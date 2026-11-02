// The weekly summary email and the missing-hours email, for one company.
const db = require('./db');
const T = require('./time');
const H = require('./hours');
const config = require('./config');
const { send, esc, layout } = require('./email');

async function recipients(company) {
  if (company.report_emails && company.report_emails.trim()) return company.report_emails;
  const owners = await db.q('SELECT email FROM owners WHERE company_id=$1', [company.id]);
  return owners.map(o => o.email);
}

function blockLine(label, start, end, out, back, note, hours) {
  const span = end ? `${T.clock(start)}–${T.clock(end)}` : `started ${T.clock(start)}, <b>no end time</b>`;
  const away = out ? (back ? ` (out ${T.clock(out)}–${T.clock(back)})` : ` (clocked out ${T.clock(out)})`) : '';
  return `${esc(label)}: ${span}${away}${end ? ', ' + hours.toFixed(2) + ' h' : ''}${note ? ' · ' + esc(note) : ''}`;
}

/** The rest of the week: roads, water system, leaks, orders, address jobs. Only the parts this company uses. */
async function operations(company, from, to) {
  const tz = company.timezone || 'America/New_York', id = company.id;
  const inWeek = col => `(${col} AT TIME ZONE $2)::date BETWEEN $3 AND $4`;
  const a = [id, tz, from, to];
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const out = [];
  const roads = await db.one(`SELECT (SELECT count(*)::int FROM roads WHERE company_id=$1 AND kind='road' AND active) AS total,
      (SELECT count(DISTINCT m.road_id)::int FROM road_mows m JOIN roads r ON r.id=m.road_id WHERE m.company_id=$1 AND r.kind='road' AND m.day BETWEEN $2 AND $3) AS mowed,
      (SELECT string_agg(DISTINCT r.name, ', ') FROM road_mows m JOIN roads r ON r.id=m.road_id WHERE m.company_id=$1 AND r.kind='road' AND m.day BETWEEN $2 AND $3) AS names,
      (SELECT count(*)::int FROM roads r WHERE r.company_id=$1 AND r.kind='road' AND r.active AND NOT EXISTS (SELECT 1 FROM road_mows m WHERE m.road_id=r.id AND m.day > $3::date - 30)) AS stale,
      (SELECT count(*)::int FROM road_mows m JOIN roads r ON r.id=m.road_id WHERE m.company_id=$1 AND r.kind='water' AND m.day BETWEEN $2 AND $3) AS checks,
      (SELECT count(*)::int FROM roads WHERE company_id=$1 AND kind='water' AND active) AS sites`, [id, from, to]);
  if (roads.total) out.push(`<li><b>Roads mowed:</b> ${roads.mowed} of ${roads.total}${roads.names ? ' (' + esc(roads.names) + ')' : ''}${roads.stale ? ` · ${roads.stale} not mowed in 30+ days` : ''}</li>`);
  if (roads.sites) out.push(`<li><b>Water sites checked:</b> ${roads.checks} check${roads.checks === 1 ? '' : 's'}</li>`);
  const lk = await db.one(`SELECT count(*) FILTER (WHERE ${inWeek('created_at')})::int AS opened, count(*) FILTER (WHERE status='done' AND ${inWeek('done_at')})::int AS fixed,
      count(*) FILTER (WHERE status='open')::int AS open FROM tasks WHERE company_id=$1 AND kind='repair'`, a);
  if (lk.opened || lk.fixed || lk.open) out.push(`<li><b>Leaks &amp; repairs:</b> ${lk.opened} reported, ${lk.fixed} fixed this week · ${lk.open} still open</li>`);
  const meters = (await db.one('SELECT count(*)::int AS n FROM meters WHERE company_id=$1 AND active', [id])).n;
  if (meters) {
    const rt = await require('./meters').route(company);
    const high = rt.meters.filter(m => m.active && m.alert && m.alert.level === 'high');
    out.push(`<li><b>Meters (${esc(rt.label)}):</b> ${rt.read} of ${rt.toRead} read${high.length ? ` · <b style="color:#b42318">${high.length} high use (possible leak)</b>: ` +
      high.slice(0, 5).map(m => esc(m.address || m.name) + (m.alert.times ? ` (${m.alert.times}×)` : '')).join(', ') + (high.length > 5 ? ', …' : '') : ''}</li>`);
  }
  const od = await db.one(`SELECT count(*) FILTER (WHERE status='open')::int AS open, COALESCE(sum(cost) FILTER (WHERE status='open'),0)::float AS est,
      count(*) FILTER (WHERE status='done' AND arrived_at IS NULL)::int AS waiting,
      count(*) FILTER (WHERE ${inWeek('arrived_at')})::int AS arrived, COALESCE(sum(actual_cost) FILTER (WHERE ${inWeek('arrived_at')}),0)::float AS spent
    FROM tasks WHERE company_id=$1 AND kind='order'`, a);
  if (od.open || od.waiting || od.arrived) out.push(`<li><b>Needs to order:</b> ${od.open} to order${od.est ? ' (about ' + money(od.est) + ')' : ''} · ${od.waiting} ordered, waiting to arrive${od.arrived ? ` · ${od.arrived} arrived this week, ${money(od.spent)} spent` : ''}</li>`);
  const jb = await db.q(`SELECT c.name, count(*)::int AS n, COALESCE(sum(j.chem_cost),0)::float AS chem, COALESCE(sum(j.material_cost),0)::float AS mat
    FROM jobs j LEFT JOIN crew c ON c.id=j.crew_id WHERE j.company_id=$1 AND j.day BETWEEN $2 AND $3 GROUP BY c.name ORDER BY c.name`, [id, from, to]);
  jb.forEach(j => out.push(`<li><b>Address jobs${j.name ? ' (' + esc(j.name) + ')' : ''}:</b> ${j.n} job${j.n === 1 ? '' : 's'} · chemicals ${money(j.chem)} · materials ${money(j.mat)}</li>`));
  return out.length ? `<h3 style="margin:20px 0 6px">This week at a glance</h3><ul style="margin:0;padding-left:18px">${out.join('')}</ul>` : '';
}

