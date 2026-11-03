// Address jobs: one entry per visit to a property. Address (from the members list), time in / time out,
// chemical cost, material cost, receipts and notes. A separate log: it does not change anyone's hours.
const db = require('./db');
const V = require('./validate');
const T = require('./time');
const K = require('./tasks');

const MAX_RECEIPTS = 10;
const COLS = `j.id, to_char(j.day, 'YYYY-MM-DD') AS day, j.address, j.owner, j.time_in AS "timeIn", j.time_out AS "timeOut",
  j.chem_cost AS "chemCost", j.material_cost AS "materialCost", j.notes, j.crew_id AS "crewId", c.name AS "crewName", j.created_at AS "createdAt",
  COALESCE((SELECT json_agg(r.id ORDER BY r.id) FROM job_receipts r WHERE r.job_id=j.id), '[]') AS receipts`;
const FROM = 'FROM jobs j LEFT JOIN crew c ON c.id=j.crew_id';

/** Minutes on the job ("16:00" to "08:30" next morning counts across midnight). */
function minutes(a, b) {
  if (!a || !b) return null;
  const m = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  let d = m(b) - m(a); if (d < 0) d += 1440;
  return d;
}
const withTotals = rows => rows.map(j => {
  const mins = minutes(j.timeIn, j.timeOut);
  const chem = j.chemCost == null ? null : Number(j.chemCost), mat = j.materialCost == null ? null : Number(j.materialCost);
  return { ...j, chemCost: chem, materialCost: mat, hours: mins == null ? null : Math.round(mins / 6) / 10, total: Math.round(((chem || 0) + (mat || 0)) * 100) / 100 };
});

const forCrew = async (companyId, crewId) => withTotals(await db.q(`SELECT ${COLS} ${FROM} WHERE j.company_id=$1 AND j.crew_id=$2 AND j.day > CURRENT_DATE - 60
  ORDER BY (j.time_out IS NULL) DESC, j.day DESC, j.time_in DESC NULLS LAST, j.id DESC`, [companyId, crewId]));

/** The boss's view: a date range (default: this month), optionally one person. */
async function forOwner(companyId, q = {}) {
  const from = T.isDate(q.from) ? q.from : null, to = T.isDate(q.to) ? q.to : null;
  const args = [companyId], where = ['j.company_id=$1'];
  if (from) { args.push(from); where.push(`j.day >= $${args.length}`); } else where.push("j.day >= date_trunc('month', CURRENT_DATE)");
  if (to) { args.push(to); where.push(`j.day <= $${args.length}`); }
  if (q.crew) { args.push(Number(q.crew)); where.push(`j.crew_id = $${args.length}`); }
  const jobs = withTotals(await db.q(`SELECT ${COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY j.day DESC, j.time_in DESC NULLS LAST, j.id DESC LIMIT 2000`, args));
  const sum = k => Math.round(jobs.reduce((a, j) => a + (j[k] || 0), 0) * 100) / 100;
  return { jobs, totals: { jobs: jobs.length, hours: Math.round(sum('hours') * 10) / 10, chemCost: sum('chemCost'), materialCost: sum('materialCost'), total: sum('total') } };
}

const clock = (v, what) => {
  if (v === '' || v == null) return null;
  const s = String(v).trim();
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s)) V.bad(`Enter the ${what} like 8:30 AM.`);
  return s;
};
const money = (v, what) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > 1e6) V.bad(`The ${what} must be a dollar amount, like 42.50.`);
  return Math.round(n * 100) / 100;
};

async function fields(company, b, cur) {
  const has = k => b[k] !== undefined;
  const day = has('day') ? b.day : cur.day;
  if (!T.isDate(day)) V.bad('Pick the date.');
  const today = T.localNow(company.timezone).date;
  if (day > today) V.bad("That date hasn't happened yet.");
  const address = has('address') ? String(b.address || '').trim().replace(/\s+/g, ' ').slice(0, 200) : cur.address;
  if (!address) V.bad('Pick the address.');
  return {
    day, address,
    timeIn: has('timeIn') ? clock(b.timeIn, 'time in') : cur.time_in,
    timeOut: has('timeOut') ? clock(b.timeOut, 'time out') : cur.time_out,
    chem: has('chemCost') ? money(b.chemCost, 'chemical cost') : cur.chem_cost,
    mat: has('materialCost') ? money(b.materialCost, 'material cost') : cur.material_cost,
    notes: has('notes') ? String(b.notes || '').trim().slice(0, 2000) : cur.notes,
    addrChanged: address !== cur.address
  };
}

