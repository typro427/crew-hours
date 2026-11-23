// Sample results: read a lab report (text PDF and a scan) or a Drinking Water Watch table, save after checking,
// see each test against its limit. Made-up results only.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createCanvas } = require('@napi-rs/canvas');
const { app } = require('../src/server');
const db = require('../src/db');
const R = require('../src/cwresults');

function makePdf(lines) {   // a one-page text PDF
  const content = 'BT /F1 10 Tf 36 750 Td 14 TL ' + lines.map(l => '(' + l.replace(/[()\\]/g, '\\$&') + ') Tj T*').join(' ') + ' ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let server, base, O;
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : ct.includes('wordprocessing') ? Buffer.from(await r.arrayBuffer()) : await r.text() };
  };
  await O('POST', '/api/signup', { company: 'Water Co', name: 'Op', email: 'op@example.com', password: 'LongPass1!' });
  await db.q("UPDATE companies SET features = COALESCE(features,'{}'::jsonb) || '{\"compliance\":true}'::jsonb").catch(() => {});
});
after(async () => { server.close(); await db.pool.end(); });

test('results, units and names', () => {
  assert.deepEqual(R.resultOf('<0.0010'), { value: 0.001, qual: 'lt', text: '<0.0010' });
  assert.equal(R.resultOf('ND').qual, 'nd');
  assert.equal(R.resultOf('Absent').qual, 'absent');
  assert.equal(R.resultOf('Nitrate'), null);
  assert.equal(R.unitTidy('ug/L'), 'µg/L'); assert.equal(R.unitTidy('PPM'), 'mg/L');
  assert.equal(R.testName('Nitrate as N'), 'Nitrate'); assert.equal(R.testName('Nitrate-Nitrite as N'), 'Nitrate + nitrite');
  assert.equal(R.testName('TOTAL TRIHALOMETHANES'), 'TTHM'); assert.equal(R.testName('Lead'), 'Lead');
  assert.equal(R.convert(24.1, 'µg/L', 'mg/L').toFixed(4), '0.0241');
});

test('a lab PDF: read, check, save, and mark the schedule', async () => {
  // a sample type on the schedule
  await O('POST', '/api/admin/cw/items', { list: 'samples', name: 'Nitrate', months: 12 });
  const pdf = makePdf([
    'Smoky Mountain Analytical Laboratory',
    'Sample ID: 2611045-01      Sample Location: Entry Point 001',
    'Date Collected: 10/14/2026 09:15',
    'Analyte              Result      Units    RL       MCL     Method',
    'Nitrate as N         0.52        mg/L     0.10     10      EPA 300.0   10/15/2026',
    'Arsenic              <0.0010     mg/L     0.0010   0.010   EPA 200.8',
    'Total Coliform       Absent      P/A               SM 9223B',
    'Sample ID: 2611045-02      Sample Location: 141 Deer Run Pt',
    'Date Collected: 10/13/2026',
    'Lead                 0.0210      mg/L     0.0010   0.015   EPA 200.8']);
  const r = await O('POST', '/api/admin/cw/results/read', null, pdf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.how, 'pdf');
  const by = t => r.body.rows.find(x => x.test === t);
  assert.deepEqual([by('Nitrate').day, by('Nitrate').point, by('Nitrate').result, by('Nitrate').units], ['2026-10-14', 'Entry Point 001', '0.52', 'mg/L']);
  assert.equal(by('Lead').point, '141 Deer Run Pt'); assert.equal(by('Lead').day, '2026-10-13');
  assert.equal(by('Total coliform').result, 'Absent');
  assert.equal(r.body.schedule.length, 1); assert.equal(r.body.schedule[0].day, '2026-10-14');
  assert.ok(by('Lead').lab.includes('Smoky Mountain'));

  const s = await O('POST', '/api/admin/cw/results', { rows: r.body.rows, schedule: r.body.schedule, source: 'report.pdf' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.added, 4); assert.equal(s.body.marked, 1);
  assert.equal(s.body.limits.Lead.limit, 0.015); assert.equal(s.body.limits.Lead.kind, 'al');
  assert.equal(R.over(s.body.results.find(x => x.test === 'Lead'), s.body.limits.Lead), true);
  assert.equal(R.over(s.body.results.find(x => x.test === 'Arsenic'), s.body.limits.Arsenic), false);
  const cw = (await O('GET', '/api/admin/cw')).body;
  assert.equal(cw.samples.find(x => x.name === 'Nitrate').last, '2026-10-14', 'schedule marked');

  // the same report again: nothing new, and the preview says so
  const again = await O('POST', '/api/admin/cw/results/read', null, pdf);
  assert.ok(again.body.rows.every(x => x.dup));
  assert.equal((await O('POST', '/api/admin/cw/results', { rows: again.body.rows, source: 'again' })).body.skipped, 4);
  // checks on what is saved
  assert.equal((await O('POST', '/api/admin/cw/results', { rows: [{ test: 'Lead', result: 'high', day: '2026-10-01' }] })).status, 400);
  assert.equal((await O('POST', '/api/admin/cw/results', { rows: [{ test: 'Lead', result: '0.01' }] })).status, 400, 'needs a date');
  assert.equal((await O('POST', '/api/admin/cw/results', { rows: [{ test: 'Lead', result: '0.01', day: '2099-01-01' }] })).status, 400);
});

test('Drinking Water Watch rows pasted in, limits, CSV, delete and undo', async () => {
  const paste = ['Analyte Code\tAnalyte Name\tSample Point\tCollection Date\tLess Than Ind.\tResult\tUOM',
    '1040\tNITRATE\tEP001\t11/14/2025\t\t0.48\tMG/L',
    '2950\tTTHM\tDIST\t8/2/2025\t\t24.1\tUG/L',
    '2950\tTTHM\tDIST\t8/5/2024\t\t91\tUG/L'].join('\n');
  const r = await O('POST', '/api/admin/cw/results/read', null, Buffer.from(paste));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.rows.length, 3);
  assert.equal(r.body.rows[1].units, 'µg/L');
  const s = await O('POST', '/api/admin/cw/results', { rows: r.body.rows, source: 'DWW' });
  const tt = s.body.results.filter(x => x.test === 'TTHM');
  assert.deepEqual(tt.map(x => R.over(x, s.body.limits.TTHM)), [true, false], '91 µg/L is over 0.080 mg/L');
  let L = await O('PUT', '/api/admin/cw/results/limit', { test: 'Nitrate', limit: '5', units: 'mg/L' });
  assert.equal(L.body.limits.Nitrate.limit, 5); assert.equal(L.body.limits.Nitrate.own, true);
  assert.equal((await O('PUT', '/api/admin/cw/results/limit', { test: 'Nitrate', limit: 'x' })).status, 400);
  L = await O('PUT', '/api/admin/cw/results/limit', { test: 'Nitrate', reset: true });
  assert.equal(L.body.limits.Nitrate.limit, 10);
  const csv = await O('GET', '/api/admin/cw/results.csv');
  assert.match(csv.body, /"Sample date","Sample point","Test","Result","Units","Limit","Over limit"/);
  assert.match(csv.body, /"2024-08-05","DIST","TTHM","91","µg\/L","0.08 mg\/L","YES"/);
  const one = L.body.results.find(x => x.test === 'Nitrate' && x.day === '2025-11-14');
  assert.equal((await O('DELETE', '/api/admin/cw/results/' + one.id)).body.results.some(x => x.id === one.id), false);
  const batch = L.body.results.find(x => x.source === 'DWW').batch;
  const after = (await O('DELETE', '/api/admin/cw/results/batch/' + batch)).body;
  assert.equal(after.results.filter(x => x.source === 'DWW').length, 0);
  assert.equal(after.results.length, 4);
});

