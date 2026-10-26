/**
 * ============================================================================
 * PRAPER CONTEST LEAGUE — Google Apps Script backend (Season 2)
 * ============================================================================
 * Receives submissions from the PCL form and maintains the league ledger:
 *
 *   doPost → for EVERY post in the submission (a submission carries many):
 *            1. extracts the MEDIA ID from the post URL (IG shortcode /
 *               YouTube video ID / LinkedIn activity ID) — the dedup key
 *            2. decides NEW vs UPDATE: the same Media ID submitted again is
 *               an UPDATE snapshot of that post's count, never extra views
 *            3. enforces LINK OWNERSHIP: a link already on file under
 *               ANOTHER player is rejected unless the collab pair checks
 *               out (either side tagged the other) — confirmed pairs get
 *               'Collab Status' = CONFIRMED; BOTH rows score FULL points
 *            4. saves the analytics screenshot (base64) to Drive
 *            5. appends one ledger row with claimed count, multiplier and
 *               projected points — leaving the OCR / cross-check / verified
 *               columns empty for the review pipeline to fill in
 *            6. replies {ok:true, id, posts:<count>}; a retried submissionId
 *               is recognised and answered WITHOUT appending twice
 *
 *   doGet  → metrics JSON: {ok, totalSubmissions, totalPosts, uniqueMedia,
 *            lastSubmissionAt, players:[…], weeks:{…}}
 *            `players` aggregates the ledger per candidate — submissions,
 *            post count, unique media, format ratio and projected points
 *            — so the league can see who uploaded how much and in what
 *            mix without ever double-counting (Media ID dedup holds).
 *            `weeks` carries the public leaderboard roll-up: per week,
 *            per player {posts, impressions, points} deduped the same
 *            way (latest snapshot per Media ID, first-snapshot week).
 *
 *   ADMIN CONSOLE (admin.html) — gated by six per-admin passwords (the
 *   ADMINS roster in this file; password = identity, audit entries are
 *   stamped server-side):
 *     doGet  ?action=ledger&key=…[&callback=…]  → every ledger row (newest
 *            first, incl. Drive file ids + thumbnail urls) + totals +
 *            per-player roll-up. JSONP when `callback` is given, so the
 *            static admin page can read it cross-origin with zero CORS
 *            configuration.
 *     doGet  ?action=ocr&key=…&fileId=…[&claimed=…] → semi-auto OCR: the
 *            analytics screenshot is OCR'd through Drive (free) and the
 *            count closest to the claimed number is suggested for the
 *            review pipeline. Needs "Drive API" enabled as an Advanced
 *            Service in the editor; without it the console simply asks
 *            the admin to type the number.
 *     doPost {action:'adminVerify', adminKey, updates:[…]} → writes the
 *            review columns (OCR Count / Cross-Check / Verified Count /
 *            Verified Points) for specific ledger rows. Verified Points
 *            are recomputed server-side from the row's multiplier.
 *            Cross-Check whitelist: PENDING OCR · MATCH · MISMATCH · BOOST?
 *
 * LEDGER LAYOUT ("Submissions" sheet) — one row PER POST; a submission
 * with 5 posts writes 5 rows sharing one Submission ID:
 *   Identity:   Timestamp · Submission ID · Entry Type · Snapshot # ·
 *               Full Name · Reporting Manager
 *   Media:      Content Type · Platform · Format · Multiplier · Post URL ·
 *               Media ID · Weekly Challenge · Challenge URL · Notes
 *   Claims:     Claimed Views/Impressions · Projected Points ·
 *               Screenshot File · Screenshot Link
 *   Review:     OCR Count · Cross-Check · Verified Count · Verified Points
 *   Audit:      Raw JSON (base64 stripped — screenshots live in Drive)
 *   (→ pipeline: Name/UID → per-post media + claimed data → OCR'd ×
 *    cross-verification → total analytics)
 * NOTE: the Content Type column is DEPRECATED (the form no longer tags
 * posts Praper/PAVE vs Personal) but stays in HEADERS so existing sheet
 * layouts keep their column order; new rows simply leave it blank.
 *
 * Points rule (rulebook §3): Leaderboard Points = views/impressions ×
 * multiplier, fractional points rounded UP. Verified Points always wins over
 * Projected Points once the review pipeline fills it in.
 *
 * ----------------------------------------------------------------------------
 * SETUP (5 minutes, all free):
 *   1. Open https://script.google.com → New project.
 *   2. Paste this whole file into Code.gs and save.
 *   3. (Optional) Put an existing spreadsheet's ID in SHEET_ID below.
 *   4. Deploy → New deployment → type: Web app
 *        - Execute as:     Me (your account)
 *        - Who has access: Anyone          ← required for contestants
 *      Approve the Drive/Sheets permission prompts.
 *   5. Copy the Web app URL (ends in /exec) into js/gas-endpoint.js
 *      → gasWebAppUrl, then create a NEW deployment version so /exec picks
 *      up the changes.
 * ============================================================================
 */

/** ---------- CONFIG ---------- */
var SHEET_ID = '1IMgfcg6nv_PM1Ntw3KmrIZDrldueIjteT6Mx_RteAFE';                    // '' = bound/new spreadsheet
var SHEET_NAME = 'PCL-Data';
var DRIVE_FOLDER_NAME = 'Praper Contest League Uploads';
var PHOTO_FOLDER_NAME = 'PCL Player Photos';   // child of the uploads folder —
                                               // one photo per unique player
var MAX_FILE_MB = 5;                  // mirrors js/gas-endpoint.js

/** Season clock — week windows for the public leaderboard. Week 1 opens at
 *  SEASON_START_ISO (IST); every window is 7 days; posts submitted before
 *  the start (warm-up) count as Week 1; the counter caps at LEAGUE_WEEKS. */
var SEASON_START_ISO = '2026-10-19T11:00:00+05:30';
var LEAGUE_WEEKS = 10;

/** Public leaderboard fallback — Full Name → Designation (the job title shown
 *  in the board's Designation column). THE LEAGUE'S REAL ROSTER from the
 *  early-insight collection (60 participants): the board shows everyone's
 *  actual title even before their first submission; the ledger's
 *  'Player Designation' column (written by the form, verified in the Control
 *  Room) always wins over this fallback. Keys are normName_-normalized. */
var PLAYER_META = {
  'sehaj singh': 'Social Media Executive',
  'aryan': 'Junior Video Editor',
  'azkiya qamar': 'Content Creator Intern',
  'harshit': 'Video Editor',
  'japjot singh': 'Video Editor Intern',
  'dipika': 'Video Editor',
  'jaskirt singh': 'Assistant Team Lead',
  'robin': 'Video Editor',
  'bhakti arora': 'Content Creator',
  'arushi chawla': 'Content Creator',
  'sayan chakraborty': 'DI Colorist',
  'supriya singh': 'Content Creator',
  'harjappan singh': 'Jr. Motion Graphics Artist',
  'prerna jaiswani': 'Jr. Account Manager',
  'sakshi lakhmani': 'Long-Form Video Editor',
  'deepanshum srivastava': 'Team Lead',
  'rinky chauhan': 'Video Editor',
  'soyaf ikbal ghanchi': 'Junior Video Editor',
  'aryan maddeshiya': 'Video Editor',
  'hemant kataria': 'Jr. Video Editor',
  'ashutosh gupta': 'CBO',
  'archna kumari': 'Senior Executive Finance & Operations',
  'mayukh bhattacharjee': 'Executive Video Editor',
  'abhijeet singh': 'Executive Video Editor (Long Form)',
  'krish sharma': 'Video Editor Intern (Long Form)',
  'ankush sheokand': 'Assistant Team Lead',
  'vishal k': 'Video Editing Mentor',
  'harpreet singh': 'Assistant Team Lead',
  'mitali': 'HR',
  'muskan': 'Executive Video Editor',
  'deepti': 'Key Account Manager',
  'kanupriya srikoti': 'HR Associate',
  'sejal choudhary': 'HR Executive',
  'sonali dub': 'Executive Graphic Designer',
  'hiten khatri': 'Podcast Content Strategist',
  'ansh kumar': 'Senior Executive | Motion Graphics Artist',
  'kunal verma': 'Executive Video Editor',
  'harsh arora': 'Videographer Intern',
  'kartik shivam': 'Creative Video Editor',
  'shubham rai': 'Team Lead',
  'shreeraag varier': 'Video Editor',
  'rudra pratap singh': 'Video Editor',
  'shreyash rawat': 'Junior Video Editor',
  'nandini singh': 'Junior Video Editor',
  'gaurav rana': 'Junior Video Editor',
  'sumit singh': 'Executive Video Editor',
  'shreyangsu jana': 'Junior Motion Graphic Artist',
  'manas ranjan': 'System Engineer',
  'yashwant rawat': 'Executive Motion Graphic Designer',
  'dheeraj kumar': 'Video Editor',
  'shubham gusain': 'Video Editor',
  'isham grover': 'Junior Video Editor',
  'siddharth thakur': 'Junior Graphic Designer',
  'nitin sharma': 'Video Editor and Sound Designer',
  'adeeba qamar': 'Junior Video Editor',
  'vikram singh': 'Social Media Executive',
  'rohit toor': 'Executive Video Editor',
  'nikhil srivastava': 'Executive Video Editor',
  'hirday sarkar': 'Junior Video Editor'
};

/** Canonical ledger columns — REVIEW-FIRST order (created on first run):
 *  identity + verify columns first, machine/audit columns last. */
/* REVIEW-FIRST column order: identity + what-needs-verifying come first;
 * machine/audit columns (Submission ID, Snapshot #, Raw JSON…) go last.
 * Every read and write addresses columns BY NAME, so this layout is
 * presentation-only — run reorganizeForReview_() once from the editor to
 * physically reorder an existing sheet (it backs the data up first). */
var HEADERS = [
  'Timestamp', 'Full Name', 'Reporting Manager',
  'Player Designation', 'Player Verified', 'Player Photo',
  'Entry Type', 'Weekly Challenge',
  'Platform', 'Format', 'Multiplier', 'Post URL', 'Media ID',
  'Collab With', 'Collab Status', 'Content Type',
  'Claimed Views/Impressions', 'OCR Count', 'Cross-Check',
  'Verified Count', 'Verified Points', 'Projected Points',
  'Screenshot File', 'Screenshot Link',
  'Challenge URL', 'Notes',
  'Submission ID', 'Snapshot #', 'Raw JSON',
  'Player Email'
];
/* 'Player Email' (col 30, appended last so no existing reader shifts) — the
 * participant's work email from their sign-in session, carried on every row
 * they own. Powers the EMAIL collab flow: partners are invited by email,
 * the accept banner shows ONLY to the invited mail, and the ingest pairs
 * rows by email (legacy name matching still honoured for old rows). */

/** Player identity (per PLAYER, not per post — the same value repeats on
 *  every row the player owns):
 *  Player Designation — the job title from the form's first-time designation
 *          field; auto-reused from the ledger when a resubmission omits it.
 *  Player Verified    — 'VERIFIED' once the Control Room confirms the
 *          player's photo + designation (insta-style tick everywhere); ''
 *          means unverified, and unverified players get NO badge at all. */

/** Collab-post lifecycle (rulebook §6, rule 2):
 *  ''        plain post — the link belongs to this player
 *  PENDING   the player tagged a partner; the partner's same-link entry has
 *            not landed yet
 *  CONFIRMED the partner's matching entry landed and the pair was verified
 *            — EACH employee receives the post's FULL points. The rulebook
 *            is explicit: 1,000 views × 1.25 = 1,250 points and "Both
 *            employees will receive 1,250 leaderboard points each". The
 *            two rows share one Media ID but score independently; there is
 *            NO halving anywhere in the pipeline. */
var COLLAB_PENDING = 'PENDING';
var COLLAB_CONFIRMED = 'CONFIRMED';

/** Review-pipeline values for the Cross-Check column. */
var CHECK_PENDING = 'PENDING OCR';
var CHECK_VALUES = ['PENDING OCR', 'MATCH', 'MISMATCH', 'BOOST?'];

/** Admin console — one password per admin (see ADMINS near checkAdmin_).
 *  The password IS the identity: every audit entry is stamped with the name
 *  derived SERVER-SIDE from the password, so the client can never mislabel
 *  who did what. Interim passwords follow firstName@123 — rotate by editing
 *  the ADMINS list and deploying a new version. */

/** Column indexes of the four review columns — derived from HEADERS. */
var COL_OCR = HEADERS.indexOf('OCR Count') + 1;
var COL_CHECK = HEADERS.indexOf('Cross-Check') + 1;
var COL_VCOUNT = HEADERS.indexOf('Verified Count') + 1;
var COL_VPOINTS = HEADERS.indexOf('Verified Points') + 1;

/** Rulebook §3 — leaderboard multipliers per format. */
var MULTIPLIERS = {
  ig_reel: 1.25,      // Instagram Reels:  1 view  → 1.25 pts
  ig_post: 1,         // IG Post/Carousel: 1 impr. → 1 pt
  yt_shorts: 1.25,    // YouTube Shorts:   1 view  → 1.25 pts
  yt_long: 2,         // YT Long-Form:     1 view  → 2 pts
  li_post: 1          // LinkedIn Post:    1 impr. → 1 pt
};

var FORMAT_LABELS = {
  ig_reel: 'Instagram Reel',
  ig_post: 'Instagram Post / Carousel',
  yt_shorts: 'YouTube Shorts',
  yt_long: 'YouTube Long-Form',
  li_post: 'LinkedIn Post'
};

var PLATFORM_LABELS = {
  ig_reel: 'Instagram', ig_post: 'Instagram',
  yt_shorts: 'YouTube', yt_long: 'YouTube',
  li_post: 'LinkedIn'
};

/** ---------- ENTRY POINTS ---------- */

function doPost(e) {
  /* serialization lock — two participants submitting in the same moment
     (the Monday 11:00 deadline rush) must never interleave their
     read-modify-write cycles; a lost update here would be silent data
     corruption, and data loss is not acceptable at any point */
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return doPostLocked_(e);
  } finally {
    lock.releaseLock();
  }
}

