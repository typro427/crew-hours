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

test('road details import onto the pasted list without duplicates; boss can edit; crew sees them', async () => {
  const file = require('./fixtures-deerfield-roads.json');
  await O('PUT', '/api/admin/roads', { names: file.roads.map(r => r.name) });
  let r = await O('POST', '/api/admin/import', file);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.roadsAdded, 0); assert.strictEqual(r.body.roadsUpdated, 31);
  r = await O('POST', '/api/admin/import', file);   // again: still 31
  const list = (await O('GET', '/api/admin/roads')).body.roads;
  assert.strictEqual(list.length, 31); assert.strictEqual(list[0].name, 'Deer Hill to Yellow Condos');
  const dp = list.find(x => x.name === 'Deer Pond');
  assert.deepStrictEqual([dp.lengthMi, dp.pRoad, dp.pDitch, dp.pTrees, dp.surface], [null, 1, 2, 1, 'Gravel']);
  assert.strictEqual(list.reduce((a, x) => a + (x.lengthMi || 0), 0).toFixed(1), '15.2');
  r = await O('PUT', `/api/admin/roads/${dp.id}/info`, { lengthMi: '0.4', surface: 'Gravel', pRoad: '1', pDitch: '', pTrees: '1', notes: 'Paving scheduled' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await O('PUT', `/api/admin/roads/${dp.id}/info`, { pRoad: '7' })).status, 400);
  const crewView = (await jake('GET', '/roads/' + dp.id)).body.road;
  assert.deepStrictEqual([crewView.lengthMi, crewView.pDitch, crewView.notes], [0.4, null, 'Paving scheduled']);
});

