// Every few minutes: send each company's emails when it's time in *their* time zone.
//  - Weekly summary: first day of the new week, at summary_hour, for the week that just ended.
//  - Missing hours:  last day of the week, at missing_hour.
const db = require('./db');
const T = require('./time');
const H = require('./hours');
const R = require('./reports');
const GD = require('./gdrive');
const BACKUP_HOUR = 2;   // 2 AM in the company's time zone

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
    if (!H.planOk(c) && !c.gdrive_token) continue;   // paused accounts still get their nightly backup
    const paused = !H.planOk(c);
    try {
      const { date, hour } = T.localNow(c.timezone, now);
      const ws = T.weekStartOf(date, c.week_start);
      if (!paused && date === ws && hour >= c.summary_hour) {
        const last = T.shift(ws, -7);
        if (await claim(c.id, 'weekly', last)) await sendOrRelease(c.id, 'weekly', last, () => R.sendWeekly(c, last));
        // each crew member with an email gets their own week
        for (const p of await db.q("SELECT * FROM crew WHERE company_id=$1 AND active AND email<>''", [c.id])) {
          const kind = 'crew-week:' + p.id;
          if (await claim(c.id, kind, last)) await sendOrRelease(c.id, kind, last, () => R.sendPersonal(c, p, last)).catch(e => console.error(`[scheduler] crew ${p.id}:`, e.message));
        }
      }
      if (!paused && date === T.shift(ws, 6) && hour >= c.missing_hour) {
        if (await claim(c.id, 'missing', ws)) await sendOrRelease(c.id, 'missing', ws, () => R.sendMissing(c));
      }
      // Address jobs: on the 1st, last month's invoices are made and the boss gets them to approve (only if there were jobs).
      if (!paused && date.slice(8) === '01' && hour >= c.summary_hour) {
        const JB = require('./jobbilling'), pm = JB.prevMonth(date);
        if (await claim(c.id, 'jobs-month', pm + '-01')) await sendOrRelease(c.id, 'jobs-month', pm + '-01', () => require('./jobinvoices').sendMonthly(c, pm));
      }
      // Weather reminders: check the forecast at 6 AM and 3 PM.
      if (!paused && c.weather_lat != null) {
        const WX = require('./weather');
        for (const h of WX.CHECK_HOURS) {
          if (hour >= h && hour < h + 3 && await claim(c.id, 'weather-' + h, date)) WX.run(c).catch(e => console.error(`[weather] company ${c.id}:`, e.message));
        }
      }
      // Nightly: refresh the QuickBooks customer list (names, balances) and meter links.
      if (c.qbo_realm && hour >= BACKUP_HOUR && await claim(c.id, 'qbo-sync', date)) {
        require('./qbo').sync(c.id).catch(e => console.error(`[qbo] company ${c.id}:`, e.message));
      }
      // Nightly Google Drive backup. A failure is shown in the dashboard; it tries again the next night (or "Back up now").
      if (c.gdrive_token && GD.enabled() && hour >= BACKUP_HOUR && await claim(c.id, 'gdrive', date)) {
        GD.backupNow(c.id).catch(e => console.error(`[gdrive] company ${c.id}:`, e.message));
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
