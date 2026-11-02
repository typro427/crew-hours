// Billing for address jobs: each month, one invoice per client (property), with every visit broken out.
// Charges: labor (hours on site x rate), chemicals and materials (cost + optional markup), optional charge per visit.
const db = require('./db');
const V = require('./validate');
const T = require('./time');
const J = require('./jobs');
const M = require('./meters');

const PER_FILE = 100;   // QuickBooks takes up to 100 invoices per import file
const DEFAULTS = { laborRate: null, chemMarkup: 0, matMarkup: 0, visitCharge: null,
  laborItem: 'Labor', chemItem: 'Chemicals', matItem: 'Materials', visitItem: 'Service call', dueDays: 30, prefix: 'J' };

async function settings(companyId) {
  const c = await db.one('SELECT job_billing FROM companies WHERE id=$1', [companyId]);
  return { ...DEFAULTS, ...((c && c.job_billing) || {}) };
}
const num = (v, what, max) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > max) V.bad(`The ${what} must be a number, like 65 or 10.`);
  return Math.round(n * 100) / 100;
};
async function save(companyId, b) {
  const cur = await settings(companyId);
  const s = (v, d, n) => (v === undefined ? d : String(v || '').trim().slice(0, n) || d);
  const out = {
    laborRate: b.laborRate !== undefined ? num(b.laborRate, 'labor rate', 10000) : cur.laborRate,
    chemMarkup: b.chemMarkup !== undefined ? num(b.chemMarkup, 'chemical markup', 1000) || 0 : cur.chemMarkup,
    matMarkup: b.matMarkup !== undefined ? num(b.matMarkup, 'material markup', 1000) || 0 : cur.matMarkup,
    visitCharge: b.visitCharge !== undefined ? num(b.visitCharge, 'charge per visit', 100000) : cur.visitCharge,
    laborItem: s(b.laborItem, DEFAULTS.laborItem, 100), chemItem: s(b.chemItem, DEFAULTS.chemItem, 100),
    matItem: s(b.matItem, DEFAULTS.matItem, 100), visitItem: s(b.visitItem, DEFAULTS.visitItem, 100),
    dueDays: b.dueDays !== undefined ? V.int(b.dueDays, 'Days until due', 0, 365) : cur.dueDays,
    prefix: b.prefix !== undefined ? String(b.prefix || '').trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 8) : cur.prefix
  };
  await db.q('UPDATE companies SET job_billing=$1 WHERE id=$2', [JSON.stringify(out), companyId]);
  return out;
}

