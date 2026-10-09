(function(){ if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function(){}); })();

(function(){
  var $ = function(id){ return document.getElementById(id); };
  var DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var LONG = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var pad2 = function(n){ return String(n).padStart(2,"0"); };

  // YYYY-MM-DD math in UTC (same as the server) so days never shift
  function toUTC(s){ var p=s.split("-").map(Number); return new Date(Date.UTC(p[0],p[1]-1,p[2])); }
  function shift(s,n){ var d=toUTC(s); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
  var settings = { weekStart: 1, mainLabel: "Work time", otherEnabled: true, otherLabel: "Other time", otherOptions: [], maxDaysBack: 14 };
  function weekStartOf(s){ return shift(s, -((toUTC(s).getUTCDay()-settings.weekStart+7)%7)); }
  function weekDates(ws){ var a=[]; for(var i=0;i<7;i++) a.push(shift(ws,i)); return a; }
  function short(s){ var d=toUTC(s); return MON[d.getUTCMonth()]+" "+d.getUTCDate(); }
  function fmt(h){ return (Math.round((Number(h)||0)*100)/100).toFixed(2); }
  function workHours(s,e,o,b){
    var h=spanHours(s,e); if(h===null) return null; if(!o||!b) return h;
    var m=function(t){ var p=t.split(":").map(Number); return p[0]*60+p[1]; }, base=m(s);
    var rel=function(t){ return (m(t)-base+1440)%1440; }, ro=rel(o), rb=rel(b), re=rel(e)||1440;
    if(!(ro>0 && ro<rb && rb<re)) return NaN;
    return Math.round((re-(rb-ro))/60*100)/100;
  }
  function spanHours(a,b){ if(!a||!b) return null; var x=a.split(":").map(Number), y=b.split(":").map(Number); var m=(y[0]*60+y[1])-(x[0]*60+x[1]); if(m<0) m+=1440; return Math.round(m/60*100)/100; }

  var token = null, today = null, maxBack = 14;
  var week = null, days = {}, sel = null, busy = false, locked = false;
  var isBoss = false, otherOptions = [], crewWeek = null, crewData = null, pick = null;
  function clock(t){ if(!t) return ""; var p=t.split(":").map(Number); return ((p[0]%12)||12)+":"+pad2(p[1])+(p[0]>=12?" PM":" AM"); }

  var SLUG = document.body.getAttribute("data-slug"), API = "/api/c/" + SLUG;
  // Each old Apps Script call maps onto the company's REST API.
  var ROUTES = {
    login:           function(a){ return ["POST", "/login", { pin: a[0] }]; },
    getMyWeek:       function(a){ return ["GET", "/week?start=" + encodeURIComponent(a[1]||"")]; },
    saveDay:         function(a){ return ["POST", "/day", { date:a[1],
                       work:  { start:a[2], end:a[3], summary:a[4], out:a[8], back:a[9] },
                       other: { start:a[5], end:a[6], summary:a[7], out:a[10], back:a[11], job:a[12] } }]; },
    clearDay:        function(a){ return ["DELETE", "/day/" + encodeURIComponent(a[1])]; },
    getCrewWeek:     function(a){ return ["GET", "/crew-week?start=" + encodeURIComponent(a[1]||"")]; },
    setWeekApproved: function(a){ return ["POST", "/approve", { weekStart:a[1], approved:a[2] }]; }
  };
  function call(fn, args, ok, fail){
    var r = ROUTES[fn](args), opts = { method: r[0], headers: { "x-ch": "1" } };
    if (token) opts.headers.Authorization = "Bearer " + token;
    if (r[2]) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(r[2]); }
    fetch(API + r[1], opts)
      .then(function(res){ return res.json().catch(function(){ return { error: "Something went wrong. Try again." }; }); })
      .then(function(res){
        if(res && !res.error){ if(res.settings) applySettings(res.settings); ok(res); return; }
        var msg = (res && res.error) || "Something went wrong. Try again.";
        if(msg==="SESSION_EXPIRED"){ signOut("You were signed out. Enter your PIN again."); return; }
        fail(msg);
      })
      .catch(function(){ fail(navigator.onLine ? "Couldn't reach the time log. Try again in a moment." : "No internet connection. Try again when you have signal."); });
  }
  var LONGD = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  function applySettings(s){
    settings = s;
    $("lbl-main").textContent = s.mainLabel; $("lbl-other").textContent = s.otherLabel;
    $("seg").className = "seg" + (s.otherEnabled ? "" : " single");
    var span = LONGD[s.weekStart] + " to " + LONGD[(s.weekStart+6)%7];
    $("wk-sub").textContent = "Week runs " + span; $("cw-sub").textContent = "Everyone's hours, " + span;
    setOptions(s.otherOptions || []);
    $("ojob-in").parentNode.hidden = !(s.otherOptions && s.otherOptions.length);
    if(!s.otherEnabled) showTab("work");
  }
  function setStatus(id,msg,cls){ var s=$(id); s.textContent=msg||""; s.className="status"+(cls?" "+cls:""); }

  // ---- PIN pad ----
  var pin = "";
  function drawDots(){ Array.prototype.forEach.call($("dots").children, function(d,i){ d.className = i<pin.length ? "on" : ""; }); }
  function press(k){
    if(busy) return;
    if(k==="clear") pin="";
    else if(k==="back") pin=pin.slice(0,-1);
    else if(pin.length<4) pin+=k;
    drawDots(); setStatus("pin-status","");
    if(pin.length===4) submitPin();
  }
  $("pad").addEventListener("click", function(e){ var b=e.target.closest("button"); if(b) press(b.getAttribute("data-k")); });
  document.addEventListener("keydown", function(e){
    if($("pin-screen").hidden) return;
    if(/^\d$/.test(e.key)) press(e.key); else if(e.key==="Backspace") press("back");
  });
  function submitPin(){
    busy = true; setStatus("pin-status","Checking…");
    call("login",[pin], function(res){
      busy=false; token=res.token; today=res.today; isBoss=!!res.manager;
      try{ sessionStorage.setItem("crewToken:"+SLUG, token); }catch(e){}
      pin=""; drawDots();
      enterLog(res.name);
    }, function(msg){ busy=false; pin=""; drawDots(); setStatus("pin-status",msg,"err"); });
  }

  function signOut(msg){
    token=null; try{ sessionStorage.removeItem("crewToken:"+SLUG); }catch(e){}
    $("log-screen").hidden=true; $("crew-screen").hidden=true; $("tabs").hidden=true; $("who").hidden=true; $("pin-screen").hidden=false;
    isBoss=false; crewData=null;
    setStatus("pin-status", msg||"");
  }
  $("logout").onclick = function(){ signOut(""); };

  // ---- log screen ----
  function enterLog(name){
    $("who-name").textContent = name; $("who").hidden=false;
    $("pin-screen").hidden=true; showScreen(isBoss ? "crew" : "mine");
    loadWeek(weekStartOf(today || new Date().toISOString().slice(0,10)), today);
  }
  function setOptions(list){
    if(!list || (list.join("|")===otherOptions.join("|") && $("ojob-in").options.length>1)) return;
    otherOptions = list.slice();
    var s=$("ojob-in"), keep=s.value; s.innerHTML='<option value="">Choose one…</option>';
    otherOptions.forEach(function(o){ var op=document.createElement("option"); op.value=o; op.textContent=o; s.appendChild(op); });
    s.value=keep;
  }
  function showScreen(which){
    $("tabs").hidden = !isBoss;
    $("tab-mine").setAttribute("aria-selected", which==="mine");
    $("tab-crew").setAttribute("aria-selected", which==="crew");
    $("log-screen").hidden = which!=="mine";
    $("crew-screen").hidden = which!=="crew";
    if(which==="crew") loadCrew(crewWeek || weekStartOf(today || new Date().toISOString().slice(0,10)));
  }
  $("tab-mine").onclick = function(){ showScreen("mine"); if(week) loadWeek(week, sel); };
  $("tab-crew").onclick = function(){ showScreen("crew"); };
  function loadWeek(ws, select){
    setStatus("save-status","Loading…");
    call("getMyWeek",[token, ws], function(res){ applyWeek(res, select); setStatus("save-status",""); },
      function(msg){ setStatus("save-status",msg,"err"); });
  }
  function applyWeek(res, select){
    week=res.weekStart; days=res.days||{}; today=res.today; maxBack=(res.maxDaysBack!=null?res.maxDaysBack:settings.maxDaysBack); locked=!!res.locked;
    if(res.manager!==undefined && !!res.manager!==isBoss){ isBoss=!!res.manager; $("tabs").hidden=!isBoss; }
    $("who-name").textContent = res.name; $("who").hidden=false;
    var dates = weekDates(week);
    sel = select && dates.indexOf(select)!==-1 ? select : (dates.indexOf(today)!==-1 ? today : dates[6]);
    if(sel>today) sel=today;
    drawWeek(); drawDay();
  }
  function editable(d){ return d<=today && d>=shift(today,-maxBack); }
  function drawWeek(){
    $("wk-label").textContent = short(week)+" – "+short(shift(week,6));
    $("wk-next").disabled = week >= weekStartOf(today);
    $("wk-prev").disabled = shift(week,-1) < shift(today,-maxBack);
    var strip=$("strip"); strip.innerHTML="";
    weekDates(week).forEach(function(d){
      var e=days[d], b=document.createElement("button"), dt=toUTC(d);
      var isOpen = e && (e.open || e.oOpen) && !(dayTotal(e)>0);
      b.className="day"+(e?"":" empty")+(isOpen?" open":"")+(d===today?" today":"");
      b.setAttribute("aria-pressed", d===sel);
      b.disabled = !editable(d);
      b.innerHTML='<span class="dn"></span><span class="dd"></span><span class="dh"></span>';
      b.children[0].textContent=DAYS[dt.getUTCDay()];
      b.children[1].textContent=dt.getUTCDate();
      b.children[2].textContent= isOpen ? "on" : e ? fmt(dayTotal(e)) : "–";
      b.onclick=function(){ sel=d; drawWeek(); drawDay(); setStatus("save-status",""); };
      strip.appendChild(b);
    });
    var tot=0; Object.keys(days).forEach(function(k){ tot+=dayTotal(days[k]); });
    $("my-total").textContent = fmt(tot)+" h";
  }
  function drawDay(){
    var e=days[sel], dt=toUTC(sel);
    $("day-title").textContent = LONG[dt.getUTCDay()]+", "+MON[dt.getUTCMonth()]+" "+dt.getUTCDate()+(sel===today?" · Today":"");
    $("start-in").value = e ? (e.start||"") : "";
    $("end-in").value = e ? (e.end||"") : "";
    $("summary-in").value = e ? (e.summary||"") : "";
    $("ostart-in").value = e ? (e.oStart||"") : "";
    $("oend-in").value = e ? (e.oEnd||"") : "";
    $("osummary-in").value = e ? (e.oSummary||"") : "";
    $("out-in").value = e ? (e.outT||"") : "";
    $("back-in").value = e ? (e.inT||"") : "";
    showBreak(!!(e && e.outT));
    $("ojob-in").value = e ? (e.oJob||"") : "";
    $("oout-in").value = e ? (e.oOutT||"") : "";
    $("oback-in").value = e ? (e.oInT||"") : "";
    showOBreak(!!(e && e.oOutT));
    $("clear").hidden = !e || locked;
    $("lock-note").hidden = !locked;
    ["start-in","end-in","out-in","back-in","summary-in","ojob-in","ostart-in","oend-in","oout-in","oback-in","osummary-in","save","break-add","obreak-add","break-remove","obreak-remove"]
      .forEach(function(id){ $(id).disabled = locked; });
    showTab(e && !(e.hours>0) && e.oHours>0 ? "other" : "work");
    showCalc();
  }
  function dayTotal(e){ return (Number(e.hours)||0)+(Number(e.oHours)||0); }
  function showCalc(){
    var w=workHours($("start-in").value,$("end-in").value,$("out-in").value,$("back-in").value);
    var o=workHours($("ostart-in").value,$("oend-in").value,$("oout-in").value,$("oback-in").value);
    if(w!==null && isNaN(w)) w=spanHours($("start-in").value,$("end-in").value);
    if(o!==null && isNaN(o)) o=spanHours($("ostart-in").value,$("oend-in").value);
    var wOpen = $("start-in").value && !$("end-in").value, oOpen = $("ostart-in").value && !$("oend-in").value;
    $("seg-work-h").textContent = wOpen ? "on" : w ? fmt(w) : "";
    $("seg-other-h").textContent = oOpen ? "on" : o ? fmt(o) : "";
    var sum = (w||0)+(o||0);
    $("hours-out").textContent = (wOpen||oOpen) ? (sum ? fmt(sum)+" + in progress" : "In progress") : (w===null && o===null) ? "–" : fmt(sum);
  }
  function showTab(which){
    $("seg-work").setAttribute("aria-selected", which==="work");
    $("seg-other").setAttribute("aria-selected", which==="other");
    $("panel-work").hidden = which!=="work";
    $("panel-other").hidden = which!=="other";
  }
  $("seg-work").onclick = function(){ showTab("work"); };
  $("seg-other").onclick = function(){ showTab("other"); };
  $("start-in").oninput = $("end-in").oninput = $("ostart-in").oninput = $("oend-in").oninput = $("out-in").oninput = $("back-in").oninput = $("oout-in").oninput = $("oback-in").oninput = showCalc;
  function showOBreak(on){ $("obreak-box").hidden=!on; $("obreak-add").hidden=on; }
  $("obreak-add").onclick = function(){ showOBreak(true); $("oout-in").focus(); };
  $("obreak-remove").onclick = function(){ $("oout-in").value=""; $("oback-in").value=""; showOBreak(false); showCalc(); };
  function showBreak(on){ $("break-box").hidden=!on; $("break-add").hidden=on; }
  $("break-add").onclick = function(){ showBreak(true); $("out-in").focus(); };
  $("break-remove").onclick = function(){ $("out-in").value=""; $("back-in").value=""; showBreak(false); showCalc(); };

  $("wk-prev").onclick = function(){ loadWeek(shift(week,-7), shift(week,-1)); };
  $("wk-next").onclick = function(){ var n=shift(week,7); loadWeek(n, n); };

  $("save").onclick = function(){
    if(busy || locked) return;
    var start=$("start-in").value, end=$("end-in").value, summary=$("summary-in").value.trim();
    var oStart=$("ostart-in").value, oEnd=$("oend-in").value, oSummary=$("osummary-in").value.trim();
    var hasWork = start||end, hasOther = oStart||oEnd;
    var wOpen = start && !end, oOpen = oStart && !oEnd;
    var outT=$("out-in").value, inT=$("back-in").value;
    var oJob=$("ojob-in").value, oOutT=$("oout-in").value, oInT=$("oback-in").value;
    function bad(msg, tab){ showTab(tab); setStatus("save-status",msg,"err"); }
    function breakOk(s0,e0,o0,b0){            // clocked out / back in fits inside the shift
      var m=function(t){ var p=t.split(":").map(Number); return p[0]*60+p[1]; }, rel=function(t){ return (m(t)-m(s0)+1440)%1440; };
      if(!e0) return rel(o0)>0 && (!b0 || rel(b0)>rel(o0));
      return !isNaN(workHours(s0,e0,o0,b0));
    }
    if(!hasWork && !hasOther) return bad("Enter a start time.","work");
    if(end && !start) return bad(settings.mainLabel+" needs a start time.","work");
    if(start && end && !(spanHours(start,end)>0)) return bad(settings.mainLabel+": end time must be different from start time.","work");
    if((outT||inT) && !start) return bad("Enter your start time before clock out / back in.","work");
    if(inT && !outT) return bad("Enter the clocked out time first.","work");
    if(outT && !inT && !wOpen) return bad("Enter the clocked back in time too (or clear the end time if you're still out).","work");
    if(outT && !breakOk(start,end,outT,inT)) return bad("Clocked out and back in must be between your start and end time, in that order.","work");
    if(start && end && !summary) return bad("Add a short summary of what you did.","work");
    if(oEnd && !oStart) return bad(settings.otherLabel+" needs a start time.","other");
    if(oStart && oEnd && !(spanHours(oStart,oEnd)>0)) return bad(settings.otherLabel+": end time must be different from start time.","other");
    if(hasOther && !oJob && settings.otherOptions && settings.otherOptions.length) return bad("Pick what the "+settings.otherLabel+" was for.","other");
    if((oOutT||oInT) && !oStart) return bad("Enter the "+settings.otherLabel+" start before clock out / back in.","other");
    if(oInT && !oOutT) return bad(settings.otherLabel+": enter the clocked out time first.","other");
    if(oOutT && !oInT && !oOpen) return bad(settings.otherLabel+": enter the clocked back in time too.","other");
    if(oOutT && !breakOk(oStart,oEnd,oOutT,oInT)) return bad(settings.otherLabel+": clocked out and back in must be between the start and end time, in that order.","other");
    busy=true; $("save").disabled=true; setStatus("save-status","Saving…");
    var d=sel;
    call("saveDay",[token, d, start, end, summary, oStart, oEnd, oSummary, outT, inT, oOutT, oInT, oJob], function(res){
      busy=false; $("save").disabled=false; applyWeek(res, d);
      setStatus("save-status", (wOpen||oOpen) ? "Saved. Add your end time when you finish." : "Saved","ok");
    }, function(msg){ busy=false; $("save").disabled=false; setStatus("save-status",msg,"err"); });
  };

  var armed=false;
  $("clear").onclick = function(){
    if(busy) return;
    if(!armed){ armed=true; $("clear").textContent="Tap again to clear"; setTimeout(function(){ armed=false; $("clear").textContent="Clear day"; },3000); return; }
    armed=false; $("clear").textContent="Clear day";
    busy=true; var d=sel;
    call("clearDay",[token, d], function(res){ busy=false; applyWeek(res, d); setStatus("save-status","Cleared","ok"); },
      function(msg){ busy=false; setStatus("save-status",msg,"err"); });
  };

  // ---- boss: crew week ----
  function loadCrew(ws){
    crewWeek = ws; setStatus("cw-status","Loading…");
    call("getCrewWeek",[token, ws], function(res){ crewData=res; crewWeek=res.weekStart; drawCrew(); setStatus("cw-status",""); },
      function(msg){ setStatus("cw-status",msg,"err"); });
  }
  function drawCrew(){
    var r=crewData, dates=weekDates(r.weekStart);
    $("cw-label").textContent = short(r.weekStart)+" – "+short(shift(r.weekStart,6));
    $("cw-next").disabled = r.weekStart >= weekStartOf(r.today);
    $("cw-state").textContent = r.approved ? "Approved" : "Not approved";
    $("cw-state").className = "pill " + (r.approved ? "done" : "open");
    $("cw-state-note").textContent = r.approved ? "Locked. Crew can't change these days." : "Crew can still change these days.";
    $("cw-approve").textContent = r.approved ? "Unlock week" : "Approve week";
    $("cw-approve").className = r.approved ? "ghost" : "primary";
    var head=$("cw-head"); head.innerHTML="<th>Crew</th>";
    dates.forEach(function(d){ var th=document.createElement("th"); th.textContent=DAYS[toUTC(d).getUTCDay()]+" "+toUTC(d).getUTCDate(); head.appendChild(th); });
    head.insertAdjacentHTML("beforeend","<th>Total</th>");
    var body=$("cw-body"); body.innerHTML="";
    var col=[0,0,0,0,0,0,0], logged=0, ot=0;
    r.people.forEach(function(p){
      var tr=document.createElement("tr"); tr.className="person"; tr.tabIndex=0;
      var td=document.createElement("td"); td.textContent=p.name;
      if(p.ot>0){ var pl=document.createElement("span"); pl.className="pill ot"; pl.textContent="OT "+fmt(p.ot); td.appendChild(pl); ot++; }
      tr.appendChild(td);
      dates.forEach(function(d,i){ var e=p.days[d], h=e?e.total:0; col[i]+=h; var c=document.createElement("td");
        var on = e && (e.open||e.oOpen) && !h;
        c.className = on ? "on" : "n"+(h?"":" z"); c.textContent = on ? "on" : h?fmt(h):"–"; tr.appendChild(c); });
      var t=document.createElement("td"); t.className="n t"; t.textContent=fmt(p.total); tr.appendChild(t);
      if(p.total>0) logged++;
      if(pick===p.name) tr.className="person sel";
      var toggle=function(){ pick = pick===p.name ? null : p.name; drawCrew(); if(pick) $("cw-detail").scrollIntoView({behavior:"smooth",block:"nearest"}); };
      tr.onclick=toggle; tr.onkeydown=function(ev){ if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); toggle(); } };
      body.appendChild(tr);
    });
    drawDetail(dates);
    var foot=$("cw-foot"); foot.innerHTML="<td>Crew total</td>";
    col.forEach(function(h){ var c=document.createElement("td"); c.className="n"; c.textContent=fmt(h); foot.appendChild(c); });
    var g=document.createElement("td"); g.className="n"; g.textContent=fmt(r.grand); foot.appendChild(g);
    $("cw-hours").textContent=fmt(r.grand); $("cw-people").textContent=logged+"/"+r.people.length; $("cw-ot").textContent=ot;
  }
  function line(label, start, end, outT, inT, note){
    var l=document.createElement("div"); l.className="l";
    var m=document.createElement("span"); m.className="m"; m.textContent=label+": ";
    l.appendChild(m);
    var span = end ? clock(start)+"–"+clock(end) : "started "+clock(start)+", still on the clock";
    var away = outT ? (inT ? " (out "+clock(outT)+"–"+clock(inT)+")" : " (clocked out "+clock(outT)+", not back yet)") : "";
    l.appendChild(document.createTextNode(span+away+(note?" · "+note:"")));
    return l;
  }
  function drawDetail(dates){
    var box=$("cw-detail"), p=crewData.people.filter(function(x){ return x.name===pick; })[0];
    box.hidden=!p; $("cw-hint").hidden=!!p; if(!p) return;
    box.innerHTML="";
    var h=document.createElement("h2"); h.textContent=p.name+" · "+fmt(p.total)+" h"; box.appendChild(h);
    var any=false;
    dates.forEach(function(d){ var e=p.days[d]; if(!e) return; any=true;
      var row=document.createElement("div"); row.className="d";
      var k=document.createElement("div"); k.className="k"; k.textContent=LONG[toUTC(d).getUTCDay()]+", "+short(d)+" · "+fmt(e.total)+" h"; row.appendChild(k);
      if(e.hours>0 || e.open) row.appendChild(line(settings.mainLabel, e.start, e.end, e.outT, e.inT, e.summary));
      if(e.oHours>0 || e.oOpen) row.appendChild(line(settings.otherLabel+(e.oJob?" ("+e.oJob+")":""), e.oStart, e.oEnd, e.oOutT, e.oInT, e.oSummary));
      box.appendChild(row);
    });
    if(!any){ var n=document.createElement("p"); n.className="muted"; n.style.margin="0"; n.textContent="Nothing logged this week."; box.appendChild(n); }
  }
  $("cw-prev").onclick = function(){ pick=null; loadCrew(shift(crewWeek,-7)); };
  $("cw-next").onclick = function(){ pick=null; loadCrew(shift(crewWeek,7)); };
  var approveArmed=false;
  $("cw-approve").onclick = function(){
    if(!crewData || busy) return;
    var want=!crewData.approved;
    if(!approveArmed){ approveArmed=true; $("cw-approve").textContent = want ? "Tap again to approve" : "Tap again to unlock";
      setTimeout(function(){ approveArmed=false; if(crewData) drawCrew(); },3000); return; }
    approveArmed=false; busy=true; setStatus("cw-status", want ? "Approving…" : "Unlocking…");
    call("setWeekApproved",[token, crewData.weekStart, want], function(res){
      busy=false; crewData=res; drawCrew(); setStatus("cw-status", want ? "Week approved and locked" : "Week unlocked","ok");
    }, function(msg){ busy=false; setStatus("cw-status",msg,"err"); });
  };

  // resume a session from this tab if there is one
  try { token = sessionStorage.getItem("crewToken:"+SLUG); } catch(e){}
  fetch(API + "/info").then(function(r){ return r.json(); }).then(function(r){
    if(r.settings) applySettings(r.settings); else if(r.error) setStatus("pin-status", r.error, "err");
  }).catch(function(){});
  if(token){
    $("pin-screen").hidden=true; $("log-screen").hidden=false;
    call("getMyWeek",[token, ""],
      function(res){ applyWeek(res, res.today); showScreen(isBoss ? "crew" : "mine"); },
      function(msg){ signOut(msg); });
  }
})();

