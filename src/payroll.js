// Payroll for a week: each person's hours split into the main job (Deerfield) and each other job (Water System,
// McCloud Venue...), times their rate, plus extras / reimbursements, with how each is paid (QuickBooks, direct
// deposit, a handwritten check from that job). Shown on the Crew week tab and downloaded as Excel.
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const H = require('./hours');

const METHODS = ['Print from QuickBooks', 'Direct Deposit', 'Handwritten check'];
const round2 = n => Math.round(n * 100) / 100;

async function settings(company) {
  const c = await db.one('SELECT payroll, other_options FROM companies WHERE id=$1', [company.id]);
  const p = (c && c.payroll) || {};
  const jobs = {};
  (c.other_options || []).forEach(j => { jobs[j] = (p.jobs && p.jobs[j]) || `Handwritten ${j} check`; });
  const out = { jobs, mainCheck: p.mainCheck || `Handwritten ${(company.main_label || 'main').replace(/\s*time$/i, '')} check` };
  out.methods = [...METHODS.slice(0, 2), out.mainCheck];
  return out;
}

/** The week's payroll. */
async function week(company, weekStart) {
  const w = await H.crewWeek(company, weekStart);
  const set = await settings(company);
  const crew = await db.q('SELECT id, name, active, pay_rate, pay_flat, pay_method FROM crew WHERE company_id=$1 ORDER BY lower(name)', [company.id]);
  const extras = await db.q('SELECT crew_id, job, amount, note FROM payroll_extras WHERE company_id=$1 AND week_start=$2', [company.id, w.weekStart]);
  const main = (company.main_label || 'Main').replace(/\s*time$/i, '') || 'Main';
  const people = [];
  for (const c of crew) {
    const p = w.people.find(x => x.id === c.id);
    const byJob = { '': 0 };
    if (p) Object.values(p.days).forEach(d => {
      const o = Number(d.oHours) || 0, mainH = Math.max(0, (Number(d.total) || 0) - o);   // overlap already taken out of the total
      byJob[''] += mainH;
      if (o) { const j = d.oJob || 'Other'; byJob[j] = (byJob[j] || 0) + o; }
    });
    extras.filter(e => e.crew_id === c.id).forEach(e => { if (byJob[e.job] === undefined) byJob[e.job] = 0; });
    const rate = c.pay_rate != null ? Number(c.pay_rate) : null, flat = c.pay_flat != null ? Number(c.pay_flat) : null;
    const lines = Object.entries(byJob).map(([job, hours]) => {
      hours = round2(hours);
      const ex = extras.find(e => e.crew_id === c.id && e.job === job);
      const extra = ex ? Number(ex.amount) : 0;
      const base = job === '' && flat != null ? flat : rate != null ? round2(hours * rate) : null;
      return { job, label: job || main, hours, extra, note: ex ? ex.note : '', pay: base == null ? null : round2(base + extra),
        method: job === '' ? (c.pay_method || '') : (set.jobs[job] || `Handwritten ${job} check`) };
    }).filter(l => l.hours || l.extra || (l.job === '' && flat != null));
    if (!lines.length && !c.active) continue;
    const hours = round2(lines.reduce((a, l) => a + l.hours, 0));
    const missingRate = lines.some(l => l.pay == null);
    people.push({ id: c.id, name: c.name, active: c.active, rate, flat, method: c.pay_method || '', lines, hours,
      pay: missingRate ? null : round2(lines.reduce((a, l) => a + l.pay, 0)), missingRate });
  }
  // totals by job, and by how it's paid
  const jobs = {};
  people.forEach(p => p.lines.forEach(l => { const j = jobs[l.label] || (jobs[l.label] = { label: l.label, hours: 0, pay: 0 }); j.hours = round2(j.hours + l.hours); j.pay = round2(j.pay + (l.pay || 0)); }));
  const methods = {};
  people.forEach(p => p.lines.forEach(l => { const k = l.method || 'Not set'; methods[k] = round2((methods[k] || 0) + (l.pay || 0)); }));
  return { weekStart: w.weekStart, dates: w.dates, approved: w.approved, main, settings: set, people,
    jobs: [jobs[main], ...Object.values(jobs).filter(j => j.label !== main)].filter(Boolean), methods,
    total: { hours: round2(people.reduce((a, p) => a + p.hours, 0)), pay: round2(people.reduce((a, p) => a + (p.pay || 0), 0)) },
    missingRates: people.filter(p => p.missingRate).map(p => p.name) };
}

const money = (v, what, max = 100000) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < -max || n > max) V.bad(`${what} must be a dollar amount.`);
  return round2(n);
};

