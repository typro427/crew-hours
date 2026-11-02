// Customer water meters: a route in read-sequence order. Each quarter the crew enters the current reading.
// Quarters are calendar quarters, stored as 'YYYY-Q1'..'YYYY-Q4' (in the meter_reads.month column).
const db = require('./db');
const V = require('./validate');
const T = require('./time');

const quarterOfDate = d => d.slice(0, 4) + '-Q' + (Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1);
const quarterOf = company => quarterOfDate(T.localNow(company.timezone).date);
const validQuarter = q => /^\d{4}-Q[1-4]$/.test(String(q || ''));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Q4 2026 (Oct–Dec)" */
const label = q => { const [y, n] = [q.slice(0, 4), Number(q.slice(6))]; return `Q${n} ${y} (${MONTHS[(n - 1) * 3]}–${MONTHS[(n - 1) * 3 + 2]})`; };

/**
 * The route for one quarter: every active meter with its previous reading (the latest read before this quarter,
 * or the starting reading from the old sheet), this quarter's reading if there is one, and the usage.
 */
async function route(company, quarter, opts = {}) {
  const m = validQuarter(quarter) ? quarter : quarterOf(company);
  const rows = await db.q(`SELECT mt.id, mt.seq, mt.account, mt.meter_no AS "meterNo", mt.name, mt.address, mt.notes,
      mt.name_check AS "nameCheck", mt.old_name AS "oldName", mt.active, mt.qb_customer AS "qbCustomer",
      cur.reading AS current, cur.read_at AS "readAt", cur.notes AS "readNotes", cc.name AS "readBy", cur.id AS "readId",
      COALESCE(prev.reading, mt.start_reading) AS previous, prev.month AS "previousQuarter",
      cur.leak_task_id AS "leakTaskId", cur.flag_ok AS "flagOk", lt.status AS "leakStatus"
    FROM meters mt
    LEFT JOIN meter_reads cur ON cur.meter_id=mt.id AND cur.month=$2
    LEFT JOIN crew cc ON cc.id=cur.crew_id
    LEFT JOIN tasks lt ON lt.id=cur.leak_task_id
    LEFT JOIN LATERAL (SELECT reading, month FROM meter_reads p WHERE p.meter_id=mt.id AND p.month<$2 ORDER BY p.month DESC LIMIT 1) prev ON TRUE
    WHERE mt.company_id=$1 ${opts.all ? '' : 'AND mt.active'} ORDER BY mt.seq, mt.id`, [company.id, m]);
  rows.forEach(r => { r.usage = r.current != null && r.previous != null ? Math.round((r.current - r.previous) * 100) / 100 : null; });
  const { usual, typical } = await usageHistory(company.id, m, rows);
  rows.forEach(r => {
    r.gap = r.previousQuarter ? quartersBetween(r.previousQuarter, m) : 1;
    r.usual = usual.has(r.id) ? usual.get(r.id) : null;
    r.alert = r.flagOk ? null : alertFor(r, typical);
  });
  const withMeter = rows.filter(r => r.meterNo && r.active);
  return { quarter: m, label: label(m), thisQuarter: quarterOf(company), meters: rows, typical,
           highUse: rows.filter(r => r.active && r.alert && r.alert.level === 'high').length,
           read: withMeter.filter(r => r.current != null).length, toRead: withMeter.length };
}

// ---- High-usage alerts ----
const quartersBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 4 + Number(b.slice(6)) - Number(a.slice(6));
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const r2 = n => Math.round(n * 100) / 100;

/**
 * Each meter's usual use per quarter (average of its last 4 quarters before this one), and the typical use
 * across all meters (median, from at least 10 quarterly usages), so a big jump stands out.
 */
