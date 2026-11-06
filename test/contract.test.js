// Contract budget vs actual: read a pricing workbook (Exhibit B layout) and a payroll history workbook (a sheet per
// week + an equipment sheet), match people to lines, expenses, and the yearly view. Made-up numbers only.
process.env.DISABLE_SCHEDULER = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { app } = require('../src/server');
const db = require('../src/db');
const CT = require('../src/contract');

let server, base, O, year;
before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body, raw) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': raw ? 'application/octet-stream' : 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await O('POST', '/api/signup', { company: 'Test Mgmt', name: 'Pat', email: 'boss@example.com', password: 'LongPass1!' });
  year = Number((await db.one("SELECT to_char(now(), 'YYYY') AS y")).y);
});
after(async () => { server.close(); await db.pool.end(); });

const f = (formula, result) => ({ formula, result });
async function pricing() {
  const wb = new ExcelJS.Workbook();
  const ex = wb.addWorksheet('Exec Summary');
  ex.getCell('A8').value = 'Benefits Factor'; ex.getCell('B8').value = 0.01;
  ex.getCell('A10').value = 'Overhead Factor'; ex.getCell('B10').value = 0.1;
  ex.getCell('A12').value = 'Profit Margin'; ex.getCell('B12').value = 0.1;
  ex.getCell('A16').value = 'Contract Value'; ex.getCell('C16').value = f('SUM(C13:C15)', 120000); ex.getCell('D16').value = 123000; ex.getCell('E16').value = 126000;
  const mg = wb.addWorksheet('Management & Supervisory');
  [[2, 3], [12, 13], [22, 23]].forEach(([h, r], y) => {
    mg.getCell(`A${h}`).value = 'Role';
    mg.getCell(`A${r}`).value = 'Community Manager'; mg.getCell(`F${r}`).value = 48000; mg.getCell(`I${r}`).value = f(`H${r}*F${r}`, 48000 * (1 + y * 0.03)); mg.getCell(`J${r}`).value = 'Pat';
    mg.getCell(`A${h + 8}`).value = 'Year 1 Total';
  });
  const gs = wb.addWorksheet('General Staffing');
  [2, 22, 43].forEach((h, y) => {
    gs.getCell(`A${h}`).value = `Year ${y + 1}`; gs.getCell(`A${h + 1}`).value = 'Area/Role'; gs.getCell(`A${h + 2}`).value = 'Office Administration';
    gs.getRow(h + 3).values = ['Office (& Mail Room)', 15, 1, ...Array(12).fill(100), null, null, 'Sam - 23 hours per week'];
    gs.getRow(h + 4).values = ['Guards', 15, 1, ...Array(12).fill(390), null, null, 'Lee 90 hours per week'];
    gs.getCell(`A${h + 6}`).value = 'Totals';
  });
  const eq = wb.addWorksheet('Equipment & Supplies');
  eq.getRow(2).values = ['Equipment/Supply Name', 'Usage', 'Cost Per Unit', 'Units', 'Estimated Cost'];
  eq.getRow(3).values = ['Excavator pay difference', 'Ditches', 30, 100, f('D3*C3', 3000)];
  eq.getRow(4).values = ['Fuel', '', 6000, 1, f('D4*C4', 6000)];
  eq.getCell('A17').value = 'Year 1 Total';
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function payroll() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Master Data Sheet').getCell('A1').value = 'x';
  const eqp = wb.addWorksheet('Davey Road Prep');
  eqp.getRow(2).values = ['Date', 'Total Pay', 'Normal Hourly', 'Diffrence Pay', 'Total Tractor', 'Total excavator'];
  eqp.getRow(3).values = [new Date(Date.UTC(year, 0, 9)), 500, 200, 300, 0, 10];
  const wk = (name, d, rows, withPay) => { const ws = wb.addWorksheet(name); ws.getCell('A1').value = new Date(Date.UTC(year, d[0], d[1])); if (withPay) { ws.getCell('C1').value = 'Extra/ Rembursments'; ws.getCell('F1').value = 'Per Hour'; } rows.forEach((r, i) => { ws.getRow(i + 2).values = r; }); };
  wk('week1', [0, 9], [['Sam Smith', '20', null, 'print from Quickbooks', null, 300], ['Lee Jones', '90', null, 'handwritten Deerfield Management  Check', null, 1350],
    ['Sam Smith', '4', null, 'Handwritten Water Check', null, 60], ['Pat Boss', null, null, 'Direct Deposit ', 'Payroll', 923], ['Lee Jones', null, null, 'Handwritten Mt Cloud check', null, 0]], true);
  wk('week2', [0, 16], [['Sam Smith', '10:30', 'print from Quickbooks'], ['Kim Who', '8', 'Direct Deposit']], false);   // an older layout: hours only
  wk('typo', [0, 23], [], true); wb.getWorksheet('typo').getCell('A1').value = new Date(Date.UTC(1936, 0, 23));
  wb.getWorksheet('typo').getRow(2).values = ['Sam Smith', '2', null, 'print from Quickbooks', null, 30];
  wb.getWorksheet('typo').name = '1232' + year;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('reading the pricing workbook: lines for each year, who, factors, contract value', async () => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await pricing());
  const p = CT.readPricing(wb);
  assert.deepStrictEqual(p.factors, { benefits: 0.01, overhead: 0.1, profit: 0.1 });
  assert.deepStrictEqual(p.value, [120000, 123000, 126000]);
  assert.deepStrictEqual(p.lines.map(l => [l.key, l.name, l.who, l.years[0].amount]), [
    ['mgmt:0', 'Community Manager', 'Pat', 48000], ['staff:0', 'Office (& Mail Room)', 'Sam', 18000], ['staff:1', 'Guards', 'Lee', 70200],
    ['equip:0', 'Excavator pay difference', '', 3000], ['equip:1', 'Fuel', '', 6000]]);
  assert.strictEqual(p.lines[0].years[1].amount, 49440);
  assert.strictEqual(CT.jobOf('Handwritten Wedding Venue'), 'McCloud Venue'); assert.strictEqual(CT.hoursOf('31:30'), 31.5); assert.strictEqual(CT.hoursOf('17 labor 2 tractor'), 17);
});

