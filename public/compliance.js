
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
  ["results","Results",'<path d="M4 20V4M4 20h16"/><circle cx="8" cy="14" r="1.6"/><circle cx="12" cy="10" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="19" cy="7" r="1.6"/><path d="M4 8h16" stroke-dasharray="2 2.5"/>'],
  ["email","Email",'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'],
  ["report","Report",'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
];
function route(){ const h = location.hash.slice(1); if(/^email(-|$)/.test(h)) return "email"; return ["home","log","samples","testing","results","report","settings"].includes(h) ? h : "home"; }
function go(r){ if(location.hash.slice(1)===r) render(); else location.hash = r; }
window.addEventListener("hashchange", render);
document.addEventListener("click", e => { const g = e.target.closest("[data-go]"); if(g){ e.preventDefault(); go(g.dataset.go); } });

function render(){
  if(!DB) return;
  const r = route();
  document.getElementById("sysname").textContent = DB.system.name;
  document.getElementById("tabs").innerHTML = TABS.map(([id,label,path]) =>
    `<a href="#${id}" class="${r===id?"on":""}" aria-current="${r===id?"page":"false"}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${path}</svg>${label}</a>`).join("");
  ({home:Home, log:Log, samples:Samples, testing:Testing, results:Results, email:Email, report:Report, settings:Settings})[r]();
  if(ML) mailBadge(); else if(r!=="email") mlApi("GET","").then(d => { if(route()==="home" && d.items.some(x=>x.status==="new")) Home(); }).catch(()=>{});
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
  const mailN = ML ? ML.items.filter(x=>x.status==="new").length : 0, mailU = ML && ML.items.some(x=>x.status==="new" && x.urgent);
  $view.innerHTML = `
    <h1>Good ${new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}</h1>
    <p class="muted small" style="margin-bottom:14px">${nice(TODAY)}${DB.system.operator ? " · "+esc(DB.system.operator)+(DB.system.cert ? ", "+esc(DB.system.cert)+" operator" : "") : ' · <a href="#settings" style="color:var(--brand);font-weight:600">Add your system details</a>'}</p>
    ${today ? `<div class="alert good"><span class="badge good">${ICON.good}Logged</span><div class="small"><b>Today's readings are in.</b>Distribution free chlorine ${fmt(today.dist)} mg/L.</div></div>`
            : `<div class="alert warn"><span class="badge warn">${ICON.warn}To do</span><div class="small" style="flex:1"><b>Today's readings aren't logged yet.</b><button class="btn primary small" data-go="log" style="margin-top:8px">Log today's readings</button></div></div>`}
    ${over.length ? `<div class="alert crit"><span class="badge crit">${ICON.crit}${over.length} overdue</span><div class="small"><b>${esc(over.map(x=>x.name).join(", "))}</b>Collect or test as soon as possible, and check whether a monitoring violation applies.</div></div>` : ""}
    ${mailN ? `<a class="alert ${mailU?"crit":"warn"} linkcard" href="#email"><span class="badge ${mailU?"crit":"warn"}">${mailU?ICON.crit:ICON.warn}${mailN} email${mailN>1?"s":""}</span><div class="small"><b>Water system email needs your attention.</b>Tap to see ${mailN>1?"them":"it"}.</div></a>` : ""}
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

