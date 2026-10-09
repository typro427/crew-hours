// Owner dashboard API: /api/admin/...  (cookie login)
const db = require('../db');
const A = require('../auth');
const H = require('../hours');
const T = require('../time');
const V = require('../validate');
const R = require('../reports');
const config = require('../config');
const P = require('../plans');

const r = require('../router')();
r.use(A.requireOwner);

const activeCount = async companyId => (await db.one('SELECT count(*)::int AS n FROM crew WHERE company_id=$1 AND active', [companyId])).n;

async function billing(c) {
  const daysLeft = c.trial_ends_at ? Math.max(0, Math.ceil((new Date(c.trial_ends_at) - Date.now()) / 864e5)) : null;
  const active = await activeCount(c.id);
  const fits = P.planFor(active);
  return { status: c.plan_status, ok: H.planOk(c), trialEndsAt: c.trial_ends_at, trialDaysLeft: c.plan_status === 'trialing' ? daysLeft : null,
           hasCustomer: !!c.stripe_customer_id, hasSubscription: !!c.stripe_subscription_id && c.plan_status !== 'canceled',
           stripeReady: !!config.stripe.secretKey, tier: c.plan_tier, plans: P.publicPlans(),
           activeCrew: active, crewLimit: P.crewLimit(c), suggested: fits ? fits.key : null };
}

/** Refuses when one more active crew member would go over the plan. */
async function checkRoom(c) {
  const limit = P.crewLimit(c), active = await activeCount(c.id);
  if (active < limit) return;
  if (limit >= P.TRIAL_MAX) V.bad(`You have ${active} active crew, the most any plan allows. Turn someone off first.`);
  V.bad(`Your ${P.PLANS[c.plan_tier].name} plan covers up to ${limit} active crew. Switch to Pro on the Billing tab to add more.`);
}

function settingsOut(c) {
  return { name: c.name, slug: c.slug, timezone: c.timezone, weekStart: c.week_start, mainLabel: c.main_label,
           otherEnabled: c.other_enabled, otherLabel: c.other_label, otherOptions: c.other_options,
           overtimeAfter: Number(c.overtime_after), maxDaysBack: c.max_days_back, workdays: c.workdays,
           summaryHour: c.summary_hour, missingHour: c.missing_hour, reportEmails: c.report_emails };
}

r.get('/me', async (req, res) => res.json({
  owner: { name: req.owner.name, email: req.owner.email },
  settings: settingsOut(req.company), billing: await billing(req.company),
  crewLink: `${config.appUrl}/c/${req.company.slug}`, today: H.today(req.company), productName: config.productName
}));

r.put('/settings', async (req, res) => {
  const b = req.body || {}, c = req.company;
  const opts = Array.isArray(b.otherOptions) ? b.otherOptions.map(s => V.str(s, 'an option', 1, 60)) : c.other_options;
  if (opts.length > 25) V.bad('Up to 25 options.');
  if (new Set(opts.map(s => s.toLowerCase())).size !== opts.length) V.bad('Each option must be different.');
  const workdays = Array.isArray(b.workdays) ? [...new Set(b.workdays.map(d => V.int(d, 'Workday', 0, 6)))].sort() : c.workdays;
  const tz = b.timezone !== undefined ? String(b.timezone) : c.timezone;
  if (!T.validTimeZone(tz)) V.bad('Pick a valid time zone.');
  const v = {
    name: b.name !== undefined ? V.str(b.name, 'a company name', 1, 80) : c.name,
    week_start: b.weekStart !== undefined ? V.int(b.weekStart, 'Week start', 0, 6) : c.week_start,
    main_label: b.mainLabel !== undefined ? V.str(b.mainLabel, 'a name for the main time tab', 1, 30) : c.main_label,
    other_enabled: b.otherEnabled !== undefined ? !!b.otherEnabled : c.other_enabled,
    other_label: b.otherLabel !== undefined ? V.str(b.otherLabel, 'a name for the second tab', 1, 30) : c.other_label,
    overtime_after: b.overtimeAfter !== undefined ? V.num(b.overtimeAfter, 'Overtime after', 0, 168) : c.overtime_after,
    max_days_back: b.maxDaysBack !== undefined ? V.int(b.maxDaysBack, 'Days back', 0, 60) : c.max_days_back,
    summary_hour: b.summaryHour !== undefined ? V.int(b.summaryHour, 'Summary hour', 0, 23) : c.summary_hour,
    missing_hour: b.missingHour !== undefined ? V.int(b.missingHour, 'Reminder hour', 0, 23) : c.missing_hour,
    report_emails: b.reportEmails !== undefined ? V.emailList(b.reportEmails) : c.report_emails
  };
  const row = await db.one(`UPDATE companies SET name=$1, timezone=$2, week_start=$3, main_label=$4, other_enabled=$5, other_label=$6,
    other_options=$7, overtime_after=$8, max_days_back=$9, workdays=$10, summary_hour=$11, missing_hour=$12, report_emails=$13
    WHERE id=$14 RETURNING *`, [v.name, tz, v.week_start, v.main_label, v.other_enabled, v.other_label, JSON.stringify(opts),
    v.overtime_after, v.max_days_back, JSON.stringify(workdays), v.summary_hour, v.missing_hour, v.report_emails, c.id]);
  res.json({ settings: settingsOut(row) });
});

