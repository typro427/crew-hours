// Weekly property-transfer check: reads transfer lists (a text PDF, a scanned PDF, a screenshot) from a stand-in for
// WLAF's page, matches them to the Members list, and keeps them for review. Made-up names and places only.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const ExcelJS = require('exceljs');
const { createCanvas } = require('@napi-rs/canvas');
const { app } = require('../src/server');
const db = require('../src/db');
const config = require('../src/config');
const TR = require('../src/transfers');
const { send } = require('../src/email');

/** A small PDF. Each page is { lines: [...] } (real text) or { jpeg, w, h } (a scan: just a picture). */
function makePdf(pages) {
  const objs = [];
  const add = o => { objs.push(o); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageRefs = [];
  for (const p of pages) {
    let content, res;
    if (p.lines) {
      content = 'BT /F1 10 Tf 36 750 Td 14 TL ' + p.lines.map(l => '(' + l.replace(/[()\\]/g, '\\$&') + ') Tj T*').join(' ') + ' ET';
      res = `/Font << /F1 ${font} 0 R >>`;
    } else {
      const im = add({ dict: `/Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, stream: p.jpeg });
      content = `q 560 0 0 ${Math.round(560 * p.h / p.w)} 26 500 cm /Im1 Do Q`;
      res = `/XObject << /Im1 ${im} 0 R >>`;
    }
    const c = add({ dict: '', stream: Buffer.from(content) });
    pageRefs.push(add({ page: true, c, res }));
  }
  const pagesId = objs.length + 1;
  add(`<< /Type /Pages /Kids [${pageRefs.map(i => i + ' 0 R').join(' ')}] /Count ${pageRefs.length} >>`);
  const root = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const parts = [Buffer.from('%PDF-1.4\n')], offs = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    const head = `${i + 1} 0 obj\n`;
    const b = typeof o === 'string' ? Buffer.from(`${head}${o}\nendobj\n`)
      : o.page ? Buffer.from(`${head}<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${o.c} 0 R /Resources << ${o.res} >> >>\nendobj\n`)
      : Buffer.concat([Buffer.from(`${head}<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`), o.stream, Buffer.from('\nendstream\nendobj\n')]);
    offs.push(len); parts.push(b); len += b.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${root} 0 R >>\nstartxref\n${len}\n%%EOF\n`));
  return Buffer.concat(parts);
}
function picture(lines, type) {
  const c = createCanvas(1400, 70 + lines.length * 52), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000'; g.font = '30px DejaVu Sans';
  lines.forEach((l, i) => g.fillText(l, 30, 60 + i * 52));
  return { buf: c.toBuffer(type), w: c.width, h: c.height };
}

const files = {};
let wlaf, wlafBase, server, base, O, companyId, hits = {};
function listPage() {
  return `<html><body><h1>Property Transfers</h1><ul>
    <li><a href="/uploads/2026/11/wlaf-11-16.pdf">November 16, 2026</a></li>
    <li><a href="${wlafBase}/uploads/DOC111226-scan.pdf">November 12, 2026</a></li>
    <li><a href="/uploads/Nov-10-2026-Screenshot-1.png">November 10, 2026</a></li>
    <li><a href="/uploads/old.pdf">January 2, 2020</a></li>
    <li><a href="https://example.com/other.pdf">November 9, 2026</a></li>
    <li><a href="/about">About us</a></li></ul></body></html>`;
}

before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  files['/uploads/2026/11/wlaf-11-16.pdf'] = makePdf([{ lines: [
    'CAMPBELL COUNTY PROPERTY TRANSFERS',
    'Doe John to Brown Ann, 470 Deerfield Landing, $300,000',
    'Jones Al to King Bo, 12 Main St Jacksboro, $90,000',
    'Green Tom to White Amy, Lot 40 Deerfield, $45,000'] }]);
  const scan = picture(['Smith John and Mary to Roe Jane, 141 Deer Run Pt, $250,000', 'Map 076N A 012.00 Deerfield Resort'], 'image/jpeg');
  files['/uploads/DOC111226-scan.pdf'] = makePdf([{ jpeg: scan.buf, w: scan.w, h: scan.h }]);
  files['/uploads/Nov-10-2026-Screenshot-1.png'] = picture(['Hill Bob to Lake Sue LLC, Lot 12 Deerfield, $60,000'], 'image/png').buf;
  files['/uploads/old.pdf'] = makePdf([{ lines: ['Doe John to Someone Else, 470 Deerfield Landing'] }]);
  wlaf = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/property-transfers/') { res.setHeader('Content-Type', 'text/html'); return res.end(listPage()); }
    const f = files[req.url];
    if (!f) { res.statusCode = 404; return res.end('no'); }
    res.setHeader('Content-Type', req.url.endsWith('.png') ? 'image/png' : 'application/pdf'); res.end(f);
  });
  await new Promise(ok => wlaf.listen(0, '127.0.0.1', ok));
  wlafBase = 'http://127.0.0.1:' + wlaf.address().port;
  config.transfers.url = wlafBase + '/property-transfers/';

  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  await O('POST', '/api/signup', { company: 'Test Mgmt', name: 'Pat', email: 'boss@example.com', password: 'LongPass1!' });
  companyId = (await db.one('SELECT id FROM companies')).id;
  const imp = await O('POST', '/api/admin/members/import', {
    columns: ['Deerfield address', 'First name(s)', 'Last name', 'Trust or LLC', 'Status', 'Parcel ID', 'Cell phone 1', 'Email 1'],
    rows: [
      { 'Deerfield address': '470 Deerfield Landing', 'First name(s)': 'John', 'Last name': 'Doe', Status: 'Active', 'Cell phone 1': '423-555-0101', 'Email 1': 'jd@example.com' },
      { 'Deerfield address': '141 Deer Run Pt', 'First name(s)': 'John & Mary', 'Last name': 'Smith', Status: 'Active', 'Parcel ID': '076N A 012.00' },
      { 'Deerfield address': '22 Whitetail Ct', 'First name(s)': 'Bob', 'Last name': 'Hill', 'Trust or LLC': 'Hill Family Trust', Status: 'Active' },
      { 'Deerfield address': '9 Elk Ridge', 'First name(s)': 'Al', 'Last name': 'Jones', Status: 'Inactive / sold' },
      { 'Deerfield address': '55 Deer Meadow Dr', 'First name(s)': 'Ann', 'Last name': 'Lee', Status: 'Active' }]
  });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
});
after(async () => { server.close(); wlaf.close(); await db.pool.end(); });

