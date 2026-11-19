// Gate log: a guard (hours + members + gate) checks cars in with an address from the Members list, the type of visit,
// a tag photo and a vehicle description; the boss sees and searches the log. Made-up names and places only.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const db = require('../src/db');

const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
let server, base, O, slug, guard, worker, guardId;
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), type: ct };
  };
  await O('POST', '/api/signup', { company: 'Deerfield', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' });
  slug = (await db.one('SELECT slug FROM companies')).slug;
  await O('POST', '/api/admin/crew', { name: 'Gary Guard', pin: '4444' });
  await O('POST', '/api/admin/crew', { name: 'Jake', pin: '1111' });
  guardId = (await db.one("SELECT id FROM crew WHERE name='Gary Guard'")).id;
  const set = await O('PUT', '/api/admin/crew/' + guardId, { features: { hours: true, members: true, gate: true, tasks: false, roads: false, w_sites: false, w_repairs: false, w_meters: false } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  await O('POST', '/api/admin/members/import', {
    columns: ['Deerfield address', 'First name(s)', 'Last name', 'Status'],
    rows: [
      { 'Deerfield address': '141 Deer Run Pt', 'First name(s)': 'Sam', 'Last name': 'Sample', Status: 'Active' },
      { 'Deerfield address': '470 Deerfield Landing', 'First name(s)': 'Pat', 'Last name': 'Example', Status: 'Active' },
      { 'Deerfield address': '9 Elk Ridge', 'First name(s)': 'Old', 'Last name': 'Owner', Status: 'Inactive / sold' }]
  });
  const crew = tok => async (method, path, body) => {
    const r = await fetch(`${base}/api/c/${slug}${path}`, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.headers.get('content-type').includes('json') ? await r.json() : null, type: r.headers.get('content-type') };
  };
  const login = async pin => (await crew()('POST', '/login', { pin })).body;
  const g = await login('4444');
  assert.equal(g.features.gate, true); assert.equal(g.features.members, true); assert.equal(g.features.tasks, false);
  guard = crew(g.token); worker = crew((await login('1111')).token);
});
after(async () => { server.close(); await db.pool.end(); });

test('only guards get the gate; they see the address list (active members) and check cars in', async () => {
  assert.equal((await worker('GET', '/gate')).status, 403, 'off unless switched on');
  const g = (await guard('GET', '/gate')).body;
  assert.deepEqual(g.addresses.map(a => a.address).sort(), ['141 Deer Run Pt', '470 Deerfield Landing']);
  assert.equal(g.addresses.find(a => a.address === '141 Deer Run Pt').owner, 'Sam Sample');
  assert.equal(g.entries.length, 0);
  assert.ok(g.kinds.marina);

  const m = g.addresses.find(a => a.address === '141 Deer Run Pt');
  assert.equal((await guard('POST', '/gate', { address: '', kinds: ['visitor'] })).status, 400);
  assert.equal((await guard('POST', '/gate', { address: '141 Deer Run Pt', kinds: [] })).status, 400, 'needs a type');
  assert.equal((await guard('POST', '/gate', { address: '141 Deer Run Pt', kinds: ['visitor'], photo: 'data:image/png;base64,AAAA' })).status, 400, 'not a picture');
  const r = await guard('POST', '/gate', { address: '141 Deer Run Pt', member_id: m.id, kinds: ['renter', 'visitor', 'bogus'], description: 'Silver Ford F-150, TN ABC 123', photo: PNG, clientRef: 'g1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = r.body.entries[0];
  assert.deepEqual(e.kinds, ['renter', 'visitor']);
  assert.deepEqual(e.kindLabels, ['Renter', 'Visitor']);
  assert.equal(e.owner, 'Sam Sample'); assert.equal(e.guard, 'Gary Guard'); assert.equal(e.photo, true);
  // sent twice from the phone's outbox: kept once
  await guard('POST', '/gate', { address: '141 Deer Run Pt', member_id: m.id, kinds: ['renter'], clientRef: 'g1' });
  // an address not on the list, saved with no signal earlier
  const earlier = new Date(Date.now() - 3600e3).toISOString();
  const r2 = await guard('POST', '/gate', { address: 'Marina boat ramp', kinds: ['marina'], description: 'Blue Jeep with trailer', clientRef: 'g2', at: earlier });
  assert.equal(r2.body.entries.length, 2);
  assert.equal(r2.body.entries[1].address, 'Marina boat ramp');
  assert.equal(new Date(r2.body.entries[1].at).toISOString(), earlier);
  assert.equal(r2.body.entries[1].owner, '');

  const ph = await guard('GET', '/gate/photo/' + e.id);
  assert.equal(ph.status, 200); assert.equal(ph.type, 'image/png');
});

test('the boss sees, filters, downloads and deletes the gate log', async () => {
  let L = (await O('GET', '/api/admin/gate')).body;
  assert.equal(L.entries.length, 2);
  assert.equal((await O('GET', '/api/admin/gate?kind=marina')).body.entries.length, 1);
  assert.equal((await O('GET', '/api/admin/gate?q=ford')).body.entries.length, 1);
  assert.equal((await O('GET', '/api/admin/gate?q=sample')).body.entries[0].address, '141 Deer Run Pt');
  assert.equal((await O('GET', '/api/admin/gate?from=2001-01-01&to=2001-01-02')).body.entries.length, 0);
  const csv = await O('GET', '/api/admin/gate.csv');
  assert.match(csv.type, /text\/csv/);
  assert.match(csv.body, /"Date & time","Address","Owner","Type","Vehicle","Guard","Tag photo"/);
  assert.match(csv.body, /"141 Deer Run Pt","Sam Sample","Renter, Visitor","Silver Ford F-150, TN ABC 123","Gary Guard","Yes"/);
  const p = await fetch(base + '/api/admin/gate/photo/' + L.entries.find(x => x.photo).id, { headers: { Cookie: '' } });
  assert.notEqual(p.status, 200, 'photos need the boss login');
  await O('DELETE', '/api/admin/gate/' + L.entries[0].id);
  L = (await O('GET', '/api/admin/gate')).body;
  assert.equal(L.entries.length, 1);
});