test('upload both; people matched by name from the pricing; the year at a glance', async () => {
  assert.strictEqual((await O('POST', '/api/admin/contract/pricing', Buffer.from('nope'), true)).status, 400);
  let r = await O('POST', '/api/admin/contract/pricing', await pricing(), true);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.startYear, year);
  r = await O('POST', '/api/admin/contract/payroll', await payroll(), true);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.weeks, 3); assert.strictEqual(r.body.equipment, 1); assert.strictEqual(r.body.estimated, 2);
  const v = r.body;
  assert.strictEqual(v.year, year); assert.strictEqual(v.contractYear, 1); assert.strictEqual(v.value, 120000);
  const line = k => v.rows.find(x => x.key === k);
  // Sam: 300 + 10.5 h x 15 (usual rate) + 30 (the 1936 typo sheet counts in this year)
  assert.strictEqual(line('staff:0').actual, 300 + 157.5 + 30); assert.deepStrictEqual(line('staff:0').people, ['Sam Smith']);
  assert.strictEqual(line('staff:1').actual, 1350);
  assert.strictEqual(line('mgmt:0').actual, 923, 'Pat Boss matched by first name');
  assert.strictEqual(line('equip:0').actual, 300, 'equipment pay on the excavator line');
  assert.strictEqual(line('staff:unassigned').actual, 120, 'Kim: 8 h x $15, not in the pricing');
  assert.deepStrictEqual(v.outside, [{ job: 'Water System', amount: 60, hours: 4 }]);
  const staff = v.cats.find(c => c.key === 'staff');
  assert.strictEqual(staff.loadedActual, Math.round((487.5 + 1350 + 120) * 1.01 * 1.1 * 1.1 * 100) / 100);
  assert.ok(v.goals.find(g => g.label === 'Guards').contractMin === 90);
  assert.ok(v.budgetToDate > 0);
});

test('match a person by hand, leave one out, expenses, other years', async () => {
  let v = (await O('PUT', '/api/admin/contract/settings', { people: { 'Kim Who': 'staff:0' } })).body;
  assert.strictEqual(v.rows.find(x => x.key === 'staff:0').actual, 487.5 + 120);
  assert.ok(!v.rows.find(x => x.key === 'staff:unassigned'));
  v = (await O('PUT', '/api/admin/contract/settings', { people: { 'Kim Who': 'skip' } })).body;
  assert.strictEqual(v.rows.find(x => x.key === 'staff:0').actual, 487.5);
  assert.strictEqual((await O('POST', '/api/admin/contract/expenses', { day: `${year}-02-01`, line: 'nope', amount: 5 })).status, 400);
  v = (await O('POST', '/api/admin/contract/expenses', { day: `${year}-02-01`, line: 'equip:1', amount: '$412.50', note: 'Fuel, Feb' })).body;
  assert.strictEqual(v.rows.find(x => x.key === 'equip:1').actual, 412.5); assert.strictEqual(v.expenses.length, 1);
  v = (await O('DELETE', '/api/admin/contract/expenses/' + v.expenses[0].id)).body;
  assert.strictEqual(v.rows.find(x => x.key === 'equip:1').actual, 0);
  v = (await O('PUT', '/api/admin/contract/settings', { startYear: year + 1 })).body;
  assert.strictEqual(v.contractYear, null); assert.strictEqual(v.value, 0);
  v = (await O('GET', '/api/admin/contract?year=' + (year + 1))).body;
  assert.strictEqual(v.contractYear, 1); assert.strictEqual(v.value, 120000);
  // uploading the history again replaces it
  const again = (await O('POST', '/api/admin/contract/payroll', await payroll(), true)).body;
  assert.strictEqual(again.rows.length >= 1, true);
  assert.strictEqual((await db.one("SELECT count(*)::int AS n FROM contract_actuals WHERE source='history'")).n, 7);
});
