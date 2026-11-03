// Owner portal (water customers). Sign in by address -> emailed link; then usage, alerts, reports, notices, documents.
(function () {
  var SLUG = document.body.getAttribute('data-slug'), API = '/api/p/' + SLUG;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function say(id, msg, cls) { var s = $(id); s.textContent = msg || ''; s.className = 'status' + (cls ? ' ' + cls : ''); }
  function api(method, path, body) {
    var o = { method: method, credentials: 'same-origin', headers: { 'x-ch': '1' } };
    if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(API + path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Try again.'); e.status = r.status; e.code = j.error; throw e; }
        return j;
      });
    }, function () { throw new Error('No connection. Try again when you have signal.'); });
  }
  var num = function (n) { return Number(n || 0).toLocaleString(); };
  var money = function (n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pretty(d) { return d ? MON[Number(d.slice(5, 7)) - 1] + ' ' + Number(d.slice(8, 10)) : ''; }

  /* ------------------------------ sign in ------------------------------ */
  var picked = null, timer = null;
  function showSignin() { $('signin').hidden = false; $('home').hidden = true; $('who').hidden = true; setTimeout(function () { $('addr').focus(); }, 50); }
  $('addr').oninput = function () {
    clearTimeout(timer); picked = null; $('si-sent').hidden = true; $('si-acct').hidden = true; $('si-pending').hidden = true; say('si-status', '');
    var q = $('addr').value.trim();
    if (q.length < 2) { $('addr-sug').innerHTML = ''; return; }
    timer = setTimeout(function () {
      api('GET', '/addresses?q=' + encodeURIComponent(q)).then(function (r) {
        var box = $('addr-sug'); box.innerHTML = '';
        if (!r.addresses.length) { box.appendChild(el('p', 'hint', 'No match yet. Try just the house number and street name.')); return; }
        r.addresses.forEach(function (a) {
          var b = el('button', '', a.address); b.type = 'button';
          b.onclick = function () { pick(a); };
          box.appendChild(b);
        });
      }).catch(function (e) { say('si-status', e.message, 'err'); });
    }, 250);
  };
  function pick(a) {
    picked = a; $('addr').value = a.address; $('addr-sug').innerHTML = '';
    say('si-status', 'Sending your sign-in link…');
    api('POST', '/start', { meterId: a.id }).then(function (r) {
      say('si-status', '');
      if (r.sent) { $('si-sent').hidden = false; $('si-sent-to').textContent = 'We emailed a sign-in link to ' + r.to.join(' and ') + '.'; }
      else showAccount();
    }).catch(function (e) { say('si-status', e.message, 'err'); });
  }
  function showAccount() { $('si-sent').hidden = true; $('si-acct').hidden = false; $('si-acct-addr').textContent = picked ? picked.address : ''; $('si-account').focus(); }
  $('si-noemail').onclick = showAccount;
  $('si-acct').onsubmit = function (e) {
    e.preventDefault();
    if (!picked) return say('si-status', 'Pick your address first.', 'err');
    say('si-status', 'Sending…');
    api('POST', '/request', { meterId: picked.id, account: $('si-account').value, name: $('si-name').value, email: $('si-email').value, phone: $('si-phone').value })
      .then(function () { say('si-status', ''); $('si-acct').hidden = true; $('si-pending').hidden = false; })
      .catch(function (e2) { say('si-status', e2.message, 'err'); });
  };

  /* ------------------------------ signed in ------------------------------ */
  var data = null, cur = 0;
  function load() {
    return api('GET', '/me').then(function (r) { data = r; showHome(); })
      .catch(function (e) { if (e.status === 401) showSignin(); else { showSignin(); say('si-status', e.message, 'err'); } });
  }
  $('logout').onclick = function () { api('POST', '/logout').then(function () { location.reload(); }); };
  function showHome() {
    $('signin').hidden = true; $('home').hidden = false; $('who').hidden = false; $('who-email').textContent = data.email;
    drawNotices();
    var sel = $('prop'); sel.innerHTML = '';
    data.properties.forEach(function (p, i) { var o = el('option', '', p.address); o.value = i; sel.appendChild(o); });
    sel.hidden = data.properties.length < 2; sel.value = String(cur);
    sel.onchange = function () { cur = Number(sel.value); drawProperty(); };
    drawProperty();
  }
  function drawNotices() {
    var box = $('notices'); box.innerHTML = '';
    var TAG = { boil: 'Boil water notice', shutoff: 'Planned water shutoff', alert: 'Important', info: 'Notice' };
    data.notices.forEach(function (n) {
      var c = el('div', 'notice ' + n.kind);
      c.appendChild(el('span', 'tag', TAG[n.kind] || 'Notice'));
      c.appendChild(el('b', '', n.title));
      if (n.body) c.appendChild(el('p', '', n.body));
      c.appendChild(el('span', 'when', n.ends ? pretty(n.starts) + ' – ' + pretty(n.ends) : 'Since ' + pretty(n.starts)));
      box.appendChild(c);
    });
  }
  function drawProperty() {
    var box = $('property'); box.innerHTML = '';
    var p = data.properties[cur];
    if (!p) { box.appendChild(el('div', 'card', 'No property is linked to this sign-in yet. Call the office.')); $('docs-card').hidden = true; return; }
    var card = el('section', 'card');
    card.appendChild(el('h2', 'pt-addr', p.address));
    card.appendChild(el('div', 'pt-meta', (p.account ? 'Account ' + p.account + ' · ' : '') + (p.meterNo ? 'Meter ' + p.meterNo : '')));
    if (p.alert) {
      var a = el('div', 'pt-alert');
      a.appendChild(el('b', '', '⚠ Your water use is much higher than usual' + (p.alert.times ? ' (' + p.alert.times + '×)' : '') + '.'));
      a.appendChild(el('span', '', 'That can mean a leak at your place: a running toilet, a dripping outside tap or a broken line. Check, or report a problem below and we\'ll take a look at the meter.'));
      card.appendChild(a);
    }
    // this quarter
    var b = data.billing, c = p.current, inc = b.allowance;
    var q = el('div', ''); q.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    q.appendChild(el('div', 'pt-meta', p.thisQuarter));
    if (!c) q.appendChild(el('div', '', 'Not read yet this quarter. Meters are read once a quarter.'));
    else if (c.starting || c.gallons == null) q.appendChild(el('div', '', 'Reading: ' + num(c.reading) + '. This is the first reading on the new system, so it\'s the starting point; your use shows from next quarter.'));
    else {
      q.appendChild(el('div', 'pt-big', num(c.gallons) + ' gal'));
      if (inc) {
        var over = Math.max(0, c.gallons - inc), bar = el('div', 'pt-bar' + (over ? ' over' : '')), fill = el('i');
        fill.style.width = Math.min(100, Math.round(c.gallons / inc * 100)) + '%'; bar.appendChild(fill); q.appendChild(bar);
        q.appendChild(el('div', 'pt-meta', over ? num(over) + ' gallons over the ' + num(inc) + ' included' + (b.overRate ? ' (about ' + money(over * b.overRate) + ' extra)' : '') + '.'
          : num(inc - c.gallons) + ' of the ' + num(inc) + ' gallons included are left.'));
      }
    }
    card.appendChild(q);
    // last quarters
    var qs = p.quarters.filter(function (x) { return x.gallons != null; });
    if (qs.length) {
      card.appendChild(el('div', 'pt-meta', 'Water used per quarter (gallons)'));
      var top = Math.max.apply(null, qs.map(function (x) { return x.gallons; }).concat([1])), max = inc && top > inc * 0.6 ? Math.max(top, inc) : top;   // scale to their use
      var ch = el('div', 'pt-chart');
      qs.forEach(function (x) {
        var col = el('div', 'pt-col'), bb = el('div', 'b' + (inc && x.gallons > inc ? ' over' : ''));
        bb.style.height = Math.max(2, Math.round(x.gallons / max * 110)) + 'px';
        col.appendChild(el('div', 'v', num(x.gallons))); col.appendChild(bb); col.appendChild(el('div', 'q', x.quarter.slice(5) + ' ' + x.quarter.slice(2, 4)));
        ch.appendChild(col);
      });
      card.appendChild(ch);
    }
    box.appendChild(card);
    drawReports(p); drawDocs(p);
  }
  function drawReports(p) {
    var box = $('reports'); box.innerHTML = '';
    if (!p.reports.length) return;
    box.appendChild(el('div', 'pt-meta', 'Your reports'));
    var l = el('div', 'pt-list');
    p.reports.forEach(function (r) {
      var row = el('div', 'row'), left = el('div');
      left.appendChild(el('div', '', r.title)); left.appendChild(el('span', '', 'Sent ' + pretty(r.reported)));
      row.appendChild(left);
      row.appendChild(el('span', 'pt-pill ' + (r.status === 'done' ? 'done' : 'open'), r.status === 'done' ? 'Fixed ' + pretty(r.fixed) : 'Open'));
      l.appendChild(row);
    });
    box.appendChild(l);
  }
  function drawDocs(p) {
    var box = $('docs'); box.innerHTML = '';
    var list = p.docs.map(function (d) { d.mine = true; return d; }).concat(data.docs);
    $('docs-card').hidden = !list.length;
    var l = el('div', 'pt-list');
    list.forEach(function (d) {
      var row = el('div', 'row'), a = el('a', '', d.title); a.href = API + '/docs/' + d.id; a.target = '_blank'; a.rel = 'noopener';
      row.appendChild(a); row.appendChild(el('span', '', (d.mine ? 'Your property · ' : '') + (d.mime === 'application/pdf' ? 'PDF' : 'Image')));
      l.appendChild(row);
    });
    box.appendChild(l);
  }

  /* ------------------------------ report a problem ------------------------------ */
  var pics = [];
  (function photos() {
    var box = $('rep-photos'), th = el('div', 'thumbs'), lab = el('label', 'photo-btn', '📷 Add a photo (optional)'), inp = el('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; lab.appendChild(inp);
    function draw() {
      th.innerHTML = '';
      pics.forEach(function (src, i) { var x = el('div', 'x'), im = el('img'); im.src = src; im.alt = 'Photo'; var d = el('button', '', '×'); d.type = 'button'; d.setAttribute('aria-label', 'Remove photo');
        d.onclick = function () { pics.splice(i, 1); draw(); }; x.appendChild(im); x.appendChild(d); th.appendChild(x); });
      lab.hidden = pics.length >= 4;
    }
    inp.onchange = function () {
      var files = Array.prototype.slice.call(inp.files || [], 0, 4 - pics.length); inp.value = '';
      files.reduce(function (p, f) { return p.then(function () { return shrink(f).then(function (d) { pics.push(d); }); }); }, Promise.resolve()).then(draw)
        .catch(function (e) { say('rep-status', e.message, 'err'); });
    };
    box.appendChild(th); box.appendChild(lab); draw();
    $('rep').reset2 = function () { pics = []; draw(); };
  })();
  function shrink(file) {
    return new Promise(function (ok, fail) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        ok(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () { URL.revokeObjectURL(url); fail(new Error("That photo couldn't be opened.")); };
      img.src = url;
    });
  }
  $('rep').onsubmit = function (e) {
    e.preventDefault();
    var p = data && data.properties[cur];
    if (!p) return;
    if (!$('rep-title').value.trim()) return say('rep-status', 'Say what the problem is.', 'err');
    say('rep-status', pics.length ? 'Sending photos…' : 'Sending…');
    api('POST', '/report', { meterId: p.meterId, title: $('rep-title').value, details: $('rep-details').value, phone: $('rep-phone').value, photos: pics.slice() })
      .then(function (r) { data = r; $('rep-title').value = ''; $('rep-details').value = ''; $('rep').reset2(); drawProperty(); say('rep-status', 'Sent. The water crew has it.', 'ok'); })
      .catch(function (e2) { say('rep-status', e2.message, 'err'); });
  };

  load();
})();