function doPostLocked_(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    // Admin console write-back (key-gated) — everything else is a submission
    if (payload && payload.action === 'adminVerify') return adminVerify_(payload);
    if (payload && payload.action === 'adminPlayerVerify') return adminPlayerVerify_(payload);
    if (payload && payload.action === 'adminLogin') return adminLogin_(payload);
    if (payload && payload.action === 'syncNow') return syncNow_(payload);
    if (payload && payload.action === 'awardChallenge') return awardChallenge_(payload);
    if (payload && payload.action === 'setGate') return setGate_(payload);
    if (payload && payload.action === 'repairMediaIds') return repairMediaIds_(payload);

    var id = payload.submissionId || Utilities.getUuid();
    var d = payload.data || {};

    var posts = Array.isArray(d.postDetails) ? d.postDetails : [];
    if (!posts.length) {
      return json_({ ok: false, error: 'No posts in submission' });
    }

    var folder = getDriveFolder_();

    // Identity (shared by every post in this submission)
    var fullName = str_(d.fullName);
    var manager = str_(d.reportingManager);
    var who = normName_(fullName);
    var designation = str_(d.playerDesignation).trim();
      // first-time field — a returning player's entry may omit it; the
      // designation already on file for this name is picked up further down
      // (needs the ledger index, which is built right after this block)
    var week = str_(d.challengeWeek);
    var challengeUrl = safeUrl_(d.challengeUrl);
    if (challengeUrl === null) {
      return json_({ ok: false, error:
        'The challenge link looks invalid — paste the full web address ' +
        '(it must start with https://).' });
    }
    var notes = str_(d.additionalNotes);
    /* the participant's work email — now TYPED in Participant Details (the
     * sign-in card is gone). It powers email-keyed collab matching + the
     * Player Email column; never trusted for anything but collab pairing.
     * An absent email (stale pre-email cached page) still lands — collab
     * then falls back to name matching — but a NON-praper address is
     * refused outright: the league is employees only. */
    var myEmail = String(d.email || '').trim().toLowerCase();
    if (myEmail && !/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(myEmail)) {
      myEmail = '';   // junk session value — collab falls back to name matching
    }
    if (myEmail) {
      var emDom = '@' + (EMPLOYEE_DOMAIN || 'praper.in');
      if (myEmail.slice(-emDom.length) !== emDom) {
        return json_({ ok: false, error:
          'Entries must carry a @' + (EMPLOYEE_DOMAIN || 'praper.in') +
          ' work email — fix the Work email field in Participant Details ' +
          'and resubmit.' });
      }
    }

    // ---- SUBMISSION GATES (Control Room switches, ROUND 35) — the admin
    // power to hold submissions: whole season, or any single week's
    // challenge entries. Absent settings = everything open.
    var gates = readSubmitGates_();
    if (!gates.seasonOpen) {
      return json_({ ok: false, error:
        'Submissions are paused by the league admins right now — they will '
        + 'reopen the gates soon. Your draft is saved in the form.' });
    }
    if (week) {
      var gateWk = wkNumOfLabel_(week);
      if (gateWk && !gates.weeks[String(gateWk)]) {
        return json_({ ok: false, error:
          'Week ' + gateWk + ' challenge entries are CLOSED by the league '
          + 'admins. Switch the challenge to \u201cNot entering\u201d to send '
          + 'regular posts, or wait for the reopen.' });
      }
    }

    var sheet = getSheet_(true);   // ingest may bootstrap a brand-new ledger

    // One read pass over the ledger → everything the checks need:
    // media/URL ownership, snapshot counters and the retried-submission guard
    var index = ledgerIndex_(sheet);

    // designation fallback — reuse what's already on file for this player
    if (!designation && index.desigByName[who]) designation = index.desigByName[who];

    // Idempotency: a retry after a lost response must never append twice
    if (index.subIds[id]) {
      return json_({ ok: true, id: id, posts: 0, duplicate: true });
    }

    var raw = JSON.stringify(payload, function (k, v) {
      // keep the audit trail small — screenshots live in Drive
      return (k === 'content' && typeof v === 'string' &&
              v.slice(0, 5) === 'data:') ? '[saved to Drive]' : v;
    });

    // ---- VALIDATION PASS: every post must clear BEFORE anything is written
    //      (a submission is all-or-nothing, so a rejection mid-way can never
    //      leave half a submission in the ledger)
    var batch = [];
    var seenInBatch = {};
    for (var i = 0; i < posts.length; i++) {
      var p = posts[i];
      var fmt = str_(p.format);
      var postUrl = safeUrl_(p.link);
      if (postUrl === null) {
        return json_({ ok: false, error:
          'A post link looks invalid — links must be normal web addresses ' +
          'starting with https://.' });
      }
      var mediaId = mediaId_(postUrl, fmt);
      var claimed = toCount_(p.viewsImpressions);
      var mult = MULTIPLIERS.hasOwnProperty(fmt) ? MULTIPLIERS[fmt] : '';
      var projected = (claimed !== '' && mult !== '')
        ? Math.ceil(claimed * mult)          // rulebook: round fractions UP
        : '';
      var key = mediaId || urlKey_(postUrl);

      if (key && seenInBatch[key]) {
        return json_({ ok: false, error:
          'The same link appears twice in this submission — each post can ' +
          'only be entered once.' });
      }
      if (key) seenInBatch[key] = true;

      // Ledger state for this link: own rows → UPDATE; other players' rows →
      // collab check (a link belongs to the player who posted it first)
      var priorOwn = [], priorOthers = [];
      if (key) {
        (index.byKey[key] || []).forEach(function (r) {
          if (normName_(r.name) === who) priorOwn.push(r);
          else priorOthers.push(r);
        });
      }

      var partner = '';
      var status = '';
      if (priorOthers.length) {
        // confirm the collab — EMAIL first (the collab list now carries work
        // emails), the registered-name match kept for legacy rows:
        //   d1: the other row's collab list contains MY email
        //   d2: my collab list contains the other row's Player Email
        var matched = null;
        priorOthers.forEach(function (r) {
          if (matched) return;
          if (myEmail && chipEmails_(r.collabWith).indexOf(myEmail) >= 0) {
            matched = r;
          }
        });
        var pn = normName_(str_(p.collabWith).replace(/[a-z0-9._%+'-]+@[a-z0-9.-]+/gi, ''));
        if (!matched && pn) {
          priorOthers.forEach(function (r) {
            if (!matched && normName_(r.name) === pn) matched = r;
          });
        }
        if (!matched && myEmail) {
          var myChips = chipEmails_(p.collabWith);
          if (myChips.length) {
            priorOthers.forEach(function (r) {
              if (!matched && r.playerEmail && myChips.indexOf(r.playerEmail) >= 0) {
                matched = r;
              }
            });
          }
        }
        if (!matched) {
          // short + plain — the form's banner already explains the collab path
          var owners = [];
          priorOthers.forEach(function (r) {
            if (r.name && owners.indexOf(r.name) < 0) owners.push(r.name);
          });
          return json_({ ok: false, error:
            'Already uploaded by ' +
            (owners.length ? firstName_(owners[0]) : 'another player') +
            '. Your collab? Tag it COLLAB and add their email.' });
        }
        // the ledger's canonical identity: email when known, name otherwise
        partner = matched.playerEmail || matched.name;
        status = COLLAB_CONFIRMED;
      } else {
        partner = str_(p.collabWith).trim();
        status = partner ? COLLAB_PENDING : '';
      }

      batch.push({
        p: p, fmt: fmt, postUrl: postUrl, mediaId: mediaId,
        claimed: claimed, mult: mult, projected: projected,
        priorOwn: priorOwn, priorOthers: priorOthers,
        partner: partner, status: status
      });
    }

    // ---- WRITE PASS
    var written = 0;

    // Player photo: save-or-reuse (exactly ONE photo per unique player lives
    // in Drive, named "<name>__<manager>"). Failure never blocks the entry.
    var photoUrl = savePlayerPhoto_(d, fullName, manager, folder);

    var colWith = HEADERS.indexOf('Collab With') + 1;
    var colStatus = HEADERS.indexOf('Collab Status') + 1;

    batch.forEach(function (b, i) {
      var shot = fileAnswer_(b.p.analyticsScreenshot, folder,
                             id + '-p' + (i + 1));

      var entryType = b.priorOwn.length ? 'UPDATE' : 'NEW';
      var snapshotNo = b.priorOwn.length
        ? b.priorOwn[b.priorOwn.length - 1].snapshot + 1 : 1;

      var row = {};
      row['Timestamp'] = new Date();
      row['Submission ID'] = id;
      row['Entry Type'] = entryType;
      row['Snapshot #'] = snapshotNo;
      row['Full Name'] = cellSafe_(fullName);
      row['Reporting Manager'] = cellSafe_(manager);
      // 50:50 balance rule (rulebook §6) — the form tags every post
      // PRAPER/PAVE or PERSONAL; the column was kept for exactly this revival
      row['Content Type'] = str_(b.p.contentType).toUpperCase() === 'PERSONAL'
        ? 'PERSONAL' : 'PRAPER';
      row['Platform'] = PLATFORM_LABELS[b.fmt] || '';
      row['Format'] = FORMAT_LABELS[b.fmt] || b.fmt;
      row['Multiplier'] = b.mult;
      row['Post URL'] = cellSafe_(b.postUrl);
      row['Media ID'] = b.mediaId;
      row['Weekly Challenge'] = cellSafe_(week);
      row['Challenge URL'] = cellSafe_(challengeUrl);
      row['Notes'] = cellSafe_(notes);
      row['Claimed Views/Impressions'] = b.claimed;
      row['Projected Points'] = b.projected;
      row['Screenshot File'] = shot ? cellSafe_(shot.name)
        : 'REJECTED — over ' + MAX_FILE_MB + ' MB cap';
      row['Screenshot Link'] = shot ? shot.url : '';
      // OCR Count: machine-read of the screenshot. The form's client-side
      // Tesseract pass fills it at ingest; the console's SCAN button can
      // re-read it server-side (Drive OCR) whenever the reviewer wants a
      // second opinion — a SCAN always overwrites the ingested value.
      row['OCR Count'] = numOrBlank_(b.p.ocrCount);
      row['Cross-Check'] = CHECK_PENDING;  // PENDING → MATCH / MISMATCH / BOOST?
      row['Verified Count'] = '';          // filled after cross-verification
      row['Verified Points'] = '';         // final leaderboard points
      row['Raw JSON'] = raw;
      row['Player Photo'] = photoUrl;
      row['Collab With'] = cellSafe_(b.partner);
      row['Collab Status'] = b.status;
      row['Player Designation'] = cellSafe_(designation);
      row['Player Verified'] = index.verifiedByName[who] ? 'VERIFIED' : '';
      row['Player Email'] = cellSafe_(myEmail);
        // carry the player's existing verification onto new rows so a single
        // read pass always sees it (the Control Room can flip it any time)

      sheet.appendRow(HEADERS.map(function (h) { return row[h]; }));
      written++;

      // A confirmed pair also flips the PARTNER's prior rows to CONFIRMED
      // (their Collab With is filled in when blank) so both sides score.
      if (b.status === COLLAB_CONFIRMED) {
        var partnerIsEmail = String(b.partner).indexOf('@') >= 0;
        var partnerWho = normName_(partnerIsEmail ? '' : b.partner);
        b.priorOthers.forEach(function (r) {
          var isPartner = partnerIsEmail
            ? String(r.playerEmail || '').toLowerCase() ===
              String(b.partner).toLowerCase()
            : normName_(r.name) === partnerWho;
          if (!isPartner) return;
          sheet.getRange(r.row, colStatus).setValue(COLLAB_CONFIRMED);
          if (!r.collabWith) {
            // backfill the partner's side with the ACCEPTOR's identity —
            // email when the session has one, ledger name otherwise
            sheet.getRange(r.row, colWith).setValue(cellSafe_(myEmail || fullName));
          }
        });
      }
    });

    return json_({ ok: true, id: id, posts: written });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'ledger') return ledgerEndpoint_(p);
    if (p.action === 'ocr')    return ocrEndpoint_(p);
    if (p.action === 'subcheck') return subcheckEndpoint_(p);
    if (p.action === 'checklink') return checklinkEndpoint_(p);
    if (p.action === 'playerPhoto') return playerPhotoEndpoint_(p);
    if (p.action === 'directorFeed') return directorFeed_(p);
    if (p.action === 'directorNote') return directorNote_(p);
    if (p.action === 'employeeLogin') return employeeLogin_(p);
    return statsEndpoint_(p);
  } catch (err) {
    return reply_(p, { ok: false, error: String(err) });
  }
}

/** Public metrics (feeds the form page + the public leaderboard). JSONP
 *  when `callback` is given — the static board reads it cross-origin with
 *  zero CORS configuration; plain JSON otherwise.
 *
 *  The PUBLIC board payload strips verification status at the source —
 *  league policy: verification NEVER appears on the leaderboard (defence
 *  in depth: the renderer never reads it either). Designation itself
 *  stays; it is public. */
function publicPlayer_(p) {
  var c = {};
  Object.keys(p).forEach(function (k) {
    /* verified = league policy (the public board never shows it);
       manager = internal reporting-line data, not for a public endpoint */
    if (k !== 'verified' && k !== 'manager') c[k] = p[k];
  });
  return c;
}

function statsEndpoint_(p) {
  var s = collect_();
  var byWeek = {};
  Object.keys(s.weeks.byWeek).forEach(function (w) {
    byWeek[w] = s.weeks.byWeek[w].map(publicPlayer_);
  });
  return reply_(p, {
    ok: true,
    totalSubmissions: s.totalSubmissions,
    totalPosts: s.totalPosts,
    uniqueMedia: s.uniqueMedia,
    lastSubmissionAt: s.lastSubmissionAt,
    players: s.players.map(publicPlayer_),
    weeks: {
      seasonStart: s.weeks.seasonStart,
      total: s.weeks.total,
      current: s.weeks.current,
      byWeek: byWeek
    },
    awards: (s.awards || []).map(function (a) {
      return { week: a.week, player: a.name, points: a.points, note: a.note };
    }),
    gates: s.gates,            // the form reads the submission switches here
    generatedAt: new Date().toISOString()
  });
}

/** Admin: every ledger row (newest first) + totals + players, key-gated.
 *  Also carries the audit catalogue (AdminLog, newest first). */
function ledgerEndpoint_(p) {
  var err = checkAdmin_(p.key);
  if (err) return reply_(p, { ok: false, error: err });
  var s = collect_();
  return reply_(p, {
    ok: true,
    generatedAt: new Date().toISOString(),
    operator: operatorOf_(p),        // identity for the console header chip
    totals: {
      totalSubmissions: s.totalSubmissions,
      totalPosts: s.totalPosts,
      uniqueMedia: s.uniqueMedia,
      lastSubmissionAt: s.lastSubmissionAt
    },
    players: s.players,
    rows: s.rows,
    log: recentLog_(150),
    gates: s.gates            // submission switches → the SUBMISSIONS panel
  });
}

/** Admin: semi-auto OCR for one screenshot — suggests the count closest
 *  to what the player claimed (falls back to the largest number seen). */
function ocrEndpoint_(p) {
  var err = checkAdmin_(p.key);
  if (err) return reply_(p, { ok: false, error: err });
  var claimed = Number(String(p.claimed || '').replace(/[^\d.]/g, '')) || 0;
  var out = ocrSuggest_(p.fileId, claimed);
  return reply_(p, out);
}

/** Submission confirmation — the browser's direct /exec leg can never read
 *  the 302 answer (no CORS headers on googleusercontent), so after sending
 *  it confirms through this JSONP action instead. Keys on the same
 *  Submission ID doPost uses for dedupe, so found:true is proof the entry
 *  is safely in the ledger. Public but harmless: a yes/no for an
 *  unguessable id, nothing else is exposed. */
function subcheckEndpoint_(p) {
  var id = String(p.id || '').trim();
  if (!id) return reply_(p, { ok: true, found: false });
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  var found = false;
  if (lastRow > 1) {
    // column located BY NAME — survives any physical column order
    var idCol = HEADERS.indexOf('Submission ID') + 1;
    var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (str_(ids[i][0]) === id) { found = true; break; }
    }
  }
  return reply_(p, { ok: true, found: found });
}

/** ---------- LINK OWNERSHIP PRE-CHECK (the form's "who uploaded this?" ask) ----------
 *  The moment a participant commits a link, the form asks the ledger who
 *  owns it BEFORE any submission exists. Three answers:
 *    taken     — another player posted this link with no collab tag for the
 *                asker → the form blocks it and names the uploader.
 *    collabFor — another player posted it AND tagged the asker as partner
 *                → the form shows "this video was collabed with you,
 *                confirm below" and the asker confirms in one tap.
 *    otherwise — free to enter (own earlier rows = a snapshot UPDATE).
 *  Read-only, keyed on the same Media ID / URL key the ingest dedupes
 *  with. Public like subcheck: it only ever returns a participant's name
 *  for a link — the same names the public leaderboard already shows. */
