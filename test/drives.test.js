// Roads driven checklist: managers (and crew it's switched on for) tick roads per day with notes; a note can go on
// Tasks once; sending twice is safe; the boss sees the history; the board report counts it.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const db = require('../src/db');

let server, base, O, slug, scott, jake, ids, today;
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await O('POST', '/api/signup', { company: 'Deerfield', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' });
  slug = (await db.one('SELECT slug FROM companies')).slug;
  await O('POST', '/api/admin/crew', { name: 'Scott', pin: '2222', isManager: true });
  await O('POST', '/api/admin/crew', { name: 'Jake', pin: '1111' });
  await db.q("UPDATE crew SET is_manager = (name='Scott')");
  const c = (await db.one('SELECT id FROM companies')).id;
  for (const [i, n] of ['Deer Run', 'Skyline Knoll', 'Fairway Vista'].entries()) await db.q("INSERT INTO roads (company_id, name, position, kind) VALUES ($1,$2,$3,'road')", [c, n, i]);
  await db.q("INSERT INTO roads (company_id, name, position, kind) VALUES ($1,'Well house 1',0,'water')", [c]);
  const crew = tok => async (method, path, body) => {
    const r = await fetch(`${base}/api/c/${slug}${path}`, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = async pin => (await crew()('POST', '/login', { pin })).body.token;
  scott = crew(await login('2222')); jake = crew(await login('1111'));
});
after(async () => { server.close(); await db.pool.end(); });

test('a manager sees every road (not water sites) and ticks them off; untick works', async () => {
  const d = (await scott('GET', '/drives')).body;
  today = d.today;
  assert.deepStrictEqual(d.roads.map(r => r.name), ['Deer Run', 'Skyline Knoll', 'Fairway Vista']);
  assert.strictEqual(d.driven, 0);
  ids = Object.fromEntries(d.roads.map(r => [r.name, r.id]));
  let r = await scott('POST', '/drives/' + ids['Deer Run'], { done: true });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.driven, 1);
  const dr = r.body.roads.find(x => x.name === 'Deer Run'); assert.ok(dr.done); assert.strictEqual(dr.byName, 'Scott');
  r = await scott('POST', '/drives/' + ids['Deer Run'], { done: true });   // sent twice from the outbox
  assert.strictEqual(r.body.driven, 1);
  await scott('POST', '/drives/' + ids['Skyline Knoll'], { done: true });
  r = await scott('POST', '/drives/' + ids['Skyline Knoll'], { done: false });
  assert.strictEqual(r.body.driven, 1);
  assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM road_drives WHERE done')).n, 1);
});

test('a note: ticks the road, goes on Tasks once, stays with the road for the day', async () => {
  let r = await scott('POST', '/drives/' + ids['Fairway Vista'], { note: 'Pothole by the culvert', toTasks: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fv = r.body.roads.find(x => x.name === 'Fairway Vista');
  assert.ok(fv.done); assert.strictEqual(fv.note, 'Pothole by the culvert'); assert.ok(fv.taskId);
  await scott('POST', '/drives/' + ids['Fairway Vista'], { note: 'Pothole by the culvert', toTasks: true });
  const tasks = await db.q('SELECT title FROM tasks');
  assert.deepStrictEqual(tasks.map(t => t.title), ['Fairway Vista: Pothole by the culvert'], 'only one task');
});

test('other days: up to a week back, not the future; a water site is refused', async () => {
  const shift = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const y = shift(today, -1);
  let r = await scott('POST', '/drives/' + ids['Skyline Knoll'], { day: y, done: true });
  assert.strictEqual(r.body.day, y); assert.strictEqual(r.body.driven, 1);
  r = (await scott('GET', '/drives')).body;
  assert.strictEqual(r.roads.find(x => x.name === 'Skyline Knoll').lastDay, y, 'last driven shows on today');
  assert.strictEqual((await scott('GET', '/drives?day=' + shift(today, 1))).status, 400);
  assert.strictEqual((await scott('GET', '/drives?day=' + shift(today, -8))).status, 400);
  const site = (await db.one("SELECT id FROM roads WHERE kind='water'")).id;
  assert.strictEqual((await scott('POST', '/drives/' + site, { done: true })).status, 400);
});

test('crew only when the boss switches it on', async () => {
  assert.strictEqual((await jake('GET', '/drives')).status, 403);
  const j = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Jake');
  await O('PUT', '/api/admin/crew/' + j.id, { features: { ...j.features, drives: true } });
  assert.strictEqual((await jake('GET', '/drives')).status, 200);
  assert.strictEqual((await jake('GET', '/week')).body.features.drives, true);
});

test('the boss sees each day, and the board report counts it', async () => {
  const h = (await O('GET', '/api/admin/drives?days=30')).body;
  assert.strictEqual(h.total, 3);
  const t = h.days.find(d => d.day === today);
  assert.strictEqual(t.driven, 2); assert.deepStrictEqual(t.who, ['Scott']);
  assert.deepStrictEqual(t.notes, [{ road: 'Fairway Vista', note: 'Pothole by the culvert', by: 'Scott', task: true }]);
  const b = (await O('GET', '/api/admin/board?kind=month&start=' + today.slice(0, 7))).body;
  const tile = b.summary.find(x => x.label === 'Days the roads were driven');
  assert.ok(tile, JSON.stringify(b.summary));
  assert.match(b.sections.find(s => s.key === 'drives').list[0].sub, /^Pothole by the culvert/);
});
