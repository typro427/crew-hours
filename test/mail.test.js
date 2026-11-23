// Compliance › Email: connect an Outlook mailbox (Microsoft stand-in), read water system mail, sort what needs
// attention, notify, mark done. Made-up messages only.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { app } = require('../src/server');
const db = require('../src/db');
const config = require('../src/config');
const ML = require('../src/mail');
const P = require('../src/push');

const now = Date.now(), ago = h => new Date(now - h * 3600e3).toISOString();
let inbox = [
  { id: 'm1', subject: '2026 Lead & Copper Consumer Notice Documents', from: { emailAddress: { address: 'chris.allen@tn.gov', name: 'Chris Allen' } },
    receivedDateTime: ago(5), bodyPreview: 'We have not yet received documentation. Please submit the CN-1595 by December 15, 2026.', webLink: 'https://outlook.example/m1', hasAttachments: true },
  { id: 'm2', subject: 'Leave Your Leaves This Fall', from: { emailAddress: { address: 'Green.Government@tn.gov', name: 'The Catalyst' } }, receivedDateTime: ago(6), bodyPreview: 'Newsletter. Unsubscribe', webLink: 'x' },
  { id: 'm3', subject: 'Data', from: { emailAddress: { address: 'joey@minerallabs.com', name: 'Joey Rutherford' } }, receivedDateTime: ago(7), bodyPreview: 'Certificate of Analysis attached', webLink: 'https://outlook.example/m3', hasAttachments: true },
  { id: 'm4', subject: 'ML INVOICE-6103130 for DEER FIELD WATER SYSTEM', from: { emailAddress: { address: 'denalyon@minerallabs.com', name: 'LaDena Lyon' } }, receivedDateTime: ago(8), bodyPreview: 'Please find invoice attached', webLink: 'y' },
  { id: 'm5', subject: 'Lunch Friday?', from: { emailAddress: { address: 'friend@example.com', name: 'Friend' } }, receivedDateTime: ago(9), bodyPreview: 'Tacos?', webLink: 'z' },
  { id: 'm6', subject: 'Water system problem reported by Jake', from: { emailAddress: { address: 'mycrewhours@gmail.com', name: 'Crew Hours' } }, receivedDateTime: ago(9), bodyPreview: 'leak', webLink: 'z' },
  { id: 'm7', subject: 'Deerfield water main question', from: { emailAddress: { address: 'owner@example.com', name: 'A Homeowner' } }, receivedDateTime: ago(10), bodyPreview: 'Who do I call about pressure?', webLink: 'w' },
  { id: 'm8', subject: 'Sent by me about the water system', from: { emailAddress: { address: 'op@example.com', name: 'Me' } }, receivedDateTime: ago(10), bodyPreview: 'x', webLink: 'v' }
];
let ms, server, base, O, tokens = 0, pushed = [];
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  ms = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/oauth/token') {
        const p = new URLSearchParams(body);
        if (p.get('client_secret') !== 'sec') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'invalid_client' })); }
        if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' })); }
        tokens++;
        return res.end(JSON.stringify({ access_token: 'at' + tokens, refresh_token: 'rt' + tokens, expires_in: 3600 }));
      }
      if (!/^Bearer at\d+$/.test(req.headers.authorization || '')) { res.statusCode = 401; return res.end('{}'); }
      if (req.url.startsWith('/graph/me?')) return res.end(JSON.stringify({ mail: 'op@example.com', displayName: 'Operator' }));
      if (req.url.startsWith('/graph/me/messages')) return res.end(JSON.stringify({ value: inbox }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(ok => ms.listen(0, '127.0.0.1', ok));
  const mb = 'http://127.0.0.1:' + ms.address().port;
  Object.assign(config.outlook, { clientId: 'cid', clientSecret: 'sec', authority: mb + '/oauth', graph: mb + '/graph' });
  P.notify = async (c, ids, payload) => { pushed.push(payload); };
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body) => {
    const r = await fetch(base + url, { method, redirect: 'manual', headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, location: r.headers.get('location'), body: ct.includes('json') ? await r.json() : await r.text() };
  };
  await O('POST', '/api/signup', { company: 'Water Co', name: 'Op', email: 'boss@example.com', password: 'LongPass1!' });
});
after(async () => { server.close(); ms.close(); await db.pool.end(); });