function checklinkEndpoint_(p) {
  var url = str_(p.url).trim();
  var fmt = str_(p.format);
  var who = normName_(str_(p.name));
  var myEmail = str_(p.email).trim().toLowerCase();
  if (myEmail && !/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(myEmail)) myEmail = '';
  var key = mediaId_(url, fmt) || urlKey_(url);
  if (!key || (!who && !myEmail)) {
    // nothing to compare yet (no identity / unknown link shape) — the form
    // treats this as "no objection" and the ingest re-checks anyway
    return reply_(p, { ok: true, checkable: false, taken: false });
  }
  var index = ledgerIndex_(getSheet_());
  var rows = index.byKey[key] || [];
  var mine = false;
  var uploader = '';
  var uploaderEmail = '';
  var collabFor = '';
  var collabForEmail = '';
  rows.forEach(function (r) {
    var own = (who && normName_(r.name) === who) ||
              (myEmail && r.playerEmail && r.playerEmail === myEmail);
    if (own) { mine = true; return; }
    if (!uploader) {
      uploader = r.name;                               // first poster wins
      uploaderEmail = r.playerEmail || '';
    }
    // the invite leg: their collab list carries MY email (legacy rows may
    // still carry my NAME — both count)
    if (!collabFor && ((myEmail &&
        chipEmails_(r.collabWith).indexOf(myEmail) >= 0) ||
        (who && normName_(r.collabWith) === who))) {
      collabFor = r.name;
      collabForEmail = r.playerEmail || '';
    }
  });
  // the asker's OWN rows always win — their resubmission is a view-count
  // UPDATE and the collab state is already on file, so no banner is needed
  if (mine) {
    return reply_(p, { ok: true, checkable: true, taken: false, mine: true });
  }
  // a collab tag aimed at THIS player beats a plain "taken" — the whole
  // point of the feature: one tap to accept and both sides score
  if (collabFor) {
    return reply_(p, { ok: true, checkable: true, taken: false,
                       collabFor: collabFor, collabForEmail: collabForEmail,
                       uploader: uploader, uploaderEmail: uploaderEmail });
  }
  if (uploader) {
    return reply_(p, { ok: true, checkable: true, taken: true,
                       uploader: uploader, uploaderEmail: uploaderEmail });
  }
  return reply_(p, { ok: true, checkable: true, taken: false });
}

/** ---------- WEEKLY CHALLENGE AWARDS (rulebook §4) ---------- */

var AWARDS_SHEET = 'PCL-Awards';
var AWARDS_HEADERS = ['Timestamp', 'Week', 'Player', 'Points', 'Note',
                      'Awarded By'];

function getAwardsSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(AWARDS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(AWARDS_SHEET);
    sheet.appendRow(AWARDS_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** All awards, blank-safe; unknown rows are skipped, not fatal. */
function getAwards_() {
  var sheet = getAwardsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var vals = sheet.getRange(2, 1, lastRow - 1, AWARDS_HEADERS.length).getValues();
  var out = [];
  vals.forEach(function (r) {
    var pts = Number(r[3]);
    if (r[1] === '' || r[1] === null) return;
    var name = str_(r[2]);
    if (!name || isNaN(pts) || pts <= 0) return;
    out.push({
      week: Number(r[1]) || 0,
      name: name,
      points: Math.ceil(pts),
      note: str_(r[4]),
      by: str_(r[5]),
      ts: r[0] instanceof Date ? r[0].toISOString() : str_(r[0])
    });
  });
  return out;
}

/** Admin POST action — grant a weekly-challenge reward (rulebook §4:
 *  6000–12000 LeaderBoard points for the week's winner). The points ride
 *  ON TOP of the post multipliers in season totals and weekly buckets. */
function awardChallenge_(payload) {
  var err = checkAdmin_(payload.adminKey);
  if (err) return json_({ ok: false, error: err });

  var week = Number(payload.week);
  var name = str_(payload.name).trim();
  var points = Math.ceil(Number(payload.points));
  var note = str_(payload.note).trim();
  if (!(week >= 1 && week <= LEAGUE_WEEKS)) {
    return json_({ ok: false, error: 'Week must be 1-' + LEAGUE_WEEKS });
  }
  if (!name) return json_({ ok: false, error: 'Player name required' });
  if (isNaN(points) || points <= 0) {
    return json_({ ok: false, error: 'Points must be a positive number' });
  }
  getAwardsSheet_().appendRow([new Date(), week, cellSafe_(name), points,
                               cellSafe_(note), operatorOf_(payload) || 'console']);
  logAdmin_(operatorOf_(payload) || 'console', 'AWARD',
            'W' + week + ' · ' + name + ' · +' + points,
            note || 'weekly challenge reward');
  return json_({ ok: true, awarded: { week: week, name: name, points: points } });
}

/** ---------- SHEET LAYOUT: review-first reorder (one-shot) ---------- */

/** Physically reorders PCL-Data columns into the review-first HEADERS
 *  order. Identity + verify columns first, machine/audit columns last.
 *  Every read and write in this script addresses columns BY HEADER NAME,
 *  so the physical order is presentation-only and this is safe to run at
 *  any time, any number of times. A full backup tab is created before
 *  anything is touched — data loss is not acceptable. */
function reorganizeForReview_() {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return 'Sheet is empty — nothing to do';

  var current = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return str_(h).trim(); });
  var inOrder = lastCol === HEADERS.length &&
    HEADERS.every(function (h, i) { return current[i] === h; });
  if (inOrder) return 'Already in review-first order';

  // 1. full backup tab before touching anything
  var ss = getSpreadsheet_();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(),
                                   'yyyyMMdd-HHmmss');
  var backupName = 'PCL-Data-Backup-' + stamp;
  ss.getSheetByName(SHEET_NAME).copyTo(ss).setName(backupName);
  SpreadsheetApp.flush();

  // 2. read everything, project columns onto the HEADERS order in memory
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var byName = {};
  current.forEach(function (h, i) {
    if (h && byName[h] === undefined) byName[h] = i;
  });
  var out = [];
  for (var r = 0; r < lastRow; r++) {
    var row = [];
    HEADERS.forEach(function (h) {
      var ci = byName[h];
      row.push(ci === undefined ? '' : values[r][ci]);
    });
    out.push(row);
  }

  // 3. rewrite (values only; legacy columns a new build no longer knows
  //    are preserved in the backup tab)
  sheet.clearContents();
  sheet.getRange(1, 1, out.length, HEADERS.length).setValues(out);
  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
  return 'Reordered to review-first layout. Backup tab: ' + backupName;
}

/** ---------- SEASON CLOCK ---------- */

var WEEK_MS_ = 7 * 24 * 60 * 60 * 1000;

/** Week number for a moment (ms epoch). Pre-season → 1, capped at 10. */
function weekOfMs_(ms) {
  var start = new Date(SEASON_START_ISO).getTime();
  if (!isFinite(ms) || ms < start) return 1;
  return Math.min(Math.floor((ms - start) / WEEK_MS_) + 1, LEAGUE_WEEKS);
}

/** The week that is live right now — 0 before the season starts. */
function currentWeek_() {
  return Date.now() < new Date(SEASON_START_ISO).getTime()
    ? 0 : weekOfMs_(Date.now());
}

/** One read pass over the ledger → rows as objects + totals + players +
 *  per-week public roll-ups for the leaderboard. */
function collect_() {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  var totalPosts = Math.max(0, lastRow - 1);
  var media = {}, subs = {}, last = null;
  var players = {};                    // per-candidate roll-up
  var rows = [];
  if (totalPosts > 0) {
    var values = sheet.getRange(2, 1, totalPosts, HEADERS.length).getValues();
    var c = {};
    HEADERS.forEach(function (h, i) { c[h] = i; });
    values.forEach(function (r, i) {
      var mid = r[c['Media ID']];
      if (mid) media[mid] = true;
      var sid = r[c['Submission ID']];
      if (sid) subs[sid] = true;

      var name = str_(r[c['Full Name']]);
      if (!name) return;
      if (!players[name]) {
        players[name] = {
          player: name,
          manager: str_(r[c['Reporting Manager']]),
          designation: '',
          verified: false,
          submissions: {},
          posts: 0,
          media: {},
          formats: {},
          projectedPoints: 0,
          verifiedPoints: 0
        };
      }
      var pl = players[name];
      // identity columns repeat on every row — last non-empty value wins
      var dg = c['Player Designation'] !== undefined ? str_(r[c['Player Designation']]) : '';
      if (dg) pl.designation = dg;
      var pv = c['Player Verified'] !== undefined ? str_(r[c['Player Verified']]) : '';
      if (pv) pl.verified = pv.toUpperCase() === 'VERIFIED';
      if (sid) pl.submissions[sid] = true;
      pl.posts++;
      if (mid) pl.media[mid] = true;   // unique media never double-counts
      var fmt = str_(r[c['Format']]);
      if (fmt) pl.formats[fmt] = (pl.formats[fmt] || 0) + 1;
      var pts = Number(r[c['Projected Points']]);
      if (!isNaN(pts)) pl.projectedPoints += pts;
      var vpts = Number(r[c['Verified Points']]);
      if (!isNaN(vpts) && str_(r[c['Verified Points']]) !== '') pl.verifiedPoints += vpts;

      var ts = r[c['Timestamp']];
      var shotUrl = str_(r[c['Screenshot Link']]);
      var fileId = driveFileId_(shotUrl);
      var photoUrl = c['Player Photo'] !== undefined ? str_(r[c['Player Photo']]) : '';
      rows.push({
        row: i + 2,                            // sheet row → write-back target
        ts: ts instanceof Date ? ts.toISOString() : str_(ts),
        id: str_(r[c['Submission ID']]),
        type: str_(r[c['Entry Type']]),
        snap: str_(r[c['Snapshot #']]),
        name: name,
        manager: str_(r[c['Reporting Manager']]),
        platform: str_(r[c['Platform']]),
        format: str_(r[c['Format']]),
        mult: r[c['Multiplier']],
        url: str_(r[c['Post URL']]),
        mediaId: str_(mid),
        week: str_(r[c['Weekly Challenge']]),
        challengeUrl: str_(r[c['Challenge URL']]),
        claimed: r[c['Claimed Views/Impressions']],
        projected: r[c['Projected Points']],
        shotName: str_(r[c['Screenshot File']]),
        shotUrl: shotUrl,
        fileId: fileId,
        thumb: fileId ? ('https://drive.google.com/thumbnail?id=' +
                         fileId + '&sz=w400') : '',
        photo: photoUrl,
        photoId: photoUrl ? driveFileId_(photoUrl) : '',
        ocr: r[c['OCR Count']],
        check: str_(r[c['Cross-Check']]) || CHECK_PENDING,
        verified: r[c['Verified Count']],
        verifiedPoints: r[c['Verified Points']],
        collabWith: c['Collab With'] !== undefined ? str_(r[c['Collab With']]) : '',
        collabStatus: c['Collab Status'] !== undefined
          ? str_(r[c['Collab Status']]) : '',
        ctype: c['Content Type'] !== undefined ? str_(r[c['Content Type']]) : '',
        email: c['Player Email'] !== undefined
          ? str_(r[c['Player Email']]) : ''
      });
    });
    var v = values[values.length - 1][0];
    last = v instanceof Date ? v.toISOString() : String(v);
  }
  // ---- Leaderboard roll-up --------------------------------------------
  // UPDATE rows repeat the FULL current count (never a delta), so summing
  // every row would double-count the same post. Per Media ID only the
  // newest snapshot is current: it wins the impressions/points, credited
  // to its player, and the media is bucketed in the week of its FIRST
  // snapshot (when the post entered the league). Verified cells win over
  // claimed/projected once the review pipeline fills them in. Confirmed
  // collab rows share one Media ID but EACH scores its own player FULL
  // points (rulebook §6 rule 2 — no halving anywhere); partner rows are
  // credited explicitly because latestByMedia keeps only the newest
  // snapshot per media.
  var latestByMedia = {}, firstByMedia = {};
  // ---- YouTube AUTO lift — the twice-daily sync leg (syncYouTube_) writes
  // the platform's own viewCount into PCL-Snapshots; the board lifts every
  // yt_ post to that number when it outruns what the ledger holds. Points
  // follow the lifted count × the row's multiplier. Instagram and LinkedIn
  // stay MANUAL (OCR) by design — snapshots never touch them.
  var ytSnaps = {};
  try {
    var snapAll = latestSnapshots_();
    Object.keys(snapAll).forEach(function (mid) {
      if (mid.indexOf('yt_') === 0 && isFinite(Number(snapAll[mid].views))) {
        ytSnaps[mid] = Number(snapAll[mid].views);
      }
    });
  } catch (ignore) { /* snapshots absent — the board runs on ledger numbers */ }
  rows.forEach(function (r) {
    var k = r.mediaId || 'row:' + r.row;
    if (!latestByMedia[k] ||
        String(r.ts).localeCompare(String(latestByMedia[k].ts)) > 0) {
      latestByMedia[k] = r;
    }
    if (!firstByMedia[k] ||
        String(r.ts).localeCompare(String(firstByMedia[k].ts)) < 0) {
      firstByMedia[k] = r;
    }
  });
  var dedup = {};                      // player → deduped season sums
  var wk = {};                         // week → player → weekly roll-up
  var desigLookup = {}, verLookup = {};   // identity for board buckets
  Object.keys(players).forEach(function (n) {
    desigLookup[n] = players[n].designation || PLAYER_META[n] || '';
    verLookup[n] = !!players[n].verified;
  });
  Object.keys(latestByMedia).forEach(function (k) {
    var r = latestByMedia[k];
    if (!players[r.name]) return;      // defensive — name keyed the roll-up
    var collabSplit = r.collabStatus === 'CONFIRMED';

    // Confirmed collab pairs share one Media ID, so the latest-snapshot rule
    // alone would erase the partner's half. Every CONFIRMED row of this
    // media credits its own player — FULL points each (rulebook §6 rule 2).
    var partners = [];
    if (collabSplit) {
      rows.forEach(function (x) {
        if ((x.mediaId || 'row:' + x.row) === k &&
            x.collabStatus === 'CONFIRMED' &&
            players[x.name] &&
            normName_(x.name) !== normName_(r.name)) {
          partners.push(x);
        }
      });
    }

    function credit(row) {
      var views = numOrBlank_(row.verified);
      if (views === '') views = toCount_(row.claimed);
      if (views === '') views = 0;
      // the YT lift — platform truth (PCL-Snapshots) when it is higher
      var ytLift = (row.mediaId && ytSnaps[row.mediaId] > views)
        ? ytSnaps[row.mediaId] : 0;
      if (ytLift) views = ytLift;
      var pts = numOrBlank_(row.verifiedPoints);
      if (ytLift) {
        // the platform number outruns the stored one — points recompute
        // from the lifted count × multiplier (the console can always
        // re-verify; its explicit verified points resume when it does)
        pts = (row.mult !== '' && !isNaN(Number(row.mult)))
          ? Math.ceil(views * Number(row.mult))
          : numOrBlank_(row.projected);
        if (pts === '') pts = 0;
      } else {
        if (pts === '') pts = numOrBlank_(row.projected);
        if (pts === '' && views > 0 && row.mult !== '' && !isNaN(Number(row.mult))) {
          pts = Math.ceil(views * Number(row.mult));
        }
        if (pts === '') pts = 0;
      }
      var d = dedup[row.name] ||
        (dedup[row.name] = { imp: 0, pts: 0, proj: 0, ver: 0 });
      d.imp += views;
      d.pts += pts;
      var proj = numOrBlank_(row.projected);
      if (proj !== '') d.proj += proj;
      var ver = numOrBlank_(row.verifiedPoints);
      if (ver !== '') d.ver += ver;
      // ROUND 35 — the weekly tabs mean WEEKLY-CHALLENGE uploads only.
      // The bucket key comes from the row's own challenge tag ("Week N —
      // name"); regular (untagged) posts score the season totals but never
      // appear in a W tab. Tag weeks and calendar weeks agree — the form
      // only lets the live week be selected — and a tag beats the clock:
      // the challenge a post was FOR is the truth, not when it landed.
      var tagged = wkNumOfLabel_(row.week);
      if (!tagged) return;                    // regular post — season only
      var bucket = wk[tagged] || (wk[tagged] = {});
      var wp = bucket[row.name] ||
        (bucket[row.name] = { player: row.name,
                              designation: desigLookup[row.name] || '',
                              verified: verLookup[row.name] || false,
                              posts: 0, impressions: 0, points: 0 });
      wp.posts++;
      wp.impressions += views;
      wp.points += pts;
    }

    credit(r);
    partners.forEach(function (x) { credit(x); });
  });
  // Weekly-challenge awards (rulebook §4) — admin-granted reward points
  // that ride ON TOP of the post multipliers, per player and per week.
  var awards = getAwards_();
  var awardTotal = {}, awardWeek = {};
  awards.forEach(function (a) {
    var k = normName_(a.name);
    if (!k) return;
    awardTotal[k] = (awardTotal[k] || 0) + a.points;
    var wkey = String(a.week);
    if (!awardWeek[wkey]) awardWeek[wkey] = {};
    awardWeek[wkey][k] = (awardWeek[wkey][k] || 0) + a.points;
  });
  var playerList = Object.keys(players).map(function (k) {
    var pl = players[k];
    var d = dedup[k] || { imp: 0, pts: 0, proj: 0, ver: 0 };
    return {
      player: pl.player,
      manager: pl.manager,
      designation: pl.designation || PLAYER_META[k] || '',
      verified: !!pl.verified,
      submissions: Object.keys(pl.submissions).length,
      posts: pl.posts,
      uniqueMedia: Object.keys(pl.media).length,
      formatRatio: pl.formats,
      impressions: d.imp,
      points: d.pts + (awardTotal[normName_(k)] || 0),
      projectedPoints: d.proj,         // deduped — latest snapshot per media
      verifiedPoints: d.ver
    };
  }).sort(function (a, b) { return b.posts - a.posts; });
  var byWeek = {};
  Object.keys(wk).map(Number)
    .sort(function (a, b) { return a - b; })
    .forEach(function (w) {
      byWeek[String(w)] = Object.keys(wk[w]).map(function (n) {
        var p = wk[w][n];
        var aw = awardWeek[String(w)];
        if (aw) p.points += aw[normName_(n)] || 0;
        return p;
      }).sort(function (a, b) {
        return b.points - a.points || b.impressions - a.impressions ||
               a.player.localeCompare(b.player);
      });
    });
  rows.sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
  // Tracked metrics join — the latest PCL-Snapshots count per Media ID rides
  // every matching ledger row so the console shows it as an AUTO tag (a
  // platform-observed number the reviewer can compare against the claim).
  try {
    var snaps = latestSnapshots_();
    if (Object.keys(snaps).length) {
      rows.forEach(function (r) {
        var s = snaps[r.mediaId];
        if (s && s.views !== '' && s.views !== undefined) {
          r.tracked = true;
          r.trackedViews = s.views;
          r.trackedAt = s.ts;
        }
      });
    }
  } catch (ignore) { /* snapshots absent — rows stay untouched */ }
  return {
    totalSubmissions: Object.keys(subs).length,
    totalPosts: totalPosts,
    uniqueMedia: Object.keys(media).length,
    lastSubmissionAt: last,
    players: playerList,
    awards: awards,
    rows: rows,
    weeks: {
      seasonStart: SEASON_START_ISO,
      total: LEAGUE_WEEKS,
      current: currentWeek_(),
      byWeek: byWeek
    },
    gates: publicGates_()      // season + per-week submission switches
  };
}

