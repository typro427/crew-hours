// Bank statements for the contract tab: read the transactions off a statement (a PDF, a scan or photo, the bank's
// CSV / Excel download, or Quicken / QuickBooks .qfx/.ofx), then each one goes against a budget line. What a vendor
// was put against is remembered, so next month's statement comes in already sorted. Payroll and transfers between
// accounts are left out by default: payroll is already counted from the payroll history and Crew Hours.
const crypto = require('crypto');
const db = require('./db');
const T = require('./time');
const V = require('./validate');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const AMT = '\\(?-?\\$?\\s?\\d{1,3}(?:,\\d{3})*\\.\\d{2}\\)?-?(?:\\s?(?:CR|DR))?';
const AMT_RE = new RegExp(AMT, 'g');

/** "1,234.56-" / "(12.00)" / "$5.00 CR" -> { v, neg, pos } */
function amt(s) {
  const t = String(s).trim();
  const v = Number(t.replace(/[^\d.]/g, ''));
  return { v: r2(v), neg: /^\(|^-|-$|\)$|DR$/i.test(t), pos: /CR$/i.test(t) };
}
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1990 && y < 2100;
const fullYear = y => (y < 100 ? 2000 + y : y);

/* ------------------------------ which line it goes on ------------------------------ */
// money that's already counted elsewhere, or isn't spending at all
const PAYROLL = /payroll|paychex|\badp\b|gusto|direct dep|net ?pay|salary|wages|intuit.*(pay|psp)|qb ?payroll|tax ?(?:pymt|payment)|eftps|irs usataxpymt/i;
const TRANSFER = /\btransfer\b|\bxfer\b|\btrnsfr\b|to (?:sav|chk)|from (?:sav|chk)|zelle to self/i;
const NOT_INCOME = /interest|refund|reversal|return(?:ed)? item|transfer|xfer/i;

