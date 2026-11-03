// Board report: a month of what the crew did with photos; the boss adds notes and leaves things out;
// the board's private link shows only what's included; a new link replaces the old one; emailing the board.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const db = require('../src/db');
const { send } = require('../src/email');

let server, base, O, slug, jake;
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
  };
  await O('POST', '/api/signup', { company: 'Deerfield Water', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' });
  slug = (await db.one('SELECT slug FROM companies')).slug;
  await O('POST', '/api/admin/crew', { name: 'Jake', pin: '1111' });
  jake = async (method, path, body) => {
    const r = await fetch(`${base}/api/c/${slug}${path}`, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(jake.t ? { Authorization: 'Bearer ' + jake.t } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  jake.t = (await jake('POST', '/login', { pin: '1111' })).body.token;
});
after(async () => { server.close(); await db.pool.end(); });

const L = u => base + new URL(u).pathname;   // the link is on the app's address
const month = async () => (await O('GET', '/api/admin/board?kind=month&start=' + (await jake('GET', '/week')).body.today.slice(0, 7))).body;

test("the month's work comes together with its photos", async () => {
  const today = (await jake('GET', '/week')).body.today;
  // a leak fixed with photos and a progress note
  await O('POST', '/api/admin/tasks', { kind: 'repair', title: 'Main break on Deerfield Way', priority: 'urgent', address: '600 Deerfield Way' });
  const leak = (await db.one("SELECT id FROM tasks WHERE kind='repair'")).id;
  assert.strictEqual((await jake('POST', `/tasks/${leak}/progress`, { notes: 'Dug it out, waiting on the coupling', photos: [JPEG] })).status, 200);
  assert.strictEqual((await jake('POST', `/tasks/${leak}/done`, { notes: 'New coupling in, water back on.', photos: [JPEG] })).status, 200);
  await O('POST', '/api/admin/tasks', { kind: 'repair', title: 'Slow drip at the pool', priority: 'high' });
  await O('POST', '/api/admin/tasks', { title: 'Clean the shop' });
  const task = (await db.one("SELECT id FROM tasks WHERE title='Clean the shop'")).id;
  await jake('POST', `/tasks/${task}/done`, { notes: 'Swept and organized' });
  // a day with photos
  await jake('POST', '/day', { date: today, work: { start: '08:00', end: '14:00', summary: 'Cleared the ditch on Skyline' } });
  await jake('POST', `/day/${today}/photos`, { photos: [JPEG] });

  const d = await month();
  assert.match(d.label, /^[A-Z][a-z]+ \d{4}$/);
  const sec = k => d.sections.find(s => s.key === k);
  const fixed = sec('repairs').items[0];
  assert.strictEqual(fixed.title, 'Main break on Deerfield Way'); assert.strictEqual(fixed.priority, 'urgent');
  assert.strictEqual(fixed.photos.length, 2, 'the progress photo and the done photo');
  assert.match(fixed.text, /New coupling in/); assert.match(fixed.text, /Jake: Dug it out/);
  assert.match(fixed.sub, /600 Deerfield Way · Fixed .* by Jake/);
  assert.deepStrictEqual(sec('open').list.map(i => i.title), ['Slow drip at the pool']);
  assert.strictEqual(sec('tasks').items[0].title, 'Clean the shop');
  assert.strictEqual(sec('days').items[0].text, 'Cleared the ditch on Skyline');
  assert.strictEqual(sec('hours').list[0].sub, '6.00 h');
  assert.ok(d.summary.find(t => t.label === 'Crew hours' && t.value === '6'));
  assert.match(d.summary.find(t => t.label === 'Leaks & repairs fixed').value, /^1 <small>of 2 reported/);
  // the boss's photo view
  const img = await fetch(base + '/api/admin/board/photo/' + fixed.photos[0]);
  assert.strictEqual(img.status, 401, 'needs the boss signed in');
});

test('notes and leaving things out; the board link shows only what is included', async () => {
  let d = await month();
  const fixed = d.sections.find(s => s.key === 'repairs').items[0];
  const r = await O('PUT', '/api/admin/board', { from: d.from, to: d.to, intro: 'A busy month.', notes: { [fixed.key]: 'Biggest job this year.' }, hidden: [fixed.photos[0], 'tasks', 'bad key!'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.hidden, [fixed.photos[0], 'tasks']);
  d = await month();
  assert.strictEqual(d.intro, 'A busy month.');
  const page = await fetch(L(d.link)); const html = await page.text();
  assert.strictEqual(page.status, 200);
  assert.match(html, /A busy month\./); assert.match(html, /Biggest job this year\./); assert.match(html, /Main break on Deerfield Way/);
  assert.doesNotMatch(html, /Clean the shop/, 'section left out');
  assert.ok(!html.includes('/photo/' + fixed.photos[0] + '"'), 'photo left out');
  assert.ok(html.includes('/photo/' + fixed.photos[1] + '"'));
  const tok = d.link.split('/board/')[1];
  assert.strictEqual((await fetch(`${base}/board/${tok}/photo/${fixed.photos[1]}`)).status, 200);
  assert.strictEqual((await fetch(`${base}/board/${tok}/photo/${fixed.photos[0]}`)).status, 404, 'left-out photo not shown');
  const other = (await db.one('SELECT id FROM day_photos')).id;
  await O('PUT', '/api/admin/board', { from: d.from, to: d.to, hidden: [fixed.photos[0], 'tasks', 'days'] });
  assert.strictEqual((await fetch(`${base}/board/${tok}/photo/dp${other}`)).status, 404, 'only photos in the report');
  assert.strictEqual((await fetch(`${base}/board/nope-not-a-real-token-123`)).status, 404);
  // a new link: the old one stops working
  const nl = (await O('POST', '/api/admin/board/link', { from: d.from, to: d.to })).body.link;
  assert.notStrictEqual(nl, d.link);
  assert.strictEqual((await fetch(L(d.link))).status, 404);
  assert.strictEqual((await fetch(L(nl))).status, 200);
});

test('email the board: the numbers, a few photos and the link; addresses are remembered', async () => {
  const d = await month();
  assert.strictEqual((await O('POST', '/api/admin/board/email', { from: d.from, to: d.to, emails: 'not-an-email' })).status, 400);
  send.outbox.length = 0;
  const r = await O('POST', '/api/admin/board/email', { from: d.from, to: d.to, emails: 'chair@example.com, treasurer@example.com' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const m = send.outbox[0];
  assert.deepStrictEqual(m.to, ['chair@example.com', 'treasurer@example.com']);
  assert.match(m.subject, /Deerfield Water board report/);
  assert.ok(m.html.includes(d.link)); assert.match(m.html, /Leaks &amp; repairs fixed:<\/b> 1 \(of 2 reported\)/);
  assert.match(m.html, /\/photo\/tp\d+/);
  const again = await month();
  assert.strictEqual(again.boardEmails, 'chair@example.com, treasurer@example.com'); assert.ok(again.sentAt);
});

test('weeks follow the company week; a report can be at most about 3 months', async () => {
  const w = (await O('GET', '/api/admin/board?kind=week&start=2026-10-29')).body;
  assert.strictEqual(w.from, '2026-10-26'); assert.strictEqual(w.to, '2026-11-01');   // Monday start
  assert.strictEqual((await O('GET', '/api/admin/board?from=2026-01-01&to=2026-12-31')).status, 400);
});
