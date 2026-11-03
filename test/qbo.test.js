// QuickBooks Online connection, against a pretend Intuit: connect, match customers to meters, owners see
// their balance / invoices / payments, invoice PDFs only for their own customer, token rotation, disconnect.
const http = require('http');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

// ---- pretend Intuit ----
const intuit = { refresh: 0, calls: [], minor: new Set(), bad: 0 };
const CUSTOMERS = [
  { Id: '11', DisplayName: 'Meadows, Pat', Balance: 75, Active: true },
  { Id: '12', DisplayName: 'Wendy Tail', Balance: 0, Active: true },
  { Id: '13', DisplayName: 'Somebody Else', Balance: 150, Active: true }];
const INVOICES = [
  { Id: '501', DocNumber: 'W26Q3-0001', TxnDate: '2026-07-01', DueDate: '2026-07-31', TotalAmt: 75, Balance: 0, CustomerRef: { value: '11' } },
  { Id: '502', DocNumber: 'W26Q4-0001', TxnDate: '2026-10-01', DueDate: '2099-10-31', TotalAmt: 75, Balance: 75, CustomerRef: { value: '11' } },
  { Id: '601', DocNumber: 'W26Q4-0003', TxnDate: '2026-10-01', DueDate: '2026-10-31', TotalAmt: 150, Balance: 150, CustomerRef: { value: '13' } }];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    intuit.calls.push(u.pathname);
    if (u.pathname === '/token') {
      if (req.headers.authorization !== 'Basic ' + Buffer.from('cid:secret').toString('base64')) return json(401, { error: 'invalid_client' });
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good') return json(400, { error: 'invalid_grant' });
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') !== 'r' + intuit.refresh) return json(400, { error: 'invalid_grant' });
      intuit.refresh++;
      return json(200, { access_token: 'a' + intuit.refresh, refresh_token: 'r' + intuit.refresh, expires_in: 3600, x_refresh_token_expires_in: 8726400 });
    }
    if (u.pathname === '/revoke') return json(200, {});
    if (!u.pathname.startsWith('/v3/company/123/')) return json(404, {});
    if (req.headers.authorization !== 'Bearer a' + intuit.refresh) { intuit.bad++; return json(401, { Fault: { type: 'AUTHENTICATION' } }); }
    intuit.minor.add(u.searchParams.get('minorversion'));
    if (u.pathname === '/v3/company/123/companyinfo/123') return json(200, { CompanyInfo: { CompanyName: 'Deerfield Water QB' } });
    const pdf = /^\/v3\/company\/123\/invoice\/(\d+)\/pdf$/.exec(u.pathname);
    if (pdf) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end('%PDF-1.4 invoice ' + pdf[1]); }
    if (u.pathname === '/v3/company/123/query') {
      const q = u.searchParams.get('query');
      let m;
      if (/FROM Customer STARTPOSITION/.test(q)) return json(200, { QueryResponse: { Customer: CUSTOMERS } });
      if ((m = /FROM Customer WHERE Id = '(\d+)'/.exec(q))) return json(200, { QueryResponse: { Customer: CUSTOMERS.filter(c => c.Id === m[1]) } });
      if ((m = /FROM Invoice WHERE CustomerRef = '(\d+)'/.exec(q))) return json(200, { QueryResponse: { Invoice: INVOICES.filter(i => i.CustomerRef.value === m[1]).reverse() } });
      if ((m = /FROM Invoice WHERE Id = '(\d+)'/.exec(q))) return json(200, { QueryResponse: { Invoice: INVOICES.filter(i => i.Id === m[1]) } });
      if ((m = /FROM Payment WHERE CustomerRef = '(\d+)'/.exec(q))) return json(200, { QueryResponse: m[1] === '11' ? { Payment: [{ Id: '9', TxnDate: '2026-07-15', TotalAmt: 75 }] } : {} });
    }
    json(400, { Fault: { Error: [{ Message: 'unexpected ' + u.pathname }] } });
  });
});

let server, base, db, send;
before(async () => {
  await new Promise(ok => mock.listen(0, ok));
  const m = 'http://127.0.0.1:' + mock.address().port;
  Object.assign(process.env, { DISABLE_SCHEDULER: '1', QBO_CLIENT_ID: 'cid', QBO_CLIENT_SECRET: 'secret', QBO_AUTH_URL: m + '/auth', QBO_TOKEN_URL: m + '/token', QBO_REVOKE_URL: m + '/revoke', QBO_API_BASE: m });
  const { app } = require('../src/server');
  db = require('../src/db'); send = require('../src/email').send;
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.close(); mock.close(); await db.pool.end(); });

function client() {
  let cookie = '';
  const f = async (method, url, body) => {
    const r = await fetch(base + url, { method, redirect: 'manual', headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), location: r.headers.get('location') };
  };
  return f;
}