async function ownerOf(companyId, address) {
  const o = K.ownerAt(await K.activeMembers(companyId), address);
  return o.owner;
}

/** Add a job. who = crew row (crew app) or null (dashboard, with b.crewId). */
async function create(company, crew, b) {
  const v = await fields(company, b, { day: T.localNow(company.timezone).date, address: '', notes: '' });
  const crewId = crew ? crew.id : (b.crewId ? Number(b.crewId) : null);
  if (crewId && !(await db.one('SELECT 1 FROM crew WHERE id=$1 AND company_id=$2', [crewId, company.id]))) V.bad('Pick someone from your crew.');
  const receipts = (Array.isArray(b.receipts) ? b.receipts : []).map(K.photoBytes);
  if (receipts.length > MAX_RECEIPTS) V.bad(`Up to ${MAX_RECEIPTS} receipts per job.`);
  const ref = /^[A-Za-z0-9_-]{8,64}$/.test(String(b.clientRef || '')) ? b.clientRef : null;
  if (ref) { const had = await db.one('SELECT id FROM jobs WHERE company_id=$1 AND client_ref=$2', [company.id, ref]); if (had) return had.id; }
  const owner = await ownerOf(company.id, v.address);
  return db.tx(async t => {
    const r = await t.one(`INSERT INTO jobs (company_id, crew_id, day, address, owner, time_in, time_out, chem_cost, material_cost, notes, client_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [company.id, crewId, v.day, v.address, owner, v.timeIn, v.timeOut, v.chem, v.mat, v.notes, ref]);
    for (const p of receipts) await t.q('INSERT INTO job_receipts (job_id, company_id, mime, data) VALUES ($1,$2,$3,$4)', [r.id, company.id, p.mime, p.buf]);
    return r.id;
  });
}

/** Change a job and/or add receipts. Crew: only their own, from the last 30 days. */
async function update(company, crew, id, b) {
  const cur = await db.one(`SELECT *, to_char(day, 'YYYY-MM-DD') AS day FROM jobs WHERE id=$1 AND company_id=$2 ${crew ? "AND crew_id=$3 AND day > CURRENT_DATE - 30" : ''}`,
    crew ? [id, company.id, crew.id] : [id, company.id]);
  if (!cur) V.bad(crew ? 'You can only change your own jobs from the last 30 days.' : 'That job was not found.');
  const v = await fields(company, b, cur);
  const receipts = (Array.isArray(b.receipts) ? b.receipts : []).map(K.photoBytes);
  const have = (await db.one('SELECT count(*)::int AS n FROM job_receipts WHERE job_id=$1', [id])).n;
  if (have + receipts.length > MAX_RECEIPTS) V.bad(`Up to ${MAX_RECEIPTS} receipts per job. This one has ${have}.`);
  const owner = v.addrChanged ? await ownerOf(company.id, v.address) : cur.owner;
  const crewId = !crew && b.crewId !== undefined ? (b.crewId ? Number(b.crewId) : null) : cur.crew_id;
  await db.tx(async t => {
    await t.q(`UPDATE jobs SET day=$1, address=$2, owner=$3, time_in=$4, time_out=$5, chem_cost=$6, material_cost=$7, notes=$8, crew_id=$9 WHERE id=$10`,
      [v.day, v.address, owner, v.timeIn, v.timeOut, v.chem, v.mat, v.notes, crewId, id]);
    for (const p of receipts) await t.q('INSERT INTO job_receipts (job_id, company_id, mime, data) VALUES ($1,$2,$3,$4)', [id, company.id, p.mime, p.buf]);
  });
}

async function remove(companyId, id, crew) {
  const r = await db.q(`DELETE FROM jobs WHERE id=$1 AND company_id=$2 ${crew ? "AND crew_id=$3 AND created_at > now() - interval '7 days'" : ''} RETURNING id`,
    crew ? [id, companyId, crew.id] : [id, companyId]);
  if (!r.length) V.bad(crew ? 'You can only delete your own jobs from the last 7 days.' : 'That job was not found.');
}

async function removeReceipt(companyId, receiptId, crew) {
  const r = await db.one(`SELECT r.id FROM job_receipts r JOIN jobs j ON j.id=r.job_id WHERE r.id=$1 AND r.company_id=$2 ${crew ? "AND j.crew_id=$3 AND r.created_at > now() - interval '24 hours'" : ''}`,
    crew ? [receiptId, companyId, crew.id] : [receiptId, companyId]);
  if (!r) V.bad(crew ? 'You can only remove receipts you added in the last 24 hours.' : 'That receipt was not found.');
  await db.q('DELETE FROM job_receipts WHERE id=$1', [receiptId]);
}

/** A receipt image. Crew: only from their own jobs. */
const receipt = (companyId, id, crewId) => db.one(`SELECT r.mime, r.data FROM job_receipts r JOIN jobs j ON j.id=r.job_id WHERE r.id=$1 AND r.company_id=$2 ${crewId ? 'AND j.crew_id=$3' : ''}`,
  crewId ? [id, companyId, crewId] : [id, companyId]);

/** Addresses to pick from: the Deerfield addresses on the members list, with the owner's name. */
async function addresses(companyId) {
  const rows = await db.q(`SELECT data->>'Deerfield address' AS a, data->>'Last name' AS l, data->>'First name(s)' AS f, data->>'Trust or LLC' AS t
    FROM members WHERE company_id=$1 AND COALESCE(data->>'Status','Active')='Active' AND COALESCE(data->>'Deerfield address','')<>'' ORDER BY position, id`, [companyId]);
  const by = new Map();
  rows.forEach(r => {
    const a = r.a.trim(), n = [r.f, r.l].filter(Boolean).join(' ') || r.t || '';
    const e = by.get(a) || { address: a, owners: [] };
    if (n && !e.owners.includes(n)) e.owners.push(n);
    by.set(a, e);
  });
  return [...by.values()].map(e => ({ address: e.address, owner: e.owners.slice(0, 3).join(', ') }))
    .sort((x, y) => x.address.localeCompare(y.address, 'en', { numeric: true }));
}

/** Running totals for one person: this week and this month (jobs, hours on site, costs, and what it bills at the current rates). */
async function totalsFor(company, crewId) {
  const H = require('./hours'), JB = require('./jobbilling');
  const today = T.localNow(company.timezone).date, set = await JB.settings(company.id);
  const bill = j => (set.laborRate && j.hours != null ? (JB.billedHours(j, set) || 0) * set.laborRate : 0) + (j.chemCost || 0) * (1 + (set.chemMarkup || 0) / 100)
    + (j.materialCost || 0) * (1 + (set.matMarkup || 0) / 100) + (set.visitCharge || 0);
  const r2 = n => Math.round(n * 100) / 100;
  async function range(from, to) {
    const { jobs, totals } = await forOwner(company.id, { from, to, crew: crewId });
    return { ...totals, billed: r2(jobs.reduce((a, j) => a + bill(j), 0)), open: jobs.filter(j => j.timeIn && !j.timeOut).length, from, to };
  }
  const ws = H.weekOf(company, today);
  // this month, one line per address billed (what each client's invoice will show)
  const mb = await JB.month(company, today.slice(0, 7), crewId);
  const byAddress = mb.clients.map(c => ({ address: c.address, customer: c.customer, visits: c.totals.visits, hours: c.totals.hours,
    chemCost: c.totals.chemCost, materialCost: c.totals.materialCost, billed: c.totals.total })).sort((a, b) => b.billed - a.billed || a.address.localeCompare(b.address));
  return { week: await range(ws, T.shift(ws, 6)), month: { ...(await range(today.slice(0, 8) + '01', today)), byAddress, label: mb.label }, rates: !!(set.laborRate || set.visitCharge) };
}

function csv(list) {
  const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const out = [['Date', 'Crew', 'Address', 'Owner', 'Time in', 'Time out', 'Hours', 'Chemical cost', 'Material cost', 'Total cost', 'Receipts', 'Notes'].map(q).join(',')];
  list.jobs.forEach(j => out.push([j.day, j.crewName, j.address, j.owner, j.timeIn, j.timeOut, j.hours, j.chemCost, j.materialCost, j.total, j.receipts.length, j.notes].map(q).join(',')));
  return out.join('\r\n') + '\r\n';
}

module.exports = { totalsFor, forCrew, forOwner, create, update, remove, removeReceipt, receipt, addresses, csv, minutes, MAX_RECEIPTS };
