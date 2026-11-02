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

test('crew can add tasks: for themselves or anyone; only the person who added one can delete it', async () => {
  let r = await jake('POST', '/tasks', { title: 'Replace sprinkler head by the gate', forMe: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await jake('POST', '/tasks', { title: 'Pick up mulch', details: '20 bags', forMe: false });
  const mine = r.body.tasks.find(t => t.title.startsWith('Replace')), anyone = r.body.tasks.find(t => t.title === 'Pick up mulch');
  assert.strictEqual(mine.createdByName, 'Jake'); assert.strictEqual(mine.assignedName, 'Jake');
  assert.strictEqual(anyone.assignedTo, null);
  const samSees = (await sam('GET', '/tasks')).body.tasks.map(t => t.title);
  assert.ok(samSees.includes('Pick up mulch') && !samSees.includes('Replace sprinkler head by the gate'));
  const boss = (await O('GET', '/api/admin/tasks')).body.tasks.find(t => t.title === 'Pick up mulch');
  assert.strictEqual(boss.createdByName, 'Jake');
  assert.strictEqual((await sam('DELETE', '/tasks/' + anyone.id)).status, 400, "Sam can't delete Jake's task");
  assert.strictEqual((await jake('POST', '/tasks', { title: '' })).status, 400);
  r = await jake('DELETE', '/tasks/' + anyone.id);
  assert.strictEqual(r.status, 200); assert.ok(!r.body.tasks.some(t => t.id === anyone.id));
});

test('photos on a day: only after saving, up to 6, boss and managers see them, cleared with the day', async () => {
  const day = (await jake('GET', '/week')).body.today;
  assert.strictEqual((await jake('POST', `/day/${day}/photos`, { photos: [JPEG] })).status, 400, 'save the day first');
  assert.strictEqual((await jake('POST', '/day', { date: day, work: { start: '08:00', end: '12:00', summary: 'Mowed' } })).status, 200);
  let r = await jake('POST', `/day/${day}/photos`, { photos: [JPEG, JPEG] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.days[day].photos.length, 2);
  assert.strictEqual((await jake('POST', `/day/${day}/photos`, { photos: [JPEG, JPEG, JPEG, JPEG, JPEG] })).status, 400, 'max 6');
  const id = r.body.days[day].photos[0];
  const wk = (await O('GET', '/api/admin/week?start=' + day)).body;
  assert.deepStrictEqual(wk.people.find(p => p.name === 'Jake').days[day].photos, r.body.days[day].photos);
  assert.strictEqual((await O('GET', '/api/admin/day-photo/' + id)).status, 200);
  assert.strictEqual((await O2('GET', '/api/admin/day-photo/' + id)).status, 404, 'other company');
  assert.strictEqual((await sam('GET', '/day-photo/' + id)).status, 404, 'other crew member');
  assert.strictEqual((await jake('GET', '/day-photo/' + id)).type, 'image/jpeg');
  assert.strictEqual((await sam('DELETE', '/day-photo/' + id)).status, 400);
  r = await jake('DELETE', '/day-photo/' + id);
  assert.strictEqual(r.body.days[day].photos.length, 1);
  await jake('DELETE', '/day/' + day);
  assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM day_photos')).n, 0);
});

test('roads mowed: boss sets the list, crew logs mowings with photos, history and last-mowed show up', async () => {
  let r = await O('PUT', '/api/admin/roads', { names: ['Deerfield Way', ' Skyline Knoll ', 'deerfield way', '', 'Lakeview Dr'] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.roads.map(x => x.name), ['Deerfield Way', 'Skyline Knoll', 'Lakeview Dr'], 'trimmed, no duplicates, in order');
  const roads = (await jake('GET', '/roads')).body.roads;
  const dw = roads.find(x => x.name === 'Deerfield Way');
  assert.strictEqual(dw.lastDay, null);
  const today = (await jake('GET', '/week')).body.today;
  assert.strictEqual((await jake('POST', `/roads/${dw.id}/mows`, { day: '2999-01-01' })).status, 400, 'no future dates');
  r = await jake('POST', `/roads/${dw.id}/mows`, { day: today, notes: 'Both sides', photos: [JPEG] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.road.mows[0].photos.length, 1);
  assert.strictEqual((await jake('POST', `/roads/${dw.id}/mows`, { day: today })).status, 400, 'same person, same day, same road');
  const after = (await sam('GET', '/roads')).body.roads.find(x => x.id === dw.id);
  assert.strictEqual(after.lastDay, today); assert.strictEqual(after.lastBy, 'Jake'); assert.strictEqual(after.timesThisYear, 1);
  const photoId = r.body.road.mows[0].photos[0];
  assert.strictEqual((await O('GET', '/api/admin/road-photo/' + photoId)).status, 200);
  assert.strictEqual((await O2('GET', '/api/admin/road-photo/' + photoId)).status, 404, 'other company');
  assert.strictEqual((await O2('GET', '/api/admin/roads')).body.roads.length, 0);
  const mowId = r.body.road.mows[0].id;
  assert.strictEqual((await sam('DELETE', '/mows/' + mowId)).status, 400, "Sam can't remove Jake's entry");
  // Taking a road off the list hides it; putting it back brings its history back.
  await O('PUT', '/api/admin/roads', { names: ['Skyline Knoll'] });
  assert.deepStrictEqual((await jake('GET', '/roads')).body.roads.map(x => x.name), ['Skyline Knoll']);
  r = await O('PUT', '/api/admin/roads', { names: ['Deerfield Way', 'Skyline Knoll'] });
  assert.strictEqual(r.body.roads[0].lastDay, today);
  r = await O('DELETE', '/api/admin/mows/' + mowId);
  assert.strictEqual(r.body.road.mows.length, 0);
});
