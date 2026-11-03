// Board report: a week or a month of what the crew did, with the photos they took, for the board.
// The boss picks the period, adds a message and notes, and leaves out any item or photo; the board opens it
// with a private link (no sign-in), prints it or saves it as a PDF.
const crypto = require('crypto');
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const H = require('./hours');
const config = require('./config');
const { send, esc, layout } = require('./email');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_DAYS = 93;
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDate = d => `${T.pretty(d)}, ${d.slice(0, 4)}`;
const lastOfMonth = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** The dates for a week (the company's week, around `start`) or a calendar month (`start` = YYYY-MM or a date in it). */
function period(company, kind, start) {
  const today = H.today(company);
  if (kind === 'month') {
    const ym = /^\d{4}-\d{2}/.test(String(start || '')) ? String(start).slice(0, 7) : today.slice(0, 7);
    if (!T.isDate(ym + '-01')) V.bad('Pick a month.');
    return { kind, from: ym + '-01', to: lastOfMonth(ym), label: `${MONTH_NAMES[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}` };
  }
  const d = T.isDate(String(start || '')) ? start : today;
  const from = T.weekStartOf(d, company.week_start), to = T.shift(from, 6);
  return { kind: 'week', from, to, label: `Week of ${T.pretty(from)} – ${T.pretty(to)}, ${to.slice(0, 4)}` };
}
function checkRange(from, to) {
  if (!T.isDate(from) || !T.isDate(to) || to < from) V.bad('Pick the dates for the report.');
  if ((T.toUTC(to) - T.toUTC(from)) / 864e5 > MAX_DAYS) V.bad(`A report can cover up to ${MAX_DAYS} days.`);
}

const local = (col, n = 2) => `(${col} AT TIME ZONE $${n})::date`;
const day = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const localDay = (ts, tz) => T.localNow(tz, new Date(ts)).date;

/** Done tasks / repairs in the period, each with its photos (when it was finished and while it was underway). */
async function doneTasks(company, kind, from, to) {
  const tz = company.timezone || 'America/New_York';
  const rows = await db.q(`SELECT t.id, t.title, t.details, t.address, t.priority, t.done_at, t.done_notes, d.name AS by,
      COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM task_photos p WHERE p.task_id=t.id), '[]') AS photos,
      COALESCE((SELECT json_agg(json_build_object('by', u.by_name, 'note', u.note, 'at', u.created_at) ORDER BY u.id) FROM task_updates u WHERE u.task_id=t.id AND u.note <> ''), '[]') AS updates
    FROM tasks t LEFT JOIN crew d ON d.id=t.done_by
    WHERE t.company_id=$1 AND t.kind=$3 AND t.status='done' AND ${local('t.done_at')} BETWEEN $4 AND $5 ORDER BY t.done_at, t.id`, [company.id, tz, kind, from, to]);
  return rows.map(r => {
    const when = localDay(r.done_at, tz);
    const text = [r.done_notes, ...r.updates.map(u => `${u.by ? u.by + ': ' : ''}${u.note}`)].filter(Boolean);
    return { key: (kind === 'repair' ? 'rep' : 'task') + r.id, title: r.title, priority: kind === 'repair' && r.priority !== 'normal' ? r.priority : '',
      sub: [r.address, `${kind === 'repair' ? 'Fixed' : 'Done'} ${T.dayName(when)} ${T.pretty(when)}${r.by ? ' by ' + r.by : ''}`].filter(Boolean).join(' · '),
      text: text.join('\n'), details: r.details, photos: r.photos.map(id => 'tp' + id) };
  });
}

/** Roads mowed, or water sites checked: one item per place, with each visit and its photos. */
async function visits(company, kind, from, to) {
  const rows = await db.q(`SELECT r.id AS place, r.name, to_char(m.day, 'YYYY-MM-DD') AS day, m.notes, c.name AS by,
      COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM road_mow_photos p WHERE p.mow_id=m.id), '[]') AS photos
    FROM road_mows m JOIN roads r ON r.id=m.road_id LEFT JOIN crew c ON c.id=m.crew_id
    WHERE m.company_id=$1 AND r.kind=$2 AND m.day BETWEEN $3 AND $4 ORDER BY r.position, lower(r.name), m.day, m.id`, [company.id, kind, from, to]);
  const by = new Map();
  rows.forEach(r => {
    if (!by.has(r.place)) by.set(r.place, { key: (kind === 'water' ? 'site' : 'road') + r.place, title: r.name, days: [], text: [], photos: [] });
    const it = by.get(r.place);
    it.days.push(`${T.pretty(r.day)}${r.by ? ' (' + r.by + ')' : ''}`);
    if (r.notes) it.text.push(`${T.pretty(r.day)}: ${r.notes}`);
    it.photos.push(...r.photos.map(id => 'mp' + id));
  });
  return [...by.values()].map(it => ({ key: it.key, title: it.title, photos: it.photos, text: it.text.join('\n'),
    sub: `${kind === 'water' ? 'Checked' : 'Mowed'} ${it.days.length === 1 ? 'once' : it.days.length + ' times'}: ${it.days.join(', ')}` }));
}

/** Everything for the period, before the boss's notes and choices. */
async function build(company, from, to) {
  checkRange(from, to);
  const tz = company.timezone || 'America/New_York', id = company.id;

  // crew hours, from each week that touches the period
  const people = new Map();
  const dayPics = [];
  for (let ws = T.weekStartOf(from, company.week_start); ws <= to; ws = T.shift(ws, 7)) {
    const w = await H.crewWeek(company, ws);
    w.people.forEach(p => Object.entries(p.days).forEach(([d, e]) => {
      if (d < from || d > to) return;
      const cur = people.get(p.id) || { name: p.name, h: 0 }; cur.h = T.round2(cur.h + e.total); people.set(p.id, cur);
      if (e.photos && e.photos.length) dayPics.push({ key: `day${p.id}-${d}`, title: `${p.name} · ${T.dayName(d)} ${T.pretty(d)}`,
        sub: [e.summary && 'Deerfield', e.oSummary && e.oJob].filter(Boolean).join(' · '), text: [e.summary, e.oSummary].filter(Boolean).join('\n'),
        photos: e.photos.map(ph => 'dp' + ph) });
    }));
  }
  const hoursList = [...people.entries()].filter(([, p]) => p.h > 0).sort((a, b) => b[1].h - a[1].h);
  const totalHours = T.round2(hoursList.reduce((a, [, p]) => a + p.h, 0));

  const repairs = await doneTasks(company, 'repair', from, to);
  const tasks = await doneTasks(company, 'task', from, to);
  const roads = await visits(company, 'road', from, to);
  const water = await visits(company, 'water', from, to);
  const counts = await db.one(`SELECT
      (SELECT count(*)::int FROM tasks WHERE company_id=$1 AND kind='repair' AND ${local('created_at')} BETWEEN $3 AND $4) AS reported,
      (SELECT count(*)::int FROM roads WHERE company_id=$1 AND kind='road' AND active) AS road_total,
      (SELECT count(*)::int FROM road_mows m JOIN roads r ON r.id=m.road_id WHERE m.company_id=$1 AND r.kind='water' AND m.day BETWEEN $3 AND $4) AS checks,
      (SELECT count(*) FILTER (WHERE NOT cant_read)::int FROM meter_reads WHERE company_id=$1 AND ${local('read_at')} BETWEEN $3 AND $4) AS reads,
      (SELECT count(*) FILTER (WHERE cant_read)::int FROM meter_reads WHERE company_id=$1 AND ${local('read_at')} BETWEEN $3 AND $4) AS cant_read`, [id, tz, from, to]);
  const open = await db.q(`SELECT id, title, address, priority, to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS reported FROM tasks
    WHERE company_id=$1 AND kind='repair' AND (status='open' OR ${local('done_at')} > $3) AND ${local('created_at')} <= $3
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'low' THEN 3 ELSE 2 END, created_at`, [id, tz, to]);
  const orders = await db.q(`SELECT t.id, t.title, t.qty, t.actual_cost, t.arrived_at,
      COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM task_photos p WHERE p.task_id=t.id), '[]') AS photos
    FROM tasks t WHERE t.company_id=$1 AND t.kind='order' AND ${local('t.arrived_at')} BETWEEN $3 AND $4 ORDER BY t.arrived_at`, [id, tz, from, to]);
  const spent = orders.reduce((a, o) => a + Number(o.actual_cost || 0), 0);

  const summary = [
    totalHours && { label: 'Crew hours', value: totalHours.toLocaleString('en-US') },
    (repairs.length || counts.reported) && { label: 'Leaks & repairs fixed', value: repairs.length + (counts.reported ? ` <small>of ${counts.reported} reported</small>` : '') },
    tasks.length && { label: 'Tasks done', value: String(tasks.length) },
    roads.length && { label: 'Roads mowed', value: roads.length + (counts.road_total ? ` <small>of ${counts.road_total}</small>` : '') },
    counts.checks && { label: 'Water system checks', value: String(counts.checks) },
    (counts.reads || counts.cant_read) && { label: 'Meters read', value: String(counts.reads) + (counts.cant_read ? ` <small>${counts.cant_read} couldn't be read</small>` : '') },
    orders.length && { label: 'Spent on parts', value: money(spent) }
  ].filter(Boolean);

  const sections = [
    { key: 'repairs', title: 'Leaks & repairs fixed', items: repairs },
    { key: 'open', title: 'Leaks & repairs still open', list: open.map(o => ({ key: 'open' + o.id, title: o.title, priority: o.priority !== 'normal' ? o.priority : '',
        sub: [o.address, 'reported ' + T.pretty(o.reported)].filter(Boolean).join(' · ') })) },
    { key: 'tasks', title: 'Tasks completed', items: tasks },
    { key: 'roads', title: 'Roads mowed', items: roads },
    { key: 'water', title: 'Water system checks', items: water },
    { key: 'orders', title: 'Parts & supplies received', items: orders.map(o => ({ key: 'ord' + o.id, title: o.title,
        sub: [o.qty && 'Qty ' + o.qty, o.actual_cost != null && money(o.actual_cost), 'arrived ' + T.pretty(localDay(o.arrived_at, tz))].filter(Boolean).join(' · '),
        photos: o.photos.map(p => 'tp' + p) })) },
    { key: 'days', title: 'More from the crew', items: dayPics },
    { key: 'hours', title: 'Crew hours', list: hoursList.map(([cid, p]) => ({ key: 'hrs' + cid, title: p.name, sub: p.h.toFixed(2) + ' h' })) }
  ].filter(s => (s.items || s.list).length);
  return { from, to, company: company.name, summary, sections };
}

/* --------------------------- the saved report (notes, choices, link) --------------------------- */
const newToken = () => crypto.randomBytes(24).toString('base64url');
async function row(company, from, to) {
  checkRange(from, to);
  await db.q(`INSERT INTO board_reports (company_id, start_day, end_day, token) VALUES ($1,$2,$3,$4) ON CONFLICT (company_id, start_day, end_day) DO NOTHING`,
    [company.id, from, to, newToken()]);
  return db.one('SELECT * FROM board_reports WHERE company_id=$1 AND start_day=$2 AND end_day=$3', [company.id, from, to]);
}
const linkOf = r => `${config.appUrl}/board/${r.token}`;
function labelOf(company, from, to) {
  if (from.slice(8) === '01' && to === lastOfMonth(from.slice(0, 7))) return period(company, 'month', from).label;
  return `${longDate(from).replace(/, \d{4}$/, '')} – ${longDate(to)}`;
}
const edits = r => ({ intro: r.intro, notes: r.notes || {}, hidden: r.hidden || [] });

/** For the dashboard: everything, plus what the boss changed. */
async function get(company, from, to) {
  const r = await row(company, from, to);
  return { ...(await build(company, from, to)), label: labelOf(company, from, to), ...edits(r), link: linkOf(r), sentAt: r.sent_at, sentTo: r.sent_to,
    boardEmails: company.board_emails || '' };
}

async function save(company, from, to, b) {
  const r = await row(company, from, to);
  const intro = b.intro !== undefined ? String(b.intro || '').slice(0, 5000) : r.intro;
  const notes = b.notes !== undefined ? Object.fromEntries(Object.entries(b.notes || {}).filter(([k, v]) => /^[a-z][\w-]{0,40}$/i.test(k) && String(v || '').trim())
    .slice(0, 500).map(([k, v]) => [k, String(v).slice(0, 2000)])) : r.notes;
  const hidden = b.hidden !== undefined ? [...new Set((Array.isArray(b.hidden) ? b.hidden : []).map(String).filter(k => /^[a-z][\w-]{0,40}$/i.test(k)))].slice(0, 3000) : r.hidden;
  await db.q('UPDATE board_reports SET intro=$1, notes=$2, hidden=$3, updated_at=now() WHERE id=$4', [intro, JSON.stringify(notes), JSON.stringify(hidden), r.id]);
  return { intro, notes, hidden };
}

/** A new private link; the old one stops working. */
async function newLink(company, from, to) {
  const r = await row(company, from, to);
  const token = newToken();
  await db.q('UPDATE board_reports SET token=$1 WHERE id=$2', [token, r.id]);
  return { link: linkOf({ token }) };
}

/** What the board sees: the report with the boss's choices applied. */
function applyEdits(data, e) {
  const hide = new Set(e.hidden || []);
  const sections = data.sections.filter(s => !hide.has(s.key)).map(s => ({ ...s, note: (e.notes || {})[s.key] || '',
    items: s.items && s.items.filter(i => !hide.has(i.key)).map(i => ({ ...i, note: (e.notes || {})[i.key] || '', photos: (i.photos || []).filter(p => !hide.has(p)) })),
    list: s.list && s.list.filter(i => !hide.has(i.key)) })).filter(s => (s.items || s.list).length || s.note);
  return { ...data, sections, intro: e.intro || '' };
}

/** The shared page: by its link. Returns null for a link that isn't (or is no longer) valid. */
const cache = new Map();   // token -> { at, company, report, photos }
async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const c = cache.get(token);
  if (c && Date.now() - c.at < 60e3) return c;
  const r = await db.one('SELECT * FROM board_reports WHERE token=$1', [token]);
  if (!r) return null;
  const company = await db.one('SELECT * FROM companies WHERE id=$1', [r.company_id]);
  const from = day(r.start_day), to = day(r.end_day);
  const report = applyEdits(await build(company, from, to), edits(r));
  report.label = labelOf(company, from, to);
  const photos = new Set();
  report.sections.forEach(s => (s.items || []).forEach(i => i.photos.forEach(p => photos.add(p))));
  const out = { at: Date.now(), company, report, photos };
  cache.set(token, out);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}
