// Google Drive backup, with Google itself stubbed out: connect, nightly backup, only new photos, disconnect.
process.env.DISABLE_SCHEDULER = '1';
process.env.GOOGLE_CLIENT_ID = 'test-client'; process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const realFetch = global.fetch;
const calls = [];
let folderSeq = 0;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (!/googleapis\.com|accounts\.google\.com/.test(url)) return realFetch(url, opts);
  calls.push({ url, method: opts.method || 'GET', body: opts.body });
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(String(opts.body));
    if (p.get('grant_type') === 'authorization_code') {
      const idt = 'x.' + Buffer.from(JSON.stringify({ email: 'tyler@example.com' })).toString('base64url') + '.y';
      return json({ access_token: 'at1', refresh_token: 'rt-secret-123', id_token: idt });
    }
    return json({ access_token: 'at2' });
  }
  if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
  if (url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && opts.method === 'POST') return json({ id: 'folder' + (++folderSeq) });
  if (/drive\/v3\/files\/folder\d+\?fields=id,trashed/.test(url)) return json({ id: 'x', trashed: false });
  if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) return json({ id: 'file' + calls.length });
  if (url.startsWith('https://www.googleapis.com/drive/v3/files?q=')) return json({ files: [] });
  return json({ error: { message: 'unexpected ' + url } }, 500);
};
const { app } = require('../src/server');
const { migrate } = require('../src/migrate');
const db = require('../src/db');
const sched = require('../src/scheduler');

let server, base, cookie = '';
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate();
  await new Promise(ok => { server = app.listen(0, ok); }); base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); await db.pool.end(); global.fetch = realFetch; });
const call = async (method, url, body) => {
  const r = await realFetch(base + url, { method, redirect: 'manual', headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { status: r.status, body: j, location: r.headers.get('location') };
};
const uploads = () => calls.filter(c => c.url.startsWith('https://www.googleapis.com/upload/'));
const uploadName = c => /"name":"([^"]+)"/.exec(c.body.toString('latin1'))[1];

test('connect, back up records and photos, only new photos next time, disconnect', async () => {
  assert.strictEqual((await call('POST', '/api/signup', { company: 'Deerfield', name: 'Tyler', email: 't@example.com', password: 'LongPass1!' })).status, 200);
  let r = await call('GET', '/api/admin/me');
  assert.deepStrictEqual([r.body.gdrive.available, r.body.gdrive.connected], [true, false]);
  r = await call('GET', '/api/admin/google/connect');
  assert.strictEqual(r.status, 302); assert.match(r.location, /^https:\/\/accounts\.google\.com\/.*scope=openid\+email\+https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fdrive\.file/);
  const state = new URL(r.location).searchParams.get('state');
  // a forged or swapped state is refused
  r = await call('GET', '/api/admin/google/callback?code=abc&state=' + encodeURIComponent(state.replace(/.$/, c => c === '0' ? '1' : '0')));
  assert.match(r.location, /#gdrive-error=/);
  r = await call('GET', '/api/admin/google/callback?code=abc&state=' + encodeURIComponent(state));
  assert.strictEqual(r.location, '/admin#gdrive-ok');
  await new Promise(ok => setTimeout(ok, 300));   // first backup runs in the background
  const row = await db.one('SELECT gdrive_token, gdrive_email, gdrive_last_at FROM companies');
  assert.strictEqual(row.gdrive_email, 'tyler@example.com');
  assert.ok(!row.gdrive_token.includes('rt-secret-123'), 'refresh token is encrypted at rest');
  assert.ok(row.gdrive_last_at, 'first backup ran');
  assert.ok(uploads().some(c => /crewhours-backup-\d{4}-\d{2}-\d{2}\.json/.test(uploadName(c))));
  // add a task photo, back up now: one new photo
  const cid = (await db.one('SELECT id FROM companies')).id;
  const t = await db.one("INSERT INTO tasks (company_id, title) VALUES ($1, 'Fix leak') RETURNING id", [cid]);
  await db.q("INSERT INTO task_photos (task_id, company_id, mime, data) VALUES ($1,$2,'image/jpeg',$3)", [t.id, cid, Buffer.from([0xff, 0xd8, 0xff, 1, 2])]);
  calls.length = 0;
  r = await call('POST', '/api/admin/google/backup');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.photos, 1);
  assert.ok(uploads().some(c => /^task-\d+-Fix-leak-\d+\.jpg$/.test(uploadName(c))));
  const dump = uploads().find(c => /\.json$/.test(uploadName(c))).body.toString();
  assert.match(dump, /"tasks":\[/); assert.match(dump, /Fix leak/);
  for (const k of ['"report_emails"', '"workdays"', '"other_enabled"', '"summary_hour"', '"member_columns"', '"meterReads"', '"roadChecks"', '"readings"']) assert.ok(dump.includes(k), k); assert.doesNotMatch(dump, /password_hash|pin_hmac|gdrive_token/, 'no secrets in the backup file');
  calls.length = 0;
  r = await call('POST', '/api/admin/google/backup');
  assert.strictEqual(r.body.photos, 0, 'photos are only copied once');
  // nightly: once per day
  await db.q("UPDATE companies SET timezone='UTC'"); await db.q("DELETE FROM email_log");
  calls.length = 0;
  const at3am = new Date(); at3am.setUTCHours(3, 0, 0, 0);
  await sched.tick(at3am); await sched.tick(at3am); await new Promise(ok => setTimeout(ok, 300));
  assert.strictEqual(uploads().filter(c => /\.json$/.test(uploadName(c))).length, 1, 'one nightly backup');
  // disconnect
  r = await call('POST', '/api/admin/google/disconnect');
  assert.ok(calls.some(c => c.url.startsWith('https://oauth2.googleapis.com/revoke')));
  assert.strictEqual((await db.one('SELECT gdrive_token FROM companies')).gdrive_token, null);
  assert.strictEqual((await call('POST', '/api/admin/google/backup')).status, 502);
});
