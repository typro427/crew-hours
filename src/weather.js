// Weather reminders: twice a day the app reads the National Weather Service forecast for the company's location.
// When a rule is crossed (low below 40°F, an inch of rain...) it puts a task on the crew's Tasks tab and emails the boss.
const db = require('./db');
const V = require('./validate');
const T = require('./time');
const config = require('./config');

const API = () => config.weather.api;
const UA = () => `${config.productName} (${config.appUrl})`;   // the Weather Service asks every app to say who it is
const CHECK_HOURS = [6, 15];                                    // 6 AM and 3 PM in the company's time zone
const METRICS = {
  low_below:  { label: 'Low temperature below', unit: '°F', field: 'minTemperature', how: 'min', below: true },
  high_above: { label: 'High temperature above', unit: '°F', field: 'maxTemperature', how: 'max' },
  rain_above: { label: 'Rain more than', unit: 'in', field: 'quantitativePrecipitation', how: 'sum' },
  snow_above: { label: 'Snow more than', unit: 'in', field: 'snowfallAmount', how: 'sum' },
  gust_above: { label: 'Wind gusts over', unit: 'mph', field: 'windGust', how: 'max' },
  chance_above: { label: 'Chance of rain over', unit: '%', field: 'probabilityOfPrecipitation', how: 'max' }
};
const DEFAULT_RULES = [
  { metric: 'low_below', threshold: 40, hours: 24, title: 'Check the heaters in all the well houses', priority: 'high' },
  { metric: 'rain_above', threshold: 1, hours: 24, title: 'Check the ditches', priority: 'high' }
];

/* ------------------------------ the forecast ------------------------------ */
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA(), Accept: 'application/geo+json, application/json' } });
  if (!r.ok) { const e = new Error(`The weather service said ${r.status}.`); e.status = r.status; throw e; }
  return r.json();
}
/** "PT6H", "P1DT3H", "PT30M" -> milliseconds */
function duration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(s || ''));
  if (!m) return 0;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 60e3;
}
/** Convert to °F, inches, mph or % from the Weather Service's units. */
function convert(v, uom) {
  if (v == null) return null;
  const u = String(uom || '');
  if (/degC$/.test(u)) return v * 9 / 5 + 32;
  if (/degF$/.test(u)) return v;
  if (/:mm$/.test(u)) return v / 25.4;
  if (/:m$/.test(u)) return v * 39.3701;
  if (/km_h-1$/.test(u)) return v * 0.621371;
  if (/m_s-1$/.test(u)) return v * 2.23694;
  return v;   // percent etc.
}
function series(props, field) {
  const p = props[field];
  if (!p || !Array.isArray(p.values)) return [];
  return p.values.map(x => {
    const [start, dur] = String(x.validTime || '').split('/');
    const s = Date.parse(start), len = duration(dur);
    return isFinite(s) && len ? { s, e: s + len, v: convert(x.value, p.uom) } : null;
  }).filter(x => x && x.v != null);
}

const cache = new Map();   // grid URL -> { at, props }
async function forecast(company) {
  const c = await db.one('SELECT weather_lat, weather_lon, weather_grid FROM companies WHERE id=$1', [company.id]);
  if (!c || c.weather_lat == null) V.bad('Set the location first.');
  let grid = c.weather_grid;
  if (!grid) {
    const p = await getJson(`${API()}/points/${Number(c.weather_lat).toFixed(4)},${Number(c.weather_lon).toFixed(4)}`);
    grid = p.properties && p.properties.forecastGridData;
    if (!grid) V.bad("The weather service doesn't cover that location (US only).");
    await db.q('UPDATE companies SET weather_grid=$1 WHERE id=$2', [grid, company.id]);
  }
  const hit = cache.get(grid);
  if (hit && Date.now() - hit.at < config.weather.cacheMs) return hit.props;
  let g;
  try { g = await getJson(grid); }
  catch (e) { if (e.status === 404) await db.q('UPDATE companies SET weather_grid=NULL WHERE id=$1', [company.id]); throw e; }
  cache.set(grid, { at: Date.now(), props: g.properties || {} });
  return g.properties || {};
}

