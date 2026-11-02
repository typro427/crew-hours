// Roads mowed: a list of the company's roads, and each time someone mowed one (date, notes, photos).
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const H = require('./hours');

const MAX_PHOTOS = 4;      // per mowing
const MAX_DAYS_BACK = 60;  // how far back the crew can log a mowing

/** Every active road with when it was last mowed and by whom, in list order. */
const INFO = `r.length_mi AS "lengthMi", r.p_road AS "pRoad", r.p_ditch AS "pDitch", r.p_trees AS "pTrees", r.surface, r.notes`;
const list = companyId => db.q(`SELECT r.id, r.name, ${INFO},
    to_char(m.day, 'YYYY-MM-DD') AS "lastDay", c.name AS "lastBy",
    (SELECT count(*)::int FROM road_mows x WHERE x.road_id=r.id AND x.day >= date_trunc('year', now())::date) AS "timesThisYear"
  FROM roads r
  LEFT JOIN LATERAL (SELECT day, crew_id FROM road_mows WHERE road_id=r.id ORDER BY day DESC, id DESC LIMIT 1) m ON TRUE
  LEFT JOIN crew c ON c.id=m.crew_id
  WHERE r.company_id=$1 AND r.active ORDER BY r.position, lower(r.name)`, [companyId]);

/** One road's mowing history, newest first. */
async function history(companyId, roadId, limit) {
  const road = await db.one(`SELECT r.id, r.name, ${INFO} FROM roads r WHERE r.id=$1 AND r.company_id=$2`, [roadId, companyId]);
  if (!road) V.bad('That road was not found.');
  road.mows = await db.q(`SELECT m.id, to_char(m.day, 'YYYY-MM-DD') AS day, m.notes, m.crew_id AS "crewId", c.name AS "byName",
      COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM road_mow_photos p WHERE p.mow_id=m.id), '[]') AS photos
    FROM road_mows m LEFT JOIN crew c ON c.id=m.crew_id WHERE m.road_id=$1 ORDER BY m.day DESC, m.id DESC LIMIT $2`, [roadId, limit || 50]);
  return road;
}

/** The boss sets the list: one name per line. Roads taken off the list are hidden, and their history is kept. */
async function setList(companyId, names) {
  if (!Array.isArray(names)) V.bad('Send the list of road names.');
  const clean = [], seen = new Set();
  names.forEach(n => { const s = String(n || '').trim().replace(/\s+/g, ' '); if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); clean.push(V.str(s, 'a road name', 1, 80)); } });
  if (clean.length > 500) V.bad('Up to 500 roads.');
  await db.tx(async t => {
    const have = await t.q('SELECT id, name FROM roads WHERE company_id=$1', [companyId]);
    const byName = new Map(have.map(r => [r.name.toLowerCase(), r]));
    await t.q('UPDATE roads SET active=FALSE WHERE company_id=$1', [companyId]);
    for (let i = 0; i < clean.length; i++) {
      const old = byName.get(clean[i].toLowerCase());
      if (old) await t.q('UPDATE roads SET name=$1, position=$2, active=TRUE WHERE id=$3', [clean[i], i, old.id]);
      else await t.q('INSERT INTO roads (company_id, name, position) VALUES ($1,$2,$3)', [companyId, clean[i], i]);
    }
  });
}

/** Length, surface, priorities (1 needs work, 2 soon, 3 can wait) and notes for one road. */
function cleanInfo(b) {
  const pr = (v, n) => { if (v === '' || v == null) return null; const x = V.int(v, n, 1, 3); return x; };
  const len = b.lengthMi === '' || b.lengthMi == null ? null : V.num(b.lengthMi, 'Length', 0, 100);
  return { len, pRoad: pr(b.pRoad, 'Roadway priority'), pDitch: pr(b.pDitch, 'Ditch line priority'), pTrees: pr(b.pTrees, 'Trees priority'),
           surface: String(b.surface || '').trim().slice(0, 60), notes: String(b.notes || '').trim().slice(0, 2000) };
}
async function setInfo(companyId, roadId, b, q) {
  const v = cleanInfo(b || {});
  const r = await (q || db).q('UPDATE roads SET length_mi=$1, p_road=$2, p_ditch=$3, p_trees=$4, surface=$5, notes=$6 WHERE id=$7 AND company_id=$8 RETURNING id',
    [v.len, v.pRoad, v.pDitch, v.pTrees, v.surface, v.notes, roadId, companyId]);
  if (!r.length) V.bad('That road was not found.');
}

