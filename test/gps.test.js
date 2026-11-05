// GPS on the roads driven checklist: road shapes from OpenStreetMap (mocked), a drive's route ticks the roads it
// covers, a batch sent twice is saved once, a hand tick during a drive learns that road, unticking sticks, maps.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// fake OpenStreetMap (Overpass)
const line = (lat, lon1, lon2, n = 6) => Array.from({ length: n }, (_, i) => ({ lat, lon: lon1 + (lon2 - lon1) * i / (n - 1) }));
let osmHits = 0;
const osm = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
    osmHits++;
    assert.match(decodeURIComponent(b), /around:\d+,36\.4,-84\.1/);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ elements: [
      { type: 'way', tags: { name: 'Deer Run Road' }, geometry: line(36.4000, -84.1000, -84.0950) },
      { type: 'way', tags: { name: 'Skyline Knoll' }, geometry: line(36.4050, -84.1000, -84.0950) },
      { type: 'way', tags: { name: 'Some Other Rd' }, geometry: line(36.4100, -84.1000, -84.0950) }
    ] }));
  });
});

let server, base, O, scott, db, ids, today;
before(async () => {
  await new Promise(ok => osm.listen(0, ok));
  process.env.OVERPASS_URL = `http://127.0.0.1:${osm.address().port}/api/interpreter`;
  db = require('../src/db');
  const { app } = require('../src/server');
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
  const slug = (await db.one('SELECT slug FROM companies')).slug, c = (await db.one('SELECT id FROM companies')).id;
  await O('POST', '/api/admin/crew', { name: 'Scott', pin: '2222' });
  await db.q("UPDATE crew SET is_manager=TRUE");
  for (const [i, n] of ['Deer Run', 'Skyline Knoll', 'Fairway Vista'].entries()) await db.q("INSERT INTO roads (company_id, name, position, kind) VALUES ($1,$2,$3,'road')", [c, n, i]);
  const crew = tok => async (method, path, body) => {
    const r = await fetch(`${base}/api/c/${slug}${path}`, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  scott = crew((await crew()('POST', '/login', { pin: '2222' })).body.token);
  const l = (await scott('GET', '/drives')).body; today = l.today;
  ids = Object.fromEntries(l.roads.map(r => [r.name, r.id]));
});
after(async () => { server.close(); osm.close(); await db.pool.end(); });

// points every ~20 m along a street, a few seconds apart
const drive = (lat, lon1, lon2, t0, acc = 8) => { const n = 25; return Array.from({ length: n }, (_, i) => [t0 + i * 4000, lat + 0.00002 * (i % 2), lon1 + (lon2 - lon1) * i / (n - 1), acc]); };

test('the map math: near the route or not, and how much of a road is covered', () => {
  const G = require('../src/geo');
  assert.ok(Math.abs(G.dist([36.4, -84.1], [36.4, -84.095]) - 448) < 5);
  const idx = G.routeIndex([[[36.4, -84.1], [36.4, -84.0975]]]);
  assert.ok(idx.near([36.4002, -84.099]), '22 m away'); assert.ok(!idx.near([36.401, -84.099]), '110 m away');
  const c = G.coverage([[[36.4, -84.1], [36.4, -84.095]]], idx);
  assert.ok(c > 0.45 && c < 0.6, String(c));
  assert.strictEqual(G.norm('Deer Run Rd.'), 'deer run road');
  assert.deepStrictEqual(Object.keys(G.matchWays([{ id: 1, name: 'Deer Meadow' }, { id: 2, name: 'Oak' }],
    [{ name: 'Deer Meadow Dr', line: [[0, 0], [1, 1]] }, { name: 'Oak Lane', line: [[0, 0], [1, 1]] }, { name: 'Oak Street', line: [[0, 0], [1, 1]] }])), ['1'], 'Oak is ambiguous');
});

test('road shapes: needs a location, then found by name on OpenStreetMap', async () => {
  assert.strictEqual((await O('POST', '/api/admin/drives/shapes/find')).status, 400);
  await db.q('UPDATE companies SET weather_lat=36.4, weather_lon=-84.1');
  const r = await O('POST', '/api/admin/drives/shapes/find');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.found, 2); assert.strictEqual(r.body.osm, 2);
  assert.deepStrictEqual(r.body.missing.map(m => m.name), ['Fairway Vista']);
});

test('driving Deer Run ticks it by GPS; the batch sent twice is saved once; rough fixes are left out', async () => {
  const pts = drive(36.4, -84.1, -84.095, Date.now() - 120e3);
  const r = await scott('POST', '/drives/trip', { ref: 'trip-aaaaaaaa1', points: pts });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.ticked, ['Deer Run']);
  const dr = r.body.list.roads.find(x => x.name === 'Deer Run'); assert.ok(dr.done && dr.auto); assert.strictEqual(dr.byName, 'Scott');
  assert.ok(!r.body.list.roads.find(x => x.name === 'Skyline Knoll').done);
  await scott('POST', '/drives/trip', { ref: 'trip-aaaaaaaa1', points: pts });
  assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM drive_points')).n, 25);
  // a fuzzy fix along Skyline doesn't count
  const fuzzy = drive(36.405, -84.1, -84.095, Date.now() - 60e3, 300);
  assert.deepStrictEqual((await scott('POST', '/drives/trip', { ref: 'trip-aaaaaaaa1', points: fuzzy })).body.ticked, []);
  assert.strictEqual((await scott('POST', '/drives/trip', { ref: 'x', points: [] })).status, 400);
});

