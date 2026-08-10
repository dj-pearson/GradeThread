// GradeThread Lister — Vinted content script (US-2479, PHASE 4)
//
// Same shape as poshmark.js: ask the background whether a job was queued for
// this tab, hand it to the shared runner, no-op on every other Vinted page.
// Everything that decides behaviour — probe-before-fill, the login-wall rule
// that must not consume the job, delist verification — lives in common.js and
// is shared, which is the point: a per-platform copy of that logic is how the
// US-1875 probe bug survived in one copy for four days.
//
// The Vinted-specific part is the LOCALE, and it is handled in the background
// (lister-guard.newListingUrlForLocale) rather than here. By the time this
// script runs the tab is already on a covered domain, because an uncovered one
// was refused before a tab was ever opened. That ordering is deliberate: the
// alternative — open the tab, then discover we don't support it — leaves the
// seller staring at a foreign-language Vinted they have no account on.

(function () {
  // Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
  const chrome = globalThis.browser || globalThis.chrome;
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  Promise.resolve(chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }))
    .then(function (job) {
      return GT.runJobForPlatform(SEL, "vinted", "Vinted", job);
    })
    .catch(function () { /* no queued job / worker asleep */ });
})();
