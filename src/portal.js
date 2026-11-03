// Owner portal for water customers: their usage, high-use alerts, problem reports, notices and documents.
// Sign-in: type the property address -> a sign-in link is emailed to the email(s) on the members list for it.
// No email on file: give the account number (Act #) from the bill + an email -> the boss approves -> link emailed.
// An owner only ever sees the properties they were let into.
const crypto = require('crypto');
const db = require('./db');
const V = require('./validate');
const T = require('./time');
const config = require('./config');
const M = require('./meters');
const { send, esc, layout } = require('./email');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const COOKIE = 'ch_portal', DAYS = 90, LINK_MINUTES = 60;
const mask = e => { const [u, d] = String(e).split('@'); return (u.length <= 2 ? u[0] + '•' : u.slice(0, 2) + '•'.repeat(Math.min(6, u.length - 2))) + '@' + d; };
const normAcct = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');

/** Addresses on the route that match what they typed (addresses only, never names). */
async function findAddresses(companyId, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length || String(q).trim().length < 2) return [];
  const rows = await db.q("SELECT id, address FROM meters WHERE company_id=$1 AND active AND address<>'' ORDER BY seq", [companyId]);
  return rows.filter(r => words.every(w => r.address.toLowerCase().includes(w))).slice(0, 8).map(r => ({ id: r.id, address: r.address }));
}

/** Emails on the members list for a property (Email 1 and 2 of everyone listed there). */
async function emailsFor(companyId, address) {
  const k = M.addrKey(address), s = M.streetOf(address);
  if (!k.house) return [];
  const rows = await db.q(`SELECT data FROM members WHERE company_id=$1 AND COALESCE(data->>'Status','Active')='Active' AND COALESCE(data->>'Deerfield address','')<>''`, [companyId]);
  const out = new Set();
  rows.forEach(({ data: d }) => {
    const a = d['Deerfield address'], ms = M.streetOf(a);
    if (!ms || !s.includes(ms) || !M.sameProperty(k, M.addrKey(a)) || d['Undeliverable email']) return;
    [d['Email 1'], d['Email 2']].forEach(e => { e = String(e || '').trim().toLowerCase(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) out.add(e); });
  });
  return [...out];
}

async function meterOf(companyId, meterId) {
  return db.one('SELECT id, address, account, meter_no, name FROM meters WHERE id=$1 AND company_id=$2 AND active', [Number(meterId), companyId]);
}

/** Email a sign-in link for one property. */
async function sendLink(company, email, meterId) {
  const token = newToken();
  await db.q(`INSERT INTO portal_tokens (token_hash, company_id, email, meter_id, expires_at) VALUES ($1,$2,$3,$4, now() + $5::interval)`,
    [sha(token), company.id, email, meterId, LINK_MINUTES + ' minutes']);
  const m = await meterOf(company.id, meterId);
  const url = `${config.appUrl}/p/${company.slug}/in/${token}`;
  await send({ to: [email], subject: `Your sign-in link: ${company.name} owner portal`,
    html: layout(`${esc(company.name)} owner portal`, `<p>Tap the button to sign in and see your water use, notices and documents for <b>${esc(m ? m.address : '')}</b>.</p>
      <p><a href="${url}" style="display:inline-block;background:#e3a008;color:#1f2328;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Sign in</a></p>
      <p style="color:#777;font-size:12px">The link works once and for ${LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.</p>`) });
}

/** Step 1: they picked their address. */
async function start(company, meterId) {
  const m = await meterOf(company.id, meterId);
  if (!m) V.bad('Pick your address from the list.');
  const emails = await emailsFor(company.id, m.address);
  if (!emails.length) return { needAccount: true, address: m.address };
  for (const e of emails) await sendLink(company, e, m.id);
  return { sent: true, to: emails.map(mask), address: m.address };
}

