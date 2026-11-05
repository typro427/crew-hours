// Import a sampling schedule: an Excel or CSV file, or rows copied out of a spreadsheet. Columns are found by their
// headings (sample / contaminant / analyte, frequency, last sampled, next due, notes); with no headings the order is
// name, how often, last sampled, notes. First read() shows what would change; apply() makes the change.
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const H = require('./hours');

const MAX_ROWS = 200;

/* ------------------------------- reading the file ------------------------------- */
function csvRows(text) {
  const tab = (text.split('\n')[0] || '').includes('\t') || (!text.includes(',') && text.includes('\t'));
  if (tab) return text.split(/\r?\n/).map(l => l.split('\t').map(c => c.trim()));
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}
async function xlsxRows(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (e) { V.bad("That file couldn't be opened. Save it as .xlsx or .csv and try again."); }
  // the sheet that looks most like a schedule
  let best = null;
  wb.eachSheet(ws => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, r => {
      const vals = [];
      r.eachCell({ includeEmpty: true }, (c, n) => {
        let v = c.value;
        if (v && typeof v === 'object') v = v instanceof Date ? v : v.result !== undefined ? v.result : v.richText ? v.richText.map(t => t.text).join('') : v.text || '';
        vals[n - 1] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v).trim();
      });
      rows.push(Array.from(vals, x => x || ''));
    });
    const score = rows.slice(0, 15).filter(r => r.some(c => NAME.test(c)) && r.some(c => FREQ.test(c) || DATE.test(c))).length * 1000 + rows.length;
    if (!best || score > best.score) best = { score, rows };
  });
  return best ? best.rows : [];
}

