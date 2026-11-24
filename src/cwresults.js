// Sample results: read a lab report (PDF, including scanned ones) or a table copied from Drinking Water Watch /
// Excel / CSV into rows of { date, sample point, test, result, units }, let the operator check them, keep them,
// and give the viewer each test's history against its limit.
const crypto = require('crypto');
const db = require('./db');
const V = require('./validate');
const H = require('./hours');
const CI = require('./cwimport');

const MAX_ROWS = 500;

/* ------------------------------- tests and their limits ------------------------------- */
// Federal drinking water limits (EPA). kind: mcl = maximum contaminant level, al = action level (lead and copper:
// the 90th percentile of the round is what counts), mrdl = disinfectant level, smcl = secondary (taste, color; not
// enforceable), presence = must be absent. The operator can change any of these (TDEC can be stricter).
const TESTS = [
  { name: 'Total coliform', alias: /total\s*coliform|coliform,?\s*total|^coliform/i, kind: 'presence' },
  { name: 'E. coli', alias: /\be\.?\s*coli\b|escherichia|fecal\s*coliform/i, kind: 'presence' },
  { name: 'Nitrate + nitrite', alias: /nitrate.*nitrite|nitrite.*nitrate/i, limit: 10, units: 'mg/L', kind: 'mcl' },
  { name: 'Nitrate', alias: /nitrate(?!.*nitrite)|\bno3\b/i, limit: 10, units: 'mg/L', kind: 'mcl' },
  { name: 'Nitrite', alias: /nitrite(?!.*nitrate)|\bno2\b/i, limit: 1, units: 'mg/L', kind: 'mcl' },
  { name: 'Lead', alias: /^lead\b|\blead\b(?!\s*(time|free))|\bpb\b/i, limit: 0.015, units: 'mg/L', kind: 'al' },
  { name: 'Copper', alias: /copper|\bcu\b/i, limit: 1.3, units: 'mg/L', kind: 'al' },
  { name: 'Arsenic', alias: /arsenic|\bas\b(?=\s*\()/i, limit: 0.010, units: 'mg/L', kind: 'mcl' },
  { name: 'Barium', alias: /barium/i, limit: 2, units: 'mg/L', kind: 'mcl' },
  { name: 'Cadmium', alias: /cadmium/i, limit: 0.005, units: 'mg/L', kind: 'mcl' },
  { name: 'Chromium', alias: /chromium/i, limit: 0.1, units: 'mg/L', kind: 'mcl' },
  { name: 'Mercury', alias: /mercury/i, limit: 0.002, units: 'mg/L', kind: 'mcl' },
  { name: 'Selenium', alias: /selenium/i, limit: 0.05, units: 'mg/L', kind: 'mcl' },
  { name: 'Antimony', alias: /antimony/i, limit: 0.006, units: 'mg/L', kind: 'mcl' },
  { name: 'Beryllium', alias: /beryllium/i, limit: 0.004, units: 'mg/L', kind: 'mcl' },
  { name: 'Thallium', alias: /thallium/i, limit: 0.002, units: 'mg/L', kind: 'mcl' },
  { name: 'Cyanide', alias: /cyanide/i, limit: 0.2, units: 'mg/L', kind: 'mcl' },
  { name: 'Fluoride', alias: /fluoride/i, limit: 4, units: 'mg/L', kind: 'mcl' },
  { name: 'TTHM', alias: /tthm|total\s*trihalomethane|trihalomethanes/i, limit: 0.080, units: 'mg/L', kind: 'mcl' },
  { name: 'HAA5', alias: /haa\s*5|haa\b|haloacetic/i, limit: 0.060, units: 'mg/L', kind: 'mcl' },
  { name: 'Bromate', alias: /bromate/i, limit: 0.010, units: 'mg/L', kind: 'mcl' },
  { name: 'Chlorite', alias: /chlorite/i, limit: 1, units: 'mg/L', kind: 'mcl' },
  { name: 'Chlorine', alias: /chlorine|\bcl2\b/i, limit: 4, units: 'mg/L', kind: 'mrdl' },
  { name: 'Gross alpha', alias: /gross\s*alpha/i, limit: 15, units: 'pCi/L', kind: 'mcl' },
  { name: 'Combined radium', alias: /radium.*(226|228).*(226|228)|combined\s*radium/i, limit: 5, units: 'pCi/L', kind: 'mcl' },
  { name: 'Radium 226', alias: /radium[\s-]*226/i, units: 'pCi/L' },
  { name: 'Radium 228', alias: /radium[\s-]*228/i, units: 'pCi/L' },
  { name: 'Uranium', alias: /uranium/i, limit: 0.030, units: 'mg/L', kind: 'mcl' },
  { name: 'Benzene', alias: /benzene/i, limit: 0.005, units: 'mg/L', kind: 'mcl' },
  { name: 'Iron', alias: /^iron\b|\biron\b/i, limit: 0.3, units: 'mg/L', kind: 'smcl' },
  { name: 'Manganese', alias: /manganese/i, limit: 0.05, units: 'mg/L', kind: 'smcl' },
  { name: 'Sulfate', alias: /sulfate|sulphate/i, limit: 250, units: 'mg/L', kind: 'smcl' },
  { name: 'Chloride', alias: /chloride/i, limit: 250, units: 'mg/L', kind: 'smcl' },
  { name: 'Total dissolved solids', alias: /total\s*dissolved\s*solids|\btds\b/i, limit: 500, units: 'mg/L', kind: 'smcl' },
  { name: 'Sodium', alias: /sodium/i, units: 'mg/L' },
  { name: 'Hardness', alias: /hardness/i, units: 'mg/L' },
  { name: 'Alkalinity', alias: /alkalinity/i, units: 'mg/L' },
  { name: 'pH', alias: /^ph\b|\bph\b/i, units: 'pH' },
  { name: 'Turbidity', alias: /turbidity/i, units: 'NTU' },
  { name: 'Temperature', alias: /temperature|\btemp\b/i, units: '°C' }
];
const KIND_LABEL = { mcl: 'EPA limit (MCL)', al: 'Action level', mrdl: 'Disinfectant limit', smcl: 'Secondary limit (taste/color)', presence: 'Must be absent' };

/** "Nitrate as N" -> the standard name, or the name tidied up when it isn't one we know. */
function testName(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  const t = TESTS.find(x => x.alias.test(s));
  if (t) return t.name;
  return s.replace(/[,:;*]+$/, '').slice(0, 80);
}
const known = raw => TESTS.some(x => x.alias.test(String(raw || '')));

/* ------------------------------- results and units ------------------------------- */
const UNIT = /^(mg\/l|ug\/l|µg\/l|μg\/l|ng\/l|ppm|ppb|ppt|pci\/l|ntu|su|s\.u\.|ph units?|cfu\/100\s?ml|mpn\/100\s?ml|col\/100\s?ml|p\/a|°c|deg\s?c|umhos\/cm|µs\/cm|us\/cm|mg\/l\s?as\s?caco3|%)$/i;
const RESULT = /^(?:(<|>|≤|≥|less than)\s*)?(\d*\.?\d+(?:e[-+]?\d+)?)$|^(nd|n\.d\.|bdl|not detected|non[- ]?detect|absent|present|positive|negative|detected|<\s*mdl|<\s*rl|<\s*mrl)$/i;
function unitTidy(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  const l = s.toLowerCase().replace(/\s+/g, '');
  if (l === 'ppm') return 'mg/L';
  if (l === 'ppb' || /^[uµμ]g\/l$/.test(l)) return 'µg/L';
  if (l === 'mg/l') return 'mg/L';
  if (l === 'ng/l' || l === 'ppt') return 'ng/L';
  if (l === 'pci/l') return 'pCi/L';
  if (l === 'ntu') return 'NTU';
  if (/^(su|s\.u\.|phunits?)$/.test(l)) return 'pH';
  if (/^(cfu|mpn|col)\/100ml$/.test(l)) return s.toUpperCase().replace(/ML$/, 'mL').replace(/\s/g, '');
  if (l === 'p/a') return 'P/A';
  if (/^(°c|degc)$/.test(l)) return '°C';
  return s.slice(0, 30);
}
/** "<0.0010", "ND", "0.52", "Absent" -> { value, qual, text } (value null for ND/absent). */
function resultOf(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/,/g, '');
  const m = RESULT.exec(s);
  if (!m) return null;
  if (m[3]) {
    const w = m[3].toLowerCase();
    if (/absent|negative/.test(w)) return { value: null, qual: 'absent', text: 'Absent' };
    if (/present|positive|^detected/.test(w)) return { value: null, qual: 'present', text: 'Present' };
    return { value: null, qual: 'nd', text: 'Not detected' };
  }
  const v = Number(m[2]);
  if (!isFinite(v)) return null;
  const lt = m[1] && /<|≤|less/i.test(m[1]);
  return { value: v, qual: lt ? 'lt' : m[1] ? 'gt' : '', text: (lt ? '<' : m[1] ? '>' : '') + m[2] };
}
/** A value in one unit converted to another (mg/L <-> µg/L <-> ng/L); null when they don't convert. */
function convert(v, from, to) {
  if (v == null || from === to || !from || !to) return v;
  const f = { 'mg/L': 1, 'µg/L': 1e-3, 'ng/L': 1e-6 };
  return f[from] && f[to] ? v * f[from] / f[to] : null;
}

