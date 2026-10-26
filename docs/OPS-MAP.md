# PCL OPS MAP — where to look for what

The one-page brain of the whole system: what lives where, how it connects,
and which update path to use for which change. Read this top to bottom once
and you will always know where to fix, where to check, and what to redeploy.

---

## 1 · The three habitats of one project

The same code lives in three places. Everything you ever "deploy" is moving
a change between them:

```
 GitHub: toadsage01/Praper-Contest-League (main repo)      ← source of truth
     │  every push to main auto-deploys → Vercel (public site)
     │      pcl-form.prapermedia.in  ·  praper-contest-league.vercel.app
     │
 GitHub: toadsage01/PCL (the internal-hosting repo)        ← company portal
     │  cloned on the company host → docker compose up -d --build
     │      served on the internal network, DNS made live to everyone
     │
 Google Apps Script (script.google.com — pasted Code.gs)   ← the ledger brain
        every change needs: paste → save → Deploy → New version
        writes/reads the Google Sheet (PCL-Data tab) that IS the database
```

**Rule of thumb:**
- Changed a **.html / .css / .js** file? → push to main repo (Vercel picks it
  up in ~1 min) AND pull+rebuild the PCL Docker portal.
- Changed **gas/Code.gs**? → paste it into the Apps Script editor and deploy a
  **New version** (the sheet never updates from a git push — the script is
  pasted, not linked).

## 2 · File map — what to open for what

| I want to fix / change… | Open… | Then deploy via… |
|---|---|---|
| Entry form fields, validation, OCR engine, drafts | `index.html` + `js/app.js` (+ `css/theme.css`) | push main + rebuild PCL |
| The OCR parser (number extraction) | `js/app.js` → `parseCounts_` / `directedCrops_` / `pickCount_` (one block, unit-tested) | push main + rebuild PCL |
| Leaderboard look/logic/info pop-up | `leaderboard.html` + `js/leaderboard.js` + `css/leaderboard.css` | push main + rebuild PCL |
| Week names/criteria/rewards (the 10 weeks) | `js/gas-endpoint.js` → challenge config | push main + rebuild PCL |
| Admin console UI/flows | `admin.html` + `js/admin.js` + `css/admin.css` | push main + rebuild PCL |
| CEO screening room | `director.html` + `css/director.css` (+ `directorFeed_` in Code.gs) | push main + rebuild PCL **and** paste Code.gs if backend changed |
| Admin passwords (the 6) | Apps Script editor → Code.gs → `var ADMINS` (~line 1245) | paste + **New version** |
| CEO screening passcode | Apps Script editor → Project Settings → Script Properties → `CEO_CODE` | nothing else — live instantly |
| Ingest rules, dedupe, collab pairing, points math, YT lift, backups | `gas/Code.gs` | paste + **New version** |
| Submit forwarding + employee-domain gate (Vercel path) | `api/submit.js` | push main (Vercel) |
| The same gate on the Docker portal | `server.js` (PCL repo) — mirrors the contract | rebuild PCL |
| Docker / Terraform / internal hosting | PCL repo: `Dockerfile`, `docker-compose.yml`, `terraform/`, `server.js`, `INTERNAL-HOSTING.md` | rebuild |
| Open/close submissions (season or per week) | Control Room → REPORTS tab → **Submissions — Open / Close** (stored in the `PCL-Settings` tab of the Sheet; no deploy needed) | nothing — live instantly |
| Fix crossed Media IDs (dup dedup keys) | Control Room → AUDIT tab → **Data Tools → REPAIR MEDIA IDS** (or run `repairLedgerMediaIds()` once from the Apps Script editor) | nothing — writes the Sheet + AdminLog |
| A player's full profile (stats/uploads/metrics) | Control Room → PLAYERS tab → click any participant card | push main + rebuild PCL |
| Director screening another week | Screening Room → week strip (W1..Wn with entry counts) under the tabs | push main + rebuild PCL **and** paste Code.gs if backend changed |

## 3 · The data path (how everything connects)