/* ================= SAMPLE RESULTS ================= */
// Import lab reports (PDF, scanned too) or tables copied from Drinking Water Watch; then each test over time against its limit.
let RS = null, SEL = null;
const KINDNOTE = { al:"Lead and copper: the action level applies to the 90th percentile of a sampling round, not to one tap.", smcl:"Secondary limits are for taste, color and odor. They aren't enforceable.", presence:"Any positive (Present) needs follow-up right away." };
function rsApi(method, path, body){ return api(method, "/results" + path, body).then(d => { RS = d; return d; }); }
function conv(v, from, to){ if(v==null || !from || !to || from===to) return v; const f={"mg/L":1,"µg/L":1e-3,"ng/L":1e-6}; return f[from]&&f[to] ? v*f[from]/f[to] : null; }
function isOver(r, l){
  if(!l) return null;
  if(l.kind==="presence") return r.qual==="present";
  if(l.limit==null) return null;
  if(r.value==null || r.qual==="lt") return false;
  const v = conv(r.value, r.units, l.units); return v==null ? null : v > l.limit;
}
const limText = l => !l ? "" : l.kind==="presence" ? "Must be absent" : l.limit==null ? "No limit set" : `${l.limit} ${l.units}`;
function Results(){
  if(!RS){ $view.innerHTML = '<p class="muted">Loading results…</p>'; rsApi("GET","").then(Results).catch(e=>oops(e.message)); return; }
  const tests = {};
  RS.results.forEach(r => (tests[r.test] = tests[r.test] || []).push(r));
  const names = Object.keys(tests).sort((a,b) => {
    const oa = tests[a].some(r=>isOver(r,RS.limits[a])), ob = tests[b].some(r=>isOver(r,RS.limits[b]));
    return (ob-oa) || a.localeCompare(b);
  });
  if(SEL && !tests[SEL]) SEL = null;
  const overNow = names.filter(n => latest(n, tests[n]).over);
  $view.innerHTML = `
    <div class="row between wrap" style="margin-bottom:10px"><div><h1 style="margin:0">Sample results</h1><p class="muted small" style="margin:2px 0 0">Every lab result in one place, each test against its limit.</p></div>
      <div class="row wrap"><button class="btn primary" id="rs-imp" type="button">Import results</button>${RS.results.length?'<button class="btn small" id="rs-csv" type="button">Download CSV</button>':""}</div></div>
    <div id="rs-slot"></div>
    ${!RS.results.length ? `<div class="card"><h2>No results yet</h2><p class="small muted">Tap <b>Import results</b> and pick the lab's PDF report (a scan works too), or copy the results table from Drinking Water Watch and paste it in.</p></div>` : `
    ${overNow.length ? `<div class="alert crit"><span class="badge crit">${ICON.crit}Over the limit</span><div class="small"><b>${esc(overNow.join(", "))}</b>The most recent result is over the limit. Check with TDEC about follow-up sampling and public notice.</div></div>` : ""}
    <div class="grid3" style="margin-bottom:14px">
      <div class="tile"><div class="big num">${names.length}</div><div class="lbl">Tests</div></div>
      <div class="tile"><div class="big num">${RS.results.length}</div><div class="lbl">Results</div></div>
      <div class="tile"><div class="big num" style="color:${overNow.length?"var(--crit-text)":"inherit"}">${overNow.length}</div><div class="lbl">Over limit now</div></div>
    </div>
    <div class="card"><h2>Tests</h2><p class="tiny muted" style="margin:-4px 0 4px">Tap one to see it over time.</p>
      ${names.map(n => { const rs = tests[n], L = latest(n, rs), last = L.worst, l = RS.limits[n], o = L.over, anyO = rs.some(r=>isOver(r,l));
        const st = o ? `<span class="badge crit">${ICON.crit}Over limit</span>` : l && (l.limit!=null || l.kind==="presence") ? `<span class="badge good">${ICON.good}${anyO?"Now within":"Within limit"}</span>` : `<span class="badge neutral">No limit</span>`;
        return `<button class="item rs-test ${SEL===n?"on":""}" data-test="${esc(n)}" type="button"><div style="text-align:left"><div class="t">${esc(n)}</div><div class="s">${L.round.length>1?`Latest round, highest of ${L.round.length}:`:"Latest"} <b class="${last.value==null?"":"num"}">${esc(last.result)}</b> ${esc(last.units)} · ${nice(last.day)} · ${rs.length} result${rs.length===1?"":"s"}</div></div>${st}</button>`; }).join("")}
    </div>
    <div id="rs-detail"></div>
    <details class="card"><summary><b>All results</b> <span class="tiny muted">(${RS.results.length})</span></summary>
      <div style="overflow-x:auto;margin-top:8px"><table><thead><tr><th>Date</th><th>Test</th><th>Sample point</th><th class="r">Result</th><th>Units</th></tr></thead><tbody>
      ${RS.results.slice().reverse().map(r=>`<tr><td>${short(r.day)} ${r.day.slice(0,4)}</td><td>${esc(r.test)}</td><td>${esc(r.point)}</td><td class="r num ${isOver(r,RS.limits[r.test])?"flag":""}">${esc(r.result)}</td><td>${esc(r.units)}</td></tr>`).join("")}
      </tbody></table></div>
      ${lastBatch() ? `<div class="row wrap" style="margin-top:10px"><span class="tiny muted">Last import: ${esc(lastBatch().source||"pasted results")}, ${lastBatch().n} result${lastBatch().n===1?"":"s"}.</span><button class="btn small danger" id="rs-undo" type="button">Undo that import</button></div>` : ""}
    </details>`}`;
  document.getElementById("rs-imp").onclick = () => rsImport(document.getElementById("rs-slot"));
  const csvb = document.getElementById("rs-csv");
  if(csvb) csvb.onclick = async () => {
    const h = { "x-ch":"1" }; if(CREW && TOKEN) h.Authorization = "Bearer " + TOKEN;
    const r = await fetch(API + "/results.csv", { headers:h, credentials:"same-origin" });
    if(!r.ok) return oops("Couldn't download the results.");
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = "sample-results.csv"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  };
  const undo = document.getElementById("rs-undo");
  if(undo) undo.onclick = () => { const b = lastBatch(); if(!confirm(`Remove the ${b.n} result${b.n===1?"":"s"} from the last import?`)) return; rsApi("DELETE","/batch/"+encodeURIComponent(b.batch)).then(Results).catch(e=>oops(e.message)); };
  document.querySelectorAll(".rs-test").forEach(b => b.onclick = () => { SEL = SEL===b.dataset.test ? null : b.dataset.test; Results(); if(SEL) document.getElementById("rs-detail").scrollIntoView({behavior:"smooth", block:"start"}); });
  if(!SEL && names.length) SEL = overNow[0] || null;
  if(SEL) detail(SEL, tests[SEL]);
}
/** The most recent sampling day for a test, and its worst result (a lead round has many taps on one day). */
function latest(name, rs){
  const l = RS.limits[name], day = rs[rs.length-1].day, round = rs.filter(r=>r.day===day);
  const size = r => r.qual==="present" ? 1e9 : r.value==null ? -1 : (conv(r.value, r.units, (l&&l.units)||r.units) ?? r.value) - (r.qual==="lt" ? 1e-9 : 0);
  const worst = round.reduce((a,b)=> size(b)>size(a) ? b : a, round[0]);
  return { round, worst, over: round.some(r=>isOver(r,l)) };
}
function lastBatch(){
  if(!RS || !RS.results.length) return null;
  const byB = {}; RS.results.forEach(r => { if(!r.batch) return; (byB[r.batch] = byB[r.batch] || {batch:r.batch, source:r.source, n:0, max:0}).n++; byB[r.batch].max = Math.max(byB[r.batch].max, r.id); });
  return Object.values(byB).sort((a,b)=>b.max-a.max)[0] || null;
}
function detail(name, rs){
  const l = RS.limits[name] || {}, box = document.getElementById("rs-detail");
  const unit = l.limit!=null && l.units ? l.units : (rs.find(r=>r.units)||{}).units || "";
  const pts = [...new Set(rs.map(r=>r.point||"—"))];
  box.innerHTML = `<div class="card">
    <div class="row between wrap" style="align-items:flex-start"><div><h2 style="margin:0">${esc(name)}</h2>
      <div class="tiny muted">${esc(l.label||"")}: <b>${esc(limText(l))}</b> <button class="linkbtn" id="rs-lim" type="button">Change</button></div></div>
      ${pts.length>1?`<span class="tiny muted">${pts.length} sample points</span>`:""}</div>
    ${KINDNOTE[l.kind] ? `<p class="tiny muted" style="margin:6px 0 0">${KINDNOTE[l.kind]}</p>` : ""}
    <div id="rs-limform"></div>
    ${name==="Lead"||name==="Copper" ? `<div class="lcr no-print"><div class="row between wrap"><div><b>Lead and copper notices</b><div class="tiny muted">TDEC's Notification of Results, filled in for every home in a round, one per page.</div></div><button class="btn small" id="lcr-open" type="button">Make notices</button></div><div id="lcr-form"></div></div>` : ""}
    ${l.kind==="presence" ? presenceStrip(rs) : `<div class="chartwrap" id="rs-chart" style="margin-top:8px"></div>`}
    <div style="overflow-x:auto;margin-top:10px"><table><thead><tr><th>Date</th><th>Sample point</th><th class="r">Result</th><th>Units</th><th></th></tr></thead><tbody>
    ${rs.slice().reverse().map(r=>`<tr><td>${nice(r.day)}</td><td>${esc(r.point)}</td><td class="r num ${isOver(r,l)?"flag":""}">${esc(r.result)}${isOver(r,l)?" ⚠":""}</td><td>${esc(r.units)}</td><td class="r"><button class="btn small danger" data-rdel="${r.id}" type="button" aria-label="Delete this result">Delete</button></td></tr>`).join("")}
    </tbody></table></div></div>`;
  if(l.kind!=="presence") resultChart(document.getElementById("rs-chart"), rs, l, unit);
  const lo = document.getElementById("lcr-open"); if(lo) lo.onclick = () => lcrForm(document.getElementById("lcr-form"));
  box.querySelectorAll("[data-rdel]").forEach(b => b.onclick = () => { if(confirm("Delete this result?")) rsApi("DELETE","/"+b.dataset.rdel).then(Results).catch(e=>oops(e.message)); });
  document.getElementById("rs-lim").onclick = () => {
    const f = document.getElementById("rs-limform");
    if(f.innerHTML){ f.innerHTML=""; return; }
    f.innerHTML = `<div class="row wrap" style="margin-top:10px;align-items:flex-end">
      <div class="field" style="margin:0;flex:1;min-width:120px"><label for="lim-v">Limit</label><input id="lim-v" inputmode="decimal" value="${l.limit??""}" placeholder="Blank = no limit"></div>
      <div class="field" style="margin:0;width:120px"><label for="lim-u">Units</label><select id="lim-u">${["mg/L","µg/L","ng/L","pCi/L","NTU","pH",""].map(u=>`<option ${u===(l.units||unit)?"selected":""} value="${u}">${u||"none"}</option>`).join("")}</select></div>
      <button class="btn primary small" id="lim-s" type="button">Save</button>${l.own?'<button class="btn small" id="lim-r" type="button">Back to EPA limit</button>':""}</div>`;
    document.getElementById("lim-s").onclick = () => rsApi("PUT","/limit",{ test:name, limit:document.getElementById("lim-v").value.trim(), units:document.getElementById("lim-u").value }).then(Results).catch(e=>oops(e.message));
    const rr = document.getElementById("lim-r"); if(rr) rr.onclick = () => rsApi("PUT","/limit",{ test:name, reset:true }).then(Results).catch(e=>oops(e.message));
  };
}
/** Lead and copper consumer notices: pick the round and the notice date, get one Word file. */
async function lcrForm(box){
  if(box.innerHTML){ box.innerHTML = ""; return; }
  box.innerHTML = '<p class="small muted">Loading rounds…</p>';
  let rounds = [];
  try{ rounds = (await api("GET","/results/lcr-rounds")).rounds; }catch(e){ box.innerHTML = `<p class="flag small">${esc(e.message)}</p>`; return; }
  const S = DB.system, miss = [["operator","operator name"],["phone","phone"],["email","email"],["pwsid","PWSID"]].filter(([k])=>!S[k]).map(x=>x[1]);
  box.innerHTML = `<div class="row wrap" style="align-items:flex-end;margin-top:10px">
      <div class="field" style="margin:0;min-width:200px;flex:1"><label for="lcr-day">Sampling round</label><select id="lcr-day">${rounds.map(r=>`<option value="${r.from}|${r.to}">${r.from===r.to?nice(r.from):short(r.from)+"–"+nice(r.to)}: ${r.taps} sample${r.taps===1?"":"s"}</option>`).join("")}</select></div>
      <div class="field" style="margin:0;width:180px"><label for="lcr-date">Date on the notice</label><input type="date" id="lcr-date" value="${TODAY}"></div>
      <button class="btn primary" id="lcr-go" type="button">Download (Word)</button></div>
    ${miss.length ? `<p class="small flag" style="margin:8px 0 0">Add your ${miss.join(", ")} in <a href="#settings">System settings</a> first, or those blanks stay empty.</p>` : ""}
    <p class="tiny muted" style="margin:8px 0 0">Each home's sample point is used as the Location, so name sample points by address when you import. Check each notice, then print and deliver them by TDEC's deadline.</p>
    <span class="small" id="lcr-msg"></span>`;
  document.getElementById("lcr-go").onclick = async () => {
    const msg = document.getElementById("lcr-msg"), [day, to] = document.getElementById("lcr-day").value.split("|");
    msg.className = "small muted"; msg.textContent = "Making the notices…";
    try{
      const h = { "x-ch":"1" }; if(CREW && TOKEN) h.Authorization = "Bearer " + TOKEN;
      const r = await fetch(API + `/results/lcr-notices.docx?day=${encodeURIComponent(day)}&to=${encodeURIComponent(to||day)}&date=${encodeURIComponent(document.getElementById("lcr-date").value)}`, { headers:h, credentials:"same-origin" });
      if(!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.error || "Couldn't make the notices."); }
      const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `lead-copper-notices-${day}.docx`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
      msg.className = "small"; msg.textContent = `Downloaded ${r.headers.get("X-Notices")||""} notices ✓`;
    }catch(e){ msg.className = "small flag"; msg.textContent = e.message; }
  };
}
function presenceStrip(rs){
  const pos = rs.filter(r=>r.qual==="present");
  return `<div class="alert ${pos.length?"crit":"good"}" style="margin-top:10px"><span class="badge ${pos.length?"crit":"good"}">${pos.length?ICON.crit:ICON.good}${pos.length?pos.length+" present":"All absent"}</span>
    <div class="small">${pos.length ? "Present on " + pos.map(r=>nice(r.day)+(r.point?" ("+esc(r.point)+")":"")).join(", ") + "." : `Absent in all ${rs.length} sample${rs.length===1?"":"s"} since ${nice(rs[0].day)}.`}</div></div>`;
}
/** One test over time: a dot per result (hollow = not detected, plotted at its reporting limit or zero), the limit dashed. */
function resultChart(el, rs, l, unit){
  const data = rs.map(r => { let v = r.value==null ? 0 : conv(r.value, r.units, unit); if(v==null) v = r.value; return { r, v, nd: r.value==null || r.qual==="lt", over: isOver(r,l) }; }).filter(d=>d.v!=null);
  if(!data.length){ el.innerHTML = '<p class="muted small">No numbers to chart for this test.</p>'; return; }
  const W = Math.max(300, el.clientWidth || 640), H = 230, m = {t:16,r:14,b:28,l:50};
  const lim = l.limit!=null && unit===l.units ? l.limit : null;
  const maxV = Math.max(lim||0, ...data.map(d=>d.v)) * 1.15 || 1;
  const t = s => parse(s).getTime();
  let t0 = t(data[0].r.day), t1 = t(data[data.length-1].r.day); if(t1===t0){ t0 -= 30*864e5; t1 += 30*864e5; }
  const x = d => m.l + (t(d.r.day)-t0)/(t1-t0)*(W-m.l-m.r);
  const y = v => m.t + (1 - v/maxV)*(H-m.t-m.b);
  const step = niceStep(maxV/4), ticks = []; for(let v=0; v<=maxV+1e-12; v+=step) ticks.push(+v.toPrecision(6));
  const single = new Set(data.map(d=>d.r.point)).size===1;
  const line = single && data.length>1 ? data.map((d,i)=>`${i?"L":"M"}${x(d).toFixed(1)},${y(d.v).toFixed(1)}`).join("") : "";
  const y0 = new Date(t0).getFullYear(), y1 = new Date(t1).getFullYear();
  const xt = y1-y0 >= 2 ? Array.from({length:y1-y0+1},(_,i)=>y0+i).filter(yr => { const tt = new Date(yr,0,1).getTime(); return tt>=t0 && tt<=t1; }).map(yr=>({tt:new Date(yr,0,1).getTime(), label:String(yr)}))
    : [{tt:t0,label:new Date(t0).toLocaleDateString("en-US",{month:"short",year:"numeric"})},{tt:t1,label:new Date(t1).toLocaleDateString("en-US",{month:"short",year:"numeric"})}];
  const xx = tt => m.l + (tt-t0)/(t1-t0)*(W-m.l-m.r);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(rs[0].test)} results over time${lim!=null?`, with the ${lim} ${esc(unit)} limit marked`:""}">
    ${ticks.map(v=>`<line x1="${m.l}" x2="${W-m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${m.l-6}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)" class="num">${v}</text>`).join("")}
    <text x="${m.l-6}" y="${m.t-5}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(unit)}</text>
    <line x1="${m.l}" x2="${W-m.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>
    ${lim!=null?`<line x1="${m.l}" x2="${W-m.r}" y1="${y(lim)}" y2="${y(lim)}" stroke="var(--crit)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W-m.r}" y="${y(lim)-6}" text-anchor="end" font-size="11.5" font-weight="600" fill="var(--crit-text)">${l.kind==="al"?"Action level":"Limit"} ${lim} ${esc(unit)}</text>`:""}
    ${xt.map(d=>`<text x="${xx(d.tt)}" y="${H-8}" text-anchor="${d.tt===t0?"start":d.tt===t1?"end":"middle"}" font-size="11" fill="var(--muted)">${d.label}</text>`).join("")}
    ${line?`<path d="${line}" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round"/>`:""}
    ${data.map((d,i)=>`<circle data-i="${i}" cx="${x(d).toFixed(1)}" cy="${y(d.v).toFixed(1)}" r="5" fill="${d.nd?"var(--surface)":d.over?"var(--crit)":"var(--series)"}" stroke="${d.over?"var(--crit)":"var(--series)"}" stroke-width="2"/>`).join("")}
  </svg><div class="tip" id="rs-tip"></div>
  <p class="tiny muted" style="margin:4px 0 0">● detected · ○ not detected (shown at the reporting limit)${single?"":" · dots are separate sample points"}. Hover or tap a dot for details.</p>`;
  const svg = el.querySelector("svg"), tip = el.querySelector("#rs-tip");
  const show = ev => {
    const b = svg.getBoundingClientRect(), px = (ev.clientX-b.left)*(W/b.width), py = (ev.clientY-b.top)*(W/b.width);
    let best = null, bd = 1e9; data.forEach(d => { const dd = Math.hypot(x(d)-px, (y(d.v)-py)*0.5); if(dd<bd){ bd=dd; best=d; } });
    if(!best || bd > 60){ tip.style.opacity = 0; return; }
    tip.style.left = (x(best)*b.width/W)+"px"; tip.style.top = (y(best.v)*b.width/W)+"px"; tip.style.opacity = 1;
    tip.innerHTML = `<b>${nice(best.r.day)}</b> · <span class="num">${esc(best.r.result)}</span> ${esc(best.r.units)}${best.r.point?" · "+esc(best.r.point):""}${best.over?' <span class="flag">over</span>':""}`;
  };
  svg.addEventListener("pointermove", show); svg.addEventListener("pointerdown", show); svg.addEventListener("pointerleave", () => tip.style.opacity = 0);
}
function niceStep(raw){ const p = Math.pow(10, Math.floor(Math.log10(raw||1))), n = raw/p; return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p; }

/* ---- import ---- */
function rsImport(slot){
  if(slot.innerHTML){ slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="card"><h2>Import results</h2>
    <div class="field"><label for="ri-file">Lab report (PDF, a scan or photo works too), Excel or CSV</label><input type="file" id="ri-file" accept=".pdf,.xlsx,.csv,.txt,.html,.htm,image/*,application/pdf"></div>
    <div class="field"><label for="ri-text">Or paste results</label><textarea id="ri-text" rows="5" placeholder="On Drinking Water Watch, open the sample results, select the whole table including its heading row, copy it, and paste it here."></textarea></div>
    <div class="row wrap"><button class="btn primary small" id="ri-read" type="button">Read it</button><button class="btn small" id="ri-x" type="button">Cancel</button></div>
    <div id="ri-out"></div></div>`;
  slot.querySelector("#ri-x").onclick = () => slot.innerHTML = "";
  const out = slot.querySelector("#ri-out");
  slot.querySelector("#ri-read").onclick = async () => {
    const f = slot.querySelector("#ri-file").files[0], t = slot.querySelector("#ri-text").value;
    if(!f && !t.trim()){ out.innerHTML = '<p class="flag small" style="margin-top:10px">Pick a file or paste the results first.</p>'; return; }
    out.innerHTML = `<p class="small muted" style="margin-top:10px">Reading${f && /pdf|image/.test(f.type) ? " the report… a scanned report takes up to a minute" : "…"}</p>`;
    try{
      const h = { "x-ch":"1", "Content-Type":"application/octet-stream" }; if(CREW && TOKEN) h.Authorization = "Bearer " + TOKEN;
      const r = await fetch(API + "/results/read", { method:"POST", headers:h, body: f ? await f.arrayBuffer() : new Blob([t]), credentials:"same-origin" });
      const j = await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(j.error || "That couldn't be read.");
      rsPreview(out, j, f ? f.name : "Pasted results", slot);
    }catch(e){ out.innerHTML = `<p class="flag small" style="margin-top:10px">${esc(e.message)}</p>`; }
  };
}
function rsPreview(out, d, source, slot){
  const how = {scan:"a scanned report (read with text recognition, so check every number)", pdf:"the PDF", table:"the table", text:"the text"}[d.how] || "the file";
  out.innerHTML = `<h3 style="margin:14px 0 4px">Found ${d.rows.length} result${d.rows.length===1?"":"s"} in ${how}</h3>
    <p class="small muted">Check them against the report. Fix anything that's wrong and untick anything that isn't a result. Nothing is saved until you tap Save.</p>
    ${d.missingDate ? `<div class="field"><label for="ri-day">Sample date for rows without one</label><input type="date" id="ri-day" max="${d.today}"></div>` : ""}
    <div class="ri-list">
    ${d.rows.map((r,i)=>`<div class="ri-row" data-i="${i}">
      <div class="ri-top"><input type="checkbox" class="ri-on" ${r.dup?"":"checked"} aria-label="Save ${esc(r.test)}"><input class="ri-t" value="${esc(r.test)}" aria-label="Test" title="As written: ${esc(r.raw||"")}">${r.dup?'<span class="badge neutral">Already saved</span>':""}</div>
      <div class="ri-grid">
        <div><label>Result</label><input class="ri-r num" value="${esc(r.result)}"></div>
        <div><label>Units</label><input class="ri-u" value="${esc(r.units)}"></div>
        <div><label>Sample date</label><input type="date" class="ri-d" value="${r.day||""}" max="${d.today}" style="${r.day?"":"border-color:var(--crit)"}"></div>
        <div><label>Sample point</label><input class="ri-p" value="${esc(r.point)}"></div>
      </div></div>`).join("")}
    </div>
    ${d.schedule.length ? `<div class="field" style="margin-top:12px"><label>Also mark these samples as collected on the schedule</label>${d.schedule.map((s,i)=>`<label class="row small" style="font-weight:400;margin:4px 0"><input type="checkbox" class="ri-s" data-i="${i}" checked style="width:auto;min-height:0"> ${esc(s.name)}: collected ${nice(s.day)}</label>`).join("")}</div>` : ""}
    <div class="row wrap" style="margin-top:12px"><button class="btn primary" id="ri-save" type="button">Save results</button><span class="small" id="ri-msg"></span></div>`;
  const msg = out.querySelector("#ri-msg");
  out.querySelector("#ri-save").onclick = async () => {
    const fill = (out.querySelector("#ri-day")||{}).value || "";
    const rows = [...out.querySelectorAll(".ri-row")].filter(tr => tr.querySelector(".ri-on").checked).map(tr => {
      const r = d.rows[+tr.dataset.i];
      return { day: tr.querySelector(".ri-d").value || fill, test: tr.querySelector(".ri-t").value.trim(), result: tr.querySelector(".ri-r").value.trim(), units: tr.querySelector(".ri-u").value.trim(), point: tr.querySelector(".ri-p").value.trim(), raw: r.raw, lab: r.lab };
    });
    if(!rows.length){ msg.className = "small flag"; msg.textContent = "Tick at least one result."; return; }
    const sched = [...out.querySelectorAll(".ri-s")].filter(c=>c.checked).map(c=>d.schedule[+c.dataset.i]);
    msg.className = "small muted"; msg.textContent = "Saving…";
    try{
      const r = await rsApi("POST","",{ rows, schedule: sched, source });
      if(sched.length) api("GET","").then(x=>{ DB = x; }).catch(()=>{});
      slot.innerHTML = `<div class="alert good"><span class="badge good">${ICON.good}Saved</span><div class="small"><b>${r.added} result${r.added===1?"":"s"} added.</b>${r.skipped?` ${r.skipped} were already saved.`:""}${r.marked?` ${r.marked} sample${r.marked===1?"":"s"} marked collected on the schedule.`:""}</div></div>`;
      SEL = null; Results(); document.getElementById("rs-slot").innerHTML = slot.innerHTML;
    }catch(e){ msg.className = "small flag"; msg.textContent = e.message; }
  };
}