test('what counts as water system mail, and what needs attention', () => {
  const c = m => ML.classify({ subject: m[0], preview: m[1] || '', from: m[2], fromName: m[3] || '', received: new Date().toISOString() }, 'op@example.com');
  const tdec = c(['Monthly Operating Report', 'Your October MOR is due by Dec 10.', 'someone@tn.gov']);
  assert.ok(tdec.attention); assert.equal(tdec.kind, 'TDEC'); assert.match(tdec.due, /^\d{4}-12-10$/);
  assert.equal(c(['Lunch?', 'tacos', 'a@example.com']), null);
  assert.equal(c(['Newsletter', 'Unsubscribe here', 'Green.Government@tn.gov', 'The Catalyst']), null);
  assert.equal(c(['Water system problem reported', 'leak', 'mycrewhours@gmail.com']), null, 'already in the app');
  const boil = c(['Boil water advisory', 'E. coli positive at site 3', 'lab@example.com']);
  assert.ok(boil.urgent && boil.attention);
  const fyi = c(['Training class', 'Drinking water operator class in March', 'someone@tn.gov']);
  assert.ok(fyi && !fyi.attention, 'TDEC mail that asks for nothing is FYI');
  assert.equal(ML.dueDate('please send it no later than 1/5/2027'), '2027-01-05');
  assert.equal(ML.dueDate('nothing here'), null);
});

test('connect Outlook, first check (no notification), then new mail notifies', async () => {
  const st = await O('GET', '/api/admin/mail/setup');
  assert.equal(st.body.enabled, true); assert.match(st.body.redirectUri, /\/api\/admin\/mail\/callback$/);
  const go = await O('GET', '/api/admin/mail/connect');
  assert.equal(go.status, 302);
  const u = new URL(go.location);
  assert.equal(u.searchParams.get('scope'), 'offline_access User.Read Mail.Read', 'read-only');
  const state = u.searchParams.get('state');
  const bad = await O('GET', `/api/admin/mail/callback?code=good&state=${encodeURIComponent(state.replace(/.$/, 'x'))}`);
  assert.match(decodeURIComponent(bad.location), /email-error=.*expired/);
  const ok = await O('GET', `/api/admin/mail/callback?code=good&state=${encodeURIComponent(state)}`);
  assert.match(decodeURIComponent(ok.location), /#email-ok=op@example\.com/);
  const acct = await db.one('SELECT refresh FROM mail_accounts');
  assert.ok(!acct.refresh.includes('rt'), 'tokens are sealed');
  let L = (await O('GET', '/api/admin/cw/mail')).body;
  assert.deepEqual(L.items.map(i => i.subject).sort(), ['2026 Lead & Copper Consumer Notice Documents', 'Data', 'Deerfield water main question', 'ML INVOICE-6103130 for DEER FIELD WATER SYSTEM'].sort());
  const notice = L.items.find(i => /Consumer Notice/.test(i.subject));
  assert.equal(notice.status, 'new'); assert.equal(notice.due, '2026-12-15'); assert.equal(notice.kind, 'TDEC');
  assert.equal(L.items.find(i => i.subject === 'Data').kind, 'Lab results');
  assert.equal(L.items.find(i => /INVOICE/.test(i.subject)).kind, 'Invoice');
  assert.equal(L.items.find(i => /water main/.test(i.subject)).status, 'fyi');
  assert.equal(pushed.length, 0, 'the first 30 days are not notified');

  // new mail arrives
  inbox = [{ id: 'm9', subject: 'Notice of Violation', from: { emailAddress: { address: 'dwr@tn.gov', name: 'DWR' } }, receivedDateTime: new Date().toISOString(), bodyPreview: 'Monitoring violation. Public notice is required.', webLink: 'u' }, ...inbox];
  const s = await O('POST', '/api/admin/mail/sync');
  assert.equal(s.body.added, 1);
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].title, /needs attention/); assert.equal(pushed[0].path, 'compliance#email'); assert.equal(pushed[0].feature, 'compliance'); assert.ok(pushed[0].notGuards);
  await O('POST', '/api/admin/mail/sync');
  assert.equal(pushed.length, 1, 'each email notifies once');
  L = (await O('GET', '/api/admin/cw/mail')).body;
  assert.equal(L.items[0].subject, 'Notice of Violation', 'urgent first'); assert.ok(L.items[0].urgent);
});

test('done, not done, flag; disconnect', async () => {
  let L = (await O('GET', '/api/admin/cw/mail')).body;
  const n = L.items.find(i => /Consumer Notice/.test(i.subject));
  L = (await O('POST', `/api/admin/cw/mail/${n.id}/done`)).body;
  const d = L.items.find(i => i.id === n.id);
  assert.equal(d.status, 'done'); assert.ok(d.doneBy);
  L = (await O('POST', `/api/admin/cw/mail/${n.id}/undone`)).body;
  assert.equal(L.items.find(i => i.id === n.id).status, 'new');
  const f = L.items.find(i => i.status === 'fyi');
  L = (await O('POST', `/api/admin/cw/mail/${f.id}/flag`, { on: true })).body;
  assert.equal(L.items.find(i => i.id === f.id).status, 'new');
  assert.equal((await O('POST', '/api/admin/cw/mail/99999/done')).status, 400);
  // a refresh token that stopped working
  await db.q("UPDATE mail_accounts SET access_exp = now() - interval '1 hour'");
  config.outlook.clientSecret = 'wrong';
  const s = await O('POST', '/api/admin/mail/sync');
  assert.equal(s.body.errors.length, 1);
  assert.ok((await O('GET', '/api/admin/cw/mail')).body.accounts[0].error);
  config.outlook.clientSecret = 'sec';
  const acct = L.accounts[0];
  L = (await O('DELETE', '/api/admin/mail/accounts/' + acct.id)).body;
  assert.equal(L.accounts.length, 0); assert.equal(L.items.length, 0);
});