/* ------------------------------- reading a lab report (text) ------------------------------- */
const HEADER_WORD = /^(analyte|parameter|test|result|units?|method|mcl|limit|rl|mdl|qualifier|date|analy[sz]ed|prepared|dilution|cas|sample|page|report|client|project)\b/i;
const DATE_RE = /\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i;
const COLLECTED = /(collect(?:ed|ion)?|sampl(?:ed|e)\s*date|date\s*(?:sampled|collected)|date\s*\/\s*time\s*collected)\s*(?:date)?\s*[:#-]?\s*/i;
const POINT = /(sample\s*(?:point|location|site|description)|location|site\s*(?:name|id)|collection\s*point|sampling\s*point)\s*[:#-]\s*(.+)/i;
const SAMPLE_ID = /\b(?:lab\s*)?sample\s*(?:id|#|number|no\.?)\s*[:#-]/i;

/** Rows from the text of a lab report, one line per result. */
function fromText(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  const rows = [];
  let day = null, point = '', lab = '', used = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '   ');
    if (!lab) { const l = /([A-Z][\w&.,' -]{2,60}(?:laborator(?:y|ies)|labs?\b|analytical|environmental)[\w&.,' -]{0,30})/i.exec(line); if (l && !/report|page/i.test(l[1])) lab = l[1].trim().slice(0, 80); }
    if (SAMPLE_ID.test(line) && !POINT.test(line) && used) { point = ''; used = false; }     // a new sample: its location comes next
    const c = COLLECTED.exec(line);
    if (c) { const d = DATE_RE.exec(line.slice(c.index + c[0].length - 1)) || DATE_RE.exec(line); if (d) day = CI.dateOf(d[1].replace(/\./g, '/')) || day; }
    const p = POINT.exec(line);
    if (p && !RESULT.test(p[2].trim().split(/\s{2,}/)[0])) {
      // "DS01 #1   1049 Deerfield Way": the street address is the location (the site code alone if there's none)
      const parts = p[2].split(/\s{3,}|\s+(?=(?:collect|date|matrix|sampled)\b)/i).map(x => x.trim()).filter(Boolean)
        .filter(x => !/^(collect|date|matrix|sampled)/i.test(x));
      const v = parts.find(x => /^\d{1,6}[a-z]?\s+[a-z]/i.test(x)) || parts[0] || '';
      if (v && v.length < 80 && !DATE_RE.test(v.slice(0, 10))) { point = v; used = false; }
    }
    // a result line: a test name, then a result, then (usually) units
    const toks = line.trim().split(/\s{2,}|\s+(?=[<>]?\s*\d*\.?\d+\s+(?:mg|ug|µg|μg|ng|pci|ntu|ppm|ppb|cfu|mpn|p\/a|su\b))/i);
    let r = null, ri = -1;
    for (let i = 1; i < toks.length && i < 6; i++) { const x = resultOf(toks[i]); if (x) { r = x; ri = i; break; } }
    let name = ri > 0 ? toks.slice(0, ri).join(' ') : '';
    let units = '';
    if (!r) {      // single spaces (OCR): "Nitrate as N 0.52 mg/L"
      const m = /^(.*?[a-z)][a-z0-9 ,().+\-/]*?)\s+((?:<|>)?\s*\d*\.?\d+|nd|absent|present|not detected|bdl)\s+(mg\/l|ug\/l|µg\/l|μg\/l|ng\/l|ppm|ppb|pci\/l|ntu|su|cfu\/100\s?ml|mpn\/100\s?ml|p\/a)\b/i.exec(line.trim());
      if (m) { name = m[1]; r = resultOf(m[2].replace(/\s+/g, '')); units = m[3]; }
      else {
        const b = /^(.*?(?:coliform|e\.?\s*coli)[a-z .]*?)\s+(absent|present|negative|positive|not detected|detected)\b/i.exec(line.trim());
        if (b) { name = b[1]; r = resultOf(b[2]); units = 'P/A'; }
      }
    } else {
      for (let j = ri + 1; j < toks.length && j < ri + 3; j++) { if (UNIT.test(toks[j].trim())) { units = toks[j]; break; } }
      if (!units) { const u = /^(\S+)/.exec(toks[ri + 1] || ''); if (u && UNIT.test(u[1])) units = u[1]; }
    }
    if (!r) continue;
    name = name.replace(/^\d+[.)]?\s+(?=[a-z])/i, '').trim();
    if (!/[a-z]{2}/i.test(name) || name.length > 80 || HEADER_WORD.test(name)) continue;
    if (!known(name) && !units) continue;            // an unknown name with no units is usually not a result
    const d = DATE_RE.exec(line);
    // the date collected (a date on the line itself is usually when it was analyzed)
    used = true;
    rows.push({ day: day || (d && CI.dateOf(d[1].replace(/\./g, '/'))) || null, point, test: testName(name), raw: name.slice(0, 80),
      result: r.text, value: r.value, qual: r.qual, units: unitTidy(units) || (r.qual === 'absent' || r.qual === 'present' ? 'P/A' : ''), lab });
  }
  return rows;
}