/** A vendor's name without the bank's noise, used to remember where it goes: "POS DEBIT LOWES #1234 KNOXVILLE TN" -> "lowes". */
function vendorKey(desc) {
  const STATES = /\s+[A-Za-z.]+\s+(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b.*$/;
  const w = String(desc || '').replace(/\s{2,}.*$/, '').replace(STATES, '').toLowerCase()
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, ' ')
    .replace(/\b(pos|debit|credit|card|checkcard|check card|purchase|recurring|ach|ppd|ccd|web|tel|online|electronic|withdrawal|withdrwl|payment|pmt|pymt|dbt|crd|visa|mastercard|mc|sq|tst|paypal|pp|id|ref|trace|co|entry|descr|sec|ind|name|des|in|at|on|the)\b/g, ' ')
    .replace(/[#*]\s*\w*/g, ' ').replace(/\b[a-z]*\d[\w-]*\b/g, ' ').replace(/[^a-z& ]+/g, ' ').trim().split(/\s+/).filter(x => x.length > 1);
  return w.slice(0, 2).join(' ');
}

/** The line a transaction should go on: what was picked for this vendor before, or a sensible default. */
function guessLine(t, rules) {
  const k = vendorKey(t.desc);
  if (!t.check && k && rules[k] !== undefined) return { line: rules[k], why: 'remembered' };
  if (t.amount > 0) return NOT_INCOME.test(t.desc) ? { line: 'skip', why: 'not income' } : { line: 'received', why: '' };
  if (PAYROLL.test(t.desc)) return { line: 'skip', why: 'payroll (already counted)' };
  if (TRANSFER.test(t.desc)) return { line: 'skip', why: 'transfer between accounts' };
  return { line: '', why: '' };
}

/* ------------------------------ reading a statement ------------------------------ */
/** The statement's period, for the year of "10/05"-style dates. { from, to } or null. */
function period(text) {
  const d = '(\\d{1,2})[/-](\\d{1,2})[/-](\\d{2,4})';
  let m = new RegExp(`${d}\\s*(?:-|–|to|through|thru)\\s*${d}`, 'i').exec(text);
  if (m) {
    const a = ymd(fullYear(+m[3]), +m[1], +m[2]), b = ymd(fullYear(+m[6]), +m[4], +m[5]);
    if (T.isDate(a) && T.isDate(b)) return { from: a, to: b };
  }
  const n = '([A-Za-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s*(\\d{4})?';
  m = new RegExp(`${n}\\s*(?:-|–|to|through|thru)\\s*${n}`, 'i').exec(text);
  if (m && MON[m[1].slice(0, 3).toLowerCase()] && MON[m[4].slice(0, 3).toLowerCase()] && (m[3] || m[6])) {
    const y2 = +(m[6] || m[3]), m1 = MON[m[1].slice(0, 3).toLowerCase()], m2 = MON[m[4].slice(0, 3).toLowerCase()];
    const y1 = m[3] ? +m[3] : m1 > m2 ? y2 - 1 : y2;
    return { from: ymd(y1, m1, +m[2]), to: ymd(y2, m2, +m[5]) };
  }
  return null;
}

/** Transactions from a statement's text (the PDF's text, or what OCR read off a scan). */
function fromText(text, today) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  const per = period(text);
  const endY = per ? Number(per.to.slice(0, 4)) : (() => {   // the year that shows up most
    const ys = {}; (text.match(/\b20\d{2}\b/g) || []).forEach(y => { ys[y] = (ys[y] || 0) + 1; });
    const best = Object.entries(ys).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : Number(today.slice(0, 4));
  })();
  const endM = per ? Number(per.to.slice(5, 7)) : 12;
  const yearOf = m => (m > endM ? endY - 1 : endY);

  const out = [];
  let section = null, bal = null, opening = null, closing = null, last = null;
  const trailing = new RegExp(`^(.*?)\\s+(${AMT})(?:\\s+(${AMT}))?(?:\\s+(${AMT}))?\\s*$`, 'i');
  const checkRe = new RegExp(`(?:^|\\s)(\\d{3,6})\\s*[*^]?\\s+(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?\\s+(${AMT})`, 'gi');

  const push = (y, m, d, desc, a, balance) => {
    if (!valid(y, m, d)) return;
    let sign = a.neg ? -1 : a.pos ? 1 : section === 'in' ? 1 : section === 'out' || section === 'checks' ? -1 : 0;
    if (balance != null && bal != null) {   // the running balance tells which way the money went
      const diff = r2(balance - bal);
      if (Math.abs(Math.abs(diff) - a.v) < 0.006) sign = diff < 0 ? -1 : 1;
    }
    if (balance != null) bal = balance;
    if (!sign || !a.v) return;
    const check = /^(?:check|chk|ck)\s*#?\s*(\d+)$/i.exec(desc) || (section === 'checks' && /^#?\d{3,6}$/.exec(desc) ? [desc, desc.replace('#', '')] : null);
    last = { day: ymd(y, m, d), desc: check ? `Check #${check[1]}` : desc.replace(/\s{2,}/g, ' ').trim(), amount: r2(sign * a.v), check: check ? check[1] : '' };
    out.push(last);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { last = null; continue; }
    const low = line.toLowerCase();
    // opening / closing balance
    const ob = /(beginning|opening|previous|starting) balance/i.test(line) && line.match(AMT_RE);
    if (ob) { const a = amt(ob[ob.length - 1]); bal = a.neg ? -a.v : a.v; if (opening == null) opening = bal; last = null; continue; }
    const cb = /(ending|closing|new) balance/i.test(line) && line.match(AMT_RE);
    if (cb && !/^\d{1,2}[/-]\d{1,2}/.test(line)) { const a = amt(cb[cb.length - 1]); closing = a.neg ? -a.v : a.v; last = null; continue; }

    let m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s+(.+)$/.exec(line);
    let mo, dd, yy, rest;
    if (m) { mo = +m[1]; dd = +m[2]; yy = m[3] ? fullYear(+m[3]) : null; rest = m[4]; }
    else if ((m = /^([A-Za-z]{3,4})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(.+)$/.exec(line)) && MON[m[1].toLowerCase()]) { mo = MON[m[1].toLowerCase()]; dd = +m[2]; yy = m[3] ? +m[3] : null; rest = m[4]; }

    if (section === 'checks' && !mo) {   // "1234  10/05  150.00   1235  10/07  75.00"
      const cs = [...line.matchAll(checkRe)];
      if (cs.length) { cs.forEach(c => push(c[4] ? fullYear(+c[4]) : yearOf(+c[2]), +c[2], +c[3], `Check #${c[1]}`, amt(c[5]), null)); last = null; continue; }
    }
    if (mo && rest && section !== 'skip') {
      const t = trailing.exec(rest);
      if (t) {
        const amts = [t[2], t[3], t[4]].filter(Boolean).map(amt);
        let desc = t[1].trim();
        // "10/05 1234 150.00" in the checks section; anything else needs words (a daily balance line has none)
        if (!/[a-z]/i.test(desc) && !(section === 'checks' && /^#?\d{3,6}$/.test(desc))) { last = null; continue; }
        const a = amts.length >= 3 ? (amts[0].v ? { ...amts[0], neg: true } : amts[1]) : amts[0];
        const balance = amts.length >= 2 ? (amts[amts.length - 1].neg ? -amts[amts.length - 1].v : amts[amts.length - 1].v) : null;
        push(yy || yearOf(mo), mo, dd, desc, a, balance);
        continue;
      }
    }
    // a heading: what kind of money the lines below are
    if (!mo && line.length < 70) {
      const hasAmt = (line.match(AMT_RE) || []).length;
      if (/daily (ending |ledger )?balance|balance summary|ending daily/i.test(low)) { section = 'skip'; last = null; continue; }
      if (!hasAmt) {
        const isIn = /deposit|credits?\b|additions|incoming/i.test(low), isOut = /withdraw|debits?\b|subtractions|charges|fees|purchases|payments|other deductions|electronic (?:payments|withdrawals)/i.test(low);
        if (/checks? (?:paid|cleared)|^checks?\b/i.test(low) && !isIn) { section = 'checks'; last = null; continue; }
        if (isIn !== isOut) { section = isIn ? 'in' : 'out'; last = null; continue; }
        // the payee on the line under a transaction
        if (last && /[a-z]{3}/i.test(line) && !/^page \d|continued|^date\b|^description\b|^amount\b/i.test(line) && last.desc.length < 60) { last.desc = (last.desc + ' ' + line).slice(0, 90); continue; }
      }
    }
    last = null;
  }
  return { txns: out, period: per, opening, closing };
}

/** The bank's CSV / Excel download: a header row, then a row per transaction. */
function fromTable(rows, today) {
  const idx = rows.findIndex(r => r.some(c => /date|posted/i.test(c)) && r.some(c => /amount|debit|withdraw|credit|deposit/i.test(c)));
  if (idx < 0) return null;
  const h = rows[idx].map(c => String(c || '').toLowerCase().trim());
  const col = re => h.findIndex(c => re.test(c));
  const cDate = col(/^(transaction |posted |post |posting )?date$|date/), cDesc = (() => { const i = col(/desc|payee|memo|details|merchant|^name$|narrative|transaction$/); return i >= 0 ? i : col(/name|memo/); })();
  const cAmt = col(/^amount|amount$|^amt/), cDeb = col(/debit|withdraw|payments?$|money out|^out$/), cCred = col(/credit|deposit|money in|^in$/), cType = col(/^type$|dr.?cr|transaction type/);
  const cCheck = col(/check|chk|ref/), cBal = col(/balance/);
  if (cDate < 0 || (cAmt < 0 && cDeb < 0 && cCred < 0)) return null;
  const txns = [];
  for (const r of rows.slice(idx + 1)) {
    const ds = String(r[cDate] || '').trim();
    let day = null, m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ds))) day = ymd(+m[1], +m[2], +m[3]);
    else if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(ds))) day = ymd(fullYear(+m[3]), +m[1], +m[2]);
    else if ((m = /^(\d{1,2})[/-](\d{1,2})$/.exec(ds))) day = ymd(Number(today.slice(0, 4)), +m[1], +m[2]);
    if (!day || !T.isDate(day)) continue;
    const n = s => { const t = String(s == null ? '' : s).trim(); if (!t) return null; const a = amt(t); const v = Number(t.replace(/[^\d.]/g, '')); return isFinite(v) && /\d/.test(t) ? (a.neg ? -v : v) : null; };
    let a = null;
    if (cDeb >= 0 || cCred >= 0) { const d = cDeb >= 0 ? n(r[cDeb]) : null, c = cCred >= 0 ? n(r[cCred]) : null; if (d) a = -Math.abs(d); else if (c) a = Math.abs(c); }
    if (a == null && cAmt >= 0) { a = n(r[cAmt]); if (a != null && cType >= 0 && /debit|dr|withdraw/i.test(r[cType]) && a > 0) a = -a; }
    if (!a) continue;
    let desc = String(cDesc >= 0 ? r[cDesc] || '' : '').replace(/\s+/g, ' ').trim();
    const ck = cCheck >= 0 && /check|chk/.test(h[cCheck]) ? String(r[cCheck] || '').trim() : '';
    if (!desc && ck) desc = 'Check #' + ck;
    const cm = /^(?:check|chk|ck)\s*#?\s*(\d+)$/i.exec(desc);
    txns.push({ day, desc: desc || '(no description)', amount: r2(a), check: cm ? cm[1] : ck && /^\d+$/.test(ck) ? ck : '' });
  }
  void cBal;
  return { txns, period: null, opening: null, closing: null };
}

