// Tasks: the boss assigns, the crew finishes with notes and photos, the boss sees it. Companies stay separate.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const { migrate } = require('../src/migrate');
const db = require('../src/db');

let server, base;
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); await db.pool.end(); });

function owner() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type };
  };
}
const crewApi = (slug, token) => async (method, path, body) => {
  const r = await fetch(`${base}/api/c/${slug}${path}`, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : null, type };
};
// A real 1x1 JPEG.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

let O, slug, jake, sam, O2;
test('boss adds tasks, crew sees only theirs and the open-to-anyone ones', async () => {
  O = owner();
  assert.strictEqual((await O('POST', '/api/signup', { company: 'Deerfield', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' })).status, 200);
  await O('POST', '/api/admin/crew', { name: 'Jake', pin: '1111' });
  await O('POST', '/api/admin/crew', { name: 'Sam', pin: '2222' });
  const crew = (await O('GET', '/api/admin/crew')).body.crew;
  const jakeId = crew.find(c => c.name === 'Jake').id;
  let r = await O('POST', '/api/admin/tasks', { title: 'Fix pool well house leak', details: 'Bring the pipe wrench', assignedTo: jakeId, due: '2026-11-02' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await O('POST', '/api/admin/tasks', { title: 'Blow leaves off Skyline Knoll' });
  assert.strictEqual(r.body.tasks.length, 2);
  assert.strictEqual((await O('POST', '/api/admin/tasks', { title: '' })).status, 400);
  slug = (await db.one('SELECT slug FROM companies')).slug;
  const login = async pin => (await crewApi(slug)('POST', '/login', { pin })).body.token;
  jake = crewApi(slug, await login('1111')); sam = crewApi(slug, await login('2222'));
  assert.strictEqual((await jake('GET', '/tasks')).body.tasks.length, 2);
  const samTasks = (await sam('GET', '/tasks')).body.tasks;
  assert.deepStrictEqual(samTasks.map(t => t.title), ['Blow leaves off Skyline Knoll']);
});

test('crew marks a task done with notes and a photo; boss sees it and the photo', async () => {
  const t = (await jake('GET', '/tasks')).body.tasks.find(x => x.title.startsWith('Fix'));
  assert.strictEqual((await sam('POST', `/tasks/${t.id}/done`, { notes: 'not mine' })).status, 400, "Sam can't finish Jake's task");
  assert.strictEqual((await jake('POST', `/tasks/${t.id}/done`, {})).status, 400, 'needs notes or a photo');
  assert.strictEqual((await jake('POST', `/tasks/${t.id}/done`, { notes: 'x', photos: ['data:image/jpeg;base64,aGVsbG8='] })).status, 400, 'fake photo refused');
  const r = await jake('POST', `/tasks/${t.id}/done`, { notes: 'Replaced the fitting, no more leak.', photos: [JPEG, JPEG] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const done = r.body.tasks.find(x => x.id === t.id);
  assert.strictEqual(done.status, 'done'); assert.strictEqual(done.photos.length, 2);
  const mine = (await O('GET', '/api/admin/tasks')).body.tasks.find(x => x.id === t.id);
  assert.strictEqual(mine.doneByName, 'Jake'); assert.strictEqual(mine.doneNotes, 'Replaced the fitting, no more leak.');
  const img = await O('GET', '/api/admin/tasks/photo/' + mine.photos[0]);
  assert.strictEqual(img.status, 200); assert.strictEqual(img.type, 'image/jpeg'); assert.strictEqual(img.body[0], 0xff);
  // Jake can add more photos later, up to 6.
  assert.strictEqual((await jake('POST', `/tasks/${t.id}/done`, { photos: [JPEG, JPEG, JPEG, JPEG, JPEG] })).status, 400);
  assert.strictEqual((await jake('POST', `/tasks/${t.id}/done`, { photos: [JPEG] })).status, 200);
});

test('other companies cannot see the photos; reopen and delete work', async () => {
  O2 = owner();
  await O2('POST', '/api/signup', { company: 'Other Co', name: 'Sam', email: 'other@example.com', password: 'LongPass1!' });
  const photoId = (await db.one('SELECT id FROM task_photos ORDER BY id LIMIT 1')).id;
  assert.strictEqual((await O2('GET', '/api/admin/tasks/photo/' + photoId)).status, 404);
  assert.strictEqual((await O2('GET', '/api/admin/tasks')).body.tasks.length, 0);
  const t = (await O('GET', '/api/admin/tasks')).body.tasks.find(x => x.status === 'done');
  let r = await O('PUT', '/api/admin/tasks/' + t.id, { reopen: true });
  assert.strictEqual(r.body.tasks.find(x => x.id === t.id).status, 'open');
  r = await O('DELETE', '/api/admin/tasks/' + t.id);
  assert.ok(!r.body.tasks.some(x => x.id === t.id));
  assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM task_photos')).n, 0, 'photos go with the task');
});
