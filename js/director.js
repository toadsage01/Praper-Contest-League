/* ============================================================================
   PCL — SCREENING ROOM (director.html)
   The Director/CEO's private viewer. Opens on the CURRENT week's
   weekly-challenge uploads; the ALL CONTENTS tab plays the WHOLE season —
   every post, challenge or not, in submission order. Nothing renders until
   the screening passcode unlocks the backend feed (gas/Code.gs →
   directorFeed_, action=directorFeed) — the passcode is the ONLY key
   (CEO_CODE Script Property overrides the built-in default).
   Media: YouTube/Instagram embed when the platform allows one; LinkedIn
   gets the participant's analytics screenshot inline; a POST/SCREENSHOT
   switch covers every in-between case. Read-only, JSONP, zero CORS setup.
   ========================================================================== */
(function () {
  "use strict";

  /* ---------- tiny DOM + safety helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------- theme toggle (same contract as the other portals) ---------- */
  var themeToggle = $("pclThemeToggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-pcl-theme") === "dark"
        ? "light" : "dark";
      document.documentElement.setAttribute("data-pcl-theme", next);
      try { localStorage.setItem("pcl_theme", next); } catch (e) { /* ok */ }
    });
  }

  /* ---------- season clock (mirrors js/app.js + gas/Code.gs) ---------- */
  var SEASON_START_ISO = "2026-10-19T11:00:00+05:30";
  var SEASON_START = new Date(SEASON_START_ISO).getTime();
  var WEEK_TOTAL = 10;
  var CHALLENGES = [
    { name: "Best Original Content",
      crit: "Most original and creative content featuring Praper Media.", pts: 6000 },
    { name: "Best Storytelling Debut",
      crit: "Most engaging storytelling content mentioning Praper Media.", pts: 8000 },
    { name: "A Day in My Life",
      crit: "Give a glimpse into your daily life — routine, fun moments, work highlights.", pts: 8000 },
    { name: "Best Collaboration",
      crit: "Create content with at least one other Praper employee.", pts: 10000 },
    { name: "Behind the Scenes at Praper",
      crit: "Best emerging creator showcasing office culture and daily life.", pts: 6000 },
    { name: "Most Improved Creator",
      crit: "Highest improvement in profile visits, reach, engagement and follower growth during the challenge.", pts: 10000 },
    { name: "Consistency Reward",
      crit: "Publish at least 2 posts per week for seven consecutive weeks.", pts: 12000 },
    { name: "The One-Take Challenge",
      crit: "One continuous take of minimum 30 seconds, without cuts or edits.", pts: 8000 },
    { name: "The Trend Takeover",
      crit: "Give a popular trend or meme your own creative twist.", pts: 8000 },
    { name: "The Comment Magnet — Final Showdown",
      crit: "Create a post that sparks meaningful conversations and invites opinions.", pts: 10000 }
  ];
  function currentWeek() {
    var t = Date.now();
    if (t < SEASON_START) return 1;
    return Math.min(WEEK_TOTAL, Math.floor((t - SEASON_START) / 604800000) + 1);
  }

  /* ---------- JSONP (cache-busted, same pattern as js/app.js) ---------- */
  function jsonp(params) {
    return new Promise(function (resolve, reject) {
      var cb = "dirCb" + Date.now() + "_" + Math.floor(Math.random() * 1e5);
      var s = document.createElement("script");
      var done = false;
      var timer = setTimeout(function () { finish(new Error("timeout")); }, 20000);
      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
        err ? reject(err) : resolve(data);
      }
      window[cb] = function (data) { finish(null, data); };
      s.onerror = function () { finish(new Error("network")); };
      var q = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      }).join("&");
      s.src = window.PCL_GAS_URL + "?" + q + "&_=" + Date.now() + "&callback=" + cb;
      document.head.appendChild(s);
    });
  }

  /* The screening room is deployed with the same GAS URL as the other
     portals — it is inlined here so this page stays dependency-free. */
  window.PCL_GAS_URL =
    "https://script.google.com/macros/s/AKfycbxdY0N312upmv3VgfmG2DiVrlHdGGylv7jUk6Psa42Yp1NJotKURlJOoVpiKtly5iwe/exec";

  /* ---------- state ---------- */
  var state = {
    code: "", idx: 0,
    mode: "challenge",            // "challenge" = weekly tab (default) · "all" = season
    mediaMode: null,              // "post" | "shot" — per-entry, null = auto
    feed: { challenge: [], all: [] },
    picks: {},                    // mediaId → picked? (the Director's wishes)
    pickCount: 0,
    notes: { weeks: {}, season: "" }
  };
  var CODE_KEY = "pcl_dir_code";

  /* ---------- the Director's desk (picks + notes) -------------------------
     Every write is passcode-gated server-side (directorNote action) and
     lands in the Director-Log tab; the feed carries the merged state. */
  function deskNoteFor() {
    return state.mode === "all"
      ? String(state.notes.season || "")
      : String(state.notes.weeks[String(state.week || currentWeek())] || "");
  }
  function entryKey(e) {
    return String((e && (e.mediaId || e.url)) || "");
  }
  function renderDesk() {
    var list = listFor(state.mode);
    var e = list[state.idx];
    var desk = $("dirDesk");
    if (!e || !desk) { if (desk) desk.hidden = true; return; }
    desk.hidden = false;
    var picked = !!state.picks[entryKey(e)];
    var btn = $("dirPick");
    btn.setAttribute("aria-pressed", String(picked));
    btn.classList.toggle("is-on", picked);
    btn.innerHTML = picked ? "&#9733; PICKED" : "&#9734; PICK THIS ENTRY";
    $("dirPickCount").textContent = state.pickCount
      ? state.pickCount + " PICKED THIS SEASON" : "";
    var label = $("dirNoteLabel");
    label.textContent = state.mode === "all"
      ? "NOTES · SEASON"
      : "NOTES · WEEK " + (state.week || currentWeek());
    if (document.activeElement !== $("dirNote")) {
      $("dirNote").value = deskNoteFor();
    }
    $("dirNoteStatus").textContent = "";
  }
  function deskBusy(on) {
    var b = $("dirNoteSave");
    if (b) { b.disabled = on; b.textContent = on ? "SAVING…" : "SAVE NOTE"; }
    var p = $("dirPick");
    if (p) p.disabled = on;
  }
  function deskStatus(msg, isErr) {
    var el = $("dirNoteStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("is-err", !!isErr);
  }
  function sendDeskNote(params) {
    return jsonp(Object.assign({ action: "directorNote", code: state.code },
      params));
  }

  var gate = $("dirGate");
  var theatre = $("dirTheatre");
  var emptyBox = $("dirEmpty");

  function showGateErr(msg) {
    $("dirErr").textContent = msg || "";
  }
  function openTheatre() {
    gate.hidden = true;
    theatre.hidden = false;
  }
  function showEmpty(msg) {
    gate.hidden = true;
    emptyBox.hidden = false;
    $("dirEmptyMsg").textContent = msg;
  }

  /* ---------- embeds + media stage ----------
     Stability contract: a platform embed when the platform allows one
     (YouTube, Instagram), the participant's own analytics screenshot
     otherwise (LinkedIn blocks in-page playback entirely) — and a
     POST / SCREENSHOT switch whenever both are available, so a blank
     embed (IG rate-limits, private posts) never strands the viewer. */
  function ytId(url) {
    var m = String(url || "").match(
      /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : "";
  }
  function igParts(url) {
    var m = String(url || "").match(
      /instagram\.com\/(reel|reels|p|tv)\/([\w-]+)/);
    if (!m) return null;
    return { kind: m[1] === "p" || m[1] === "tv" ? "p" : "reel", id: m[2] };
  }
  /* Drive file id out of any share-link shape — the upload folder is
     shared any-one-with-link, so thumbnail URLs render inline. */
  function driveId(u) {
    var s = String(u || "");
    var m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/) ||
            s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    return m ? m[1] : "";
  }
  function shotSrc(e) {
    var id = driveId(e.screenshot);
    return id ? "https://drive.google.com/thumbnail?id=" +
      encodeURIComponent(id) + "&sz=w2000" : "";
  }
  function mediaCaps(e) {
    var yt = ytId(e.url);
    var ig = yt ? null : igParts(e.url);
    var canPost = !!(yt || ig);
    var canShot = !!shotSrc(e);
    return { yt: yt, ig: ig, canPost: canPost, canShot: canShot,
      def: canPost ? "post" : (canShot ? "shot" : "none") };
  }
  function stageHtml(e, mode) {
    var caps = mediaCaps(e);
    if (mode === "post" && caps.yt) {
      return '<iframe src="https://www.youtube-nocookie.com/embed/' + esc(caps.yt) +
        '" title="League entry" allow="accelerometer; autoplay; ' +
        'clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
        'allowfullscreen loading="lazy"></iframe>';
    }
    if (mode === "post" && caps.ig) {
      return '<iframe src="https://www.instagram.com/' + caps.ig.kind + "/" +
        esc(caps.ig.id) + '/embed" title="League entry" ' +
        'scrolling="no" loading="lazy"></iframe>';
    }
    if (mode === "shot" && caps.canShot) {
      var sub = String(e.platform || "").toLowerCase().indexOf("linkedin") === 0
        ? '<span class="dir-shot-sub">LinkedIn does not allow in-page playback ' +
          "— showing the participant's analytics screenshot.</span>"
        : "";
      return '<img class="dir-shot" src="' + esc(shotSrc(e)) +
        '" alt="Analytics screenshot" />' + sub;
    }
    /* no embeddable player and no screenshot — a calm link card */
    var word = String(e.platform || "LINK").toUpperCase();
    return '<div class="dir-fallback">' +
      '<span class="dir-fallback-word">' + esc(word) + "</span>" +
      '<span class="dir-fallback-sub">This platform does not allow in-page ' +
      "playback. Open the original post below — it opens in a new tab.</span>" +
      "</div>";
  }

  /* Only real web addresses become links — the feed is built from ledger
     rows, and a hostile direct-API write must never render a javascript:
     href inside the CEO's room. Non-http(s) values degrade to "#". */
  function safeHref(u) {
    var s = String(u || "").trim();
    return /^https?:\/\//i.test(s) ? s : "#";
  }

  /* ---------- render ---------- */
  function listFor(mode) {
    return mode === "all" ? state.feed.all : state.feed.challenge;
  }
  function firstView(e) {
    var v = e.views || [];
    for (var i = 0; i < v.length; i++) {
      if (v[i] !== "" && v[i] != null) return v[i];
    }
    return "";
  }
  function fmtNum(n) {
    var x = Number(String(n).replace(/[^\d.-]/g, ""));
    return isNaN(x) ? String(n) : x.toLocaleString("en-IN");
  }
  function renderBanner() {
    if (state.mode === "all") {
      $("dirWeekTag").textContent = "SEASON 2";
      $("dirWeekName").textContent = "ALL CONTENTS";
      $("dirLiveTag").textContent = "SEASON";
      return;
    }
    var w = state.week || currentWeek();
    var ch = CHALLENGES[w - 1] || { name: "" };
    $("dirWeekTag").textContent = "WEEK " + w;
    $("dirWeekName").textContent = ch.name.toUpperCase();
    $("dirLiveTag").textContent = w === currentWeek() ? "LIVE" : "ARCHIVE";
  }
  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?").charAt(0) + (parts[1] ? parts[1].charAt(0) : ""))
      .toUpperCase();
  }
  /* the initials sit UNDER the photo — a failed Drive image just hides
     itself and the disc degrades to the same look as a no-photo player */
  function discHtml(name, photo) {
    var pid = driveId(photo);
    return '<span class="dir-disc">' +
      '<span class="dir-initials" aria-hidden="true">' + esc(initials(name)) + "</span>" +
      (pid ? '<img class="dir-pfp" src="https://drive.google.com/thumbnail?id=' +
        encodeURIComponent(pid) + '&sz=w120" alt="" loading="lazy" />' : "") +
      "</span>";
  }
  function renderEntry() {           // full re-render — media mode resets
    state.mediaMode = null;
    renderStage();
  }
  function renderStage() {           // stage-only (the POST/SHOT switch)
    var list = listFor(state.mode);
    var e = list[state.idx];
    var stage = $("dirStage");
    var sw = $("dirMediaSwitch");
    if (!e) { renderEmptyMode(); return; }
    var caps = mediaCaps(e);
    if (state.mediaMode !== "post" && state.mediaMode !== "shot") {
      state.mediaMode = caps.def;
    }
    if (state.mediaMode === "post" && !caps.canPost) {
      state.mediaMode = caps.canShot ? "shot" : "none";
    }
    if (state.mediaMode === "shot" && !caps.canShot) {
      state.mediaMode = caps.canPost ? "post" : "none";
    }
    stage.className = "dir-stage" +
      (state.mediaMode === "post" && caps.ig ? " dir-stage--ig" : "") +
      (state.mediaMode === "shot" ? " dir-stage--shot" : "");
    stage.innerHTML = stageHtml(e, state.mediaMode);

    if (caps.canPost && caps.canShot) {
      sw.hidden = false;
      $("dirSwPost").classList.toggle("is-on", state.mediaMode === "post");
      $("dirSwShot").classList.toggle("is-on", state.mediaMode === "shot");
    } else {
      sw.hidden = true;
    }

    var who = "";
    e.names.forEach(function (nm, i) {
      var role = (e.designations && e.designations[i]) || "";
      var photo = (e.photos && e.photos[i]) || "";
      who += '<div class="dir-chip">' + discHtml(nm, photo) +
        '<span class="dir-chip-id">' +
          '<span class="dir-chip-name">' + esc(nm) + "</span>" +
          (role ? '<span class="dir-chip-role">' + esc(role) + "</span>" : "") +
        "</span></div>";
    });
    var views = firstView(e);
    var roleLine = "entry " + (state.idx + 1) + " of " + list.length;
    if (state.mode === "all" && e.weekNum) {
      roleLine = "WEEK " + e.weekNum + " · " + roleLine;
    }
    if (views !== "" && views != null) {
      roleLine += " · " + fmtNum(views) + " views";
    }
    who += '<div class="dir-chip dir-chip--plat">' +
      '<span class="dir-chip-id">' +
        '<span class="dir-chip-name">' + esc(String(e.platform || "").toUpperCase() +
          (e.format ? " · " + String(e.format).toUpperCase() : "")) + "</span>" +
        '<span class="dir-chip-role">' + esc(roleLine) + "</span>" +
      "</span></div>";
    $("dirWho").innerHTML = who;

    var acts = "";
    if (e.url) {
      acts += '<a class="dir-act" href="' + esc(safeHref(e.url)) +
        '" target="_blank" rel="noopener">OPEN ORIGINAL POST &#8599;</a>';
    }
    if (e.screenshot) {
      acts += '<a class="dir-act" href="' + esc(safeHref(e.screenshot)) +
        '" target="_blank" rel="noopener">ANALYTICS SHOT &#8599;</a>';
    }
    $("dirActions").innerHTML = acts;

    $("dirCount").textContent =
      "ENTRY " + (state.idx + 1) + " / " + list.length;

    var dots = "";
    list.forEach(function (_, i) {
      dots += '<button type="button" class="dir-dot' + (i === state.idx ? " is-on" : "") +
        '" data-i="' + i + '" aria-label="Entry ' + (i + 1) + '"></button>';
    });
    $("dirDots").innerHTML = dots;
    $("dirPrev").disabled = state.idx === 0;
    $("dirNext").disabled = state.idx === list.length - 1;
    renderDesk();
  }
  function renderEmptyMode() {       // this tab has nothing — the other may
    var stage = $("dirStage");
    stage.className = "dir-stage";
    $("dirMediaSwitch").hidden = true;
    var msg = state.mode === "challenge"
      ? "No weekly-challenge entries for Week " + (state.week || currentWeek()) +
        " yet — use the week strip above to screen another week."
      : "No submissions this season yet.";
    var alt = state.mode === "challenge" && state.feed.all.length
      ? '<button type="button" class="dir-act" id="dirSeeAll">SEE ALL CONTENTS &#8599;</button>'
      : "";
    stage.innerHTML = '<div class="dir-fallback">' +
      '<span class="dir-fallback-word">NOTHING HERE YET</span>' +
      '<span class="dir-fallback-sub">' + esc(msg) + "</span>" + alt + "</div>";
    $("dirWho").innerHTML = "";
    $("dirActions").innerHTML = "";
    $("dirCount").textContent = "ENTRY 0 / 0";
    $("dirDots").innerHTML = "";
    $("dirPrev").disabled = true;
    $("dirNext").disabled = true;
    var desk = $("dirDesk");
    if (desk) desk.hidden = true;
    var sa = $("dirSeeAll");
    if (sa) sa.addEventListener("click", function () { setMode("all"); });
  }
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    state.idx = 0;
    $("dirTabWk").classList.toggle("is-on", mode === "challenge");
    $("dirTabAll").classList.toggle("is-on", mode === "all");
    $("dirTabWk").setAttribute("aria-selected", mode === "challenge");
    $("dirTabAll").setAttribute("aria-selected", mode === "all");
    renderBanner();
    renderEntry();
  }
  function go(delta) {
    var list = listFor(state.mode);
    var n = state.idx + delta;
    if (n < 0 || n >= list.length) return;
    state.idx = n;
    renderEntry();
  }

  /* ---------- feed load ----------
     ROUND 35 — the room browses ANY week (?week=N, default = the live
     week); the weekCounts block feeds the week strip so the Director can
     see at a glance which weeks hold challenge entries. */
  function loadFeed(code, week) {
    showGateErr("Checking…");
    var params = { action: "directorFeed", code: code };
    if (week >= 1 && week <= WEEK_TOTAL) params.week = week;
    return jsonp(params)
      .then(function (res) {
        if (!res || !res.ok) {
          try { localStorage.removeItem(CODE_KEY); } catch (e) { /* ok */ }
          state.code = "";
          showGateErr((res && res.error) || "Access denied.");
          return;
        }
        state.code = code;
        state.week = Number(res.week) || currentWeek();
        state.liveWeek = Number(res.liveWeek) || currentWeek();
        state.weekCounts = (res.weekCounts && typeof res.weekCounts === "object")
          ? res.weekCounts : { challenge: {}, all: {} };
        state.feed = {
          challenge: Array.isArray(res.entries) ? res.entries : [],
          all: Array.isArray(res.regular) ? res.regular : []
        };
        /* the Director's own marks — picks + latest note per scope */
        state.picks = {};
        (Array.isArray(res.picks) ? res.picks : []).forEach(function (mid) {
          if (mid) state.picks[String(mid)] = true;
        });
        state.pickCount = state.picks ? Object.keys(state.picks).length : 0;
        state.notes = {
          weeks: (res.noteWeeks && typeof res.noteWeeks === "object")
            ? res.noteWeeks : {},
          season: String(res.noteSeason || "")
        };
        renderWeeks();
        if (!state.feed.challenge.length && !state.feed.all.length) {
          showEmpty("No submissions for Week " + res.week +
            " yet — pick another week from the strip, or the ALL CONTENTS " +
            "tab plays every submission of the season.");
          return;
        }
        renderBanner();
        state.idx = 0;
        renderEntry();
        openTheatre();
      })
      .catch(function (err) {
        showGateErr(err && err.message === "timeout"
          ? "The league server took too long to answer — try again."
          : "Could not reach the league server — check the connection.");
      });
  }

  /* ---------- week strip ----------
     W1..W10 chips, each with that week's CHALLENGE-entry count (the
     weekly tab's content). Clicking re-pulls the feed for that week. */
  function renderWeeks() {
    var nav = $("dirWeeks");
    if (!nav) return;
    nav.hidden = false;
    var counts = (state.weekCounts && state.weekCounts.challenge) || {};
    var html = "";
    for (var w = 1; w <= WEEK_TOTAL; w++) {
      if (w > (state.liveWeek || currentWeek())) break;   // future weeks don't exist yet
      var n = Number(counts[String(w)]) || 0;
      html += '<button type="button" class="dir-wchip' +
        (w === state.week ? " is-on" : "") +
        (!n ? " is-empty" : "") + '" data-week="' + w + '"' +
        ' title="Week ' + w + ' — ' +
        esc((CHALLENGES[w - 1] || {}).name || "") + '">W' + w +
        '<span class="dir-wchip-n">' + n + "</span></button>";
    }
    nav.innerHTML = html;
  }

  /* ---------- gate wiring ---------- */
  $("dirGateForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var code = String($("dirCode").value || "").trim();
    if (!code) { showGateErr("Enter the screening passcode."); return; }
    if ($("dirRemember").checked) {
      try { localStorage.setItem(CODE_KEY, code); } catch (e) { /* ok */ }
    } else {
      try { localStorage.removeItem(CODE_KEY); } catch (e) { /* ok */ }
    }
    $("dirUnlock").disabled = true;
    loadFeed(code).then(function () { $("dirUnlock").disabled = false; });
  });

  /* auto-unlock with a remembered passcode */
  (function tryRemembered() {
    var saved = "";
    try { saved = String(localStorage.getItem(CODE_KEY) || ""); } catch (e) { /* ok */ }
    if (saved) {
      $("dirCode").value = saved;
      loadFeed(saved);
    }
  })();

  /* ---------- nav + tab + media wiring ---------- */
  $("dirPrev").addEventListener("click", function () { go(-1); });
  $("dirNext").addEventListener("click", function () { go(1); });
  $("dirDots").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-i]");
    if (!b) return;
    state.idx = Number(b.getAttribute("data-i")) || 0;
    renderEntry();
  });
  $("dirTabWk").addEventListener("click", function () { setMode("challenge"); });
  $("dirTabAll").addEventListener("click", function () { setMode("all"); });
  /* week strip — screen another week (re-pulls that week's feed) */
  $("dirWeeks").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-week]");
    if (!b || !state.code) return;
    var w = Number(b.getAttribute("data-week"));
    if (!w || w === state.week) return;
    state.week = w;
    renderWeeks();
    var list = listFor(state.mode);
    if (state.mode === "challenge" && list.length) {
      // optimistic clear — the fresh feed re-renders when it lands
      state.idx = 0;
      renderEntry();
    }
    loadFeed(state.code, w).then(function () {
      if (theatre.hidden) return;          // empty week → showEmpty already
      state.idx = 0;
      renderEntry();
    });
  });
  $("dirSwPost").addEventListener("click", function () {
    if (state.mediaMode !== "post") { state.mediaMode = "post"; renderStage(); }
  });
  $("dirSwShot").addEventListener("click", function () {
    if (state.mediaMode !== "shot") { state.mediaMode = "shot"; renderStage(); }
  });

  /* ---------- the Director's desk wiring ---------- */
  $("dirPick").addEventListener("click", function () {
    var list = listFor(state.mode);
    var e = list[state.idx];
    if (!e || !state.code) return;
    var key = entryKey(e);
    if (!key) return;
    var nowPicked = !state.picks[key];
    deskBusy(true);
    deskStatus("");
    sendDeskNote({ type: nowPicked ? "pick" : "unpick", target: key })
      .then(function (res) {
        deskBusy(false);
        if (res && res.ok) {
          if (nowPicked) state.picks[key] = true;
          else delete state.picks[key];
          state.pickCount = Object.keys(state.picks).length;
          renderDesk();
          deskStatus(nowPicked ? "PICKED — saved." : "Unpicked — saved.");
        } else {
          deskStatus((res && res.error) || "Could not save — try again.", true);
        }
      })
      .catch(function () {
        deskBusy(false);
        deskStatus("Could not reach the league server — try again.", true);
      });
  });
  $("dirNoteSave").addEventListener("click", function () {
    if (!state.code) return;
    var txt = String($("dirNote").value || "").trim();
    var isSeason = state.mode === "all";
    deskBusy(true);
    deskStatus("");
    var params = isSeason
      ? { type: "note", scope: "season", text: txt }
      : { type: "note", scope: "week", week: state.week || currentWeek(), text: txt };
    sendDeskNote(params)
      .then(function (res) {
        deskBusy(false);
        if (res && res.ok) {
          if (isSeason) state.notes.season = txt;
          else state.notes.weeks[String(state.week || currentWeek())] = txt;
          deskStatus("Saved.");
        } else {
          deskStatus((res && res.error) || "Could not save — try again.", true);
        }
      })
      .catch(function () {
        deskBusy(false);
        deskStatus("Could not reach the league server — try again.", true);
      });
  });
  /* a photo Drive refuses to serve (permissions revoked, deep-link change)
     hides itself — the initials disc underneath takes over seamlessly */
  $("dirWho").addEventListener("error", function (ev) {
    if (ev.target && ev.target.tagName === "IMG") {
      ev.target.classList.add("is-broken");
    }
  }, true);
  /* if the screenshot itself fails to load, fall back to the calm link
     card instead of a broken-image icon in the CEO's theatre */
  $("dirStage").addEventListener("error", function (ev) {
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains("dir-shot")) return;
    var stage = $("dirStage");
    stage.classList.remove("dir-stage--shot");
    state.mediaMode = "none";
    stage.innerHTML = stageHtml(listFor(state.mode)[state.idx] || {}, "none");
  }, true);
  /* clicking the screenshot stage opens the full-res shot in a new tab */
  $("dirStage").addEventListener("click", function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains("dir-shot")) return;
    var e = listFor(state.mode)[state.idx];
    if (e && e.screenshot) window.open(safeHref(e.screenshot), "_blank", "noopener");
  });
  document.addEventListener("keydown", function (ev) {
    if (theatre.hidden) return;
    if (ev.key === "ArrowLeft") go(-1);
    if (ev.key === "ArrowRight") go(1);
  });
})();