test('your own billing is sorted right; stop these; always let these through', async () => {
  // a fresh mailbox with billing mail
  inbox = [
    { id: 'b1', subject: 'Invoice 100188 from Deerfield Water System', from: { emailAddress: { address: 'quickbooks@notification.intuit.com', name: 'Deerfield Water System' } }, receivedDateTime: ago(3), bodyPreview: 'Your invoice is ready', webLink: 'q' },
    { id: 'b2', subject: 'Money on the way!', from: { emailAddress: { address: 'BusinessServices@intuit.com', name: 'Intuit' } }, receivedDateTime: ago(3), bodyPreview: 'water system deposit', webLink: 'q' },
    { id: 'b3', subject: 'Re: New payment request from Deerfield Water System LLC - invoice 1012', from: { emailAddress: { address: 'owner@example.com', name: 'A Customer' } }, receivedDateTime: ago(4), bodyPreview: 'I paid this already', webLink: 'q' },
    { id: 'b4', subject: 'Weekly bulletin', from: { emailAddress: { address: 'news@county.example', name: 'County' } }, receivedDateTime: ago(4), bodyPreview: 'Water main flushing schedule', webLink: 'q' },
    { id: 'b5', subject: 'Hydrant on Deer Run', from: { emailAddress: { address: 'neighbor@example.com', name: 'Neighbor' } }, receivedDateTime: ago(5), bodyPreview: 'It was hit by a truck', webLink: 'q' }
  ];
  const go = await O('GET', '/api/admin/mail/connect');
  await O('GET', `/api/admin/mail/callback?code=good&state=${encodeURIComponent(new URL(go.location).searchParams.get('state'))}`);
  let L = (await O('GET', '/api/admin/cw/mail')).body;
  const subj = L.items.map(i => i.subject);
  assert.ok(!subj.some(x => /Invoice 100188|Money on the way/.test(x)), 'QuickBooks copies and deposits are left out');
  const cust = L.items.find(i => /payment request/.test(i.subject));
  assert.equal(cust.kind, 'Customer billing'); assert.equal(cust.status, 'new'); assert.deepEqual(cust.reasons, ['A customer replied about their bill']);
  assert.ok(!subj.includes('Hydrant on Deer Run'), 'not water words, not allowed yet');

  // stop the county bulletin by subject
  const bul = L.items.find(i => i.subject === 'Weekly bulletin');
  L = (await O('POST', '/api/admin/cw/mail/rules', { list: 'block', type: 'subject', value: bul.subject })).body;
  assert.ok(!L.items.some(i => i.subject === 'Weekly bulletin'));
  assert.equal(L.rules.block[0].value, 'weekly bulletin');
  // always let through: a word (looks back 30 days)
  L = (await O('POST', '/api/admin/cw/mail/rules', { list: 'allow', type: 'word', value: 'Hydrant' })).body;
  const h = L.items.find(i => i.subject === 'Hydrant on Deer Run');
  assert.ok(h, 'found in the look-back'); assert.equal(h.status, 'new'); assert.deepEqual(h.reasons, ['Has "hydrant"']);
  // a domain stop; checks
  assert.equal((await O('POST', '/api/admin/cw/mail/rules', { list: 'block', type: 'domain', value: 'not a domain' })).status, 400);
  assert.equal((await O('POST', '/api/admin/cw/mail/rules', { list: 'allow', type: 'sender', value: 'nope' })).status, 400);
  L = (await O('POST', '/api/admin/cw/mail/rules', { list: 'block', type: 'domain', value: 'example.com' })).body;
  assert.ok(!L.items.some(i => /example\.com$/.test(i.sender)), 'blocking wins over letting through');
  // undo
  L = (await O('DELETE', '/api/admin/cw/mail/rules/' + L.rules.block.find(r => r.type === 'domain').id)).body;
  assert.ok(L.items.some(i => i.subject === 'Hydrant on Deer Run'));
  pushed.length = 0;
  inbox = [{ id: 'b6', subject: 'Weekly bulletin', from: { emailAddress: { address: 'news@county.example', name: 'County' } }, receivedDateTime: new Date().toISOString(), bodyPreview: 'Water main flushing', webLink: 'q' }, ...inbox];
  await O('POST', '/api/admin/mail/sync');
  assert.equal(pushed.length, 0, 'a stopped email never notifies');
});
