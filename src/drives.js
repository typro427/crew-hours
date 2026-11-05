// Roads driven: a checklist a manager ticks off while driving the roads. One check per road per day (whoever
// drove it), with an optional note ("pothole by the culvert") that can also go on the task list.
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const H = require('./hours');
const G = require('./geo');

const DAYS_BACK = 7;   // fix a forgotten tick up to a week later

function checkDay(company, day) {
  const today = H.today(company);
  const d = day ? String(day) : today;
  if (!T.isDate(d)) V.bad('Pick a valid date.');
  if (d > today) V.bad("You can't check off a day that hasn't happened yet.");
  if (d < T.shift(today, -DAYS_BACK)) V.bad(`You can go back up to ${DAYS_BACK} days.`);
  return d;
}

/** Every active road for that day: driven or not, by whom, the note, and when it was last driven before. */
async function list(company, day) {
  const d = checkDay(company, day);
  const roads = await db.q(`SELECT r.id, r.name, r.length_mi AS "lengthMi", r.surface,
      x.done, x.note, x.auto, x.task_id AS "taskId", x.checked_at AS "checkedAt", xc.name AS "byName", (s.road_id IS NOT NULL) AS "hasShape",
      to_char(l.day, 'YYYY-MM-DD') AS "lastDay", lc.name AS "lastBy"
    FROM roads r
    LEFT JOIN road_drives x ON x.road_id=r.id AND x.day=$2
    LEFT JOIN crew xc ON xc.id=x.crew_id
    LEFT JOIN road_shapes s ON s.road_id=r.id
    LEFT JOIN LATERAL (SELECT day, crew_id FROM road_drives WHERE road_id=r.id AND done AND day < $2 ORDER BY day DESC LIMIT 1) l ON TRUE
    LEFT JOIN crew lc ON lc.id=l.crew_id
    WHERE r.company_id=$1 AND r.kind='road' AND r.active ORDER BY r.position, lower(r.name)`, [company.id, d]);
  roads.forEach(r => { r.done = !!r.done; r.auto = !!(r.done && r.auto); r.note = r.note || ''; });
  return { day: d, today: H.today(company), daysBack: DAYS_BACK, roads, driven: roads.filter(r => r.done).length };
}

/**
 * Tick a road (done true/false) and/or save its note for the day. toTasks: also put the note on the task list.
 * Safe to send twice (the phone resends from its outbox when signal comes back).
 */
async function check(company, crew, roadId, b) {
  const d = checkDay(company, b.day);
  const road = await db.one("SELECT id, name FROM roads WHERE id=$1 AND company_id=$2 AND kind='road'", [roadId, company.id]);
  if (!road) V.bad('That road was not found. Pull down to refresh.');
  const cur = await db.one('SELECT * FROM road_drives WHERE road_id=$1 AND day=$2', [roadId, d]);
  const done = b.done === undefined ? (cur ? cur.done : true) : !!b.done;
  const note = b.note === undefined ? (cur ? cur.note : '') : String(b.note || '').trim().slice(0, 1000);
  // unticking keeps the row (not done), so a GPS drive later that day doesn't tick it again
  if (cur || done || note) await db.q(`INSERT INTO road_drives (company_id, road_id, day, crew_id, done, note) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (road_id, day) DO UPDATE SET done=EXCLUDED.done, note=EXCLUDED.note,
        auto=CASE WHEN road_drives.done AND EXCLUDED.done THEN road_drives.auto ELSE FALSE END,
        crew_id=CASE WHEN road_drives.done AND EXCLUDED.done THEN road_drives.crew_id ELSE EXCLUDED.crew_id END,
        checked_at=CASE WHEN road_drives.done AND EXCLUDED.done THEN road_drives.checked_at ELSE now() END`,
    [company.id, roadId, d, crew.id, done, note]);
  if (done && !(cur && cur.done)) await learn(company, crew, roadId, d);
  if (b.toTasks && note) {
    const row = await db.one('SELECT id, task_id FROM road_drives WHERE road_id=$1 AND day=$2', [roadId, d]);
    if (row && !row.task_id) {   // once per road per day, even if sent twice
      await require('./tasks').createByCrew(company, crew, { title: `${road.name}: ${note}`.slice(0, 120), details: `Seen driving the roads on ${T.dayName(d)} ${T.pretty(d)}.\n${note}`, clientRef: `drive-${roadId}-${d}` });
      const t = await db.one('SELECT id FROM tasks WHERE company_id=$1 AND client_ref=$2', [company.id, `drive-${roadId}-${d}`]);
      if (t) await db.q('UPDATE road_drives SET task_id=$1 WHERE id=$2', [t.id, row.id]);
    }
  }
  return list(company, d);
}

