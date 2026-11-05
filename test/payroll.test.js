// Payroll: hours split into the main job and each other job, at each person's rate, extras, how each is paid,
// a flat weekly amount, and the Excel download.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app } = require('../src/server');
const db = require('../src/db');

let server, base, O, ids, ws;
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
    return { status: r.status, type, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  await O('POST', '/api/signup', { company: 'Deerfield', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' });
  await db.q(`UPDATE companies SET main_label='Deerfield Time', other_options='["Water System","McCloud Venue","MtCloud Maintenance"]', week_start=4`);
  for (const [n, pin] of [['James Partin', '1111'], ['JT Fontana', '2222'], ['Tyler Proffitt', '3333']]) await O('POST', '/api/admin/crew', { name: n, pin });
  ids = Object.fromEntries((await O('GET', '/api/admin/crew')).body.crew.map(c => [c.name, c.id]));
  ws = '2026-10-29';   // a Thursday
  const c = (await db.one('SELECT id FROM companies')).id;
  const day = async (who, d, h, oJob, oH) => db.q(`INSERT INTO entries (company_id, crew_id, day, start_t, end_t, hours, o_job, o_start, o_end, o_hours, summary)
    VALUES ($1,$2,$3,'07:00',$4,$5,$6,$7,$8,$9,'work')`, [c, ids[who], d, h === 8 ? '15:00' : '13:00', h, oJob || '', oJob ? '16:00' : '', oJob ? (oH === 2 ? '18:00' : '17:30') : '', oH || 0]);
  await day('James Partin', '2026-10-29', 8, 'Water System', 2);
  await day('James Partin', '2026-10-30', 8, 'Water System', 1.5);
  await day('James Partin', '2026-11-02', 6);
  await day('JT Fontana', '2026-10-29', 8, 'McCloud Venue', 2);
  await day('Tyler Proffitt', '2026-10-31', 6, 'Water System', 2);
});
after(async () => { server.close(); await db.pool.end(); });

test('hours split by job; no rate yet says so', async () => {
  const p = (await O('GET', '/api/admin/payroll?start=' + ws)).body;
  assert.strictEqual(p.weekStart, ws); assert.strictEqual(p.main, 'Deerfield');
  const james = p.people.find(x => x.name === 'James Partin');
  assert.deepStrictEqual(james.lines.map(l => [l.label, l.hours]), [['Deerfield', 22], ['Water System', 3.5]]);
  assert.strictEqual(james.pay, null); assert.ok(p.missingRates.includes('James Partin'));
  assert.strictEqual(james.lines[1].method, 'Handwritten Water System check');
});

test('rates, how it is paid, extras, a flat weekly amount; totals by job and by method', async () => {
  await O('PUT', '/api/admin/payroll/pay/' + ids['James Partin'], { rate: '20', method: 'Direct Deposit' });
  await O('PUT', '/api/admin/payroll/pay/' + ids['JT Fontana'], { rate: '$16.00', method: 'Handwritten Deerfield Management check' });
  await O('PUT', '/api/admin/payroll/pay/' + ids['Tyler Proffitt'], { rate: '15', flat: '603', method: 'Direct Deposit' });
  assert.strictEqual((await O('PUT', '/api/admin/payroll/pay/' + ids['JT Fontana'], { rate: 'lots' })).status, 400);
  await O('PUT', '/api/admin/payroll/settings', { weekStart: ws, jobs: { 'Water System': 'Handwritten Water Check', 'McCloud Venue': 'Handwritten Wedding Venue' } });
  let p = (await O('PUT', '/api/admin/payroll/extra', { weekStart: ws, crewId: ids['Tyler Proffitt'], job: '', amount: '96.09', note: 'Gas' })).body;
  const t = p.people.find(x => x.name === 'Tyler Proffitt');
  assert.deepStrictEqual(t.lines.map(l => [l.label, l.hours, l.extra, l.pay, l.method]), [['Deerfield', 6, 96.09, 699.09, 'Direct Deposit'], ['Water System', 2, 0, 30, 'Handwritten Water Check']]);
  const j = p.people.find(x => x.name === 'James Partin');
  assert.strictEqual(j.pay, 22 * 20 + 3.5 * 20);
  assert.strictEqual(p.people.find(x => x.name === 'JT Fontana').lines[1].method, 'Handwritten Wedding Venue');
  assert.deepStrictEqual(p.jobs.map(x => [x.label, x.hours, x.pay]), [['Deerfield', 36, 1267.09], ['Water System', 5.5, 70 + 30], ['McCloud Venue', 2, 32]]);
  assert.strictEqual(p.methods['Handwritten Water Check'], 100);
  assert.strictEqual(p.total.pay, 1399.09); assert.deepStrictEqual(p.missingRates, []);
  // remove the extra
  p = (await O('PUT', '/api/admin/payroll/extra', { weekStart: ws, crewId: ids['Tyler Proffitt'], job: '', amount: '' })).body;
  assert.strictEqual(p.people.find(x => x.name === 'Tyler Proffitt').lines[0].pay, 603);
});

test('the Excel download', async () => {
  const r = await O('GET', '/api/admin/payroll.xlsx?start=' + ws);
  assert.strictEqual(r.status, 200); assert.match(r.type, /spreadsheetml/);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
  const sh = wb.getWorksheet('Payroll');
  const text = []; sh.eachRow(row => text.push(row.values.slice(1).map(v => (v && v.formula ? '=' : v == null ? '' : String(v))).join('|')));
  const all = text.join('\n');
  assert.match(all, /Deerfield payroll · Oct 29 – Nov 4, 2026/);
  assert.match(all, /James Partin\|22\|\|Direct Deposit\|440/);
  assert.match(all, /Deerfield: handwritten checks/); assert.match(all, /JT Fontana\|8\|\|Handwritten Deerfield Management check\|128/);
  assert.match(all, /Water System[^\n]*\nJames Partin\|3\.5\|\|Handwritten Water Check\|70/);
  assert.match(all, /Total payroll\|43\.5\|1303/);
  assert.ok(wb.getWorksheet('Days').rowCount >= 6);
});
