const { Pool, types } = require('pg');
const config = require('./config');

// Return DATE columns as plain 'YYYY-MM-DD' strings and NUMERIC as numbers.
types.setTypeParser(1082, v => v);
types.setTypeParser(1700, v => Number(v));

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 10
});

async function q(text, params) { const r = await pool.query(text, params); return r.rows; }
async function one(text, params) { const r = await pool.query(text, params); return r.rows[0] || null; }

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn({
      q: async (t, p) => (await client.query(t, p)).rows,
      one: async (t, p) => (await client.query(t, p)).rows[0] || null
    });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, q, one, tx };