/* ------------------------------ GPS ------------------------------ */
const MAX_ACC = 60;         // metres: rougher fixes are left out
const COVER = 0.6;          // a road is driven when 60% of it is along the route
const LEARN_MIN = 10;       // a hand tick learns the road from the last 10 minutes driven at most

/** The route driven that day (every trip, everyone), as lines; or one person's, or since a time. */
async function routeLines(companyId, day, { crewId, since } = {}) {
  const pts = await db.q(`SELECT p.trip_id, p.lat, p.lon FROM drive_points p JOIN drive_trips t ON t.id=p.trip_id
    WHERE t.company_id=$1 AND t.day=$2 ${crewId ? 'AND t.crew_id=$3' : ''} ${since ? `AND p.t >= $${crewId ? 4 : 3}` : ''} AND (p.acc IS NULL OR p.acc <= ${MAX_ACC})
    ORDER BY p.trip_id, p.t`, [companyId, day, ...(crewId ? [crewId] : []), ...(since ? [since] : [])]);
  const lines = []; let cur = null, last = null;
  pts.forEach(p => {
    const q = [p.lat, p.lon];
    if (!cur || p.trip_id !== last.trip_id || G.dist([last.lat, last.lon], q) > 800) { cur = []; lines.push(cur); }   // a gap (no signal for a while): don't draw a line across it
    cur.push(q); last = p;
  });
  return lines;
}

/** A road ticked by hand with no shape yet: what was driven just before is its shape. */
async function learn(company, crew, roadId, day) {
  if (day !== H.today(company)) return;
  if (await db.one('SELECT 1 FROM road_shapes WHERE road_id=$1', [roadId])) return;
  const prev = await db.one(`SELECT max(checked_at) AS t FROM road_drives WHERE company_id=$1 AND day=$2 AND crew_id=$3 AND done AND road_id<>$4`, [company.id, day, crew.id, roadId]);
  let since = new Date(Date.now() - LEARN_MIN * 60e3);
  if (prev && prev.t && new Date(prev.t) > since) since = new Date(prev.t);
  const lines = (await routeLines(company.id, day, { crewId: crew.id, since })).filter(l => l.length >= 2);
  const len = lines.reduce((a, l) => a + G.lineLength(l), 0);
  if (len < 80) return;   // too little to go on
  await db.q(`INSERT INTO road_shapes (road_id, company_id, source, shape) VALUES ($1,$2,'learned',$3) ON CONFLICT (road_id) DO NOTHING`, [roadId, company.id, JSON.stringify(lines)]);
}

/** Tick every road the day's route now covers. Returns the names ticked. */
async function autoTick(company, crew, day) {
  const roads = await db.q(`SELECT r.id, r.name, s.shape FROM roads r JOIN road_shapes s ON s.road_id=r.id
    WHERE r.company_id=$1 AND r.kind='road' AND r.active AND NOT EXISTS (SELECT 1 FROM road_drives x WHERE x.road_id=r.id AND x.day=$2)`, [company.id, day]);
  if (!roads.length) return [];
  const index = G.routeIndex(await routeLines(company.id, day));
  const ticked = [];
  for (const r of roads) {
    if (G.coverage(r.shape, index) < COVER) continue;
    const ins = await db.one(`INSERT INTO road_drives (company_id, road_id, day, crew_id, done, auto) VALUES ($1,$2,$3,$4,TRUE,TRUE)
      ON CONFLICT (road_id, day) DO NOTHING RETURNING id`, [company.id, r.id, day, crew.id]);
    if (ins) ticked.push(r.name);
  }
  return ticked;
}