```
Player (form)
  │  types @praper.in work email + posts + screenshots
  │  Tesseract.js reads the screenshots IN THE BROWSER (4 passes) → OCR count
  │  YouTube links self-fetch the official viewCount instead
  ▼
/api/submit  (Vercel function, or server.js inside Docker)
  │  gate: present-but-non-@praper.in email → 422, never forwarded
  ▼
Apps Script Web App  (the /exec URL — one per deployment version)
  │  Code.gs ingest: dedupe by Submission ID, pair collabs by email,
  │  write the row into the Google Sheet (PCL-Data, review-first columns)
  │  OCR Count lands here too  ·  Cross-Check starts as PENDING OCR
  ▼
Google Sheet = the single source of truth
  │  read by: admin console (jsonp), leaderboard rollup, YT snapshot sync
  ▼
Admin console (admin.html) → SCAN re-reads the screenshot server-side
  (Drive OCR + ocrParse_ twin + ocrBoost_ ad re-check) → reviewer types
  Verified Count → MATCH/MISMATCH/BOOST? → points verified → leaderboard
```

The three browser portals (form / admin / leaderboard+director) are pure
static files — they hold no data. Everything they show comes from the Sheet
through the Apps Script Web App. That is why a Code.gs change never reaches
anyone until "New version" is clicked.

## 4 · Update runbooks

### 4a · Change something in the repo (HTML/CSS/JS)
```
# on your machine, in the clone:
git pull                      # start from latest
# ...edit files...
git add -A && git commit -m "what changed"
git push                      # main repo → Vercel redeploys automatically
```
Then on the **company host** (the internal portal):
```
cd PCL && git pull
docker compose up -d --build  # rebuilds the image, restarts the container
# or, if you launched it with Terraform:
terraform apply
```
Verify: open the internal URL hard-refreshed (Ctrl+F5) and `curl <portal>/healthz`.

### 4b · Change Code.gs (backend)
1. Open `gas/Code.gs` from the repo, copy the WHOLE file.
2. script.google.com → open the PCL script project → select all in Code.gs → paste.
3. Save (Ctrl+S) → **Deploy → Manage deployments → ✏ → Version: New version → Deploy**.
4. Smoke test: submit one entry, watch it land in the Sheet.
   ⚠ Forgetting "New version" is the #1 "why isn't it working" cause — the
   old code keeps serving until you cut a new version.