/** ---------- MEDIA ID (the dedup key) + LINK OWNERSHIP ---------- */

// One stable ID per physical post, pulled from its canonical URL:
//   IG reel/post/IGTV → shortcode      YT → video ID      LI → activity number
// Mirrors the form's classifyUrl: instagram.com + instagr.am, youtube.com
// (+ m./music./nocookie) + youtu.be, linkedin.com + lnkd.in (LinkedIn's own
// shortener). Unknown shapes return '' → the normalized URL becomes the
// ownership key instead (safe default).
//
// ROUND 35 — LinkedIn canonicalisation. The ledger had degenerate Media IDs
// ("li", "li_p"…) that collided ACROSS PLAYERS and tripped the dedup. Two
// causes: (1) the posts/<slug> capture grabbed the whole "name_text-activity-
// <id>-hash" slug instead of the activity NUMBER inside it; (2) a truncated
// or partial link fell through to a 1-char tail. The extractor now runs in
// strict priority order — the urn / activity number always beats the slug —
// and the degeneracy guard refuses any li_ tail shorter than 5 characters
// (those fall back to the URL key, which stays unique per link).
function mediaId_(url, fmt) {
  url = String(url || '');
  var m;
  if (fmt.indexOf('ig_') === 0) {
    m = url.match(/(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/([\w-]+)/i);
    if (m) return 'ig_' + m[1];
  } else if (fmt === 'yt_shorts') {
    m = url.match(/youtube(?:-nocookie)?\.com\/shorts\/([\w-]+)/i);
    if (m) return 'yt_' + m[1];
  } else if (fmt === 'yt_long') {
    m = url.match(/[?&]v=([\w-]+)/i) || url.match(/youtu\.be\/([\w-]+)/i) ||
        url.match(/youtube(?:-nocookie)?\.com\/(?:live|embed|v)\/([\w-]+)/i);
    if (m) return 'yt_' + m[1];
  } else if (fmt === 'li_post') {
    // 1. the urn form — feed/update/urn:li:activity|ugcPost|share:<digits>
    m = url.match(/urn:li:(?:activity|ugcPost|share):(\d{8,})/i);
    if (m) return 'li_' + m[1];
    // 2. the activity number anywhere in the link (posts, feed, permalinks)
    m = url.match(/activity[-:](\d{10,})/i);
    if (m) return 'li_' + m[1];
    // 3. the posts/<slug> form — re-scan the slug itself for the number
    //    first (…/posts/name_text-activity-7234…-aB1), the name alone second
    m = url.match(/linkedin\.com\/posts\/([^\/?#]+)/i);
    if (m) {
      var slug = m[1];
      var inner = slug.match(/-activity-(\d{10,})/i) || slug.match(/(\d{10,})/);
      if (inner) return 'li_' + inner[1];
      if (slug.length >= 5) return 'li_' + slug;   // named slug, long enough
      return '';                                   // "p"-style junk → URL key
    }
    // 4. Pulse articles keep their slug (unique per article)
    m = url.match(/linkedin\.com\/pulse\/([^\/?#]+)/i);
    if (m && m[1].length >= 5) return 'li_' + m[1];
    // 5. lnkd.in opaque tokens — unique per share
    m = url.match(/lnkd\.in\/([\w-]+)/i);
    if (m && m[1].length >= 5) return 'li_' + m[1];
    return '';
  }
  return '';
}

/** A stored Media ID no extractor should ever produce again ("li", "li_p",
 *  "li_urn:…" residue). These are the cross-player COLLISION ids — the
 *  repair pass rewrites them and ingest prefers the URL key over them. */
function degenerateMediaId_(mid) {
  var s = String(mid || '');
  if (!s) return false;
  if (s.indexOf('li_') === 0) {
    var tail = s.slice(3);
    if (!tail || tail.length < 5) return true;          // li, li_p, li_ab
    if (/^urn:/i.test(tail)) return true;               // li_urn:li:ugcPost:…
    if (/[-_]activity[-:]/i.test(tail) && !/^\d{10,}$/.test(tail)) return true;
  }
  return false;
}

/** ---------- MEDIA ID REPAIR (one click, ROUND 35) ----------
 *  Rewrites every ledger Media ID to today's canonical extraction. Fixes
 *  the LinkedIn duplication era: degenerate ids ("li", "li_p"), full-slug
 *  ids ("li_name_text-activity-7234…-aB1") and empty cells all become the
 *  canonical "li_<activity-number>" — so the same physical post ALWAYS
 *  carries one key, whichever shape of link was pasted. Rows whose stored
 *  id already matches the canonical extraction are left untouched; IG/YT
 *  ids recompute to themselves by construction. Old snapshots keep their
 *  rows (history), the OCR count lives in the ledger cell anyway. */
function repairRun_() {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  var out = { scanned: 0, rewritten: 0, cleared: 0, mergedKeys: 0 };
  if (lastRow < 2) return out;
  var idCol = HEADERS.indexOf('Media ID') + 1;
  var fmtCol = HEADERS.indexOf('Format') + 1;
  var urlCol = HEADERS.indexOf('Post URL') + 1;
  var rng = sheet.getRange(2, 1, lastRow - 1, HEADERS.length);
  var vals = rng.getValues();
  var mapTo = {};                        // old id → new id (merge detector)
  var writes = [];                       // [rowIndex, newValue]
  for (var i = 0; i < vals.length; i++) {
    var stored = str_(vals[i][idCol - 1]).trim();
    var fmt = str_(vals[i][fmtCol - 1]).trim();
    var url = str_(vals[i][urlCol - 1]).trim();
    if (!fmt || !url) continue;
    out.scanned++;
    var computed = mediaId_(url, fmt);
    var next = stored;
    if (!stored) {
      if (computed) next = computed;                 // fill the empty cell
    } else if (degenerateMediaId_(stored)) {
      next = computed;                               // junk → canonical (or '')
    } else if (computed && computed !== stored) {
      next = computed;                               // legacy slug → canonical
    }
    if (next !== stored) {
      writes.push([i + 2, next]);
      if (next) mapTo[stored] = next;   // merge detector input
      if (!next) out.cleared++;
    }
  }
  // merge detector: distinct OLD ids now sharing one NEW canonical key
  var byNew = {};
  Object.keys(mapTo).forEach(function (old) {
    var nw = mapTo[old];
    byNew[nw] = (byNew[nw] || 0) + 1;
  });
  Object.keys(byNew).forEach(function (nw) {
    if (byNew[nw] > 1) out.mergedKeys++;
  });
  writes.forEach(function (w) {
    sheet.getRange(w[0], idCol).setValue(w[1]);
  });
  out.rewritten = writes.length;
  return out;
}

/** Admin POST action — {action:'repairMediaIds', adminKey} → run + log. */
function repairMediaIds_(payload) {
  var err = checkAdmin_(payload.adminKey);
  if (err) return json_({ ok: false, error: err });
  var out = repairRun_();
  logAdmin_(operatorOf_(payload) || 'console', 'REPAIR', 'media ids',
    out.rewritten + '/' + out.scanned + ' rows rewritten' +
    (out.cleared ? ' · ' + out.cleared + ' cleared to URL-key' : '') +
    (out.mergedKeys ? ' · ' + out.mergedKeys + ' key merges' : ''));
  return json_({ ok: true, result: out });
}

/** Editor-runnable twin — run repairLedgerMediaIds() from the Apps Script
 *  editor once if you prefer not to use the console button. */
function repairLedgerMediaIds() {
  var out = repairRun_();
  logAdmin_('editor', 'REPAIR', 'media ids',
    out.rewritten + '/' + out.scanned + ' rows rewritten' +
    (out.mergedKeys ? ' · ' + out.mergedKeys + ' key merges' : ''));
  return out.rewritten + ' of ' + out.scanned + ' rows rewritten' +
    (out.cleared ? ' (' + out.cleared + ' cleared to URL-key)' : '') +
    (out.mergedKeys ? ' · ' + out.mergedKeys + ' duplicate keys merged' : '');
}

/** "Week 2 — Best Storytelling Debut" → 2 · anything else → 0.
 *  Shared by the director feed, the roll-up's challenge-only weekly buckets
 *  and the ingest gates — one parser, one behaviour everywhere. */
function wkNumOfLabel_(label) {
  var m = String(label || '').match(/^Week\s+(\d+)\b/i);
  return m ? Number(m[1]) : 0;
}

/** ---------- SUBMISSION GATES (Control Room power, ROUND 35) ----------
 *  The admins can close the whole season or any single week's challenge
 *  entries without touching code. Settings live in a tiny PCL-Settings tab
 *  (Key/Value) so they stay visible and editable by hand; absent rows mean
 *  OPEN — the season clock stays the only gate by default.
 *    gate.seasonOpen  = '0'  → EVERY submission refused
 *    gate.week.<n>    = '0'  → challenge-tagged posts for week n refused
 *  Regular ("Not entering") posts only answer to the season switch. */
var GATES_SHEET = 'PCL-Settings';

function getGatesSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(GATES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(GATES_SHEET);
    sh.appendRow(['Key', 'Value', 'Updated', 'Updated By']);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Read pass → { seasonOpen: bool, weeks: {1..10: bool}, raw: {...} }.
 *  Any missing/blank key = open. Anything non-'0' also reads open, so a
 *  typo can never lock the league out by accident. */
function readSubmitGates_() {
  var out = { seasonOpen: true, weeks: {}, raw: {} };
  for (var w = 1; w <= LEAGUE_WEEKS; w++) out.weeks[String(w)] = true;
  try {
    var sh = getGatesSheet_();
    var last = sh.getLastRow();
    if (last < 2) return out;
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    vals.forEach(function (r) {
      var k = str_(r[0]).trim();
      var v = str_(r[1]).trim();
      if (!k) return;
      out.raw[k] = v;
      if (k === 'gate.seasonOpen') out.seasonOpen = v !== '0';
      var mw = k.match(/^gate\.week\.(\d+)$/);
      if (mw) {
        var n = Number(mw[1]);
        if (n >= 1 && n <= LEAGUE_WEEKS) out.weeks[String(n)] = v !== '0';
      }
    });
  } catch (ignore) { /* settings tab absent → everything open */ }
  return out;
}

/** Write one gate key ('0' = closed, '1' = open) with an audit trail. */
function writeGate_(key, open, operator) {
  var sh = getGatesSheet_();
  var last = sh.getLastRow();
  var vals = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
  var row = 0;
  for (var i = 0; i < vals.length; i++) {
    if (str_(vals[i][0]).trim() === key) { row = i + 2; break; }
  }
  if (row) {
    sh.getRange(row, 2, 1, 3).setValues([[open ? '1' : '0', new Date(),
                                          operator || 'console']]);
  } else {
    sh.appendRow([key, open ? '1' : '0', new Date(), operator || 'console']);
  }
}

/** Admin POST action — {action:'setGate', adminKey, scope:'season'|'week',
 *  week:<n>, open:<bool>} → writes the settings row + AdminLog. */
function setGate_(payload) {
  var err = checkAdmin_(payload.adminKey);
  if (err) return json_({ ok: false, error: err });
  var scope = String(payload.scope || '').toLowerCase();
  var operator = operatorOf_(payload) || 'console';
  if (scope === 'season') {
    writeGate_('gate.seasonOpen', !!payload.open, operator);
    logAdmin_(operator, 'GATE', 'season',
              payload.open ? 'SEASON SUBMISSIONS OPEN' : 'SEASON SUBMISSIONS CLOSED');
    return json_({ ok: true, scope: 'season', open: !!payload.open });
  }
  if (scope === 'week') {
    var n = Number(payload.week);
    if (!(n >= 1 && n <= LEAGUE_WEEKS)) {
      return json_({ ok: false, error: 'Week must be 1-' + LEAGUE_WEEKS });
    }
    writeGate_('gate.week.' + n, !!payload.open, operator);
    logAdmin_(operator, 'GATE', 'week ' + n,
              payload.open ? 'WEEK ' + n + ' ENTRIES OPEN' :
                             'WEEK ' + n + ' ENTRIES CLOSED');
    return json_({ ok: true, scope: 'week', week: n, open: !!payload.open });
  }
  return json_({ ok: false, error: 'Unknown gate scope.' });
}

/** The public shape that rides the stats/collect responses — booleans only,
 *  no settings internals. */
function publicGates_() {
  var g = readSubmitGates_();
  return { seasonOpen: g.seasonOpen, weeks: g.weeks };
}

/** Comparison form of a player's name — whitespace/case tolerant so
 *  "priya   sharma" matches "Priya Sharma" in collab + ownership checks. */
function normName_(s) {
  return str_(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The work emails inside a Collab-With cell — the collab list now carries
 *  comma-separated emails ("a@praper.in, b@praper.in"); anything without an
 *  @ (a legacy partner NAME) is ignored here, the name-matching leg still
 *  honours it. */
function chipEmails_(cell) {
  var out = [];
  String(cell || '').split(/[,;\s]+/).forEach(function (tok) {
    tok = tok.trim().toLowerCase();
    if (tok.indexOf('@') > 0 && out.indexOf(tok) < 0) out.push(tok);
  });
  return out;
}

/** "Rohit Kharal" → "Rohit" — banners stay short. */
function firstName_(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

/** Fallback ownership key when no Media ID could be extracted: the URL
 *  stripped of protocol, www, query string and trailing slashes. */
function urlKey_(url) {
  var s = str_(url).trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();
  return s.split(/[?#]/)[0].replace(/\/+$/, '');
}

/** One read pass over the ledger for the submission checks:
 *  subIds — every Submission ID seen (retried-submission guard);
 *  byKey  — Media ID / URL → [{row, name, snapshot, collabWith, status,
 *                             playerEmail}]. */
function ledgerIndex_(sheet) {
  var out = { byKey: {}, subIds: {}, desigByName: {}, verifiedByName: {} };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  var vals = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var c = {};
  HEADERS.forEach(function (h, i) { c[h] = i; });
  vals.forEach(function (r, i) {
    var sid = str_(r[c['Submission ID']]);
    if (sid) out.subIds[sid] = true;
    // player identity roll-up (rows are oldest → newest, so the last
    // non-empty value wins = the player's CURRENT designation/verification)
    var who = normName_(r[c['Full Name']]);
    if (who) {
      var dg = c['Player Designation'] !== undefined ? str_(r[c['Player Designation']]) : '';
      if (dg) out.desigByName[who] = dg;
      var pv = c['Player Verified'] !== undefined ? str_(r[c['Player Verified']]) : '';
      if (pv) out.verifiedByName[who] = pv.toUpperCase() === 'VERIFIED';
    }
    var mid = str_(r[c['Media ID']]);
    var key = mid || urlKey_(r[c['Post URL']]);
    if (!key) return;
    (out.byKey[key] = out.byKey[key] || []).push({
      row: i + 2,
      name: str_(r[c['Full Name']]),
      snapshot: Number(r[c['Snapshot #']]) || 1,
      collabWith: c['Collab With'] !== undefined ? str_(r[c['Collab With']]) : '',
      status: c['Collab Status'] !== undefined ? str_(r[c['Collab Status']]) : '',
      playerEmail: c['Player Email'] !== undefined
        ? str_(r[c['Player Email']]).trim().toLowerCase() : ''
    });
  });
  return out;
}

/** ---------- ADMIN CONSOLE ---------- */

/** The six league admins — password is the identity. Keep this list the
 *  single source of truth: rotate a password here, deploy a new version,
 *  done. (Never move this list client-side.) */
var ADMINS = [
  { pass: '8q41my67tks9',  name: 'Pratham Jindal' },
  { pass: 'lfi9g1y67fo9',  name: 'Lagan Garg' },
  { pass: '40jnj8o83bd7',  name: 'Vikram Singh Mawari' },
  { pass: '7mvs8l9xs0qd',  name: 'Sejal Choudhary' },
  { pass: '55adv8mo00f9',  name: 'Kanupriya Srikoti' },
  { pass: 'x898xes4shct',  name: 'Manas Ranjan' }
];

/** Look an admin up by password; null when the password matches nobody. */
function adminByPass_(key) {
  var k = String(key == null ? '' : key).trim();
  for (var i = 0; i < ADMINS.length; i++) {
    if (ADMINS[i].pass === k) return ADMINS[i];
  }
  return null;
}

/** Operator name derived from the request's own credentials (adminKey on
 *  POST payloads, key on JSONP GETs). '' when unrecognised. Audit entries
 *  always use this — a client-supplied operator name is never trusted. */
function operatorOf_(payload) {
  if (!payload) return '';
  var raw = (payload.adminKey !== undefined && payload.adminKey !== null)
    ? payload.adminKey : payload.key;
  var a = adminByPass_(raw);
  return a ? a.name : '';
}

function checkAdmin_(key) {
  if (!adminByPass_(key)) return 'Access denied — wrong admin password.';
  return '';
}

/** ---------- CEO SCREENING ROOM + EMPLOYEE SIGN-IN ---------- */

/** Screening-room passcode — the ONLY key that opens the private weekly-
 *  challenge viewer (director.html) for the Director/CEO. It is separate
 *  from the six admin passwords on purpose: the screening room is the
 *  CEO's room, nobody else's. Rotate any time: Script Properties →
 *  add/update `CEO_CODE` — the default below then stops working. */
var DIRECTOR_CODE = 'director@123';
function directorCode_() {
  return String(PropertiesService.getScriptProperties()
    .getProperty('CEO_CODE') || '').trim() || DIRECTOR_CODE;
}

/** Google employee sign-in. GOOGLE_OAUTH_CLIENT_ID must hold the SAME
 *  OAuth Client ID as js/gas-endpoint.js (it verifies the ID token's
 *  audience). Empty = the audience check is skipped (domain + allowlist
 *  still enforced) — fill it in once the OAuth client exists. */
var GOOGLE_OAUTH_CLIENT_ID = '199911099744-6pt5fvjcl5u8g4qk06tlpqigd7tbaev8.apps.googleusercontent.com';
var EMPLOYEE_DOMAIN = 'praper.in';

/** The active-employee email log lives in its own tab (PCL-Allowlist):
 *  one @praper.in email per row, first column, from row 2 down. Admins
 *  edit the sheet directly — no redeploy needed. A blank/missing tab
 *  DENIES every sign-in (employees only, by design). */
var ALLOWLIST_SHEET = 'PCL-Allowlist';
var ALLOWLIST_HEADERS = ['Email (one per row — @praper.in addresses only)'];

function getAllowlistSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(ALLOWLIST_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ALLOWLIST_SHEET);
    sheet.appendRow(ALLOWLIST_HEADERS);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < ALLOWLIST_HEADERS.length) {
    sheet.getRange(1, sheet.getLastColumn() + 1, 1,
                   ALLOWLIST_HEADERS.length - sheet.getLastColumn())
         .setValues([ALLOWLIST_HEADERS.slice(sheet.getLastColumn())]);
  }
  return sheet;
}

function allowlistHas_(email) {
  var want = String(email || '').trim().toLowerCase();
  if (!want) return false;
  try {
    var sheet = getAllowlistSheet_();
    var last = sheet.getLastRow();
    if (last < 2) return false;
    var vals = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (str_(vals[i][0]).trim().toLowerCase() === want) return true;
    }
    return false;
  } catch (ignore) {
    return false;   // unreadable allowlist denies — never waves someone in
  }
}

/** Best-effort map of the Google profile name onto the league roster so
 *  the form can prefill the exact ledger identity after sign-in. */
function rosterNameFor_(profileName) {
  var want = normName_(profileName);
  if (!want) return '';
  var names = Object.keys(PLAYER_META);
  for (var i = 0; i < names.length; i++) {
    if (normName_(names[i]) === want) {
      return String(names[i]).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }
  }
  return '';
}

/** EMPLOYEE SIGN-IN (Google) — verifies a Google ID token SERVER-SIDE via
 *  Google's tokeninfo endpoint, then gates on BOTH the company domain AND
 *  the active-employee allowlist. GET:
 *  ?action=employeeLogin&token=<ID_TOKEN> →
 *    { ok, email, name, matchedName }  or  { ok:false, error }
 *  ?action=employeeLogin&email=<WORK_EMAIL> →
 *    INTERIM fallback while some browsers block the Google pop-up hand-over
 *    (COOP / shields): the employee types only their work email and the
 *    backend applies the SAME two gates — company domain + allowlist.
 *    No token, no client-side trust; a non-employee address never gets in. */
function employeeLogin_(p) {
  var email = str_(p.email).trim().toLowerCase();
  if (email) return emailLogin_(p, email);
  var token = str_(p.token);
  if (!token) return reply_(p, { ok: false, error: 'Missing Google token.' });
  var info;
  try {
    var res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return reply_(p, { ok: false, error: 'Google could not verify this sign-in. Try again.' });
    }
    info = JSON.parse(res.getContentText());
  } catch (err) {
    return reply_(p, { ok: false, error: 'Could not reach Google to verify the sign-in.' });
  }
  var email = String(info.email || '').toLowerCase();
  if (String(info.email_verified) !== 'true' && info.email_verified !== true) {
    return reply_(p, { ok: false, error: 'This Google account has no verified email.' });
  }
  if (GOOGLE_OAUTH_CLIENT_ID && info.aud !== GOOGLE_OAUTH_CLIENT_ID) {
    return reply_(p, { ok: false, error: 'This sign-in was issued for a different app.' });
  }
  var dom = '@' + String(EMPLOYEE_DOMAIN).toLowerCase();
  if (email.slice(-dom.length) !== dom) {
    return reply_(p, { ok: false,
      error: 'Employees only — sign in with your @' + EMPLOYEE_DOMAIN + ' work account.' });
  }
  if (!allowlistHas_(email)) {
    return reply_(p, { ok: false,
      error: 'Your email is not on the active employee list yet — ask an admin to add it to the PCL-Allowlist tab of the league sheet.' });
  }
  return reply_(p, { ok: true, email: email, name: str_(info.name),
                     matchedName: rosterNameFor_(info.name) });
}

/** The email fallback leg of employeeLogin_ (see the doc above). Gated on
 *  the exact same two checks the token path applies — the @praper.in
 *  domain and the PCL-Allowlist roster — so the fallback can never wave
 *  anyone through whom the Google path would refuse. */
function emailLogin_(p, email) {
  var dom = '@' + String(EMPLOYEE_DOMAIN).toLowerCase();
  var re = new RegExp('^[a-z0-9._%+\'-]+@' +
    String(EMPLOYEE_DOMAIN).toLowerCase().replace(/[.\-]/g, '\\$&') + '$');
  if (!re.test(email)) {
    return reply_(p, { ok: false,
      error: 'Enter your full @' + EMPLOYEE_DOMAIN + ' work email.' });
  }
  if (!allowlistHas_(email)) {
    return reply_(p, { ok: false,
      error: 'Your email is not on the active employee list yet — ask an admin to add it to the PCL-Allowlist tab of the league sheet.' });
  }
  return reply_(p, { ok: true, email: email, name: '',
                     matchedName: rosterEmailToName_(email) });
}

/** Best-effort ledger identity from a work email — "first.last@praper.in"
 *  → "First Last" → matched against the roster like the Google path does.
 *  Returns '' when the guess does not match; the employee then types their
 *  name as before. */
function rosterEmailToName_(email) {
  var local = String(email || '').split('@')[0] || '';
  var guess = local.split(/[._\-]+/).filter(String).join(' ');
  return rosterNameFor_(guess);
}

/** CEO SCREENING ROOM feed — the private passcode-gated viewer. Without the
 *  right passcode the endpoint leaks nothing. Read-only JSONP.
 *  Two collections, both deduped per Media ID (the newest snapshot wins) with
 *  collab partners of the same post merged into one entry:
 *    entries — THIS week's weekly-challenge posts (the opening tab)
 *    regular — the WHOLE season: every post, challenge or not, any week
 *  Each entry carries parallel per-person arrays (names/designations/photos/
 *  views) so the theatre chips can show the player photo and their OCR-view
 *  count without a second round-trip. Both lists play in submission order.
 *  Also carries the Director's own marks from the Director-Log tab:
 *    picks[] — media IDs starred by the Director (his final wishes)
 *    noteWeeks / noteSeason — his latest written note per scope. */
function directorFeed_(p) {
  if (String(p.code || '').trim() !== directorCode_()) {
    return reply_(p, { ok: false, error: 'Access denied — wrong screening passcode.' });
  }
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  // The room can browse ANY week — ?week=N — default = the live week.
  // weekCounts tells the chips what each week holds so "nothing to review"
  // never comes as a surprise again.
  var liveWeek = currentWeek_();
  var wantWeek = Number(p.week);
  if (!(wantWeek >= 1 && wantWeek <= LEAGUE_WEEKS)) wantWeek = liveWeek || 1;
  var out = { ok: true, week: wantWeek, liveWeek: liveWeek,
              entries: [], regular: [],
              picks: [], noteWeeks: {}, noteSeason: '',
              weekCounts: { challenge: {}, all: {} },
              generatedAt: new Date().toISOString() };
  try {
    var log = readDirectorLog_();
    out.picks = log.picks;
    out.noteWeeks = log.noteWeeks;
    out.noteSeason = log.noteSeason;
  } catch (ignore) { /* log absent — the room runs without marks */ }
  if (lastRow < 2) return reply_(p, out);
  var vals = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var c = {};
  HEADERS.forEach(function (h, i) { c[h] = i; });
  var want = 'Week ' + wantWeek;   // stored as "Week N — Challenge Name"
  function numCell_(v) {
    if (v === '' || v === null || v === undefined) return '';
    var n = Number(String(v).replace(/[,\s]/g, ''));
    return isNaN(n) ? '' : n;
  }
  var allByMedia = {};             // every post of the season
  var challengeKeys = {};          // keys that belong to the BROWSED week's challenge
  for (var i = vals.length - 1; i >= 0; i--) {          // newest first
    var wk = str_(vals[i][c['Weekly Challenge']]);
    var isChallenge = wkNumOfLabel_(wk) > 0;
    var url = str_(vals[i][c['Post URL']]);
    var key = str_(vals[i][c['Media ID']]) || url;
    if (!key) continue;
    var nm = str_(vals[i][c['Full Name']]);
    if (!nm) continue;
    var entry = allByMedia[key];
    if (!entry) {
      entry = allByMedia[key] = {
        mediaId: key,
        people: {},
        order: [],
        platform: str_(vals[i][c['Platform']]),
        format: str_(vals[i][c['Format']]),
        url: url,
        challenge: wk,
        weekNum: wkNumOfLabel_(wk),
        isChallenge: isChallenge,
        challengeUrl: str_(vals[i][c['Challenge URL']]),
        submittedAt: vals[i][c['Timestamp']] instanceof Date
          ? vals[i][c['Timestamp']].toISOString() : str_(vals[i][c['Timestamp']]),
        screenshot: str_(vals[i][c['Screenshot Link']])
      };
      // count DISTINCT media once per week bucket (the room dedups by media)
      var wkn = wkNumOfLabel_(wk);
      if (wkn) out.weekCounts.challenge[wkn] = (out.weekCounts.challenge[wkn] || 0) + 1;
      out.weekCounts.all[wkn || 'regular'] = (out.weekCounts.all[wkn || 'regular'] || 0) + 1;
    }
    if (isChallenge && wk.indexOf(want) === 0) challengeKeys[key] = true;
    // collab-partner merge + per-person newest-wins photo/views
    var views = numCell_(vals[i][c['OCR Count']]);
    var photo = str_(vals[i][c['Player Photo']]);
    var pkey = normName_(nm);
    var who = entry.people[pkey];
    if (!who) {
      who = entry.people[pkey] = { name: nm,
        designation: str_(vals[i][c['Player Designation']]),
        photo: photo,
        views: views };
      entry.order.push(pkey);
    } else {
      if (who.views === '' && views !== '') who.views = views;
      if (who.photo === '' && photo !== '') who.photo = photo;
    }
  }
  function toOut_(entry) {
    return {
      mediaId: entry.mediaId,
      names: entry.order.map(function (k) { return entry.people[k].name; }),
      designations: entry.order.map(function (k) { return entry.people[k].designation; }),
      photos: entry.order.map(function (k) { return entry.people[k].photo; }),
      views: entry.order.map(function (k) { return entry.people[k].views; }),
      platform: entry.platform,
      format: entry.format,
      url: entry.url,
      challenge: entry.challenge,
      weekNum: entry.weekNum,
      isChallenge: entry.isChallenge,
      challengeUrl: entry.challengeUrl,
      submittedAt: entry.submittedAt,
      screenshot: entry.screenshot
    };
  }
  Object.keys(allByMedia).forEach(function (k) {
    if (challengeKeys[k]) out.entries.push(toOut_(allByMedia[k]));
    out.regular.push(toOut_(allByMedia[k]));
  });
  function chrono_(a, b) {
    return String(a.submittedAt).localeCompare(String(b.submittedAt));
  }
  out.entries.sort(chrono_);       // submission order — the default tab
  out.regular.sort(chrono_);       // the ALL CONTENTS tab
  return reply_(p, out);
}

/** ---------- THE DIRECTOR'S LOG (his notes + final wishes) ----------
 *  A private append-only tab, written ONLY through the passcode-gated
 *  directorNote action. The Screening Room reads it back via directorFeed:
 *    Scope  'week:N' | 'season'      — which panel the note belongs to
 *    Type   NOTE | PICK | UNPICK     — what the Director did
 *    Target media ID (picks) / ''    — which post a pick toggles
 *    Text   the note (NOTE only)     — scores, verdicts, anything
 *  Latest note per scope wins; PICK/UNPICK toggle per media (latest wins).
 *  cellSafe_ guards every write; the passcode gates every write. */
var DIRLOG_SHEET = 'Director-Log';
var DIRLOG_HEADERS = ['Timestamp', 'Scope', 'Type', 'Target', 'Text'];

function getDirectorLogSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(DIRLOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(DIRLOG_SHEET);
    sheet.appendRow(DIRLOG_HEADERS);
    sheet.setFrozenRows(1);
    try { ss.setTabColor(DIRLOG_SHEET, '#0d9dd6'); } catch (ignore) { /* ok */ }
  }
  return sheet;
}

/** Latest-per-scope notes + the current pick set, in one read pass. */
function readDirectorLog_() {
  var out = { picks: [], noteWeeks: {}, noteSeason: '' };
  var sheet = getDirectorLogSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return out;
  var vals = sheet.getRange(2, 1, last - 1, DIRLOG_HEADERS.length).getValues();
  var pickState = {};                  // mediaId → picked?
  vals.forEach(function (r) {
    var scope = str_(r[1]);
    var type = str_(r[2]).toUpperCase();
    var target = str_(r[3]);
    var text = str_(r[4]);
    if (type === 'PICK') pickState[target] = true;
    else if (type === 'UNPICK') pickState[target] = false;
    else if (type === 'NOTE') {
      if (scope === 'season') out.noteSeason = text;
      else {
        var m = scope.match(/^week:(\d+)$/);
        if (m) out.noteWeeks[m[1]] = text;
      }
    }
  });
  Object.keys(pickState).forEach(function (mid) {
    if (pickState[mid]) out.picks.push(mid);
  });
  return out;
}

/** WRITE leg — ?action=directorNote&code=…&type=note|pick|unpick
 *  &scope=week|season&week=N&target=<mediaId>&text=…
 *  The Director's panel calls it on SAVE NOTE / star toggles. */
function directorNote_(p) {
  if (String(p.code || '').trim() !== directorCode_()) {
    return reply_(p, { ok: false, error: 'Access denied — wrong screening passcode.' });
  }
  var type = String(p.type || '').trim().toLowerCase();
  if (['note', 'pick', 'unpick'].indexOf(type) < 0) {
    return reply_(p, { ok: false, error: 'Unknown note action.' });
  }
  var scopeKey;
  if (type === 'note') {
    var scope = String(p.scope || '').trim().toLowerCase();
    if (scope === 'season') scopeKey = 'season';
    else {
      var w = Number(p.week);
      if (!(w >= 1 && w <= LEAGUE_WEEKS)) {
        return reply_(p, { ok: false, error: 'Unknown week for the note.' });
      }
      scopeKey = 'week:' + w;
    }
  } else {
    scopeKey = '';                     // picks carry their media id instead
  }
  var target = type === 'note' ? '' : str_(p.target).slice(0, 120);
  if (type !== 'note' && !target) {
    return reply_(p, { ok: false, error: 'Missing post reference.' });
  }
  var text = type === 'note' ? cellSafe_(str_(p.text).slice(0, 1500)) : '';
  try {
    getDirectorLogSheet_().appendRow([
      new Date(),
      type === 'note' ? scopeKey : '',
      type.toUpperCase(),
      cellSafe_(target),
      text
    ]);
    try {
      logAdmin_('director', 'NOTE', type.toUpperCase(),
        (type === 'note' ? scopeKey : target) +
        (text ? ' — ' + text.slice(0, 60) : ''));
    } catch (ignore) { /* audit is best-effort */ }
    return reply_(p, { ok: true });
  } catch (err) {
    return reply_(p, { ok: false, error: 'Could not save the note — try again.' });
  }
}

// Admin write-back: {action:'adminVerify', adminKey, updates:[
//   {row:<sheet row>, ocrCount:…, crossCheck:…, verifiedCount:…,
//    contentType:'PRAPER'|'PERSONAL'|''}, … ]}
// Verified Points are always recomputed here — the console never sends them.
// Every write is catalogued in the AdminLog sheet (operator + old→new values)
// so accidental/random edits in the Control Room are always traceable.
function adminVerify_(payload) {
  var err = checkAdmin_(payload.adminKey);
  if (err) return json_({ ok: false, error: err });

  var updates = Array.isArray(payload.updates) ? payload.updates : [];
  if (!updates.length) {
    return json_({ ok: false, error: 'No updates in request' });
  }

  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  var updated = 0, errors = [];
  var nameCol = HEADERS.indexOf('Full Name') + 1;
  var ctCol = HEADERS.indexOf('Content Type') + 1;

  updates.forEach(function (u) {
    var row = Math.floor(Number(u.row));
    if (!row || row < 2 || row > lastRow) {
      errors.push({ row: u.row, error: 'Row out of range' });
      return;
    }
    var mult = Number(sheet.getRange(row, HEADERS.indexOf('Multiplier') + 1, 1, 1)
                       .getDisplayValue().replace(/[^\d.]/g, '')) || 1;

    var ocr = numOrBlank_(u.ocrCount);
    var vcount = numOrBlank_(u.verifiedCount);
    var check = String(u.crossCheck || '').toUpperCase().trim() || CHECK_PENDING;
    if (CHECK_VALUES.indexOf(check) < 0) {
      errors.push({ row: row, error: 'Cross-Check must be one of: ' +
                    CHECK_VALUES.join(', ') });
      return;
    }
    // A typed verified count promotes the row to MATCH (reviewer decision
    // can still override it by sending a different crossCheck).
    if (vcount !== '' && String(u.crossCheck || '').trim() === '') check = 'MATCH';

    // 50:50 balance tagging — only the two rulebook §6 values are legal
    var ctype = String(u.contentType || '').toUpperCase().trim();
    if (ctype && ctype !== 'PRAPER' && ctype !== 'PERSONAL') {
      errors.push({ row: row, error: 'Content Type must be PRAPER or PERSONAL' });
      return;
    }

    // Confirmed collab pairs BOTH earn the post's FULL points (rulebook
    // §6 rule 2: "Both employees will receive 1,250 leaderboard points
    // each") — the rows share a Media ID, never the points.
    var vpoints = (vcount !== '') ? Math.ceil(vcount * mult) : '';

    // capture the old review values BEFORE writing (for the audit log)
    var oldVals = sheet.getRange(row, COL_OCR, 1, 4).getDisplayValues()[0];
    var oldCt = str_(sheet.getRange(row, ctCol, 1, 1).getDisplayValue());
    var pname = sheet.getRange(row, nameCol, 1, 1).getDisplayValue();

    sheet.getRange(row, COL_OCR, 1, 4)
         .setValues([[ocr, check, vcount, vpoints]]);
    if (ctype) sheet.getRange(row, ctCol).setValue(ctype);
    updated++;

    logAdmin_(operatorOf_(payload) || 'console', 'VERIFY', 'row ' + row + ' · ' + pname,
      'OCR: ' + oldVals[0] + '→' + (ocr === '' ? '—' : ocr) +
      ' · CHECK: ' + oldVals[1] + '→' + check +
      ' · VERIFIED: ' + oldVals[2] + '→' + (vcount === '' ? '—' : vcount) +
      ' · VPTS: ' + oldVals[3] + '→' + (vpoints === '' ? '—' : vpoints) +
      (ctype ? ' · CT: ' + (oldCt || '—') + '→' + ctype : ''));
  });

  return json_({ ok: errors.length === 0, updated: updated,
                 errors: errors, error: errors.length
                   ? errors[0].error : undefined });
}

/** Admin IDENTITY verification — flips a PLAYER's verified tick (photo +
 *  designation confirmed by a human). {action:'adminPlayerVerify', adminKey,
 *  operator, players:[{name:'…', verified:true|false}]}. Writes the
 *  'Player Verified' column on EVERY row of that player (a single read pass
 *  then always carries the flag) and catalogues the change. */
function adminPlayerVerify_(payload) {
  var err = checkAdmin_(payload.adminKey);
  if (err) return json_({ ok: false, error: err });

  var list = Array.isArray(payload.players) ? payload.players : [];
  if (!list.length) return json_({ ok: false, error: 'No players in request' });

  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return json_({ ok: false, error: 'Ledger is empty' });

  var nameCol = HEADERS.indexOf('Full Name') + 1;
  var verCol = HEADERS.indexOf('Player Verified') + 1;
  var vals = sheet.getRange(2, nameCol, lastRow - 1, 1).getValues();

  // bucket sheet rows per requested player (case/whitespace tolerant)
  var wanted = {};
  list.forEach(function (p) {
    var n = normName_(p.name);
    if (n) wanted[n] = { name: str_(p.name), verified: !!p.verified, rows: [] };
  });
  for (var i = 0; i < vals.length; i++) {
    var w = wanted[normName_(vals[i][0])];
    if (w) w.rows.push(i + 2);
  }

  var updated = 0, errors = [];
  Object.keys(wanted).forEach(function (n) {
    var w = wanted[n];
    if (!w.rows.length) {
      errors.push({ name: w.name, error: 'No ledger rows for this player yet' });
      return;
    }
    var val = w.verified ? 'VERIFIED' : '';
    w.rows.forEach(function (row) {
      sheet.getRange(row, verCol).setValue(val);
      updated++;
    });
    logAdmin_(operatorOf_(payload) || 'console',
      w.verified ? 'VERIFY-ID' : 'UNVERIFY-ID',
      w.name + ' · ' + w.rows.length + ' row(s)',
      'identity ' + (w.verified ? 'VERIFIED (tick on)' : 'unverified (tick off)'));
  });

  return json_({ ok: errors.length === 0, updated: updated,
                 errors: errors, error: errors.length
                   ? errors[0].error : undefined });
}

/** Admin LOGIN trail — the password IS the identity, so the operator name
 *  in the audit log is derived SERVER-SIDE from it (a client can never
 *  sign an entry under somebody else's name). The browser fingerprint still
 *  rides along as audit context (who unlocks from where) but gates nothing:
 *  a new device just works, because knowing the password is the proof.
 *  Post: {action:'adminLogin', adminKey, device} → {ok, operator} */
function adminLogin_(payload) {
  var op = operatorOf_(payload);
  if (!op) return json_({ ok: false, error: 'Access denied — wrong admin password.' });
  var device = str_(payload.device) || 'unknown-device';
  logAdmin_(op, 'LOGIN', 'Control Room',
    'gate unlocked · device ' + device.split('·')[0]);
  return json_({ ok: true, operator: op });
}

/** ---------- METRICS TRACKING (Phase 1) ----------
 *  The league's daily view-count pipeline (docs/METRICS-RESEARCH.md):
 *    · YouTube — LIVE. YouTube Data API v3 videos.list, 50 IDs per call
 *      (1 quota unit), fresh view/like/comment counts per unique yt_ post.
 *    · Instagram — AWAITS the Meta app review (Business Discovery needs the
 *      league IG token in Script Properties: META_IG_TOKEN + META_IG_USER_ID).
 *    · LinkedIn — decision (c): OCR impressions stay the source of truth via
 *      the existing SCAN pipeline; guest engagement fetches are attempted
 *      best-effort and only recorded when LinkedIn actually answers.
 *  Snapshots append to their own sheet ('PCL-Snapshots') — never silently
 *  zero, never rewriting history. collect_() joins the latest tracked count
 *  onto every ledger row so the console shows it as an AUTO tag.
 *  Runs twice daily (09:00 & 21:00 IST triggers, self-healing on every
 *  SYNC NOW) and on demand from the console's SYNC NOW button. */
var DEFAULT_YT_API_KEY = 'AIzaSyChPgXr6U4MICfIPtdobUFTQHp_uS9veog';
var SNAP_SHEET_NAME = 'PCL-Snapshots';
var SNAP_HEADERS = ['Timestamp', 'Media ID', 'Platform', 'Source',
                    'Views', 'Likes', 'Comments', 'Status', 'Note'];

function ytKey_() {
  var k = String(PropertiesService.getScriptProperties()
    .getProperty('YOUTUBE_API_KEY') || '');
  return k || DEFAULT_YT_API_KEY;
}

function getSnapSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SNAP_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SNAP_SHEET_NAME);
    sheet.appendRow(SNAP_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function appendSnapshot_(mediaId, platform, source, views, likes, comments,
                         status, note) {
  try {
    getSnapSheet_().appendRow([new Date(), mediaId, platform, source,
                               views === '' ? '' : Number(views),
                               likes === '' ? '' : Number(likes),
                               comments === '' ? '' : Number(comments),
                               status || 'OK', str_(note)]);
  } catch (ignore) { /* tracking must never break the ledger */ }
}

/** Latest snapshot per Media ID — one read, last write wins. */
function latestSnapshots_() {
  var out = {};
  try {
    var sh = getSpreadsheet_().getSheetByName(SNAP_SHEET_NAME);
    if (!sh) return out;
    var last = sh.getLastRow();
    if (last < 2) return out;
    var vals = sh.getRange(2, 1, last - 1, SNAP_HEADERS.length).getValues();
    vals.forEach(function (r) {
      var mid = str_(r[1]);
      if (!mid) return;
      out[mid] = {
        views: r[4] === '' ? '' : Number(r[4]),
        ts: r[0] instanceof Date ? r[0].toISOString() : str_(r[0]),
        status: str_(r[7])
      };
    });
  } catch (ignore) { /* no snapshots yet */ }
  return out;
}

/** YouTube leg — batched videos.list over every unique yt_ post on the
 *  ledger. A count that hasn't moved since the last snapshot writes nothing
 *  (the sheet stays a real change-log, not a copy of YouTube). */
function syncYouTube_() {
  var out = { checked: 0, updated: 0, note: '' };
  try {
    var key = ytKey_();
    if (!key) { out.note = 'no API key'; return out; }
    var sheet = getSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { out.note = 'ledger empty'; return out; }
    var c = {};
    HEADERS.forEach(function (h, i) { c[h] = i; });
    var vals = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    var seen = {};
    var ids = [];
    vals.forEach(function (r) {
      var mid = str_(r[c['Media ID']]);
      if (mid.indexOf('yt_') !== 0) return;
      var vid = mid.slice(3);
      if (vid && !seen[vid]) { seen[vid] = true; ids.push(vid); }
    });
    if (!ids.length) { out.note = 'no YT posts yet'; return out; }
    var latest = latestSnapshots_();
    for (var i = 0; i < ids.length; i += 50) {
      var chunk = ids.slice(i, i + 50);
      var url = 'https://www.googleapis.com/youtube/v3/videos' +
                '?part=statistics&id=' + chunk.join(',') + '&key=' + key;
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        out.note = 'YT API HTTP ' + res.getResponseCode() +
                   ' — check the key / quota';
        break;
      }
      var data = JSON.parse(res.getContentText());
      (data.items || []).forEach(function (item) {
        var st = item.statistics || {};
        if (st.viewCount === undefined) return;
        out.checked++;
        var mid = 'yt_' + item.id;
        var prev = latest[mid];
        if (prev && String(prev.views) === String(st.viewCount)) return;
        appendSnapshot_(mid, 'YouTube', 'YT_API', st.viewCount,
                        st.likeCount || '', st.commentCount || '', 'OK', '');
        out.updated++;
      });
    }
    if (!out.note) out.note = out.updated ? 'tracked' : 'no changes';
  } catch (err) {
    out.note = String(err).slice(0, 120);
  }
  return out;
}

/** Instagram leg — Business Discovery needs the league token (Meta app
 *  currently under review). Until META_IG_TOKEN + META_IG_USER_ID land in
 *  Script Properties this reports and exits — it never invents counts. */
function syncInstagram_() {
  var out = { checked: 0, updated: 0, note: 'awaiting Meta app token' };
  try {
    var token = String(PropertiesService.getScriptProperties()
      .getProperty('META_IG_TOKEN') || '');
    var userId = String(PropertiesService.getScriptProperties()
      .getProperty('META_IG_USER_ID') || '');
    if (!token || !userId) return out;
    out.note = 'token present — BD pass needs the IG username map';
    // Phase 2: per-participant Business Discovery + media.pull — built the
    // moment the league's IG usernames are registered in PLAYER_META.
  } catch (ignore) { /* defensive */ }
  return out;
}

/** LinkedIn leg — decision (c): OCR impressions stay the review floor; the
 *  auto leg is best-effort only and writes nothing unless LinkedIn itself
 *  answers (guest fetches usually meet the login wall — expected, never an
 *  error worth a junk snapshot row). */
function syncLinkedIn_() {
  return { checked: 0, updated: 0,
           note: 'option c — OCR floor + guest engagement best-effort' };
}

/** SYNC NOW — the console's button; also self-heals the daily triggers. */
function syncNow_(payload) {
  var err = checkAdmin_(payload.adminKey);
  if (err) return json_({ ok: false, error: err });
  var yt = syncYouTube_();
  var ig = syncInstagram_();
  var li = syncLinkedIn_();
  try { ensureMetricsTriggers_(); } catch (ignore) { /* best effort */ }
  try { ensureBackupTrigger_(); } catch (ignore) { /* best effort */ }
  logAdmin_(operatorOf_(payload) || 'console', 'SYNC', 'metrics',
    'YT ' + yt.updated + '/' + yt.checked + (yt.note ? ' (' + yt.note + ')' : '') +
    (ig.note ? ' · IG ' + ig.note : '') +
    (li.note ? ' · LI ' + li.note : ''));
  return json_({ ok: true, yt: yt, ig: ig, li: li });
}

/** HOURLY tracker (ROUND 35 — was twice-daily 09:00 & 21:00). The league
 *  wants the board fresh: YouTube counts lift every hour, and every page
 *  open re-reads the ledger live. The function NAME stays metricsDaily_
 *  so pre-round triggers upgrade cleanly (the ensure pass deletes them). */
function metricsDaily_() {
  var yt = syncYouTube_();
  if (yt.note) logAdmin_('system', 'SYNC', 'metrics',
    'scheduled · YT ' + yt.updated + '/' + yt.checked + ' (' + yt.note + ')');
  try { ensureBackupTrigger_(); dailyLedgerBackup_(); }
  catch (ignore) { /* best effort — backup stays once-per-day by design */ }
}
function ensureMetricsTriggers_() {
  var want = 'metricsDaily_';
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === want;
  });
  // upgrade path: drop ANY count of the old trigger, install exactly one
  // hourly — never two, never the stale twice-daily pair
  if (existing.length !== 1) {
    existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger(want).timeBased().everyHours(1).create();
  }
}
/** Run ONCE from the editor if the hourly trigger should exist before the
 *  first SYNC NOW (the console button also self-heals it). */
function setupMetricsTriggers() {
  ensureMetricsTriggers_();
  var t = ScriptApp.getProjectTriggers().filter(function (x) {
    return x.getHandlerFunction() === 'metricsDaily_';
  })[0];
  return 'Hourly tracking trigger installed' +
    (t ? ' (' + String(t.getEventType()) + ', every 1 hour).' : '.');
}

/** ---------- DAILY LEDGER BACKUP (10-week insurance) ----------
 *  The league cannot lose data — ever. Once a day the whole PCL-Data tab
 *  is copied INSIDE the same spreadsheet as PCL-Data-Backup-YYYYMMDD, so
 *  even a bad manual edit / bad mass-paste can be rolled back to the
 *  previous morning. The newest 14 backup tabs are kept, older ones prune
 *  themselves. Install once with setupBackupTrigger() from the editor;
 *  SYNC NOW and the scheduled metrics run both self-heal the trigger. */
var BACKUP_PREFIX = 'PCL-Data-Backup-';
var BACKUP_KEEP = 14;

function dailyLedgerBackup_() {
  var out = { made: '', pruned: 0, note: '' };
  try {
    var ss = getSpreadsheet_();
    var data = ss.getSheetByName(SHEET_NAME);
    if (!data) { out.note = 'no ledger tab'; return out; }
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(),
                                     'yyyyMMdd');
    var name = BACKUP_PREFIX + stamp;
    if (!ss.getSheetByName(name)) {
      var copy = data.copyTo(ss);
      copy.setName(name);
      try { copy.setFrozenRows(1); } catch (ignore) { /* cosmetic */ }
      out.made = name;
    } else {
      out.note = 'already backed up today';
    }
    /* prune — oldest backup tabs beyond the retention window */
    var backs = ss.getSheets().map(function (s) { return s.getName(); })
      .filter(function (n) { return n.indexOf(BACKUP_PREFIX) === 0; })
      .sort();
    while (backs.length > BACKUP_KEEP) {
      var old = backs.shift();
      try { ss.deleteSheet(ss.getSheetByName(old)); out.pruned++; }
      catch (ignore) { break; }
    }
  } catch (err) { out.note = String(err).slice(0, 120); }
  return out;
}

/** Time-driven wrapper — the trigger calls THIS, so a failed backup can
 *  never take the scheduled run down with it. */
function dailyLedgerBackupTrigger() {
  var b = dailyLedgerBackup_();
  if (b.made || b.pruned) {
    logAdmin_('system', 'BACKUP', b.made || 'prune',
              'daily ledger backup' +
              (b.pruned ? ' · pruned ' + b.pruned + ' old tab(s)' : ''));
  }
}

function ensureBackupTrigger_() {
  var want = 'dailyLedgerBackupTrigger';
  var has = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === want;
  });
  if (!has) {
    ScriptApp.newTrigger(want).timeBased().everyDays(1).atHour(6).create();
  }
}

/** Run ONCE from the editor (or let SYNC NOW self-heal it): */
function setupBackupTrigger() {
  ensureBackupTrigger_();
  var b = dailyLedgerBackup_();
  return 'Backup trigger installed. First backup: ' + (b.made || b.note);
}

/** ---------- AUDIT LOG ("AdminLog" sheet) ---------- */

var LOG_SHEET_NAME = 'AdminLog';
var LOG_HEADERS = ['Timestamp', 'Operator', 'Action', 'Target', 'Detail'];

function getLogSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(LOG_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function logAdmin_(operator, action, target, detail) {
  try {
    /* cellSafe_ — log targets/details echo participant-typed names and
       admin notes; a crafted name must never become a live formula cell */
    getLogSheet_().appendRow([new Date(), cellSafe_(str_(operator) || 'unnamed'),
                              cellSafe_(action), cellSafe_(target),
                              cellSafe_(detail)]);
  } catch (ignore) { /* the ledger write must never fail because of the log */ }
}

function recentLog_(n) {
  try {
    var sh = getLogSheet_();
    var last = sh.getLastRow();
    if (last < 2) return [];
    var from = Math.max(2, last - n + 1);
    var vals = sh.getRange(from, 1, last - from + 1, LOG_HEADERS.length).getValues();
    var out = [];
    for (var i = vals.length - 1; i >= 0; i--) {
      var v = vals[i];
      out.push({
        ts: v[0] instanceof Date ? v[0].toISOString() : String(v[0]),
        operator: str_(v[1]),
        action: str_(v[2]),
        target: str_(v[3]),
        detail: str_(v[4])
      });
    }
    return out;
  } catch (ignore) { return []; }
}

/** ---------- PLAYER PHOTO (one per unique player) ---------- */

// Stored as "<slug(name)>__<slug(manager)>.<ext>" inside a child folder of the
// uploads folder. A re-submission with a new photo TRASHES the old file first,
// so exactly one photo per player exists. No new upload → the existing photo
// is reused and its URL lands in the ledger's Player Photo column.
function savePlayerPhoto_(data, fullName, manager, uploadsFolder) {
  try {
    var folder = getPhotoFolder_(uploadsFolder);
    var slug = slugify_(fullName);
    if (!slug) return '';
    var files = data.playerPhoto;
    if (Array.isArray(files) && files.length && files[0] &&
        typeof files[0].content === 'string' && files[0].content) {
      var file = files[0];
      if (file.type && !/^image\//i.test(file.type)) return '';   // images only
      var base64 = file.content.split(',')[1] || '';
      var bytes = Utilities.base64Decode(base64);
      if (bytes.length > MAX_FILE_MB * 1024 * 1024) return '';
      trashPhotos_(folder, slug);
      var extMatch = String(file.name || '').match(/\.(\w+)$/);
      var ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      var blob = Utilities.newBlob(bytes, file.type || 'image/png',
                                   slug + '__' + slugify_(manager) + '.' + ext);
      var stored = folder.createFile(blob);
      try {
        stored.setSharing(DriveApp.Access.ANYONE_WITH_LINK,
                          DriveApp.Permission.VIEW);
      } catch (ignore) { /* domain policies — owner link still works */ }
      return stored.getUrl();
    }
    // no new upload → reuse the photo already on file for this player
    var found = findPhotoByPrefix_(folder, slug);
    return found ? found.getUrl() : '';
  } catch (ignore) { return ''; }   // photo problems never block a submission
}

function getPhotoFolder_(uploadsFolder) {
  var parent = uploadsFolder || DriveApp.getRootFolder();
  var it = parent.getFoldersByName(PHOTO_FOLDER_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(PHOTO_FOLDER_NAME);
}

function findPhotoByPrefix_(folder, nameSlug) {
  var prefix = nameSlug + '__';
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (String(f.getName()).indexOf(prefix) === 0) return f;
  }
  return null;
}

function trashPhotos_(folder, nameSlug) {
  var prefix = nameSlug + '__';
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (String(f.getName()).indexOf(prefix) === 0) {
      try { f.setTrash(true); } catch (ignore) { /* best effort */ }
    }
  }
}

function slugify_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
           .replace(/^-+|-+$/g, '');
}

/** Public lookup: the form types a name → JSONP returns the photo on file
 *  (if any) so the player sees it instead of re-uploading. Also carries the
 *  player's designation + verified tick so the form can prefill the
 *  first-time fields for returning players. No key needed — the leaderboard
 *  is public anyway. */
function playerPhotoEndpoint_(p) {
  var nameSlug = slugify_(p.name);
  if (!nameSlug) {
    return reply_(p, { ok: false, error: 'Type your full name first.' });
  }
  try {
    var profile = playerProfile_(p.name);   // designation + verified from ledger
    var folder = getPhotoFolder_(getDriveFolder_());
    var f = findPhotoByPrefix_(folder, nameSlug);
    if (!f && !profile.found) {
      return reply_(p, { ok: false, error: 'no photo on file' });
    }
    var out = {
      ok: true,
      designation: profile.designation,
      verified: profile.verified
    };
    if (f) {
      var id = f.getId();
      out.name = f.getName();
      out.url = f.getUrl();
      out.fileId = id;
      out.thumb = 'https://drive.google.com/thumbnail?id=' + id + '&sz=w400';
    }
    return reply_(p, out);
  } catch (err) {
    return reply_(p, { ok: false, error: String(err) });
  }
}

/** Latest non-empty designation + verified flag for one player, straight
 *  from the ledger (three columns, one read pass — cheap per keystroke). */
function playerProfile_(name) {
  var who = normName_(name);
  var out = { found: false, designation: '', verified: false };
  if (!who) return out;
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  var nameCol = HEADERS.indexOf('Full Name') + 1;
  var desigCol = HEADERS.indexOf('Player Designation') + 1;
  var verCol = HEADERS.indexOf('Player Verified') + 1;
  var names = sheet.getRange(2, nameCol, lastRow - 1, 1).getValues();
  var rest = sheet.getRange(2, Math.min(desigCol, verCol), lastRow - 1,
                            Math.abs(verCol - desigCol) + 1).getValues();
  var dOff = desigCol - Math.min(desigCol, verCol);
  var vOff = verCol - Math.min(desigCol, verCol);
  for (var i = 0; i < names.length; i++) {
    if (normName_(names[i][0]) !== who) continue;
    out.found = true;
    var dg = str_(rest[i][dOff]);
    if (dg) out.designation = dg;
    var pv = str_(rest[i][vOff]);
    if (pv) out.verified = pv.toUpperCase() === 'VERIFIED';
  }
  return out;
}

/** ---------- OCR (free, via Drive) ---------- */

// Converts the screenshot with Drive OCR into a temp Doc, reads its text,
// extracts candidate counts and suggests the one closest to the claim.
// Needs "Drive API" enabled as an Advanced Service in the editor.
/** The review-side twin of the form's OCR brain (js/app.js parseCounts_ +
 *  pickCount_): the same four anchor shapes — inline, keyword-above-number,
 *  the IG insights card grid (fused "Views Viewers" / "1,082 422" rows),
 *  number-above-keyword — with strict single-token number captures and the
 *  comma-join fallback. Keeping both brains identical means the SCAN button
 *  reads a screenshot exactly the way the participant's form did.
 *  Returns {suggested, found}; claimed (the player's typed number) breaks
 *  ties by proximity, keyword priority arbitrates otherwise. */
function ocrParse_(text, claimed) {
  var t = String(text || ''), cands = [], m, seen = {}, anchors = 0;
  function km(s) {
    var mm = String(s).match(/^\s*([\d][\d,\.\s]*?)\s*([KkMm])?\s*$/);
    if (!mm) return 0;
    var raw = mm[1].replace(/[,\s]/g, '');
    if (!mm[2] && /^\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
    var n = Number(raw);
    if (!isFinite(n)) return 0;
    if (mm[2] === 'K' || mm[2] === 'k') n *= 1e3;
    else if (mm[2] === 'M' || mm[2] === 'm') n *= 1e6;
    return n;
  }
  function push(n, kw) {
    n = Math.round(n);
    if (!isFinite(n) || n <= 0 || n >= 1e10) return;
    var key = n + '|' + kw;
    if (seen[key]) return;
    seen[key] = 1;
    cands.push({ n: n, kw: kw });
  }
  var reA = /([\d][\d,.]*[KkMm]?)[ \t]*(views|impressions|plays|replays)(?![\w-])/ig;
  while ((m = reA.exec(t))) { anchors += 1; push(km(m[1]), m[2].toLowerCase()); }
  var reB1 = /(views|impressions|plays|replays|accounts reached|accounts engaged|members reached)[ \t]*:?[ \t]+([\d][\d,.]*[KkMm]?)(?![\w-])/ig;
  while ((m = reB1.exec(t))) { anchors += 1; push(km(m[2]), m[1].toLowerCase()); }
  var reB2 = /(^|\n)[ \t]*(accounts reached|accounts engaged|members reached|impressions|views|plays|replays)(?![\w-])[ \t]*:?[ \t]*(?!over\b|time\b|last\b|days?\b|week\b|month\b)(?:[A-Za-z\u00c0-\u024f\u00ae]+[ \t]*){0,2}(?:\n+)[ \t]*([\d][\d,.]*[KkMm]?)(?![\w-])/ig;
  while ((m = reB2.exec(t))) { anchors += 1; push(km(m[3]), m[2].toLowerCase()); }
  var reC = /(^|\n)[ \t]*([\d][\d,.]*[KkMm]?)(?:[ \t]*\n)+[ \t]*(views|impressions|plays|replays|accounts reached|accounts engaged|members reached)(?![\w-])(?![ \t]*:?[\d])/ig;
  while ((m = reC.exec(t))) { anchors += 1; push(km(m[2]), m[3].toLowerCase()); }
  if (!anchors) {
    var flat = t, guard = 0;
    while (guard++ < 4) {
      var nf = flat.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
      if (nf === flat) break;
      flat = nf;
    }
    var reN = /(\d{2,9})/g;
    while ((m = reN.exec(flat))) {
      var n = Number(m[1]);
      if (n > 9 && n < 1e9) push(n, '');
    }
  }
  var found = [];
  cands.forEach(function (c) { if (found.indexOf(c.n) < 0) found.push(c.n); });
  var suggested = '';
  if (cands.length) {
    if (claimed > 0) {
      var best = cands.reduce(function (a, b) {
        return Math.abs(b.n - claimed) < Math.abs(a.n - claimed) ? b : a;
      });
      suggested = best.n;
    } else {
      var KW = ['views', 'impressions', 'plays', 'replays',
                'accounts reached', 'accounts engaged', 'members reached'];
      for (var i = 0; i < KW.length && suggested === ''; i++) {
        var hits = cands.filter(function (c) { return c.kw === KW[i]; });
        if (hits.length) {
          suggested = Math.max.apply(null, hits.map(function (c) { return c.n; }));
        }
      }
      if (suggested === '') suggested = Math.max.apply(null, found);
    }
  }
  return { suggested: suggested, found: found };
}

/** The review-side twin of the form's detectBoost_: an ad/boost/sponsor
 *  mark found in the SCAN text means the screenshot itself shows boosted
 *  or sponsored content — banned by rulebook §6. Bare "boost" is the CTA
 *  button every business post carries (organic included) and never flags. */
function ocrBoost_(text) {
  var t = String(text || '').toLowerCase();
  if (!t) return '';
  var hit = t.match(/\b(boost(ed|ing)|sponsored|promoted|paid partnership|paid promotion)\b/);
  if (hit) return hit[0];
  if (/^[ \t\W]*ad[ \t\W]*$/im.test(t) && !/\badd(ing|ed|s)?\b/.test(t)) return 'ad';
  return '';
}

function ocrSuggest_(fileId, claimed) {
  if (!fileId) return { ok: false, error: 'This row has no screenshot on file.' };
  var advanced;
  try { advanced = Drive.Files; } catch (ignore) { /* not enabled */ }
  if (!advanced) {
    return { ok: false,
      error: 'Drive API advanced service is OFF — enable it in the script ' +
             'editor (Services → Drive API) or type the count manually.' };
  }
  var blob, docFile;
  try {
    blob = DriveApp.getFileById(fileId).getBlob();
    docFile = advanced.insert(
      { title: 'PCL OCR ' + fileId,
        mimeType: 'application/vnd.google-apps.document' },
      blob,
      { ocr: true, ocrLanguage: 'en' });
  } catch (err) {
    return { ok: false, error: 'OCR failed: ' + String(err) };
  }
  var text = '';
  try {
    text = DocumentApp.openById(docFile.getId()).getBody().getText();
  } finally {
    try { advanced.remove(docFile.getId()); } catch (ignore) { /* cleanup best effort */ }
  }
  var read = ocrParse_(text, claimed || 0);
  var boost = ocrBoost_(text);
  return { ok: true, suggested: read.suggested, found: read.found,
           boost: boost,
           text: String(text).replace(/\s+/g, ' ').slice(0, 400) };
}

// Blank-safe numeric parse for the review columns: '' stays '' (blank cell),
// unlike toCount_ which maps '' to 0.
function numOrBlank_(v) {
  var s = str_(v).replace(/[,\s]/g, '');
  if (s === '') return '';
  var n = Number(s);
  return (isNaN(n) || n < 0) ? '' : n;
}

/** Spreadsheet-formula injection guard. A participant-typed string that
 *  begins with = + - @ would be EXECUTED as a formula the moment Sheets
 *  ingests it — =IMPORTXML(...) or =GOOGLEFINANCE(...) can exfiltrate
 *  adjacent ledger cells to an attacker's server when an admin opens the
 *  tab. Prefixing an apostrophe forces text mode; the apostrophe is
 *  storage-only (Sheets hides it) and reads back unchanged. Every
 *  participant-typed TEXT field goes through this on the way into the
 *  sheet; numbers, dates and whitelisted values never do. */
function cellSafe_(v) {
  var s = str_(v);
  if (s && /^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

/** URL normaliser for anything a participant (or a raw API caller) sends
 *  as a link. '' passes through. A scheme-less domain gets https:// — the
 *  same thing the form's URL engine does. Anything with a dangerous
 *  scheme (javascript:, data:, vbscript:) or malformed shape returns
 *  null so the ingest can refuse it — a javascript: URL in a ledger row
 *  would otherwise become a clickable XSS in the Control Room. */
function safeUrl_(u) {
  var s = str_(u).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+([\/?#].*)?$/i.test(s)) return 'https://' + s;
  return null;
}

/** Extract the Drive file id from a stored share link. */
function driveFileId_(url) {
  var m = String(url || '').match(/\/d\/([\w-]{20,})/) ||
          String(url || '').match(/[?&]id=([\w-]{20,})/);
  return m ? m[1] : '';
}

/** JSON when fetched directly, JSONP when ?callback= is given (static-site
 *  friendly — no CORS setup anywhere). */
function reply_(p, obj) {
  var cb = str_(p && p.callback);
  var body = JSON.stringify(obj);
  if (cb && /^[A-Za-z_$][\w$.]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + body + ');')
                         .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body)
                       .setMimeType(ContentService.MimeType.JSON);
}

/** ---------- SHEET ---------- */

function getSpreadsheet_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet() ||
         SpreadsheetApp.create('Praper Contest League — Data');
}

function getSheet_(allowCreate) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SHEET_NAME);
  var exactRows = sheet ? sheet.getLastRow() : -1;

  if (sheet && exactRows > 1) return finishLedgerSheet_(sheet);   // healthy

  /* Self-heal: find a data-bearing near-match ('PCL Data', 'pcl-data ',
   * 'Copy of PCL-Data', …). 2026-10-26 incident — a renamed/shadowed
   * ledger tab silently read as ZERO everywhere while the data sat safe
   * in the original tab. Never again: adopt the data back by name. */
  var best = null, bestRows = -1, others = [];
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (sh.getName() === SHEET_NAME) continue;
    if (!isLedgerTabName_(sh.getName())) continue;
    var rows = sh.getLastRow();
    if (rows > bestRows) {
      if (best) others.push('"' + best.getName() + '"');
      best = sh; bestRows = rows;
    } else {
      others.push('"' + sh.getName() + '"');
    }
  }

  if (sheet && bestRows <= exactRows) return finishLedgerSheet_(sheet);

  if (best && bestRows > 1) {                     // adopt the real ledger
    var from = best.getName();
    if (sheet) {                                  // empty shadow in the way
      var parked = 'PCL-Data-empty-' +
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(),
                             'yyyyMMdd-HHmmss');
      sheet.setName(parked);
      others.push('"' + parked + '" (the empty tab that shadowed the data)');
    }
    best.setName(SHEET_NAME);
    logAdmin_('system', 'LEDGER-TAB-ADOPTED', SHEET_NAME + ' \u2190 ' + from,
              'Ledger tab was not reachable under its real name (renamed or '
            + 'copied over?). Re-adopted "' + from + '" with ' + bestRows
            + ' rows. Other candidates: ' + (others.join(', ') || 'none')
            + '. Nothing was lost.');
    return finishLedgerSheet_(best);
  }

  if (sheet) return finishLedgerSheet_(sheet);    // header-only, no better match

  if (allowCreate) {                              // first-ever bootstrap (ingest)
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    logAdmin_('system', 'LEDGER-CREATED', SHEET_NAME,
              'Fresh ledger bootstrapped by the ingest path.');
    return sheet;
  }

  throw new Error('LEDGER TAB MISSING: no readable "' + SHEET_NAME
    + '" tab in the ledger spreadsheet. Rename the data tab back to "'
    + SHEET_NAME + '" (or restore the sheet) \u2014 reads refuse to invent '
    + 'an empty ledger.');
}

/** Header-integrity migration shared by every resolve path (old sheets get
 *  new tail columns when HEADERS grows). */
function finishLedgerSheet_(sheet) {
  if (sheet.getLastColumn() < HEADERS.length) {
    sheet.getRange(1, sheet.getLastColumn() + 1, 1,
                   HEADERS.length - sheet.getLastColumn())
         .setValues([HEADERS.slice(sheet.getLastColumn())]);
  }
  return sheet;
}

/** 'PCL-Data' family detector: case/spacing/punctuation-insensitive and
 *  tolerant of Google's 'Copy of ' prefix. Deliberately NEVER matches
 *  backup tabs (PCL-Data-Backup-…) or unrelated names. */
function isLedgerTabName_(name) {
  var n = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n.indexOf('copyof') === 0) n = n.slice(6);
  return n === 'pcldata';
}

