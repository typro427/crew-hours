// Water system readings: the boss picks what to record (chlorine, pressure, tank level...), the crew logs values.
const db = require('./db');
const V = require('./validate');

/** What to record, in order. */
const types = companyId => db.q('SELECT id, name, unit FROM reading_types WHERE company_id=$1 AND active ORDER BY position, id', [companyId]);

/** The boss sets the list: one per line, "Name | unit" (unit optional). Removed ones are hidden; past values are kept. */
async function setTypes(companyId, lines) {
  if (!Array.isArray(lines)) V.bad('Send the list of readings.');
  const items = [], seen = new Set();
  lines.forEach(l => {
    const [n, u] = String(l || '').split('|').map(x => x.trim().replace(/\s+/g, ' '));
    if (!n || seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    items.push({ name: V.str(n, 'a reading name', 1, 60), unit: String(u || '').slice(0, 20) });
  });
  if (items.length > 40) V.bad('Up to 40 readings.');
  await db.tx(async t => {
    const have = await t.q('SELECT id, name FROM reading_types WHERE company_id=$1', [companyId]);
    const byName = new Map(have.map(r => [r.name.toLowerCase(), r]));
    await t.q('UPDATE reading_types SET active=FALSE WHERE company_id=$1', [companyId]);
    for (let i = 0; i < items.length; i++) {
      const old = byName.get(items[i].name.toLowerCase());
      if (old) await t.q('UPDATE reading_types SET name=$1, unit=$2, position=$3, active=TRUE WHERE id=$4', [items[i].name, items[i].unit, i, old.id]);
      else await t.q('INSERT INTO reading_types (company_id, name, unit, position) VALUES ($1,$2,$3,$4)', [companyId, items[i].name, items[i].unit, i]);
    }
  });
}

/** Recent readings, newest first. */
const recent = (companyId, days, limit) => db.q(`SELECT r.id, r.taken_at AS "takenAt", r.vals, r.notes, r.crew_id AS "crewId", c.name AS "byName",
    r.site_id AS "siteId", s.name AS "siteName", r.mow_id AS "checkId"
  FROM readings r LEFT JOIN crew c ON c.id=r.crew_id LEFT JOIN roads s ON s.id=r.site_id
  WHERE r.company_id=$1 AND r.taken_at > now() - ($2 || ' days')::interval ORDER BY r.taken_at DESC LIMIT $3`, [companyId, String(days || 60), limit || 500]);

/** Checks a {readingTypeId: value} map: only known readings, numbers only, blanks skipped. */
async function cleanVals(companyId, raw) {
  const ids = new Set((await types(companyId)).map(t => String(t.id)));
  const vals = {};
  Object.entries(raw || {}).forEach(([k, v]) => {
    if (!ids.has(String(k)) || v === '' || v == null) return;
    const n = Number(v);
    if (!isFinite(n) || Math.abs(n) > 1e9) V.bad('Readings must be numbers.');
    vals[k] = n;
  });
  return vals;
}

/** A crew member records a set of readings now. At least one value; each must be a number. */
async function log(company, crew, b) {
  const vals = await cleanVals(company.id, b && b.vals);
  const notes = String((b && b.notes) || '').trim().slice(0, 1000);
  if (!Object.keys(vals).length && !notes) V.bad('Enter at least one reading.');
  await db.q('INSERT INTO readings (company_id, crew_id, vals, notes) VALUES ($1,$2,$3,$4)', [company.id, crew.id, JSON.stringify(vals), notes]);
}

/** Crew can remove their own reading from the last 24 hours; the boss can remove any. */
async function remove(companyId, id, crewId) {
  const r = await db.one(`SELECT 1 FROM readings WHERE id=$1 AND company_id=$2 ${crewId ? "AND crew_id=$3 AND taken_at > now() - interval '24 hours'" : ''}`,
    crewId ? [id, companyId, crewId] : [id, companyId]);
  if (!r) V.bad(crewId ? 'You can only remove your own readings from the last 24 hours.' : 'That reading was not found.');
  await db.q('DELETE FROM readings WHERE id=$1', [id]);
}

module.exports = { types, setTypes, recent, log, remove, cleanVals };
