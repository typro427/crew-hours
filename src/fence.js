// Guard shack geofence: a guard's phone says when they arrive at or leave the guard shack, and their time sheet
// clocks them in or out. Arriving starts the day (or ends a break); leaving ends it. Coming back the same day turns
// the time away into "clocked out / back in", so a run to the store doesn't split the shift.
const db = require('./db');
const V = require('./validate');
const T = require('./time');
const H = require('./hours');
const F = require('./features');

const DEFAULT_RADIUS = 100;     // metres around the shack
const DRIVE_RADIUS = 200;       // driving past: a wider circle, so a phone going 30 mph still notices
const P = require('./push');
/** 'drive' = clocks in when driving past, never out; 'guard' = in when arriving, out when leaving; null = off. */
const modeOf = crew => F.can(crew, 'drivein') ? 'drive' : F.can(crew, 'autoclock') ? 'guard' : null;
const SUMMARY = 'Guard shift (clocked by the guard shack)';

/** The shack: { lat, lon, radius } or null. */
async function shack(companyId) {
  const c = await db.one('SELECT gate_fence FROM companies WHERE id=$1', [companyId]);
  const f = c && c.gate_fence;
  return f && f.lat != null ? { lat: Number(f.lat), lon: Number(f.lon), radius: Number(f.radius) || DEFAULT_RADIUS } : null;
}
async function setShack(companyId, b) {
  if (b && b.clear) { await db.q('UPDATE companies SET gate_fence=NULL WHERE id=$1', [companyId]); return null; }
  const lat = Number(b.lat), lon = Number(b.lon), radius = Math.round(Number(b.radius) || DEFAULT_RADIUS);
  if (!(isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon))) V.bad('Set the guard shack on the map, or tap "Use my location" while you stand at it.');
  if (radius < 50 || radius > 1000) V.bad('Make the circle between 50 and 1000 meters (about 150 to 3,000 feet).');
  await db.q('UPDATE companies SET gate_fence=$1 WHERE id=$2', [JSON.stringify({ lat, lon, radius }), companyId]);
  return shack(companyId);
}

/** Local date and HH:MM of a moment in the company's time zone. */
function local(tz, d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const row = (crewId, day) => db.one('SELECT * FROM entries WHERE crew_id=$1 AND day=$2', [crewId, day]);
const blockOf = r => ({ start: r.start_t, end: r.end_t, out: r.out_t, back: r.back_t, summary: r.summary });
const otherOf = r => ({ job: r.o_job, start: r.o_start, end: r.o_end, out: r.o_out, back: r.o_back, summary: r.o_summary });

/**
 * The phone saw the guard arrive ('enter') or leave ('exit'). Returns { did, note }.
 * did: 'in' | 'out' | 'back' | 'away' | 'none'.
 */
async function event(company, crew, b) {
  const mode = modeOf(crew);
  if (!mode) V.bad('Clocking in and out at the guard shack is not switched on for you.');
  const kind = b.event === 'enter' ? 'enter' : b.event === 'exit' ? 'exit' : null;
  if (!kind) V.bad('Unknown event.');
  const now = new Date();
  let at = b.at ? new Date(b.at) : now;
  if (isNaN(at) || at > new Date(now.getTime() + 5 * 60e3) || now - at > 36 * 3600e3) at = now;   // a phone's clock that's off, or a very late send
  const tz = company.timezone || 'America/New_York';
  const { date, time } = local(tz, at);

  // the phone may send the same thing twice (or flutter at the edge): the same event within 10 minutes counts once
  const last = await db.one('SELECT kind, at FROM fence_events WHERE crew_id=$1 ORDER BY at DESC, id DESC LIMIT 1', [crew.id]);
  const log = async (did, note) => {
    await db.q('INSERT INTO fence_events (company_id, crew_id, kind, at, did, note) VALUES ($1,$2,$3,$4,$5,$6)', [company.id, crew.id, kind, at, did, note]);
    return { did, note, event: kind, at: at.toISOString() };
  };
  if (last && last.kind === kind && Math.abs(at - new Date(last.at)) < 10 * 60e3) return { did: 'none', note: 'Already noted.', event: kind, at: at.toISOString() };

  const save = async (day, r, work, did, note) => {
    try {
      await H.saveDay(company, crew, { date: day, work: { ...work, summary: work.summary || SUMMARY }, other: r ? otherOf(r) : {} });
      return log(did, note);
    } catch (e) {
      if (!e.expose && !(e instanceof T.InputError)) throw e;
      return log('none', `Not changed: ${e.message}`);
    }
  };

  if (mode === 'drive') {
    if (kind === 'exit') return log('none', 'Drove past. Clock out by hand at the end of the day.');
    const r = await row(crew.id, date);
    if (r && r.start_t) return log('none', r.end_t ? 'Already clocked out today.' : 'Already clocked in.');
    const done = await save(date, r, { start: time, summary: (r && r.summary) || 'Workday (clocked in at the guard shack)' }, 'in', `Clocked in at ${T.clock(time)}.`);
    if (done.did === 'in') P.notify(company, [crew.id], { feature: null, tab: 'log', tag: 'fence-' + date,
      title: `Clocked in at ${T.clock(time)}`, body: 'You drove past the guard shack. Remember to clock out at the end of the day.' }).catch(() => {});
    return done;
  }
  if (kind === 'enter') {
    const r = await row(crew.id, date);
    if (!r || !r.start_t) return save(date, r, { start: time }, 'in', `Clocked in at ${T.clock(time)}.`);
    if (r.start_t && !r.end_t && r.out_t && !r.back_t) return save(date, r, { ...blockOf(r), back: time }, 'back', `Back at ${T.clock(time)}.`);
    if (r.start_t && r.end_t && !r.out_t && time > r.end_t)   // left earlier today and came back: that was a break
      return save(date, r, { ...blockOf(r), out: r.end_t, back: time, end: '' }, 'back', `Back at ${T.clock(time)} (away ${T.clock(r.end_t)}–${T.clock(time)}).`);
    return log('none', r.end_t ? 'Already clocked out today with a break used. Fix the time sheet by hand if needed.' : 'Already clocked in.');
  }
  // exit: end today's open day, or last night's (a shift past midnight)
  for (const day of [date, T.shift(date, -1)]) {
    const r = await row(crew.id, day);
    if (r && r.start_t && !r.end_t) {
      if (r.out_t && !r.back_t) return log('none', 'Already out.');
      return save(day, r, { ...blockOf(r), end: time }, 'out', `Clocked out at ${T.clock(time)}.`);
    }
  }
  return log('none', 'Not clocked in.');
}

/** What the guard's phone needs: is it on for them, and where's the shack. */
async function forCrew(company, crew) {
  const mode = modeOf(crew);
  if (!mode) return { on: false };
  let s = await shack(company.id);
  if (s && mode === 'drive') s = { ...s, radius: Math.max(s.radius, DRIVE_RADIUS) };
  const last = await db.one('SELECT kind, at, did, note FROM fence_events WHERE crew_id=$1 ORDER BY at DESC, id DESC LIMIT 1', [crew.id]);
  return { on: !!s, shack: s, last, mode };
}

const recent = companyId => db.q(`SELECT e.id, e.kind, e.at, e.did, e.note, c.name FROM fence_events e JOIN crew c ON c.id=e.crew_id
  WHERE e.company_id=$1 ORDER BY e.at DESC, e.id DESC LIMIT 30`, [companyId]);

module.exports = { shack, setShack, event, forCrew, recent, modeOf, DEFAULT_RADIUS, DRIVE_RADIUS };