test('a scanned report is read with text recognition', async () => {
  const c = createCanvas(1400, 260), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 1400, 260); g.fillStyle = '#000'; g.font = '30px DejaVu Sans';
  ['Date Collected: 09/02/2026', 'Copper    0.42    mg/L', 'Fluoride    0.71    mg/L'].forEach((l, i) => g.fillText(l, 30, 60 + i * 60));
  const r = await O('POST', '/api/admin/cw/results/read', null, c.toBuffer('image/png'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.how, 'scan');
  const cu = r.body.rows.find(x => x.test === 'Copper');
  assert.ok(cu, JSON.stringify(r.body.rows));
  assert.equal(cu.result, '0.42'); assert.equal(cu.day, '2026-09-02');
});

test('lead and copper notices: the template filled in for each home', async () => {
  const JSZip = require('jszip');
  await O('PUT', '/api/admin/cw/system', { name: 'Water Co', pwsid: 'TN0000912', operator: 'Pat Operator', phone: '(423) 555-0100', email: 'water@example.com' });
  const rows = [['141 Deer Run Pt', 'Lead', '0.0042', 'mg/L'], ['141 Deer Run Pt', 'Copper', '310', 'µg/L'], ['22 Whitetail Ct', 'Lead', 'ND', 'mg/L']]
    .map(([point, test, result, units]) => ({ day: '2026-07-08', point, test, result, units }));
  await O('POST', '/api/admin/cw/results', { rows, source: 'lcr' });
  const rounds = (await O('GET', '/api/admin/cw/results/lcr-rounds')).body.rounds;
  assert.deepEqual(rounds.find(r => r.day === '2026-07-08'), { day: '2026-07-08', taps: 2 });
  const r = await fetch(base + '/api/admin/cw/results/lcr-notices.docx?day=2026-07-08&date=2026-11-23', { headers: { 'x-ch': '1', Cookie: '' } });
  assert.notEqual(r.status, 200, 'needs the login');
  const res = await O('GET', '/api/admin/cw/results/lcr-notices.docx?day=2026-07-08&date=2026-11-23');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-notices'), '2'); assert.equal(res.headers.get('x-missing'), '');
  const zip = await JSZip.loadAsync(res.body);
  const doc = await zip.file('word/document.xml').async('string');
  const text = doc.replace(/<[^>]+>/g, '');
  assert.equal((text.match(/Notification of Results/g) || []).length, 2, 'one notice per home');
  assert.match(text, /Lead\s+0\.0042\s+mg\/L/); assert.match(text, /Copper\s+0\.31\s+mg\/L/, 'µg/L shown in mg/L');
  assert.match(text, /Lead\s+ND\s+mg\/L\s*Copper\s+Not tested/);
  assert.match(text, /Pat Operator/); assert.match(text, /\(423\) 555-0100/); assert.match(text, /water@example\.com/);
  assert.match(text, /There is no safe level of lead in drinking water/, 'the template wording stays');
  const h1 = await zip.file('word/headerNotice1.xml').async('string'), h2 = await zip.file('word/headerNotice2.xml').async('string');
  assert.match(h1.replace(/<[^>]+>/g, ''), /Location: 141 Deer Run Pt.*Date: 11\/23\/2026/);
  assert.match(h2.replace(/<[^>]+>/g, ''), /22 Whitetail Ct/);
  assert.match((await zip.file('word/footer1.xml').async('string')).replace(/<[^>]+>/g, ''), /TN0000912/);
  assert.equal((await O('GET', '/api/admin/cw/results/lcr-notices.docx?day=2001-01-01')).status, 400);
});