/* ------------------------------- reading a table (DWW, Excel, CSV) ------------------------------- */
const COL = {
  test: /analyte\s*name|^analyte$|contaminant|parameter|^test|constituent|^name$|analysis/i,
  result: /^result|concentration|^value|measurement|^amount|level\s*found|^reported/i,
  units: /^units?$|^uom$|unit of measure|^measure/i,
  day: /sample\s*date|collect|date\s*sampled|^date|sampled/i,
  point: /sample\s*point|location|^site|facility|sampling\s*point|^point|description|address/i,
  qual: /less\s*than|qualifier|^lt\b|indicator|^flag|^sign|^<$/i,
  lab: /^lab/i
};
function fromTable(rows) {
  let hi = -1, map = null;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i].map(c => String(c || '').trim());
    const m = {};
    r.forEach((c, j) => { for (const k of Object.keys(COL)) if (m[k] == null && c && COL[k].test(c) && !(k === 'test' && /code|date/i.test(c)) && !(k === 'day' && /analy[sz]ed|received|report/i.test(c))) { m[k] = j; break; } });
    if (m.test != null && m.result != null) { hi = i; map = m; break; }
  }
  if (!map) return null;
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const g = k => (map[k] == null ? '' : String(r[map[k]] == null ? '' : r[map[k]]).trim());
    const name = g('test');
    if (!name || !/[a-z]/i.test(name)) continue;
    let res = g('result'), q = g('qual');
    if (q && /^(<|lt|less|y|yes|true)$/i.test(q) && !/^[<>]/.test(res)) res = '<' + res;
    let x = resultOf(res);
    let units = g('units');
    if (!x) { const m = /^([<>]?\s*\d*\.?\d+|nd|absent|present)\s*(.*)$/i.exec(res); if (m) { x = resultOf(m[1].replace(/\s+/g, '')); units = units || m[2]; } }
    if (!x) continue;
    out.push({ day: CI.dateOf(g('day')), point: g('point').slice(0, 80), test: testName(name), raw: name.slice(0, 80), result: x.text, value: x.value, qual: x.qual,
      units: unitTidy(units) || (x.qual === 'absent' || x.qual === 'present' ? 'P/A' : ''), lab: g('lab').slice(0, 80) });
  }
  return out;
}

