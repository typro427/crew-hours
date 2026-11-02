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
  res.json({ token, name: person.name, manager: person.is_manager, features: require('../features').forCrew(person), today: H.today(c), settings: H.publicSettings(c) });
});

// What the boss has set up, so the app only shows tabs that have something in them.
const setupOf = async companyId => db.one(`SELECT
  (SELECT count(*)::int FROM roads WHERE company_id=$1 AND active AND kind='road') AS roads,
  (SELECT count(*)::int FROM roads WHERE company_id=$1 AND active AND kind='water') AS "waterSites",
  (SELECT count(*)::int FROM reading_types WHERE company_id=$1 AND active) AS "readingTypes",
  (SELECT count(*)::int FROM meters WHERE company_id=$1 AND active) AS meters`, [companyId]);
r.get('/:slug/week', A.requireCrew, async (req, res) => res.json({ ...(await H.myWeek(req.company, req.crew, req.query.start)),
  features: require('../features').forCrew(req.crew), setup: await setupOf(req.company.id) }));
r.post('/:slug/day', A.requireCrew, async (req, res) => res.json(await H.saveDay(req.company, req.crew, req.body || {})));
r.delete('/:slug/day/:date', A.requireCrew, async (req, res) => res.json(await H.clearDay(req.company, req.crew, req.params.date)));

// Tasks (kind=task) and water leaks & repairs (kind=repair): same rules, separate lists, separate switches.
const K = require('../tasks');
const RD = require('../roads');
const RG = require('../readings');
const F = require('../features');
const featTask = k => (k === 'repair' ? 'w_repairs' : k === 'order' ? 'orders' : 'tasks');
const featPlace = k => (k === 'water' ? 'w_sites' : 'roads');
const off = res => res.status(403).json({ error: "The boss hasn't turned this on for you." });
const sendPhoto = (res, p) => p ? res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }).send(p.data) : res.status(404).end();
const taskList = async (req, kind) => {
  const seeContacts = F.can(req.crew, 'members');   // owner phone numbers are private: only for people with the Members list
  const tasks = (await K.forCrew(req.company.id, req.crew.id, kind)).map(t => (seeContacts ? t : { ...t, ownerPhone: '' }));
  return { tasks, maxPhotos: K.MAX_PHOTOS, kind: K.kindOf(kind) };
};

r.get('/:slug/tasks', A.requireCrew, async (req, res) => {
  const kind = K.kindOf(req.query.kind);
  if (!F.can(req.crew, featTask(kind))) return off(res);
  res.json(await taskList(req, kind));
});
r.post('/:slug/tasks', A.requireCrew, async (req, res) => {
  const kind = K.kindOf((req.body || {}).kind);
  if (!F.can(req.crew, featTask(kind))) return off(res);
  await K.createByCrew(req.company, req.crew, { ...(req.body || {}), kind });
  res.json(await taskList(req, kind));
});
r.post('/:slug/tasks/:id/done', A.requireCrew, async (req, res) => {
  const kind = await K.kindOfTask(req.company.id, Number(req.params.id));
  if (kind && !F.can(req.crew, featTask(kind))) return off(res);
  await K.complete(req.company, req.crew, Number(req.params.id), req.body || {});
  res.json(await taskList(req, kind));
});
r.delete('/:slug/tasks/:id', A.requireCrew, async (req, res) => {
  const kind = await K.kindOfTask(req.company.id, Number(req.params.id));
  if (kind && !F.can(req.crew, featTask(kind))) return off(res);
  await K.removeByCrew(req.company, req.crew, Number(req.params.id));
  res.json(await taskList(req, kind));
});
r.get('/:slug/tasks/photo/:id', A.requireCrew, async (req, res) => {
  const kind = await K.kindOfTaskPhoto(req.company.id, Number(req.params.id));
  if (!kind || !F.can(req.crew, featTask(kind))) return res.status(404).end();
  sendPhoto(res, await K.photo(req.company.id, Number(req.params.id)));
});

