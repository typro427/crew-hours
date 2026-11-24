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
    ['Sam Smith', '4', null, 'Handwritten Water Check', null, 60], ['Pat Boss', '5', 342, 'Handwritten Real Estate Check', null, 417], ['Pat Boss', null, null, 'Direct Deposit ', 'Payroll', 923], ['Lee Jones', null, null, 'Handwritten Mt Cloud check', null, 0]], true);
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
  assert.deepStrictEqual(v.outside, [{ job: 'Water System', amount: 60, hours: 4 }]);   // Real Estate is left out
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

/* ------------------------------ bank statements ------------------------------ */
const BK = require('../src/bank');
const STATEMENT = `First Fake Bank                                   Page 1 of 2
Account 000123  Statement Period 10/01/2026 through 10/31/2026
Beginning Balance                                            $12,000.00
Deposits and Additions
10/03   HOA ASSESSMENT DEPOSIT                    5,000.00     17,000.00
10/20   INTEREST PAYMENT                              1.25     17,001.25
Electronic Withdrawals
10/05   POS DEBIT LOWES #1234 KNOXVILLE TN          245.17     16,754.83
        BUILDING SUPPLIES
10/09   INTUIT PAYROLL 1234567                    3,100.00     13,654.83
10/12   ONLINE TRANSFER TO SAV 9988                 500.00     13,154.83
10/15   CHECKCARD 1014 PILOT 00412 JELLICO TN       88.40     13,066.43
Checks Paid
1201   10/07   150.00    1202*  10/18   1,200.00
Daily Ending Balance
10/03  17,000.00   10/05  16,754.83
Ending Balance                                               $11,717.68`;

test('bank statement text: deposits, withdrawals, checks, the year, and it adds up', () => {
  const r = BK.fromText(STATEMENT, '2026-11-24');
  assert.deepStrictEqual(r.period, { from: '2026-10-01', to: '2026-10-31' });
  assert.strictEqual(r.opening, 12000); assert.strictEqual(r.closing, 11717.68);
  const by = d => r.txns.find(t => t.desc.includes(d));
  assert.strictEqual(r.txns.length, 8, JSON.stringify(r.txns));
  assert.strictEqual(by('HOA').amount, 5000);
  assert.strictEqual(by('LOWES').amount, -245.17); assert.match(by('LOWES').desc, /BUILDING SUPPLIES/, 'the payee line underneath joins on');
  assert.strictEqual(by('#1202').amount, -1200); assert.strictEqual(by('#1202').day, '2026-10-18'); assert.strictEqual(by('#1201').check, '1201');
  const inn = r.txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0), out = r.txns.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  assert.strictEqual(Math.round((12000 + inn + out) * 100) / 100, 11717.68);
  // a January statement's December dates belong to last year
  const jan = BK.fromText('Statement Period 12/15/2026 - 01/14/2027\nWithdrawals\n12/20 PILOT TRAVEL 40.00\n01/02 LOWES 10.00', '2027-01-20');
  assert.deepStrictEqual(jan.txns.map(t => t.day), ['2026-12-20', '2027-01-02']);
  // where things go by default
  assert.strictEqual(BK.guessLine(by('PAYROLL'), {}).line, 'skip');
  assert.strictEqual(BK.guessLine(by('TRANSFER'), {}).line, 'skip');
  assert.strictEqual(BK.guessLine(by('INTEREST'), {}).line, 'skip');
  assert.strictEqual(BK.guessLine(by('HOA'), {}).line, 'received');
  assert.strictEqual(BK.vendorKey('POS DEBIT LOWES #1234 KNOXVILLE TN'), 'lowes', 'the town and state are left off');
  assert.strictEqual(BK.vendorKey('CHECKCARD 1014 PILOT 00412 JELLICO TN'), 'pilot');
});

