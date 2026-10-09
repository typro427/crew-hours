// Every few minutes: send each company's emails when it's time in *their* time zone.
//  - Weekly summary: first day of the new week, at summary_hour, for the week that just ended.
//  - Missing hours:  last day of the week, at missing_hour.
const db = require('./db');
const T = require('./time');
const H = require('./hours');
const R = require('./reports');

async function claim(companyId, kind, period) {
  const r = await db.q(`INSERT INTO email_log (company_id, kind, period) VALUES ($1,$2,$3)
                        ON CONFLICT DO NOTHING RETURNING company_id`, [companyId, kind, period]);
  return r.length > 0;   // false = already sent
}

/** If sending fails, forget the claim so the next run tries again. */
async function sendOrRelease(companyId, kind, period, fn) {
  try { await fn(); }
  catch (e) { await db.q('DELETE FROM email_log WHERE company_id=$1 AND kind=$2 AND period=$3', [companyId, kind, period]); throw e; }
}

async function tick(now = new Date()) {
  const companies = await db.q('SELECT * FROM companies');
  for (const c of companies) {
    if (!H.planOk(c)) continue;
    try {
      const { date, hour } = T.localNow(c.timezone, now);
      const ws = T.weekStartOf(date, c.week_start);
      if (date === ws && hour >= c.summary_hour) {
        const last = T.shift(ws, -7);
        if (await claim(c.id, 'weekly', last)) await sendOrRelease(c.id, 'weekly', last, () => R.sendWeekly(c, last));
      }
      if (date === T.shift(ws, 6) && hour >= c.missing_hour) {
        if (await claim(c.id, 'missing', ws)) await sendOrRelease(c.id, 'missing', ws, () => R.sendMissing(c));
      }
    } catch (e) { console.error(`[scheduler] company ${c.id}:`, e.message); }
  }
  // tidy up expired logins
  await db.q('DELETE FROM crew_sessions WHERE expires_at < now()');
  await db.q('DELETE FROM owner_sessions WHERE expires_at < now()');
}

function start() {
  const run = () => tick().catch(e => console.error('[scheduler]', e.message));
  setTimeout(run, 15000);
  return setInterval(run, 5 * 60 * 1000);
}

module.exports = { tick, start };
