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

function shape(r) {
  const hours = Number(r.hours) || 0, oHours = Number(r.o_hours) || 0;
  return {
    date: r.day, start: r.start_t, end: r.end_t, outT: r.out_t, inT: r.back_t, summary: r.summary, hours,
    oJob: r.o_job, oStart: r.o_start, oEnd: r.o_end, oOutT: r.o_out, oInT: r.o_back, oSummary: r.o_summary, oHours,
    total: T.round2(hours + oHours),
    open: !!(r.start_t && !r.end_t), oOpen: !!(r.o_start && !r.o_end),
    updatedAt: r.updated_at
  };
}

async function isApproved(companyId, weekStart) {
  const r = await db.one('SELECT approved FROM approvals WHERE company_id=$1 AND week_start=$2', [companyId, weekStart]);
  return !!(r && r.approved);
}

async function myWeek(company, crew, weekStart) {
  const ws = weekOf(company, weekStart);
  const rows = await db.q('SELECT * FROM entries WHERE crew_id=$1 AND day BETWEEN $2 AND $3', [crew.id, ws, T.shift(ws, 6)]);
  const days = {};
  rows.forEach(r => { days[r.day] = shape(r); });
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

async function saveDay(company, crew, body) {
  const date = body.date;
  checkEditable(company, date);
  if (await isApproved(company.id, weekOf(company, date)))
    throw new T.InputError('This week was approved by the boss and is locked. Ask the boss if something needs fixing.');
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
  return myWeek(company, crew, date);
}

async function clearDay(company, crew, date) {
  checkEditable(company, date);
  if (await isApproved(company.id, weekOf(company, date)))
    throw new T.InputError('This week was approved by the boss and is locked.');
  await db.q('DELETE FROM entries WHERE crew_id=$1 AND day=$2', [crew.id, date]);
  return myWeek(company, crew, date);
}

/** Everyone's week, for the boss. Managers themselves are left out unless they logged time. */
async function crewWeek(company, weekStart) {
  const ws = weekOf(company, weekStart);
  const dates = T.weekDates(ws);
  const crew = await db.q('SELECT id, name, active, is_manager FROM crew WHERE company_id=$1 ORDER BY lower(name)', [company.id]);
  const rows = await db.q('SELECT * FROM entries WHERE company_id=$1 AND day BETWEEN $2 AND $3', [company.id, ws, dates[6]]);
  const ot = Number(company.overtime_after);
  const people = crew.map(c => {
    const days = {};
    rows.filter(r => r.crew_id === c.id).forEach(r => { days[r.day] = shape(r); });
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

module.exports = { publicSettings, planOk, myWeek, saveDay, clearDay, crewWeek, setApproved, weekOf, today, shape };
