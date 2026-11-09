// The services contract, budget vs actual. The budget comes from the pricing workbook (Exhibit B: management,
// general staffing, sub-contractors, equipment & supplies, and the benefits / overhead / profit factors, for 3 years).
// Actual comes from the payroll history workbook (one sheet per week, plus Davey's equipment pay), from Crew Hours'
// own payroll after that, and from expenses entered by hand. Each person is matched to a budget line.
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const H = require('./hours');

const CATS = { mgmt: 'Management & Supervisory', staff: 'General Staffing', sub: 'Sub-Contractors', equip: 'Equipment & Supplies' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Jobs left out of the contract view entirely (paid separately, nothing to do with the services contract).
const LEFT_OUT = new Set(['Real Estate']);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ------------------------------ reading workbooks ------------------------------ */
async function workbook(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) V.bad('Pick the file first.');
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) V.bad('That should be an Excel file (.xlsx). In Google Sheets: File › Download › Microsoft Excel.');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (e) { V.bad("That file couldn't be opened. Save it as .xlsx and try again."); }
  return wb;
}
/** A cell's value: the saved result for a formula, text for rich text, a date as YYYY-MM-DD. */
function val(cell) {
  let v = cell && cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result !== undefined ? v.result : v.richText ? v.richText.map(t => t.text).join('') : v.text !== undefined ? v.text : v.error ? null : null;
  if (v && typeof v === 'object' && !(v instanceof Date)) v = null;   // a formula error (#REF!)
  return v instanceof Date ? v.toISOString().slice(0, 10) : v;
}
const num = v => { const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
const txt = v => String(v == null ? '' : v).trim();
const sheet = (wb, re) => wb.worksheets.find(w => re.test(w.name));

/** Exhibit B: the pricing model -> budget lines for each contract year. */
function readPricing(wb) {
  const ex = sheet(wb, /exec/i), mg = sheet(wb, /management/i), gs = sheet(wb, /general staff/i), sc = sheet(wb, /sub.?contract/i), eq = sheet(wb, /equipment/i);
  if (!ex || !mg || !gs) V.bad("That doesn't look like the pricing workbook (it needs the Exec Summary, Management & Supervisory and General Staffing sheets).");
  const lines = new Map();   // key -> line
  const add = (key, cat, name, who, y, data) => {
    if (!lines.has(key)) lines.set(key, { key, cat, name, who: who || '', years: [null, null, null] });
    const l = lines.get(key); if (who && !l.who) l.who = who;
    l.years[y] = data;
  };
  const even = a => Array(12).fill(r2(a / 12));
  // management: blocks headed "Role", ended by "Year 1 Total"
  { let y = -1, i = 0;
    for (let r = 1; r <= mg.rowCount; r++) {
      const a = txt(val(mg.getCell(r, 1)));
      if (/^role$/i.test(a)) { y++; i = 0; continue; }
      if (/total/i.test(a) || y < 0 || y > 2 || !a) continue;
      const amount = num(val(mg.getCell(r, 9))) || 0;
      if (!amount) continue;
      add(`mgmt:${i++}`, 'mgmt', a, txt(val(mg.getCell(r, 10))), y, { amount: r2(amount), months: even(amount), rate: num(val(mg.getCell(r, 6))), period: txt(val(mg.getCell(r, 7))) });
    } }
  // general staffing: blocks "Year N", rows until "Totals"; a blank role carries on the one above (the guards)
  { let y = -1, i = 0, role = '';
    for (let r = 1; r <= gs.rowCount; r++) {
      const a = txt(val(gs.getCell(r, 1)));
      const m = /^year\s*(\d)/i.exec(a);
      if (m) { y = Number(m[1]) - 1; i = 0; role = ''; continue; }
      if (y < 0 || y > 2 || /^area|^totals?$/i.test(a)) continue;
      const rate = num(val(gs.getCell(r, 2))), fte = num(val(gs.getCell(r, 3))) || 1;
      const hours = Array.from({ length: 12 }, (_, k) => num(val(gs.getCell(r, 4 + k))) || 0);
      if (a) role = a;
      if (!rate || !hours.some(Boolean)) continue;   // a heading (Office Administration) or an empty row
      const note = txt(val(gs.getCell(r, 18)));
      const who = (/^([A-Z][a-z]+)\s*(?:[-–]|\d)/.exec(note) || [])[1] || '';   // "Linda - 32 hours...", "Jerry 40 hours..."
      add(`staff:${i++}`, 'staff', role, who, y, { amount: r2(hours.reduce((s, h) => s + h, 0) * rate * fte), months: hours.map(h => r2(h * rate * fte)), rate: r2(rate), fte, hours: hours.map(h => r2(h * fte)), note });
    } }
  // sub-contractors: blocks headed "Contractor Name"
  if (sc) { let y = -1, i = 0;
    for (let r = 1; r <= sc.rowCount; r++) {
      const a = txt(val(sc.getCell(r, 1)));
      if (/^contractor name/i.test(a)) { y++; i = 0; continue; }
      if (y < 0 || y > 2 || !a || /total/i.test(a)) continue;
      const rate = num(val(sc.getCell(r, 4))) || 0, units = Array.from({ length: 12 }, (_, k) => num(val(sc.getCell(r, 5 + k))) || 0);
      const cost = num(val(sc.getCell(r, 20))) || units.reduce((s, u) => s + u, 0) * rate;
      if (!cost) continue;
      add(`sub:${i++}`, 'sub', `${a}${txt(val(sc.getCell(r, 2))) ? ': ' + txt(val(sc.getCell(r, 2))) : ''}`, a, y, { amount: r2(cost), months: units.map(u => r2(u * rate)), rate, hours: units });
    } }
  // equipment & supplies: blocks ended by "Year N Total"
  if (eq) { let y = 0, i = 0;
    for (let r = 1; r <= eq.rowCount; r++) {
      const a = txt(val(eq.getCell(r, 1)));
      if (/^year\s*\d\s*total/i.test(a)) { y++; i = 0; continue; }
      if (y > 2 || !a || /supply name|^equipment/i.test(a)) continue;
      const cost = num(val(eq.getCell(r, 5))) || 0;
      if (!cost) continue;
      add(`equip:${i++}`, 'equip', a, '', y, { amount: r2(cost), months: even(cost), rate: num(val(eq.getCell(r, 3))), units: num(val(eq.getCell(r, 4))), note: txt(val(eq.getCell(r, 2))) });
    } }
  // the factors, and the contract value each year as the workbook has it
  const rows = {};
  for (let r = 1; r <= ex.rowCount; r++) { const a = norm(val(ex.getCell(r, 1))); if (a) rows[a] = r; }
  const f = k => { const r = Object.keys(rows).find(x => x.startsWith(k)); return r ? num(val(ex.getCell(rows[r], 2))) || 0 : 0; };
  const valueRow = Object.keys(rows).find(x => x.startsWith('contract value'));
  const value = valueRow ? [3, 4, 5].map(c => r2(num(val(ex.getCell(rows[valueRow], c))) || 0)) : null;
  const out = { factors: { benefits: f('benefits'), overhead: f('overhead'), profit: f('profit') }, lines: [...lines.values()], value };
  if (!out.lines.length) V.bad('No budget lines were found in that workbook.');
  return out;
}

/** What a payroll line was paid for, from how it was paid ("Handwritten Water Check" -> Water System). */
function jobOf(method) {
  const m = norm(method);
  if (/water/.test(m)) return 'Water System';
  if (/mt ?cloud|mc ?cloud/.test(m)) return 'MtCloud';
  if (/wedding/.test(m)) return 'McCloud Venue';
  if (/dock/.test(m)) return 'Dock';
  if (/real estate/.test(m)) return 'Real Estate';
  if (/restaurant/.test(m)) return 'Restaurant';
  return 'Deerfield';
}
/** "30", "31:29" (hours:minutes), "16.5", "17 labor 2 tractor" -> hours (the first number), or null. */
function hoursOf(v) {
  if (typeof v === 'number') return v;
  const s = txt(v);
  let m = /^(\d+):(\d{1,2})$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2]) / 60;
  m = /^(\d*\.?\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

/** The payroll workbook: each week's sheet (date in A1; name, hours, [extra], paid by, ..., pay) and Davey's equipment sheet. */
function readPayroll(wb) {
  const rows = [], equip = [];
  for (const ws of wb.worksheets) {
    const name = ws.name;
    if (/copy of|master/i.test(name)) continue;
    if (/road prep|davey/i.test(name)) {   // equipment: the extra pay for running the tractor / excavator / dump truck
      for (let r = 1; r <= ws.rowCount; r++) {
        const d = val(ws.getCell(r, 1)), diff = num(val(ws.getCell(r, 4)));
        if (typeof d === 'string' && T.isDate(d) && diff) equip.push({ day: d, amount: r2(diff), tractor: num(val(ws.getCell(r, 5))) || 0, excavator: num(val(ws.getCell(r, 6))) || 0, truck: num(val(ws.getCell(r, 7))) || 0 });
      }
      continue;
    }
    let day = val(ws.getCell(1, 1));
    if (!(typeof day === 'string' && T.isDate(day))) continue;
    const ny = (/(20\d\d)$/.exec(name.replace(/\D/g, '')) || [])[1];
    if (ny && day.slice(0, 4) !== ny && Math.abs(Number(day.slice(0, 4)) - Number(ny)) > 1) day = ny + day.slice(4);   // a typo in the year (1936)
    // where the columns are: "paid by" is the column with QuickBooks / Deposit / Check in it; pay is the "Per Hour" column
    let methodCol = 0, payCol = 0, extraCol = 0;
    for (let c = 2; c <= 7; c++) {
      const h = norm(val(ws.getCell(1, c)));
      if (/per hour/.test(h)) payCol = c;
      if (/extra|remb|reimb/.test(h)) extraCol = c;
    }
    for (let c = 2; c <= 5 && !methodCol; c++) for (let r = 2; r <= Math.min(ws.rowCount, 12); r++) if (/quickbooks|deposit|check/i.test(txt(val(ws.getCell(r, c))))) { methodCol = c; break; }
    if (!methodCol) continue;
    for (let r = 2; r <= ws.rowCount; r++) {
      const who = txt(val(ws.getCell(r, 1))), method = txt(val(ws.getCell(r, methodCol)));
      if (!who || !method || /total|names/i.test(who)) continue;
      const hours = hoursOf(val(ws.getCell(r, 2)));
      const pay = payCol ? num(val(ws.getCell(r, payCol))) : null;
      const extra = extraCol ? num(val(ws.getCell(r, extraCol))) : null;
      if (!hours && !pay) continue;
      rows.push({ day, person: who.replace(/\s+/g, ' '), job: jobOf(method), method, hours: hours != null ? r2(hours) : null, amount: pay != null ? r2(pay) : null, extra: extra || 0, sheet: name });
    }
  }
  if (!rows.length && !equip.length) V.bad('No weekly payroll sheets were found. Each week should be its own sheet with the date in the top-left cell.');
  // older weeks have hours but no pay: use that person's usual rate from weeks that have both
  const rate = {};
  rows.filter(x => x.amount && x.hours && !x.extra && x.job === 'Deerfield').forEach(x => { const k = norm(x.person); (rate[k] = rate[k] || []).push(x.amount / x.hours); });
  const usual = k => { const a = (rate[k] || []).filter(v => v >= 10 && v <= 60).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : 15; };
  rows.forEach(x => { if (x.amount == null && x.hours) { x.amount = r2(x.hours * usual(norm(x.person))); x.est = true; } });
  return { rows: rows.filter(x => x.amount && !LEFT_OUT.has(x.job)), equip };
}

/* ------------------------------ saved settings ------------------------------ */
async function get(company) {
  const c = await db.one('SELECT contract FROM companies WHERE id=$1', [company.id]);
  return (c && c.contract) || {};
}
async function put(company, obj) { await db.q('UPDATE companies SET contract=$1 WHERE id=$2', [JSON.stringify(obj), company.id]); }

async function importPricing(company, buf) {
  const p = readPricing(await workbook(buf));
  const cur = await get(company);
  await put(company, { ...cur, ...p, startYear: cur.startYear || Number(H.today(company).slice(0, 4)), pricingAt: new Date().toISOString() });
  return view(company);
}

async function importPayroll(company, buf) {
  const { rows, equip } = readPayroll(await workbook(buf));
  await db.tx(async t => {
    await t.q("DELETE FROM contract_actuals WHERE company_id=$1 AND source IN ('history', 'equipment')", [company.id]);
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400), args = [company.id];
      const v = chunk.map((x, k) => { args.push(x.day, x.person, x.job, x.hours, x.amount, x.method, !!x.est); const n = k * 7 + 2; return `($1,$${n},'history',$${n + 1},$${n + 2},$${n + 3},$${n + 4},$${n + 5},$${n + 6})`; });
      await t.q(`INSERT INTO contract_actuals (company_id, day, source, person, job, hours, amount, note, est) VALUES ${v.join(',')}`, args);
    }
    for (const e of equip) {
      const hrs = e.tractor + e.excavator, ex = hrs ? r2(e.amount * e.excavator / hrs) : e.amount;
      const note = [e.tractor && `${e.tractor} h tractor`, e.excavator && `${e.excavator} h excavator`, e.truck && `${e.truck} dump truck loads`].filter(Boolean).join(', ');
      for (const [hint, amount, h] of [['excavator', ex, e.excavator], ['tractor', r2(e.amount - ex), e.tractor]]) if (amount)
        await t.q(`INSERT INTO contract_actuals (company_id, day, source, person, job, hours, amount, note, line_hint) VALUES ($1,$2,'equipment','Davey','Deerfield',$3,$4,$5,$6)`, [company.id, e.day, h, amount, note, hint]);
    }
  });
  const cur = await get(company);
  await put(company, { ...cur, payrollAt: new Date().toISOString() });
  const days = rows.map(x => x.day).sort();
  return { weeks: new Set(days).size, rows: rows.length, equipment: equip.length, from: days[0], to: days[days.length - 1], estimated: rows.filter(x => x.est).length, ...(await view(company)) };
}

