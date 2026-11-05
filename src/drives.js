// Roads driven: a checklist a manager ticks off while driving the roads. One check per road per day (whoever
// drove it), with an optional note ("pothole by the culvert") that can also go on the task list.
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const H = require('./hours');

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
      x.done, x.note, x.task_id AS "taskId", x.checked_at AS "checkedAt", xc.name AS "byName",
      to_char(l.day, 'YYYY-MM-DD') AS "lastDay", lc.name AS "lastBy"
    FROM roads r
    LEFT JOIN road_drives x ON x.road_id=r.id AND x.day=$2
    LEFT JOIN crew xc ON xc.id=x.crew_id
    LEFT JOIN LATERAL (SELECT day, crew_id FROM road_drives WHERE road_id=r.id AND done AND day < $2 ORDER BY day DESC LIMIT 1) l ON TRUE
    LEFT JOIN crew lc ON lc.id=l.crew_id
    WHERE r.company_id=$1 AND r.kind='road' AND r.active ORDER BY r.position, lower(r.name)`, [company.id, d]);
  roads.forEach(r => { r.done = !!r.done; r.note = r.note || ''; });
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
  if (!done && !note) { if (cur) await db.q('DELETE FROM road_drives WHERE id=$1', [cur.id]); }
  else await db.q(`INSERT INTO road_drives (company_id, road_id, day, crew_id, done, note) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (road_id, day) DO UPDATE SET done=EXCLUDED.done, note=EXCLUDED.note,
        crew_id=CASE WHEN road_drives.done AND EXCLUDED.done THEN road_drives.crew_id ELSE EXCLUDED.crew_id END,
        checked_at=CASE WHEN road_drives.done AND EXCLUDED.done THEN road_drives.checked_at ELSE now() END`,
    [company.id, roadId, d, crew.id, done, note]);
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

module.exports = { list, check, history, DAYS_BACK };