/** Quicken / QuickBooks / Money download (.qfx, .ofx, .qbo). */
function fromOfx(text) {
  const tag = (s, t) => { const m = new RegExp(`<${t}>([^<\\r\\n]*)`, 'i').exec(s); return m ? m[1].trim() : ''; };
  const txns = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|<\/BANKTRANLIST>)/gi)].map(m => {
    const s = m[1], d = tag(s, 'DTPOSTED');
    const day = /^\d{8}/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
    const amount = r2(Number(tag(s, 'TRNAMT')));
    const ck = tag(s, 'CHECKNUM');
    const desc = [tag(s, 'NAME'), tag(s, 'MEMO')].filter(Boolean).join(' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() || (ck ? 'Check #' + ck : '');
    return day && amount ? { day, desc: desc || '(no description)', amount, check: ck } : null;
  }).filter(Boolean);
  const st = tag(text, 'DTSTART'), en = tag(text, 'DTEND');
  const f = s => /^\d{8}/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
  const bal = /<LEDGERBAL>[\s\S]*?<BALAMT>([-\d.]+)/i.exec(text);
  return { txns, period: f(st) && f(en) ? { from: f(st), to: f(en) } : null, opening: null, closing: bal ? r2(Number(bal[1])) : null };
}

/** A transaction's fingerprint, so the same statement uploaded twice isn't counted twice. */
const refOf = (t, n) => crypto.createHash('sha1').update(`${t.day}|${t.amount.toFixed(2)}|${String(t.desc).toLowerCase().replace(/[^a-z0-9]/g, '')}|${n}`).digest('hex').slice(0, 20);
function fingerprint(txns) {
  const seen = {};
  txns.forEach(t => { const k = `${t.day}|${t.amount}|${t.desc}`; seen[k] = (seen[k] || 0) + 1; t.ref = refOf(t, seen[k]); });
  return txns;
}

