// The crew app's API: /api/c/:slug/...  Workers sign in with their company link + 4-digit PIN.
const db = require('../db');
const A = require('../auth');
const H = require('../hours');
const V = require('../validate');

const r = require('../router')();

// Every request names a company by its link; load it and check the subscription.
r.use('/:slug', async (req, res, next) => {
  try {
    const c = await db.one('SELECT * FROM companies WHERE slug=$1', [String(req.params.slug).toLowerCase()]);
    if (!c) return res.status(404).json({ error: "This crew link doesn't exist. Check the link the boss sent you." });
    if (!H.planOk(c)) return res.status(402).json({ error: 'This account is paused. Ask the boss to check the subscription.' });
    req.company = c;
    next();
  } catch (e) { next(e); }
});

r.get('/:slug/info', (req, res) => res.json({ settings: H.publicSettings(req.company) }));

r.post('/:slug/login', async (req, res) => {
  const c = req.company, ipKey = `pin:${c.id}:${req.ip}`, coKey = `pinco:${c.id}`;
  if (A.limited(ipKey, 10, 15 * 60e3) || A.limited(coKey, 60, 15 * 60e3))
    return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes and try again.' });
  let pin;
  try { pin = V.pin(req.body.pin); } catch (e) { return res.status(400).json({ error: 'Enter your 4-digit PIN.' }); }
  const person = await db.one('SELECT * FROM crew WHERE company_id=$1 AND pin_hmac=$2 AND active', [c.id, A.pinHmac(c.id, pin)]);
  if (!person) {
    A.fail(ipKey, 15 * 60e3); A.fail(coKey, 15 * 60e3);
    await new Promise(ok => setTimeout(ok, 600));
    return res.status(400).json({ error: "That PIN doesn't match anyone on the crew list." });
  }
  A.clearFails(ipKey);
  const token = await A.startCrewSession(person.id);
  res.json({ token, name: person.name, manager: person.is_manager, today: H.today(c), settings: H.publicSettings(c) });
});

r.get('/:slug/week', A.requireCrew, async (req, res) => res.json(await H.myWeek(req.company, req.crew, req.query.start)));
r.post('/:slug/day', A.requireCrew, async (req, res) => res.json(await H.saveDay(req.company, req.crew, req.body || {})));
r.delete('/:slug/day/:date', A.requireCrew, async (req, res) => res.json(await H.clearDay(req.company, req.crew, req.params.date)));

// Crew members ticked as Manager also get the boss screen in the app.
const manager = (req, res, next) => req.crew.is_manager ? next() : res.status(403).json({ error: 'Only managers can see the whole crew.' });
r.get('/:slug/crew-week', A.requireCrew, manager, async (req, res) => res.json(await H.crewWeek(req.company, req.query.start)));
r.post('/:slug/approve', A.requireCrew, manager, async (req, res) =>
  res.json(await H.setApproved(req.company, req.body.weekStart, req.body.approved, req.crew.name)));

r.post('/:slug/logout', A.requireCrew, async (req, res) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  await db.q('DELETE FROM crew_sessions WHERE token_hash=$1', [A.sha(m[1])]);
  res.json({ ok: true });
});

module.exports = r;
