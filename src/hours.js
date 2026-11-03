// Reading and saving timesheet entries, weeks, approvals. Everything is scoped to one company.
const db = require('./db');
const T = require('./time');

const today = company => T.localNow(company.timezone).date;
const weekOf = (company, date) => T.weekStartOf(date || today(company), company.week_start);

/** Settings the crew app needs to draw itself. */
function publicSettings(c) {
  return {
    name: c.name, slug: c.slug, weekStart: c.week_start,
    mainLabel: c.main_label, otherEnabled: c.other_enabled, otherLabel: c.other_label,
    otherOptions: c.other_options, maxDaysBack: c.max_days_back, overtimeAfter: Number(c.overtime_after)
  };
}

/** Is the company allowed to use the app right now (paid, or still in the free trial)? */
function planOk(c) {
  if (c.plan_status === 'active') return true;
  if (c.plan_status === 'trialing') return !c.trial_ends_at || new Date(c.trial_ends_at) > new Date();
  if (c.plan_status === 'past_due') return true;   // Stripe is retrying the card; keep working meanwhile
  return false;
}

// ---- Overlapping time on the two tabs is only counted once ----
const mins = t => (T.isTime(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
/** The worked stretches of a block, in minutes from midnight (end past midnight runs on past 1440), with the time clocked out removed. */
function stretches(start, end, out, back) {
  const s = mins(start), e0 = mins(end); if (s == null || e0 == null) return [];
  const up = t => { const m = mins(t); return m == null ? null : (m < s ? m + 1440 : m); };
  const e = e0 <= s ? e0 + 1440 : e0, o = up(out), b = up(back);
  return o != null && b != null && o < b ? [[s, o], [b, e]] : [[s, e]];
}
function overlapMinutes(a, b) {
  let n = 0; a.forEach(([s1, e1]) => b.forEach(([s2, e2]) => { n += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2)); })); return n;
}
const overlapHours = r => overlapMinutes(stretches(r.start_t, r.end_t, r.out_t, r.back_t), stretches(r.o_start, r.o_end, r.o_out, r.o_back)) / 60;

/**
 * Both tabs finished and overlapping (e.g. Deerfield 12–6, Other 2–4): clock them out of the main job while
 * they were on the other one, so the day counts 6 hours, not 8. Returns a note for the crew member, or ''.
 */
function trimOverlap(w, o, company) {
  if (!(w.start && w.end && o.start && o.end) || ![w.start, w.end, o.start, o.end].every(T.isTime)) return '';
  const ws = mins(w.start), we = mins(w.end), os = mins(o.start), oe = mins(o.end);
  if (we <= ws || oe <= os) return '';                       // past midnight: leave it
  if (oe <= ws || os >= we) return '';                       // no overlap
  const main = company.main_label, other = company.other_label;
  if (w.out && w.back && mins(w.out) <= os && mins(w.back) >= oe) return '';   // already clocked out for it
  if (w.out || w.back) throw new T.InputError(`${main} and ${other} overlap. Make ${main}'s clocked out / back in times match ${other}, or change the times.`);
  if (os <= ws && oe >= we) throw new T.InputError(`All of the ${main} hours are inside the ${other} hours. Clear one of them, or fix the times.`);
  if (os > ws && oe < we) { w.out = o.start; w.back = o.end; return `${main}: clocked out ${T.clock(o.start)}–${T.clock(o.end)} for ${other}.`; }
  if (os <= ws) { w.start = o.end; return `${main} now starts at ${T.clock(o.end)}, when ${other} ended.`; }
  w.end = o.start; return `${main} now ends at ${T.clock(o.start)}, when ${other} started.`;
}

function shape(r) {
  const hours = Number(r.hours) || 0, oHours = Number(r.o_hours) || 0;
  const overlap = r.end_t && r.o_end ? overlapHours(r) : 0;   // older days saved before the fix
  return {
    date: r.day, start: r.start_t, end: r.end_t, outT: r.out_t, inT: r.back_t, summary: r.summary, hours,
    oJob: r.o_job, oStart: r.o_start, oEnd: r.o_end, oOutT: r.o_out, oInT: r.o_back, oSummary: r.o_summary, oHours,
    total: T.round2(Math.max(0, hours + oHours - overlap)),
    open: !!(r.start_t && !r.end_t), oOpen: !!(r.o_start && !r.o_end),
    updatedAt: r.updated_at
  };
}

async function isApproved(companyId, weekStart) {
  const r = await db.one('SELECT approved FROM approvals WHERE company_id=$1 AND week_start=$2', [companyId, weekStart]);
  return !!(r && r.approved);
}

