/* ============================================================================
   PCL ADMIN CONSOLE — dependency-free engine (plain ES5-ish, no framework).
   ----------------------------------------------------------------------------
   Talks to the SAME Google Apps Script Web App as the form:
     · READ   JSONP  ?action=ledger&key=…&callback=…   → rows+totals+players
     · READ   JSONP  ?action=ocr&key=…&fileId=…        → semi-auto OCR suggest
     · WRITE  POST   {action:'adminVerify', adminKey, updates:[…]}
              (same simple-request POST the form uses — no CORS preflight)

   Console model:
     · The FEED renders the ledger newest-first with filters.
     · Edits (verified count / status / OCR) are STAGED in memory — the
       sticky bar counts them and SAVE CHANGES writes them in one batch,
       then the ledger reloads so sheet row numbers stay fresh.
     · AUDIT rebuilds per-Media-ID snapshot timelines and flags hard
       claimed-count jumps (WATCH) with one-click BOOST? staging.
     · REPORTS computes season cards, weekly windows (Tue 18:00 IST
       deadline) and the per-player table. CSV export is client-side.

   Debug/demo: open admin.html?mock=1 → mock ledger, any password ≥ 4 chars
   unlocks, writes apply in-memory. window.PCL_ADMIN exposes state.
   ========================================================================== */