/* ------------------------------- read: what would be saved ------------------------------- */
async function read(company, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) V.bad('Pick a file, or paste the results first.');
  if (buf.length > 25 * 1024 * 1024) V.bad('That file is too big (over 25 MB).');
  let rows = null, how = 'table';
  const head = buf.slice(0, 8);
  const isPdf = head.slice(0, 5).toString() === '%PDF-';
  const isImg = (head[0] === 0x89 && head[1] === 0x50) || (head[0] === 0xff && head[1] === 0xd8);
  if (head[0] === 0xd0 && head[1] === 0xcf) V.bad('That is an old Excel file (.xls). Open it in Excel and save it as .xlsx, then try again.');
  if (isPdf || isImg) {
    const TR = require('./transfers');
    const ocr = TR.ocrSession();
    try {
      const t = await TR.extract(buf, isPdf ? 'application/pdf' : 'image/png', ocr);
      how = t.ocr ? 'scan' : 'pdf';
      rows = fromText(t.text);
      if (!rows.length) rows = fromTable(t.text.split(/\r?\n/).map(l => l.trim().split(/\s{2,}/))) || [];
    } finally { await ocr.close(); }
  } else if (head[0] === 0x50 && head[1] === 0x4b) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch (e) { V.bad("That file couldn't be opened. Save it as .xlsx or .csv and try again."); }
    rows = [];
    wb.eachSheet(ws => {
      const cells = [];
      ws.eachRow({ includeEmpty: false }, r => {
        const vals = [];
        r.eachCell({ includeEmpty: true }, (c, n) => {
          let v = c.value;
          if (v && typeof v === 'object') v = v instanceof Date ? v : v.result !== undefined ? v.result : v.richText ? v.richText.map(t => t.text).join('') : v.text || '';
          vals[n - 1] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v).trim();
        });
        cells.push(Array.from(vals, x => x || ''));
      });
      rows.push(...(fromTable(cells) || []));
    });
  } else {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const cells = /<table/i.test(text)
      ? [...text.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(tr => [...tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(td => td[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/\s+/g, ' ').trim()))
      : csvish(text);
    rows = fromTable(cells);
    if (!rows || !rows.length) { rows = fromText(text); how = 'text'; }
  }
  rows = (rows || []).slice(0, MAX_ROWS);
  if (!rows.length) V.bad(isPdf ? "No results were found in that PDF. If it's a scan, try a clearer copy, or copy the results table and paste it in the box." : 'No results were found. Include the heading row (Analyte, Result, Units, Sample date) when you copy the table.');
  // which are already saved
  const have = new Set((await db.q('SELECT key FROM cw_results WHERE company_id=$1', [company.id])).map(r => r.key));
  rows.forEach(r => { r.dup = !!(r.day && have.has(keyOf(r))); });
  const today = H.today(company);
  return { rows, how, today, missingDate: rows.some(r => !r.day), schedule: await scheduleMatches(company, rows) };
}
function csvish(text) {
  const first = text.split('\n').slice(0, 5).join('\n');
  if (first.includes('\t')) return text.split(/\r?\n/).map(l => l.split('\t'));
  if (/,/.test(first)) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
      if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  return text.split(/\r?\n/).map(l => l.trim().split(/\s{2,}/));
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9.<>]+/g, ' ').trim();
const keyOf = r => crypto.createHash('sha1').update([r.day, norm(r.point), norm(r.test), norm(r.result), norm(r.units)].join('|')).digest('hex').slice(0, 32);

