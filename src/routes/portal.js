// Owner portal API: /api/p/:slug/...
const db = require('../db');
const A = require('../auth');
const P = require('../portal');
const r = require('../router')();

// The company for this portal link (only when the boss has turned the portal on).
async function company(req, res, next) {
  try {
    const c = await db.one('SELECT * FROM companies WHERE slug=$1', [String(req.params.slug || '').toLowerCase()]);
    if (!c || !c.portal_on) return res.status(404).json({ error: 'This owner portal is not open yet.' });
    req.company = c; next();
  } catch (e) { next(e); }
}
const ip = req => req.ip || (req.socket && req.socket.remoteAddress) || '';
function slow(key, max, ms) {   // rate limit: counts every try
  return (req, res, next) => { const k = key(req); if (A.limited(k, max, ms)) return res.status(429).json({ error: 'Too many tries. Wait a little and try again.' }); A.fail(k, ms); next(); };
}

r.get('/:slug/info', company, (req, res) => res.json({ company: req.company.name }));
r.get('/:slug/addresses', company, slow(req => 'paddr:' + ip(req), 300, 15 * 60e3), async (req, res) => res.json({ addresses: await P.findAddresses(req.company.id, req.query.q) }));
r.post('/:slug/start', company, slow(req => 'pstart:' + ip(req), 15, 60 * 60e3), slow(req => 'pstartm:' + req.company.id + ':' + (req.body || {}).meterId, 5, 60 * 60e3),
  async (req, res) => res.json(await P.start(req.company, (req.body || {}).meterId)));
r.post('/:slug/request', company, slow(req => 'preq:' + ip(req), 8, 60 * 60e3), async (req, res) => {
  const out = await P.request(req.company, req.body || {});
  if (!out.ok) return res.status(400).json({ error: "That account number doesn't match our records for that address. Check your water bill, or call the office." });
  res.json(out);
});

r.get('/:slug/me', company, P.requireUser, async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await P.home(req.company, req.portalUser)); });
r.post('/:slug/name', company, P.requireUser, async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 120);
  await db.q('UPDATE portal_users SET name=$1 WHERE id=$2', [name, req.portalUser.id]);
  res.json({ ok: true });
});
r.post('/:slug/report', company, P.requireUser, slow(req => 'prep:' + req.portalUser.id, 20, 24 * 60 * 60e3), async (req, res) => {
  await P.report(req.company, req.portalUser, req.body || {});
  res.json(await P.home(req.company, req.portalUser));
});
r.get('/:slug/docs/:id', company, P.requireUser, async (req, res) => {
  const d = await P.doc(req.company, req.portalUser, Number(req.params.id));
  if (!d) return res.status(404).end();
  const ext = d.mime === 'application/pdf' ? 'pdf' : d.mime === 'image/png' ? 'png' : 'jpg';
  res.set({ 'Content-Type': d.mime, 'Content-Disposition': `inline; filename="${String(d.title).replace(/[^\w .-]+/g, '').slice(0, 80) || 'document'}.${ext}"`, 'Cache-Control': 'private, max-age=3600' }).send(d.data);
});
r.get('/:slug/report-photo/:id', company, P.requireUser, async (req, res) => {   // photos on their own reports only
  const p = await db.one(`SELECT p.mime, p.data FROM task_photos p JOIN tasks t ON t.id=p.task_id JOIN portal_access a ON a.meter_id=t.portal_meter_id
    WHERE p.id=$1 AND t.company_id=$2 AND a.user_id=$3`, [Number(req.params.id), req.company.id, req.portalUser.id]);
  p ? res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }).send(p.data) : res.status(404).end();
});
r.post('/:slug/logout', company, async (req, res) => { await P.signOut(req, res); res.json({ ok: true }); });

module.exports = r;
