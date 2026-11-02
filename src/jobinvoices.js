// Address-job invoices, one per client per month, from the crew member who did the work (e.g. "Bill Newhaul").
// Made as drafts on the 1st (or any time from the dashboard). The boss approves each one and it's emailed to the client.
const crypto = require('crypto');
const db = require('./db');
const V = require('./validate');
const T = require('./time');
const config = require('./config');
const JB = require('./jobbilling');
const M = require('./meters');
const { send, esc } = require('./email');

const token = inv => crypto.createHmac('sha256', config.secret).update(`job-invoice:${inv.id}:${inv.company_id}`).digest('hex').slice(0, 32);
const link = inv => `${config.appUrl}/inv/${inv.id}/${token(inv)}`;
const okToken = (inv, t) => { const a = Buffer.from(token(inv)), b = Buffer.from(String(t || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };

/** The client's email for an address, from the members list (Email 1, else Email 2). */
async function emailLookup(companyId) {
  const rows = await db.q(`SELECT data FROM members WHERE company_id=$1 AND COALESCE(data->>'Status','Active')='Active' AND COALESCE(data->>'Deerfield address','')<>''`, [companyId]);
  const list = rows.map(({ data: d }) => ({ k: M.addrKey(d['Deerfield address']), street: M.streetOf(d['Deerfield address']), email: d['Undeliverable email'] ? '' : (d['Email 1'] || d['Email 2'] || '') }));
  return address => {
    const k = M.addrKey(address), s = M.streetOf(address);
    const hit = k.house && list.find(m => m.email && m.street && s.includes(m.street) && M.sameProperty(k, m.k));
    return hit ? String(hit.email).trim().toLowerCase() : '';
  };
}

/**
 * Make (or bring up to date) the month's invoices for every crew member with address jobs.
 * Sent invoices never change. Drafts are rebuilt from the jobs; a draft whose client has no jobs any more is removed.
 */
async function build(company, month) {
  const m = JB.validMonth(month) ? month : JB.prevMonth(T.localNow(company.timezone).date);
  const set = await JB.settings(company.id);
  const crew = await db.q("SELECT DISTINCT c.id, c.name FROM jobs j JOIN crew c ON c.id=j.crew_id WHERE j.company_id=$1 AND to_char(j.day,'YYYY-MM')=$2", [company.id, m]);
  const mail = await emailLookup(company.id);
  const date = T.localNow(company.timezone).date, due = T.shift(date, set.dueDays || 0);
  const kept = new Set();
  for (const person of crew) {
    const b = await JB.month(company, m, person.id);
    for (const c of b.clients) {
      if (!c.totals.total) continue;
      const have = await db.one('SELECT * FROM job_invoices WHERE company_id=$1 AND crew_id=$2 AND month=$3 AND lower(address)=lower($4)', [company.id, person.id, m, c.address]);
      const detail = { visits: c.visits, totals: c.totals, owner: c.owner, label: b.label,
        rates: { laborRate: set.laborRate, chemMarkup: set.chemMarkup, matMarkup: set.matMarkup, visitCharge: set.visitCharge } };
      if (have) {
        kept.add(have.id);
        if (have.status !== 'draft') continue;
        await db.q('UPDATE job_invoices SET customer=$1, detail=$2, total=$3, email=CASE WHEN email=$6 THEN $4 ELSE email END, from_name=$5, invoice_date=$7, due_date=$8, updated_at=now() WHERE id=$9',
          [c.customer, JSON.stringify(detail), c.totals.total, mail(c.address) || have.email, set.fromName || person.name, '', date, due, have.id]);
      } else {
        const n = (await db.one('SELECT count(*)::int AS n FROM job_invoices WHERE company_id=$1 AND month=$2', [company.id, m])).n + 1;
        const number = `${set.prefix || 'J'}${m.replace('-', '')}-${String(n).padStart(3, '0')}`;
        const r = await db.one(`INSERT INTO job_invoices (company_id, crew_id, month, number, address, customer, email, from_name, detail, total, invoice_date, due_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [company.id, person.id, m, number, c.address, c.customer, mail(c.address), set.fromName || person.name, JSON.stringify(detail), c.totals.total, date, due]);
        kept.add(r.id);
      }
    }
  }
  const drafts = await db.q("SELECT id FROM job_invoices WHERE company_id=$1 AND month=$2 AND status='draft'", [company.id, m]);
  for (const d of drafts) if (!kept.has(d.id)) await db.q('DELETE FROM job_invoices WHERE id=$1', [d.id]);
  return list(company, m);
}

async function list(company, month) {
  const m = JB.validMonth(month) ? month : JB.prevMonth(T.localNow(company.timezone).date);
  const rows = await db.q(`SELECT i.*, to_char(i.invoice_date,'YYYY-MM-DD') AS invoice_date, to_char(i.due_date,'YYYY-MM-DD') AS due_date, c.name AS crew_name, c.email AS crew_email
    FROM job_invoices i LEFT JOIN crew c ON c.id=i.crew_id WHERE i.company_id=$1 AND i.month=$2 ORDER BY i.number`, [company.id, m]);
  const invoices = rows.map(r => ({ id: r.id, number: r.number, month: r.month, crewName: r.crew_name, fromName: r.from_name, address: r.address, customer: r.customer, email: r.email,
    total: Number(r.total), status: r.status, sentAt: r.sent_at, sentTo: r.sent_to, invoiceDate: r.invoice_date, dueDate: r.due_date, visits: r.detail.visits.length, link: link(r) }));
  const sum = k => Math.round(invoices.filter(k).reduce((a, i) => a + i.total, 0) * 100) / 100;
  return { month: m, label: JB.validMonth(m) ? new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : m,
    invoices, totals: { drafts: invoices.filter(i => i.status === 'draft').length, sent: invoices.filter(i => i.status === 'sent').length,
      toSend: sum(i => i.status === 'draft'), sentTotal: sum(i => i.status === 'sent'), noEmail: invoices.filter(i => i.status === 'draft' && !i.email).length } };
}

const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ampm = t => { if (!t) return ''; const h = Number(t.slice(0, 2)); return `${h % 12 || 12}:${t.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`; };

/** The invoice itself, as the client sees it. From the crew member's name (not the company). */
function invoiceHtml(inv, payTo, fromEmail) {
  const d = inv.detail, t = d.totals, r = d.rates || {};
  const td = 'padding:7px 8px;border-bottom:1px solid #e3e3e3;font-size:14px;vertical-align:top', tr = td + ';text-align:right;white-space:nowrap';
  const th = 'padding:7px 8px;border-bottom:2px solid #222;font-size:11px;letter-spacing:.04em;text-transform:uppercase;text-align:left';
  const showVisit = t.visit > 0, showL = t.labor > 0, showC = t.chem > 0, showM = t.mat > 0;   // leave out empty columns (phones)
  const rows = d.visits.map(v => `<tr><td style="${td}">${esc(T.dayName(v.day))} ${esc(T.pretty(v.day))}${v.notes ? `<br><span style="color:#666">${esc(v.notes)}</span>` : ''}</td>
    <td style="${td}">${v.timeIn ? esc(ampm(v.timeIn)) + ' – ' + esc(ampm(v.timeOut)) : ''}</td><td style="${tr}">${v.hours == null ? '' : v.hours}</td>
    ${showL ? `<td style="${tr}">${v.labor ? money(v.labor) : ''}</td>` : ''}${showC ? `<td style="${tr}">${v.chem ? money(v.chem) : ''}</td>` : ''}${showM ? `<td style="${tr}">${v.mat ? money(v.mat) : ''}</td>` : ''}
    ${showVisit ? `<td style="${tr}">${money(v.visit)}</td>` : ''}<td style="${tr}"><b>${money(v.total)}</b></td></tr>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:760px;margin:0 auto;padding:24px">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:top"><div style="font-size:26px;font-weight:bold">${esc(inv.from_name)}</div>${(fromEmail || inv.crew_email) ? `<div style="color:#555">${esc(fromEmail || inv.crew_email)}</div>` : ''}</td>
    <td style="vertical-align:top;text-align:right"><div style="font-size:22px;letter-spacing:.08em;font-weight:bold">INVOICE</div>
      <div style="color:#555">No. ${esc(inv.number)}<br>Date: ${esc(T.pretty(inv.invoice_date))}<br>Due: <b>${esc(T.pretty(inv.due_date))}</b></div></td></tr></table>
  <div style="margin:22px 0 14px"><div style="font-size:11px;text-transform:uppercase;color:#777;letter-spacing:.06em">Bill to</div>
    <div style="font-size:16px;font-weight:bold">${esc(inv.customer)}</div><div>${esc(inv.address)}</div></div>
  <div style="margin:0 0 8px;color:#555">Services for ${esc(d.label)}</div>
  <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%"><tr><th style="${th}">Date</th><th style="${th}">Time</th><th style="${th};text-align:right">Hours</th>
    ${showL ? `<th style="${th};text-align:right">Labor</th>` : ''}${showC ? `<th style="${th};text-align:right">Chemicals</th>` : ''}${showM ? `<th style="${th};text-align:right">Materials</th>` : ''}${showVisit ? `<th style="${th};text-align:right">Service call</th>` : ''}<th style="${th};text-align:right">Total</th></tr>
    ${rows}
    <tr><td style="${td};font-weight:bold" colspan="2">${t.visits} visit${t.visits === 1 ? '' : 's'}</td><td style="${tr};font-weight:bold">${t.hours}</td>${showL ? `<td style="${tr};font-weight:bold">${money(t.labor)}</td>` : ''}
    ${showC ? `<td style="${tr};font-weight:bold">${money(t.chem)}</td>` : ''}${showM ? `<td style="${tr};font-weight:bold">${money(t.mat)}</td>` : ''}${showVisit ? `<td style="${tr};font-weight:bold">${money(t.visit)}</td>` : ''}<td style="${tr};font-size:17px;font-weight:bold">${money(t.total)}</td></tr>
  </table></div>
  ${r.laborRate && showL ? `<p style="color:#666;font-size:12px;margin:8px 0 0">Labor at ${money(r.laborRate)} per hour on site.</p>` : ''}
  <p style="font-size:20px;text-align:right;margin:18px 0"><b>Amount due: ${money(t.total)}</b></p>
  ${payTo ? `<div style="border-top:1px solid #ddd;padding-top:12px;white-space:pre-wrap">${esc(payTo)}</div>` : ''}
  ${payTo && /reply/i.test(payTo) ? '' : '<p style="color:#777;font-size:12px;margin-top:18px">Questions? Reply to this email.</p>'}</div>`;
}

async function getFull(companyId, id) {
  return db.one(`SELECT i.*, to_char(i.invoice_date,'YYYY-MM-DD') AS invoice_date, to_char(i.due_date,'YYYY-MM-DD') AS due_date, c.name AS crew_name, c.email AS crew_email
    FROM job_invoices i LEFT JOIN crew c ON c.id=i.crew_id WHERE i.id=$1 AND i.company_id=$2`, [id, companyId]);
}

/** Change a draft's client email (or customer name). */
async function edit(companyId, id, b) {
  const inv = await getFull(companyId, id);
  if (!inv) V.bad('That invoice was not found.');
  if (inv.status !== 'draft') V.bad('That invoice was already sent.');
  const email = b.email !== undefined ? (String(b.email || '').trim() ? V.email(b.email) : '') : inv.email;
  const customer = b.customer !== undefined ? V.str(b.customer, 'the client name', 1, 160) : inv.customer;
  await db.q('UPDATE job_invoices SET email=$1, customer=$2, updated_at=now() WHERE id=$3', [email, customer, id]);
}

/** Approve and email it to the client. Only drafts; only once. */
async function approveSend(company, id, by, emailOverride) {
  const first = await getFull(company.id, id);
  if (first && first.status === 'draft' && emailOverride != null && String(emailOverride).trim()) await edit(company.id, id, { email: emailOverride });
  const inv = await getFull(company.id, id);
  if (!inv) V.bad('That invoice was not found.');
  if (inv.status === 'sent') V.bad(`Already sent to ${inv.sent_to}.`);
  if (inv.status !== 'draft') V.bad('That invoice was cancelled.');
  if (!inv.email) V.bad("Add the client's email first.");
  const set = await JB.settings(company.id);
  const claim = await db.q("UPDATE job_invoices SET status='sending' WHERE id=$1 AND status='draft' RETURNING id", [id]);
  if (!claim.length) V.bad('That invoice is already being sent.');
  try {
    const fromEmail = set.fromEmail || inv.crew_email || '';
    await send({ to: [inv.email], subject: `Invoice ${inv.number} from ${inv.from_name}: ${money(inv.total)}`, html: invoiceHtml(inv, set.payTo, fromEmail),
      fromName: inv.from_name, fromAddress: fromEmail || undefined, replyTo: fromEmail || undefined });
  } catch (e) { await db.q("UPDATE job_invoices SET status='draft' WHERE id=$1", [id]); throw e; }
  await db.q("UPDATE job_invoices SET status='sent', sent_at=now(), sent_to=$1, approved_by=$2 WHERE id=$3", [inv.email, String(by || '').slice(0, 120), id]);
}

async function voidInvoice(companyId, id, undo) {
  const r = await db.q(`UPDATE job_invoices SET status=$1 WHERE id=$2 AND company_id=$3 AND status=$4 RETURNING id`, undo ? ['draft', id, companyId, 'void'] : ['void', id, companyId, 'draft']);
  if (!r.length) V.bad(undo ? 'That invoice is not cancelled.' : 'Only invoices not sent yet can be cancelled.');
}

/** The boss's monthly email: every invoice ready to go, each with a Review & send link. */
async function sendMonthly(company, month) {
  const R = require('./reports'), { layout } = require('./email');
  const L = await build(company, month);
  if (!L.invoices.length) return null;
  const td = 'padding:7px 8px;border-bottom:1px solid #ddd;font-size:14px;vertical-align:top';
  const t = L.totals;
  let html = `<p style="margin:0 0 14px"><b>${t.drafts} invoice${t.drafts === 1 ? '' : 's'} ready to send · ${money(t.toSend)}</b>${t.noEmail ? ` · <span style="color:#b42318">${t.noEmail} need a client email</span>` : ''}</p>
  <p style="margin:0 0 14px;color:#555">Tap <b>Review &amp; send</b> on each one: you see the invoice exactly as the client will, then approve it and it's emailed to them.</p>
  <table style="border-collapse:collapse;width:100%"><tr>${['Invoice', 'Client', 'From', 'Total', ''].map(x => `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #333;font-size:11px;text-transform:uppercase">${x}</th>`).join('')}</tr>`;
  L.invoices.filter(i => i.status === 'draft').forEach(i => {
    html += `<tr><td style="${td}">${esc(i.number)}</td><td style="${td}"><b>${esc(i.customer)}</b><br><span style="color:#666">${esc(i.address)}<br>${i.email ? esc(i.email) : '<span style="color:#b42318">no email yet</span>'}</span></td>
      <td style="${td}">${esc(i.fromName)}</td><td style="${td};text-align:right;white-space:nowrap"><b>${money(i.total)}</b><br><span style="color:#666">${i.visits} visit${i.visits === 1 ? '' : 's'}</span></td>
      <td style="${td}"><a href="${i.link}" style="display:inline-block;background:#e3a008;color:#1f2328;padding:8px 12px;border-radius:6px;text-decoration:none;font-weight:bold;white-space:nowrap">Review &amp; send</a></td></tr>`;
  });
  html += `</table><p style="margin-top:16px"><a href="${config.appUrl}/admin#jobs">Open Bill’s Billables in your dashboard</a> to see every invoice, change an email, or download the breakdown.</p>`;
  const e = { subject: `${t.drafts} invoice${t.drafts === 1 ? '' : 's'} ready to approve: ${L.label} (${money(t.toSend)})`, html: layout(`Invoices to approve: ${L.label}`, html) };
  await send({ to: await R.recipients(company), ...e });
  return e;
}

module.exports = { build, list, edit, approveSend, voidInvoice, invoiceHtml, getFull, sendMonthly, okToken, link, token };