/** Step 1b: no email on file. The account number must match the meter; the boss approves. */
async function request(company, b) {
  const m = await meterOf(company.id, b.meterId);
  if (!m) V.bad('Pick your address from the list.');
  const email = V.email(b.email), name = V.str(b.name, 'your name', 1, 120);
  const phone = String(b.phone || '').trim().slice(0, 40);
  if (!m.account || !normAcct(b.account) || normAcct(b.account) !== normAcct(m.account)) return { ok: false };
  const have = await db.one("SELECT id FROM portal_requests WHERE company_id=$1 AND meter_id=$2 AND lower(email)=$3 AND status='pending'", [company.id, m.id, email]);
  if (!have) await db.q('INSERT INTO portal_requests (company_id, meter_id, email, name, phone) VALUES ($1,$2,$3,$4,$5)', [company.id, m.id, email, name, phone]);
  const R = require('./reports');
  send({ to: await R.recipients(company), subject: `Owner portal: ${name} asked to sign up for ${m.address}`,
    html: layout('Owner portal request', `<p><b>${esc(name)}</b> (${esc(email)}${phone ? ', ' + esc(phone) : ''}) asked to see <b>${esc(m.address)}</b>. The account number matched.</p>
      <p><a href="${config.appUrl}/admin#portal">Approve or deny it in your dashboard</a>. When you approve, they get a sign-in link by email.</p>`) }).catch(() => {});
  return { ok: true, pending: true };
}

/** The emailed link: sign in, and let this person into that property from now on. */
async function useLink(company, token) {
  const row = await db.one(`UPDATE portal_tokens SET used=TRUE WHERE token_hash=$1 AND company_id=$2 AND NOT used AND expires_at > now()
    RETURNING email, meter_id`, [sha(token), company.id]);
  if (!row) return null;
  const u = await db.one(`INSERT INTO portal_users (company_id, email) VALUES ($1,$2)
    ON CONFLICT (company_id, email) DO UPDATE SET last_seen=now() RETURNING id`, [company.id, row.email]);
  if (row.meter_id) await db.q('INSERT INTO portal_access (user_id, meter_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, row.meter_id]);
  const s = newToken();
  await db.q('INSERT INTO portal_sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + $3::interval)', [sha(s), u.id, DAYS + ' days']);
  return s;
}
const cookie = (res, s) => res.cookie(COOKIE, s, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: DAYS * 864e5, path: '/' });

/** Middleware for /api/p/:slug/*: req.portalUser (signed in to this company) or 401. */
async function requireUser(req, res, next) {
  try {
    const t = req.cookies[COOKIE];
    const row = t && await db.one(`SELECT u.id, u.email, u.name, u.company_id FROM portal_sessions s JOIN portal_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at > now()`, [sha(t)]);
    if (!row || row.company_id !== req.company.id) return res.status(401).json({ error: 'SIGNED_OUT' });
    req.portalUser = row; next();
  } catch (e) { next(e); }
}
async function signOut(req, res) {
  const t = req.cookies[COOKIE];
  if (t) await db.q('DELETE FROM portal_sessions WHERE token_hash=$1', [sha(t)]);
  res.clearCookie(COOKIE, { path: '/' });
}

const meterIdsOf = async userId => (await db.q('SELECT meter_id FROM portal_access WHERE user_id=$1', [userId])).map(r => r.meter_id);

/** Quarterly use in gallons for one meter, oldest first. The first reading after the old sheet is the starting point. */
async function usageOf(companyId, meterId, unitGallons) {
  const reads = await db.q('SELECT month AS quarter, reading::float AS reading FROM meter_reads WHERE company_id=$1 AND meter_id=$2 ORDER BY month', [companyId, meterId]);
  const out = [];
  for (let i = 0; i < reads.length; i++) {
    const r = reads[i], p = reads[i - 1];
    out.push({ quarter: r.quarter, label: M.label(r.quarter), reading: r.reading,
      gallons: p && r.reading >= p.reading ? Math.round((r.reading - p.reading) * unitGallons / Math.max(1, M.quartersBetween(p.quarter, r.quarter))) : null, starting: !p });
  }
  return out;
}