const forget = () => cache.clear();

/** One photo in a report: only photos that are in it (and not left out). */
async function photo(companyId, key) {
  const m = /^(tp|mp|dp)(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  const table = { tp: 'task_photos', mp: 'road_mow_photos', dp: 'day_photos' }[m[1]];
  return db.one(`SELECT mime, data FROM ${table} WHERE id=$1 AND company_id=$2`, [Number(m[2]), companyId]);
}

const PRI_COLOR = { urgent: '#b42318', high: '#b4540a', low: '#57606a' };
const nl = s => esc(s).replace(/\n/g, '<br>');

/** The report as a page (also what prints / saves as a PDF). photoUrl(key) gives each photo's address. */
function html(rep, photoUrl) {
  const tiles = rep.summary.map(t => `<div class="tile"><div class="v">${t.value}</div><div class="l">${esc(t.label)}</div></div>`).join('');
  const pri = p => (p ? ` <span class="pri" style="background:${PRI_COLOR[p] || '#57606a'}">${esc(p)}</span>` : '');
  const secs = rep.sections.map(s => `<section><h2>${esc(s.title)}</h2>${s.note ? `<p class="note">${nl(s.note)}</p>` : ''}
    ${(s.items || []).map(i => `<article><h3>${esc(i.title)}${pri(i.priority)}</h3>${i.sub ? `<div class="sub">${esc(i.sub)}</div>` : ''}
      ${i.note ? `<p class="note">${nl(i.note)}</p>` : ''}${i.text ? `<p class="txt">${nl(i.text)}</p>` : ''}
      ${i.photos.length ? `<div class="pics">${i.photos.map(p => `<a href="${photoUrl(p)}" target="_blank"><img src="${photoUrl(p)}" alt="" loading="lazy"></a>`).join('')}</div>` : ''}</article>`).join('')}
    ${s.list ? `<ul>${s.list.map(i => `<li><b>${esc(i.title)}</b>${pri(i.priority)}${i.sub ? ' · ' + esc(i.sub) : ''}</li>`).join('')}</ul>` : ''}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(rep.company)} · Board report · ${esc(rep.label)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f2ee;font-family:Arial,Helvetica,sans-serif;color:#1f2328;line-height:1.4}
.page{max-width:900px;margin:0 auto;padding:20px 16px 40px}.bar{display:flex;justify-content:flex-end;gap:8px;margin-bottom:10px}
.bar button{font-size:15px;font-weight:bold;padding:10px 16px;border:0;border-radius:8px;background:#e3a008;color:#1f2328;cursor:pointer}
.sheet{background:#fff;border:1px solid #ddd;border-radius:12px;padding:28px}
.kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6e6a60;font-weight:bold}
h1{margin:4px 0 2px;font-size:28px}.period{color:#57606a;margin:0 0 16px}.intro{font-size:16px;margin:0 0 18px;white-space:normal}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 22px}
.tile{border:1px solid #e3e1da;border-radius:10px;padding:12px}.tile .v{font-size:26px;font-weight:bold}.tile .v small{font-size:13px;font-weight:normal;color:#57606a;display:block}.tile .l{font-size:13px;color:#57606a}
section{margin-top:24px}h2{font-size:19px;border-bottom:2px solid #1f2328;padding-bottom:4px;margin:0 0 10px}
article{padding:12px 0;border-bottom:1px solid #eee;break-inside:avoid;page-break-inside:avoid}h3{margin:0;font-size:16px}
.sub{color:#57606a;font-size:13px;margin-top:2px}.txt{margin:6px 0 0;font-size:14px}.note{margin:6px 0 0;padding:8px 10px;background:#fbf3dc;border-left:3px solid #e3a008;font-size:14px}
.pri{color:#fff;font-size:11px;border-radius:9px;padding:1px 7px;text-transform:uppercase;vertical-align:2px;letter-spacing:.04em}
.pics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}.pics img{width:100%;height:190px;object-fit:cover;border-radius:6px;display:block;background:#eee}
ul{margin:0;padding-left:18px}li{margin:4px 0}.foot{color:#888;font-size:12px;margin-top:26px}
@media (max-width:600px){.sheet{padding:16px}.pics{grid-template-columns:repeat(2,1fr)}.pics img{height:140px}}
@media print{body{background:#fff}.page{padding:0;max-width:none}.bar{display:none}.sheet{border:0;padding:0}.pics img{height:170px}a{color:inherit;text-decoration:none}}
</style></head><body><div class="page"><div class="bar"><button type="button" id="print">Print / Save as PDF</button></div><div class="sheet">
<div class="kicker">Board report</div><h1>${esc(rep.company)}</h1><p class="period">${esc(rep.label)}</p>
${rep.intro ? `<p class="intro">${nl(rep.intro)}</p>` : ''}${tiles ? `<div class="tiles">${tiles}</div>` : ''}
${secs || '<p>Nothing was logged for these dates.</p>'}
<p class="foot">From the crew’s logs in ${esc(config.productName)}.</p></div></div><script src="/board.js"></script></body></html>`;
}

/** Email the board: the message, the numbers and the link to the full report with photos. */
async function email(company, from, to, b) {
  const list = String(b.to || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  if (!list.length) V.bad("Add the board's email addresses.");
  if (list.length > 30) V.bad('Up to 30 email addresses.');
  list.forEach(e => { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) V.bad(`"${e}" is not an email address.`); });
  await db.q('UPDATE companies SET board_emails=$1 WHERE id=$2', [list.join(', '), company.id]);
  const r = await row(company, from, to);
  forget();
  const full = await byToken(r.token);
  const rep = full.report, link = linkOf(r);
  const pics = [];
  rep.sections.forEach(s => (s.items || []).forEach(i => i.photos.forEach(p => pics.length < 6 && pics.push(p))));
  const body = `<p style="margin:0 0 12px;color:#555">${esc(rep.label)}</p>
    ${rep.intro ? `<p style="font-size:15px">${nl(rep.intro)}</p>` : ''}
    ${rep.summary.length ? `<ul style="padding-left:18px">${rep.summary.map(t => `<li><b>${esc(t.label)}:</b> ${t.value.replace(/<small>/g, '(').replace(/<\/small>/g, ')')}</li>`).join('')}</ul>` : ''}
    ${pics.length ? `<div>${pics.map(p => `<img src="${link}/photo/${p}" alt="" width="200" height="150" style="object-fit:cover;border-radius:6px;margin:0 6px 6px 0">`).join('')}</div>` : ''}
    <p style="margin:18px 0"><a href="${link}" style="background:#e3a008;color:#1f2328;font-weight:bold;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">See the full report with photos</a></p>
    <p style="color:#666;font-size:13px">The link opens without signing in. You can print it or save it as a PDF from there.</p>`;
  await send({ to: list, subject: `${company.name} board report: ${rep.label}`, html: layout(`Board report: ${rep.label}`, body) });
  await db.q('UPDATE board_reports SET sent_at=now(), sent_to=$1 WHERE id=$2', [list.join(', '), r.id]);
  return { sentTo: list.join(', ') };
}

module.exports = { period, build, get, save, newLink, byToken, photo, html, email, forget, applyEdits };