test('dates, links and the two sides of a transfer', () => {
  assert.equal(TR.dayOf('November 16, 2026'), '2026-11-16');
  assert.equal(TR.dayOf('Nov. 3 2026'), '2026-11-03');
  assert.equal(TR.dayOf('x', '/Nov-16-2026-Screenshot-421.png'), '2026-11-16');
  assert.equal(TR.dayOf('11/2/2026'), '2026-11-02');
  assert.equal(TR.dayOf('About us'), null);
  assert.deepEqual(TR.parties('Doe John to Brown Ann, 470 Deerfield Landing, $300,000'), { from: 'Doe John', to: 'Brown Ann' });
  assert.deepEqual(TR.parties('11/12/2026   Smith John & Mary   Roe Jane   Dist 3 Map 076N   $250,000'), { from: 'Smith John & Mary', to: 'Roe Jane' });
  assert.deepEqual(TR.parties('Grantor: Hill Bob Grantee: Lake Sue LLC  Lot 12'), { from: 'Hill Bob', to: 'Lake Sue LLC' });
});

test('matching: address, parcel, names, trusts; nothing for other places or sold members', async () => {
  const idx = await TR.index(companyId);
  assert.equal(idx.length, 4, 'the sold member is left out');
  const ch = TR.findChanges([
    'Doe John to Brown Ann, 470 Deerfield Landing, $300,000',
    'Jones Al to King Bo, 12 Main St Jacksboro, $90,000',
    'Someone to Other, Map 076N-A-012.00',
    'Lee Ann to Park Joe, 55 Deer Run Pt',                     // right house number, wrong street: only her name matches
    'Trustee of the Hill Family Trust to Fox Kim',
    'Doe Jane to Brown Sam, 12 Elm St'                         // same last name, different first name: no match
  ].join('\n'), idx);
  const doe = ch.find(c => c.old_owner === 'Doe John');
  assert.ok(doe && doe.reasons.some(r => r.startsWith('Address')) && doe.reasons.some(r => r.startsWith('Owner name')), JSON.stringify(ch));
  assert.equal(doe.new_owner, 'Brown Ann');
  assert.equal(doe.address, '470 Deerfield Landing');
  assert.ok(ch.some(c => c.reasons.some(r => r.startsWith('Parcel ID'))));
  const lee = ch.find(c => c.old_owner === 'Lee Ann');
  assert.ok(lee && !lee.reasons.some(r => r.startsWith('Address')) && lee.reasons.some(r => r.startsWith('Owner name')));
  assert.ok(ch.some(c => c.reasons.some(r => r.startsWith('Trust/LLC'))));
  assert.ok(!ch.some(c => c.old_owner === 'Jones Al'), 'not in Deerfield, and that member sold');
  assert.ok(!ch.some(c => c.old_owner === 'Doe Jane'));
});