/* ================= ANNUAL WATER QUALITY (CCR) ================= */
// The detected-contaminants table for the Consumer Confidence Report, from the imported sample results
// (and the daily log for chlorine). Most recent data within 5 years for tests not sampled that year.
let REPMODE = "mor";
const CCRINFO = {
  "Nitrate":{mclg:10, src:"Runoff from fertilizer use; leaching from septic tanks, sewage; erosion of natural deposits"},
  "Nitrite":{mclg:1, src:"Runoff from fertilizer use; leaching from septic tanks, sewage; erosion of natural deposits"},
  "Nitrate + nitrite":{mclg:10, src:"Runoff from fertilizer use; leaching from septic tanks, sewage; erosion of natural deposits"},
  "Arsenic":{mclg:0, src:"Erosion of natural deposits; runoff from orchards; runoff from glass and electronics production wastes"},
  "Barium":{mclg:2, src:"Discharge of drilling wastes; discharge from metal refineries; erosion of natural deposits"},
  "Fluoride":{mclg:4, src:"Erosion of natural deposits; water additive which promotes strong teeth; discharge from fertilizer and aluminum factories"},
  "Lead":{mclg:0, src:"Corrosion of household plumbing systems; erosion of natural deposits"},
  "Copper":{mclg:1.3, src:"Corrosion of household plumbing systems; erosion of natural deposits; leaching from wood preservatives"},
  "TTHM":{mclg:null, src:"By-product of drinking water chlorination"},
  "HAA5":{mclg:null, src:"By-product of drinking water disinfection"},
  "Chlorine":{mclg:4, src:"Water additive used to control microbes"},
  "Gross alpha":{mclg:0, src:"Erosion of natural deposits"},
  "Combined radium":{mclg:0, src:"Erosion of natural deposits"},
  "Uranium":{mclg:0, src:"Erosion of natural deposits"},
  "Cadmium":{mclg:0.005, src:"Corrosion of galvanized pipes; erosion of natural deposits"},
  "Chromium":{mclg:0.1, src:"Discharge from steel and pulp mills; erosion of natural deposits"},
  "Selenium":{mclg:0.05, src:"Discharge from petroleum and metal refineries; erosion of natural deposits"},
  "Sodium":{mclg:null, src:"Erosion of natural deposits; road salt"},
  "Total coliform":{mclg:0, src:"Naturally present in the environment"},
  "E. coli":{mclg:0, src:"Human and animal fecal waste"}
};
const SKIPCCR = new Set(["pH","Temperature","Turbidity","Alkalinity","Hardness"]);
/** 90th percentile of a lead/copper round: the sample at rank 0.9 × n (interpolated); fewer than 5 = average of the top two. */
function p90(vals){
  const v = vals.slice().sort((a,b)=>a-b), n = v.length;
  if(!n) return null; if(n===1) return v[0];
  if(n<5) return (v[n-1]+v[n-2])/2;
  const k = 0.9*n, lo = Math.floor(k), hi = Math.ceil(k);
  return lo===hi ? v[k-1] : v[lo-1] + (v[hi-1]-v[lo-1])*(k-lo);
}
const ccrUnit = u => u==="mg/L" ? "ppm" : u==="µg/L" ? "ppb" : u==="ng/L" ? "ppt" : u;
const r3 = v => v==null ? "—" : (+v.toPrecision(3)).toString();
function ccrRows(Y){
  const out = [], notDet = [];
  const by = {}; RS.results.forEach(r => (by[r.test] = by[r.test] || []).push(r));
  for(const [test, rs] of Object.entries(by)){
    if(SKIPCCR.has(test)) continue;
    const l = RS.limits[test] || {};
    // this year's results, or the most recent year within the last 5 that has some
    const yrs = [...new Set(rs.map(r=>+r.day.slice(0,4)))].filter(y=>y<=Y && y>Y-5).sort((a,b)=>b-a);
    if(!yrs.length) continue;
    const yr = yrs[0], set = rs.filter(r=>+r.day.slice(0,4)===yr);
    const unit = l.units && l.units!=="P/A" ? l.units : (set.find(r=>r.units)||{}).units || "";
    const info = CCRINFO[test] || {src:""};
    if(l.kind==="presence"){
      const pos = set.filter(r=>r.qual==="present");
      if(!pos.length){ notDet.push(test); continue; }
      const months = {}; pos.forEach(r=>{ const m=r.day.slice(0,7); months[m]=(months[m]||0)+1; });
      out.push({ test, unit:"positive samples", mcl: test==="E. coli" ? "Routine and repeat samples total coliform-positive and either is E. coli-positive" : "TT (assessment)", mclg:0,
        level: Math.max(...Object.values(months)) + " in one month", range: `${pos.length} of ${set.length} samples`, year: yr, viol: test==="E. coli" ? "Yes" : "No (assessment required)", src: info.src });
      continue;
    }
    const det = set.filter(r=>r.value!=null && r.qual!=="lt");
    const vals = det.map(r=>conv(r.value, r.units, unit)).filter(v=>v!=null);
    if(!vals.length){ notDet.push(test); continue; }
    const lim = l.limit!=null && l.units===unit ? l.limit : null;
    if(l.kind==="al"){
      const all = set.map(r => r.value==null||r.qual==="lt" ? 0 : conv(r.value, r.units, unit)).filter(v=>v!=null);
      const p = p90(all), overN = set.filter(r=>isOver(r,l)).length;
      out.push({ test, unit: ccrUnit(unit), mcl: lim!=null ? `AL = ${r3(lim)}` : "", mclg: info.mclg, level: `${r3(p)} (90th percentile)`, range: `${r3(Math.min(...all))}–${r3(Math.max(...all))}; ${overN} of ${set.length} sites over the AL`, year: yr,
        viol: lim!=null && p>lim ? "Exceeded AL" : "No", src: info.src });
      continue;
    }
    const hi = Math.max(...vals), lo = Math.min(...vals);
    out.push({ test, unit: ccrUnit(unit), mcl: l.kind==="smcl" ? `SMCL ${r3(lim)}` : lim!=null ? r3(lim) : "None", mclg: info.mclg, level: r3(hi), range: vals.length>1 || set.length>det.length ? `${set.length>det.length?"ND":r3(lo)}–${r3(hi)}` : "—", year: yr,
      viol: l.kind==="smcl" || lim==null ? "N/A" : hi>lim ? "Check*" : "No", src: info.src || (l.kind==="none" ? "Unregulated" : "") });
  }
  // chlorine from the daily log: highest running annual average of monthly averages, and the range
  const logs = sortedLogs().filter(x=>x.dist!=null && x.date<=`${Y}-12-31` && x.date>=`${Y-1}-01-01`);
  const yl = logs.filter(x=>x.date.startsWith(String(Y)));
  if(yl.length){
    const mAvg = {}; logs.forEach(x=>{ const m=x.date.slice(0,7); (mAvg[m]=mAvg[m]||[]).push(x.dist); });
    const ms = Object.keys(mAvg).sort(), avg = a => a.reduce((s,v)=>s+v,0)/a.length;
    let raa = 0; ms.filter(m=>m.startsWith(String(Y))).forEach(m => { const w = ms.filter(k=>k<=m).slice(-12).map(k=>avg(mAvg[k])); raa = Math.max(raa, avg(w)); });
    const v = yl.map(x=>x.dist);
    out.push({ test:"Chlorine (distribution)", unit:"ppm", mcl:"MRDL = 4", mclg:"MRDLG = 4", level:`${raa.toFixed(2)} (highest running annual average)`, range:`${Math.min(...v).toFixed(2)}–${Math.max(...v).toFixed(2)}`, year:Y, viol: raa>4 ? "Yes" : "No", src: CCRINFO.Chlorine.src });
  }
  out.sort((a,b)=>a.test.localeCompare(b.test));
  return { rows: out, notDet: notDet.sort() };
}
function CCR(year){
  if(!RS){ $view.innerHTML = '<p class="muted">Loading results…</p>'; rsApi("GET","").then(()=>CCR(year)).catch(e=>oops(e.message)); return; }
  const thisY = +TODAY.slice(0,4), Y = year || (thisY - 1);
  const { rows, notDet } = ccrRows(Y), S = DB.system;
  const years = []; for(let y=thisY; y>=thisY-6; y--) years.push(y);
  const head = ["Contaminant","Units","MCL / AL","MCLG","Level found","Range","Year sampled","Violation","Likely source"];
  const cells = r => [r.test, r.unit, r.mcl, r.mclg==null?"N/A":r.mclg, r.level, r.range, r.year, r.viol, r.src];
  const text = `WATER QUALITY DATA: ${Y} CONSUMER CONFIDENCE REPORT
System: ${S.name}   PWSID: ${S.pwsid}

DETECTED CONTAMINANTS
${rows.map(r=>`${r.test}: ${r.level} ${r.unit} (range ${r.range}; MCL ${r.mcl}; MCLG ${r.mclg==null?"N/A":r.mclg}; sampled ${r.year}; violation: ${r.viol})\n  Likely source: ${r.src}`).join("\n")||"None"}

Tested and not detected: ${notDet.join(", ")||"—"}
`;
  $view.innerHTML = `${repSwitch()}
    <h1>Annual water quality report</h1><p class="muted small">The detected-contaminants table for your Consumer Confidence Report (CCR), from your sample results and daily log. The CCR is due to customers by July 1, with the certification to TDEC.</p>
    <div class="card">
      <div class="row wrap no-print" style="align-items:flex-end;margin-bottom:12px">
        <div class="field" style="margin:0;width:180px"><label for="ccr-y">Report for year</label><select id="ccr-y">${years.map(y=>`<option ${y===Y?"selected":""}>${y}</option>`).join("")}</select></div>
        <button class="btn primary" id="ccr-print" type="button">Print or save PDF</button><button class="btn" id="ccr-csv" type="button">Download CSV</button><button class="btn" id="ccr-copy" type="button">Copy text</button><span class="small muted" id="ccr-msg"></span>
      </div>
      <div class="print-only"><h2 style="margin:0">${esc(S.name)}: ${Y} water quality data</h2><p class="small">PWSID ${esc(S.pwsid||"")}</p></div>
      ${!RS.results.length ? '<p class="small muted">No sample results yet. Import your lab reports on the Results tab first.</p>' : `
      <div style="overflow-x:auto"><table class="ccr"><thead><tr>${head.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>
      ${rows.map(r=>`<tr class="${/^(Yes|Exceeded|Check)/.test(r.viol)?"bad":""}">${cells(r).map((c,i)=>`<td class="${i===8?"src":""}">${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="9" class="muted">Nothing detected in ${Y} or the 4 years before.</td></tr>`}
      </tbody></table></div>
      <p class="small" style="margin-top:10px"><b>Tested and not detected:</b> ${esc(notDet.join(", ")||"none")}</p>
      ${rows.some(r=>r.viol==="Check*")?'<p class="small flag">* A single result is over the MCL. For some contaminants (nitrate, TTHM, HAA5, radionuclides) compliance is based on averages or confirmation samples. Confirm with TDEC whether it was a violation before you publish.</p>':""}
      <h3 style="margin:16px 0 6px">Definitions for the report</h3>
      <ul class="small" style="margin:0;padding-left:18px">
        <li><b>MCL</b> (Maximum Contaminant Level): the highest level of a contaminant allowed in drinking water.</li>
        <li><b>MCLG</b> (Maximum Contaminant Level Goal): the level below which there is no known or expected risk to health.</li>
        <li><b>AL</b> (Action Level): the concentration which, if exceeded, triggers treatment or other requirements.</li>
        <li><b>MRDL / MRDLG</b>: the highest level of a disinfectant allowed, and the goal below which there is no known risk.</li>
        <li><b>ND</b>: not detected. <b>ppm</b>: parts per million (mg/L). <b>ppb</b>: parts per billion (µg/L). <b>pCi/L</b>: picocuries per liter.</li>
      </ul>`}
      <p class="hint" style="margin-top:12px">Check every number against your lab reports and TDEC's records before you publish. The CCR also needs the required lead statement, health-effects language for any violation, and your contact information; TDEC's CCR guidance has the exact wording. Lead and copper 90th percentiles are calculated from the results you imported for the most recent round.</p>
    </div>`;
  wireSwitch();
  document.getElementById("ccr-y").onchange = e => CCR(+e.target.value);
  document.getElementById("ccr-print").onclick = () => window.print();
  document.getElementById("ccr-copy").onclick = async () => { try{ await navigator.clipboard.writeText(text); document.getElementById("ccr-msg").textContent = "Copied ✓"; }catch(e){ document.getElementById("ccr-msg").textContent = "Couldn't copy here."; } };
  document.getElementById("ccr-csv").onclick = () => {
    const q = v => '"' + String(v==null?"":v).replace(/"/g,'""') + '"';
    const csv = "﻿" + [head, ...rows.map(cells)].map(r=>r.map(q).join(",")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download = `water-quality-${Y}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  };
}
function repSwitch(){ return `<div class="seg no-print" role="tablist"><button type="button" data-rep="mor" aria-selected="${REPMODE==="mor"}">Monthly (MOR)</button><button type="button" data-rep="ccr" aria-selected="${REPMODE==="ccr"}">Annual water quality (CCR)</button></div>`; }
function wireSwitch(){ document.querySelectorAll("[data-rep]").forEach(b => b.onclick = () => { REPMODE = b.dataset.rep; REPMODE==="ccr" ? CCR() : Report(); }); }

/* ================= EMAIL ================= */
// Water system email from Outlook: what needs attention first, then everything else. Read-only.
let ML = null, MLFILTER = "attn", MLFLASH = null;
function mlApi(method, path, body){ return api(method, "/mail" + path, body).then(d => { ML = d; mailBadge(); return d; }); }
function mailBadge(){
  const n = ML ? ML.items.filter(i=>i.status==="new").length : 0;
  document.querySelectorAll('nav.tabs a[href="#email"]').forEach(a => { let b = a.querySelector(".nb"); if(!b){ b = document.createElement("span"); b.className = "nb"; a.appendChild(b); } b.textContent = n || ""; b.hidden = !n; });
}
function ago(iso){
  const d = new Date(iso), m = (Date.now()-d)/60000;
  if(m < 60) return Math.max(1,Math.round(m)) + " min ago";
  if(m < 24*60) return Math.round(m/60) + " h ago";
  return d.toLocaleDateString("en-US",{month:"short",day:"numeric"}) + (d.getFullYear()!==new Date().getFullYear() ? ", "+d.getFullYear() : "");
}
function Email(){
  // the message from connecting (kept until the list has loaded, then shown once)
  const h = location.hash.slice(1);
  if(/^email-(ok|error)=/.test(h)){ MLFLASH = { text: decodeURIComponent(h.split("=").slice(1).join("=")), bad: h.startsWith("email-error") }; ML = null; history.replaceState(null, "", "#email"); }
  const flash = ML && MLFLASH ? MLFLASH.text : "", bad = !!(MLFLASH && MLFLASH.bad);
  if(ML && MLFLASH) MLFLASH = null;
  if(!ML){ $view.innerHTML = '<p class="muted">Loading email…</p>'; mlApi("GET","").then(()=>{ if(route()==="email") Email(); }).catch(e=>oops(e.message)); return; }
  const attn = ML.items.filter(i=>i.status==="new"), done = ML.items.filter(i=>i.status==="done"), fyi = ML.items.filter(i=>i.status==="fyi");
  const show = MLFILTER==="attn" ? attn : MLFILTER==="fyi" ? fyi : done;
  const accts = ML.accounts;
  const last = accts.map(a=>a.syncedAt).filter(Boolean).sort().pop();
  $view.innerHTML = `
    <div class="row between wrap" style="margin-bottom:10px"><div><h1 style="margin:0">Email</h1><p class="muted small" style="margin:2px 0 0">Water system email from Outlook${accts.length?`, checked every 15 minutes${last?" (last "+ago(last)+")":""}`:""}. You get a phone notification when something new needs attention.</p></div>
      ${!CREW && accts.length ? '<button class="btn small" id="ml-sync" type="button">Check now</button>' : ""}</div>
    ${flash ? `<div class="alert ${bad?"crit":"good"}"><span class="badge ${bad?"crit":"good"}">${bad?ICON.crit:ICON.good}${bad?"Couldn't connect":"Connected"}</span><div class="small">${esc(bad?flash:flash+" is connected. Its water system email from the last 30 days is below.")}</div></div>` : ""}
    ${accts.some(a=>a.error) ? accts.filter(a=>a.error).map(a=>`<div class="alert warn"><span class="badge warn">${ICON.warn}${esc(a.email)}</span><div class="small">${esc(a.error)}${!CREW?' <a href="/api/admin/mail/connect">Reconnect</a>':""}</div></div>`).join("") : ""}
    ${!accts.length ? connectCard() : `
    <div class="seg" role="tablist">
      <button type="button" data-mf="attn" aria-selected="${MLFILTER==="attn"}">Needs attention${attn.length?` (${attn.length})`:""}</button>
      <button type="button" data-mf="fyi" aria-selected="${MLFILTER==="fyi"}">Other water email</button>
      <button type="button" data-mf="done" aria-selected="${MLFILTER==="done"}">Done</button>
    </div>
    <div class="card" style="padding:6px 16px">
      ${show.length ? show.map(mailRow).join("") : `<p class="small muted" style="margin:12px 0">${MLFILTER==="attn" ? "Nothing needs your attention right now. ✓" : MLFILTER==="fyi" ? "No other water system email in the last 45 days." : "Nothing marked done yet."}</p>`}
    </div>
    ${rulesCard()}
    <details class="card"><summary><b>Mailboxes</b> <span class="tiny muted">(${accts.length})</span></summary>
      ${accts.map(a=>`<div class="item"><div><div class="t">${esc(a.email)}</div><div class="s">${a.syncedAt?"Checked "+ago(a.syncedAt):"Not checked yet"}</div></div>${!CREW?`<button class="btn small danger" data-mdel="${a.id}" type="button">Disconnect</button>`:""}</div>`).join("")}
      ${!CREW ? `<p class="small" style="margin:10px 0 0"><a class="btn small" href="/api/admin/mail/connect">Connect another mailbox</a></p><p class="tiny muted">To add a second mailbox (like scott@deerfieldwater.com), sign out of Outlook in this browser first, or use a private window, so Microsoft asks which account.</p>` : ""}
    </details>`}`;
  document.querySelectorAll("[data-mf]").forEach(b => b.onclick = () => { MLFILTER = b.dataset.mf; Email(); });
  document.querySelectorAll("[data-mdone]").forEach(b => b.onclick = () => mlApi("POST", `/${b.dataset.mdone}/done`).then(Email).catch(e=>oops(e.message)));
  document.querySelectorAll("[data-mundo]").forEach(b => b.onclick = () => mlApi("POST", `/${b.dataset.mundo}/undone`).then(Email).catch(e=>oops(e.message)));
  document.querySelectorAll("[data-mflag]").forEach(b => b.onclick = () => mlApi("POST", `/${b.dataset.mflag}/flag`, { on: b.dataset.on==="1" }).then(Email).catch(e=>oops(e.message)));
  document.querySelectorAll("[data-mdel]").forEach(b => b.onclick = async () => {
    if(!confirm("Disconnect this mailbox? Its emails are removed from this list.")) return;
    const r = await fetch("/api/admin/mail/accounts/"+b.dataset.mdel, { method:"DELETE", headers:{"x-ch":"1"}, credentials:"same-origin" });
    if(!r.ok) return oops("Couldn't disconnect it.");
    ML = await r.json(); mailBadge(); Email();
  });
  document.querySelectorAll("[data-mstop]").forEach(b => b.onclick = () => stopMenu(ML.items.find(x => String(x.id)===b.dataset.mstop)));
  document.querySelectorAll("[data-ruledel]").forEach(b => b.onclick = () => mlApi("DELETE", "/rules/"+b.dataset.ruledel).then(Email).catch(e=>oops(e.message)));
  document.querySelectorAll("[data-radd]").forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const list = f.dataset.radd, type = f.querySelector("select").value, value = f.querySelector("input").value.trim(), btn = f.querySelector("button");
    if(!value) return;
    btn.disabled = true; btn.textContent = list==="allow" ? "Adding… (looking back 30 days)" : "Adding…";
    mlApi("POST", "/rules", { list, type, value }).then(Email).catch(err => { btn.disabled = false; btn.textContent = "Add"; oops(err.message); });
  });
  const sy = document.getElementById("ml-sync");
  if(sy) sy.onclick = async () => { sy.disabled = true; sy.textContent = "Checking…";
    try{ const r = await fetch("/api/admin/mail/sync",{method:"POST",headers:{"x-ch":"1"},credentials:"same-origin"}); const j = await r.json(); if(!r.ok) throw new Error(j.error||"Couldn't check."); ML = j; mailBadge(); Email(); }catch(e){ oops(e.message); sy.disabled = false; sy.textContent = "Check now"; } };
}
function mailRow(i){
  const reasons = (i.reasons||[]).filter(r=>!/^Due /.test(r));
  const dueSoon = i.due && i.due <= addDays(TODAY, 7);
  return `<div class="ml-row${i.urgent?" urgent":""}">
    <div class="ml-top"><b class="ml-from">${esc(i.senderName||i.sender)}</b><span class="tiny muted">${ago(i.received)}</span></div>
    <a class="ml-subj" href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.subject)}${i.attach?' <span class="tiny muted">📎</span>':""}</a>
    <div class="small muted ml-prev">${esc(i.preview)}</div>
    <div class="ml-tags">${i.urgent?`<span class="badge crit">${ICON.crit}Urgent</span>`:""}${i.due?`<span class="badge ${dueSoon?"warn":"neutral"}">${dueSoon?ICON.warn:""}Due ${nice(i.due)}</span>`:""}<span class="badge neutral">${esc(i.kind)}</span>${reasons.map(r=>`<span class="tiny muted">${esc(r)}</span>`).join(" · ")}</div>
    <div class="row wrap ml-acts"><a class="btn small" href="${esc(i.link)}" target="_blank" rel="noopener">Open in Outlook</a>
      ${i.status==="new" ? `<button class="btn small primary" data-mdone="${i.id}" type="button">Done</button><button class="btn small" data-mflag="${i.id}" data-on="0" type="button">Not important</button>`
      : i.status==="done" ? `<span class="tiny muted">Done${i.doneBy?" by "+esc(i.doneBy):""}</span><button class="btn small" data-mundo="${i.id}" type="button">Not done</button>`
      : `<button class="btn small" data-mflag="${i.id}" data-on="1" type="button">Needs attention</button>`}
      <button class="btn small ghostish" data-mstop="${i.id}" type="button">Stop these…</button>
      ${ML.accounts.length>1?`<span class="tiny muted">${esc(i.mailbox)}</span>`:""}</div><div class="ml-stop" id="ml-stop-${i.id}"></div></div>`;
}
const domainOf = e => String(e||"").toLowerCase().split("@")[1] || "";
const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|comcast|att|sbcglobal|bellsouth|charter|me)\./;
const subjKey = s => String(s||"").toLowerCase().replace(/^\s*((re|fw|fwd)\s*:\s*)+/i,"").replace(/[0-9]+/g,"#").replace(/[^a-z#&]+/g," ").replace(/\s+/g," ").trim();
/** "Stop these…" under an email: this sender, the whole domain, or emails with this kind of subject. */
function stopMenu(i){
  const box = document.getElementById("ml-stop-"+i.id);
  if(box.innerHTML){ box.innerHTML = ""; return; }
  const d = domainOf(i.sender), sk = subjKey(i.subject);
  const opts = [["sender", i.sender, `Everything from ${esc(i.sender)}`]];
  if(d && !FREE_MAIL.test(d)) opts.push(["domain", d, `Everything from anyone @${esc(d)}`]);
  if(sk.length >= 4) opts.push(["subject", sk, `Emails with subjects like “${esc(sk.replace(/#/g,"…"))}”`]);
  box.innerHTML = `<div class="stopbox"><div class="small"><b>Stop which emails?</b> They won't show here or notify anyone. You can undo it under Your email rules.</div>
    ${opts.map((o,n)=>`<button class="btn small" data-so="${n}" type="button">${o[2]}</button>`).join("")}</div>`;
  box.querySelectorAll("[data-so]").forEach(b => b.onclick = () => { const o = opts[+b.dataset.so]; b.disabled = true; b.textContent = "Stopping…";
    mlApi("POST", "/rules", { list:"block", type:o[0], value:o[1] }).then(Email).catch(e=>oops(e.message)); });
}
function rulesCard(){
  const R = ML.rules || { block:[], allow:[] };
  const T = { sender:"From", domain:"From anyone @", subject:"Subject like", word:"Has the words" };
  const row = r => `<div class="rule"><span class="tiny muted">${T[r.type]}</span> <b>${esc(r.type==="subject"?r.value.replace(/#/g,"…"):r.value)}</b><button class="linkbtn" data-ruledel="${r.id}" type="button">Remove</button></div>`;
  return `<details class="card" ${R.allow.length||R.block.length?"":""}><summary><b>Your email rules</b> <span class="tiny muted">(${R.allow.length} let through · ${R.block.length} stopped)</span></summary>
    <h3 style="margin:12px 0 4px">Always let these through</h3>
    <p class="tiny muted" style="margin:0 0 6px">Email from these addresses, or with these words, always shows here as needing attention, and you get a notification.</p>
    ${R.allow.map(row).join("") || '<p class="small muted" style="margin:4px 0">None yet.</p>'}
    <form class="rule-add" data-radd="allow"><select aria-label="Match"><option value="sender">Email address</option><option value="word">Word or phrase</option></select><input placeholder="name@example.com or a word like hydrant" aria-label="Address or word" autocapitalize="off"><button class="btn small primary" type="submit">Add</button></form>
    <h3 style="margin:16px 0 4px">Stopped</h3>
    <p class="tiny muted" style="margin:0 0 6px">These never show here and never notify. QuickBooks copies of your own invoices and Intuit deposit notices are left out already.</p>
    ${R.block.map(row).join("") || '<p class="small muted" style="margin:4px 0">None yet. Use “Stop these…” on an email, or add one here.</p>'}
    <form class="rule-add" data-radd="block"><select aria-label="Match"><option value="sender">Email address</option><option value="domain">Whole domain</option><option value="subject">Subject like</option><option value="word">Word or phrase</option></select><input placeholder="name@example.com, example.com or words" aria-label="What to stop" autocapitalize="off"><button class="btn small primary" type="submit">Add</button></form>
  </details>`;
}
function connectCard(){
  if(CREW) return `<div class="card"><h2>Not connected yet</h2><p class="small muted">The boss connects Outlook from the dashboard's Compliance page. Then water system email shows up here.</p></div>`;
  if(!ML.enabled) return `<div class="card"><h2>Connect Outlook</h2><p class="small">This needs a one-time setup in Microsoft's Azure portal and two settings in Render. The steps are in the guide Claude gave you. After that, a <b>Connect Outlook</b> button appears here.</p></div>`;
  return `<div class="card"><h2>Connect Outlook</h2><p class="small">Sign in with the mailbox that gets the water system email (TDEC, the lab, invoices). Crew Hours only <b>reads</b> mail: it can't send, move or delete anything. You can connect more than one mailbox.</p><a class="btn primary" href="/api/admin/mail/connect">Connect Outlook</a></div>`;
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
  if(REPMODE==="ccr") return CCR();
  if(!RS){ rsApi("GET","").then(()=>{ if(route()==="report") Report(month); }).catch(()=>{}); }
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
  const labs = (RS ? RS.results : []).filter(r => r.day>=from && r.day<=to);
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

LAB RESULTS THIS MONTH
${labs.length ? labs.map(r=>`  ${short(r.day).padEnd(7)} ${r.test}: ${r.result} ${r.units}${r.point?" at "+r.point:""}${isOver(r,RS.limits[r.test])?"  ** OVER LIMIT **":""}`).join("\n") : "  None imported"}

NOTES
${logs.filter(l=>l.notes).map(l=>`  ${short(l.date).padEnd(7)} ${l.notes}`).join("\n") || "  None"}
`;
  $view.innerHTML = `
    ${repSwitch()}
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
      <h3 style="margin:16px 0 6px">Lab results this month</h3>
      ${labs.length?`<table><thead><tr><th>Date</th><th>Test</th><th>Sample point</th><th class="r">Result</th></tr></thead><tbody>${labs.map(r=>`<tr><td style="white-space:nowrap">${short(r.day)}</td><td>${esc(r.test)}</td><td>${esc(r.point)}</td><td class="r num ${isOver(r,RS.limits[r.test])?"flag":""}">${esc(r.result)} ${esc(r.units)}</td></tr>`).join("")}</tbody></table>`:'<p class="small muted">None imported for this month. Add them on the Results tab.</p>'}
      <h3 style="margin:16px 0 6px">Notes</h3>
      ${logs.filter(l=>l.notes).length?`<table><tbody>${logs.filter(l=>l.notes).map(l=>`<tr><td style="white-space:nowrap;vertical-align:top">${short(l.date)}</td><td>${esc(l.notes)}</td></tr>`).join("")}</tbody></table>`:'<p class="small muted">None.</p>'}
      <details style="margin-top:14px"><summary class="small" style="cursor:pointer;color:var(--brand);font-weight:600">Plain-text version</summary><div class="report" id="rep" style="margin-top:8px;white-space:pre;font-size:12px">${esc(text)}</div></details>
      <div class="row wrap" style="margin-top:12px"><button class="btn primary" id="copy">Copy report</button><span class="small muted" id="copied"></span></div>
      <p class="hint" style="margin-top:10px">This is a summary to help you fill out the official form. It doesn't replace TDEC's required MOR format.</p>
    </div>`;
  wireSwitch();
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
      <div class="grid2">${F("operator","Operator name",S.operator)}${F("cert","Certification",S.cert)}${F("phone","Operator phone",S.phone||"","On lead and copper notices.")}${F("email","Operator email",S.email||"","On lead and copper notices.")}</div>
      ${F("minCl","Minimum distribution chlorine (mg/L)",S.minCl,"Tennessee requires at least 0.2 mg/L free chlorine.")}
      <div class="row"><button class="btn primary">Save</button><span class="small muted" id="ok"></span></div>
    </form>
    <div class="card"><h2>Your records</h2>
      <p class="small muted">Saved in Crew Hours, the same on every phone and on the dashboard. Managers use it from the crew app; the boss from the dashboard.</p>
      <div class="row wrap"><button class="btn small" id="exp">Download a copy (JSON)</button></div>
      <p class="tiny muted" style="margin:12px 0 0">Sampling frequencies and limits here are examples, so always follow the monitoring schedule TDEC issues for your system. Not affiliated with TDEC.</p>
    </div>`;
  document.getElementById("sf").onsubmit = e => { e.preventDefault();
    const b = {}; ["name","pwsid","type","pop","conn","operator","cert","phone","email","minCl"].forEach(k => b[k] = document.getElementById("s-"+k).value.trim());
    change("PUT", "/system", b, () => { Settings(); document.getElementById("sysname").textContent = DB.system.name; document.getElementById("ok").textContent = "Saved ✓"; }).catch(()=>{}); };
  document.getElementById("exp").onclick = () => {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(DB, null, 2)], {type:"application/json"}));
    a.download = "compliance-" + TODAY + ".json"; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
}

if (CREW && !TOKEN) signIn();
else api("GET", "").then(d => { DB = d; TODAY = d.today; render(); }).catch(e => { if (!/sign in/i.test(e.message)) { oops(e.message); $view.innerHTML = '<p class="muted">Couldn\'t load. Pull down to try again.</p>'; } });
