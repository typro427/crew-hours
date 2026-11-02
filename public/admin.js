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
    if (name === 'tasks') loadTasks();
    if (name === 'roads') loadRoads();
    if (name === 'water') showWater(wTab);
    if (name === 'members') loadMembers();
    if (name === 'orders') orderPanel.load();
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
      drawPlan(); fillSettings(); drawDrive();
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
  // When the Billing tab opens, quietly re-check with Stripe in case a webhook was missed.
  document.querySelector('[data-tab="billing"]').addEventListener('click', function () {
    if (me && me.billing.hasCustomer) api('POST', '/api/billing/sync').then(function (r) { if (r.synced) return loadMe(); }).catch(function () {});
  });
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
      if (e.photos && e.photos.length) {
        var th = el('div', 't-thumbs');
        e.photos.forEach(function (id) { var a = el('a'); a.href = '/api/admin/day-photo/' + id; a.target = '_blank'; a.rel = 'noopener';
          var i = el('img'); i.src = a.href; i.alt = 'Photo from ' + p.name; i.loading = 'lazy'; a.appendChild(i); th.appendChild(a); });
        row.appendChild(th);
      }
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
  var featLabels = {};
  function loadCrew() { return api('GET', '/api/admin/crew').then(function (r) { crew = r.crew; featLabels = r.features || featLabels; showCount(r.billing); drawCrew(); }); }
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
      var offs = c.features ? Object.keys(featLabels).filter(function (k) { return c.features[k] === false; }) : [];
      if (offs.length) left.appendChild(el('span', 'hint', ' ' + offs.length + ' off'));
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
        // What this person can use in the app.
        var fs = el('div', 'feats'); fs.appendChild(el('span', 'k', 'Can use in the app'));
        var boxes = {};
        Object.keys(featLabels).forEach(function (k) {
          var l = el('label', 'check'), cb = el('input'); cb.type = 'checkbox'; cb.checked = !c.features || c.features[k] !== false;
          boxes[k] = cb; l.appendChild(cb); l.appendChild(document.createTextNode(' ' + featLabels[k])); fs.appendChild(l);
        });
        f.appendChild(n); f.appendChild(p); f.appendChild(m); f.appendChild(fs); f.appendChild(sv);
        f.onsubmit = function (e) {
          e.preventDefault();
          var feats = {}; Object.keys(boxes).forEach(function (k) { feats[k] = boxes[k].checked; });
          updateCrew(c.id, { name: ni.value, pin: pi.value, manager: mi.checked, features: feats }, true);
        };
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
    $('s-slug').value = s.slug; $('s-slug-pre').textContent = me.crewLink.replace(/[^/]*$/, '');
    $('s-name').value = s.name; $('s-tz').value = s.timezone; $('s-week').value = s.weekStart; $('s-ot').value = s.overtimeAfter;
    $('s-back').value = s.maxDaysBack; $('s-main').value = s.mainLabel; $('s-other-on').checked = s.otherEnabled; $('s-other').value = s.otherLabel;
    $('s-opts').value = (s.otherOptions || []).join('\n'); $('s-emails').value = s.reportEmails; $('s-sum').value = s.summaryHour; $('s-miss').value = s.missingHour;
    DAYS.forEach(function (d, i) { $('s-day-' + i).checked = s.workdays.indexOf(i) !== -1; });
  }
  $('settings').onsubmit = function (e) {
    e.preventDefault(); status('s-status', 'Saving…');
    var workdays = []; DAYS.forEach(function (d, i) { if ($('s-day-' + i).checked) workdays.push(i); });
    api('PUT', '/api/admin/settings', {
      name: $('s-name').value, slug: $('s-slug').value.trim().toLowerCase(), timezone: $('s-tz').value, weekStart: Number($('s-week').value), overtimeAfter: Number($('s-ot').value),
      maxDaysBack: Number($('s-back').value), mainLabel: $('s-main').value, otherEnabled: $('s-other-on').checked, otherLabel: $('s-other').value,
      otherOptions: $('s-opts').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean),
      workdays: workdays, reportEmails: $('s-emails').value, summaryHour: Number($('s-sum').value), missingHour: Number($('s-miss').value)
    }).then(function (r) { me.settings = r.settings; weekStart = null; pick = null; $('co-name').textContent = r.settings.name;
      if (r.crewLink) { me.crewLink = r.crewLink; $('crew-link').textContent = r.crewLink; $('open-link').href = r.crewLink; } fillSettings(); status('s-status', 'Saved.', 'ok'); })
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
    if (/^#billing/.test(h)) {
      showTab('billing');
      if (h === '#billing-done') {
        status('b-status', 'Thanks! Checking your subscription with Stripe…', 'ok');
        api('POST', '/api/billing/sync').then(function () { return loadMe(); })
          .then(function () { status('b-status', me.billing.status === 'trialing' ? 'Payment received. Stripe is still finishing up; refresh in a minute.' : 'You’re subscribed. Thank you!', 'ok'); })
          .catch(function (e) { status('b-status', e.message, 'err'); });
      }
    }
    else if (h === '#tasks') showTab('tasks');
    else if (h === '#roads') showTab('roads');
    else if (h === '#water') showTab('water');
    else if (h === '#members') showTab('members');
    else if (h === '#orders') showTab('orders');
    else if (/^#gdrive/.test(h)) {
      showTab('settings'); var gm = /^#gdrive-error=(.*)$/.exec(h);
      if (h === '#gdrive-ok') status('gd-status', 'Google Drive connected. The first backup is running now.', 'ok');
      else if (gm) status('gd-status', decodeURIComponent(gm[1]), 'err');
      else if (h === '#gdrive-off') status('gd-status', 'Google Drive backup isn’t switched on yet (the Google keys aren’t in Render).', 'err');
      setTimeout(function () { $('gdrive-card').scrollIntoView({ behavior: 'smooth' }); }, 200);
      history.replaceState(null, '', '/admin#settings');
    }
    else if (h === '#welcome') { showTab('crew'); loadWeek(weekStart); }
    else showTab('week');
  }).catch(function () {});

  /* ------------------------------ import ------------------------------ */
  if ($('imp-go')) $('imp-go').onclick = function () {
    var f = $('imp-file').files[0];
    if (!f) return status('imp-status', 'Pick the import file first.', 'err');
    status('imp-status', 'Importing…');
    if (isExcel(f)) return sendMeterExcel(f).then(function (r) {
      status('imp-status', 'Done. Imported ' + r.meters + ' meters from Excel' + (r.readings ? ' and ' + r.readings + ' current readings' : '') + '. See them under Water System → Meters.', 'ok');
    }).catch(function (e) { status('imp-status', e.message, 'err'); });
    f.text().then(function (txt) {
      var data; try { data = JSON.parse(txt.replace(/^\ufeff/, '')); } catch (e) {
        throw new Error(/^%PDF/.test(txt) ? "That's a PDF. Pick the .json file Claude made instead." : /^PK/.test(txt) ? "That's an Excel file. Save it as CSV and use the Members tab's import box, or pick the .json file." : "That file isn't a Crew Hours import file. Pick the .json file.");
      }
      return api('POST', '/api/admin/import', data);
    }).then(function (r) {
      if (r.meters) { status('imp-status', 'Done. Imported ' + r.meters + ' meters. See them under Water System → Meters.', 'ok'); return loadMe(); }
      if (r.members) { status('imp-status', 'Done. Imported ' + r.members + ' members. See them in the Members tab.', 'ok'); return loadMe(); }
      var msg = (r.crewAdded || r.daysAdded || !(r.roadsAdded || r.roadsUpdated)) ? 'Done. Added ' + r.crewAdded + ' crew and ' + r.daysAdded + ' days of hours.' : 'Done.';
      if (r.crewSkipped.length) msg += ' Skipped: ' + r.crewSkipped.join(', ') + '.';
      if (r.daysSkipped) msg += ' ' + r.daysSkipped + ' days were already here.';
      if (r.roadsAdded || r.roadsUpdated) msg += ' Roads: ' + r.roadsAdded + ' added, ' + r.roadsUpdated + ' updated with their details.';
      if (r.problems.length) msg += ' Problems: ' + r.problems.join('; ') + '.';
      status('imp-status', msg, r.problems.length ? 'err' : 'ok');
      return loadMe();
    }).catch(function (e) { status('imp-status', e.message, 'err'); });
  };

  /* --------------------- task panels: Tasks, Water leaks & repairs --------------------- */
  function TaskPanel(kind, root, L) {
    var me = { tasks: [], editing: null };
    var form = el('form', 'card'); form.noValidate = true;
    form.appendChild(el('h3', '', L.formTitle));
    function field(label, node, hint) { var l = el('label', '', label); if (hint) l.appendChild(el('span', 'hint', ' ' + hint)); form.appendChild(l); form.appendChild(node); return node; }
    var fT = field(L.titleLabel, el('input')); fT.maxLength = 120; fT.placeholder = L.titlePh; fT.autocomplete = 'off';
    var fD = field(L.detailsLabel || 'Details', el('textarea'), '(optional)'); fD.maxLength = 2000; fD.rows = 3; fD.placeholder = L.detailsPh;
    var fA = el('input'); fA.maxLength = 200; fA.placeholder = 'e.g. 141 Deer Meadow'; fA.autocomplete = 'off';
    if (L.addressField) field('Address', fA, '(finds the owner on the members list)');
    var g = el('div', 'grid2'), w1 = el('div'), w2 = el('div');
    var fW = el('select'), fDue = el('input'); fDue.type = 'date';
    w1.appendChild(el('label', '', 'For')); w1.appendChild(fW); w2.appendChild(el('label', '', L.dueLabel || 'Due')); w2.lastChild.appendChild(el('span', 'hint', ' (optional)')); w2.appendChild(fDue);
    g.appendChild(w1); g.appendChild(w2); form.appendChild(g);
    if (L.hideFor) w1.hidden = true;
    var fCost = el('input'); fCost.inputMode = 'decimal'; fCost.placeholder = 'e.g. 250';
    if (L.costField) { var wc = el('div'); wc.appendChild(el('label', '', 'Rough cost ($)')); wc.lastChild.appendChild(el('span', 'hint', ' (optional)')); wc.appendChild(fCost); g.appendChild(wc); }
    var fPics = [], fPhoto = el('input'), fThumbs = el('div', 't-thumbs');
    fPhoto.type = 'file'; fPhoto.accept = 'image/*'; fPhoto.multiple = true;
    if (L.photosOnCreate) {
      var wp = el('div'); wp.appendChild(el('label', '', 'Picture')); wp.lastChild.appendChild(el('span', 'hint', ' (optional)')); wp.appendChild(fPhoto); wp.appendChild(fThumbs); form.appendChild(wp);
      fPhoto.onchange = function () {
        var files = Array.prototype.slice.call(fPhoto.files || [], 0, Math.max(0, 6 - fPics.length)); fPhoto.value = '';
        files.reduce(function (p, f) { return p.then(function () { return shrinkImage(f).then(function (d) { fPics.push(d); }); }); }, Promise.resolve())
          .then(drawPics).catch(function (e) { say(e.message, 'err'); });
      };
    }
    function drawPics() {
      fThumbs.innerHTML = '';
      fPics.forEach(function (src, i) { var w = el('span'); w.style.position = 'relative'; var im = el('img'); im.src = src; im.alt = 'New photo'; im.style.cssText = 'width:90px;height:90px;object-fit:cover;border-radius:8px';
        var x = el('button', 'btn ghost small', '×'); x.type = 'button'; x.style.cssText = 'position:absolute;top:-6px;right:-6px;padding:0 7px'; x.onclick = function () { fPics.splice(i, 1); drawPics(); };
        w.appendChild(im); w.appendChild(x); fThumbs.appendChild(w); });
    }
    var row = el('div', 'row'), sv = el('button', 'btn', L.addBtn), cancel = el('button', 'btn ghost', 'Cancel'), st = el('span', 'status');
    sv.type = 'submit'; cancel.type = 'button'; cancel.hidden = true; row.appendChild(sv); row.appendChild(cancel); row.appendChild(st); form.appendChild(row);
    form.appendChild(el('p', 'hint', L.formHint));
    var openC = el('div', 'card'), doneC = el('div', 'card');
    openC.appendChild(el('h3', '', L.openTitle)); var openL = el('div', 'tasks'), openE = el('p', 'hint', L.openEmpty); openC.appendChild(openL); openC.appendChild(openE);
    doneC.appendChild(el('h3', '', L.doneTitle)); doneC.lastChild.appendChild(el('span', 'hint', ' (last 60 days)'));
    var doneL = el('div', 'tasks'), doneE = el('p', 'hint', L.doneEmpty); doneC.appendChild(doneL); doneC.appendChild(doneE);
    var wrap = el('div', 'stack'); [form, openC, doneC].forEach(function (n) { wrap.appendChild(n); }); root.appendChild(wrap);
    function say(m, c) { st.textContent = m || ''; st.className = 'status' + (c ? ' ' + c : ''); }
    me.load = function () {
      say('');
      return Promise.all([api('GET', '/api/admin/tasks?kind=' + kind), api('GET', '/api/admin/crew')]).then(function (r) {
        me.tasks = r[0].tasks; crew = r[1].crew; fillWho(); draw();
      }).catch(function (e) { say(e.message, 'err'); });
    };
    function fillWho() {
      var keep = fW.value; fW.innerHTML = '';
      var o = el('option', '', 'Anyone on the crew'); o.value = ''; fW.appendChild(o);
      crew.filter(function (c) { return c.active; }).forEach(function (c) { var x = el('option', '', c.name); x.value = c.id; fW.appendChild(x); });
      fW.value = keep;
    }
    function draw() {
      openL.innerHTML = ''; doneL.innerHTML = ''; var no = 0, nd = 0;
      me.tasks.forEach(function (t) {
        var r = el('div', 'trow'), top = el('div', 't-top'), left = el('div');
        left.appendChild(el('b', '', t.title));
        var meta = el('div', 't-meta');
        if (!L.hideFor) meta.appendChild(el('span', '', t.assignedName ? 'For ' + t.assignedName : 'For anyone'));
        if (t.createdByName) meta.appendChild(el('span', '', L.byWord + ' ' + t.createdByName));
        if (t.due) { var late = t.status === 'open' && t.due < me_today(); meta.appendChild(el('span', late ? 'late' : '', (late ? (L.overdueWord || 'Overdue: ') : (L.dueWord || 'Due ')) + DAYS[toUTC(t.due).getUTCDay()] + ' ' + short(t.due))); }
        if (t.cost != null) meta.appendChild(el('span', '', '≈ $' + Number(t.cost).toLocaleString()));
        if (t.status === 'done') meta.appendChild(el('span', '', L.doneWord + ' by ' + (t.doneByName || 'someone') + ' · ' + new Date(t.doneAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
        left.appendChild(meta); top.appendChild(left);
        var acts = el('div', 't-acts');
        function btn(label, fn) { var b = el('button', 'btn ghost small', label); b.type = 'button'; b.onclick = fn; acts.appendChild(b); return b; }
        if (t.status === 'open' && L.progress) btn('+ Progress', function () { progressForm(t, r); });
        if (t.status === 'open') btn('Edit', function () { edit(t); });
        else btn('Reopen', function () { api('PUT', '/api/admin/tasks/' + t.id, { reopen: true }).then(function (x) { me.tasks = x.tasks; draw(); }).catch(function (e) { say(e.message, 'err'); }); });
        var del = btn('Delete', function () {
          if (del.textContent !== 'Tap again') { del.textContent = 'Tap again'; setTimeout(function () { del.textContent = 'Delete'; }, 3000); return; }
          api('DELETE', '/api/admin/tasks/' + t.id).then(function (x) { me.tasks = x.tasks; draw(); }).catch(function (e) { say(e.message, 'err'); });
        });
        top.appendChild(acts); r.appendChild(top);
        if (t.address || t.owner) {
          var ow = el('p', 't-text');
          if (t.address) ow.appendChild(el('span', '', '📍 ' + t.address + (t.owner ? ' · ' : '')));
          if (t.owner) ow.appendChild(el('b', '', 'Owner: ' + t.owner));
          if (t.ownerPhone) { ow.appendChild(document.createTextNode(' · ')); var tel = el('a', '', t.ownerPhone); tel.href = 'tel:' + t.ownerPhone.replace(/[^0-9+]/g, ''); ow.appendChild(tel); }
          r.appendChild(ow);
        }
        if (t.details) r.appendChild(el('p', 't-text', t.details));
        (t.updates || []).forEach(function (u) {
          var w = el('div', 't-upd'), when = new Date(u.at), h = el('div', 't-meta');
          h.appendChild(el('span', '', 'Progress · ' + when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' · ' + (u.by || 'crew')));
          var x = el('button', 'btn ghost small', 'Remove'); x.type = 'button';
          x.onclick = function () {
            if (x.textContent !== 'Tap again') { x.textContent = 'Tap again'; setTimeout(function () { x.textContent = 'Remove'; }, 3000); return; }
            api('DELETE', '/api/admin/tasks/updates/' + u.id).then(function (q) { me.tasks = q.tasks; draw(); }).catch(function (e) { say(e.message, 'err'); });
          };
          h.appendChild(x); w.appendChild(h);
          if (u.note) w.appendChild(el('p', 't-text', u.note));
          if (u.photos.length) w.appendChild(photoLinks(u.photos, '/api/admin/tasks/photo/', 'Progress photo'));
          r.appendChild(w);
        });
        if (t.status === 'done' && t.doneNotes) r.appendChild(el('p', 't-notes', t.doneNotes));
        if (t.photos && t.photos.length) r.appendChild(photoLinks(t.photos, '/api/admin/tasks/photo/', 'Photo from ' + (t.doneByName || 'crew')));
        if (t.status === 'open') { openL.appendChild(r); no++; } else { doneL.appendChild(r); nd++; }
      });
      openE.hidden = no > 0; doneE.hidden = nd > 0;
      if (L.costField) {
        var openT = me.tasks.filter(function (t) { return t.status === 'open'; }), tot = openT.reduce(function (a, t) { return a + (Number(t.cost) || 0); }, 0);
        openC.firstChild.textContent = L.openTitle + (openT.length ? ' · about $' + Math.round(tot).toLocaleString() : '');
      }
    }
    function progressForm(t, r) {
      if (r.querySelector('.t-prog')) return;
      var f = el('div', 't-prog'), pics = [], inp = el('input'), th = el('div', 't-thumbs'), note = el('textarea'), ps = el('span', 'status');
      inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; note.rows = 2; note.maxLength = 2000; note.placeholder = 'Note (optional)';
      f.appendChild(el('label', '', 'Progress photos')); f.appendChild(inp); f.appendChild(th); f.appendChild(note);
      function drawP() { th.innerHTML = ''; pics.forEach(function (src) { var im = el('img'); im.src = src; im.alt = 'New photo'; im.style.cssText = 'width:90px;height:90px;object-fit:cover;border-radius:8px'; th.appendChild(im); }); }
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files || [], 0, 12); inp.value = '';
        files.reduce(function (p, file) { return p.then(function () { return shrinkImage(file).then(function (d) { pics.push(d); }); }); }, Promise.resolve())
          .then(drawP).catch(function (e) { ps.textContent = e.message; ps.className = 'status err'; });
      };
      var row = el('div', 'row'), save = el('button', 'btn', 'Save progress'), no = el('button', 'btn ghost', 'Cancel');
      save.type = no.type = 'button'; no.onclick = function () { f.remove(); };
      save.onclick = function () {
        if (!pics.length && !note.value.trim()) { ps.textContent = 'Add a photo or a few words.'; ps.className = 'status err'; return; }
        save.disabled = true; ps.textContent = pics.length ? 'Sending photos…' : 'Saving…'; ps.className = 'status';
        api('POST', '/api/admin/tasks/' + t.id + '/progress', { notes: note.value.trim(), photos: pics }).then(function (q) { me.tasks = q.tasks; draw(); say('Progress saved.', 'ok'); })
          .catch(function (e) { save.disabled = false; ps.textContent = e.message; ps.className = 'status err'; });
      };
      row.appendChild(save); row.appendChild(no); row.appendChild(ps); f.appendChild(row); r.appendChild(f);
    }
    function edit(t) { me.editing = t.id; fT.value = t.title; fD.value = t.details || ''; fW.value = t.assignedTo || ''; fDue.value = t.due || ''; fCost.value = t.cost == null ? '' : t.cost; fA.value = t.address || ''; sv.textContent = 'Save'; cancel.hidden = false; fT.focus(); }
    function reset() { me.editing = null; form.reset(); fPics = []; drawPics(); sv.textContent = L.addBtn; cancel.hidden = true; }
    cancel.onclick = reset;
    form.onsubmit = function (e) {
      e.preventDefault();
      var body = { kind: kind, title: fT.value.trim(), details: fD.value, assignedTo: L.hideFor ? null : (fW.value ? Number(fW.value) : null), due: fDue.value || null };
      if (L.costField) body.cost = fCost.value.replace(/[$,\s]/g, '');
      if (L.addressField) body.address = fA.value.trim();
      if (!me.editing && fPics.length) body.photos = fPics.slice();
      if (!body.title) return say(L.needTitle, 'err');
      var id = me.editing;
      api(id ? 'PUT' : 'POST', '/api/admin/tasks' + (id ? '/' + id : ''), body).then(function (r) {
        me.tasks = r.tasks; reset(); draw(); say(id ? 'Saved.' : L.addedOk, 'ok');
      }).catch(function (err) { say(err.message, 'err'); });
    };
    return me;
  }
  function me_today() { return me.today; }
  function photoLinks(ids, base, alt) {
    var th = el('div', 't-thumbs');
    ids.forEach(function (id) { var a = el('a'); a.href = base + id; a.target = '_blank'; a.rel = 'noopener';
      var i = el('img'); i.src = a.href; i.alt = alt; i.loading = 'lazy'; a.appendChild(i); th.appendChild(a); });
    return th;
  }

  /* --------------------- place panels: Roads mowed, Water sites --------------------- */
  function PlacePanel(kind, root, L) {
    var me = { roads: [], pick: null };
    var tableC = el('div', 'card'), head = el('div', 'row'); head.style.justifyContent = 'space-between';
    head.appendChild(el('h3', '', L.title)); var count = el('span', 'hint'); head.appendChild(count); tableC.appendChild(head);
    var find = el('input'); find.type = 'search'; find.placeholder = L.searchPh; find.autocomplete = 'off'; find.setAttribute('aria-label', L.searchPh); find.style.margin = '10px 0';
    tableC.appendChild(find); find.oninput = function () { draw(); };
    var tb = el('div', 'tablebox'), table = el('table', 'roads'), thead = el('thead'), htr = el('tr'), body = el('tbody');
    L.cols.forEach(function (c) { htr.appendChild(el('th', '', c)); }); thead.appendChild(htr); table.appendChild(thead); table.appendChild(body); tb.appendChild(table); tableC.appendChild(tb);
    var empty = el('p', 'hint', L.empty); tableC.appendChild(empty); tableC.appendChild(el('p', 'hint', L.clickHint));
    var detail = el('div', 'card'); detail.hidden = true;
    var form = el('form', 'card'); form.noValidate = true; form.appendChild(el('h3', '', L.listTitle));
    form.appendChild(el('label', '', 'One per line, in the order the crew should see them'));
    var ta = el('textarea'); ta.rows = 10; ta.placeholder = L.listPh; form.appendChild(ta);
    form.appendChild(el('p', 'hint', 'Taking one off the list hides it from the crew. Its history is kept, and comes back if you add it again.'));
    var frow = el('div', 'row'), fsv = el('button', 'btn', 'Save list'), fst = el('span', 'status'); fsv.type = 'submit'; frow.appendChild(fsv); frow.appendChild(fst); form.appendChild(frow);
    var wrap = el('div', 'stack'); [tableC, detail, form].forEach(function (n) { wrap.appendChild(n); }); root.appendChild(wrap);
    function say(m, c) { fst.textContent = m || ''; fst.className = 'status' + (c ? ' ' + c : ''); }
    function daysAgo(d) { return Math.round((toUTC(me_today()) - toUTC(d)) / 864e5); }
    me.load = function () {
      return api('GET', '/api/admin/roads?kind=' + kind).then(function (r) {
        me.roads = r.roads; ta.value = me.roads.map(function (x) { return x.name; }).join('\n'); draw();
        if (me.pick) show(me.pick);
      }).catch(function (e) { say(e.message, 'err'); });
    };
    function draw() {
      body.innerHTML = '';
      var q = find.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var shown = me.roads.filter(function (x) { var t = [x.name, x.surface, x.notes, x.lastBy].join(' ').toLowerCase(); return q.every(function (w) { return t.indexOf(w) !== -1; }); });
      shown.forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(el('td', '', x.name));
        if (L.showLength) tr.appendChild(el('td', '', x.lengthMi != null ? x.lengthMi + ' mi' : ''));
        var n = x.lastDay ? daysAgo(x.lastDay) : null;
        tr.appendChild(el('td', x.lastDay ? (n > L.oldDays ? 'old' : '') : 'never', x.lastDay ? DAYS[toUTC(x.lastDay).getUTCDay()] + ' ' + short(x.lastDay) + ' (' + (n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago') + ')' : L.never));
        tr.appendChild(el('td', '', x.lastBy || ''));
        tr.appendChild(el('td', '', String(x.timesThisYear)));
        tr.onclick = function () { show(x.id); };
        body.appendChild(tr);
      });
      empty.hidden = shown.length > 0;
      empty.textContent = me.roads.length ? 'Nothing matches “' + find.value.trim() + '”.' : L.empty;
      var stale = me.roads.filter(function (x) { return !x.lastDay || daysAgo(x.lastDay) > L.oldDays; }).length;
      count.textContent = me.roads.length ? me.roads.length + ' ' + L.noun + (stale ? ' · ' + stale + ' ' + L.staleText : '') : '';
    }
    function show(id) { me.pick = id; api('GET', '/api/admin/roads/' + id).then(function (r) { drawOne(r.road); }).catch(function (e) { say(e.message, 'err'); }); }
    function drawOne(road) {
      detail.hidden = false; detail.innerHTML = '';
      var top = el('div', 'row'); top.style.justifyContent = 'space-between';
      top.appendChild(el('h3', '', road.name + ' · ' + road.mows.length + ' time' + (road.mows.length === 1 ? '' : 's') + ' logged'));
      var close = el('button', 'btn ghost small', 'Close'); close.type = 'button'; close.onclick = function () { me.pick = null; detail.hidden = true; };
      top.appendChild(close); detail.appendChild(top);
      var PL = { 1: 'needs work', 2: 'soon', 3: 'can wait' }, chips = el('div', 'chips');
      [['Roadway', road.pRoad], ['Ditch line', road.pDitch], ['Trees', road.pTrees]].forEach(function (x) { if (x[1]) chips.appendChild(el('span', 'chip p' + x[1], x[0] + ': ' + PL[x[1]])); });
      var facts = [road.lengthMi != null ? road.lengthMi + ' miles' : '', road.surface || ''].filter(Boolean).join(' · ');
      if (facts) detail.appendChild(el('p', 'muted', facts));
      if (chips.children.length) detail.appendChild(chips);
      if (road.notes) detail.appendChild(el('p', 't-text', road.notes));
      var ed = el('details'); ed.appendChild(el('summary', '', L.editDetails));
      var g = el('div', 'rd-edit');
      function fld(label, node) { var w = el('div'); w.appendChild(el('label', '', label)); w.appendChild(node); g.appendChild(w); return node; }
      function inp(v, type) { var i = el('input'); i.type = type || 'text'; i.value = v == null ? '' : v; return i; }
      function prSel(v) { var sl = el('select'); [['', '—'], ['1', '1 · needs work'], ['2', '2 · soon'], ['3', '3 · can wait']].forEach(function (o) { var x = el('option', '', o[1]); x.value = o[0]; sl.appendChild(x); }); sl.value = v ? String(v) : ''; return sl; }
      var fLen = null, fR = null, fD = null, fT = null;
      if (L.showLength) { fLen = fld('Length (miles)', inp(road.lengthMi, 'number')); fLen.step = '0.1'; fLen.min = '0'; }
      var fSurf = fld(L.surfaceLabel, inp(road.surface)); fSurf.placeholder = L.surfacePh;
      if (L.showPriorities) { fR = fld('Roadway', prSel(road.pRoad)); fD = fld('Ditch line', prSel(road.pDitch)); fT = fld('Trees', prSel(road.pTrees)); }
      ed.appendChild(g);
      ed.appendChild(el('label', '', 'Notes for the crew')); var fN = el('textarea'); fN.value = road.notes || ''; fN.rows = 3; ed.appendChild(fN);
      var r2 = el('div', 'row'), sv = el('button', 'btn small', 'Save details'), st = el('span', 'status'); sv.type = 'button';
      sv.onclick = function () {
        api('PUT', '/api/admin/roads/' + road.id + '/info', { lengthMi: fLen ? fLen.value : road.lengthMi, surface: fSurf.value, pRoad: fR ? fR.value : road.pRoad, pDitch: fD ? fD.value : road.pDitch, pTrees: fT ? fT.value : road.pTrees, notes: fN.value })
          .then(function (r) { me.roads = r.roads; draw(); drawOne(r.road); say('Saved ' + r.road.name + '.', 'ok'); })
          .catch(function (e) { st.textContent = e.message; st.className = 'status err'; });
      };
      r2.appendChild(sv); r2.appendChild(st); ed.appendChild(r2); detail.appendChild(ed);
      // Water sites: which readings the crew takes here.
      if (road.allReadingTypes) {
        var rd = el('details'); rd.appendChild(el('summary', '', 'Readings at this site (' + road.readingTypes.length + ' of ' + road.allReadingTypes.length + ')'));
        if (!road.allReadingTypes.length) rd.appendChild(el('p', 'hint', 'Add readings under Water System → Readings first.'));
        var fsx = el('div', 'feats'), bx = {};
        road.allReadingTypes.forEach(function (t) {
          var l = el('label', 'check'), cb = el('input'); cb.type = 'checkbox';
          cb.checked = road.readingTypes.some(function (x) { return x.id === t.id; }); bx[t.id] = cb;
          l.appendChild(cb); l.appendChild(document.createTextNode(' ' + t.name + (t.unit ? ' (' + t.unit + ')' : ''))); fsx.appendChild(l);
        });
        rd.appendChild(fsx);
        var r3 = el('div', 'row'), sv3 = el('button', 'btn small', 'Save readings for this site'), st3 = el('span', 'status'); sv3.type = 'button';
        sv3.onclick = function () {
          var ids = Object.keys(bx).filter(function (k) { return bx[k].checked; }).map(Number);
          api('PUT', '/api/admin/roads/' + road.id + '/readings', { ids: ids })
            .then(function (r) { me.roads = r.roads; draw(); drawOne(r.road); say('Saved readings for ' + r.road.name + '.', 'ok'); })
            .catch(function (e) { st3.textContent = e.message; st3.className = 'status err'; });
        };
        if (road.allReadingTypes.length) { r3.appendChild(sv3); r3.appendChild(st3); rd.appendChild(r3); }
        detail.appendChild(rd);
      }
      detail.appendChild(el('h3', '', L.historyTitle));
      if (!road.mows.length) detail.appendChild(el('p', 'muted', 'Nothing logged yet.'));
      road.mows.forEach(function (m) {
        var row = el('div', 'mrow'), t = el('div', 't-top');
        t.appendChild(el('b', '', DAYS[toUTC(m.day).getUTCDay()] + ' ' + short(m.day) + (m.byName ? ' · ' + m.byName : '')));
        var del = el('button', 'btn ghost small', 'Remove'); del.type = 'button';
        del.onclick = function () {
          if (del.textContent !== 'Tap again') { del.textContent = 'Tap again'; setTimeout(function () { del.textContent = 'Remove'; }, 3000); return; }
          api('DELETE', '/api/admin/mows/' + m.id).then(function (r) { me.roads = r.roads; draw(); drawOne(r.road); }).catch(function (e) { say(e.message, 'err'); });
        };
        t.appendChild(del); row.appendChild(t);
        if (m.vals && road.allReadingTypes) {
          var vv = road.allReadingTypes.filter(function (x) { return m.vals[x.id] != null; }).map(function (x) { return x.name + ': ' + m.vals[x.id] + (x.unit ? ' ' + x.unit : ''); });
          if (vv.length) row.appendChild(el('p', 't-meta', vv.join(' · ')));
        }
        if (m.notes) row.appendChild(el('p', 't-text', m.notes));
        if (m.photos.length) row.appendChild(photoLinks(m.photos, '/api/admin/road-photo/', 'Photo of ' + road.name));
        detail.appendChild(row);
      });
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    form.onsubmit = function (e) {
      e.preventDefault(); say('Saving…');
      api('PUT', '/api/admin/roads', { kind: kind, names: ta.value.split('\n') }).then(function (r) {
        me.roads = r.roads; ta.value = me.roads.map(function (x) { return x.name; }).join('\n'); draw(); say('Saved. ' + me.roads.length + ' ' + L.noun + '.', 'ok');
      }).catch(function (err) { say(err.message, 'err'); });
    };
    return me;
  }

  var taskPanel = TaskPanel('task', $('tasks-panel'), { formTitle: 'Give the crew a task', titleLabel: 'Task', titlePh: 'e.g. Fix the leak at the pool well house',
    detailsPh: 'Where, what to bring, anything they should know', addBtn: 'Add task', needTitle: 'Give the task a name.', addedOk: 'Task added. The crew will see it in their app.',
    formHint: 'The crew sees it under Tasks in their app. When they finish, they add notes and photos and you get an email.',
    openTitle: 'Open', openEmpty: 'Nothing open.', doneTitle: 'Done', doneEmpty: 'Nothing finished yet.', byWord: 'Added by', doneWord: 'Done' });
  var orderPanel = TaskPanel('order', $('orders-panel'), { formTitle: 'Add something to order', titleLabel: 'What', titlePh: 'e.g. 2" PVC ball valve x4',
    detailsPh: 'Size, brand, where it is for, where to buy', addBtn: 'Add', needTitle: 'Say what needs ordering.', addedOk: 'Added to the order list.',
    formHint: 'Crew you switch on (Crew & PINs → Needs to order) can add items from their app too, with a picture. You get an email when they do.',
    openTitle: 'Needs to order', openEmpty: 'Nothing to order.', doneTitle: 'Ordered', doneEmpty: 'Nothing ordered yet.', byWord: 'Added by', doneWord: 'Ordered',
    hideFor: true, costField: true, photosOnCreate: true, detailsLabel: 'Description', dueLabel: 'Due by', dueWord: 'Due by ', overdueWord: 'Past due: ' });
  var repairPanel = TaskPanel('repair', $('water-repairs'), { addressField: true, progress: true, photosOnCreate: true, formTitle: 'Log a leak or repair', titleLabel: 'What and where', titlePh: 'e.g. Leak at the meter by 141 Deer Meadow',
    detailsPh: 'What needs doing, parts needed', addBtn: 'Add', needTitle: 'Say what the problem is and where.', addedOk: 'Added. The crew will see it under Water System.',
    formHint: 'The crew can also report problems from their app. When they fix one, they add notes and photos and you get an email.',
    openTitle: 'Open leaks & repairs', openEmpty: 'Nothing open.', doneTitle: 'Fixed', doneEmpty: 'Nothing fixed yet.', byWord: 'Reported by', doneWord: 'Fixed' });
  var roadPanel = PlacePanel('road', $('roads-panel'), { searchPh: 'Search roads', title: 'Roads mowed', cols: ['Road', 'Length', 'Last mowed', 'By', 'Times this year'], showLength: true, showPriorities: true,
    empty: 'No roads yet. Add your list below and the Roads mowed tab shows up in the crew app.', clickHint: 'Click a road to see every time it was mowed, with photos.',
    listTitle: 'Road list', listPh: 'Deerfield Way\nSkyline Knoll', noun: 'roads', staleText: 'not mowed in 2 weeks', oldDays: 14, never: 'Not mowed yet',
    editDetails: 'Edit road details', surfaceLabel: 'Surface / other', surfacePh: 'Paved, Gravel…', historyTitle: 'Mowing history' });
  var sitePanel = PlacePanel('water', $('water-sites'), { searchPh: 'Search sites', title: 'Water system sites', cols: ['Site', 'Last checked', 'By', 'Times this year'], showLength: false, showPriorities: false,
    empty: 'No sites yet. Add wells, tanks, pump houses and so on below.', clickHint: 'Click a site to see every check, with photos.',
    listTitle: 'Site list', listPh: 'Well 1\nWell 2\nStorage tank\nPump house\nChlorinator', noun: 'sites', staleText: 'not checked in a week', oldDays: 7, never: 'Not checked yet',
    editDetails: 'Edit site details', surfaceLabel: 'Type', surfacePh: 'Well, Tank, Pump house…', historyTitle: 'Check history' });
  var loadTasks = function () { return taskPanel.load(); }, loadRoads = function () { return roadPanel.load(); };

  /* ------------------------------- water tab ------------------------------ */
  var wTab = 'meters', wTypes = [];
  function showWater(which) {
    wTab = which;
    document.querySelectorAll('[data-w]').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-w') === which); });
    document.querySelectorAll('[data-wp]').forEach(function (p) { p.hidden = p.getAttribute('data-wp') !== which; });
    if (which === 'meters') loadMeterAdmin();
    if (which === 'sites') { sitePanel.load(); loadReadings(); }
    if (which === 'repairs') repairPanel.load();
  }
  document.querySelectorAll('[data-w]').forEach(function (b) { b.onclick = function () { showWater(b.getAttribute('data-w')); }; });
  function loadReadings() {
    var days = $('wr-days').value; $('wr-csv').href = '/api/admin/readings.csv?days=' + days;
    return api('GET', '/api/admin/readings?days=' + days).then(drawReadings).catch(function (e) { status('wr-status', e.message, 'err'); });
  }
  $('wr-days').onchange = loadReadings;
  function drawReadings(r) {
    wTypes = r.types;
    if (document.activeElement !== $('wr-lines')) $('wr-lines').value = wTypes.map(function (t) { return t.name + (t.unit ? ' | ' + t.unit : ''); }).join('\n');
    var head = $('wr-head'); head.innerHTML = '';
    ['When', 'Site', 'By'].concat(wTypes.map(function (t) { return t.name + (t.unit ? ' (' + t.unit + ')' : ''); })).concat(['Notes', '']).forEach(function (h) { head.appendChild(el('th', '', h)); });
    var body = $('wr-body'); body.innerHTML = '';
    r.readings.forEach(function (x) {
      var tr = el('tr'), d = new Date(x.takenAt);
      tr.appendChild(el('td', '', d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
      tr.appendChild(el('td', '', x.siteName || ''));
      tr.appendChild(el('td', '', x.byName || ''));
      wTypes.forEach(function (t) { tr.appendChild(el('td', 'num', x.vals[t.id] != null ? String(x.vals[t.id]) : '')); });
      tr.appendChild(el('td', '', x.notes || ''));
      var td = el('td'), del = el('button', 'btn ghost small', 'Remove'); del.type = 'button';
      del.onclick = function (ev) {
        ev.stopPropagation();
        if (del.textContent !== 'Tap again') { del.textContent = 'Tap again'; setTimeout(function () { del.textContent = 'Remove'; }, 3000); return; }
        api('DELETE', '/api/admin/readings/' + x.id + '?days=' + $('wr-days').value).then(drawReadings).catch(function (e) { status('wr-status', e.message, 'err'); });
      };
      td.appendChild(del); tr.appendChild(td); body.appendChild(tr);
    });
    $('wr-empty').hidden = r.readings.length > 0;
    $('wr-empty').textContent = wTypes.length ? 'No readings in this period.' : 'List the readings below (chlorine, pressure…). The crew fills them in when they check a site.';
  }
  $('wr-form').onsubmit = function (e) {
    e.preventDefault(); status('wr-status', 'Saving…');
    api('PUT', '/api/admin/reading-types?days=' + $('wr-days').value, { lines: $('wr-lines').value.split('\n') }).then(function (r) {
      $('wr-lines').blur(); drawReadings(r); status('wr-status', 'Saved. ' + r.types.length + ' readings.', 'ok');
    }).catch(function (err) { status('wr-status', err.message, 'err'); });
  };

  /* ------------------------------ members ------------------------------ */
  var mb = { columns: [], rows: [], total: 0, limit: 100, timer: null, seq: 0, open: null };
  function mbField(d, names) { for (var i = 0; i < names.length; i++) { if (d[names[i]]) return d[names[i]]; } return ''; }
  function loadMembers(more) {
    if (!more) mb.limit = 100;
    var seq = ++mb.seq;
    return api('GET', '/api/admin/members?limit=' + mb.limit + '&q=' + encodeURIComponent($('mb-q').value.trim()) + '&status=' + encodeURIComponent($('mb-status').value))
      .then(function (r) { if (seq !== mb.seq) return; mb.columns = r.columns; mb.rows = r.rows; mb.total = r.total; drawMembers(); })
      .catch(function (e) { status('mb-status-line', e.message, 'err'); });
  }
  $('mb-q').oninput = function () { clearTimeout(mb.timer); mb.timer = setTimeout(loadMembers, 250); };
  $('mb-status').onchange = function () { loadMembers(); };
  $('mb-more').onclick = function () { mb.limit += 200; loadMembers(true); };
  function drawMembers() {
    var body = $('mb-body'); body.innerHTML = '';
    mb.rows.forEach(function (r) {
      var d = r.data, tr = el('tr');
      var nm = el('td', 'nm', [mbField(d, ['Last name']), mbField(d, ['First name(s)'])].filter(Boolean).join(', ') || mbField(d, ['Trust or LLC']) || '(no name)');
      if (d['Status'] && d['Status'] !== 'Active') nm.appendChild(el('span', 'off', d['Status']));
      tr.appendChild(nm);
      tr.appendChild(el('td', '', d['Deerfield address'] || ''));
      tr.appendChild(el('td', '', d['Property type'] || ''));
      tr.appendChild(el('td', '', d['Parcel ID'] || ''));
      tr.appendChild(el('td', '', mbField(d, ['Cell phone 1', 'Home phone', 'Deerfield phone', 'Cell phone 2', 'Work phone'])));
      tr.appendChild(el('td', '', mbField(d, ['Email 1', 'Email 2'])));
      tr.onclick = function () { showMember(r); };
      body.appendChild(tr);
    });
    $('mb-count').textContent = mb.columns.length ? (mb.total + ' ' + (mb.total === 1 ? 'member' : 'members') + ($('mb-q').value.trim() ? ' match' : '') + (mb.rows.length < mb.total ? ' · showing ' + mb.rows.length : '')) : 'No list yet. Import the master list below.';
    $('mb-more-row').hidden = mb.rows.length >= mb.total;
  }
  function showMember(r, editing) {
    var box = $('mb-detail'); box.hidden = false; box.innerHTML = '';
    var d = (r && r.data) || {}, top = el('div', 'row'); top.style.justifyContent = 'space-between';
    top.appendChild(el('h3', '', r ? ([d['Last name'], d['First name(s)']].filter(Boolean).join(', ') || 'Member') : 'New member'));
    var acts = el('div', 'row'); acts.style.gap = '8px';
    function btn(label, cls, fn) { var b = el('button', 'btn small ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; acts.appendChild(b); return b; }
    if (!editing && r) btn('Edit', 'ghost', function () { showMember(r, true); });
    if (r) {
      var del = btn('Delete', 'ghost', function () {
        if (del.textContent !== 'Tap again') { del.textContent = 'Tap again'; setTimeout(function () { del.textContent = 'Delete'; }, 3000); return; }
        api('DELETE', '/api/admin/members/' + r.id).then(function () { box.hidden = true; loadMembers(); status('mb-status-line', 'Deleted.', 'ok'); }).catch(function (e) { status('mb-status-line', e.message, 'err'); });
      });
    }
    btn('Close', 'ghost', function () { box.hidden = true; });
    top.appendChild(acts); box.appendChild(top);
    if (!editing) {
      var dl = el('dl', 'mb-dl');
      mb.columns.forEach(function (k) { if (!d[k]) return; dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', d[k])); });
      box.appendChild(dl);
    } else {
      var g = el('div', 'mb-grid'), inputs = {};
      mb.columns.forEach(function (k) { var w = el('div'); w.appendChild(el('label', '', k)); var i = el('input'); i.value = d[k] || ''; inputs[k] = i; w.appendChild(i); g.appendChild(w); });
      box.appendChild(g);
      var row = el('div', 'row'), sv = el('button', 'btn', r ? 'Save' : 'Add member'), st = el('span', 'status'); sv.type = 'button';
      sv.onclick = function () {
        var data = {}; mb.columns.forEach(function (k) { data[k] = inputs[k].value; });
        api(r ? 'PUT' : 'POST', '/api/admin/members' + (r ? '/' + r.id : ''), { data: data }).then(function (x) {
          showMember({ id: x.id, data: data }); loadMembers(); status('mb-status-line', 'Saved.', 'ok');
        }).catch(function (e) { st.textContent = e.message; st.className = 'status err'; });
      };
      row.appendChild(sv); row.appendChild(st); box.appendChild(row);
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('mb-add').onclick = function () {
    if (!mb.columns.length) return status('mb-status-line', 'Import the master list first, so the app knows the columns.', 'err');
    showMember(null, true);
  };
  // A small CSV reader: quoted fields, commas and new lines inside quotes, "" for a quote.
  function parseCSV(text) {
    var rows = [], row = [], f = '', q = false, i = 0, c;
    text = text.replace(/^﻿/, '');
    for (; i < text.length; i++) {
      c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
  }
  $('mb-import').onclick = function () {
    var f = $('mb-file').files[0];
    if (!f) return status('mb-status-line', 'Pick the file first.', 'err');
    status('mb-status-line', 'Reading the file…');
    f.text().then(function (txt) {
      var body;
      if (/\.json$/i.test(f.name) || /^\s*\{/.test(txt)) {
        try { body = JSON.parse(txt); } catch (e) { throw new Error("That file isn't a Crew Hours members file."); }
        if (body.format && body.format !== 'crewhours-members-1') throw new Error('That is the hours/roads import file. Upload it under Settings → Import from another system.');
      } else {
        var rows = parseCSV(txt); if (rows.length < 2) throw new Error('The CSV needs a header row and at least one member.');
        var cols = rows[0].map(function (x) { return x.trim(); });
        body = { columns: cols, rows: rows.slice(1).map(function (r) { var o = {}; cols.forEach(function (k, i) { o[k] = r[i] || ''; }); return o; }) };
      }
      if (!confirm('Replace the members list with the ' + (body.rows ? body.rows.length : 0) + ' rows in this file?')) throw new Error('Cancelled.');
      status('mb-status-line', 'Importing…');
      return api('POST', '/api/admin/members/import', { columns: body.columns, rows: body.rows });
    }).then(function (r) {
      status('mb-status-line', 'Imported ' + r.rows + ' members with ' + r.columns + ' columns.', 'ok'); $('mb-file').value = ''; $('mb-q').value = ''; loadMembers();
    }).catch(function (e) { status('mb-status-line', e.message, 'err'); });
  };

  /* ------------------------------ meter readings ------------------------------ */
  var mr = { data: null, edit: null };
  function nfmt(v) { return v == null ? '' : Number(v).toLocaleString(); }
  function quarterLabel(q) { var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], n = Number(q.slice(6)); return 'Q' + n + ' ' + q.slice(0, 4) + ' (' + M[(n - 1) * 3] + '–' + M[(n - 1) * 3 + 2] + ')'; }
  function fillQuarters(current) {   // this quarter and the 11 before it
    var sel = $('mr-month'); if (sel.options.length) return;
    var y = Number(current.slice(0, 4)), n = Number(current.slice(6));
    for (var i = 0; i < 12; i++) { var q = y + '-Q' + n, o = el('option', '', quarterLabel(q)); o.value = q; sel.appendChild(o); n--; if (!n) { n = 4; y--; } }
  }
  function loadMeterAdmin() {
    var q = $('mr-month').value;
    return api('GET', '/api/admin/meters?all=1' + (q ? '&quarter=' + q : '')).then(function (r) {
      mr.data = r; fillQuarters(r.thisQuarter); $('mr-month').value = r.quarter;
      $('mr-csv').href = '/api/admin/meters.csv?quarter=' + r.quarter; drawMeterAdmin(); loadNotOnRoute();
    }).catch(function (e) { status('mr-status', e.message, 'err'); });
  }
  $('mr-month').onchange = loadMeterAdmin;
  $('mr-q').oninput = function () { if (mr.data) drawMeterAdmin(); };
  $('mr-show').onchange = function () { if (mr.data) drawMeterAdmin(); };
  function drawMeterAdmin() {
    var d = mr.data, q = $('mr-q').value.trim().toLowerCase(), show = $('mr-show').value, body = $('mr-body'); body.innerHTML = '';
    var active = d.meters.filter(function (m) { return m.active; });
    var checks = active.filter(function (m) { return m.nameCheck; }).length;
    $('mr-progress').textContent = d.read + ' of ' + d.toRead + ' meters read for ' + d.label + (checks ? ' · ' + checks + ' names to check' : '');
    var shown = 0;
    d.meters.forEach(function (m) {
      if (show === 'inactive' ? m.active : !m.active) return;
      if (show === 'unread' && (m.current != null || !m.meterNo)) return;
      if (show === 'read' && m.current == null) return;
      if (show === 'low' && !(m.usage != null && m.usage < 0)) return;
      if (show === 'check' && !m.nameCheck) return;
      if (q && [m.seq, m.account, m.name, m.oldName, m.qbCustomer, m.address, m.meterNo].join(' ').toLowerCase().indexOf(q) === -1) return;
      shown++;
      var tr = el('tr', m.current != null ? 'done' : '');
      tr.appendChild(el('td', 'num', String(m.seq)));
      tr.appendChild(el('td', '', m.account));
      var nm = el('td', ''); nm.appendChild(document.createTextNode(m.name || '')); if (m.nameCheck) nm.appendChild(el('span', 'chk', 'Check'));
      if (m.oldName && m.oldName !== m.name) nm.appendChild(el('span', 'old', 'Was: ' + m.oldName));
      if (m.qbCustomer && m.qbCustomer !== m.name) nm.appendChild(el('span', 'old', 'QuickBooks: ' + m.qbCustomer));
      tr.appendChild(nm);
      tr.appendChild(el('td', '', m.address));
      tr.appendChild(el('td', '', m.meterNo || 'no meter'));
      tr.appendChild(el('td', 'num', nfmt(m.previous)));
      var ct = el('td', 'num'), inp = el('input', 'cur'); inp.inputMode = 'numeric'; inp.value = m.current != null ? String(m.current) : ''; inp.setAttribute('aria-label', 'Current reading for ' + m.name);
      var was = inp.value;
      inp.onchange = function () {
        var v = inp.value.replace(/[,\s]/g, '');
        if (v !== '' && !/^\d+(\.\d+)?$/.test(v)) { status('mr-status', 'Readings are numbers only.', 'err'); return; }
        api('POST', '/api/admin/meters/' + m.id + '/read', { reading: v, quarter: d.quarter }).then(function () { was = v; return loadMeterAdmin(); })
          .catch(function (e) { inp.value = was; status('mr-status', e.message, 'err'); });
      };
      ct.appendChild(inp); tr.appendChild(ct);
      tr.appendChild(el('td', 'num' + (m.usage != null && m.usage < 0 ? ' warn' : ''), m.usage == null ? '' : nfmt(m.usage)));
      tr.appendChild(el('td', '', m.readBy || ''));
      var et = el('td'), eb = el('button', 'btn ghost small', mr.edit === m.id ? 'Close' : 'Edit'); eb.type = 'button';
      eb.onclick = function () { mr.edit = mr.edit === m.id ? null : m.id; drawMeterAdmin(); };
      et.appendChild(eb); tr.appendChild(et);
      body.appendChild(tr);
      if (mr.edit === m.id) body.appendChild(meterEditRow(m));
    });
    $('mr-empty').hidden = shown > 0;
    $('mr-empty').textContent = d.meters.length ? 'No meters match.' : 'No meters yet. Import the meter list below.';
  }
  function meterEditRow(m) {
    var tr = el('tr', 'mr-edit'), td = el('td'); td.colSpan = 10;
    var g = el('div', 'mb-grid'), f = {};
    [['seq', 'Read sequence', m.seq], ['account', 'Act #', m.account], ['meterNo', 'Meter ID', m.meterNo], ['name', 'Customer name', m.name], ['qbCustomer', 'QuickBooks customer', m.qbCustomer], ['address', 'Service address', m.address], ['notes', 'Notes', m.notes]]
      .forEach(function (x) { var w = el('div'); w.appendChild(el('label', '', x[1])); var i = el('input'); i.value = x[2] == null ? '' : x[2]; f[x[0]] = i; w.appendChild(i); g.appendChild(w); });
    td.appendChild(g);
    var row = el('div', 'row'); row.style.marginTop = '10px';
    var ck = el('label', 'check'), cki = el('input'); cki.type = 'checkbox'; cki.checked = m.nameCheck; ck.appendChild(cki); ck.appendChild(document.createTextNode(' Name needs checking'));
    var ac = el('label', 'check'), aci = el('input'); aci.type = 'checkbox'; aci.checked = m.active; ac.appendChild(aci); ac.appendChild(document.createTextNode(' On the route'));
    var sv = el('button', 'btn small', 'Save'), st = el('span', 'status'); sv.type = 'button';
    sv.onclick = function () {
      var b = { quarter: mr.data.quarter, nameCheck: cki.checked, active: aci.checked }; Object.keys(f).forEach(function (k) { b[k] = f[k].value; });
      api('PUT', '/api/admin/meters/' + m.id, b).then(function (r) { mr.edit = null; mr.data = r; drawMeterAdmin(); status('mr-status', 'Saved.', 'ok'); })
        .catch(function (e) { st.textContent = e.message; st.className = 'status err'; });
    };
    [ck, ac, sv, st].forEach(function (n) { row.appendChild(n); }); td.appendChild(row);
    if (m.oldName && m.oldName !== m.name) td.appendChild(el('p', 'hint', 'Name on the old meter sheet: ' + m.oldName));
    tr.appendChild(td); return tr;
  }
  $('mr-import').onclick = function () {
    var file = $('mr-file').files[0];
    if (!file) return status('mr-status', 'Pick the meter list file first.', 'err');
    status('mr-status', 'Importing…');
    if (isExcel(file)) return sendMeterExcel(file).then(function (r) {
      status('mr-status', 'Imported ' + r.meters + ' meters from Excel' + (r.readings ? ' and ' + r.readings + ' current readings.' : '.'), 'ok'); $('mr-file').value = ''; return loadMeterAdmin();
    }).catch(function (e) { status('mr-status', e.message, 'err'); });
    if (/\.xls$/i.test(file.name)) return status('mr-status', 'That is an old-style .xls file. Open it in Excel and save it as .xlsx, then try again.', 'err');
    file.text().then(function (txt) {
      var b; try { b = JSON.parse(txt.replace(/^﻿/, '')); } catch (e) { throw new Error(/^%PDF/.test(txt) ? "That's a PDF. Pick the .json file Claude made." : "That file isn't a meter list file."); }
      if (b.format !== 'crewhours-meters-1') throw new Error("That file isn't a meter list file.");
      return api('POST', '/api/admin/meters/import', { meters: b.meters });
    }).then(function (r) { status('mr-status', 'Imported ' + r.meters + ' meters.', 'ok'); $('mr-file').value = ''; return loadMeterAdmin(); })
      .catch(function (e) { status('mr-status', e.message, 'err'); });
  };

  /* --------------------------- Google Drive backup --------------------------- */
  function drawDrive() {
    var g = me.gdrive || {}, st = $('gd-state'); st.innerHTML = '';
    if (!g.available) { st.appendChild(el('span', 'hint', 'Not switched on yet: the app needs its Google keys (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Render). See LAUNCH.md, step 8.')); }
    else if (g.connected) {
      st.appendChild(el('span', '', 'Connected to ' + (g.email || 'Google Drive') + '. '));
      st.appendChild(el('span', g.error ? 'warn' : 'muted', g.error ? 'Last backup failed: ' + g.error : g.lastAt ? 'Last backup: ' + new Date(g.lastAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : 'First backup is running.'));
    } else st.appendChild(el('span', 'muted', 'Not connected.'));
    $('gd-connect').hidden = !g.available || (g.connected && !g.error);
    $('gd-connect').textContent = g.connected ? 'Reconnect Google Drive' : 'Connect Google Drive';
    $('gd-now').hidden = !g.connected; $('gd-off').hidden = !g.connected;
  }
  $('gd-connect').onclick = function () { location.href = '/api/admin/google/connect'; };
  $('gd-now').onclick = function () {
    status('gd-status', 'Backing up… (photos can take a minute)');
    api('POST', '/api/admin/google/backup').then(function (r) { status('gd-status', 'Done. Saved ' + r.file + (r.photos ? ' and ' + r.photos + ' new photos.' : '.'), 'ok'); return loadMe(); })
      .catch(function (e) { status('gd-status', e.message, 'err'); loadMe(); });
  };
  var gdArmed = false;
  $('gd-off').onclick = function () {
    if (!gdArmed) { gdArmed = true; $('gd-off').textContent = 'Tap again to disconnect'; setTimeout(function () { gdArmed = false; $('gd-off').textContent = 'Disconnect'; }, 3000); return; }
    gdArmed = false; api('POST', '/api/admin/google/disconnect').then(function () { status('gd-status', 'Disconnected. Backups already in your Drive stay there.', 'ok'); return loadMe(); })
      .catch(function (e) { status('gd-status', e.message, 'err'); });
  };

  /* Excel meter list → server (raw bytes). */
  function sendMeterExcel(file) {
    return file.arrayBuffer().then(function (buf) {
      return fetch('/api/admin/meters/import-xlsx', { method: 'POST', credentials: 'same-origin', headers: { 'x-ch': '1', 'Content-Type': 'application/octet-stream' }, body: buf });
    }).then(function (r) { return r.json().catch(function () { return { error: 'Something went wrong. Try again.' }; }); })
      .then(function (r) { if (r.error) throw new Error(r.error); return r; });
  }
  function isExcel(file) { return /\.xlsx$/i.test(file.name); }

  /* ---------------------- add a meter / properties not on the route ---------------------- */
  var nr = [];
  function openAddMeter(p) {
    $('ma-form').hidden = false; $('ma-status').textContent = '';
    $('ma-title').textContent = p ? 'Add ' + p.address + ' to the route' : 'Add a meter';
    $('ma-seq').value = p && p.suggestSeq ? p.suggestSeq : ''; $('ma-name').value = p ? (p.names[0] || '') : ''; $('ma-address').value = p ? p.address : '';
    ['ma-meter', 'ma-account', 'ma-start', 'ma-qb', 'ma-notes'].forEach(function (id) { $(id).value = ''; });
    $('ma-hint').textContent = p && p.suggestSeq ? 'Suggested spot: right after the last meter on the same street (read sequence ' + (p.suggestSeq - 1) + '). Meters from there on move down one.' : 'Leave Read sequence blank to put it at the end of the route. Meters from that spot on move down one.';
    $('ma-form').scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(function () { (p ? $('ma-meter') : $('ma-name')).focus(); }, 300);
  }
  $('mr-add').onclick = function () { openAddMeter(null); };
  $('ma-cancel').onclick = function () { $('ma-form').hidden = true; };
  $('ma-form').onsubmit = function (e) {
    e.preventDefault();
    var b = { seq: $('ma-seq').value.trim(), name: $('ma-name').value, address: $('ma-address').value, meterNo: $('ma-meter').value, account: $('ma-account').value,
      startReading: $('ma-start').value.replace(/[,\s]/g, ''), qbCustomer: $('ma-qb').value, notes: $('ma-notes').value, quarter: mr.data && mr.data.quarter };
    status('ma-status', 'Adding…');
    api('POST', '/api/admin/meters', b).then(function (r) {
      mr.data = r; $('ma-form').hidden = true; drawMeterAdmin(); loadNotOnRoute();
      var m = r.meters.filter(function (x) { return x.id === r.id; })[0];
      status('mr-status', 'Added ' + (b.name || b.address) + ' at read sequence ' + (m ? m.seq : '') + '.', 'ok');
      $('mr-q').value = b.address || b.name; drawMeterAdmin();
    }).catch(function (err) { status('ma-status', err.message, 'err'); });
  };
  function loadNotOnRoute() {
    return api('GET', '/api/admin/meters/not-on-route').then(function (r) { nr = r.properties; drawNotOnRoute(); }).catch(function () {});
  }
  $('nr-show').onchange = drawNotOnRoute;
  function drawNotOnRoute() {
    var show = $('nr-show').value, body = $('nr-body'); body.innerHTML = '';
    var BUILD = { Home: 1, Condo: 1, Villa: 1, Comm: 1 };
    var list = nr.filter(function (p) { return show === 'skipped' ? p.skipped : !p.skipped && (show === 'all' || BUILD[p.type]); });
    var open = nr.filter(function (p) { return !p.skipped; }), b = open.filter(function (p) { return BUILD[p.type]; }).length;
    $('nr-count').textContent = open.length ? b + ' with a building, ' + (open.length - b) + ' lots, hangars and garages' + (nr.length > open.length ? ' · ' + (nr.length - open.length) + ' marked not needed' : '') : 'Every property on the members list is on the route.';
    list.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', '', p.address)); tr.appendChild(el('td', '', p.type)); tr.appendChild(el('td', '', p.parcel)); tr.appendChild(el('td', '', p.names.join('; ')));
      var td = el('td'); td.style.whiteSpace = 'nowrap';
      if (!p.skipped) { var add = el('button', 'btn small', 'Add to route'); add.type = 'button'; add.onclick = function () { openAddMeter(p); }; td.appendChild(add); td.appendChild(document.createTextNode(' ')); }
      var sk = el('button', 'btn ghost small', p.skipped ? 'Put back' : 'Not needed'); sk.type = 'button';
      sk.onclick = function () { api('POST', '/api/admin/meters/skip', { address: p.address, skip: !p.skipped }).then(function (r) { nr = r.properties; drawNotOnRoute(); }).catch(function (e) { status('mr-status', e.message, 'err'); }); };
      td.appendChild(sk); tr.appendChild(td); body.appendChild(tr);
    });
    $('nr-empty').hidden = list.length > 0;
    $('nr-empty').textContent = show === 'skipped' ? 'Nothing marked not needed.' : nr.length ? 'Nothing to show here.' : 'Import the members list (Members tab) to see which properties are missing from the route.';
  }

  // Phone photos are huge: shrink to 1600 px JPEG before sending.
  function shrinkImage(file) {
    return new Promise(function (ok, fail) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { var s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); ok(c.toDataURL('image/jpeg', 0.8)); };
      img.onerror = function () { URL.revokeObjectURL(url); fail(new Error("Couldn't read that picture.")); };
      img.src = url;
    });
  }
})();