### 4c · The GAS editor drifted from the repo (your current case)
Someone edited Code.gs directly in script.google.com, so the live script and
the repo copy have diverged. To make the repo match reality again:
1. Apps Script editor → Code.gs → Ctrl+A → Ctrl+C.
2. Paste over your local `gas/Code.gs` (or send it to me and I'll diff + merge it).
3. Commit + push as above. From then on, 4b is the only path — one source of truth.

### 4d · Rotate the admin passwords
Apps Script editor → Code.gs → `var ADMINS` → edit the `pass:` values (keep
each `name:` as is — the name is what gets stamped on audit entries) → save →
**New version**. CEO room passcode: Script Properties → `CEO_CODE` (instant).

## 4e · Round 35 — what changed and where it lives

| Feature | Where it lives |
|---|---|
| Submission gates (admin open/close per week + season) | Backend: `gas/Code.gs` → `readSubmitGates_` / `setGate_` / the gate check inside `doPostLocked_` · Settings tab: **PCL-Settings** (Key/Value; absent = open) · Console UI: `admin.html` `#gatePanel` + `renderGates()` in `js/admin.js` · Form UI: `buildWeekOptions()` + `weekClosed_()` + the `#pclGateNote` banner in `js/app.js` |
| Canonical Media IDs (LinkedIn li / li_p fix) | Extractor twins: `mediaId_()` in `gas/Code.gs` + `classifyUrl()` LinkedIn branch in `js/app.js` — same priority: urn → activity number → posts-slug re-scan → pulse/lnkd · Junk-tail guard: `degenerateMediaId_()` · One-click cleanup: `repairRun_` / `repairMediaIds_` / `repairLedgerMediaIds` in Code.gs + the AUDIT-tab button |
| Weekly tabs = challenge uploads only | Roll-up weekly bucket in `collect_()` (Code.gs): a post buckets into a W tab ONLY when its `Weekly Challenge` cell is tagged "Week N — …"; the tag's week decides the tab, regular posts stay Season-only |
| ALL-SEASON → SEASON 2 | `leaderboard.js` `buildWeekChips()` first chip · it still counts EVERYTHING (challenges + regular) |
| "Total Points" → "Leaderboard Points" | `leaderboard.html` column label |
| Leaderboard scroll section | `css/leaderboard.css`: `.pcl-tablewrap` fixed max-height + inner scroll; `.pcl-collabels` sticky inside it |
| Hourly sync | `gas/Code.gs` `ensureMetricsTriggers_()` — ONE hourly trigger (was 09:00 & 21:00 daily); `syncNow_` (the console button) self-heals it; page opens always read the ledger live |
| Collab popup hover-off minimize | `js/app.js`: `p.collabOpen` state + `mouseout` handler on `.pcl-collabpop` + three-state collab button (off→on · minimized→reopen · open→off) — emails stay saved in the draft |
| Player profiles for admins | `admin.html` `#profModal` + `ProfModal` / `playerProfileHtml()` / `openProfile()` in `js/admin.js` — identity + contest stats + per-app metrics + every upload (latest snapshot each) |
| Director week browsing | `directorFeed_(p)` accepts `week=N` + returns `weekCounts` · Screening room week strip: `renderWeeks()` in `js/director.js`, chips W1..live with per-week challenge counts |

**LinkedIn id cheat sheet** — one physical post = one id, whichever link
shape was pasted: `posts/<user>_<text>-activity-<ID>-<hash>` ·
`feed/update/urn:li:activity:<ID>` · `urn:li:ugcPost:<ID>` all collapse to
`li_<ID>`. If you ever SEE a `li_p`-style value in the sheet again, run the
AUDIT-tab repair once — it rewrites the whole ledger to canonical ids.

## 5 · Where to look when something breaks

| Symptom | First place to look |
|---|---|
| Form won't submit | Browser console (F12) → `[PCL OCR]` log + network tab on `/api/submit`; then the 422 messages from the gate |
| OCR reads a wrong number | The screenshot's text is in the console `[PCL OCR]` dump — check which layout shape failed; `scripts/test_ocr_parse.js` reproduces parsers offline |
| SCAN button errors | The Drive API advanced service must be ON (editor → Services); the error text names it |
| New Code.gs changes invisible | You skipped **New version** (4b step 3) |
| Internal portal shows old UI | You forgot `docker compose up -d --build` after `git pull` |
| Public site old, internal fine (or vice versa) | The two repos diverged — sync per 4a/4c |
| Sign-in / identity weirdness | The Work email field is the identity now; legacy Google sign-in engine is dormant in app.js (restore the #gpanel HTML to re-enable) |
| Data scare | `PCL-Data-Backup-YYYYMMDD` tabs (14 kept, daily trigger) — never edit those |
| Board/admin/director all empty but the Sheet has data | The `PCL-Data` tab was renamed or shadowed by an empty copy — rename the data tab back to exactly `PCL-Data`. Since the 2026-10-26 fix, `getSheet_()` self-heals: it re-adopts a data-bearing near-name tab (`PCL Data`, `Copy of PCL-Data`, …), logs `LEDGER-TAB-ADOPTED` in AdminLog, and on truly-missing tabs reads fail LOUDLY instead of showing fake zeros |
| Two players "share" a post they didn't both submit | Crossed Media ID — run AUDIT → REPAIR MEDIA IDS once; the ingest can't produce those ids anymore |
| Director's room says nothing to review | Default tab = CURRENT week's challenge entries only — use the week strip; ALL CONTENTS always plays the whole season |
| Players can't submit a challenge entry | Check REPORTS → Submissions panel (a week/season switch may be CLOSED) and the `PCL-Settings` tab in the Sheet |

## 6 · Tests — your safety net before every push

All in the sibling `scripts/` folder of your workspace (node, no browser):
```
node scripts/test_ocr_parse.js      # the form's OCR brain (real screenshot dumps)
node scripts/test_ocr_server.js     # the SCAN twin + ad-mark detector
node scripts/test_do_post_collab.js # ingest/dedupe/collab/points (~168)
node scripts/test_threat_matrix.js  # 107 security assertions
node scripts/test_leaderboard_rollup.js · test_leaderboard_sanitize.js
node scripts/test_submit_gate.js · test_url_diag.js
node scripts/test_round35.js         # gates + canonical ids + repair + hourly trigger
```
If a test fails after your edit, the test output names the exact behaviour
that broke. Never push red.