/** ---------- ANSWER → DRIVE ---------- */

// Accepts a single SurveyJS file object OR an array of them; returns the
// first successfully stored file ({name, url}) or null.
function fileAnswer_(value, folder, submissionId) {
  var files = Array.isArray(value) ? value : (value ? [value] : []);
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f && typeof f.content === 'string' && typeof f.name === 'string') {
      return saveFile_(f, folder, submissionId);
    }
  }
  return null;
}

function saveFile_(file, folder, submissionId) {
  var base64 = file.content.split(',')[1] || '';   // strip data-URL prefix
  var bytes = Utilities.base64Decode(base64);

  if (file.type && !/^image\//i.test(file.type)) {
    /* defense in depth — the form's file picker already restricts to
       PNG/JPG/WEBP; a raw API caller does not, and a non-image blob has
       no business in the analytics evidence chain */
    return { name: 'REJECTED — screenshots must be PNG / JPG / WEBP (' +
                     file.name + ')', url: '' };
  }

  if (bytes.length > MAX_FILE_MB * 1024 * 1024) {
    return { name: 'REJECTED — over ' + MAX_FILE_MB + ' MB cap (' + file.name + ')', url: '' };
  }

  var safe = submissionId + '_screenshot_' +
             file.name.replace(/[^\w.\-]+/g, '_');
  var blob = Utilities.newBlob(bytes, file.type || 'application/octet-stream',
                               safe);
  var stored = folder.createFile(blob);
  try {
    stored.setSharing(DriveApp.Access.ANYONE_WITH_LINK,
                      DriveApp.Permission.VIEW);
  } catch (ignore) { /* domain policies may forbid — link still works for owner */ }
  return { name: file.name, url: stored.getUrl() };
}

