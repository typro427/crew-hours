// Compliance: managers (crew app) and the boss (dashboard) share one daily log, sampling schedule and testing list.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const db = require('../src/db');

let server, base, O, slug, scott, jake, today;
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
  await O('POST', '/api/signup', { company: 'Deerfield Water', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' });
  slug = (await db.one('SELECT slug FROM companies')).slug;
  await O('POST', '/api/admin/crew', { name: 'Scott', pin: '2222' });
  await O('POST', '/api/admin/crew', { name: 'Jake', pin: '1111' });
  await db.q("UPDATE crew SET is_manager = (name='Scott')");
  const crew = tok => async (method, path, body) => {
    const r = await fetch(`${base}/api/c/${slug}${path}`, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = async pin => (await crew()('POST', '/login', { pin })).body.token;
  scott = crew(await login('2222')); jake = crew(await login('1111'));
});
after(async () => { server.close(); await db.pool.end(); });

test('managers open it with a starting sampling list; other crew only when switched on', async () => {
  const d = (await scott('GET', '/cw')).body;
  today = d.today;
  assert.strictEqual(d.system.name, 'Deerfield Water'); assert.strictEqual(d.system.minCl, 0.2);
  assert.strictEqual(d.samples.length, 5); assert.strictEqual(d.samples[0].name, 'Total coliform (bacteriological)');
  assert.strictEqual(d.samples[0].last, null); assert.deepStrictEqual(d.assets, []);
  assert.strictEqual((await scott('GET', '/cw')).body.samples.length, 5, 'only added once');
  assert.strictEqual((await jake('GET', '/cw')).status, 403);
  const j = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Jake');
  await O('PUT', '/api/admin/crew/' + j.id, { features: { ...j.features, compliance: true } });
  assert.strictEqual((await jake('GET', '/cw')).status, 200);
});

test('the daily log: distribution chlorine needed, no future days, saving a day again replaces it, delete', async () => {
  assert.strictEqual((await scott('POST', '/cw/logs', { date: today, ep: '1.1' })).status, 400);
  assert.strictEqual((await scott('POST', '/cw/logs', { date: '2999-01-01', dist: '0.5' })).status, 400);
  assert.strictEqual((await scott('POST', '/cw/logs', { date: today, dist: 'lots' })).status, 400);
  let r = await scott('POST', '/cw/logs', { date: today, ep: '1.10', dist: '0.55', meter: '4,812,300', pump: '5.2', notes: 'Flushed hydrant 3' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.logs.map(l => [l.date, l.dist, l.meter, l.by]), [[today, 0.55, 4812300, 'Scott']]);
  r = await scott('POST', '/cw/logs', { date: today, dist: '0.18' });
  assert.strictEqual(r.body.logs.length, 1); assert.strictEqual(r.body.logs[0].dist, 0.18); assert.strictEqual(r.body.logs[0].ep, null);
  // the boss sees the same records
  const b = (await O('GET', '/api/admin/cw')).body;
  assert.strictEqual(b.logs[0].dist, 0.18);
  r = await O('DELETE', '/api/admin/cw/logs/' + today);
  assert.strictEqual(r.body.logs.length, 0);
});

test('samples and testing: add, record (moves the due date), remove a mistaken record, edit, delete', async () => {
  let d = (await scott('GET', '/cw')).body;
  const tc = d.samples[0];
  let r = await scott('POST', `/cw/items/${tc.id}/record`, { date: today, result: 'Total coliform absent', lab: 'State lab' });
  let it = r.body.samples[0];
  assert.strictEqual(it.last, today); assert.strictEqual(it.history[0].result, 'Total coliform absent'); assert.strictEqual(it.history[0].by, 'Scott');
  r = await scott('DELETE', '/cw/history/' + it.history[0].id);
  assert.strictEqual(r.body.samples[0].last, null, 'last done goes back');
  r = await scott('POST', '/cw/items', { list: 'assets', name: 'RPZ, clubhouse kitchen', kind: 'Backflow test', months: 12, last: '2026-01-15' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const rpz = r.body.assets[0]; assert.strictEqual(rpz.kind, 'Backflow test'); assert.strictEqual(rpz.last, '2026-01-15');
  r = await O('POST', '/api/admin/cw/items', { id: rpz.id, list: 'assets', name: 'RPZ, clubhouse', kind: 'Nope', months: 24 });
  assert.strictEqual(r.body.assets[0].name, 'RPZ, clubhouse'); assert.strictEqual(r.body.assets[0].kind, 'Other'); assert.strictEqual(r.body.assets[0].months, 24);
  assert.strictEqual((await scott('POST', '/cw/items', { list: 'assets', name: '', months: 12 })).status, 400);
  r = await O('POST', `/api/admin/cw/items/${rpz.id}/record`, { date: today });
  assert.strictEqual(r.body.assets[0].history[0].by, 'Tyler'); assert.strictEqual(r.body.assets[0].history[0].result, 'Recorded');
  r = await scott('DELETE', '/cw/items/' + rpz.id);
  assert.strictEqual(r.body.assets.length, 0);
});

test("the system's details; other companies can't touch these records", async () => {
  let r = await scott('PUT', '/cw/system', { name: 'Deerfield Water System', pwsid: 'TN0000123', operator: 'Scott Fields', cert: 'Small Water System', minCl: '0.3' });
  assert.strictEqual(r.body.system.pwsid, 'TN0000123'); assert.strictEqual(r.body.system.minCl, 0.3);
  const id = r.body.samples[1].id;
  const O2 = async (method, url, body) => { const x = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', Cookie: O2.c || '' }, body: body ? JSON.stringify(body) : undefined }); const sc = x.headers.get('set-cookie'); if (sc) O2.c = sc.split(';')[0]; return { status: x.status, body: await x.json().catch(() => null) }; };
  await O2('POST', '/api/signup', { company: 'Other Co', name: 'Ann', email: 'ann@example.com', password: 'LongPass1!' });
  assert.strictEqual((await O2('POST', `/api/admin/cw/items/${id}/record`, { date: today })).status, 400);
  assert.strictEqual((await O2('DELETE', '/api/admin/cw/items/' + id)).status, 400);
  assert.strictEqual((await O2('GET', '/api/admin/cw')).body.system.name, 'Other Co');
});

test('the pages', async () => {
  const p = await fetch(`${base}/c/${slug}/compliance`); assert.strictEqual(p.status, 200);
  assert.match(await p.text(), new RegExp(`data-slug="${slug}"`));
  assert.strictEqual((await fetch(base + '/compliance')).status, 200);
  assert.strictEqual((await fetch(base + '/compliance.js')).status, 200);
});