/** A person's rate, flat weekly pay and how their main pay goes out. */
async function setPay(company, crewId, b) {
  const c = await db.one('SELECT id FROM crew WHERE id=$1 AND company_id=$2', [crewId, company.id]);
  if (!c) V.bad('That crew member was not found.');
  const rate = money(b.rate, 'The pay rate', 1000), flat = money(b.flat, 'The weekly pay');
  if (rate != null && rate < 0 || flat != null && flat < 0) V.bad("Pay can't be negative.");
  await db.q('UPDATE crew SET pay_rate=$1, pay_flat=$2, pay_method=$3 WHERE id=$4', [rate, flat, String(b.method || '').trim().slice(0, 60), crewId]);
}

/** An extra or reimbursement for one person, one job, one week (empty = remove it). */
async function setExtra(company, b) {
  const ws = H.weekOf(company, String(b.weekStart || ''));
  const c = await db.one('SELECT id FROM crew WHERE id=$1 AND company_id=$2', [Number(b.crewId), company.id]);
  if (!c) V.bad('That crew member was not found.');
  const job = String(b.job || '').slice(0, 80);
  const amount = money(b.amount, 'The extra');
  if (!amount) await db.q('DELETE FROM payroll_extras WHERE company_id=$1 AND week_start=$2 AND crew_id=$3 AND job=$4', [company.id, ws, c.id, job]);
  else await db.q(`INSERT INTO payroll_extras (company_id, week_start, crew_id, job, amount, note) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (company_id, week_start, crew_id, job) DO UPDATE SET amount=$5, note=$6`, [company.id, ws, c.id, job, amount, String(b.note || '').trim().slice(0, 200)]);
  return ws;
}

/** What check each other job is paid with. */
async function saveSettings(company, b) {
  const cur = await settings(company);
  const jobs = {};
  Object.keys(cur.jobs).forEach(j => { const v = b.jobs && b.jobs[j]; jobs[j] = String(v == null ? cur.jobs[j] : v).trim().slice(0, 60) || cur.jobs[j]; });
  await db.q('UPDATE companies SET payroll=$1 WHERE id=$2', [JSON.stringify({ jobs, mainCheck: String(b.mainCheck || cur.mainCheck).slice(0, 60) }), company.id]);
}

