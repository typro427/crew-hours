// Compliance for a small water system: the daily operating log (chlorine, master meter, pump hours), the sampling
// schedule, testing & maintenance (backflow, valves, tanks, flushing), and the system's details for the monthly report.
// Managers use it in the crew app; the boss on the dashboard. Everyone sees the same records.
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const H = require('./hours');

const KINDS = ['Backflow test', 'Valve exercising', 'Inspection', 'Flushing', 'Meter test', 'Other'];
// A starting list: the boss sets each one to the schedule TDEC gave the system.
const START_SAMPLES = [
  ['Total coliform (bacteriological)', 1, '1 routine sample per month. Rotate sites per your sample siting plan.'],
  ['Nitrate', 12, 'MCL 10 mg/L as N.'],
  ['Lead & copper (5 taps)', 36, 'First-draw after 6+ hours standing. Lead AL 15 ppb, copper AL 1.3 mg/L.'],
  ['TTHM / HAA5 (disinfection byproducts)', 12, 'MCLs 0.080 / 0.060 mg/L.'],
  ['Gross alpha / radium', 72, 'Frequency depends on prior results.']
];
const SYSTEM = { name: '', pwsid: '', type: 'Community, groundwater', pop: '', conn: '', operator: '', cert: '', minCl: 0.2 };

const day = v => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const num = v => (v == null ? null : Number(v));
const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
function date(v, what, today) {
  const d = String(v || '');
  if (!T.isDate(d)) V.bad(`Pick the ${what}.`);
  if (d > today) V.bad(`The ${what} can't be in the future.`);
  return d;
}
function reading(v, what, max) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  if (!isFinite(n) || n < 0 || n > max) V.bad(`${what} must be a number.`);
  return n;
}

/** Everything the screens need: the system, logs for the last ~13 months, both lists with their history. */
async function all(company) {
  const c = await db.one('SELECT cw_system FROM companies WHERE id=$1', [company.id]);
  if (!(await db.one('SELECT 1 FROM cw_items WHERE company_id=$1 LIMIT 1', [company.id])) && !(c && c.cw_system)) {
    for (const [i, [name, months, note]] of START_SAMPLES.entries())
      await db.q("INSERT INTO cw_items (company_id, list, name, months, note, position) VALUES ($1,'samples',$2,$3,$4,$5)", [company.id, name, months, note, i]);
  }
  const system = { ...SYSTEM, name: company.name, ...((c && c.cw_system) || {}) };
  const today = H.today(company);
  const logs = (await db.q(`SELECT to_char(day, 'YYYY-MM-DD') AS date, ep, dist, meter, pump, notes, by_name AS "by" FROM cw_logs
    WHERE company_id=$1 AND day > $2::date - 400 ORDER BY day`, [company.id, today]))
    .map(l => ({ ...l, ep: num(l.ep), dist: num(l.dist), meter: num(l.meter), pump: num(l.pump) }));
  const items = await db.q(`SELECT i.id, i.list, i.name, i.kind, i.months, to_char(i.last, 'YYYY-MM-DD') AS last, i.note,
      COALESCE((SELECT json_agg(json_build_object('id', h.id, 'date', to_char(h.day, 'YYYY-MM-DD'), 'result', h.result, 'lab', h.lab, 'by', h.by_name) ORDER BY h.day DESC, h.id DESC)
        FROM cw_history h WHERE h.item_id=i.id), '[]') AS history
    FROM cw_items i WHERE i.company_id=$1 ORDER BY i.position, i.id`, [company.id]);
  return { system, today, logs, samples: items.filter(i => i.list === 'samples'), assets: items.filter(i => i.list === 'assets'), kinds: KINDS };
}

async function saveSystem(company, b) {
  const s = { name: txt(b.name, 120) || company.name, pwsid: txt(b.pwsid, 40), type: txt(b.type, 80), pop: txt(b.pop, 20), conn: txt(b.conn, 20),
    operator: txt(b.operator, 80), cert: txt(b.cert, 80), minCl: reading(b.minCl, 'The minimum chlorine', 10) ?? 0.2 };
  await db.q('UPDATE companies SET cw_system=$1 WHERE id=$2', [JSON.stringify(s), company.id]);
  return all(company);
}