/** Read a statement file. Returns what was found, each transaction with a guessed budget line; nothing is saved yet. */
async function read(company, buf, rules) {
  if (!Buffer.isBuffer(buf) || !buf.length) V.bad('Pick the bank statement first.');
  if (buf.length > 25 * 1024 * 1024) V.bad('That file is too big (over 25 MB).');
  const today = T.localNow(company.timezone || 'America/New_York').date;
  const head = buf.slice(0, 8);
  const isPdf = head.slice(0, 5).toString() === '%PDF-';
  const isImg = (head[0] === 0x89 && head[1] === 0x50) || (head[0] === 0xff && head[1] === 0xd8);
  if (head[0] === 0xd0 && head[1] === 0xcf) V.bad('That is an old Excel file (.xls). Open it in Excel and save it as .xlsx or .csv, then try again.');
  let got = null, how = 'pdf';
  if (isPdf || isImg) {
    const TR = require('./transfers');
    const ocr = TR.ocrSession();
    try {
      const t = await TR.extract(buf, isPdf ? 'application/pdf' : 'image/png', ocr);
      how = t.ocr ? 'scan' : 'pdf';
      got = fromText(t.text, today);
      if (!got.txns.length) {
        if (!t.text.replace(/\s/g, '').length) V.bad("Nothing could be read off that file. If it's a photo, take it straight on in good light, or download the statement from the bank's website as a PDF or CSV.");
        if (/password|encrypted/i.test(t.text)) V.bad('That PDF is locked with a password. Download it again without the password, or use the CSV download.');
      }
    } catch (e) {
      if (/password/i.test(e.message || '')) V.bad('That PDF is locked with a password. Download it again without the password, or use the CSV download.');
      throw e;
    } finally { await ocr.close(); }
  } else if (head[0] === 0x50 && head[1] === 0x4b) {
    how = 'table';
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch (e) { V.bad("That file couldn't be opened. Save it as .xlsx or .csv and try again."); }
    const rows = [];
    wb.worksheets[0].eachRow({ includeEmpty: false }, r => {
      const vals = [];
      r.eachCell({ includeEmpty: true }, (c, n) => {
        let v = c.value;
        if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result !== undefined ? v.result : v.richText ? v.richText.map(t => t.text).join('') : v.text || '';
        vals[n - 1] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v).trim();
      });
      rows.push(Array.from(vals, x => x || ''));
    });
    got = fromTable(rows, today);
  } else {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    if (/<OFX>|OFXHEADER|<STMTTRN>/i.test(text)) { how = 'qfx'; got = fromOfx(text); }
    else { how = 'table'; got = fromTable(require('./cwresults').csvish(text), today) || fromText(text, today); }
  }
  if (!got || !got.txns.length) V.bad("No transactions were found on that statement. The bank's CSV or Excel download (usually under Download or Export on the account page) reads best.");

  const txns = fingerprint(got.txns).sort((a, b) => a.day.localeCompare(b.day));
  const saved = new Set((await db.q("SELECT ref FROM contract_actuals WHERE company_id=$1 AND source='bank' AND ref = ANY($2::text[])", [company.id, txns.map(t => t.ref)])).map(r => r.ref));
  txns.forEach(t => { const g = guessLine(t, rules || {}); t.line = g.line; t.why = g.why; t.dup = saved.has(t.ref); });
  const moneyIn = r2(txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0));
  const moneyOut = r2(-txns.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0));
  // does it add up? opening + in - out = closing means nothing was missed
  const adds = got.opening != null && got.closing != null ? Math.abs(r2(got.opening + moneyIn - moneyOut) - got.closing) < 0.02 : null;
  return { how, period: got.period || { from: txns[0].day, to: txns[txns.length - 1].day }, opening: got.opening, closing: got.closing, moneyIn, moneyOut, addsUp: adds, txns };
}