/* ------------------------------- understanding it ------------------------------- */
const NAME = /analyte|contaminant|sample|parameter|test\b|^name$|description|monitoring|constituent/i;
const FREQ = /freq|how often|schedule|interval|period|per\b/i;
const LAST = /last|collected|sampled|most recent|previous|date taken/i;
const NEXT = /next|due|deadline/i;
const NOTE = /note|comment|remark|requirement|location|site|point|method/i;
const COUNT = /^(no\.?|number|#|count)\b.*|samples (required|needed)|# ?of samples/i;
const DATE = /date/i;

/** "Monthly", "1/quarter", "every 3 years", "annually", "triennial", "1 per 6 yrs" -> months. */
function months(text) {
  const s = String(text || '').toLowerCase().replace(/[()]/g, ' ').trim();
  if (!s) return null;
  const words = { monthly: 1, month: 1, quarterly: 3, quarter: 3, semiannual: 6, 'semi-annual': 6, 'semi annual': 6, biannual: 6, 'twice a year': 6, annual: 12, annually: 12, yearly: 12, year: 12,
    biennial: 24, biennially: 24, triennial: 36, triennially: 36, weekly: 0.25, daily: 1 / 30 };
  const U = { year: 12, yr: 12, y: 12, month: 1, mo: 1, quarter: 3, qtr: 3, q: 3 };
  // "2x per year", "4 times a year", "4/yr": that many in each period
  let c = /(\d+)\s*(?:x|times)\s*(?:a|per|each|\/)?\s*(year|yr|y|month|mo|quarter|qtr|q)\b/.exec(s) || /(\d+)\s*\/\s*(year|yr|y|month|mo|quarter|qtr|q)\b/.exec(s);
  if (c) return Math.max(1, Math.round(U[c[2]] / Number(c[1])));
  let m = /(?:every|per|\/|once (?:a|per|every))\s*(\d+(?:\.\d+)?)?\s*(day|week|month|mo|quarter|qtr|q|year|yr|y)s?\b/.exec(s) || /^(\d+(?:\.\d+)?)\s*(day|week|month|mo|quarter|qtr|q|year|yr|y)s?\b/.exec(s);
  if (m) {
    const n = Number(m[1] || 1), u = m[2];
    const unit = /^(day)/.test(u) ? 1 / 30 : /^week/.test(u) ? 0.25 : /^(month|mo)/.test(u) ? 1 : /^(quarter|qtr|q)$/.test(u) ? 3 : 12;
    return Math.max(1, Math.round(n * unit));
  }
  for (const [w, v] of Object.entries(words).sort((a, b) => b[0].length - a[0].length)) if (s.includes(w)) return Math.max(1, Math.round(v));
  m = /\b(\d+)\s*(?:yrs?|years?)\b/.exec(s); if (m) return Number(m[1]) * 12;
  return null;
}

/** 2025-11-03, 11/3/2025, 11/3/25, Nov 3 2025, 11/2025 -> YYYY-MM-DD. */
function dateOf(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) return ok(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return ok(+m[2], +m[1], 1);
  const d = new Date(s);
  if (/[a-z]/i.test(s) && !isNaN(d)) return ok(d.getFullYear(), d.getMonth() + 1, /\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-z]{3}/i.test(s) ? d.getDate() : 1);
  if (/^\d{5}$/.test(s)) { const x = new Date(Date.UTC(1899, 11, 30) + Number(s) * 864e5); return x.toISOString().slice(0, 10); }   // an Excel day number
  return null;
  function ok(y, mo, da) { const v = `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`; return T.isDate(v) && y > 1980 && y < 2100 ? v : null; }
}
const addMonths = (d, n) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(dd, last)); return x.toISOString().slice(0, 10); };
const key = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/** Rows of cells -> schedule rows { name, months, last, note, problem }. */
function understand(rows, today) {
  rows = rows.filter(r => r.some(c => String(c).trim()));
  // the heading row: the first with a name-like heading and a frequency- or date-like one
  let hi = rows.slice(0, 15).findIndex(r => r.some(c => NAME.test(c) && String(c).length < 40) && r.some(c => (FREQ.test(c) || DATE.test(c) || NEXT.test(c)) && String(c).length < 40));
  let col;
  if (hi >= 0) {
    const h = rows[hi].map(c => String(c));
    const find = (re, not) => h.findIndex((c, i) => re.test(c) && !(not || []).includes(i));
    const n = find(NAME), f = find(FREQ, [n]), l = find(LAST, [n, f]), x = find(NEXT, [n, f, l]), k = find(COUNT, [n, f, l, x]), o = find(NOTE, [n, f, l, x, k]);
    col = { name: n, freq: f, last: l, next: x, count: k, note: o };
  } else col = { name: 0, freq: 1, last: 2, next: -1, count: -1, note: 3 };
  const body = rows.slice(hi + 1);
  const out = [];
  for (const r of body) {
    const name = String(r[col.name] || '').trim().slice(0, 120);
    if (!name || /^(grand )?totals?:?$|^page \d+/i.test(name)) continue;
    let m = col.freq >= 0 ? months(r[col.freq]) : null;
    if (m == null) for (const c of r) { if (c !== r[col.name] && (m = months(c)) != null) break; }   // the frequency is in some other column
    let last = col.last >= 0 ? dateOf(r[col.last]) : null;
    const next = col.next >= 0 ? dateOf(r[col.next]) : null;
    if (!last && next && m) last = addMonths(next, -m);   // only the next due date given: work back to the last one
    if (last && last > today) last = null;
    const bits = [];
    if (col.count >= 0 && r[col.count]) bits.push(`${r[col.count]} sample${String(r[col.count]) === '1' ? '' : 's'}`);
    if (col.note >= 0 && r[col.note]) bits.push(String(r[col.note]));
    const row = { name, months: m, last, next, note: bits.join(' · ').slice(0, 500) };
    if (m == null) row.problem = "How often isn't clear. Pick it after importing.";
    out.push(row);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

/**
 * Which of ours an imported name is: the same name, the same without the bit in brackets ("Lead & Copper" =
 * "Lead & copper (5 taps)"), or the only one that starts the same way ("Total coliform" = "Total coliform bacteria").
 */
function findMatch(have, name, taken) {
  const k = key(name), plain = key(String(name).replace(/\([^)]*\)/g, ''));
  const free = have.filter(h => !taken.has(h.id));
  const same = free.find(h => key(h.name) === k) || free.find(h => key(String(h.name).replace(/\([^)]*\)/g, '')) === plain);
  if (same) return same;
  if (plain.length < 5) return null;
  const starts = free.filter(h => { const o = key(String(h.name).replace(/\([^)]*\)/g, '')); return o.length >= 5 && (o.startsWith(plain + ' ') || plain.startsWith(o + ' ')); });
  return starts.length === 1 ? starts[0] : null;
}