/**
 * Points from the phone while "Start drive" is on: [[time ms, lat, lon, accuracy m], ...]. ref names the trip
 * (made on the phone, so a batch sent twice from the outbox is only saved once).
 */
async function trip(company, crew, b) {
  const ref = String(b.ref || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(ref)) V.bad("That drive didn't come through. Stop and start it again.");
  const pts = (Array.isArray(b.points) ? b.points : []).slice(0, 5000).map(p => (Array.isArray(p) ? p.map(Number) : []))
    .filter(p => p.length >= 3 && isFinite(p[0]) && Math.abs(p[1]) <= 90 && Math.abs(p[2]) <= 180 && Math.abs(p[0] - Date.now()) < 36 * 3600e3);
  const first = pts.length ? T.localNow(company.timezone, new Date(pts[0][0])).date : H.today(company);
  let t = await db.one('SELECT * FROM drive_trips WHERE company_id=$1 AND ref=$2', [company.id, ref]);
  if (t && t.crew_id !== crew.id) V.bad("That drive didn't come through. Stop and start it again.");
  if (!t) t = await db.one(`INSERT INTO drive_trips (company_id, crew_id, ref, day, started_at) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (company_id, ref) DO UPDATE SET ref=EXCLUDED.ref RETURNING *`, [company.id, crew.id, ref, first, pts.length ? new Date(pts[0][0]) : new Date()]);
  for (let i = 0; i < pts.length; i += 500) {   // 500 points per insert
    const chunk = pts.slice(i, i + 500), args = [t.id];
    const vals = chunk.map((p, k) => { args.push(p[0], p[1], p[2], isFinite(p[3]) ? p[3] : null); const n = k * 4 + 2; return `($1, to_timestamp($${n}::double precision / 1000), $${n + 1}, $${n + 2}, $${n + 3})`; });
    await db.q(`INSERT INTO drive_points (trip_id, t, lat, lon, acc) VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`, args);
  }
  if (b.ended) await db.q('UPDATE drive_trips SET ended_at=now() WHERE id=$1 AND ended_at IS NULL', [t.id]);
  const day = t.day instanceof Date ? t.day.toISOString().slice(0, 10) : String(t.day).slice(0, 10);
  const ticked = await autoTick(company, crew, day);
  const out = day >= T.shift(H.today(company), -DAYS_BACK) ? await list(company, day) : null;
  return { ticked, list: out };
}

/** For a map: each road's shape (driven or not) and the route(s) driven that day. */
async function map(company, day, { crewId, any } = {}) {
  const d = any && T.isDate(String(day || '')) ? String(day) : checkDay(company, day);   // the dashboard can look further back
  const roads = await db.q(`SELECT r.id, r.name, s.shape, s.source, COALESCE(x.done, FALSE) AS done FROM roads r
    JOIN road_shapes s ON s.road_id=r.id LEFT JOIN road_drives x ON x.road_id=r.id AND x.day=$2
    WHERE r.company_id=$1 AND r.kind='road' AND r.active ORDER BY r.position`, [company.id, d]);
  const c = await db.one('SELECT weather_lat AS lat, weather_lon AS lon FROM companies WHERE id=$1', [company.id]);
  return { day: d, roads, route: await routeLines(company.id, d, { crewId }), center: c && c.lat != null ? [Number(c.lat), Number(c.lon)] : null };
}