/** Summary of one week: table of hours, things that need attention, what everyone did. */
async function weeklySummary(company, weekStart, { final = true } = {}) {
  const w = await H.crewWeek(company, weekStart);
  // people with the time sheet switched off (e.g. address jobs only) aren't in the hours table
  const noSheet = new Set((await db.q("SELECT name FROM crew WHERE company_id=$1 AND features->>'hours' = 'false'", [company.id])).map(r => r.name));
  w.people = w.people.filter(p => !noSheet.has(p.name) || p.total > 0);
  const range = `${T.pretty(w.dates[0])} – ${T.pretty(w.dates[6])}`;
  const attention = [];
  w.people.forEach(p => {
    const logged = Object.keys(p.days).length;
    if (!logged) attention.push(`${p.name}: no hours logged`);
    if (p.ot > 0) attention.push(`${p.name}: ${p.ot.toFixed(2)} h overtime`);
    w.dates.forEach(d => { const e = p.days[d]; if (e && (e.open || e.oOpen)) attention.push(`${p.name}: ${T.dayName(d)} ${T.pretty(d)} has no end time (not counted)`); });
  });
  const th = 'padding:6px 8px;border-bottom:2px solid #333;text-align:right;font-size:12px;text-transform:uppercase';
  const td = 'padding:6px 8px;border-bottom:1px solid #ddd;text-align:right;font-family:Menlo,Consolas,monospace';
  let html = `<p style="margin:0 0 14px;color:#555"><b>${w.grand.toFixed(2)} hours</b> total · ${w.people.filter(p => p.total > 0).length} of ${w.people.length} people logged time</p>
  <div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:14px"><tr><th style="${th};text-align:left">Name</th>`
    + w.dates.map(d => `<th style="${th}">${T.dayName(d)} ${Number(d.slice(8))}</th>`).join('') + `<th style="${th}">Total</th></tr>`;
  w.people.forEach(p => {
    html += `<tr><td style="${td};text-align:left;font-family:Arial,sans-serif">${esc(p.name)}${p.ot > 0 ? ' <span style="background:#b4540a;color:#fff;border-radius:9px;padding:1px 6px;font-size:11px">OT</span>' : ''}</td>`
      + w.dates.map(d => { const h = p.days[d] ? p.days[d].total : 0; return `<td style="${td}${h ? '' : ';color:#bbb'}">${h ? h.toFixed(2) : '–'}</td>`; }).join('')
      + `<td style="${td};font-weight:bold">${p.total.toFixed(2)}</td></tr>`;
  });
  html += '</table></div>';
  html += await operations(company, w.dates[0], w.dates[6]);
  if (attention.length) html += `<h3 style="margin:20px 0 6px">Needs attention</h3><ul style="margin:0;padding-left:18px">${attention.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`;
  html += '<h3 style="margin:20px 0 6px">What everyone did</h3>';
  w.people.forEach(p => {
    const ds = w.dates.filter(d => p.days[d]);
    if (!ds.length) return;
    html += `<p style="margin:12px 0 4px"><b>${esc(p.name)}</b> · ${p.total.toFixed(2)} h</p><ul style="margin:0;padding-left:18px">`;
    ds.forEach(d => {
      const e = p.days[d], lines = [];
      if (e.start) lines.push(blockLine(company.main_label, e.start, e.end, e.outT, e.inT, e.summary, e.hours));
      if (e.oStart) lines.push(blockLine(company.other_label + (e.oJob ? ' (' + e.oJob + ')' : ''), e.oStart, e.oEnd, e.oOutT, e.oInT, e.oSummary, e.oHours));
      html += `<li><b>${T.dayName(d)} ${T.pretty(d)}</b> (${e.total.toFixed(2)} h)<br>${lines.join('<br>')}</li>`;
    });
    html += '</ul>';
  });
  if (final) html += `<p style="margin-top:18px"><b>${w.approved ? 'This week is approved and locked.' : 'To lock this week so nobody can change it, open your dashboard and tap Approve week.'}</b></p>`;
  html += `<p><a href="${config.appUrl}/admin#week=${w.weekStart}">Open this week in your dashboard</a></p>`;
  return { subject: `Crew hours: ${range} (${w.grand.toFixed(2)} h)`, html: layout(`Crew hours: ${range}`, html) };
}

