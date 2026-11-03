// Owner portal: sign in by address (emailed link, or account number + approval), see only your property,
// usage toward the gallons included, report a problem, notices and documents.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const { migrate } = require('../src/migrate');
const db = require('../src/db');
const { send } = require('../src/email');

let server, base;
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); await db.pool.end(); });

function client() {   // keeps its own cookies (boss or owner)
  let cookie = '';
  const f = async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, redirect: 'manual', headers: { 'x-ch': '1', ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw || (body ? JSON.stringify(body) : undefined) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  };
  f.cookie = () => cookie;
  return f;
}
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const linkIn = m => (/href="https?:\/\/[^/"]+(\/p\/[^"]+\/in\/[^"]+)"/.exec(m.html) || [])[1];

let O, slug, meters;
test('setup: company, members with emails, meters with readings', async () => {
  O = client();
  assert.strictEqual((await O('POST', '/api/signup', { company: 'Deerfield Water', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' })).status, 200);
  slug = (await db.one('SELECT slug FROM companies')).slug;
  await O('POST', '/api/admin/members/import', { columns: ['Status', 'Last name', 'First name(s)', 'Deerfield address', 'Email 1'], rows: [
    { Status: 'Active', 'Last name': 'Meadows', 'First name(s)': 'Pat', 'Deerfield address': '141 Deer Meadow Dr', 'Email 1': 'pat@example.com' },
    { Status: 'Active', 'Last name': 'Tail', 'First name(s)': 'Wendy', 'Deerfield address': '305 Whitetail Lane' }] });
  await O('POST', '/api/admin/meters/import', { meters: [
    { seq: 1, account: '0042', meterNo: 'M1', name: 'Meadows, Pat', address: '141 Deer Meadow Dr', startReading: 1000 },
    { seq: 2, account: 'A-77', meterNo: 'M2', name: 'Tail, Wendy', address: '305 Whitetail Lane', startReading: 500 }] });
  meters = (await O('GET', '/api/admin/meters')).body.meters;
  const q = (await O('GET', '/api/admin/meters')).body.thisQuarter;
  const back = n => { let y = Number(q.slice(0, 4)), k = Number(q.slice(6)) - n; while (k < 1) { k += 4; y--; } return y + '-Q' + k; };
  const c = await db.one('SELECT id FROM companies WHERE slug=$1', [slug]);
  await db.q('INSERT INTO meter_reads (company_id, meter_id, reading, month) VALUES ($1,$2,5000,$3),($1,$2,9000,$4),($1,$2,15500,$5)', [c.id, meters[0].id, back(2), back(1), q]);
  await O('PUT', '/api/admin/billing', { base: '75', allowance: '5000', overRate: '' });
});

test('portal is closed until the boss opens it', async () => {
  const P = client();
  assert.strictEqual((await P('GET', `/api/p/${slug}/addresses?q=141`)).status, 404);
  assert.strictEqual((await fetch(`${base}/p/${slug}/`)).status, 404);
  const r = await O('PUT', '/api/admin/portal', { on: true });
  assert.strictEqual(r.body.on, true);
  assert.strictEqual((await fetch(`${base}/p/${slug}/`)).status, 200);
});

let pat;
test('sign in: type the address, the link goes to the email on file, never shown in full', async () => {
  pat = client();
  const a = (await pat('GET', `/api/p/${slug}/addresses?q=141 deer`)).body.addresses;
  assert.deepStrictEqual(a.map(x => x.address), ['141 Deer Meadow Dr']);
  assert.ok(!JSON.stringify(a).includes('Meadows'), 'addresses only, no names');
  send.outbox.length = 0;
  const r = await pat('POST', `/api/p/${slug}/start`, { meterId: a[0].id });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.sent, true); assert.ok(!r.body.to[0].includes('pat@'), 'masked: ' + r.body.to[0]);
  const m = send.outbox.find(x => x.to.includes('pat@example.com'));
  const path = linkIn(m);
  assert.ok(path, m.html);
  // opening the link (as an email checker would) does not sign in
  let g = await pat('GET', path); assert.strictEqual(g.status, 200); assert.strictEqual((await pat('GET', `/api/p/${slug}/me`)).status, 401);
  g = await pat('GET', path + '?go=1'); assert.strictEqual(g.status, 303);
  assert.ok(pat.cookie().startsWith('ch_portal='));
  // the link works once
  assert.strictEqual((await client()('GET', path + '?go=1')).status, 400);
});

test("home: only their property; usage toward the 5,000 included; high use shows", async () => {
  const h = (await pat('GET', `/api/p/${slug}/me`)).body;
  assert.strictEqual(h.email, 'pat@example.com');
  assert.strictEqual(h.properties.length, 1);
  const p = h.properties[0];
  assert.strictEqual(p.address, '141 Deer Meadow Dr');
  assert.strictEqual(p.current.gallons, 6500);
  assert.strictEqual(h.billing.allowance, 5000);
  assert.deepStrictEqual(p.quarters.map(q => q.gallons), [null, 4000, 6500], 'first reading is the starting point');
  // can't open the other property's things
  const wendyDoc = await O('POST', `/api/admin/portal/docs?title=Plat&meterId=${meters[1].id}`, null, PDF);
  assert.strictEqual(wendyDoc.status, 200, JSON.stringify(wendyDoc.body));
  const d = wendyDoc.body.docs.find(x => x.title === 'Plat');
  assert.strictEqual((await pat('GET', `/api/p/${slug}/docs/${d.id}`)).status, 404);
  assert.strictEqual((await pat('POST', `/api/p/${slug}/report`, { meterId: meters[1].id, title: 'x' })).status, 400);
});

test('documents and notices: community-wide and for their address', async () => {
  let r = await O('POST', '/api/admin/portal/docs?title=Deerfield CCRs', null, PDF);
  assert.strictEqual(r.status, 200);
  r = await O('POST', `/api/admin/portal/docs?title=Where your shutoff is&meterId=${meters[0].id}`, null, PDF);
  assert.strictEqual((await O('POST', '/api/admin/portal/docs?title=Bad', null, Buffer.from('hello'))).status, 400, 'PDF, JPG or PNG only');
  send.outbox.length = 0;
  r = await O('POST', '/api/admin/portal/notices', { kind: 'boil', title: 'Boil water: Deer Meadow', body: 'Until further notice.', email: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.notices[0].emailedTo, 1);
  assert.ok(send.outbox.some(m => m.to.includes('pat@example.com') && /BOIL WATER/.test(m.subject)));
  await O('POST', '/api/admin/portal/notices', { title: 'Old news', starts: '2020-01-01', ends: '2020-01-02' });
  const h = (await pat('GET', `/api/p/${slug}/me`)).body;
  assert.deepStrictEqual(h.notices.map(n => n.title), ['Boil water: Deer Meadow'], 'only current notices');
  assert.deepStrictEqual(h.docs.map(x => x.title), ['Deerfield CCRs']);
  assert.deepStrictEqual(h.properties[0].docs.map(x => x.title), ['Where your shutoff is']);
  const f = await pat('GET', `/api/p/${slug}/docs/${h.docs[0].id}`);
  assert.strictEqual(f.status, 200); assert.strictEqual(f.body.slice(0, 4).toString(), '%PDF');
});

test('report a problem: lands in Leaks & repairs with the address, the boss is emailed, owner sees status', async () => {
  send.outbox.length = 0;
  const r = await pat('POST', `/api/p/${slug}/report`, { meterId: meters[0].id, title: 'Water bubbling by the meter box', details: 'Since Monday', phone: '603-555-0100', photos: [JPEG] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.properties[0].reports[0].status, 'open');
  const t = (await O('GET', '/api/admin/tasks?kind=repair')).body.tasks.find(x => /bubbling/.test(x.title));
  assert.ok(t); assert.strictEqual(t.address, '141 Deer Meadow Dr'); assert.match(t.details, /owner portal/); assert.strictEqual(t.photos.length, 1);
  assert.ok(send.outbox.some(m => m.to.includes('boss@example.com') && /Owner report/.test(m.subject)));
});

test('no email on file: account number + approval; wrong number refused', async () => {
  const w = client();
  const r = await w('POST', `/api/p/${slug}/start`, { meterId: meters[1].id });
  assert.strictEqual(r.body.needAccount, true);
  assert.strictEqual((await w('POST', `/api/p/${slug}/request`, { meterId: meters[1].id, account: '999', name: 'Wendy Tail', email: 'wendy@example.com' })).status, 400);
  send.outbox.length = 0;
  let q = await w('POST', `/api/p/${slug}/request`, { meterId: meters[1].id, account: 'a77', name: 'Wendy Tail', email: 'wendy@example.com' });
  assert.strictEqual(q.status, 200, JSON.stringify(q.body));
  assert.ok(send.outbox.some(m => m.to.includes('boss@example.com') && /asked to sign up/.test(m.subject)));
  let v = (await O('GET', '/api/admin/portal')).body;
  const req = v.requests.find(x => x.email === 'wendy@example.com' && x.status === 'pending');
  assert.ok(req);
  send.outbox.length = 0;
  v = (await O('POST', `/api/admin/portal/requests/${req.id}`, { approve: true })).body;
  const m = send.outbox.find(x => x.to.includes('wendy@example.com'));
  assert.ok(m);
  await w('GET', linkIn(m) + '?go=1');
  const h = (await w('GET', `/api/p/${slug}/me`)).body;
  assert.deepStrictEqual(h.properties.map(p => p.address), ['305 Whitetail Lane']);
  assert.deepStrictEqual(h.properties[0].docs.map(d => d.title), ['Plat']);
  // the boss can take access away
  const u = (await O('GET', '/api/admin/portal')).body.users.find(x => x.email === 'wendy@example.com');
  await O('DELETE', `/api/admin/portal/users/${u.id}`);
  assert.strictEqual((await w('GET', `/api/p/${slug}/me`)).status, 401);
});

test('signing out ends the session; other companies are separate', async () => {
  await pat('POST', `/api/p/${slug}/logout`);
  assert.strictEqual((await pat('GET', `/api/p/${slug}/me`)).status, 401);
  const O2 = client();
  await O2('POST', '/api/signup', { company: 'Other Co', name: 'X', email: 'x@example.com', password: 'LongPass1!' });
  assert.deepStrictEqual((await O2('GET', '/api/admin/portal')).body.users, []);
  assert.strictEqual((await O2('GET', '/api/admin/portal')).body.docs.length, 0);
});

test("can't read a meter: * (with a reason); next quarter's use counts from the last real reading; the base charge still bills", async () => {
  const M = require('../src/meters');
  const c = await db.one('SELECT * FROM companies WHERE slug=$1', [slug]);
  const q = M.quarterOf(c);
  // Wendy's meter: last real reading 500 (start); can't read this quarter
  let r = await O('POST', `/api/admin/meters/${meters[1].id}/read`, { reading: '* buried in mud', quarter: q });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  let d = (await O('GET', '/api/admin/meters')).body;
  const w = d.meters.find(m => m.id === meters[1].id);
  assert.strictEqual(w.cantRead, true); assert.strictEqual(w.current, null); assert.strictEqual(w.readNotes, 'buried in mud'); assert.strictEqual(w.usage, null);
  assert.strictEqual(d.cantRead, 1); assert.strictEqual(w.alert, null);
  // billing: $75 base, no overage, says why
  const b = (await O('GET', '/api/admin/billing')).body;
  const inv = b.invoices.find(i => i.seq === 2);
  assert.ok(inv && inv.cantRead); assert.strictEqual(inv.total, 75); assert.match(inv.lines[0].desc, /couldn't be read/);
  // CSV says Can't read
  assert.match((await O('GET', '/api/admin/meters.csv')).body.toString(), /"Can't read"/);
  // a real reading replaces it
  r = await O('POST', `/api/admin/meters/${meters[1].id}/read`, { reading: '900', quarter: q });
  d = (await O('GET', '/api/admin/meters')).body;
  assert.strictEqual(d.meters.find(m => m.id === meters[1].id).cantRead, false);
  assert.strictEqual(d.meters.find(m => m.id === meters[1].id).usage, 400);
  await O('POST', `/api/admin/meters/${meters[1].id}/read`, { reading: '*', quarter: q });
  // the quarter after a can't-read: previous is the last real reading, not the blank
  const next = (() => { let y = Number(q.slice(0, 4)), k = Number(q.slice(6)) + 1; if (k > 4) { k = 1; y++; } return y + '-Q' + k; })();
  await db.q('INSERT INTO meter_reads (company_id, meter_id, reading, month) VALUES ($1,$2,800,$3)', [c.id, meters[1].id, next]);
  const rt = await M.route(c, next);
  const m2 = rt.meters.find(m => m.id === meters[1].id);
  assert.strictEqual(m2.previous, 500); assert.strictEqual(m2.usage, 300);
  await db.q('DELETE FROM meter_reads WHERE meter_id=$1 AND month=$2', [meters[1].id, next]);
});
