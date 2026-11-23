// Lead and copper consumer notices: TDEC's "Notification of Results" template, filled in once for every tap in a
// lead/copper round (location, date, that tap's lead and copper results, PWS ID, operator name, phone, email), all in
// one Word file with a page break between homes. The template's own wording is left exactly as TDEC wrote it.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const db = require('./db');
const V = require('./validate');
const H = require('./hours');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'lead-copper-notice.docx');

const x = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const usDate = d => { const [y, m, dd] = String(d).split('-'); return `${+m}/${+dd}/${y}`; };

/** The taps in a round: [{ point, lead, copper }] from the results saved for that day. */
async function round(company, day) {
  const rows = await db.q(`SELECT point, test, result, units FROM cw_results WHERE company_id=$1 AND day=$2 AND test IN ('Lead','Copper') ORDER BY point, test`, [company.id, day]);
  const taps = new Map();
  for (const r of rows) {
    const k = r.point || '(no sample point)';
    if (!taps.has(k)) taps.set(k, { point: r.point, lead: null, copper: null });
    taps.get(k)[r.test === 'Lead' ? 'lead' : 'copper'] = r;
  }
  return [...taps.values()];
}

/** Lead/copper rounds there are notices for: [{ day, taps }] newest first. */
async function rounds(company) {
  return db.q(`SELECT to_char(day,'YYYY-MM-DD') AS day, count(DISTINCT point)::int AS taps FROM cw_results
    WHERE company_id=$1 AND test IN ('Lead','Copper') GROUP BY day ORDER BY day DESC LIMIT 40`, [company.id]);
}

/** A result as it goes in the blank, in mg/L like the template ("0.0042", "<0.0010", "ND"). */
function inMgL(r) {
  if (!r) return 'Not tested';
  if (r.result === 'Not detected') return 'ND';
  if (r.units === 'µg/L') {     // the template's blanks are mg/L
    const m = /^([<>]?)(\d*\.?\d+)$/.exec(r.result);
    if (m) return m[1] + String(+(Number(m[2]) / 1000).toPrecision(4));
  }
  return r.result;
}

/** Fill one copy of the body. */
function fillBody(body, t, sys) {
  let i = 0;
  // the two result blanks, in order: lead, then copper
  body = body.replace(/<w:t xml:space="preserve">            <\/w:t>/g, m => {
    i++;
    if (i === 1) return `<w:t xml:space="preserve"> ${x(inMgL(t.lead))} </w:t>`;
    if (i === 2) return `<w:t xml:space="preserve"> ${x(inMgL(t.copper))} </w:t>`;
    return m;
  });
  // the results line: a fixed gap before "Copper" (the template's tab stop is too close for longer results)
  body = body.replace('<w:tab/><w:t xml:space="preserve">Copper </w:t>', '<w:t xml:space="preserve">        Copper </w:t>');   // first one only: the results line
  if (sys.operator) body = body.replace('<w:t>Operator Name</w:t>', `<w:t>${x(sys.operator)}</w:t>`);
  if (sys.phone) body = body.replace('<w:t>(         )</w:t>', `<w:t xml:space="preserve">${x(sys.phone)}</w:t>`);
  if (sys.email) {
    // the underlined run after "or via email at "
    body = body.replace(/(or via email at <\/w:t><\/w:r>\s*<w:r\b[^>]*>\s*<w:rPr>[\s\S]*?<\/w:rPr>)[\s\S]*?(<\/w:r>)/, (m, a, b) => `${a}<w:t xml:space="preserve"> ${x(sys.email)} </w:t>${b}`);
  }
  return body;
}

/** The first-page header for one home: Location and Date filled in. */
function fillHeader(h, t, noticeDay) {
  const loc = t.point || '';
  // the underlined tab right after "Location:" / "Date:" gets the text in front of it
  h = h.replace(/(<w:t>Location:<\/w:t><\/w:r>\s*<w:r\b[^>]*>\s*<w:rPr>[\s\S]*?<\/w:rPr>)(<w:tab\/>)/, (m, a, b) => `${a}<w:t xml:space="preserve"> ${x(loc)}</w:t>${b}`);
  h = h.replace(/(<w:t>Date:<\/w:t><\/w:r>\s*<w:r\b[^>]*>\s*<w:rPr>[\s\S]*?<\/w:rPr>)(<w:tab\/>)/, (m, a, b) => `${a}<w:t xml:space="preserve"> ${x(usDate(noticeDay))}</w:t>${b}`);
  return h;
}

