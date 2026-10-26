/* ============================================================================
   PCL CONFIG — the only file you edit to wire the backend, change limits,
   or toggle the fun extras on/off for a deployment.
   ========================================================================== */

window.PCL_CONFIG = {
  // Paste your deployed Google Apps Script Web App URL here (ends with /exec).
  // Leave "" to run in LOCAL mode: submissions are logged to the browser
  // console + localStorage so you can demo the form without any backend.
  gasWebAppUrl: "https://script.google.com/macros/s/AKfycbxdY0N312upmv3VgfmG2DiVrlHdGGylv7jUk6Psa42Yp1NJotKURlJOoVpiKtly5iwe/exec",

  // Set true on a Vercel deployment: submissions POST to /api/submit and the
  // serverless function forwards them to Google Apps Script using the
  // GOOGLE_SCRIPT_WEBAPP_URL environment variable (URL stays secret, no CORS
  // concerns). Keep false for pure static hosting (GitHub Pages / local).
  submitViaApi: true,

  // Hard cap per uploaded attachment, in MB.
  // Enforced client-side (SurveyJS maxSize) AND server-side (Code.gs guard).
  maxFileMB: 5,

  // Accepted upload types for the analytics screenshot input.
  fileTypes: "image/png, image/jpeg, image/webp",

  // YouTube Data API v3 key (public, unrestricted — same key the GAS sync
  // leg uses). Lets the form read the OFFICIAL view count the moment a
  // YouTube link lands, so YouTube posts need nothing typed at all.
  // Leave "" to disable the client-side auto-read.
  ytApiKey: "AIzaSyChPgXr6U4MICfIPtdobUFTQHp_uS9veog",

  // ---- EMPLOYEE SIGN-IN (Google) — optional, off until YOU turn it on ----
  // 1. Google Cloud Console → Credentials → OAuth 2.0 Client ID (Web app).
  // 2. Add your site origin (e.g. https://praper-contest-league.vercel.app)
  //    under "Authorized JavaScript origins".
  // 3. Paste the client ID here AND in gas/Code.gs (GOOGLE_OAUTH_CLIENT_ID).
  // 4. Paste the active-employee emails into the PCL-Allowlist tab of the
  //    league sheet (one @praper.in email per row from row 2 down).
  // Sign-in is then accepted ONLY for @praper.in accounts that are on that
  // list — verified server-side against Google's tokeninfo endpoint.
  // Leave "" to hide the sign-in card completely (the form works exactly
  // as before — Full Name + Reporting Manager identity).
  googleClientId: "199911099744-6pt5fvjcl5u8g4qk06tlpqigd7tbaev8.apps.googleusercontent.com",

  // The only work domain accepted at sign-in. Must match EMPLOYEE_DOMAIN
  // in gas/Code.gs.
  employeeDomain: "praper.in",

  // ---- SEASON CLOCK + WEEKLY CHALLENGES ------------------------------------
  // The season window drives the leaderboard's week chips (hover a W chip →
  // its challenge; the ⓘ chip lists all ten). Keep in sync with
  // SEASON_START_ISO in gas/Code.gs. The form and the Director's room carry
  // their own copies — change challenge names HERE for the public board.
  seasonStartIso: "2026-10-19T11:00:00+05:30",
  challenges: [
    { name: "Best Original Content",
      crit: "Most original and creative content featuring Praper Media.",
      pts: 6000 },
    { name: "Best Storytelling Debut",
      crit: "Most engaging storytelling content mentioning Praper Media.",
      pts: 8000 },
    { name: "A Day in My Life",
      crit: "Give a glimpse into your daily life — routine, fun moments, work highlights.",
      pts: 8000 },
    { name: "Best Collaboration",
      crit: "Create content with at least one other Praper employee.",
      pts: 10000 },
    { name: "Behind the Scenes at Praper",
      crit: "Best emerging creator showcasing office culture and daily life.",
      pts: 6000 },
    { name: "Most Improved Creator",
      crit: "Highest improvement in profile visits, reach, engagement and follower growth during the challenge.",
      pts: 10000 },
    { name: "Consistency Reward",
      crit: "Publish at least 2 posts per week for seven consecutive weeks. Tie-break: total impressions and likes.",
      pts: 12000 },
    { name: "The One-Take Challenge",
      crit: "One continuous take of minimum 30 seconds, without cuts or edits.",
      pts: 8000 },
    { name: "The Trend Takeover",
      crit: "Give a popular trend or meme your own creative twist.",
      pts: 8000 },
    { name: "The Comment Magnet — Final Showdown",
      crit: "Create a post that sparks meaningful conversations and invites the audience to share opinions in the comments.",
      pts: 10000 }
  ]
};