/** Everything an owner sees. */
async function home(company, user) {
  const B = require('./billing');
  const set = await B.settings(company.id), unit = Number(set.unitGallons) || 1;
  const ids = await meterIdsOf(user.id);
  const rt = ids.length ? await M.route(company) : { meters: [] };
  const props = [];
  for (const id of ids) {
    const m = rt.meters.find(x => x.id === id) || (await meterOf(company.id, id));
    if (!m) continue;
    const quarters = await usageOf(company.id, id, unit);
    const thisQ = M.quarterOf(company), cur = quarters.find(q => q.quarter === thisQ) || null;
    const alert = m.alert && m.alert.level === 'high' && !m.flagOk ? { times: m.alert.times } : null;
    const reports = (await db.q(`SELECT id, title, status, to_char(created_at,'YYYY-MM-DD') AS reported, to_char(done_at,'YYYY-MM-DD') AS fixed
      FROM tasks WHERE company_id=$1 AND kind='repair' AND portal_meter_id=$2 ORDER BY id DESC LIMIT 20`, [company.id, id]));
    const docs = await db.q("SELECT id, title, mime, size, to_char(created_at,'YYYY-MM-DD') AS added FROM portal_docs WHERE company_id=$1 AND meter_id=$2 ORDER BY id DESC", [company.id, id]);
    const qbo = await require('./qbo').forMeter(company.id, id);   // balance, invoices, payments from QuickBooks (null if not linked)
    props.push({ meterId: id, address: m.address, account: m.account, meterNo: m.meterNo || m.meter_no, quarters: quarters.slice(-8), current: cur, thisQuarter: M.label(thisQ), alert, reports, docs, qbo });
  }
  const today = T.localNow(company.timezone).date;
  const notices = await db.q(`SELECT id, title, body, kind, to_char(starts,'YYYY-MM-DD') AS starts, to_char(ends,'YYYY-MM-DD') AS ends FROM portal_notices
    WHERE company_id=$1 AND starts <= $2 AND (ends IS NULL OR ends >= $2) ORDER BY CASE kind WHEN 'boil' THEN 0 WHEN 'shutoff' THEN 1 ELSE 2 END, starts DESC`, [company.id, today]);
  const docs = await db.q("SELECT id, title, mime, size, to_char(created_at,'YYYY-MM-DD') AS added FROM portal_docs WHERE company_id=$1 AND meter_id IS NULL ORDER BY title", [company.id]);
  await db.q('UPDATE portal_users SET last_seen=now() WHERE id=$1', [user.id]);
  return { company: company.name, email: user.email, name: user.name, properties: props, notices, docs,
    billing: { allowance: set.allowance, overRate: set.overRate, base: set.base } };
}

/** An owner reports a problem: it goes into Leaks & repairs, tagged with their property. */
async function report(company, user, b) {
  const ids = await meterIdsOf(user.id);
  const meterId = Number(b.meterId);
  if (!ids.includes(meterId)) V.bad('Pick one of your properties.');
  const m = await meterOf(company.id, meterId);
  const K = require('./tasks');
  const what = V.str(b.title, 'what the problem is', 1, 100);
  const n = await db.one("SELECT count(*)::int AS n FROM tasks WHERE company_id=$1 AND portal_meter_id=$2 AND created_at > now() - interval '1 day'", [company.id, meterId]);
  if (n.n >= 5) V.bad('You have sent a lot of reports today. Call the office if it is urgent.');
  const details = `Reported by the owner (${user.name || user.email}${b.phone ? ', ' + String(b.phone).slice(0, 40) : ''}) on the owner portal.` + (b.details ? '\n' + String(b.details).trim().slice(0, 1500) : '');
  const id = await K.create(company.id, { kind: 'repair', title: `${what} (${m.address})`.slice(0, 120), details, address: m.address, photos: b.photos, priority: 'normal' });
  await db.q('UPDATE tasks SET portal_meter_id=$1 WHERE id=$2', [meterId, id]);
  const R = require('./reports');
  send({ to: await R.recipients(company), subject: `Owner report: ${what} at ${m.address}`,
    html: layout('Problem reported on the owner portal', `<p><b>${esc(m.address)}</b>: ${esc(what)}</p>${b.details ? `<p style="white-space:pre-wrap">${esc(String(b.details).slice(0, 1500))}</p>` : ''}
      <p>From ${esc(user.name || user.email)} (${esc(user.email)}). It's in Water System → Leaks &amp; repairs.</p>`) }).catch(() => {});
}