/** Photo ids per crew member per day, for one week. */
async function weekPhotos(companyId, ws, crewId) {
  const rows = await db.q(`SELECT id, crew_id, to_char(day, 'YYYY-MM-DD') AS day FROM day_photos WHERE company_id=$1 AND day BETWEEN $2 AND $3
    ${crewId ? 'AND crew_id=$4' : ''} ORDER BY id`, crewId ? [companyId, ws, T.shift(ws, 6), crewId] : [companyId, ws, T.shift(ws, 6)]);
  const map = {};
  rows.forEach(r => { ((map[r.crew_id] = map[r.crew_id] || {})[r.day] = map[r.crew_id][r.day] || []).push(r.id); });
  return map;
}

async function myWeek(company, crew, weekStart) {
  const ws = weekOf(company, weekStart);
  const rows = await db.q('SELECT * FROM entries WHERE crew_id=$1 AND day BETWEEN $2 AND $3', [crew.id, ws, T.shift(ws, 6)]);
  const pics = (await weekPhotos(company.id, ws, crew.id))[crew.id] || {};
  const days = {};
  rows.forEach(r => { days[r.day] = shape(r); days[r.day].photos = pics[r.day] || []; });
  return { name: crew.name, manager: crew.is_manager, weekStart: ws, today: today(company), days,
           locked: await isApproved(company.id, ws), settings: publicSettings(company) };
}

function checkEditable(company, date) {
  const t = today(company);
  if (!T.isDate(date)) throw new T.InputError('That date is not valid.');
  if (date > t) throw new T.InputError("You can't log a day that hasn't happened yet.");
  if (date < T.shift(t, -company.max_days_back)) throw new T.InputError('That day is too far back to change. Ask the boss.');
}

const clean = (s, max = 2000) => String(s || '').trim().slice(0, max);

function autoSwitch(w, o) {
  const str = v => (typeof v === 'string' ? v : '');
  for (const b of [w, o]) for (const k of ['start', 'end', 'out', 'back']) b[k] = str(b[k]);
  const later = (a, b) => a && b && T.isTime(a) && T.isTime(b) && T.span(a, b) > 0 && b > a;
  if (w.start && !w.end && !w.out && later(w.start, o.start)) w.out = o.start;
  if (o.start && !o.end && !o.out && later(o.start, w.start)) o.end = w.start;
  if (o.start && !o.end && !o.out && w.out && w.back && later(o.start, w.back)) o.end = w.back;
  if (w.start && !w.end && w.out && !w.back && o.start && o.end && w.out === o.start) { w.end = w.out; w.out = ''; }
  if (w.start && w.end && w.back && !w.out && later(w.end, w.back)) { w.out = w.end; w.end = ''; }
}

async function saveDay(company, crew, body) {
  const date = body.date;
  checkEditable(company, date);
  if (await isApproved(company.id, weekOf(company, date)))
    throw new T.InputError('This week was approved by the boss and is locked. Ask the boss if something needs fixing.');
  // Switching jobs: clocking in on the second tab clocks them out of the main tab, and coming back does the reverse.
  if (company.other_enabled) autoSwitch(body.work = { ...(body.work || {}) }, body.other = { ...(body.other || {}) });
  const adjusted = company.other_enabled ? trimOverlap(body.work, body.other, company) : '';
  const work = T.timeBlock(body.work || {}, company.main_label);
  const other = company.other_enabled ? T.timeBlock(body.other || {}, company.other_label) : null;
  if (!work && !other) throw new T.InputError('Enter a start time.');
  const summary = clean(body.work && body.work.summary);
  const oSummary = clean(body.other && body.other.summary);
  if (work && !work.open && !summary) throw new T.InputError('Add a short summary of what you did.');
  let oJob = clean(body.other && body.other.job, 100);
  const options = company.other_options || [];
  if (other && options.length && options.indexOf(oJob) === -1) throw new T.InputError(`Pick what the ${company.other_label} was for from the list.`);
  if (!other) oJob = '';
  const w = work || {}, o = other || {};
  await db.q(
    `INSERT INTO entries (company_id, crew_id, day, start_t, end_t, out_t, back_t, summary, o_job, o_start, o_end, o_out, o_back, o_summary, hours, o_hours, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     ON CONFLICT (crew_id, day) DO UPDATE SET start_t=EXCLUDED.start_t, end_t=EXCLUDED.end_t, out_t=EXCLUDED.out_t, back_t=EXCLUDED.back_t,
       summary=EXCLUDED.summary, o_job=EXCLUDED.o_job, o_start=EXCLUDED.o_start, o_end=EXCLUDED.o_end, o_out=EXCLUDED.o_out, o_back=EXCLUDED.o_back,
       o_summary=EXCLUDED.o_summary, hours=EXCLUDED.hours, o_hours=EXCLUDED.o_hours, updated_at=now()`,
    [company.id, crew.id, date, w.start || '', w.end || '', w.out || '', w.back || '', summary, oJob,
     o.start || '', o.end || '', o.out || '', o.back || '', oSummary, w.hours || 0, o.hours || 0]);
  return { ...(await myWeek(company, crew, date)), adjusted };
}

