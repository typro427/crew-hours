// Quarterly water billing: invoices for QuickBooks Online's "Import invoices" (Settings > Import data > Invoices).
// QuickBooks takes up to 100 invoices per file, so the quarter is split into parts.
const db = require('./db');
const V = require('./validate');
const T = require('./time');
const MT = require('./meters');

const PER_FILE = 100;
const DEFAULTS = { rate: null, item: 'Water usage', base: null, baseItem: 'Water base charge', dueDays: 30, prefix: 'W' };

async function settings(companyId) {
  const c = await db.one('SELECT billing FROM companies WHERE id=$1', [companyId]);
  return { ...DEFAULTS, ...((c && c.billing) || {}) };
}

const money = (v, what) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > 1e6) V.bad(`The ${what} must be a dollar amount, like 0.012 or 25.`);
  return Math.round(n * 100000) / 100000;   // rates can be fractions of a cent per gallon
};

async function save(companyId, b) {
  const cur = await settings(companyId);
  const s = (v, d, n) => (v === undefined ? d : String(v || '').trim().slice(0, n) || d);
  const out = {
    rate: b.rate !== undefined ? money(b.rate, 'rate') : cur.rate,
    item: s(b.item, DEFAULTS.item, 100),
    base: b.base !== undefined ? money(b.base, 'base charge') : cur.base,
    baseItem: s(b.baseItem, DEFAULTS.baseItem, 100),
    dueDays: b.dueDays !== undefined ? V.int(b.dueDays, 'Days until due', 0, 365) : cur.dueDays,
    prefix: b.prefix !== undefined ? String(b.prefix || '').trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 8) : cur.prefix
  };
  await db.q('UPDATE companies SET billing=$1 WHERE id=$2', [JSON.stringify(out), companyId]);
  return out;
}

const mdy = d => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const cents = n => Math.round(n * 100) / 100;

/**
 * Invoices for a quarter: one per meter that was read, in read-sequence order.
 * Skipped: not read, lower than last (QuickBooks can't take negatives), and nothing to charge.
 */
async function invoices(company, quarter) {
  const set = await settings(company.id);
  const rt = await MT.route(company, quarter);
  const date = T.localNow(company.timezone).date, due = addDays(date, set.dueDays);
  const tag = rt.quarter.slice(2, 4) + rt.quarter.slice(5);   // 2026-Q4 -> 26Q4
  const list = [], skipped = [];
  for (const m of rt.meters) {
    if (!m.meterNo) continue;
    const who = m.qbCustomer || m.name;
    if (m.current == null) { skipped.push({ seq: m.seq, name: who, why: 'Not read' }); continue; }
    if (m.usage == null || m.usage < 0) { skipped.push({ seq: m.seq, name: who, why: m.usage < 0 ? 'Lower than last reading' : 'No last reading' }); continue; }
    const lines = [];
    if (set.rate) lines.push({ item: set.item, desc: `${rt.label}: ${m.previous} to ${m.current}, meter ${m.meterNo}`, qty: m.usage, rate: set.rate, amount: cents(m.usage * set.rate) });
    if (set.base) lines.push({ item: set.baseItem, desc: `${rt.label} base charge`, qty: 1, rate: set.base, amount: cents(set.base) });
    const total = cents(lines.reduce((a, l) => a + l.amount, 0));
    if (!total) { skipped.push({ seq: m.seq, name: who, why: 'Nothing to charge' }); continue; }
    list.push({ no: `${set.prefix}${tag}-${String(m.seq).padStart(4, '0')}`, customer: who, qbMatched: !!m.qbCustomer, seq: m.seq, address: m.address, date, due, usage: m.usage, lines, total });
  }
  const parts = Math.ceil(list.length / PER_FILE);
  return { quarter: rt.quarter, label: rt.label, settings: set, ready: !!(set.rate || set.base), invoices: list, skipped, parts,
           total: cents(list.reduce((a, i) => a + i.total, 0)), notMatched: list.filter(i => !i.qbMatched).length };
}

/** One part (1-based) as a CSV for QuickBooks. */
async function csv(company, quarter, part) {
  const b = await invoices(company, quarter);
  if (!b.ready) V.bad('Set the rate (or a base charge) first.');
  const p = Math.max(1, Math.min(b.parts || 1, Number(part) || 1));
  const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const out = [['Invoice no', 'Customer', 'Invoice date', 'Due date', 'Memo', 'Product/Service', 'Description', 'Qty', 'Rate', 'Amount'].map(q).join(',')];
  b.invoices.slice((p - 1) * PER_FILE, p * PER_FILE).forEach(i => i.lines.forEach(l =>
    out.push([i.no, i.customer, mdy(i.date), mdy(i.due), `${b.label} water, ${i.address}`, l.item, l.desc, l.qty, l.rate, l.amount.toFixed(2)].map(q).join(','))));
  return { name: `quickbooks-invoices-${b.quarter}-part${p}of${b.parts || 1}.csv`, body: out.join('\r\n') + '\r\n' };
}

module.exports = { settings, save, invoices, csv, PER_FILE };
