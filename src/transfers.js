// Weekly property-transfer check: reads the Campbell County transfer lists WLAF posts
// (1450wlaf.com/property-transfers, with WLAF's permission), finds the ones that touch a property or
// owner on the Members list, and keeps them as "possible owner changes" for the boss to approve or dismiss.
// Nothing on the Members list changes until the boss approves a change.
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const V = require('./validate');
const config = require('./config');
const M = require('./meters');
const MB = require('./members');

const BACKFILL_DAYS = 60;        // the first check looks back this far
const MAX_FILES = 30;            // per check, so one run never takes too long
const MAX_BYTES = 30 * 1024 * 1024;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const UA = () => `${config.productName} property-transfer check (${config.appUrl})`;
const NM = path.join(__dirname, '..', 'node_modules');

/* ------------------------------ the list page ------------------------------ */

/** "November 16, 2026" / "Nov. 16 2026" / "11/16/2026" / a date in the file name -> "2026-11-16". */
function dayOf(...texts) {
  for (const t of texts) {
    const s = String(t || '');
    let m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(20\d\d)\b/i.exec(s);
    if (m) return `${m[3]}-${String(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d\d)\b/.exec(s);
    if (m && +m[1] <= 12 && +m[2] <= 31) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

const decode = s => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
const FILE = /\.(pdf|png|jpe?g|gif|webp)(?:[?#]|$)/i;
const driveId = u => (/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{10,})/.exec(u) || [])[1];

/** Only WLAF's own sites and the places it keeps the files. */
function allowed(u, listUrl) {
  let h; try { h = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
  const own = new URL(listUrl).hostname.toLowerCase();
  return h === own || h.endsWith('.1450wlaf.com') || h === '1450wlaf.com' || h === 'wlaffiles.blob.core.windows.net'
    || h === 'drive.google.com' || h === 'drive.usercontent.google.com';
}

/** Links on a page: [{ url, text }]. */
function links(html, base) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url; try { url = new URL(m[1].replace(/&amp;/g, '&'), base).href; } catch (e) { continue; }
    out.push({ url, text: decode(m[2]) });
  }
  return out;
}

async function get(url, { binary, max = MAX_BYTES } = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA(), Accept: binary ? '*/*' : 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).hostname}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > max) throw new Error('The file is too big.');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > max) throw new Error('The file is too big.');
  return { buf, type: String(r.headers.get('content-type') || '').toLowerCase(), url: r.url || url };
}

/**
 * The transfer lists on WLAF's page, newest first: [{ url, day, label }].
 * A day links straight to its PDF or screenshot; a day that links to a post instead is opened to find the file in it.
 */
async function listFiles(listUrl = config.transfers.url) {
  const { buf } = await get(listUrl);
  const html = buf.toString('utf8');
  const seen = new Set(), out = [];
  const push = (url, day, label) => {
    const id = driveId(url);
    if (id) url = `https://drive.google.com/uc?export=download&id=${id}`;
    if (seen.has(url) || !allowed(url, listUrl)) return;
    seen.add(url); out.push({ url, day, label });
  };
  const posts = [];
  for (const l of links(html, listUrl)) {
    const day = dayOf(l.text, decodeURIComponent(l.url));
    if (FILE.test(l.url) || driveId(l.url)) { if (day || /transfer/i.test(l.text + l.url)) push(l.url, day, l.text); }
    else if (day && dayOf(l.text) && allowed(l.url, listUrl) && /1450wlaf\.com|^\//.test(new URL(l.url).hostname + '/') && !/property-transfers\/?$/.test(l.url)) posts.push({ url: l.url, day, label: l.text });
  }
  for (const p of posts.slice(0, 12)) {     // posts that hold the file
    try {
      const page = (await get(p.url, { max: 5e6 })).buf.toString('utf8');
      links(page, p.url).filter(l => FILE.test(l.url) || driveId(l.url)).filter(l => !/logo|icon|avatar|banner|cropped/i.test(l.url)).slice(0, 4)
        .forEach(l => push(l.url, p.day, p.label));
      const imgs = [...page.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(x => { try { return new URL(x[1], p.url).href; } catch (e) { return null; } })
        .filter(u => u && /wp-content\/uploads/.test(u) && !/logo|icon|avatar|banner|cropped|-\d{2,3}x\d{2,3}\./i.test(u));
      if (!out.some(o => o.day === p.day)) imgs.slice(0, 4).forEach(u => push(u, p.day, p.label));
    } catch (e) { /* that post can wait for the next check */ }
  }
  return out.sort((a, b) => String(b.day || '').localeCompare(String(a.day || '')));
}

/* ------------------------------ reading a file ------------------------------ */

let pdfjsP = null;
const pdfjs = () => pdfjsP || (pdfjsP = import(path.join(NM, 'pdfjs-dist/legacy/build/pdf.mjs')));

/** One OCR worker for a whole check (it takes a second to start), closed at the end. */
function ocrSession() {
  let w = null;
  return {
    async read(img) {
      if (!w) {
        const T = require('tesseract.js');
        w = await T.createWorker('eng', 1, { langPath: path.join(NM, '@tesseract.js-data/eng/4.0.0'), gzip: true, cachePath: require('os').tmpdir() });
        await w.setParameters({ preserve_interword_spaces: '1' });    // keeps the gaps between columns
      }
      return (await w.recognize(img)).data.text || '';
    },
    async close() { if (w) { const x = w; w = null; await x.terminate().catch(() => {}); } }
  };
}

/** A PDF page's words, laid out in lines; a wide gap between words becomes two spaces (a column break). */
function pageLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let row = rows.find(r => Math.abs(r.y - y) < 3);
    if (!row) rows.push(row = { y, items: [] });
    row.items.push({ x, end: x + (it.width || 0), s: it.str });
  }
  return rows.sort((a, b) => b.y - a.y).map(r => {
    r.items.sort((a, b) => a.x - b.x);
    let line = '', end = null;
    for (const it of r.items) {
      if (end != null) { const gap = it.x - end; line += gap > 9 ? '   ' : gap > 0.8 && !/\s$/.test(line) && !/^\s/.test(it.s) ? ' ' : ''; }
      line += it.s; end = it.end;
    }
    return line.trim();
  }).join('\n');
}

