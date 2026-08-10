// GradeThread Lister — Mercari content script (US-716, PHASE 2 — not yet enabled)
//
// Mercari's sell flow is flagged off in selectors.js until its selectors are
// verified against the live SPA (it rewrites field ids often). Until then this
// reports a clear "list manually" result rather than guessing at the form.

(function () {
  // Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
  const chrome = globalThis.browser || globalThis.chrome;
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  // US-1875: the job runner (incl. the login-wall rule that must not consume
  // the job) is shared in common.js — these three scripts were identical copies.
  // US-2484: let the popup check this page's selectors on demand.
  GT.registerProbe(SEL, "mercari");

  Promise.resolve(chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }))
    .then(function (job) {
      return GT.runJobForPlatform(SEL, "mercari", "Mercari", job);
    })
    .catch(function () { /* no queued job / worker asleep */ });
})();