/** Read a file (or pasted text) and show what would change. */
async function read(company, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) V.bad('Pick a file, or paste the rows first.');
  const isXlsx = buf[0] === 0x50 && buf[1] === 0x4b;   // "PK": an .xlsx (zip)
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) V.bad("That's a PDF. Open it, select the schedule table, copy it, and paste it in the box instead. Or save the schedule as Excel or CSV.");
  if (buf[0] === 0xd0 && buf[1] === 0xcf) V.bad('That is an old Excel file (.xls). Open it in Excel and save it as .xlsx, then try again.');
  const rows = isXlsx ? await xlsxRows(buf) : csvRows(buf.toString('utf8').replace(/^﻿/, ''));
  const today = H.today(company);
  const parsed = understand(rows, today);
  if (!parsed.length) V.bad("No samples were found. The first column should be the sample name (like Nitrate), then how often, then the last date sampled.");
  const have = await db.q("SELECT id, name, months, to_char(last, 'YYYY-MM-DD') AS last FROM cw_items WHERE company_id=$1 AND list='samples'", [company.id]);
  const seen = new Set(), taken = new Set();
  parsed.forEach(p => {
    const k = key(p.name);
    if (seen.has(k)) { p.action = 'skip'; p.problem = 'Listed twice; the first one is used.'; return; }
    seen.add(k);
    const h = findMatch(have, p.name, taken);
    if (h) { taken.add(h.id); p.matchId = h.id; p.matchName = h.name; p.action = 'update'; p.was = { months: h.months, last: h.last }; } else p.action = 'add';
  });
  const keep = have.filter(h => !taken.has(h.id)).map(h => ({ id: h.id, name: h.name }));
  return { rows: parsed, notInFile: keep };
}

/** Make the change: add new sample types, update the ones already there; optionally remove ones not in the file. */
async function apply(company, b) {
  const today = H.today(company);
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_ROWS);
  if (!rows.length) V.bad('Nothing to import.');
  let added = 0, updated = 0, removed = 0;
  await db.tx(async t => {
    const have = await t.q("SELECT id, name, to_char(last, 'YYYY-MM-DD') AS last FROM cw_items WHERE company_id=$1 AND list='samples'", [company.id]);
    const done = new Set(), taken = new Set();
    for (const r of rows) {
      if (r.skip) continue;
      const name = V.str(r.name, 'a sample name', 1, 120), k = key(name);
      if (done.has(k)) continue; done.add(k);
      const m = V.int(r.months, `How often for ${name}`, 1, 240);
      const last = r.last ? (T.isDate(String(r.last)) && r.last <= today ? String(r.last) : V.bad(`The last date for ${name} isn't valid.`)) : null;
      const note = String(r.note || '').trim().slice(0, 500);
      // the one matched in the preview, or matched again the same way
      const h = (r.matchId && have.find(x => x.id === Number(r.matchId) && !taken.has(x.id))) || findMatch(have, name, taken);
      if (h) {
        taken.add(h.id);
        await t.q(`UPDATE cw_items SET months=$1, last=CASE WHEN $2::date IS NULL THEN last ELSE GREATEST(COALESCE(last,$2::date),$2::date) END, note=CASE WHEN $3='' THEN note ELSE $3 END WHERE id=$4`, [m, last, note, h.id]);
        updated++;
      } else {
        await t.q(`INSERT INTO cw_items (company_id, list, name, months, last, note, position) VALUES ($1,'samples',$2,$3,$4,$5,(SELECT COALESCE(max(position),0)+1 FROM cw_items WHERE company_id=$1))`, [company.id, name, m, last, note]);
        added++;
      }
    }
    if (b.removeOthers) {
      // sample types not in the file go, unless something was recorded for them
      for (const h of have) {
        if (taken.has(h.id)) continue;
        const g = await t.one('DELETE FROM cw_items i WHERE i.id=$1 AND NOT EXISTS (SELECT 1 FROM cw_history x WHERE x.item_id=i.id) RETURNING id', [h.id]);
        if (g) removed++;
      }
    }
  });
  return { added, updated, removed, ...(await require('./compliance').all(company)) };
}

module.exports = { read, apply, months, dateOf, understand };