test('a check reads text PDFs, scans and screenshots, and keeps possible changes for review', async () => {
  const res = await TR.check(companyId, { today: '2026-11-17' });
  assert.equal(res.files, 3, JSON.stringify(res));      // the 2020 list is too old; example.com isn't WLAF
  assert.deepEqual(res.errors, []);
  assert.ok(!hits['/uploads/old.pdf']);
  const L = await O('GET', '/api/admin/transfers');
  assert.equal(L.status, 200);
  const ch = L.body.changes;
  const doe = ch.find(c => /Doe John/.test(c.excerpt) && c.members.length);
  assert.ok(doe, JSON.stringify(ch.map(c => c.excerpt)));
  assert.equal(doe.day.slice(0, 10), '2026-11-16');
  assert.equal(doe.old_owner, 'Doe John'); assert.equal(doe.new_owner, 'Brown Ann');
  assert.equal(doe.members[0].name, 'John Doe');
  const smith = ch.find(c => c.members.some(m => m.name === 'John & Mary Smith'));
  assert.ok(smith, 'found in the scanned PDF by OCR');
  assert.ok(smith.reasons.some(r => /Parcel|Address|Owner/.test(r)));
  const hill = ch.find(c => c.members.some(m => m.name === 'Bob Hill'));
  assert.ok(hill, 'found in the screenshot');
  assert.match(hill.new_owner, /Lake Sue/);
  const lot40 = ch.find(c => /Lot 40/.test(c.excerpt));
  assert.ok(lot40 && !lot40.members.length && lot40.reasons.includes('Mentions Deerfield'));
  assert.ok(!ch.some(c => /Jones Al/.test(c.excerpt.split('\n')[1] || '') && c.members.length));
  assert.equal(L.body.sources.filter(s => s.status === 'ok').length, 3);
  assert.ok(L.body.sources.some(s => s.ocr));
  assert.equal(L.body.settings.on, true, 'on by default for a Deerfield members list');
  assert.equal(L.body.settings.lastFiles, 3);

  // the next check skips lists it already read
  const again = await TR.check(companyId, { today: '2026-11-17' });
  assert.equal(again.files, 0);
  assert.equal(hits['/uploads/2026/11/wlaf-11-16.pdf'], 1);
});

