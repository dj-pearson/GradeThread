// GradeThread Lister — background service worker (US-716)
//
// Receives a listing payload from the GradeThread SaaS tab via
// chrome.runtime.onMessageExternal (only gradethread.com is allowed by
// externally_connectable), opens the target marketplace's new-listing page in
// the user's OWN authenticated session, hands the payload to that tab's content
// script, and relays the result back to the SaaS tab.
//
// PRIVACY (AC2): the extension has NO "cookies" permission and is NOT
// host-permitted on gradethread.com — it cannot read the user's marketplace
// session or GradeThread auth. No marketplace password or cookie ever leaves
// the user's browser; GradeThread servers receive only the listing URL the
// SaaS tab itself records using the user's existing SaaS session.

const SUPPORTED = {
  poshmark: "Poshmark",
  mercari: "Mercari",
  grailed: "Grailed",
};

// Job lifecycle: jobsByTab maps a freshly-opened marketplace tab to its queued
// job; pendingExternal maps a jobId to the SaaS sendResponse callback so the
// content script's result can be relayed back. Kept in module memory — the
// worker stays alive while a job is outstanding (sendResponse port open).
const jobsByTab = {};
const pendingExternal = {};
let jobSeq = 0;

function makeJobId() {
  jobSeq += 1;
  return "job-" + jobSeq + "-" + Date.now();
}

function originAllowed(sender) {
  const url = (sender && sender.url) || "";
  try {
    const host = new URL(url).host;
    return host === "gradethread.com" || host.endsWith(".gradethread.com");
  } catch (_e) {
    return false;
  }
}

function isValidPayload(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.platform === "string" &&
    SUPPORTED[p.platform] &&
    typeof p.title === "string" &&
    p.title.length > 0
  );
}

// US-717: an auto-delist job ends an already-published listing on the seller's
// marketplace (the SaaS queues these when a cross-listed item sells elsewhere).
// It needs the platform + the live listing URL to open.
function isValidDelistPayload(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.platform === "string" &&
    SUPPORTED[p.platform] &&
    typeof p.listingUrl === "string" &&
    /^https:\/\//.test(p.listingUrl)
  );
}

async function tosAccepted() {
  const out = await chrome.storage.local.get("tosAcceptedAt");
  return Boolean(out && out.tosAcceptedAt);
}

// ── External messages from the GradeThread SaaS ──────────────────────────
chrome.runtime.onMessageExternal.addListener(function (msg, sender, sendResponse) {
  if (!originAllowed(sender)) {
    sendResponse({ ok: false, error: "Unauthorized origin." });
    return false;
  }

  // A simple handshake so the SaaS can detect the extension + show versions.
  if (msg && msg.type === "GT_LISTER_PING") {
    sendResponse({
      ok: true,
      installed: true,
      name: "GradeThread Lister",
      platforms: SUPPORTED,
    });
    return false;
  }

  // US-717: end a live listing on the seller's marketplace (cross-listing
  // auto-delist after a sale elsewhere).
  if (msg && msg.type === "GT_LISTER_DELIST") {
    const dp = msg.payload;
    if (!isValidDelistPayload(dp)) {
      sendResponse({ ok: false, error: "Invalid or unsupported delist payload." });
      return false;
    }
    handleDelistRequest(dp, sendResponse);
    return true; // async result
  }

  if (!msg || msg.type !== "GT_LISTER_LIST") {
    sendResponse({ ok: false, error: "Unknown message type." });
    return false;
  }

  const payload = msg.payload;
  if (!isValidPayload(payload)) {
    sendResponse({ ok: false, error: "Invalid or unsupported listing payload." });
    return false;
  }

  handleListRequest(payload, sendResponse);
  return true; // keep the response port open for the async result
});

async function handleListRequest(payload, sendResponse) {
  if (!(await tosAccepted())) {
    sendResponse({
      ok: false,
      needsConsent: true,
      error:
        "Open the GradeThread Lister and accept the terms before cross-listing.",
    });
    return;
  }

  const jobId = makeJobId();
  let tab;
  try {
    tab = await chrome.tabs.create({ url: payload.newListingUrl, active: true });
  } catch (_e) {
    sendResponse({ ok: false, error: "Couldn't open the marketplace tab." });
    return;
  }

  jobsByTab[tab.id] = { jobId: jobId, platform: payload.platform, payload: payload };
  pendingExternal[jobId] = sendResponse;

  // Safety timeout so the SaaS promise never hangs forever (user may close the
  // tab or get stuck on a login wall).
  setTimeout(function () {
    if (pendingExternal[jobId]) {
      try {
        pendingExternal[jobId]({
          ok: false,
          timedOut: true,
          error:
            "Timed out waiting for the " + SUPPORTED[payload.platform] +
            " form. List manually if the tab didn't prefill.",
        });
      } catch (_e) { /* port may be gone */ }
      delete pendingExternal[jobId];
    }
  }, 120000);
}

async function handleDelistRequest(payload, sendResponse) {
  if (!(await tosAccepted())) {
    sendResponse({
      ok: false,
      needsConsent: true,
      error:
        "Open the GradeThread Lister and accept the terms before delisting.",
    });
    return;
  }

  const jobId = makeJobId();
  let tab;
  try {
    tab = await chrome.tabs.create({ url: payload.listingUrl, active: true });
  } catch (_e) {
    sendResponse({ ok: false, error: "Couldn't open the marketplace tab." });
    return;
  }

  // kind="delist" tells the per-platform content script to run the end-listing
  // flow instead of the fill flow.
  jobsByTab[tab.id] = {
    jobId: jobId,
    platform: payload.platform,
    kind: "delist",
    payload: payload,
  };
  pendingExternal[jobId] = sendResponse;

  setTimeout(function () {
    if (pendingExternal[jobId]) {
      try {
        pendingExternal[jobId]({
          ok: false,
          timedOut: true,
          error:
            "Timed out ending the " + SUPPORTED[payload.platform] +
            " listing. End it manually if the tab didn't.",
        });
      } catch (_e) { /* port may be gone */ }
      delete pendingExternal[jobId];
    }
  }, 120000);
}

// ── Internal messages from content scripts ───────────────────────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;

  if (msg.type === "GT_LISTER_GET_JOB") {
    const tabId = sender.tab && sender.tab.id;
    const job = (tabId != null && jobsByTab[tabId]) || null;
    sendResponse(job);
    return false;
  }

  if (msg.type === "GT_LISTER_LOG") {
    // eslint-disable-next-line no-console
    console.debug("[GradeThread Lister][content]", msg.message);
    return false;
  }

  if (msg.type === "GT_LISTER_RESULT") {
    const cb = pendingExternal[msg.jobId];
    if (cb) {
      const out = Object.assign({}, msg);
      delete out.type;
      delete out.jobId;
      try { cb(out); } catch (_e) { /* port closed */ }
      delete pendingExternal[msg.jobId];
    }
    // Free the per-tab job once consumed.
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) delete jobsByTab[tabId];
    return false;
  }

  return false;
});

// Clean up if the marketplace tab is closed before reporting.
chrome.tabs.onRemoved.addListener(function (tabId) {
  delete jobsByTab[tabId];
});