/* ---------------------------- road shapes ---------------------------- */
async function shapes(company) {
  const rows = await db.q(`SELECT r.id, r.name, s.source FROM roads r LEFT JOIN road_shapes s ON s.road_id=r.id
    WHERE r.company_id=$1 AND r.kind='road' AND r.active ORDER BY r.position, lower(r.name)`, [company.id]);
  return { total: rows.length, osm: rows.filter(r => r.source === 'osm').length, learned: rows.filter(r => r.source === 'learned').length,
    missing: rows.filter(r => !r.source).map(r => ({ id: r.id, name: r.name })), roads: rows };
}

/** Look the roads up on OpenStreetMap by name, around the company's location. Shapes learned by driving are kept. */
async function findShapes(company) {
  const c = await db.one('SELECT weather_lat AS lat, weather_lon AS lon FROM companies WHERE id=$1', [company.id]);
  let center = c && c.lat != null ? [Number(c.lat), Number(c.lon)] : null;
  if (!center) {
    const p = await db.one('SELECT avg(p.lat) AS lat, avg(p.lon) AS lon FROM drive_points p JOIN drive_trips t ON t.id=p.trip_id WHERE t.company_id=$1', [company.id]);
    if (p && p.lat != null) center = [Number(p.lat), Number(p.lon)];
  }
  if (!center) V.bad('Set your location first (Tasks tab, Weather reminders), or record one drive in the app.');
  let ways;
  try { ways = await G.osmWays(center[0], center[1], require('./config').geo.radius); }
  catch (e) { V.bad("Couldn't reach OpenStreetMap right now. Try again in a few minutes."); }
  const roads = await db.q("SELECT r.id, r.name FROM roads r LEFT JOIN road_shapes s ON s.road_id=r.id WHERE r.company_id=$1 AND r.kind='road' AND r.active AND (s.source IS NULL OR s.source='osm')", [company.id]);
  const found = G.matchWays(roads, ways);
  for (const [id, shape] of Object.entries(found)) {
    await db.q(`INSERT INTO road_shapes (road_id, company_id, source, shape) VALUES ($1,$2,'osm',$3)
      ON CONFLICT (road_id) DO UPDATE SET shape=EXCLUDED.shape, source='osm', updated_at=now() WHERE road_shapes.source='osm'`, [Number(id), company.id, JSON.stringify(shape)]);
  }
  return { found: Object.keys(found).length, ...(await shapes(company)) };
}
/** Forget a road's shape (e.g. it was learned wrong); it's learned again the next time it's ticked by hand on a drive. */
async function clearShape(company, roadId) {
  await db.q('DELETE FROM road_shapes WHERE road_id=$1 AND company_id=$2', [roadId, company.id]);
  return shapes(company);
}

/** For the dashboard: each day the roads were driven, how many, who, and the notes. */
async function history(company, days = 30) {
  const n = Math.max(1, Math.min(366, Number(days) || 30));
  const rows = await db.q(`SELECT to_char(x.day, 'YYYY-MM-DD') AS day, x.done, x.note, x.task_id AS "taskId", r.name AS road, c.name AS by
    FROM road_drives x JOIN roads r ON r.id=x.road_id LEFT JOIN crew c ON c.id=x.crew_id
    WHERE x.company_id=$1 AND x.day > $2::date - $3::int ORDER BY x.day DESC, r.position, lower(r.name)`, [company.id, H.today(company), n]);
  const total = (await db.one("SELECT count(*)::int AS n FROM roads WHERE company_id=$1 AND kind='road' AND active", [company.id])).n;
  const by = new Map();
  rows.forEach(r => {
    if (!by.has(r.day)) by.set(r.day, { day: r.day, driven: 0, total, who: new Set(), notes: [] });
    const g = by.get(r.day);
    if (r.done) { g.driven++; if (r.by) g.who.add(r.by); }
    if (r.note) g.notes.push({ road: r.road, note: r.note, by: r.by, task: !!r.taskId });
  });
  return { total, days: [...by.values()].map(g => ({ ...g, who: [...g.who] })) };
}

module.exports = { list, check, history, trip, map, shapes, findShapes, clearShape, autoTick, DAYS_BACK };