const cents = n => Math.round(n * 100) / 100;
const validMonth = m => /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
function monthRange(m) {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` };
}
const monthLabel = m => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const prevMonth = d => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1; return m ? `${y}-${String(m).padStart(2, '0')}` : `${y - 1}-12`; };

/** The QuickBooks customer for an address: the name on the meter at that property, else the owner. */
async function customerLookup(companyId) {
  const meters = (await db.q('SELECT address, name, qb_customer FROM meters WHERE company_id=$1 AND active', [companyId]))
    .map(m => ({ k: M.addrKey(m.address), qb: m.qb_customer, name: m.name }));
  return address => { const k = M.addrKey(address); const m = k.house && meters.find(x => M.sameProperty(k, x.k)); return m ? { qb: m.qb || '', meterName: m.name } : { qb: '', meterName: '' }; };
}

/**
 * One month: every client (property) with each visit priced, plus totals. crew = optional crew id.
 */
async function month(company, m, crew) {
  const mm = validMonth(m) ? m : T.localNow(company.timezone).date.slice(0, 7);
  const set = await settings(company.id);
  const { from, to } = monthRange(mm);
  const { jobs } = await J.forOwner(company.id, { from, to, crew });
  const look = await customerLookup(company.id);
  const by = new Map();
  for (const j of [...jobs].reverse()) {   // oldest first
    const key = j.address.trim().toLowerCase();
    if (!by.has(key)) {
      const c = look(j.address);
      by.set(key, { address: j.address, owner: j.owner, customer: c.qb || j.owner || j.address, qbMatched: !!c.qb, visits: [] });
    }
    const labor = set.laborRate && j.hours ? cents(j.hours * set.laborRate) : 0;
    const chem = j.chemCost ? cents(j.chemCost * (1 + (set.chemMarkup || 0) / 100)) : 0;
    const mat = j.materialCost ? cents(j.materialCost * (1 + (set.matMarkup || 0) / 100)) : 0;
    const visit = set.visitCharge || 0;
    by.get(key).visits.push({ id: j.id, day: j.day, crew: j.crewName || '', timeIn: j.timeIn, timeOut: j.timeOut, hours: j.hours, notes: j.notes,
      receipts: j.receipts.length, chemCost: j.chemCost, materialCost: j.materialCost, labor, chem, mat, visit, total: cents(labor + chem + mat + visit), open: !!(j.timeIn && !j.timeOut) });
  }
  const sum = (xs, k) => cents(xs.reduce((a, x) => a + (x[k] || 0), 0));
  const clients = [...by.values()].map(c => ({ ...c, totals: { visits: c.visits.length, hours: Math.round(sum(c.visits, 'hours') * 100) / 100,
    labor: sum(c.visits, 'labor'), chemCost: sum(c.visits, 'chemCost'), chem: sum(c.visits, 'chem'), materialCost: sum(c.visits, 'materialCost'),
    mat: sum(c.visits, 'mat'), visit: sum(c.visits, 'visit'), total: sum(c.visits, 'total') } }))
    .sort((a, b) => a.customer.localeCompare(b.customer));
  const T2 = clients.map(c => c.totals);
  const totals = { clients: clients.length, visits: T2.reduce((a, t) => a + t.visits, 0), hours: Math.round(sum(T2, 'hours') * 100) / 100,
    labor: sum(T2, 'labor'), chemCost: sum(T2, 'chemCost'), chem: sum(T2, 'chem'), materialCost: sum(T2, 'materialCost'), mat: sum(T2, 'mat'), visit: sum(T2, 'visit'), total: sum(T2, 'total'),
    open: clients.reduce((a, c) => a + c.visits.filter(v => v.open).length, 0) };
  return { month: mm, label: monthLabel(mm), from, to, settings: set, clients, totals, parts: Math.ceil(clients.filter(c => c.totals.total > 0).length / PER_FILE) };
}

const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const mdy = d => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

/** Everything broken out: one row per visit, a subtotal per client, and the month's total. */
function breakdownCsv(b) {
  const out = [['Client', 'Address', 'Date', 'Crew', 'Time in', 'Time out', 'Hours', 'Labor $', 'Chemical cost', 'Chemicals billed', 'Material cost', 'Materials billed', 'Visit charge', 'Total', 'Receipts', 'Notes'].map(q).join(',')];
  b.clients.forEach(c => {
    c.visits.forEach(v => out.push([c.customer, c.address, v.day, v.crew, v.timeIn, v.timeOut, v.hours, v.labor, v.chemCost, v.chem, v.materialCost, v.mat, v.visit, v.total, v.receipts, v.notes].map(q).join(',')));
    const t = c.totals;
    out.push([c.customer + ' total', c.address, `${t.visits} visit${t.visits === 1 ? '' : 's'}`, '', '', '', t.hours, t.labor, t.chemCost, t.chem, t.materialCost, t.mat, t.visit, t.total, '', ''].map(q).join(','));
  });
  const t = b.totals;
  out.push([`${b.label} total`, `${t.clients} clients`, `${t.visits} visits`, '', '', '', t.hours, t.labor, t.chemCost, t.chem, t.materialCost, t.mat, t.visit, t.total, '', ''].map(q).join(','));
  return { name: `address-jobs-${b.month}-by-client.csv`, body: out.join('\r\n') + '\r\n' };
}

/** QuickBooks invoices: one per client, a line each for labor, chemicals, materials and visit charges (dates in the description). */
async function invoicesCsv(company, b, part) {
  const set = b.settings, date = T.localNow(company.timezone).date;
  const due = (() => { const x = new Date(date + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + (set.dueDays || 0)); return x.toISOString().slice(0, 10); })();
  const billable = b.clients.filter(c => c.totals.total > 0);
  if (!billable.length) V.bad(`Nothing to invoice for ${b.label}. Set a labor rate, or add costs to the jobs.`);
  const p = Math.max(1, Math.min(b.parts || 1, Number(part) || 1));
  const out = [['Invoice no', 'Customer', 'Invoice date', 'Due date', 'Memo', 'Product/Service', 'Description', 'Qty', 'Rate', 'Amount'].map(q).join(',')];
  billable.slice((p - 1) * PER_FILE, p * PER_FILE).forEach((c, i) => {
    const no = `${set.prefix}${b.month.replace('-', '')}-${String((p - 1) * PER_FILE + i + 1).padStart(3, '0')}`;
    const head = [no, c.customer, mdy(date), mdy(due), `${b.label}: ${c.address}`];
    const visits = c.visits;
    const dates = k => visits.filter(v => v[k]).map(v => md(v.day) + (k === 'labor' ? ` (${v.hours} h)` : '')).join(', ');
    if (c.totals.labor) out.push([...head, set.laborItem, `${c.address}, ${dates('labor')}`, c.totals.hours, set.laborRate, c.totals.labor.toFixed(2)].map(q).join(','));
    if (c.totals.chem) out.push([...head, set.chemItem, `Chemicals, ${dates('chem')}`, 1, c.totals.chem, c.totals.chem.toFixed(2)].map(q).join(','));
    if (c.totals.mat) out.push([...head, set.matItem, `Materials, ${dates('mat')}`, 1, c.totals.mat, c.totals.mat.toFixed(2)].map(q).join(','));
    if (c.totals.visit) out.push([...head, set.visitItem, `${c.totals.visits} visit${c.totals.visits === 1 ? '' : 's'}: ${visits.map(v => md(v.day)).join(', ')}`, c.totals.visits, set.visitCharge, c.totals.visit.toFixed(2)].map(q).join(','));
  });
  return { name: `quickbooks-job-invoices-${b.month}-part${p}of${b.parts}.csv`, body: out.join('\r\n') + '\r\n' };
}

/** The monthly email to the boss: totals and every client broken out. */
function emailHtml(company, b) {
  const { esc, layout } = require('./email');
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const td = 'padding:5px 8px;border-bottom:1px solid #ddd;font-size:13px;vertical-align:top', tr = td + ';text-align:right';
  const th = 'padding:5px 8px;border-bottom:2px solid #333;font-size:11px;text-transform:uppercase;text-align:left';
  const t = b.totals;
  let html = `<p style="margin:0 0 12px"><b>${money(t.total)}</b> to bill · ${t.clients} client${t.clients === 1 ? '' : 's'} · ${t.visits} visit${t.visits === 1 ? '' : 's'} · ${t.hours} h on site</p>
  <p style="margin:0 0 16px;color:#555">Labor ${money(t.labor)} · chemicals ${money(t.chem)} (cost ${money(t.chemCost)}) · materials ${money(t.mat)} (cost ${money(t.materialCost)})${t.visit ? ' · visit charges ' + money(t.visit) : ''}</p>`;
  if (t.open) html += `<p style="color:#b42318"><b>${t.open} visit${t.open === 1 ? ' has' : 's have'} no time out</b>, so no labor is counted for ${t.open === 1 ? 'it' : 'them'}. Fix ${t.open === 1 ? 'it' : 'them'} in Address jobs.</p>`;
  b.clients.forEach(c => {
    html += `<h3 style="margin:18px 0 4px">${esc(c.customer)} · ${money(c.totals.total)}</h3><p style="margin:0 0 6px;color:#555">${esc(c.address)}${c.owner && c.owner !== c.customer ? ' · ' + esc(c.owner) : ''}</p>
    <div style="overflow-x:auto"><table style="border-collapse:collapse"><tr>${['Date', 'Who', 'In–out', 'Hours', 'Labor', 'Chemicals', 'Materials', c.totals.visit ? 'Visit' : '', 'Total'].filter(Boolean).map(x => `<th style="${th}">${x}</th>`).join('')}</tr>`;
    c.visits.forEach(v => {
      html += `<tr><td style="${td}">${T.dayName(v.day)} ${T.pretty(v.day)}</td><td style="${td}">${esc(v.crew)}</td><td style="${td}">${v.timeIn || ''}–${v.timeOut || '<b>?</b>'}</td><td style="${tr}">${v.hours == null ? '' : v.hours}</td>`
        + `<td style="${tr}">${money(v.labor)}</td><td style="${tr}">${money(v.chem)}</td><td style="${tr}">${money(v.mat)}</td>${c.totals.visit ? `<td style="${tr}">${money(v.visit)}</td>` : ''}<td style="${tr}"><b>${money(v.total)}</b></td></tr>`
        + (v.notes ? `<tr><td style="${td};color:#555" colspan="9">${esc(v.notes)}</td></tr>` : '');
    });
    html += '</table></div>';
  });
  html += `<p style="margin-top:18px">Download the breakdown or the QuickBooks invoices: dashboard → <b>Address jobs</b> → Monthly invoices.</p>`;
  return { subject: `Address jobs, ${b.label}: ${money(t.total)} to bill (${t.clients} clients)`, html: layout(`Address jobs: ${b.label}`, html) };
}

async function sendMonth(company, m) {
  const R = require('./reports'), { send } = require('./email');
  const b = await month(company, m);
  if (!b.clients.length) return null;
  const e = emailHtml(company, b);
  await send({ to: await R.recipients(company), ...e });
  return e;
}

module.exports = { settings, save, month, breakdownCsv, invoicesCsv, emailHtml, sendMonth, prevMonth, validMonth, PER_FILE };