test("a hand tick during a drive teaches the app that road's shape", async () => {
  await scott('POST', '/drives/trip', { ref: 'trip-aaaaaaaa1', points: drive(36.42, -84.1, -84.097, Date.now() - 30e3) });
  const r = await scott('POST', '/drives/' + ids['Fairway Vista'], { done: true });
  assert.ok(r.body.roads.find(x => x.name === 'Fairway Vista').hasShape);
  assert.strictEqual((await db.one("SELECT source FROM road_shapes WHERE road_id=$1", [ids['Fairway Vista']])).source, 'learned');
  // finding shapes again keeps it
  await O('POST', '/api/admin/drives/shapes/find');
  assert.strictEqual((await db.one("SELECT source FROM road_shapes WHERE road_id=$1", [ids['Fairway Vista']])).source, 'learned');
});

test('untick a GPS tick and it stays unticked; the maps', async () => {
  await scott('POST', '/drives/' + ids['Deer Run'], { done: false });
  const r = await scott('POST', '/drives/trip', { ref: 'trip-aaaaaaaa1', points: drive(36.4, -84.1, -84.095, Date.now() - 10e3), ended: true });
  assert.deepStrictEqual(r.body.ticked, []);
  assert.ok(!r.body.list.roads.find(x => x.name === 'Deer Run').done);
  assert.ok((await db.one('SELECT ended_at FROM drive_trips')).ended_at);
  const m = (await scott('GET', '/drives/map')).body;
  assert.strictEqual(m.roads.length, 3); assert.deepStrictEqual(m.center, [36.4, -84.1]);
  assert.deepStrictEqual(m.route, [], 'the saved track is cleared off the phone map');
  const dash = (await O('GET', '/api/admin/drives/map?day=' + today)).body;
  assert.ok(dash.route.length >= 1, 'the dashboard still has it');
  // a new drive shows only itself on the phone
  await scott('POST', '/drives/trip', { ref: 'trip-bbbbbbbb2', points: drive(36.43, -84.1, -84.099, Date.now() - 5e3) });
  const m2 = (await scott('GET', '/drives/map')).body;
  assert.strictEqual(m2.route.length, 1); assert.ok(m2.route[0].every(p => p[0] > 36.429));
  const a = (await O('GET', '/api/admin/drives/map?day=2026-01-05')).body;
  assert.strictEqual(a.day, '2026-01-05'); assert.deepStrictEqual(a.route, []);
  assert.strictEqual((await O('DELETE', '/api/admin/drives/shapes/' + ids['Fairway Vista'])).body.learned, 0);
});
