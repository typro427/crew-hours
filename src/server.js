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
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
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
app.use('/api/admin/import', express.json({ limit: '5mb' }));
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

// Nightly backup for your own computer: curl -H "Authorization: Bearer $BACKUP_TOKEN" https://.../api/backup
app.get('/api/backup', async (req, res, next) => {
  try {
    if (!config.backupToken || req.get('authorization') !== 'Bearer ' + config.backupToken) return res.status(401).json({ error: 'Not allowed.' });
    const dump = {
      exportedAt: new Date().toISOString(),
      companies: await db.q('SELECT * FROM companies ORDER BY id'),
      owners: await db.q('SELECT id, company_id, email, name, created_at FROM owners ORDER BY id'),
      crew: await db.q('SELECT id, company_id, name, active, is_manager, created_at FROM crew ORDER BY id'),
      entries: await db.q('SELECT * FROM entries ORDER BY company_id, day'),
      approvals: await db.q('SELECT * FROM approvals ORDER BY company_id, week_start')
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

app.use(express.static(PUB, { index: false, maxAge: config.isProd ? '1h' : 0 }));

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
