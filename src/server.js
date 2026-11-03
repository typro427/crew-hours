const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const db = require('./db');
const { migrate } = require('./migrate');
const T = require('./time');
const scheduler = require('./scheduler');
const billing = require('./routes/billing');

const app = express();
app.set('trust proxy', 1);              // Render sits in front of the app
app.disable('x-powered-by');
const PUB = path.join(__dirname, '..', 'public');

// Security headers on everything.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  });
  if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// Tiny cookie reader (only the owner login uses a cookie).
app.use((req, res, next) => {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) req.cookies[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  next();
});

app.use('/api/stripe/webhook', billing.webhook);           // raw body, before the JSON parser
app.use('/api/admin/import', express.json({ limit: '20mb' }));
app.use('/api/admin/members/import', express.json({ limit: '20mb' }));
app.use('/api/admin/meters/import', express.json({ limit: '5mb' }));
app.use('/api/admin/meters/import-xlsx', express.raw({ type: () => true, limit: '15mb' }));
app.use('/api/admin/portal/docs', express.raw({ type: () => true, limit: '13mb' }));
app.use(/^\/api\/p\/[^/]+\/report$/, express.json({ limit: '25mb' }));   // photos
app.use(/^\/api\/c\/[^/]+\/(tasks|tasks\/\d+\/(done|progress)|jobs|jobs\/\d+|day\/[\d-]+\/photos|roads\/\d+\/mows)$/, express.json({ limit: '25mb' }));
app.use(/^\/api\/admin\/(tasks|jobs)(\/\d+(\/progress)?)?$/, express.json({ limit: '25mb' }));   // photos
app.use(express.json({ limit: '100kb' }));

// Requests that change things must come from our own pages (blocks cross-site form tricks).
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('x-ch') !== '1') return res.status(403).json({ error: 'Request blocked.' });
  next();
});