/** Sample types on the schedule these results look like (to mark them collected). */
async function scheduleMatches(company, rows) {
  const have = await db.q("SELECT id, name FROM cw_items WHERE company_id=$1 AND list='samples'", [company.id]);
  const out = new Map();
  const lc = s => s.toLowerCase();
  for (const r of rows) {
    if (!r.day) continue;
    const h = have.find(x => {
      const n = lc(x.name), t = lc(r.test);
      if (n.includes(t) || t.includes(n)) return true;
      if (/lead|copper/.test(t) && /lead|copper/.test(n)) return true;
      if (/coliform|e\. coli/.test(t) && /bacteri|coliform|rtcr/.test(n)) return true;
      if (/tthm|haa5/.test(t) && /dbp|disinfect|tthm|haa/.test(n)) return true;
      if (/radium|alpha|uranium/.test(t) && /radio|radium|alpha/.test(n)) return true;
      return false;
    });
    if (!h) continue;
    const cur = out.get(h.id);
    if (!cur || r.day > cur.day) out.set(h.id, { id: h.id, name: h.name, day: r.day });
  }
  return [...out.values()];
}

/* ------------------------------- save, list, limits ------------------------------- */
async function save(company, who, b) {
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_ROWS);
  if (!rows.length) V.bad('Nothing to save.');
  const today = H.today(company);
  const batch = crypto.randomBytes(6).toString('hex');
  const source = String(b.source || '').slice(0, 120);
  let added = 0, skipped = 0;
  for (const raw of rows) {
    const day = CI.dateOf(raw.day);
    if (!day) V.bad(`Add the sample date for ${String(raw.test || 'every row').slice(0, 40)}.`);
    if (day > today) V.bad(`${day} is in the future. Check the sample dates.`);
    const test = testName(raw.test);
    if (!test) V.bad('Every row needs a test name.');
    const x = resultOf(raw.result);
    if (!x) V.bad(`"${String(raw.result).slice(0, 20)}" for ${test} isn't a result. Use a number, <number, ND, Absent or Present.`);
    const r = { day, point: String(raw.point || '').trim().slice(0, 80), test, result: x.text, units: unitTidy(raw.units) || (x.qual === 'absent' || x.qual === 'present' ? 'P/A' : '') };
    const ins = await db.q(`INSERT INTO cw_results (company_id, key, day, point, test, raw_name, result, value, qual, units, lab, source, batch, by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (company_id, key) DO NOTHING RETURNING id`,
      [company.id, keyOf(r), day, r.point, test, String(raw.raw || raw.test).slice(0, 80), x.text, x.value, x.qual, r.units, String(raw.lab || '').slice(0, 80), source, batch, who]);
    ins.length ? added++ : skipped++;
  }
  // mark the matching samples on the schedule as collected
  let marked = 0;
  for (const s of Array.isArray(b.schedule) ? b.schedule.slice(0, 50) : []) {
    const it = await db.one("SELECT id FROM cw_items WHERE id=$1 AND company_id=$2 AND list='samples'", [Number(s.id) || 0, company.id]);
    const d = CI.dateOf(s.day);
    if (!it || !d || d > today) continue;
    if (await db.one('SELECT 1 FROM cw_history WHERE item_id=$1 AND day=$2', [it.id, d])) continue;
    await db.q('INSERT INTO cw_history (item_id, day, result, lab, by_name) VALUES ($1,$2,$3,$4,$5)', [it.id, d, 'Results imported', source.slice(0, 120), who]);
    await db.q('UPDATE cw_items SET last=GREATEST(COALESCE(last, $2::date), $2::date) WHERE id=$1', [it.id, d]);
    marked++;
  }
  if (b.pending) await db.q("UPDATE cw_pending SET status='saved' WHERE id=$1 AND company_id=$2", [Number(b.pending) || 0, company.id]);
  return { added, skipped, marked, ...(await list(company)) };
}