/** Save the transactions that were given a line. b.txns: [{ day, desc, amount, check, ref, line }] */
async function save(company, contract, b) {
  const list = Array.isArray(b && b.txns) ? b.txns.slice(0, 3000) : [];
  if (!list.length) V.bad('Nothing to save.');
  const keys = new Set((contract.lines || []).map(l => l.key));
  const rules = { ...(contract.bankRules || {}) };
  let saved = 0, skipped = 0, dups = 0;
  await db.tx(async t => {
    for (const x of list) {
      const day = String(x.day || ''), amount = r2(x.amount), line = String(x.line || ''), desc = String(x.desc || '').slice(0, 200);
      if (!T.isDate(day) || !amount) continue;
      const k = vendorKey(desc);
      if (k && !x.check && (keys.has(line) || line === 'skip' || line === 'received')) rules[k] = line;   // remember it for next time
      if (!keys.has(line) && line !== 'received') { skipped++; continue; }
      if (line === 'received' && amount < 0) { skipped++; continue; }
      const ref = /^[0-9a-f]{20}$/.test(x.ref || '') ? x.ref : refOf({ day, amount, desc }, 1);
      const r = await t.q(`INSERT INTO contract_actuals (company_id, day, source, person, job, amount, note, line_key, ref)
        SELECT $1,$2,'bank','','Deerfield',$3,$4,$5,$6 WHERE NOT EXISTS (SELECT 1 FROM contract_actuals WHERE company_id=$1 AND source='bank' AND ref=$6) RETURNING id`,
        [company.id, day, line === 'received' ? amount : -amount, desc, line, ref]);
      if (r.length) saved++; else dups++;
    }
  });
  return { saved, skipped, dups, rules };
}

module.exports = { read, save, fromText, fromTable, fromOfx, vendorKey, guessLine, period };