/** The week as an Excel file, laid out like the payroll sheet: main job by how it's paid, then each other job, then totals. */
async function xlsx(company, weekStart) {
  const ExcelJS = require('exceljs');
  const P = await week(company, weekStart);
  const wb = new ExcelJS.Workbook(); wb.creator = 'Crew Hours';
  const ws = wb.addWorksheet('Payroll', { views: [{ state: 'frozen', ySplit: 3 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 24 }, { width: 10 }, { width: 16 }, { width: 38 }, { width: 13 }, { width: 3 }, { width: 38 }, { width: 12 }, { width: 13 }];
  const end = T.shift(P.weekStart, 6);
  ws.mergeCells('A1:E1');
  ws.getCell('A1').value = `${company.name} payroll · ${T.pretty(P.weekStart)} – ${T.pretty(end)}, ${end.slice(0, 4)}${P.approved ? '' : '  (week not approved yet)'}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  const head = r => { const row = ws.getRow(r); ['Name', 'Hours', 'Extra / Reimb.', 'Paid by', 'Pay'].forEach((h, i) => { const c = row.getCell(i + 1); c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2328' } }; }); };
  const MONEY = '$#,##0.00', HRS = '0.00';
  let r = 3; head(r); r++;
  const green = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBD9' } };
  const section = (title, rows, color) => {
    if (!rows.length) return;
    const t = ws.getRow(r); t.getCell(1).value = title; t.getCell(1).font = { bold: true, color: { argb: color || 'FF1F2328' } }; r++;
    const first = r;
    rows.forEach(x => {
      const row = ws.getRow(r);
      row.values = [x.name, x.hours, x.extra || null, x.method || '', x.pay];
      row.getCell(2).numFmt = HRS; row.getCell(2).fill = green; row.getCell(3).numFmt = MONEY; row.getCell(5).numFmt = MONEY;
      if (x.pay == null) { row.getCell(5).value = 'Set a rate'; row.getCell(5).font = { color: { argb: 'FFB42318' }, bold: true }; }
      if (color) row.getCell(4).font = { color: { argb: color } };
      if (x.note) row.getCell(3).note = x.note;
      r++;
    });
    const tot = ws.getRow(r);
    tot.getCell(1).value = 'Total'; tot.getCell(1).font = { bold: true };
    tot.getCell(2).value = { formula: `SUM(B${first}:B${r - 1})` }; tot.getCell(2).numFmt = HRS; tot.getCell(2).font = { bold: true };
    tot.getCell(5).value = { formula: `SUM(E${first}:E${r - 1})` }; tot.getCell(5).numFmt = MONEY; tot.getCell(5).font = { bold: true };
    tot.eachCell(c => { c.border = { top: { style: 'thin' } }; });
    r += 2;
  };
  const lineOf = (p, l) => ({ name: p.name, hours: l.hours, extra: l.extra, note: l.note, method: l.method || (l.job === '' ? '' : ''), pay: l.pay });
  // main job: paid on QuickBooks / direct deposit first, then handwritten checks, then anyone not set
  const mainLines = P.people.map(p => { const l = p.lines.find(x => x.job === ''); return l && { p, l }; }).filter(Boolean);
  const hand = x => /hand|check/i.test(x.l.method);
  section(`${P.main}`, mainLines.filter(x => !hand(x)).map(x => lineOf(x.p, x.l)));
  section(`${P.main}: handwritten checks`, mainLines.filter(hand).map(x => lineOf(x.p, x.l)));
  const COLORS = ['FF1F4FD8', 'FFC026D3', 'FF2F7D4F', 'FFB4540A', 'FF6E40C9'];
  const others = [...new Set(P.people.flatMap(p => p.lines.filter(l => l.job !== '').map(l => l.job)))];
  others.forEach((job, i) => section(job, P.people.map(p => { const l = p.lines.find(x => x.job === job); return l && lineOf(p, l); }).filter(Boolean), COLORS[i % COLORS.length]));
  // summary on the right: each person's total, each job's total, by how it's paid
  let s = 3;
  const put = (col, row, v, fmt, bold) => { const c = ws.getCell(`${col}${row}`); c.value = v; if (fmt) c.numFmt = fmt; if (bold) c.font = { bold: true }; return c; };
  ['Names', 'Total hours', 'Total pay'].forEach((h, i) => { const c = put('GHI'[i], s, h, null, true); c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3A008' } }; });
  s++;
  P.people.forEach(p => { put('G', s, p.name); put('H', s, p.hours, HRS); put('I', s, p.pay == null ? 'Set a rate' : p.pay, MONEY); s++; });
  const red = { top: { style: 'medium', color: { argb: 'FFB42318' } }, bottom: { style: 'medium', color: { argb: 'FFB42318' } } };
  put('G', s, 'Total payroll', null, true).border = red; put('H', s, P.total.hours, HRS, true).border = red; put('I', s, P.total.pay, MONEY, true).border = red;
  s += 2;
  put('G', s, 'By job', null, true); put('H', s, 'Hours', null, true); put('I', s, 'Pay', null, true); s++;
  P.jobs.forEach(j => { put('G', s, j.label); put('H', s, j.hours, HRS); put('I', s, j.pay, MONEY); s++; });
  s++;
  put('G', s, 'By how it’s paid', null, true); s++;
  Object.entries(P.methods).forEach(([m, v]) => { put('G', s, m); put('I', s, v, MONEY); s++; });
  if (P.missingRates.length) { s++; put('G', s, 'No pay rate yet: ' + P.missingRates.join(', ')).font = { color: { argb: 'FFB42318' }, bold: true }; }
  // a second sheet with each day, for checking
  const d = wb.addWorksheet('Days');
  d.columns = [{ header: 'Date', width: 12 }, { header: 'Day', width: 6 }, { header: 'Name', width: 22 }, { header: P.main + ' hours', width: 14 }, { header: 'Other job', width: 22 }, { header: 'Other hours', width: 12 }, { header: 'Total', width: 9 }, { header: 'What they did', width: 50 }];
  d.getRow(1).font = { bold: true };
  const wk = await H.crewWeek(company, P.weekStart);
  wk.dates.forEach(dt => wk.people.forEach(p => { const e = p.days[dt]; if (!e) return;
    const o = Number(e.oHours) || 0;
    const row = d.addRow([dt, T.dayName(dt), p.name, round2(Math.max(0, e.total - o)), o ? e.oJob || '' : '', o || null, e.total, [e.summary, e.oSummary].filter(Boolean).join(' / ')]);
    [4, 6, 7].forEach(i => { row.getCell(i).numFmt = HRS; }); }));
  return { name: `payroll-${P.weekStart}.xlsx`, buf: await wb.xlsx.writeBuffer() };
}

module.exports = { week, setPay, setExtra, settings, saveSettings, xlsx, METHODS };