async function settings(company, b) {
  const cur = await get(company);
  const out = { ...cur };
  if (b.startYear !== undefined) out.startYear = V.int(b.startYear, 'The first contract year', 2000, 2100);
  if (b.people !== undefined) {   // person -> budget line key ('' = not in the contract budget, 'skip' = leave out)
    const keys = new Set((cur.lines || []).map(l => l.key));
    out.people = { ...(cur.people || {}) };   // only the people sent change; '' goes back to the guess
    Object.entries(b.people || {}).forEach(([p, k]) => { if (keys.has(k) || k === 'skip' || k === 'none') out.people[norm(p)] = k; else if (!k) delete out.people[norm(p)]; });
  }
  await put(company, out);
  return view(company);
}

async function addExpense(company, b) {
  const cur = await get(company);
  const day = String(b.day || '');
  if (!T.isDate(day)) V.bad('Pick the date.');
  const amount = num(b.amount);
  if (amount == null || amount === 0 || Math.abs(amount) > 1e7) V.bad('Enter the amount.');
  const line = String(b.line || '');
  if (!(cur.lines || []).some(l => l.key === line)) V.bad('Pick the budget line it goes against.');
  await db.q("INSERT INTO contract_actuals (company_id, day, source, person, job, amount, note, line_key) VALUES ($1,$2,'manual','', 'Deerfield',$3,$4,$5)",
    [company.id, day, r2(amount), txt(b.note).slice(0, 200), line]);
  return view(company, Number(day.slice(0, 4)));
}
async function removeExpense(company, id) {
  await db.q("DELETE FROM contract_actuals WHERE id=$1 AND company_id=$2 AND source='manual'", [id, company.id]);
  return view(company);
}

