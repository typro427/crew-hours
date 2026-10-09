(function () {
  var $ = function (id) { return document.getElementById(id); };
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var me = null, week = null, weekStart = null, pick = null, crew = [], editing = null;

  function api(method, url, body) {
    var opts = { method: method, headers: { 'x-ch': '1' }, credentials: 'same-origin' };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) { location.href = '/login'; throw new Error('Please log in.'); }
      return r.json().catch(function () { return { error: 'Something went wrong. Try again.' }; });
    }).then(function (r) { if (r.error) throw new Error(r.error); return r; });
  }
  function status(id, msg, cls) { var s = $(id); s.textContent = msg || ''; s.className = 'status' + (cls ? ' ' + cls : ''); }
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  function toUTC(s) { var p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
  function shift(s, n) { var d = toUTC(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function short(s) { var d = toUTC(s); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function fmt(h) { return (Math.round((Number(h) || 0) * 100) / 100).toFixed(2); }
  function clock(t) { if (!t) return ''; var p = t.split(':').map(Number); return ((p[0] % 12) || 12) + ':' + pad2(p[1]) + (p[0] >= 12 ? ' PM' : ' AM'); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hourLabel(h) { return ((h % 12) || 12) + ':00 ' + (h >= 12 ? 'PM' : 'AM'); }

  /* ------------------------------- tabs ------------------------------- */
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === name); });
    document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
    if (name === 'crew') loadCrew();
    if (name === 'week') loadWeek(weekStart);
  }
  document.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { showTab(b.getAttribute('data-tab')); }; });
  document.querySelectorAll('[data-goto]').forEach(function (b) { b.onclick = function () { showTab(b.getAttribute('data-goto')); }; });
  $('logout').onclick = function () { api('POST', '/api/logout').then(function () { location.href = '/login'; }); };

  /* ------------------------------- me --------------------------------- */
  function loadMe() {
    return api('GET', '/api/admin/me').then(function (r) {
      me = r;
      $('co-name').textContent = r.settings.name; $('owner-email').textContent = r.owner.email;
      $('crew-link').textContent = r.crewLink; $('open-link').href = r.crewLink;
      drawPlan(); fillSettings();
    });
  }
  $('copy-link').onclick = function () {
    var t = $('crew-link').textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () {
      $('copy-link').textContent = 'Copied'; setTimeout(function () { $('copy-link').textContent = 'Copy link'; }, 1500);
    }).catch(function () { var r = document.createRange(); r.selectNodeContents($('crew-link')); var s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  };

  function drawPlan() {
    var b = me.billing, ban = $('plan-banner'); ban.innerHTML = ''; ban.className = 'notice'; ban.hidden = true;
    if (b.status === 'trialing' && b.ok) { ban.hidden = false; ban.appendChild(el('span', '', 'Free trial: ' + b.trialDaysLeft + ' day' + (b.trialDaysLeft === 1 ? '' : 's') + ' left.')); }
    if (!b.ok) { ban.hidden = false; ban.className = 'notice bad'; ban.appendChild(el('span', '', b.status === 'trialing' ? 'Your free trial has ended. Your crew can’t log time until you subscribe. Your data is safe.' : 'Your subscription isn’t active. Your crew can’t log time until it is. Your data is safe.')); }
    if (b.status === 'past_due') { ban.hidden = false; ban.className = 'notice bad'; ban.appendChild(el('span', '', 'Your last payment didn’t go through. Update your card to keep things running.')); }
    if (!ban.hidden) { var go = el('button', 'btn small', b.hasCustomer ? 'Billing' : 'Subscribe'); go.onclick = function () { showTab('billing'); }; ban.appendChild(go); }
    var line = $('b-line'), cur = b.plans.filter(function (p) { return p.key === b.tier; })[0];
    var stat = { trialing: 'Free trial' + (b.ok ? ' · ' + b.trialDaysLeft + ' days left' : ' · ended'), active: (cur ? cur.name + ' plan' : 'Active'), past_due: 'Payment problem', canceled: 'Canceled' }[b.status] || b.status;
    line.textContent = stat + '. ' + b.activeCrew + ' active crew' + (b.status === 'trialing' ? ' (up to 50 during the trial).' : ' of ' + b.crewLimit + ' allowed.');
    var box = $('b-plans'); box.innerHTML = '';
    var subscribed = b.hasSubscription && (b.status === 'active' || b.status === 'past_due');
    b.plans.forEach(function (p) {
      var isCur = subscribed && p.key === b.tier, card = el('div', 'plan' + (isCur ? ' current' : ''));
      card.appendChild(el('h3', '', p.name));
      var pp = el('div', 'pp', p.price); pp.appendChild(el('small', '', ' /month')); card.appendChild(pp);
      card.appendChild(el('p', 'muted', p.key === 'starter' ? 'Up to ' + p.maxCrew + ' active crew' : '21 to ' + p.maxCrew + ' active crew'));
      var fits = b.activeCrew <= p.maxCrew;
      var btn = el('button', isCur ? 'btn ghost' : 'btn', isCur ? 'Your plan' : subscribed ? 'Switch to ' + p.name : 'Choose ' + p.name);
      btn.disabled = isCur || !fits || !b.stripeReady || !p.ready;
      if (!fits) card.appendChild(el('p', 'hint', 'You have ' + b.activeCrew + ' active crew, more than this plan covers.'));
      else if (b.suggested === p.key && !isCur) card.appendChild(el('p', 'hint', 'Fits your crew right now.'));
      btn.onclick = function () { choosePlan(p, subscribed, btn); };
      card.appendChild(btn); box.appendChild(card);
    });
    $('b-portal').hidden = !b.hasCustomer;
    if (!b.stripeReady) status('b-status', 'Payments are not switched on yet (Stripe keys missing).');
  }
  var planArmed = null;
  function choosePlan(p, subscribed, btn) {
    if (!subscribed) {
      status('b-status', 'Opening secure checkout…');
      api('POST', '/api/billing/checkout', { plan: p.key }).then(function (r) { location.href = r.url; }).catch(function (e) { status('b-status', e.message, 'err'); });
      return;
    }
    if (planArmed !== p.key) { planArmed = p.key; btn.textContent = 'Tap again to switch to ' + p.name + ' (' + p.price + '/mo)'; setTimeout(function () { planArmed = null; drawPlan(); }, 4000); return; }
    planArmed = null; status('b-status', 'Switching plan…');
    api('POST', '/api/billing/change-plan', { plan: p.key }).then(function () { return loadMe(); })
      .then(function () { status('b-status', 'Switched to ' + p.name + '. Stripe adjusts your next bill for the rest of this month.', 'ok'); })
      .catch(function (e) { status('b-status', e.message, 'err'); });
  }
  $('b-portal').onclick = function () {
    status('b-status', 'Opening billing…');
    api('POST', '/api/billing/portal').then(function (r) { location.href = r.url; }).catch(function (e) { status('b-status', e.message, 'err'); });
  };

  /* ------------------------------- week ------------------------------- */
  function loadWeek(ws) {
    status('w-status', 'Loading…');
    return api('GET', '/api/admin/week?start=' + encodeURIComponent(ws || '')).then(function (r) {
      week = r; weekStart = r.weekStart; drawWeek(); status('w-status', '');
    }).catch(function (e) { status('w-status', e.message, 'err'); });
  }
  function drawWeek() {
    var r = week, dates = r.dates, s = r.settings;
    $('wk-label').textContent = short(dates[0]) + ' – ' + short(dates[6]);
    $('wk-sub').textContent = 'Week runs ' + LONG[s.weekStart] + ' to ' + LONG[(s.weekStart + 6) % 7];
    $('wk-next').disabled = shift(r.weekStart, 7) > r.today;
    $('appr-pill').textContent = r.approved ? 'Approved' : 'Not approved';
    $('appr-pill').className = 'pill ' + (r.approved ? 'done' : 'open');
    $('appr-note').textContent = r.approved ? 'Locked' + (r.approvedBy ? ' by ' + r.approvedBy : '') + '. Crew can’t change these days.' : 'Crew can still change these days.';
    $('appr-btn').textContent = r.approved ? 'Unlock week' : 'Approve week';
    $('appr-btn').className = r.approved ? 'btn ghost' : 'btn';
    var head = $('w-head'); head.innerHTML = '';
    head.appendChild(el('th', '', 'Crew'));
    dates.forEach(function (d) { head.appendChild(el('th', '', DAYS[toUTC(d).getUTCDay()] + ' ' + toUTC(d).getUTCDate())); });
    head.appendChild(el('th', '', 'Total'));
    var body = $('w-body'); body.innerHTML = '';
    var col = [0, 0, 0, 0, 0, 0, 0], logged = 0, ot = 0, open = 0;
    r.people.forEach(function (p) {
      var tr = el('tr', 'person' + (pick === p.id ? ' sel' : '')); tr.tabIndex = 0;
      var td = el('td', '', p.name);
      if (p.manager) td.appendChild(el('span', 'pill mgr', 'Mgr'));
      if (!p.active) td.appendChild(el('span', 'pill off', 'Inactive'));
      if (p.ot > 0) { td.appendChild(el('span', 'pill ot', 'OT ' + fmt(p.ot))); ot++; }
      tr.appendChild(td);
      var anyOpen = false;
      dates.forEach(function (d, i) {
        var e = p.days[d], h = e ? e.total : 0, on = e && (e.open || e.oOpen) && !h; col[i] += h;
        if (e && (e.open || e.oOpen)) anyOpen = true;
        tr.appendChild(el('td', on ? 'on' : 'n' + (h ? '' : ' z'), on ? 'on' : h ? fmt(h) : '–'));
      });
      if (anyOpen) open++;
      tr.appendChild(el('td', 'n t', fmt(p.total)));
      if (p.total > 0 || Object.keys(p.days).length) logged++;
      var toggle = function () { pick = pick === p.id ? null : p.id; drawWeek(); if (pick) $('w-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
      tr.onclick = toggle; tr.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } };
      body.appendChild(tr);
    });
    var foot = $('w-foot'); foot.innerHTML = ''; foot.appendChild(el('td', '', 'Crew total'));
    col.forEach(function (h) { foot.appendChild(el('td', 'n', fmt(h))); });
    foot.appendChild(el('td', 'n', fmt(r.grand)));
    $('t-hours').textContent = fmt(r.grand); $('t-people').textContent = logged + '/' + r.people.length;
    $('t-ot').textContent = ot; $('t-open').textContent = open;
    $('w-empty').hidden = r.people.length > 0;
    $('csv').href = '/api/admin/export.csv?from=' + dates[0] + '&to=' + dates[6];
    drawDetail();
  }
  function line(label, start, end, out, back, note, hours) {
    var l = el('div', 'l'); l.appendChild(el('span', 'm', label + ': '));
    var span = end ? clock(start) + '–' + clock(end) + ' (' + fmt(hours) + ' h)' : 'started ' + clock(start) + ', still on the clock';
    var away = out ? (back ? ' · out ' + clock(out) + '–' + clock(back) : ' · clocked out ' + clock(out) + ', not back yet') : '';
    l.appendChild(document.createTextNode(span + away + (note ? ' · ' + note : '')));
    return l;
  }
  function drawDetail() {
    var box = $('w-detail'), p = week.people.filter(function (x) { return x.id === pick; })[0], s = week.settings;
    box.hidden = !p; if (!p) return; box.innerHTML = '';
    box.appendChild(el('h3', '', p.name + ' · ' + fmt(p.total) + ' h'));
    var any = false;
    week.dates.forEach(function (d) {
      var e = p.days[d]; if (!e) return; any = true;
      var row = el('div', 'd'); row.appendChild(el('div', 'k', LONG[toUTC(d).getUTCDay()] + ', ' + short(d) + ' · ' + fmt(e.total) + ' h'));
      if (e.start) row.appendChild(line(s.mainLabel, e.start, e.end, e.outT, e.inT, e.summary, e.hours));
      if (e.oStart) row.appendChild(line(s.otherLabel + (e.oJob ? ' (' + e.oJob + ')' : ''), e.oStart, e.oEnd, e.oOutT, e.oInT, e.oSummary, e.oHours));
      box.appendChild(row);
    });
    if (!any) box.appendChild(el('p', 'muted', 'Nothing logged this week.'));
  }
  $('wk-prev').onclick = function () { pick = null; loadWeek(shift(weekStart, -7)); };
  $('wk-next').onclick = function () { pick = null; loadWeek(shift(weekStart, 7)); };
  var armed = false;
  $('appr-btn').onclick = function () {
    var want = !week.approved;
    if (!armed) { armed = true; $('appr-btn').textContent = want ? 'Tap again to approve' : 'Tap again to unlock'; setTimeout(function () { armed = false; drawWeek(); }, 3000); return; }
    armed = false; status('w-status', want ? 'Approving…' : 'Unlocking…');
    api('POST', '/api/admin/approve', { weekStart: weekStart, approved: want }).then(function (r) {
      week = r; drawWeek(); status('w-status', want ? 'Week approved and locked.' : 'Week unlocked.', 'ok');
    }).catch(function (e) { status('w-status', e.message, 'err'); });
  };
  function emailMe(kind) {
    status('w-status', 'Sending…');
    api('POST', '/api/admin/email-me', { kind: kind, weekStart: weekStart }).then(function (r) {
      status('w-status', 'Sent to ' + [].concat(r.to).join(', ') + '.', 'ok');
    }).catch(function (e) { status('w-status', e.message, 'err'); });
  }
  $('email-week').onclick = function () { emailMe('weekly'); };
  $('email-missing').onclick = function () { emailMe('missing'); };

  /* ------------------------------- crew ------------------------------- */
  function loadCrew() { return api('GET', '/api/admin/crew').then(function (r) { crew = r.crew; showCount(r.billing); drawCrew(); }); }
  function showCount(b) {
    if (!b) return; me.billing = b; drawPlan();
    $('crew-count').textContent = b.activeCrew + ' of ' + b.crewLimit + ' active' + (b.status === 'trialing' ? ' (trial)' : '');
  }
  function drawCrew() {
    var list = $('crew-list'); list.innerHTML = '';
    if (!crew.length) { list.appendChild(el('p', 'muted', 'No one yet. Add your first crew member above.')); return; }
    crew.forEach(function (c) {
      var row = el('div', 'crow' + (c.active ? '' : ' inactive'));
      var left = el('div'); left.appendChild(el('span', 'nm', c.name));
      if (c.is_manager) left.appendChild(el('span', 'pill mgr', 'Manager'));
      if (!c.active) left.appendChild(el('span', 'pill off', 'Can’t log in'));
      row.appendChild(left);
      var acts = el('div', 'acts');
      var edit = el('button', 'btn ghost small', editing === c.id ? 'Close' : 'Edit');
      edit.onclick = function () { editing = editing === c.id ? null : c.id; drawCrew(); };
      var act = el('button', c.active ? 'btn danger small' : 'btn ghost small', c.active ? 'Turn off' : 'Turn on');
      act.title = c.active ? 'Stops their PIN working. Their hours are kept.' : 'Lets their PIN work again.';
      act.onclick = function () { updateCrew(c.id, { active: !c.active }); };
      acts.appendChild(edit); acts.appendChild(act); row.appendChild(acts);
      if (editing === c.id) {
        var f = el('form', 'edit'); f.noValidate = true;
        var n = el('div'); n.innerHTML = '<label>Name</label>'; var ni = el('input'); ni.value = c.name; ni.maxLength = 60; n.appendChild(ni);
        var p = el('div'); p.innerHTML = '<label>New PIN <span class="hint">leave blank to keep</span></label>'; var pi = el('input'); pi.inputMode = 'numeric'; pi.maxLength = 4; pi.autocomplete = 'off'; p.appendChild(pi);
        var m = el('label', 'check'); var mi = el('input'); mi.type = 'checkbox'; mi.checked = c.is_manager; m.appendChild(mi); m.appendChild(document.createTextNode(' Manager'));
        var sv = el('button', 'btn small', 'Save'); sv.type = 'submit';
        f.appendChild(n); f.appendChild(p); f.appendChild(m); f.appendChild(sv);
        f.onsubmit = function (e) { e.preventDefault(); updateCrew(c.id, { name: ni.value, pin: pi.value, manager: mi.checked }, true); };
        row.appendChild(f);
      }
      list.appendChild(row);
    });
  }
  function updateCrew(id, body, close) {
    status('add-status', 'Saving…');
    api('PUT', '/api/admin/crew/' + id, body).then(function (r) { crew = r.crew; showCount(r.billing); if (close) editing = null; drawCrew(); status('add-status', 'Saved.', 'ok'); })
      .catch(function (e) { status('add-status', e.message, 'err'); });
  }
  $('add-crew').onsubmit = function (e) {
    e.preventDefault();
    status('add-status', 'Adding…');
    api('POST', '/api/admin/crew', { name: $('new-name').value, pin: $('new-pin').value, manager: $('new-mgr').checked }).then(function (r) {
      crew = r.crew; showCount(r.billing); drawCrew();
      status('add-status', 'Added ' + $('new-name').value.trim() + ' with PIN ' + $('new-pin').value + '. Text them your crew link and their PIN.', 'ok');
      $('new-name').value = ''; $('new-pin').value = ''; $('new-mgr').checked = false; $('new-name').focus();
    }).catch(function (err) { status('add-status', err.message, 'err'); });
  };

  /* ----------------------------- settings ----------------------------- */
  var ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico', 'America/Halifax', 'America/Toronto', 'America/Vancouver', 'Europe/London', 'Australia/Sydney'];
  function fillSettings() {
    var s = me.settings;
    if (!$('s-tz').options.length) {
      var zones = ZONES.indexOf(s.timezone) === -1 ? [s.timezone].concat(ZONES) : ZONES;
      zones.forEach(function (z) { var o = el('option', '', z.replace(/_/g, ' ')); o.value = z; $('s-tz').appendChild(o); });
      LONG.forEach(function (d, i) { var o = el('option', '', d); o.value = i; $('s-week').appendChild(o); });
      for (var h = 0; h < 24; h++) { [$('s-sum'), $('s-miss')].forEach(function (sel) { var o = el('option', '', hourLabel(h)); o.value = h; sel.appendChild(o); }); }
      DAYS.forEach(function (d, i) { var l = el('label'); var c = el('input'); c.type = 'checkbox'; c.value = i; c.id = 's-day-' + i; l.appendChild(c); l.appendChild(document.createTextNode(d)); $('s-days').appendChild(l); });
    }
    $('s-name').value = s.name; $('s-tz').value = s.timezone; $('s-week').value = s.weekStart; $('s-ot').value = s.overtimeAfter;
    $('s-back').value = s.maxDaysBack; $('s-main').value = s.mainLabel; $('s-other-on').checked = s.otherEnabled; $('s-other').value = s.otherLabel;
    $('s-opts').value = (s.otherOptions || []).join('\n'); $('s-emails').value = s.reportEmails; $('s-sum').value = s.summaryHour; $('s-miss').value = s.missingHour;
    DAYS.forEach(function (d, i) { $('s-day-' + i).checked = s.workdays.indexOf(i) !== -1; });
  }
  $('settings').onsubmit = function (e) {
    e.preventDefault(); status('s-status', 'Saving…');
    var workdays = []; DAYS.forEach(function (d, i) { if ($('s-day-' + i).checked) workdays.push(i); });
    api('PUT', '/api/admin/settings', {
      name: $('s-name').value, timezone: $('s-tz').value, weekStart: Number($('s-week').value), overtimeAfter: Number($('s-ot').value),
      maxDaysBack: Number($('s-back').value), mainLabel: $('s-main').value, otherEnabled: $('s-other-on').checked, otherLabel: $('s-other').value,
      otherOptions: $('s-opts').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean),
      workdays: workdays, reportEmails: $('s-emails').value, summaryHour: Number($('s-sum').value), missingHour: Number($('s-miss').value)
    }).then(function (r) { me.settings = r.settings; weekStart = null; pick = null; $('co-name').textContent = r.settings.name; fillSettings(); status('s-status', 'Saved.', 'ok'); })
      .catch(function (err) { status('s-status', err.message, 'err'); });
  };

  /* ------------------------------- start ------------------------------ */
  var showWelcome = false;
  try { showWelcome = location.hash === '#welcome' || localStorage.getItem('ch-welcome') === '1'; if (location.hash === '#welcome') localStorage.setItem('ch-welcome', '1'); } catch (e) {}
  $('welcome').hidden = !showWelcome;
  $('welcome-done').onclick = function () { $('welcome').hidden = true; try { localStorage.removeItem('ch-welcome'); } catch (e) {} };
  loadMe().then(function () {
    var h = location.hash;
    var m = /^#week=(\d{4}-\d{2}-\d{2})$/.exec(h);
    if (m) weekStart = m[1];
    if (/^#billing/.test(h)) { showTab('billing'); if (h === '#billing-done') status('b-status', 'Thanks! Your subscription is being set up. This page will show it within a minute.', 'ok'); }
    else if (h === '#welcome') { showTab('crew'); loadWeek(weekStart); }
    else showTab('week');
  }).catch(function () {});
})();