/** Everything for the viewer: results (oldest first) and the limit for each test. */
async function list(company) {
  const rows = await db.q(`SELECT id, to_char(day,'YYYY-MM-DD') AS day, point, test, raw_name AS raw, result, value::float AS value, qual, units, lab, source, batch, by_name AS by
    FROM cw_results WHERE company_id=$1 ORDER BY day, id`, [company.id]);
  const c = await db.one('SELECT cw_limits FROM companies WHERE id=$1', [company.id]);
  const own = (c && c.cw_limits) || {};
  const tests = [...new Set(rows.map(r => r.test))];
  const limits = {};
  for (const t of tests) {
    const d = TESTS.find(x => x.name === t) || {};
    const o = own[t];
    limits[t] = o ? { limit: o.limit, units: o.units, kind: o.kind || 'own', label: o.kind === 'none' ? 'No limit' : 'Your limit', own: true }
      : d.kind === 'presence' ? { limit: null, units: 'P/A', kind: 'presence', label: KIND_LABEL.presence }
      : d.limit != null ? { limit: d.limit, units: d.units, kind: d.kind, label: KIND_LABEL[d.kind] } : { limit: null, units: d.units || '', kind: 'none', label: 'No federal limit' };
  }
  const pending = await db.q(`SELECT id, doc_id AS "docId", name, sender, received, rows, schedule, how FROM cw_pending
    WHERE company_id=$1 AND status='ready' ORDER BY received DESC NULLS LAST, id DESC LIMIT 20`, [company.id]);
  // mark rows already saved, so the check shows them as such
  if (pending.length) {
    const have = new Set((await db.q('SELECT key FROM cw_results WHERE company_id=$1', [company.id])).map(r => r.key));
    pending.forEach(p => p.rows.forEach(r => { r.dup = !!(r.day && have.has(keyOf(r))); }));
  }
  return { results: rows, limits, pending };
}

