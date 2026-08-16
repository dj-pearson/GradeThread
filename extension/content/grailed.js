// GradeThread Lister — Grailed content script (US-716, PHASE 3 — not yet enabled)
//
// Flagged off in selectors.js until the Grailed sell flow (designer allow-list,
// department/category/subcategory pickers) is verified against the live site.
// Until then this reports a clear "list manually" result.

(function () {
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }, async function (job) {
    if (chrome.runtime.lastError || !job || job.platform !== "grailed") return;
    const payload = Object.assign({ platform: "grailed", platformLabel: "Grailed" }, job.payload);
    let partial;
    try {
      partial = job.kind === "delist"
        ? await GT.runDelistFlow(SEL.grailed.delist, payload)
        : await GT.runFlow(SEL.grailed, payload);
    } catch (err) {
      partial = {
        ok: false,
        manual: true,
        error: "Grailed " + (job.kind === "delist" ? "delist" : "listing") +
          " failed: " + (err && err.message ? err.message : String(err)),
        version: SEL.grailed.version,
      };
    }
    chrome.runtime.sendMessage(GT.result(job.jobId, partial));
  });
})();