/** A document the owner may open: community-wide, or for one of their properties. */
async function doc(company, user, id) {
  const d = await db.one('SELECT title, mime, data, meter_id FROM portal_docs WHERE id=$1 AND company_id=$2', [id, company.id]);
  if (!d) return null;
  if (d.meter_id && !(await meterIdsOf(user.id)).includes(d.meter_id)) return null;
  return d;
}

/* ------------------------------- the boss's side ------------------------------- */
async function adminView(company) {
  const requests = await db.q(`SELECT r.id, r.email, r.name, r.phone, r.status, r.created_at AS "createdAt", m.address, m.account FROM portal_requests r
    JOIN meters m ON m.id=r.meter_id WHERE r.company_id=$1 AND (r.status='pending' OR r.created_at > now() - interval '30 days') ORDER BY r.status<>'pending', r.id DESC`, [company.id]);
  const users = await db.q(`SELECT u.id, u.email, u.name, u.last_seen AS "lastSeen", COALESCE(json_agg(json_build_object('meterId', m.id, 'address', m.address)) FILTER (WHERE m.id IS NOT NULL), '[]') AS properties
    FROM portal_users u LEFT JOIN portal_access a ON a.user_id=u.id LEFT JOIN meters m ON m.id=a.meter_id WHERE u.company_id=$1 GROUP BY u.id ORDER BY u.last_seen DESC NULLS LAST`, [company.id]);
  const notices = await db.q(`SELECT id, title, body, kind, to_char(starts,'YYYY-MM-DD') AS starts, to_char(ends,'YYYY-MM-DD') AS ends, emailed_to AS "emailedTo" FROM portal_notices WHERE company_id=$1 ORDER BY starts DESC, id DESC LIMIT 100`, [company.id]);
  const docs = await db.q(`SELECT d.id, d.title, d.mime, d.size, d.meter_id AS "meterId", m.address, to_char(d.created_at,'YYYY-MM-DD') AS added FROM portal_docs d
    LEFT JOIN meters m ON m.id=d.meter_id WHERE d.company_id=$1 ORDER BY d.meter_id NULLS FIRST, d.title`, [company.id]);
  return { on: !!company.portal_on, link: `${config.appUrl}/p/${company.slug}/`, requests, users, notices, docs };
}

async function decide(company, id, approve) {
  const r = await db.one("SELECT * FROM portal_requests WHERE id=$1 AND company_id=$2 AND status='pending'", [id, company.id]);
  if (!r) V.bad('That request was already handled.');
  await db.q('UPDATE portal_requests SET status=$1 WHERE id=$2', [approve ? 'approved' : 'denied', id]);
  if (approve) {
    await db.q(`INSERT INTO portal_users (company_id, email, name) VALUES ($1,$2,$3) ON CONFLICT (company_id, email) DO UPDATE SET name=COALESCE(NULLIF(portal_users.name,''), EXCLUDED.name)`, [company.id, r.email, r.name]);
    await sendLink(company, r.email, r.meter_id);
  }
}

async function removeAccess(companyId, userId, meterId) {
  const u = await db.one('SELECT id FROM portal_users WHERE id=$1 AND company_id=$2', [userId, companyId]);
  if (!u) V.bad('That owner was not found.');
  if (meterId) await db.q('DELETE FROM portal_access WHERE user_id=$1 AND meter_id=$2', [userId, meterId]);
  else { await db.q('DELETE FROM portal_users WHERE id=$1', [userId]); }
}