/** Text of a PDF or picture: { text, ocr }. Pages with no text (scans) are read with OCR. */
async function extract(buf, type, ocr) {
  const isPdf = buf.slice(0, 5).toString() === '%PDF-' || /pdf/.test(type);
  if (!isPdf) return { text: await ocr.read(buf), ocr: true };
  const P = await pdfjs();
  const doc = await P.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0,
    standardFontDataUrl: path.join(NM, 'pdfjs-dist/standard_fonts') + path.sep }).promise;
  const parts = []; let used = false;
  try {
    for (let i = 1; i <= Math.min(doc.numPages, 40); i++) {
      const page = await doc.getPage(i);
      let text = pageLines((await page.getTextContent()).items);
      if (text.replace(/\s/g, '').length < 40) {      // a scan: draw the page and read it
        const v1 = page.getViewport({ scale: 1 });
        const scale = Math.min(3, 3000 / Math.max(v1.width, v1.height));
        const vp = page.getViewport({ scale });
        const { canvas, context } = doc.canvasFactory.create(Math.ceil(vp.width), Math.ceil(vp.height));
        context.fillStyle = '#fff'; context.fillRect(0, 0, vp.width, vp.height);
        await page.render({ canvasContext: context, viewport: vp }).promise;
        const read = await ocr.read(canvas.toBuffer('image/png'));
        if (read.replace(/\s/g, '').length > text.replace(/\s/g, '').length) { text = read; used = true; }
      }
      parts.push(text);
      page.cleanup();
    }
  } finally { await doc.destroy(); }
  return { text: parts.join('\n'), ocr: used };
}

/* ------------------------------ matching ------------------------------ */

const STOP = new Set(['trust', 'trustee', 'trustees', 'tr', 'llc', 'inc', 'the', 'family', 'revocable', 'irrevocable', 'living', 'of', 'and', 'co', 'company',
  'ltd', 'lp', 'llp', 'dated', 'dtd', 'joint', 'estate', 'et', 'al', 'ux', 'vir', 'properties', 'property', 'holdings', 'investments', 'group', 'partners', 'mr', 'mrs', 'jr', 'sr', 'ii', 'iii']);
const words = s => String(s || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const plainAddr = a => String(a || '').replace(/\([^)]*\)?/g, ' ').split('&')[0];