let O, slug, meters, owner;
test('setup: company, meters with QuickBooks names, an owner signed in to 141 Deer Meadow', async () => {
  O = client();
  await O('POST', '/api/signup', { company: 'Deerfield Water', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' });
  slug = (await db.one('SELECT slug FROM companies')).slug;
  await O('POST', '/api/admin/members/import', { columns: ['Status', 'Last name', 'First name(s)', 'Deerfield address', 'Email 1'], rows: [
    { Status: 'Active', 'Last name': 'Meadows', 'First name(s)': 'Pat', 'Deerfield address': '141 Deer Meadow Dr', 'Email 1': 'pat@example.com' }] });
  await O('POST', '/api/admin/meters/import', { meters: [
    { seq: 1, account: '1', meterNo: 'M1', name: 'Meadows, Pat', qbCustomer: 'Meadows, Pat', address: '141 Deer Meadow Dr', startReading: 0 },
    { seq: 2, account: '2', meterNo: 'M2', name: 'Tail, Wendy', address: '305 Whitetail Lane', startReading: 0 },
    { seq: 3, account: '3', meterNo: 'M3', name: 'Nobody, Known', address: '1 Lost Lane', startReading: 0 }] });
  meters = (await O('GET', '/api/admin/meters')).body.meters;
  await O('PUT', '/api/admin/portal', { on: true });
  owner = client();
  send.outbox.length = 0;
  await owner('POST', `/api/p/${slug}/start`, { meterId: meters[0].id });
  const path = /href="https?:\/\/[^/"]+(\/p\/[^"]+\/in\/[^"]+)"/.exec(send.outbox[0].html)[1];
  await owner('GET', path + '?go=1');
  const h = (await owner('GET', `/api/p/${slug}/me`)).body;
  assert.strictEqual(h.properties[0].qbo, null, 'nothing from QuickBooks until it is connected');
});

test('connect: the Intuit sign-in round trip (forged or expired state refused)', async () => {
  let st = (await O('GET', '/api/admin/quickbooks')).body;
  assert.strictEqual(st.setUp, true); assert.strictEqual(st.connected, false);
  const r = await O('GET', '/api/admin/quickbooks/connect');
  assert.strictEqual(r.status, 302);
  const u = new URL(r.location);
  assert.strictEqual(u.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.match(u.searchParams.get('redirect_uri'), /\/api\/admin\/quickbooks\/callback$/);
  const state = u.searchParams.get('state');
  let cb = await O('GET', `/api/admin/quickbooks/callback?code=good&realmId=123&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`);
  assert.match(decodeURIComponent(cb.location), /qbo-error=.*expired/);
  cb = await O('GET', `/api/admin/quickbooks/callback?code=good&realmId=123&state=${encodeURIComponent(state)}`);
  assert.strictEqual(cb.location, '/admin#qbo-ok');
  st = (await O('GET', '/api/admin/quickbooks')).body;
  assert.strictEqual(st.connected, true); assert.strictEqual(st.company, 'Deerfield Water QB');
  assert.strictEqual(st.linked, 2, 'by the QuickBooks name on the meter, and "Tail, Wendy" = "Wendy Tail"');
  // tokens are sealed in the database, never stored plain
  const c = await db.one('SELECT qbo_refresh, qbo_access FROM companies');
  assert.ok(!/^r\d+$/.test(c.qbo_refresh) && !/^a\d+$/.test(c.qbo_access));
  assert.deepStrictEqual([...intuit.minor], ['75']);
});

test('matching: unmatched meters can be matched by hand', async () => {
  let st = (await O('GET', '/api/admin/quickbooks')).body;
  const lost = st.unlinked.find(m => m.address === '1 Lost Lane');
  assert.ok(lost, JSON.stringify(st.unlinked));
  assert.strictEqual((await O('PUT', '/api/admin/quickbooks/link', { meterId: lost.id, qboId: '999' })).status, 400);
  st = (await O('PUT', '/api/admin/quickbooks/link', { meterId: lost.id, qboId: '13' })).body;
  assert.ok(!st.unlinked.some(m => m.id === lost.id));
  // a hand-picked match survives the nightly refresh
  st = (await O('POST', '/api/admin/quickbooks/sync')).body;
  assert.ok(!st.unlinked.some(m => m.id === lost.id));
});

test('owner portal: balance, invoices with status, payments; PDF only for their own invoices', async () => {
  const h = (await owner('GET', `/api/p/${slug}/me`)).body;
  const a = h.properties[0].qbo;
  assert.strictEqual(a.balance, 75);
  assert.deepStrictEqual(a.invoices.map(i => [i.number, i.status]), [['W26Q4-0001', 'open'], ['W26Q3-0001', 'paid']]);
  assert.deepStrictEqual(a.payments, [{ date: '2026-07-15', amount: 75 }]);
  const pdf = await owner('GET', `/api/p/${slug}/invoice/${meters[0].id}/502`);
  assert.strictEqual(pdf.status, 200); assert.match(pdf.body.toString(), /^%PDF/);
  assert.strictEqual((await owner('GET', `/api/p/${slug}/invoice/${meters[0].id}/601`)).status, 404, "someone else's invoice");
  assert.strictEqual((await owner('GET', `/api/p/${slug}/invoice/${meters[2].id}/601`)).status, 404, 'not their property');
  assert.strictEqual((await client()('GET', `/api/p/${slug}/invoice/${meters[0].id}/502`)).status, 401, 'signed in only');
});

test('an expired access token is refreshed once, and the new (rotated) refresh token is kept', async () => {
  const before = intuit.refresh;
  await db.q("UPDATE companies SET qbo_access_exp = now() - interval '1 minute'");
  const st = (await O('POST', '/api/admin/quickbooks/sync')).body;
  assert.strictEqual(st.connected, true);
  assert.strictEqual(intuit.refresh, before + 1);
  // again with the stored (rotated) token: works, so the newest one was saved
  await db.q("UPDATE companies SET qbo_access_exp = now() - interval '1 minute'");
  assert.strictEqual((await O('POST', '/api/admin/quickbooks/sync')).status, 200);
  assert.strictEqual(intuit.refresh, before + 2);
});

test('disconnect: owners stop seeing QuickBooks; the portal still works', async () => {
  const st = (await O('POST', '/api/admin/quickbooks/disconnect')).body;
  assert.strictEqual(st.connected, false);
  assert.ok(intuit.calls.includes('/revoke'));
  const h = (await owner('GET', `/api/p/${slug}/me`)).body;
  assert.strictEqual(h.properties[0].qbo, null);
  assert.strictEqual(h.properties[0].address, '141 Deer Meadow Dr');
});