/** Who hasn't logged which workdays this week so far. Managers are left out. */
async function missingHours(company) {
  const t = H.today(company), ws = H.weekOf(company, t), dates = T.weekDates(ws);
  const workdays = company.workdays || [1, 2, 3, 4, 5];
  const due = dates.filter(d => d <= t && workdays.indexOf(T.dow(d)) !== -1);
  const crew = await db.q('SELECT id, name FROM crew WHERE company_id=$1 AND active AND NOT is_manager ORDER BY lower(name)', [company.id]);
  const rows = await db.q("SELECT crew_id, day FROM entries WHERE company_id=$1 AND day BETWEEN $2 AND $3 AND (start_t<>'' OR o_start<>'')", [company.id, ws, dates[6]]);
  const have = new Set(rows.map(r => r.crew_id + '|' + r.day));
  const missing = crew.map(c => ({ name: c.name, gaps: due.filter(d => !have.has(c.id + '|' + d)) })).filter(m => m.gaps.length);
  const range = `${T.pretty(dates[0])} – ${T.pretty(dates[6])}`;
  let html;
  if (!missing.length) html = `<p>Everyone has logged every workday so far (${due.map(T.dayName).join(', ') || 'none yet'}).</p>`;
  else html = `<p style="color:#555;margin:0 0 12px">${missing.length} of ${crew.length} people are missing days.</p><ul style="padding-left:18px">`
    + missing.map(m => `<li style="margin-bottom:6px"><b>${esc(m.name)}</b>: ${m.gaps.length === due.length ? 'nothing logged this week' : 'missing ' + m.gaps.map(d => T.dayName(d) + ' ' + T.pretty(d)).join(', ')}</li>`).join('') + '</ul>';
  html += `<p style="color:#777;font-size:12px">Checks ${workdays.map(i => T.DAY_NAMES[i]).join(', ')}. Managers are left out.</p>`;
  return { missing, subject: missing.length ? `Missing hours: ${missing.map(m => m.name).join(', ')}` : 'Hours check: everyone has logged',
           html: layout(`Hours check: ${range}`, html) };
}

/**
 * One crew member's own week: their time sheet (if they keep one) and their address jobs, with totals.
 * Sent to the email on their Crew & PINs entry.
 */