const KINDS = ['info', 'boil', 'shutoff', 'alert'];
async function saveNotice(company, id, b) {
  const title = V.str(b.title, 'a title', 1, 120), body = String(b.body || '').trim().slice(0, 4000);
  const kind = KINDS.includes(b.kind) ? b.kind : 'info';
  const today = T.localNow(company.timezone).date;
  const starts = b.starts ? (T.isDate(b.starts) ? b.starts : V.bad('Pick a valid start date.')) : today;
  const ends = b.ends ? (T.isDate(b.ends) ? b.ends : V.bad('Pick a valid end date.')) : null;
  if (ends && ends < starts) V.bad('The end date is before the start date.');
  let nid = id;
  if (id) { const r = await db.q('UPDATE portal_notices SET title=$1, body=$2, kind=$3, starts=$4, ends=$5 WHERE id=$6 AND company_id=$7 RETURNING id', [title, body, kind, starts, ends, id, company.id]); if (!r.length) V.bad('That notice was not found.'); }
  else nid = (await db.one('INSERT INTO portal_notices (company_id, title, body, kind, starts, ends) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [company.id, title, body, kind, starts, ends])).id;
  if (b.email) {
    const to = (await db.q('SELECT email FROM portal_users WHERE company_id=$1', [company.id])).map(r => r.email);
    const label = { boil: 'BOIL WATER NOTICE', shutoff: 'Planned water shutoff', alert: 'Important', info: 'Notice' }[kind];
    const html = layout(`${esc(company.name)}: ${esc(label)}`, `<h2 style="margin:0 0 8px">${esc(title)}</h2>${body ? `<p style="white-space:pre-wrap">${esc(body)}</p>` : ''}
      <p style="color:#555">${ends ? `${esc(T.pretty(starts))} – ${esc(T.pretty(ends))}` : `From ${esc(T.pretty(starts))}`}</p>
      <p><a href="${config.appUrl}/p/${company.slug}/">Open the owner portal</a></p>`);
    let sent = 0;
    for (const e of to) { try { await send({ to: [e], subject: `${label}: ${title}`, html }); sent++; } catch (err) { /* keep going */ } }
    await db.q('UPDATE portal_notices SET emailed_to=$1 WHERE id=$2', [sent, nid]);
  }
}
const removeNotice = (companyId, id) => db.q('DELETE FROM portal_notices WHERE id=$1 AND company_id=$2', [id, companyId]);

const DOC_TYPES = { 'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47] };
async function addDoc(company, buf, q) {
  if (!Buffer.isBuffer(buf) || !buf.length) V.bad('Pick a file.');
  if (buf.length > 12 * 1024 * 1024) V.bad('Files up to 12 MB.');
  const mime = Object.keys(DOC_TYPES).find(t => DOC_TYPES[t].every((b, i) => buf[i] === b));
  if (!mime) V.bad('Upload a PDF, JPG or PNG.');
  const title = V.str(q.title, 'a title', 1, 120);
  let meterId = null;
  if (q.meterId) { const m = await meterOf(company.id, q.meterId); if (!m) V.bad('Pick an address on the route.'); meterId = m.id; }
  const n = (await db.one('SELECT count(*)::int AS n FROM portal_docs WHERE company_id=$1', [company.id])).n;
  if (n >= 2000) V.bad('That is a lot of documents. Remove some first.');
  await db.q('INSERT INTO portal_docs (company_id, meter_id, title, mime, data, size) VALUES ($1,$2,$3,$4,$5,$6)', [company.id, meterId, title, mime, buf, buf.length]);
}
const removeDoc = (companyId, id) => db.q('DELETE FROM portal_docs WHERE id=$1 AND company_id=$2', [id, companyId]);
const docForBoss = (companyId, id) => db.one('SELECT title, mime, data FROM portal_docs WHERE id=$1 AND company_id=$2', [id, companyId]);

module.exports = { sendInvite: sendLink, findAddresses, emailsFor, start, request, useLink, cookie, requireUser, signOut, home, report, doc, usageOf,
  adminView, decide, removeAccess, saveNotice, removeNotice, addDoc, removeDoc, docForBoss, mask, COOKIE };