/** One day's readings (saving the same day again replaces it). */
async function saveLog(company, who, b) {
  const today = H.today(company);
  const d = date(b.date, 'date', today);
  const dist = reading(b.dist, 'Distribution chlorine', 20);
  if (dist == null) V.bad('Distribution chlorine is required.');
  const vals = [company.id, d, reading(b.ep, 'Entry point chlorine', 20), dist, reading(b.meter, 'The meter reading', 1e12), reading(b.pump, 'Pump run time', 24), txt(b.notes, 2000), who];
  await db.q(`INSERT INTO cw_logs (company_id, day, ep, dist, meter, pump, notes, by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (company_id, day) DO UPDATE SET ep=$3, dist=$4, meter=$5, pump=$6, notes=$7, by_name=$8, updated_at=now()`, vals);
  return all(company);
}
async function removeLog(company, d) {
  await db.q('DELETE FROM cw_logs WHERE company_id=$1 AND day=$2', [company.id, String(d)]);
  return all(company);
}

const item = async (company, id) => { const i = await db.one('SELECT * FROM cw_items WHERE id=$1 AND company_id=$2', [id, company.id]); if (!i) V.bad('That item was not found. Refresh the page.'); return i; };

/** Add (no id) or change a sample type / device or task. */
async function saveItem(company, b) {
  const today = H.today(company);
  const list = b.list === 'assets' ? 'assets' : 'samples';
  const name = V.str(b.name, 'a name', 1, 120);
  const months = V.int(b.months, 'How often', 1, 240);
  const last = b.last ? date(b.last, 'last done date', today) : null;
  const kind = list === 'assets' ? (KINDS.includes(b.kind) ? b.kind : 'Other') : '';
  const note = txt(b.note, 500);
  if (b.id) {
    await item(company, Number(b.id));
    await db.q('UPDATE cw_items SET name=$1, months=$2, last=$3, kind=$4, note=$5 WHERE id=$6', [name, months, last, kind, note, Number(b.id)]);
  } else {
    if ((await db.one('SELECT count(*)::int AS n FROM cw_items WHERE company_id=$1', [company.id])).n >= 300) V.bad('That is a lot of items. Delete some first.');
    await db.q(`INSERT INTO cw_items (company_id, list, name, months, last, kind, note, position)
      VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(max(position),0)+1 FROM cw_items WHERE company_id=$1))`, [company.id, list, name, months, last, kind, note]);
  }
  return all(company);
}
async function removeItem(company, id) {
  await item(company, id);
  await db.q('DELETE FROM cw_items WHERE id=$1', [id]);
  return all(company);
}

/** A sample collected / a test or task done: goes in its history and moves the next due date. */
async function record(company, who, id, b) {
  const it = await item(company, id);
  const d = date(b.date, 'date', H.today(company));
  await db.q('INSERT INTO cw_history (item_id, day, result, lab, by_name) VALUES ($1,$2,$3,$4,$5)', [it.id, d, txt(b.result, 300) || 'Recorded', txt(b.lab, 120), who]);
  await db.q('UPDATE cw_items SET last=GREATEST(COALESCE(last, $2::date), $2::date) WHERE id=$1', [it.id, d]);
  return all(company);
}
async function removeRecord(company, historyId) {
  const h = await db.one('SELECT h.id, h.item_id FROM cw_history h JOIN cw_items i ON i.id=h.item_id WHERE h.id=$1 AND i.company_id=$2', [historyId, company.id]);
  if (!h) V.bad('That record was not found. Refresh the page.');
  await db.q('DELETE FROM cw_history WHERE id=$1', [h.id]);
  await db.q('UPDATE cw_items SET last=(SELECT max(day) FROM cw_history WHERE item_id=$1) WHERE id=$1', [h.item_id]);
  return all(company);
}

/** The same API for the crew app (managers) and the dashboard (the boss). who(req) is the name put on records. */
function mount(r, prefix, guard, who) {
  const g = guard ? [].concat(guard) : [];
  r.get(prefix, ...g, async (req, res) => res.json(await all(req.company)));
  r.put(prefix + '/system', ...g, async (req, res) => res.json(await saveSystem(req.company, req.body || {})));
  r.post(prefix + '/logs', ...g, async (req, res) => res.json(await saveLog(req.company, who(req), req.body || {})));
  r.delete(prefix + '/logs/:day', ...g, async (req, res) => res.json(await removeLog(req.company, req.params.day)));
  r.post(prefix + '/items', ...g, async (req, res) => res.json(await saveItem(req.company, req.body || {})));
  r.delete(prefix + '/items/:id', ...g, async (req, res) => res.json(await removeItem(req.company, Number(req.params.id))));
  r.post(prefix + '/items/:id/record', ...g, async (req, res) => res.json(await record(req.company, who(req), Number(req.params.id), req.body || {})));
  r.delete(prefix + '/history/:id', ...g, async (req, res) => res.json(await removeRecord(req.company, Number(req.params.id))));
}

module.exports = { all, saveSystem, saveLog, removeLog, saveItem, removeItem, record, removeRecord, mount, KINDS };
