// GradeThread Lister — Mercari content script (US-716, PHASE 2 — not yet enabled)
//
// Mercari's sell flow is flagged off in selectors.js until its selectors are
// verified against the live SPA (it rewrites field ids often). Until then this
// reports a clear "list manually" result rather than guessing at the form.

(function () {
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }, async function (job) {
    if (chrome.runtime.lastError || !job || job.platform !== "mercari") return;
    const payload = Object.assign({ platform: "mercari", platformLabel: "Mercari" }, job.payload);
    let partial;
    try {
      partial = await GT.runFlow(SEL.mercari, payload, { autoSubmit: false });
    } catch (err) {
      partial = {
        ok: false,
        manual: true,
        error: "Mercari listing failed: " + (err && err.message ? err.message : String(err)),
        version: SEL.mercari.version,
      };
    }
    chrome.runtime.sendMessage(GT.result(job.jobId, partial));
  });
})();