app.get('/healthz', async (req, res) => { await db.q('SELECT 1'); res.send('ok'); });
app.use('/api', require('./routes/account'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/billing', billing.router);
app.use('/api/c', require('./routes/crew'));
app.use('/api/p', require('./routes/portal'));

// Nightly backup for your own computer: curl -H "Authorization: Bearer $BACKUP_TOKEN" https://.../api/backup
app.get('/api/backup', async (req, res, next) => {
  try {
    if (!config.backupToken || req.get('authorization') !== 'Bearer ' + config.backupToken) return res.status(401).json({ error: 'Not allowed.' });
    const dump = {
      exportedAt: new Date().toISOString(),
      companies: await db.q('SELECT * FROM companies ORDER BY id'),
      owners: await db.q('SELECT id, company_id, email, name, created_at FROM owners ORDER BY id'),
      crew: await db.q('SELECT id, company_id, name, active, is_manager, email, features, created_at FROM crew ORDER BY id'),
      entries: await db.q('SELECT * FROM entries ORDER BY company_id, day'),
      approvals: await db.q('SELECT * FROM approvals ORDER BY company_id, week_start'),
      tasks: await db.q('SELECT * FROM tasks ORDER BY company_id, id'),
      taskUpdates: await db.q('SELECT * FROM task_updates ORDER BY company_id, id'),
      jobs: await db.q('SELECT * FROM jobs ORDER BY company_id, id'),
      portalUsers: await db.q('SELECT u.id, u.company_id, u.email, u.name, u.created_at, u.last_seen, COALESCE(json_agg(a.meter_id) FILTER (WHERE a.meter_id IS NOT NULL), \'[]\') AS meters FROM portal_users u LEFT JOIN portal_access a ON a.user_id=u.id GROUP BY u.id ORDER BY u.company_id, u.id'),
      portalNotices: await db.q('SELECT * FROM portal_notices ORDER BY company_id, id'),
      portalDocs: await db.q('SELECT id, company_id, meter_id, title, mime, size, created_at FROM portal_docs ORDER BY company_id, id'),
      members: await db.q('SELECT company_id, data FROM members ORDER BY company_id, position, id'),
      roads: await db.q('SELECT id, company_id, kind, name, position, active, length_mi, p_road, p_ditch, p_trees, surface, notes, reading_ids FROM roads ORDER BY company_id, kind, position'),
      roadChecks: await db.q("SELECT id, company_id, road_id, crew_id, to_char(day, 'YYYY-MM-DD') AS day, notes, created_at FROM road_mows ORDER BY company_id, id"),
      readingTypes: await db.q('SELECT * FROM reading_types ORDER BY company_id, position'),
      readings: await db.q('SELECT * FROM readings ORDER BY company_id, taken_at'),
      meters: await db.q('SELECT * FROM meters ORDER BY company_id, seq'),
      meterReads: await db.q('SELECT * FROM meter_reads ORDER BY company_id, meter_id, month'),
      photoCounts: await db.one(`SELECT (SELECT count(*)::int FROM task_photos) AS tasks, (SELECT count(*)::int FROM day_photos) AS days, (SELECT count(*)::int FROM road_mow_photos) AS checks, (SELECT count(*)::int FROM job_receipts) AS receipts`)
      // the photos themselves are too big for this file; they are in Render's own database backups
    };
    res.setHeader('Content-Disposition', `attachment; filename="crewhours-backup-${dump.exportedAt.slice(0, 10)}.json"`);
    res.json(dump);
  } catch (e) { next(e); }
});

/* ---------------------------------- pages ---------------------------------- */
const page = f => (req, res) => res.sendFile(path.join(PUB, f));
const landing = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
  .replace(/__PRICE_STARTER__/g, config.plans.starter.price).replace(/__PRICE_PRO__/g, config.plans.pro.price);
app.get('/', (req, res) => res.type('html').send(landing));
['signup', 'login', 'forgot', 'reset', 'admin', 'terms', 'privacy'].forEach(p => app.get('/' + p, page(p + '.html')));

// Address-job invoice approval: the link in the boss's monthly email. The secret link is the permission;
// opening it only shows the invoice, sending takes a tap on the button (so email link-checkers can't send it).
const JI = require('./jobinvoices');
const invPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title></head><body style="margin:0;background:#f3f2ee;font-family:Arial,Helvetica,sans-serif;color:#222">${body}</body></html>`;
async function invFor(req) {
  const id = Number(req.params.id);
  const row = Number.isFinite(id) && await db.one('SELECT id, company_id FROM job_invoices WHERE id=$1', [id]);
  if (!row || !JI.okToken(row, req.params.token)) return null;
  return { inv: await JI.getFull(row.company_id, id), company: await db.one('SELECT * FROM companies WHERE id=$1', [row.company_id]) };
}
function invView(x, msg, err) {
  const { esc } = require('./email');
  return require('./jobbilling').settings(x.company.id).then(s => {
    const i = x.inv, money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const bar = i.status === 'sent' ? `<p style="margin:0;font-size:17px"><b>✓ Sent</b> to ${esc(i.sent_to)} on ${esc(new Date(i.sent_at).toLocaleString('en-US', { timeZone: x.company.timezone || 'America/New_York' }))}.</p>`
      : i.status === 'void' ? '<p style="margin:0"><b>This invoice was cancelled.</b></p>'
      : `<form method="post" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:0">
          <label style="flex:1 1 260px;font-weight:bold;font-size:14px">Send to (client's email)<br><input name="email" type="email" required value="${esc(i.email)}" placeholder="client@example.com" style="width:100%;box-sizing:border-box;font-size:17px;padding:10px;border:1px solid #bbb;border-radius:8px;margin-top:4px"></label>
          <button style="font-size:17px;font-weight:bold;padding:12px 18px;border:0;border-radius:8px;background:#e3a008;color:#1f2328;cursor:pointer">Approve &amp; send ${money(i.total)}</button></form>`;
    return invPage(`Invoice ${esc(i.number)}`, `<div style="max-width:808px;margin:0 auto;padding:16px">
      <div style="background:#fff;border:1px solid #ddd;border-radius:12px;padding:16px;margin-bottom:14px">${msg ? `<p style="margin:0 0 10px;color:${err ? '#b42318' : '#1a7f37'};font-weight:bold">${esc(msg)}</p>` : ''}${bar}
      <p style="margin:10px 0 0;color:#666;font-size:13px">This is exactly what the client gets, from ${esc(i.from_name)}${s.fromEmail ? ' (' + esc(s.fromEmail) + ')' : ''}.</p></div>
      <div style="background:#fff;border:1px solid #ddd;border-radius:12px">${JI.invoiceHtml(i, s.payTo, s.fromEmail || i.crew_email)}</div></div>`);
  });
}
app.get('/inv/:id/:token', async (req, res, next) => {
  try { const x = await invFor(req); if (!x) return res.status(404).type('html').send(invPage('Not found', '<p style="padding:24px">That invoice link is not valid.</p>'));
    res.set('Cache-Control', 'no-store').type('html').send(await invView(x)); } catch (e) { next(e); }
});
app.post('/inv/:id/:token', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res, next) => {
  try {
    const x = await invFor(req); if (!x) return res.status(404).type('html').send(invPage('Not found', '<p style="padding:24px">That invoice link is not valid.</p>'));
    try { await JI.approveSend(x.company, x.inv.id, 'email link', (req.body || {}).email); x.inv = await JI.getFull(x.company.id, x.inv.id); res.type('html').send(await invView(x, 'Approved and sent.')); }
    catch (e) { if (!e.expose && !(e instanceof T.InputError)) throw e; x.inv = await JI.getFull(x.company.id, x.inv.id); res.status(400).type('html').send(await invView(x, e.message, true)); }
  } catch (e) { next(e); }
});

// Owner portal pages: /p/<link>/ (sign in or home), /p/<link>/in/<token> (the emailed sign-in link).
const portalHtml = fs.readFileSync(path.join(PUB, 'portal.html'), 'utf8');
app.get('/p/:slug', async (req, res, next) => {
  try {
    const c = await db.one('SELECT name, slug, portal_on FROM companies WHERE slug=$1', [String(req.params.slug).toLowerCase()]);
    if (!c || !c.portal_on) return res.status(404).type('html').send('<p style="font-family:sans-serif;padding:24px">This owner portal is not open yet.</p>');
    if (!req.path.endsWith('/')) return res.redirect(301, `/p/${c.slug}/`);
    const esc = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    res.set('Cache-Control', 'no-store').type('html').send(portalHtml.replace(/__COMPANY__/g, esc(c.name)).replace(/__SLUG__/g, c.slug));
  } catch (e) { next(e); }
});
app.get('/p/:slug/in/:token', async (req, res, next) => {
  try {
    const c = await db.one('SELECT * FROM companies WHERE slug=$1', [String(req.params.slug).toLowerCase()]);
    if (!c || !c.portal_on) return res.status(404).send('Not found');
    const PO = require('./portal');
    // Email link-checkers open links too, so the sign-in happens on a tap, not on the page load.
    if (req.query.go !== '1') return res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in</title>
      <body style="font-family:Arial,sans-serif;background:#f3f2ee;margin:0"><div style="max-width:420px;margin:15vh auto;background:#fff;border:1px solid #ddd;border-radius:12px;padding:24px;text-align:center">
      <h2 style="margin:0 0 8px">${c.name.replace(/[&<>"]/g, '')}</h2><p style="color:#555">Owner portal</p>
      <form method="get"><input type="hidden" name="go" value="1"><button style="font-size:18px;font-weight:bold;padding:14px 22px;border:0;border-radius:8px;background:#e3a008;color:#1f2328;cursor:pointer">Sign in</button></form></div></body>`);
    const s = await PO.useLink(c, String(req.params.token));
    if (!s) return res.status(400).type('html').send(`<p style="font-family:sans-serif;padding:24px">That sign-in link was already used or has expired. <a href="/p/${c.slug}/">Get a new one</a>.</p>`);
    PO.cookie(res, s);
    res.redirect(303, `/p/${c.slug}/`);
  } catch (e) { next(e); }
});

