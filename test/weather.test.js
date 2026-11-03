// Weather reminders against a pretend Weather Service: location lookup, the forecast math (°C -> °F, mm -> inches,
// only the hours inside the window), reminders going off once into Tasks with an email, and the two starter reminders.
const http = require('http');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const hour = 3600e3, t0 = Date.now();
const iso = ms => new Date(ms).toISOString().replace('.000Z', '+00:00');
let grid = null;   // what the pretend forecast says
function setForecast({ lowC = 10, rainMm = 0, rainAtHours = 6, gustKmh = 10 } = {}) {
  grid = { properties: {
    minTemperature: { uom: 'wmoUnit:degC', values: [{ validTime: iso(t0 + 2 * hour) + '/PT12H', value: lowC }, { validTime: iso(t0 + 60 * hour) + '/PT12H', value: -10 }] },
    maxTemperature: { uom: 'wmoUnit:degC', values: [{ validTime: iso(t0 - 1 * hour) + '/PT12H', value: 18 }] },
    // half of the 12-hour stretch is inside the next 24 hours when rainAtHours = 18
    quantitativePrecipitation: { uom: 'wmoUnit:mm', values: [{ validTime: iso(t0 + rainAtHours * hour) + '/PT12H', value: rainMm }] },
    snowfallAmount: { uom: 'wmoUnit:mm', values: [{ validTime: iso(t0) + '/P1D', value: 0 }] },
    windGust: { uom: 'wmoUnit:km_h-1', values: [{ validTime: iso(t0) + '/PT6H', value: gustKmh }] },
    probabilityOfPrecipitation: { uom: 'wmoUnit:percent', values: [{ validTime: iso(t0) + '/PT6H', value: 40 }] }
  } };
}
const hits = { points: 0, grid: 0, ua: '' };
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), j = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  hits.ua = req.headers['user-agent'] || '';
  if (u.pathname === '/geocode') {
    return j(200, { result: { addressMatches: /deerfield way/i.test(u.searchParams.get('address')) ? [{ matchedAddress: '1517 DEERFIELD WAY, LA FOLLETTE, TN, 37766', coordinates: { x: -84.051, y: 36.418 } }] : [] } });
  }
  if (u.pathname === '/points/36.4180,-84.0510') { hits.points++; return j(200, { properties: { forecastGridData: `http://127.0.0.1:${mock.address().port}/gridpoints/MRX/50,80` } }); }
  if (u.pathname === '/gridpoints/MRX/50,80') { hits.grid++; return j(200, grid); }
  j(404, {});
});

let server, base, db, send, O;
before(async () => {
  await new Promise(ok => mock.listen(0, ok));
  const m = 'http://127.0.0.1:' + mock.address().port;
  Object.assign(process.env, { DISABLE_SCHEDULER: '1', WEATHER_CACHE_MS: '0', WEATHER_API: m, GEOCODER_URL: m + '/geocode' });
  const { app } = require('../src/server');
  db = require('../src/db'); send = require('../src/email').send;
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/migrate').migrate();
  await new Promise(ok => { server = app.listen(0, ok); });
  base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  O = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-ch': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await O('POST', '/api/signup', { company: 'Deerfield Water', name: 'Tyler', email: 'boss@example.com', password: 'LongPass1!' });
});
after(async () => { server.close(); mock.close(); await db.pool.end(); });

test('the forecast math: durations, units, and only the part of a stretch inside the window', () => {
  const W = require('../src/weather');
  assert.strictEqual(W.duration('PT6H'), 6 * hour); assert.strictEqual(W.duration('P1DT3H'), 27 * hour); assert.strictEqual(W.duration('PT30M'), 30 * 60e3);
  assert.strictEqual(Math.round(W.convert(4, 'wmoUnit:degC') * 10) / 10, 39.2);
  assert.strictEqual(W.convert(25.4, 'wmoUnit:mm'), 1);
  setForecast({ rainMm: 50.8, rainAtHours: 18 });
  const o = W.outlook(grid.properties, t0, 24);
  assert.strictEqual(Math.round(o.rain_above.value * 100) / 100, 1, 'half of 2 inches falls inside the next 24 hours');
  assert.strictEqual(Math.round(o.low_below.value), 50);
  assert.ok(!(W.outlook(grid.properties, t0, 24).low_below.value < 0), 'the -10°C two days out is outside 24 hours');
  assert.ok(W.outlook(grid.properties, t0, 72).low_below.value < 20, 'but inside 72');
});

