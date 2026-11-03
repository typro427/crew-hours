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
  crewLink: `${config.appUrl}/c/${req.company.slug}`, today: H.today(req.company), productName: config.productName,
  gdrive: require('../gdrive').status(req.company)
}));

/* ---------------------------- Google Drive backup ---------------------------- */
const GD = require('../gdrive');
r.get('/google/connect', async (req, res) => {
  if (!GD.enabled()) return res.redirect('/admin#gdrive-off');
  res.redirect(GD.authUrl(req.company.id));
});
r.get('/google/callback', async (req, res) => {
  if (req.query.error) return res.redirect('/admin#gdrive-error=' + encodeURIComponent(req.query.error === 'access_denied' ? 'You cancelled the Google sign-in.' : String(req.query.error)));
  try {
    await GD.finishConnect(req.company.id, String(req.query.code || ''), String(req.query.state || ''));
    GD.backupNow(req.company.id).catch(e => console.error('[gdrive] first backup', e.message));   // first copy right away
    res.redirect('/admin#gdrive-ok');
  } catch (e) { res.redirect('/admin#gdrive-error=' + encodeURIComponent(e.message)); }
});
r.post('/google/disconnect', async (req, res) => { await GD.disconnect(req.company.id); res.json({ ok: true }); });
r.post('/google/backup', async (req, res) => {
  try { res.json(await GD.backupNow(req.company.id)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

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
  let slug = c.slug;
  if (b.slug !== undefined && String(b.slug).trim().toLowerCase() !== c.slug) {
    slug = String(b.slug).trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) || slug.includes('--'))
      V.bad('The crew link can use lowercase letters, numbers and dashes (3 to 40 characters), and must start and end with a letter or number.');
    const taken = await db.one('SELECT 1 FROM companies WHERE slug=$1 UNION ALL SELECT 1 FROM slug_redirects WHERE old_slug=$1 AND company_id<>$2', [slug, c.id]);
    if (taken) V.bad('That crew link is already taken. Try another.');
  }
  const row = await db.one(`UPDATE companies SET name=$1, timezone=$2, week_start=$3, main_label=$4, other_enabled=$5, other_label=$6,
    other_options=$7, overtime_after=$8, max_days_back=$9, workdays=$10, summary_hour=$11, missing_hour=$12, report_emails=$13
    WHERE id=$14 RETURNING *`, [v.name, tz, v.week_start, v.main_label, v.other_enabled, v.other_label, JSON.stringify(opts),
    v.overtime_after, v.max_days_back, JSON.stringify(workdays), v.summary_hour, v.missing_hour, v.report_emails, c.id]);
  if (slug !== c.slug) await db.tx(async t => {
    await t.q('DELETE FROM slug_redirects WHERE old_slug=$1', [slug]);
    await t.q('INSERT INTO slug_redirects (old_slug, company_id) VALUES ($1,$2) ON CONFLICT (old_slug) DO UPDATE SET company_id=EXCLUDED.company_id', [c.slug, c.id]);
    await t.q('UPDATE companies SET slug=$1 WHERE id=$2', [slug, c.id]);
    row.slug = slug;
  });
  res.json({ settings: settingsOut(row), crewLink: `${config.appUrl}/c/${row.slug}` });
});

/* ------------------------------- crew members ------------------------------- */
const F = require('../features');
const crewList = async companyId => (await db.q('SELECT id, name, active, is_manager, features, email, created_at FROM crew WHERE company_id=$1 ORDER BY active DESC, lower(name)', [companyId]))
  .map(c => ({ ...c, features: F.forCrew(c) }));

r.get('/crew', async (req, res) => res.json({ crew: await crewList(req.company.id), billing: await billing(req.company), features: F.FEATURES }));

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
  res.json({ crew: await crewList(req.company.id), billing: await billing(req.company), features: F.FEATURES });
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
  const features = b.features !== undefined ? F.clean(b.features) : person.features;
  const email = b.email !== undefined ? (String(b.email || '').trim() ? V.email(b.email) : '') : person.email;
  await db.q('UPDATE crew SET name=$1, pin_hmac=$2, active=$3, is_manager=$4, features=$5, email=$6 WHERE id=$7', [name, pinH, active, manager, features ? JSON.stringify(features) : null, email, id]);
  if (!active || pinH !== person.pin_hmac) await db.q('DELETE FROM crew_sessions WHERE crew_id=$1', [id]);   // sign them out
  res.json({ crew: await crewList(req.company.id), billing: await billing(req.company), features: F.FEATURES });
});