/** Everything on the Members list worth looking for. Only members who are still active. */
async function index(companyId) {
  const rows = await db.q(`SELECT id, data FROM members WHERE company_id=$1 AND COALESCE(data->>'Status','Active') NOT ILIKE 'inactive%' ORDER BY position, id`, [companyId]);
  return rows.map(({ id, data: d }) => {
    const firsts = words(d['First name(s)']).filter(w => w.length >= 2 && !STOP.has(w));
    const lasts = words(d['Last name']).filter(w => w.length >= 3 && !STOP.has(w));
    const trust = words(d['Trust or LLC']).filter(w => !STOP.has(w) && !/^\d+$/.test(w));
    const parcel = squash(d['Parcel ID']);
    const addr = plainAddr(d['Deerfield address']);
    return { id, data: d, firsts, lasts, trust, parcel: parcel.length >= 6 ? parcel : '', parcelShort: parcel.replace(/0+$/, ''),
      k: addr ? M.addrKey(addr) : null, street: addr ? M.streetOf(addr) : '',
      name: [d['First name(s)'], d['Last name']].filter(Boolean).join(' ') || d['Trust or LLC'] || '', address: d['Deerfield address'] || '' };
  });
}

const ADDR_IN_TEXT = /\b[0-9]{2,5}[a-z]?\b(?:[ ,.#-]+[a-z0-9]+){1,6}/gi;

/** Why this member matches this bit of text: a list of reasons (strongest first), or []. */
function whyMatch(m, text, ws, sq) {
  const out = [];
  if (m.parcel && (sq.includes(m.parcel) || (m.parcelShort.length >= 6 && sq.includes(m.parcelShort)))) out.push('Parcel ID ' + m.data['Parcel ID']);
  if (m.k && m.k.house && m.street) {
    for (const t of String(text).match(ADDR_IN_TEXT) || []) {
      const k = M.addrKey(t);
      if (k.house && M.streetOf(t).includes(m.street) && M.sameProperty(k, m.k)) { out.push('Address ' + m.address); break; }
    }
  }
  if (m.lasts.length && m.lasts.every(w => ws.has(w)) && m.firsts.some(w => ws.has(w))) out.push('Owner name ' + m.name);
  const sig = m.trust.filter(w => w.length >= 3).slice(0, 3);
  if (sig.length && sig.some(w => w.length >= 4) && sig.every(w => ws.has(w))) out.push('Trust/LLC ' + m.data['Trust or LLC']);
  return out;
}

/** "Smith John & Mary to Roe Jane, 141 Deer Run" -> { from, to }; also "Grantor: … Grantee: …" and column layouts. */
function parties(line) {
  const s = String(line).replace(/\s+\|\s+/g, '   ');
  let m = /grantor[s]?\s*[:-]\s*(.+?)\s+grantee[s]?\s*[:-]\s*(.+)$/i.exec(s);
  const tidy = x => String(x || '').replace(/^[\s\d/.,#:-]+(?=[a-z])/i, '').split(/\s{3,}|,\s*(?=\d)|\$|\b(?:lot|dist(?:rict)?|map|parcel|tract|acres?|ac\.?)\b/i)[0]
    .replace(/[\s,;:-]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (m) return { from: tidy(m[1]), to: tidy(m[2]) };
  const cols = s.split(/\s{3,}/).map(x => x.trim()).filter(Boolean);
  m = /^(.*?\S)\s+(?:to|TO|To)\s+(\S.*)$/.exec(s);
  if (m && !/^\s*$/.test(m[1])) {
    const left = m[1].split(/\s{3,}/).pop();
    return { from: tidy(left), to: tidy(m[2]) };
  }
  const off = cols.length && /^[\d/.-]+$/.test(cols[0]) ? 1 : 0;   // a date or number column first
  if (cols.length >= off + 3 && /[a-z]{3}/i.test(cols[off]) && /[a-z]{3}/i.test(cols[off + 1])) return { from: tidy(cols[off]), to: tidy(cols[off + 1]) };
  return { from: '', to: '' };
}

const DEERFIELD = /\bdeer\s?field\b/i;

/**
 * Possible owner changes in one transfer list's text, given the members index.
 * Each: { key, excerpt, reasons, member_ids, old_owner, new_owner, address }
 */
function findChanges(text, members) {
  const lines = String(text).split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  const found = [], usedMembers = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.replace(/[^a-z]/gi, '').length < 6) continue;
    const win = line + ' ' + (lines[i + 1] || '');             // a record may wrap onto the next line
    const ws = new Set(words(line)), sq = squash(win);
    const hits = [];
    for (const m of members) {
      if (usedMembers.has(m.id)) continue;
      let r = whyMatch(m, line, ws, squash(line));
      if (!r.length && lines[i + 1]) {      // a parcel or address split across two lines
        const next = lines[i + 1], alone = whyMatch(m, next, new Set(words(next)), squash(next));
        r = whyMatch(m, win, new Set(words(win)), sq).filter(x => !/^Owner name|^Trust/.test(x) && !alone.includes(x));
      }
      if (r.length) hits.push({ m, r });
    }
    const deer = DEERFIELD.test(line);
    if (!hits.length && !deer) continue;
    const excerpt = lines.slice(Math.max(0, i - 1), i + 2).join('\n').slice(0, 600);
    const p = parties(line);
    const reasons = [...new Set(hits.flatMap(h => h.r))];
    if (deer) reasons.push('Mentions Deerfield');
    if (!hits.length && !p.from && !p.to) continue;            // a heading such as "Deerfield Resort" on its own
    hits.forEach(h => usedMembers.add(h.m.id));
    const lead = hits[0] && hits[0].m;
    // the member we found is usually the seller; if their name is on the buyer side, say so
    const buyerSide = lead && p.to && lead.lasts.length && lead.lasts.every(w => words(p.to).includes(w)) && !lead.lasts.every(w => words(p.from).includes(w));
    if (buyerSide) reasons.push('Member is the buyer');
    const addr = lead ? lead.address : ((line.match(ADDR_IN_TEXT) || []).find(a => /[a-z]{3}/i.test(a)) || (/\blot\s*#?\s*\w+[^,$]*/i.exec(line) || [''])[0]).trim();
    found.push({
      key: crypto.createHash('sha1').update(squash(line) + '|' + hits.map(h => h.m.id).sort().join(',')).digest('hex').slice(0, 32),
      excerpt, reasons, member_ids: hits.map(h => h.m.id),
      old_owner: (p.from || (lead && !buyerSide ? lead.name : '')).slice(0, 200), new_owner: (p.to || '').slice(0, 200), address: String(addr || '').slice(0, 200)
    });
  }
  return found;
}

/* ------------------------------ the check ------------------------------ */

const running = new Map();
const settings = async companyId => {
  const c = await db.one('SELECT transfers, member_columns FROM companies WHERE id=$1', [companyId]);
  const s = (c && c.transfers) || {};
  // on by default for a members list with Deerfield addresses (the Campbell County list is about them)
  const on = s.on != null ? !!s.on : ((c && c.member_columns) || []).includes('Deerfield address');
  return { on, emails: s.emails || '', lastRun: s.lastRun || null, lastError: s.lastError || '', lastFiles: s.lastFiles || 0, lastFound: s.lastFound || 0 };
};
async function saveSettings(companyId, b) {
  const cur = (await db.one('SELECT transfers FROM companies WHERE id=$1', [companyId])).transfers || {};
  const emails = b.emails == null ? cur.emails || '' : String(b.emails).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  if (Array.isArray(emails)) { if (emails.some(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) V.bad('Check the email addresses.'); if (emails.length > 10) V.bad('Up to 10 emails.'); }
  const next = { ...cur, ...(b.on != null ? { on: !!b.on } : {}), emails: Array.isArray(emails) ? emails.join(', ') : emails };
  await db.q('UPDATE companies SET transfers=$1 WHERE id=$2', [JSON.stringify(next), companyId]);
  return settings(companyId);
}
const note = async (companyId, patch) => db.q(`UPDATE companies SET transfers=COALESCE(transfers,'{}'::jsonb) || $1::jsonb WHERE id=$2`, [JSON.stringify(patch), companyId]);

/**
 * Read the transfer lists not read yet and keep any possible owner changes.
 * Returns { files, found: [new change ids], errors }.
 */
async function check(companyId, { today, maxFiles = MAX_FILES, listUrl } = {}) {
  if (running.get(companyId)) return running.get(companyId);
  const job = (async () => {
    const ocr = ocrSession();
    const res = { files: 0, found: [], errors: [] };
    try {
      const list = await listFiles(listUrl);
      const from = new Date(new Date(today || Date.now()).getTime() - BACKFILL_DAYS * 864e5).toISOString().slice(0, 10);
      const done = new Map((await db.q('SELECT url, status, checked_at FROM transfer_sources WHERE company_id=$1', [companyId])).map(r => [r.url, r]));
      const members = await index(companyId);
      for (const f of list) {
        if (res.files >= maxFiles) break;
        if (f.day && f.day < from) continue;
        const was = done.get(f.url);
        if (was && (was.status === 'ok' || (was.status === 'error' && Date.now() - new Date(was.checked_at) < 20 * 3600e3))) continue;
        res.files++;
        try {
          const { buf, type } = await get(f.url, { binary: true });
          if (/text\/html/.test(type)) throw new Error('That link is a web page, not a file. Open it to check by hand.');
          const { text, ocr: used } = await extract(buf, type, ocr);
          const changes = findChanges(text, members);
          for (const c of changes) {
            const r = await db.q(`INSERT INTO property_changes (company_id, day, url, excerpt, key, reasons, member_ids, old_owner, new_owner, address)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (company_id, key) DO NOTHING RETURNING id`,
              [companyId, f.day, f.url, c.excerpt, c.key, JSON.stringify(c.reasons), c.member_ids, c.old_owner, c.new_owner, c.address]);
            if (r.length) res.found.push(r[0].id);
          }
          await db.q(`INSERT INTO transfer_sources (company_id, url, day, status, chars, ocr, error, checked_at) VALUES ($1,$2,$3,'ok',$4,$5,'',now())
            ON CONFLICT (company_id, url) DO UPDATE SET day=EXCLUDED.day, status='ok', chars=EXCLUDED.chars, ocr=EXCLUDED.ocr, error='', checked_at=now()`,
            [companyId, f.url, f.day, text.length, used]);
        } catch (e) {
          res.errors.push(`${f.label || f.url}: ${e.message}`);
          await db.q(`INSERT INTO transfer_sources (company_id, url, day, status, error, checked_at) VALUES ($1,$2,$3,'error',$4,now())
            ON CONFLICT (company_id, url) DO UPDATE SET status='error', error=EXCLUDED.error, checked_at=now()`, [companyId, f.url, f.day, String(e.message).slice(0, 300)]);
        }
      }
      await note(companyId, { lastRun: new Date().toISOString(), lastError: res.errors.length ? `${res.errors.length} list(s) couldn't be read.` : '', lastFiles: res.files, lastFound: res.found.length });
    } catch (e) {
      await note(companyId, { lastRun: new Date().toISOString(), lastError: `Couldn't open WLAF's transfer page: ${e.message}`, lastFiles: 0, lastFound: 0 });
      throw e;
    } finally { await ocr.close(); }
    return res;
  })();
  running.set(companyId, job);
  try { return await job; } finally { running.delete(companyId); }
}

/* ------------------------------ review ------------------------------ */

async function list(companyId, { status } = {}) {
  const st = ['new', 'approved', 'dismissed', 'all'].includes(status) ? status : 'new';
  const rows = await db.q(`SELECT id, day, url, excerpt, reasons, member_ids, old_owner, new_owner, address, status, emailed_at, decided_at, created_at
    FROM property_changes WHERE company_id=$1 ${st === 'all' ? '' : 'AND status=$2'} ORDER BY day DESC NULLS LAST, id DESC LIMIT 300`, st === 'all' ? [companyId] : [companyId, st]);
  const ids = [...new Set(rows.flatMap(r => r.member_ids))];
  const mem = ids.length ? await db.q('SELECT id, data FROM members WHERE company_id=$1 AND id = ANY($2)', [companyId, ids]) : [];
  const byId = new Map(mem.map(m => [m.id, m.data]));
  const counts = Object.fromEntries((await db.q('SELECT status, count(*)::int AS n FROM property_changes WHERE company_id=$1 GROUP BY status', [companyId])).map(r => [r.status, r.n]));
  const sources = await db.q('SELECT url, day, status, chars, ocr, error, checked_at FROM transfer_sources WHERE company_id=$1 ORDER BY day DESC NULLS LAST, checked_at DESC LIMIT 40', [companyId]);
  return {
    settings: await settings(companyId), running: running.has(companyId), counts, sources,
    changes: rows.map(r => ({ ...r, members: r.member_ids.filter(id => byId.has(id)).map(id => { const d = byId.get(id); return { id, name: [d['First name(s)'], d['Last name']].filter(Boolean).join(' '), trust: d['Trust or LLC'] || '', address: d['Deerfield address'] || '', parcel: d['Parcel ID'] || '', first: d['First name(s)'] || '', last: d['Last name'] || '' }; }) }))
  };
}

const getChange = async (companyId, id) => {
  const c = await db.one('SELECT * FROM property_changes WHERE id=$1 AND company_id=$2', [Number(id) || 0, companyId]);
  if (!c) V.bad('That change was not found.');
  return c;
};

/**
 * Approve: the member's owner becomes the new owner; the old owner and their phones and emails move to "Previous owner".
 * Without a member (say a Deerfield lot that isn't on the list), it is just marked reviewed.
 */
async function approve(companyId, id, b = {}) {
  const c = await getChange(companyId, id);
  if (c.status !== 'new') V.bad('That change was already decided.');
  const memberId = b.member_id ? Number(b.member_id) : null;
  if (memberId) {
    const m = await db.one('SELECT data FROM members WHERE id=$1 AND company_id=$2', [memberId, companyId]);
    if (!m) V.bad('That member was not found.');
    const first = String(b.first || '').trim(), last = String(b.last || '').trim(), trust = String(b.trust || '').trim();
    if (!first && !last && !trust) V.bad('Type the new owner’s name.');
    let cols = await MB.columns(companyId);
    const add = ['First name(s)', 'Last name', 'Trust or LLC', 'Previous owner', 'Owner changed'].filter(k => !cols.includes(k));
    if (add.length) {
      if (cols.length + add.length > 60) V.bad('The members list has too many columns to add "Previous owner".');
      cols = [...cols, ...add];
      await db.q('UPDATE companies SET member_columns=$1 WHERE id=$2', [JSON.stringify(cols), companyId]);
    }
    const d = { ...m.data };
    const oldName = [d['First name(s)'], d['Last name']].filter(Boolean).join(' ') || d['Trust or LLC'] || '';
    const contact = b.keep_contact ? [] : cols.filter(k => /phone|e-?mail/i.test(k) && d[k]).map(k => { const v = d[k]; delete d[k]; return v; });
    const prev = [oldName + (d['Trust or LLC'] && oldName !== d['Trust or LLC'] ? ` (${d['Trust or LLC']})` : ''), ...contact].filter(Boolean).join(' · ');
    d['Previous owner'] = [prev, d['Previous owner']].filter(Boolean).join(' | ').slice(0, 1000);
    d['Owner changed'] = c.day ? new Date(c.day).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    d['First name(s)'] = first; d['Last name'] = last; d['Trust or LLC'] = trust;
    await MB.save(companyId, memberId, d);
  }
  await db.q("UPDATE property_changes SET status='approved', decided_at=now(), new_owner=COALESCE(NULLIF($3,''), new_owner) WHERE id=$1 AND company_id=$2",
    [c.id, companyId, [b.first, b.last].filter(Boolean).join(' ') || String(b.trust || '')]);
  return { ok: true };
}
async function dismiss(companyId, id) { const c = await getChange(companyId, id); await db.q("UPDATE property_changes SET status='dismissed', decided_at=now() WHERE id=$1", [c.id]); return { ok: true }; }
async function reopen(companyId, id) {
  const c = await getChange(companyId, id);
  if (c.status !== 'dismissed') V.bad('Only dismissed changes can be brought back. An approved change is already on the members list.');
  await db.q("UPDATE property_changes SET status='new', decided_at=NULL WHERE id=$1", [c.id]); return { ok: true };
}

/* ------------------------------ the sheet & the email ------------------------------ */

const usDate = d => { if (!d) return ''; const s = new Date(d).toISOString().slice(0, 10); return `${+s.slice(5, 7)}/${+s.slice(8)}/${s.slice(0, 4)}`; };

async function xlsx(companyId, ids) {
  const ExcelJS = require('exceljs');
  const all = (await list(companyId, { status: ids ? 'all' : 'new' })).changes.filter(c => !ids || ids.includes(c.id));
  const wb = new ExcelJS.Workbook(); wb.creator = config.productName;
  const ws = wb.addWorksheet('Possible owner changes', { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [
    { header: 'Date', key: 'day', width: 12 }, { header: 'Property', key: 'address', width: 30 }, { header: 'Old owner', key: 'old', width: 30 },
    { header: 'New owner', key: 'new', width: 30 }, { header: 'On the Members list as', key: 'member', width: 30 }, { header: 'Why it matched', key: 'why', width: 30 },
    { header: 'From the transfer list', key: 'excerpt', width: 60 }, { header: 'Source', key: 'url', width: 18 }, { header: 'Status', key: 'status', width: 11 }];
  ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2328' } }; });
  for (const c of all) {
    const row = ws.addRow({ day: usDate(c.day), address: c.address, old: c.old_owner, new: c.new_owner,
      member: c.members.map(m => [m.name || m.trust, m.address].filter(Boolean).join(', ')).join('\n'), why: c.reasons.join('\n'),
      excerpt: c.excerpt, url: { text: 'Open the list', hyperlink: c.url }, status: c.status });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('url').font = { color: { argb: 'FF0B5CAD' }, underline: true };
  }
  if (!all.length) ws.addRow({ day: '', address: 'No possible owner changes.' });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), count: all.length };
}

/** Email the boss the changes found that haven't been emailed yet. Returns the number sent (0 = no email). */
async function emailNew(company) {
  const { send, esc, layout } = require('./email');
  const rows = await db.q("SELECT id FROM property_changes WHERE company_id=$1 AND status='new' AND emailed_at IS NULL ORDER BY day DESC NULLS LAST, id DESC", [company.id]);
  const s = await settings(company.id);
  if (!rows.length && !s.lastError) return 0;
  const to = s.emails || await require('./reports').recipients(company);
  const ids = rows.map(r => r.id);
  const items = (await list(company.id, { status: 'new' })).changes.filter(c => ids.includes(c.id));
  const link = `${config.appUrl}/admin#changes`;
  const table = items.slice(0, 40).map(c => `<tr><td style="padding:6px 8px;border-top:1px solid #e5e5e5;white-space:nowrap">${esc(usDate(c.day))}</td>
    <td style="padding:6px 8px;border-top:1px solid #e5e5e5">${esc(c.address || '')}</td><td style="padding:6px 8px;border-top:1px solid #e5e5e5">${esc(c.old_owner || '')}</td>
    <td style="padding:6px 8px;border-top:1px solid #e5e5e5"><b>${esc(c.new_owner || '?')}</b></td></tr>`).join('');
  const body = rows.length
    ? `<p>The Campbell County transfer lists on WLAF show <b>${rows.length} possible owner change${rows.length === 1 ? '' : 's'}</b> for Deerfield. Nothing on the Members list has changed. Approve or dismiss each one on the dashboard.</p>
       <table style="border-collapse:collapse;font-size:14px;width:100%"><tr style="text-align:left;color:#555"><th style="padding:6px 8px">Date</th><th style="padding:6px 8px">Property</th><th style="padding:6px 8px">Old owner</th><th style="padding:6px 8px">New owner</th></tr>${table}</table>
       ${items.length > 40 ? `<p>…and ${items.length - 40} more in the attached sheet.</p>` : ''}
       <p><a href="${esc(link)}">Review them on the dashboard</a>. The attached sheet has the source line from each transfer list.</p>`
    : '';
  const warn = s.lastError ? `<p style="color:#b42318">${esc(s.lastError)} <a href="${esc(link)}">See which ones</a>.</p>` : '';
  const att = rows.length ? [{ filename: `Property changes ${new Date().toISOString().slice(0, 10)}.xlsx`, content: (await xlsx(company.id, ids)).buffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }] : undefined;
  await send({ to, subject: rows.length ? `Property changes to review: ${rows.length} (Campbell County transfers)` : 'Property-transfer check: some lists couldn’t be read',
    html: layout(rows.length ? 'Possible owner changes' : 'Property-transfer check', `${body}${warn}`), attachments: att });
  if (ids.length) await db.q('UPDATE property_changes SET emailed_at=now() WHERE id = ANY($1)', [ids]);
  return rows.length;
}

/** The weekly run from the scheduler. */
async function weekly(company) {
  try { await check(company.id); } catch (e) { /* noted in settings.lastError; the email says so */ }
  return emailNew(company);
}

module.exports = { dayOf, links, listFiles, extract, pageLines, parties, findChanges, index, check, list, approve, dismiss, reopen, xlsx, emailNew, weekly, settings, saveSettings, running };