// Each company's crew app lives at /c/<link>, installable on a phone's home screen.
const crewHtml = fs.readFileSync(path.join(PUB, 'crew.html'), 'utf8');
app.get('/c/:slug', async (req, res, next) => {
  try {
    const c = await db.one('SELECT name, slug FROM companies WHERE slug=$1', [String(req.params.slug).toLowerCase()]);
    if (!c) {
      const moved = await db.one('SELECT c.slug FROM slug_redirects r JOIN companies c ON c.id=r.company_id WHERE r.old_slug=$1', [String(req.params.slug).toLowerCase()]);
      if (moved) return res.redirect(301, `/c/${moved.slug}/`);
      return res.status(404).send('This crew link does not exist. Check the link your boss sent you.');
    }
    if (!req.path.endsWith('/')) return res.redirect(301, `/c/${c.slug}/`);
    const esc = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    res.type('html').send(crewHtml.replace(/__COMPANY__/g, esc(c.name)).replace(/__SLUG__/g, c.slug));
  } catch (e) { next(e); }
});
app.get('/c/:slug/manifest.webmanifest', async (req, res, next) => {
  try {
    const c = await db.one('SELECT name, slug FROM companies WHERE slug=$1', [String(req.params.slug).toLowerCase()]);
    if (!c) return res.status(404).end();
    res.type('application/manifest+json').send(JSON.stringify({
      name: `${c.name} · Crew Hours`, short_name: 'Crew Hours', start_url: `/c/${c.slug}/`, scope: `/c/${c.slug}/`,
      display: 'standalone', orientation: 'portrait', background_color: '#f3f2ee', theme_color: '#e3a008',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
              { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
    }));
  } catch (e) { next(e); }
});
app.get('/c/:slug/sw.js', (req, res) => res.type('application/javascript').set('Service-Worker-Allowed', `/c/${req.params.slug}/`).sendFile(path.join(PUB, 'sw.js')));

// Scripts and styles are re-checked on every visit (cheap, thanks to ETags) so updates show up straight away.
// Images and icons can be kept for a day.
app.use(express.static(PUB, { index: false, setHeaders: (res, file) => {
  res.setHeader('Cache-Control', /\.(png|ico|svg|webp|jpg)$/.test(file) && config.isProd ? 'public, max-age=86400' : 'no-cache');
} }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).sendFile(path.join(PUB, '404.html')));

// Errors: input mistakes go back to the user as a message; anything else is logged.
app.use((err, req, res, next) => {
  if (err instanceof T.InputError) return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  if (err.expose) return res.status(502).json({ error: err.message });
  // Stripe problems (bad key, wrong price ID, one-time price...): show the owner Stripe's own explanation.
  if (err.type && String(err.type).startsWith('Stripe')) {
    console.error('[stripe]', err.type, err.code || '', err.message);
    const hint = /No such price/i.test(err.message) ? ' Check STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO in Render, and that they come from the same Stripe sandbox (or live account) as STRIPE_SECRET_KEY.'
      : /recurring/i.test(err.message) ? ' The price must be set to Recurring (monthly) in Stripe, not One-off.'
      : err.type === 'StripeAuthenticationError' ? ' Check STRIPE_SECRET_KEY in Render.' : '';
    return res.status(502).json({ error: 'Stripe said: ' + err.message + hint });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Try again in a minute.' });
});

async function main() {
  await migrate();
  app.listen(config.port, () => console.log(`${config.productName} running on ${config.appUrl} (port ${config.port})`));
  if (process.env.DISABLE_SCHEDULER !== '1') scheduler.start();
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { app, main };