function getDriveFolder_() {
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  return it.hasNext() ? it.next()
                      : DriveApp.createFolder(DRIVE_FOLDER_NAME);
}

/** ---------- NON-TECHNICAL GUIDE ("START HERE" tab) ----------
 *  Run ONCE from the script editor (or after any HEADERS change):
 *  buildAdminGuide() — creates/refreshes a plain-language tab in the league
 *  spreadsheet so a non-technical panellist can find anything without
 *  reading code: what every column means, who writes it, what to do next. */
function buildAdminGuide() {
  var GUIDE = [
    ['COLUMN', 'WHO FILLS IT', 'WHAT IT MEANS / WHAT TO DO'],
    ['Timestamp', 'Form (automatic)', 'When the entry landed. Newest first in the Control Room feed.'],
    ['Submission ID', 'Form (automatic)', 'One ID per submission — a retried entry never appends twice.'],
    ['Entry Type', 'Form (automatic)', 'NEW = first report of this post · UPDATE = a newer count for the same post.'],
    ['Snapshot #', 'Form (automatic)', 'Which report this is for the post (S1 = first, S2 = second…).'],
    ['Full Name', 'Player', 'The player as they typed it — the key for photos, designation, points.'],
    ['Reporting Manager', 'Player', 'Who they report to — used for identity checks.'],
    ['Content Type', 'Player (per post) + admin', 'PRAPER = Praper/PAVE content · PERSONAL = personal content. The 50:50 balance rule is checked PER PLATFORM on the PLAYERS tab (IG 5:5 = balanced).'],
    ['Platform / Format / Multiplier', 'Form (automatic)', 'Detected from the link itself. Multiplier: YT video ×2, Reels/Shorts ×1.25, IG/LI posts ×1.'],
    ['Post URL / Media ID', 'Form (automatic)', 'The post link and its unique fingerprint — the dedup key.'],
    ['Weekly Challenge / Challenge URL / Notes', 'Player (optional)', 'Filled only when entering the weekly challenge.'],
    ['Claimed Views/Impressions', 'Player', 'The number the player typed. Points = this × multiplier (rounded up).'],
    ['Projected Points', 'Form (automatic)', 'Claimed × multiplier. Becomes official only after verification.'],
    ['Screenshot File / Screenshot Link', 'Form (automatic)', 'The analytics screenshot in Drive — click the link to open it.'],
    ['OCR Count', 'SCAN button / admin', 'Machine-read number from the screenshot. Start here when verifying.'],
    ['Cross-Check', 'Admin', 'PENDING OCR → MATCH / MISMATCH / BOOST? (BOOST? = suspected fake views).'],
    ['Verified Count', 'Admin', 'What the screenshot REALLY shows. This is the number the league trusts.'],
    ['Verified Points', 'Form→admin (automatic)', 'Verified Count × multiplier — written for you, never edit by hand.'],
    ['Player Photo', 'Form (automatic)', 'One photo per player, reused on every entry.'],
    ['Collab With / Collab Status', 'Form (automatic)', 'COLLAB pairs. Collab lists carry WORK EMAILS (comma-separated). CONFIRMED = the pair matched by email (either side) or legacy name → each scores FULL points (rulebook §6 rule 2).'],
    ['Player Email', 'Form (automatic)', "The participant's work email, typed in Participant Details — powers email-keyed collab matching and the accept-invite banner. Blank only for stale pre-email pages (collab then matches by name)."],
    ['Player Designation', 'Player (first time)', 'Job title shown on the leaderboard. Reused automatically afterwards.'],
    ['Player Verified', 'Admin', 'VERIFIED = photo + designation checked against name · manager · designation (PLAYERS tab → CONFIRM ID). Green tick shows everywhere. Empty = no badge.'],
    ['PCL-Snapshots tab', 'Automatic (YouTube tracking)', 'The SYNC NOW pipeline appends every platform-observed count here: Timestamp · Media ID · Source · Views. Ledger rows show the latest as an AUTO tag in the feed.'],
    ['Admin access', 'Six passwords', 'One password per admin (firstName@123). The password IS the identity — every log entry is stamped with the matching name automatically; there is no name picker and no device lock. Rotate by editing ADMINS in Code.gs + a new version.'],
    ['PCL-Allowlist tab', 'Admins (paste emails)', 'The active-employee email log for Google sign-in: one @praper.in email per row from row 2 down. A signer-in must be on the @praper.in domain AND on this list; a blank list denies everyone. Edit the tab any time — no redeploy needed.'],
    ['Screening Room (CEO)', 'CEO only (private)', 'director.html — a passcode-gated private theatre that plays ONLY the current week\u2019s weekly-challenge uploads for the Director/CEO. Passcode: CEO_CODE Script Property (default director@123). Not linked anywhere public — share the link + passcode with the CEO directly.'],
    ['', '', ''],
    ['DAILY FLOW', '', '1. FEED tab: newest entries.  2. SCAN + compare screenshot.  3. Type Verified Count.'],
    ['', '', '4. Set Cross-Check.  5. SAVE CHANGES (sticky bar).  6. REPORTS → Players → VERIFY ID for new players.'],
    ['', '', 'Tie-break order: Verified Points > Projected Points. Suspicious jumps → AUDIT tab → FLAG BOOST?']
  ];
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName('START HERE');
  if (!sh) sh = ss.insertSheet('START HERE', 0);
  sh.clear();
  sh.getRange(1, 1, GUIDE.length, 3).setValues(GUIDE);
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 230);
  sh.setColumnWidth(2, 190);
  sh.setColumnWidth(3, 620);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#ed3b00').setFontColor('#ffffff');
  return 'START HERE tab created/refreshed.';
}

/** ---------- HELPERS ---------- */

function str_(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function toCount_(v) {
  var n = Number(str_(v).replace(/[,\s]/g, ''));
  return (isNaN(n) || n < 0) ? '' : n;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}