/** Import roads with their details (from the import file): matched by name, added if new, in the file's order. */
async function importRoads(companyId, roads, t) {
  const have = await t.q('SELECT id, name, position FROM roads WHERE company_id=$1', [companyId]);
  const byName = new Map(have.map(r => [r.name.toLowerCase(), r]));
  const loose = s => s.toLowerCase().replace(/\bthru\b/g, 'through').replace(/[^a-z0-9]+/g, '');
  const byLoose = new Map(have.map(r => [loose(r.name), r]));
  let added = 0, updated = 0;
  for (let i = 0; i < roads.length; i++) {
    const name = V.str(roads[i].name, 'a road name', 1, 80);
    let row = byName.get(name.toLowerCase()) || byLoose.get(loose(name));
    if (!row) { row = await t.one('INSERT INTO roads (company_id, name, position) VALUES ($1,$2,$3) RETURNING id', [companyId, name, i]); added++; }
    else { await t.q('UPDATE roads SET active=TRUE, position=$1 WHERE id=$2', [i, row.id]); updated++; }
    await setInfo(companyId, row.id, roads[i], t);
  }
  return { added, updated };
}

/** A crew member logs a mowing: the date (today or earlier), optional notes, up to 4 photos. */
async function logMow(company, crew, roadId, b, photoBytes) {
  const road = await db.one('SELECT id FROM roads WHERE id=$1 AND company_id=$2 AND active', [roadId, company.id]);
  if (!road) V.bad('That road was not found. Pull down to refresh.');
  const day = String(b.day || '');
  const today = H.today(company);
  if (!T.isDate(day)) V.bad('Pick the date you mowed it.');
  if (day > today) V.bad("You can't log a day that hasn't happened yet.");
  if (day < T.shift(today, -MAX_DAYS_BACK)) V.bad('That date is too far back. Ask the boss.');
  const photos = (Array.isArray(b.photos) ? b.photos : []).map(photoBytes);
  if (photos.length > MAX_PHOTOS) V.bad(`Up to ${MAX_PHOTOS} photos each time.`);
  if (await db.one('SELECT 1 FROM road_mows WHERE road_id=$1 AND day=$2 AND crew_id=$3', [roadId, day, crew.id])) V.bad('You already logged this road for that day.');
  await db.tx(async t => {
    const m = await t.one('INSERT INTO road_mows (company_id, road_id, crew_id, day, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [company.id, roadId, crew.id, day, String(b.notes || '').trim().slice(0, 1000)]);
    for (const p of photos) await t.q('INSERT INTO road_mow_photos (mow_id, company_id, mime, data) VALUES ($1,$2,$3,$4)', [m.id, company.id, p.mime, p.buf]);
  });
}

/** Crew can undo their own entry; the boss can remove any. */
async function removeMow(companyId, mowId, crewId) {
  const m = await db.one(`SELECT road_id FROM road_mows WHERE id=$1 AND company_id=$2 ${crewId ? 'AND crew_id=$3' : ''}`, crewId ? [mowId, companyId, crewId] : [mowId, companyId]);
  if (!m) V.bad(crewId ? 'You can only remove entries you added.' : 'That entry was not found.');
  await db.q('DELETE FROM road_mows WHERE id=$1', [mowId]);
  return m.road_id;
}

const photo = (companyId, id) => db.one('SELECT mime, data FROM road_mow_photos WHERE id=$1 AND company_id=$2', [id, companyId]);

module.exports = { list, history, setList, setInfo, importRoads, logMow, removeMow, photo, MAX_PHOTOS };
