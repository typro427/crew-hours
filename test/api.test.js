// End-to-end API tests against a real Postgres. Run: DATABASE_URL=... npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
process.env.DISABLE_SCHEDULER = '1';
const { app } = require('../src/server');
const { migrate } = require('../src/migrate');
const db = require('../src/db');
const T = require('../src/time');
const H = require('../src/hours');
const { send } = require('../src/email');
const scheduler = require('../src/scheduler');

let server, base;
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); await db.pool.end(); });

// A tiny browser: keeps the owner cookie.
function client() {
  let cookie = '';
  return async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, { method, redirect: 'manual',
      headers: { 'x-ch': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch (e) { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}
const crewCall = (slug, token) => (method, path, body) => fetch(`${base}/api/c/${slug}${path}`, { method,
  headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));

let A, B, slugA, slugB, todayA;

test('sign up two companies; duplicate email refused; weak password refused', async () => {
  A = client(); B = client();
  let r = await A('POST', '/api/signup', { company: 'Deerfield Water & Venue', name: 'Tyler', email: 'tyler@example.com', password: 'longpassword1', timezone: 'America/New_York' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await B('POST', '/api/signup', { company: 'Other Co', name: 'Sam', email: 'sam@example.com', password: 'anotherpass2' });
  assert.strictEqual(r.status, 200);
  r = await client()('POST', '/api/signup', { company: 'X', name: 'X', email: 'TYLER@example.com', password: 'whatever123' });
  assert.match(r.body.error, /already has an account/);
  r = await client()('POST', '/api/signup', { company: 'X', name: 'X', email: 'new@example.com', password: 'short' });
  assert.match(r.body.error, /at least 8/);
  const meA = (await A('GET', '/api/admin/me')).body, meB = (await B('GET', '/api/admin/me')).body;
  slugA = meA.settings.slug; slugB = meB.settings.slug; todayA = meA.today;
  assert.strictEqual(slugA, 'deerfield-water-venue');
  assert.strictEqual(meA.billing.status, 'trialing');
  assert.ok(meA.billing.trialDaysLeft >= 13);
});

test('requests without our header are blocked (cross-site protection)', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403);
});

test('settings: Thursday week, custom labels and job list', async () => {
  const r = await A('PUT', '/api/admin/settings', { weekStart: 4, mainLabel: 'Deerfield Time', otherLabel: 'Other time',
    otherOptions: ['Water System', 'McCloud Venue', 'MtCloud Maintenance'], workdays: [4, 5, 1, 2, 3] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.settings.weekStart, 4);
  const bad = await A('PUT', '/api/admin/settings', { otherOptions: ['A', 'a'] });
  assert.match(bad.body.error, /different/);
  const tz = await A('PUT', '/api/admin/settings', { timezone: 'Mars/Base' });
  assert.match(tz.body.error, /time zone/);
});

test('crew: add, duplicate PIN refused, PIN not stored in plain text', async () => {
  let r = await A('POST', '/api/admin/crew', { name: 'Jake', pin: '6532' });
  assert.strictEqual(r.status, 200);
  await A('POST', '/api/admin/crew', { name: 'JT', pin: '2654' });
  await A('POST', '/api/admin/crew', { name: 'Tyler', pin: '1111', manager: true });
  r = await A('POST', '/api/admin/crew', { name: 'Copy', pin: '6532' });
  assert.match(r.body.error, /already uses that PIN/);
  // the same PIN is fine in a different company
  r = await B('POST', '/api/admin/crew', { name: 'Bea', pin: '6532' });
  assert.strictEqual(r.status, 200);
  const rows = await db.q('SELECT pin_hmac FROM crew');
  assert.ok(rows.every(x => x.pin_hmac.length === 64 && !x.pin_hmac.includes('6532')));
});

let jakeTok, mgrTok, beaTok;
test('crew login with PIN: wrong PIN refused, right PIN works, per company', async () => {
  let r = await crewCall(slugA)('POST', '/login', { pin: '9999' });
  assert.strictEqual(r.status, 400);
  r = await crewCall(slugA)('POST', '/login', { pin: '6532' });
  assert.strictEqual(r.body.name, 'Jake'); jakeTok = r.body.token;
  assert.strictEqual(r.body.settings.mainLabel, 'Deerfield Time');
  r = await crewCall(slugB)('POST', '/login', { pin: '6532' });
  assert.strictEqual(r.body.name, 'Bea'); beaTok = r.body.token;
  r = await crewCall(slugA)('POST', '/login', { pin: '1111' });
  assert.strictEqual(r.body.manager, true); mgrTok = r.body.token;
});

test('save as you go: start only, clocked out, then finish', async () => {
  const c = crewCall(slugA, jakeTok), d = todayA;
  let r = await c('POST', '/day', { date: d, work: { start: '07:00' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.days[d].open, true); assert.strictEqual(r.body.days[d].total, 0);
  r = await c('POST', '/day', { date: d, work: { start: '07:00', out: '11:00' } });
  assert.strictEqual(r.body.days[d].outT, '11:00');
  r = await c('POST', '/day', { date: d, work: { start: '07:00', out: '11:00', back: '12:30', end: '15:30' } });
  assert.match(r.body.error, /summary/);
  r = await c('POST', '/day', { date: d, work: { start: '07:00', out: '11:00', back: '12:30', end: '15:30', summary: 'Framed walls' },
                                other: { job: 'Water System', start: '16:00', end: '18:00', out: '16:30', back: '17:00' } });
  assert.strictEqual(r.body.days[d].hours, 7); assert.strictEqual(r.body.days[d].oHours, 1.5); assert.strictEqual(r.body.days[d].total, 8.5);
  r = await c('POST', '/day', { date: d, other: { job: 'Not a real job', start: '16:00', end: '18:00' } });
  assert.match(r.body.error, /from the list/);
  r = await c('POST', '/day', { date: T.shift(d, 1), work: { start: '07:00' } });
  assert.match(r.body.error, /hasn't happened yet/);
});

test('privacy: crew see only themselves; companies never see each other', async () => {
  // Jake cannot open the boss screen
  let r = await crewCall(slugA, jakeTok)('GET', '/crew-week');
  assert.strictEqual(r.status, 403);
  // Bea's token does not work on company A's link
  r = await crewCall(slugA, beaTok)('GET', '/week');
  assert.strictEqual(r.status, 401);
  // Company B's owner sees none of A's crew or hours
  const wb = (await B('GET', '/api/admin/week')).body;
  assert.deepStrictEqual(wb.people.map(p => p.name), ['Bea']);
  const crewB = (await B('GET', '/api/admin/crew')).body.crew;
  assert.deepStrictEqual(crewB.map(c => c.name), ['Bea']);
  // B cannot edit A's crew member by guessing the id
  const jakeId = (await A('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'Jake').id;
  r = await B('PUT', '/api/admin/crew/' + jakeId, { name: 'hacked' });
  assert.strictEqual(r.status, 404);
  // B's CSV export has no A rows
  const csv = (await B('GET', '/api/admin/export.csv')).body;
  assert.ok(!String(csv).includes('Jake'));
  // logged out = no dashboard
  r = await client()('GET', '/api/admin/me');
  assert.strictEqual(r.status, 401);
});

test('manager sees the crew week and can approve; approved week is locked', async () => {
  const m = crewCall(slugA, mgrTok);
  let r = await m('GET', '/crew-week');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.people.some(p => p.name === 'Jake' && p.total === 8.5));
  assert.ok(!r.body.people.some(p => p.name === 'Tyler'), 'managers with no hours are left out');
  r = await m('POST', '/approve', { weekStart: r.body.weekStart, approved: true });
  assert.strictEqual(r.body.approved, true);
  r = await crewCall(slugA, jakeTok)('POST', '/day', { date: todayA, work: { start: '06:00', end: '14:00', summary: 'x' } });
  assert.match(r.body.error, /locked/);
  r = await crewCall(slugA, jakeTok)('GET', '/week');
  assert.strictEqual(r.body.locked, true);
  r = await A('POST', '/api/admin/approve', { weekStart: todayA, approved: false });
  assert.strictEqual(r.body.approved, false);
});

test('turning a crew member off signs them out', async () => {
  const jt = (await crewCall(slugA)('POST', '/login', { pin: '2654' })).body.token;
  const id = (await A('GET', '/api/admin/crew')).body.crew.find(c => c.name === 'JT').id;
  await A('PUT', '/api/admin/crew/' + id, { active: false });
  let r = await crewCall(slugA, jt)('GET', '/week');
  assert.strictEqual(r.status, 401);
  r = await crewCall(slugA)('POST', '/login', { pin: '2654' });
  assert.strictEqual(r.status, 400);
  await A('PUT', '/api/admin/crew/' + id, { active: true });
});

test('CSV export has the hours and blocks spreadsheet formulas', async () => {
  await A('POST', '/api/admin/approve', { weekStart: todayA, approved: false });
  await crewCall(slugA, jakeTok)('POST', '/day', { date: todayA, work: { start: '07:00', end: '15:00', summary: '=HYPERLINK("x")' } });
  const r = await A('GET', '/api/admin/export.csv');
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.ok(String(r.body).includes(`"'=HYPERLINK(""x"")"`), r.body);
});

test('trial over and no subscription: crew app pauses, dashboard still opens', async () => {
  await db.q("UPDATE companies SET trial_ends_at = now() - interval '1 day' WHERE slug=$1", [slugB]);
  let r = await crewCall(slugB, beaTok)('GET', '/week');
  assert.strictEqual(r.status, 402);
  r = await B('GET', '/api/admin/me');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.billing.ok, false);
  const billing = require('../src/routes/billing');
  const co = await db.one('SELECT id FROM companies WHERE slug=$1', [slugB]);
  await billing.applySubscription({ id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { company_id: String(co.id) } });
  r = await crewCall(slugB, beaTok)('GET', '/week');
  assert.strictEqual(r.status, 200);
  await billing.applySubscription({ id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { company_id: String(co.id) } });
  r = await crewCall(slugB, beaTok)('GET', '/week');
  assert.strictEqual(r.status, 402);
});

test('scheduled emails go out once, in the company time zone', async () => {
  send.outbox.length = 0;
  const c = await db.one('SELECT * FROM companies WHERE slug=$1', [slugA]);
  // pick the next Thursday (week start for A) at 8 AM New York time
  let d = todayA; while (T.dow(d) !== 4) d = T.shift(d, 1);
  const thu8 = new Date(d + 'T12:00:00Z');                  // 8 AM EDT / 7 AM EST
  await scheduler.tick(thu8); await scheduler.tick(thu8);
  const weekly = send.outbox.filter(m => /^Crew hours:/.test(m.subject));
  assert.strictEqual(weekly.length, 1);
  assert.deepStrictEqual(weekly[0].to, ['tyler@example.com']);
  const wed7 = new Date(T.shift(d, -1) + 'T23:00:00Z');     // Wednesday 7 PM EDT
  await scheduler.tick(wed7);
  const miss = send.outbox.filter(m => /Missing hours|Hours check/.test(m.subject));
  assert.strictEqual(miss.length, 1);
  assert.ok(!send.outbox.some(m => m.to.includes('sam@example.com')), 'canceled company gets nothing');
});

test('password reset flow', async () => {
  send.outbox.length = 0;
  await client()('POST', '/api/forgot', { email: 'tyler@example.com' });
  const mail = send.outbox.find(m => /Reset/.test(m.subject));
  const token = /reset#([\w-]+)/.exec(mail.html)[1];
  const c = client();
  let r = await c('POST', '/api/reset', { token, password: 'brandnewpass9' });
  assert.strictEqual(r.status, 200);
  r = await c('POST', '/api/reset', { token, password: 'again12345' });
  assert.match(r.body.error, /expired/);
  r = await client()('POST', '/api/login', { email: 'tyler@example.com', password: 'brandnewpass9' });
  assert.strictEqual(r.status, 200);
});

test('pages load', async () => {
  for (const p of ['/', '/signup', '/login', '/admin', '/c/' + slugA + '/', '/c/' + slugA + '/manifest.webmanifest']) {
    const r = await fetch(base + p); assert.strictEqual(r.status, 200, p);
  }
  const html = await (await fetch(base + '/c/' + slugA + '/')).text();
  assert.ok(html.includes('Deerfield Water &amp; Venue'));
  assert.strictEqual((await fetch(base + '/c/nope/')).status, 404);
});