/* ------------------------------ the numbers ------------------------------ */
/** Best guess of a person's budget line: the line names them ("Linda - 32 hours...", "Scott"). */
function guess(lines, person, firsts) {
  const first = norm(person).split(' ')[0];
  if (firsts && firsts[first] > 1) return '';   // two Tylers: pick by hand
  const byFirst = lines.filter(l => l.who && norm(l.who).split(' ')[0] === first);
  return byFirst.length === 1 ? byFirst[0].key : '';
}

/** Crew Hours' own payroll, for the weeks after the payroll history ends. */
async function livePayroll(company, after, until) {
  const PY = require('./payroll');
  const out = [];
  let ws = H.weekOf(company, T.shift(after, 1));
  if (ws <= after) ws = T.shift(ws, 7);
  for (; ws <= until; ws = T.shift(ws, 7)) {
    const p = await PY.week(company, ws);
    const payDay = T.shift(ws, 6);
    p.people.forEach(x => x.lines.forEach(l => { if (l.pay) out.push({ day: payDay, source: 'crew', person: x.name, job: l.job === '' ? 'Deerfield' : l.job, hours: l.hours, amount: l.pay }); }));
  }
  return out;
}

async function view(company, yearIn) {
  const c = await get(company);
  const today = H.today(company);
  const lines = c.lines || [];
  const start = c.startYear || Number(today.slice(0, 4));
  const hist = await db.q("SELECT id, to_char(day,'YYYY-MM-DD') AS day, source, person, job, hours::float, amount::float, note, est, line_key, line_hint FROM contract_actuals WHERE company_id=$1 ORDER BY day", [company.id]);
  const lastHist = hist.filter(h => h.source === 'history').map(h => h.day).sort().pop();
  const live = lastHist || lines.length ? await livePayroll(company, lastHist || `${start - 1}-12-31`, today).catch(() => []) : [];
  const all = [...hist, ...live].filter(a => !LEFT_OUT.has(a.job));
  const years = [...new Set([start, start + 1, start + 2, ...all.map(a => Number(a.day.slice(0, 4)))])].filter(y => y >= start - 2).sort();
  const year = yearIn && years.includes(Number(yearIn)) ? Number(yearIn) : years.includes(Number(today.slice(0, 4))) ? Number(today.slice(0, 4)) : years[0];
  const yi = year - start;   // which contract year (0..2), if any
  const people = c.people || {};
  const firsts = {};
  [...new Set(all.filter(a => a.person).map(a => norm(a.person)))].forEach(p => { const f0 = p.split(' ')[0]; firsts[f0] = (firsts[f0] || 0) + 1; });
  const lineOf = a => {
    if (a.line_key) return a.line_key;
    if (a.line_hint) return (lines.find(l => l.cat === 'equip' && new RegExp(a.line_hint, 'i').test(l.name)) || lines.find(l => l.cat === 'equip' && /excavator|tractor/i.test(l.name)) || {}).key || 'equip:other';
    const k = people[norm(a.person)];
    if (k !== undefined) return k === 'none' ? 'staff:unassigned' : k;
    return guess(lines, a.person, firsts) || 'staff:unassigned';
  };
  const inYear = all.filter(a => a.day.slice(0, 4) === String(year));
  const deer = inYear.filter(a => a.job === 'Deerfield' && lineOf(a) !== 'skip');
  // months of the year that have passed (this month counts by how far into it we are)
  const curY = Number(today.slice(0, 4)), curM = Number(today.slice(5, 7)) - 1;
  const dim = new Date(Date.UTC(curY, curM + 1, 0)).getUTCDate();
  const elapsed = year < curY ? 12 : year > curY ? 0 : curM + Number(today.slice(8, 10)) / dim;
  const sumTo = (arr, upto) => arr.reduce((s, v, i) => s + (i < Math.floor(upto) ? v : i === Math.floor(upto) ? v * (upto - Math.floor(upto)) : 0), 0);
  // each budget line: budget (year, to date), actual to date, by month
  const rows = lines.map(l => {
    const b = yi >= 0 && yi <= 2 ? l.years[yi] : null;
    const acts = deer.filter(a => lineOf(a) === l.key);
    const months = Array(12).fill(0); acts.forEach(a => { months[Number(a.day.slice(5, 7)) - 1] += a.amount; });
    const hours = acts.reduce((s, a) => s + (a.hours || 0), 0);
    return { key: l.key, cat: l.cat, name: l.name, who: l.who, budget: b ? b.amount : 0, budgetToDate: b ? r2(sumTo(b.months, elapsed)) : 0, budgetMonths: b ? b.months : Array(12).fill(0),
      budgetHours: b && b.hours ? r2(b.hours.reduce((s, h) => s + h, 0)) : null, rate: b ? b.rate : null,
      actual: r2(acts.reduce((s, a) => s + a.amount, 0)), hours: r2(hours), months: months.map(r2), people: [...new Set(acts.map(a => a.person))] };
  });
  // money that didn't match a line
  const extra = [['staff:unassigned', 'staff', 'Not matched to a budget line'], ['equip:other', 'equip', 'Equipment (no matching line)']].map(([key, cat, name]) => {
    const acts = deer.filter(a => lineOf(a) === key);
    if (!acts.length) return null;
    const months = Array(12).fill(0); acts.forEach(a => { months[Number(a.day.slice(5, 7)) - 1] += a.amount; });
    return { key, cat, name, who: '', budget: 0, budgetToDate: 0, budgetMonths: Array(12).fill(0), budgetHours: null, actual: r2(acts.reduce((s, a) => s + a.amount, 0)), hours: r2(acts.reduce((s, a) => s + (a.hours || 0), 0)), months: months.map(r2), people: [...new Set(acts.map(a => a.person))], unmatched: true };
  }).filter(Boolean);
  const all2 = [...rows, ...extra];
  const f = c.factors || { benefits: 0, overhead: 0, profit: 0 };
  const load = x => x * (1 + f.benefits) * (1 + f.overhead) * (1 + f.profit);   // cost-plus: staffing gets benefits, overhead and profit
  const cats = Object.entries(CATS).map(([k, label]) => {
    const rs = all2.filter(r => r.cat === k);
    const s = key => r2(rs.reduce((a, r) => a + r[key], 0));
    const staffing = k === 'mgmt' || k === 'staff';
    return { key: k, label, budget: s('budget'), budgetToDate: s('budgetToDate'), actual: s('actual'), loadedBudget: r2(staffing ? load(s('budget')) : s('budget')),
      loadedBudgetToDate: r2(staffing ? load(s('budgetToDate')) : s('budgetToDate')), loadedActual: r2(staffing ? load(s('actual')) : s('actual')),
      months: Array.from({ length: 12 }, (_, i) => r2(rs.reduce((a, r) => a + r.months[i], 0))), budgetMonths: Array.from({ length: 12 }, (_, i) => r2(rs.reduce((a, r) => a + r.budgetMonths[i], 0))) };
  });
  const tot = key => r2(cats.reduce((a, x) => a + x[key], 0));
  const value = c.value && yi >= 0 && yi <= 2 ? c.value[yi] : tot('loadedBudget');
  const spent = tot('loadedActual');
  const projected = elapsed > 0.5 && elapsed < 12 ? r2(spent / elapsed * 12) : spent;
  // weekly hours goals: guards (the contract says at least 90 a week) and the office
  const weeks = Math.max(1, Math.round(elapsed * 52 / 12 * 10) / 10);
  const group = re => { const rs = rows.filter(r => r.cat === 'staff' && re.test(r.name)); return rs.length ? { hours: r2(rs.reduce((a, r) => a + r.hours, 0)), budgetHours: r2(rs.reduce((a, r) => a + (r.budgetHours || 0), 0)) } : null; };
  const goals = [['Guards', /guard/i, 90], ['Office', /office/i, 48]].map(([label, re, min]) => { const g = group(re); return g && { label, perWeek: r2(g.hours / weeks), budgetPerWeek: r2(g.budgetHours / 52), contractMin: label === 'Guards' ? min : null }; }).filter(Boolean);
  // work paid for other jobs (not part of this contract)
  const outside = {};
  inYear.filter(a => a.job !== 'Deerfield').forEach(a => { const o = outside[a.job] || (outside[a.job] = { job: a.job, amount: 0, hours: 0 }); o.amount = r2(o.amount + a.amount); o.hours = r2(o.hours + (a.hours || 0)); });
  // everyone paid this year and the line they count against
  const ppl = {};
  inYear.filter(a => a.source !== 'manual' && a.source !== 'equipment').forEach(a => { const k = norm(a.person); const p = ppl[k] || (ppl[k] = { person: a.person, deerfield: 0, other: 0 }); if (a.job === 'Deerfield') p.deerfield = r2(p.deerfield + a.amount); else p.other = r2(p.other + a.amount); });
  Object.values(ppl).forEach(p => { const k = norm(p.person); p.line = people[k] !== undefined ? people[k] : guess(lines, p.person, firsts); p.guessed = people[k] === undefined; });
  return {
    year, years, startYear: start, contractYear: yi >= 0 && yi <= 2 ? yi + 1 : null, today, elapsed: r2(elapsed), factors: f,
    value, spent, projected, budgetToDate: tot('loadedBudgetToDate'), cats, rows: all2,
    months: MONTHS, goals, outside: Object.values(outside).sort((a, b) => b.amount - a.amount),
    people: Object.values(ppl).sort((a, b) => b.deerfield - a.deerfield),
    lines: lines.map(l => ({ key: l.key, cat: l.cat, name: l.name, who: l.who })),
    expenses: hist.filter(h => h.source === 'manual' && h.day.slice(0, 4) === String(year)).map(h => ({ id: h.id, day: h.day, amount: h.amount, note: h.note, line: h.line_key })),
    estimated: inYear.filter(a => a.est).length,
    sources: { pricingAt: c.pricingAt || null, payrollAt: c.payrollAt || null, historyTo: lastHist || null, liveWeeks: new Set(live.map(l => l.day)).size },
    hasBudget: !!lines.length
  };
}

module.exports = { readPricing, readPayroll, importPricing, importPayroll, settings, addExpense, removeExpense, view, jobOf, hoursOf, CATS };
