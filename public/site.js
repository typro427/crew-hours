// Shared form handling for sign up / log in / forgot / reset.
(function () {
  var tz = document.getElementById('timezone');
  if (tz) { try { tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {} }
  var tok = document.getElementById('token');
  if (tok) tok.value = location.hash.slice(1);
  document.querySelectorAll('form[data-endpoint]').forEach(function (form) {
    var status = form.querySelector('.status'), btn = form.querySelector('button[type=submit]');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = v; });
      btn.disabled = true; status.className = 'status'; status.textContent = 'One moment…';
      fetch(form.getAttribute('data-endpoint'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ch': '1' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json(); })
        .then(function (r) {
          if (r.error) { status.className = 'status err'; status.textContent = r.error; btn.disabled = false; return; }
          var done = form.getAttribute('data-done');
          if (done) { status.className = 'status ok'; status.textContent = done; return; }
          location.href = form.getAttribute('data-next') || '/admin';
        })
        .catch(function () { status.className = 'status err'; status.textContent = "Couldn't connect. Check your internet and try again."; btn.disabled = false; });
    });
  });
})();
