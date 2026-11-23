/* Top Tea Talents — single-page app. Hash routing, API client, all screens.
   Sections: (1) config + helpers, (2) API client, (3) auth/session,
   (4) router, (5) shared UI bits, (6) screens, (7) join wizard,
   (8) photos, (9) ledger / contacts / agencies, (10) init. */

/* ---------- (1) config + helpers ---------- */
var API = "";
function apiBase(){
  if (window.__TTT_API__) return String(window.__TTT_API__).replace(/\/+$/,"");
  try { return (localStorage.getItem("ttt_api_url")||"").replace(/\/+$/,""); } catch(e){ return ""; }
}
function loadApiConfig(){
  // api-config.js is written by the deploy workflow from repo var TTT_API_URL.
  // It may not exist (front-end-only deploy) — a failed fetch is normal, not an error.
  return fetch("api-config.js", {cache:"no-store"}).then(function(r){
    if(!r.ok) return;
    return r.text().then(function(t){
      var m = t.match(/window\.__TTT_API__\s*=\s*"([^"]*)"/);
      if(m) window.__TTT_API__ = m[1];
    });
  }).catch(function(){ /* no api-config.js — backend not configured */ });
}
function $(sel, root){ return (root||document).querySelector(sel); }
function esc(s){
  if(s===null||s===undefined) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function money(cents){
  if(cents===null||cents===undefined||cents==="") return "";
  var n = Number(cents)/100;
  if(isNaN(n)) return String(cents);
  return "$" + n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtDate(s){
  if(!s) return "";
  var d = new Date(s);
  if(isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"});
}
function fmtDT(s){
  if(!s) return "";
  var d = new Date(s);
  if(isNaN(d.getTime())) return String(s);
  return d.toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});
}
function payText(o){
  var c = o.compensation || o.pay || o.compensation_text || "";
  if(c) return esc(c);
  return '<span class="muted">Pay not stated</span>';
}
function locText(o){
  var l = o.location;
  if(!l) return "";
  if(typeof l === "string") return l;
  return [l.city, l.county, l.state].filter(Boolean).join(", ");
}
function isExpired(o){
  if(!o.deadline) return false;
  var d = new Date(o.deadline);
  return !isNaN(d.getTime()) && d < new Date(new Date().toDateString());
}
function selBadge(o){
  var s = o.selectivity||"unknown";
  if(s==="guaranteed") return '<span class="badge" style="border-color:var(--gold);color:var(--gold)">GUARANTEED — open call'+(o.selectivityReason?" · "+esc(o.selectivityReason):"")+'</span>';
  if(s==="selective") return '<span class="badge">SELECTIVE — audition'+(o.selectivityReason?" · "+esc(o.selectivityReason):"")+'</span>';
  return '<span class="badge">Selectivity unknown</span>';
}
function genderReqLine(o){
  if(!o.genderRequirement) return "Open to all genders";
  return (o.genderRequirement==="female"?"Female only":"Male only")+" — roles that require a different gender never appear in your matches";
}
function verBadge(o){
  var v = (o.verification_status||"").toUpperCase();
  if(v==="VERIFIED") return '<span class="badge badge-verified">VERIFIED</span>';
  if(v==="PARTIALLY_VERIFIED") return '<span class="badge badge-partial">PARTIALLY VERIFIED</span>';
  if(v==="UNVERIFIED") return '<span class="badge badge-unverified">UNVERIFIED</span>';
  return "";
}
/* Brand mark: the splash SVG is the single source — header, hero, and join
   screens clone it. Crown on top (TOP), teacup (TEA), steam rising. */
function brandMarkSVG(size){
  var src = document.querySelector("#splash-mark svg");
  if(!src) return "";
  var c = src.cloneNode(true);
  c.setAttribute("width", size); c.setAttribute("height", size);
  return c.outerHTML;
}
/* v18 fix #8: the splash gate is gone — content shows at once. The splash
   markup stays in the DOM only as the brand-mark SVG source (header, hero,
   and join screens clone it); it is hidden immediately here and by CSS, and
   never waits on a tap or a timer. No audio on this page. */
function initSplash(){
  var hm = $("#header-mark"); if(hm) hm.innerHTML = brandMarkSVG(30);
  var s = $("#splash"); if(!s) return;
  s.classList.add("splash-hide"); s.classList.add("hidden");
}
function emptyBox(msg){ return '<div class="empty">'+esc(msg)+'</div>'; }
function errBox(msg){ return '<div class="error-box" role="alert">'+esc(msg)+'</div>'; }
function okBox(msg){ return '<div class="success-box" role="status">'+esc(msg)+'</div>'; }
function loadingBox(msg){ return '<div class="card"><p class="muted">'+esc(msg||"Loading…")+'</p></div>'; }
/* Agency review windows (owner policy 2026-11-22): the agency reviews
   profiles three times a day — 9:00 AM, 12:00 PM, and 4:00 PM Eastern.
   A profile not in by the 4:00 PM review waits until the next day, unless
   the talent emails the agency directly. */
var AGENCY_EMAIL = "topteatalents@gmail.com"; // agency contact — swapped from moocho954@gmail.com once the agency Gmail existed (Nov 23 00:0x EST).
function reviewWindowsNotice(){
  return '<p class="notice-box">Agency review runs three times a day — <strong>9:00 AM, 12:00 PM, and 4:00 PM Eastern</strong>. If your profile is not in by the 4:00 PM review, it waits until the next day. Need it sooner? Email the agency directly at <a href="mailto:'+AGENCY_EMAIL+'">'+AGENCY_EMAIL+'</a>.</p>';
}
function isAwaitingReview(t){
  var s = ((t && (t.readiness_status || t.status)) || "").toString().toUpperCase();
  return s.indexOf("AWAITING") >= 0;
}
function apiBanner(){
  var b = $("#api-banner");
  if(!b) return;
  if(!apiBase()){
    b.classList.remove("hidden");
    b.textContent = "Backend not configured yet — showing site copy only. No live numbers until the API is connected.";
  } else { b.classList.add("hidden"); b.textContent = ""; }
}
function qs(name){
  var m = location.hash.match(new RegExp("[?&]"+name+"=([^&]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

/* ---------- (2) API client ---------- */
function api(path, opts){
  opts = opts || {};
  var base = apiBase();
  if(!base) return Promise.reject(new Error("Backend not configured yet — set the API URL (TTT_API_URL) or localStorage ttt_api_url."));
  var headers = {"Content-Type":"application/json"};
  var tok = opts.token || adminToken() || sessionToken();
  if(tok) headers["Authorization"] = "Bearer " + tok;
  return fetch(base + path, {
    method: opts.method || "GET",
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function(r){
    return r.text().then(function(t){
      var data = null;
      try { data = t ? JSON.parse(t) : null; } catch(e){ data = {raw:t}; }
      if(!r.ok){
        var msg = (data && (data.error || data.message)) || ("Request failed (" + r.status + ")");
        throw new Error(msg);
      }
      return data;
    });
  });
}
function apiGet(path){ return api(path); }

/* ---------- API field mapping: wizard/profile forms use snake_case keys; the API speaks camelCase. ----------
   toApiProfile(d, skipEmptyArrays): the wizard passes skipEmptyArrays=true.
   Why: the wizard re-saves a step after re-entry, and a blank box there means
   "not entered on this step", NOT "delete what is saved" — sending [] would
   overwrite saved languages/skills/categories/availability with nothing (the
   wizard-drop bug, reproduced live 2026-11-22: 80% -> 60%). Edit My Profile
   calls it without the flag, so clearing a box there still deliberately
   clears that field (its form renders from the saved record, so blank there
   is a real choice, not an untouched step). */
var PROFILE_KEY_MAP = {first_name:"firstName", last_name:"lastName", professional_name:"professionalName", travel_radius:"travelRadius", age_range:"ageRange", hair_color:"hairColor", eye_color:"eyeColor", min_compensation:"minCompensation", union_affiliation:"unionAffiliation", adult_or_minor:"adultOrMinor", contact_method:"contactMethod", share_photos:"sharePhotos"};
function toApiProfile(d, skipEmptyArrays){
  var b = {};
  Object.keys(PROFILE_KEY_MAP).forEach(function(k){ if(d[k]!==undefined && d[k]!=="") b[PROFILE_KEY_MAP[k]]=d[k]; });
  ["phone","city","state","zip","height","experience","availability","languages","skills","categories","adultOrMinor","minCompensation","unionAffiliation","clothing","clothingSizes","measurements","resume","demoReel","portfolioLinks","contactMethod","notifyEmail","notifySms","location","visibility","sharePhotos","paused"].forEach(function(k){
    if(d[k]===undefined || d[k]==="") return;
    if(skipEmptyArrays && Array.isArray(d[k]) && d[k].length===0) return;
    b[k]=d[k];
  });
  if(d.gender!==undefined || d.ethnicity!==undefined){
    b.demographics = {gender: d.gender||null, ethnicity: d.ethnicity||null};
  }
  return b;
}
/* Add snake_case aliases to a talent object returned by the API, so the UI's existing reads keep working. */
function normTalent(t){
  if(!t) return t;
  Object.keys(PROFILE_KEY_MAP).forEach(function(k){ var ck = PROFILE_KEY_MAP[k]; if(t[ck]!==undefined && t[k]===undefined) t[k]=t[ck]; });
  if(t.demographics){ if(t.gender===undefined) t.gender=t.demographics.gender; if(t.ethnicity===undefined) t.ethnicity=t.demographics.ethnicity; }
  if(t.guardian){ if(t.guardian_name===undefined) t.guardian_name=t.guardian.guardianName||""; if(t.guardian_contact===undefined) t.guardian_contact=t.guardian.guardianEmail||t.guardian.guardianPhone||""; }
  return t;
}

/* ---------- wizard repopulation (owner order 2026-11-22) ----------
   The wizard used to read the device-local draft only, so re-entering after
   the draft was gone (new device, cleared storage, or a previous Finish
   removing it) showed blank fields even though the server had the answers —
   and submitting a step then overwrote saved array values with [] (the
   wizard-drop bug, reproduced live 2026-11-22: 80% -> 60%).
   mergeDraftWithProfile fills the draft from the saved server profile (p is
   a normTalent'ed profile, so both casings are present):
   - scalars: the server is the durable record, so it wins when present.
   - arrays (availability/categories/skills/languages): the draft wins only
     when non-empty (chip taps not yet submitted); otherwise the server fills
     the blank, so nothing already saved ever comes back empty. */
function mergeDraftWithProfile(d, p){
  if(!p) return d;
  var demo = p.demographics || {};
  var scalarMap = {first_name:"firstName", last_name:"lastName", professional_name:"professionalName", email:"email", phone:"phone", city:"city", state:"state", zip:"zip", travel_radius:"travelRadius", age_range:"ageRange", gender:"gender", ethnicity:"ethnicity", hair_color:"hairColor", eye_color:"eyeColor", height:"height", experience:"experience", min_compensation:"minCompensation", union_affiliation:"unionAffiliation", contact_method:"contactMethod", adult_or_minor:"adultOrMinor"};
  Object.keys(scalarMap).forEach(function(snake){
    var camel = scalarMap[snake];
    var v = (p[camel]!==undefined && p[camel]!=="" && p[camel]!==null) ? p[camel] : p[snake];
    if((v===undefined || v==="" || v===null) && demo[camel]!==undefined && demo[camel]!=="" && demo[camel]!==null) v = demo[camel];
    if(v!==undefined && v!=="" && v!==null) d[snake]=v;
  });
  ["availability","categories","skills","languages"].forEach(function(k){
    if(Array.isArray(d[k]) && d[k].length) return; // unsaved chip picks stay
    if(Array.isArray(p[k])) d[k]=p[k].slice();
  });
  return d;
}
/* Debounced server sync for chip taps while the wizard is open: the draft
   saves locally on every tap already; this also lands it on the server
   profile so a closed tab loses nothing. Skipped while a step submit is in
   flight, and never sends empty arrays (see toApiProfile). */
var wizardSyncTimer = null, wizardSubmitting = false;
function scheduleWizardSync(d){
  if(!isLoggedIn()) return;
  if(wizardSyncTimer) clearTimeout(wizardSyncTimer);
  wizardSyncTimer = setTimeout(function(){
    if(wizardSubmitting) return;
    api("/api/v1/talent/"+encodeURIComponent(sessionTalentId()), {method:"PATCH", body:toApiProfile(d, true)}).catch(function(){ /* draft still holds it; the step submit retries */ });
  }, 800);
}

/* ---------- (3) auth / session ---------- */
function sessionToken(){ try{ return localStorage.getItem("ttt_token")||""; }catch(e){ return ""; } }
function sessionTalentId(){ try{ return localStorage.getItem("ttt_talent_id")||""; }catch(e){ return ""; } }
function isLoggedIn(){ return !!sessionToken() && !!sessionTalentId(); }
function isAdmin(){ try{ return !!localStorage.getItem("ttt_admin_token"); }catch(e){ return false; } }
function adminToken(){ try{ return localStorage.getItem("ttt_admin_token")||""; }catch(e){ return ""; } }
/* Owner gate (v10): the owner unlocks with a passcode; the 12-hour owner
   session token lives in localStorage until locked or expired. Agency
   money is fetched ONLY with this token (or the admin token). */
function ownerToken(){ try{ return localStorage.getItem("ttt_owner_token")||""; }catch(e){ return ""; } }
function ownerTokenValid(){
  try{
    var exp = localStorage.getItem("ttt_owner_expires")||"";
    return !!localStorage.getItem("ttt_owner_token") && (!exp || new Date(exp).getTime() > Date.now());
  }catch(e){ return false; }
}
function clearOwnerToken(){ try{ localStorage.removeItem("ttt_owner_token"); localStorage.removeItem("ttt_owner_expires"); }catch(e){} }
var US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
/* Version stamp (v11): rendered into the footer so drift is checkable by eye. */
function renderVersionStamp(){
  var el = document.getElementById("version-stamp");
  if(!el) return;
  var b = window.__TTT_BUILD__ || {};
  var v = b.artifact_version || "v11";
  var d = (b.exported || "").slice(0,10) || "2026-11-21";
  el.textContent = "TOP TEA TALENTS • " + v + " • updated " + d;
}
function logout(){
  try{ localStorage.removeItem("ttt_token"); localStorage.removeItem("ttt_talent_id"); }catch(e){}
  location.hash = "#/";
  route();
}
function authSlotHtml(){
  if(isLoggedIn()) return '<a href="#/dashboard">My Dashboard</a><button class="btn btn-ghost btn-sm" id="logout-btn" type="button">Log out</button>';
  return '<a class="btn btn-ghost btn-sm" href="#/login">Log in</a>';
}
function bindAuthSlot(){
  var s = $("#auth-slot"); if(!s) return;
  s.innerHTML = authSlotHtml();
  var b = $("#logout-btn");
  if(b) b.addEventListener("click", logout);
}
function requireLogin(app, inner){
  if(!isLoggedIn()){
    app.innerHTML = '<div class="card"><h2>Log in first</h2><p>This page needs your talent account. <a href="#/login">Log in</a> or <a href="#/join">join Top Tea Talents</a>.</p></div>';
    return false;
  }
  return true;
}

/* ---------- (4) router ---------- */
var ROUTES = [
  {re:/^#\/$/, fn:screenLanding},
  {re:/^#\/join$/, fn:screenJoin},
  {re:/^#\/verify$/, fn:screenVerify},
  {re:/^#\/login$/, fn:screenLogin},
  {re:/^#\/dashboard$/, fn:screenDashboard},
  {re:/^#\/jobs$/, fn:screenJobsForYou},
  {re:/^#\/automation$/, fn:screenAutomation},
  {re:/^#\/earnings$/, fn:screenEarnings},
  {re:/^#\/owner$/, fn:screenOwner},
  {re:/^#\/talent\/([^\/]+)$/, fn:screenPublicTalent},
  {re:/^#\/social$/, fn:screenSocial},
  {re:/^#\/cubicles$/, fn:screenCubicles},
  {re:/^#\/replies$/, fn:screenReplies},
  {re:/^#\/opportunities$/, fn:screenOpportunities},
  {re:/^#\/browse$/, fn:screenBrowse},
  {re:/^#\/opportunity\/([^\/]+)$/, fn:screenOpportunityDetail},
  {re:/^#\/portfolio$/, fn:screenPortfolio},
  {re:/^#\/profile$/, fn:screenProfile},
  {re:/^#\/fast-track$/, fn:screenFastTrack},
  {re:/^#\/consent$/, fn:screenConsent},
  {re:/^#\/matches$/, fn:screenMatches},
  {re:/^#\/applications$/, fn:screenApplications},
  {re:/^#\/bookings$/, fn:screenBookings},
  {re:/^#\/notifications$/, fn:screenNotifications},
  {re:/^#\/community$/, fn:screenCommunity},
  {re:/^#\/settings$/, fn:screenSettings},
  {re:/^#\/compliance$/, fn:screenCompliance},
  {re:/^#\/agency\/([^\/]+)$/, fn:screenAgencyHistory},
  {re:/^#\/agency$/, fn:screenAgency},
  {re:/^#\/ledger$/, fn:screenLedger},
  {re:/^#\/contacts$/, fn:screenContacts}
];
function route(){
  var app = $("#app");
  if(!app) return;
  // Community Board timers (15s refresh + 30s bubble auto-close) belong
  // to that screen only — clear them on every navigation.
  if(window.__tttBoardTimers){ window.__tttBoardTimers.forEach(function(t){ clearInterval(t); }); window.__tttBoardTimers = []; }
  if(window.__tttBoardOutsideTap){ document.removeEventListener("pointerdown", window.__tttBoardOutsideTap); window.__tttBoardOutsideTap = null; }
  if(window.__tttBoardEsc){ document.removeEventListener("keydown", window.__tttBoardEsc); window.__tttBoardEsc = null; }
  apiBanner(); bindAuthSlot(); closeSidebar();
  document.querySelectorAll(".nav-group-body a").forEach(function(a){
    var h = a.getAttribute("href")||"";
    a.classList.toggle("active", ("#"+location.hash.replace(/^#/,"")) === h || location.hash === h);
  });
  var hash = (location.hash || "#/").split("?")[0];
  if(!hash) hash = "#/";
  for(var i=0;i<ROUTES.length;i++){
    var m = hash.match(ROUTES[i].re);
    if(m){ ROUTES[i].fn(app, m[1]); window.scrollTo(0,0); return; }
  }
  app.innerHTML = '<div class="card"><h2>Page not found</h2><p>That page does not exist. <a href="#/">Back to the home page</a>.</p></div>';
}

/* ---------- (5) shared UI bits ---------- */
function oppCard(o){
  var exp = isExpired(o);
  var src = o.source ? esc(o.source) : "";
  var srcLink = o.source_url ? ' · <a href="'+esc(o.source_url)+'" target="_blank" rel="noopener">Original listing</a>' : "";
  return '<article class="opp-card'+(exp?' expired':'')+'">'
    + '<h3><a href="#/opportunity/'+encodeURIComponent(o.id)+'">'+esc(o.title||"Untitled opportunity")+'</a></h3>'
    + '<p class="meta">'+esc(o.production||o.employer||o.casting_org||"")+(o.production&&o.employer?" · ":"")+esc(o.employer&&o.production?o.employer:"")+' · '+esc(locText(o))+'</p>'
    + '<p class="pay-line"><span class="pay">'+payText(o)+'</span>'+verBadge(o)+(exp?'<span class="badge badge-expired">EXPIRED</span>':"")+'</p>'
    + '<p class="meta">Category: '+esc(o.category||"—")+' · Deadline: '+esc(o.deadline?fmtDate(o.deadline):"Not stated")+'</p>'
    + '<p class="meta">Source: '+src+srcLink+'</p>'
    + '<p><a class="btn btn-ghost btn-sm" href="#/opportunity/'+encodeURIComponent(o.id)+'">View details</a></p>'
    + '</article>';
}
function actionButtons(){
  return '<div class="actions-row">'
    + '<a class="btn" href="#/portfolio">VIEW MY PORTFOLIO</a>'
    + '<a class="btn btn-ghost" href="#/profile">EDIT MY PROFILE</a>'
    + '<a class="btn btn-ghost" href="#/portfolio">UPLOAD PHOTOS</a>'
    + '<a class="btn btn-ghost" href="#/profile">UPDATE AVAILABILITY</a>'
    + '<a class="btn btn-ghost" href="#/opportunities">FIND OPPORTUNITIES</a>'
    + '<a class="btn btn-ghost" href="#/fast-track">MANAGE MY PERMISSIONS</a>'
    + '<a class="btn btn-ghost" href="#/applications">VIEW APPLICATIONS</a>'
    + '<a class="btn btn-ghost" href="#/bookings">VIEW BOOKINGS</a>'
    + '</div>';
}
function fetchJsonOrNull(p){ return apiGet(p).catch(function(){ return null; }); }
function checkHealth(){
  if(!apiBase()) return;
  apiGet("/api/v1/health").then(function(h){
    var b = $("#api-banner");
    if(b && h && (h.status==="ok" || h.healthy)) { /* backend reachable; banner stays hidden */ }
  }).catch(function(){
    var b = $("#api-banner");
    if(b){ b.classList.remove("hidden"); b.textContent = "Backend URL is set but the API did not answer its health check — live data is unavailable right now."; }
  });
}
/* v1.3.0: live-mode banner. The settings endpoint is public-read; the
   banner + footer lines follow the server's liveMode flag so the page
   never claims TEST MODE while the agency is sending, or LIVE while it
   is not. Safe default is TEST MODE until the fetch answers. */
window.__tttLiveMode = false;
function refreshMode(){
  if(!apiBase()) return;
  apiGet("/api/v1/settings").then(function(s){
    var live = !!(s && s.liveMode);
    window.__tttLiveMode = live;
    var banner = document.getElementById("mode-banner");
    if(banner) banner.textContent = live ? "LIVE — the agency sends applications by email." : "TEST MODE — submissions paused, nothing is sent live.";
    var line = document.getElementById("mode-line");
    if(line) line.textContent = live ? "LIVE — applications are sent by the agency email." : "TEST MODE — submissions paused, nothing is sent live.";
    var mail = document.getElementById("mail-line");
    if(mail) mail.textContent = live
      ? (s.mailConfigured ? "Email connected — the agency sends from the agency mailbox." : "Email not connected yet — sends queue until the agency mailbox is connected.")
      : "Email is not connected — notifications stay in-app.";
  }).catch(function(){ /* settings unreachable: TEST MODE copy stays */ });
}
function isLiveMode(){ return window.__tttLiveMode === true; }

/* ---------- (6) screens: landing / login / opportunities ---------- */
function screenLanding(app){
  // Returning talents need a way back in at first glance: the hero used to
  // offer SIGN UP only, and the only Log in link was a small header link.
  var heroCta = isLoggedIn()
    ? '<a class="btn btn-gold btn-gold-big" href="#/dashboard">GO TO MY DASHBOARD</a>'
    : '<a class="btn btn-gold btn-gold-big" href="#/join">SIGN UP</a> <a class="btn btn-ghost btn-gold-big" href="#/login">LOG IN</a>'
      + '<p class="muted" style="margin-top:10px">Already have a profile? <a href="#/login">Log in</a> — you will pick up right where you left off.</p>';
  app.innerHTML =
    '<section class="hero">'
    + '<div class="brand-mark hero-mark">'+brandMarkSVG(96)+'</div>'
    + '<h1 class="wordmark">TOP TEA<br><span>TALENTS</span></h1>'
    + '<p class="hero-tag">Casting discovery, matching, and bookings — nationwide, South Florida first.</p>'
    + heroCta
    + '<div class="hero-panel"><div class="steps-grid">'
    + '<div class="step-tile"><div class="step-icon">🔍</div><h3>FIND</h3><p>New casting calls, hunted every day.</p></div>'
    + '<div class="step-tile"><div class="step-icon">🎯</div><h3>MATCH</h3><p>The right jobs for your look, skills, and location.</p></div>'
    + '<div class="step-tile"><div class="step-icon">📤</div><h3>SUBMIT</h3><p>We send your profile to the best-paying fits first.</p></div>'
    + '<div class="step-tile"><div class="step-icon">🎬</div><h3>BOOK</h3><p>You get the call, the details, and your pay.</p></div>'
    + '</div>'
    + '<ul class="trust-list"><li>Free to join.</li><li>You approve before anything is sent.</li><li>10–15% only when you book.</li></ul>'
    + '</div></section>'
    + '<section id="live-counts"><div class="stats-row">'
    + '<div class="stat"><b data-stat="opportunities">—</b><span>opportunities found</span></div>'
    + '<div class="stat"><b data-stat="south_florida">—</b><span>in South Florida</span></div>'
    + '<div class="stat"><b data-stat="sources">—</b><span>sources checked</span></div>'
    + '</div><p class="muted small" id="stats-note"></p><details class="sources-details" id="sources-details"><summary><span id="sources-count">23</span> sources checked</summary><p class="muted small" id="sources-line"></p></details></section>'
    + '<section class="card"><h2>South Florida</h2><p>South Florida first — Miami, Fort Lauderdale, and Palm Beach castings surface here before anywhere else.</p><p><a class="btn btn-ghost" href="#/opportunities?geography=south-florida">Browse South Florida</a> <a class="btn btn-ghost" href="#/browse">Browse all listings</a></p></section>'
    + '<section><h2 style="color:var(--gold)">Browse opportunities</h2><div id="preview-list">'+loadingBox("Loading opportunities…")+'</div>'
    + '<p><a class="btn" href="#/opportunities">See all opportunities</a> <a class="btn btn-ghost" href="#/browse">Browse all listings</a></p></section>';
  if(!apiBase()){
    var note = $("#stats-note");
    if(note) note.textContent = "Live counts appear here once the backend is connected. No numbers are shown until then.";
    var sd0 = $("#sources-details"); if(sd0) sd0.style.display = "none";
    var pl = $("#preview-list");
    if(pl) pl.innerHTML = emptyBox("Opportunities load from the live backend once it is connected. Nothing is listed yet.");
    return;
  }
  apiGet("/api/v1/stats").then(function(s){
    s = s||{};
    var set = function(k,v){ var el=document.querySelector('[data-stat="'+k+'"]'); if(el) el.textContent=(v===null||v===undefined||v==="")?"—":v; };
    set("opportunities", s.opportunityCount ?? s.opportunities ?? s.total_opportunities ?? s.count);
    set("south_florida", s.southFlorida ?? s.south_florida ?? (s.by_geography && s.by_geography["south-florida"]));
    set("sources", s.sourceCount ?? s.sources ?? s.source_count ?? (s.by_source && Object.keys(s.by_source).length));
    apiGet("/api/v1/opportunities?geography=south-florida&limit=1").then(function(d){ set("south_florida", d.total ?? d.count); }).catch(function(){});
    var n = $("#stats-note");
    if(n && s.generated_at) n.textContent = "Counts from the live backend, updated " + fmtDT(s.generated_at) + ".";
  }).catch(function(){
    var n = $("#stats-note");
    if(n) n.textContent = "Live counts are unavailable right now — the backend could not be reached. No numbers are shown until it responds.";
  });
  apiGet("/api/v1/sources").then(function(d){
    var list = d.sources||d||[];
    var el = $("#sources-line"); if(!el) return;
    var sd = $("#sources-details");
    if(Array.isArray(list) && list.length){
      el.textContent = "Sources checked: " + list.map(function(s){ return s.name||s.id||s; }).join(", ") + ".";
      var c = $("#sources-count"); if(c) c.textContent = list.length;
    } else if(sd) { sd.style.display = "none"; }
  }).catch(function(){ var sd2 = $("#sources-details"); if(sd2) sd2.style.display = "none"; });
  apiGet("/api/v1/opportunities?limit=5").then(function(d){
    var list = (d && (d.opportunities||d.items||d.data)) || [];
    var pl = $("#preview-list"); if(!pl) return;
    if(!list.length){ pl.innerHTML = emptyBox("No opportunities listed yet. Check back soon."); return; }
    pl.innerHTML = list.map(oppCard).join("");
  }).catch(function(){
    var pl = $("#preview-list"); if(pl) pl.innerHTML = emptyBox("Opportunities could not be loaded — the backend is unreachable right now.");
  });
}

function screenLogin(app){
  if(isLoggedIn()){ location.hash = "#/dashboard"; route(); return; }
  app.innerHTML = '<div class="card"><h2>Log in</h2><div id="login-msg"></div>'
    + '<form id="login-form"><label for="login-email">Email</label><input id="login-email" type="email" required autocomplete="email">'
    + '<label for="login-password">Password</label><input id="login-password" type="password" required autocomplete="current-password">'
    + '<p><button class="btn" type="submit">Log in</button></p></form>'
    + '<p class="muted">Once you are in, you will stay signed in on this phone until you log out — no need to sign in every time.</p>'
    + '<p><a href="#" id="forgot-link">Forgot your password?</a></p>'
    + '<div id="reset-box" style="display:none"><h3>Reset your password</h3><div id="reset-msg"></div>'
    + '<form id="reset-request-form"><label for="reset-email">Email</label><input id="reset-email" type="email" required autocomplete="email">'
    + '<p><button class="btn btn-ghost" type="submit">Send reset code</button></p></form>'
    + '<form id="reset-form" style="display:none"><label for="reset-code">6-digit code</label><input id="reset-code" type="text" inputmode="numeric" required autocomplete="one-time-code">'
    + '<label for="reset-new-password">New password (at least 8 characters)</label><input id="reset-new-password" type="password" required autocomplete="new-password">'
    + '<p><button class="btn" type="submit">Reset password</button></p></form></div>'
    + '<p class="muted">No account yet? <a href="#/join">Join Top Tea Talents — it is free.</a></p></div>';
  $("#login-form").addEventListener("submit", function(e){
    e.preventDefault();
    var msg = $("#login-msg");
    api("/api/v1/auth/login", {method:"POST", body:{email:$("#login-email").value.trim(), password:$("#login-password").value}})
      .then(function(d){
        var tok = d.token || d.access_token || "";
        var id = (d.talent && d.talent.id) || d.talentId || d.talent_id || d.id || "";
        if(!tok || !id) throw new Error("Login succeeded but no session was returned.");
        try{ localStorage.setItem("ttt_token", tok); localStorage.setItem("ttt_talent_id", id); }catch(err){}
        location.hash = "#/dashboard"; route();
      })
      .catch(function(err){ msg.innerHTML = errBox(err.message); });
  });
  $("#forgot-link").addEventListener("click", function(e){
    e.preventDefault();
    var b = $("#reset-box"); if(b) b.style.display = (b.style.display === "none") ? "block" : "none";
  });
  $("#reset-request-form").addEventListener("submit", function(e){
    e.preventDefault();
    var msg = $("#reset-msg");
    api("/api/v1/auth/request-password-reset", {method:"POST", body:{email:$("#reset-email").value.trim()}})
      .then(function(d){
        var note = "If that email has an account, a reset code was sent. Check your email for the 6-digit code, then enter it below with your new password.";
        if(d && d.testModeResetCode){ note = "TEST MODE — email is not connected yet, so your reset code is shown here: <b>" + esc(String(d.testModeResetCode)) + "</b>. Enter it below with your new password."; }
        msg.innerHTML = okBox(note);
        var f = $("#reset-form"); if(f) f.style.display = "block";
      })
      .catch(function(err){ msg.innerHTML = errBox(err.message); });
  });
  $("#reset-form").addEventListener("submit", function(e){
    e.preventDefault();
    var msg = $("#reset-msg");
    api("/api/v1/auth/reset-password", {method:"POST", body:{email:$("#reset-email").value.trim(), code:$("#reset-code").value.trim(), newPassword:$("#reset-new-password").value}})
      .then(function(){ msg.innerHTML = okBox("Password reset. Log in with your new password."); var f = $("#reset-form"); if(f) f.style.display = "none"; })
      .catch(function(err){ msg.innerHTML = errBox(err.message); });
  });
}

function screenOpportunities(app){
  var geo = qs("geography") || "";
  app.innerHTML = '<h1 style="color:var(--gold)">Opportunities</h1>'
    + '<div class="card"><div class="filters">'
    + '<div><label for="f-geo">Geography</label><select id="f-geo"><option value="">All</option><option value="south-florida">South Florida</option><option value="florida">Florida</option><option value="nationwide">Nationwide</option></select></div>'
    + '<div><label for="f-cat">Category</label><select id="f-cat"><option value="">All</option><option>film-tv</option><option>commercial</option><option>modeling</option><option>music-video</option><option>extras</option><option>live-event</option><option>reality-tv</option><option>brand-activation</option><option>promo</option><option>specialty</option><option>corporate</option><option>advertising</option><option>featured-extras</option><option>paid-audience</option><option>other</option></select></div>'
    + '<div><label for="f-ver">Verification</label><select id="f-ver"><option value="">All</option><option value="VERIFIED">Verified</option><option value="PARTIALLY_VERIFIED">Partially verified</option><option value="UNVERIFIED">Unverified</option></select></div>'
    + '<div><label for="f-q">Search</label><input id="f-q" type="search" placeholder="Title, production, location…"></div>'
    + '<div><label class="checkbox-row"><input id="f-exp" type="checkbox"> Hide expired</label></div>'
    + '<div><button class="btn" id="f-apply" type="button">Apply filters</button></div>'
    + '</div></div>'
    + '<div id="opp-msg"></div><div id="opp-list">'+loadingBox("Loading opportunities…")+'</div>';
  if(geo) $("#f-geo").value = geo;
  var load = function(){
    var p = new URLSearchParams();
    var g=$("#f-geo").value, c=$("#f-cat").value, v=$("#f-ver").value, q=$("#f-q").value.trim();
    if(g) p.set("geography", g);
    if(c) p.set("category", c);
    if(v) p.set("verification_status", v);
    if(q) p.set("q", q);
    p.set("include_expired","true");
    if(!apiBase()){ $("#opp-list").innerHTML = emptyBox("Opportunities load from the live backend once it is connected."); return; }
    apiGet("/api/v1/opportunities?"+p.toString()).then(function(d){
      var list = (d && (d.opportunities||d.items||d.data)) || [];
      var hideExp = $("#f-exp").checked;
      var live = [], expired = [];
      list.forEach(function(o){ (isExpired(o)?expired:live).push(o); });
      if(hideExp) expired = [];
      var out = live.concat(expired);
      var el = $("#opp-list");
      if(!out.length){ el.innerHTML = emptyBox("No opportunities match these filters yet."); return; }
      el.innerHTML = '<p class="muted">'+out.length+' opportunit'+(out.length===1?'y':'ies')+(expired.length && !hideExp ? ' — expired listings are shown last, never as live.' : '')+'</p>' + out.map(oppCard).join("");
    }).catch(function(err){ $("#opp-list").innerHTML = errBox(err.message); });
  };
  $("#f-apply").addEventListener("click", load);
  load();
}

var PAY_TYPES = ["daily","flat","hourly","session","unpaid","undisclosed","expense-only","deferred","residual"];
function browseCard(o){
  var exp = o.expired===true ? true : isExpired(o);
  var src = o.source ? esc(o.source) : "";
  var srcLink = o.source_url ? ' · <a href="'+esc(o.source_url)+'" target="_blank" rel="noopener">Original listing</a>' : "";
  return '<article class="opp-card'+(exp?' expired':'')+'">'
    + '<h3><a href="#/opportunity/'+encodeURIComponent(o.id)+'">'+esc(o.title||"Untitled opportunity")+'</a></h3>'
    + '<p class="meta">'+esc(o.production||o.employer||o.casting_org||"")+(o.production&&o.employer?" · ":"")+esc(o.employer&&o.production?o.employer:"")+' · '+esc(locText(o))+'</p>'
    + '<p class="pay-line"><span class="pay">'+payText(o)+'</span>'+verBadge(o)+(exp?'<span class="badge badge-expired">EXPIRED</span>':"")+'</p>'
    + '<p class="meta">Listed: '+esc(o.discovered_at?fmtDate(o.discovered_at):"Not stated")+' · Category: '+esc(o.category||"—")+' · Deadline: '+esc(o.deadline?fmtDate(o.deadline):"Not stated")+'</p>'
    + '<p class="meta">Source: '+src+srcLink+'</p>'
    + '<p><a class="btn btn-ghost btn-sm" href="#/opportunity/'+encodeURIComponent(o.id)+'">View details</a></p>'
    + '</article>';
}
/* Browse All Listings: one scrollable list of everything, newest first by
   default, with the full filter set. Filtering is client-side over one fetch
   of the whole set, so every control answers instantly. "Date listed" is
   discovered_at — the date we found the listing (the source boards gave no
   per-listing posted date). Expired rows are dimmed + badged, never live. */
function screenBrowse(app){
  app.innerHTML = '<h1 style="color:var(--gold)">Browse All Listings</h1>'
    + '<p class="muted">Every listing, newest first. Expired listings are shown dimmed with an EXPIRED badge — never as live.</p>'
    + '<div class="card"><div class="filters">'
    + '<div><label for="b-geo">Geography</label><select id="b-geo"><option value="">All</option><option value="south-florida">South Florida</option><option value="florida">Florida</option><option value="nationwide">Nationwide</option></select></div>'
    + '<div><label for="b-county">County</label><select id="b-county"><option value="">All counties</option></select></div>'
    + '<div><label for="b-cat">Category</label><select id="b-cat"><option value="">All</option></select></div>'
    + '<div><label for="b-pay">Pay type</label><select id="b-pay"><option value="">All</option>'+PAY_TYPES.map(function(p){return '<option value="'+p+'">'+p+'</option>';}).join("")+'</select></div>'
    + '<div><label for="b-ver">Verification</label><select id="b-ver"><option value="">All</option><option value="VERIFIED">Verified</option><option value="PARTIALLY_VERIFIED">Partially verified</option><option value="UNVERIFIED">Unverified</option></select></div>'
    + '<div><label for="b-src">Source</label><select id="b-src"><option value="">All sources</option></select></div>'
    + '<div><label for="b-q">Keyword</label><input id="b-q" type="search" placeholder="Title, production, location…"></div>'
    + '<div><label>Showing</label><div class="seg-toggle" id="b-status" role="group" aria-label="Live or expired"><button type="button" data-status="all" aria-pressed="true">All</button><button type="button" data-status="live" aria-pressed="false">Live</button><button type="button" data-status="expired" aria-pressed="false">Expired</button></div></div>'
    + '<div><label for="b-sort">Sort by date</label><select id="b-sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div>'
    + '</div></div>'
    + '<div id="browse-count"></div><div id="browse-list"><div class="card"><p class="muted">Loading all listings…</p><div class="skel"></div><div class="skel s2"></div><div class="skel s3"></div></div></div>';
  if(!apiBase()){ $("#browse-list").innerHTML = emptyBox("All listings load from the live backend once it is connected."); return; }
  var base = [], status = "all";
  var uniq = function(vals){ var seen={}, out=[]; vals.forEach(function(v){ if(v && !seen[v]){ seen[v]=1; out.push(v); } }); return out.sort(); };
  var fillSelect = function(id, vals, allLabel){
    var el = $(id); if(!el) return;
    el.innerHTML = '<option value="">'+esc(allLabel)+'</option>' + vals.map(function(v){ return '<option value="'+esc(v)+'">'+esc(v)+'</option>'; }).join("");
  };
  var apply = function(){
    var g=$("#b-geo").value, county=$("#b-county").value, c=$("#b-cat").value,
        pay=$("#b-pay").value, v=$("#b-ver").value, src=$("#b-src").value,
        q=$("#b-q").value.trim().toLowerCase(), sort=$("#b-sort").value;
    var list = base.filter(function(o){
      if(g && o.geography!==g) return false;
      if(county && !(o.location && o.location.county===county)) return false;
      if(c && o.category!==c) return false;
      if(pay && o.compensation_type!==pay) return false;
      if(v && (o.verification_status||"").toUpperCase()!==v) return false;
      if(src && o.source!==src) return false;
      var exp = o.expired===true ? true : isExpired(o);
      if(status==="live" && exp) return false;
      if(status==="expired" && !exp) return false;
      if(q){
        var hay = [o.title,o.production,o.employer,o.casting_org,o.category,o.compensation,locText(o),(o.location&&o.location.raw)||""].join(" ").toLowerCase();
        if(hay.indexOf(q)===-1) return false;
      }
      return true;
    });
    var byDesc = function(a,b){ return String(b.discovered_at||"").localeCompare(String(a.discovered_at||"")) || String(b.deadline||"").localeCompare(String(a.deadline||"")) || String(a.id).localeCompare(String(b.id)); };
    var byAsc = function(a,b){ return String(a.discovered_at||"").localeCompare(String(b.discovered_at||"")) || String(a.deadline||"").localeCompare(String(b.deadline||"")) || String(a.id).localeCompare(String(b.id)); };
    list.sort(sort==="oldest" ? byAsc : byDesc);
    var liveN = base.filter(function(o){ return !(o.expired===true ? true : isExpired(o)); }).length;
    var expN = base.length - liveN;
    var cnt = $("#browse-count");
    if(cnt) cnt.innerHTML = '<p class="muted">Showing '+list.length+' of '+base.length+' listings · '+liveN+' live · '+expN+' expired</p>';
    var el = $("#browse-list");
    if(!list.length){ el.innerHTML = emptyBox("No listings match these filters yet."); return; }
    el.innerHTML = list.map(browseCard).join("");
  };
  apiGet("/api/v1/opportunities?include_expired=true&limit=500&sort=newest").then(function(d){
    base = (d && (d.opportunities||d.items||d.data)) || [];
    fillSelect("#b-county", uniq(base.map(function(o){ return o.location && o.location.county; })), "All counties");
    fillSelect("#b-src", uniq(base.map(function(o){ return o.source; })), "All sources");
    fillSelect("#b-cat", uniq(base.map(function(o){ return o.category; })), "All");
    apply();
  }).catch(function(err){ $("#browse-list").innerHTML = errBox(err.message); });
  ["#b-geo","#b-county","#b-cat","#b-pay","#b-ver","#b-src","#b-sort"].forEach(function(id){
    $(id).addEventListener("change", apply);
  });
  var qEl = $("#b-q"), deb = null;
  qEl.addEventListener("input", function(){ clearTimeout(deb); deb = setTimeout(apply, 200); });
  document.querySelectorAll("#b-status button").forEach(function(b){
    b.addEventListener("click", function(){
      status = b.getAttribute("data-status");
      document.querySelectorAll("#b-status button").forEach(function(x){ x.setAttribute("aria-pressed", x===b ? "true" : "false"); });
      apply();
    });
  });
}

function screenOpportunityDetail(app, id){
  try{ id = decodeURIComponent(id); }catch(e){}
  app.innerHTML = '<p><a href="#/opportunities">&larr; Back to opportunities</a></p><div id="opp-detail">'+loadingBox("Loading opportunity…")+'</div>';
  if(!apiBase()){ $("#opp-detail").innerHTML = emptyBox("Opportunity details load from the live backend once it is connected."); return; }
  apiGet("/api/v1/opportunities/"+encodeURIComponent(id)).then(function(d){
    var o = d.opportunity || d;
    var el = $("#opp-detail"); if(!el) return;
    el.innerHTML = '<div class="card"><h2>'+esc(o.title||"Untitled opportunity")+'</h2>'
      + '<p class="pay-line">'+verBadge(o)+(isExpired(o)?'<span class="badge badge-expired">EXPIRED</span>':"")+' '+selBadge(o)+'</p>'
      + '<dl class="kv">'
      + '<dt>Production</dt><dd>'+esc(o.production||"—")+'</dd>'
      + '<dt>Employer</dt><dd>'+esc(o.employer||o.casting_org||o.casting_professional||"—")+'</dd>'
      + (o.casting_org && o.casting_org!==o.employer ? '<dt>Casting organization</dt><dd>'+esc(o.casting_org)+'</dd>' : "")
      + (o.casting_professional && o.casting_professional!==o.employer ? '<dt>Casting professional</dt><dd>'+esc(o.casting_professional)+'</dd>' : "")
      + '<dt>Location</dt><dd>'+esc(locText(o))+'</dd>'
      + '<dt>Pay</dt><dd><span class="pay">'+payText(o)+'</span></dd>'
      + '<dt>Category</dt><dd>'+esc(o.category||"—")+'</dd>'
      + '<dt>Deadline</dt><dd>'+esc(o.deadline?fmtDate(o.deadline):"Not stated")+'</dd>'
      + '<dt>Production dates</dt><dd>'+esc(o.production_dates||"—")+'</dd>'
      + '<dt>Source</dt><dd>'+esc(o.source||"—")+(o.source_url?' · <a href="'+esc(o.source_url)+'" target="_blank" rel="noopener">Original listing</a>':"")+'</dd>'
      + '<dt>Verification notes</dt><dd>'+esc(o.verification_notes||"—")+'</dd>'
      + '</dl>'
      + '<h3>Requirements to qualify</h3><dl class="kv">'
      + '<dt>Gender</dt><dd>'+esc(genderReqLine(o))+'</dd>'
      + '<dt>Selectivity</dt><dd>'+(o.selectivity==="guaranteed"?"Guaranteed — open call, everyone who shows up and meets the basics gets hired and paid":o.selectivity==="selective"?"Selective — many apply, only a few are picked":"Unknown — the listing does not say how selective it is")+(o.selectivityReason?" ("+esc(o.selectivityReason)+")":"")+'</dd>'
      + (o.age?'<dt>Age</dt><dd>'+esc(o.age)+'</dd>':"")
      + (o.eligibility?'<dt>Eligibility</dt><dd>'+esc(o.eligibility)+'</dd>':"")
      + (o.appearance?'<dt>Appearance</dt><dd>'+esc(o.appearance)+'</dd>':"")
      + (o.skills?'<dt>Skills</dt><dd>'+esc(o.skills)+'</dd>':"")
      + (o.travel?'<dt>Travel</dt><dd>'+esc(o.travel)+'</dd>':"")
      + (o.positions?'<dt>Spots</dt><dd>'+esc(String(o.positions))+' position'+(Number(o.positions)===1?"":"s")+'</dd>':"")
      + (o.usage_exclusivity?'<dt>Usage / exclusivity</dt><dd>'+esc(o.usage_exclusivity)+'</dd>':"")
      + '</dl>'
      + (o.roles?'<h3>Roles</h3><p>'+esc(o.roles)+'</p>':"")
      + (o.submission_instructions?'<h3>How to apply</h3><p>'+esc(o.submission_instructions)+'</p>':"")
      + '<div id="match-box"></div>'
      + '<div class="actions-row"><button class="btn" id="check-match" type="button">Check my match</button>'
      + '<button class="btn btn-ghost" id="apply-btn" type="button">Apply (request approval)</button></div>'
      + '<div id="apply-msg"></div>'
      + '<p class="muted small">'+(isLiveMode() ? "LIVE — applying here records an application request for agency review; the agency sends it to the employer by email once approved." : "TEST MODE — submissions paused, nothing is sent live. Applying here records an application request for agency review; nothing leaves the platform.")+'</p></div>';
    $("#check-match").addEventListener("click", function(){
      var box = $("#match-box");
      if(!isLoggedIn()){ box.innerHTML = errBox("Log in or join first so we can check this opportunity against your profile."); return; }
      box.innerHTML = '<p class="muted">Checking your match…</p>';
      api("/api/v1/talent/"+encodeURIComponent(sessionTalentId())+"/match", {method:"POST", body:{}})
        .then(function(r){
          var list = r.matches||[];
          var m = null;
          list.forEach(function(x){ if((x.opportunityId||(x.opportunity&&x.opportunity.id))===o.id) m=x; });
          if(!m){
            var gx = (r.genderExcluded||[]).filter(function(g){ return g.opportunityId===o.id; })[0];
            if(gx){ box.innerHTML = emptyBox("This role requires "+gx.requiredGender+" talent, so it never appears in your matches."); return; }
            box.innerHTML = emptyBox("No match found for this opportunity yet. Complete your profile and run matching again."); return;
          }
          var reasons = Array.isArray(m.reasons) ? m.reasons.join(" · ") : (m.reason||m.explanation||"No reason returned.");
          box.innerHTML = '<div class="notice-box"><strong>Match: '+esc(m.classification||"—")+'</strong><br>'+esc(reasons)+'</div>';
        })
        .catch(function(err){ box.innerHTML = errBox(err.message); });
    });
    $("#apply-btn").addEventListener("click", function(){
      var msg = $("#apply-msg");
      if(!isLoggedIn()){ msg.innerHTML = errBox("Log in or join first to apply."); return; }
      api("/api/v1/applications", {method:"POST", body:{talentId:sessionTalentId(), opportunityId:o.id}})
        .then(function(){ msg.innerHTML = okBox("Application request recorded. It is pending agency review — nothing has been sent to the employer yet."); })
        .catch(function(err){ msg.innerHTML = errBox(err.message); });
    });
  }).catch(function(err){ $("#opp-detail").innerHTML = errBox(err.message); });
}

/* ---------- (7) join wizard ---------- */
var JOIN_STEPS = ["Quick sign-up","About you","Professional & permissions"];
var PHOTO_SLOTS = ["MAIN HEADSHOT","FULL-BODY PHOTO","PROFESSIONAL PORTRAIT","CASUAL LOOK","ALTERNATE LOOK","PROFILE OR SIDE VIEW","ADDITIONAL PHOTO","ADDITIONAL PHOTO"];
function joinDraft(){
  try{ return JSON.parse(localStorage.getItem("ttt_join_draft")||"{}"); }catch(e){ return {}; }
}
function saveDraft(d){ try{ localStorage.setItem("ttt_join_draft", JSON.stringify(d)); }catch(e){} }
function chipSet(id, values, selected, onPick){
  var el = document.getElementById(id); if(!el) return;
  el.innerHTML = values.map(function(v){
    return '<button type="button" class="chip'+(selected.indexOf(v)>=0?" on":"")+'" data-v="'+esc(v)+'">'+esc(v)+'</button>';
  }).join("");
  el.querySelectorAll(".chip").forEach(function(c){
    c.addEventListener("click", function(){
      var v = c.getAttribute("data-v");
      var i = selected.indexOf(v);
      if(i>=0) selected.splice(i,1); else selected.push(v);
      c.classList.toggle("on");
      onPick(selected);
    });
  });
}
/* v7 — 3-SCREEN SIGNUP REBUILD. Screen 1 is quick (name, email, phone,
   password, city, state, contact preference, terms) and creates the
   account immediately; email verification follows at #/verify. The
   remaining fields moved to post-signup profile completion, tracked by
   the % meter on the dashboard — nothing blocks joining. */
/* Inline photo uploader inside wizard step 3 — reuses the portfolio upload
   path (uploadPhoto -> POST /api/v1/talent/:id/photos, slot 1-8, JPG/PNG/WEBP,
   decoded <= 500KB, max 8 photos). Only when signed in; otherwise the
   #/portfolio link beside it is the path. */
function wireJoinPhotos(){
  var grid = $("#join-photo-grid"); if(!grid) return;
  var msg = $("#join-photo-msg");
  if(!isLoggedIn()){
    grid.innerHTML = '<p class="muted">Sign in to upload photos here — or finish signing up and add them from your portfolio.</p>';
    var addBtn0 = $("#join-photo-add"); if(addBtn0) addBtn0.style.display = "none";
    var cnt0 = $("#join-photo-count"); if(cnt0) cnt0.textContent = "";
    return;
  }
  var id = sessionTalentId();
  var load = function(){
    apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/photos").then(function(d){
      var photos = d.photos||d||[];
      var cnt = $("#join-photo-count"); if(cnt) cnt.textContent = photos.length + " of 8 photos";
      grid.innerHTML = photos.length ? photos.map(function(p){
        var imgSrc = p.url ? (apiBase() + p.url) : (p.dataUrl||"");
        return '<div class="photo-slot"><img src="'+esc(imgSrc)+'" alt="'+esc(p.caption||p.label||"Photo")+'"><p class="small">'+esc(p.caption||p.label||"Photo")+'</p></div>';
      }).join("") : '<p class="muted">No photos yet — add one below, or later from your portfolio.</p>';
      var addBtn = $("#join-photo-add"); if(addBtn) addBtn.style.display = photos.length >= 8 ? "none" : "";
    }).catch(function(err){ grid.innerHTML = errBox(err.message); });
  };
  var addBtn = $("#join-photo-add");
  if(addBtn) addBtn.addEventListener("click", function(){
    var inp = $("#join-photo-file"); if(!inp) return;
    inp.onchange = function(){
      var f = inp.files[0]; if(!f) return;
      apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/photos").then(function(d){
        var photos = d.photos||d||[];
        var used = {};
        photos.forEach(function(p){ used[p.slot]=true; });
        var slot = 0;
        for(var s=1; s<=8; s++){ if(!used[s]){ slot=s; break; } }
        if(!slot){ msg.innerHTML = errBox("You already have 8 photos — delete one from your portfolio to add another."); return; }
        uploadPhoto(id, slot, f, PHOTO_SLOTS[slot-1], function(err){
          if(err) msg.innerHTML = errBox(err);
          else { msg.innerHTML = okBox("Photo uploaded."); load(); }
        });
      }).catch(function(err){ msg.innerHTML = errBox(err.message); });
    };
    inp.click();
  });
  load();
}

function screenJoin(app){
  var d = joinDraft();
  var step = parseInt(qs("step")||"1",10) || 1;
  if(step<1||step>3) step=1;
  // Returning account: a signed-in talent already has an account, so step 1
  // (fresh registration) is a dead end — show a resume panel instead.
  if(step===1 && isLoggedIn() && sessionTalentId()){
    app.innerHTML = '<div class="brand-mark hero-mark">'+brandMarkSVG(72)+'</div>'
      + '<h1 style="color:var(--gold)">WELCOME BACK</h1>'
      + '<p class="muted">You already have an account and you are signed in — no need to sign up again. Continue where you left off:</p>'
      + '<div class="card welcome-card"><p><a class="btn" href="#/join?step=2">Continue my profile — About you</a></p>'
      + '<p><a class="btn" href="#/join?step=3">Pick my categories</a></p>'
      + '<p><a class="btn btn-ghost" href="#/dashboard">Go to my dashboard</a></p></div>';
    return;
  }
  d.availability = d.availability||[]; d.categories=d.categories||[]; d.skills=d.skills||[]; d.languages=d.languages||[];
  d.fast_track = d.fast_track||{A:false,B:false,C:false,D:false,E:false,F:false,G:false,H:false};
  // Repopulate from the saved server profile before rendering steps 2-3:
  // the server is the durable record — nothing already typed comes back
  // blank, even if the device draft is gone. Draft-only if the fetch fails.
  if(isLoggedIn() && (step===2 || step===3)){
    app.innerHTML = '<div class="brand-mark hero-mark">'+brandMarkSVG(72)+'</div>'
      + '<h1 style="color:var(--gold)">YOUR NEXT OPPORTUNITY STARTS HERE</h1>'
      + '<p class="muted">Loading your saved answers…</p>';
    apiGet("/api/v1/talent/"+encodeURIComponent(sessionTalentId())).then(function(res){
      var t = normTalent((res&&(res.talent||res))||{});
      d = mergeDraftWithProfile(d, t);
      saveDraft(d);
      renderJoin(app, d, step);
    }).catch(function(){ renderJoin(app, d, step); });
    return;
  }
  renderJoin(app, d, step);
}
function renderJoin(app, d, step){
  var html = '<div class="brand-mark hero-mark">'+brandMarkSVG(72)+'</div>'
    + '<h1 style="color:var(--gold)">YOUR NEXT OPPORTUNITY STARTS HERE</h1>'
    + '<p class="progress-label">Screen '+step+' of 3 — '+esc(JOIN_STEPS[step-1])+'</p>'
    + '<div class="progress" aria-label="Join progress">'+JOIN_STEPS.map(function(_,i){
        return '<i class="'+(i+1<step?'done':(i+1===step?'now':''))+'"></i>';
      }).join("")+'</div>'
    + '<div class="card"><div id="join-msg"></div><form id="join-form">';
  if(step===1){
    html += '<p class="muted">Quick sign-up — under a minute. The rest of your profile can be completed afterwards; your completion % shows on your dashboard.</p>'
      + '<div class="form-row"><div><label>First name<input name="first_name" required value="'+esc(d.first_name||"")+'"></label></div>'
      + '<div><label>Last name<input name="last_name" required value="'+esc(d.last_name||"")+'"></label></div></div>'
      + '<label>Professional name<input name="professional_name" value="'+esc(d.professional_name||"")+'" placeholder="Stage / professional name (optional)"></label>'
      + '<label>Email<input name="email" type="email" required value="'+esc(d.email||"")+'"></label>'
      + '<label>Phone<input name="phone" type="tel" required value="'+esc(d.phone||"")+'"></label>'
      + '<label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>'
      + '<div class="form-row"><div><label>City<input name="city" required value="'+esc(d.city||"")+'" placeholder="Miami"></label></div>'
      + '<div><label>State<select name="state" required><option value="">Select state…</option>'+US_STATES.map(function(s){ return '<option value="'+s+'"'+(d.state===s?' selected':"")+'>'+s+'</option>'; }).join("")+'</select></label></div></div>'
      + '<label>Preferred contact method<select name="contact_method"><option value="">No preference</option><option value="email">Email</option><option value="phone">Phone call</option><option value="text">Text</option></select></label>'
      + '<label class="checkbox-row"><input name="terms" type="checkbox" required> <span>I agree to the terms and the likeness-release process. I understand nothing is sent to an employer without my approval.</span></label>';
  } else if(step===2){
    html += '<p class="muted">About you — height, ZIP and age range are needed to sign the release. Availability, languages and skills are optional — pick them only if they apply to you; skipping them never blocks you and never lowers your core completion.</p>'
      + '<label>Height <span class="muted small">(needed to sign the release)</span><input name="height" placeholder="e.g. 5\'9&quot;" value="'+esc(d.height||"")+'"></label>'
      + '<div class="form-row"><div><label>ZIP <span class="muted small">(needed to sign the release)</span><input name="zip" value="'+esc(d.zip||"")+'"></label></div>'
      + '<div><label>Travel radius (miles)<input name="travel_radius" type="number" min="0" value="'+esc(d.travel_radius||"")+'"></label></div></div>'
      + '<label>Availability <span class="muted small">(optional — pick only what applies, never blocks signing)</span></label><div class="chip-set" id="avail-set"></div>'
      + '<label>Age range <span class="muted small">(needed to sign the release)</span><select name="age_range"><option value="">Prefer not to say</option>'+["18–24","25–34","35–44","45–54","55+"].map(function(a){ return '<option'+(String(d.age_range||"").replace("–","-")===a.replace("–","-")?" selected":"")+'>'+a+'</option>'; }).join("")+'</select></label>'
      + '<label>Adult or minor<select name="adult_or_minor"><option value="">Prefer not to say</option><option value="adult"'+(d.adultOrMinor==="adult"?" selected":"")+'>Adult (18+)</option><option value="minor"'+(d.adultOrMinor==="minor"?" selected":"")+'>Minor (under 18 — guardian required)</option></select></label>'
      + '<p class="muted">Gender is used only as a hard eligibility filter — a role that requires a different gender never appears in your matches. It never adds or subtracts match points. You control whether any of it is shared.</p>'
      + '<label>Gender<select name="gender"><option value=""'+(!d.gender?" selected":"")+'>Prefer not to say</option>'+["Female","Male","Non-binary","Other"].map(function(g){ return '<option'+(d.gender===g?" selected":"")+'>'+g+'</option>'; }).join("")+'</select></label>'
      + '<label>Ethnicity<select name="ethnicity"><option value=""'+(!d.ethnicity?" selected":"")+'>Prefer not to say</option>'+["Black / African American","Hispanic / Latino","White","Asian","Other","Two or more"].map(function(e){ return '<option'+(d.ethnicity===e?" selected":"")+'>'+e+'</option>'; }).join("")+'</select></label>'
      + '<label>Hair color<input name="hair_color" value="'+esc(d.hair_color||"")+'" placeholder="Prefer not to say — leave blank"></label>'
      + '<label>Eye color<input name="eye_color" value="'+esc(d.eye_color||"")+'" placeholder="Prefer not to say — leave blank"></label>'
      + '<label>Languages (comma separated) <span class="muted small">(optional)</span><input name="languages_text" value="'+esc((d.languages||[]).join(", "))+'" placeholder="English, Spanish…"></label>'
      + '<label>Skills (comma separated) <span class="muted small">(optional)</span><input name="skills_text" value="'+esc((d.skills||[]).join(", "))+'" placeholder="Acting, dance, modeling…"></label>';
  } else {
    html += '<p class="muted">Professional info &amp; permissions. Experience is needed to sign the release; categories are optional — pick only what applies. Photos go in your portfolio (up to 8) — add them right below, now or later.</p>'
      + '<label>Categories <span class="muted small">(optional — pick only what applies, never blocks signing)</span></label><div class="chip-set" id="cat-set"></div>'
      + '<label>Experience <span class="muted small">(needed to sign the release)</span><textarea name="experience" rows="4" placeholder="Credits, training, past bookings…">'+esc(d.experience||"")+'</textarea></label>'
      + '<label>Minimum daily pay you will accept ($)<input name="min_compensation" type="number" min="0" value="'+esc(d.min_compensation||"")+'"></label>'
      + '<label>Union affiliation<input name="union_affiliation" value="'+esc(d.union_affiliation||"")+'" placeholder="e.g. SAG-AFTRA (optional)"></label>'
      + '<div id="join-photos"><h3>Portfolio photos <span class="muted small">(optional — add now or later, never blocks signing)</span></h3>'
      + '<p class="muted small">JPG, PNG, or WEBP only. Each photo is downscaled in your browser to max 1200px (JPEG, quality 0.82) before upload.</p>'
      + '<p><strong id="join-photo-count">0 of 8 photos</strong></p>'
      + '<div class="photo-grid" id="join-photo-grid">'+loadingBox("Loading photos…")+'</div>'
      + '<p><input type="file" id="join-photo-file" accept="image/jpeg,image/png,image/webp" class="hidden">'
      + '<button type="button" class="btn btn-ghost btn-sm" id="join-photo-add">Upload a photo</button> '
      + '<a class="btn btn-ghost btn-sm" href="#/portfolio">Manage all photos</a></p>'
      + '<div id="join-photo-msg"></div></div>'
      + '<p class="notice-box"><strong>Auto-submit is OFF by default.</strong> Turning it ON permits the agency to submit your profile automatically to matches that fit your rules — without asking you first each time. You can change this any time in Fast-Track settings.</p>'
      + '<div id="ft-controls"></div>';
  }
  html += '<div class="actions-row">'
    + (step>1?'<button class="btn btn-ghost" type="button" id="join-back">Back</button>':"")
    + (step<3?'<button class="btn" type="submit">Save &amp; continue</button>':'<button class="btn" type="submit">Finish — save my profile</button>')
    + '</div></form></div>'
    + '<p class="muted small">Your answers save automatically on this device as you go. If you are logged in, changes also save to your profile.</p>';
  app.innerHTML = html;

  if(step===2) chipSet("avail-set", ["Available immediately","Weekdays","Weekends","Evenings","Flexible","Specific dates","Temporarily unavailable"], d.availability, function(v){ d.availability=v; saveDraft(d); scheduleWizardSync(d); });
  if(step===3){
    chipSet("cat-set", ["Film and television","Background extras","Featured extras","Commercials","Advertising","Music videos","Modeling","Print campaigns","Promotional events","Brand activations","Reality television","Live events","Corporate productions","Specialty talent","Other paid opportunities"], d.categories, function(v){ d.categories=v; saveDraft(d); scheduleWizardSync(d); });
    renderFastTrackControls($("#ft-controls"), d.fast_track, function(k,v){ d.fast_track[k]=v; saveDraft(d); });
    wireJoinPhotos();
  }

  var back = $("#join-back");
  if(back) back.addEventListener("click", function(){ location.hash = "#/join?step="+(step-1); route(); });
  $("#join-form").addEventListener("submit", function(e){
    e.preventDefault();
    var fd = new FormData(e.target);
    ["first_name","last_name","professional_name","email","phone","password","height","city","state","zip","travel_radius","age_range","gender","ethnicity","hair_color","eye_color","experience","min_compensation","union_affiliation","contact_method"].forEach(function(k){
      if(fd.get(k)!==null && fd.get(k)!=="") d[k]=fd.get(k);
    });
    if(fd.get("adult_or_minor")) d.adultOrMinor = fd.get("adult_or_minor");
    if(fd.get("skills_text")!==null) d.skills = String(fd.get("skills_text")||"").split(",").map(function(s){return s.trim();}).filter(Boolean);
    if(fd.get("languages_text")!==null) d.languages = String(fd.get("languages_text")||"").split(",").map(function(s){return s.trim();}).filter(Boolean);
    saveDraft(d);
    var msg = $("#join-msg");
    if(step===1){
      if(!apiBase()){ msg.innerHTML = errBox("The backend is not configured yet, so the account cannot be created right now. Your answers are saved on this device."); return; }
      api("/api/v1/auth/register", {method:"POST", body:{email:d.email, password:d.password, firstName:d.first_name, lastName:d.last_name, professionalName:d.professional_name, phone:d.phone, city:d.city, state:d.state, contactMethod:d.contact_method, termsAccepted:true}})
        .then(function(r){
          var tok = r.token||r.access_token||"", id=(r.talent&&r.talent.id)||r.talentId||r.talent_id||r.id||"";
          if(tok&&id){ try{ localStorage.setItem("ttt_token",tok); localStorage.setItem("ttt_talent_id",id); }catch(err){} }
          // TEST MODE: the verification code comes back in the register
          // response because email is not connected — keep it for the
          // verify screen, session-only.
          try{
            if(r.testModeVerificationCode) sessionStorage.setItem("ttt_verify_code", r.testModeVerificationCode);
            if(r.testModeVerificationCode) sessionStorage.setItem("ttt_verify_email", d.email);
          }catch(err){}
          location.hash = "#/verify"; route();
        })
        .catch(function(err){
          var m = err.message||"";
          if(/already registered/i.test(m)){
            // NOTE (v16 port): the GitHub hunk passed the anchor through
            // errBox(), which escapes HTML — as-shipped the "Sign in
            // instead" link renders as literal "&lt;a&gt;" text, not a
            // link. Same words, same error box, but the anchor is live.
            msg.innerHTML = '<div class="error-box" role="alert">'+esc(m)+' <a href="#/login">Sign in instead</a> — your account already exists, and signing in takes you back to where you left off.</div>';
          } else { msg.innerHTML = errBox(m); }
        });
      return;
    }
    if(step<3){
      if(isLoggedIn()){
        wizardSubmitting = true; // pause the debounced chip sync while saving
        api("/api/v1/talent/"+encodeURIComponent(sessionTalentId()), {method:"PATCH", body:toApiProfile(d, true)})
          .then(function(){ location.hash = "#/join?step="+(step+1); route(); })
          .catch(function(err){ wizardSubmitting = false; msg.innerHTML = errBox(err.message + " — your answers are still saved on this device."); });
      } else { location.hash = "#/join?step="+(step+1); route(); }
      return;
    }
    // step 3 finish: save profile + fast-track, then the likeness release
    var finish = function(){
      if(!isLoggedIn()){ location.hash = "#/consent"; route(); return; }
      api("/api/v1/talent/"+encodeURIComponent(sessionTalentId())+"/fast-track", {method:"POST", body:{controls:d.fast_track}})
        .then(function(){ try{ localStorage.removeItem("ttt_join_draft"); }catch(err){} location.hash = "#/consent"; route(); })
        .catch(function(err){ wizardSubmitting = false; msg.innerHTML = errBox(err.message); });
    };
    if(isLoggedIn()){
      wizardSubmitting = true; // pause the debounced chip sync while saving
      api("/api/v1/talent/"+encodeURIComponent(sessionTalentId()), {method:"PATCH", body:toApiProfile(d, true)})
        .then(finish)
        .catch(function(err){ wizardSubmitting = false; msg.innerHTML = errBox(err.message); });
    } else finish();
  });
}
/* Email verification screen (v7): 6-digit code, resend, live status.
   TEST MODE: email is not connected, so the code is shown on this screen
   from the sign-up response (session-only) instead of arriving by email. */
function screenVerify(app){
  var email = "";
  try{ email = sessionStorage.getItem("ttt_verify_email") || ""; }catch(e){}
  if(!email && isLoggedIn()){
    // fall back to the logged-in talent's email
  }
  app.innerHTML = '<div class="card"><h2>Verify your email</h2><div id="verify-msg"></div>'
    + '<p class="muted">We sent a 6-digit code to <strong id="verify-email-label">'+esc(email||"your email")+'</strong>. It expires in 15 minutes and locks after 5 wrong tries — you can always request a new one.</p>'
    + '<p class="notice-box" id="verify-test-note"></p>'
    + '<form id="verify-form"><label for="verify-email">Email</label><input id="verify-email" type="email" required value="'+esc(email)+'">'
    + '<label for="verify-code">6-digit code</label><input id="verify-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="123456" class="code-input">'
    + '<p><button class="btn" type="submit">Verify my email</button> <button class="btn btn-ghost" id="verify-resend" type="button">Resend code</button></p></form>'
    + '<p id="verify-status" class="muted"></p>'
    + '<p class="muted small">Verified email is required before you can sign the likeness release.</p></div>';
  try{
    var tc = sessionStorage.getItem("ttt_verify_code");
    var note = $("#verify-test-note");
    if(note) note.innerHTML = tc
      ? "TEST MODE — email is not connected, so your code is shown here instead of emailed: <strong>"+esc(tc)+"</strong> (shown once, session-only)."
      : (isLiveMode()
        ? "Check your email for the code — it was sent from the agency mailbox. If you don't see it, tap Resend code."
        : "TEST MODE — email is not connected. If you already have a code, enter it above; otherwise tap Resend code.");
  }catch(e){}
  var refreshStatus = function(){
    var em = $("#verify-email").value.trim();
    if(!em || !apiBase()) return;
    apiGet("/api/v1/auth/verification-status?email="+encodeURIComponent(em)).then(function(d){
      var el = $("#verify-status"); if(!el) return;
      el.textContent = d.verified ? "Status: VERIFIED — you are all set." : (d.hasActiveCode ? "Status: code sent, waiting for you to enter it." : "Status: no active code — tap Resend code.");
      if(d.verified){ try{ sessionStorage.removeItem("ttt_verify_code"); }catch(err){} }
    }).catch(function(){});
  };
  if(email) refreshStatus();
  $("#verify-form").addEventListener("submit", function(e){
    e.preventDefault();
    var msg = $("#verify-msg");
    var em = $("#verify-email").value.trim(), code = $("#verify-code").value.trim();
    api("/api/v1/auth/verify-email", {method:"POST", body:{email:em, code:code}})
      .then(function(){
        try{ sessionStorage.removeItem("ttt_verify_code"); }catch(err){}
        msg.innerHTML = okBox("Email verified. Continue to your profile — screen 2 of sign-up.");
        setTimeout(function(){ location.hash = "#/join?step=2"; route(); }, 1200);
      })
      .catch(function(err){ msg.innerHTML = errBox(err.message); });
  });
  $("#verify-resend").addEventListener("click", function(){
    var msg = $("#verify-msg");
    var em = $("#verify-email").value.trim();
    if(!em){ msg.innerHTML = errBox("Enter your email first."); return; }
    api("/api/v1/auth/resend-verification", {method:"POST", body:{email:em}})
      .then(function(r){
        try{ if(r.testModeVerificationCode) sessionStorage.setItem("ttt_verify_code", r.testModeVerificationCode); }catch(err){}
        var note = $("#verify-test-note");
        if(note && r.testModeVerificationCode) note.innerHTML = "TEST MODE — email is not connected, so your new code is shown here instead of emailed: <strong>"+esc(r.testModeVerificationCode)+"</strong> (shown once, session-only).";
        msg.innerHTML = okBox("A new code was issued (15 minutes).");
        refreshStatus();
      })
      .catch(function(err){ msg.innerHTML = errBox(err.message); });
  });
}
function renderJoinPhotos(d){
  var grid = $("#join-photo-grid"); if(!grid) return;
  d.photos = d.photos||[];
  var count = $("#photo-count"); if(count) count.textContent = d.photos.length + " OF 8 PHOTOS";
  grid.innerHTML = PHOTO_SLOTS.map(function(label,i){
    var p = d.photos[i];
    var inner = p
      ? '<img src="'+esc(p.dataUrl)+'" alt="'+esc(label)+'"><p class="primary-tag">'+(i===0?"PRIMARY":"")+'</p><p class="small">'+esc(p.caption||"")+'</p>'
        + '<div class="slot-actions"><button type="button" class="mini-btn" data-act="replace" data-i="'+i+'">Replace</button><button type="button" class="mini-btn" data-act="del" data-i="'+i+'">Delete</button></div>'
      : '<p class="slot-label">'+esc(label)+'</p><p class="muted small">Empty slot</p><div class="slot-actions"><button type="button" class="mini-btn" data-act="add" data-i="'+i+'">Upload</button></div>';
    return '<div class="photo-slot">'+inner+'<input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" data-file="'+i+'"></div>';
  }).join("");
  grid.querySelectorAll("[data-act]").forEach(function(b){
    b.addEventListener("click", function(){
      var i = parseInt(b.getAttribute("data-i"),10);
      var act = b.getAttribute("data-act");
      if(act==="del"){ d.photos.splice(i,1); saveDraft(d); renderJoinPhotos(d); return; }
      var inp = grid.querySelector('[data-file="'+i+'"]');
      inp.onchange = function(){
        var f = inp.files[0]; if(!f) return;
        downscalePhoto(f, function(dataUrl, err){
          if(err){ alert(err); return; }
          if(act==="add") d.photos.push({dataUrl:dataUrl, caption:PHOTO_SLOTS[i]});
          else d.photos[i] = {dataUrl:dataUrl, caption:PHOTO_SLOTS[i]};
          saveDraft(d); renderJoinPhotos(d);
        });
      };
      inp.click();
    });
  });
}
var FT_DEFS = [
  ["A","Auto-submit to matches","When ON, the agency may submit your profile automatically to opportunities that fit your rules, without asking you first. OFF means you approve every submission."],
  ["B","Only verified listings","Only auto-submit to listings marked verified or partially verified."],
  ["C","Minimum pay rule","Only auto-submit when the stated pay meets your minimum."],
  ["D","Maximum travel distance","Only auto-submit within the travel radius on your profile."],
  ["E","Category limits","Only auto-submit for the categories you selected."],
  ["F","Require approval for unpaid work","Never auto-submit to a listing with no stated pay."],
  ["G","Notify me before each submit","Send an in-app notification before any automatic submission."],
  ["H","Pause auto-submit","Temporarily stop all automatic submissions. (The agency can also pause submissions platform-wide.)"]
];
function renderFastTrackControls(el, state, onChange){
  if(!el) return;
  el.innerHTML = FT_DEFS.map(function(def){
    var k=def[0];
    return '<label class="checkbox-row"><input type="checkbox" data-ft="'+k+'"'+(state[k]?" checked":"")+'><span><strong>'+k+' — '+esc(def[1])+'</strong><br><span class="muted">'+esc(def[2])+'</span></span></label>';
  }).join("");
  el.querySelectorAll("[data-ft]").forEach(function(c){
    c.addEventListener("change", function(){ onChange(c.getAttribute("data-ft"), c.checked); });
  });
}

/* ---------- (8) dashboard / portfolio / profile / fast-track / consent ---------- */
/* Fallback completion % — used ONLY when the server sends no completion
   value. It sees only the 6 core items, so it reports on the same richness
   scale as the server: core is worth 60 of 100, and a bare 6-core record
   reads 60%, never 100%. Photos, categories, availability, gender and
   verified social links supply the rest — the server counts them; this
   fallback cannot, so it never claims the top of the scale. */
function completionPct(t){
  if(!t) return 0;
  var core = [
    !!(t.email && t.phone),
    !!((t.firstName||t.first_name) && (t.lastName||t.last_name)),
    !!(t.city && t.state && t.zip),
    !!t.height,
    !!(t.ageRange||t.age_range),
    !!t.experience
  ];
  var done = core.filter(function(x){ return x; }).length;
  return Math.round((done/core.length)*60);
}
function screenDashboard(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Command Center</h1><div id="dash">'+loadingBox("Loading your dashboard…")+'</div>' + actionButtons();
  Promise.all([
    fetchJsonOrNull("/api/v1/talent/"+encodeURIComponent(id)),
    fetchJsonOrNull("/api/v1/talent/"+encodeURIComponent(id)+"/photos"),
    fetchJsonOrNull("/api/v1/applications?talentId="+encodeURIComponent(id)),
    fetchJsonOrNull("/api/v1/bookings?talentId="+encodeURIComponent(id)),
    fetchJsonOrNull("/api/v1/talent/"+encodeURIComponent(id)+"/notifications"),
    fetchJsonOrNull("/api/v1/agencies")
  ]).then(function(res){
    var t = normTalent((res[0]&&(res[0].talent||res[0]))||{});
    var photos = (res[1]&&(res[1].photos||res[1]))||[];
    var apps = (res[2]&&(res[2].applications||res[2]))||[];
    var books = (res[3]&&(res[3].bookings||res[3]))||[];
    var notifs = (res[4]&&(res[4].notifications||res[4]))||[];
    var agencies = (res[5]&&(res[5].agencies||res[5]))||[];
    var pct = (typeof t.completion === "number") ? t.completion : completionPct(t);
    var missing = (t.completionChecklist||[]).filter(function(c){ return !c.done; }).map(function(c){ return c.label; });
    var pending = apps.filter(function(a){ return (a.status||"").toLowerCase().indexOf("pend")>=0; }).length;
    var unread = notifs.filter(function(n){ return !n.read && !n.read_at; }).length;
    var el = $("#dash"); if(!el) return;
    el.innerHTML = '<div class="card"><h2>Welcome, '+esc(t.professional_name||t.first_name||"talent")+'</h2>'
      + '<p>Profile completion: <strong>'+pct+'%</strong> · Photos: <strong>'+photos.length+' of 8</strong> · Readiness: <strong>'+esc(t.readiness_status||t.status||(pct>=80?"Ready":"In progress"))+'</strong></p>'
      + (isAwaitingReview(t) ? reviewWindowsNotice() : "")
      + (pct<100 && missing.length ? '<p class="muted small">To reach 100%: '+esc(missing.join(", "))+'.</p>' : "")
      + (t.gender ? "" : '<p class="muted small">Set your gender in <a href="#/profile">Edit My Profile</a> — roles that require a different gender can only filter once it is set.</p>')
      + '<div class="stats-row"><div class="stat"><b>'+apps.length+'</b><span>applications</span></div>'
      + '<div class="stat"><b>'+pending+'</b><span>pending approvals</span></div>'
      + '<div class="stat"><b>'+books.length+'</b><span>bookings</span></div></div>'
      + '<p class="muted">Auditions and callbacks appear here once the agency records them. Notifications: '+unread+' unread.</p></div>'
      + '<div class="card"><h3>Matching opportunities</h3><div id="dash-matches"><p class="muted">Run a match to see your current fits.</p><p><a class="btn btn-ghost btn-sm" href="#/matches">Run matching</a></p></div></div>'
      + '<div class="card" id="dash-agencies"><h3>Top Repeat Agencies</h3><div id="dash-agency-list"><p class="muted">Loading agency board…</p></div><p><a href="#/agency">Open the full Agency Network board &rarr;</a></p></div>'
      + '<div class="card" id="dash-v11"><h3>Jobs, earnings &amp; your link</h3><p><a class="btn btn-ghost btn-sm" href="#/jobs">Jobs For You</a> <a class="btn btn-ghost btn-sm" href="#/earnings">My Earnings &amp; Credits</a> <a class="btn btn-ghost btn-sm" href="#/automation">Automation</a> <a class="btn btn-ghost btn-sm" href="#/social">Social Links</a> <a class="btn btn-ghost btn-sm" href="#/replies">Agency Replies</a></p><div id="dash-v11-detail"><p class="muted">Loading your portfolio link…</p></div></div>';
    renderTopRepeatWidget($("#dash-agency-list"), agencies);
    Promise.all([
      fetchJsonOrNull("/api/v1/talent/"+encodeURIComponent(id)+"/portfolio-link"),
      fetchJsonOrNull("/api/v1/talent/"+encodeURIComponent(id)+"/earnings")
    ]).then(function(r2){
      var box = $("#dash-v11-detail"); if(!box) return;
      var pl = r2[0]||{}, earn = r2[1]||{};
      var vis = pl.visibility || (t.visibility || "private");
      var linkLine = vis === "public"
        ? '<p>Your public portfolio link: <a href="'+esc(pl.path||("#/talent/"+id))+'">'+esc(pl.path||("#/talent/"+id))+'</a> — this opens YOUR profile and portfolio, never the front page. <button class="mini-btn" id="dash-copy-link" type="button">Copy link</button></p>'
        : '<p>Your portfolio link is <strong>private</strong> right now ('+esc(pl.path||("#/talent/"+id))+'). Set visibility to Public in Settings to share it with agencies.</p>';
      box.innerHTML = linkLine
        + '<p>You have made <strong>'+money(earn.totalNetCents||0)+'</strong> with TOP TEA TALENTS across '+(earn.jobCount||0)+' job'+((earn.jobCount||0)===1?"":"s")+'. <a href="#/earnings">See the breakdown &rarr;</a></p>'
        + '<p class="muted small">Automation is <strong>'+(t.automation && t.automation.enabled ? "ON" : "OFF")+'</strong>. Email verified: <strong>'+(t.emailVerified ? "yes" : "no — verify at #/verify")+'</strong>.</p>';
      var cp = $("#dash-copy-link");
      if(cp) cp.addEventListener("click", function(){
        var full = location.origin + location.pathname + (pl.path||("#/talent/"+id));
        if(navigator.clipboard) navigator.clipboard.writeText(full).then(function(){ cp.textContent = "Copied!"; }).catch(function(){ cp.textContent = full; });
        else cp.textContent = full;
      });
    }).catch(function(){});
  }).catch(function(err){ $("#dash").innerHTML = errBox(err.message); });
}

function screenPortfolio(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">My Portfolio</h1><div id="pf-msg"></div><p><strong id="pf-count">0 OF 8 PHOTOS</strong></p>'
    + '<div class="photo-grid" id="pf-grid">'+loadingBox("Loading photos…")+'</div>'
    + '<p class="muted small">JPG, PNG, or WEBP only. Each photo is downscaled in your browser to max 1200px (JPEG, quality 0.82) before upload.</p>';
  var load = function(){
    apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/photos").then(function(d){
      var photos = d.photos||d||[];
      var grid = $("#pf-grid"); if(!grid) return;
      $("#pf-count").textContent = photos.length + " OF 8 PHOTOS";
      var slots = PHOTO_SLOTS.map(function(label,i){
        var p = photos[i];
        if(!p) return '<div class="photo-slot"><p class="slot-label">'+esc(label)+'</p><p class="muted small">Empty slot</p><div class="slot-actions"><button type="button" class="mini-btn" data-add="'+i+'">Upload</button></div><input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" data-file="'+i+'"></div>';
        var imgSrc = p.url ? (apiBase() + p.url) : (p.dataUrl||"");
        return '<div class="photo-slot"><img src="'+esc(imgSrc)+'" alt="'+esc(p.caption||label)+'">'
          + '<p class="primary-tag">'+(p.isPrimary||p.is_primary||i===0?"PRIMARY":"")+'</p><p class="small">'+esc(p.caption||label)+'</p>'
          + '<div class="slot-actions"><button type="button" class="mini-btn" data-primary="'+p.id+'">Make primary</button><button type="button" class="mini-btn" data-del="'+p.id+'">Delete</button></div></div>';
      }).join("");
      grid.innerHTML = slots;
      grid.querySelectorAll("[data-add]").forEach(function(b){
        b.addEventListener("click", function(){
          var inp = grid.querySelector('[data-file="'+b.getAttribute("data-add")+'"]');
          inp.onchange = function(){
            var f = inp.files[0]; if(!f) return;
            uploadPhoto(id, parseInt(b.getAttribute("data-add"),10)+1, f, PHOTO_SLOTS[parseInt(b.getAttribute("data-add"),10)], function(err){
              if(err) $("#pf-msg").innerHTML = errBox(err);
              else { $("#pf-msg").innerHTML = okBox("Photo uploaded."); load(); }
            });
          };
          inp.click();
        });
      });
      grid.querySelectorAll("[data-del]").forEach(function(b){
        b.addEventListener("click", function(){
          if(!confirm("Delete this photo?")) return;
          api("/api/v1/photos/"+encodeURIComponent(b.getAttribute("data-del")), {method:"DELETE"})
            .then(function(){ load(); }).catch(function(err){ $("#pf-msg").innerHTML = errBox(err.message); });
        });
      });
      grid.querySelectorAll("[data-primary]").forEach(function(b){
        b.addEventListener("click", function(){
          api("/api/v1/photos/"+encodeURIComponent(b.getAttribute("data-primary")), {method:"PATCH", body:{isPrimary:true}})
            .then(function(){ load(); }).catch(function(err){ $("#pf-msg").innerHTML = errBox(err.message); });
        });
      });
    }).catch(function(err){ $("#pf-grid").innerHTML = errBox(err.message); });
  };
  load();
}

function screenProfile(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Edit My Profile</h1><div class="card"><div id="prof-msg"></div><div id="prof-form-wrap">'+loadingBox("Loading profile…")+'</div></div>';
  apiGet("/api/v1/talent/"+encodeURIComponent(id)).then(function(d){
    var t = normTalent(d.talent||d);
    var w = $("#prof-form-wrap"); if(!w) return;
    w.innerHTML = '<form id="prof-form">'
      + '<div class="form-row"><div><label>First name<input name="first_name" value="'+esc(t.first_name||"")+'"></label></div><div><label>Last name<input name="last_name" value="'+esc(t.last_name||"")+'"></label></div></div>'
      + '<label>Professional name<input name="professional_name" value="'+esc(t.professional_name||"")+'"></label>'
      + '<label>Email<input name="email" type="email" value="'+esc(t.email||"")+'"></label>'
      + '<label>Phone<input name="phone" type="tel" value="'+esc(t.phone||"")+'"></label>'
      + '<label>Height<input name="height" value="'+esc(t.height||"")+'"></label>'
      + '<div class="form-row"><div><label>City<input name="city" value="'+esc(t.city||"")+'"></label></div><div><label>State<input name="state" value="'+esc(t.state||"")+'"></label></div></div>'
      + '<label>ZIP<input name="zip" value="'+esc(t.zip||"")+'"></label>'
      + '<label>Travel radius (miles)<input name="travel_radius" type="number" value="'+esc(t.travel_radius||"")+'"></label>'
      + '<label>Gender<select name="gender"><option value=""'+(!t.gender?" selected":"")+'>Prefer not to say</option>'+["Female","Male","Non-binary","Other"].map(function(g){ return '<option'+(t.gender===g?" selected":"")+'>'+g+'</option>'; }).join("")+'</select></label>'
      + '<label>Ethnicity<select name="ethnicity"><option value=""'+(!t.ethnicity?" selected":"")+'>Prefer not to say</option>'+["Black / African American","Hispanic / Latino","White","Asian","Other","Two or more"].map(function(e){ return '<option'+(t.ethnicity===e?" selected":"")+'>'+e+'</option>'; }).join("")+'</select></label>'
      + '<p class="muted small">Gender is used only as a hard filter — roles that require a different gender never appear in your matches. Set it so the filter works for you.</p>'
      + '<label>Languages (comma separated) <span class="muted small">(optional)</span><input name="languages_text" value="'+esc((t.languages||[]).join(", "))+'"></label>'
      + '<label>Skills (comma separated) <span class="muted small">(optional)</span><input name="skills_text" value="'+esc((t.skills||[]).join(", "))+'"></label>'
      + '<label>Categories <span class="muted small">(optional — pick only what applies)</span></label><div class="chip-set" id="prof-cat-set"></div>'
      + '<label>Availability <span class="muted small">(optional — pick only what applies)</span></label><div class="chip-set" id="prof-avail-set"></div>'
      + '<label>Experience<textarea name="experience" rows="4">'+esc(t.experience||"")+'</textarea></label>'
      + '<label>Portfolio visibility<select name="visibility"><option value="private"'+((t.visibility||"private")==="private"?" selected":"")+'>Private — nobody sees my portfolio</option><option value="agency"'+(t.visibility==="agency"?" selected":"")+'>Agency staff only</option><option value="public"'+(t.visibility==="public"?" selected":"")+'>Public — anyone with my personal link</option></select></label>'
      + '<label class="checkbox-row"><input type="checkbox" name="share_photos"'+(t.sharePhotos?" checked":"")+'> <span>Share my portfolio photos on my public portfolio page (only when visibility is Public).</span></label>'
      + '<p><button class="btn" type="submit">Save profile</button></p></form>'
      + '<hr style="border-color:var(--line)"><h3>Guardian (for talent under 18)</h3><p class="muted small">If the talent is a minor, a parent or guardian must be on file.</p>'
      + '<form id="guardian-form"><label>Guardian name<input id="guardian-name" value="'+esc(t.guardian_name||"")+'"></label>'
      + '<label>Guardian email<input id="guardian-email" type="email" value="'+esc((t.guardian&&t.guardian.guardianEmail)||"")+'"></label>'
      + '<label>Guardian phone<input id="guardian-phone" type="tel" value="'+esc((t.guardian&&t.guardian.guardianPhone)||"")+'"></label>'
      + '<label>Relationship<input id="guardian-relationship" value="'+esc((t.guardian&&t.guardian.relationship)||"")+'" placeholder="Mother, father, legal guardian…"></label>'
      + '<label class="checkbox-row"><input type="checkbox" id="guardian-consent"'+((t.guardian&&t.guardian.consentGiven)?" checked":"")+'> <span>Guardian consents to representation and submissions for this minor.</span></label>'
      + '<p><button class="btn btn-ghost" type="submit">Save guardian</button></p></form><div id="guardian-msg"></div>'
      + '<hr style="border-color:var(--line)"><h3>My audit trail</h3><p class="muted small">Every change to your record, from the ledger.</p><div id="audit-box"><p class="muted">Loading…</p></div>'
      + '<hr style="border-color:var(--line)"><h3>Delete my account</h3><p class="muted small">Deleting removes your talent record. This cannot be undone.</p><p><button class="btn btn-danger" id="del-acct" type="button">Delete my account</button></p>';
    // Categories + availability live here too (optional) — they were
    // wizard-only before, so a talent had no way to add or change them after
    // signing up except by re-entering the wizard.
    var profCategories = (t.categories||[]).slice(), profAvailability = (t.availability||[]).slice();
    chipSet("prof-cat-set", ["Film and television","Background extras","Featured extras","Commercials","Advertising","Music videos","Modeling","Print campaigns","Promotional events","Brand activations","Reality television","Live events","Corporate productions","Specialty talent","Other paid opportunities"], profCategories, function(v){ profCategories=v; });
    chipSet("prof-avail-set", ["Available immediately","Weekdays","Weekends","Evenings","Flexible","Specific dates","Temporarily unavailable"], profAvailability, function(v){ profAvailability=v; });
    $("#prof-form").addEventListener("submit", function(e){
      e.preventDefault();
      var body = {};
      new FormData(e.target).forEach(function(v,k){ body[k]=v; });
      var sp = e.target.querySelector('[name="share_photos"]');
      body.sharePhotos = sp ? sp.checked : false;
      if(body.languages_text!==undefined){ body.languages = String(body.languages_text||"").split(",").map(function(s){return s.trim();}).filter(Boolean); delete body.languages_text; }
      if(body.skills_text!==undefined){ body.skills = String(body.skills_text||"").split(",").map(function(s){return s.trim();}).filter(Boolean); delete body.skills_text; }
      body.categories = profCategories; body.availability = profAvailability;
      api("/api/v1/talent/"+encodeURIComponent(id), {method:"PATCH", body:toApiProfile(body)})
        .then(function(){ $("#prof-msg").innerHTML = okBox("Profile saved."); })
        .catch(function(err){ $("#prof-msg").innerHTML = errBox(err.message); });
    });
    $("#del-acct").addEventListener("click", function(){
      if(!confirm("Delete your account permanently?")) return;
      api("/api/v1/talent/"+encodeURIComponent(id), {method:"DELETE"})
        .then(function(){ logout(); }).catch(function(err){ $("#prof-msg").innerHTML = errBox(err.message); });
    });
    $("#guardian-form").addEventListener("submit", function(e){
      e.preventDefault();
      api("/api/v1/talent/"+encodeURIComponent(id)+"/guardian", {method:"POST", body:{guardianName:$("#guardian-name").value.trim(), guardianEmail:$("#guardian-email").value.trim(), guardianPhone:$("#guardian-phone").value.trim(), relationship:$("#guardian-relationship").value.trim(), consentGiven:$("#guardian-consent").checked}})
        .then(function(){ $("#guardian-msg").innerHTML = okBox("Guardian saved."); })
        .catch(function(err){ $("#guardian-msg").innerHTML = errBox(err.message); });
    });
    apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/audit").then(function(d){
      var evs = d.events||d.audit||d||[];
      var box = $("#audit-box"); if(!box) return;
      if(!Array.isArray(evs)||!evs.length){ box.innerHTML = emptyBox("No audit events recorded yet."); return; }
      box.innerHTML = '<table><thead><tr><th>Time</th><th>Event</th><th>Actor</th></tr></thead><tbody>'
        + evs.map(function(ev){ return '<tr><td>'+esc(fmtDT(ev.ts||ev.created_at))+'</td><td>'+esc(ev.event_type||ev.type||"")+'</td><td>'+esc(ev.actor||"")+'</td></tr>'; }).join("")+'</tbody></table>';
    }).catch(function(){ var b=$("#audit-box"); if(b) b.innerHTML = emptyBox("Audit trail unavailable right now."); });
  }).catch(function(err){ $("#prof-form-wrap").innerHTML = errBox(err.message); });
}

function screenFastTrack(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Fast-Track Permissions</h1><div class="card"><div id="ft-msg"></div>'
    + '<p class="notice-box"><strong>Auto-submit is OFF by default.</strong> Turning control A ON permits the agency to submit your profile automatically to matches that fit your rules — without asking you first each time.</p>'
    + '<p><a class="btn btn-ghost btn-sm" href="#/automation">Open the BIG automation toggle &rarr;</a></p>'
    + '<div id="ft-controls">Loading…</div><p><button class="btn" id="ft-save" type="button">Save permissions</button></p></div>';
  var state = {A:false,B:false,C:false,D:false,E:false,F:false,G:false,H:false};
  apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/fast-track").then(function(d){
    var cur = (d.fastTrack&&d.fastTrack.controls)||d.fast_track||d.controls||{};
    Object.keys(state).forEach(function(k){ if(cur[k]!==undefined) state[k]=!!cur[k]; });
    renderFastTrackControls($("#ft-controls"), state, function(k,v){ state[k]=v; });
  }).catch(function(){ renderFastTrackControls($("#ft-controls"), state, function(k,v){ state[k]=v; }); });
  $("#ft-save").addEventListener("click", function(){
    api("/api/v1/talent/"+encodeURIComponent(id)+"/fast-track", {method:"POST", body:{controls:state}})
      .then(function(){ $("#ft-msg").innerHTML = okBox("Fast-Track permissions saved."); })
      .catch(function(err){ $("#ft-msg").innerHTML = errBox(err.message); });
  });
}

function screenConsent(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Likeness Release</h1><div class="card"><div id="consent-msg"></div><div id="consent-body">'+loadingBox("Loading the release…")+'</div></div>';
  apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/likeness-release").then(function(d){
    var text = d.contractText || d.text || d.contract_text || d.release_text || "";
    var signed = !!(d.consent && d.consent.signed) || d.signed === true || d.status === "SIGNED";
    var body = $("#consent-body"); if(!body) return;
    body.innerHTML = '<div class="contract-box">'+esc(text || "The likeness-release contract text was not returned by the backend.")+'</div>'
      + '<form id="consent-form"><label class="checkbox-row"><input type="checkbox" id="consent-check" required> <span>I have read the likeness release above and agree to it.</span></label>'
      + '<label>Type your full legal name as your e-signature<input id="consent-sig" class="sig-input" required placeholder="Type your full name"></label>'
      + '<p><button class="btn" type="submit">Sign the release</button></p></form>'
      + '<hr style="border-color:var(--line)"><h3>Revoke</h3><p class="muted small">You can revoke your likeness release at any time from privacy settings. Revoking stops future use.</p>'
      + '<p><button class="btn btn-danger" id="consent-revoke" type="button">Revoke my likeness release</button></p>'
      + (signed?'<p class="success-box">This release is currently signed.</p>':"");
    $("#consent-form").addEventListener("submit", function(e){
      e.preventDefault();
      var sig = $("#consent-sig").value.trim();
      api("/api/v1/talent/"+encodeURIComponent(id)+"/likeness-release/sign", {method:"POST", body:{signature:sig, agreed:true}})
        .then(function(){ $("#consent-msg").innerHTML = okBox("Release signed. Status: AWAITING AGENCY REVIEW.") + reviewWindowsNotice(); })
        .catch(function(err){ $("#consent-msg").innerHTML = errBox(err.message); });
    });
    $("#consent-revoke").addEventListener("click", function(){
      if(!confirm("Revoke your likeness release?")) return;
      api("/api/v1/talent/"+encodeURIComponent(id)+"/likeness-release/revoke", {method:"POST", body:{}})
        .then(function(){ $("#consent-msg").innerHTML = okBox("Likeness release revoked."); })
        .catch(function(err){ $("#consent-msg").innerHTML = errBox(err.message); });
    });
  }).catch(function(err){ $("#consent-body").innerHTML = errBox(err.message); });
}

function screenMatches(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Matches</h1><div class="card"><p><button class="btn" id="run-match" type="button">Run matching</button></p><div id="match-msg"></div><div id="match-results"></div></div>'
    + '<div class="card"><h2>Rotation queue</h2><p class="muted">The queue orders opportunities for submission. SELECTED entries go forward; SKIPPED entries show the reason.</p><div id="queue-box"></div><p><button class="btn" id="queue-selected" type="button">Queue selected</button></p><div id="queue-msg"></div></div>';
  $("#run-match").addEventListener("click", function(){
    var box = $("#match-results"); box.innerHTML = '<p class="muted">Running matching…</p>';
    api("/api/v1/talent/"+encodeURIComponent(id)+"/match", {method:"POST", body:{}})
      .then(function(d){
        var list = d.matches||d.results||d||[];
        if(!Array.isArray(list) || !list.length){ box.innerHTML = emptyBox("No matches found yet. Complete your profile and portfolio, then run matching again."); return; }
        var renderList = function(titles){
          box.innerHTML = (d.genderExcluded && d.genderExcluded.length ? '<p class="muted">'+d.genderExcluded.length+' listing'+(d.genderExcluded.length===1?"":"s")+' hidden by the gender filter.</p>' : "")
            + (d.genderSet===false ? '<p class="notice-box">Set your gender in <a href="#/profile">Edit My Profile</a> so gender-restricted roles filter correctly for you.</p>' : "")
            + list.map(function(m){
            var o = m.opportunity||{};
            var reasons = Array.isArray(m.reasons) ? m.reasons.join(" · ") : (m.reason||m.explanation||"");
            var oid = m.opportunityId || (o&&o.id) || m.opportunity_id;
            var title = o.title || m.title || (titles && titles[oid]) || oid || "Opportunity";
            return '<div class="opp-card"><h3>'+esc(title)+'</h3><p><strong>'+esc(m.classification||m.match||"")+'</strong> — '+esc(reasons)+'</p>'
              + '<p>'+selBadge(m)+'</p>'
              + '<p class="meta">Gender: '+esc(m.genderRequirement ? (m.genderRequirement==="female"?"Female only":"Male only") : "Open to all genders")+'</p>'
              + (oid?'<p><a href="#/opportunity/'+encodeURIComponent(oid)+'">View opportunity</a></p>':"")+'</div>';
          }).join("");
        };
        apiGet("/api/v1/opportunities?limit=500").then(function(od){
          var titles = {};
          ((od&&od.opportunities)||[]).forEach(function(o){ titles[o.id]=o.title; });
          renderList(titles);
        }).catch(function(){ renderList(null); });
      })
      .catch(function(err){ box.innerHTML = errBox(err.message); });
  });
  window.__tttQueueSelected = [];
  api("/api/v1/talent/"+encodeURIComponent(id)+"/rotation-queue", {method:"POST", body:{}}).then(function(d){
    var q = d.queue||d.items||d||[];
    var box = $("#queue-box"); if(!box) return;
    if(!Array.isArray(q) || !q.length){ box.innerHTML = emptyBox("The rotation queue is empty."); return; }
    window.__tttQueueSelected = q.filter(function(x){ return x.decision==="SELECTED"; }).map(function(x){ return x.opportunityId||x.opportunity_id; }).filter(Boolean);
    box.innerHTML = '<table><thead><tr><th>Opportunity</th><th>Status</th><th>Reason</th></tr></thead><tbody>'
      + q.map(function(item){
          var oid = item.opportunityId||item.opportunity_id||"";
          return '<tr><td>'+(oid?'<a href="#/opportunity/'+encodeURIComponent(oid)+'">'+esc(oid)+'</a>':"—")+'</td><td>'+esc(item.status||item.decision||"—")+'</td><td>'+esc(item.reason||"")+'</td></tr>';
        }).join("")+'</tbody></table>';
  }).catch(function(err){ var b=$("#queue-box"); if(b) b.innerHTML = emptyBox("The rotation queue is unavailable right now." + (err && err.message ? " " + esc(err.message) : "")); });
  $("#queue-selected").addEventListener("click", function(){
    api("/api/v1/talent/"+encodeURIComponent(id)+"/queue-selected", {method:"POST", body:{opportunityIds:(window.__tttQueueSelected||[])}})
      .then(function(){ $("#queue-msg").innerHTML = okBox(isLiveMode() ? "Selected queue entries queued for agency review — the agency sends approved applications by email." : "Selected queue entries queued. TEST MODE: nothing is sent live."); })
      .catch(function(err){ $("#queue-msg").innerHTML = errBox(err.message); });
  });
}

/* ---------- (8b) v7–v11 screens: Jobs For You, automation, earnings, owner, public talent, social, cubicles, replies ---------- */
function screenJobsForYou(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Jobs For You</h1>'
    + '<p class="muted">Your ranked matches, evolved as your profile changes. Each job carries its personal reference code — the same code the agency sees in its email for you.</p>'
    + '<div id="jobs-list">'+loadingBox("Loading your jobs…")+'</div>';
  apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/jobs-for-you").then(function(d){
    var list = d.jobs||[];
    var el = $("#jobs-list"); if(!el) return;
    if(!list.length){ el.innerHTML = emptyBox("No jobs for you yet. Complete your profile and portfolio, then check back — new matches appear as listings land."); return; }
    el.innerHTML = '<p class="muted">'+list.length+' job'+(list.length===1?"":"s")+' for you · Automation is <strong>'+(d.automationEnabled?"ON":"OFF")+'</strong> · '+esc(d.note||"")+(d.genderExcluded? ' · '+d.genderExcluded+' hidden by the gender filter':'')+'</p>'
      + (d.genderSet===false ? '<p class="notice-box">Set your gender in <a href="#/profile">Edit My Profile</a> so gender-restricted roles filter correctly for you.</p>' : "")
      + list.map(function(j){
        return '<div class="opp-card"><h3>'+esc(j.title||"Job")+'</h3>'
          + '<p><strong>'+esc(j.classification||"")+'</strong> — '+esc((j.reasons||[]).join(" · "))+'</p>'
          + '<p>'+selBadge(j)+'</p>'
          + '<p class="meta">Gender: '+esc(j.genderRequirement ? (j.genderRequirement==="female"?"Female only":"Male only") : "Open to all genders")+'</p>'
          + '<p class="meta">'+esc(j.agency||"")+' · '+esc(j.location?((j.location.city||"")+", "+(j.location.state||"")):"")+' · Pay: '+esc(j.compensation||"Not stated")+'</p>'
          + '<p class="meta">Reference code: <strong class="mono">'+esc(j.referenceCode||"")+'</strong> · '+esc(j.automationNote||"")+'</p>'
          + '<p><a class="btn btn-ghost btn-sm" href="#/opportunity/'+encodeURIComponent(j.opportunityId)+'">View opportunity</a></p></div>';
      }).join("");
  }).catch(function(err){ $("#jobs-list").innerHTML = errBox(err.message); });
}

function screenAutomation(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Automation</h1>'
    + '<div class="card"><div id="auto-msg"></div>'
    + '<p class="muted">One BIG switch. When it is ON, the agency may send your profile to matching jobs automatically — agency mailbox sends, you are CC\'d, Reply-To is you, and every send carries your personal reference code for that job. When it is OFF, every job waits for your approval.</p>'
    + '<div class="big-toggle-row"><span class="big-toggle-label">AUTOMATION</span>'
    + '<button type="button" class="big-toggle" id="auto-toggle" aria-pressed="false"><span class="toggle-knob"></span><span class="toggle-state">OFF</span></button></div>'
    + '<p class="notice-box" id="auto-mode-note">TEST MODE — even with automation ON, nothing is ever sent live. Would-be sends queue for review instead.</p>'
    + '<div id="auto-detail"><p class="muted">Loading your automation settings…</p></div>'
    + '<p><button class="btn" id="auto-save" type="button">Save automation</button></p></div>';
  var state = {enabled:false, agencySendEmail:true, ccTalent:true, replyToTalent:true};
  var paint = function(){
    var t = $("#auto-toggle"); if(!t) return;
    t.classList.toggle("on", !!state.enabled);
    t.setAttribute("aria-pressed", state.enabled?"true":"false");
    var s = t.querySelector(".toggle-state"); if(s) s.textContent = state.enabled ? "ON" : "OFF";
  };
  var load = function(){
    apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/automation").then(function(d){
      state = d.automation||state;
      paint();
      var noteEl = $("#auto-mode-note");
      if(noteEl && d.note) noteEl.textContent = d.note;
      var el = $("#auto-detail"); if(!el) return;
      el.innerHTML = '<dl class="kv"><dt>Agency-send email</dt><dd>'+(state.agencySendEmail?"Yes — the agency mailbox sends":"No")+'</dd>'
        + '<dt>You are CC\'d</dt><dd>'+(state.ccTalent?"Yes":"No")+'</dd>'
        + '<dt>Reply-To</dt><dd>'+(state.replyToTalent?"You (the talent)":"The agency")+'</dd>'
        + '<dt>Geography</dt><dd>'+esc(state.geography||"Your fast-track rules")+'</dd>'
        + '<dt>Minimum daily pay</dt><dd>'+esc(state.minDaily!==null&&state.minDaily!==undefined?"$"+state.minDaily:"Your fast-track rules")+'</dd></dl>'
        + '<p class="muted small">Fine-grained rules (categories, geography, pay floor) live in <a href="#/fast-track">Fast-Track Permissions</a>.</p>';
    }).catch(function(err){ $("#auto-detail").innerHTML = errBox(err.message); });
  };
  $("#auto-toggle").addEventListener("click", function(){ state.enabled = !state.enabled; paint(); });
  $("#auto-save").addEventListener("click", function(){
    api("/api/v1/talent/"+encodeURIComponent(id)+"/automation", {method:"POST", body:state})
      .then(function(r){ $("#auto-msg").innerHTML = okBox(state.enabled ? (r && r.testMode===false ? "Automation is ON. Eligible jobs will be sent by the agency email." : "Automation is ON. TEST MODE: nothing is ever sent live.") : "Automation is OFF. Nothing will be submitted automatically."); })
      .catch(function(err){ $("#auto-msg").innerHTML = errBox(err.message); });
  });
  load();
}

function screenEarnings(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">My Earnings &amp; Credits</h1>'
    + '<p class="muted">Proof of work: every job you accepted and completed successfully, plus exactly what <strong>you</strong> made on each one. Agency commission is never shown here — only the owner sees agency money.</p>'
    + '<div id="earn-box">'+loadingBox("Loading your earnings…")+'</div>'
    + '<div id="credits-box">'+loadingBox("Loading your credits…")+'</div>';
  apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/earnings").then(function(d){
    var el = $("#earn-box"); if(!el) return;
    var jobs = d.jobs||[];
    el.innerHTML = '<div class="card"><h2>What you made</h2>'
      + '<p>Running total with TOP TEA TALENTS: <strong class="gold">'+money(d.totalNetCents)+'</strong> across '+d.jobCount+' job'+(d.jobCount===1?"":"s")+' · Completed jobs: <strong>'+money(d.completedNetCents)+'</strong></p>'
      + (jobs.length ? '<table><thead><tr><th>Job</th><th>Agency</th><th>Status</th><th>Net to you</th></tr></thead><tbody>'
        + jobs.map(function(j){ return '<tr><td>'+esc(j.title||"")+'</td><td>'+esc(j.agency||"—")+'</td><td>'+esc(j.status||"")+'</td><td><strong>'+money(j.netCents)+'</strong></td></tr>'; }).join("")+'</tbody></table>'
        : emptyBox("No jobs yet. When you book and complete work, your pay per job and your running total appear here."))
      + '</div>';
  }).catch(function(err){ $("#earn-box").innerHTML = errBox(err.message); });
  apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/credits").then(function(d){
    var el = $("#credits-box"); if(!el) return;
    var list = d.credits||[];
    el.innerHTML = '<div class="card"><h2>Proof of work — credits ('+d.completedCount+')</h2>'
      + (list.length ? '<ul>'+list.map(function(c){ return '<li><strong>'+esc(c.title||"")+'</strong>'+(c.production?" — "+esc(c.production):"")+(c.agency?" · "+esc(c.agency):"")+' · Completed '+esc(fmtDate(c.completedAt))+'</li>'; }).join("")+'</ul>'
        : emptyBox("No completed jobs yet. Finished work shows up here as your proof of work."))
      + (d.acceptedInProgress ? '<p class="muted">'+d.acceptedInProgress+' job'+(d.acceptedInProgress===1?"":"s")+' accepted and in progress.</p>' : "")
      + '</div>';
  }).catch(function(err){ $("#credits-box").innerHTML = errBox(err.message); });
}

function screenOwner(app){
  app.innerHTML = '<h1 style="color:var(--gold)">Owner View</h1>'
    + '<p class="muted">Agency money lives here and nowhere else. Unlock with the owner passcode — the session lasts 12 hours. Talent, staff, and casting never see agency earnings.</p>'
    + '<div class="card"><div id="owner-msg"></div><div id="owner-body">'+loadingBox("Checking the owner gate…")+'</div></div>'
    + '<div id="owner-earnings"></div>';
  var body = $("#owner-body"), earn = $("#owner-earnings");
  var showEarnings = function(){
    var tok = ownerToken();
    api("/api/v1/agency-earnings", {token: tok || undefined}).then(function(d){
      earn.innerHTML = '<div class="card"><h2>Agency Earnings (owner only)</h2>'
        + '<p>Total commission tracked: <strong class="gold">'+money(d.totalCommissionCents)+'</strong> · Total gross: '+money(d.totalGrossCents)+' · Total net paid to talent: '+money(d.totalNetCents)+' · '+d.bookingCount+' booking'+(d.bookingCount===1?"":"s")+'</p>'
        + ((d.byAgency||[]).length ? '<table><thead><tr><th>Agency</th><th>Bookings</th><th>Gross</th><th>Commission</th><th>Net to talent</th></tr></thead><tbody>'
          + d.byAgency.map(function(a){ return '<tr><td>'+esc(a.agency)+'</td><td>'+a.bookings+'</td><td>'+money(a.grossCents)+'</td><td><strong>'+money(a.commissionCents)+'</strong></td><td>'+money(a.netCents)+'</td></tr>'; }).join("")+'</tbody></table>' : emptyBox("No bookings yet — no agency earnings to count."))
        + '<p><button class="btn btn-ghost btn-sm" id="owner-lock" type="button">Lock owner view</button></p></div>';
      var lock = $("#owner-lock");
      if(lock) lock.addEventListener("click", function(){
        api("/api/v1/owner/lock", {method:"POST", body:{}, token: ownerToken() || undefined}).catch(function(){});
        clearOwnerToken();
        $("#owner-msg").innerHTML = okBox("Owner view locked.");
        earn.innerHTML = ""; route();
      });
    }).catch(function(err){ earn.innerHTML = errBox(err.message); });
  };
  var renderForms = function(gate){
    var setFormHtml = isAdmin()
      ? '<hr style="border-color:var(--line)"><h3>Set / change the owner passcode</h3><p class="muted small">Staff (admin token) only. The passcode hash is stored in settings — never in the ledger or the mirror.</p>'
        + '<form id="owner-set-form"><label>New owner passcode (min 6 characters)<input id="owner-new-passcode" type="password" required minlength="6" autocomplete="new-password"></label>'
        + '<p><button class="btn btn-ghost" type="submit">Save passcode</button></p></form>'
      : '<p class="muted small">No passcode set yet? The owner sets it from the staff view (admin token).</p>';
    var bindSetForm = function(){
      var setForm = $("#owner-set-form");
      if(setForm) setForm.addEventListener("submit", function(e){
        e.preventDefault();
        api("/api/v1/owner/set-passcode", {method:"POST", body:{passcode:$("#owner-new-passcode").value}})
          .then(function(){ $("#owner-msg").innerHTML = okBox("Owner passcode saved. Now unlock with it above."); })
          .catch(function(err){ $("#owner-msg").innerHTML = errBox(err.message); });
      });
    };
    if(gate.unlocked){
      body.innerHTML = '<p class="success-box">Owner view is UNLOCKED (12-hour session).</p>'
        + '<p><button class="btn btn-ghost btn-sm" id="owner-lock-2" type="button">Lock owner view</button></p>' + setFormHtml;
      var l2 = $("#owner-lock-2");
      if(l2) l2.addEventListener("click", function(){
        api("/api/v1/owner/lock", {method:"POST", body:{}, token: ownerToken() || undefined}).catch(function(){});
        clearOwnerToken(); earn.innerHTML = ""; route();
      });
      bindSetForm();
      showEarnings();
      return;
    }
    body.innerHTML = '<h3>Unlock the owner view</h3>'
      + '<form id="owner-unlock-form"><label>Owner passcode<input id="owner-passcode" type="password" required autocomplete="off"></label>'
      + '<p><button class="btn" type="submit">Unlock (12 hours)</button></p></form>'
      + setFormHtml;
    $("#owner-unlock-form").addEventListener("submit", function(e){
      e.preventDefault();
      api("/api/v1/owner/unlock", {method:"POST", body:{passcode:$("#owner-passcode").value}})
        .then(function(d){
          try{ localStorage.setItem("ttt_owner_token", d.ownerToken); localStorage.setItem("ttt_owner_expires", d.expiresAt); }catch(err){}
          $("#owner-msg").innerHTML = okBox("Owner view unlocked for 12 hours.");
          route();
        })
        .catch(function(err){ $("#owner-msg").innerHTML = errBox(err.message); });
    });
    bindSetForm();
  };
  api("/api/v1/owner/gate", {token: ownerTokenValid() ? ownerToken() : undefined}).then(renderForms).catch(function(err){ body.innerHTML = errBox(err.message); });
}

function screenPublicTalent(app, talentId){
  try{ talentId = decodeURIComponent(talentId); }catch(e){}
  app.innerHTML = '<p><a href="#/">&larr; Back to Top Tea Talents</a></p><div id="pub-talent">'+loadingBox("Loading portfolio…")+'</div>';
  if(!apiBase()){ $("#pub-talent").innerHTML = emptyBox("This portfolio loads from the live backend once it is connected."); return; }
  apiGet("/api/v1/public/talent/"+encodeURIComponent(talentId)).then(function(d){
    var p = d.portfolio||{};
    var el = $("#pub-talent"); if(!el) return;
    var name = p.professionalName || ((p.firstName||"")+" "+(p.lastName||"")).trim() || "Talent";
    el.innerHTML = '<div class="card"><div class="brand-mark hero-mark">'+brandMarkSVG(64)+'</div>'
      + '<h1>'+esc(name)+'</h1>'
      + '<p class="muted">TOP TEA TALENTS · '+esc([p.city, p.state].filter(Boolean).join(", ")||"")+'</p>'
      + '<p>Categories: <strong>'+esc((p.categories||[]).join(", ")||"—")+'</strong></p>'
      + '<p>Skills: '+esc((p.skills||[]).join(", ")||"—")+' · Languages: '+esc((p.languages||[]).join(", ")||"—")+'</p>'
      + '<p>Height: '+esc(p.height||"—")+' · Availability: '+esc((p.availability||[]).join(", ")||"—")+'</p>'
      + (p.experience?'<p>'+esc(p.experience)+'</p>':"")
      + '</div>'
      + '<div class="card"><h2>Portfolio</h2>'
      + (p.photos && p.photos.length
          ? '<div class="photo-grid">'+p.photos.map(function(ph){ return '<div class="photo-slot"><img src="'+esc(apiBase()+ph.url)+'" alt="'+esc(ph.caption||ph.label)+'"><p class="small">'+esc(ph.caption||ph.label)+'</p></div>'; }).join("")+'</div>'
          : '<p class="muted">No portfolio photos shared publicly.</p>')
      + '</div>'
      + ((p.socialPhotos||[]).length || (p.socialLinks||[]).length ? '<div class="card"><h2>From social</h2>'
        + (p.socialLinks||[]).map(function(s){ return '<p><strong>'+esc(s.platform)+'</strong> — '+esc(s.handle)+(s.bioChecked?" · bio links TOP TEA TALENTS":"")+'</p>'; }).join("")
        + (p.socialPhotos||[]).map(function(ph){ var u = ph.publicPhotoUrl||ph.photoUrl||""; var src = u ? (u.charAt(0)==="/"?apiBase()+u:u) : ""; return '<p>'+(src?'<img src="'+esc(src)+'" alt="'+esc(ph.caption||"Social photo")+'" style="max-width:240px"> ':"")+'<span class="small">'+esc(ph.caption||"")+' ('+esc(ph.platform)+(ph.source? " · "+esc(ph.source):"")+(ph.selection? " · "+esc(ph.selection):"")+(ph.likesLabel? " · "+esc(ph.likesLabel):"")+')</span></p>'; }).join("")
        + '</div>' : "")
      + '<div class="card"><h2>Proof of work — credits ('+(p.credits||[]).length+')</h2>'
      + ((p.credits||[]).length ? '<ul>'+p.credits.map(function(c){ return '<li><strong>'+esc(c.title||"")+'</strong>'+(c.production?" — "+esc(c.production):"")+(c.agency?" · "+esc(c.agency):"")+'</li>'; }).join("")+'</ul>' : '<p class="muted">No completed jobs listed yet.</p>')
      + '</div>'
      + '<p class="muted small">This is a personal portfolio page for '+esc(name)+' — shared with the talent\'s permission. Contact details are never shown here; reach the talent through TOP TEA TALENTS.</p>';
  }).catch(function(err){
    var el = $("#pub-talent"); if(!el) return;
    el.innerHTML = '<div class="card"><h2>Portfolio unavailable</h2><p>'+esc(err.message)+'</p><p class="muted">Portfolios are private by default and shared only with the talent\'s permission.</p></div>';
  });
}

function screenSocial(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Social Links</h1>'
    + '<p class="muted">Link YOUR OWN Instagram and/or Facebook. A few of your photos then show as an extended portfolio preview, alongside your 8-photo portfolio — only what you connect and approve.</p>'
    + '<div class="card"><h2>Instagram auto-pull — honest note</h2><p class="muted small">The agency app can pull your first three Instagram photos plus your most popular post straight from your public profile — only photos the identity check confirms are you. <strong>This public site cannot do that pull itself</strong> — it has no browser to send. The request button below records that honestly and nothing is faked. Your own uploads in the form below work right now and show the same way.</p></div>'
    + '<div class="card"><div id="social-msg"></div><div id="social-list">'+loadingBox("Loading your social links…")+'</div></div>'
    + '<div class="card"><h2>Link an account</h2><form id="social-add-form">'
    + '<label>Platform<select id="social-platform"><option value="instagram">Instagram</option><option value="facebook">Facebook</option></select></label>'
    + '<label>Your handle / profile name<input id="social-handle" placeholder="@yourhandle" required></label>'
    + '<label>Profile URL (optional)<input id="social-profile-url" type="url" placeholder="https://instagram.com/yourhandle"></label>'
    + '<label class="checkbox-row"><input type="checkbox" id="social-own" required> This is my own account</label>'
    + '<p><button class="btn" type="submit">Begin linking — get my ownership code</button></p></form>'
    + '<p class="muted small">There is no OAuth integration — linking is per-talent authorization: you state the account is yours, put the ownership code in your bio, sign, and the agency runs the live bio check. Only a confirmed code authorizes the account.</p></div>'
    + '<div class="card"><h2>Add a social photo to the preview</h2><form id="social-photo-form">'
    + '<label>Platform<select id="social-photo-platform"></select></label>'
    + '<label>Photo<input id="social-photo-file" type="file" accept="image/jpeg,image/png,image/webp" required></label>'
    + '<label>Link to the original post on your own authorized account<input id="social-photo-post-url" type="url" placeholder="https://instagram.com/p/…" required></label>'
    + '<label>Caption<input id="social-photo-caption" placeholder="Optional caption"></label>'
    + '<p><button class="btn btn-ghost" type="submit">Add to preview</button></p></form><div id="social-photo-msg"></div>'
    + '<p class="muted small">Each preview photo needs the link to the original post on your own authorized account, so every photo is traceable to your post. Photos are downscaled in your browser before upload.</p></div>';
  var load = function(){
    apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/social-links").then(function(d){
      var el = $("#social-list"); if(!el) return;
      var links = d.socialLinks||[], photos = d.socialPhotos||[];
      var authorized = links.filter(function(l){ return l.status==="AUTHORIZED"; });
      var sel = $("#social-photo-platform");
      if(sel){
        sel.innerHTML = authorized.length
          ? authorized.map(function(l){ return '<option value="'+esc(l.platform)+'">'+esc(l.platform)+' — '+esc(l.handle)+'</option>'; }).join("")
          : '<option value="">Authorize an account first</option>';
        sel.disabled = !authorized.length;
      }
      el.innerHTML = '<h3>Linked accounts ('+links.length+')</h3>'
        + (links.length ? links.map(function(l){
            var v = l.verificationStatus||"";
            var vText = v==="code_confirmed" ? "Bio check confirmed — the code was found in your bio."
              : v==="check_pending" ? "Signed — the agency runs the live bio check against your public bio."
              : v==="code_not_found" ? "Bio check ran and did NOT find the code in your bio — check it is there, then re-run the check."
              : v==="check_unreadable" ? "Bio check could not read your profile (private or login-walled) — make it public, then re-run the check."
              : "Code issued — put it in your bio, then sign below.";
            var pullText = "";
            if(l.platform==="instagram"){
              if(l.pullStatus==="pulled") pullText = '<p class="muted small">Auto-pull: photos pulled from your public profile.'+(l.pullRejectedCount?" "+l.pullRejectedCount+" photo(s) were rejected by the identity check and never shown.":"")+(l.pullDetail?" "+esc(l.pullDetail):"")+'</p>';
              else if(l.pullStatus==="unavailable") pullText = '<p class="muted small">Auto-pull: not available on this public site — it runs from the agency app.'+(l.pullDetail?" "+esc(l.pullDetail):"")+'</p>';
              else if(l.pullStatus) pullText = '<p class="muted small">Auto-pull: '+esc(l.pullStatus)+(l.pullDetail?" — "+esc(l.pullDetail):"")+'</p>';
            }
            return '<div class="card"><p><strong>'+esc(l.platform)+'</strong> — '+esc(l.handle)+' · <span class="badge '+(l.status==="AUTHORIZED"?"badge-verified":"badge-unverified")+'">'+esc(l.status)+'</span></p>'
              + '<p class="muted small">Verification: '+esc(v||"—")+' — '+vText+'</p>'
              + (l.ownershipCode ? '<p>Your ownership code: <strong>'+esc(l.ownershipCode)+'</strong> — put this exact code in your '+esc(l.platform)+' bio.</p>' : "")
              + (l.signedAt ? '<p class="muted small">Signed by '+esc(l.signatureName||"")+' on '+esc(l.signedAt)+'</p>' : "")
              + (l.checkDetail ? '<p class="muted small">Last check: '+esc(l.checkDetail)+'</p>' : "")
              + pullText
              + (l.status==="AUTHORIZED"||l.signedAt ? "" : '<div><label>Your typed signature (must match your legal or professional name)<input data-sig-name="'+l.id+'" placeholder="Type your full name"></label>'
              + '<label class="checkbox-row"><input type="checkbox" data-sig-bio="'+l.id+'"> The ownership code is in my bio</label>'
              + '<label class="checkbox-row"><input type="checkbox" data-sig-agree="'+l.id+'"> I authorize TOP TEA TALENTS to check my public bio for the code</label>'
              + '<p><button class="mini-btn" data-sign-btn="'+l.id+'">Sign &amp; start the bio check</button></p></div>')
              + '<p>'
              + (l.status!=="AUTHORIZED" && l.signedAt ? '<button class="mini-btn" data-recheck="'+l.id+'">Re-run bio check</button> ' : "")
              + (l.status==="AUTHORIZED" && l.platform==="instagram" ? '<button class="mini-btn" data-pull="'+l.id+'">Request Instagram photo pull</button> ' : "")
              + '<button class="mini-btn" data-unlink="'+l.platform+'">Unlink</button></p></div>';
          }).join("") : emptyBox("No accounts linked yet."))
        + '<h3>Extended portfolio preview ('+photos.length+' photos)</h3>'
        + (photos.length ? photos.map(function(ph){
            var u = ph.photoUrl||"";
            var src = u ? (u.charAt(0)==="/"?apiBase()+u:u) : "";
            return '<p>'+(src?'<img src="'+esc(src)+'" alt="'+esc(ph.caption||"Social photo")+'" style="max-width:200px"> ':"")+'<span class="small">'+esc(ph.caption||"")+' ('+esc(ph.platform)+' · '+esc(ph.source||"upload")+(ph.selection? " · "+esc(ph.selection):"")+(ph.likesLabel? " · "+esc(ph.likesLabel):"")+(ph.identityNote? " — "+esc(ph.identityNote):"")+')</span> '+(ph.sourcePostUrl?'<a class="small" href="'+esc(ph.sourcePostUrl)+'" target="_blank" rel="noopener">original post</a> ':"")+'<button class="mini-btn" data-del-photo="'+ph.id+'">Remove</button></p>';
          }).join("") : '<p class="muted">No preview photos yet — add one below.</p>');
      el.querySelectorAll("[data-sign-btn]").forEach(function(b){
        b.addEventListener("click", function(){
          var lid = b.getAttribute("data-sign-btn");
          var nameEl = el.querySelector('[data-sig-name="'+lid+'"]');
          var bioEl = el.querySelector('[data-sig-bio="'+lid+'"]');
          var agreeEl = el.querySelector('[data-sig-agree="'+lid+'"]');
          api("/api/v1/talent/"+encodeURIComponent(id)+"/social-links/"+encodeURIComponent(lid), {method:"POST", body:{action:"confirm", signatureName:nameEl?nameEl.value.trim():"", codeInBioConfirmed:bioEl?bioEl.checked:false, agreed:agreeEl?agreeEl.checked:false}})
            .then(function(){ $("#social-msg").innerHTML = okBox("Signed. The agency runs the live bio check — your account authorizes only when the code is found in your bio."); load(); })
            .catch(function(err){ $("#social-msg").innerHTML = errBox(err.message); });
        });
      });
      el.querySelectorAll("[data-recheck]").forEach(function(b){
        b.addEventListener("click", function(){
          api("/api/v1/talent/"+encodeURIComponent(id)+"/social-links/"+encodeURIComponent(b.getAttribute("data-recheck")), {method:"POST", body:{action:"resend-bio-check"}})
            .then(function(){ $("#social-msg").innerHTML = okBox("Bio check re-requested."); load(); })
            .catch(function(err){ $("#social-msg").innerHTML = errBox(err.message); });
        });
      });
      el.querySelectorAll("[data-pull]").forEach(function(b){
        b.addEventListener("click", function(){
          api("/api/v1/talent/"+encodeURIComponent(id)+"/social-links/"+encodeURIComponent(b.getAttribute("data-pull")), {method:"POST", body:{action:"request-photo-pull"}})
            .then(function(d){ $("#social-msg").innerHTML = okBox(d.reason||"Auto-pull is not available on this public site."); load(); })
            .catch(function(err){ $("#social-msg").innerHTML = errBox(err.message); });
        });
      });
      el.querySelectorAll("[data-unlink]").forEach(function(b){
        b.addEventListener("click", function(){
          if(!confirm("Unlink this account? All of its preview photos will be removed too.")) return;
          api("/api/v1/talent/"+encodeURIComponent(id)+"/social-links/"+encodeURIComponent(b.getAttribute("data-unlink")), {method:"DELETE"})
            .then(function(){ load(); }).catch(function(err){ $("#social-msg").innerHTML = errBox(err.message); });
        });
      });
      el.querySelectorAll("[data-del-photo]").forEach(function(b){
        b.addEventListener("click", function(){
          api("/api/v1/talent/"+encodeURIComponent(id)+"/social-photos/"+encodeURIComponent(b.getAttribute("data-del-photo")), {method:"DELETE"})
            .then(function(){ load(); }).catch(function(err){ $("#social-msg").innerHTML = errBox(err.message); });
        });
      });
    }).catch(function(err){ $("#social-list").innerHTML = errBox(err.message); });
  };
  load();
  $("#social-add-form").addEventListener("submit", function(e){
    e.preventDefault();
    api("/api/v1/talent/"+encodeURIComponent(id)+"/social-links", {method:"POST", body:{platform:$("#social-platform").value, handle:$("#social-handle").value.trim(), profileUrl:$("#social-profile-url").value.trim()||undefined, ownAccountConfirmed:$("#social-own").checked}})
      .then(function(d){ $("#social-msg").innerHTML = okBox("Link started. Your ownership code is "+(d.socialLink&&d.socialLink.ownershipCode?d.socialLink.ownershipCode:"—")+" — put it in your bio, then sign above."); load(); })
      .catch(function(err){ $("#social-msg").innerHTML = errBox(err.message); });
  });
  $("#social-photo-form").addEventListener("submit", function(e){
    e.preventDefault();
    var f = $("#social-photo-file").files[0];
    if(!f){ $("#social-photo-msg").innerHTML = errBox("Choose a photo file first."); return; }
    var platform = $("#social-photo-platform").value;
    if(!platform){ $("#social-photo-msg").innerHTML = errBox("Authorize an Instagram or Facebook account first."); return; }
    var postUrl = $("#social-photo-post-url").value.trim();
    var caption = $("#social-photo-caption").value.trim();
    downscalePhoto(f, function(dataUrl, err){
      if(err){ $("#social-photo-msg").innerHTML = errBox(err); return; }
      api("/api/v1/talent/"+encodeURIComponent(id)+"/social-photos", {method:"POST", body:{platform:platform, dataUrl:dataUrl, sourcePostUrl:postUrl, caption:caption}})
        .then(function(){ $("#social-photo-msg").innerHTML = okBox("Photo added to your extended portfolio preview."); load(); })
        .catch(function(err){ $("#social-photo-msg").innerHTML = errBox(err.message); });
    });
  });
}

function screenCubicles(app){
  app.innerHTML = '<h1 style="color:var(--gold)">Cubicles</h1>'
    + '<p class="muted">Specialist cubicles — the discovery workforce. Each cubicle has a department, mission, sources, and a live status. Statuses reflect configuration only; discovery runs on the sweep schedule.</p>'
    + '<div id="cub-list">'+loadingBox("Loading cubicles…")+'</div>'
    + '<div class="card" id="cub-add-box"><h2>Add a cubicle (staff)</h2><div id="cub-msg"></div>'
    + '<form id="cub-add-form"><label>Name<input id="cub-name" required placeholder="e.g. South Florida Extras Scout"></label>'
    + '<label>Department<input id="cub-dept" placeholder="Film and Television Casting"></label>'
    + '<label>Mission<input id="cub-mission" placeholder="What this specialist hunts for"></label>'
    + '<p><button class="btn" type="submit">Create cubicle</button></p></form>'
    + '<p class="muted small">Staff only — needs the admin token (enter it on the Agency page).</p></div>';
  var load = function(){
    if(!apiBase()){ $("#cub-list").innerHTML = emptyBox("Cubicles load from the live backend once it is connected."); return; }
    apiGet("/api/v1/cubicles").then(function(d){
      var list = d.cubicles||[];
      var el = $("#cub-list"); if(!el) return;
      if(!list.length){ el.innerHTML = emptyBox("No cubicles configured yet. The spec targets 50 specialist cubicles across 6 departments."); return; }
      el.innerHTML = list.map(function(c){
        return '<div class="card card-lift"><h3>'+esc(c.name||c.id)+'</h3>'
          + '<p class="meta">'+esc(c.department||c.dept||"—")+' · Status: <strong>'+esc(c.status||"OPEN")+'</strong></p>'
          + '<p>'+esc(c.mission||c.assignment||"")+'</p>'
          + (isAdmin()?'<p><label>Status <select data-cub-status="'+esc(c.id)+'"><option'+(c.status==="OPEN"?" selected":"")+'>OPEN</option><option'+(c.status==="PAUSED"?" selected":"")+'>PAUSED</option><option'+(c.status==="CLOSED"?" selected":"")+'>CLOSED</option></select></label> <button class="mini-btn" data-cub-save="'+esc(c.id)+'">Save status</button></p>':"")
          + '</div>';
      }).join("");
      el.querySelectorAll("[data-cub-save]").forEach(function(b){
        b.addEventListener("click", function(){
          var sel = el.querySelector('[data-cub-status="'+b.getAttribute("data-cub-save")+'"]');
          api("/api/v1/cubicles/"+encodeURIComponent(b.getAttribute("data-cub-save"))+"/status", {method:"PATCH", body:{status: sel ? sel.value : "OPEN"}})
            .then(function(){ load(); }).catch(function(err){ $("#cub-msg").innerHTML = errBox(err.message); });
        });
      });
    }).catch(function(err){ $("#cub-list").innerHTML = errBox(err.message); });
  };
  load();
  $("#cub-add-form").addEventListener("submit", function(e){
    e.preventDefault();
    api("/api/v1/cubicles", {method:"POST", body:{name:$("#cub-name").value.trim(), department:$("#cub-dept").value.trim(), mission:$("#cub-mission").value.trim()}})
      .then(function(){ $("#cub-msg").innerHTML = okBox("Cubicle created."); load(); })
      .catch(function(err){ $("#cub-msg").innerHTML = errBox(err.message); });
  });
}

function screenReplies(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Agency Replies</h1>'
    + '<p class="muted">Replies from agencies and casting directors to your applications — auditions, callbacks, questions, offers. Recorded by staff as they arrive.</p>'
    + '<div id="replies-list">'+loadingBox("Loading replies…")+'</div>'
    + (isAdmin()?'<div class="card"><h2>Record an inbound reply (staff)</h2><div id="reply-msg"></div>'
      + '<form id="reply-form"><label>Application ID<input id="reply-app" required placeholder="app_…"></label>'
      + '<label>From (agency / casting name)<input id="reply-from" placeholder="Project Casting"></label>'
      + '<label>Channel<input id="reply-channel" placeholder="Email, phone, portal…"></label>'
      + '<label>Reply<textarea id="reply-body" rows="4" required placeholder="What they said…"></textarea></label>'
      + '<p><button class="btn" type="submit">Record reply</button></p></form></div>':"");
  var load = function(){
    apiGet("/api/v1/application-replies?talentId="+encodeURIComponent(id)).then(function(d){
      var list = d.replies||[];
      var el = $("#replies-list"); if(!el) return;
      if(!list.length){ el.innerHTML = emptyBox("No replies yet. When an agency answers one of your applications, their reply shows up here."); return; }
      el.innerHTML = list.map(function(r){
        return '<div class="card"><p><strong>'+esc(r.fromName||"Agency")+'</strong> · '+esc(r.channel||"")+' · '+esc(fmtDT(r.receivedAt))+'</p>'
          + '<p>'+esc(r.body||"")+'</p><p class="muted small">Application: '+esc(r.applicationId)+'</p></div>';
      }).join("");
    }).catch(function(err){ $("#replies-list").innerHTML = errBox(err.message); });
  };
  load();
  var f = $("#reply-form");
  if(f) f.addEventListener("submit", function(e){
    e.preventDefault();
    api("/api/v1/application-replies", {method:"POST", body:{applicationId:$("#reply-app").value.trim(), fromName:$("#reply-from").value.trim(), channel:$("#reply-channel").value.trim(), body:$("#reply-body").value.trim()}})
      .then(function(){ $("#reply-msg").innerHTML = okBox("Reply recorded."); load(); })
      .catch(function(err){ $("#reply-msg").innerHTML = errBox(err.message); });
  });
}

/* ---------- (9) applications / bookings / notifications / settings / compliance ---------- */
function screenApplications(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Applications</h1><div id="apps-list">'+loadingBox("Loading applications…")+'</div>';
  apiGet("/api/v1/applications?talentId="+encodeURIComponent(id)).then(function(d){
    var list = d.applications||d||[];
    var el = $("#apps-list"); if(!el) return;
    if(!list.length){ el.innerHTML = emptyBox("No applications yet. Browse opportunities and apply — you approve before anything is sent."); return; }
    el.innerHTML = list.map(function(a){
      return '<div class="card card-lift"><h3>'+esc((a.opportunity&&a.opportunity.title)||a.opportunity_title||a.opportunityId||a.opportunity_id||"Application")+'</h3>'
        + '<p>Status: <strong>'+esc(a.status||"pending")+'</strong></p>'
        + '<p class="muted small">Applied '+esc(fmtDT(a.createdAt||a.created_at||a.submitted_at))+'</p></div>';
    }).join("");
  }).catch(function(err){ $("#apps-list").innerHTML = errBox(err.message); });
}

function screenBookings(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Bookings</h1><div id="book-list">'+loadingBox("Loading bookings…")+'</div>';
  apiGet("/api/v1/bookings?talentId="+encodeURIComponent(id)).then(function(d){
    var list = d.bookings||d||[];
    var el = $("#book-list"); if(!el) return;
    if(!list.length){ el.innerHTML = emptyBox("No bookings yet. When you book, the gross, fee, and net appear here to the cent."); return; }
    el.innerHTML = list.map(function(b){
      var gross = b.grossCents ?? b.gross_cents ?? (b.gross!==undefined?Math.round(b.gross*100):null);
      var fee = b.commissionCents ?? b.feeCents ?? b.fee_cents ?? (b.fee!==undefined?Math.round(b.fee*100):null);
      var net = b.netCents ?? b.net_cents ?? (b.net!==undefined?Math.round(b.net*100):null);
      var pct = b.rate ?? b.fee_percent ?? b.commission_percent ?? b.fee_pct ?? "";
      var showFee = isAdmin() || ownerTokenValid();
      return '<div class="card card-lift"><h3>'+esc(b.title||b.opportunity_title||b.opportunityId||"Booking")+'</h3>'
        + '<p>Status: <strong>'+esc(b.status||"—")+'</strong> · Payment: <strong>'+esc(b.payment_status||"—")+'</strong></p>'
        + '<table><tbody>'
        + '<tr><td>Gross</td><td><strong>'+(gross!==null?money(gross):"—")+'</strong></td></tr>'
        + (showFee?'<tr><td>Agency fee'+(pct!==""?' ('+esc(pct)+'%)':"")+'</td><td><strong>'+(fee!==null?money(fee):"—")+'</strong></td></tr>':"")
        + '<tr><td>Net to you</td><td><strong class="gold">'+(net!==null?money(net):"—")+'</strong></td></tr>'
        + '</tbody></table>'+(showFee?"":'<p class="muted small">Agency fee is hidden here — only the owner sees agency money. Your net is what you were paid.</p>')+'</div>';
    }).join("");
  }).catch(function(err){ $("#book-list").innerHTML = errBox(err.message); });
}

function screenNotifications(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Notifications</h1><p class="notice-box">IN-APP DELIVERED · EMAIL QUEUED — email pending: integration not connected. Email is never claimed as sent.</p><div id="notif-list">'+loadingBox("Loading notifications…")+'</div>';
  var load = function(){
    apiGet("/api/v1/talent/"+encodeURIComponent(id)+"/notifications").then(function(d){
      var list = d.notifications||d||[];
      var el = $("#notif-list"); if(!el) return;
      if(!list.length){ el.innerHTML = emptyBox("No notifications yet."); return; }
      el.innerHTML = list.map(function(n){
        var read = n.read || n.read_at;
        return '<div class="card"><p><strong>'+esc(n.title||n.type||"Notification")+'</strong> '+(read?"":'<span class="badge badge-blue">UNREAD</span>')+'</p>'
          + '<p>'+esc(n.body||n.message||"")+'</p>'
          + '<p class="muted small">'+esc(fmtDT(n.createdAt||n.created_at))+' · IN-APP DELIVERED · EMAIL QUEUED</p>'
          + '<p><button class="mini-btn" data-read="'+n.id+'">Mark read</button> <button class="mini-btn" data-notif-del="'+n.id+'">Delete</button></p></div>';
      }).join("");
      el.querySelectorAll("[data-read]").forEach(function(b){
        b.addEventListener("click", function(){
          api("/api/v1/notifications/"+encodeURIComponent(b.getAttribute("data-read"))+"/read", {method:"PATCH", body:{read:true}}).then(load).catch(function(){});
        });
      });
      el.querySelectorAll("[data-notif-del]").forEach(function(b){
        b.addEventListener("click", function(){
          api("/api/v1/notifications/"+encodeURIComponent(b.getAttribute("data-notif-del")), {method:"DELETE"}).then(load).catch(function(){});
        });
      });
    }).catch(function(err){ $("#notif-list").innerHTML = errBox(err.message); });
  };
  load();
}

/* ---------- (6b) Community Board (v17, Phase 0 + bubble fix) ----------
   One public board: everybody talks in it, everybody sees everybody's
   messages — there are no private DMs. @ mentions autocomplete live
   (narrowing per letter, tap to insert) and are highlighted to the
   named talent (+ an in-app notification). The direct-talk bubble is
   ONLY a filtered view of the same public posts — its header says so
   in plain words. It is DOCKED (sticky side panel on desktop, bottom
   sheet on phones) and never covers the feed; it closes the instant you
   tap the x, End chat, anywhere outside it, or Talk to / Reply again
   for the same person, or minimizes to a small chip — the 30-second
   auto-close is only a backup. The messages themselves stay on the
   board. @ suggestions dismiss the instant one is picked. The composer
   is a plain textarea with NO autocorrect/autocomplete suppression, so
   the phone keyboard's predictive spelling works exactly as ordered.
   Audio/carousel buttons call the honest-refusal endpoint and create
   nothing. Ported from artifact top-tea-talents v17. */
function screenCommunity(app){
  var me = sessionTalentId();
  var signedIn = isLoggedIn();
  var posts = [];
  var picks = [];
  var photo = null; // {dataBase64, mimeType, preview}
  var mentionQuery = null;
  var suggestions = [];
  var partner = null; // {talentId, name, handle}
  var bubbleText = "";
  var lastActivity = 0;
  var bubbleMin = false; // bubble minimized to a chip (never over the feed)
  var reported = {};
  var refreshTick = 0;

  // Instant dismiss: every close path below clears the partner at once —
  // no timer, no delay. The 30s auto-close in the tick is only a backup.
  function closeBubble(){ partner = null; bubbleText = ""; bubbleMin = false; lastActivity = 0; renderBubble(); }
  function boardBodyHTML(post){
    var text = esc(post.body||"");
    var handles = (post.mentions||[]).map(function(m){ return m.handle; }).filter(Boolean);
    if(!handles.length) return text;
    var re = new RegExp("(@(?:" + handles.map(function(h){ return h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + "))", "gi");
    return text.split(re).map(function(part){
      var m = (post.mentions||[]).filter(function(x){ return part.toLowerCase() === "@"+String(x.handle||"").toLowerCase(); })[0];
      if(!m) return part;
      var cls = m.talentId === me ? "mention mention-me" : "mention";
      return '<span class="'+cls+'">'+esc(part)+'</span>';
    }).join("");
  }
  function postCardHTML(post){
    var mine = post.talentId === me;
    var h = '<article class="card board-post'+(post.mentionsViewer?' board-post-mentioned':'')+'" data-post-id="'+esc(post.id)+'">'
      + '<p><strong style="color:var(--gold)">'+esc(post.authorName)+'</strong> <span class="muted small">@'+esc(post.authorHandle)+'</span> '
      + '<span class="muted small">'+esc(fmtDT(post.createdAt))+'</span> '
      + (post.mentionsViewer?'<span class="badge badge-gold">MENTIONED YOU</span>':"")
      + (mine?'<span class="badge badge-blue">YOUR POST</span>':"")+'</p>'
      + '<p style="white-space:pre-wrap;overflow-wrap:break-word">'+boardBodyHTML(post)+'</p>';
    if(post.photoUrl) h += '<p><img src="'+esc(apiBase()+post.photoUrl)+'" alt="Photo posted by '+esc(post.authorName)+'" style="border-radius:12px;max-height:320px;width:auto;max-width:100%;border:1px solid rgba(212,175,55,.35)" loading="lazy"></p>';
    h += '<p>';
    if(signedIn && !mine) h += '<button class="mini-btn" data-talk="'+esc(post.talentId)+'" data-talk-name="'+esc(post.authorName)+'" data-talk-handle="'+esc(post.authorHandle)+'">Talk to '+esc((post.authorName||"them").split(" ")[0])+'</button> ';
    if(signedIn && post.mentionsViewer && !mine) h += '<button class="mini-btn" data-talk="'+esc(post.talentId)+'" data-talk-name="'+esc(post.authorName)+'" data-talk-handle="'+esc(post.authorHandle)+'">Reply</button> ';
    if(signedIn && mine) h += '<button class="mini-btn" data-del="'+esc(post.id)+'">Delete my post</button> ';
    if(ownerTokenValid()) h += '<button class="mini-btn" data-remove="'+esc(post.id)+'">Remove (owner)</button> ';
    if(signedIn) h += '<button class="mini-btn" data-report="'+esc(post.id)+'">'+(reported[post.id]?"Reported":"Report")+'</button>';
    h += '</p></article>';
    return h;
  }
  function threadPosts(){
    if(!partner) return [];
    return posts.filter(function(p){
      return (p.talentId === me && (p.mentions||[]).some(function(m){ return m.talentId === partner.talentId; }))
        || (p.talentId === partner.talentId && (p.mentions||[]).some(function(m){ return m.talentId === me; }));
    }).slice().reverse();
  }
  function renderBubble(){
    var el = $("#board-bubble"); if(!el) return;
    var layout = el.closest(".board-layout");
    if(!partner || !signedIn){
      el.innerHTML = "";
      if(layout) layout.classList.remove("bubble-open", "bubble-min");
      return;
    }
    if(layout){ layout.classList.toggle("bubble-open", !bubbleMin); layout.classList.toggle("bubble-min", bubbleMin); }
    if(bubbleMin){
      el.innerHTML = '<div class="board-bubble-chip" id="bubble-chip" role="button" tabindex="0" aria-label="Re-open talk with '+esc(partner.name)+'">'
        + '<span>Talking with <strong style="color:var(--gold)">'+esc(partner.name)+'</strong> — tap to open</span>'
        + '<button class="btn btn-sm" id="bubble-chip-close" type="button" aria-label="Close talk">×</button></div>';
      var chip = $("#bubble-chip");
      chip.addEventListener("click", function(){ bubbleMin = false; lastActivity = Date.now(); renderBubble(); });
      chip.addEventListener("keydown", function(e){ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); bubbleMin = false; lastActivity = Date.now(); renderBubble(); } });
      $("#bubble-chip-close").addEventListener("click", function(e){ e.stopPropagation(); closeBubble(); });
      return;
    }
    var thread = threadPosts();
    var h = '<div class="board-bubble"><div style="display:flex;justify-content:space-between;gap:.5rem;align-items:flex-start">'
      + '<h2 style="margin:0;color:var(--gold)">Talking with '+esc(partner.name)+'</h2>'
      + '<span style="display:flex;gap:.25rem;flex:none">'
      + '<button class="btn btn-sm" id="bubble-min" type="button" aria-label="Minimize talk">–</button>'
      + '<button class="btn btn-sm" id="bubble-close" type="button" aria-label="Close talk">×</button>'
      + '<button class="btn btn-sm" id="bubble-end" type="button">End chat</button></span></div>'
      + '<p class="muted small">Everyone on the board can see this conversation — the bubble just makes it easier to follow. Tap ×, End chat, or anywhere outside it and it is gone at once; it also closes on its own 30 seconds after the last typing. The messages stay on the board.</p>'
      + '<div id="bubble-thread" style="max-height:320px;overflow-y:auto;margin-bottom:.75rem">'
      + (thread.length ? thread.map(function(p){
          var mine = p.talentId === me;
          return '<div class="board-bubble-msg'+(mine?' board-bubble-mine':'')+'"><p class="small" style="margin:0"><strong style="color:var(--gold)">'+esc(mine?"You":p.authorName)+'</strong> · '+esc(fmtDT(p.createdAt))+'</p>'
            + '<p style="white-space:pre-wrap;overflow-wrap:break-word;margin:.2rem 0 0">'+boardBodyHTML(p)+'</p>'
            + (p.photoUrl?'<p style="margin:.3rem 0 0"><img src="'+esc(apiBase()+p.photoUrl)+'" alt="Photo posted by '+esc(p.authorName)+'" style="border-radius:8px;max-height:160px;width:auto;max-width:100%" loading="lazy"></p>':"")+'</div>';
        }).join("") : '<p class="muted small">No messages between you two yet — say hello below. It posts straight to the public board, addressed to @'+esc(partner.handle)+'.</p>')
      + '</div>'
      + '<label for="bubble-text" class="small muted">Message @'+esc(partner.handle)+' — public, everyone can see it</label>'
      + '<textarea id="bubble-text" rows="2" autocomplete="on" autocorrect="on" autocapitalize="sentences" spellcheck="true" placeholder="Message @'+esc(partner.handle)+'…" aria-label="Message '+esc(partner.name)+' on the public board">'+esc(bubbleText)+'</textarea>'
      + '<p style="margin-top:.5rem"><button class="btn" id="bubble-send" type="button">Send to @'+esc(partner.handle)+'</button></p></div>';
    el.innerHTML = h;
    $("#bubble-min").addEventListener("click", function(){ bubbleMin = true; renderBubble(); });
    $("#bubble-close").addEventListener("click", function(){ closeBubble(); });
    $("#bubble-end").addEventListener("click", function(){ closeBubble(); });
    var ta = $("#bubble-text");
    ta.addEventListener("input", function(){ bubbleText = ta.value; lastActivity = Date.now(); });
    $("#bubble-send").addEventListener("click", function(){
      if(!bubbleText.trim() || !partner) return;
      var body = bubbleText.trim();
      bubbleText = ""; lastActivity = Date.now();
      api("/api/v1/board/posts", {method:"POST", body:{talentId:me, body:body, mentionedTalentIds:[partner.talentId]}})
        .then(function(r){ setNotice(r.message||"Posted to the Community Board."); loadPosts(); renderBubble(); })
        .catch(function(e){ setNotice(e.message); });
    });
  }
  function setNotice(msg){
    var el = $("#board-notice"); if(el) el.innerHTML = msg ? '<p class="small" role="status" style="color:var(--gold);font-weight:700">'+esc(msg)+'</p>' : "";
  }
  function renderPosts(){
    var el = $("#board-posts"); if(!el) return;
    if(!posts.length){ el.innerHTML = emptyBox("No posts yet. Be the first to say hello, share a job photo, or ask the community for what you need."); return; }
    el.innerHTML = posts.map(postCardHTML).join("");
    el.querySelectorAll("[data-talk]").forEach(function(b){
      b.addEventListener("click", function(){
        if(partner && partner.talentId === b.getAttribute("data-talk")){ closeBubble(); return; }
        partner = {talentId:b.getAttribute("data-talk"), name:b.getAttribute("data-talk-name"), handle:b.getAttribute("data-talk-handle")};
        bubbleText = ""; bubbleMin = false; lastActivity = Date.now(); renderBubble();
      });
    });
    el.querySelectorAll("[data-del]").forEach(function(b){
      b.addEventListener("click", function(){
        api("/api/v1/board/posts/"+encodeURIComponent(b.getAttribute("data-del"))+"/delete", {method:"POST", body:{talentId:me}})
          .then(function(r){ setNotice(r.message); loadPosts(); })
          .catch(function(e){ setNotice(e.message); });
      });
    });
    el.querySelectorAll("[data-remove]").forEach(function(b){
      b.addEventListener("click", function(){
        api("/api/v1/board/posts/"+encodeURIComponent(b.getAttribute("data-remove"))+"/remove", {method:"POST", body:{ownerToken:ownerToken()}, token:ownerToken()||undefined})
          .then(function(r){ setNotice(r.message); loadPosts(); })
          .catch(function(e){ setNotice(e.message); });
      });
    });
    el.querySelectorAll("[data-report]").forEach(function(b){
      b.addEventListener("click", function(){
        var id = b.getAttribute("data-report");
        api("/api/v1/board/posts/"+encodeURIComponent(id)+"/report", {method:"POST", body:{reporterTalentId:me, reason:""}})
          .then(function(r){ reported[id] = true; setNotice(r.message); renderPosts(); })
          .catch(function(e){ setNotice(e.message); });
      });
    });
  }
  function loadPosts(){
    if(!apiBase()){ var el=$("#board-posts"); if(el) el.innerHTML = emptyBox("The board loads from the live backend once it is connected."); return; }
    apiGet("/api/v1/board/posts?viewerTalentId="+encodeURIComponent(me||"")).then(function(d){
      posts = d.posts||[]; renderPosts(); renderBubble();
    }).catch(function(e){ var el2=$("#board-posts"); if(el2) el2.innerHTML = errBox(e.message); });
  }
  function openBubble(p){ partner = p; bubbleText = ""; bubbleMin = false; lastActivity = Date.now(); renderBubble(); }
  function onComposerChange(value, cursor){
    var upto = cursor == null ? value : value.slice(0, cursor);
    var m = /(?:^|\s)@([A-Za-z0-9]*)$/.exec(upto);
    mentionQuery = m ? (m[1]||"") : null;
    renderSuggestions();
    if(mentionQuery !== null && signedIn){
      apiGet("/api/v1/board/mentions/search?q="+encodeURIComponent(mentionQuery)).then(function(d){
        suggestions = (d.profiles||[]).filter(function(p){ return p.talentId !== me; });
        renderSuggestions();
      }).catch(function(){ suggestions = []; renderSuggestions(); });
    }
  }
  function renderSuggestions(){
    var box = $("#board-suggestions"); if(!box) return;
    if(mentionQuery === null){ box.innerHTML = ""; return; }
    if(!suggestions.length){
      box.innerHTML = '<div class="board-suggest-empty">No profile matches “@'+esc(mentionQuery)+'” yet — keep typing.</div>';
      return;
    }
    box.innerHTML = suggestions.map(function(p, i){
      return '<button type="button" class="board-suggest-item" data-sugg="'+i+'"><span aria-hidden="true">⭐</span> <strong style="color:var(--gold)">@'+esc(p.handle)+'</strong> <span class="muted">'+esc(p.name)+'</span></button>';
    }).join("");
    box.querySelectorAll("[data-sugg]").forEach(function(b){
      b.addEventListener("pointerdown", function(e){ e.preventDefault(); chooseMention(suggestions[Number(b.getAttribute("data-sugg"))]); });
    });
  }
  function chooseMention(p){
    if(!p) return;
    var ta = $("#board-text"); if(!ta) return;
    var cursor = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    var upto = ta.value.slice(0, cursor), rest = ta.value.slice(cursor);
    var replaced = upto.replace(/(?:^|\s)@[A-Za-z0-9]*$/, function(whole){ return (whole.charAt(0) === "@" ? "" : whole.charAt(0)) + "@" + p.handle + " "; });
    ta.value = replaced + rest;
    if(!picks.some(function(x){ return x.talentId === p.talentId; })) picks.push(p);
    mentionQuery = null; renderSuggestions();
    ta.focus();
  }
  function submitPost(){
    var ta = $("#board-text"); if(!ta) return;
    var body = ta.value.trim();
    if(!body && !photo){ setNotice("Write something or add a photo before posting."); return; }
    var live = picks.filter(function(p){ return body.toLowerCase().indexOf("@"+p.handle.toLowerCase()) >= 0; });
    var payload = {talentId:me, body:body, mentionedTalentIds:live.map(function(p){ return p.talentId; })};
    if(photo) payload.photo = {dataBase64:photo.dataBase64, mimeType:photo.mimeType};
    api("/api/v1/board/posts", {method:"POST", body:payload}).then(function(r){
      setNotice(r.message); ta.value = ""; photo = null; picks = []; mentionQuery = null;
      var pv = $("#board-photo-preview"); if(pv) pv.innerHTML = "";
      renderSuggestions(); loadPosts();
      if(live.length) openBubble(live[0]);
    }).catch(function(e){ setNotice(e.message); });
  }
  function onPhotoFile(file){
    if(!file) return;
    if(["image/jpeg","image/png","image/webp"].indexOf(file.type) < 0){ setNotice("Board photos must be JPG, PNG, or WEBP."); return; }
    if(file.size > 500*1024){ setNotice("That photo is too large for the board — 500 KB maximum. Pick a smaller photo."); return; }
    var rd = new FileReader();
    rd.onload = function(){
      var dataUrl = String(rd.result||"");
      var m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if(!m){ setNotice("That photo appears empty or corrupted. Choose a different photo."); return; }
      photo = {dataBase64:m[2], mimeType:m[1], preview:dataUrl};
      var pv = $("#board-photo-preview");
      if(pv) pv.innerHTML = '<div style="display:flex;gap:.75rem;align-items:flex-start;margin-top:.75rem"><img src="'+esc(dataUrl)+'" alt="Photo attached to your post" style="border-radius:12px;max-height:160px;width:auto;border:1px solid rgba(212,175,55,.4)"><button class="btn btn-ghost btn-sm" id="board-photo-remove" type="button">Remove photo</button></div>';
      var rm = $("#board-photo-remove");
      if(rm) rm.addEventListener("click", function(){ photo = null; var pv2=$("#board-photo-preview"); if(pv2) pv2.innerHTML = ""; });
      setNotice("");
    };
    rd.onerror = function(){ setNotice("Could not read that photo file."); };
    rd.readAsDataURL(file);
  }
  function mediaAttempt(kind){
    api("/api/v1/board/media-posts", {method:"POST", body:{talentId:me, kind:kind, body:""}}).then(function(r){ setNotice(r.message); }).catch(function(e){ setNotice(e.message); });
  }

  app.innerHTML = '<h1 style="color:var(--gold)">Community Board</h1>'
    + '<div class="card"><p><strong>This board is public.</strong> Everyone on the board can see every post and every conversation — there are no private messages here. Talk to someone directly by @-mentioning them: it reaches them highlighted, like a direct message, but it stays on the open board for everyone to see.</p>'
    + '<p class="muted">Share your experiences, post photos from jobs, and find people in the talent pool for what you need — a videographer, a photographer, a partner for your next project. Create together, make friends, make partners.</p>'
    + '<p class="muted small">Moderation: there is no automatic content filter. You can delete your own posts, report any post, and the agency owner reviews reports and can remove posts. Posting here is not a submission — nothing is sent to an employer.</p></div>'
    + (signedIn ? "" : '<div class="card"><h2>Join the conversation</h2><p>You can read the whole board right now — it\'s public. To post, @-mention, and talk with other talent, sign up or open your profile first.</p><p><a class="btn" href="#/join">SIGN UP — JOIN FREE</a> <a class="btn btn-ghost" href="#/dashboard">My Dashboard</a></p></div>')
    + (signedIn ? '<div class="card"><h2>Post to the board</h2><div style="position:relative">'
      + '<label for="board-text">Share something with the community… type @ to mention someone</label>'
      + '<textarea id="board-text" rows="3" autocomplete="on" autocorrect="on" autocapitalize="sentences" spellcheck="true" placeholder="Share something with the community… type @ to mention someone" aria-label="Write a post for the community board"></textarea>'
      + '<div id="board-suggestions" class="board-suggest" role="listbox" aria-label="Mention suggestions"></div></div>'
      + '<div id="board-photo-preview"></div>'
      + '<p style="margin-top:.75rem"><button class="btn" id="board-post-btn" type="button">Post</button> '
      + '<label class="btn btn-ghost btn-sm" style="cursor:pointer">Add photo<input type="file" id="board-photo-input" accept="image/jpeg,image/png,image/webp" style="display:none" aria-label="Add a photo to your post"></label> '
      + '<button class="btn btn-ghost btn-sm" id="board-audio-btn" type="button">Add music</button> '
      + '<button class="btn btn-ghost btn-sm" id="board-carousel-btn" type="button">Carousel</button></p>'
      + '<p class="muted small">Photos: JPG, PNG, or WEBP, up to 500 KB. Type @ plus a letter and matching profiles appear — tap one to mention them.</p>'
      + '<div id="board-notice"></div></div>' : '<div id="board-notice"></div>')
    + '<div class="board-layout"><div id="board-posts" style="flex:1;min-width:0">'+loadingBox("Loading the board…")+'</div><aside id="board-bubble" style="flex:0 0 360px;min-width:0" aria-label="Direct talk"></aside></div>';

  if(signedIn){
    var ta = $("#board-text");
    ta.addEventListener("input", function(){ onComposerChange(ta.value, ta.selectionStart); });
    ta.addEventListener("click", function(){ onComposerChange(ta.value, ta.selectionStart); });
    $("#board-post-btn").addEventListener("click", submitPost);
    $("#board-photo-input").addEventListener("change", function(e){ onPhotoFile(e.target.files && e.target.files[0]); e.target.value = ""; });
    $("#board-audio-btn").addEventListener("click", function(){ mediaAttempt("audio"); });
    $("#board-carousel-btn").addEventListener("click", function(){ mediaAttempt("carousel"); });
  }
  // Instant dismiss, part 2: a tap anywhere outside the bubble closes it
  // at once (so it never sits over the feed while you read), and Escape
  // closes the bubble and any open @ suggestions. Taps inside the bubble,
  // on a Talk to / Reply button (toggle), or on a suggestion are left
  // alone. Stored on window so route() removes them on navigation,
  // same pattern as the timers.
  if(window.__tttBoardOutsideTap) document.removeEventListener("pointerdown", window.__tttBoardOutsideTap);
  if(window.__tttBoardEsc) document.removeEventListener("keydown", window.__tttBoardEsc);
  window.__tttBoardOutsideTap = function(e){
    var t = e.target;
    if(!t || !t.closest) return;
    if(partner && !t.closest("#board-bubble") && !t.closest("[data-talk]")) closeBubble();
    if(mentionQuery !== null && !t.closest("#board-suggestions") && !t.closest("#board-text")){ mentionQuery = null; renderSuggestions(); }
  };
  window.__tttBoardEsc = function(e){
    if(e.key !== "Escape") return;
    if(partner) closeBubble();
    if(mentionQuery !== null){ mentionQuery = null; renderSuggestions(); }
  };
  document.addEventListener("pointerdown", window.__tttBoardOutsideTap);
  document.addEventListener("keydown", window.__tttBoardEsc);
  loadPosts();
  // Refresh the board every 15s while this screen is open; the
  // 1-second tick also auto-closes the bubble 30s after last typing
  // (backup only — every close path above is instant). Timers and the
  // outside-tap / Escape handlers are cleared by route() on navigation.
  window.__tttBoardTimers = window.__tttBoardTimers || [];
  window.__tttBoardTimers.push(setInterval(function(){
    refreshTick++;
    if(partner && lastActivity && Date.now() - lastActivity > 30000){ closeBubble(); }
    if(refreshTick % 15 === 0) loadPosts();
  }, 1000));
}

function screenSettings(app){
  if(!requireLogin(app)) return;
  var id = sessionTalentId();
  app.innerHTML = '<h1 style="color:var(--gold)">Settings &amp; Commission</h1>'
    + '<div class="card"><h2>Commission</h2><div id="comm-box">'+loadingBox("Loading commission terms…")+'</div></div>'
    + '<div class="card"><h2>Commission preview</h2><p class="muted">Preview from the live calculator endpoint — never hardcoded.</p><div id="comm-preview"><p class="muted">Loading preview…</p></div></div>'
    + '<div class="card"><h2>Repeat-agency threshold</h2><div id="threshold-box"><p class="muted">Loading…</p></div></div>'
    + '<div class="card"><h2>Pause &amp; visibility</h2><div id="set-msg"></div>'
    + '<label class="checkbox-row"><input type="checkbox" id="pause-toggle"> <span>Pause my profile — stop new matches and submissions while paused.</span></label>'
    + '<label class="checkbox-row"><input type="checkbox" id="vis-toggle" checked> <span>Visible to the agency for matching.</span></label>'
    + '<p><button class="btn" id="save-settings" type="button">Save settings</button></p></div>';
  apiGet("/api/v1/commission-settings").then(function(d){
    var el = $("#comm-box"); if(!el) return;
    var s = d.settings||d;
    el.innerHTML = '<p>'+esc(s.description||s.terms||"Commission is 10–15% only when you book. The exact scale is set by the agency.")+'</p>'
      + (s.scale?'<p>'+esc(typeof s.scale==="string"?s.scale:JSON.stringify(s.scale))+'</p>':"");
  }).catch(function(){ var el=$("#comm-box"); if(el) el.innerHTML = '<p>Commission is 10–15% only when you book. Full terms are in <a href="#/compliance">Compliance</a>.</p>'; });
  apiGet("/api/v1/commission/calculate?gross=550&type=daily").then(function(d){
    var el = $("#comm-preview"); if(!el) return;
    var c = d.calculation||d;
    el.innerHTML = '<table><tbody><tr><td>Gross ($550/day)</td><td><strong>'+money(c.grossCents ?? Math.round((c.gross||550)*100))+'</strong></td></tr>'
      + '<tr><td>Fee ('+esc(c.rate ?? c.fee_percent ?? c.percent ?? "—")+'%)</td><td><strong>'+money(c.feeCents ?? c.fee_cents)+'</strong></td></tr>'
      + '<tr><td>Net to you</td><td><strong class="gold">'+money(c.netCents ?? c.net_cents)+'</strong></td></tr></tbody></table>';
  }).catch(function(){ var el=$("#comm-preview"); if(el) el.innerHTML = '<p class="muted">Preview unavailable — the commission calculator could not be reached.</p>'; });
  apiGet("/api/v1/settings").then(function(d){
    var s = d.settings||d||{};
    var th = s.repeatAgencyThreshold ?? s.repeat_agency_threshold ?? 3;
    var tp = s.repeatAgencyTopPercent ?? s.repeat_agency_top_percent ?? 10;
    var el = $("#threshold-box"); if(!el) return;
    el.innerHTML = '<p>An agency is flagged as a <strong>repeat agency</strong> at <strong>'+esc(th)+' confirmed bookings</strong> (or more), or in the <strong>top '+esc(tp)+'% by booking volume</strong>.</p>'
      + (isAdmin()
          ? '<label>Repeat-agency threshold (admin)<input id="threshold-input" type="number" min="1" value="'+esc(th)+'"></label><p><button class="btn btn-ghost btn-sm" id="threshold-save" type="button">Save threshold</button></p><div id="threshold-msg"></div>'
          : '<p class="muted small">Admins can change this threshold. Sign in with the admin token on the Agency page to edit it.</p>');
    var save = $("#threshold-save");
    if(save) save.addEventListener("click", function(){
      var v = parseInt($("#threshold-input").value,10);
      api("/api/v1/settings", {method:"POST", body:{repeatAgencyThreshold:v}})
        .then(function(){ $("#threshold-msg").innerHTML = okBox("Threshold saved."); })
        .catch(function(err){ $("#threshold-msg").innerHTML = errBox(err.message); });
    });
  }).catch(function(){ var el=$("#threshold-box"); if(el) el.innerHTML = '<p class="muted">Threshold unavailable — the backend could not be reached. Default is 3 confirmed bookings.</p>'; });
  apiGet("/api/v1/talent/"+encodeURIComponent(id)).then(function(d){
    var t = normTalent(d.talent||d||{});
    var pt = $("#pause-toggle"); if(pt) pt.checked = t.paused === true;
    var vt = $("#vis-toggle"); if(vt) vt.checked = t.visibility !== "private";
  }).catch(function(){});
  $("#save-settings").addEventListener("click", function(){
    api("/api/v1/talent/"+encodeURIComponent(id), {method:"PATCH", body:toApiProfile({paused:$("#pause-toggle").checked, visibility:$("#vis-toggle").checked?"public":"private"})})
      .then(function(){ $("#set-msg").innerHTML = okBox("Settings saved."); })
      .catch(function(err){ $("#set-msg").innerHTML = errBox(err.message); });
  });
}

function screenCompliance(app){
  app.innerHTML = '<h1 style="color:var(--gold)">Compliance</h1>'
    + '<div class="card"><h2>Commission terms</h2><p>Commission is 10–15% and applies only when you book. No upfront fees. No fee is ever collected before a booking is confirmed and paid.</p><div id="comp-comm"><p class="muted">Loading terms…</p></div></div>'
    + '<div class="card"><h2>Florida research</h2><p class="notice-box">Florida talent-agency requirements research is pending. Before charging commissions, representing talent, or entering agency agreements, applicable Florida and other state talent-agency, employment-agency, labor, contract, and fee requirements must be researched and satisfied.</p></div>'
    + '<div class="card"><h2>Email status</h2><p><strong>QUEUED</strong> — email integration is not connected. Notifications are delivered in-app; email shows as queued and is never claimed as sent.</p></div>'
    + '<div class="card"><h2>Ledger</h2><p>Every event on this platform is recorded in an append-only, hash-chained ledger. <a href="#/ledger">Open the Ledger view</a>.</p></div>';
  apiGet("/api/v1/commission-settings").then(function(d){
    var el = $("#comp-comm"); if(!el) return;
    var s = d.settings||d;
    el.innerHTML = '<p>'+esc(s.description||s.terms||"")+'</p>';
  }).catch(function(){});
}

/* ---------- (10) agency / ledger / contacts ---------- */
function repeatBadge(a, threshold){
  var n = a.bookingsConfirmed ?? a.bookings_confirmed ?? a.bookings ?? 0;
  if(n >= threshold) return '<span class="badge badge-verified">TOP REPEAT AGENCY · '+esc(n)+' BOOKINGS</span>';
  return "";
}
function spikeBadge(a){
  if(a.spike) return '<span class="badge badge-expired">SPIKE — bookings rising fast</span>';
  return "";
}
function agencyCard(a, threshold, rank){
  var n = a.bookingsConfirmed ?? a.bookings_confirmed ?? a.bookings ?? 0;
  var gross = a.totalGrossCents ?? a.total_gross_cents ?? null;
  var comm = a.totalCommissionCents ?? a.total_commission_cents ?? null;
  return '<div class="card card-lift"><div class="agency-row"><span class="rank-num">#'+rank+'</span><div class="grow">'
    + '<h3 style="margin-top:0"><a href="#/agency/'+encodeURIComponent(a.id)+'">'+esc(a.name||"Agency")+'</a></h3>'
    + '<p>'+repeatBadge(a, threshold)+' '+spikeBadge(a)+'</p>'
    + '<p class="meta">Jobs posted: <strong>'+esc(a.jobsPosted ?? a.jobs_posted ?? 0)+'</strong> · Applications sent: <strong>'+esc(a.applicationsSent ?? a.applications_sent ?? 0)+'</strong> · Bookings confirmed: <strong>'+esc(n)+'</strong></p>'
    + '<p class="meta">Total gross: <strong>'+(gross!==null?money(gross):"—")+'</strong> · Commission tracked: <strong>'+(comm!==null?money(comm):"—")+'</strong></p>'
    + '<p class="muted small">First booking: '+esc(a.firstBookingAt?fmtDate(a.firstBookingAt):"—")+' · Last booking: '+esc(a.lastBookingAt?fmtDate(a.lastBookingAt):"—")+'</p>'
    + '<p><a class="btn btn-ghost btn-sm" href="#/agency/'+encodeURIComponent(a.id)+'">View full history</a></p>'
    + '</div></div></div>';
}
function renderTopRepeatWidget(el, agencies){
  if(!el) return;
  if(!apiBase()){ el.innerHTML = emptyBox("Agency board loads from the live backend once it is connected."); return; }
  if(!agencies.length){ el.innerHTML = emptyBox("No agencies with bookings yet. Repeat agencies will be highlighted here once bookings land."); return; }
  apiGet("/api/v1/settings").then(function(d){
    var s = d.settings||d||{};
    var th = s.repeatAgencyThreshold ?? s.repeat_agency_threshold ?? 3;
    var sorted = agencies.slice().sort(function(x,y){ return (y.bookingsConfirmed??y.bookings??0)-(x.bookingsConfirmed??x.bookings??0); });
    var top = sorted.slice(0,3);
    el.innerHTML = top.map(function(a,i){ return agencyCard(a, th, i+1); }).join("");
  }).catch(function(){
    var sorted = agencies.slice().sort(function(x,y){ return (y.bookingsConfirmed??y.bookings??0)-(x.bookingsConfirmed??x.bookings??0); });
    el.innerHTML = sorted.slice(0,3).map(function(a,i){ return agencyCard(a, 3, i+1); }).join("");
  });
}
function screenAgency(app){
  app.innerHTML = '<h1 style="color:var(--gold)">Agency Network</h1>'
    + '<p class="muted">Monitoring and highlighting only. No submissions, no contacts, no payments from this view.</p>'
    + '<div class="card"><h2>Top Repeat Agencies</h2><p class="muted">Ranked by booking volume. Agencies at or above the repeat threshold are flagged; spikes are flagged too. One click opens the full history.</p><div id="agency-board">'+loadingBox("Loading agencies…")+'</div></div>'
    + '<div class="card"><h2>Production intel</h2><div id="prod-intel">'+loadingBox("Loading production intel…")+'</div></div>'
    + '<div class="card"><h2>Staff view</h2><div id="staff-box"></div></div>';
  var loadBoard = function(){
    if(!apiBase()){ $("#agency-board").innerHTML = emptyBox("Agency board loads from the live backend once it is connected."); return; }
    Promise.all([apiGet("/api/v1/agencies"), fetchJsonOrNull("/api/v1/settings")]).then(function(res){
      var list = res[0].agencies||res[0]||[];
      var s = (res[1]&&(res[1].settings||res[1]))||{};
      var th = s.repeatAgencyThreshold ?? s.repeat_agency_threshold ?? 3;
      var el = $("#agency-board"); if(!el) return;
      if(!list.length){ el.innerHTML = emptyBox("No agencies recorded yet."); return; }
      list = list.slice().sort(function(x,y){ return (y.bookingsConfirmed??y.bookings??0)-(x.bookingsConfirmed??x.bookings??0); });
      el.innerHTML = '<p class="muted">Repeat threshold: <strong>'+esc(th)+' confirmed bookings</strong> (see Settings).</p>'
        + list.map(function(a,i){ return agencyCard(a, th, i+1); }).join("");
    }).catch(function(err){ $("#agency-board").innerHTML = errBox(err.message); });
  };
  loadBoard();
  apiGet("/api/v1/production-intel").then(function(d){
    var list = d.intel||d.items||d||[];
    var el = $("#prod-intel"); if(!el) return;
    if(!Array.isArray(list)||!list.length){ el.innerHTML = emptyBox("No production intel recorded yet."); return; }
    el.innerHTML = '<ul>'+list.slice(0,20).map(function(p){
      return '<li><strong>'+esc(p.production||p.title||p.name||"Production")+'</strong> — '+esc(p.note||p.detail||p.location||"")+'</li>';
    }).join("")+'</ul>';
  }).catch(function(){ var el=$("#prod-intel"); if(el) el.innerHTML = emptyBox("Production intel unavailable right now."); });
  var staff = $("#staff-box");
  if(isAdmin()){
    staff.innerHTML = '<p class="muted">Signed in as staff. Talent private data (phone, email, photos) is shown only to the owner admin token — staff lists show names and status only.</p><div id="staff-lists">'+loadingBox("Loading staff lists…")+'</div><p><button class="btn btn-ghost btn-sm" id="admin-logout" type="button">Clear admin token</button></p>';
    $("#admin-logout").addEventListener("click", function(){ try{ localStorage.removeItem("ttt_admin_token"); }catch(e){} route(); });
    Promise.all([fetchJsonOrNull("/api/v1/reviews"), fetchJsonOrNull("/api/v1/cubicles")]).then(function(res){
      var reviews = (res[0]&&(res[0].reviews||res[0]))||[];
      var cubes = (res[1]&&(res[1].cubicles||res[1]))||[];
      var el = $("#staff-lists"); if(!el) return;
      el.innerHTML = '<h3>Review queue</h3>' + (reviews.length ? reviews.map(function(r){
        return '<div class="card"><p><strong>'+esc(r.talent_name||r.talent_id||"Talent")+'</strong> — '+esc(r.status||"pending")+'</p><p><button class="mini-btn" data-review-pass="'+esc(r.talent_id||"")+'">PASS</button> <button class="mini-btn" data-review-fail="'+esc(r.talent_id||"")+'">FAIL</button></p></div>';
      }).join("") : emptyBox("Review queue is empty."))
      + '<h3>Cubicles</h3>' + (cubes.length ? '<ul>'+cubes.map(function(c){ return '<li>'+esc(c.name||c.id)+'</li>'; }).join("")+'</ul>' : emptyBox("No cubicles listed."));
    }).catch(function(){});
  } else {
    staff.innerHTML = '<p>Staff screens need an admin token. It is stored in this browser only (localStorage).</p>'
      + '<form id="admin-form"><label>Admin token<input id="admin-token" type="password" autocomplete="off"></label><p><button class="btn" type="submit">Enter staff view</button></p></form>';
    $("#admin-form").addEventListener("submit", function(e){
      e.preventDefault();
      var v = $("#admin-token").value.trim();
      if(!v) return;
      try{ localStorage.setItem("ttt_admin_token", v); }catch(err){}
      route();
    });
  }
}
function screenAgencyHistory(app, agencyId){
  try{ agencyId = decodeURIComponent(agencyId); }catch(e){}
  app.innerHTML = '<p><a href="#/agency">&larr; Back to Agency Network</a></p><div id="agency-hist">'+loadingBox("Loading agency history…")+'</div>';
  if(!apiBase()){ $("#agency-hist").innerHTML = emptyBox("Agency history loads from the live backend once it is connected."); return; }
  apiGet("/api/v1/agencies/"+encodeURIComponent(agencyId)+"/history").then(function(d){
    var a = d.agency||{};
    var jobs = d.jobs||[], apps = d.applications||[], books = d.bookings||[], pays = d.payments||[];
    var el = $("#agency-hist"); if(!el) return;
    var row = function(x){ return '<tr><td>'+esc(x.title||x.name||x.id||"—")+'</td><td>'+esc(x.status||"")+'</td><td>'+esc(x.date?fmtDate(x.date):(x.created_at?fmtDate(x.created_at):""))+'</td><td>'+(x.gross_cents!==undefined?money(x.gross_cents):(x.amount_cents!==undefined?money(x.amount_cents):""))+'</td></tr>'; };
    var table = function(title, list){
      if(!list.length) return '<h3>'+esc(title)+'</h3>'+emptyBox("None recorded yet.");
      return '<h3>'+esc(title)+' ('+list.length+')</h3><table><thead><tr><th>Item</th><th>Status</th><th>Date</th><th>Amount</th></tr></thead><tbody>'+list.map(row).join("")+'</tbody></table>';
    };
    el.innerHTML = '<div class="card"><h2>'+esc(a.name||"Agency")+'</h2><p class="muted">Full history from the ledger — every job, booking, and payment.</p></div>'
      + '<div class="card">'+table("Jobs", jobs)+'</div>'
      + '<div class="card">'+table("Applications", apps)+'</div>'
      + '<div class="card">'+table("Bookings", books)+'</div>'
      + '<div class="card">'+table("Payments", pays)+'</div>';
  }).catch(function(err){ $("#agency-hist").innerHTML = errBox(err.message); });
}
function screenLedger(app){
  app.innerHTML = '<h1 style="color:var(--gold)">Ledger</h1>'
    + '<p class="muted">Append-only, hash-chained record of everything the agency knows. Corrections are new entries — history is never edited.</p>'
    + '<div class="card"><div class="filters">'
    + '<div><label for="lg-type">Event type</label><select id="lg-type"><option value="">All</option><option>talent_registered</option><option>profile_updated</option><option>consent_signed</option><option>consent_revoked</option><option>review_decision</option><option>match_run</option><option>application_created</option><option>booking_created</option><option>payment_recorded</option><option>notification_sent</option><option>opportunity_ingested</option><option>agency_contact</option></select></div>'
    + '<div><label for="lg-entity">Contact / entity ID</label><input id="lg-entity" placeholder="talent or agency ID"></div>'
    + '<div><label for="lg-from">From</label><input id="lg-from" type="date"></div>'
    + '<div><label for="lg-to">To</label><input id="lg-to" type="date"></div>'
    + '<div><button class="btn" id="lg-apply" type="button">Filter</button></div>'
    + '</div><p><button class="btn btn-ghost" id="lg-verify" type="button">Verify chain</button> <button class="btn btn-ghost" id="lg-export" type="button">Export JSONL</button></p><div id="lg-verify-out"></div></div>'
    + '<div id="lg-list">'+loadingBox("Loading ledger…")+'</div>';
  var load = function(){
    if(!apiBase()){ $("#lg-list").innerHTML = emptyBox("The ledger loads from the live backend once it is connected."); return; }
    var p = new URLSearchParams();
    var t=$("#lg-type").value, e=$("#lg-entity").value.trim(), f=$("#lg-from").value, to=$("#lg-to").value;
    if(t) p.set("event_type", t);
    if(e) p.set("entity_id", e);
    if(f) p.set("from", f);
    if(to) p.set("to", to);
    p.set("limit","100");
    apiGet("/api/v1/ledger?"+p.toString()).then(function(d){
      var events = d.events||d||[];
      var el = $("#lg-list"); if(!el) return;
      if(!events.length){ el.innerHTML = emptyBox("No ledger events match these filters yet."); return; }
      el.innerHTML = '<p class="muted">'+esc(d.total ?? events.length)+' events</p><table><thead><tr><th>Seq</th><th>Time</th><th>Event</th><th>Entity</th><th>Actor</th><th>Hash</th></tr></thead><tbody>'
        + events.map(function(ev){
            return '<tr><td>'+esc(ev.seq)+'</td><td>'+esc(fmtDT(ev.ts))+'</td><td>'+esc(ev.event_type)+'</td><td>'+esc(ev.entity_type||"")+' '+esc(ev.entity_id||"")+'</td><td>'+esc(ev.actor||"")+'</td><td class="mono">'+esc(String(ev.hash||"").slice(0,12))+'</td></tr>';
          }).join("")+'</tbody></table>';
    }).catch(function(err){ $("#lg-list").innerHTML = errBox(err.message); });
  };
  $("#lg-apply").addEventListener("click", load);
  $("#lg-verify").addEventListener("click", function(){
    var out = $("#lg-verify-out");
    out.innerHTML = '<p class="muted">Verifying chain…</p>';
    apiGet("/api/v1/ledger/verify").then(function(d){
      var ok = d.ok !== false && d.valid !== false;
      if(ok) out.innerHTML = okBox("Chain VALID — "+(d.events??"")+" events, head seq "+esc(d.head_seq??"")+", head hash "+String(d.head_hash||"").slice(0,16)+"…");
      else out.innerHTML = errBox("Chain INVALID — first bad seq: "+esc(d.first_bad_seq ?? "unknown")+".");
    }).catch(function(err){ out.innerHTML = errBox(err.message); });
  });
  $("#lg-export").addEventListener("click", function(){
    if(!apiBase()){ $("#lg-verify-out").innerHTML = errBox("Backend not configured yet."); return; }
    var a = document.createElement("a");
    a.href = apiBase() + "/api/v1/ledger/export";
    a.download = "top-tea-talents-ledger.jsonl";
    a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  });
  load();
}
function screenContacts(app){
  app.innerHTML = '<h1 style="color:var(--gold)">Contact Book</h1>'
    + '<p class="muted">Every contact in one place — talents, agencies, employers, casting professionals, and production companies — each linked to their bookings, applications, and history.</p>'
    + '<div class="card"><label for="ct-q">Search contacts</label><input id="ct-q" type="search" placeholder="Name, city, kind…"></div>'
    + '<div id="ct-list">'+loadingBox("Loading contacts…")+'</div>';
  var all = [];
  var render = function(){
    var q = ($("#ct-q").value||"").toLowerCase();
    var list = all.filter(function(c){
      if(!q) return true;
      return ((c.name||"")+" "+(c.kind||"")+" "+(c.city||"")+" "+(c.email||"")).toLowerCase().indexOf(q)>=0;
    });
    var el = $("#ct-list"); if(!el) return;
    if(!list.length){ el.innerHTML = emptyBox(all.length?"No contacts match that search.":"No contacts recorded yet."); return; }
    el.innerHTML = list.map(function(c){
      var hist = c.historyUrl || (c.kind==="agency"||c.kind==="employer" ? "#/agency/"+encodeURIComponent(c.id) : "#/ledger?entity_id="+encodeURIComponent(c.id));
      return '<div class="card card-lift"><h3>'+esc(c.name||"Unnamed")+' <span class="badge badge-blue">'+esc((c.kind||"").toUpperCase())+'</span></h3>'
        + '<p class="meta">'+esc([c.email,c.phone,c.city,c.state].filter(Boolean).join(" · ")||"No contact details on file")+'</p>'
        + '<p>Bookings: <strong>'+esc(c.bookings ?? 0)+'</strong> · Applications: <strong>'+esc(c.applications ?? 0)+'</strong></p>'
        + '<p><a class="btn btn-ghost btn-sm" href="'+esc(hist)+'">View history</a></p></div>';
    }).join("");
  };
  $("#ct-q").addEventListener("input", render);
  if(!apiBase()){ $("#ct-list").innerHTML = emptyBox("Contacts load from the live backend once it is connected."); return; }
  apiGet("/api/v1/contacts").then(function(d){
    all = d.contacts||d||[];
    render();
  }).catch(function(err){ $("#ct-list").innerHTML = errBox(err.message); });
}

/* ---------- (11) photos ---------- */
// Encode ladder for the server's 500KB photo limit: try the largest/best
// first, then step down until the JPEG fits. Android camera photos are
// often 3–12MB, so a single 1200px pass is not enough — the ladder is
// what gets a big phone photo under the cap. The last step is the floor —
// a photo that still does not fit is rejected instead of ever being sent
// over the limit.
function photoEncodeSteps(){
  return [
    { max: 1200, quality: 0.82 },
    { max: 900, quality: 0.70 },
    { max: 700, quality: 0.60 }
  ];
}
var PHOTO_MAX_BYTES = 480 * 1024; // stay under the server's 500KB cap
var PHOTO_HARD_LIMIT = 500 * 1024; // server rejects anything over this
function dataUrlByteSize(dataUrl){
  var b64 = String(dataUrl || "").split(",")[1] || "";
  var pad = (b64.match(/=+$/) || [""])[0].length;
  return Math.floor(b64.length * 3 / 4) - pad;
}
function downscalePhoto(file, cb){
  var t = String(file.type || "").toLowerCase();
  // HEIC/HEIF (iPhone camera-roll photos) are accepted and attempted —
  // Safari decodes them natively. Only fail if the load actually errors.
  // An empty type is also attempted; only genuinely unsupported types
  // are rejected up front, in plain words.
  if(t && ["image/jpeg","image/png","image/webp","image/heic","image/heif"].indexOf(t)<0){
    cb(null, "That photo format can't be used — please choose a JPG or PNG, or on iPhone set Camera > Formats > Most Compatible and take it again.");
    return;
  }
  var img = new Image();
  var url = URL.createObjectURL(file);
  img.onload = function(){
    // Each step is guarded on its own: on a low-memory phone a big
    // canvas draw can throw, so a failed step falls through to the
    // next smaller one instead of failing the whole upload. The last
    // encode that succeeded is kept as a fallback.
    var w = img.naturalWidth, h = img.naturalHeight;
    var steps = photoEncodeSteps(), best = null, i = 0;
    while(i < steps.length){
      try{
        var step = steps[i];
        var scale = Math.min(1, step.max/Math.max(w,h));
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(w*scale); canvas.height = Math.round(h*scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        best = canvas.toDataURL("image/jpeg", step.quality);
        if(dataUrlByteSize(best) <= PHOTO_MAX_BYTES) break;
      }catch(e){ /* step failed (e.g. low memory) — try the smaller step */ }
      i++;
    }
    URL.revokeObjectURL(url);
    if(!best){
      cb(null, "Could not process that photo — please try a smaller photo or a different one.");
      return;
    }
    if(dataUrlByteSize(best) > PHOTO_HARD_LIMIT){
      cb(null, "That photo is still too large even after shrinking — please choose a smaller photo.");
      return;
    }
    cb(best, null);
  };
  img.onerror = function(){ URL.revokeObjectURL(url); cb(null, "That photo couldn't be read — please try a different photo, or on iPhone set Camera > Formats > Most Compatible and take it again."); };
  img.src = url;
}
function uploadPhoto(talentId, slot, file, caption, cb){
  downscalePhoto(file, function(dataUrl, err){
    if(err){ cb(err); return; }
    api("/api/v1/talent/"+encodeURIComponent(talentId)+"/photos", {method:"POST", body:{slot:slot, dataUrl:dataUrl, caption:caption}})
      .then(function(){ cb(null); })
      .catch(function(e){ cb(e.message); });
  });
}

/* ---------- (12) init ---------- */
function closeSidebar(){
  var sb = $("#sidebar"); if(sb) sb.classList.remove("open");
  var nav = $("#topbar-nav"); if(nav) nav.classList.remove("open");
}
function initNav(){
  var t = $("#nav-toggle");
  if(t) t.addEventListener("click", function(){
    var nav = $("#topbar-nav");
    var open = nav.classList.toggle("open");
    t.setAttribute("aria-expanded", open?"true":"false");
    var sb = $("#sidebar"); if(sb) sb.classList.toggle("open", open);
  });
  var c = $("#sidebar-close");
  if(c) c.addEventListener("click", closeSidebar);
  document.querySelectorAll(".nav-group-head").forEach(function(h){
    h.addEventListener("click", function(){
      var g = h.parentElement;
      var closed = g.classList.toggle("closed");
      h.setAttribute("aria-expanded", closed?"false":"true");
    });
  });
  document.querySelectorAll(".sidebar a, .topbar-nav a").forEach(function(a){
    a.addEventListener("click", closeSidebar);
  });
}
document.addEventListener("DOMContentLoaded", function(){
  initNav();
  initSplash();
  renderVersionStamp();
  loadApiConfig().then(function(){ apiBanner(); bindAuthSlot(); checkHealth(); refreshMode(); route(); });
});
window.addEventListener("hashchange", route);
