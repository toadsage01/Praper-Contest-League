/* ============================================================================
   PCL LEADERBOARD — public standings engine (leaderboard.html)
   ----------------------------------------------------------------------------
   Reads the SAME public stats endpoint as the form page
   (window.PCL_CONFIG.gasWebAppUrl, default ?action=stats) over JSONP, so
   static hosting needs zero CORS configuration — identical transport to
   the admin console.

   Renders five columns only: RANK · NAME · DESIGNATION · TOTAL IMPRESSIONS ·
   TOTAL POINTS. When the backend reports season weeks (gas/Code.gs
   `weeks` block), week chips appear: ALL-SEASON + Week 1..10, with the
   live week marked and future weeks locked. Older deployments (no weeks
   block) simply show the ALL-SEASON board — no error, nothing missing.

   Number sources, deduped server-side (latest snapshot per Media ID wins):
     points      = verified points where filled, else projected points
     impressions = verified count  where filled, else claimed count

   ?mock=1 → full offline demo: built-in players, fake endpoint, no network.
   ============================================================================ */
(function () {
  "use strict";

  var cfg = window.PCL_CONFIG || {};
  var MOCK = /(^|[?&])mock=1(&|$)/.test(location.search);

  /* ---------- tiny helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(n) {
    if (n == null || n === "") return "—";
    var x = Number(n);
    if (!isFinite(x) && typeof n === "string") {
      x = Number(n.replace(/[ ,\u00A0\u202F]/g, ""));
    }
    if (!isFinite(x)) return "0";      // never print NaN / Infinity
    return x.toLocaleString("en-IN");
  }
  /* STRICT number coercion — the board must never render a raw string as a
     view count (an older backend once let sheet strings leak through).
     · number            → kept when finite, else 0
     · "12,345" / " 99 " → commas + whitespace stripped, then Number
     · anything else     → null (the column prints "—" for a genuinely
       absent number; points fall back to 0) */
  function toNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (typeof v === "string" && v.trim() !== "") {
      var n = Number(v.replace(/[ ,\u00A0\u202F]/g, ""));
      return isFinite(n) ? n : 0;
    }
    return null;
  }
  function fmtIST(iso) {
    try {
      return new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata"
      });
    } catch (e) { return ""; }
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /* ---------- reading-font toggle (SF Pro default ⇄ OG arcade) ---------- */
  var fontBtn = $("pclFontToggle");
  if (fontBtn) {
    fontBtn.setAttribute("title", "Toggle OG arcade font");
    fontBtn.setAttribute("aria-label", "Toggle OG arcade font");
    fontBtn.setAttribute("aria-pressed",
      String(document.documentElement.getAttribute("data-pcl-font") === "og"));
    fontBtn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-pcl-font") === "og"
        ? "sf" : "og";
      document.documentElement.setAttribute("data-pcl-font", next);
      fontBtn.setAttribute("aria-pressed", String(next === "og"));
      try { localStorage.setItem("pcl_font", next); } catch (e) { /* ok */ }
    });
  }

  /* ---------- theme toggle (same behaviour as the form page) ---------- */
  var toggleBtn = $("pclThemeToggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-pcl-theme") === "dark"
        ? "light" : "dark";
      document.documentElement.setAttribute("data-pcl-theme", next);
      try { localStorage.setItem("pcl_theme", next); } catch (e) { /* ok */ }
    });
  }

  /* ---------- state ---------- */
  var state = {
    data: null,        // normalized response
    view: "all",       // 'all' | 1..10
    syncing: false
  };

  /* ---------- transport: JSONP (cross-origin, zero config) ---------- */
  var jsonpSeq = 0;
  function jsonp(params, cb) {
    var name = "pclBoardCb" + (++jsonpSeq) + "_" + Date.now();
    var s = document.createElement("script");
    var timer = setTimeout(function () {
      cleanup();
      cb(new Error("timeout"));
    }, 60000);
    function cleanup() {
      clearTimeout(timer);
      delete window[name];
      if (s.parentNode) s.parentNode.removeChild(s);
    }
    window[name] = function (data) {
      cleanup();
      cb(null, data);
    };
    params.callback = name;
    params._ = Date.now();   // cache-buster — /exec GETs are CDN-cached
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    }).join("&");
    s.src = cfg.gasWebAppUrl + "?" + qs;
    document.head.appendChild(s);
  }

  /* ============================================================================
     MOCK MODE — offline demo with the exact new response shape
     ========================================================================== */
  function mockData() {
    var players = [
      { player: "Jatin Gulati", designation: "COO", posts: 6, uniqueMedia: 6,
        impressions: 148326, points: 148326,
        projectedPoints: 148326, verifiedPoints: 148326 },
      { player: "Ashutosh", designation: "CBO", posts: 5, uniqueMedia: 5,
        impressions: 121845, points: 121845,
        projectedPoints: 121845, verifiedPoints: 0 },
      { player: "Lagan Garg", designation: "Backend Developer", posts: 4, uniqueMedia: 4,
        impressions: 96402, points: 96402,
        projectedPoints: 96402, verifiedPoints: 30500 },
      { player: "Sehaj", designation: "", posts: 3, uniqueMedia: 3,
        impressions: 64310, points: 64310,
        projectedPoints: 64310, verifiedPoints: 0 },
      { player: "Manas Ranjan", designation: "Frontend Developer", posts: 3, uniqueMedia: 3,
        impressions: 51987, points: 51987,
        projectedPoints: 51987, verifiedPoints: 51987 },
      { player: "Priya Sharma", designation: "", posts: 2, uniqueMedia: 2,
        impressions: 31255, points: 31255,
        projectedPoints: 31255, verifiedPoints: 0 }
    ];
    var weeks = {
      seasonStart: "2026-10-19T11:00:00+05:30",
      total: 10,
      current: 1,
      byWeek: {
        "1": [
          { player: "Jatin Gulati", designation: "COO", posts: 2, impressions: 51320, points: 51320 },
          { player: "Ashutosh", designation: "CBO", posts: 2, impressions: 44870, points: 44870 },
          { player: "Manas Ranjan", designation: "Frontend Developer", posts: 1, impressions: 18437, points: 18437 },
          { player: "Sehaj", designation: "", posts: 1, impressions: 12004, points: 12004 }
        ],
        "2": [
          { player: "Lagan Garg", designation: "Backend Developer", posts: 2, impressions: 30500, points: 30500 },
          { player: "Priya Sharma", designation: "", posts: 1, impressions: 12755, points: 12755 }
        ]
      }
    };
    return { ok: true, totalPosts: 23, uniqueMedia: 23, players: players,
             weeks: weeks, generatedAt: new Date().toISOString() };
  }

  /* ---------- normalize (tolerates the OLD stats shape) ---------- */
  function normalize(data) {
    if (!data || data.ok !== true || !Array.isArray(data.players)) {
      throw new Error("bad response");
    }
    var players = data.players.map(function (p) {
      var impressions = toNum(p.impressions);
      var points = toNum(p.points);
      if (points === null) {
        points = toNum(p.verifiedPoints);        // older payload shapes
        if (points === null || points <= 0) points = toNum(p.projectedPoints);
        if (points === null) points = 0;
      }
      return {
        name: String(p.player || "").trim(),
        designation: String(p.designation || "").trim(),
        impressions: impressions,
        points: points || 0
      };
    }).filter(function (p) { return p.name; });
    players.sort(function (a, b) {
      return b.points - a.points ||
             (b.impressions || 0) - (a.impressions || 0) ||
             a.name.localeCompare(b.name);
    });
    var weeks = data.weeks && data.weeks.byWeek ? data.weeks : null;
    return {
      players: players,
      weeks: weeks,
      currentWeek: weeks ? (weeks.current || 0) : 0,
      totalPosts: data.totalPosts,
      uniqueMedia: data.uniqueMedia,
      generatedAt: data.generatedAt
    };
  }

  /* ---------- rendering ---------- */
  function viewPlayers() {
    var d = state.data;
    if (!d) return [];
    if (state.view === "all") return d.players;
    var list = (d.weeks && d.weeks.byWeek && d.weeks.byWeek[String(state.view)]) || [];
    return list.map(function (p) {
      return { name: p.player, designation: p.designation,
               impressions: toNum(p.impressions), points: toNum(p.points) || 0 };
    }).sort(function (a, b) {
      return b.points - a.points || (b.impressions || 0) - (a.impressions || 0) ||
             a.name.localeCompare(b.name);
    });
  }

  /* VERIFICATION TICK REMOVED — league policy: verification status NEVER
     appears on the leaderboard. The tick lives in the form (own-designation
     seal) and the admin portal (Control Room review) ONLY. The public board
     shows rank, name, designation, impressions and points — nothing else. */

  function rowHtml(p, i) {
    var rankCls = i === 0 ? " is-r1" : i === 1 ? " is-r2" : i === 2 ? " is-r3" : "";
    var desig = p.designation
      ? esc(p.designation)
      : '<span class="pcl-desig-blank">—</span>';
    return '<div class="pcl-row' + rankCls + '">' +
      '<div class="pcl-cell pcl-cell--rank"><span class="pcl-rank">' +
        '<span class="pcl-rankchip">' + pad2(i + 1) + '</span></span></div>' +
      '<div class="pcl-cell pcl-cell--name"><span class="pcl-name">' + esc(p.name) + '</span></div>' +
      '<div class="pcl-cell pcl-cell--desig"><span class="pcl-desig">' + desig + '</span></div>' +
      '<div class="pcl-cell pcl-cell--imp"><span class="pcl-num">' + fmt(p.impressions) + '</span></div>' +
      '<div class="pcl-cell pcl-cell--pts"><span class="pcl-num">' + fmt(p.points) + '</span></div>' +
      '</div>';
  }

  function show(which) {
    $("pclLoading").hidden = which !== "loading";
    $("pclEmpty").hidden = which !== "empty";
    $("pclError").hidden = which !== "error";
    var rowsOk = which === "rows";
    $("pclRows").style.display = rowsOk ? "" : "none";
    $("pclLabels").hidden = !rowsOk;
  }

  function render() {
    var list = viewPlayers();
    if (!list.length) {
      show("empty");
      $("pclRows").innerHTML = "";
      return;
    }
    $("pclRows").innerHTML = list.map(rowHtml).join("");
    show("rows");
  }

  /* ---------- season clock + challenge guide (cfg.challenges) ---------- */
  function seasonWeek() {
    var start = Date.parse(cfg.seasonStartIso || "");
    if (!isFinite(start)) return 0;
    var t = Date.now();
    if (t < start) return 1;               // warm-up posts land in Week 1
    return Math.min(cfg.challenges ? cfg.challenges.length : 10,
                    Math.floor((t - start) / 604800000) + 1);
  }
  function weekWindowTxt(w) {
    var start = Date.parse(cfg.seasonStartIso || "");
    if (!isFinite(start)) return "";
    var a = new Date(start + (w - 1) * 604800000);
    var b = new Date(start + w * 604800000);
    var M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function d(x) { return x.getDate() + " " + M[x.getMonth()]; }
    return d(a) + " → " + d(b);
  }

  function buildWeekChips() {
    var d = state.data;
    var nav = $("pclWeeks");
    nav.innerHTML = "";
    if (!d || !d.weeks) return;                 // old backend → ALL-SEASON only
    var cur = d.currentWeek;
    var chs = Array.isArray(cfg.challenges) ? cfg.challenges : [];
    function chip(label, view, cls, title) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pcl-wchip" + (cls ? " " + cls : "");
      b.textContent = label;
      b.dataset.view = String(view);
      if (title) b.title = title;               // hover = that week's challenge
      if (cls !== "is-locked") {
        b.addEventListener("click", function () {
          if (view === "info") { openWeekInfo(); return; }
          state.view = view;
          syncChipStates();
          render();
        });
      }
      nav.appendChild(b);
    }
    /* ROUND 35 — the all-time tab reads "SEASON 2" (counts EVERYTHING:
       weekly-challenge uploads AND regular posts, deduped). The W tabs now
       carry weekly-challenge uploads only. */
    chip("SEASON 2", "all", state.view === "all" ? "is-active" : "",
      "The whole season — challenges + regular posts");
    for (var w = 1; w <= (d.weeks.total || 10); w++) {
      var cls = [];
      if (state.view === w) cls.push("is-active");
      if (w === cur) cls.push("is-live");
      if (w > cur) cls.push("is-locked");
      var ch = chs[w - 1];
      chip("W" + w, w, cls.join(" "),
        ch ? "Week " + w + " · " + ch.name : "");
    }
    /* the ⓘ chip — same size as a W chip, right of W10; opens the guide */
    if (chs.length) {
      chip("\u24D8", "info", "is-info", "All weekly challenges");
    }
  }

  /* ---- the themed modal pop-up — the SAME component the entry form uses
     for its section-4 info button. Overlay + card, so the guide NEVER
     pushes the standings down the page. Esc / backdrop / X all close it. */
  var Modal = (function () {
    var root = $("pclModal");
    var body = $("pclModalBody");
    function open(html) {
      body.innerHTML = html;
      root.hidden = false;
      document.body.style.overflow = "hidden";
      var chip = $("pclWeeks").querySelector(".pcl-wchip.is-info");
      if (chip) chip.classList.add("is-open");
      var btn = root.querySelector(".pcl-lb-close");
      if (btn) btn.focus();
    }
    function close() {
      root.hidden = true;
      document.body.style.overflow = "";
      var chip = $("pclWeeks").querySelector(".pcl-wchip.is-info");
      if (chip) chip.classList.remove("is-open");
    }
    root.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-act='close']")) close();
    });
    document.addEventListener("keydown", function (ev) {
      if (!root.hidden && ev.key === "Escape") close();
    });
    return { open: open, close: close };
  })();

  /* the challenge guide — IDENTICAL content to the form's section-4 info
     pop-up: title + intro + one card per week (name / LIVE-CLOSED tag /
     window / criteria / reward) + the analytics-deadline note. Same shared
     pcl-wkcard styles, so font sizes stay proper and readable. */
  function openWeekInfo() {
    var chs = Array.isArray(cfg.challenges) ? cfg.challenges : [];
    var cur = seasonWeek();
    var html = '<h3 class="pcl-modal-title">WEEKLY CHALLENGES</h3>' +
      '<p class="pcl-modal-sub">Season 2 · 10 weeks · a new challenge every Monday</p>' +
      '<p class="pcl-rb-p">Only the week that is live right now can be entered — ' +
      "the league is on <b>Week " + cur + "</b> until " +
      esc(weekWindowTxt(cur).split(" → ")[1] || weekWindowTxt(cur)) +
      ". Upcoming challenges are listed below so you can plan and shoot ahead.</p>";
    for (var w = 1; w <= chs.length; w++) {
      var c = chs[w - 1];
      var tag = w === cur ? '<span class="pcl-wk-tag">LIVE</span>'
        : (w < cur ? '<span class="pcl-wk-tag pcl-wk-tag--past">CLOSED</span>' : "");
      html += '<div class="pcl-wkcard' + (w === cur ? " is-live" : "") + '">' +
        '<div class="pcl-wk-head">' +
          '<span class="pcl-wk-name">WEEK ' + w + " · " + esc(c.name) + "</span>" + tag +
          '<span class="pcl-wk-date">' + esc(weekWindowTxt(w)) + "</span>" +
        "</div>" +
        '<p class="pcl-wk-crit">' + esc(c.crit) + "</p>" +
        '<p class="pcl-wk-pts">Weekly Reward + ' +
        Number(c.pts || 0).toLocaleString("en-IN") + " LeaderBoard Points</p>" +
        "</div>";
    }
    html += '<p class="pcl-rb-note">Analytics are tracked Monday → Saturday. Submit ' +
      "each week's post analytics by <b>11:00 AM the following Monday</b> to be " +
      "considered. The winning post gets featured as a collab on Praper Media's " +
      "official pages.</p>";
    Modal.open(html);
  }

  function syncChipStates() {
    var chips = $("pclWeeks").querySelectorAll(".pcl-wchip");
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var v = c.dataset.view === "all" ? "all" : Number(c.dataset.view);
      c.classList.toggle("is-active", v === state.view);
    }
  }

  /* ---------- season ticker ---------- */
  function renderTicker() {
    var d = state.data;
    var unit;
    if (!d) {
      unit = "SEASON 2 ★ HIGH SCORES LIVE ";
    } else {
      var impTotal = d.players.reduce(function (a, p) {
        return a + (toNum(p.impressions) || 0);
      }, 0);
      var wkTxt = d.currentWeek > 0 ? "WEEK " + d.currentWeek + " LIVE" : "SEASON 2";
      unit = "SEASON 2 ★ " + wkTxt + " ★ " + d.players.length + " PLAYERS ★ " +
             fmt(d.totalPosts) + " POSTS ★ " + fmt(impTotal) + " IMPRESSIONS ";
    }
    var star = ' <span class="pcl-tick-star">★</span> ';
    var html = unit.replace(/ ★ /g, star) + star;
    var track = $("pclTickerTrack");
    track.innerHTML =
      '<span class="pcl-ticker-text">' + html.repeat(3) + '</span>' +
      '<span class="pcl-ticker-text" aria-hidden="true">' + html.repeat(3) + '</span>';
  }

  /* ---------- load ---------- */
  function setSync(text) { $("pclSync").textContent = text; }
  function setBusy(b) {
    state.syncing = b;
    $("pclRefresh").disabled = b;
    var r = $("pclRetry");
    if (r) r.disabled = b;
  }

  function load() {
    if (state.syncing) return;
    setBusy(true);
    show("loading");
    setSync("SYNCING…");

    function done(err, data) {
      setBusy(false);
      if (err) {
        show("error");
        setSync("SYNC FAILED — CHECK CONNECTION");
        return;
      }
      try {
        state.data = normalize(data);
      } catch (e) {
        show("error");
        setSync("SYNC FAILED — BAD RESPONSE");
        return;
      }
      buildWeekChips();
      render();
      renderTicker();
      setSync(MOCK ? "DEMO DATA · MOCK BOARD"
                   : "LAST SYNC " + fmtIST(state.data.generatedAt) + " IST");
    }

    if (MOCK) {
      setTimeout(function () { done(null, mockData()); }, 350);
      return;
    }
    if (!cfg.gasWebAppUrl) {
      // unwired deployment — behave like an empty season, not an error
      setBusy(false);
      state.data = normalize({ ok: true, totalPosts: 0, players: [] });
      buildWeekChips();
      render();
      renderTicker();
      setSync("STANDBY");
      return;
    }
    jsonp({ action: "stats" }, done);
  }

  /* ---------- wire up ---------- */
  $("pclRefresh").addEventListener("click", load);
  var retry = $("pclRetry");
  if (retry) retry.addEventListener("click", load);

  load();

  /* debug handle */
  window.PCL_BOARD = state;
})();