test('starts with the two reminders: heaters below 40°F, ditches over 1 inch of rain', async () => {
  const d = (await O('GET', '/api/admin/weather')).body;
  assert.strictEqual(d.location, null);
  assert.deepStrictEqual(d.rules.map(r => [r.metric, r.threshold, r.title]), [['low_below', 40, 'Check the heaters in all the well houses'], ['rain_above', 1, 'Check the ditches']]);
  assert.strictEqual((await O('GET', '/api/admin/weather')).body.rules.length, 2, 'only seeded once');
  assert.strictEqual((await O('POST', '/api/admin/weather/run')).status, 400, 'needs a location');
});

test('location: from an address, or latitude and longitude', async () => {
  assert.strictEqual((await O('PUT', '/api/admin/weather/location', { address: 'Nowhere Street' })).status, 400);
  let d = (await O('PUT', '/api/admin/weather/location', { address: '1517 Deerfield Way, LaFollette, TN 37766' })).body;
  assert.strictEqual(d.location.lat, 36.418); assert.match(d.location.label, /DEERFIELD WAY/);
  assert.strictEqual((await O('PUT', '/api/admin/weather/location', { lat: '200', lon: '0' })).status, 400);
  d = (await O('PUT', '/api/admin/weather/location', { lat: '36.418', lon: '-84.051' })).body;
  assert.strictEqual(d.location.lon, -84.051);
  assert.match(hits.ua, /Crew Hours/, 'tells the Weather Service who is asking');
});

test('a cold night and a lot of rain: tasks on the Tasks tab, due today, and an email; only once a day', async () => {
  setForecast({ lowC: 2, rainMm: 30, rainAtHours: 6 });   // 35.6°F, 1.18 in
  const pv = (await O('GET', '/api/admin/weather/forecast')).body;
  assert.ok(pv.rules.every(r => r.would), JSON.stringify(pv.rules));
  assert.match(pv.next24.low_below.text, /^Low of 36°F around/);
  send.outbox.length = 0;
  let r = await O('POST', '/api/admin/weather/run');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.fired.map(f => f.title), ['Check the heaters in all the well houses', 'Check the ditches']);
  const tasks = (await O('GET', '/api/admin/tasks')).body.tasks;
  const heat = tasks.find(t => t.title === 'Check the heaters in all the well houses');
  assert.ok(heat); assert.strictEqual(heat.priority, 'high'); assert.ok(heat.due); assert.match(heat.details, /Low of 36°F/);
  assert.match(tasks.find(t => t.title === 'Check the ditches').details, /1\.18 in of rain/);
  assert.ok(send.outbox.some(m => m.to.includes('boss@example.com') && /^Weather: Check the heaters/.test(m.subject)));
  r = await O('POST', '/api/admin/weather/run');
  assert.deepStrictEqual(r.body.fired, [], 'not again the same day');
  assert.strictEqual((await O('GET', '/api/admin/tasks')).body.tasks.filter(t => /heaters/.test(t.title)).length, 1);
});

test('a mild dry day: nothing goes off; your own reminders and switching one off', async () => {
  setForecast({ lowC: 12, rainMm: 2, gustKmh: 80 });   // gusts ~50 mph
  await db.q('UPDATE weather_rules SET last_fired_at=NULL');
  assert.strictEqual((await O('POST', '/api/admin/weather/rules', { metric: 'gust_above', threshold: '', title: 'x' })).status, 400);
  let d = (await O('POST', '/api/admin/weather/rules', { metric: 'gust_above', threshold: '40', hours: 24, title: 'Check for trees down on the roads', emailCrew: true })).body;
  const gust = d.rules.find(r => r.metric === 'gust_above');
  assert.ok(gust && gust.emailCrew);
  await O('PUT', '/api/admin/weather/rules/' + gust.id, { ...gust, active: false });
  let r = await O('POST', '/api/admin/weather/run');
  assert.deepStrictEqual(r.body.fired, [], 'mild, dry, and the wind one is switched off');
  await O('PUT', '/api/admin/weather/rules/' + gust.id, { ...gust, active: true });
  r = await O('POST', '/api/admin/weather/run');
  assert.deepStrictEqual(r.body.fired.map(f => f.title), ['Check for trees down on the roads']);
  await O('DELETE', '/api/admin/weather/rules/' + gust.id);
  assert.strictEqual((await O('GET', '/api/admin/weather')).body.rules.length, 2);
});