async function personalWeekly(company, person, weekStart) {
  const F = require('./features'), J = require('./jobs');
  const ws = H.weekOf(company, weekStart), dates = T.weekDates(ws);
  const range = `${T.pretty(dates[0])} – ${T.pretty(dates[6])}`;
  const td = 'padding:6px 8px;border-bottom:1px solid #ddd;font-size:14px;vertical-align:top';
  const th = 'padding:6px 8px;border-bottom:2px solid #333;font-size:12px;text-transform:uppercase;text-align:left';
  const money = n => n == null ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ampm = t => { if (!t) return ''; const h = Number(t.slice(0, 2)); return `${h % 12 || 12}:${t.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`; };
  let html = '', summary = [];
  if (F.can(person, 'hours')) {
    const w = await H.crewWeek(company, ws), me = w.people.find(p => p.id === person.id);
    const total = me ? me.total : 0;
    summary.push(`${total.toFixed(2)} h on the time sheet`);
    html += `<h3 style="margin:0 0 6px">Time sheet</h3>`;
    if (!me || !Object.keys(me.days).length) html += '<p style="color:#555">Nothing logged on the time sheet this week.</p>';
    else {
      html += `<table style="border-collapse:collapse"><tr><th style="${th}">Day</th><th style="${th}">Hours</th><th style="${th}">What you did</th></tr>`;
      dates.filter(d => me.days[d]).forEach(d => { const e = me.days[d];
        html += `<tr><td style="${td}">${T.dayName(d)} ${T.pretty(d)}</td><td style="${td};text-align:right">${e.total.toFixed(2)}</td><td style="${td}">${esc([e.summary, e.oSummary].filter(Boolean).join(' · '))}</td></tr>`; });
      html += `<tr><td style="${td};font-weight:bold">Total</td><td style="${td};text-align:right;font-weight:bold">${total.toFixed(2)}</td><td style="${td}"></td></tr></table>`;
    }
  }
  if (F.can(person, 'jobs')) {
    const { jobs, totals: t } = await J.forOwner(company.id, { from: dates[0], to: dates[6], crew: person.id });
    summary.push(`${t.jobs} address job${t.jobs === 1 ? '' : 's'}, ${t.hours} h on site`);
    html += `<h3 style="margin:${html ? '20px' : '0'} 0 6px">Address jobs</h3>`;
    if (!jobs.length) html += '<p style="color:#555">No address jobs logged this week.</p>';
    else {
      html += `<div style="overflow-x:auto"><table style="border-collapse:collapse"><tr>${['Date', 'Address', 'In', 'Out', 'Hours', 'Chemicals', 'Materials', 'Receipts'].map(x => `<th style="${th}">${x}</th>`).join('')}</tr>`;
      [...jobs].reverse().forEach(j => {
        html += `<tr><td style="${td}">${T.dayName(j.day)} ${T.pretty(j.day)}</td><td style="${td}">${esc(j.address)}${j.owner ? `<br><span style="color:#777">${esc(j.owner)}</span>` : ''}${j.notes ? `<br><span style="color:#555">${esc(j.notes)}</span>` : ''}</td>`
          + `<td style="${td}">${ampm(j.timeIn)}</td><td style="${td}">${j.timeIn && !j.timeOut ? '<b>no time out</b>' : ampm(j.timeOut)}</td><td style="${td};text-align:right">${j.hours == null ? '' : j.hours}</td>`
          + `<td style="${td};text-align:right">${money(j.chemCost)}</td><td style="${td};text-align:right">${money(j.materialCost)}</td><td style="${td};text-align:right">${j.receipts.length || ''}</td></tr>`;
      });
      html += `<tr><td style="${td};font-weight:bold" colspan="4">Total · ${t.jobs} job${t.jobs === 1 ? '' : 's'}</td><td style="${td};text-align:right;font-weight:bold">${t.hours}</td><td style="${td};text-align:right;font-weight:bold">${money(t.chemCost)}</td><td style="${td};text-align:right;font-weight:bold">${money(t.materialCost)}</td><td style="${td}"></td></tr></table></div>`;
      html += `<p style="margin:10px 0 0"><b>Chemicals + materials: ${money(t.total)}</b></p>`;
    }
  }
  if (!html) html = '<p>Nothing to report this week.</p>';
  html += `<p style="color:#777;font-size:12px;margin-top:18px">From ${esc(company.name)}'s Crew Hours. Something wrong? Fix it in the app this week, or tell the boss.</p>`;
  return { subject: `Your week: ${range} · ${summary.join(' · ') || 'nothing logged'}`, html: layout(`${esc(person.name)}: your week, ${range}`, html) };
}
async function sendPersonal(company, person, weekStart) {
  if (!person.email) return null;
  const r = await personalWeekly(company, person, weekStart);
  await send({ to: [person.email], ...r });
  return r;
}

async function sendWeekly(company, weekStart, opts) { const r = await weeklySummary(company, weekStart, opts); await send({ to: await recipients(company), ...r }); return r; }
async function sendMissing(company) { const r = await missingHours(company); await send({ to: await recipients(company), subject: r.subject, html: r.html }); return r; }

module.exports = { personalWeekly, sendPersonal, operations, weeklySummary, missingHours, sendWeekly, sendMissing, recipients };
