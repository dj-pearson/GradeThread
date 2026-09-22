// GradeThread Lister — Depop content script (US-3462, PHASE 6)
//
// Same shape as vinted.js: ask the background whether a job was queued for
// this tab, hand it to the shared runner, no-op on every other Depop page.
// Probe-before-fill, the login-wall rule and delist verification all live in
// common.js.
//
// The one Depop-specific step is the TITLE. Depop's form has no title field:
// the first line of the description is what a buyer sees as the listing's
// name. So the title leads the description here, before the runner fills it,
// and the result is cut to Depop's 1000 characters on a word boundary rather
// than letting the textarea's maxlength chop a word in half.

(function () {
  const DEPOP_DESCRIPTION_MAX = 1000;

  // Pure, and exposed for test/depop-lister.test.cjs.
  function depopDescription(title, description, max) {
    const limit = max || DEPOP_DESCRIPTION_MAX;
    const t = String(title || "").trim();
    const d = String(description || "").trim();
    // Don't say the title twice when the copy already opens with it.
    const text = !t
      ? d
      : !d
      ? t
      : d.toLowerCase().indexOf(t.toLowerCase()) === 0
      ? d
      : t + "\n\n" + d;
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const lastSpace = cut.search(/\s\S*$/);
    return (lastSpace > limit * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
  }

  self.GTDepop = { depopDescription: depopDescription };

  // Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
  const chrome = globalThis.browser || globalThis.chrome;
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL || !chrome || !chrome.runtime) return;

  // US-2484: let the popup check this page's selectors on demand.
  GT.registerProbe(SEL, "depop");

  Promise.resolve(chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }))
    .then(function (job) {
      if (job && job.platform === "depop" && (!job.kind || job.kind === "list") && job.payload) {
        job = Object.assign({}, job, {
          payload: Object.assign({}, job.payload, {
            description: depopDescription(job.payload.title, job.payload.description),
          }),
        });
      }
      return GT.runJobForPlatform(SEL, "depop", "Depop", job);
    })
    .catch(function () { /* no queued job / worker asleep */ });
})();
