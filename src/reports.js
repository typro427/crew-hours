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

/** Summary of one week: table of hours, things that need attention, what everyone did. */
async function weeklySummary(company, weekStart, { final = true } = {}) {
  const w = await H.crewWeek(company, weekStart);
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

async function sendWeekly(company, weekStart, opts) { const r = await weeklySummary(company, weekStart, opts); await send({ to: await recipients(company), ...r }); return r; }
async function sendMissing(company) { const r = await missingHours(company); await send({ to: await recipients(company), subject: r.subject, html: r.html }); return r; }

module.exports = { weeklySummary, missingHours, sendWeekly, sendMissing, recipients };
