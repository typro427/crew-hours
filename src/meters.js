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
      COALESCE(prev.reading, mt.start_reading) AS previous, prev.month AS "previousQuarter"
    FROM meters mt
    LEFT JOIN meter_reads cur ON cur.meter_id=mt.id AND cur.month=$2
    LEFT JOIN crew cc ON cc.id=cur.crew_id
    LEFT JOIN LATERAL (SELECT reading, month FROM meter_reads p WHERE p.meter_id=mt.id AND p.month<$2 ORDER BY p.month DESC LIMIT 1) prev ON TRUE
    WHERE mt.company_id=$1 ${opts.all ? '' : 'AND mt.active'} ORDER BY mt.seq, mt.id`, [company.id, m]);
  rows.forEach(r => { r.usage = r.current != null && r.previous != null ? Math.round((r.current - r.previous) * 100) / 100 : null; });
  const withMeter = rows.filter(r => r.meterNo && r.active);
  return { quarter: m, label: label(m), thisQuarter: quarterOf(company), meters: rows,
           read: withMeter.filter(r => r.current != null).length, toRead: withMeter.length };
}

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
    ON CONFLICT (meter_id, month) DO UPDATE SET reading=EXCLUDED.reading, crew_id=EXCLUDED.crew_id, notes=EXCLUDED.notes, read_at=now()`,
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

module.exports = { route, read, replaceAll, update, quarterOf, quarterOfDate, label };
