// GradeThread Lister — Poshmark content script (US-716, PHASE 1)
//
// On load, asks the background worker whether a listing job was queued for this
// tab. If so, runs the shared fill flow against the versioned Poshmark
// selectors and reports the result back. No-op on every other Poshmark page.

(function () {
  // Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
  const chrome = globalThis.browser || globalThis.chrome;
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  // Promise form so the query resolves on Firefox too (its `chrome.*` is
  // callback-only); a rejected send (worker asleep / no job) is a quiet no-op.
  // US-1875: the job runner (incl. the login-wall rule that must not consume
  // the job) is shared in common.js — these three scripts were identical copies.
  Promise.resolve(chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }))
    .then(function (job) {
      return GT.runJobForPlatform(SEL, "poshmark", "Poshmark", job);
    })
    .catch(function () { /* no queued job / worker asleep */ });
})();