async function usageHistory(companyId, quarter, rows) {
  const reads = await db.q('SELECT meter_id, month, reading::float AS reading FROM meter_reads WHERE company_id=$1 AND month<$2 ORDER BY meter_id, month', [companyId, quarter]);
  const start = new Map((await db.q('SELECT id, start_reading::float AS s FROM meters WHERE company_id=$1', [companyId])).map(r => [r.id, r.s]));
  const per = new Map();
  let lastId = null, lastQ = null, lastV = null;
  for (const r of reads) {
    if (r.meter_id !== lastId) { lastId = r.meter_id; lastQ = null; lastV = start.get(r.meter_id); }
    if (lastV != null && r.reading >= lastV) {
      const u = (r.reading - lastV) / (lastQ ? Math.max(1, quartersBetween(lastQ, r.month)) : 1);
      if (!per.has(r.meter_id)) per.set(r.meter_id, []);
      per.get(r.meter_id).push(u);
    }
    lastQ = r.month; lastV = r.reading;
  }
  const usual = new Map(), all = [];
  per.forEach((us, id) => { const last = us.slice(-4); usual.set(id, r2(last.reduce((a, b) => a + b, 0) / last.length)); all.push(...last.filter(x => x > 0)); });
  rows.forEach(r => { if (r.usage > 0) all.push(r.usage / (r.previousQuarter ? Math.max(1, quartersBetween(r.previousQuarter, quarter)) : 1)); });
  return { usual, typical: all.length >= 10 ? r2(median(all)) : null };
}

/**
 * high: at least twice this meter's usual use (and up by at least a typical meter's quarter),
 *       or, with no history yet, 4x what a typical meter uses. low: lower than the last reading.
 */
function alertFor(m, typical) {
  if (m.usage == null) return null;
  if (m.usage < 0) return { level: 'low' };
  const perQ = m.usage / Math.max(1, m.gap || 1), jump = typical || 0;
  if (m.usual != null) {
    if (m.usual > 0 ? perQ >= 2 * m.usual && perQ - m.usual >= jump : jump > 0 && perQ >= jump)
      return { level: 'high', basis: 'own', usual: m.usual, times: m.usual > 0 ? Math.round(perQ / m.usual * 10) / 10 : null };
  } else if (typical && perQ >= 4 * typical) return { level: 'high', basis: 'typical', usual: typical, times: Math.round(perQ / typical * 10) / 10 };
  return null;
}

/** The boss marks a high reading as not a leak (pool fill, irrigation...), or undoes that. */
async function flagOk(company, meterId, quarter, ok) {
  const q = validQuarter(quarter) ? quarter : quarterOf(company);
  const r = await db.q('UPDATE meter_reads SET flag_ok=$1 WHERE company_id=$2 AND meter_id=$3 AND month=$4 RETURNING id', [!!ok, company.id, meterId, q]);
  if (!r.length) V.bad('That meter has no reading for that quarter.');
}

/** Link the leak report made from a high reading to that reading. */
const linkLeak = (companyId, meterId, quarter, taskId) =>
  db.q('UPDATE meter_reads SET leak_task_id=$1 WHERE company_id=$2 AND meter_id=$3 AND month=$4', [taskId, companyId, meterId, quarter]);

/** Save (or change) this quarter's reading for one meter. */
async function read(company, crew, meterId, b) {
  const mt = await db.one('SELECT id FROM meters WHERE id=$1 AND company_id=$2 AND active', [meterId, company.id]);
  if (!mt) V.bad('That meter was not found.');
  const month = validQuarter(b.quarter) ? b.quarter : quarterOf(company);
  if (month > quarterOf(company)) V.bad("You can't enter a reading for a quarter that hasn't started.");
  if (b.reading === '' || b.reading == null) {   // blank clears it
    await db.q('DELETE FROM meter_reads WHERE meter_id=$1 AND month=$2', [meterId, month]);
    return;
  }
  const n = Number(b.reading);
  if (!isFinite(n) || n < 0 || n > 1e10) V.bad('The reading must be a number.');
  await db.q(`INSERT INTO meter_reads (company_id, meter_id, reading, month, crew_id, notes) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (meter_id, month) DO UPDATE SET reading=EXCLUDED.reading, crew_id=EXCLUDED.crew_id, notes=EXCLUDED.notes, read_at=now(),
      flag_ok = meter_reads.flag_ok AND meter_reads.reading = EXCLUDED.reading`,
    [company.id, meterId, n, month, crew ? crew.id : null, String(b.notes || '').trim().slice(0, 500)]);
}

