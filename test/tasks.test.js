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
  const f = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type };
  };
  f.raw = async (url, buf) => { const r = await fetch(base + url, { method: 'POST', headers: { 'x-ch': '1', 'Content-Type': 'application/octet-stream', Cookie: cookie }, body: buf }); return { status: r.status, body: await r.json() }; };
  return f;
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
  // Jake can add more photos later, up to 12.
  assert.strictEqual((await jake('POST', `/tasks/${t.id}/done`, { photos: Array(11).fill(JPEG) })).status, 400);
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
  assert.deepStrictEqual(wk.setup, { roads: 31, waterSites: 2, readingTypes: 2, meters: 0 });
});

test('per-person switches: the boss turns parts of the app off for one person', async () => {
  const crew = (await O('GET', '/api/admin/crew')).body;
  assert.ok(crew.features.w_meters);
  const samRow = crew.crew.find(c => c.name === 'Sam');
  assert.strictEqual(samRow.features.tasks, true);
  let r = await O('PUT', '/api/admin/crew/' + samRow.id, { features: { tasks: true, roads: false, w_sites: true, w_repairs: false, w_meters: true } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.crew.find(c => c.id === samRow.id).features.roads, false);
  const wk = (await sam('GET', '/week')).body;
  assert.deepStrictEqual(wk.features, { hours: true, tasks: true, roads: false, w_sites: true, w_repairs: false, w_meters: true, members: false, orders: false, jobs: false, drives: false });
  assert.strictEqual((await sam('GET', '/roads')).status, 403);
  assert.strictEqual((await sam('POST', '/tasks', { kind: 'repair', title: 'x' })).status, 403);
  assert.strictEqual((await sam('GET', '/roads?kind=water')).status, 200);
  assert.strictEqual((await sam('GET', '/tasks')).status, 200);
  const roadId = (await O('GET', '/api/admin/roads')).body.roads[0].id;
  assert.strictEqual((await sam('POST', `/roads/${roadId}/mows`, { day: wk.today })).status, 403, 'blocked by id too');
  assert.strictEqual((await jake('GET', '/roads')).status, 200, 'others unaffected');
  // turn everything back on
  await O('PUT', '/api/admin/crew/' + samRow.id, { features: { tasks: true, roads: true, w_sites: true, w_repairs: true, w_meters: true } });
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

test('the members file also works from the Settings import box', async () => {
  const r = await O('POST', '/api/admin/import', { format: 'crewhours-members-1', columns: ['Status', 'Last name'], rows: [{ Status: 'Active', 'Last name': 'Viasettings' }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.members, 1);
  assert.strictEqual((await O('GET', '/api/admin/members?q=viasettings')).body.total, 1);
  assert.strictEqual((await O('POST', '/api/admin/import', { format: 'nope' })).status, 400);
});

test('meter route: import keeps order, crew enter readings, usage from last, history kept on re-import', async () => {
  const meters = [
    { seq: 1, account: '2751415', meterNo: '2751415', name: 'Test Greens', address: 'Halfway House', startReading: 27011 },
    { seq: 2, account: '2751416', meterNo: '2751416', name: 'Testy, Greg', address: '434 Fake Vista', startReading: 66476, nameCheck: true, oldName: 'Old, Name', qbCustomer: 'Testy, Greg & Pat' },
    { seq: 3, account: '1A', meterNo: '', name: 'No Meter, Pat', address: '142 Fake Trot 1A', startReading: 0, notes: 'No meter' }
  ];
  let r = await O('POST', '/api/admin/meters/import', { meters });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.meters, 3);
  r = await jake('GET', '/meters');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.meters.map(m => m.seq), [1, 2, 3]);
  assert.strictEqual(r.body.toRead, 2, 'only meters with a meter number count');
  const [m1, m2] = r.body.meters;
  assert.strictEqual(m1.previous, 27011);
  assert.strictEqual((await jake('POST', `/meters/${m1.id}/read`, { reading: 'abc' })).status, 400);
  assert.strictEqual((await jake('POST', `/meters/${m1.id}/read`, { reading: '27500' })).status, 200);
  assert.strictEqual((await jake('POST', `/meters/${m2.id}/read`, { reading: 66000 })).status, 200);
  r = await jake('GET', '/meters');
  assert.strictEqual(r.body.meters[0].usage, 489); assert.strictEqual(r.body.meters[0].readBy, 'Jake');
  assert.strictEqual(r.body.meters[1].usage, -476, 'lower than last shows negative usage');
  assert.strictEqual(r.body.read, 2);
  // boss: month view, CSV, edit; next month uses this month's reading as "last"
  const quarter = r.body.quarter;
  assert.match(quarter, /^\d{4}-Q[1-4]$/); assert.match(r.body.label, /^Q[1-4] \d{4} \(/);
  const adm = (await O('GET', '/api/admin/meters?all=1')).body;
  assert.strictEqual(adm.meters[1].nameCheck, true); assert.strictEqual(adm.meters[1].oldName, 'Old, Name'); assert.strictEqual(adm.meters[1].qbCustomer, 'Testy, Greg & Pat');
  r = await O('PUT', '/api/admin/meters/' + m2.id, { name: 'Fixed, Greg', nameCheck: false });
  assert.strictEqual(r.body.meters[1].name, 'Fixed, Greg'); assert.strictEqual(r.body.meters[1].nameCheck, false);
  const csv = (await O('GET', '/api/admin/meters.csv?quarter=' + quarter)).body.toString();
  assert.match(csv, /"Read sequence"/); assert.match(csv, /"27500"/); assert.match(csv, /"QuickBooks customer"/); assert.match(csv, /Testy, Greg & Pat/);
  const y = Number(quarter.slice(0, 4)), qn = Number(quarter.slice(6)), next = qn === 4 ? `${y + 1}-Q1` : `${y}-Q${qn + 1}`;
  r = await O('GET', '/api/admin/meters?quarter=' + next);
  assert.strictEqual(r.body.meters[0].previous, 27500); assert.strictEqual(r.body.meters[0].current, null);
  assert.strictEqual((await O('POST', `/api/admin/meters/${m1.id}/read`, { reading: 1, quarter: next })).status, 400, 'future quarter');
  // re-import keeps the readings for the same meters
  await O('POST', '/api/admin/meters/import', { meters });
  r = await jake('GET', '/meters');
  assert.strictEqual(r.body.meters[0].current, 27500);
  // switch
  const sRow = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Sam');
  await O('PUT', '/api/admin/crew/' + sRow.id, { features: { ...sRow.features, w_meters: false } });
  assert.strictEqual((await sam('GET', '/meters')).status, 403);
  assert.strictEqual((await O2('GET', '/api/admin/meters')).body.meters.length, 0, 'other company');
});

test('meter list from Excel: names, QuickBooks name, "no meter", checks and current readings come in', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Meter list');
  ws.addRow(['Deerfield Water System: Meter list']); ws.addRow([]); ws.addRow([]);
  ws.addRow(['Read Sequence', 'Act #', 'Customer Name', 'QuickBooks Customer', 'Service Address', 'Meter ID', 'Last Reading', 'Current Reading', 'Usage', 'Name Status', 'Name on Old Sheet']);
  ws.addRow([1, '2751415', 'Test Greens', '', 'Halfway House', '2751415', 27011, 27600, { formula: 'H5-G5', result: 589 }, 'Confirmed', '']);
  ws.addRow([2, '2751416', 'Fixed In Excel, Greg', 'Testy, Greg & Pat', '434 Fake Vista', '2751416', 66476, null, '', 'Updated from master list', 'Old, Name']);
  ws.addRow([3, '1A', 'No Meter, Pat', '', '142 Fake Trot 1A', 'no meter', 0, null, '', 'Check: more than one possible owner', '']);
  const buf = await wb.xlsx.writeBuffer();
  const r = await fetch(base + '/api/admin/meters/import-xlsx', { method: 'POST', headers: { 'x-ch': '1', 'Content-Type': 'application/octet-stream', Cookie: '' + (await (async () => { return ''; })()) }, body: buf });
  assert.strictEqual(r.status, 401, 'needs the owner login');
  const up = await O.raw('/api/admin/meters/import-xlsx', buf);
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  assert.deepStrictEqual(up.body, { meters: 3, readings: 1 });
  const adm = (await O('GET', '/api/admin/meters?all=1')).body;
  const act = adm.meters.filter(m => m.active);
  assert.deepStrictEqual(act.map(m => m.name), ['Test Greens', 'Fixed In Excel, Greg', 'No Meter, Pat']);
  assert.strictEqual(act[0].current, 27600, 'current reading saved for this quarter');
  assert.strictEqual(act[1].qbCustomer, 'Testy, Greg & Pat'); assert.strictEqual(act[1].nameCheck, false);
  assert.strictEqual(act[2].meterNo, ''); assert.strictEqual(act[2].notes, 'No meter'); assert.strictEqual(act[2].nameCheck, true);
  assert.strictEqual((await O.raw('/api/admin/meters/import-xlsx', Buffer.from('not excel'))).status, 400);
});

test('add a meter mid-route; properties not on the route; not needed / put back', async () => {
  await O('POST', '/api/admin/members/import', { columns: ['Status', 'Last name', 'First name(s)', 'Property type', 'Parcel ID', 'Deerfield address'], rows: [
    { Status: 'Active', 'Last name': 'Onroute', 'First name(s)': 'Al', 'Property type': 'Home', 'Deerfield address': 'Halfway House' },
    { Status: 'Active', 'Last name': 'Testy', 'First name(s)': 'Greg', 'Property type': 'Home', 'Deerfield address': '434 Fake Vista Lane' },
    { Status: 'Active', 'Last name': 'Newhome', 'First name(s)': 'Nina', 'Property type': 'Home', 'Parcel ID': '999 A 1', 'Deerfield address': '440 Fake Vista Lane' },
    { Status: 'Active', 'Last name': 'Lotowner', 'First name(s)': 'Lou', 'Property type': 'Lot', 'Deerfield address': '500 Fake Vista Lot 3' },
    { Status: 'Inactive / sold', 'Last name': 'Gone', 'Property type': 'Home', 'Deerfield address': '450 Fake Vista' }
  ] });
  let r = await O('GET', '/api/admin/meters/not-on-route');
  const addrs = r.body.properties.map(p => p.address);
  assert.ok(addrs.includes('440 Fake Vista Lane') && addrs.includes('500 Fake Vista Lot 3'));
  assert.ok(!addrs.includes('434 Fake Vista Lane'), '434 is on the route (as "434 Fake Vista")');
  assert.ok(!addrs.includes('450 Fake Vista'), 'inactive owners are left out');
  const nh = r.body.properties.find(p => p.address === '440 Fake Vista Lane');
  assert.deepStrictEqual(nh.names, ['Newhome, Nina']); assert.strictEqual(nh.type, 'Home');
  const before = (await O('GET', '/api/admin/meters?all=1')).body.meters.filter(m => m.active);
  const fake = before.find(m => m.address === '434 Fake Vista');
  assert.strictEqual(nh.suggestSeq, fake.seq + 1, 'suggested right after the last meter on the same street');
  // add it there: later meters move down one
  r = await O('POST', '/api/admin/meters', { seq: nh.suggestSeq, name: 'Newhome, Nina', address: '440 Fake Vista Lane', meterNo: '7777777', startReading: '120' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const after = r.body.meters.filter(m => m.active);
  assert.strictEqual(after.length, before.length + 1);
  const added = after.find(m => m.id === r.body.id);
  assert.strictEqual(added.seq, nh.suggestSeq); assert.strictEqual(added.previous, 120);
  const moved = after.find(m => m.id === before.find(m => m.seq === nh.suggestSeq).id);
  assert.strictEqual(moved.seq, nh.suggestSeq + 1, 'the meter that was there moved down one');
  r = await O('GET', '/api/admin/meters/not-on-route');
  assert.ok(!r.body.properties.some(p => p.address === '440 Fake Vista Lane'), 'gone from the list once added');
  // not needed / put back
  r = await O('POST', '/api/admin/meters/skip', { address: '500 Fake Vista Lot 3' });
  assert.strictEqual(r.body.properties.find(p => p.address === '500 Fake Vista Lot 3').skipped, true);
  r = await O('POST', '/api/admin/meters/skip', { address: '500 Fake Vista Lot 3', skip: false });
  assert.strictEqual(r.body.properties.find(p => p.address === '500 Fake Vista Lot 3').skipped, false);
  // blank seq = end of the route
  r = await O('POST', '/api/admin/meters', { name: 'End, Ed', address: '1 End Road' });
  const end = r.body.meters.filter(m => m.active);
  assert.strictEqual(end[end.length - 1].name, 'End, Ed');
  assert.strictEqual((await O('POST', '/api/admin/meters', {})).status, 400);
});

test('needs to order: off by default, rough cost and picture when adding, mark ordered', async () => {
  assert.strictEqual((await jake('GET', '/tasks?kind=order')).status, 403, 'off until the boss turns it on');
  const row = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Jake');
  assert.strictEqual(row.features.orders, false);
  await O('PUT', '/api/admin/crew/' + row.id, { features: { ...row.features, orders: true } });
  assert.strictEqual((await jake('POST', '/tasks', { kind: 'order', title: 'Ball valves', cost: 'abc' })).status, 400);
  let r = await jake('POST', '/tasks', { kind: 'order', title: '2" PVC ball valve x4', details: 'For the pump house', due: '2026-12-01', cost: '$1,250.50', photos: [JPEG] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const item = r.body.tasks[0];
  assert.strictEqual(item.cost, 1250.5); assert.strictEqual(item.due, '2026-12-01'); assert.strictEqual(item.photos.length, 1); assert.strictEqual(r.body.kind, 'order');
  assert.ok(!(await jake('GET', '/tasks')).body.tasks.some(t => t.id === item.id), 'not in the normal Tasks list');
  assert.strictEqual((await sam('GET', '/tasks?kind=order')).status, 403, 'Sam has it off');
  // boss: sees it, adds one with a cost, edits cost
  let b = (await O('GET', '/api/admin/tasks?kind=order')).body.tasks;
  assert.strictEqual(b.find(t => t.id === item.id).createdByName, 'Jake');
  r = await O('POST', '/api/admin/tasks', { kind: 'order', title: 'Chlorine tablets', cost: '89', photos: [JPEG] });
  const tabs = r.body.tasks.find(t => t.title === 'Chlorine tablets');
  assert.strictEqual(tabs.cost, 89); assert.strictEqual(tabs.photos.length, 1);
  r = await O('PUT', '/api/admin/tasks/' + tabs.id, { cost: '' });
  assert.strictEqual(r.body.tasks.find(t => t.id === tabs.id).cost, null);
  // quantity: free text, saved and editable
  r = await jake('POST', '/tasks', { kind: 'order', title: 'Chlorine pucks', qty: '  2   boxes ' });
  const pucks = r.body.tasks.find(t => t.title === 'Chlorine pucks');
  assert.strictEqual(pucks.qty, '2 boxes');
  r = await O('PUT', '/api/admin/tasks/' + pucks.id, { qty: '3 boxes' });
  assert.strictEqual(r.body.tasks.find(t => t.id === pucks.id).qty, '3 boxes');
  r = await O('POST', '/api/admin/tasks', { kind: 'order', title: 'Pipe', qty: '100 ft' });
  assert.strictEqual(r.body.tasks.find(t => t.title === 'Pipe').qty, '100 ft');
  // mark ordered
  r = await jake('POST', `/tasks/${item.id}/done`, { notes: 'Ordered from Ferguson, arrives Friday' });
  assert.strictEqual(r.body.tasks.find(t => t.id === item.id).status, 'done');
});

test('leaks & repairs: the owner at that address comes from the members list', async () => {
  await O('POST', '/api/admin/members/import', { columns: ['Status', 'Last name', 'First name(s)', 'Deerfield address', 'Cell phone 1', 'Home phone'], rows: [
    { Status: 'Active', 'Last name': 'Meadows', 'First name(s)': 'Pat', 'Deerfield address': '141 Deer Meadow Dr', 'Cell phone 1': '(603) 555-0141' },
    { Status: 'Active', 'Last name': 'Wrong', 'First name(s)': 'Ron', 'Deerfield address': '141 Deer Run Point', 'Home phone': '603-555-9999' },
    { Status: 'Active', 'Last name': 'Tail', 'First name(s)': 'Wendy', 'Deerfield address': '305 Whitetail Lane' },
    { Status: 'Inactive', 'Last name': 'Gone', 'First name(s)': 'Old', 'Deerfield address': '77 Old Mill Rd' }
  ] });
  // the repair logged earlier ("Leak at meter by 141 Deer Meadow") is matched from its title
  let b = (await O('GET', '/api/admin/tasks?kind=repair')).body.tasks;
  const old = b.find(t => /141 Deer Meadow/.test(t.title));
  assert.strictEqual(old.owner, 'Pat Meadows'); assert.strictEqual(old.ownerPhone, '(603) 555-0141');
  // crew: phone only for people with the Members list on
  const row = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Jake');
  await O('PUT', '/api/admin/crew/' + row.id, { features: { ...row.features, members: false } });
  let r = await jake('POST', '/tasks', { kind: 'repair', title: 'Curb stop leaking', address: '305 White Tail Ln', forMe: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  let t = r.body.tasks.find(x => x.title === 'Curb stop leaking');
  assert.strictEqual(t.address, '305 White Tail Ln'); assert.strictEqual(t.owner, 'Wendy Tail');
  assert.strictEqual(r.body.tasks.find(x => x.id === old.id) ? r.body.tasks.find(x => x.id === old.id).ownerPhone : '', '');
  await O('PUT', '/api/admin/crew/' + row.id, { features: { ...row.features, members: true } });
  r = await jake('POST', '/tasks', { kind: 'repair', title: 'Wet spot', address: '141 Deer Run Pt', forMe: true });
  t = r.body.tasks.find(x => x.title === 'Wet spot');
  assert.strictEqual(t.owner, 'Ron Wrong'); assert.strictEqual(t.ownerPhone, '603-555-9999');
  // no match, inactive, and a changed address looks it up again
  r = await O('POST', '/api/admin/tasks', { kind: 'repair', title: 'Hydrant drip', address: '77 Old Mill Rd' });
  t = r.body.tasks.find(x => x.title === 'Hydrant drip');
  assert.strictEqual(t.owner, '');
  r = await O('PUT', '/api/admin/tasks/' + t.id, { address: '141 Deer Meadow' });
  assert.strictEqual(r.body.tasks.find(x => x.id === t.id).owner, 'Pat Meadows');
  // ordinary tasks are never looked up
  r = await O('POST', '/api/admin/tasks', { title: 'Fix 141 Deer Meadow mailbox' });
  assert.strictEqual(r.body.tasks.find(x => x.title === 'Fix 141 Deer Meadow mailbox').owner, '');
});

test('leaks & repairs: progress photos and notes while the job is open', async () => {
  let r = await jake('POST', '/tasks', { kind: 'repair', title: 'Main break on Deerfield Way', forMe: true, photos: [JPEG] });
  const job = r.body.tasks.find(x => x.title === 'Main break on Deerfield Way');
  assert.strictEqual(job.photos.length, 1, 'photo when reporting');
  assert.strictEqual((await jake('POST', `/tasks/${job.id}/progress`, {})).status, 400, 'needs a photo or a note');
  r = await jake('POST', `/tasks/${job.id}/progress`, { notes: 'Dug down to the line', photos: [JPEG, JPEG] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  let t = r.body.tasks.find(x => x.id === job.id);
  assert.strictEqual(t.status, 'open', 'still open');
  assert.strictEqual(t.updates.length, 1); assert.strictEqual(t.updates[0].note, 'Dug down to the line'); assert.strictEqual(t.updates[0].by, 'Jake');
  assert.strictEqual(t.updates[0].photos.length, 2); assert.strictEqual(t.photos.length, 1, 'progress photos kept apart');
  assert.strictEqual((await jake('GET', '/tasks/photo/' + t.updates[0].photos[0])).status, 200);
  // the boss sees it and adds one too
  r = await O('POST', `/api/admin/tasks/${job.id}/progress`, { notes: 'Coupling ordered' });
  t = r.body.tasks.find(x => x.id === job.id);
  assert.strictEqual(t.updates.length, 2); assert.strictEqual(t.updates[1].by, 'Tyler');
  // Sam can't remove Jake's update; Jake can
  assert.strictEqual((await sam('DELETE', '/tasks/updates/' + t.updates[0].id)).status, 400);
  assert.strictEqual((await O2('DELETE', '/api/admin/tasks/updates/' + t.updates[0].id)).status, 400, 'other company');
  r = await jake('DELETE', '/tasks/updates/' + t.updates[0].id);
  assert.strictEqual(r.body.tasks.find(x => x.id === job.id).updates.length, 1);
  // photo limit counts everything; done jobs take no more progress
  assert.strictEqual((await jake('POST', `/tasks/${job.id}/progress`, { photos: Array(12).fill(JPEG) })).status, 400);
  await jake('POST', `/tasks/${job.id}/done`, { notes: 'Fixed' });
  assert.strictEqual((await jake('POST', `/tasks/${job.id}/progress`, { notes: 'x' })).status, 400);
  // switched off = blocked
  const row = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Sam');
  await O('PUT', '/api/admin/crew/' + row.id, { features: { ...row.features, w_repairs: false } });
  assert.strictEqual((await sam('POST', `/tasks/${job.id}/progress`, { notes: 'x' })).status, 403);
  await O('PUT', '/api/admin/crew/' + row.id, { features: { ...row.features, w_repairs: true } });
});

test('high water use: flagged against the meter\'s usual use, report a leak from it, or mark not a leak', async () => {
  const db2 = require('../src/db');
  const c = await db2.one("SELECT id FROM companies WHERE name='Deerfield'");
  await O('POST', '/api/admin/meters/import', { meters: Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, account: 'A' + i, meterNo: 'M' + i, name: 'Owner ' + i, address: (100 + i) + ' Deer Meadow', startReading: 1000 })) });
  const ms = (await O('GET', '/api/admin/meters')).body.meters;
  // two past quarters of ~100 a quarter for every meter
  const q = (await O('GET', '/api/admin/meters')).body.thisQuarter;
  const back = (qq, n) => { let y = Number(qq.slice(0, 4)), k = Number(qq.slice(6)) - n; while (k < 1) { k += 4; y--; } return y + '-Q' + k; };
  for (const m of ms) {
    await db2.q('INSERT INTO meter_reads (company_id, meter_id, reading, month) VALUES ($1,$2,1100,$3),($1,$2,1200,$4)', [c.id, m.id, back(q, 2), back(q, 1)]);
  }
  // normal, high, lower
  await O('POST', `/api/admin/meters/${ms[0].id}/read`, { reading: '1290', quarter: q });
  let r = await jake('POST', `/meters/${ms[1].id}/read`, { reading: '1650' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.meter.alert.level, 'high'); assert.strictEqual(r.body.meter.alert.basis, 'own');
  assert.ok(r.body.meter.alert.times >= 4, JSON.stringify(r.body.meter.alert));
  await O('POST', `/api/admin/meters/${ms[2].id}/read`, { reading: '1100', quarter: q });
  let d = (await O('GET', '/api/admin/meters')).body;
  const by = id => d.meters.find(m => m.id === id);
  assert.strictEqual(by(ms[0].id).alert, null);
  assert.strictEqual(by(ms[2].id).alert.level, 'low');
  assert.strictEqual(d.highUse, 1); assert.strictEqual(d.typical, 100);
  // crew reports a leak from it: linked, owner looked up, no double report from a resend
  const ref = 'test-ref-12345';
  r = await jake('POST', '/tasks', { kind: 'repair', title: 'High water use at 101 Deer Meadow', address: '101 Deer Meadow', meterId: ms[1].id, clientRef: ref });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await jake('POST', '/tasks', { kind: 'repair', title: 'High water use at 101 Deer Meadow', address: '101 Deer Meadow', meterId: ms[1].id, clientRef: ref });
  const leaks = (await O('GET', '/api/admin/tasks?kind=repair')).body.tasks.filter(t => t.title === 'High water use at 101 Deer Meadow');
  assert.strictEqual(leaks.length, 1, 'sent twice, saved once');
  d = (await O('GET', '/api/admin/meters')).body;
  assert.strictEqual(by(ms[1].id).leakTaskId, leaks[0].id);
  assert.strictEqual((await jake('GET', '/meters')).body.meters.find(m => m.id === ms[1].id).leakTaskId, leaks[0].id);
  // not a leak: the flag goes away, and comes back if the reading changes
  r = await O('POST', `/api/admin/meters/${ms[1].id}/not-a-leak`, { quarter: q });
  assert.strictEqual(r.body.meters.find(m => m.id === ms[1].id).alert, null);
  assert.strictEqual(r.body.highUse, 0);
  await O('POST', `/api/admin/meters/${ms[1].id}/read`, { reading: '1700', quarter: q });
  d = (await O('GET', '/api/admin/meters')).body;
  assert.strictEqual(by(ms[1].id).alert.level, 'high');
  // the first reading after the old sheet is the starting point (it covers years): never flagged
  const fresh = (await O('POST', '/api/admin/meters', { name: 'New, Nina', address: '500 Deer Meadow', meterNo: 'N1', startReading: '0' })).body.id;
  await O('POST', `/api/admin/meters/${fresh}/read`, { reading: '900', quarter: q });
  d = (await O('GET', '/api/admin/meters')).body;
  assert.strictEqual(by(fresh).alert, null);
  // a meter with one reading last quarter and no usual use yet: compared with a typical meter (4x)
  const fresh2 = (await O('POST', '/api/admin/meters', { name: 'New, Ned', address: '501 Deer Meadow', meterNo: 'N2' })).body.id;
  await O('POST', `/api/admin/meters/${fresh2}/read`, { reading: '100', quarter: back(q, 1) });
  await O('POST', `/api/admin/meters/${fresh2}/read`, { reading: '900', quarter: q });
  d = (await O('GET', '/api/admin/meters')).body;
  assert.strictEqual(by(fresh2).alert.basis, 'typical');
  // old quarter not allowed from the crew app: falls back to this quarter
  r = await jake('POST', `/meters/${ms[3].id}/read`, { reading: '1300', quarter: '2020-Q1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await db2.one('SELECT month FROM meter_reads WHERE meter_id=$1 ORDER BY month DESC LIMIT 1', [ms[3].id])).month, q);
});

test('QuickBooks billing: invoices per read meter, split 100 per file, settings saved', async () => {
  let b = (await O('GET', '/api/admin/billing')).body;
  assert.strictEqual(b.ready, false);
  assert.strictEqual((await O('GET', '/api/admin/billing.csv')).status, 400);
  assert.strictEqual((await O('PUT', '/api/admin/billing', { rate: 'abc' })).status, 400);
  b = (await O('PUT', '/api/admin/billing', { rate: '0.5', base: '$10', dueDays: 15, prefix: 'W' })).body;
  assert.strictEqual(b.ready, true); assert.strictEqual(b.settings.rate, 0.5);
  // from the high-use test: meter 0 used 90, meter 2 was lower (left out), unread meters left out
  const inv = b.invoices.find(i => i.customer === 'Owner 0');
  assert.strictEqual(inv.total, 55); assert.strictEqual(inv.lines.length, 2);
  assert.ok(b.skipped.some(s => s.name === 'Owner 2' && /Lower/.test(s.why)));
  assert.ok(b.skipped.some(s => s.why === 'Not read'));
  assert.strictEqual(b.parts, 1);
  const f = await O('GET', '/api/admin/billing.csv?part=1');
  assert.strictEqual(f.status, 200);
  const text = f.body.toString();
  assert.match(text, /^"Invoice no","Customer","Invoice date","Due date"/);
  assert.match(text, /"Owner 0",".{10}",".{10}",.*"Water usage",.*"90","0.5","45.00"/);
  assert.match(text, /"Water base charge",.*"1","10","10.00"/);
  assert.strictEqual((await O2('GET', '/api/admin/billing')).body.invoices.length, 0, 'other company');
  // from January: $75 a quarter includes 5,000 gallons; over that, per gallon (rate set later). Meters read in gallons x 10 here.
  b = (await O('PUT', '/api/admin/billing', { rate: '', base: '75', allowance: '5,000', overRate: '', unitGallons: 10 })).body;
  const o0 = b.invoices.find(i => i.customer === 'Owner 0');   // used 90 units = 900 gallons
  assert.strictEqual(o0.gallons, 900); assert.strictEqual(o0.total, 75); assert.strictEqual(o0.over, 0);
  const nina = b.invoices.find(i => i.customer === 'New, Nina');   // first reading: the starting point, base charge only
  assert.ok(nina.first); assert.strictEqual(nina.total, 75);
  const ned = b.invoices.find(i => i.customer === 'New, Ned');   // 800 units = 8,000 gallons: 3,000 over, no rate yet
  assert.strictEqual(ned.over, 3000); assert.strictEqual(ned.total, 75); assert.ok(b.overNoRate >= 1);
  b = (await O('PUT', '/api/admin/billing', { overRate: '0.01' })).body;
  const ned2 = b.invoices.find(i => i.customer === 'New, Ned');
  assert.strictEqual(ned2.total, 105); assert.strictEqual(ned2.lines[1].item, 'Water overage'); assert.strictEqual(ned2.lines[1].qty, 3000);
  assert.match((await O('GET', '/api/admin/billing.csv')).body.toString(), /"Water overage",".*3,000 gallons over 5,000","3000","0.01","30.00"/);
});

test('address jobs: off by default, time in/out, costs, receipts, owner from the members list; hours can be switched off', async () => {
  assert.strictEqual((await sam('GET', '/jobs')).status, 403, 'off until switched on');
  const row = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Sam');
  assert.strictEqual(row.features.jobs, false); assert.strictEqual(row.features.hours, true);
  await O('PUT', '/api/admin/crew/' + row.id, { features: { ...row.features, jobs: true, hours: false } });
  const wk = (await sam('GET', '/week')).body;
  assert.strictEqual(wk.features.jobs, true); assert.strictEqual(wk.features.hours, false);
  assert.strictEqual((await sam('POST', '/day', { day: wk.today, in1: '08:00', out1: '12:00' })).status, 403, 'no time sheet');
  // addresses come from the members list, with owners
  const ad = (await sam('GET', '/jobs/addresses')).body.addresses;
  assert.ok(ad.some(a => a.address === '141 Deer Meadow Dr' && a.owner === 'Pat Meadows'));
  // add a job: in now, out later
  assert.strictEqual((await sam('POST', '/jobs', { address: '' })).status, 400);
  assert.strictEqual((await sam('POST', '/jobs', { address: '141 Deer Meadow Dr', day: wk.today, chemCost: 'abc' })).status, 400);
  let r = await sam('POST', '/jobs', { address: '141 Deer Meadow Dr', day: wk.today, timeIn: '08:30', chemCost: '$42.50', receipts: [JPEG], clientRef: 'job-ref-123456' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await sam('POST', '/jobs', { address: '141 Deer Meadow Dr', day: wk.today, timeIn: '08:30', clientRef: 'job-ref-123456' });
  assert.strictEqual(r.body.jobs.length, 1);
  let j = r.body.jobs[0];
  assert.strictEqual(j.owner, 'Pat Meadows'); assert.strictEqual(j.chemCost, 42.5); assert.strictEqual(j.receipts.length, 1); assert.strictEqual(j.timeOut, null);
  assert.strictEqual((await sam('GET', '/jobs')).body.jobs.length, 1, 'resend made no second job');
  r = await sam('PUT', '/jobs/' + j.id, { timeOut: '10:45', materialCost: '18', receipts: [JPEG] });
  j = r.body.jobs[0];
  assert.strictEqual(j.hours, 2.3); assert.strictEqual(j.total, 60.5); assert.strictEqual(j.receipts.length, 2);
  assert.strictEqual((await sam('GET', '/receipts/' + j.receipts[0])).status, 200);
  // other crew can't see or change it
  assert.strictEqual((await jake('PUT', '/jobs/' + j.id, { notes: 'x' })).status, 403, 'Jake has jobs off');
  // the boss: totals, CSV, edit, receipts
  let b = (await O('GET', '/api/admin/jobs')).body;
  assert.strictEqual(b.totals.jobs, 1); assert.strictEqual(b.totals.total, 60.5); assert.strictEqual(b.jobs[0].crewName, 'Sam');
  assert.strictEqual((await O('GET', '/api/admin/receipts/' + j.receipts[0])).status, 200);
  assert.match((await O('GET', '/api/admin/jobs.csv')).body.toString(), /"141 Deer Meadow Dr","Pat Meadows","08:30","10:45","2.3","42.5","18","60.5","2"/);
  r = await O('PUT', '/api/admin/jobs/' + j.id, { address: '305 Whitetail Lane' });
  assert.strictEqual(r.body.jobs[0].owner, 'Wendy Tail');
  assert.strictEqual((await O2('GET', '/api/admin/jobs')).body.jobs.length, 0, 'other company');
  assert.strictEqual((await O2('GET', '/api/admin/receipts/' + j.receipts[0])).status, 404);
  await O('PUT', '/api/admin/crew/' + row.id, { features: { ...row.features, jobs: false, hours: true } });
});

test('needs to order: ordered -> arrived with the real cost; monthly spending', async () => {
  const row = (await O('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Jake');
  await O('PUT', '/api/admin/crew/' + row.id, { features: { ...row.features, orders: true } });
  let r = await jake('POST', '/tasks', { kind: 'order', title: 'Pump seal kit', cost: '200' });
  const item = r.body.tasks.find(t => t.title === 'Pump seal kit');
  assert.strictEqual((await jake('POST', `/tasks/${item.id}/arrived`, {})).status, 400, 'order it first');
  await jake('POST', `/tasks/${item.id}/done`, { notes: 'Ordered from Grainger' });
  r = await jake('GET', '/tasks?kind=order');
  let t = r.body.tasks.find(x => x.id === item.id);
  assert.strictEqual(t.status, 'done'); assert.strictEqual(t.arrivedAt, null);
  assert.ok((await sam('GET', '/tasks?kind=order')).status === 403);
  r = await jake('POST', `/tasks/${item.id}/arrived`, { actualCost: '$215.50' });
  t = r.body.tasks.find(x => x.id === item.id);
  assert.ok(t.arrivedAt); assert.strictEqual(t.actualCost, 215.5); assert.strictEqual(t.arrivedByName, 'Jake');
  let s = (await O('GET', '/api/admin/orders/spending')).body;
  const m = s.months[0];
  assert.strictEqual(m.actual, 215.5); assert.strictEqual(m.estimate, 200);
  // the boss fixes the cost, then undoes
  r = await O('POST', `/api/admin/tasks/${item.id}/arrived`, { actualCost: '210' });
  assert.strictEqual(r.body.spending.months[0].actual, 210);
  r = await O('POST', `/api/admin/tasks/${item.id}/arrived`, { undo: true });
  assert.strictEqual(r.body.tasks.find(x => x.id === item.id).arrivedAt, null, 'still listed while waiting');
  assert.ok(r.body.spending.waiting >= 1);
  assert.strictEqual((await O('POST', `/api/admin/tasks/${item.id}/arrived`, { actualCost: 'x' })).status, 400);
  assert.strictEqual((await O2('POST', `/api/admin/tasks/${item.id}/arrived`, {})).status, 400, 'other company');
});

test('weekly email: adds roads, leaks, meters, orders and address jobs; leaves out people without a time sheet', async () => {
  const R = require('../src/reports'), H2 = require('../src/hours'), db2 = require('../src/db');
  const c = await db2.one("SELECT * FROM companies WHERE name='Deerfield'");
  const sam1 = (await O('GET', '/api/admin/crew')).body.crew.find(x => x.name === 'Sam');
  await O('PUT', '/api/admin/crew/' + sam1.id, { features: { ...sam1.features, hours: false, jobs: true } });
  const today = H2.today(c);
  await sam('POST', '/jobs', { address: '141 Deer Meadow Dr', day: today, timeIn: '09:00', timeOut: '10:00', chemCost: '12', materialCost: '3' });
  const r = await R.weeklySummary(c, H2.weekOf(c, today), { final: false });
  assert.match(r.html, /This week at a glance/);
  assert.match(r.html, /Leaks &amp; repairs:<\/b> \d+ reported, \d+ fixed this week/);
  assert.match(r.html, /Meters \(Q\d \d{4}/);
  assert.match(r.html, /high use \(possible leak\)/);
  assert.match(r.html, /Needs to order:/);
  assert.match(r.html, /Bill’s Billables \(Sam\):<\/b> \d+ jobs? · chemicals \$\d/);
  assert.ok(!/Sam: no hours logged/.test(r.html), 'Sam has no time sheet');
  await O('PUT', '/api/admin/crew/' + sam1.id, { features: { ...sam1.features, hours: true, jobs: false } });
});

test('crew weekly email: their own time sheet and address jobs, to the email on their entry', async () => {
  const { send } = require('../src/email');
  const R = require('../src/reports'), H2 = require('../src/hours'), db2 = require('../src/db');
  const c = await db2.one("SELECT * FROM companies WHERE name='Deerfield'");
  const sam1 = (await O('GET', '/api/admin/crew')).body.crew.find(x => x.name === 'Sam');
  assert.strictEqual((await O('PUT', '/api/admin/crew/' + sam1.id, { email: 'not-an-email' })).status, 400);
  assert.strictEqual((await O('POST', `/api/admin/crew/${sam1.id}/email-week`, {})).status, 400, 'needs an email');
  let r = await O('PUT', '/api/admin/crew/' + sam1.id, { email: 'Sam@Example.com', features: { ...sam1.features, hours: false, jobs: true } });
  assert.strictEqual(r.body.crew.find(x => x.id === sam1.id).email, 'sam@example.com');
  const ws = H2.weekOf(c, H2.today(c));
  send.outbox.length = 0;
  r = await O('POST', `/api/admin/crew/${sam1.id}/email-week`, { weekStart: ws });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const m = send.outbox.find(x => x.to.includes('sam@example.com'));
  assert.ok(m, 'sent to Sam');
  assert.match(m.subject, /^Your week: .* address jobs?, [0-9.]+ h on site/);
  assert.match(m.html, /Bill’s Billables/); assert.match(m.html, /141 Deer Meadow Dr/); assert.match(m.html, /Chemicals \+ materials: \$/);
  assert.ok(!/Time sheet/.test(m.html), 'no time sheet section when hours are off');
  // with the time sheet on, it's in there too
  await O('PUT', '/api/admin/crew/' + sam1.id, { features: { ...sam1.features, hours: true, jobs: false } });
  const p = await db2.one('SELECT * FROM crew WHERE id=$1', [sam1.id]);
  const e = await R.personalWeekly(c, p, ws);
  assert.match(e.html, /Time sheet/); assert.ok(!/Bill’s Billables/.test(e.html));
  await O('PUT', '/api/admin/crew/' + sam1.id, { email: '' });
});

test('address jobs invoices: monthly, one per client, everything broken out; QuickBooks file; monthly email', async () => {
  const { send } = require('../src/email');
  const db2 = require('../src/db'), H2 = require('../src/hours');
  const c = await db2.one("SELECT * FROM companies WHERE name='Deerfield'");
  const month = H2.today(c).slice(0, 7), day = H2.today(c);
  const sam1 = (await O('GET', '/api/admin/crew')).body.crew.find(x => x.name === 'Sam');
  await O('POST', '/api/admin/jobs', { crewId: sam1.id, address: '141 Deer Meadow Dr', day, timeIn: '08:00', timeOut: '09:30', chemCost: '20', materialCost: '10' });
  await O('POST', '/api/admin/jobs', { crewId: sam1.id, address: '141 Deer Meadow Dr', day, timeIn: '13:00', timeOut: '14:00', chemCost: '5' });
  let b = (await O('GET', '/api/admin/jobs/month?month=' + month)).body;
  const pat = b.clients.find(x => x.address === '141 Deer Meadow Dr');
  assert.ok(pat, JSON.stringify(b.clients.map(x => x.address)));
  assert.strictEqual(pat.visits.length, 3, 'with the one from the weekly email test'); assert.strictEqual(pat.totals.hours, 3.5);
  assert.strictEqual(pat.totals.labor, 0, 'no rate yet');
  assert.strictEqual((await O('PUT', '/api/admin/job-billing', { laborRate: 'abc' })).status, 400);
  b = (await O('PUT', '/api/admin/job-billing', { month, laborRate: '60', chemMarkup: '10', visitCharge: '15' })).body;
  const p2 = b.clients.find(x => x.address === '141 Deer Meadow Dr');
  assert.strictEqual(p2.totals.labor, 210); assert.strictEqual(p2.totals.chem, 40.7); assert.strictEqual(p2.totals.mat, 13); assert.strictEqual(p2.totals.visit, 45);
  assert.strictEqual(p2.totals.total, 308.7);
  assert.strictEqual(p2.customer, 'Pat Meadows', 'owner from the members list');
  // breakdown CSV: each visit + client total + month total
  const csv = (await O('GET', '/api/admin/jobs/month.csv?month=' + month)).body.toString();
  assert.match(csv, /"Pat Meadows total","141 Deer Meadow Dr","3 visits",.*"308.7"/);
  assert.match(csv, /total","\d+ clients"/);
  // QuickBooks invoices: one invoice, lines for labor, chemicals, materials, visits
  const inv = (await O('GET', '/api/admin/jobs/invoices.csv?month=' + month)).body.toString();
  const lines = inv.split('\r\n').filter(l => l.includes('"Pat Meadows"'));
  assert.strictEqual(lines.length, 4);
  assert.ok(lines.every(l => l.startsWith(lines[0].slice(0, 14))), 'same invoice number');
  assert.match(lines[0], /"Labor",".*","3.5","60","210.00"/);
  assert.match(lines[3], /"Service call","3 visits: .*","3","15","45.00"/);
  // email
  send.outbox.length = 0;
  const r = await O('POST', '/api/admin/jobs/month/email', { month });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const m = send.outbox.find(x => /ready to approve/.test(x.subject));
  assert.ok(m); assert.match(m.html, /Pat Meadows/); assert.match(m.html, /\$308.70/);
  assert.strictEqual((await O('GET', '/api/admin/jobs/month?month=1999-01')).body.clients.length, 0);
  assert.strictEqual((await O2('GET', '/api/admin/jobs/month?month=' + month)).body.clients.length, 0, 'other company');
});

test('job invoices: made as drafts from the crew member, approve each and it goes to the client, once', async () => {
  const { send } = require('../src/email');
  const db2 = require('../src/db'), H2 = require('../src/hours');
  const c = await db2.one("SELECT * FROM companies WHERE name='Deerfield'");
  const month = H2.today(c).slice(0, 7);
  // client email from the members list
  await O('POST', '/api/admin/members/import', { columns: ['Status', 'Last name', 'First name(s)', 'Deerfield address', 'Email 1'], rows: [
    { Status: 'Active', 'Last name': 'Meadows', 'First name(s)': 'Pat', 'Deerfield address': '141 Deer Meadow Dr', 'Email 1': 'Pat@Example.com' },
    { Status: 'Active', 'Last name': 'Tail', 'First name(s)': 'Wendy', 'Deerfield address': '305 Whitetail Lane' }] });
  await O('PUT', '/api/admin/job-billing', { fromName: 'Bill Newhaul', fromEmail: 'newtenn310@gmail.com', payTo: 'Checks to Bill Newhaul' });
  send.outbox.length = 0;
  let r = await O('POST', '/api/admin/jobs/month/email', { month });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const boss = send.outbox.find(m => /invoices? ready to approve/.test(m.subject));
  assert.ok(boss, send.outbox.map(m => m.subject).join(' | '));
  assert.match(boss.html, /Review &amp; send/);
  assert.ok(!send.outbox.some(m => m.to.includes('pat@example.com')), 'nothing goes to a client before approval');
  let L = (await O('GET', '/api/admin/job-invoices?month=' + month)).body;
  const pat = L.invoices.find(i => i.address === '141 Deer Meadow Dr');
  assert.strictEqual(pat.status, 'draft'); assert.strictEqual(pat.fromName, 'Bill Newhaul'); assert.strictEqual(pat.email, 'pat@example.com');
  const wendy = L.invoices.find(i => i.address === '305 Whitetail Lane');
  assert.strictEqual(wendy.email, '', 'no email on the list');
  // the link from the email: GET only shows it; POST approves and sends
  const path = new URL(pat.link).pathname;
  let g = await fetch(base + path); assert.strictEqual(g.status, 200);
  let page = await g.text(); assert.match(page, /Approve &amp; send/); assert.match(page, /Bill Newhaul/); assert.match(page, /INVOICE/);
  assert.strictEqual((await fetch(base + path.replace(/[0-9a-f]{32}$/, '0'.repeat(32)))).status, 404, 'bad token');
  send.outbox.length = 0;
  g = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=pat%40example.com' });
  page = await g.text(); assert.strictEqual(g.status, 200, page.slice(0, 300)); assert.match(page, /Approved and sent/);
  const out = send.outbox.find(m => m.to.includes('pat@example.com'));
  assert.ok(out); assert.strictEqual(out.fromName, 'Bill Newhaul'); assert.strictEqual(out.fromAddress, 'newtenn310@gmail.com');
  assert.match(out.subject, /^Invoice J\d{6}-\d{3} from Bill Newhaul: \$/); assert.match(out.html, /Checks to Bill Newhaul/); assert.match(out.html, /Bill to/);
  // only once
  g = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=pat%40example.com' });
  assert.strictEqual(g.status, 400); assert.match(await g.text(), /Already sent/);
  // dashboard: needs an email, then approve & send; rebuilding never touches sent ones
  assert.strictEqual((await O('POST', `/api/admin/job-invoices/${wendy.id}/send`, { month })).status, 400);
  r = await O('PUT', `/api/admin/job-invoices/${wendy.id}`, { email: 'wendy@example.com', month });
  r = await O('POST', `/api/admin/job-invoices/${wendy.id}/send`, { month });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  L = (await O('POST', '/api/admin/job-invoices/build', { month })).body;
  assert.ok(L.invoices.filter(i => i.address === '141 Deer Meadow Dr').every(i => i.status === 'sent'));
  assert.strictEqual((await O2('GET', '/api/admin/job-invoices?month=' + month)).body.invoices.length, 0, 'other company');
  assert.strictEqual((await O2('GET', `/api/admin/job-invoices/${pat.id}/view`)).status, 404);
});

test('address jobs: running totals for the person; managers can view someone else (read-only)', async () => {
  const sam1 = (await O('GET', '/api/admin/crew')).body.crew.find(x => x.name === 'Sam');
  const jake1 = (await O('GET', '/api/admin/crew')).body.crew.find(x => x.name === 'Jake');
  await O('PUT', '/api/admin/crew/' + sam1.id, { features: { ...sam1.features, jobs: true } });
  let r = await sam('GET', '/jobs');
  assert.strictEqual(r.status, 200);
  const t = r.body.totals;
  assert.ok(t.month.jobs >= 3, JSON.stringify(t)); assert.ok(t.month.hours > 0); assert.ok(t.month.billed > 0, 'rates are set');
  assert.ok(t.week.jobs >= 1); assert.strictEqual(r.body.people, undefined, 'not a manager');
  assert.strictEqual((await sam('GET', '/jobs?crew=' + jake1.id)).status, 403, 'only managers look at others');
  // make Jake a manager without address jobs: he lands on Sam's jobs, read-only
  await O('PUT', '/api/admin/crew/' + jake1.id, { manager: true, features: { ...jake1.features, jobs: false } });
  r = await jake('GET', '/jobs');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.viewing, sam1.id); assert.strictEqual(r.body.mine, false);
  assert.ok(r.body.people.some(p => p.name === 'Sam'));
  assert.strictEqual(r.body.totals.month.jobs, t.month.jobs);
  const j = r.body.jobs[0];
  assert.strictEqual((await jake('PUT', '/jobs/' + j.id, { notes: 'x' })).status, 403, 'view only');
  if (j.receipts.length) assert.strictEqual((await jake('GET', '/receipts/' + j.receipts[0])).status, 200);
  await O('PUT', '/api/admin/crew/' + jake1.id, { manager: false });
  await O('PUT', '/api/admin/crew/' + sam1.id, { features: { ...sam1.features, jobs: false } });
});

test('priority tags: set, sorted most urgent first, and paste many at once', async () => {
  assert.strictEqual((await O('POST', '/api/admin/tasks', { kind: 'repair', title: 'x', priority: 'whenever' })).status, 400);
  let r = await O('POST', '/api/admin/tasks/bulk', { kind: 'repair', text: [
    'Urgent: Chuck 1231 df way condo 2 needs new water box ASAP',
    '183 Needs 2 meters second row',
    'High: 206 Deer Ridge main valve leak needs fixed -- photo on Trello',
    'Low: 439 deer hill find meter box', '', '  '].join('\n') });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.added, 4);
  const open = r.body.tasks.filter(t => t.status === 'open');
  assert.strictEqual(open[0].priority, 'urgent'); assert.match(open[0].title, /^Chuck 1231/);
  const v = open.find(t => /206 Deer Ridge/.test(t.title));
  assert.strictEqual(v.priority, 'high'); assert.strictEqual(v.details, 'photo on Trello'); assert.strictEqual(v.title, '206 Deer Ridge main valve leak needs fixed');
  assert.strictEqual(open.find(t => /^183 Needs/.test(t.title)).priority, 'normal', 'house number kept');
  assert.strictEqual(open[open.length - 1].priority === 'low' || open.some(t => t.priority === 'low'), true);
  r = await O('PUT', '/api/admin/tasks/' + v.id, { priority: 'urgent' });
  assert.strictEqual(r.body.tasks.find(t => t.id === v.id).priority, 'urgent');
  // crew can set it when reporting, and see it
  r = await jake('POST', '/tasks', { kind: 'repair', title: 'Big leak by the clubhouse', priority: 'urgent' });
  assert.strictEqual(r.body.tasks.find(t => t.title === 'Big leak by the clubhouse').priority, 'urgent');
  assert.strictEqual((await O('POST', '/api/admin/tasks/bulk', { kind: 'repair', text: '' })).status, 400);
});