test('approve updates the member and keeps the old owner; dismiss and bring back; nothing changes on its own', async () => {
  let L = (await O('GET', '/api/admin/transfers')).body;
  const doe = L.changes.find(c => c.members.some(m => m.name === 'John Doe'));
  let m = (await O('GET', '/api/admin/members?q=deerfield landing')).body.rows[0];
  assert.equal(m.data['Last name'], 'Doe', 'not changed until approved');

  assert.equal((await O('POST', `/api/admin/transfers/${doe.id}/approve`, { member_id: doe.members[0].id })).status, 400, 'needs the new name');
  const ok = await O('POST', `/api/admin/transfers/${doe.id}/approve`, { member_id: doe.members[0].id, first: 'Ann', last: 'Brown' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  m = (await O('GET', '/api/admin/members?q=deerfield landing')).body.rows[0];
  assert.equal(m.data['First name(s)'], 'Ann'); assert.equal(m.data['Last name'], 'Brown');
  assert.match(m.data['Previous owner'], /John Doe · 423-555-0101 · jd@example\.com/);
  assert.equal(m.data['Owner changed'], '2026-11-16');
  assert.ok(!m.data['Cell phone 1'] && !m.data['Email 1'], "the old owner's phone and email moved to Previous owner");
  assert.equal((await O('POST', `/api/admin/transfers/${doe.id}/approve`, { member_id: doe.members[0].id, first: 'X' })).status, 400, 'already decided');

  const lot40 = L.changes.find(c => /Lot 40/.test(c.excerpt));
  assert.equal((await O('POST', `/api/admin/transfers/${lot40.id}/dismiss`)).status, 200);
  L = (await O('GET', '/api/admin/transfers?status=dismissed')).body;
  assert.equal(L.changes.length, 1);
  assert.equal((await O('POST', `/api/admin/transfers/${lot40.id}/reopen`)).status, 200);
  assert.equal((await O('POST', `/api/admin/transfers/${doe.id}/reopen`)).status, 400);
  L = (await O('GET', '/api/admin/transfers')).body;
  assert.ok(L.changes.some(c => c.id === lot40.id));
  assert.equal(L.counts.approved, 1);
});

test('the sheet and the weekly email', async () => {
  const x = await O('GET', '/api/admin/transfers.xlsx');
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
  const ws = wb.worksheets[0];
  assert.deepEqual(ws.getRow(1).values.slice(1, 5), ['Date', 'Property', 'Old owner', 'New owner']);
  assert.ok(ws.rowCount >= 4);
  assert.ok(ws.getColumn(3).values.some(v => v === 'Smith John and Mary' || /Smith/.test(String(v))));

  send.outbox.length = 0;
  const company = await db.one('SELECT * FROM companies WHERE id=$1', [companyId]);
  const n = await TR.emailNew(company);
  assert.ok(n >= 3);
  const mail = send.outbox.find(e => /Property changes to review/.test(e.subject));
  assert.ok(mail);
  assert.deepEqual(mail.to, ['boss@example.com']);
  assert.equal(mail.attachments.length, 1);
  assert.match(mail.attachments[0].filename, /\.xlsx$/);
  assert.match(mail.html, /Nothing on the Members list has changed/);
  assert.equal(await TR.emailNew(company), 0, 'each change is emailed once');

  const s = await O('PUT', '/api/admin/transfers/settings', { on: false, emails: 'a@example.com, b@example.com' });
  assert.equal(s.body.on, false); assert.equal(s.body.emails, 'a@example.com, b@example.com');
  assert.equal((await O('PUT', '/api/admin/transfers/settings', { emails: 'nope' })).status, 400);
});

test('a list that cannot be read is noted and tried again later', async () => {
  const page = listPage;
  // a new day whose file is missing
  const orig = wlaf.listeners('request')[0];
  wlaf.removeAllListeners('request');
  wlaf.on('request', (req, res) => {
    if (req.url === '/property-transfers/') { res.setHeader('Content-Type', 'text/html'); return res.end(page().replace('<ul>', '<ul><li><a href="/uploads/missing.pdf">November 17, 2026</a></li>')); }
    orig(req, res);
  });
  const r = await TR.check(companyId, { today: '2026-11-17' });
  assert.equal(r.files, 1); assert.equal(r.errors.length, 1);
  const L = (await O('GET', '/api/admin/transfers')).body;
  assert.match(L.settings.lastError, /couldn't be read/);
  assert.ok(L.sources.some(s => s.status === 'error' && /404/.test(s.error)));
  assert.equal((await TR.check(companyId, { today: '2026-11-17' })).files, 0, 'not again the same day');
});