/** One Word file with a notice per tap. */
async function build(company, { day, noticeDay, points } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) V.bad('Pick the lead and copper round.');
  const today = H.today(company);
  noticeDay = /^\d{4}-\d{2}-\d{2}$/.test(String(noticeDay || '')) ? noticeDay : today;
  let taps = await round(company, day);
  if (Array.isArray(points) && points.length) taps = taps.filter(t => points.includes(t.point));
  if (!taps.length) V.bad('No lead or copper results were found for that day.');
  const c = await db.one('SELECT cw_system FROM companies WHERE id=$1', [company.id]);
  const sys = (c && c.cw_system) || {};

  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  let doc = await zip.file('word/document.xml').async('string');
  const header = await zip.file('word/header2.xml').async('string');
  let rels = await zip.file('word/_rels/document.xml.rels').async('string');
  let types = await zip.file('[Content_Types].xml').async('string');
  let footer = await zip.file('word/footer1.xml').async('string');

  // PWS ID in the footer ("TN000" + blank)
  if (sys.pwsid) footer = footer.replace(/<w:t>TN000<\/w:t>/, `<w:t>${x(sys.pwsid)}</w:t>`).replace(/(<w:t>[^<]*<\/w:t><\/w:r>\s*<w:r\b[^>]*>\s*<w:rPr>[\s\S]*?<\/w:rPr>)<w:t xml:space="preserve">       <\/w:t>/, '$1<w:t xml:space="preserve"> </w:t>');
  zip.file('word/footer1.xml', footer);

  const open = doc.indexOf('<w:body>') + '<w:body>'.length;
  const sectStart = doc.lastIndexOf('<w:sectPr');
  const close = doc.lastIndexOf('</w:body>');
  const body = doc.slice(open, sectStart), sect = doc.slice(sectStart, close);

  const parts = [];
  taps.forEach((t, n) => {
    const rid = `rIdNotice${n + 1}`, file = `headerNotice${n + 1}.xml`;
    zip.file(`word/${file}`, fillHeader(header, t, noticeDay));
    rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${file}"/></Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/word/${file}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`);
    const s = sect.replace(/<w:headerReference w:type="first" r:id="[^"]+"\/>/, `<w:headerReference w:type="first" r:id="${rid}"/>`);
    const b = fillBody(body, t, sys);
    // every home but the last ends with a section break (its own first-page header, a new page)
    parts.push(n < taps.length - 1 ? `${b}<w:p><w:pPr>${s}</w:pPr></w:p>` : `${b}${s}`);
  });
  doc = doc.slice(0, open) + parts.join('') + doc.slice(close);
  zip.file('word/document.xml', doc);
  zip.file('word/_rels/document.xml.rels', rels);
  zip.file('[Content_Types].xml', types);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const missing = ['operator', 'phone', 'email', 'pwsid'].filter(k => !sys[k]);
  return { buffer: buf, taps: taps.length, missing };
}

function mount(r, prefix, guard) {
  const g = guard ? [].concat(guard) : [];
  r.get(prefix + '/results/lcr-rounds', ...g, async (req, res) => res.json({ rounds: await rounds(req.company) }));
  r.get(prefix + '/results/lcr-notices.docx', ...g, async (req, res) => {
    const f = await build(req.company, { day: req.query.day, noticeDay: req.query.date, points: req.query.point ? [].concat(req.query.point) : null });
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="lead-copper-notices-${String(req.query.day).replace(/[^\d-]/g, '')}.docx"`,
      'X-Notices': String(f.taps), 'X-Missing': f.missing.join(','), 'Cache-Control': 'no-store' }).send(f.buffer);
  });
}

module.exports = { build, round, rounds, inMgL, mount };
