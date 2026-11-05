
/* ================= UTILITIES ================= */
const $view = document.getElementById("view");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
let TODAY = iso(new Date());
const addDays = (s,n) => { const d = parse(s); d.setDate(d.getDate()+n); return iso(d); };
const addMonths = (s,n) => { const d = parse(s), day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth()+n); const last = new Date(d.getFullYear(), d.getMonth()+1, 0).getDate(); d.setDate(Math.min(day,last)); return iso(d); };
const daysBetween = (a,b) => Math.round((parse(b)-parse(a))/864e5);
const nice = s => s ? parse(s).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "—";
const short = s => parse(s).toLocaleDateString("en-US",{month:"short",day:"numeric"});
const fmt = (n,d=2) => n==null||isNaN(n) ? "—" : Number(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const uid = () => Math.random().toString(36).slice(2,9);
const FREQS = [[1,"Monthly"],[3,"Quarterly"],[6,"Every 6 months"],[12,"Yearly"],[24,"Every 2 years"],[36,"Every 3 years"],[72,"Every 6 years"],[108,"Every 9 years"]];
const freqName = m => (FREQS.find(f=>f[0]===+m)||[0,`Every ${m} months`])[1];

/* ================= SERVER ================= */
// Two ways in: the crew app (managers, /c/<link>/compliance, PIN sign-in) or the dashboard (/compliance, the boss).
const SLUG = document.body.getAttribute("data-slug");
const CREW = /^\/c\//.test(location.pathname);
const API = CREW ? "/api/c/" + SLUG + "/cw" : "/api/admin/cw";
let TOKEN = null; try { TOKEN = sessionStorage.getItem("crewToken:" + SLUG); } catch (e) {}
document.getElementById("back").href = CREW ? "./" : "/admin";
document.getElementById("back").textContent = CREW ? "‹ Crew app" : "‹ Dashboard";
let DB = null;
function oops(msg){ const e = document.getElementById("err"); e.textContent = msg || ""; e.hidden = !msg; }
function api(method, path, body){
  const h = { "x-ch": "1" }; if (body) h["Content-Type"] = "application/json"; if (CREW && TOKEN) h.Authorization = "Bearer " + TOKEN;
  return fetch(API + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" })
    .then(r => r.json().catch(() => ({})).then(j => {
      if (r.status === 401 || j.error === "SESSION_EXPIRED") { signIn(); throw new Error("Please sign in again."); }
      if (!r.ok) throw new Error(j.error || "Something went wrong. Try again.");
      return j;
    }), e => { throw new Error(navigator.onLine === false ? "No internet connection. Try again when you have signal." : (e.message || "Couldn't reach the server.")); });
}
function signIn(){
  $view.innerHTML = `<div class="card"><h2>Please sign in</h2><p class="small muted">${CREW ? "Open the crew app, enter your PIN, then tap Compliance." : "Log in to the dashboard, then open Compliance."}</p><a class="btn primary" href="${CREW ? "./" : "/login"}">${CREW ? "Open the crew app" : "Log in"}</a></div>`;
  document.getElementById("tabs").innerHTML = "";
}
/** Send a change; the server sends everything back, and the screen redraws. */
function change(method, path, body, after){
  oops("");
  return api(method, path, body).then(d => { DB = d; TODAY = d.today; if (after) after(); else render(); return d; })
    .catch(e => { oops(e.message); throw e; });
}
/* ================= STATUS LOGIC ================= */
const nextDue = x => x.last ? addMonths(x.last, x.months) : TODAY;
function status(due){
  const d = daysBetween(TODAY, due);
  if(d < 0) return {k:"crit", label:`Overdue ${-d} day${d===-1?"":"s"}`, d};
  if(d <= 30) return {k:"warn", label: d===0 ? "Due today" : `Due in ${d} day${d===1?"":"s"}`, d};
  return {k:"good", label:`Due ${d>300?nice(due):short(due)}`, d};
}
// never recorded: ask for the last date rather than calling it due today
const stOf = x => x.last ? status(nextDue(x)) : {k:"warn", label:"Add last date", d:0};
const ICON = {
  crit:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 17h.01"/></svg>',
  warn:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 7v5l3 2"/></svg>',
  good:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
};
const badge = s => `<span class="badge ${s.k}">${ICON[s.k]}${esc(s.label)}</span>`;
function allDue(){
  return [...DB.samples.map(x=>({...x, group:"Sample"})), ...DB.assets.map(x=>({...x, group:x.kind}))]
    .map(x => ({...x, due: nextDue(x), st: stOf(x)})).sort((a,b)=>a.st.d-b.st.d);
}
const logFor = date => DB.logs.find(l=>l.date===date);
const sortedLogs = () => DB.logs.slice().sort((a,b)=>a.date<b.date?-1:1);

/* ================= ROUTER ================= */
const TABS = [
  ["home","Home",'<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  ["log","Daily log",'<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2"/><path d="M9 12h6M9 16h4"/>'],
  ["samples","Samples",'<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 15h9"/>'],
  ["testing","Testing",'<path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z"/><path d="M9 12l2 2 4-4"/>'],
  ["report","Report",'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
];
function route(){ const h = location.hash.slice(1); return ["home","log","samples","testing","report","settings"].includes(h) ? h : "home"; }
function go(r){ if(location.hash.slice(1)===r) render(); else location.hash = r; }
window.addEventListener("hashchange", render);
document.addEventListener("click", e => { const g = e.target.closest("[data-go]"); if(g){ e.preventDefault(); go(g.dataset.go); } });

function render(){
  if(!DB) return;
  const r = route();
  document.getElementById("sysname").textContent = DB.system.name;
  document.getElementById("tabs").innerHTML = TABS.map(([id,label,path]) =>
    `<a href="#${id}" class="${r===id?"on":""}" aria-current="${r===id?"page":"false"}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${path}</svg>${label}</a>`).join("");
  ({home:Home, log:Log, samples:Samples, testing:Testing, report:Report, settings:Settings})[r]();
  window.scrollTo(0,0);
}

/* ================= HOME ================= */
function Home(){
  const due = allDue(), over = due.filter(x=>x.st.k==="crit"), soon = due.filter(x=>x.st.k==="warn");
  const today = logFor(TODAY), logs = sortedLogs();
  const last30 = logs.filter(l => daysBetween(l.date, TODAY) <= 30);
  const low = last30.filter(l => l.dist < DB.system.minCl);
  const monthStart = TODAY.slice(0,8)+"01";
  const prod = production(monthStart, TODAY);
  $view.innerHTML = `
    <h1>Good ${new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}</h1>
    <p class="muted small" style="margin-bottom:14px">${nice(TODAY)}${DB.system.operator ? " · "+esc(DB.system.operator)+(DB.system.cert ? ", "+esc(DB.system.cert)+" operator" : "") : ' · <a href="#settings" style="color:var(--brand);font-weight:600">Add your system details</a>'}</p>
    ${today ? `<div class="alert good"><span class="badge good">${ICON.good}Logged</span><div class="small"><b>Today's readings are in.</b>Distribution free chlorine ${fmt(today.dist)} mg/L.</div></div>`
            : `<div class="alert warn"><span class="badge warn">${ICON.warn}To do</span><div class="small" style="flex:1"><b>Today's readings aren't logged yet.</b><button class="btn primary small" data-go="log" style="margin-top:8px">Log today's readings</button></div></div>`}
    ${over.length ? `<div class="alert crit"><span class="badge crit">${ICON.crit}${over.length} overdue</span><div class="small"><b>${esc(over.map(x=>x.name).join(", "))}</b>Collect or test as soon as possible, and check whether a monitoring violation applies.</div></div>` : ""}
    <div class="grid3" style="margin-bottom:14px">
      <div class="tile"><div class="big num" style="color:${over.length?"var(--crit-text)":"inherit"}">${over.length}</div><div class="lbl">Overdue</div></div>
      <div class="tile"><div class="big num">${soon.length}</div><div class="lbl">Due in 30 days</div></div>
      <div class="tile"><div class="big num">${(prod.total/1e6).toFixed(2)}</div><div class="lbl">MG pumped this month</div></div>
    </div>
    <div class="card">
      <div class="row between" style="align-items:flex-start;margin-bottom:6px">
        <div><h2 style="margin:0">Distribution free chlorine</h2><div class="muted tiny">Last 30 days, mg/L · Tennessee minimum ${DB.system.minCl} mg/L</div></div>
        ${low.length ? `<span class="badge crit">${ICON.crit}${low.length} day${low.length>1?"s":""} below min</span>` : `<span class="badge good">${ICON.good}All above min</span>`}
      </div>
      <div class="chartwrap" id="chart"></div>
      <div class="row between" style="margin-top:6px"><span class="tiny muted">Tap or hover the line for daily values.</span><button class="btn small" id="tblbtn">Show as table</button></div>
      <div id="tbl"></div>
    </div>
    <div class="card"><div class="row between" style="margin-bottom:6px"><h2 style="margin:0">Coming up</h2><a href="#samples" class="small" style="color:var(--brand);font-weight:600">All samples</a></div>
      ${due.slice(0,6).map(x=>`<div class="item"><div><div class="t">${esc(x.name)}</div><div class="s">${esc(x.group)} · ${freqName(x.months)}</div></div>${badge(x.st)}</div>`).join("")}
    </div>`;
  drawChart(document.getElementById("chart"), last30);
  document.getElementById("tblbtn").onclick = e => {
    const t = document.getElementById("tbl");
    if(t.innerHTML){ t.innerHTML=""; e.target.textContent="Show as table"; return; }
    e.target.textContent="Hide table";
    t.innerHTML = `<table style="margin-top:10px"><thead><tr><th>Date</th><th class="r">Entry point</th><th class="r">Distribution</th></tr></thead><tbody>${last30.slice().reverse().map(l=>`<tr><td>${short(l.date)}</td><td class="r num">${fmt(l.ep)}</td><td class="r num ${l.dist<DB.system.minCl?"flag":""}">${fmt(l.dist)}</td></tr>`).join("")}</tbody></table>`;
  };
}
function drawChart(el, data){
  if(data.length < 2){ el.innerHTML = '<p class="muted small">Log at least two days to see the trend.</p>'; return; }
  const W = Math.max(300, el.clientWidth || 640), H = 210, m = {t:12,r:12,b:26,l:34};
  const min = DB.system.minCl, maxV = Math.max(1, ...data.map(d=>d.dist)) * 1.1;
  const t0 = parse(data[0].date).getTime(), t1 = parse(data[data.length-1].date).getTime();
  const x = d => m.l + (parse(d.date).getTime()-t0)/(t1-t0||1)*(W-m.l-m.r);
  const y = v => m.t + (1 - v/maxV)*(H-m.t-m.b);
  const ticks = [0,0.25,0.5,0.75,1,1.25,1.5].filter(v=>v<=maxV);
  const path = data.map((d,i)=>`${i?"L":"M"}${x(d).toFixed(1)},${y(d.dist).toFixed(1)}`).join("");
  const xt = [data[0], data[Math.floor(data.length/2)], data[data.length-1]];
  el.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart of distribution free chlorine for the last 30 days, with the 0.2 mg/L minimum marked">
    ${ticks.map(v=>`<line x1="${m.l}" x2="${W-m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${m.l-6}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)" class="num">${v}</text>`).join("")}
    <line x1="${m.l}" x2="${W-m.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>
    <line x1="${m.l}" x2="${W-m.r}" y1="${y(min)}" y2="${y(min)}" stroke="var(--crit)" stroke-width="1.5" stroke-dasharray="5 4"/>
    <text x="${W-m.r}" y="${y(min)-6}" text-anchor="end" font-size="11.5" font-weight="600" fill="var(--crit-text)">TN minimum ${min}</text>
    ${xt.map(d=>`<text x="${x(d)}" y="${H-6}" text-anchor="${d===data[0]?"start":d===data[data.length-1]?"end":"middle"}" font-size="11" fill="var(--muted)">${short(d.date)}</text>`).join("")}
    <path d="${path}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${data.filter(d=>d.dist<min).map(d=>`<circle cx="${x(d)}" cy="${y(d.dist)}" r="5" fill="var(--crit)" stroke="var(--surface)" stroke-width="2"/>`).join("")}
    <line id="xh" y1="${m.t}" y2="${H-m.b}" stroke="var(--axis)" stroke-width="1" opacity="0"/>
    <circle id="dot" r="5" fill="var(--series)" stroke="var(--surface)" stroke-width="2" opacity="0"/>
    <rect x="${m.l}" y="0" width="${W-m.l-m.r}" height="${H}" fill="transparent" id="hit" style="cursor:crosshair;touch-action:pan-y"/>
  </svg><div class="tip" id="tip"></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector("#tip"), xh = el.querySelector("#xh"), dot = el.querySelector("#dot");
  const show = ev => {
    const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
    let best = data[0]; for(const d of data) if(Math.abs(x(d)-px) < Math.abs(x(best)-px)) best = d;
    const cx = x(best), cy = y(best.dist);
    xh.setAttribute("x1",cx); xh.setAttribute("x2",cx); xh.setAttribute("opacity",1);
    dot.setAttribute("cx",cx); dot.setAttribute("cy",cy); dot.setAttribute("opacity",1);
    tip.style.left = (cx * r.width / W) + "px"; tip.style.top = (cy * r.width / W) + "px"; tip.style.opacity = 1;
    tip.innerHTML = `<b>${short(best.date)}</b> · <span class="num">${fmt(best.dist)}</span> mg/L${best.dist<min?' <span class="flag">below min</span>':""}`;
  };
  const hide = () => { tip.style.opacity = 0; xh.setAttribute("opacity",0); dot.setAttribute("opacity",0); };
  const hit = el.querySelector("#hit");
  hit.addEventListener("pointermove", show); hit.addEventListener("pointerdown", show); hit.addEventListener("pointerleave", hide);
}

/* ================= DAILY LOG ================= */
function Log(editDate){
  const date = typeof editDate === "string" ? editDate : TODAY;
  const cur = logFor(date) || {};
  const prev = sortedLogs().filter(l=>l.date<date).pop();
  const logs = sortedLogs().reverse().slice(0,21);
  $view.innerHTML = `
    <h1>Daily log</h1><p class="muted small">Record readings once a day. Low chlorine gets flagged right away.</p>
    <form class="card" id="lf">
      <div class="grid2">
        <div class="field"><label for="f-date">Date</label><input type="date" id="f-date" value="${date}" max="${TODAY}"></div>
        <div class="field"><label for="f-meter">Master meter reading (gal)</label><input id="f-meter" inputmode="numeric" value="${cur.meter ?? ""}" placeholder="${prev ? prev.meter : ""}"><div class="hint">${prev?`Last: ${prev.meter.toLocaleString()} on ${short(prev.date)}`:""}</div></div>
        <div class="field"><label for="f-ep">Free chlorine, entry point (mg/L)</label><input id="f-ep" inputmode="decimal" value="${cur.ep ?? ""}" placeholder="e.g. 1.10"></div>
        <div class="field"><label for="f-dist">Free chlorine, distribution (mg/L)</label><input id="f-dist" inputmode="decimal" value="${cur.dist ?? ""}" placeholder="e.g. 0.55"><div class="hint" id="clwarn"></div></div>
        <div class="field"><label for="f-pump">Well pump run time (hours)</label><input id="f-pump" inputmode="decimal" value="${cur.pump ?? ""}"></div>
      </div>
      <div class="field"><label for="f-notes">Notes (flushing, repairs, complaints)</label><textarea id="f-notes">${esc(cur.notes||"")}</textarea></div>
      <div class="row wrap"><button class="btn primary" type="submit">${cur.date?"Update entry":"Save entry"}</button><span class="small muted" id="saved"></span>${cur.date?`<span class="by" style="margin-left:auto">${cur.by?"Logged by "+esc(cur.by):""}</span><button class="btn small danger" type="button" id="dellog">Delete</button>`:""}</div>
    </form>
    <div class="card"><h2>Recent entries</h2>
      <div style="overflow-x:auto"><table><thead><tr><th>Date</th><th class="r">Entry pt.</th><th class="r">Dist.</th><th class="r">Gallons</th><th></th></tr></thead><tbody>
      ${logs.map(l=>{ const p = sortedLogs().filter(z=>z.date<l.date).pop(); const g = p ? l.meter-p.meter : null;
        return `<tr><td>${short(l.date)}${l.notes?` <span title="${esc(l.notes)}" class="muted">✎</span>`:""}</td><td class="r num">${fmt(l.ep)}</td><td class="r num ${l.dist<DB.system.minCl?"flag":""}">${fmt(l.dist)}${l.dist<DB.system.minCl?" ⚠":""}</td><td class="r num">${g==null?"—":g.toLocaleString()}</td><td class="r"><button class="btn small" data-edit="${l.date}">Edit</button></td></tr>`; }).join("")}
      </tbody></table></div></div>`;
  const distIn = document.getElementById("f-dist"), warn = document.getElementById("clwarn");
  const check = () => { const v = parseFloat(distIn.value); warn.innerHTML = !isNaN(v) && v < DB.system.minCl ? `<span class="flag">Below the ${DB.system.minCl} mg/L minimum. Flush, retest and note what you did.</span>` : ""; };
  distIn.oninput = check; check();
  document.getElementById("f-date").onchange = e => Log(e.target.value);
  const dl = document.getElementById("dellog");
  if(dl) dl.onclick = () => { if(!dl.dataset.armed){ dl.dataset.armed=1; dl.textContent="Tap again to delete"; return; } change("DELETE", "/logs/"+date, null, () => Log(TODAY)); };
  document.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => Log(b.dataset.edit));
  document.getElementById("lf").onsubmit = e => {
    e.preventDefault();
    const num = id => { const v = parseFloat(document.getElementById(id).value.replace(/,/g,"")); return isNaN(v) ? null : v; };
    const entry = {date:document.getElementById("f-date").value, ep:num("f-ep"), dist:num("f-dist"), meter:num("f-meter"), pump:num("f-pump"), notes:document.getElementById("f-notes").value.trim()};
    if(!entry.date || entry.dist==null){ document.getElementById("saved").innerHTML = '<span class="flag">Date and distribution chlorine are required.</span>'; return; }
    const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true;
    change("POST", "/logs", entry, () => { Log(entry.date); document.getElementById("saved").textContent = "Saved ✓"; }).catch(() => { btn.disabled = false; });
  };
}

/* ================= SAMPLES & TESTING (shared list UI) ================= */
function listScreen({title, intro, key, kindField, addLabel, recordLabel}){
  const items = DB[key].map(x=>({...x, due:nextDue(x), st:stOf(x)})).sort((a,b)=>a.st.d-b.st.d);
  $view.innerHTML = `
    <h1>${title}</h1><p class="muted small">${intro}</p>
    ${items.map(x=>`
      <div class="card" id="c-${x.id}">
        <div class="row between" style="align-items:flex-start">
          <div><h3>${esc(x.name)}</h3><div class="small muted">${kindField?esc(x.kind)+" · ":""}${freqName(x.months)} · last ${nice(x.last)}</div></div>${badge(x.st)}
        </div>
        ${x.note?`<p class="small muted" style="margin:8px 0 0">${esc(x.note)}</p>`:""}
        ${x.history && x.history.length ? `<details style="margin-top:8px"><summary class="small" style="cursor:pointer;color:var(--brand);font-weight:600">History (${x.history.length})</summary>
          <table style="margin-top:6px"><tbody>${x.history.map(h=>`<tr><td>${nice(h.date)}</td><td>${esc(h.result)}${h.by?`<div class="by">by ${esc(h.by)}</div>`:""}</td><td class="muted">${esc(h.lab||"")}</td><td class="r"><button class="xbtn" type="button" data-hx="${h.id}" aria-label="Remove this record" title="Remove (a mistake)">✕</button></td></tr>`).join("")}</tbody></table></details>` : ""}
        <div class="row wrap" style="margin-top:12px"><button class="btn small primary" data-rec="${x.id}">${recordLabel}</button><button class="btn small" data-ed="${x.id}">Edit</button></div>
        <div data-slot="${x.id}"></div>
      </div>`).join("")}
    ${key==="samples"?`<div class="card"><div class="row between wrap"><div><h3>Import your sample schedule</h3><div class="small muted">From an Excel or CSV file, or rows copied out of a spreadsheet or PDF.</div></div><button class="btn primary" id="impbtn" type="button">Import schedule</button></div><div id="impslot"></div></div>`:""}
    <button class="btn block" id="addbtn">+ ${addLabel}</button><div id="addslot"></div>`;
  const find = id => DB[key].find(x=>x.id===id);
  document.querySelectorAll("[data-rec]").forEach(b => b.onclick = () => {
    const slot = document.querySelector(`[data-slot="${b.dataset.rec}"]`);
    slot.innerHTML = `<form class="inline-form"><div class="grid2">
      <div class="field"><label>Date collected</label><input type="date" name="d" value="${TODAY}" max="${TODAY}"></div>
      <div class="field"><label>Result (optional)</label><input name="r" placeholder="${key==="samples"?"e.g. Absent, or 1.8 mg/L":"e.g. Passed"}"></div></div>
      <div class="field"><label>${key==="samples"?"Lab":"Done by"} (optional)</label><input name="l"></div>
      <div class="row"><button class="btn primary small">Save</button><button type="button" class="btn small" data-x>Cancel</button></div></form>`;
    slot.querySelector("[data-x]").onclick = () => slot.innerHTML = "";
    slot.querySelector("form").onsubmit = e => { e.preventDefault(); const f = e.target;
      change("POST", "/items/"+b.dataset.rec+"/record", {date:f.d.value, result:f.r.value.trim(), lab:f.l.value.trim()}).catch(()=>{}); };
  });
  const editForm = (it, slot, isNew) => {
    slot.innerHTML = `<form class="inline-form">
      <div class="field"><label>Name</label><input name="n" value="${esc(it.name||"")}" required></div>
      ${kindField?`<div class="field"><label>Type</label><select name="k">${DB.kinds.map(k=>`<option ${it.kind===k?"selected":""}>${k}</option>`).join("")}</select></div>`:""}
      <div class="grid2"><div class="field"><label>How often</label><select name="m">${FREQS.map(([v,l])=>`<option value="${v}" ${+it.months===v?"selected":""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label>Last done</label><input type="date" name="d" value="${it.last||""}" max="${TODAY}"></div></div>
      <div class="field"><label>Notes</label><input name="o" value="${esc(it.note||"")}"></div>
      <div class="row wrap"><button class="btn primary small">Save</button><button type="button" class="btn small" data-x>Cancel</button>${isNew?"":'<button type="button" class="btn small danger" data-del style="margin-left:auto">Delete</button>'}</div></form>`;
    slot.querySelector("[data-x]").onclick = () => slot.innerHTML = "";
    const del = slot.querySelector("[data-del]");
    if(del) del.onclick = () => { if(!del.dataset.armed){ del.dataset.armed=1; del.textContent="Tap again to delete"; return; } change("DELETE", "/items/"+it.id).catch(()=>{}); };
    slot.querySelector("form").onsubmit = e => { e.preventDefault(); const f = e.target;
      const upd = {list:key, name:f.n.value.trim(), months:+f.m.value, last:f.d.value||null, note:f.o.value.trim()}; if(kindField) upd.kind = f.k.value;
      if(!isNew) upd.id = it.id;
      change("POST", "/items", upd).catch(()=>{}); };
  };
  document.querySelectorAll("[data-hx]").forEach(b => b.onclick = () => { if(!b.dataset.armed){ b.dataset.armed=1; b.textContent="Remove?"; b.style.color="var(--crit-text)"; return; } change("DELETE", "/history/"+b.dataset.hx).catch(()=>{}); });
  document.querySelectorAll("[data-ed]").forEach(b => b.onclick = () => editForm(find(b.dataset.ed), document.querySelector(`[data-slot="${b.dataset.ed}"]`), false));
  document.getElementById("addbtn").onclick = () => editForm({months:12, kind:"Backflow test"}, document.getElementById("addslot"), true);
  if(key==="samples") document.getElementById("impbtn").onclick = () => importForm(document.getElementById("impslot"));
}
/* ---- import a sampling schedule ---- */
function importForm(slot){
  slot.innerHTML = `<div class="inline-form">
    <div class="field"><label for="imp-file">Excel (.xlsx) or CSV file</label><input type="file" id="imp-file" accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>
    <div class="field"><label for="imp-text">Or paste the rows</label><textarea id="imp-text" rows="5" placeholder="Copy the table from Excel, Google Sheets or your TDEC schedule and paste it here.&#10;Example:&#10;Nitrate&#9;Annual&#9;11/14/2025&#10;Lead & copper&#9;Every 3 years&#9;7/1/2024"></textarea>
      <div class="hint">Columns: sample name, how often, last date sampled (or next due), notes. A heading row is fine; the app finds the columns by their names.</div></div>
    <div class="row wrap"><button class="btn primary small" type="button" id="imp-read">Read it</button><button class="btn small" type="button" id="imp-tpl">Download a template</button><button class="btn small" type="button" id="imp-x">Cancel</button></div>
    <div id="imp-out"></div></div>`;
  slot.querySelector("#imp-x").onclick = () => slot.innerHTML = "";
  slot.querySelector("#imp-tpl").onclick = () => {
    const rows = [["Sample","How often","Last sampled","Notes"],["Total coliform (bacteriological)","Monthly","",""],["Nitrate","Annual","",""],["Lead & copper (5 taps)","Every 3 years","",""],["TTHM / HAA5","Annual","",""]];
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.map(r=>r.map(c=>`"${c}"`).join(",")).join("\r\n")], {type:"text/csv"}));
    a.download = "sample-schedule.csv"; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  const out = slot.querySelector("#imp-out");
  slot.querySelector("#imp-read").onclick = async () => {
    const f = slot.querySelector("#imp-file").files[0], t = slot.querySelector("#imp-text").value;
    if(!f && !t.trim()){ out.innerHTML = '<p class="flag small" style="margin-top:10px">Pick a file or paste the rows first.</p>'; return; }
    out.innerHTML = '<p class="small muted" style="margin-top:10px">Reading…</p>';
    try{
      const h = { "x-ch":"1", "Content-Type":"application/octet-stream" }; if(CREW && TOKEN) h.Authorization = "Bearer " + TOKEN;
      const r = await fetch(API + "/import/read", { method:"POST", headers:h, body: f ? await f.arrayBuffer() : new Blob([t]), credentials:"same-origin" });
      const j = await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(j.error || "That couldn't be read.");
      preview(out, j);
    }catch(e){ out.innerHTML = `<p class="flag small" style="margin-top:10px">${esc(e.message)}</p>`; }
  };
}
function preview(out, d){
  const opts = m => { const list = FREQS.slice(); if(m && !list.some(f=>f[0]===m)) list.push([m, freqName(m)]);
    return `<option value="">Pick…</option>` + list.sort((a,b)=>a[0]-b[0]).map(([v,l])=>`<option value="${v}" ${v===m?"selected":""}>${l}</option>`).join(""); };
  out.innerHTML = `<h3 style="margin:14px 0 4px">Found ${d.rows.length} sample type${d.rows.length===1?"":"s"}</h3>
    <p class="small muted">Check them over. Untick any you don't want; fix anything that's wrong. Nothing changes until you tap Import.</p>
    <div class="imp-list">
    ${d.rows.map((r,i)=>`<div class="imp-row" data-i="${i}">
      <div class="imp-top"><input type="checkbox" class="ic" ${r.action==="skip"?"":"checked"} aria-label="Import ${esc(r.name)}"><input class="in" value="${esc(r.name)}" aria-label="Sample name">
        ${r.action==="update"?'<span class="badge neutral">Updates yours</span>':r.action==="skip"?'<span class="badge warn">Skipped</span>':'<span class="badge good">New</span>'}</div>
      <div class="grid2"><div><label>How often</label><select class="im" style="${r.months?"":"border-color:var(--crit)"}">${opts(r.months)}</select></div>
        <div><label>Last sampled</label><input type="date" class="il" value="${r.last||""}" max="${TODAY}"></div></div>
      ${r.action==="update"?`<div class="tiny muted">Matches your “${esc(r.matchName||"")}”${r.was?`: was ${freqName(r.was.months).toLowerCase()}${r.was.last?", last "+short(r.was.last):""}`:""}</div>`:""}
      ${r.note?`<div class="tiny muted">Notes: ${esc(r.note)}</div>`:""}${r.next&&!r.last?"":""}
      ${r.problem?`<div class="tiny" style="color:var(--crit-text)">${esc(r.problem)}</div>`:""}
    </div>`).join("")}
    </div>
    ${d.notInFile.length?`<label style="display:flex;gap:8px;align-items:flex-start;margin-top:12px;font-weight:500"><input type="checkbox" id="imp-rm" style="width:20px;min-height:0;margin-top:2px"><span>Also remove the ${d.notInFile.length} sample type${d.notInFile.length===1?"":"s"} not in this file (${esc(d.notInFile.map(x=>x.name).join(", "))}). Any with samples recorded are kept.</span></label>`:""}
    <div class="row wrap" style="margin-top:12px"><button class="btn primary" type="button" id="imp-go">Import</button><span class="small" id="imp-msg"></span></div>`;
  out.querySelector("#imp-go").onclick = () => {
    const rows = [...out.querySelectorAll(".imp-row")].map(tr => { const r = d.rows[+tr.dataset.i];
      return { skip: !tr.querySelector(".ic").checked, name: tr.querySelector(".in").value.trim(), months: +tr.querySelector(".im").value || null, last: tr.querySelector(".il").value || null, note: r.note }; });
    const bad = rows.filter(r => !r.skip && (!r.months || !r.name));
    if(bad.length){ out.querySelector("#imp-msg").innerHTML = `<span class="flag">Pick how often for ${esc(bad.map(r=>r.name||"each one").join(", "))}, or untick ${bad.length===1?"it":"them"}.</span>`; return; }
    if(!rows.some(r=>!r.skip)){ out.querySelector("#imp-msg").innerHTML = '<span class="flag">Tick at least one.</span>'; return; }
    const rm = out.querySelector("#imp-rm");
    out.querySelector("#imp-go").disabled = true;
    change("POST", "/import", { rows, removeOthers: !!(rm && rm.checked) }, () => {
      const res = DB; render();
      const msg = document.createElement("div"); msg.className = "alert good"; msg.innerHTML = `<span class="badge good">${ICON.good}Imported</span><div class="small"><b>${res.added} added, ${res.updated} updated${res.removed?", "+res.removed+" removed":""}.</b>Due dates are worked out from each last sampled date.</div>`;
      $view.insertBefore(msg, $view.children[2] || null);
    }).catch(() => { out.querySelector("#imp-go").disabled = false; });
  };
}
const Samples = () => listScreen({title:"Sampling schedule", key:"samples", kindField:false, addLabel:"Add sample type", recordLabel:"Record sample",
  intro:"Set each frequency to match the monitoring schedule TDEC gave your system. Due dates update when you record a sample."});
const Testing = () => listScreen({title:"Testing & maintenance", key:"assets", kindField:true, addLabel:"Add device or task", recordLabel:"Mark done",
  intro:"Backflow assembly tests, valve exercising, tank inspections and flushing, all in one place."});

/* ================= MONTHLY REPORT ================= */
function production(from, to){
  const logs = sortedLogs(); const before = logs.filter(l=>l.date<from && l.meter!=null).pop();
  const inR = logs.filter(l=>l.date>=from && l.date<=to && l.meter!=null);
  if(!inR.length) return {total:0, days:0};
  const start = before ? before.meter : inR[0].meter;
  const total = inR[inR.length-1].meter - start;
  const days = daysBetween(before ? before.date : inR[0].date, inR[inR.length-1].date) || 1;
  return {total, days, avg: total/days, peak: Math.max(...inR.map((l,i)=>{ const p = i ? inR[i-1] : before; return p ? (l.meter-p.meter)/Math.max(1,daysBetween(p.date,l.date)) : 0; }))};
}
function Report(month){
  const now = parse(TODAY);
  const def = iso(new Date(now.getFullYear(), now.getMonth()-1, 1)).slice(0,7);
  const ym = month || def; const [Y,M] = ym.split("-").map(Number);
  const from = `${ym}-01`, last = new Date(Y, M, 0).getDate(), to = `${ym}-${pad(last)}`;
  const end = to > TODAY ? TODAY : to;
  const logs = sortedLogs().filter(l=>l.date>=from && l.date<=end);
  const st = arr => arr.length ? {min:Math.min(...arr), max:Math.max(...arr), avg:arr.reduce((a,b)=>a+b,0)/arr.length} : {};
  const ep = st(logs.map(l=>l.ep).filter(v=>v!=null)), di = st(logs.map(l=>l.dist).filter(v=>v!=null));
  const low = logs.filter(l=>l.dist<DB.system.minCl);
  const prod = production(from, end);
  const expected = daysBetween(from, end) + 1;
  const missing = []; for(let d=from; d<=end; d=addDays(d,1)) if(!logFor(d)) missing.push(d);
  const coll = [...DB.samples.map(s=>({...s,grp:"Sample"})), ...DB.assets.map(a=>({...a,grp:a.kind}))]
    .flatMap(x => (x.history||[]).filter(h=>h.date>=from && h.date<=to).map(h=>({...h, name:x.name, grp:x.grp})));
  // include assets marked done via last date without history entry
  const months = []; for(let i=0;i<12;i++){ const d = new Date(now.getFullYear(), now.getMonth()-i, 1); months.push(iso(d).slice(0,7)); }
  const S = DB.system;
  const text =
`MONTHLY OPERATING SUMMARY: ${new Date(Y,M-1,1).toLocaleDateString("en-US",{month:"long",year:"numeric"}).toUpperCase()}
System:    ${S.name}
PWSID:     ${S.pwsid}
Operator:  ${S.operator} (${S.cert})

WATER PRODUCED
  Total:            ${prod.total ? prod.total.toLocaleString()+" gal" : "No meter data"}
  Average per day:  ${prod.avg ? Math.round(prod.avg).toLocaleString()+" gal" : "—"}
  Peak day:         ${prod.peak ? Math.round(prod.peak).toLocaleString()+" gal" : "—"}

FREE CHLORINE (mg/L)       Min     Avg     Max
  Entry point            ${fmt(ep.min).padStart(5)}   ${fmt(ep.avg).padStart(5)}   ${fmt(ep.max).padStart(5)}
  Distribution           ${fmt(di.min).padStart(5)}   ${fmt(di.avg).padStart(5)}   ${fmt(di.max).padStart(5)}
  Days below ${S.minCl} (dist):  ${low.length}${low.length ? "  ("+low.map(l=>short(l.date)).join(", ")+")" : ""}

DAYS LOGGED: ${logs.length} of ${expected}${missing.length ? "\n  Missing: "+missing.map(short).join(", ") : ""}

SAMPLES & TESTS THIS MONTH
${coll.length ? coll.map(c=>`  ${short(c.date).padEnd(7)} ${c.name}: ${c.result}${c.lab?" ("+c.lab+")":""}`).join("\n") : "  None recorded"}

NOTES
${logs.filter(l=>l.notes).map(l=>`  ${short(l.date).padEnd(7)} ${l.notes}`).join("\n") || "  None"}
`;
  $view.innerHTML = `
    <h1>Monthly report</h1><p class="muted small">Your month's numbers, ready to copy onto your monthly operating report (MOR) for TDEC.</p>
    <div class="card">
      <div class="field"><label for="mon">Month</label><select id="mon">${months.map(mm=>`<option value="${mm}" ${mm===ym?"selected":""}>${parse(mm+"-01").toLocaleDateString("en-US",{month:"long",year:"numeric"})}${mm===TODAY.slice(0,7)?" (so far)":""}</option>`).join("")}</select></div>
      <div class="grid3" style="margin-bottom:14px">
        <div class="tile"><div class="big num">${prod.total?(prod.total/1e6).toFixed(2):"—"}</div><div class="lbl">MG produced</div></div>
        <div class="tile"><div class="big num">${logs.length}/${expected}</div><div class="lbl">Days logged</div></div>
        <div class="tile"><div class="big num" style="color:${low.length?"var(--crit-text)":"inherit"}">${low.length}</div><div class="lbl">Days below ${S.minCl}</div></div>
      </div>
      ${missing.length ? `<div class="alert warn"><span class="badge warn">${ICON.warn}Gaps</span><div class="small"><b>${missing.length} day${missing.length>1?"s":""} missing.</b>Fill these in from your paper notes before you submit.</div></div>` : ""}
      <h3 style="margin:4px 0 6px">Water produced</h3>
      <table><tbody>
        <tr><td>Total</td><td class="r num">${prod.total ? prod.total.toLocaleString()+" gal" : "No meter data"}</td></tr>
        <tr><td>Average per day</td><td class="r num">${prod.avg ? Math.round(prod.avg).toLocaleString()+" gal" : "—"}</td></tr>
        <tr><td>Peak day</td><td class="r num">${prod.peak ? Math.round(prod.peak).toLocaleString()+" gal" : "—"}</td></tr>
      </tbody></table>
      <h3 style="margin:16px 0 6px">Free chlorine (mg/L)</h3>
      <table><thead><tr><th></th><th class="r">Min</th><th class="r">Avg</th><th class="r">Max</th></tr></thead><tbody>
        <tr><td>Entry point</td><td class="r num">${fmt(ep.min)}</td><td class="r num">${fmt(ep.avg)}</td><td class="r num">${fmt(ep.max)}</td></tr>
        <tr><td>Distribution</td><td class="r num ${di.min<S.minCl?"flag":""}">${fmt(di.min)}</td><td class="r num">${fmt(di.avg)}</td><td class="r num">${fmt(di.max)}</td></tr>
      </tbody></table>
      ${low.length?`<p class="small" style="margin-top:6px"><span class="flag">Below ${S.minCl}:</span> ${low.map(l=>short(l.date)).join(", ")}</p>`:""}
      ${missing.length?`<p class="small muted" style="margin-top:6px">Missing days: ${missing.map(short).join(", ")}</p>`:""}
      <h3 style="margin:16px 0 6px">Samples &amp; tests this month</h3>
      ${coll.length?`<table><tbody>${coll.map(c=>`<tr><td style="white-space:nowrap">${short(c.date)}</td><td>${esc(c.name)}<div class="tiny muted">${esc(c.result)}${c.lab?" · "+esc(c.lab):""}</div></td></tr>`).join("")}</tbody></table>`:'<p class="small muted">None recorded.</p>'}
      <h3 style="margin:16px 0 6px">Notes</h3>
      ${logs.filter(l=>l.notes).length?`<table><tbody>${logs.filter(l=>l.notes).map(l=>`<tr><td style="white-space:nowrap;vertical-align:top">${short(l.date)}</td><td>${esc(l.notes)}</td></tr>`).join("")}</tbody></table>`:'<p class="small muted">None.</p>'}
      <details style="margin-top:14px"><summary class="small" style="cursor:pointer;color:var(--brand);font-weight:600">Plain-text version</summary><div class="report" id="rep" style="margin-top:8px;white-space:pre;font-size:12px">${esc(text)}</div></details>
      <div class="row wrap" style="margin-top:12px"><button class="btn primary" id="copy">Copy report</button><span class="small muted" id="copied"></span></div>
      <p class="hint" style="margin-top:10px">This is a summary to help you fill out the official form. It doesn't replace TDEC's required MOR format.</p>
    </div>`;
  document.getElementById("mon").onchange = e => Report(e.target.value);
  document.getElementById("copy").onclick = async () => {
    const out = document.getElementById("copied");
    try{ await navigator.clipboard.writeText(text); out.textContent = "Copied ✓"; }
    catch(e){ const rep = document.getElementById("rep"); rep.parentElement.open = true; const r = document.createRange(); r.selectNodeContents(rep); const s = getSelection(); s.removeAllRanges(); s.addRange(r); out.textContent = "Selected. Press copy on your device."; }
  };
}

/* ================= SETTINGS ================= */
function Settings(){
  const S = DB.system;
  const F = (id,label,val,hint="") => `<div class="field"><label for="s-${id}">${label}</label><input id="s-${id}" value="${esc(val)}">${hint?`<div class="hint">${hint}</div>`:""}</div>`;
  $view.innerHTML = `
    <h1>System settings</h1><p class="muted small">Your system's details appear on every report.</p>
    <form class="card" id="sf">
      ${F("name","System name",S.name)}
      <div class="grid2">${F("pwsid","PWSID",S.pwsid)}${F("type","System type",S.type)}${F("pop","Population served",S.pop)}${F("conn","Service connections",S.conn)}</div>
      <div class="grid2">${F("operator","Operator name",S.operator)}${F("cert","Certification",S.cert)}</div>
      ${F("minCl","Minimum distribution chlorine (mg/L)",S.minCl,"Tennessee requires at least 0.2 mg/L free chlorine.")}
      <div class="row"><button class="btn primary">Save</button><span class="small muted" id="ok"></span></div>
    </form>
    <div class="card"><h2>Your records</h2>
      <p class="small muted">Saved in Crew Hours, the same on every phone and on the dashboard. Managers use it from the crew app; the boss from the dashboard.</p>
      <div class="row wrap"><button class="btn small" id="exp">Download a copy (JSON)</button></div>
      <p class="tiny muted" style="margin:12px 0 0">Sampling frequencies and limits here are examples, so always follow the monitoring schedule TDEC issues for your system. Not affiliated with TDEC.</p>
    </div>`;
  document.getElementById("sf").onsubmit = e => { e.preventDefault();
    const b = {}; ["name","pwsid","type","pop","conn","operator","cert","minCl"].forEach(k => b[k] = document.getElementById("s-"+k).value.trim());
    change("PUT", "/system", b, () => { Settings(); document.getElementById("sysname").textContent = DB.system.name; document.getElementById("ok").textContent = "Saved ✓"; }).catch(()=>{}); };
  document.getElementById("exp").onclick = () => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(DB, null, 2)], {type:"application/json"}));
    a.download = "compliance-" + TODAY + ".json"; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
}

if (CREW && !TOKEN) signIn();
else api("GET", "").then(d => { DB = d; TODAY = d.today; render(); }).catch(e => { if (!/sign in/i.test(e.message)) { oops(e.message); $view.innerHTML = '<p class="muted">Couldn\'t load. Pull down to try again.</p>'; } });
