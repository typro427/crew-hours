// Phone notifications: a phone is saved per crew member; who gets buzzed for a task, an urgent leak and a weather
// reminder; phones that turned notifications off are dropped; "Not you?" forgets the phone.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const db = require('../src/db');
const P = require('../src/push');

let server, base, O, slug, jake, sam;
const sent = [];   // { endpoint, payload }
let gone = new Set();
P.notify.sender = async (sub, body) => { if (gone.has(sub.endpoint)) { const e = new Error('Gone'); e.statusCode = 410; throw e; } sent.push({ endpoint: sub.endpoint, ...JSON.parse(body) }); };
const phone = n => ({ endpoint: 'https://push.example.com/send/' + n + 'abcdefghij', keys: { p256dh: 'BPk' + n + 'x'.repeat(80), auth: 'auth' + n + 'xxxxxxxxxx' } });
const to = n => sent.filter(s => s.endpoint === phone(n).endpoint);

before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const out = { status: r.status, body: await r.json().catch(() => null) };
    if (/tasks/.test(url)) await new Promise(ok => setTimeout(ok, 150));   // notifications go out just after the reply
    return out;
  };
  await O('POST', '/api/signup', { company: 'Deerfield Water', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' });
  slug = (await db.one('SELECT slug FROM companies')).slug;
  await O('POST', '/api/admin/crew', { name: 'Jake', pin: '1111' });
  await O('POST', '/api/admin/crew', { name: 'Sam', pin: '2222' });
  const crewApi = token => async (method, path, body) => {
    const r = await fetch(`${base}/api/c/${slug}${path}`, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const out = { status: r.status, body: await r.json().catch(() => null) };
    if (/tasks/.test(path)) await new Promise(ok => setTimeout(ok, 150));
    return out;
  };
  const login = async pin => (await crewApi()('POST', '/login', { pin })).body.token;
  jake = crewApi(await login('1111')); sam = crewApi(await login('2222'));
});
after(async () => { server.close(); await db.pool.end(); });

test('turn on: the app gives its key, the phone is saved, and a test notification comes', async () => {
  const k = (await jake('GET', '/push')).body;
  assert.ok(k.key && k.key.length > 60, 'public key'); assert.strictEqual(k.phones, 0);
  assert.strictEqual((await jake('GET', '/push')).body.key, k.key, 'the same key every time');
  assert.strictEqual((await jake('POST', '/push', { subscription: { endpoint: 'nope' } })).status, 400);
  const r = await jake('POST', '/push', { subscription: phone(1), test: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.phones, 1);
  assert.strictEqual(to(1)[0].title, 'Notifications are on');
  await sam('POST', '/push', { subscription: phone(2) });
});

test('a task from the boss: to that person, or to everyone; tapping opens Tasks', async () => {
  sent.length = 0;
  const jakeId = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Jake').id;
  await O('POST', '/api/admin/tasks', { title: 'Flush the hydrant on Deer Run', assignedTo: jakeId });
  assert.deepStrictEqual(sent.map(s => s.title), ['New task: Flush the hydrant on Deer Run']);
  assert.ok(to(1).length && !to(2).length, 'only Jake');
  assert.match(to(1)[0].url, new RegExp(`/c/${slug}/#tasks$`));
  sent.length = 0;
  await O('POST', '/api/admin/tasks', { title: 'Clean the shop' });
  assert.ok(to(1).length && to(2).length, 'anyone = everyone');
});

test('an urgent leak: the boss logs it, or a crew member reports it (not back to them)', async () => {
  sent.length = 0;
  await O('POST', '/api/admin/tasks', { kind: 'repair', title: 'Main break on Deerfield Way', priority: 'urgent', address: '600 Deerfield Way' });
  assert.ok(to(1).length && to(2).length);
  assert.match(to(1)[0].title, /^🚨 Urgent: Main break/); assert.match(to(1)[0].url, /#water$/);
  sent.length = 0;
  await O('POST', '/api/admin/tasks', { kind: 'repair', title: 'Slow drip', priority: 'normal' });
  assert.strictEqual(sent.length, 0, 'normal ones are quiet');
  await sam('POST', '/tasks', { kind: 'repair', title: 'Water in the road', priority: 'high' });
  assert.ok(to(1).length && !to(2).length, 'Jake hears about it, Sam reported it');
  // switched off for a part of the app = no buzz for it
  const samRow = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Sam');
  await O('PUT', '/api/admin/crew/' + samRow.id, { features: { ...samRow.features, w_repairs: false } });
  sent.length = 0;
  await O('POST', '/api/admin/tasks', { kind: 'repair', title: 'Another break', priority: 'urgent' });
  assert.ok(to(1).length && !to(2).length);
  await O('PUT', '/api/admin/crew/' + samRow.id, { features: { ...samRow.features, w_repairs: true } });
});

test('a weather reminder going off buzzes the crew', async () => {
  sent.length = 0;
  const c = await db.one('SELECT * FROM companies');
  await P.notify(c, null, { title: '🌡 Check the heaters in all the well houses', body: 'Low of 35°F around Tue 5 PM', tab: 'tasks' });
  assert.ok(to(1).length && to(2).length);
  // the hook is in place in the weather check
  assert.match(require('fs').readFileSync(require.resolve('../src/weather'), 'utf8'), /require\('\.\/push'\)\.notify\(company/);
});

test("a phone that turned notifications off is dropped; 'Not you?' forgets this phone", async () => {
  gone.add(phone(2).endpoint);
  const c = await db.one('SELECT * FROM companies');
  await P.notify(c, null, { title: 'x', body: 'y' });
  assert.strictEqual((await sam('GET', '/push')).body.phones, 0, 'gone from the database');
  gone = new Set();
  const r = await jake('POST', '/push/off', { endpoint: phone(1).endpoint });
  assert.strictEqual(r.body.phones, 0);
  sent.length = 0;
  await P.notify(c, null, { title: 'x', body: 'y' });
  assert.strictEqual(sent.length, 0);
});