// Send a crew member their week now (last week by default), to check it looks right.
r.post('/crew/:id/email-week', async (req, res) => {
  const p = await db.one('SELECT * FROM crew WHERE id=$1 AND company_id=$2', [Number(req.params.id), req.company.id]);
  if (!p) return res.status(404).json({ error: 'That crew member was not found.' });
  if (!p.email) V.bad('Add their email first, then Save.');
  if (A.limited('crewmail:' + p.id, 5, 60 * 60e3)) return res.status(429).json({ error: 'Too many emails. Try again in an hour.' });
  A.fail('crewmail:' + p.id, 60 * 60e3);
  const ws = req.body && T.isDate(req.body.weekStart) ? req.body.weekStart : require('../time').shift(H.weekOf(req.company, H.today(req.company)), -7);
  await R.sendPersonal(req.company, p, ws);
  res.json({ ok: true, to: p.email });
});

/* --------------------------------- tasks ----------------------------------- */
const K = require('../tasks');
// kind=task (Tasks tab) or kind=repair (Water System tab: leaks & repairs).
const tasksOut = async (req, kind) => ({ tasks: await K.forOwner(req.company.id, kind), kind: K.kindOf(kind) });
r.get('/tasks', async (req, res) => res.json(await tasksOut(req, req.query.kind)));
r.post('/tasks/bulk', async (req, res) => { const n = await K.bulk(req.company.id, req.body || {}); res.json({ ...(await tasksOut(req, (req.body || {}).kind)), added: n }); });
r.post('/tasks', async (req, res) => {
  const b = req.body || {}, kind = K.kindOf(b.kind);
  await K.create(req.company.id, b);
  // phones: a task from the boss (to that person, or everyone), or an urgent / high leak (the water crew)
  const P = require('../push'), title = String(b.title || '').trim().slice(0, 100);
  if (kind === 'task') P.notify(req.company, b.assignedTo ? [Number(b.assignedTo)] : null, { title: `New task: ${title}`, body: String(b.details || '').trim().slice(0, 200) || 'Open the app to see it.', tab: 'tasks' });
  if (kind === 'repair' && ['urgent', 'high'].includes(b.priority)) P.notify(req.company, null, { feature: 'w_repairs', title: `${b.priority === 'urgent' ? '🚨 Urgent' : '⚠ High'}: ${title}`, body: b.address ? String(b.address) : 'Open Leaks & repairs to see it.', tab: 'water' });
  res.json(await tasksOut(req, kind));
});
r.put('/tasks/:id', async (req, res) => { const k = await K.kindOfTask(req.company.id, Number(req.params.id)); await K.update(req.company.id, Number(req.params.id), req.body || {}); res.json(await tasksOut(req, k)); });
r.post('/tasks/:id/progress', async (req, res) => { const k = await K.kindOfTask(req.company.id, Number(req.params.id)); await K.progress(req.company.id, Number(req.params.id), { boss: req.owner.name || 'Boss' }, req.body || {}); res.json(await tasksOut(req, k)); });
r.post('/tasks/:id/arrived', async (req, res) => { await K.arrived(req.company.id, Number(req.params.id), null, req.body || {}); res.json({ ...(await tasksOut(req, 'order')), spending: await K.spending(req.company.id, req.company.timezone) }); });
r.get('/orders/spending', async (req, res) => res.json(await K.spending(req.company.id, req.company.timezone)));
r.delete('/tasks/updates/:id', async (req, res) => { const k = await K.kindOfUpdate(req.company.id, Number(req.params.id)); await K.removeProgress(req.company.id, Number(req.params.id)); res.json(await tasksOut(req, k)); });
r.delete('/tasks/:id', async (req, res) => { const k = await K.kindOfTask(req.company.id, Number(req.params.id)); await K.remove(req.company.id, Number(req.params.id)); res.json(await tasksOut(req, k)); });
/* --------------------------------- roads ----------------------------------- */
const RD = require('../roads');
// kind=road (Roads mowed) or kind=water (water system sites).
r.get('/roads', async (req, res) => res.json({ roads: await RD.list(req.company.id, req.query.kind) }));
r.put('/roads', async (req, res) => { const b = req.body || {}; await RD.setList(req.company.id, b.names, b.kind); res.json({ roads: await RD.list(req.company.id, b.kind) }); });
r.put('/roads/:id/readings', async (req, res) => {
  await RD.setReadingIds(req.company.id, Number(req.params.id), (req.body || {}).ids);
  const road = await RD.history(req.company.id, Number(req.params.id), 200);
  res.json({ road, roads: await RD.list(req.company.id, road.kind) });
});
r.put('/roads/:id/info', async (req, res) => {
  await RD.setInfo(req.company.id, Number(req.params.id), req.body || {});
  const road = await RD.history(req.company.id, Number(req.params.id), 200);
  res.json({ road, roads: await RD.list(req.company.id, road.kind) });
});
r.get('/roads/:id', async (req, res) => res.json({ road: await RD.history(req.company.id, Number(req.params.id), 200) }));
r.delete('/mows/:id', async (req, res) => {
  const roadId = await RD.removeMow(req.company.id, Number(req.params.id));
  const road = await RD.history(req.company.id, roadId, 200);
  res.json({ road, roads: await RD.list(req.company.id, road.kind) });
});