/** Replace the meter list from an import: { meters: [{seq, account, meterNo, name, address, notes, startReading, nameCheck, oldName}] }. */
async function replaceAll(companyId, list) {
  if (!Array.isArray(list) || !list.length) V.bad('The file has no meters.');
  if (list.length > 5000) V.bad('Up to 5000 meters.');
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const rows = list.map((m, i) => ({ seq: Number.isFinite(Number(m.seq)) ? Number(m.seq) : i + 1, account: s(m.account, 40), meterNo: s(m.meterNo, 40),
    name: s(m.name, 120), address: s(m.address, 160), notes: s(m.notes, 300), start: m.startReading === '' || m.startReading == null || !isFinite(Number(m.startReading)) ? null : Number(m.startReading),
    check: !!m.nameCheck, old: s(m.oldName, 120), qb: s(m.qbCustomer, 160) }));
  await db.tx(async t => {
    // Keep reading history when the same meter comes back: match by account + meter number + sequence.
    const have = await t.q('SELECT id, seq, account, meter_no FROM meters WHERE company_id=$1', [companyId]);
    const k = r => [r.seq, r.account, r.meter_no == null ? r.meterNo : r.meter_no].join('|');
    const byKey = new Map(have.map(r => [k(r), r]));
    await t.q('UPDATE meters SET active=FALSE WHERE company_id=$1', [companyId]);
    for (const r of rows) {
      const old = byKey.get(k(r));
      const args = [r.seq, r.account, r.meterNo, r.name, r.address, r.notes, r.start, r.check, r.old, r.qb];
      if (old) await t.q('UPDATE meters SET seq=$1, account=$2, meter_no=$3, name=$4, address=$5, notes=$6, start_reading=$7, name_check=$8, old_name=$9, qb_customer=$10, active=TRUE WHERE id=$11', [...args, old.id]);
      else await t.q('INSERT INTO meters (seq, account, meter_no, name, address, notes, start_reading, name_check, old_name, qb_customer, company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [...args, companyId]);
    }
  });
  return { meters: rows.length };
}

/** The boss edits one meter's details. */
async function update(companyId, id, b) {
  const cur = await db.one('SELECT * FROM meters WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (!cur) V.bad('That meter was not found.');
  const s = (v, n, d) => (v === undefined ? d : String(v || '').trim().slice(0, n));
  const seq = b.seq !== undefined ? V.int(b.seq, 'Read sequence', 0, 100000) : cur.seq;
  await db.q('UPDATE meters SET seq=$1, account=$2, meter_no=$3, name=$4, address=$5, notes=$6, name_check=$7, active=$8, qb_customer=$9 WHERE id=$10',
    [seq, s(b.account, 40, cur.account), s(b.meterNo, 40, cur.meter_no), s(b.name, 120, cur.name), s(b.address, 160, cur.address), s(b.notes, 300, cur.notes),
     b.nameCheck !== undefined ? !!b.nameCheck : cur.name_check, b.active !== undefined ? !!b.active : cur.active, s(b.qbCustomer, 160, cur.qb_customer), id]);
}

/**
 * Read the meter list from the Excel file (the "Meter list" sheet Claude made, or any sheet with the same column names).
 * Returns { meters, readings } where readings are any "Current Reading" values filled in.
 */
async function fromExcel(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) { V.bad("That Excel file couldn't be opened. Save it as .xlsx and try again."); }
  const ws = wb.getWorksheet('Meter list') || wb.worksheets[0];
  if (!ws) V.bad('That Excel file has no sheets.');
  const text = v => {
    if (v == null) return '';
    if (typeof v === 'object') { if (v.result !== undefined) return text(v.result); if (v.richText) return v.richText.map(r => r.text).join(''); if (v.text) return String(v.text); if (v instanceof Date) return v.toISOString().slice(0, 10); }
    return String(v).trim();
  };
  let hdrRow = 0, cols = {};
  const WANT = { 'read sequence': 'seq', 'act #': 'account', 'customer name': 'name', 'quickbooks customer': 'qbCustomer', 'service address': 'address',
    'meter id': 'meterNo', 'last reading': 'startReading', 'current reading': 'current', 'name status': 'status', 'name on old sheet': 'oldName', 'notes': 'notes' };
  ws.eachRow((row, n) => {
    if (hdrRow) return;
    const found = {};
    row.eachCell((c, i) => { const k = WANT[text(c.value).toLowerCase()]; if (k) found[k] = i; });
    if (found.seq && found.name) { hdrRow = n; cols = found; }
  });
  if (!hdrRow) V.bad('That Excel file needs columns called "Read Sequence" and "Customer Name". Use the meter list Claude made.');
  const meters = [], readings = [];
  ws.eachRow((row, n) => {
    if (n <= hdrRow) return;
    const g = k => (cols[k] ? text(row.getCell(cols[k]).value) : '');
    const seq = Number(g('seq'));
    if (!g('seq') || !Number.isFinite(seq)) return;
    let meterNo = g('meterNo'), notes = g('notes');
    if (/^no meter/i.test(meterNo)) { notes = notes || 'No meter'; meterNo = ''; }
    const status = g('status');
    const m = { seq, account: g('account'), meterNo, name: g('name'), qbCustomer: g('qbCustomer'), address: g('address'), notes,
      startReading: g('startReading').replace(/,/g, ''), oldName: g('oldName') || g('name'), nameCheck: /^check|^not on master/i.test(status) };
    meters.push(m);
    const cur = g('current').replace(/,/g, '');
    if (cur !== '') {
      if (!/^\d+(\.\d+)?$/.test(cur)) V.bad(`Row ${n}: the current reading "${cur}" isn't a number.`);
      readings.push({ seq, account: m.account, meterNo, reading: Number(cur) });
    }
  });
  if (!meters.length) V.bad('No meters found under the header row.');
  return { meters, readings };
}

/** Import from Excel: replace the list (keeping history), then save any current readings for this quarter. */
async function importExcel(company, buffer) {
  const { meters, readings } = await fromExcel(buffer);
  const r = await replaceAll(company.id, meters);
  let saved = 0;
  for (const x of readings) {
    const mt = await db.one('SELECT id FROM meters WHERE company_id=$1 AND active AND seq=$2 AND account=$3 AND meter_no=$4', [company.id, x.seq, x.account, x.meterNo]);
    if (mt) { await read(company, null, mt.id, { reading: x.reading }); saved++; }
  }
  return { meters: r.meters, readings: saved };
}

/* ------------------- adding meters, and properties not on the route ------------------- */

/** Add one meter at a read-sequence spot; meters at that spot and after move down one. */
async function add(companyId, b) {
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const name = s(b.name, 120), address = s(b.address, 160);
  if (!name && !address) V.bad('Enter a name or an address.');
  const max = (await db.one('SELECT COALESCE(max(seq),0)::int AS m FROM meters WHERE company_id=$1 AND active', [companyId])).m;
  const seq = b.seq === '' || b.seq == null ? max + 1 : V.int(b.seq, 'Read sequence', 1, 100000);
  const start = b.startReading === '' || b.startReading == null ? null : Number(b.startReading);
  if (start != null && !(isFinite(start) && start >= 0)) V.bad('The last reading must be a number.');
  return db.tx(async t => {
    await t.q('UPDATE meters SET seq=seq+1 WHERE company_id=$1 AND seq>=$2', [companyId, seq]);
    const r = await t.one(`INSERT INTO meters (company_id, seq, account, meter_no, name, address, notes, start_reading, qb_customer, old_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$5) RETURNING id`,
      [companyId, seq, s(b.account, 40), s(b.meterNo, 40), name, address, s(b.notes, 300), start, s(b.qbCustomer, 160)]);
    await t.q('DELETE FROM meter_skips WHERE company_id=$1 AND address=$2', [companyId, address]);
    return r.id;
  });
}

// Address matching that copes with "2c 470 Deerfield Landing" = "470 Deerfield Landing #2", "131A" = "131 ... Unit A".
const ABBR = { ln: 'lane', dr: 'drive', rd: 'road', ct: 'court', cir: 'circle', pt: 'point', pl: 'place', vue: 'view', e: 'east', w: 'west', n: 'north', s: 'south' };
const GEN = new Set(['lane', 'drive', 'road', 'way', 'unit', 'condo', 'lot', 'the', 'of']);
function addrKey(a) {
  const t = String(a || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(x => ABBR[x] || x);
  const big = t.filter(x => /^\d{3,5}[a-z]?$/.test(x));
  let house = null, letter = null; const nums = new Set();
  for (const x of t) {
    let m = /^(\d{2,5})([a-z]?)$/.exec(x);
    if (m && house === null && (!big.length || x === big[0])) { house = m[1]; letter = m[2] || null; continue; }
    m = /^(\d{1,2})([a-z]?)$|^([a-z])(\d{1,2})$/.exec(x);
    if (m) nums.add(m[1] || m[4]);
  }
  const ui = t.indexOf('unit');
  if (ui >= 0 && /^[a-z]$/.test(t[ui + 1] || '')) letter = t[ui + 1];
  if (!letter && /^[ab]$/.test(t[t.length - 1] || '')) letter = t[t.length - 1];
  const plain = t.filter(x => !/\d/.test(x) && !GEN.has(x) && x.length > 1);
  const words = new Set(plain);
  for (let i = 0; i + 1 < plain.length; i++) words.add(plain[i] + plain[i + 1]);   // "White Tail" = "Whitetail", "Deer Hill" = "Deerhill"
  return { house, letter, nums, words };
}
/** Just the street name, squashed: "141 Deer Run Pt" -> "deerrunpoint". */
const streetOf = a => String(a || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(x => ABBR[x] || x)
  .filter(x => !/[0-9]/.test(x) && !GEN.has(x) && x.length > 1).join('');
function sameProperty(a, b) {
  if (!a.house || a.house !== b.house) return false;
  if (![...a.words].some(w => b.words.has(w))) return false;
  const TYPE = ['point', 'circle', 'place', 'court', 'path', 'trail', 'knoll', 'crossing'];   // these tell streets apart
  const ta = TYPE.filter(x => a.words.has(x)), tb = TYPE.filter(x => b.words.has(x));
  if (ta.length && tb.length && !ta.some(x => tb.includes(x))) return false;
  if (a.letter && b.letter && a.letter !== b.letter) return false;
  if (a.nums.size && b.nums.size && ![...a.nums].some(n => b.nums.has(n))) return false;
  return true;
}

/**
 * Deerfield properties on the members list (active) with no meter on the route.
 * Each comes with the owner's name and a suggested read-sequence spot: right after the last meter on the same street.
 */
async function notOnRoute(companyId) {
  const meters = await db.q('SELECT seq, address, name, old_name FROM meters WHERE company_id=$1 AND active ORDER BY seq', [companyId]);
  const last = s => String(s || '').toLowerCase().split(/[,(/\s]/)[0];
  const mk = meters.map(m => ({ seq: m.seq, k: addrKey(m.address), names: new Set([last(m.name), last(m.old_name)].filter(Boolean)) }));
  const members = await db.q(`SELECT data FROM members WHERE company_id=$1 AND COALESCE(data->>'Status','Active')='Active' AND COALESCE(data->>'Deerfield address','')<>'' ORDER BY position`, [companyId]);
  const skips = new Set((await db.q('SELECT address FROM meter_skips WHERE company_id=$1', [companyId])).map(r => r.address));
  const out = new Map();
  for (const { data: d } of members) {
    const address = d['Deerfield address'].trim();
    const k = addrKey(address);
    if (!k.house) { if (!out.has(address)) out.set(address, null); else continue; }
    else if (mk.some(m => sameProperty(k, m.k))) continue;
    // Same house number and the same owner on the meter, but the street is written differently (Deer Run Circle vs Point).
    else if (mk.some(m => m.k.house === k.house && m.names.has(last(d['Last name'])) && [...k.words].some(w => m.k.words.has(w)))) continue;
    const name = [d['Last name'], d['First name(s)']].filter(Boolean).join(', ') || d['Trust or LLC'] || '';
    const e = out.get(address) || { address, type: d['Property type'] || '', parcel: d['Parcel ID'] || '', names: [], skipped: skips.has(address), suggestSeq: null };
    if (name && !e.names.includes(name)) e.names.push(name);
    if (e.suggestSeq == null) {   // after the last meter on the same street
      const street = [...k.words];
      const same = mk.filter(m => street.length && street.every(w => m.k.words.has(w)));
      e.suggestSeq = same.length ? Math.max(...same.map(m => m.seq)) + 1 : null;
    }
    out.set(address, e);
  }
  const ORDER = { Home: 0, Condo: 1, Villa: 2, Comm: 3, '': 4, Lot: 5, Hangar: 6, Garage: 7 };
  return [...out.values()].filter(Boolean).sort((a, b) => (ORDER[a.type] ?? 4) - (ORDER[b.type] ?? 4) || a.address.localeCompare(b.address));
}

async function skip(companyId, address, on) {
  const a = String(address || '').trim().slice(0, 200);
  if (!a) V.bad('Which address?');
  if (on) await db.q('INSERT INTO meter_skips (company_id, address) VALUES ($1,$2) ON CONFLICT DO NOTHING', [companyId, a]);
  else await db.q('DELETE FROM meter_skips WHERE company_id=$1 AND address=$2', [companyId, a]);
}

module.exports = { flagOk, linkLeak, alertFor, quartersBetween, route, read, replaceAll, update, quarterOf, quarterOfDate, label, fromExcel, importExcel, add, notOnRoute, skip, addrKey, sameProperty, streetOf };