async function setLimit(company, b) {
  const test = String(b.test || '').trim().slice(0, 80);
  if (!test) V.bad('Which test?');
  const c = await db.one('SELECT cw_limits FROM companies WHERE id=$1', [company.id]);
  const own = { ...((c && c.cw_limits) || {}) };
  if (b.reset) delete own[test];
  else if (b.limit === '' || b.limit == null) own[test] = { limit: null, units: '', kind: 'none' };
  else {
    const v = Number(String(b.limit).replace(/,/g, ''));
    if (!isFinite(v) || v <= 0) V.bad('Type the limit as a number, like 0.015.');
    own[test] = { limit: v, units: unitTidy(b.units) || '', kind: 'own' };
  }
  await db.q('UPDATE companies SET cw_limits=$1 WHERE id=$2', [JSON.stringify(own), company.id]);
  return list(company);
}

async function remove(company, id) {
  await db.q('DELETE FROM cw_results WHERE id=$1 AND company_id=$2', [Number(id) || 0, company.id]);
  return list(company);
}
async function removeBatch(company, batch) {
  await db.q('DELETE FROM cw_results WHERE batch=$1 AND company_id=$2', [String(batch || '').slice(0, 20), company.id]);
  return list(company);
}

/** Over the limit? (null when there's no number to compare) */
function over(r, lim) {
  if (!lim) return null;
  if (lim.kind === 'presence') return r.qual === 'present';
  if (lim.limit == null || r.value == null || r.qual === 'lt') return lim.limit == null ? null : false;
  const v = convert(r.value, r.units, lim.units);
  return v == null ? null : v > lim.limit;
}

async function csv(company) {
  const { results, limits } = await list(company);
  const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const lines = [['Sample date', 'Sample point', 'Test', 'Result', 'Units', 'Limit', 'Over limit', 'Lab', 'File', 'Added by'].map(q).join(',')]
    .concat(results.slice().reverse().map(r => { const l = limits[r.test]; const o = over(r, l);
      return [r.day, r.point, r.test, r.result, r.units, l && l.limit != null ? `${l.limit} ${l.units}` : l && l.kind === 'presence' ? 'Absent' : '', o ? 'YES' : '', r.lab, r.source, r.by].map(q).join(','); }));
  return '﻿' + lines.join('\r\n');
}

function mount(r, prefix, guard, who) {
  const g = guard ? [].concat(guard) : [];
  require('./lcnotice').mount(r, prefix, guard);   // lead and copper consumer notices
  r.post(prefix + '/results/read', ...g, async (req, res) => res.json(await read(req.company, req.body)));
  r.post(prefix + '/results/pending/:id/dismiss', ...g, async (req, res) => {
    await db.q("UPDATE cw_pending SET status='dismissed' WHERE id=$1 AND company_id=$2", [Number(req.params.id) || 0, req.company.id]);
    res.json(await list(req.company));
  });
  r.get(prefix + '/results', ...g, async (req, res) => res.json(await list(req.company)));
  r.post(prefix + '/results', ...g, async (req, res) => res.json(await save(req.company, who(req), req.body || {})));
  r.put(prefix + '/results/limit', ...g, async (req, res) => res.json(await setLimit(req.company, req.body || {})));
  r.delete(prefix + '/results/batch/:batch', ...g, async (req, res) => res.json(await removeBatch(req.company, req.params.batch)));
  r.delete(prefix + '/results/:id', ...g, async (req, res) => res.json(await remove(req.company, req.params.id)));
  r.get(prefix + '/results.csv', ...g, async (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sample-results.csv"', 'Cache-Control': 'no-store' }).send(await csv(req.company));
  });
}

module.exports = { TESTS, testName, resultOf, unitTidy, convert, fromText, fromTable, csvish, read, save, list, setLimit, remove, removeBatch, over, csv, mount };
