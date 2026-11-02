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
    setWeekApproved: function(a){ return ["POST", "/approve", { weekStart:a[1], approved:a[2] }]; },
    getTasks:        function(a){ return ["GET", "/tasks?kind=" + (a[1]||"task")]; },
    getRoads:        function(a){ return ["GET", "/roads?kind=" + (a[1]||"road")]; },
    getReadings:     function(){ return ["GET", "/readings"]; },
    logReadings:     function(a){ return ["POST", "/readings", a[1]]; },
    delReading:      function(a){ return ["DELETE", "/readings/" + a[1]]; },
    getRoad:         function(a){ return ["GET", "/roads/" + a[1]]; },
    logMow:          function(a){ return ["POST", "/roads/" + a[1] + "/mows", a[2]]; },
    delMow:          function(a){ return ["DELETE", "/mows/" + a[1]]; },
    newTask:         function(a){ return ["POST", "/tasks", a[1]]; },
    delTask:         function(a){ return ["DELETE", "/tasks/" + a[1]]; },
    addDayPhotos:    function(a){ return ["POST", "/day/" + a[1] + "/photos", { photos:a[2] }]; },
    delDayPhoto:     function(a){ return ["DELETE", "/day-photo/" + a[1]]; },
    doneTask:        function(a){ return ["POST", "/tasks/" + a[1] + "/done", { notes:a[2], photos:a[3] }]; }
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
    token=null; accessLoaded=false; try{ sessionStorage.removeItem("crewToken:"+SLUG); }catch(e){}
    $("log-screen").hidden=true; $("crew-screen").hidden=true; $("task-screen").hidden=true; $("road-screen").hidden=true; $("water-screen").hidden=true; $("tabs").hidden=true; $("who").hidden=true; $("pin-screen").hidden=false;
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
    $("tabs").hidden = false; $("tab-crew").hidden = !isBoss;
    $("tab-mine").setAttribute("aria-selected", which==="mine");
    $("tab-tasks").setAttribute("aria-selected", which==="tasks");
    $("tab-roads").setAttribute("aria-selected", which==="roads");
    $("road-screen").hidden = which!=="roads";
    $("tab-water").setAttribute("aria-selected", which==="water");
    $("water-screen").hidden = which!=="water";
    $("tab-crew").setAttribute("aria-selected", which==="crew");
    $("log-screen").hidden = which!=="mine";
    $("task-screen").hidden = which!=="tasks";
    $("crew-screen").hidden = which!=="crew";
    if(which==="crew") loadCrew(crewWeek || weekStartOf(today || new Date().toISOString().slice(0,10)));
    if(which==="tasks") taskBoard.load();
    if(which==="roads") roadBoard.load();
    if(which==="water") showWater(waterTab);
  }
  $("tab-roads").onclick = function(){ roadBoard.reset(); showScreen("roads"); };
  $("tab-water").onclick = function(){ showScreen("water"); };
  $("tab-mine").onclick = function(){ showScreen("mine"); if(week) loadWeek(week, sel); };
  $("tab-tasks").onclick = function(){ showScreen("tasks"); };
  $("tab-crew").onclick = function(){ showScreen("crew"); };
  function loadWeek(ws, select){
    setStatus("save-status","Loading…");
    call("getMyWeek",[token, ws], function(res){ applyWeek(res, select); setStatus("save-status",""); },
      function(msg){ setStatus("save-status",msg,"err"); });
  }
  function applyWeek(res, select){
    applyAccess(res);
    week=res.weekStart; days=res.days||{}; today=res.today; maxBack=(res.maxDaysBack!=null?res.maxDaysBack:settings.maxDaysBack); locked=!!res.locked;
    if(res.manager!==undefined && !!res.manager!==isBoss){ isBoss=!!res.manager; $("tab-crew").hidden=!isBoss; }
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
    showCalc(); drawDayPhotos();
  }
  // ---- photos of the day's work ----
  function drawDayPhotos(){
    var e=days[sel], pics=(e && e.photos) || [], th=$("dp-thumbs"); th.innerHTML="";
    setStatus("dp-status","");
    $("dp-hint").textContent = !e ? "(save your hours first)" : pics.length ? "("+pics.length+" of 6)" : "(optional)";
    pics.forEach(function(id){
      var x=document.createElement("div"); x.className="x"; var im=document.createElement("img"); im.alt="Photo"; photoInto(im, id, "day");
      im.onclick=function(){ if(im.src) viewer(im.src); }; x.appendChild(im);
      if(!locked){ var del=document.createElement("button"); del.type="button"; del.textContent="×"; del.setAttribute("aria-label","Remove photo");
        del.onclick=function(){ if(busy) return; busy=true; var d=sel; setStatus("dp-status","Removing…");
          call("delDayPhoto",[token, id], function(res){ busy=false; applyWeek(res, d); }, function(msg){ busy=false; setStatus("dp-status",msg,"err"); }); };
        x.appendChild(del); }
      th.appendChild(x);
    });
    $("dp-add").hidden = !e || locked || pics.length>=6;
  }
  $("dp-file").onchange = function(){
    var e=days[sel], room=6-((e && e.photos) || []).length, d=sel;
    var files=Array.prototype.slice.call(this.files||[], 0, Math.max(0, room)); this.value="";
    if(!files.length || busy) return;
    busy=true; setStatus("dp-status","Adding photos…");
    var pics=[];
    files.reduce(function(p, f){ return p.then(function(){ return shrink(f).then(function(x){ pics.push(x); }); }); }, Promise.resolve())
      .then(function(){
        call("addDayPhotos",[token, d, pics], function(res){ busy=false; applyWeek(res, d); setStatus("dp-status","Photos added.","ok"); },
          function(msg){ busy=false; setStatus("dp-status",msg,"err"); });
      }).catch(function(err){ busy=false; setStatus("dp-status",err.message,"err"); });
  };
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


  // Switching jobs: clocking in on the second tab clocks you out of the main tab, and coming back does the reverse.
  function autoSwitch(w, o){
    var m=function(t){ var p=t.split(":").map(Number); return p[0]*60+p[1]; }, later=function(a,b){ return a&&b&&m(b)>m(a); };
    var notes=[];
    if(w.s && !w.e && !w.o && later(w.s,o.s)){ w.o=o.s; notes.push("clocked you out of "+settings.mainLabel+" at "+clock(o.s)); }
    if(o.s && !o.e && !o.o && later(o.s,w.s)){ o.e=w.s; notes.push("clocked you out of "+settings.otherLabel+" at "+clock(w.s)); }
    if(o.s && !o.e && !o.o && w.o && w.b && later(o.s,w.b)){ o.e=w.b; notes.push("clocked you out of "+settings.otherLabel+" at "+clock(w.b)); }
    if(w.s && !w.e && w.o && !w.b && o.s && o.e && w.o===o.s){ w.e=w.o; w.o=""; }
    if(w.s && w.e && w.b && !w.o && later(w.e,w.b)){ w.o=w.e; w.e=""; }
    return notes;
  }

  $("save").onclick = function(){
    if(busy || locked) return;
    var start=$("start-in").value, end=$("end-in").value, summary=$("summary-in").value.trim();
    var oStart=$("ostart-in").value, oEnd=$("oend-in").value, oSummary=$("osummary-in").value.trim();
    var hasWork = start||end, hasOther = oStart||oEnd;
    var wOpen = start && !end, oOpen = oStart && !oEnd;
    var outT=$("out-in").value, inT=$("back-in").value;
    var oJob=$("ojob-in").value, oOutT=$("oout-in").value, oInT=$("oback-in").value;
    var W={s:start,e:end,o:outT,b:inT}, O={s:oStart,e:oEnd,o:oOutT,b:oInT};
    var switched = settings.otherEnabled === false ? [] : autoSwitch(W,O);
    start=W.s; end=W.e; outT=W.o; inT=W.b; oStart=O.s; oEnd=O.e; oOutT=O.o; oInT=O.b;
    $("start-in").value=start; $("end-in").value=end; $("out-in").value=outT; $("back-in").value=inT;
    $("ostart-in").value=oStart; $("oend-in").value=oEnd; $("oout-in").value=oOutT; $("oback-in").value=oInT;
    if(outT||inT) showBreak(true);
    if(oOutT||oInT) showOBreak(true);
    hasWork = start||end; hasOther = oStart||oEnd; wOpen = start && !end; oOpen = oStart && !oEnd;
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
    if(start && end && !summary) return bad(switched.length ? "You were clocked out of "+settings.mainLabel+" at "+clock(end)+". Add a short summary of what you did there." : "Add a short summary of what you did.","work");
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
      var sn = switched.length ? " We "+switched.join(" and ")+"." : "";
      setStatus("save-status", ((wOpen||oOpen) ? "Saved. Add your end time when you finish." : "Saved.")+sn,"ok");
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
      if(e.photos && e.photos.length){ var th=document.createElement("div"); th.className="thumbs";
        e.photos.forEach(function(id){ var im=document.createElement("img"); im.alt="Photo"; photoInto(im, id, "day"); im.onclick=function(){ if(im.src) viewer(im.src); }; th.appendChild(im); });
        row.appendChild(th); }
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


  // ---- shared helpers for photos ----
  var photoUrls={};
  function el(tag, cls, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; }
  function photoInto(img, id, kind){
    var key=(kind||"task")+id;
    if(photoUrls[key]){ img.src=photoUrls[key]; return; }
    fetch(API+(kind==="day" ? "/day-photo/" : kind==="road" ? "/road-photo/" : "/tasks/photo/")+id, { headers:{ Authorization:"Bearer "+token } })
      .then(function(r){ if(!r.ok) throw 0; return r.blob(); })
      .then(function(b){ photoUrls[key]=URL.createObjectURL(b); img.src=photoUrls[key]; }).catch(function(){});
  }
  function viewer(src){
    var v=el("div","viewer"), i=el("img"); i.src=src; i.alt="Photo"; v.appendChild(i);
    v.onclick=function(){ document.body.removeChild(v); }; document.body.appendChild(v);
  }
  // Phone photos are huge: shrink to 1600 px JPEG before sending.
  function shrink(file){
    return new Promise(function(ok, fail){
      var url=URL.createObjectURL(file), img=new Image();
      img.onload=function(){
        var s=Math.min(1, 1600/Math.max(img.width, img.height)), c=document.createElement("canvas");
        c.width=Math.round(img.width*s); c.height=Math.round(img.height*s);
        c.getContext("2d").drawImage(img,0,0,c.width,c.height); URL.revokeObjectURL(url);
        ok(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror=function(){ URL.revokeObjectURL(url); fail(new Error("Couldn't read that photo. Try a different one.")); };
      img.src=url;
    });
  }
  function shrinkAll(files){ var out=[]; return files.reduce(function(p,f){ return p.then(function(){ return shrink(f).then(function(x){ out.push(x); }); }); }, Promise.resolve()).then(function(){ return out; }); }
  function thumbsFor(ids, kind, alt){
    var th=el("div","thumbs");
    ids.forEach(function(id){ var im=el("img"); im.alt=alt||"Photo"; photoInto(im,id,kind); im.onclick=function(){ if(im.src) viewer(im.src); }; th.appendChild(im); });
    return th;
  }
  function photoPicker(max, statusEl){   // a "📷 Add photos" button with removable previews
    var pics=[], box=el("div",""), th=el("div","thumbs"), pick=el("label","photo-btn","📷 Add photos"), inp=el("input");
    box.style.cssText="display:flex;flex-direction:column;gap:8px";
    inp.type="file"; inp.accept="image/*"; inp.multiple=true; pick.appendChild(inp);
    function draw(){
      th.innerHTML="";
      pics.forEach(function(src,i){ var x=el("div","x"), im=el("img"); im.src=src; im.alt="New photo"; var del=el("button","","×"); del.type="button"; del.setAttribute("aria-label","Remove photo");
        del.onclick=function(){ pics.splice(i,1); draw(); }; x.appendChild(im); x.appendChild(del); th.appendChild(x); });
      pick.hidden = pics.length>=picker.max;
    }
    inp.onchange=function(){
      var files=Array.prototype.slice.call(inp.files||[], 0, Math.max(0, picker.max-pics.length)); inp.value="";
      if(!files.length) return;
      statusEl.textContent="Adding photos…"; statusEl.className="status";
      shrinkAll(files).then(function(x){ pics.push.apply(pics,x); statusEl.textContent=""; draw(); })
        .catch(function(e){ statusEl.textContent=e.message; statusEl.className="status err"; draw(); });
    };
    box.appendChild(th); box.appendChild(pick);
    var picker={ el:box, max:max, get:function(){ return pics.slice(); }, clear:function(){ pics=[]; draw(); }, redraw:draw };
    draw();
    return picker;
  }
  function statusLine(){ var s=el("div","status"); s.setAttribute("role","status"); return s; }
  function say(node,msg,cls){ node.textContent=msg||""; node.className="status"+(cls?" "+cls:""); }
  function dayLabel(d){ return DAYS[toUTC(d).getUTCDay()]+" "+short(d); }
  function ago(d){ var n=Math.round((toUTC(today)-toUTC(d))/864e5); return n<=0 ? "today" : n===1 ? "yesterday" : n+" days ago"; }
  function isMe(name){ return !!name && name===$("who-name").textContent; }

  // ---- a list of tasks: used for Tasks and for Water leaks & repairs ----
  function TaskBoard(kind, root, L){
    var me={ tasks:[], maxPhotos:6, openForm:null, onCount:null };
    root.classList.add("board");
    var top=el("div","row"), addBtn=el("button","ghost",L.add); addBtn.type="button"; top.appendChild(addBtn);
    var form=el("div","task"); form.hidden=true;
    form.appendChild(el("h3","",L.newTitle));
    var fT=el("input"); fT.maxLength=120; fT.placeholder=L.titlePh; fT.autocomplete="off";
    var fD=el("textarea"); fD.maxLength=2000; fD.placeholder=L.detailsPh;
    var fF=el("select"); [["me",L.forMe],["anyone",L.forAnyone]].forEach(function(o){ var x=el("option","",o[1]); x.value=o[0]; fF.appendChild(x); });
    var fDue=el("input"); fDue.type="date";
    [[L.titleLabel,fT],[L.detailsLabel,fD],["",fF],["Due (optional)",fDue]].forEach(function(x){ if(x[0]){ form.appendChild(el("label","",x[0])); } else { form.appendChild(el("label","",L.forLabel)); } form.appendChild(x[1]); });
    if(L.hideDue){ fDue.hidden=true; fDue.previousSibling.hidden=true; }
    var fRow=el("div","row"), fSave=el("button","primary",L.addSave), fCancel=el("button","ghost","Cancel"); fSave.type=fCancel.type="button";
    fRow.appendChild(fSave); fRow.appendChild(fCancel); form.appendChild(fRow);
    var fSt=statusLine(); form.appendChild(fSt);
    var list=el("div","tasklist"), empty=el("p","hint",L.empty), st=statusLine();
    empty.style.cssText="margin:0;text-align:center";
    [top,form,list,empty,st].forEach(function(n){ root.appendChild(n); });
    function showForm(on){ form.hidden=!on; top.hidden=on; say(fSt,""); if(on) fT.focus(); }
    addBtn.onclick=function(){ showForm(true); };
    fCancel.onclick=function(){ showForm(false); };
    fSave.onclick=function(){
      if(busy) return;
      if(!fT.value.trim()) return say(fSt,L.needTitle,"err");
      busy=true; fSave.disabled=true; say(fSt,"Saving…");
      call("newTask",[token,{ kind:kind, title:fT.value.trim(), details:fD.value, forMe:fF.value==="me", due:fDue.value||null }], function(res){
        busy=false; fSave.disabled=false; me.tasks=res.tasks||[]; fT.value=""; fD.value=""; fDue.value=""; showForm(false); draw(); say(st,L.addedOk,"ok");
      }, function(msg){ busy=false; fSave.disabled=false; say(fSt,msg,"err"); });
    };
    me.load=function(quiet){
      if(!token) return;
      if(!quiet && !me.tasks.length) say(st,"Loading…");
      call("getTasks",[token,kind], function(res){ me.tasks=res.tasks||[]; me.maxPhotos=res.maxPhotos||6; say(st,""); draw(); },
        function(msg){ if(!quiet) say(st,msg,"err"); });
    };
    function draw(){
      list.innerHTML="";
      var open=me.tasks.filter(function(t){ return t.status==="open"; }).length;
      if(me.onCount) me.onCount(open);
      empty.hidden = me.tasks.length>0;
      me.tasks.forEach(function(t){
        var done=t.status==="done", card=el("div","task"+(done?" done":""));
        card.appendChild(el("h3","",t.title));
        var meta=el("div","meta");
        if(done) meta.appendChild(el("span","ok",L.doneTag+(t.doneAt ? " "+new Date(t.doneAt).toLocaleDateString([], {month:"short", day:"numeric"}) : "")+(t.doneByName && !isMe(t.doneByName) ? " by "+t.doneByName : "")));
        else if(t.due) meta.appendChild(el("span", t.due<today ? "late" : "", (t.due<today ? "Overdue: " : "Due ")+dayLabel(t.due)));
        meta.appendChild(el("span","", t.assignedTo ? (t.assignedName && !isMe(t.assignedName) ? "For "+t.assignedName : "For you") : "For anyone on the crew"));
        card.appendChild(meta);
        if(t.createdByName) card.appendChild(el("div","by", isMe(t.createdByName) ? L.byYou : L.byOther+" "+t.createdByName));
        if(t.details) card.appendChild(el("p","details",t.details));
        if(done && t.doneNotes) card.appendChild(el("p","notes",t.doneNotes));
        if(t.photos && t.photos.length) card.appendChild(thumbsFor(t.photos,"task"));
        var room=me.maxPhotos-(t.photos||[]).length;
        if(me.openForm===t.id) card.appendChild(doneForm(t, room));
        else if(!done || room>0){
          var b=el("button", done ? "ghost" : "primary", done ? "Add more photos" : L.markDone); b.type="button";
          b.onclick=function(){ me.openForm=t.id; draw(); };
          var row=el("div","row"); row.appendChild(b); card.appendChild(row);
        }
        if(!done && isMe(t.createdByName) && me.openForm!==t.id){
          var dl=el("button","linkdel",L.del); dl.type="button";
          dl.onclick=function(){
            if(dl.textContent!=="Tap again to delete"){ dl.textContent="Tap again to delete"; setTimeout(function(){ dl.textContent=L.del; },3000); return; }
            call("delTask",[token,t.id], function(res){ me.tasks=res.tasks||[]; draw(); say(st,"Deleted.","ok"); }, function(msg){ say(st,msg,"err"); });
          };
          card.appendChild(dl);
        }
        list.appendChild(card);
      });
    }
    function doneForm(t, room){
      var f=el("div",""); f.style.cssText="display:flex;flex-direction:column;gap:10px";
      var done=t.status==="done", fst=statusLine();
      var notes=el("textarea"); notes.placeholder = done ? "Anything to add? (optional)" : L.donePh;
      if(done) notes.value=t.doneNotes||"";
      f.appendChild(el("label","", done ? "Notes" : L.whatYouDid)); f.appendChild(notes);
      var pk=photoPicker(room, fst); f.appendChild(pk.el);
      var row=el("div","row"), send=el("button","primary", done ? "Save" : L.doneSend), cancel=el("button","ghost","Cancel");
      send.type=cancel.type="button";
      cancel.onclick=function(){ me.openForm=null; draw(); };
      send.onclick=function(){
        if(busy) return;
        var pics=pk.get();
        if(!done && !notes.value.trim() && !pics.length) return say(fst,"Add a few words about what you did, or a photo.","err");
        busy=true; send.disabled=true; say(fst, pics.length ? "Sending photos…" : "Saving…");
        call("doneTask",[token,t.id,notes.value.trim(),pics], function(res){
          busy=false; me.openForm=null; me.tasks=res.tasks||[]; draw(); say(st, done ? "Saved." : L.doneOk,"ok");
        }, function(msg){ busy=false; send.disabled=false; say(fst,msg,"err"); });
      };
      row.appendChild(send); row.appendChild(cancel); f.appendChild(row); f.appendChild(fst);
      return f;
    }
    return me;
  }

  // ---- a list of places to visit: used for Roads mowed and Water system sites ----
  function PlaceBoard(kind, root, L){
    var me={ roads:[], open:null, road:null, max:4 };
    root.classList.add("board");
    var listView=el("div",""); listView.style.cssText="display:flex;flex-direction:column;gap:10px";
    listView.appendChild(el("p","hint",L.hint)).style.margin="0";
    var list=el("div","roadlist"), empty=el("p","hint",L.empty); empty.style.cssText="margin:0;text-align:center";
    listView.appendChild(list); listView.appendChild(empty);
    var view=el("div",""); view.style.cssText="display:flex;flex-direction:column;gap:14px"; view.hidden=true;
    var back=el("button","ghost",L.back); back.type="button"; back.style.alignSelf="flex-start"; view.appendChild(back);
    var card=el("div","task"), name=el("h3",""), last=el("div","meta"), info=el("div","roadinfo");
    var dayIn=el("input"); dayIn.type="date";
    var notes=el("textarea"); notes.maxLength=1000; notes.placeholder="Anything the boss should know";
    var fst=statusLine(), pk=photoPicker(4, fst);
    var save=el("button","primary",L.save); save.type="button";
    [name,last,info,el("label","",L.dateLabel),dayIn,pk.el,el("label","","Notes (optional)"),notes].forEach(function(n){ card.appendChild(n); });
    var srow=el("div","row"); srow.appendChild(save); card.appendChild(srow); card.appendChild(fst);
    var hcard=el("div","task"), hist=el("div","history"); hcard.appendChild(el("h3","","History")); hcard.appendChild(hist);
    view.appendChild(card); view.appendChild(hcard);
    var st=statusLine();
    [listView,view,st].forEach(function(n){ root.appendChild(n); });
    me.load=function(quiet, cb){
      if(!token) return;
      call("getRoads",[token,kind], function(res){
        me.roads=res.roads||[]; me.max=res.maxPhotos||4; pk.max=me.max; pk.redraw();
        if(cb) cb(me.roads.length);
        if(!quiet){ draw(); if(me.open) openPlace(me.open); else { listView.hidden=false; view.hidden=true; } }
      }, function(msg){ if(!quiet) say(st,msg,"err"); });
    };
    me.reset=function(){ me.open=null; view.hidden=true; listView.hidden=false; };
    function draw(){
      list.innerHTML=""; empty.hidden=me.roads.length>0; list.hidden=!me.roads.length;
      me.roads.forEach(function(r){
        var b=el("button","roadrow"); b.type="button";
        var nm=el("span","rname"); nm.appendChild(el("b","",r.name));
        var sub=[r.lengthMi!=null ? r.lengthMi+" mi" : "", r.surface||""].filter(Boolean).join(" · ");
        if(sub) nm.appendChild(el("span","rsub",sub));
        b.appendChild(nm);
        var n = r.lastDay ? Math.round((toUTC(today)-toUTC(r.lastDay))/864e5) : null;
        b.appendChild(el("span","when"+(r.lastDay ? (n>L.oldDays ? " old" : "") : " never"), r.lastDay ? short(r.lastDay)+" · "+ago(r.lastDay)+(r.lastBy ? "\n"+r.lastBy : "") : L.never));
        b.onclick=function(){ openPlace(r.id); };
        list.appendChild(b);
      });
    }
    function openPlace(id){
      me.open=id; listView.hidden=true; view.hidden=false; say(st,"Loading…");
      call("getRoad",[token,id], function(res){ say(st,""); me.road=res.road; pk.clear(); notes.value=""; dayIn.value=today; dayIn.max=today; drawPlace(); window.scrollTo(0,0); },
        function(msg){ say(st,msg,"err"); });
    }
    function drawPlace(){
      var road=me.road; name.textContent=road.name;
      var l=road.mows[0];
      last.textContent = l ? L.lastWord+" "+dayLabel(l.day)+" ("+ago(l.day)+")"+(l.byName ? " by "+l.byName : "") : L.never;
      info.innerHTML="";
      var facts=[road.lengthMi!=null ? road.lengthMi+" miles" : "", road.surface||""].filter(Boolean).join(" · ");
      if(facts) info.appendChild(el("div","muted",facts));
      var PL={1:"needs work",2:"soon",3:"can wait"}, chips=el("div","chips");
      [["Roadway",road.pRoad],["Ditch line",road.pDitch],["Trees",road.pTrees]].forEach(function(x){ if(x[1]) chips.appendChild(el("span","chip p"+x[1], x[0]+": "+PL[x[1]])); });
      if(chips.children.length) info.appendChild(chips);
      if(road.notes) info.appendChild(el("p","rnotes",road.notes));
      hist.innerHTML="";
      if(!road.mows.length) hist.appendChild(el("p","muted","Nothing logged yet."));
      road.mows.forEach(function(m){
        var row=el("div","hrow"), k=el("div","hk");
        k.appendChild(el("b","",dayLabel(m.day))); k.appendChild(el("span","muted",m.byName||""));
        row.appendChild(k);
        if(m.notes) row.appendChild(el("p","notes",m.notes));
        if(m.photos.length) row.appendChild(thumbsFor(m.photos,"road","Photo of "+road.name));
        if(isMe(m.byName)){
          var d=el("button","linkdel","Remove"); d.type="button";
          d.onclick=function(){
            if(d.textContent!=="Tap again to remove"){ d.textContent="Tap again to remove"; setTimeout(function(){ d.textContent="Remove"; },3000); return; }
            call("delMow",[token,m.id], function(res){ me.road=res.road; me.roads=res.roads||me.roads; drawPlace(); draw(); }, function(msg){ say(fst,msg,"err"); });
          };
          row.appendChild(d);
        }
        hist.appendChild(row);
      });
    }
    back.onclick=function(){ me.reset(); draw(); };
    save.onclick=function(){
      if(busy || !me.road) return;
      if(!dayIn.value) return say(fst,"Pick the date.","err");
      var pics=pk.get(), day=dayIn.value;
      busy=true; save.disabled=true; say(fst, pics.length ? "Sending photos…" : "Saving…");
      call("logMow",[token,me.road.id,{ day:day, notes:notes.value, photos:pics }], function(res){
        busy=false; save.disabled=false; me.road=res.road; me.roads=res.roads||me.roads; pk.clear(); notes.value="";
        drawPlace(); draw(); say(fst,L.savedMsg(me.road.name, short(day)),"ok");
      }, function(msg){ busy=false; save.disabled=false; say(fst,msg,"err"); });
    };
    return me;
  }

  // ---- the boards ----
  var features={ tasks:true, roads:true, w_readings:true, w_sites:true, w_repairs:true }, setup={ roads:0, waterSites:0, readingTypes:0 };
  var taskBoard=TaskBoard("task", $("task-screen"), { add:"+ Add a task", newTitle:"New task", titleLabel:"Task", titlePh:"e.g. Replace broken sprinkler head by the gate",
    detailsLabel:"Details (optional)", detailsPh:"Where it is, what's needed", forLabel:"For", forMe:"Me", forAnyone:"Anyone on the crew", addSave:"Add task", needTitle:"Give the task a name.",
    addedOk:"Task added. The boss can see it too.", empty:"No tasks right now. Tasks from the boss show up here, or add your own.", doneTag:"Done ✓", byYou:"Added by you", byOther:"Added by",
    markDone:"Mark done", del:"Delete this task", donePh:"What did you do? Anything the boss should know?", whatYouDid:"What you did", doneSend:"Done, send to boss", doneOk:"Sent to the boss. Nice work." });
  taskBoard.onCount=function(n){ $("task-count").hidden=!n; $("task-count").textContent=n; };
  var repairBoard=TaskBoard("repair", $("wp-repairs"), { add:"+ Report a leak or repair", newTitle:"Report a problem", titleLabel:"What and where", titlePh:"e.g. Leak at the meter by 141 Deer Meadow",
    detailsLabel:"Details (optional)", detailsPh:"How bad, what you saw, what's needed", forLabel:"Who's fixing it", forMe:"I'll fix it", forAnyone:"Needs someone", addSave:"Report it", needTitle:"Say what the problem is and where.",
    addedOk:"Reported. The boss got an email.", empty:"No open leaks or repairs.", doneTag:"Fixed ✓", byYou:"Reported by you", byOther:"Reported by",
    markDone:"Mark fixed", del:"Delete this report", donePh:"What did you fix? Parts used?", whatYouDid:"What you did", doneSend:"Fixed, send to boss", doneOk:"Marked fixed. Nice work.", hideDue:true });
  var roadBoard=PlaceBoard("road", $("road-screen"), { hint:"Tap a road to log that you mowed it.", empty:"No roads yet.", back:"‹ All roads", dateLabel:"Date you mowed it", save:"Save: mowed",
    never:"Not mowed yet", lastWord:"Last mowed", oldDays:14, savedMsg:function(n,d){ return "Saved. "+n+" marked mowed "+d+"."; } });
  var siteBoard=PlaceBoard("water", $("wp-sites"), { hint:"Tap a site to log a check.", empty:"The boss hasn't added any sites yet.", back:"‹ All sites", dateLabel:"Date you checked it", save:"Save: checked",
    never:"Not checked yet", lastWord:"Last checked", oldDays:7, savedMsg:function(n,d){ return "Saved. "+n+" checked "+d+"."; } });

  // ---- water readings ----
  var rTypes=[], rList=[];
  function loadReadings(quiet){
    if(!token || !features.w_readings) return;
    call("getReadings",[token], function(res){ rTypes=res.types||[]; rList=res.readings||[]; drawReadings(); }, function(msg){ if(!quiet) say($("rd-status"),msg,"err"); });
  }
  function drawReadings(){
    var g=$("rd-fields"), keep={};
    Array.prototype.forEach.call(g.querySelectorAll("input"), function(i){ keep[i.dataset.id]=i.value; });
    g.innerHTML="";
    rTypes.forEach(function(t){
      var l=el("label","",t.name+(t.unit ? " ("+t.unit+")" : "")), i=el("input"); i.type="number"; i.step="any"; i.inputMode="decimal"; i.dataset.id=t.id; i.value=keep[t.id]||"";
      l.appendChild(i); g.appendChild(l);
    });
    $("rd-form-card").hidden=!rTypes.length; $("rd-none").hidden=!!rTypes.length;
    var h=$("rd-history"); h.innerHTML="";
    if(!rList.length) h.appendChild(el("p","muted","No readings in the last 2 weeks."));
    var byId={}; rTypes.forEach(function(t){ byId[t.id]=t; });
    rList.forEach(function(r){
      var row=el("div","hrow"), k=el("div","hk"), d=new Date(r.takenAt);
      k.appendChild(el("b","",d.toLocaleDateString([], {weekday:"short", month:"short", day:"numeric"})+" "+d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})));
      k.appendChild(el("span","muted",r.byName||"")); row.appendChild(k);
      var v=el("div","vals");
      Object.keys(r.vals||{}).forEach(function(id){ var t=byId[id]; if(!t) return; var sp=el("span","",t.name+": "); sp.appendChild(el("b","",String(r.vals[id])+(t.unit ? " "+t.unit : ""))); v.appendChild(sp); });
      if(v.children.length) row.appendChild(v);
      if(r.notes) row.appendChild(el("p","notes",r.notes));
      if(isMe(r.byName) && Date.now()-d < 864e5){
        var del=el("button","linkdel","Remove"); del.type="button";
        del.onclick=function(){
          if(del.textContent!=="Tap again to remove"){ del.textContent="Tap again to remove"; setTimeout(function(){ del.textContent="Remove"; },3000); return; }
          call("delReading",[token,r.id], function(res){ rTypes=res.types||rTypes; rList=res.readings||[]; drawReadings(); }, function(msg){ say($("rd-status"),msg,"err"); });
        };
        row.appendChild(del);
      }
      h.appendChild(row);
    });
  }
  $("rd-save").onclick=function(){
    if(busy) return;
    var vals={}, any=false;
    Array.prototype.forEach.call($("rd-fields").querySelectorAll("input"), function(i){ if(i.value!==""){ vals[i.dataset.id]=i.value; any=true; } });
    if(!any && !$("rd-notes").value.trim()) return say($("rd-status"),"Enter at least one reading.","err");
    busy=true; $("rd-save").disabled=true; say($("rd-status"),"Saving…");
    call("logReadings",[token,{ vals:vals, notes:$("rd-notes").value }], function(res){
      busy=false; $("rd-save").disabled=false; rTypes=res.types||rTypes; rList=res.readings||[];
      Array.prototype.forEach.call($("rd-fields").querySelectorAll("input"), function(i){ i.value=""; }); $("rd-notes").value="";
      drawReadings(); say($("rd-status"),"Readings saved.","ok");
    }, function(msg){ busy=false; $("rd-save").disabled=false; say($("rd-status"),msg,"err"); });
  };

  // ---- water tab: sub-tabs ----
  var waterTab="readings";
  function waterParts(){
    return { readings: features.w_readings && setup.readingTypes>0, sites: features.w_sites && setup.waterSites>0,
             repairs: features.w_repairs && (setup.readingTypes>0 || setup.waterSites>0) };
  }
  function showWater(which){
    var parts=waterParts();
    if(!parts[which]) which = parts.readings ? "readings" : parts.sites ? "sites" : "repairs";
    waterTab=which;
    ["readings","sites","repairs"].forEach(function(k){
      $("wt-"+k).hidden=!parts[k]; $("wt-"+k).setAttribute("aria-selected", k===which); $("wp-"+k).hidden = k!==which;
    });
    $("w-tabs").hidden = [parts.readings,parts.sites,parts.repairs].filter(Boolean).length<2;
    if(which==="readings") loadReadings();
    if(which==="sites"){ siteBoard.reset(); siteBoard.load(); }
    if(which==="repairs") repairBoard.load();
  }
  $("wt-readings").onclick=function(){ showWater("readings"); };
  $("wt-sites").onclick=function(){ showWater("sites"); };
  $("wt-repairs").onclick=function(){ showWater("repairs"); };

  /** Show only the tabs this person can use, and only for things the boss has set up. */
  function applyAccess(res){
    if(res.features) features=res.features;
    if(res.setup) setup=res.setup;
    var p=waterParts();
    $("tab-tasks").hidden=!features.tasks;
    $("tab-roads").hidden=!(features.roads && setup.roads>0);
    $("tab-water").hidden=!(p.readings || p.sites || p.repairs);
    if(features.tasks && !accessLoaded) taskBoard.load(true);
    accessLoaded=true;
  }
  var accessLoaded=false;
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