/* --------------------------------- meters ----------------------------------- */
const MT = require('../meters');
r.get('/meters', async (req, res) => res.json(await MT.route(req.company, req.query.quarter, { all: req.query.all === '1' })));
r.post('/meters/import', async (req, res) => res.json(await MT.replaceAll(req.company.id, (req.body || {}).meters)));
r.post('/meters', async (req, res) => { const id = await MT.add(req.company.id, req.body || {}); res.json({ id, ...(await MT.route(req.company, (req.body || {}).quarter, { all: true })) }); });
r.get('/meters/not-on-route', async (req, res) => res.json({ properties: await MT.notOnRoute(req.company.id) }));
r.post('/meters/skip', async (req, res) => { const b = req.body || {}; await MT.skip(req.company.id, b.address, b.skip !== false); res.json({ properties: await MT.notOnRoute(req.company.id) }); });
r.post('/meters/import-xlsx', async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Pick the Excel file first.' });
  res.json(await MT.importExcel(req.company, req.body));
});
r.put('/meters/:id', async (req, res) => { await MT.update(req.company.id, Number(req.params.id), req.body || {}); res.json(await MT.route(req.company, (req.body || {}).quarter, { all: true })); });
r.post('/meters/:id/read', async (req, res) => { await MT.read(req.company, null, Number(req.params.id), req.body || {}); res.json({ ok: true }); });
r.post('/meters/:id/not-a-leak', async (req, res) => { const b = req.body || {}; await MT.flagOk(req.company, Number(req.params.id), b.quarter, b.ok !== false); res.json(await MT.route(req.company, b.quarter, { all: true })); });
const BL = require('../billing');
r.get('/billing', async (req, res) => { const b = await BL.invoices(req.company, req.query.quarter); res.json({ ...b, invoices: b.invoices.slice(0, 20), count: b.invoices.length }); });
r.put('/billing', async (req, res) => { await BL.save(req.company.id, req.body || {}); const b = await BL.invoices(req.company, (req.body || {}).quarter); res.json({ ...b, invoices: b.invoices.slice(0, 20), count: b.invoices.length }); });
r.get('/billing.csv', async (req, res) => {
  const f = await BL.csv(req.company, req.query.quarter, req.query.part);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store' }).send(f.body);
});
r.get('/meters.csv', async (req, res) => {
  const rt = await MT.route(req.company, req.query.quarter);
  const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const lines = [['Read sequence', 'Act #', 'Customer name', 'QuickBooks customer', 'Service address', 'Meter ID', 'Last reading', 'Current reading', 'Usage', 'Read by', 'Notes'].map(q).join(',')];
  rt.meters.forEach(m => lines.push([m.seq, m.account, m.name, m.qbCustomer, m.address, m.meterNo, m.previous, m.cantRead ? "Can't read" : m.current, m.usage, m.readBy, [m.notes, m.readNotes].filter(Boolean).join(' · ')].map(q).join(',')));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="meter-readings-${rt.quarter}.csv"` }).send('\ufeff' + lines.join('\r\n'));
});

/* ------------------------------ address jobs -------------------------------- */
const J = require('../jobs');
r.get('/jobs', async (req, res) => res.json(await J.forOwner(req.company.id, req.query)));
r.get('/jobs/addresses', async (req, res) => res.json({ addresses: await J.addresses(req.company.id) }));
r.post('/jobs', async (req, res) => { await J.create(req.company, null, req.body || {}); res.json(await J.forOwner(req.company.id, req.body || {})); });
r.put('/jobs/:id', async (req, res) => { await J.update(req.company, null, Number(req.params.id), req.body || {}); res.json(await J.forOwner(req.company.id, req.body || {})); });
r.delete('/jobs/:id', async (req, res) => { await J.remove(req.company.id, Number(req.params.id)); res.json(await J.forOwner(req.company.id, req.query)); });
r.delete('/receipts/:id', async (req, res) => { await J.removeReceipt(req.company.id, Number(req.params.id)); res.json(await J.forOwner(req.company.id, req.query)); });
r.get('/receipts/:id', async (req, res) => {
  const p = await J.receipt(req.company.id, Number(req.params.id));
  p ? res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }).send(p.data) : res.status(404).end();
});
const JB = require('../jobbilling');
const jbOut = async (req, m, crew) => { const b = await JB.month(req.company, m, crew); return b; };
r.get('/jobs/month', async (req, res) => res.json(await jbOut(req, req.query.month, req.query.crew)));
r.put('/job-billing', async (req, res) => { await JB.save(req.company.id, req.body || {}); res.json(await jbOut(req, (req.body || {}).month, (req.body || {}).crew)); });
r.get('/jobs/month.csv', async (req, res) => {
  const f = JB.breakdownCsv(await jbOut(req, req.query.month, req.query.crew));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store' }).send(f.body);
});
r.get('/jobs/invoices.csv', async (req, res) => {
  const f = await JB.invoicesCsv(req.company, await jbOut(req, req.query.month, req.query.crew), req.query.part);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.name}"`, 'Cache-Control': 'no-store' }).send(f.body);
});
const JI = require('../jobinvoices');
r.get('/job-invoices', async (req, res) => res.json({ ...(await JI.list(req.company, req.query.month)), mailbox: require('../email').invoiceMailbox() }));
r.post('/job-invoices/build', async (req, res) => res.json(await JI.build(req.company, (req.body || {}).month)));
r.put('/job-invoices/:id', async (req, res) => { await JI.edit(req.company.id, Number(req.params.id), req.body || {}); res.json(await JI.list(req.company, (req.body || {}).month)); });
r.post('/job-invoices/:id/send', async (req, res) => { await JI.approveSend(req.company, Number(req.params.id), req.owner.name || req.owner.email, (req.body || {}).email); res.json(await JI.list(req.company, (req.body || {}).month)); });
r.post('/job-invoices/:id/void', async (req, res) => { await JI.voidInvoice(req.company.id, Number(req.params.id), !!(req.body || {}).undo); res.json(await JI.list(req.company, (req.body || {}).month)); });
r.get('/job-invoices/:id/view', async (req, res) => {
  const inv = await JI.getFull(req.company.id, Number(req.params.id));
  if (!inv) return res.status(404).send('Not found');
  res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ' + inv.number + '</title><body style="margin:0;background:#fff">' + JI.invoiceHtml(inv, ...(s => [s.payTo, s.fromEmail || inv.crew_email])(await require('../jobbilling').settings(req.company.id))));
});
r.post('/jobs/month/email', async (req, res) => {
  if (A.limited('jobmail:' + req.company.id, 10, 60 * 60e3)) return res.status(429).json({ error: 'Too many emails. Try again in an hour.' });
  A.fail('jobmail:' + req.company.id, 60 * 60e3);
  const e = await JI.sendMonthly(req.company, (req.body || {}).month);
  if (!e) V.bad('No invoices to make that month. Check the rates and that there are address jobs.');
  res.json({ ok: true, to: await R.recipients(req.company) });
});
r.get('/jobs.csv', async (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="address-jobs-${(req.query.from || 'this-month')}.csv"`, 'Cache-Control': 'no-store' })
    .send(J.csv(await J.forOwner(req.company.id, req.query)));
});

/* ------------------------------- weather reminders ------------------------------- */
const WX = require('../weather');
r.get('/weather', async (req, res) => res.json(await WX.status(req.company)));
r.put('/weather/location', async (req, res) => { await WX.setLocation(req.company, req.body || {}); res.json(await WX.status(req.company)); });
r.post('/weather/rules', async (req, res) => { await WX.saveRule(req.company.id, null, req.body || {}); res.json(await WX.status(req.company)); });
r.put('/weather/rules/:id', async (req, res) => { await WX.saveRule(req.company.id, Number(req.params.id), req.body || {}); res.json(await WX.status(req.company)); });
r.delete('/weather/rules/:id', async (req, res) => { await WX.removeRule(req.company.id, Number(req.params.id)); res.json(await WX.status(req.company)); });
r.get('/weather/forecast', async (req, res) => {
  try { res.json(await WX.preview(req.company)); } catch (e) { if (e instanceof T.InputError) throw e; V.bad("Couldn't get the forecast right now: " + e.message); }
});
r.post('/weather/run', async (req, res) => {   // check now and act (same as the 6 AM / 3 PM check)
  if (A.limited('wxrun:' + req.company.id, 10, 60 * 60e3)) return res.status(429).json({ error: 'Too many checks. Try again in an hour.' });
  A.fail('wxrun:' + req.company.id, 60 * 60e3);
  try { res.json({ fired: await WX.run(req.company), ...(await WX.status(req.company)) }); } catch (e) { if (e instanceof T.InputError) throw e; V.bad("Couldn't get the forecast right now: " + e.message); }
});

/* ------------------------------- QuickBooks Online ------------------------------- */
const QB = require('../qbo');
r.get('/quickbooks', async (req, res) => res.json(await QB.status(req.company.id)));
r.get('/quickbooks/connect', async (req, res) => {
  if (!QB.enabled()) return res.redirect('/admin#portal');
  res.redirect(QB.authUrl(req.company.id));
});
r.get('/quickbooks/callback', async (req, res) => {
  if (req.query.error) return res.redirect('/admin#qbo-error=' + encodeURIComponent(req.query.error === 'access_denied' ? 'You cancelled the QuickBooks sign-in.' : String(req.query.error)));
  try {
    await QB.finishConnect(req.company.id, String(req.query.code || ''), String(req.query.realmId || ''), String(req.query.state || ''));
    await QB.sync(req.company.id).catch(e => console.error('[qbo] first sync', e.message));
    res.redirect('/admin#qbo-ok');
  } catch (e) { res.redirect('/admin#qbo-error=' + encodeURIComponent(e.message)); }
});
r.post('/quickbooks/sync', async (req, res) => {
  try { res.json(await QB.sync(req.company.id)); } catch (e) { V.bad(e.message); }
});
r.put('/quickbooks/link', async (req, res) => { const b = req.body || {}; await QB.link(req.company.id, Number(b.meterId), b.qboId || null); res.json(await QB.status(req.company.id)); });
r.post('/quickbooks/disconnect', async (req, res) => { await QB.disconnect(req.company.id); res.json(await QB.status(req.company.id)); });

/* ------------------------------- owner portal ------------------------------- */
const PO = require('../portal');
r.get('/portal', async (req, res) => res.json(await PO.adminView(req.company)));
r.put('/portal', async (req, res) => {
  await db.q('UPDATE companies SET portal_on=$1 WHERE id=$2', [!!(req.body || {}).on, req.company.id]);
  req.company.portal_on = !!(req.body || {}).on;
  res.json(await PO.adminView(req.company));
});
r.post('/portal/requests/:id', async (req, res) => { await PO.decide(req.company, Number(req.params.id), !!(req.body || {}).approve); res.json(await PO.adminView(req.company)); });
r.delete('/portal/users/:id', async (req, res) => { await PO.removeAccess(req.company.id, Number(req.params.id), Number(req.query.meter) || null); res.json(await PO.adminView(req.company)); });
r.post('/portal/notices', async (req, res) => { await PO.saveNotice(req.company, null, req.body || {}); res.json(await PO.adminView(req.company)); });
r.put('/portal/notices/:id', async (req, res) => { await PO.saveNotice(req.company, Number(req.params.id), req.body || {}); res.json(await PO.adminView(req.company)); });
r.delete('/portal/notices/:id', async (req, res) => { await PO.removeNotice(req.company.id, Number(req.params.id)); res.json(await PO.adminView(req.company)); });
r.post('/portal/docs', async (req, res) => { await PO.addDoc(req.company, req.body, req.query); res.json(await PO.adminView(req.company)); });
r.delete('/portal/docs/:id', async (req, res) => { await PO.removeDoc(req.company.id, Number(req.params.id)); res.json(await PO.adminView(req.company)); });
r.get('/portal/docs/:id', async (req, res) => {
  const d = await PO.docForBoss(req.company.id, Number(req.params.id));
  d ? res.set({ 'Content-Type': d.mime, 'Cache-Control': 'private, max-age=600' }).send(d.data) : res.status(404).end();
});
// Send a sign-in link to an owner by hand (e.g. someone who called the office): email + one of the route addresses.
r.post('/portal/invite', async (req, res) => {
  const b = req.body || {};
  const m = await db.one('SELECT id FROM meters WHERE id=$1 AND company_id=$2 AND active', [Number(b.meterId), req.company.id]);
  if (!m) V.bad('Pick an address on the route.');
  const email = V.email(b.email);
  await db.q(`INSERT INTO portal_users (company_id, email, name) VALUES ($1,$2,$3) ON CONFLICT (company_id, email) DO NOTHING`, [req.company.id, email, String(b.name || '').trim().slice(0, 120)]);
  await PO.sendInvite(req.company, email, m.id);
  res.json(await PO.adminView(req.company));
});

/* -------------------------------- members ----------------------------------- */
const MB = require('../members');
r.get('/members', async (req, res) => res.json(await MB.search(req.company.id, req.query)));
r.post('/members/import', async (req, res) => res.json(await MB.replaceAll(req.company.id, req.body || {})));
r.post('/members', async (req, res) => res.json({ id: await MB.save(req.company.id, null, (req.body || {}).data) }));
r.put('/members/:id', async (req, res) => res.json({ id: await MB.save(req.company.id, Number(req.params.id), (req.body || {}).data) }));
r.delete('/members/:id', async (req, res) => { await MB.remove(req.company.id, Number(req.params.id)); res.json({ ok: true }); });
r.get('/members.csv', async (req, res) => {
  const cols = await MB.columns(req.company.id), rows = await MB.all(req.company.id);
  const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const lines = [cols.map(q).join(',')].concat(rows.map(r => cols.map(c => q(r.data[c])).join(',')));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="members.csv"', 'Cache-Control': 'no-store' }).send('\ufeff' + lines.join('\r\n'));
});

/* -------------------------------- readings ---------------------------------- */
const RG = require('../readings');
const readingsOut = async req => ({ types: await RG.types(req.company.id), readings: await RG.recent(req.company.id, Number(req.query.days) || 60, 1000) });
r.get('/readings', async (req, res) => res.json(await readingsOut(req)));
r.put('/reading-types', async (req, res) => { await RG.setTypes(req.company.id, (req.body || {}).lines); res.json(await readingsOut(req)); });
r.delete('/readings/:id', async (req, res) => { await RG.remove(req.company.id, Number(req.params.id)); res.json(await readingsOut(req)); });
r.get('/readings.csv', async (req, res) => {
  const types = await RG.types(req.company.id), rows = await RG.recent(req.company.id, Number(req.query.days) || 365, 100000);
  const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const tz = req.company.timezone;
  const when = d => new Date(d).toLocaleString('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = [['Date and time', 'Site', 'By', ...types.map(t => t.name + (t.unit ? ' (' + t.unit + ')' : '')), 'Notes'].map(q).join(',')];
  rows.slice().reverse().forEach(r => lines.push([when(r.takenAt), r.siteName || '', r.byName || '', ...types.map(t => r.vals[t.id] != null ? r.vals[t.id] : ''), r.notes].map(q).join(',')));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="water-readings.csv"' }).send(lines.join('\r\n'));
});
r.get('/road-photo/:id', async (req, res) => {
  const p = await RD.photo(req.company.id, Number(req.params.id));
  if (!p) return res.status(404).end();
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }).send(p.data);
});

r.get('/day-photo/:id', async (req, res) => {
  const p = await H.dayPhoto(req.company.id, Number(req.params.id));
  if (!p) return res.status(404).end();
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }).send(p.data);
});
r.get('/tasks/photo/:id', async (req, res) => {
  const p = await K.photo(req.company.id, Number(req.params.id));
  if (!p) return res.status(404).end();
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }).send(p.data);
});

/* ------------------------------- board report ------------------------------- */
const BR = require('../board');
const brRange = (req, q) => {
  if (q.from && q.to) return { from: String(q.from), to: String(q.to) };
  return BR.period(req.company, q.kind === 'month' ? 'month' : 'week', String(q.start || ''));
};
r.get('/board', async (req, res) => { const p = brRange(req, req.query); res.json({ kind: p.kind || 'custom', ...(await BR.get(req.company, p.from, p.to)) }); });
r.put('/board', async (req, res) => { const b = req.body || {}; const out = await BR.save(req.company, String(b.from || ''), String(b.to || ''), b); BR.forget(); res.json(out); });
r.post('/board/link', async (req, res) => { const b = req.body || {}; BR.forget(); res.json(await BR.newLink(req.company, String(b.from || ''), String(b.to || ''))); });
r.post('/board/email', async (req, res) => {
  if (A.limited('board:' + req.company.id, 20, 60 * 60e3)) return res.status(429).json({ error: 'Too many emails. Try again in an hour.' });
  A.fail('board:' + req.company.id, 60 * 60e3);
  const b = req.body || {}; res.json(await BR.email(req.company, String(b.from || ''), String(b.to || ''), { to: b.emails }));
});
r.get('/board/photo/:key', async (req, res) => {
  const p = await BR.photo(req.company.id, req.params.key);
  if (!p) return res.status(404).end();
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }).send(p.data);
});

/* --------------------------------- import ---------------------------------- */
// Bring in crew, settings and past hours from another system (e.g. the old Google Sheet).
// Safe to run twice: existing crew (same name) and days already logged are left alone.
r.post('/import', async (req, res) => {
  const b = req.body || {}, c = req.company;
  if (b.format === 'crewhours-meters-1') {
    const m = await require('../meters').replaceAll(c.id, b.meters);
    return res.json({ meters: m.meters, crewAdded: 0, crewSkipped: [], daysAdded: 0, daysSkipped: 0, roadsAdded: 0, roadsUpdated: 0, problems: [] });
  }
  if (b.format === 'crewhours-members-1') {   // the members list file, uploaded in Settings instead of the Members tab
    const m = await require('../members').replaceAll(c.id, b);
    return res.json({ members: m.rows, crewAdded: 0, crewSkipped: [], daysAdded: 0, daysSkipped: 0, roadsAdded: 0, roadsUpdated: 0, problems: [] });
  }
  if (b.format !== 'crewhours-import-1') V.bad("That file isn't a Crew Hours import file. If it's a spreadsheet, save it as CSV and use the Members tab's import box.");
  const crewIn = Array.isArray(b.crew) ? b.crew : [], entriesIn = Array.isArray(b.entries) ? b.entries : [];
  const roadsIn = Array.isArray(b.roads) ? b.roads : [];
  if (roadsIn.length > 500) V.bad('Up to 500 roads.');
  if (crewIn.length > 300 || entriesIn.length > 20000) V.bad('That file is too big to import at once.');
  const s = b.settings || {};
  const result = { crewAdded: 0, crewSkipped: [], daysAdded: 0, daysSkipped: 0, roadsAdded: 0, roadsUpdated: 0, problems: [] };
  await db.tx(async t => {
    if (roadsIn.length) { const rr = await require('../roads').importRoads(c.id, roadsIn, t); result.roadsAdded = rr.added; result.roadsUpdated = rr.updated; }
    if (s.weekStart !== undefined || s.mainLabel || s.otherOptions) {
      const opts = Array.isArray(s.otherOptions) ? s.otherOptions.map(x => V.str(x, 'an option', 1, 60)).slice(0, 25) : c.other_options;
      await t.q('UPDATE companies SET week_start=$1, main_label=$2, other_label=$3, other_options=$4, other_enabled=TRUE, overtime_after=$5 WHERE id=$6',
        [s.weekStart !== undefined ? V.int(s.weekStart, 'Week start', 0, 6) : c.week_start,
         s.mainLabel ? V.str(s.mainLabel, 'a tab name', 1, 30) : c.main_label,
         s.otherLabel ? V.str(s.otherLabel, 'a tab name', 1, 30) : c.other_label,
         JSON.stringify(opts), s.overtimeAfter !== undefined ? V.num(s.overtimeAfter, 'Overtime after', 0, 168) : c.overtime_after, c.id]);
    }
    const existing = await t.q('SELECT id, name, active FROM crew WHERE company_id=$1', [c.id]);
    const byName = new Map(existing.map(x => [x.name.trim().toLowerCase(), x]));
    let active = existing.filter(x => x.active).length;
    const limit = P.crewLimit(c);
    for (const p of crewIn) {
      const name = V.str(p.name, 'a name', 1, 60), key = name.toLowerCase();
      if (byName.has(key)) { result.crewSkipped.push(name + ' (already here)'); continue; }
      const pin = V.pin(p.pin), on = p.active !== false;
      if (await t.one('SELECT 1 FROM crew WHERE company_id=$1 AND pin_hmac=$2', [c.id, A.pinHmac(c.id, pin)])) { result.crewSkipped.push(name + ' (PIN already used)'); continue; }
      if (on && active >= limit) V.bad(`That would be more than the ${limit} active crew your plan covers. Switch to Pro first.`);
      const row = await t.one('INSERT INTO crew (company_id, name, pin_hmac, active, is_manager) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, active',
        [c.id, name, A.pinHmac(c.id, pin), on, !!p.manager]);
      byName.set(key, row); if (on) active++; result.crewAdded++;
    }
    const mainLabel = s.mainLabel || c.main_label, otherLabel = s.otherLabel || c.other_label;
    for (const e of entriesIn) {
      const who = byName.get(String(e.name || '').trim().toLowerCase());
      if (!who) { result.problems.push(`${e.name} on ${e.date}: no crew member with that name`); continue; }
      if (!T.isDate(e.date)) { result.problems.push(`${e.name}: bad date ${e.date}`); continue; }
      try {
        const w = T.timeBlock({ start: e.start, end: e.end, out: e.out, back: e.back }, mainLabel) || {};
        const o = T.timeBlock({ start: e.oStart, end: e.oEnd, out: e.oOut, back: e.oBack }, otherLabel) || {};
        const clean = (v, n) => String(v || '').slice(0, n || 2000);
        const ins = await t.q(`INSERT INTO entries (company_id, crew_id, day, start_t, end_t, out_t, back_t, summary, o_job, o_start, o_end, o_out, o_back, o_summary, hours, o_hours, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, COALESCE($17::timestamptz, now())) ON CONFLICT (crew_id, day) DO NOTHING RETURNING id`,
          [c.id, who.id, e.date, w.start || '', w.end || '', w.out || '', w.back || '', clean(e.summary), clean(o.start ? e.oJob : '', 100),
           o.start || '', o.end || '', o.out || '', o.back || '', clean(e.oSummary), w.hours || 0, o.hours || 0, e.updated || null]);
        if (ins.length) result.daysAdded++; else result.daysSkipped++;
      } catch (err) {
        if (!(err instanceof T.InputError)) throw err;
        result.problems.push(`${e.name} on ${e.date}: ${err.message}`);
      }
    }
  });
  res.json(result);
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