test('water system: sites are separate from roads, repairs separate from tasks, readings log and export', async () => {
  let r = await O('PUT', '/api/admin/roads', { kind: 'water', names: ['Well 1', 'Storage tank'] });
  assert.deepStrictEqual(r.body.roads.map(x => x.name), ['Well 1', 'Storage tank']);
  assert.ok(!(await O('GET', '/api/admin/roads')).body.roads.some(x => x.name === 'Well 1'), 'roads list unchanged');
  const well = (await jake('GET', '/roads?kind=water')).body.roads[0];
  r = await jake('POST', `/roads/${well.id}/mows`, { day: (await jake('GET', '/week')).body.today, notes: 'Pump running fine', photos: [JPEG] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.roads.find(x => x.id === well.id).lastBy, 'Jake');
  // a second check the same day is fine for water sites
  assert.strictEqual((await jake('POST', `/roads/${well.id}/mows`, { day: r.body.road.mows[0].day })).status, 200);
  // repairs
  r = await jake('POST', '/tasks', { kind: 'repair', title: 'Leak at meter by 141 Deer Meadow', forMe: true });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.kind, 'repair');
  assert.ok(!(await jake('GET', '/tasks')).body.tasks.some(t => t.title.startsWith('Leak')), 'not in Tasks');
  const rep = r.body.tasks[0];
  r = await jake('POST', `/tasks/${rep.id}/done`, { notes: 'Replaced the gasket', photos: [JPEG] });
  assert.strictEqual(r.body.tasks.find(t => t.id === rep.id).status, 'done');
  assert.strictEqual((await O('GET', '/api/admin/tasks?kind=repair')).body.tasks[0].doneNotes, 'Replaced the gasket');
  // readings
  r = await O('PUT', '/api/admin/reading-types', { lines: ['Chlorine | ppm', 'Pressure|psi', '', 'chlorine | x'] });
  assert.deepStrictEqual(r.body.types.map(t => [t.name, t.unit]), [['Chlorine', 'ppm'], ['Pressure', 'psi']]);
  const [cl, pr] = r.body.types;
  assert.strictEqual((await jake('POST', '/readings', { vals: {} })).status, 400);
  assert.strictEqual((await jake('POST', '/readings', { vals: { [cl.id]: 'abc' } })).status, 400);
  r = await jake('POST', '/readings', { vals: { [cl.id]: '1.2', [pr.id]: 62 }, notes: 'Morning check' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.readings[0].vals, { [cl.id]: 1.2, [pr.id]: 62 });
  const csv = await O('GET', '/api/admin/readings.csv');
  assert.match(csv.body.toString(), /Chlorine \(ppm\)/); assert.match(csv.body.toString(), /1\.2/);
  assert.strictEqual((await sam('DELETE', '/readings/' + r.body.readings[0].id)).status, 400, "Sam can't remove Jake's reading");
  assert.strictEqual((await O2('GET', '/api/admin/readings')).body.readings.length, 0, 'other company');
  const wk = (await jake('GET', '/week')).body;
  assert.deepStrictEqual(wk.setup, { roads: 31, waterSites: 2, readingTypes: 2 });
});

test('per-person switches: the boss turns parts of the app off for one person', async () => {
  const crew = (await O('GET', '/api/admin/crew')).body;
  assert.ok(crew.features.w_readings);
  const samRow = crew.crew.find(c => c.name === 'Sam');
  assert.strictEqual(samRow.features.tasks, true);
  let r = await O('PUT', '/api/admin/crew/' + samRow.id, { features: { tasks: true, roads: false, w_readings: false, w_sites: true, w_repairs: false } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.crew.find(c => c.id === samRow.id).features.roads, false);
  const wk = (await sam('GET', '/week')).body;
  assert.deepStrictEqual(wk.features, { tasks: true, roads: false, w_readings: false, w_sites: true, w_repairs: false, members: false });
  assert.strictEqual((await sam('GET', '/roads')).status, 403);
  assert.strictEqual((await sam('GET', '/readings')).status, 403);
  assert.strictEqual((await sam('POST', '/tasks', { kind: 'repair', title: 'x' })).status, 403);
  assert.strictEqual((await sam('GET', '/roads?kind=water')).status, 200);
  assert.strictEqual((await sam('GET', '/tasks')).status, 200);
  const roadId = (await O('GET', '/api/admin/roads')).body.roads[0].id;
  assert.strictEqual((await sam('POST', `/roads/${roadId}/mows`, { day: wk.today })).status, 403, 'blocked by id too');
  assert.strictEqual((await jake('GET', '/roads')).status, 200, 'others unaffected');
  // turn everything back on
  await O('PUT', '/api/admin/crew/' + samRow.id, { features: { tasks: true, roads: true, w_readings: true, w_sites: true, w_repairs: true } });
  assert.strictEqual((await sam('GET', '/readings')).status, 200);
});

test('readings inside a site: saved with the check, show in the readings list with the site, per-site choice', async () => {
  const types = (await O('GET', '/api/admin/readings')).body.types;
  const [cl, pr] = types;
  const well = (await O('GET', '/api/admin/roads?kind=water')).body.roads.find(x => x.name === 'Well 1');
  let r = await O('PUT', `/api/admin/roads/${well.id}/readings`, { ids: [cl.id] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.road.readingTypes.map(t => t.id), [cl.id]);
  const view = (await jake('GET', '/roads/' + well.id)).body.road;
  assert.deepStrictEqual(view.readingTypes.map(t => t.name), ['Chlorine']);
  const today = (await jake('GET', '/week')).body.today;
  assert.strictEqual((await jake('POST', `/roads/${well.id}/mows`, { day: today, vals: { [cl.id]: 'x' } })).status, 400);
  r = await jake('POST', `/roads/${well.id}/mows`, { day: today, notes: 'Site check', vals: { [cl.id]: '0.9' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.road.mows[0].vals, { [cl.id]: 0.9 });
  const list = (await O('GET', '/api/admin/readings')).body.readings;
  const mine = list.find(x => x.siteName === 'Well 1');
  assert.ok(mine && mine.vals[cl.id] === 0.9);
  assert.match((await O('GET', '/api/admin/readings.csv')).body.toString(), /"Well 1"/);
  // removing the check removes its readings
  await jake('DELETE', '/mows/' + r.body.road.mows[0].id);
  assert.ok(!(await O('GET', '/api/admin/readings')).body.readings.some(x => x.id === mine.id));
  // all ticked = back to "every reading"
  r = await O('PUT', `/api/admin/roads/${well.id}/readings`, { ids: types.map(t => t.id) });
  assert.strictEqual(r.body.road.readingIds, null);
  // roads never get reading boxes
  assert.strictEqual((await jake('GET', '/roads/' + (await O('GET', '/api/admin/roads')).body.roads[0].id)).body.road.readingTypes, undefined);
});

test('members list: off by default, boss imports and searches, only switched-on crew can search, companies separate', async () => {
  const cols = ['Status', 'Last name', 'First name(s)', 'Deerfield address', 'Parcel ID', 'Cell phone 1', 'Email 1'];
  const rows = [
    { Status: 'Active', 'Last name': 'Testerson', 'First name(s)': 'Pat & Lee', 'Deerfield address': '12 Fake Deer Lane', 'Parcel ID': '999A A 001.00 000', 'Cell phone 1': '(555)010-0001', 'Email 1': 'pat@example.com' },
    { Status: 'Active', 'Last name': 'Sampleton', 'First name(s)': 'Jo', 'Deerfield address': '40 Pretend Trail', 'Parcel ID': '999A A 002.00 000' },
    { Status: 'Inactive / sold', 'Last name': 'Oldowner', 'First name(s)': 'Max', 'Deerfield address': '12 Fake Deer Lane' }
  ];
  let r = await O('POST', '/api/admin/members/import', { columns: cols, rows });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.rows, 3);
  r = await O('GET', '/api/admin/members?q=fake deer');
  assert.deepStrictEqual(r.body.rows.map(x => x.data['Last name']), ['Testerson', 'Oldowner'], 'every word must match, any column');
  r = await O('GET', '/api/admin/members?q=fake&status=Active');
  assert.deepStrictEqual(r.body.rows.map(x => x.data['Last name']), ['Testerson']);
  assert.strictEqual((await O('GET', '/api/admin/members?q=010-0001')).body.total, 1, 'phone search');
  assert.strictEqual((await O('GET', '/api/admin/members?q=100%')).body.total, 0, 'wildcards are literal');
  // crew: off by default, even for managers
  const crew = (await O('GET', '/api/admin/crew')).body.crew;
  const jakeRow = crew.find(c => c.name === 'Jake');
  assert.strictEqual(jakeRow.features.members, false);
  assert.strictEqual((await jake('GET', '/members?q=fake')).status, 403);
  await O('PUT', '/api/admin/crew/' + jakeRow.id, { features: { ...jakeRow.features, members: true } });
  r = await jake('GET', '/members?q=testerson');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.rows[0].data['Email 1'], 'pat@example.com');
  assert.strictEqual((await sam('GET', '/members')).status, 403, 'still off for Sam');
  assert.strictEqual((await jake('POST', '/members', { data: {} })).status, 404, 'crew cannot change it');
  // other company sees nothing
  assert.strictEqual((await O2('GET', '/api/admin/members?q=testerson')).body.total, 0);
  // edit, add, delete, export
  const id = (await O('GET', '/api/admin/members?q=sampleton')).body.rows[0].id;
  assert.strictEqual((await O('PUT', '/api/admin/members/' + id, { data: { 'Last name': 'Sampleton', 'Cell phone 1': '(555)010-0002', Bogus: 'x' } })).status, 200);
  const upd = (await O('GET', '/api/admin/members?q=010-0002')).body.rows[0];
  assert.strictEqual(upd.id, id); assert.strictEqual(upd.data.Bogus, undefined, 'unknown columns dropped');
  const newId = (await O('POST', '/api/admin/members', { data: { 'Last name': 'Newbie', Status: 'Active' } })).body.id;
  assert.ok(newId);
  await O('DELETE', '/api/admin/members/' + newId);
  assert.strictEqual((await O('GET', '/api/admin/members?q=newbie')).body.total, 0);
  const csv = (await O('GET', '/api/admin/members.csv')).body.toString();
  assert.match(csv, /"Last name"/); assert.match(csv, /Testerson/);
  assert.strictEqual((await O('POST', '/api/admin/members/import', { columns: [], rows: [] })).status, 400);
});