test('bank CSV and QFX downloads', () => {
  const csv = BK.fromTable([['Date', 'Description', 'Debit', 'Credit', 'Balance'], ['10/05/2026', 'LOWES #1234', '245.17', '', '100'], ['10/06/2026', 'DEPOSIT', '', '50.00', '150']], '2026-11-01');
  assert.deepStrictEqual(csv.txns.map(t => [t.day, t.amount]), [['2026-10-05', -245.17], ['2026-10-06', 50]]);
  const one = BK.fromTable([['Posting Date', 'Amount', 'Payee', 'Check Number'], ['2026-10-05', '-75.5', 'AT&T', ''], ['2026-10-07', '-150', '', '1201']], '2026-11-01');
  assert.deepStrictEqual(one.txns.map(t => [t.desc, t.amount, t.check]), [['AT&T', -75.5, ''], ['Check #1201', -150, '1201']]);
  const q = BK.fromOfx('OFXHEADER:100\n<OFX><BANKTRANLIST><DTSTART>20261001<DTEND>20261031<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005120000<TRNAMT>-245.17<NAME>LOWES #1234<MEMO>KNOXVILLE</STMTTRN><STMTTRN><TRNTYPE>CHECK<DTPOSTED>20261007<TRNAMT>-150.00<CHECKNUM>1201</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>99.00</LEDGERBAL></OFX>');
  assert.deepStrictEqual(q.txns.map(t => [t.day, t.desc, t.amount]), [['2026-10-05', 'LOWES #1234 KNOXVILLE', -245.17], ['2026-10-07', 'Check #1201', -150]]);
  assert.deepStrictEqual(q.period, { from: '2026-10-01', to: '2026-10-31' });
});

test('upload a statement, sort it, save; it is remembered and never counted twice', async () => {
  await O('PUT', '/api/admin/contract/settings', { startYear: year });
  const csv = Buffer.from(`Date,Description,Amount\n${'03/05/' + year},POS DEBIT LOWES #1234 KNOXVILLE TN,-245.17\n${'03/06/' + year},INTUIT PAYROLL 99,-3100.00\n${'03/08/' + year},HOA ASSESSMENT DEPOSIT,5000.00\n${'03/09/' + year},PILOT 00412 JELLICO TN,-88.40\n`);
  let r = await O('POST', '/api/admin/contract/bank', csv, true);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  let d = r.body;
  assert.strictEqual(d.txns.length, 4); assert.strictEqual(d.moneyIn, 5000); assert.strictEqual(d.moneyOut, 3433.57);
  const t = x => d.txns.find(y => y.desc.includes(x));
  assert.strictEqual(t('PAYROLL').line, 'skip'); assert.strictEqual(t('HOA').line, 'received'); assert.strictEqual(t('LOWES').line, '');
  t('LOWES').line = 'equip:1';   // supplies
  r = await O('POST', '/api/admin/contract/bank/save', { txns: d.txns });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.saved, 2, 'Lowes and the deposit; payroll left out, Pilot not picked');
  assert.strictEqual(r.body.rows.find(x => x.key === 'equip:1').actual, 245.17);
  assert.strictEqual(r.body.received, 5000);
  assert.ok(r.body.expenses.some(x => x.bank && x.line === 'received'));
  // the same statement again: already saved, and Lowes is remembered
  d = (await O('POST', '/api/admin/contract/bank', csv, true)).body;
  assert.ok(t('LOWES').dup && t('HOA').dup); assert.ok(!t('PILOT').dup);
  const next = Buffer.from(`Date,Description,Amount\n${'04/02/' + year},POS DEBIT LOWES #5678 LAFOLLETTE TN,-19.99\n`);
  d = (await O('POST', '/api/admin/contract/bank', next, true)).body;
  assert.strictEqual(d.txns[0].line, 'equip:1'); assert.strictEqual(d.txns[0].why, 'remembered');
  r = await O('POST', '/api/admin/contract/bank/save', { txns: (await O('POST', '/api/admin/contract/bank', csv, true)).body.txns.map(x => ({ ...x, line: x.line || 'equip:1' })) });
  assert.strictEqual(r.body.saved, 1, 'only Pilot is new'); assert.strictEqual(r.body.dups, 2);
  assert.strictEqual(r.body.rows.find(x => x.key === 'equip:1').actual, 333.57);
  // removing a bank line
  const lowes = r.body.expenses.find(x => /LOWES/.test(x.note));
  r = await O('DELETE', '/api/admin/contract/expenses/' + lowes.id);
  assert.strictEqual(r.body.rows.find(x => x.key === 'equip:1').actual, 88.4);
  // nothing readable
  assert.strictEqual((await O('POST', '/api/admin/contract/bank', Buffer.from('hello'), true)).status, 400);
});
