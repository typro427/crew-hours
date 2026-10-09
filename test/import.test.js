// Importing the old Google Sheet: crew, PINs, settings and hours come across; running it twice changes nothing.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const { migrate } = require('../src/migrate');
const db = require('../src/db');
const file = require('./fixtures-deerfield-import.json');

let server, base, cookie = '';
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); await db.pool.end(); });
const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json() };
};

test('import the Deerfield sheet', async () => {
  assert.strictEqual((await call('POST', '/api/signup', { company: 'Deerfield', name: 'Tyler', email: 't@example.com', password: 'LongPass1!', timezone: 'America/New_York' })).status, 200);
  const r = await call('POST', '/api/admin/import', file);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.problems, []);
  assert.strictEqual(r.body.crewAdded, file.crew.length);
  assert.strictEqual(r.body.daysAdded, file.entries.length);
  const me = (await call('GET', '/api/admin/me')).body.settings;
  assert.strictEqual(me.weekStart, 4); assert.strictEqual(me.mainLabel, 'Deerfield Time');
  assert.deepStrictEqual(me.otherOptions, ['Water System', 'McCloud Venue', 'MtCloud Maintenance']);
  for (const e of file.entries) {
    const row = await db.one('SELECT e.hours FROM entries e JOIN crew c ON c.id=e.crew_id WHERE c.name=$1 AND e.day=$2', [e.name, e.date]);
    assert.strictEqual(Number(row.hours), Number(e.sheetHours), e.name + ' hours match the sheet');
  }
  // A crew PIN from the sheet logs in.
  const slug = (await db.one('SELECT slug FROM companies')).slug;
  const p = file.crew[0];
  const login = await fetch(`${base}/api/c/${slug}/login`, { method: 'POST', headers: { 'x-ch': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: p.pin }) }).then(x => x.json());
  assert.strictEqual(login.name, p.name);
});

test('importing again adds nothing', async () => {
  const r = await call('POST', '/api/admin/import', file);
  assert.strictEqual(r.body.crewAdded, 0); assert.strictEqual(r.body.daysAdded, 0);
  assert.strictEqual(r.body.daysSkipped, file.entries.length);
});
