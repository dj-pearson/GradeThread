// GradeThread Lister — Facebook Marketplace content script (US-2480, PHASE 5)
//
// Same shape as poshmark.js — the shared runner in common.js owns
// probe-before-fill, the login-wall rule, and delist verification.
//
// Two things are worth knowing about this channel specifically, both encoded in
// selectors.js rather than here:
//
//   • Marketplace's markup is machine-generated. Class names are hashed and
//     change on every deploy, so every selector is anchored on ARIA instead.
//     Expect this flow to need re-verification more often than any other.
//   • The create flow is a multi-step dialog with a required category and
//     condition, so `submit` is the "Next" control, not a publish. The seller
//     finishes and publishes. Auto-publishing a Marketplace listing with a
//     guessed category is how a listing gets removed and an account flagged —
//     the exact outcome the seller installed this to avoid.

(function () {
  // Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
  const chrome = globalThis.browser || globalThis.chrome;
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  // US-2484: let the popup check this page's selectors on demand.
  GT.registerProbe(SEL, "facebook");

  Promise.resolve(chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }))
    .then(function (job) {
      return GT.runJobForPlatform(SEL, "facebook", "Facebook Marketplace", job);
    })
    .catch(function () { /* no queued job / worker asleep */ });
})();