(function () {
  "use strict";

  var cfg = window.PCL_CONFIG || {};
  var MOCK = /(^|[?&])mock=1(&|$)/.test(location.search);
  var KEY_STORE = "pcl_admin_key";
  var OP_STORE = "pcl_admin_op";

  /* ---------- tiny helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(n) {
    n = Number(n);
    return isNaN(n) ? "–" : n.toLocaleString("en-IN");
  }
  function fmtTS(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "–";
    try {
      return d.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
        hour: "2-digit", minute: "2-digit", hour12: true
      });
    } catch (e) { return d.toISOString().slice(0, 16).replace("T", " "); }
  }
  function fmtDay(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "–";
    try {
      return d.toLocaleDateString("en-IN",
        { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" });
    } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function shortLink(url) {
    try {
      var u = new URL(url);
      var s = u.hostname.replace(/^www\./i, "") + u.pathname;
      return s.length > 34 ? s.slice(0, 34) + "…" : s;
    } catch (e) { return String(url || ""); }
  }
  function mediaTail(mediaId) {
    var t = String(mediaId || "").split("_").slice(1).join("_");
    return t.length > 12 ? t.slice(0, 12) + "…" : t;
  }
  function multOf(v) {
    var n = Number(v);
    return isNaN(n) ? "×1" : "×" + n;
  }
  function normCheck(v) {
    return String(v || "").toUpperCase().trim() || "PENDING OCR";
  }
  /* Only real web addresses become links. Ledger rows are written by the
     form, but the ingest endpoint is public — a hostile direct API write
     must never get a javascript:/data: URL rendered as a clickable href
     inside the Control Room. Non-http(s) values degrade to an inert "#". */
  function safeHref(u) {
    var s = String(u || "").trim();
    return /^https?:\/\//i.test(s) ? s : "#";
  }
  /* collab badge: CONFIRMED pairs split verified points 50:50 server-side,
     PENDING means the player tagged a partner whose same-link entry has not
     landed (or does not match) yet — reviewer gets to see it at a glance */
  function collabBadgeHtml(r) {
    if (r.collabStatus === "CONFIRMED") {
      return '<span class="pcl-tag pcl-tag--collab" title="Confirmed collab with ' +
        esc(r.collabWith || "partner") + " — FULL points credited to EACH collaborator (shared, never split)\">COLLAB · FULL</span>";
    }
    if (r.collabStatus === "PENDING") {
      return '<span class="pcl-tag pcl-tag--collabpend" title="Tagged as collab with ' +
        esc(r.collabWith || "?") + " — waiting for the partner\u2019s matching entry\">COLLAB?</span>";
    }
    return "";
  }
  function digitsOf(v) {
    var s = String(v == null ? "" : v).replace(/[^\d]/g, "");
    return s === "" ? "" : Number(s);
  }

  /* admin-verified tick — inline SVG (no emoji), shared with the form and
     the leaderboard. GREEN circle per user spec: green = the Control Room
     has confirmed this participant. Unverified players carry nothing. */
  var TICK_SVG = '<svg class="pcl-vbadge pcl-vbadge--sm" viewBox="0 0 24 24" ' +
    'role="img" aria-label="Admin verified">' +
    '<circle cx="12" cy="12" r="10.5" fill="#1d9e57"/>' +
    '<circle cx="12" cy="12" r="10.5" fill="none" stroke="#fffdf6" stroke-width="1.4"/>' +
    '<circle cx="12" cy="12" r="7.7" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1"/>' +
    '<path d="M7.6 12.3l3 3.1 5.9-6.3" fill="none" stroke="#fff" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var FORMAT_SHORT = {
    "Instagram Reel": "IG REEL",
    "Instagram Post / Carousel": "IG POST",
    "YouTube Shorts": "YT SHORTS",
    "YouTube Long-Form": "YT VIDEO",
    "LinkedIn Post": "LI POST"
  };
  function fmtShort(f) { return FORMAT_SHORT[f] || String(f || "?").toUpperCase(); }

  /* platform logos + platform-coloured format words — the SAME markup the
     form uses (.pcl-fmtbrand), so review reads by icon and colour, not by
     deciphering uppercase words. Reel/Post/Short/Video take the platform
     logo's brand colour/gradient via [data-fmt] rules in theme.css. */
  var BRAND_LOGO = {
    ig: '<svg class="pcl-fmtlogo" viewBox="0 0 24 24" aria-hidden="true">' +
        '<defs><linearGradient id="pclAdmIgGrad" x1="0" y1="1" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#feda75"/><stop offset=".28" stop-color="#fa7e1e"/>' +
        '<stop offset=".55" stop-color="#d62976"/><stop offset=".8" stop-color="#962fbf"/>' +
        '<stop offset="1" stop-color="#4f5bd5"/></linearGradient></defs>' +
        '<rect x="2.4" y="2.4" width="19.2" height="19.2" rx="5.4" fill="none" ' +
        'stroke="url(#pclAdmIgGrad)" stroke-width="2.7"/>' +
        '<circle cx="12" cy="12" r="4.5" fill="none" stroke="url(#pclAdmIgGrad)" stroke-width="2.7"/>' +
        '<circle cx="17.3" cy="6.7" r="1.7" fill="url(#pclAdmIgGrad)"/></svg>',
    yt: '<svg class="pcl-fmtlogo" viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="1.5" y="4.8" width="21" height="14.4" rx="4" fill="#FF0000"/>' +
        '<path d="M10 9l6 3-6 3z" fill="#fff"/></svg>',
    li: '<svg class="pcl-fmtlogo" viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="2" y="2" width="20" height="20" rx="3.2" fill="#0A66C2"/>' +
        '<rect x="5.4" y="9.9" width="2.9" height="8.8" fill="#fff"/>' +
        '<circle cx="6.85" cy="6.5" r="1.75" fill="#fff"/>' +
        '<path d="M11.4 9.9h2.8v1.25c.5-.8 1.55-1.55 3.1-1.55 2.5 0 3.85 1.6 3.85 4.45v4.65h-2.9v-4.2c0-1.45-.6-2.35-1.75-2.35-1.25 0-2.2.9-2.2 2.55v4h-2.9z" fill="#fff"/></svg>'
  };
  var FORMAT_WORD = {
    "Instagram Reel": "Reel", "Instagram Post / Carousel": "Post",
    "YouTube Shorts": "Short", "YouTube Long-Form": "Video",
    "LinkedIn Post": "Post"
  };
  function fmtKey(f) {
    if (f === "Instagram Reel") return "ig_reel";
    if (f === "Instagram Post / Carousel") return "ig_post";
    if (f === "YouTube Shorts") return "yt_shorts";
    if (f === "YouTube Long-Form") return "yt_long";
    if (f === "LinkedIn Post") return "li_post";
    return "";
  }
  function brandBadgeAdm(f, mult) {
    var key = fmtKey(f);
    if (!key) return '<b>' + esc(fmtShort(f)) + "</b>";
    var plat = key.split("_")[0];
    var word = FORMAT_WORD[f] || fmtShort(f);
    return '<span class="pcl-fmtbrand" data-fmt="' + key + '">' +
      BRAND_LOGO[plat] + '<span class="pcl-fmtword">' + esc(word) + "</span></span>";
  }
  function platKeyOf(r) {
    var p = String(r.platform || "").toLowerCase();
    if (p.indexOf("instagram") === 0) return "ig";
    if (p.indexOf("youtube") === 0) return "yt";
    if (p.indexOf("linkedin") === 0) return "li";
    var k = fmtKey(r.format);
    return k ? k.split("_")[0] : "";
  }
  /* the #hash identity — the SAME link logic as the form: icon-ish hash
     text, full URL on hover/href (user: "replace the url with the same
     logic we have") */
  function postHashOf(r) {
    var tail = String(r.mediaId || "").split("_").slice(1).join("_");
    if (!tail) return shortLink(r.url);
    return tail.length > 8 ? tail.slice(0, 8) + "…" : tail;
  }
  function ctTagHtml(ct) {
    if (ct !== "PRAPER" && ct !== "PERSONAL") return "";
    return '<span class="pcl-cttag' + (ct === "PERSONAL" ? " is-personal" : "") +
      '">' + ct + "</span>";
  }

  /* device/browser identity — a readable fingerprint so the league can
     check WHO usually operates each name (nobody signs in under somebody
     else's name). Sent with every login; the backend binds the first
     device per operator and refuses mismatches. */
  function deviceFingerprint() {
    var parts = [];
    try {
      var n = navigator;
      parts.push(n.userAgent.split(")").pop().trim().slice(0, 40) || "?");
      parts.push((n.platform || "?").slice(0, 20));
      parts.push(n.language || "?");
      parts.push(screen.width + "x" + screen.height);
      parts.push(String(new Date().getTimezoneOffset()));
      parts.push(String(n.hardwareConcurrency || "?"));
    } catch (e) { /* best effort */ }
    var raw = parts.join(" | ");
    var h = 0, i, c;
    for (i = 0; i < raw.length; i++) {
      c = raw.charCodeAt(i);
      h = ((h << 5) - h + c) | 0;
    }
    return (h >>> 0).toString(36) + "·" + raw.replace(/\|/g, "·");
  }

  /* ---------- theme + reading-font toggles (shared behaviour/storage) ---------- */
  var toggleBtn = $("pclThemeToggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-pcl-theme") === "dark"
        ? "light" : "dark";
      document.documentElement.setAttribute("data-pcl-theme", next);
      try { localStorage.setItem("pcl_theme", next); } catch (e) { /* ok */ }
    });
  }
  var fontBtn = $("pclFontToggle");
  if (fontBtn) {
    fontBtn.setAttribute("aria-pressed",
      String(document.documentElement.getAttribute("data-pcl-font") === "og"));
    fontBtn.setAttribute("title", "Toggle OG arcade font");
    fontBtn.setAttribute("aria-label", "Toggle OG arcade font");
    fontBtn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-pcl-font") === "og"
        ? "sf" : "og";
      document.documentElement.setAttribute("data-pcl-font", next);
      fontBtn.setAttribute("aria-pressed", String(next === "og"));
      try { localStorage.setItem("pcl_font", next); } catch (e) { /* ok */ }
    });
  }
  var dateEl = $("pclDate");
  if (dateEl) {
    var MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var nowD = new Date();
    dateEl.textContent = nowD.getDate() + " " + MO[nowD.getMonth()] + " " + nowD.getFullYear();
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg, isError) {
    var el = $("pclToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "pclToast";
      el.className = "pcl-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle("is-error", !!isError);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, 2800);
  }

  /* ============================================================================
     WEEK WINDOWS — season opens Mon 2026-10-19, entries lock Tuesdays 6:00 PM IST (+ the Control-Room reopen power)
     ========================================================================== */
  var WEEKS = 10;
  var SEASON_START_ISO = "2026-10-19T11:00:00+05:30";
  var SEASON_START = new Date(SEASON_START_ISO).getTime();
  var WEEK_THEMES = {
    1: "Best Original Content", 2: "Best Storytelling Debut", 3: "A Day in My Life",
    4: "Best Collaboration", 5: "Behind the Scenes at Praper",
    6: "Most Improved Creator", 7: "Consistency Reward", 8: "The One-Take Challenge",
    9: "The Trend Takeover", 10: "The Comment Magnet"
  };
  function weekOf(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return 0;
    if (t < SEASON_START) return 1;               // warm-up posts land in W1
    var k = Math.floor((t - SEASON_START) / (7 * 86400000)) + 1;
    return Math.min(WEEKS, k);
  }
  function weekWindow(w) {
    // always returns the window; "live" (not yet closed) is derived by caller
    return {
      a: new Date(SEASON_START + (w - 1) * 7 * 86400000),
      b: new Date(SEASON_START + w * 7 * 86400000)
    };
  }

  /* ============================================================================
     MOCK MODE — full offline demo of every surface (no backend touched)
     ========================================================================== */
  var mockEdits = {};   // sheet row → {ocrCount, crossCheck, verifiedCount}
  var MOCK_VERIFIED = {};  // normName → bool (mock identity verification)
  var MOCK_AWARDS = [];    // mock weekly-challenge rewards (PCL-Awards)
  var MOCK_GATES = { seasonOpen: true, weeks: {}, reopen: {} };   // mock submission gates

  function mockSvg(seed, big) {
    // tiny pixel analytics placeholder — deterministic per seed
    var bars = "", i, h, x = 8;
    for (i = 0; i < 7; i++) {
      h = 6 + ((seed * (i + 3) * 7) % 22);
      bars += '<rect x="' + x + '" y="' + (38 - h) + '" width="7" height="' + h +
              '" fill="' + (i === 5 ? '#ff5a1f' : '#33409f') + '"/>';
      x += 11;
    }
    var label = (big ? "ANALYTICS " : "") + "#" + (1000 + seed);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96">' +
      '<rect width="160" height="96" fill="#0a0f3e"/>' +
      '<text x="8" y="14" font-family="monospace" font-size="9" fill="#aab4ff">' +
      label + "</text>" + bars + "</svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function mockAvatar(letter, tone) {
    // round-pfp stand-in for mock mode — proves the circular path offline
    var bg = ["#ed3b00", "#33409f", "#1d9e57"][tone % 3];
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
      '<rect width="96" height="96" fill="' + bg + '"/>' +
      '<text x="48" y="62" font-family="monospace" font-size="42" fill="#fff" ' +
      'text-anchor="middle">' + letter + "</text></svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function mockRows() {
    var t = Date.now(), H = 3600000, D = 24 * H;
    function row(o) { return o; }
    var base = [
      row({ row: 2,  ts: new Date(t - 3 * H).toISOString(), id: "pcl-mock-a2", type: "NEW",
            snap: 1, name: "Priya Sharma", manager: "Rahul", platform: "Instagram",
            format: "Instagram Reel", mult: 1.25, url: "https://instagram.com/reel/Cx1mock01/",
            mediaId: "ig_Cx1mock01", week: "Week 2 — Best Storytelling Debut",
            ctype: "PRAPER", tracked: true, trackedViews: 18120,
            claimed: 18400, projected: 23000, check: "PENDING OCR", ocr: "", verified: "" }),
      row({ row: 4,  ts: new Date(t - 5 * H).toISOString(), id: "pcl-mock-a2", type: "NEW",
            snap: 1, name: "Rohit Kharal", manager: "Sneha", platform: "Instagram",
            format: "Instagram Reel", mult: 1.25, url: "https://instagram.com/reel/Cx1mock01/",
            mediaId: "ig_Cx1mock01", week: "",
            ctype: "PERSONAL",
            collabWith: "Priya Sharma", collabStatus: "CONFIRMED",
            claimed: 18400, projected: 23000, check: "MATCH", ocr: 18412, verified: 18412 }),
      row({ row: 5,  ts: new Date(t - 5 * H).toISOString(), id: "pcl-mock-a2", type: "NEW",
            snap: 1, name: "Priya Sharma", manager: "Rahul", platform: "YouTube",
            format: "YouTube Long-Form", mult: 2, url: "https://youtube.com/watch?v=mockYT01",
            mediaId: "yt_mockYT01", week: "", ctype: "PERSONAL", claimed: 9600,
            projected: 19200, check: "MATCH", ocr: 9612, verified: 9612 }),
      row({ row: 6,  ts: new Date(t - 8 * H).toISOString(), id: "pcl-mock-b7", type: "UPDATE",
            snap: 3, name: "Arjun Verma", manager: "Sneha", platform: "Instagram",
            format: "Instagram Reel", mult: 1.25, url: "https://instagram.com/reel/Cx2mock02/",
            mediaId: "ig_Cx2mock02", week: "", ctype: "PRAPER", tracked: true,
            trackedViews: 64001, claimed: 61200, projected: 76500,
            check: "PENDING OCR", ocr: "", verified: "" }),
      row({ row: 7,  ts: new Date(t - 34 * H).toISOString(), id: "pcl-mock-b7", type: "UPDATE",
            snap: 2, name: "Arjun Verma", manager: "Sneha", platform: "Instagram",
            format: "Instagram Reel", mult: 1.25, url: "https://instagram.com/reel/Cx2mock02/",
            mediaId: "ig_Cx2mock02", week: "", claimed: 19600, projected: 24500,
            check: "PENDING OCR", ocr: "", verified: "" }),
      row({ row: 8,  ts: new Date(t - 60 * H).toISOString(), id: "pcl-mock-b7", type: "NEW",
            snap: 1, name: "Arjun Verma", manager: "Sneha", platform: "Instagram",
            format: "Instagram Reel", mult: 1.25, url: "https://instagram.com/reel/Cx2mock02/",
            mediaId: "ig_Cx2mock02", week: "", claimed: 18400, projected: 23000,
            check: "PENDING OCR", ocr: "", verified: "" }),
      row({ row: 9,  ts: new Date(t - 9 * H).toISOString(), id: "pcl-mock-c4", type: "NEW",
            snap: 1, name: "Sneha Rao", manager: "Rahul", platform: "LinkedIn",
            format: "LinkedIn Post", mult: 1, url: "https://linkedin.com/posts/mock-li-99",
            mediaId: "li_mock-li-99", week: "Week 2 — Best Storytelling Debut",
            claimed: 4300, projected: 4300, check: "MISMATCH", ocr: 3120, verified: 3120 }),
      row({ row: 10,  ts: new Date(t - 12 * H).toISOString(), id: "pcl-mock-d1", type: "NEW",
            snap: 1, name: "Dev Patel", manager: "Sneha", platform: "YouTube",
            format: "YouTube Shorts", mult: 1.25, url: "https://youtube.com/shorts/mockS01",
            mediaId: "yt_mockS01", week: "", claimed: 12750, projected: 15938,
            check: "PENDING OCR", ocr: "", verified: "" }),
      row({ row: 11,  ts: new Date(t - 26 * H).toISOString(), id: "pcl-mock-e9", type: "NEW",
            snap: 1, name: "Ishita Nair", manager: "Rahul", platform: "Instagram",
            format: "Instagram Post / Carousel", mult: 1, url: "https://instagram.com/p/Cx3mock03/",
            mediaId: "ig_Cx3mock03", week: "", claimed: 8100, projected: 8100,
            check: "BOOST?", ocr: "", verified: "" }),
      row({ row: 12, ts: new Date(t - 30 * H).toISOString(), id: "pcl-mock-f2", type: "NEW",
            snap: 1, name: "Arjun Verma", manager: "Sneha", platform: "YouTube",
            format: "YouTube Shorts", mult: 1.25, url: "https://youtube.com/shorts/mockS02",
            mediaId: "yt_mockS02", week: "Week 1 — Best Original Content",
            claimed: 22100, projected: 27625, check: "PENDING OCR", ocr: "", verified: "" }),
      row({ row: 13, ts: new Date(t - 50 * H).toISOString(), id: "pcl-mock-g5", type: "NEW",
            snap: 1, name: "Priya Sharma", manager: "Rahul", platform: "Instagram",
            format: "Instagram Reel", mult: 1.25, url: "https://instagram.com/reel/Cx4mock04/",
            mediaId: "ig_Cx4mock04", week: "", claimed: 5400, projected: 6750,
            check: "PENDING OCR", ocr: "", verified: "" })
    ];
    base.forEach(function (r, i) {
      r.manager = r.manager;
      r.shotName = "insights_" + (i + 1) + ".png";
      r.shotUrl = "https://drive.google.com/file/d/1MockFileId" + i + "xxxxxxxxxx/view";
      r.fileId = "1MockFileId" + i + "xxxxxxxxxx";
      r.thumb = mockSvg(i + 3);
      r.projected = Math.ceil(Number(r.claimed) * Number(r.mult));
      // mock pfps — same photoData path the real ledger gets from Drive
      var tone = { "priya sharma": 0, "rohit kharal": 1, "arjun verma": 2 }[String(r.name || "").toLowerCase()];
      if (tone !== undefined) {
        r.photoData = mockAvatar(r.name.charAt(0).toUpperCase(), tone);
      }
      // collab-confirmed rows score FULL points EACH (rulebook §6 rule 2 —
      // the server never halves; the mock must match it exactly)
      r.verifiedPoints = r.verified !== ""
        ? Math.ceil(Number(r.verified) * Number(r.mult))
        : "";
    });
    return base;
  }

  var MOCK_PLAYERS = [
    { player: "Priya Sharma", manager: "Rahul", designation: "Content", verified: true,
      submissions: 2, posts: 3, uniqueMedia: 3,
      formatRatio: { "Instagram Reel": 2, "YouTube Long-Form": 1 }, projectedPoints: 48950, verifiedPoints: 9612 },
    { player: "Rohit Kharal", manager: "Sneha", designation: "Shorts Editor", verified: true,
      submissions: 1, posts: 1, uniqueMedia: 1,
      formatRatio: { "Instagram Reel": 1 }, projectedPoints: 23000, verifiedPoints: 23000 },
    { player: "Arjun Verma", manager: "Sneha", designation: "", verified: false,
      submissions: 2, posts: 4, uniqueMedia: 3,
      formatRatio: { "Instagram Reel": 3, "YouTube Shorts": 1 }, projectedPoints: 151625, verifiedPoints: 0 },
    { player: "Sneha Rao", manager: "Rahul", designation: "HR", verified: false,
      submissions: 1, posts: 1, uniqueMedia: 1,
      formatRatio: { "LinkedIn Post": 1 }, projectedPoints: 4300, verifiedPoints: 3120 },
    { player: "Dev Patel", manager: "Sneha", designation: "", verified: false,
      submissions: 1, posts: 1, uniqueMedia: 1,
      formatRatio: { "YouTube Shorts": 1 }, projectedPoints: 15938, verifiedPoints: 0 },
    { player: "Ishita Nair", manager: "Rahul", designation: "Graphics Designer", verified: false,
      submissions: 1, posts: 1, uniqueMedia: 1,
      formatRatio: { "Instagram Post / Carousel": 1 }, projectedPoints: 8100, verifiedPoints: 0 }
  ];

  function mockNet(params) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (params.action === "ocr") {
          var claimed = Number(params.claimed) || 0;
          resolve({ ok: true, suggested: claimed ? claimed + 37 : 5000,
                    found: [claimed ? claimed + 37 : 5000],
                    text: "MOCK OCR · 5,037 views · 214 likes · 18 comments" });
          return;
        }
        // action=ledger — apply staged mock edits so saves stick
        var rows = mockRows();
        rows.forEach(function (r) {
          var e = mockEdits[r.row];
          if (!e) return;
          if (e.ocrCount !== undefined) r.ocr = e.ocrCount;
          if (e.crossCheck !== undefined) r.check = e.crossCheck;
          if (e.contentType !== undefined && e.contentType) r.ctype = e.contentType;
          if (e.verifiedCount !== undefined) {
            r.verified = e.verifiedCount;
            r.verifiedPoints = e.verifiedCount !== ""
              ? Math.ceil(Number(e.verifiedCount) * Number(r.mult)) : "";
          }
        });
        var mockPlayers = JSON.parse(JSON.stringify(MOCK_PLAYERS));
        mockPlayers.forEach(function (p) {
          var v = MOCK_VERIFIED[String(p.player || "").toLowerCase()];
          if (v !== undefined) p.verified = v;
        });
        resolve({
          ok: true, generatedAt: new Date().toISOString(),
          totals: { totalSubmissions: 8, totalPosts: rows.length, uniqueMedia: 9,
                    lastSubmissionAt: rows[0].ts },
          players: mockPlayers,
          rows: rows,
          awards: MOCK_AWARDS.slice(),
          gates: { seasonOpen: MOCK_GATES.seasonOpen,
                   weeks: JSON.parse(JSON.stringify(MOCK_GATES.weeks)),
                   reopen: JSON.parse(JSON.stringify(MOCK_GATES.reopen || {})) },
          log: mockLog
        });
      }, 220);
    });
  }

  /* offline audit-catalogue fixture (mock mode only) */
  var mockLog = [
    { ts: "2026-10-19T09:12:00.000Z", operator: "Manas", action: "VERIFY",
      target: "row 4 · Manas",
      detail: "OCR: –→332234234 · CHECK: PENDING OCR→MATCH · VERIFIED: –→332234234 · VPTS: –→415292793" },
    { ts: "2026-10-19T09:02:00.000Z", operator: "Manas", action: "LOGIN",
      target: "Control Room", detail: "gate unlocked" },
    { ts: "2026-10-18T15:40:00.000Z", operator: "Sehaj", action: "VERIFY",
      target: "row 2 · Sehaj",
      detail: "OCR: –→8798 · CHECK: PENDING OCR→MATCH · VERIFIED: –→7980 · VPTS: –→9975" }
  ];

  /* ============================================================================
     DATA LAYER — JSONP reads (CORS-free) + simple POST writes (as the form)
     ========================================================================== */
  var cbSeq = 0;

  function jsonp(params) {
    if (MOCK) return mockNet(params);
    return new Promise(function (resolve, reject) {
      if (!cfg.gasWebAppUrl) {
        reject(new Error("Backend URL not configured — set gasWebAppUrl in js/gas-endpoint.js (or open with ?mock=1)"));
        return;
      }
      var cb = "pclAdminCb" + (++cbSeq);
      var s = document.createElement("script");
      var done = false;
      var timer = setTimeout(function () {
        finish(new Error("Request timed out — is the Web App deployed?"));
      }, 60000);
      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
        err ? reject(err) : resolve(data);
      }
      window[cb] = function (data) { finish(null, data); };
      s.onerror = function () {
        finish(new Error("Network error — check the Web App URL and deployment access"));
      };
      var q = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      }).join("&");
      /* cache-buster — Google's /exec CDN caches GET responses aggressively,
         and a cached "ledger" is exactly the "REFRESH shows the same old
         numbers" bug; every read must look like a brand-new URL */
      s.src = cfg.gasWebAppUrl + "?" + q + "&_=" + Date.now() + "&callback=" + cb;
      document.head.appendChild(s);
    });
  }

  function gasPost(body) {
    if (MOCK) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (body.action === "adminLogin") {
            mockLog.unshift({ ts: new Date().toISOString(),
              operator: state.operator || "unnamed", action: "LOGIN",
              target: "Control Room", detail: "gate unlocked" });
            resolve({ ok: true });
            return;
          }
          (body.updates || []).forEach(function (u) {
            mockEdits[u.row] = {
              ocrCount: u.ocrCount, crossCheck: u.crossCheck,
              verifiedCount: u.verifiedCount, contentType: u.contentType
            };
          });
          if (body.action === "adminPlayerVerify") {
            (body.players || []).forEach(function (p) {
              MOCK_VERIFIED[String(p.name || "").toLowerCase()] = !!p.verified;
            });
            mockLog.unshift({ ts: new Date().toISOString(),
              operator: state.operator || "unnamed",
              action: (body.players || []).some(function (p) { return p.verified; })
                ? "VERIFY-ID" : "UNVERIFY-ID",
              target: (body.players || []).map(function (p) { return p.name; }).join(", ") || "—",
              detail: "identity " + ((body.players || []).some(function (p) { return p.verified; })
                ? "VERIFIED (tick on)" : "unverified (tick off)") });
            resolve({ ok: true, updated: (body.players || []).length });
            return;
          }
          if (body.action === "awardChallenge") {
            MOCK_AWARDS.push({ week: body.week, player: body.name,
                               points: body.points, note: "" });
            mockLog.unshift({ ts: new Date().toISOString(),
              operator: state.operator || "unnamed", action: "AWARD",
              target: "W" + body.week + " · " + body.name + " · +" + body.points,
              detail: "weekly challenge reward" });
            resolve({ ok: true, awarded: { week: body.week, name: body.name,
                                           points: body.points } });
            return;
          }
          if (body.action === "setGate") {
            if (body.scope === "season") MOCK_GATES.seasonOpen = !!body.open;
            else if (body.scope === "reopen") {
              MOCK_GATES.reopen = MOCK_GATES.reopen || {};
              MOCK_GATES.reopen[String(body.week)] = !!body.open;
            }
            else MOCK_GATES.weeks[String(body.week)] = !!body.open;
            mockLog.unshift({ ts: new Date().toISOString(),
              operator: state.operator || "unnamed", action: "GATE",
              target: body.scope === "season" ? "season"
                : (body.scope === "reopen" ? "week " + body.week + " reopen"
                                           : "week " + body.week),
              detail: body.open ? "OPEN" : "CLOSED" });
            resolve({ ok: true });
            return;
          }
          if (body.action === "repairMediaIds") {
            mockLog.unshift({ ts: new Date().toISOString(),
              operator: state.operator || "unnamed", action: "REPAIR",
              target: "media ids",
              detail: "mock — nothing to rewrite" });
            resolve({ ok: true, result: { scanned: mockRows().length,
              rewritten: 0, cleared: 0, mergedKeys: 0 } });
            return;
          }
          mockLog.unshift({ ts: new Date().toISOString(),
            operator: body.operator || "unnamed", action: "VERIFY",
            target: (body.updates || []).length + " row(s)",
            detail: "staged review write" });
          resolve({ ok: true, updated: (body.updates || []).length });
        }, 300);
      });
    }
    return fetch(cfg.gasWebAppUrl, {
      method: "POST",
      // no explicit Content-Type → simple request → no CORS preflight
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error("GAS responded HTTP " + res.status);
      return res.json();
    });
  }

  /* ============================================================================
     STATE
     ========================================================================== */
  var state = {
    key: "",
    operator: "",        // signed-in admin — derived from the password
    rows: [],
    players: [],
    pmap: {},            // name → {designation, verified}
    totals: null,
    generatedAt: null,
    log: [],             // audit catalogue (newest first)
    awards: [],          // weekly-challenge rewards (PCL-Awards)
    awardByWeek: {},     // week → { total, list:[{player,points,note}] }
    pending: {},          // sheet row → {ocrCount?, crossCheck?, verifiedCount?, contentType?}
    filters: { q: "", week: "all", format: "all", status: "all", type: "all", ctype: "all" },
    plats: [],            // participants tab: selected platform keys ['ig','yt','li']
    pq: "",               // participants tab search
    /* participants list ordering — two filters, each flips direction on
       re-click: POINTS starts highest-first, A–Z starts A→Z. The points
       filter carries toggleable sub-metrics (points / views). */
    psort: { mode: "points", metric: "points", pdir: "desc", adir: "asc" },
    tab: "feed"
  };

  /* identity — the SERVER derives the operator name from the password
     (ADMINS roster in gas/Code.gs) and every audit entry is stamped with
     it. The client only displays what the backend answered; it never
     declares who it is. */
  function showOperator() {
    var chip = $("opChip");
    if (!chip) return;
    if (state.operator) {
      chip.textContent = "OPERATOR · " + state.operator;
      chip.hidden = false;
    } else {
      chip.textContent = "";
      chip.hidden = true;
    }
  }

  function displayOf(r) {
    var p = state.pending[r.row] || {};
    return {
      ocr: p.ocrCount !== undefined ? p.ocrCount : (r.ocr === 0 ? "" : r.ocr),
      check: normCheck(p.crossCheck !== undefined ? p.crossCheck : r.check),
      verified: p.verifiedCount !== undefined ? p.verifiedCount
                : (r.verified === 0 ? "" : r.verified),
      ctype: p.contentType !== undefined ? p.contentType
              : (r.ctype === "PRAPER" || r.ctype === "PERSONAL" ? r.ctype : "")
    };
  }
  function stage(r, patch) {
    var cur = state.pending[r.row] || {
      ocrCount: r.ocr === "" ? "" : r.ocr,
      crossCheck: normCheck(r.check),
      verifiedCount: r.verified === "" ? "" : r.verified,
      contentType: (r.ctype === "PRAPER" || r.ctype === "PERSONAL") ? r.ctype : ""
    };
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    // staged entry dissolves when it matches the ledger again (untouch)
    var unchanged =
      String(cur.ocrCount) === String(r.ocr === "" ? "" : r.ocr) &&
      normCheck(cur.crossCheck) === normCheck(r.check) &&
      String(cur.verifiedCount) === String(r.verified === "" ? "" : r.verified) &&
      String(cur.contentType || "") === String(r.ctype || "");
    if (unchanged) delete state.pending[r.row];
    else state.pending[r.row] = cur;
    syncDirtyBar();
    renderFeedRowState(r.row);
  }
  function pendingCount() { return Object.keys(state.pending).length; }

  /* ============================================================================
     GATE
     ========================================================================== */
  function gateError(msg) {
    var f = $("gateField");
    f.classList.add("is-error");
    $("gateErr").textContent = msg;
  }
  function gateBusy(on, msg) {
    var st = $("gateState");
    st.hidden = !on;
    st.textContent = msg || "";
    st.classList.toggle("is-fail", false);
    $("gateBtn").disabled = on;
  }

  function tryUnlock(key, silent) {
    if (!key) { if (!silent) gateError("Enter your admin password."); return Promise.resolve(false); }
    if (MOCK && key.length < 4) {
      if (!silent) gateError("Mock mode: any password with 4+ characters unlocks.");
      return Promise.resolve(false);
    }
    gateBusy(true, "VERIFYING…");
    return jsonp({ action: "ledger", key: key })
      .then(function (out) {
        gateBusy(false);
        if (!out || out.ok === false) {
          if (!silent) gateError((out && out.error) || "Access denied.");
          return false;
        }
        /* the login write doubles as the DEVICE CHECK — a name trying to
           unlock from somebody else's browser is refused BEFORE the console
           opens, and the denial lands in the AdminLog (LOGIN-DENIED) */
        return loginCheck(key).then(function (ok) {
          if (!ok) return false;
          unlockWith(key);
          ingest(out);
          return true;
        });
      })
      .catch(function (err) {
        gateBusy(false);
        if (!silent) gateError(err.message || "Could not reach the backend.");
        return false;
      });
  }

  /* login trail; resolves false when the backend refuses. The operator
     name comes FROM the backend (matched against the password) — knowing
     the password is the proof of identity, so there is no name picker and
     no device lock; the fingerprint rides along as audit context only. */
  function loginCheck(key) {
    var dev = deviceFingerprint();
    if (MOCK) {
      state.operator = "Demo Admin";
      try { sessionStorage.setItem(OP_STORE, "Demo Admin"); } catch (e) { /* ok */ }
      mockLog.unshift({ ts: new Date().toISOString(), operator: "Demo Admin",
        action: "LOGIN", target: "Control Room",
        detail: "gate unlocked (mock) · device " + String(dev).split("·")[0] });
      renderLog();
      showOperator();
      return Promise.resolve(true);
    }
    return gasPost({ action: "adminLogin", adminKey: key, device: dev })
      .then(function (out) {
        if (out && out.ok === false && out.error) {
          gateError(out.error);
          return false;
        }
        if (out && out.operator) {
          state.operator = out.operator;
          try { sessionStorage.setItem(OP_STORE, out.operator); } catch (e) { /* ok */ }
          showOperator();
        }
        return true;
      })
      .catch(function () {
        /* the log write is best-effort — a network hiccup on it must not
           lock a verified operator out of an already-verified key */
        return true;
      });
  }

  /* (legacy announceLogin absorbed into loginCheck — kept as a no-op-safe
     alias in case an older surface still calls it) */
  function announceLogin(key) { return loginCheck(key); }

  function unlockWith(key) {
    state.key = key;
    try { sessionStorage.setItem(KEY_STORE, key); } catch (e) { /* ok */ }
    $("gate").hidden = true;
    $("console").hidden = false;
    showOperator();
  }

  /* ============================================================================
     INGEST + FULL RENDER
     ========================================================================== */
  function ingest(out) {
    state.rows = (out.rows || []).map(function (r) {
      r.check = normCheck(r.check);
      r.claimed = (r.claimed === "" || r.claimed == null) ? "" : Number(r.claimed);
      r.ocr = (r.ocr === "" || r.ocr == null) ? "" : Number(r.ocr);
      r.verified = (r.verified === "" || r.verified == null) ? "" : Number(r.verified);
      r.ctype = (r.ctype === "PRAPER" || r.ctype === "PERSONAL") ? r.ctype : "";
      r.weekNum = weekOf(r.ts);
      return r;
    });
    state.players = out.players || [];
    /* identity map — verified tick + designation per player, read by the
       feed rows and the REPORTS player table; points/impressions/posts
       feed the review-modal participant card (season roll-up at a glance) */
    state.pmap = {};
    state.players.forEach(function (p) {
      state.pmap[String(p.player || "").toLowerCase()] = {
        designation: String(p.designation || ""),
        verified: !!p.verified,
        points: Number(p.points) || 0,
        impressions: Number(p.impressions) || 0,
        posts: Number(p.posts) || 0
      };
    });
    state.totals = out.totals || null;
    state.generatedAt = out.generatedAt || null;
    /* ROUND 35 — the submission switches, straight from the sheet */
    state.gates = (out.gates && typeof out.gates === "object") ? out.gates : null;
    if (out.operator) {
      state.operator = out.operator;
      try { sessionStorage.setItem(OP_STORE, out.operator); } catch (e) { /* ok */ }
      showOperator();
    }
    state.awards = Array.isArray(out.awards) ? out.awards : [];
    state.awardByWeek = {};
    state.awards.forEach(function (a) {
      var slot = state.awardByWeek[a.week] ||
        (state.awardByWeek[a.week] = { total: 0, list: [] });
      slot.total += Number(a.points) || 0;
      slot.list.push({ player: a.player, points: a.points, note: a.note });
    });
    if (Array.isArray(out.log)) state.log = out.log;
    else if (MOCK) state.log = mockLog;
    renderAll();
  }

  function pmapOf(name) {
    return state.pmap && state.pmap[String(name || "").toLowerCase()] || null;
  }

  function loadAll(silent) {
    if (!silent) setSync("SYNCING…");
    return jsonp({ action: "ledger", key: state.key })
      .then(function (out) {
        if (!out || out.ok === false) {
          setSync("SYNC FAILED");
          toast((out && out.error) || "Ledger sync failed", true);
          return;
        }
        ingest(out);
        toast("Ledger synced");
      })
      .catch(function (err) {
        setSync("SYNC FAILED");
        toast(err.message || "Ledger sync failed", true);
      });
  }

  function setSync(text) {
    var el = $("syncInfo");
    var n = state.rows.length;
    el.textContent = text || (n + " ROWS · " + fmtTS(state.generatedAt));
  }

  function renderAll() {
    buildFilterOptions();
    renderFeed();
    renderPlayers();
    renderAudit();
    renderReports();
    renderGates();
    renderLog();
    syncDirtyBar();
    setSync();
  }

  /* ============================================================================
     PHOTO LIGHTBOX — every picture is expandable. Admin shots already open
     the review modal; avatars (round pfps) open this simple viewer instead,
     so not everything lives in the same popup design.
     ========================================================================== */
  var PhotoLb = (function () {
    var root = null;
    function ensure() {
      if (root) return root;
      root = document.createElement("div");
      root.className = "pcl-lightbox pcl-photolb";
      root.hidden = true;
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", "Player photo");
      root.innerHTML = '<div class="pcl-lb-back" data-act="close"></div>' +
        '<figure class="pcl-photolb-card">' +
          '<img class="pcl-photolb-img" alt="Player photo" />' +
          '<figcaption class="pcl-photolb-line"></figcaption>' +
          '<button type="button" class="pcl-lb-close" data-act="close" aria-label="Close">' +
            '<span class="pcl-px-x" aria-hidden="true"></span></button>' +
        "</figure>";
      document.body.appendChild(root);
      root.addEventListener("click", function (ev) {
        if (ev.target.closest('[data-act="close"]')) close();
      });
      document.addEventListener("keydown", function (ev) {
        if (root && !root.hidden && ev.key === "Escape") close();
      });
      return root;
    }
    function open(src, name) {
      if (!src) return;
      var r = ensure();
      r.querySelector(".pcl-photolb-img").src = src;
      r.querySelector(".pcl-photolb-line").textContent =
        name ? "Player photo · " + name : "Player photo";
      r.hidden = false;
      document.body.style.overflow = "hidden";
    }
    function close() {
      if (!root) return;
      root.hidden = true;
      document.body.style.overflow = "";
    }
    return { open: open, close: close };
  })();

  /* ============================================================================
     FILTERS + FEED
     ========================================================================== */
  function filteredRows() {
    var q = state.filters.q.toLowerCase();
    return state.rows.filter(function (r) {
      if (state.filters.week !== "all" && String(r.weekNum) !== state.filters.week) return false;
      if (state.filters.format !== "all" && r.format !== state.filters.format) return false;
      if (state.filters.type !== "all" && r.type !== state.filters.type) return false;
      if (state.filters.ctype !== "all") {
        var d0 = displayOf(r);
        if ((d0.ctype || "") !== state.filters.ctype) return false;
      }
      if (state.filters.status !== "all") {
        var d = displayOf(r);
        if (state.filters.status === "VERIFIED") {
          /* DONE = the review finished on this row: cross-check MATCH (the
             reviewer confirmed the claim) OR a verified count typed in.
             Before this, DONE only counted a filled verified number, so a
             row saved as MATCH never appeared here and the tab "never
             updated" — MATCH is exactly what marks a row done. */
          if (d.check !== "MATCH" && d.verified === "") return false;
        } else if (d.check !== state.filters.status) return false;
      }
      if (q) {
        var hay = (r.name + " " + r.url + " " + r.mediaId + " " + r.id).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function buildFilterOptions() {
    var wk = $("fWeek"), fm = $("fFormat"), st = $("fStatus"), ty = $("fType");
    var keepWk = state.filters.week, keepFm = state.filters.format;

    var wHtml = '<option value="all">ALL WEEKS</option>';
    for (var w = 1; w <= WEEKS; w++) {
      wHtml += '<option value="' + w + '">WEEK ' + w + "</option>";
    }
    wk.innerHTML = wHtml;

    var formats = [];
    state.rows.forEach(function (r) {
      if (r.format && formats.indexOf(r.format) < 0) formats.push(r.format);
    });
    formats.sort();
    fm.innerHTML = '<option value="all">ALL FORMATS</option>' + formats.map(function (f) {
      return '<option value="' + esc(f) + '">' + esc(fmtShort(f)) + "</option>";
    }).join("");

    st.innerHTML = ["all", "PENDING OCR", "MATCH", "MISMATCH", "BOOST?", "VERIFIED"]
      .map(function (s) {
        return '<option value="' + s + '">' +
          (s === "all" ? "ALL STATUS" : s) + "</option>";
      }).join("");
    ty.innerHTML = ["all", "NEW", "UPDATE"].map(function (s) {
      return '<option value="' + s + '">' +
        (s === "all" ? "ALL TYPES" : s) + "</option>";
    }).join("");

    wk.value = keepWk; fm.value = keepFm; st.value = state.filters.status;
    ty.value = state.filters.type;
  }

  function feedRowHtml(r, idx) {
    var d = displayOf(r);
    var dirty = !!state.pending[r.row];
    /* shot thumb lives NEXT TO the media url (same block) — reviewer sees
       the claim and its evidence side by side; click opens the review */
    var thumb = r.thumb
      ? '<button type="button" class="pcl-thumbbox" data-act="open" data-i="' + idx +
        '" title="Open review"><img src="' + esc(r.thumb) + '" alt="Analytics screenshot" loading="lazy" /></button>'
      : '<button type="button" class="pcl-thumbbox is-missing" data-act="open" data-i="' + idx +
        '" title="Open review">NO SHOT</button>';
    /* round pfp everywhere + click-to-expand (photoData = direct src,
       photoId = Drive file → thumbnail urls) */
    var avSrc = r.photoData || (r.photoId
      ? "https://drive.google.com/thumbnail?id=" + encodeURIComponent(r.photoId) + "&sz=w80" : "");
    var avBig = r.photoData || (r.photoId
      ? "https://drive.google.com/thumbnail?id=" + encodeURIComponent(r.photoId) + "&sz=w800" : "");
    var avatar = avSrc
      ? '<button type="button" class="pcl-avatarbtn" data-photo="' + esc(avBig) +
        '" data-name="' + esc(r.name) + '" title="Expand photo">' +
        '<img class="pcl-avatar" src="' + esc(avSrc) + '" alt="" loading="lazy" /></button>'
      : "";
    var ident = pmapOf(r.name);
    var tick = ident && ident.verified ? TICK_SVG : "";
    var tags = '<span class="pcl-fr-tags">' +
      (r.type === "UPDATE" ? "" : '<span class="pcl-tag pcl-tag--new">NEW</span>') +
      collabBadgeHtml(r) +
      ctTagHtml(d.ctype) +
      (r.tracked && r.trackedViews !== "" && r.trackedViews !== undefined
        ? '<span class="pcl-tag pcl-tag--track" title="Latest platform-tracked count (SYNC NOW pipeline)">AUTO ' +
          esc(fmt(r.trackedViews)) + "</span>"
        : "") +
      (dirty ? '<span class="pcl-tag pcl-tag--dirty">STAGED</span>' : "") +
      "</span>";
    return '<div class="pcl-feedrow' + (dirty ? " is-dirty" : "") + '" data-row="' + r.row + '">' +
      '<span class="fr-who">' + avatar +
        '<span class="pcl-fr-whotext"><p class="pcl-fr-name"><span class="pcl-fr-nametext">' +
        esc(r.name) + tick + "</span>" + tags + "</p>" +
        '<p class="pcl-fr-sub">' + esc(fmtTS(r.ts)) + " IST · " + esc(r.manager || "–") +
        (ident && ident.designation ? ' · ' + esc(ident.designation) : "") +
        (r.collabWith ? ' · <b>⇄ ' + esc(r.collabWith) + "</b>" : "") + "</p></span>" +
      "</span>" +
      '<span class="fr-post">' + thumb +
        '<span class="pcl-fr-posttext">' +
          '<a class="pcl-fr-link" href="' + esc(safeHref(r.url)) + '" target="_blank" rel="noopener"' +
          ' title="' + esc(r.url) + '">#' + esc(postHashOf(r)) + "</a>" +
          '<span class="pcl-fr-fmt">' + brandBadgeAdm(r.format) + " <b>" + esc(multOf(r.mult)) +
            '</b> <span class="pcl-fr-id">· ' + esc(postHashOf(r)) + "</span>" +
            (r.weekNum ? ' <span class="pcl-fr-id">· W' + r.weekNum + "</span>" : "") +
          "</span>" +
        "</span>" +
      "</span>" +
      '<span class="fr-claimed"><small>CLAIMED</small>' + fmt(r.claimed) + "</span>" +
      '<span class="fr-ocr"><small>OCR</small>' + (d.ocr === "" ? "–" : fmt(d.ocr)) + "</span>" +
      '<span class="fr-verified"><input class="pcl-input" type="text" inputmode="numeric"' +
        ' data-edit="verified" data-row="' + r.row + '" value="' + esc(d.verified) +
        '" placeholder="–" aria-label="Verified count for row ' + r.row + '" /></span>' +
      '<span class="fr-status"><select class="pcl-input pcl-select" data-edit="status"' +
        ' data-row="' + r.row + '" data-v="' + esc(d.check) + '"' +
        ' aria-label="Cross-check status for row ' + r.row + '">' +
        ["PENDING OCR", "MATCH", "MISMATCH", "BOOST?"].map(function (s) {
          return '<option value="' + s + '"' + (s === d.check ? " selected" : "") + ">" + s + "</option>";
        }).join("") +
      "</select></span>" +
      "</div>";
  }

  function renderFeed() {
    var rows = filteredRows();
    var wrap = $("feedRows");
    wrap.innerHTML = rows.map(feedRowHtml).join("");
    $("feedEmpty").hidden = rows.length > 0;
    $("feedEmpty").textContent = state.rows.length
      ? "Nothing matches these filters."
      : "Ledger is empty — submissions will appear here.";
    renderQuickChips();
  }

  /* quick status chips — counts first, filters second. A non-technical
     panellist lands on the FEED and instantly sees what needs a human. */
  var QUICK_DEFS = [
    { key: "all",         label: "ALL" },
    { key: "PENDING OCR", label: "NEEDS REVIEW" },
    { key: "BOOST?",      label: "BOOST SUSPECT" },
    { key: "MISMATCH",    label: "MISMATCH" },
    { key: "VERIFIED",    label: "DONE" }
  ];
  function renderQuickChips() {
    var box = $("quickChips");
    if (!box) return;
    box.innerHTML = QUICK_DEFS.map(function (d) {
      var n = 0;
      state.rows.forEach(function (r) {
        var v = displayOf(r);
        if (d.key === "all") n++;
        else if (d.key === "VERIFIED") {
          /* same rule as the filter: MATCH or a verified count = done */
          if (v.check === "MATCH" || v.verified !== "") n++;
        }
        else if (v.check === d.key) n++;
      });
      var active = state.filters.status === d.key ? " is-active" : "";
      var tone = d.key === "BOOST?" || d.key === "MISMATCH" ? " pcl-qchip--hot" :
                 (d.key === "PENDING OCR" && n ? " pcl-qchip--todo" : "");
      return '<button type="button" class="pcl-qchip' + active + tone +
        '" data-qfilter="' + d.key + '">' + d.label +
        ' <b>' + n + "</b></button>";
    }).join("");
  }
  $("quickChips").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-qfilter]");
    if (!b) return;
    state.filters.status = b.getAttribute("data-qfilter");
    var st = $("fStatus");
    if (st) st.value = state.filters.status;   // keep the dropdown in step
    renderFeed();
  });

  /* keep staged values / dirty markers without a full re-render */
  function renderFeedRowState(rowNo) {
    var el = document.querySelector('.pcl-feedrow[data-row="' + rowNo + '"]');
    var r = null;
    state.rows.forEach(function (x) { if (x.row === rowNo) r = x; });
    if (!el || !r) return;
    var d = displayOf(r);
    var dirty = !!state.pending[rowNo];
    el.classList.toggle("is-dirty", dirty);
    var tags = el.querySelector(".pcl-fr-tags");
    if (tags) {
      var html = r.type === "UPDATE"
        ? ""
        : '<span class="pcl-tag pcl-tag--new">NEW</span>';
      html += collabBadgeHtml(r);
      html += ctTagHtml(d.ctype);
      if (dirty) html += '<span class="pcl-tag pcl-tag--dirty">STAGED</span>';
      tags.innerHTML = html;
    }
    var sel = el.querySelector('[data-edit="status"]');
    if (sel && document.activeElement !== sel) {
      sel.value = d.check;
      sel.setAttribute("data-v", d.check);
    }
    var inp = el.querySelector('[data-edit="verified"]');
    if (inp && document.activeElement !== inp) inp.value = d.verified;
  }

  /* delegated inline edits */
  $("feedRows").addEventListener("input", function (ev) {
    var inp = ev.target.closest('[data-edit="verified"]');
    if (!inp) return;
    var rowNo = Number(inp.getAttribute("data-row"));
    var r = rowByNo(rowNo);
    if (r) stage(r, { verifiedCount: digitsOf(inp.value) });
  });
  $("feedRows").addEventListener("change", function (ev) {
    var sel = ev.target.closest('[data-edit="status"]');
    if (!sel) return;
    var rowNo = Number(sel.getAttribute("data-row"));
    var r = rowByNo(rowNo);
    if (r) stage(r, { crossCheck: sel.value });
  });
  $("feedRows").addEventListener("click", function (ev) {
    var av = ev.target.closest("[data-photo]");
    if (av) {
      PhotoLb.open(av.getAttribute("data-photo"), av.getAttribute("data-name"));
      return;
    }
    var btn = ev.target.closest('[data-act="open"]');
    if (!btn) return;
    openReview(Number(btn.getAttribute("data-i")));
  });

  function rowByNo(no) {
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].row === no) return state.rows[i];
    }
    return null;
  }

  /* filter wiring */
  $("fSearch").addEventListener("input", function () {
    state.filters.q = this.value.trim();
    renderFeed();
  });
  $("fWeek").addEventListener("change", function () {
    state.filters.week = this.value; renderFeed();
  });
  $("fFormat").addEventListener("change", function () {
    state.filters.format = this.value; renderFeed();
  });
  $("fStatus").addEventListener("change", function () {
    state.filters.status = this.value; renderFeed();
  });
  $("fCtype").addEventListener("change", function () {
    state.filters.ctype = this.value; renderFeed();
  });
  $("fType").addEventListener("change", function () {
    state.filters.type = this.value; renderFeed();
  });

  /* ============================================================================
     DIRTY BAR — stage → save (one batched write) / discard
     ========================================================================== */
  function syncDirtyBar() {
    var n = pendingCount();
    $("dirtyBar").hidden = n === 0;
    $("dirtyText").textContent = n + " UNSAVED " + (n === 1 ? "ROW" : "ROWS");
    /* reserve a footer-free lane for the sticky capsule — with the class on,
       the page grows extra scroll space below the footer so the capsule can
       never sit on top of the footer text */
    document.body.classList.toggle("pcl-dirty-open", n > 0);
    renderAudit();  // audit cards carry staged flags too
  }

  $("dirtyBar").addEventListener("click", function (ev) {
    var act = ev.target.closest("[id]");
    if (!act) return;
    if (act.id === "saveBtn") savePending();
    else if (act.id === "discardBtn") {
      state.pending = {};
      syncDirtyBar();
      renderFeed();
      toast("Staged changes discarded");
    }
  });

  function savePending() {
    var rows = Object.keys(state.pending).map(function (no) {
      var p = state.pending[no];   // always carries all four keys
      return {
        row: Number(no),
        ocrCount: p.ocrCount,
        crossCheck: p.crossCheck,
        verifiedCount: p.verifiedCount,
        contentType: p.contentType
      };
    });
    if (!rows.length) return;
    $("saveBtn").disabled = true;
    $("saveBtn").textContent = "SAVING…";
    gasPost({ action: "adminVerify", adminKey: state.key,
              updates: rows })
      .then(function (out) {
        if (!out || out.ok === false) {
          throw new Error((out && (out.error || (out.errors && out.errors[0] &&
            out.errors[0].error))) || "Write failed");
        }
        state.pending = {};
        toast("Saved " + out.updated + " row" + (out.updated === 1 ? "" : "s") + " to the ledger");
        return loadAll(true);
      })
      .catch(function (err) {
        toast(err.message || "Save failed — nothing was written", true);
      })
      .finally(function () {
        $("saveBtn").disabled = false;
        $("saveBtn").textContent = "SAVE CHANGES";
      });
  }

  /* ============================================================================
     REVIEW MODAL — screenshot side-by-side verification
     ========================================================================== */
  var rvIdx = -1;

  function rvList() { return filteredRows(); }

  function openReview(idx) {
    var list = rvList();
    if (!list.length) return;
    rvIdx = ((idx % list.length) + list.length) % list.length;
    fillReview(list[rvIdx], rvIdx, list.length);
    $("reviewModal").hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeReview() {
    $("reviewModal").hidden = true;
    document.body.style.overflow = "";
    rvIdx = -1;
  }
  function rvStep(dir) {
    var list = rvList();
    if (!list.length || rvIdx < 0) return;
    rvIdx = ((rvIdx + dir) % list.length + list.length) % list.length;
    fillReview(list[rvIdx], rvIdx, list.length);
  }

  function bigThumb(r) {
    if (MOCK) return r.thumb || "";   // mock: stay on the offline placeholder
    var id = r.fileId || driveIdAdm(r.shotUrl);
    if (!id) return "";
    return "https://drive.google.com/thumbnail?id=" + encodeURIComponent(id) + "&sz=w1600";
  }

  /* ---------- screening media (the CEO room's stability contract) -------
     Platform embed when the platform allows one (YouTube, Instagram), the
     participant's analytics screenshot otherwise (LinkedIn blocks in-page
     playback entirely), and a POST / SCREENSHOT switch whenever both exist
     — a blank IG embed never strands the reviewer. ----------------------- */
  function ytIdAdm(url) {
    var m = String(url || "").match(
      /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : "";
  }
  function igIdAdm(url) {
    var m = String(url || "").match(/instagram\.com\/(?:reel|reels|p|tv)\/([\w-]+)/);
    return m ? m[1] : "";
  }
  function driveIdAdm(u) {
    var s = String(u || "");
    var m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/) ||
            s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    return m ? m[1] : "";
  }
  var rvMediaMode = null;      // "post" | "shot" — reset on every row
  var rvCurrent = null;        // row behind the open modal

  function renderRvMedia(r) {
    var box = $("rvStageBox");
    var seg = $("rvSeg");
    var fileId = r.fileId || driveIdAdm(r.shotUrl);
    var shotOk = !!fileId && !MOCK || (MOCK && !!r.thumb);
    var yt = ytIdAdm(r.url);
    var ig = yt ? "" : igIdAdm(r.url);
    var postOk = !!(yt || ig);
    if (rvMediaMode !== "post" && rvMediaMode !== "shot") {
      rvMediaMode = postOk ? "post" : (shotOk ? "shot" : "none");
    }
    if (rvMediaMode === "post" && !postOk) rvMediaMode = shotOk ? "shot" : "none";
    if (rvMediaMode === "shot" && !shotOk) rvMediaMode = postOk ? "post" : "none";

    if (rvMediaMode === "post") {
      box.classList.add("is-embed");
      box.innerHTML = yt
        ? '<iframe src="https://www.youtube-nocookie.com/embed/' + esc(yt) +
          '" title="League entry" allow="accelerometer; autoplay; ' +
          'clipboard-write; encrypted-media; gyroscope; picture-in-picture" ' +
          'allowfullscreen loading="lazy"></iframe>'
        : '<iframe src="https://www.instagram.com/reel/' + esc(ig) +
          '/embed" title="League entry" scrolling="no" loading="lazy"></iframe>';
    } else {
      box.classList.remove("is-embed");
      var src = bigThumb(r);
      if (src) {
        box.innerHTML = '<img id="rvImg" class="pcl-rv-img" alt="Analytics screenshot · ' +
          esc(r.name || "") + '" src="' + esc(src) + '" />';
      } else {
        box.innerHTML = '<span class="pcl-rv-missing">NO SCREENSHOT ON FILE — OPEN THE ORIGINAL POST</span>';
      }
    }
    if (postOk && shotOk) {
      seg.hidden = false;
      $("rvSegPost").classList.toggle("is-on", rvMediaMode === "post");
      $("rvSegShot").classList.toggle("is-on", rvMediaMode === "shot");
    } else {
      seg.hidden = true;
    }
  }

  /* this player's season roll-up — unique media, newest snapshot wins,
     views = verified when the review filled it, else claimed */
  function playerVideos(name) {
    var key = normName(name);
    var byMedia = {};
    state.rows.forEach(function (r) {
      if (normName(r.name) !== key) return;
      var k = r.mediaId || "row:" + r.row;
      var cur = byMedia[k];
      if (!cur || String(r.ts).localeCompare(String(cur.ts)) > 0) byMedia[k] = r;
    });
    return Object.keys(byMedia).map(function (k) { return byMedia[k]; })
      .sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });
  }
  function viewsOf(r) {
    var v = digitsOf(r.verified);
    if (v === "") v = digitsOf(r.claimed);
    return v === "" ? null : v;
  }
  function initialsOf(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?").charAt(0) + (parts[1] ? parts[1].charAt(0) : ""))
      .toUpperCase();
  }
  function normName(s) {
    return String(s || "").toLowerCase().trim();
  }

  /* live score preview — verified (or OCR / claimed) × multiplier, rounded
     up exactly like the backend; the reviewer never does math */
  function updateRvScore() {
    var el = $("rvScore");
    var r = rvCurrent;
    if (!r) { el.hidden = true; return; }
    var mult = Number(r.mult);
    var base = digitsOf($("rvVerified").value);
    var what = "verified";
    if (base === "") { base = digitsOf($("rvOcr").value); what = "OCR"; }
    if (base === "") { base = digitsOf(r.claimed); what = "claimed"; }
    if (base === "" || isNaN(mult) || mult <= 0) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = "<b>" + fmt(Math.ceil(base * mult)) + " pts</b> if the " +
      what + " count stands — " + fmt(base) + " " + multOf(r.mult) +
      ", rounded up";
  }

  function fillReview(r, idx, total) {
    var d = displayOf(r);
    rvCurrent = r;
    rvMediaMode = null;
    renderRvMedia(r);

    var link = $("rvShotLink");
    if (r.shotUrl) { link.href = safeHref(r.shotUrl); link.style.display = ""; }
    else link.style.display = "none";

    $("rvNum").textContent = "#" + (idx + 1) + " / " + total + " · LEDGER ROW " + r.row +
      (r.mediaId ? " · " + r.mediaId : "");

    /* participant card — round pfp with an initials fallback, designation +
       manager on the identity line (everything a reviewer cross-checks) */
    var ident = pmapOf(r.name);
    var avSrc = r.photoData || (r.photoId
      ? "https://drive.google.com/thumbnail?id=" + encodeURIComponent(r.photoId) + "&sz=w160" : "");
    var avBig = r.photoData || (r.photoId
      ? "https://drive.google.com/thumbnail?id=" + encodeURIComponent(r.photoId) + "&sz=w800" : "");
    var avaBtn = $("rvPavaBtn");
    avaBtn.hidden = false;
    avaBtn.disabled = !avSrc;
    avaBtn.setAttribute("data-photo", avBig || "");
    avaBtn.setAttribute("data-name", r.name || "");
    var avaImg = $("rvPava");
    if (avSrc) { avaImg.src = avSrc; avaImg.style.display = ""; }
    else { avaImg.removeAttribute("src"); avaImg.style.display = "none"; }
    $("rvPavaIni").textContent = initialsOf(r.name);
    $("rvPlayer").textContent = r.name;
    var dEl = $("rvDesig");
    var dParts = [];
    if (ident && ident.designation) dParts.push("Desg. · " + ident.designation);
    if (r.manager) dParts.push("Manager · " + r.manager);
    if (dParts.length) {
      dEl.textContent = dParts.join("  ·  ");
      dEl.hidden = false;
    } else {
      dEl.textContent = "";
      dEl.hidden = true;
    }

    $("rvMeta").textContent = fmtShort(r.format) + " " + multOf(r.mult) +
      " · " + (r.type === "UPDATE" ? "UPDATE SNAPSHOT S" + r.snap : "FIRST REPORT") +
      (r.collabStatus === "CONFIRMED"
        ? " · COLLAB · FULL with " + (r.collabWith || "partner")
        : (r.collabStatus === "PENDING" ? " · COLLAB? with " + (r.collabWith || "?") : "")) +
      " · " + fmtTS(r.ts) + " IST";
    var l = $("rvLink");
    l.href = safeHref(r.url);
    l.textContent = "#" + postHashOf(r) + " ↗";
    l.title = r.url;
    $("rvClaimed").textContent = fmt(r.claimed);
    $("rvSnap").textContent = "S" + r.snap;
    $("rvWeek").textContent = r.weekNum ? "W" + r.weekNum : "–";

    /* season roll-up — videos + total views + points, then per-video rows
       (newest snapshot of each post; the open one highlighted) */
    var vids = playerVideos(r.name);
    var totalViews = 0, anyView = false;
    vids.forEach(function (v) {
      var x = viewsOf(v);
      if (x != null) { totalViews += x; anyView = true; }
    });
    var season = $("rvSeason");
    season.hidden = false;
    season.innerHTML =
      '<span class="pcl-rv-sitem"><b>' + vids.length + "</b> VIDEO" +
        (vids.length === 1 ? "" : "S") + "</span>" +
      '<span class="pcl-rv-sitem"><b>' + (anyView ? fmt(totalViews) : "–") +
        "</b> TOTAL VIEWS</span>" +
      (ident && ident.points
        ? '<span class="pcl-rv-sitem"><b>' + fmt(ident.points) + "</b> SEASON PTS</span>"
        : "");
    var vl = $("rvVlist");
    vl.hidden = vids.length === 0;
    vl.innerHTML = vids.map(function (v) {
      var x = viewsOf(v);
      return '<span class="pcl-rv-vitem' + (v.row === r.row ? " is-cur" : "") + '">' +
        '<span class="pcl-rv-vfmt">' + brandBadgeAdm(v.format) + "</span>" +
        '<span class="pcl-rv-vviews">' + (x == null ? "–" : fmt(x)) + " views</span>" +
        '<span class="pcl-rv-vs">S' + esc(v.snap) + " · W" + (v.weekNum || "?") + "</span>" +
        "</span>";
    }).join("");

    $("rvOcr").value = d.ocr === "" ? "" : d.ocr;
    $("rvVerified").value = d.verified === "" ? "" : d.verified;
    $("rvStatus").value = d.check;
    $("rvCtype").value = d.ctype || "";
    updateRvScore();
    $("rvOcrNote").textContent = "";
    $("rvScanBtn").disabled = false;
  }

  $("reviewModal").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "close") closeReview();
    else if (act === "prev") rvStep(-1);
    else if (act === "next") rvStep(1);
  });
  /* POST / SCREENSHOT switch — same contract as the CEO screening room */
  $("rvSegPost").addEventListener("click", function () {
    if (rvCurrent && rvMediaMode !== "post") {
      rvMediaMode = "post";
      renderRvMedia(rvCurrent);
    }
  });
  $("rvSegShot").addEventListener("click", function () {
    if (rvCurrent && rvMediaMode !== "shot") {
      rvMediaMode = "shot";
      renderRvMedia(rvCurrent);
    }
  });
  /* the score preview follows every keystroke in the count fields */
  $("rvOcr").addEventListener("input", updateRvScore);
  $("rvVerified").addEventListener("input", updateRvScore);
  /* expanding the participant photo reuses the shared picture lightbox */
  $("rvPavaBtn").addEventListener("click", function () {
    var big = this.getAttribute("data-photo");
    if (big) PhotoLb.open(big, this.getAttribute("data-name"));
  });
  /* clicking the screenshot stage opens the full-res shot */
  $("rvStageBox").addEventListener("click", function (ev) {
    if (!ev.target.classList || !ev.target.classList.contains("pcl-rv-img")) return;
    if (rvCurrent && rvCurrent.shotUrl) {
      window.open(safeHref(rvCurrent.shotUrl), "_blank", "noopener");
    }
  });
  /* a Drive thumbnail that refuses to load degrades to the missing-shot
     note instead of a broken-image icon in the reviewer's face */
  $("rvStageBox").addEventListener("error", function (ev) {
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains("pcl-rv-img")) return;
    $("rvStageBox").innerHTML =
      '<span class="pcl-rv-missing">SCREENSHOT UNAVAILABLE — OPEN THE ORIGINAL POST</span>';
  }, true);
  document.addEventListener("keydown", function (ev) {
    if ($("reviewModal").hidden) return;
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") {
      if (ev.key === "Escape") { ev.target.blur(); closeReview(); }
      return;
    }
    if (ev.key === "Escape") closeReview();
    else if (ev.key === "ArrowLeft") rvStep(-1);
    else if (ev.key === "ArrowRight") rvStep(1);
  });

  /* OCR scan (semi-auto) */
  $("rvScanBtn").addEventListener("click", function () {
    var list = rvList();
    if (rvIdx < 0 || !list[rvIdx]) return;
    var r = list[rvIdx];
    if (!r.fileId) {
      $("rvOcrNote").textContent = "This row has no screenshot on file.";
      return;
    }
    var btn = this;
    btn.disabled = true;
    $("rvOcrNote").textContent = "SCANNING…";
    jsonp({ action: "ocr", key: state.key, fileId: r.fileId,
            claimed: r.claimed === "" ? 0 : r.claimed })
      .then(function (out) {
        btn.disabled = false;
        if (!out || out.ok === false) {
          $("rvOcrNote").textContent = (out && out.error) || "OCR failed.";
          return;
        }
        /* ad/boost mark re-check — the same verdict the form enforces at
           attach, now from the reviewer's side (server re-reads the shot
           with Drive OCR; ocrBoost_ scans its text) */
        var adWarn = out.boost
          ? "  ⚠ AD MARK FOUND: " + out.boost + " — boosted/sponsored content scores nothing (rulebook §6). Stage BOOST? or reject."
          : "";
        if (out.suggested === "" || out.suggested == null) {
          $("rvOcrNote").textContent = out.boost
            ? "AD MARK FOUND: " + out.boost + " — no view count to suggest. This screenshot shows boosted/sponsored content; stage BOOST? or reject."
            : "OCR ran but found no view/impression numbers — type it manually.";
          return;
        }
        $("rvOcr").value = out.suggested;
        var extra = (out.found || []).filter(function (n) { return n !== out.suggested; });
        $("rvOcrNote").textContent = "Suggested from the screenshot" +
          (extra.length ? " · also saw: " + extra.slice(0, 4).map(fmt).join(", ") : "") +
          " — confirm against the image before staging." + adWarn;
        updateRvScore();
      })
      .catch(function (err) {
        btn.disabled = false;
        $("rvOcrNote").textContent = err.message || "OCR failed.";
      });
  });

  /* stage from the modal */
  $("rvStageBtn").addEventListener("click", function () {
    var list = rvList();
    if (rvIdx < 0 || !list[rvIdx]) return;
    var r = list[rvIdx];
    stage(r, {
      ocrCount: digitsOf($("rvOcr").value),
      verifiedCount: digitsOf($("rvVerified").value),
      crossCheck: $("rvStatus").value,
      contentType: $("rvCtype").value || ""
    });
    toast("Row staged — SAVE CHANGES writes it");
  });

  /* ============================================================================
     AUDIT — snapshot timelines per Media ID
     ========================================================================== */
  function auditGroups() {
    var byMedia = {};
    state.rows.forEach(function (r) {
      if (!r.mediaId) return;
      (byMedia[r.mediaId] = byMedia[r.mediaId] || []).push(r);
    });
    return Object.keys(byMedia)
      .map(function (mid) {
        var rows = byMedia[mid].slice().sort(function (a, b) {
          return String(a.ts).localeCompare(String(b.ts));
        });
        return { mediaId: mid, rows: rows };
      })
      .filter(function (g) { return g.rows.length > 1; })
      .sort(function (a, b) {
        return String(b.rows[b.rows.length - 1].ts)
          .localeCompare(String(a.rows[a.rows.length - 1].ts));
      });
  }

  function renderAudit() {
    var wrap = $("auditList");
    if (!wrap) return;
    var groups = auditGroups();
    $("auditEmpty").hidden = groups.length > 0;
    wrap.innerHTML = groups.map(function (g) {
      var first = g.rows[0], last = g.rows[g.rows.length - 1];
      var liftPct = first.claimed ? ((last.claimed - first.claimed) / first.claimed) * 100 : 0;
      var hours = (new Date(last.ts) - new Date(first.ts)) / 3600000;
      var hot = liftPct > 50 && hours < 72;
      var d = displayOf(last);
      var flagged = d.check === "BOOST?";

      var timeline = g.rows.map(function (r, i) {
        var html = '<div class="pcl-snap">' +
          '<p class="pcl-snap-label">S' + esc(r.snap) + " · " + esc(fmtTS(r.ts)) + "</p>" +
          '<p class="pcl-snap-count">' + fmt(r.claimed) + "</p>" +
          '<p class="pcl-snap-date">claimed · ' + esc(fmtShort(r.format)) + "</p></div>";
        if (i < g.rows.length - 1) {
          var nxt = g.rows[i + 1];
          var dpct = r.claimed
            ? ((nxt.claimed - r.claimed) / r.claimed) * 100 : 0;
          var dh = (new Date(nxt.ts) - new Date(r.ts)) / 3600000;
          var cls = dpct > 50 && dh < 72 ? "is-hot" : (dpct >= 0 ? "is-calm" : "");
          html += '<span class="pcl-delta ' + cls + '">' +
            (dpct >= 0 ? "+" : "") + Math.round(dpct) + "% · " + Math.round(dh) + "h</span>";
        }
        return html;
      }).join("");

      return '<div class="pcl-auditcard">' +
        '<div class="pcl-audit-head">' +
          '<p class="pcl-audit-id">' + esc(g.mediaId) + "</p>" +
          '<span class="pcl-fr-fmt"><b>' + esc(fmtShort(last.format)) + "</b> " + esc(multOf(last.mult)) + "</span>" +
          '<p class="pcl-audit-player">' + esc(first.name) + " · " + g.rows.length + " snapshots · lift " +
            (liftPct >= 0 ? "+" : "") + Math.round(liftPct) + "% over " + Math.round(hours) + "h</p>" +
          (hot && !flagged ? '<span class="pcl-watch">WATCH</span>' : "") +
          '<button type="button" class="pcl-abtn pcl-abtn--small" data-audit-flag="' +
            esc(g.mediaId) + '">' + (flagged ? "CLEAR FLAG" : "FLAG BOOST?") + "</button>" +
        "</div>" +
        '<div class="pcl-timeline">' + timeline + "</div>" +
        "</div>";
    }).join("");
  }

  $("auditList").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-audit-flag]");
    if (!btn) return;
    var mid = btn.getAttribute("data-audit-flag");
    var g = auditGroups().filter(function (x) { return x.mediaId === mid; })[0];
    if (!g) return;
    var last = g.rows[g.rows.length - 1];
    var flagged = displayOf(last).check === "BOOST?";
    stage(last, { crossCheck: flagged ? "PENDING OCR" : "BOOST?" });
    toast(flagged ? "Flag cleared (staged)" : "BOOST? staged on the latest snapshot");
  });

  /* ============================================================================
     PLAYERS — the ALL PARTICIPANTS list view (tab 2). Built for a
     non-technical panellist: one card per participant, big readable numbers,
     two filters only. Each filter flips direction on re-click — POINTS opens
     highest-first, A–Z opens A→Z — and BOTH direction arrows stay visible
     with the live one lit, so the active sort is never a guess. The points
     filter carries toggleable sub-metrics: POINTS / VIEWS / APPS (views =
     latest claimed count per unique post; apps = number of applications).
     ========================================================================== */
  function playerAgg() {
    var map = {};
    function blank(name) {
      return { name: name || "", manager: "", apps: 0, posts: 0, uniqueMedia: 0,
               ppts: 0, vpts: 0, views: 0, photoId: "",
               lastTs: "", lastUrl: "", lastFormat: "", formatRatio: {},
               plats: {}, balance: {} };
    }
    state.players.forEach(function (p) {
      var a = map[String(p.player || "").toLowerCase()] = blank(p.player);
      a.manager = p.manager || "";
      a.apps = Number(p.submissions) || 0;
      a.posts = Number(p.posts) || 0;
      a.uniqueMedia = Number(p.uniqueMedia) || 0;
      a.ppts = Number(p.projectedPoints) || 0;
      a.vpts = Number(p.verifiedPoints) || 0;
      a.formatRatio = p.formatRatio || {};
    });
    state.rows.forEach(function (r) {
      var a = map[String(r.name || "").toLowerCase()];
      if (a && r.photoData && !a.photoData) a.photoData = r.photoData;
    });
    /* views: sum the LATEST snapshot's claimed count per unique media —
       plain row sums would double-count every UPDATE re-report */
    var latestByMedia = {};
    state.rows.forEach(function (r) {
      var k = String(r.name || "").toLowerCase() + "|" + String(r.mediaId || r.id || r.url || "");
      var prev = latestByMedia[k];
      if (!prev || String(r.ts).localeCompare(String(prev.ts)) > 0) latestByMedia[k] = r;
    });
    Object.keys(latestByMedia).forEach(function (k) {
      var r = latestByMedia[k];
      var a = map[String(r.name || "").toLowerCase()];
      if (!a) { a = map[String(r.name || "").toLowerCase()] = blank(r.name); }
      a.views += Number(r.claimed) || 0;
      var isNewer = !a.lastTs || String(r.ts).localeCompare(String(a.lastTs)) > 0;
      if (isNewer) { a.lastTs = r.ts; a.lastUrl = r.url || ""; a.lastFormat = r.format || ""; }
      if (r.photoId && (isNewer || !a.photoId)) a.photoId = r.photoId;
    });
    /* platform presence + the 50:50 balance per platform (rulebook §6) —
       every ledger row carries its PRAPER/PERSONAL tag, so the balance is
       computed straight from the data the Control Room reviews */
    state.rows.forEach(function (r) {
      var a = map[String(r.name || "").toLowerCase()];
      if (!a) return;
      var pk = platKeyOf(r);
      if (!pk) return;
      a.plats[pk] = true;
      var b = a.balance[pk] || (a.balance[pk] = { p: 0, pe: 0 });
      var d = displayOf(r);
      if (d.ctype === "PERSONAL") b.pe++;
      else if (d.ctype === "PRAPER") b.p++;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  /* per-platform balance chips: "IG 5:5" green when balanced (|p−pe| ≤ 1
     allows rounding slack), amber when the 50:50 rule is drifting */
  function balanceHtml(a) {
    var names = { ig: "IG", yt: "YT", li: "LI" };
    return Object.keys(a.balance || {}).map(function (pk) {
      var b = a.balance[pk];
      var n = b.p + b.pe;
      if (!n) return "";
      var off = Math.abs(b.p - b.pe) > 1;
      return '<span class="pcl-bal' + (off ? " is-off" : "") + '" title="' +
        esc(names[pk] + " · " + b.p + " Praper : " + b.pe + " Personal" +
            (off ? " — off the 50:50 balance" : " — 50:50 OK")) + '">' +
        names[pk] + " <b>" + b.p + ":" + b.pe + "</b></span>";
    }).join("");
  }

  function mixShort(a) {
    var keys = Object.keys(a.formatRatio || {});
    if (!keys.length) return "";
    return keys.slice(0, 2).map(function (f) {
      return "<b>" + a.formatRatio[f] + "×</b> " + brandBadgeAdm(f);
    }).join(" · ") + (keys.length > 2 ? " +" + (keys.length - 2) : "");
  }
  /* bare media tail → the #hash chip (mediaTail expects prefixed ids) */
  function tail8(t) {
    t = String(t || "");
    return t.length > 8 ? t.slice(0, 8) + "…" : t;
  }

  function pstat(label, val, lead) {
    return '<div class="pcl-pstat' + (lead ? " pcl-pstat--lead" : "") + '">' +
      "<small>" + label + "</small><b>" + val + "</b></div>";
  }

  function playerCardHtml(a, idx) {
    var ident = pmapOf(a.name);
    var ver = !!(ident ? ident.verified : false);
    var tick = ver ? TICK_SVG : "";
    var desig = (ident && ident.designation) || "";
    var rank = idx + 1;
    var avatar = a.photoData || a.photoId
      ? '<button type="button" class="pcl-pavatarbtn" data-photo="' +
        esc(a.photoData || ("https://drive.google.com/thumbnail?id=" +
          encodeURIComponent(a.photoId) + "&sz=w800")) + '" data-name="' + esc(a.name) +
        '" title="Expand photo"><img class="pcl-pavatar" src="' +
        esc(a.photoData || ("https://drive.google.com/thumbnail?id=" +
          encodeURIComponent(a.photoId) + "&sz=w96")) + '" alt="" loading="lazy" /></button>'
      : '<span class="pcl-pavatar pcl-pavatar--letter" aria-hidden="true">' +
        esc((a.name || "?").charAt(0).toUpperCase()) + "</span>";
    var latest = a.lastUrl
      ? '<a class="pcl-plink" href="' + esc(safeHref(a.lastUrl)) + '" target="_blank" rel="noopener" title="' +
        esc(a.lastUrl) + '">' + (a.lastFormat ? brandBadgeAdm(a.lastFormat) + " " : "") +
        "#" + esc(tail8(mediaIdOfUrl(a.lastUrl))) + " &#8599;</a>"
      : '<span class="pcl-plink is-none">No posts yet</span>';
    var bal = balanceHtml(a);
    return '<div class="pcl-pcard">' +
      '<span class="pcl-prank">' + rank + "</span>" +
      avatar +
      '<div class="pcl-pid">' +
        '<p class="pcl-pname"><span class="pcl-pnametext">' + esc(a.name) + tick + "</span></p>" +
        '<p class="pcl-psub">' +
          (desig ? '<span class="pcl-pdesig">' + esc(desig) + "</span> · " : "") +
          "mgr " + esc(a.manager || "–") +
          (mixShort(a) ? ' · <span class="pcl-pmix">' + mixShort(a) + "</span>" : "") +
        "</p>" +
        (bal ? '<p class="pcl-pbal">' + bal + "</p>" : "") +
      "</div>" +
      '<div class="pcl-pstats">' +
        pstat("VERIFIED PTS", a.vpts ? fmt(a.vpts) : "–", true) +
        pstat("PROJECTED", fmt(a.ppts)) +
        pstat("VIEWS", fmt(a.views)) +
        pstat("POSTS", a.uniqueMedia) +
        pstat("APPS", a.apps) +
      "</div>" +
      '<div class="pcl-pact">' + latest +
        '<button type="button" class="pcl-abtn pcl-abtn--small pcl-pvbtn' +
          (ver ? " is-on" : "") + '" data-pv-name="' + esc(a.name) +
          '" data-pv-to="' + (ver ? "0" : "1") + '" title="Confirm photo + designation against ' +
          'name · manager · designation before the tick goes live">' +
          (ver ? "CLEAR TICK" : "CONFIRM ID") + "</button>" +
      "</div>" +
      "</div>";
  }
  function mediaIdOfUrl(url) {
    try {
      var u = new URL(url, "https://x");
      var m = (u.pathname || "").match(/\/(?:reel|reels|tv|p)\/([A-Za-z0-9_-]+)/i) ||
              (u.pathname || "").match(/\/(?:posts|pulse)\/([A-Za-z0-9_-]+)/i) ||
              (u.pathname || "").match(/\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]+)/i) ||
              (u.searchParams.get("v") ? [null, u.searchParams.get("v")] : null) ||
              (u.hostname === "youtu.be" ? (u.pathname || "").match(/^\/([A-Za-z0-9_-]+)/) : null) ||
              String(url).match(/activity[-:](\d{10,})/i);
      return m ? m[1] : "";
    } catch (e) { return ""; }
  }

  function renderPlayers() {
    var wrap = $("playersList");
    if (!wrap) return;
    var list = playerAgg();
    var q = state.pq.toLowerCase();
    if (q) {
      list = list.filter(function (a) {
        return (a.name + " " + a.manager).toLowerCase().indexOf(q) >= 0;
      });
    }
    /* platform picker — only participants who posted on EVERY chosen app */
    if (state.plats.length) {
      list = list.filter(function (a) {
        return state.plats.every(function (pk) { return a.plats && a.plats[pk]; });
      });
    }
    var s = state.psort;
    var dir = s.mode === "alpha" ? s.adir : s.pdir;
    var mul = dir === "asc" ? 1 : -1;
    list.sort(function (x, y) {
      var v;
      if (s.mode === "alpha") {
        v = String(x.name || "").localeCompare(String(y.name || ""));
      } else if (s.metric === "views") {
        v = (x.views - y.views) || ((x.vpts + x.ppts) - (y.vpts + y.ppts));
      } else {
        v = (x.vpts - y.vpts) || (x.ppts - y.ppts);   // verified leads, projected breaks ties
      }
      return mul * (v || String(x.name || "").localeCompare(String(y.name || "")));
    });
    wrap.innerHTML = list.map(playerCardHtml).join("");
    $("playersEmpty").hidden = list.length > 0;
    syncSortUi();
  }

  /* filter UI state — the active filter lights up and shows WHICH side
     (high→low or low→high) it is presenting right now */
  function syncSortUi() {
    var s = state.psort;
    var pb = $("sortPoints"), ab = $("sortAlpha"), pg = $("pointsGroup");
    if (!pb || !ab) return;
    pb.classList.toggle("is-active", s.mode === "points");
    ab.classList.toggle("is-active", s.mode === "alpha");
    pb.setAttribute("aria-pressed", String(s.mode === "points"));
    ab.setAttribute("aria-pressed", String(s.mode === "alpha"));
    pb.setAttribute("data-dir", s.mode === "points" ? s.pdir : "");
    ab.setAttribute("data-dir", s.mode === "alpha" ? s.adir : "");
    pg.classList.toggle("is-active", s.mode === "points");
    Array.prototype.forEach.call(document.querySelectorAll(".pcl-subchip"), function (c) {
      c.classList.toggle("is-active",
        s.mode === "points" && c.getAttribute("data-metric") === s.metric);
    });
  }

  $("sortPoints").addEventListener("click", function () {
    var s = state.psort;
    if (s.mode !== "points") s.mode = "points";        // back to points, keep its last direction
    else s.pdir = s.pdir === "desc" ? "asc" : "desc";  // re-click flips high ↔ low
    renderPlayers();
  });
  $("sortAlpha").addEventListener("click", function () {
    var s = state.psort;
    if (s.mode !== "alpha") s.mode = "alpha";          // first click opens A→Z
    else s.adir = s.adir === "asc" ? "desc" : "asc";   // re-click flips A–Z ↔ Z–A
    renderPlayers();
  });
  Array.prototype.forEach.call(document.querySelectorAll(".pcl-subchip"), function (c) {
    c.addEventListener("click", function () {
      state.psort.metric = c.getAttribute("data-metric") || "points";
      state.psort.mode = "points";
      renderPlayers();
    });
  });
  $("pSearch").addEventListener("input", function () {
    state.pq = this.value.trim();
    renderPlayers();
  });
  $("playersList").addEventListener("click", function (ev) {
    var av = ev.target.closest("[data-photo]");
    if (av) {
      PhotoLb.open(av.getAttribute("data-photo"), av.getAttribute("data-name"));
      return;
    }
    if (ev.target.closest("[data-pv-name]")) return;   // handled below
    if (ev.target.closest("a, button")) return;         // links + ticks behave
    /* ROUND 35 — clicking anywhere else on the card opens the profile */
    var card = ev.target.closest(".pcl-pcard");
    if (card) {
      var nameEl = card.querySelector(".pcl-pnametext");
      var nm = nameEl ? nameEl.textContent.replace(/[\u2713\u2714]/g, "").trim() : "";
      var agg = playerAgg().filter(function (x) {
        return String(x.name).toLowerCase() === String(nm).toLowerCase();
      })[0];
      if (agg) openProfile(agg);
    }
  });
  /* profile modal: expand photo + the identity tick button */
  $("profBody").addEventListener("click", function (ev) {
    var ph = ev.target.closest("[data-prof-photo]");
    if (ph) PhotoLb.open(ph.getAttribute("data-prof-photo"), "");
  });
  /* the identity tick (CONFIRM ID / CLEAR TICK) — its own handler so the
     card's profile-open click never swallows it */
  $("playersList").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-pv-name]");
    if (!btn) return;
    var to = btn.getAttribute("data-pv-to") === "1";
    btn.disabled = true;
    btn.textContent = "SAVING…";
    gasPost({ action: "adminPlayerVerify", adminKey: state.key,
              players: [{ name: name, verified: to }] })
      .then(function (out) {
        if (!out || out.ok === false) {
          throw new Error((out && (out.error || (out.errors && out.errors[0] &&
            out.errors[0].error))) || "Write failed");
        }
        toast(to ? "Identity verified — tick is live for " + name
                 : "Tick cleared for " + name);
        return loadAll(true);
      })
      .catch(function (err) {
        toast(err.message || "Save failed — nothing was written", true);
        btn.disabled = false;
      });
  });

  /* ============================================================================
     REPORTS — season cards, weekly windows, player table
     ========================================================================== */
  function seasonTotals() {
    var proj = 0, ver = 0;
    state.rows.forEach(function (r) {
      proj += Number(r.projected) || 0;
      var d = displayOf(r);
      var vp = r.verifiedPoints;
      ver += (d.verified !== "" ? Math.ceil(d.verified * (Number(r.mult) || 1))
                                : (Number(vp) || 0));
    });
    return { proj: proj, ver: ver };
  }

  function renderReports() {
    var t = seasonTotals();
    var cards = [
      ["SUBMISSIONS", state.totals ? state.totals.totalSubmissions : 0, ""],
      ["POSTS", state.totals ? state.totals.totalPosts : 0, ""],
      ["UNIQUE MEDIA", state.totals ? state.totals.uniqueMedia : 0, ""],
      ["PROJECTED PTS", t.proj, ""],
      ["VERIFIED PTS", t.ver, ""]
    ];
    $("seasonCards").innerHTML = cards.map(function (c) {
      return '<div class="pcl-card"><p class="pcl-card-label">' + c[0] +
        '</p><p class="pcl-card-num">' + fmt(c[1]) + "</p></div>";
    }).join("");

    /* weekly windows */
    var byWeek = {};
    state.rows.forEach(function (r) {
      var w = r.weekNum || 0;
      if (!w) return;
      var bw = byWeek[w] = byWeek[w] || { posts: 0, pts: 0, ver: 0, players: {}, lead: null };
      bw.posts++;
      bw.pts += Number(r.projected) || 0;
      var d = displayOf(r);
      var vpts = d.verified !== "" ? Math.ceil(d.verified * (Number(r.mult) || 1))
                                   : (Number(r.verifiedPoints) || 0);
      bw.ver += vpts;
      var pts = vpts || (Number(r.projected) || 0);
      if (!bw.players[r.name]) bw.players[r.name] = 0;
      bw.players[r.name] += pts;
      if (!bw.lead || pts > bw.lead.pts) bw.lead = { name: r.name, pts: pts };
    });

    var wRows = "";
    for (var w = 1; w <= WEEKS; w++) {
      var win = weekWindow(w);
      var b = byWeek[w];
      var aw = state.awardByWeek[w];
      var windowTxt = fmtDay(win.a.toISOString()) + " → " + fmtDay(win.b.toISOString());
      var live = win.b.getTime() > Date.now();
      wRows += "<tr" + (b && b.lead ? "" : ' class="pcl-muted-row"') + ">" +
        "<td>W" + w + " · " + esc(WEEK_THEMES[w]) + (live ? ' <span class="pcl-tag">LIVE</span>' : "") + "</td>" +
        '<td class="pcl-muted-cell">' + windowTxt + "</td>" +
        '<td class="num">' + (b ? b.posts : "–") + "</td>" +
        '<td class="num">' + (b ? Object.keys(b.players).length : "–") + "</td>" +
        '<td class="num">' + (b ? fmt(b.pts) : "–") + "</td>" +
        '<td class="num">' + (b ? fmt(b.ver) : "–") + "</td>" +
        "<td>" + (b && b.lead ? esc(b.lead.name) + ' <span class="pcl-muted-cell">(' + fmt(b.lead.pts) + ")</span>" : "–") + "</td>" +
        '<td><div class="pcl-award">' +
          '<span class="pcl-award-total" title="awarded challenge points for this week">' +
            (aw ? "+" + fmt(aw.total) : "+0") + "</span>" +
          '<input class="pcl-award-name" data-aw="' + w + '" placeholder="player" ' +
            'list="pclAwardNames" aria-label="Award player for week ' + w + '" />' +
          '<input class="pcl-award-pts" data-aw="' + w + '" type="number" min="1" ' +
            'placeholder="pts" aria-label="Award points for week ' + w + '" />' +
          '<button type="button" class="pcl-award-btn" data-act="award" data-week="' + w +
            '">GIVE</button>' +
          "</div></td>" +
        "</tr>";
    }
    var awardNames = $("pclAwardNames");
    if (awardNames) {
      awardNames.innerHTML = state.players.map(function (p) {
        return '<option value="' + esc(p.player || "") + '">';
      }).join("");
    }
    $("weekTable").innerHTML = "<thead><tr>" +
      "<th>WEEK</th><th>WINDOW (IST)</th><th class='num'>POSTS</th><th class='num'>PLAYERS</th>" +
      "<th class='num'>PROJECTED</th><th class='num'>VERIFIED</th><th>LEADER</th>" +
      "<th>CHALLENGE AWARD</th>" +
      "</tr></thead><tbody>" + wRows + "</tbody>";
    /* the per-player roster now lives in its own PLAYERS tab (tab 2) —
       reports stays season-level: cards + weekly windows */
  }

  /* weekly-challenge awards (rulebook §4) — write straight to PCL-Awards
     via the key-gated awardChallenge action; the roll-up folds them into
     the player's season total and the week's bucket automatically */
  $("weekTable").addEventListener("click", function (ev) {
    var t = ev.target;
    var btn = t && t.closest ? t.closest('[data-act="award"]') : null;
    if (!btn) return;
    var w = Number(btn.getAttribute("data-week"));
    var wrap = btn.closest(".pcl-award");
    var name = wrap.querySelector(".pcl-award-name").value.trim();
    var pts = Math.ceil(Number(wrap.querySelector(".pcl-award-pts").value));
    if (!name || !(pts > 0)) {
      toast("Pick a player and positive points first", true);
      return;
    }
    btn.disabled = true;
    btn.textContent = "…";
    gasPost({ action: "awardChallenge", adminKey: state.key,
              week: w, name: name, points: pts })
      .then(function (out) {
        if (!out || out.ok === false) {
          throw new Error((out && out.error) || "Award failed");
        }
        toast("+" + pts + " points → " + name + " (W" + w + ")");
        return loadAll(true);
      })
      .catch(function (err) {
        toast(err.message || "Award failed", true);
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "GIVE";
      });
  });

  /* ============================================================================
     SUBMISSION GATES (ROUND 35) — the admins' open/close power, enforced
     server-side at ingest and mirrored onto the entry form at its next
     page load. state.gates = { seasonOpen, weeks:{1..10}, reopen:{1..10},
     allowedWeeks:[…] } — absent = everything open (old backend).
     ========================================================================== */
  function gateOf(w) {
    var g = state.gates;
    if (!g) return true;                       // old backend — everything open
    if (g.seasonOpen === false) return false;
    return !(g.weeks && g.weeks[String(w)] === false);
  }
  function renderGates() {
    var master = $("gateMaster"), weeks = $("gateWeeks");
    if (!master || !weeks) return;
    var seasonOpen = state.gates ? state.gates.seasonOpen !== false : true;
    master.innerHTML =
      '<div class="pcl-gate-master' + (seasonOpen ? " is-open" : " is-closed") + '">' +
        '<span class="pcl-gate-lab">WHOLE SEASON</span>' +
        '<span class="pcl-gate-state">' + (seasonOpen ? "OPEN" : "CLOSED") + "</span>" +
        '<button type="button" class="pcl-abtn' + (seasonOpen ? "" : " pcl-abtn--accent") +
          '" data-gate="season" data-open="' + (seasonOpen ? "0" : "1") + '">' +
          (seasonOpen ? "CLOSE SUBMISSIONS" : "REOPEN SUBMISSIONS") + "</button>" +
      "</div>";
    var cur = serverWeek();
    var rows = "";
    var past = "";
    for (var w = 1; w <= WEEKS; w++) {
      var open = gateOf(w);
      var dlPassed = weekDeadlineOf(w) <= Date.now();
      var reopened = !!(state.gates && state.gates.reopen &&
                        state.gates.reopen[String(w)]);
      /* label truth — a closed switch always reads CLOSED (server-side a
         closed gate beats a reopen), a past-lock week reads PAST unless a
         reopen is active, and a week whose window has not started yet reads
         UPCOMING, never OPEN — the entry form does not offer it yet */
      var stateLab = !open ? "CLOSED"
        : (dlPassed ? (reopened ? "REOPENED" : "PAST")
        : (w > cur ? "UPCOMING" : "OPEN"));
      rows += '<div class="pcl-gate-row' + (open ? " is-open" : " is-closed") +
        (w === cur ? " is-live" : "") +
        (open && !dlPassed && w > cur ? " is-upcoming" : "") + '">' +
        '<span class="pcl-gate-wk">W' + w + (w === cur ? ' <span class="pcl-tag">LIVE</span>' : "") + "</span>" +
        '<span class="pcl-gate-lab2">' + esc(WEEK_THEMES[w] || "") + "</span>" +
        '<span class="pcl-gate-state' + (reopened ? " is-reopened" : "") + '">' + stateLab + "</span>" +
        '<button type="button" class="pcl-abtn pcl-abtn--small' + (open ? "" : " pcl-abtn--accent") +
          '" data-gate="week" data-week="' + w + '" data-open="' + (open ? "0" : "1") + '"' +
          ' title="' + (open ? "Close week " + w + " challenge entries"
                             : "Open week " + w + " challenge entries") + '">' +
          (open ? "CLOSE" : "OPEN") + "</button>" +
        "</div>";
      if (dlPassed) {
        past += '<div class="pcl-gate-row pcl-gate-row--reopen' +
          (reopened ? " is-open" : " is-closed") + '">' +
          '<span class="pcl-gate-wk">W' + w + "</span>" +
          '<span class="pcl-gate-lab2">' + esc(WEEK_THEMES[w] || "") + "</span>" +
          '<span class="pcl-gate-state">' + (reopened ? "REOPENED" : "PAST DEADLINE") + "</span>" +
          '<button type="button" class="pcl-abtn pcl-abtn--small' + (reopened ? "" : " pcl-abtn--accent") +
            '" data-reopen="' + w + '" data-open="' + (reopened ? "0" : "1") + '">' +
            (reopened ? "WITHDRAW" : "REOPEN") + "</button>" +
          "</div>";
      }
    }
    weeks.innerHTML = rows +
      (past ? '<div class="pcl-gates-reopen-h">PAST DEADLINE — REOPEN IF NEEDED</div>' + past : "");
  }
  /* the week number the BACKEND clock says it is — state.rows' timestamps
     use the local clock; the gates panel should match the server's window */
  function serverWeek() {
    var start = Date.parse("2026-10-19T11:00:00+05:30");
    if (!isFinite(start)) return 0;
    var t = Date.now();
    if (t < start) return 0;
    return Math.min(WEEKS, Math.floor((t - start) / 604800000) + 1);
  }
  /* ROUND 37 — a week's entries lock at 6:00 PM IST on the Tuesday after its
     Monday 11:00 close; past that, only the reopen strip can open the week. */
  var SEASON_START_MS = Date.parse("2026-10-19T11:00:00+05:30");
  var WEEK_GRACE_MS = 31 * 60 * 60 * 1000;   // Mon 11:00 → Tue 18:00 IST
  function weekDeadlineOf(w) {
    if (!isFinite(SEASON_START_MS)) return Infinity;
    return SEASON_START_MS + w * 604800000 + WEEK_GRACE_MS;
  }
  $("gatePanel").addEventListener("click", function (ev) {
    var rbtn = ev.target.closest("[data-reopen]");
    if (rbtn) {
      var rw = Number(rbtn.getAttribute("data-reopen"));
      var ropen = rbtn.getAttribute("data-open") === "1";
      var rwhat = ropen
        ? "Open W" + rw + " again past its deadline? That week will accept " +
          "challenge entries until you withdraw the reopen."
        : "Withdraw the W" + rw + " reopen? The week locks again immediately.";
      if (!window.confirm(rwhat)) return;
      rbtn.disabled = true;
      gasPost({ action: "setGate", adminKey: state.key, scope: "reopen",
                week: rw, open: ropen })
        .then(function (out) {
          if (!out || out.ok === false) throw new Error((out && out.error) || "Gate write failed");
          toast("Week " + rw + (ropen ? " REOPENED" : " reopen withdrawn"));
          if (!state.gates) state.gates = { seasonOpen: true, weeks: {} };
          state.gates.reopen = state.gates.reopen || {};
          state.gates.reopen[String(rw)] = ropen;
          renderGates();
        })
        .catch(function (err) { toast(err.message || "Gate write failed", true); })
        .finally(function () { rbtn.disabled = false; });
      return;
    }
    var btn = ev.target.closest("[data-gate]");
    if (!btn) return;
    var scope = btn.getAttribute("data-gate");
    var open = btn.getAttribute("data-open") === "1";
    var body = { action: "setGate", adminKey: state.key, scope: scope, open: open };
    if (scope === "week") body.week = Number(btn.getAttribute("data-week"));
    var what = scope === "season"
      ? (open ? "Reopen ALL submissions?" : "Close ALL submissions? Players cannot send anything until you reopen.")
      : (open ? "Reopen W" + body.week + " challenge entries?"
              : "Close W" + body.week + " challenge entries? Regular posts still go through.");
    if (!window.confirm(what)) return;
    btn.disabled = true;
    gasPost(body)
      .then(function (out) {
        if (!out || out.ok === false) throw new Error((out && out.error) || "Gate write failed");
        toast(scope === "season"
          ? "Season submissions " + (open ? "OPEN" : "CLOSED")
          : "Week " + body.week + " entries " + (open ? "OPEN" : "CLOSED"));
        /* optimistic local flip — the next sync confirms from the sheet */
        if (!state.gates) state.gates = { seasonOpen: true, weeks: {} };
        if (scope === "season") state.gates.seasonOpen = open;
        else {
          state.gates.weeks = state.gates.weeks || {};
          state.gates.weeks[String(body.week)] = open;
        }
        renderGates();
      })
      .catch(function (err) { toast(err.message || "Gate write failed", true); })
      .finally(function () { btn.disabled = false; });
  });

  /* ---- REPAIR MEDIA IDS — one click, fixes the LinkedIn id era ---------- */
  $("repairIdsBtn").addEventListener("click", function () {
    if (!window.confirm("Rewrite every ledger Media ID to the canonical " +
      "extraction now? This merges duplicate keys and lands in the Admin Log.")) return;
    var btn = this, out = $("repairIdsOut");
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = "REPAIRING…";
    out.hidden = true;
    gasPost({ action: "repairMediaIds", adminKey: state.key })
      .then(function (res) {
        if (!res || res.ok === false) throw new Error((res && res.error) || "Repair failed");
        var r = res.result || {};
        out.textContent = "DONE — " + r.rewritten + " of " + r.scanned +
          " rows rewritten" + (r.cleared ? " · " + r.cleared + " cleared to URL-key" : "") +
          (r.mergedKeys ? " · " + r.mergedKeys + " duplicate keys merged" : "");
        out.hidden = false;
        toast("Media IDs repaired — " + r.rewritten + " rows rewritten");
        return loadAll(true);
      })
      .catch(function (err) { toast(err.message || "Repair failed", true); })
      .finally(function () { btn.disabled = false; btn.textContent = old; });
  });

  /* ============================================================================
     PLAYER PROFILE MODAL (ROUND 35) — click a participant card in the
     PLAYERS tab: identity + contest stats + every upload + per-app metrics,
     built entirely from the synced ledger (no extra endpoint).
     ========================================================================== */
  var ProfModal = (function () {
    var root = $("profModal"), body = $("profBody");
    function open(html) {
      body.innerHTML = html;
      root.hidden = false;
      document.body.style.overflow = "hidden";
      var btn = root.querySelector(".pcl-lb-close");
      if (btn) btn.focus();
    }
    function close() {
      root.hidden = true;
      document.body.style.overflow = "";
    }
    root.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-act='close']")) close();
    });
    document.addEventListener("keydown", function (ev) {
      if (!root.hidden && ev.key === "Escape") close();
    });
    return { open: open, close: close };
  })();

  function playerRows(name) {
    var who = String(name || "").toLowerCase();
    return state.rows.filter(function (r) {
      return String(r.name || "").toLowerCase() === who;
    });
  }
  /* per-media latest row (UPDATE chains collapse to the newest snapshot) */
  function latestByMedia(rows) {
    var map = {};
    rows.forEach(function (r) {
      var k = r.mediaId || "row:" + r.row;
      if (!map[k] || String(r.ts).localeCompare(String(map[k].ts)) > 0) map[k] = r;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }
  function profileMetrics(rows) {
    var per = { ig: { posts: 0, views: 0 }, yt: { posts: 0, views: 0 }, li: { posts: 0, views: 0 } };
    var best = null;
    latestByMedia(rows).forEach(function (r) {
      var fam = String(r.format || "").indexOf("ig_") === 0 ? "ig"
        : String(r.format || "").indexOf("yt_") === 0 ? "yt"
        : String(r.format || "") === "li_post" ? "li" : "";
      var d = displayOf(r);
      var views = d.verified !== "" ? Number(d.verified) || 0
        : (Number(r.claimed) || 0);
      if (fam && per[fam]) { per[fam].posts++; per[fam].views += views; }
      var pts = Number(r.projected) || 0;
      if (!best || pts > best.pts) best = { url: r.url, format: r.format, pts: pts, views: views };
    });
    return { per: per, best: best };
  }
  function profRowHtml(r) {
    var d = displayOf(r);
    var views = d.verified !== "" ? fmt(d.verified) + " ✓" :
                (d.ocr !== "" ? fmt(d.ocr) : fmt(r.claimed));
    var stat = d.check === "OK" ? '<span class="pcl-tag">OK</span>'
      : d.verified !== "" ? '<span class="pcl-tag">VERIFIED</span>'
      : '<span class="pcl-tag pcl-tag--mut">' + esc(String(d.check || "PENDING")) + "</span>";
    return '<tr>' +
      '<td>' + brandBadgeAdm(r.format) + " " + esc(fmtShort(r.format)) + "</td>" +
      '<td class="num">' + views + "</td>" +
      '<td class="num">' + fmt(r.projected) + "</td>" +
      "<td>" + (r.week ? esc(r.week.split("—")[0].trim()) : '<span class="pcl-muted-cell">—</span>') + "</td>" +
      "<td>" + (r.collabStatus === "CONFIRMED" ? "COLLAB" :
                (r.collabWith ? "invited" : '<span class="pcl-muted-cell">—</span>')) + "</td>" +
      "<td>" + stat + "</td>" +
      '<td><a href="' + esc(safeHref(r.url)) + '" target="_blank" rel="noopener">open &#8599;</a>' +
        (r.shotUrl ? ' · <a href="' + esc(safeHref(r.shotUrl)) +
          '" target="_blank" rel="noopener">shot</a>' : "") + "</td>" +
      "</tr>";
  }
  function playerProfileHtml(a, rows) {
    var ident = pmapOf(a.name) || {};
    var m = profileMetrics(rows);
    var rank = playerAgg().findIndex(function (x) {
      return String(x.name).toLowerCase() === String(a.name).toLowerCase();
    }) + 1;
    var ava = a.photoData || a.photoId
      ? '<img class="pcl-prof-ava" src="' + esc(a.photoData ||
          ("https://drive.google.com/thumbnail?id=" + encodeURIComponent(a.photoId) + "&sz=w200")) +
        '" alt="" />' +
        '<button type="button" class="pcl-abtn pcl-abtn--small" data-prof-photo="' +
        esc(a.photoData || ("https://drive.google.com/thumbnail?id=" +
          encodeURIComponent(a.photoId) + "&sz=w800")) + '">EXPAND</button>'
      : '<span class="pcl-pavatar pcl-pavatar--letter pcl-prof-ava" aria-hidden="true">' +
        esc((a.name || "?").charAt(0).toUpperCase()) + "</span>";
    var email = "";
    rows.forEach(function (r) { if (!email && r.email) email = r.email; });
    var bal = balanceHtml(a);
    var mix = mixShort(a);
    var latestRows = latestByMedia(rows)
      .sort(function (x, y) { return String(y.ts).localeCompare(String(x.ts)); });
    var tbl = latestRows.length
      ? "<table class='pcl-table pcl-prof-tbl'><thead><tr>" +
        "<th>POST</th><th class='num'>VIEWS</th><th class='num'>PROJ PTS</th>" +
        "<th>WEEK</th><th>COLLAB</th><th>STATUS</th><th>LINKS</th>" +
        "</tr></thead><tbody>" + latestRows.map(profRowHtml).join("") + "</tbody></table>"
      : '<p class="pcl-empty">No uploads yet.</p>';
    return '<div class="pcl-prof-head">' +
        ava +
        '<div class="pcl-prof-id">' +
          '<p class="pcl-prof-name">' + esc(a.name) +
            (ident.verified ? " " + TICK_SVG : "") + "</p>" +
          '<p class="pcl-prof-sub">' +
            (ident.designation ? esc(ident.designation) + " · " : "") +
            "mgr " + esc(a.manager || "–") +
            (email ? " · " + esc(email) : "") +
            (rank ? ' · <b>#' + rank + "</b> on the board" : "") +
          "</p>" +
          (bal ? '<p class="pcl-pbal">' + bal + "</p>" : "") +
        "</div>" +
      "</div>" +
      '<div class="pcl-prof-stats">' +
        pstat("LEADERBOARD PTS", fmt(a.vpts ? a.vpts : a.ppts), true) +
        pstat("VERIFIED", a.vpts ? fmt(a.vpts) : "–") +
        pstat("PROJECTED", fmt(a.ppts)) +
        pstat("VIEWS", fmt(a.views)) +
        pstat("POSTS", a.uniqueMedia) +
        pstat("APPS", a.apps) +
      "</div>" +
      '<div class="pcl-prof-apps">' +
        pstat("INSTAGRAM", m.per.ig.posts + " · " + fmt(m.per.ig.views) + " views") +
        pstat("YOUTUBE", m.per.yt.posts + " · " + fmt(m.per.yt.views) + " views") +
        pstat("LINKEDIN", m.per.li.posts + " · " + fmt(m.per.li.views) + " views") +
        (mix ? pstat("FORMAT MIX", mix) : "") +
      "</div>" +
      (m.best ? '<p class="pcl-prof-best">BEST POST — ' +
        brandBadgeAdm(m.best.format) + " " + fmt(m.best.pts) + " pts · " +
        fmt(m.best.views) + " views · <a href=\"" + esc(safeHref(m.best.url)) +
        '" target="_blank" rel="noopener">open &#8599;</a></p>' : "") +
      "<h3 class='pcl-prof-h3'>UPLOADED CONTENT — " + latestRows.length + " post" +
      (latestRows.length === 1 ? "" : "s") + " (latest snapshot each)</h3>" +
      tbl;
  }
  function openProfile(a) {
    ProfModal.open(playerProfileHtml(a, playerRows(a.name)));
  }

  /* ============================================================================
     CSV EXPORT — full ledger, client-side
     ========================================================================== */
  var CSV_COLS = [
    ["Timestamp (IST)", function (r) { return fmtTS(r.ts); }],
    ["Submission ID", function (r) { return r.id; }],
    ["Entry Type", function (r) { return r.type; }],
    ["Snapshot #", function (r) { return r.snap; }],
    ["Player", function (r) { return r.name; }],
    ["Manager", function (r) { return r.manager; }],
    ["Platform", function (r) { return r.platform; }],
    ["Format", function (r) { return r.format; }],
    ["Multiplier", function (r) { return r.mult; }],
    ["Post URL", function (r) { return r.url; }],
    ["Media ID", function (r) { return r.mediaId; }],
    ["Collab Status", function (r) { return r.collabStatus || ""; }],
    ["Collab With", function (r) { return r.collabWith || ""; }],
    ["Week (computed)", function (r) { return r.weekNum ? "W" + r.weekNum : ""; }],
    ["Weekly Challenge", function (r) { return r.week; }],
    ["Claimed", function (r) { return r.claimed; }],
    ["Projected Points", function (r) { return r.projected; }],
    ["OCR Count", function (r) { return displayOf(r).ocr; }],
    ["Cross-Check", function (r) { return displayOf(r).check; }],
    ["Verified Count", function (r) { return displayOf(r).verified; }],
    ["Content Type", function (r) { return displayOf(r).ctype; }],
    ["Tracked Views", function (r) { return r.trackedViews !== undefined ? r.trackedViews : ""; }],
    ["Verified Points", function (r) {
      var d = displayOf(r);
      return d.verified !== "" ? Math.ceil(d.verified * (Number(r.mult) || 1)) : r.verifiedPoints;
    }],
    ["Screenshot Link", function (r) { return r.shotUrl; }]
  ];

  function csvCell(v) {
    v = String(v == null ? "" : v);
    /* spreadsheet-injection guard — a ledger value beginning with = + - @
       must open as text when the CSV lands in Excel / Sheets, never as a
       live formula (the classic =HYPERLINK/=CMD exfiltration trick) */
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportCsv() {
    if (!state.rows.length) { toast("Nothing to export yet", true); return; }
    var lines = [CSV_COLS.map(function (c) { return csvCell(c[0]); }).join(",")];
    state.rows.forEach(function (r) {
      lines.push(CSV_COLS.map(function (c) { return csvCell(c[1](r)); }).join(","));
    });
    var blob = new Blob(["\uFEFF" + lines.join("\r\n")],
      { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    var d = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    a.href = URL.createObjectURL(blob);
    a.download = "pcl-season2-ledger-" + d.getFullYear() + pad(d.getMonth() + 1) +
                 pad(d.getDate()) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("CSV exported — " + state.rows.length + " rows");
  }

  /* ============================================================================
     AUDIT CATALOGUE (LOG tab) — who entered, what changed
     ========================================================================== */
  function renderLog() {
    var tbl = $("logTable");
    if (!tbl) return;
    var log = state.log || [];
    var body = log.map(function (l) {
      var cls = l.action === "LOGIN" ? "pcl-logtag--login" : "pcl-logtag--verify";
      return "<tr>" +
        '<td class="pcl-muted-cell" style="white-space:nowrap">' + esc(fmtTS(l.ts)) + " IST</td>" +
        "<td><b>" + esc(l.operator || "unnamed") + "</b></td>" +
        '<td><span class="pcl-logtag ' + cls + '">' + esc(l.action || "") + "</span></td>" +
        "<td>" + esc(l.target || "") + "</td>" +
        '<td class="pcl-logdetail">' + esc(l.detail || "") + "</td>" +
        "</tr>";
    }).join("");
    tbl.innerHTML = "<thead><tr><th>WHEN (IST)</th><th>OPERATOR</th><th>ACTION</th>" +
      "<th>TARGET</th><th>WHAT CHANGED</th></tr></thead><tbody>" +
      (body || '<tr><td colspan="5" class="pcl-muted-cell">No entries yet — ' +
        "unlocks and saved writes will appear here.</td></tr>") + "</tbody>";
  }

  /* ============================================================================
     TABS + TOOLBAR
     ========================================================================== */
  $("tabs").addEventListener("click", function (ev) {
    var btn = ev.target.closest(".pcl-vbtn");
    if (!btn) return;
    var tab = btn.getAttribute("data-tab");
    state.tab = tab;
    Array.prototype.forEach.call(
      $("tabs").querySelectorAll(".pcl-vbtn"),
      function (b) { b.classList.toggle("is-active", b === btn); });
    ["feed", "players", "reports", "audit", "log"].forEach(function (t) {
      $("tab" + t.charAt(0).toUpperCase() + t.slice(1)).hidden = t !== tab;
    });
  });
  $("refreshBtn").addEventListener("click", function () { loadAll(); });
  $("exportBtn").addEventListener("click", exportCsv);

  /* SYNC NOW — pull the auto-tracked platform counts (YouTube Data API leg;
     IG/LI activate when their Phase-0 keys go live) into the ledger. The
     fresh counts surface in the feed as AUTO tags beside each row. */
  $("syncNowBtn").addEventListener("click", function () {
    var btn = this;
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = "SYNCING…";
    gasPost({ action: "syncNow", adminKey: state.key })
      .then(function (out) {
        if (!out || out.ok === false) {
          throw new Error((out && out.error) || "Sync failed");
        }
        var bits = [];
        if (out.yt) bits.push("YT " + out.yt.updated + "/" + out.yt.checked);
        if (out.ig && out.ig.note) bits.push("IG " + out.ig.note);
        if (out.li && out.li.note) bits.push("LI " + out.li.note);
        toast("Sync done — " + (bits.join(" · ") || "nothing to track yet"));
        return loadAll(true);
      })
      .catch(function (err) {
        toast(err.message || "Sync failed", true);
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
  });

  /* platform picker (participants tab) — icon multi-select; the button label
     mirrors the pick, an empty pick = ALL APPS */
  (function () {
    var pick = $("platPick"), btn = $("platBtn"), menu = $("platMenu");
    if (!pick || !btn || !menu) return;
    function syncLabel() {
      var boxes = Array.prototype.slice.call(menu.querySelectorAll("input"));
      var on = boxes.filter(function (b) { return b.checked; })
                    .map(function (b) { return b.value.toUpperCase(); });
      state.plats = on.map(function (v) { return v.toLowerCase(); });
      $("platBtnLabel").textContent = on.length ? on.join(" + ") : "ALL APPS";
      btn.classList.toggle("is-active", on.length > 0);
      renderPlayers();
    }
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
    });
    menu.addEventListener("change", syncLabel);
    document.addEventListener("click", function (ev) {
      if (menu.hidden) return;
      if (!pick.contains(ev.target)) {
        menu.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !menu.hidden) {
        menu.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    });
  })();

  /* ============================================================================
     GATE WIRING + BOOT
     ========================================================================== */
  $("gateBtn").addEventListener("click", function () {
    var f = $("gateField");
    f.classList.remove("is-error");
    tryUnlock($("gateKey").value.trim(), false);
  });
  $("gateKey").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      $("gateField").classList.remove("is-error");
      tryUnlock(this.value.trim(), false);
    }
  });
  $("gateKey").addEventListener("input", function () {
    $("gateField").classList.remove("is-error");
  });

  (function boot() {
    try {
      var savedOp = sessionStorage.getItem(OP_STORE);
      if (savedOp) state.operator = savedOp;
    } catch (e) { /* ok */ }
    var saved = "";
    try { saved = sessionStorage.getItem(KEY_STORE) || ""; } catch (e) { /* ok */ }
    if (saved) {
      tryUnlock(saved, true).then(function (ok) {
        if (!ok) {
          try { sessionStorage.removeItem(KEY_STORE); } catch (e) { /* ok */ }
          $("gate").hidden = false;
          $("console").hidden = true;
        }
      });
    } else {
      showOperator();
    }
    if (MOCK) {
      var note = document.querySelector(".pcl-gate-note");
      if (note) note.innerHTML = "<strong>MOCK MODE</strong> — demo ledger, no backend " +
        "calls. Any password with 4+ characters unlocks.";
    }
  })();

  /* debug / automation handle */
  window.PCL_ADMIN = {
    get state() { return state; },
    MOCK: MOCK,
    tryUnlock: tryUnlock,
    loadAll: loadAll,
    openReview: openReview,
    exportCsv: exportCsv,
    weekOf: weekOf,
    renderPlayers: renderPlayers,
    playerAgg: playerAgg,
    PhotoLb: PhotoLb
  };
})();