async function clearDay(company, crew, date) {
  checkEditable(company, date);
  if (await isApproved(company.id, weekOf(company, date)))
    throw new T.InputError('This week was approved by the boss and is locked.');
  await db.q('DELETE FROM entries WHERE crew_id=$1 AND day=$2', [crew.id, date]);
  await db.q('DELETE FROM day_photos WHERE crew_id=$1 AND day=$2', [crew.id, date]);
  return myWeek(company, crew, date);
}

const MAX_DAY_PHOTOS = 6;
/** Crew adds photos of the day's work to a saved day. */
async function addDayPhotos(company, crew, date, photos, photoBytes) {
  checkEditable(company, date);
  if (await isApproved(company.id, weekOf(company, date))) throw new T.InputError('This week was approved by the boss and is locked.');
  if (!(await db.one('SELECT 1 FROM entries WHERE crew_id=$1 AND day=$2', [crew.id, date]))) throw new T.InputError('Save your hours for this day first, then add photos.');
  const list = (Array.isArray(photos) ? photos : []).map(photoBytes);
  if (!list.length) throw new T.InputError('Pick a photo to add.');
  const have = (await db.one('SELECT count(*)::int AS n FROM day_photos WHERE crew_id=$1 AND day=$2', [crew.id, date])).n;
  if (have + list.length > MAX_DAY_PHOTOS) throw new T.InputError(`Up to ${MAX_DAY_PHOTOS} photos per day.`);
  for (const p of list) await db.q('INSERT INTO day_photos (company_id, crew_id, day, mime, data) VALUES ($1,$2,$3,$4,$5)', [company.id, crew.id, date, p.mime, p.buf]);
  return myWeek(company, crew, date);
}

async function removeDayPhoto(company, crew, id) {
  const p = await db.one("SELECT to_char(day, 'YYYY-MM-DD') AS day FROM day_photos WHERE id=$1 AND crew_id=$2", [id, crew.id]);
  if (!p) throw new T.InputError('That photo was not found.');
  checkEditable(company, p.day);
  if (await isApproved(company.id, weekOf(company, p.day))) throw new T.InputError('This week was approved by the boss and is locked.');
  await db.q('DELETE FROM day_photos WHERE id=$1', [id]);
  return myWeek(company, crew, p.day);
}

/** One day photo. Crew members see their own; managers and the boss see everyone's in the company. */
const dayPhoto = (companyId, id, crewId) => db.one(`SELECT mime, data FROM day_photos WHERE id=$1 AND company_id=$2 ${crewId ? 'AND crew_id=$3' : ''}`,
  crewId ? [id, companyId, crewId] : [id, companyId]);

/** Everyone's week, for the boss. Managers themselves are left out unless they logged time. */
async function crewWeek(company, weekStart) {
  const ws = weekOf(company, weekStart);
  const dates = T.weekDates(ws);
  const crew = await db.q('SELECT id, name, active, is_manager FROM crew WHERE company_id=$1 ORDER BY lower(name)', [company.id]);
  const rows = await db.q('SELECT * FROM entries WHERE company_id=$1 AND day BETWEEN $2 AND $3', [company.id, ws, dates[6]]);
  const ot = Number(company.overtime_after);
  const pics = await weekPhotos(company.id, ws);
  const people = crew.map(c => {
    const days = {};
    rows.filter(r => r.crew_id === c.id).forEach(r => { days[r.day] = shape(r); days[r.day].photos = (pics[c.id] || {})[r.day] || []; });
    const total = T.round2(dates.reduce((a, d) => a + (days[d] ? days[d].total : 0), 0));
    return { id: c.id, name: c.name, active: c.active, manager: c.is_manager, days, total, ot: T.round2(Math.max(0, total - ot)) };
  }).filter(p => Object.keys(p.days).length || (p.active && !p.manager));
  const appr = await db.one('SELECT approved, changed_by, changed_at FROM approvals WHERE company_id=$1 AND week_start=$2', [company.id, ws]);
  return { weekStart: ws, dates, today: today(company), approved: !!(appr && appr.approved),
           approvedBy: appr ? appr.changed_by : '', people, grand: T.round2(people.reduce((a, p) => a + p.total, 0)),
           settings: publicSettings(company) };
}

async function setApproved(company, weekStart, approved, byName) {
  if (!T.isDate(weekStart)) throw new T.InputError('That week is not valid.');
  const ws = weekOf(company, weekStart);
  await db.q(`INSERT INTO approvals (company_id, week_start, approved, changed_by, changed_at) VALUES ($1,$2,$3,$4, now())
              ON CONFLICT (company_id, week_start) DO UPDATE SET approved=EXCLUDED.approved, changed_by=EXCLUDED.changed_by, changed_at=now()`,
    [company.id, ws, !!approved, byName || '']);
  return crewWeek(company, ws);
}

module.exports = { trimOverlap, addDayPhotos, removeDayPhoto, dayPhoto, MAX_DAY_PHOTOS, autoSwitch, publicSettings, planOk, myWeek, saveDay, clearDay, crewWeek, setApproved, weekOf, today, shape };