/* ------------------------------- crew members ------------------------------- */
const crewList = companyId => db.q('SELECT id, name, active, is_manager, created_at FROM crew WHERE company_id=$1 ORDER BY active DESC, lower(name)', [companyId]);

r.get('/crew', async (req, res) => res.json({ crew: await crewList(req.company.id), billing: await billing(req.company) }));

async function pinFree(companyId, pin, exceptId) {
  const row = await db.one('SELECT id FROM crew WHERE company_id=$1 AND pin_hmac=$2', [companyId, A.pinHmac(companyId, pin)]);
  return !row || row.id === exceptId;
}

r.post('/crew', async (req, res) => {
  const name = V.str(req.body.name, 'a name', 1, 60), pin = V.pin(req.body.pin);
  const count = await db.one('SELECT count(*)::int AS n FROM crew WHERE company_id=$1', [req.company.id]);
  if (count.n >= 300) V.bad('That is the most crew members one account can have.');
  await checkRoom(req.company);
  if (!(await pinFree(req.company.id, pin))) V.bad('Someone else already uses that PIN. Pick a different one.');
  await db.q('INSERT INTO crew (company_id, name, pin_hmac, is_manager) VALUES ($1,$2,$3,$4)',
    [req.company.id, name, A.pinHmac(req.company.id, pin), !!req.body.manager]);
  res.json({ crew: await crewList(req.company.id), billing: await billing(req.company) });
});

r.put('/crew/:id', async (req, res) => {
  const id = Number(req.params.id);
  const person = await db.one('SELECT * FROM crew WHERE id=$1 AND company_id=$2', [id, req.company.id]);
  if (!person) return res.status(404).json({ error: 'That crew member was not found.' });
  const b = req.body || {};
  const name = b.name !== undefined ? V.str(b.name, 'a name', 1, 60) : person.name;
  let pinH = person.pin_hmac;
  if (b.pin !== undefined && b.pin !== '') {
    const pin = V.pin(b.pin);
    if (!(await pinFree(req.company.id, pin, id))) V.bad('Someone else already uses that PIN. Pick a different one.');
    pinH = A.pinHmac(req.company.id, pin);
  }
  const active = b.active !== undefined ? !!b.active : person.active;
  if (active && !person.active) await checkRoom(req.company);
  const manager = b.manager !== undefined ? !!b.manager : person.is_manager;
  await db.q('UPDATE crew SET name=$1, pin_hmac=$2, active=$3, is_manager=$4 WHERE id=$5', [name, pinH, active, manager, id]);
  if (!active || pinH !== person.pin_hmac) await db.q('DELETE FROM crew_sessions WHERE crew_id=$1', [id]);   // sign them out
  res.json({ crew: await crewList(req.company.id), billing: await billing(req.company) });
});

/* --------------------------------- weeks ---------------------------------- */
r.get('/week', async (req, res) => res.json(await H.crewWeek(req.company, req.query.start)));
r.post('/approve', async (req, res) => res.json(await H.setApproved(req.company, req.body.weekStart, req.body.approved, req.owner.name || req.owner.email)));

r.post('/email-me', async (req, res) => {
  if (A.limited('emailme:' + req.company.id, 10, 60 * 60e3)) return res.status(429).json({ error: 'Too many emails. Try again in an hour.' });
  A.fail('emailme:' + req.company.id, 60 * 60e3);
  const kind = req.body.kind;
  if (kind === 'missing') await R.sendMissing(req.company);
  else await R.sendWeekly(req.company, req.body.weekStart || H.today(req.company), { final: false });
  res.json({ ok: true, to: await R.recipients(req.company) });
});

/* -------------------------------- export ---------------------------------- */
const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;            // spreadsheet apps would run these as formulas
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

r.get('/export.csv', async (req, res) => {
  const c = req.company, t = H.today(c);
  const from = T.isDate(req.query.from) ? req.query.from : H.weekOf(c, t);
  const to = T.isDate(req.query.to) ? req.query.to : T.shift(from, 6);
  const rows = await db.q(`SELECT e.*, cr.name FROM entries e JOIN crew cr ON cr.id=e.crew_id
                           WHERE e.company_id=$1 AND e.day BETWEEN $2 AND $3 ORDER BY e.day, lower(cr.name)`, [c.id, from, to]);
  const m = c.main_label, o = c.other_label;
  const head = ['Date', 'Day', 'Name', `${m} start`, `${m} end`, 'Clocked out', 'Clocked back in', `${m} hours`, 'What they did',
                `${o} for`, `${o} start`, `${o} end`, `${o} clocked out`, `${o} clocked back in`, `${o} hours`, `${o} notes`, 'Day total', 'Last saved'];
  const lines = [head.map(csvCell).join(',')];
  rows.forEach(e => lines.push([e.day, T.dayName(e.day), e.name, e.start_t, e.end_t, e.out_t, e.back_t, Number(e.hours).toFixed(2), e.summary,
    e.o_job, e.o_start, e.o_end, e.o_out, e.o_back, Number(e.o_hours).toFixed(2), e.o_summary, (Number(e.hours) + Number(e.o_hours)).toFixed(2),
    new Date(e.updated_at).toISOString()].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${c.slug}-hours-${from}-to-${to}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

module.exports = r;
module.exports.billing = billing;
