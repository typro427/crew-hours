// Members list: a searchable database the boss imports (from the master list) and can edit.
const db = require('./db');
const V = require('./validate');

const MAX_ROWS = 10000, MAX_COLS = 60, MAX_CELL = 1000;
const searchText = data => Object.values(data).join(' ').toLowerCase().replace(/\s+/g, ' ').slice(0, 8000);

async function columns(companyId) {
  const c = await db.one('SELECT member_columns FROM companies WHERE id=$1', [companyId]);
  return (c && c.member_columns) || [];
}

/** Keep only known columns, as trimmed strings. */
function cleanRow(cols, raw) {
  const out = {};
  cols.forEach(k => { const v = raw && raw[k]; if (v != null && String(v).trim() !== '') out[k] = String(v).trim().slice(0, MAX_CELL); });
  return out;
}

/**
 * Search: every word must appear somewhere in the row. Status filter matches the Status column if there is one.
 * Returns at most `limit` rows plus the total number of matches.
 */
async function search(companyId, { q, status, limit, offset }) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const args = [companyId], where = ['company_id=$1'];
  words.forEach(w => { args.push('%' + w.replace(/[\\%_]/g, m => '\\' + m) + '%'); where.push(`search LIKE $${args.length}`); });
  if (status) { args.push(String(status)); where.push(`data->>'Status' = $${args.length}`); }
  const w = where.join(' AND ');
  const total = (await db.one(`SELECT count(*)::int AS n FROM members WHERE ${w}`, args)).n;
  args.push(Math.min(Number(limit) || 50, 500), Math.max(Number(offset) || 0, 0));
  const rows = await db.q(`SELECT id, data FROM members WHERE ${w} ORDER BY position, id LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
  return { columns: await columns(companyId), total, rows };
}

/** Replace the whole list from an import: { columns: [...], rows: [{col: value}] }. */
async function replaceAll(companyId, b) {
  const cols = Array.isArray(b && b.columns) ? [...new Set(b.columns.map(c => String(c || '').trim()).filter(Boolean))] : [];
  if (!cols.length) V.bad('The file has no columns.');
  if (cols.length > MAX_COLS) V.bad(`Up to ${MAX_COLS} columns.`);
  const rows = (Array.isArray(b.rows) ? b.rows : []).map(r => cleanRow(cols, r)).filter(r => Object.keys(r).length);
  if (!rows.length) V.bad('The file has no rows.');
  if (rows.length > MAX_ROWS) V.bad(`Up to ${MAX_ROWS} rows.`);
  await db.tx(async t => {
    await t.q('DELETE FROM members WHERE company_id=$1', [companyId]);
    await t.q('UPDATE companies SET member_columns=$1 WHERE id=$2', [JSON.stringify(cols), companyId]);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500), vals = [], args = [];
      chunk.forEach((r, j) => { args.push(companyId, JSON.stringify(r), searchText(r), i + j); const n = args.length; vals.push(`($${n - 3},$${n - 2},$${n - 1},$${n})`); });
      await t.q(`INSERT INTO members (company_id, data, search, position) VALUES ${vals.join(',')}`, args);
    }
  });
  return { columns: cols.length, rows: rows.length };
}

async function save(companyId, id, data) {
  const cols = await columns(companyId);
  if (!cols.length) V.bad('Import the list first.');
  const row = cleanRow(cols, data);
  if (!Object.keys(row).length) V.bad('Fill in at least one field.');
  if (id) {
    const r = await db.q('UPDATE members SET data=$1, search=$2, updated_at=now() WHERE id=$3 AND company_id=$4 RETURNING id', [JSON.stringify(row), searchText(row), id, companyId]);
    if (!r.length) V.bad('That member was not found.');
    return id;
  }
  const n = (await db.one('SELECT count(*)::int AS n FROM members WHERE company_id=$1', [companyId])).n;
  if (n >= MAX_ROWS) V.bad(`Up to ${MAX_ROWS} rows.`);
  return (await db.one('INSERT INTO members (company_id, data, search, position) VALUES ($1,$2,$3,(SELECT COALESCE(max(position),0)+1 FROM members WHERE company_id=$1)) RETURNING id',
    [companyId, JSON.stringify(row), searchText(row)])).id;
}

const remove = (companyId, id) => db.q('DELETE FROM members WHERE id=$1 AND company_id=$2', [id, companyId]);
const all = companyId => db.q('SELECT data FROM members WHERE company_id=$1 ORDER BY position, id', [companyId]);

module.exports = { search, replaceAll, save, remove, all, columns };