// Roads mowed (kind=road) and water system sites (kind=water): a list of places; the crew logs each visit.
r.get('/:slug/roads', A.requireCrew, async (req, res) => {
  const kind = RD.kindOf(req.query.kind);
  if (!F.can(req.crew, featPlace(kind))) return off(res);
  res.json({ roads: await RD.list(req.company.id, kind), maxPhotos: RD.MAX_PHOTOS, kind });
});
r.get('/:slug/roads/:id', A.requireCrew, async (req, res) => {
  const kind = await RD.kindOfPlace(req.company.id, Number(req.params.id));
  if (kind && !F.can(req.crew, featPlace(kind))) return off(res);
  res.json({ road: await RD.history(req.company.id, Number(req.params.id), 20) });
});
r.post('/:slug/roads/:id/mows', A.requireCrew, async (req, res) => {
  const kind = await RD.kindOfPlace(req.company.id, Number(req.params.id));
  if (kind && !F.can(req.crew, featPlace(kind))) return off(res);
  await RD.logMow(req.company, req.crew, Number(req.params.id), req.body || {}, K.photoBytes);
  res.json({ road: await RD.history(req.company.id, Number(req.params.id), 20), roads: await RD.list(req.company.id, kind) });
});
r.delete('/:slug/mows/:id', A.requireCrew, async (req, res) => {
  const kind = await RD.kindOfMow(req.company.id, Number(req.params.id));
  if (kind && !F.can(req.crew, featPlace(kind))) return off(res);
  const roadId = await RD.removeMow(req.company.id, Number(req.params.id), req.crew.id);
  res.json({ road: await RD.history(req.company.id, roadId, 20), roads: await RD.list(req.company.id, kind) });
});
r.get('/:slug/road-photo/:id', A.requireCrew, async (req, res) => {
  const kind = await RD.kindOfPhoto(req.company.id, Number(req.params.id));
  if (!kind || !F.can(req.crew, featPlace(kind))) return res.status(404).end();
  sendPhoto(res, await RD.photo(req.company.id, Number(req.params.id)));
});

// Meter reading route (current month). The crew enters readings; usage is worked out from last month.
const MT = require('../meters');
r.get('/:slug/meters', A.requireCrew, F.need('w_meters'), async (req, res) => {
  const rt = await MT.route(req.company);
  res.json({ ...rt, meters: rt.meters.map(m => ({ id: m.id, seq: m.seq, account: m.account, meterNo: m.meterNo, name: m.name, address: m.address, notes: m.notes,
    previous: m.previous, current: m.current, usage: m.usage, readBy: m.readBy, readNotes: m.readNotes })) });
});
r.post('/:slug/meters/:id/read', A.requireCrew, F.need('w_meters'), async (req, res) => {
  await MT.read(req.company, req.crew, Number(req.params.id), { reading: (req.body || {}).reading, notes: (req.body || {}).notes });
  res.json({ ok: true });
});

// Members list: read-only search, only for people the boss has switched it on for.
const MB = require('../members');
r.get('/:slug/members', A.requireCrew, F.need('members'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await MB.search(req.company.id, { q: req.query.q, status: req.query.status, limit: 50 }));
});

// Water system readings.
const readingsOut = async req => ({ types: await RG.types(req.company.id), readings: await RG.recent(req.company.id, 14, 30) });
r.get('/:slug/readings', A.requireCrew, F.need('w_sites'), async (req, res) => res.json(await readingsOut(req)));
r.post('/:slug/readings', A.requireCrew, F.need('w_sites'), async (req, res) => { await RG.log(req.company, req.crew, req.body || {}); res.json(await readingsOut(req)); });
r.delete('/:slug/readings/:id', A.requireCrew, F.need('w_sites'), async (req, res) => { await RG.remove(req.company.id, Number(req.params.id), req.crew.id); res.json(await readingsOut(req)); });

// Photos of the day's work, attached to a saved day.
r.post('/:slug/day/:date/photos', A.requireCrew, async (req, res) =>
  res.json(await H.addDayPhotos(req.company, req.crew, req.params.date, (req.body || {}).photos, K.photoBytes)));
r.delete('/:slug/day-photo/:id', A.requireCrew, async (req, res) => res.json(await H.removeDayPhoto(req.company, req.crew, Number(req.params.id))));
r.get('/:slug/day-photo/:id', A.requireCrew, async (req, res) => {
  const p = await H.dayPhoto(req.company.id, Number(req.params.id), req.crew.is_manager ? null : req.crew.id);
  if (!p) return res.status(404).end();
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }).send(p.data);
});
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