/** What the forecast says for the next `hours` hours from `from` (ms). */
function outlook(props, from, hours) {
  const to = from + hours * 3600e3, out = {};
  for (const [key, m] of Object.entries(METRICS)) {
    const list = series(props, m.field).filter(x => x.e > from && x.s < to);
    if (!list.length) { out[key] = null; continue; }
    if (m.how === 'sum') {   // count only the part of each stretch inside the window
      out[key] = { value: list.reduce((a, x) => a + x.v * (Math.min(x.e, to) - Math.max(x.s, from)) / (x.e - x.s), 0) };
    } else {
      const best = list.reduce((a, x) => (a == null || (m.how === 'min' ? x.v < a.v : x.v > a.v) ? x : a), null);
      out[key] = { value: best.v, at: best.s };
    }
  }
  return out;
}
const round = (key, v) => (v == null ? null : METRICS[key].unit === 'in' ? Math.round(v * 100) / 100 : Math.round(v));
function describe(key, o, tz) {
  if (!o) return '';
  const m = METRICS[key], v = round(key, o.value);
  const when = o.at ? ' around ' + new Date(o.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', timeZone: tz || 'America/New_York' }) : '';
  return { low_below: `Low of ${v}°F${when}`, high_above: `High of ${v}°F${when}`, rain_above: `${v} in of rain`, snow_above: `${v} in of snow`,
    gust_above: `Gusts to ${v} mph${when}`, chance_above: `${v}% chance of rain` }[key] || `${m.label} ${v}`;
}
const crossed = (rule, o) => o && o.value != null && (METRICS[rule.metric].below ? o.value < Number(rule.threshold) : o.value > Number(rule.threshold));

/* ------------------------------ rules ------------------------------ */
const COLS = `id, metric, threshold::float AS threshold, hours, title, details, assigned_to AS "assignedTo", priority, email_crew AS "emailCrew", active, last_fired_at AS "lastFiredAt", last_note AS "lastNote"`;
async function rules(companyId) {
  const c = await db.one('SELECT weather_seeded FROM companies WHERE id=$1', [companyId]);
  if (c && !c.weather_seeded) {   // start with the two everyone asks for
    await db.tx(async t => {
      for (const [i, r] of DEFAULT_RULES.entries()) await t.q('INSERT INTO weather_rules (company_id, metric, threshold, hours, title, priority, position) VALUES ($1,$2,$3,$4,$5,$6,$7)', [companyId, r.metric, r.threshold, r.hours, r.title, r.priority, i]);
      await t.q('UPDATE companies SET weather_seeded=TRUE WHERE id=$1', [companyId]);
    });
  }
  return db.q(`SELECT ${COLS} FROM weather_rules WHERE company_id=$1 ORDER BY position, id`, [companyId]);
}
async function saveRule(companyId, id, b) {
  if (!METRICS[b.metric]) V.bad('Pick what to watch for.');
  const threshold = Number(String(b.threshold).replace(/[^0-9.\-]/g, ''));
  if (b.threshold === '' || !isFinite(threshold) || Math.abs(threshold) > 1000) V.bad('Enter the number to watch for, like 40.');
  const hours = [12, 24, 36, 48, 72].includes(Number(b.hours)) ? Number(b.hours) : 24;
  const title = V.str(b.title, 'what the crew should do', 1, 120), details = String(b.details || '').trim().slice(0, 1000);
  const assigned = b.assignedTo ? Number(b.assignedTo) : null;
  if (assigned && !(await db.one('SELECT 1 FROM crew WHERE id=$1 AND company_id=$2', [assigned, companyId]))) V.bad('Pick someone from your crew.');
  const priority = ['urgent', 'high', 'normal', 'low'].includes(b.priority) ? b.priority : 'high';
  const args = [b.metric, threshold, hours, title, details, assigned, priority, !!b.emailCrew, b.active !== false];
  if (id) { const r = await db.q('UPDATE weather_rules SET metric=$1, threshold=$2, hours=$3, title=$4, details=$5, assigned_to=$6, priority=$7, email_crew=$8, active=$9 WHERE id=$10 AND company_id=$11 RETURNING id', [...args, id, companyId]); if (!r.length) V.bad('That reminder was not found.'); }
  else {
    const n = (await db.one('SELECT count(*)::int AS n FROM weather_rules WHERE company_id=$1', [companyId])).n;
    if (n >= 30) V.bad('Up to 30 weather reminders.');
    await db.q('INSERT INTO weather_rules (metric, threshold, hours, title, details, assigned_to, priority, email_crew, active, company_id, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [...args, companyId, n]);
  }
}
const removeRule = (companyId, id) => db.q('DELETE FROM weather_rules WHERE id=$1 AND company_id=$2', [id, companyId]);

/* ------------------------------ location ------------------------------ */
/** An address -> latitude/longitude (US Census geocoder), or lat/lon typed in. */
async function setLocation(company, b) {
  let lat = b.lat !== undefined && b.lat !== '' ? Number(b.lat) : null, lon = b.lon !== undefined && b.lon !== '' ? Number(b.lon) : null, label = String(b.address || '').trim().slice(0, 200);
  if (lat == null || lon == null) {
    if (!label) V.bad('Type an address, like 1517 Deerfield Way, LaFollette, TN 37766.');
    let j;
    try { const r = await fetch(`${config.weather.geocoder}?address=${encodeURIComponent(label)}&benchmark=Public_AR_Current&format=json`, { headers: { 'User-Agent': UA() } }); j = await r.json(); }
    catch (e) { V.bad("Couldn't look up that address right now. Try again, or type the latitude and longitude."); }
    const hit = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (!hit) V.bad("That address wasn't found. Include the street number, town, state and ZIP, or type the latitude and longitude.");
    lat = Number(hit.coordinates.y); lon = Number(hit.coordinates.x); label = hit.matchedAddress || label;
  }
  if (!(isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) V.bad('That latitude and longitude are not valid.');
  await db.q('UPDATE companies SET weather_lat=$1, weather_lon=$2, weather_label=$3, weather_grid=NULL WHERE id=$4', [lat, lon, label || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, company.id]);
}

/* ------------------------------ checking ------------------------------ */
/** The forecast for the next 24 and 48 hours, and which reminders it would set off. */
async function preview(company) {
  const props = await forecast(company), now = Date.now(), list = await rules(company.id);
  const sum = h => { const o = outlook(props, now, h); return Object.fromEntries(Object.keys(METRICS).map(k => [k, o[k] ? { value: round(k, o[k].value), text: describe(k, o[k], company.timezone) } : null])); };
  return { next24: sum(24), next48: sum(48),
    rules: list.map(r => { const o = outlook(props, now, r.hours)[r.metric]; return { id: r.id, would: !!(r.active && crossed(r, o)), now: o ? describe(r.metric, o, company.timezone) : 'no forecast' }; }) };
}

/**
 * Check now and act: each active reminder that's crossed puts a task on the Tasks tab (due today) and emails the boss
 * (and crew with an email, if ticked). A reminder goes off at most once in 20 hours.
 */
async function run(company) {
  const props = await forecast(company), now = Date.now(), fired = [];
  const K = require('./tasks'), R = require('./reports'), { send, esc, layout } = require('./email');
  const today = T.localNow(company.timezone).date;
  for (const r of await rules(company.id)) {
    if (!r.active) continue;
    const o = outlook(props, now, r.hours)[r.metric];
    if (!crossed(r, o)) continue;
    const claim = await db.q("UPDATE weather_rules SET last_fired_at=now(), last_note=$1 WHERE id=$2 AND (last_fired_at IS NULL OR last_fired_at < now() - interval '20 hours') RETURNING id",
      [describe(r.metric, o, company.timezone), r.id]);
    if (!claim.length) continue;
    const note = describe(r.metric, o, company.timezone) + ` in the next ${r.hours} hours (Weather Service forecast).`;
    await K.create(company.id, { kind: 'task', title: r.title, details: [note, r.details].filter(Boolean).join('\n'), due: today, assignedTo: r.assignedTo, priority: r.priority });
    require('./push').notify(company, r.assignedTo ? [r.assignedTo] : null, { title: `🌡 ${r.title}`, body: note, tab: 'tasks', tag: 'weather-' + r.id });
    const to = [].concat(await R.recipients(company));
    if (r.emailCrew) (await db.q("SELECT email FROM crew WHERE company_id=$1 AND active AND email<>''", [company.id])).forEach(c => to.push(c.email));
    send({ to: [...new Set(to)], subject: `Weather: ${r.title} (${describe(r.metric, o, company.timezone)})`,
      html: layout('Weather reminder', `<p style="font-size:17px"><b>${esc(r.title)}</b></p><p>${esc(note)}</p>${r.details ? `<p style="white-space:pre-wrap">${esc(r.details)}</p>` : ''}
        <p>It's on the crew's <b>Tasks</b> tab, due today.</p>`) }).catch(e => console.error('[weather] email', e.message));
    fired.push({ id: r.id, title: r.title, note });
  }
  return fired;
}

async function status(company) {
  const c = await db.one('SELECT weather_lat AS lat, weather_lon AS lon, weather_label AS label FROM companies WHERE id=$1', [company.id]);
  return { location: c && c.lat != null ? { lat: Number(c.lat), lon: Number(c.lon), label: c.label } : null, rules: await rules(company.id),
    metrics: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, { label: m.label, unit: m.unit }])), checkHours: CHECK_HOURS };
}

module.exports = { status, rules, saveRule, removeRule, setLocation, preview, run, outlook, duration, convert, CHECK_HOURS, METRICS };
