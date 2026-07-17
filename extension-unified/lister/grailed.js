// GradeThread Lister — Grailed content script (US-716, PHASE 3 — not yet enabled)
//
// Flagged off in selectors.js until the Grailed sell flow (designer allow-list,
// department/category/subcategory pickers) is verified against the live site.
// Until then this reports a clear "list manually" result.

(function () {
  // Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
  const chrome = globalThis.browser || globalThis.chrome;
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  // US-1875: the job runner (incl. the login-wall rule that must not consume
  // the job) is shared in common.js — these three scripts were identical copies.
  Promise.resolve(chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }))
    .then(function (job) {
      return GT.runJobForPlatform(SEL, "grailed", "Grailed", job);
    })
    .catch(function () { /* no queued job / worker asleep */ });
})();
