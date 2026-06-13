// GradeThread Lister — Poshmark content script (US-716, PHASE 1)
//
// On load, asks the background worker whether a listing job was queued for this
// tab. If so, runs the shared fill flow against the versioned Poshmark
// selectors and reports the result back. No-op on every other Poshmark page.

(function () {
  const GT = self.GTLister;
  const SEL = self.GT_LISTER_SELECTORS;
  if (!GT || !SEL) return;

  chrome.runtime.sendMessage({ type: "GT_LISTER_GET_JOB" }, async function (job) {
    if (chrome.runtime.lastError || !job || job.platform !== "poshmark") return;
    const payload = Object.assign({ platform: "poshmark", platformLabel: "Poshmark" }, job.payload);
    let partial;
    try {
      partial = await GT.runFlow(SEL.poshmark, payload, { autoSubmit: false });
    } catch (err) {
      partial = {
        ok: false,
        manual: true,
        error: "Poshmark listing failed: " + (err && err.message ? err.message : String(err)),
        version: SEL.poshmark.version,
      };
    }
    chrome.runtime.sendMessage(GT.result(job.jobId, partial));
  });
})();
