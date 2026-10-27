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
    var rows = [
      { ts: "2026-10-20T06:10:00.000Z", name: "Jatin Gulati", format: "ig_reel",
        mediaId: "C0abc123XYZ", url: "https://www.instagram.com/reel/C0abc123XYZ/",
        week: "Week 1 \u2014 Best Original Content", photoId: "", photo: "" },
      { ts: "2026-10-21T09:30:00.000Z", name: "Jatin Gulati", format: "yt_video",
        mediaId: "aqz-KE-bpKQ", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        week: "", photoId: "", photo: "" },
      { ts: "2026-10-22T11:00:00.000Z", name: "Ashutosh", format: "li_post",
        mediaId: "", url: "https://www.linkedin.com/posts/activity-7123456789",
        week: "Week 1 \u2014 Best Original Content", photoId: "", photo: "" },
      { ts: "2026-10-23T12:00:00.000Z", name: "Manas Ranjan", format: "ig_reel",
        mediaId: "C1xyz456ABC", url: "https://www.instagram.com/reel/C1xyz456ABC/",
        week: "Week 2 \u2014 Best Storytelling Debut", photoId: "", photo: "" },
      { ts: "2026-10-23T14:00:00.000Z", name: "Manas Ranjan", format: "yt_video",
        mediaId: "aqz-KE-bpKQ", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        week: "", photoId: "", photo: "" },
      { ts: "2026-10-24T15:00:00.000Z", name: "Lagan Garg", format: "ig_post",
        mediaId: "C2def789LMN", url: "https://www.instagram.com/p/C2def789LMN/",
        week: "Week 2 \u2014 Best Storytelling Debut", photoId: "", photo: "" }
    ];
    return { ok: true, totalPosts: 23, uniqueMedia: 23, players: players,
             weeks: weeks, rows: rows, generatedAt: new Date().toISOString() };
  }

  /* ---------- gallery index (ROUND 38 — the entry theatre) ----------
     The stats payload already carries every ledger row; group the posts
     per player, collapse UPDATE snapshot chains to ONE entry per media
     (newest snapshot's metadata wins, order = when the post first landed)
     and remember the player photo so the theatre header can wear it.
     Pure content — no numbers of any kind reach the pop-up. */
  function normKey(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function platformOf(r) {
    var f = String(r.format || "").toLowerCase();
    if (f.indexOf("ig_") === 0) return "ig";
    if (f.indexOf("yt_") === 0) return "yt";
    if (f.indexOf("li_") === 0) return "li";
    var u = String(r.url || "");
    if (/instagram\.com|instagr\.am/i.test(u)) return "ig";
    if (/youtube\.com|youtu\.be/i.test(u)) return "yt";
    if (/linkedin\.com|lnkd\.in/i.test(u)) return "li";
    return "";
  }
  function galleryPost(r) {
    var plat = platformOf(r);
    var wm = String(r.week || "").match(
      /^Week\s+(\d+)\s*(?:[\u2014\u2013-]\s*(.*))?$/i);
    return {
      url: String(r.url || ""),
      mediaId: String(r.mediaId || ""),
      plat: plat,
      kind: plat === "ig" && /reel/i.test(String(r.format || "")) ? "reel" : "post",
      weekNum: wm ? Number(wm[1]) : 0,
      weekName: wm && wm[2] ? wm[2].trim() : "",
      ts: String(r.ts || "")
    };
  }
  function buildGallery(rows) {
    var byKey = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var name = String((r && r.name) || "").trim();
      if (!name) return;
      var url = String((r && r.url) || "").trim();
      var mid = String((r && r.mediaId) || "").trim();
      if (!url && !mid) return;
      var k = normKey(name);
      var g = byKey[k] ||
        (byKey[k] = { name: name, posts: {}, photo: "", photoId: "" });
      var pk = mid || url;
      var p = g.posts[pk];
      if (!p) g.posts[pk] = { first: String((r && r.ts) || ""), row: r };
      else if (String((r && r.ts) || "").localeCompare(String(p.row.ts || "")) > 0) p.row = r;
      if (!g.photoId && r.photoId) { g.photoId = r.photoId; g.photo = r.photo || ""; }
      else if (!g.photoId && !g.photo && r.photo) g.photo = r.photo;
    });
    var out = {};
    Object.keys(byKey).forEach(function (k) {
      var g = byKey[k];
      var posts = Object.keys(g.posts).map(function (pk) { return g.posts[pk]; });
      posts.sort(function (a, b) {
        return String(a.first).localeCompare(String(b.first));
      });
      out[k] = { name: g.name, photo: g.photo, photoId: g.photoId,
                 posts: posts.map(function (p) { return galleryPost(p.row); }) };
    });
    return out;
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
      generatedAt: data.generatedAt,
      gallery: buildGallery(data.rows)   // old backends send no rows → {}
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
    return '<div class="pcl-row pcl-row--entry' + rankCls +
        '" data-galname="' + esc(p.name) + '" tabindex="0" role="button"' +
        ' aria-label="View ' + esc(p.name) + '&#39;s uploaded posts">' +
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

  /* ============================================================================
     THE ENTRY THEATRE (ROUND 38) — click a standings row and an elevated
     pop-up shows ONLY the content that participant uploaded: the posts
     themselves, their week tags and nothing else — no stats, no analytics,
     no numbers of any kind. Two independent navigations:
       ← →   walk THIS player's posts (wraps around)
       ↑ ↓   walk the participants of the current board view (position kept
             where possible, clamped when the next player has fewer posts)
     The filmstrip switches posts, the rail switches players, Esc / backdrop /
     × close. Embeds: YouTube (nocookie) + Instagram; LinkedIn refuses
     iframes, so it gets an elevated link card.
     ========================================================================== */
  var GAL_SVGS = {
    ig: '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="pclGalIg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#feda75"/><stop offset=".28" stop-color="#fa7e1e"/><stop offset=".55" stop-color="#d62976"/><stop offset=".8" stop-color="#962fbf"/><stop offset="1" stop-color="#4f5bd5"/></linearGradient></defs><rect x="2.4" y="2.4" width="19.2" height="19.2" rx="5.4" fill="none" stroke="url(#pclGalIg)" stroke-width="2.7"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="url(#pclGalIg)" stroke-width="2.7"/><circle cx="17.3" cy="6.7" r="1.7" fill="url(#pclGalIg)"/></svg>',
    yt: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="4.8" width="21" height="14.4" rx="4" fill="#FF0000"/><path d="M10 9l6 3-6 3z" fill="#fff"/></svg>',
    li: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="3.2" fill="#0A66C2"/><rect x="5.4" y="9.9" width="2.9" height="8.8" fill="#fff"/><circle cx="6.85" cy="6.5" r="1.75" fill="#fff"/><path d="M11.4 9.9h2.8v1.25c.5-.8 1.55-1.55 3.1-1.55 2.5 0 3.85 1.6 3.85 4.45v4.65h-2.9v-4.2c0-1.45-.6-2.35-1.75-2.35-1.25 0-2.2.9-2.2 2.55v4h-2.9z" fill="#fff"/></svg>',
    web: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
  };
  function safeUrl(u) {
    var s = String(u || "").trim();
    return /^https?:\/\//i.test(s) ? s : "";
  }
  function ytThumbUrl(id) {
    return "https://i.ytimg.com/vi/" + encodeURIComponent(id) + "/mqdefault.jpg";
  }
  var Gal = { open: false, players: [], pi: 0, mi: 0 };
  function galPhoto(g) {
    return g.photoId
      ? "https://drive.google.com/thumbnail?id=" +
        encodeURIComponent(g.photoId) + "&sz=w200"
      : (g.photo || "");
  }
  /* the theatre walks the CURRENT board view (all-season or a week), so
     ↑ ↓ matches exactly the order the visitor sees on the board */
  function buildGalPlayers() {
    var gal = (state.data && state.data.gallery) || {};
    return viewPlayers().filter(function (p) {
      var g = gal[normKey(p.name)];
      return g && g.posts.length;
    }).map(function (p) {
      return { key: normKey(p.name), name: p.name,
               designation: p.designation, g: gal[normKey(p.name)] };
    });
  }
  function galFrame(p) {
    if (p.plat === "yt" && p.mediaId) {
      return '<iframe class="pcl-gal-frame" src="https://www.youtube-nocookie.com/embed/' +
        encodeURIComponent(p.mediaId) + '?rel=0" title="League post" loading="lazy"' +
        ' allow="accelerometer; autoplay; clipboard-write; encrypted-media;' +
        ' gyroscope; picture-in-picture" allowfullscreen></iframe>';
    }
    if (p.plat === "ig" && p.mediaId) {
      return '<iframe class="pcl-gal-frame pcl-gal-frame--ig" scrolling="no"' +
        ' title="League post" loading="lazy" src="https://www.instagram.com/' +
        (p.kind === "reel" ? "reel" : "p") + "/" + encodeURIComponent(p.mediaId) +
        '/embed"></iframe>';
    }
    return '<div class="pcl-gal-noframe">' +
      '<span class="pcl-gal-noframe-ico">' +
        (GAL_SVGS[p.plat] || GAL_SVGS.web) + "</span>" +
      '<p class="pcl-gal-noframe-txt">' +
        (p.plat === "li"
          ? "LinkedIn keeps its posts to itself \u2014 watch it there:"
          : "This post plays on its home platform:") + "</p>" +
      (safeUrl(p.url)
        ? '<a class="pcl-gal-openbtn" href="' + esc(safeUrl(p.url)) +
          '" target="_blank" rel="noopener">OPEN POST &#8599;</a>'
        : '<span class="pcl-gal-openbtn is-dead">LINK UNAVAILABLE</span>') +
      "</div>";
  }
  function renderGallery() {
    var P = Gal.players[Gal.pi];
    if (!P) return;
    var posts = P.g.posts;
    Gal.mi = Math.max(0, Math.min(Gal.mi, posts.length - 1));
    var post = posts[Gal.mi];
    var ph = galPhoto(P.g);
    $("galAva").innerHTML = ph
      ? '<img src="' + esc(ph) + '" alt="" />'
      : '<span class="pcl-gal-ava-letter">' +
        esc((P.name || "?").charAt(0).toUpperCase()) + "</span>";
    $("galName").textContent = P.name;
    $("galSub").textContent = P.designation || "";
    $("galSub").hidden = !P.designation;
    $("galCount").textContent =
      posts.length + " POST" + (posts.length === 1 ? "" : "S");
    $("galStage").innerHTML =
      (posts.length > 1
        ? '<button type="button" class="pcl-gal-nav pcl-gal-nav--prev"' +
          ' data-gal="prev" aria-label="Previous post">&#8249;</button>' +
          '<button type="button" class="pcl-gal-nav pcl-gal-nav--next"' +
          ' data-gal="next" aria-label="Next post">&#8250;</button>'
        : "") +
      '<div class="pcl-gal-holder">' + galFrame(post) + "</div>" +
      '<div class="pcl-gal-stagemeta">' +
        '<span class="pcl-gal-wk">' + (post.weekNum
          ? "WEEK " + post.weekNum + (post.weekName ? " \u00b7 " + esc(post.weekName) : "")
          : "REGULAR POST") + "</span>" +
        (safeUrl(post.url)
          ? '<a class="pcl-gal-open" href="' + esc(safeUrl(post.url)) +
            '" target="_blank" rel="noopener">OPEN ORIGINAL &#8599;</a>'
          : "") +
      "</div>";
    var strip = "";
    posts.forEach(function (p, i) {
      var th = p.plat === "yt" && p.mediaId ? ytThumbUrl(p.mediaId) : "";
      strip += '<button type="button" class="pcl-gal-thumb' +
        (i === Gal.mi ? " is-on" : "") + '" data-galthumb="' + i +
        '" aria-label="Post ' + (i + 1) + '">' +
        (th ? '<img src="' + esc(th) + '" alt="" loading="lazy" />'
            : '<span class="pcl-gal-thumb-tile pcl-gal-thumb-tile--' +
              (p.plat || "web") + '">' + (GAL_SVGS[p.plat] || GAL_SVGS.web) +
              "</span>") +
        "</button>";
    });
    $("galStrip").innerHTML = strip;
    $("galStrip").hidden = posts.length < 2;
    var rail = "";
    Gal.players.forEach(function (p, i) {
      rail += '<button type="button" class="pcl-gal-railbtn' +
        (i === Gal.pi ? " is-on" : "") + '" data-galrail="' + i + '">' +
        esc(p.name) + "</button>";
    });
    $("galRail").innerHTML = rail;
  }
  function galStep(dp, dm) {
    if (!Gal.open || !Gal.players.length) return;
    if (dm) {
      var n = Gal.players[Gal.pi].g.posts.length;
      Gal.mi = (Gal.mi + dm + n) % n;
    }
    if (dp) {
      Gal.pi = (Gal.pi + dp + Gal.players.length) % Gal.players.length;
      Gal.mi = Math.min(Gal.mi, Gal.players[Gal.pi].g.posts.length - 1);
    }
    renderGallery();
  }
  function openGallery(name) {
    Gal.players = buildGalPlayers();
    if (!Gal.players.length) return;
    Gal.pi = 0;
    for (var i = 0; i < Gal.players.length; i++) {
      if (normKey(Gal.players[i].name) === normKey(name)) { Gal.pi = i; break; }
    }
    Gal.mi = 0;
    Gal.open = true;
    renderGallery();
    $("pclGallery").hidden = false;
    document.body.style.overflow = "hidden";
    var x = document.querySelector("#pclGallery .pcl-gal-x");
    if (x) x.focus();
  }
  function closeGallery() {
    Gal.open = false;
    $("pclGallery").hidden = true;
    $("galStage").innerHTML = "";            // stops any embed playback
    document.body.style.overflow = "";
  }
  $("pclGallery").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-gal]");
    if (btn) {
      var a = btn.getAttribute("data-gal");
      if (a === "close") closeGallery();
      else if (a === "prev") galStep(0, -1);
      else if (a === "next") galStep(0, 1);
      return;
    }
    var th = ev.target.closest("[data-galthumb]");
    if (th) {
      Gal.mi = Number(th.getAttribute("data-galthumb")) || 0;
      renderGallery();
      return;
    }
    var rl = ev.target.closest("[data-galrail]");
    if (rl) {
      Gal.pi = Number(rl.getAttribute("data-galrail")) || 0;
      Gal.mi = 0;
      renderGallery();
    }
  });
  document.addEventListener("keydown", function (ev) {
    if (!Gal.open) return;
    var tag = String((ev.target && ev.target.tagName) || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    switch (ev.key) {
      case "Escape": closeGallery(); break;
      case "ArrowRight": ev.preventDefault(); galStep(0, 1); break;
      case "ArrowLeft": ev.preventDefault(); galStep(0, -1); break;
      case "ArrowDown": ev.preventDefault(); galStep(1, 0); break;
      case "ArrowUp": ev.preventDefault(); galStep(-1, 0); break;
    }
  });
  /* board rows open the theatre — click or Enter/Space (rows are focusable) */
  $("pclRows").addEventListener("click", function (ev) {
    var row = ev.target.closest("[data-galname]");
    if (row) openGallery(row.getAttribute("data-galname"));
  });
  $("pclRows").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    var row = ev.target.closest("[data-galname]");
    if (row) { ev.preventDefault(); openGallery(row.getAttribute("data-galname")); }
  });

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
      "each week's post analytics by <b>6:00 PM the following Tuesday</b> to be " +
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
      /* ROUND 38 — the theatre's media feed rides its own public endpoint
         (data-minimized: only name/url/mediaId/format/week/ts/photo). The
         board renders without it; if the fetch fails the theatre simply
         stays closed and the standings are untouched. */
      if (!MOCK && cfg.gasWebAppUrl) {
        jsonp({ action: "gallery" }).then(function (g) {
          if (g && g.ok && Array.isArray(g.rows)) {
            state.data.gallery = buildGallery(g.rows);
          }
        }).catch(function () { /* theatre stays unavailable — board unaffected */ });
      }
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
