// Date and hours math. Dates are 'YYYY-MM-DD' strings, times are 24-hour 'HH:MM' strings.
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toUTC = s => { const p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); };
const fromUTC = d => d.toISOString().slice(0, 10);
const shift = (s, n) => { const d = toUTC(s); d.setUTCDate(d.getUTCDate() + n); return fromUTC(d); };
const dow = s => toUTC(s).getUTCDay();
const weekStartOf = (s, startDay) => shift(s, -((dow(s) - startDay + 7) % 7));
const weekDates = ws => Array.from({ length: 7 }, (_, i) => shift(ws, i));
const dayName = s => DAY_NAMES[dow(s)];
const pretty = s => MONTHS[Number(s.slice(5, 7)) - 1] + ' ' + Number(s.slice(8));
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toUTC(s));
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const round2 = n => Math.round(n * 100) / 100;

/** Today's date and the current hour in a company's time zone. */
function localNow(timeZone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

const minutes = t => { const p = t.split(':').map(Number); return p[0] * 60 + p[1]; };

/** Hours between two times; an end before the start means the shift ran past midnight. */
function span(a, b) { let m = minutes(b) - minutes(a); if (m < 0) m += 1440; return round2(m / 60); }

function clock(t) {
  if (!t) return '';
  const p = t.split(':').map(Number);
  return ((p[0] % 12) || 12) + ':' + String(p[1]).padStart(2, '0') + (p[0] >= 12 ? ' PM' : ' AM');
}

class InputError extends Error {}

/**
 * Checks one time block (start, end, clocked out, clocked back in) and works out its hours.
 * No end time yet = still on the clock: saved, but counts 0 hours until it's finished.
 * Returns null when the block is empty.
 */
function timeBlock(b, label) {
  const start = b.start || '', end = b.end || '', out = b.out || '', back = b.back || '';
  if (!start && !end && !out && !back) return null;
  if (!start) throw new InputError(`${label}: enter a start time.`);
  for (const [v, n] of [[start, 'start'], [end, 'end'], [out, 'clocked out'], [back, 'clocked back in']]) {
    if (v && !isTime(v)) throw new InputError(`${label}: the ${n} time isn't valid.`);
  }
  if (end && span(start, end) <= 0) throw new InputError(`${label}: the end time must be different from the start time.`);
  if (back && !out) throw new InputError(`${label}: enter the clocked out time first.`);
  const rel = t => (minutes(t) - minutes(start) + 1440) % 1440;
  if (out) {
    if (!(rel(out) > 0)) throw new InputError(`${label}: clocked out must be after the start time.`);
    if (back && !(rel(back) > rel(out))) throw new InputError(`${label}: clocked back in must be after clocked out.`);
    if (end) {
      if (!back) throw new InputError(`${label}: enter the clocked back in time too, or clear the end time if you're still out.`);
      const e = rel(end) || 1440;
      if (!(rel(back) < e)) throw new InputError(`${label}: clocked out and back in must be between the start and end time.`);
    }
  }
  let hours = 0;
  if (end) {
    const e = rel(end) || 1440;
    hours = round2((e - (out && back ? rel(back) - rel(out) : 0)) / 60);
  }
  return { start, end, out, back, hours, open: !end };
}

module.exports = {
  DAY_NAMES, LONG_DAYS, MONTHS, toUTC, shift, dow, weekStartOf, weekDates, dayName, pretty,
  isDate, isTime, round2, localNow, validTimeZone, span, clock, timeBlock, InputError
};
