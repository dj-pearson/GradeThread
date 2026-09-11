// GradeThread unified extension — background service worker (US-1873)
//
// One worker, two message families, one entitlement gate:
//
//   • BUYER RESEARCH (GT_CC_*, from research/marketplace.js) — the condition-read
//     overlay. Grading goes through here so the request carries the extension's
//     own origin (chrome-extension://<id>, trusted by the server's
//     EXTENSION_ALLOWED_ORIGINS CORS allowlist) and isn't subject to the shopping
//     page's CSP. Owns the per-install instance id (quota key), the remotely
//     updatable selector-config cache, buyer settings, and local recent-reads.
//     Anonymous-capable; a signed buyer token upgrades quota + paid signals.
//
//   • SELLER LISTER (GT_LISTER_*, external from gradethread.com) — cross-post +
//     delist into the seller's OWN logged-in marketplace tab. Navigation targets
//     are PINNED to the bundled selectors config via GT_LISTER_GUARD (never taken
//     from the message), so a gradethread.com XSS can't steer the extension.
//
//   • ENTITLEMENTS GATE (US-1873) — the Lister list/delist flows unlock ONLY for an
//     active PAID FlipDesk account. Resolved from GET /entitlements (the signed
//     token's account), normalized + gated through registry.js. FAIL-SAFE: any gap
//     resolves to anonymous (buyer research only) so a hiccup never opens seller
//     tools. Buyer research stays free for everyone.
//
// PRIVACY: no "cookies" permission; the extension never reads a marketplace
// session or account. Research sends only the public listing image URLs already
// on the page to GradeThread's public endpoint (nothing persisted server-side).
// Lister automation runs entirely on-device; GradeThread records a cross-listing
// only from the seller's own SaaS session.

// Cross-browser bootstrap. Chrome runs this as an MV3 service worker (importScripts
// available; APIs on `chrome`, promise-based). Firefox runs it as a non-persistent
// EVENT PAGE — there is no importScripts, and the deps are loaded ahead of this file
// via background.scripts in the manifest — and exposes the APIs (promise-based) as
// `browser`. So: only importScripts when it exists, and alias the API namespace.
if (typeof importScripts === "function") {
  importScripts(
    "attribution.js",
    "usage-telemetry.js",
    "lister/selectors.js",
    "lister/lister-guard.js",
    "lister/job-store.js",
    "lister/engagement.js",
    // US-3042: the eBay item-id parser. Needed HERE and not only in the content
    // script, because ingestListing consults it before letting a photo-less
    // request through. NOTE: background-deps.test.cjs finds this call by
    // scanning to the first close-paren, so a close-paren anywhere inside these
    // comments truncates the dep list it parses. Keep them out.
    "research/ebay-item-id.js",
    "registry.js",
    "research/seller-memory.js",
    "research/compare-tray.js",
    // US-3070: the label reader is pure and shared - the worker needs it for the
    // size cap and the url check, the content script needs it to draw.
    "research/label-reader.js",
    // US-3070: the card the worker injects with scripting.executeScript. Its
    // render function is SERIALISED into the page, so it closes over nothing.
    // NOTE: no close-paren in this comment - see the warning above.
    "research/label-card.js",
    // US-2701: the poll's decisions and the adapters it reads them against.
    // The DRIVER is in this file; these two only decide and describe.
    "sync/selectors.js",
    "closet-import/selectors.js",
    "sync/poll-plan.js",
    // US-3048: the cross-listing queue's view model. Shared with the popup so
    // the count on the Selling tab and the rows under it are shaped by one
    // function rather than two that drift.
    "queue/queue-view.js",
    // US-3061: the worker tab's state machine. Needed HERE because the pause,
    // the owned-tab list and the stale-tab report are decided in this file; the
    // page loads the same script for the countdown and the status line.
    "queue/worker-state.js",
    // US-3062: which tabs the side panel is offered on. Needed HERE because
    // Chromium enables the panel per tab from this file, and the panel page
    // asks the same question for the Firefox sidebar, which has no per-tab
    // option. One rule, two mechanisms.
    "panel/panel-host.js",
  );
}
const ext = globalThis.browser || globalThis.chrome;

// ── endpoints / constants ────────────────────────────────────────────────
// The site origin itself lives in attribution.js (self.GT_ATTRIBUTION.SITE) —
// one place, so every outbound link is built by the tagger and none can ship
// untagged (US-1753 AC3). The API endpoints below are a different host and are
// never user-facing links, so they stay here.
const GRADE_ENDPOINT = "https://functions.gradethread.com/api/grading/public/grade-from-url";
// US-2237: the search-page triage scan. Separate endpoint AND separate server
// rate-limit window from grading — a scan spends no Vision call, and charging it
// against the grade budget would let a few scrolls of a results page exhaust the
// shopper's ability to actually grade anything.
const SCAN_ENDPOINT = "https://functions.gradethread.com/api/grading/public/scan";
// US-3060: the on-marketplace verified badge. A public read — no token, no
// body, no listing content — so it deliberately carries none of scanCards'
// headers beyond the instance id every call already sends.
const LISTING_CERTS_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/listing-certificates";

// US-3068: the return shield. The seller's own evidence, on the eBay dispute
// page they are already looking at.
//
// It carries the SELLER's token, unlike the badge lookup beside it: this reads
// their grade report, their listing's disclosure and their dispute. Nothing
// here is public, and the route scopes every read to the workspace the token
// resolves to.
const RETURN_SHIELD_ENDPOINT =
  "https://functions.gradethread.com/api/flipdesk/return-shield/preview";
// US-2238: flip mode. NOT under /api/grading/public — this one is authenticated
// and plan-gated (FlipDesk compPulls), so it lives on the seller side and needs
// the signed extension token. A request without one is a 401 by design.
const APPRAISE_ENDPOINT = "https://functions.gradethread.com/api/flipdesk/scout/appraise-url";
const ENTITLEMENTS_ENDPOINT = "https://functions.gradethread.com/api/grading/public/entitlements";
// US-3296: trade the stored token for a fresh one. Deliberately on the public
// mount rather than a seller mount: the request that most needs to work carries
// an ALREADY EXPIRED token, and every authed mount 401s that before a handler
// runs. The server checks the signature itself and accepts an expired token
// inside its grace window.
const TOKEN_RENEW_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/extension-token/renew";
// US-2698: sold-sync observation intake. A SELLER endpoint, unlike every other
// constant above, so it sits behind the seller token and the server's own
// FlipDesk gate rather than the anonymous public quota.
const SYNC_OBSERVE_ENDPOINT =
  "https://functions.gradethread.com/api/flipdesk/sync/observations";
// US-9201: closet import intake. Also a SELLER endpoint: the seller pressed
// "Import my closet" on the web, the reader ran in their own closet tab, and
// this is where what it read becomes a durable, reversible import run.
const CLOSET_IMPORT_ENDPOINT =
  "https://functions.gradethread.com/api/flipdesk/closet-import/runs";
// The popup's door onto the SAME projection the Marketplaces page reads. The
// extension speaks an HMAC token, not a Supabase JWT, so it cannot reach the
// JWT-guarded /api/flipdesk/sync/status.
const SYNC_STATUS_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/sync-status";
const SELECTOR_HEALTH_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/selector-health";
// US-1757 AC2: the opt-in usage tally (reads + click-throughs). A SEPARATE
// endpoint from selector-health because it is a separate consent — see
// usage-telemetry.js on why the two toggles are not merged.
const USAGE_ENDPOINT = "https://functions.gradethread.com/api/grading/public/usage";
const PENDING_DELISTS_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/pending-delists";
// US-9202: the pending-revise queue — listings an edit in FlipDesk has made
// stale on Poshmark/Mercari/Vinted/Grailed. Read for the popup's count and for
// the drain; confirmed back per listing with the outcome.
const PENDING_REVISES_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/pending-revises";
const REVISE_CONFIRM_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/revise-confirm";
// US-9203: the relist COPY went live; the server activates the new row and
// ends the old one.
const RELIST_LISTED_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/relist-listed";
// The cross-post went live. Reported by the background rather than pushed to a
// GradeThread tab, because there very often is not one: the seller closed it, or
// queued the job from their phone. Without this every extension publish stayed a
// draft until somebody came back and pressed "I published it" once per channel.
const LISTED_CONFIRM_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/listed-confirm";
// US-1808: hand ONE listing the shopper is looking at to their own saved-search
// alerts. Signed-in only (the server 401s without a token) — the whole point is
// that the listing is checked against THAT buyer's criteria, so there is no
// anonymous form of this call. Never fired automatically: it is a click, one
// listing at a time, on a page the shopper opened themselves.
const INGEST_ENDPOINT = "https://functions.gradethread.com/api/grading/public/ingest-listing";
const CONFIG_URL = "https://gradethread.com/extension/marketplace-selectors.json";
const CONFIG_TTL_HIT_MS = 6 * 60 * 60 * 1000;
const CONFIG_TTL_MISS_MS = 10 * 60 * 1000;
const CONFIG_CACHE_KEY = "ccConfigCache";
// Short entitlements TTL so a plan change reflects within minutes without a tab
// reload; a token set/clear force-invalidates it so it reflects immediately.
const ENT_TTL_MS = 5 * 60 * 1000;
const ENT_CACHE_KEY = "gtEntCache";
// US-3057: 100, up from 20. The Reads tab filters in memory and paints at
// most 40 rows, so a longer list costs nothing to open; the By seller
// aggregate and the stats strip read all of it.
const MAX_RECENT = 100;
// Per-listing grade recall (so revisiting an item returns the SAME grade instead
// of re-rolling a fresh — and slightly different — read, and doesn't spend quota).
// Keyed by the normalized listing URL; a TTL keeps a stale read from masking a
// relisted/edited item, and a cap bounds storage. The buyer can always "Re-read"
// to force a fresh grade, which overwrites the cached entry.
const GRADE_CACHE_KEY = "gradeCacheByKey";
const GRADE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// US-2486: how much room a delist gets after it follows a link to the page that
// actually holds the delete control. A page load plus a re-injected content
// script routinely costs more than the slack left in a 120s job, and a job
// killed mid-navigation reports a failure for work that was still in flight.
// Much shorter than the login-wall grace: nobody is typing a password here.
const NAVIGATION_GRACE_MS = 90 * 1000;
const GRADE_CACHE_MAX = 100;

const SUPPORTED_LISTER = {
  poshmark: "Poshmark",
  mercari: "Mercari",
  grailed: "Grailed",
  // US-2479 / US-2480. A platform listed here is one the extension will ACCEPT a
  // job for — whether the flow actually runs is `enabled` in selectors.js, and a
  // disabled flow reports "list manually for now" naming the platform. That is a
  // better answer than the one these two used to get, which was the generic
  // "Invalid or unsupported listing payload" from isValidPayload: the SaaS
  // already advertised Vinted as an extension channel, so a seller clicking it
  // was told their own request was malformed.
  vinted: "Vinted",
  facebook: "Facebook Marketplace",
};

// ── per-install instance id (research quota key) ──────────────────────────
async function getInstanceId() {
  const { instanceId } = await ext.storage.local.get("instanceId");
  if (instanceId) return instanceId;
  const id = (crypto.randomUUID && crypto.randomUUID()) ||
    "gt-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  await ext.storage.local.set({ instanceId: id });
  return id;
}

// ── first-run onboarding + instance id ────────────────────────────────────
ext.runtime.onInstalled.addListener((details) => {
  getInstanceId();
  // US-1885 AC4: open a role-aware onboarding page on fresh install so first-run
  // isn't a dead-end via the puzzle-piece menu. Only on install (not on update).
  if (details && details.reason === "install") {
    // US-1753 AC3: remember the install locally so the onboarding page and the
    // popup's sign-in link can carry the install campaign. Local only — this is
    // never sent anywhere, and the join back to the signup funnel happens
    // through the utm_campaign on a link the user chose to click, not through
    // an identifier we ship to the server.
    try {
      ext.storage.local.set({
        installedAt: new Date().toISOString(),
        installVersion: ext.runtime.getManifest().version,
      });
    } catch (_e) { /* storage unavailable — the funnel tag degrades, nothing breaks */ }
    try {
      // ?first_run=1 marks THIS open as the install-triggered one. Reopening the
      // page later is a real visit but not an install, and onboarding.js keeps
      // the two apart rather than inflating the install funnel.
      ext.tabs.create({ url: ext.runtime.getURL("onboarding.html") + "?first_run=1" });
    } catch (_e) { /* tabs may be unavailable in some contexts */ }
  }
});

// ── remotely-updatable selector config (cached in storage.session) ────────
function validConfig(c) {
  return c && typeof c === "object" && c.adapters && typeof c.adapters === "object" &&
    Object.keys(c.adapters).length > 0;
}

async function readConfigCache() {
  try {
    const out = await ext.storage.session.get(CONFIG_CACHE_KEY);
    return out && out[CONFIG_CACHE_KEY] ? out[CONFIG_CACHE_KEY] : null;
  } catch (_e) {
    return null;
  }
}

async function writeConfigCache(entry) {
  try {
    await ext.storage.session.set({ [CONFIG_CACHE_KEY]: entry });
  } catch (_e) { /* session storage unavailable — degrade to always-fetch */ }
}

async function getRemoteConfig() {
  const now = Date.now();
  const cached = await readConfigCache();
  if (cached && typeof cached.at === "number") {
    const ttl = cached.config ? CONFIG_TTL_HIT_MS : CONFIG_TTL_MISS_MS;
    if (now - cached.at < ttl) return cached.config;
  }
  try {
    const resp = await fetch(CONFIG_URL, { cache: "no-cache" });
    if (!resp.ok) throw new Error("config " + resp.status);
    const json = await resp.json();
    if (!validConfig(json)) throw new Error("config shape");
    await writeConfigCache({ at: now, config: json });
    return json;
  } catch (_e) {
    await writeConfigCache({ at: now, config: null });
    return null;
  }
}

// ── settings ──────────────────────────────────────────────────────────────
async function getSettings() {
  const out = await ext.storage.local.get(["autoRun", "disabledHosts", "scanMode", "theme"]);
  return {
    autoRun: Boolean(out.autoRun),
    // US-3055: "light" | "dark" | null (System). The overlay sets it as
    // data-theme on its card; anything unrecognised reads as System.
    theme: out.theme === "light" || out.theme === "dark" ? out.theme : null,
    disabledHosts: Array.isArray(out.disabledHosts) ? out.disabledHosts : [],
    // US-2237: scan mode defaults ON — note this is `!== false`, not Boolean(),
    // the opposite of autoRun above. autoRun spends a Vision call the shopper
    // didn't ask for, so it must be opted into; a scan spends none, so an install
    // that has never opened the popup still gets the feature.
    scanMode: out.scanMode !== false,
  };
}

// ── pending cross-listing delists (US-1885 AC1) ──────────────────────────
// The popup has no network access of its own (every fetch in this extension
// lives here), so it asks the worker. Not cached: the queue changes when a sale
// lands on another marketplace, and a stale "nothing pending" is the one wrong
// answer that matters — it leaves a sold item live for someone to buy again.
async function getPendingDelists() {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return { ok: false, reason: "signed-out", pending: [] };
  }
  try {
    const resp = await fetch(PENDING_DELISTS_ENDPOINT, {
      headers: { Authorization: "Bearer " + gtBuyerToken },
      cache: "no-store",
    });
    // Distinguish the states the popup renders differently. 401 = the token
    // expired (say so, and offer sign-in) and 403 = signed in without a
    // FlipDesk plan — showing "no pending delists" for either would be a lie
    // that reads as reassurance.
    if (resp.status === 401) return { ok: false, reason: "signed-out", pending: [] };
    if (resp.status === 403) return { ok: false, reason: "no-plan", pending: [] };
    if (!resp.ok) return { ok: false, reason: "error", pending: [] };
    const json = await resp.json();
    return { ok: true, pending: Array.isArray(json.pending) ? json.pending : [] };
  } catch (_e) {
    // Offline or blocked. NOT an empty queue — see above.
    return { ok: false, reason: "error", pending: [] };
  }
}

// ── US-9202: pending revises ──────────────────────────────────────────────
//
// Same reading discipline as getPendingDelists: not cached, and every non-200
// is a distinct state the popup renders rather than "nothing pending".
async function getPendingRevises() {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return { ok: false, reason: "signed-out", pending: [] };
  }
  try {
    const resp = await fetch(PENDING_REVISES_ENDPOINT, {
      headers: { Authorization: "Bearer " + gtBuyerToken },
      cache: "no-store",
    });
    if (resp.status === 401) return { ok: false, reason: "signed-out", pending: [] };
    if (resp.status === 403) return { ok: false, reason: "no-plan", pending: [] };
    if (!resp.ok) return { ok: false, reason: "error", pending: [] };
    const json = await resp.json();
    return { ok: true, pending: Array.isArray(json.pending) ? json.pending : [] };
  } catch (_e) {
    return { ok: false, reason: "error", pending: [] };
  }
}

// ── US-3048: the cross-listing queue, read for a human ────────────────────
//
// The drain (drainQueue, below) has claimed and run these rows since US-2481.
// This is the OTHER half, and it was missing the whole time: the seller's own
// view of what is waiting, what is running right now, and what expired or
// failed without ever reaching a marketplace.
//
// Same reading discipline as getPendingDelists: never cached, and every
// non-200 is a distinct state the popup renders rather than an empty queue. A
// stale "nothing waiting" here is the same lie as a stale "nothing to end" —
// it tells a seller their cross-posts went out when they did not.
//
// `needsAttention` is kept SEPARATE all the way to the renderer, because the
// API separates it for a reason: expired and failed work must never be drawn
// as work that is still coming.
// ── US-3062: what the side panel shows for a tab ──────────────────────────
//
// The item comes from the JOB in that tab — running, or the last one that
// finished there — and from nothing else. Two things it deliberately does not
// do:
//
//   1. It does not read the page. Guessing the item from the marketplace DOM is
//      the exact practice US-3042 had to remove from the eBay path, and a wrong
//      guess here attaches a grade to somebody else's listing.
//   2. It does not fetch. The panel's facts are ones the extension already
//      holds; anything richer (comps, the certificate) is the seller's own
//      FlipDesk data and reaching it needs the token, which is a round trip the
//      panel can ask for separately when there is something to show.
//
// So the honest answer is often `{ ok: true, item: null }`, and the card renders
// that as "open a marketplace listing" rather than as an error.
async function getPanelItem(tabId, url) {
  const platform = self.GT_PANEL_HOST.platformFor(url, self.GT_LISTER_SELECTORS);
  let job = null;
  try {
    job = await withJobs(async (jobs) => ({
      value: self.GT_LISTER_JOBS.findByTab(jobs, tabId),
    }));
  } catch (_e) {
    // storage.session unavailable. Not knowing is different from knowing there
    // is nothing, and the card draws them differently, so say so.
    return { ok: false, reason: "error", item: null };
  }
  if (!job || !job.itemId) return { ok: true, item: null };

  const cfg = platform ? self.GT_LISTER_SELECTORS[platform] : null;
  return {
    ok: true,
    item: {
      id: job.itemId,
      title: job.title || null,
      platform: platform || job.platform || "",
      // Absent rather than zero: the panel's card treats null as "not read" and
      // a number as a fact, and the two must not be confused.
      grade: typeof job.grade === "number" ? job.grade : null,
      certificateId: job.certificateId || null,
      targetPriceCents: typeof job.priceCents === "number" ? job.priceCents : null,
      comps: null,
      // selectors.js's own sentence for a platform that is off, so the panel
      // does not invent a second wording for the same fact.
      disabledReason: cfg && cfg.enabled === false
        ? cfg.disabledReason || "List manually for now."
        : null,
    },
  };
}

async function getQueue() {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return {
      ok: false, reason: "signed-out", pending: [], needsAttention: [], finishedNeedsReview: [],
    };
  }
  try {
    const resp = await fetch(QUEUE_ENDPOINT, {
      headers: { Authorization: "Bearer " + gtBuyerToken },
      cache: "no-store",
    });
    if (resp.status === 401) {
      return {
        ok: false, reason: "signed-out", pending: [], needsAttention: [], finishedNeedsReview: [],
      };
    }
    if (resp.status === 403) {
      return {
        ok: false, reason: "no-plan", pending: [], needsAttention: [], finishedNeedsReview: [],
      };
    }
    if (!resp.ok) {
      return {
        ok: false, reason: "error", pending: [], needsAttention: [], finishedNeedsReview: [],
      };
    }
    const json = await resp.json();
    return {
      ok: true,
      pending: Array.isArray(json.pending) ? json.pending : [],
      needsAttention: Array.isArray(json.needsAttention) ? json.needsAttention : [],
      // US-3370: runs that finished and still want a human, inside the server's
      // own 48-hour window. A separate key because the two lists above each
      // carry a promise the seller reads off them ("still coming" and "nothing
      // happened on the marketplace"), and a finished run falsifies both.
      finishedNeedsReview: Array.isArray(json.finishedNeedsReview)
        ? json.finishedNeedsReview
        : [],
    };
  } catch (_e) {
    return {
      ok: false, reason: "error", pending: [], needsAttention: [], finishedNeedsReview: [],
    };
  }
}

/**
 * Drop one queue row.
 *
 * Two different intentions share this call — cancelling work that has not run,
 * and dismissing a row that already failed — because the server-side effect is
 * the same and inventing a second endpoint for the second wording would be
 * ceremony. The popup is what keeps them apart: it offers Cancel only on a
 * `queued` row, never on a `claimed` one, so this can never delete a job out
 * from under a marketplace tab that is mid-fill (queue/queue-view.js:canCancel).
 *
 * The id is a string the popup read out of a row WE fetched for this account,
 * and the endpoint filters by owner anyway, so a wrong id is a 404 rather than
 * a foreign delete.
 */
async function cancelQueueRow(id) {
  if (typeof id !== "string" || !id) return { ok: false, reason: "error" };
  const out = await queueFetch("/" + encodeURIComponent(id), { method: "DELETE" });
  // queueFetch swallows the difference between offline, an expired token and a
  // 404. All three mean "it is still there as far as we know", which is the
  // answer the popup needs in order not to remove the row optimistically.
  return out ? { ok: true } : { ok: false, reason: "error" };
}

/** US-3050: { queueId: { stage, stagedAt, tabId } } for every pending drained job. */
async function getQueueJobStages() {
  const byQueueId = await withJobs(async (jobs) => {
    const out = {};
    for (const id of Object.keys(jobs || {})) {
      const job = jobs[id];
      if (!job || !job.queueId || !self.GT_LISTER_JOBS.isPending(job)) continue;
      out[job.queueId] = {
        stage: typeof job.stage === "string" ? job.stage : null,
        stagedAt: typeof job.stagedAt === "number" ? job.stagedAt : null,
        tabId: typeof job.tabId === "number" ? job.tabId : null,
      };
    }
    return { value: out };
  });
  return { ok: true, byQueueId: byQueueId || {} };
}

/**
 * Re-queue a failed or expired row (the popup's Retry).
 *
 * Two calls, in this order: POST the same instruction as a new row, then
 * DELETE the dead one. The order is what makes a half-failure safe — if the
 * POST fails nothing was removed and the seller still sees the failed row; if
 * the DELETE fails the new row is queued and the old one stays visible, which
 * is a stale line in a list rather than lost work. The body is shaped by
 * queue-view.js (retryBody) from the row the popup fetched for this account,
 * and the endpoint owner-scopes both the ids it names and the row it deletes.
 */
async function retryQueueRow(id, body) {
  if (typeof id !== "string" || !id) return { ok: false, reason: "error" };
  if (!body || typeof body !== "object" || !body.kind || !body.platform) {
    return { ok: false, reason: "error" };
  }
  const created = await queueFetch("", { method: "POST", body: JSON.stringify(body) });
  if (!created) return { ok: false, reason: "error" };
  const removed = await queueFetch("/" + encodeURIComponent(id), { method: "DELETE" });
  return { ok: true, removed: Boolean(removed) };
}

/** Report a revise outcome for one listing. Applied ONLY when the flow proved it. */
async function confirmRevise(listingId, result) {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string" || !listingId) return null;
  try {
    const resp = await fetch(REVISE_CONFIRM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + gtBuyerToken,
      },
      body: JSON.stringify({
        listing_id: listingId,
        applied: Boolean(result && result.ok === true && result.revised === true),
        manual: Boolean(result && result.manual),
        unverified: Boolean(result && result.unverified),
        error: result && typeof result.error === "string" ? result.error.slice(0, 300) : null,
      }),
    });
    return resp.ok;
  } catch (_e) {
    return null;
  }
}

/** US-9203: tell the server the relist copy is live at `url`. */
async function confirmRelistListed(newListingId, url) {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string" || !newListingId) return null;
  try {
    const resp = await fetch(RELIST_LISTED_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + gtBuyerToken,
      },
      body: JSON.stringify({ new_listing_id: newListingId, listing_url: url }),
    });
    return resp.ok;
  } catch (_e) {
    return null;
  }
}

/**
 * Record a completed cross-post: the tab navigated to a live listing page, so
 * the seller submitted the form.
 *
 * Fire-and-forget by design. The server is the record; a failure here costs the
 * seller the automatic promotion and leaves "I published it" exactly where it
 * was, which is the same place they were before this existed. Returns null when
 * there is no token or no item to attribute the listing to.
 */
async function confirmExtensionListed(itemId, platform, url) {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") return null;
  if (!itemId || !platform || !url) return null;
  try {
    const resp = await fetch(LISTED_CONFIRM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + gtBuyerToken,
      },
      body: JSON.stringify({ item_id: itemId, platform: platform, listing_url: url }),
    });
    return resp.ok;
  } catch (_e) {
    return null;
  }
}

/**
 * Turn one pending revise into the payload a revise job runs with. The URL is
 * the listing's own (host-pinned by isValidRevisePayload before a tab opens);
 * the values are the CURRENT FlipDesk ones the server sent, never anything
 * from a page.
 */
function revisePayloadFor(p) {
  return {
    platform: p.platform,
    listingUrl: p.listing_url,
    listingId: p.listing_id,
    itemId: p.item_id,
    fields: Array.isArray(p.fields) ? p.fields.slice() : [],
    title: typeof p.listing_title === "string" ? p.listing_title : null,
    description: typeof p.listing_description === "string" ? p.listing_description : null,
    price: typeof p.listing_price === "number" ? p.listing_price : null,
  };
}

let reviseDrainInFlight = false;

/**
 * Drain the pending-revise queue: ONE job per tick, oldest first, in a tab
 * that is not focused. Rides the same 5-minute sweep as the mobile queue, and
 * the same gates as an interactive edit: seller entitlement, the Lister
 * clickwrap, and the bundled selectors' `revise.enabled` (a channel whose
 * revise flow is off is left for the seller, and the popup says so).
 */
async function drainPendingRevises() {
  if (reviseDrainInFlight) return;
  reviseDrainInFlight = true;
  try {
    if (!(await sellerAllowed())) return;
    if (!(await tosAccepted())) return;
    const res = await getPendingRevises();
    if (!res.ok || res.pending.length === 0) return;

    // One marketplace tab at a time: a revise never starts while any Lister
    // job (list, delist or revise) is still working in this browser.
    const jobs = await withJobs(async (j) => ({ value: j }));
    const busy = Object.keys(jobs || {}).some((id) => self.GT_LISTER_JOBS.isPending(jobs[id]));
    if (busy) return;

    const SEL = self.GT_LISTER_SELECTORS;
    const next = res.pending.find((p) =>
      p && p.auto_revisable && SEL[p.platform] && SEL[p.platform].revise &&
      SEL[p.platform].revise.enabled
    );
    if (!next) return;
    const payload = revisePayloadFor(next);
    if (!isValidRevisePayload(payload)) return;

    let tab;
    try {
      tab = await ext.tabs.create({ url: payload.listingUrl, active: false });
    } catch (_e) {
      return;
    }
    const job = self.GT_LISTER_JOBS.makeJob({
      jobId: makeJobId(),
      clientRef: null,
      tabId: tab.id,
      saasTabId: null,
      platform: payload.platform,
      kind: "revise",
      payload: payload,
      reviseListingId: payload.listingId,
      now: Date.now(),
    });
    await withJobs(async (j) => ({ jobs: self.GT_LISTER_JOBS.put(j, job) }));
    await scheduleJobAlarm(job);
  } finally {
    reviseDrainInFlight = false;
  }
}

// ── selector-failure telemetry (US-1880 AC3) ─────────────────────────────
// OPT-IN, and the default is OFF: `Boolean(undefined)` is false, so an existing
// install that has never seen the toggle sends nothing. Consent is re-read from
// storage on EVERY send rather than cached — revoking it in the popup has to
// take effect immediately, not at the next service-worker restart.
//
// This is intentionally NOT wired to the Lister's `tosAcceptedAt` clickwrap.
// That key is legal acceptance for automating a seller's marketplace account and
// it only ever renders behind caps.sellerEnabled — gating on it would collect
// nothing from anonymous research users, who are the entire population that
// hits a broken adapter. Same consent PATTERN (versioned key, revocable), a
// separate decision.
const SELECTOR_TELEMETRY_KEY = "selectorTelemetry";

async function selectorTelemetryEnabled() {
  try {
    const out = await ext.storage.local.get(SELECTOR_TELEMETRY_KEY);
    return Boolean(out && out[SELECTOR_TELEMETRY_KEY]);
  } catch (_e) {
    return false; // fail-safe: never send on a storage hiccup
  }
}

// Best-effort and deliberately silent. A telemetry failure must never surface to
// a shopper or block the overlay's honest degrade path (US-1880 AC5) — the
// content script does not even await this.
async function reportSelectorMiss(msg) {
  if (!(await selectorTelemetryEnabled())) return;
  const adapter = msg && typeof msg.adapter === "string" ? msg.adapter : "";
  const emptySelectors = Array.isArray(msg && msg.emptySelectors) ? msg.emptySelectors : [];
  if (!adapter || !emptySelectors.length) return;
  try {
    await fetch(SELECTOR_HEALTH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // NO instance id header here, unlike the grading calls: that id is a
      // stable per-install identifier and attaching it would make an otherwise
      // anonymous counter linkable into a browsing trail.
      body: JSON.stringify({
        adapter,
        emptySelectors,
        configVersion: typeof msg.configVersion === "string" ? msg.configVersion : null,
        extVersion: (ext.runtime.getManifest && ext.runtime.getManifest().version) || null,
      }),
      keepalive: true,
    });
  } catch (_e) { /* offline / blocked — drop it */ }
}

// ── usage telemetry (US-1757 AC2) ────────────────────────────────────────
// The funnel's missing middle: install → READ → CLICK-THROUGH → signup. The
// outer two ends were already measured (a store dashboard reports installs,
// US-1753's utm tags attribute the signup) and nothing measured the middle, so
// "installs convert to accounts" could not be answered at all.
//
// OPT-IN, OFF BY DEFAULT, and its OWN key — deliberately not folded into
// `selectorTelemetry`, whose copy promises a narrower thing. Consent is re-read
// from storage on every single event rather than cached, so a revoke in the
// popup stops the next one, not the next worker restart.
//
// Events are TALLIED on the device and flushed as a bag of totals hours later
// (usage-telemetry.js explains why that shape and not an event stream). This
// worker owns the batch because storage.local lives here and because the two
// producers — the content script's reads and every surface's clicks — must land
// in ONE window, not one each.
async function usageTelemetryEnabled() {
  try {
    const out = await ext.storage.local.get(self.GT_USAGE.CONSENT_KEY);
    return Boolean(out && out[self.GT_USAGE.CONSENT_KEY]);
  } catch (_e) {
    return false; // fail-safe: never send on a storage hiccup
  }
}

async function flushUsage(batch) {
  const version = (ext.runtime.getManifest && ext.runtime.getManifest().version) || null;
  const body = self.GT_USAGE.payloadFor(batch, version, Date.now());
  if (!body) return;
  try {
    await fetch(USAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No instance id header, for the same reason selector-health omits it: it
      // is a stable per-install identifier, and attaching it would turn an
      // anonymous tally into a per-person usage record.
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (_e) { /* offline / blocked — the window is dropped, never retried */ }
}

/**
 * Tally one event, and send the window when it comes due. Best-effort and
 * silent: a shopper's read must never wait on, or fail because of, a counter.
 */
async function recordUsage(event, surface) {
  const KEY = self.GT_USAGE.BATCH_KEY;
  if (!(await usageTelemetryEnabled())) {
    // Consent was revoked while a window was open. Drop what was tallied rather
    // than leave it on disk to be sent by a later opt-in — that would send
    // activity from a period the user had said no to.
    try {
      await ext.storage.local.remove(KEY);
    } catch (_e) { /* nothing to clear */ }
    return;
  }
  try {
    const now = Date.now();
    const stored = await ext.storage.local.get(KEY);
    const next = self.GT_USAGE.record(stored && stored[KEY], event, surface, now);
    if (self.GT_USAGE.shouldFlush(next, now)) {
      // Clear FIRST. If the POST is what fails, the window is lost — which is
      // the right trade: a batch that survives its own failed send is a batch
      // that can be re-sent, and double-counting a funnel is worse than an
      // undercount nobody can distinguish from a quiet day.
      await ext.storage.local.set({ [KEY]: self.GT_USAGE.emptyBatch(now) });
      await flushUsage(next);
      return;
    }
    await ext.storage.local.set({ [KEY]: next });
  } catch (_e) { /* storage unavailable — the event is simply not counted */ }
}

// ── the account token's own lifecycle (US-3296) ──────────────────────────
//
// THE BUG. mintExtensionToken issues 30 days, and the ONLY place it was ever
// handed over was /connect-extension, from a button a seller presses once.
// Nothing re-minted it. So every connected seller silently dropped to the
// ANONYMOUS entitlements about a month after connecting, every Lister action
// then failed, and the extension could not tell "my token lapsed" from "I was
// never connected" — because the server's answer to both is the same anonymous
// payload. A Business seller ended up looking at /pricing.
//
// Two halves fix it. The web app re-hands a fresh token when it can see the
// extension (src/lib/extension-token-handoff.ts), and this half lets the
// extension ASK, so a browser that was closed straight through the expiry
// recovers on its next wake rather than waiting for the seller to guess.
//
// WHAT IS STORED. `gtBuyerTokenExpiresAt` is unix MILLISECONDS, read out of the
// token's own middle segment. It is scheduling data only: the extension holds
// no secret and cannot verify anything, so this decides WHEN to ask the server
// and never what the answer is.
const TOKEN_KEYS = ["gtBuyerToken", "gtBuyerTokenExpiresAt"];
// Never renew more than once every ten minutes, whatever wakes us. The sweep
// alarm alone fires every five, and onStartup lands on top of it.
const TOKEN_RENEW_MIN_GAP_MS = 10 * 60 * 1000;
let lastTokenRenewAt = 0;
let tokenRenewInFlight = null;

/** The stored token and what state it is in. Never throws. */
async function readTokenState(now) {
  try {
    const got = await ext.storage.local.get(TOKEN_KEYS);
    const token = typeof got.gtBuyerToken === "string" && got.gtBuyerToken
      ? got.gtBuyerToken
      : null;
    if (!token) return { token: null, expiresAtMs: null, state: "none" };
    // Prefer the stored expiry; fall back to reading it off the token, which is
    // what every install upgraded from an older build will need exactly once.
    const expiresAtMs = Number(got.gtBuyerTokenExpiresAt) ||
      self.GT_REGISTRY.tokenExpiryMs(token);
    return {
      token: token,
      expiresAtMs: expiresAtMs || null,
      state: self.GT_REGISTRY.tokenStateFrom(expiresAtMs, now || Date.now()),
    };
  } catch (_e) {
    return { token: null, expiresAtMs: null, state: "none" };
  }
}

/** Store a token and the expiry read from it, and drop the caches it invalidates. */
async function storeToken(token) {
  const expiresAtMs = self.GT_REGISTRY.tokenExpiryMs(token);
  await ext.storage.local.set({
    gtBuyerToken: token,
    gtBuyerTokenExpiresAt: expiresAtMs,
  });
  await invalidateEntCache();
  // Entitlements (which paid signals a grade includes) just changed, so drop
  // the recall cache — a return visit should re-grade with the new account's
  // tier rather than replay the anonymous read.
  await clearGradeCache();
}

/**
 * Renew the stored token if it is expiring or already expired.
 *
 * Returns the resulting state, so a caller can report it without a second read.
 * NEVER deletes the token on failure, and that is deliberate: a deleted token
 * reads as "never connected", which is the exact confusion this story exists to
 * end. A dead token that is still on disk keeps saying "reconnect".
 */
async function renewTokenIfNeeded(force) {
  const now = Date.now();
  if (tokenRenewInFlight) return tokenRenewInFlight;
  if (!force && now - lastTokenRenewAt < TOKEN_RENEW_MIN_GAP_MS) {
    return readTokenState(now);
  }

  tokenRenewInFlight = (async () => {
    const before = await readTokenState(now);
    if (!before.token) return before;
    if (!force && !self.GT_REGISTRY.shouldRenewToken(before.state)) return before;
    lastTokenRenewAt = now;

    try {
      const resp = await fetch(TOKEN_RENEW_ENDPOINT, {
        method: "POST",
        headers: { Authorization: "Bearer " + before.token },
        cache: "no-store",
      });
      if (!resp.ok) {
        // 401 = past the grace window (or forged). Leave the token where it is:
        // its stored expiry keeps reporting "expired", which is what makes the
        // popup and the SaaS say "reconnect" instead of "connect". Anything
        // else (503, offline, a proxy) is transient and must not change state.
        return await readTokenState(Date.now());
      }
      const json = await resp.json();
      if (!json || typeof json.token !== "string" || !json.token) {
        return await readTokenState(Date.now());
      }
      await storeToken(json.token);
      return await readTokenState(Date.now());
    } catch (_e) {
      // Offline. The next tick tries again; nothing is lost.
      return await readTokenState(Date.now());
    }
  })();

  try {
    return await tokenRenewInFlight;
  } finally {
    tokenRenewInFlight = null;
  }
}

// ── entitlements (US-1873) ───────────────────────────────────────────────
// Resolve the account's tools from the signed token. Cached briefly in
// storage.session; a token set/clear invalidates it. FAIL-SAFE to anonymous.
async function readEntCache() {
  try {
    const out = await ext.storage.session.get(ENT_CACHE_KEY);
    return out && out[ENT_CACHE_KEY] ? out[ENT_CACHE_KEY] : null;
  } catch (_e) {
    return null;
  }
}

async function writeEntCache(entry) {
  try {
    await ext.storage.session.set({ [ENT_CACHE_KEY]: entry });
  } catch (_e) { /* session storage unavailable — degrade to always-fetch */ }
}

async function invalidateEntCache() {
  try {
    await ext.storage.session.remove(ENT_CACHE_KEY);
  } catch (_e) { /* nothing to clear */ }
}

async function fetchEntitlements() {
  const headers = {};
  try {
    const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
    if (gtBuyerToken && typeof gtBuyerToken === "string") {
      headers["Authorization"] = "Bearer " + gtBuyerToken;
    }
  } catch (_e) { /* no token → anonymous */ }
  // US-3051: the same install id the grade call sends, so the quota block the
  // server returns is read off the window this install actually spends.
  try {
    headers["x-gt-extension-id"] = await getInstanceId();
  } catch (_e) { /* no id — the server falls back to the IP window */ }
  try {
    const resp = await fetch(ENTITLEMENTS_ENDPOINT, { headers, cache: "no-store" });
    if (!resp.ok) throw new Error("entitlements " + resp.status);
    const json = await resp.json();
    return self.GT_REGISTRY.normalizeEntitlements(json);
  } catch (_e) {
    // Never let a hiccup unlock seller tools.
    return self.GT_REGISTRY.ANONYMOUS_ENTITLEMENTS;
  }
}

async function getEntitlements(force) {
  const now = Date.now();
  if (!force) {
    const entry = await readEntCache();
    if (self.GT_REGISTRY.entitlementsFresh(entry, now, ENT_TTL_MS)) return entry.ent;
  }
  const ent = await fetchEntitlements();
  await writeEntCache({ at: now, ent });
  return ent;
}

async function getCapabilities(force) {
  const [ent, settings, token] = await Promise.all([
    getEntitlements(force),
    getSettings(),
    // US-3296: the stored token's state travels with the capabilities, because
    // the entitlements payload CANNOT carry it. An expired token authenticates
    // nothing, so the server answers it with the anonymous entitlements and the
    // account it named appears nowhere in the reply. Without this the popup, the
    // composer and the Marketplaces card all read a lapsed connection as one
    // that never existed.
    readTokenState(Date.now()),
  ]);
  return self.GT_REGISTRY.resolveCapabilities(ent, settings, token.state);
}

// ── the buyer grade call ──────────────────────────────────────────────────
function maxImagesFor(requested) {
  const n = Math.floor(Number(requested));
  if (!isFinite(n)) return self.GT_REGISTRY.MAX_IMAGES_ANON;
  return Math.max(
    self.GT_REGISTRY.MAX_IMAGES_ANON,
    Math.min(self.GT_REGISTRY.MAX_IMAGES_PAID, n),
  );
}

async function gradeFromUrls(
  {
    imageUrls,
    ebayItemId,
    brand,
    title,
    condition,
    marketplace,
    price,
    maxImages: msgMaxImages,
  },
) {
  // US-3042: two shapes, and only one of them carries page content.
  //
  // On eBay the content script sends an item id and nothing else, and the
  // server reads the listing from eBay's Browse API. Everywhere else it sends
  // the photos it found on the page, because no other marketplace here
  // publishes an API to read instead.
  //
  // The id is the WHOLE request in that case: sending photos alongside it would
  // hand the server page-scraped content to fall back on, which is the thing
  // being removed.
  const byEbayId = typeof ebayItemId === "string" && /^\d{9,15}$/.test(ebayItemId);
  if (!byEbayId && (!Array.isArray(imageUrls) || imageUrls.length === 0)) {
    return { ok: false, status: 400, error: "No listing photos to grade." };
  }
  const instanceId = await getInstanceId();
  const headers = {
    "Content-Type": "application/json",
    "X-GT-Extension-Id": instanceId,
  };
  try {
    const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
    if (gtBuyerToken && typeof gtBuyerToken === "string") headers["Authorization"] = "Bearer " + gtBuyerToken;
  } catch (_e) { /* no token → anonymous */ }
  let resp;
  try {
    resp = await fetch(GRADE_ENDPOINT, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(
        byEbayId
          ? {
            ebayItemId: ebayItemId,
            maxImages: maxImagesFor(msgMaxImages),
            marketplace: "ebay",
          }
          : {
            // US-2241: the caller's tier ceiling, clamped locally as well. The
            // server trims to the real cap regardless — this only avoids
            // posting URLs we already know it will drop.
            imageUrls: imageUrls.slice(0, maxImagesFor(msgMaxImages)),
            brand: brand || undefined,
            title: title || undefined,
            condition: condition || undefined,
            marketplace: marketplace || undefined,
            price: price || undefined,
          },
      ),
    });
  } catch (_e) {
    return { ok: false, status: 0, error: "Couldn't reach GradeThread. Check your connection." };
  }
  let json = null;
  try {
    json = await resp.json();
  } catch (_e) {
    json = null;
  }
  // US-3051: a read (or a refusal) moved the quota, and the popup reads it
  // from the 5-minute entitlements cache. Drop the cache so the next open
  // shows the real remaining rather than a number up to five minutes old.
  void invalidateEntCache();
  if (resp.ok && json) return { ok: true, status: resp.status, data: json };
  // US-1883 (AC3): thread the machine-readable capacity code + retryable flag so
  // the overlay can render a 503 "at_capacity" as a NON-retryable state.
  return {
    ok: false,
    status: resp.status,
    error: (json && json.error) || "Couldn't grade this listing right now.",
    code: (json && json.code) || null,
    retryable: json && json.retryable === false ? false : true,
  };
}

// ── the search-page triage scan (US-2237) ─────────────────────────────────
// Same posture as gradeFromUrls: the call is made HERE, not in the content
// script, so it carries the extension's own origin (trusted by the server's
// EXTENSION_ALLOWED_ORIGINS allowlist) and isn't subject to the marketplace
// page's CSP. Unlike a grade it spends no AI quota, so anonymous installs are
// not rationed as tightly — the server's own window is the authority.
/**
 * US-3060: fetch the certificates for a batch of marketplace listing ids.
 *
 * ABSENCE IS NOT A CLAIM, and this function is where that becomes a network
 * posture. Every failure — offline, 4xx, 5xx, unparseable body — answers
 * `{ ok: false }` and the content script renders nothing. There is no error to
 * show a shopper: they did not ask for this, and an "unverified" marker over
 * every ungraded listing would be a judgement we have not made.
 *
 * It sends NO buyer token, unlike scanCards. The endpoint is public, takes no
 * user id and returns only already-published certificate fields, so attaching
 * an identity would associate a shopper with the listings they browse for no
 * gain whatsoever.
 */
/**
 * US-3068: the evidence verdict for one eBay return.
 *
 * NOTHING IS RETRIED, and that is deliberate rather than lazy. Every failure
 * here — no token, offline, 404, 500, an unparseable body — means the panel
 * does not render, and a seller reading a dispute must not have a GradeThread
 * box appear four seconds late on a retry. A 404 in particular is an ANSWER: it
 * is a return this workspace does not own, and asking again will not change it.
 */
async function returnShieldPack({ returnId }) {
  if (!returnId || typeof returnId !== "string") return { ok: false };
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") return { ok: false };
  try {
    const resp = await fetch(RETURN_SHIELD_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Authorization": "Bearer " + gtBuyerToken,
        "Content-Type": "application/json",
        "X-GT-Extension-Id": await getInstanceId(),
      },
      body: JSON.stringify({ return_id: returnId }),
    });
    if (!resp.ok) return { ok: false };
    return { ok: true, data: await resp.json() };
  } catch (_e) {
    return { ok: false };
  }
}

async function listingCertificates({ platform, ids }) {
  if (!platform || !Array.isArray(ids) || ids.length === 0) {
    return { ok: false, status: 400, error: "Nothing to look up." };
  }
  const url = LISTING_CERTS_ENDPOINT +
    "?platform=" + encodeURIComponent(platform) +
    "&ids=" + encodeURIComponent(ids.join(","));
  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { "X-GT-Extension-Id": await getInstanceId() },
    });
  } catch (_e) {
    return { ok: false, status: 0, error: "offline" };
  }
  if (!resp.ok) return { ok: false, status: resp.status, error: "lookup failed" };
  try {
    return { ok: true, status: 200, data: await resp.json() };
  } catch (_e) {
    return { ok: false, status: resp.status, error: "unparseable" };
  }
}

async function scanCards({ cards, marketplace, query, brand }) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { ok: false, status: 400, error: "Nothing to scan." };
  }
  const instanceId = await getInstanceId();
  const headers = {
    "Content-Type": "application/json",
    "X-GT-Extension-Id": instanceId,
  };
  try {
    const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
    if (gtBuyerToken && typeof gtBuyerToken === "string") {
      headers["Authorization"] = "Bearer " + gtBuyerToken;
    }
  } catch (_e) { /* no token → anonymous */ }
  let resp;
  try {
    resp = await fetch(SCAN_ENDPOINT, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        cards: cards,
        marketplace: marketplace || undefined,
        query: query || undefined,
        brand: brand || undefined,
      }),
    });
  } catch (_e) {
    // Silent by design: the shopper never asked for this, so an unreachable
    // scan must not surface anything on their search page.
    return { ok: false, status: 0, error: "offline" };
  }
  let json = null;
  try {
    json = await resp.json();
  } catch (_e) {
    json = null;
  }
  if (resp.ok && json) return { ok: true, status: resp.status, data: json };
  return { ok: false, status: resp.status, error: (json && json.error) || "scan failed" };
}

// ── check this listing against my alerts (US-1808) ────────────────────────
// The buyer's saved searches only ever heard about GradeThread certificates, so
// the item they are actually looking at could match perfectly and stay silent.
// This posts that one listing to the buyer-scoped ingest endpoint, which grades
// it and evaluates it against their own criteria.
//
// SIGNED-IN ONLY, and refused here as well as on the server — an anonymous
// install has no saved searches for the answer to be about, so firing the
// request would spend a round trip to be told what we already knew.
//
// ONE listing, on click. There is no batch form and no automatic trigger: the
// endpoint is for a page the shopper opened, not for walking a results grid.
// US-2698: post one sold-sync observation batch.
//
// The batch was built by sync/observe.js in the content script, which can emit
// exactly six fields per sold row. This function adds nothing to it — no page
// URL, no handle, no cookie — and does not inspect it. The server refuses a
// forbidden key with a 400 regardless (lib/sync-payload-guard.ts), which is the
// belt to this brace.
//
// Signed-in only, and refused here as well as on the server: sold-sync is about
// the seller's own listings, so an anonymous install has nothing for the answer
// to be about.
//
// Fire-and-forget by design. A passive harvest runs while the seller is doing
// something else on their own closet, and there is no UI waiting on the result.
// A failure is logged and dropped rather than retried, because a retry loop on a
// page the seller is still browsing is a poll wearing a different name.
// US-2699: per-channel sold-sync health for the popup.
//
// Read-only and cheap, so it is fetched fresh rather than cached: a seller
// opening the popup to find out whether sync is working is exactly the moment a
// stale "Syncing" would be a lie.
// US-2701: the poll's consent and cadence, for the popup.
//
// The terms come from sync/poll-plan.js so the sentences the seller accepts and
// the sentences a test asserts are the same strings. A clickwrap whose wording
// lives in markup is one that can quietly lose a sentence.
async function pollConsentState() {
  const PLAN = self.GT_SYNC_POLL;
  if (!PLAN) return { available: false };
  const out = await ext.storage.local.get([
    "syncPoll",
    "syncPollClickwrap",
    "syncPollChannels",
  ]);
  const settings = (out && out.syncPoll) || { enabled: false };
  // US-2701 AC7: which channels the poll has STOPPED on, and why.
  //
  // A human check is not stored server-side and should not be: it is something
  // that happened to a read on this device, and marketplace_sync_state's CHECK
  // deliberately holds only the three states the SERVER can observe. Reporting
  // it from here keeps the state where it is true and needs no migration.
  //
  // It matters because a stopped channel is the quietest failure in the whole
  // feature: the poll is switched on, the seller sees no error, and nothing will
  // ever happen again on that channel until they open it themselves.
  const channels = (out && out.syncPollChannels) || {};
  const stopped = Object.keys(channels).filter(function (k) {
    return channels[k] && channels[k].stoppedForHumanCheck === true;
  });

  return {
    available: true,
    accepted: PLAN.isClickwrapAccepted(out && out.syncPollClickwrap),
    enabled: settings.enabled === true,
    intervalMin: PLAN.normalizeIntervalMin(settings.intervalMin),
    terms: PLAN.CLICKWRAP_TERMS,
    stoppedChannels: stopped,
  };
}

async function acceptPollClickwrap() {
  const PLAN = self.GT_SYNC_POLL;
  if (!PLAN) return { ok: false };
  await ext.storage.local.set({
    syncPollClickwrap: PLAN.acceptClickwrap(new Date().toISOString()),
    syncPoll: { enabled: true, intervalMin: PLAN.DEFAULT_INTERVAL_MIN },
  });
  return { ok: true, state: await pollConsentState() };
}

// Revoking clears the ACCEPTANCE, not just the switch. Leaving a stale yes on
// disk would mean flipping the toggle back on never re-asks, and the seller who
// turned it off did so about the thing they had agreed to.
async function revokePollClickwrap() {
  await ext.storage.local.set({ syncPoll: { enabled: false } });
  await ext.storage.local.remove("syncPollClickwrap");
  return { ok: true, state: await pollConsentState() };
}

// The seller has dealt with the human check and wants the channel resumed.
//
// Only they can say so. GradeThread never answers a human check and never
// decides one has passed, so there is no timer here and no automatic retry —
// resuming is an action, not an elapsed duration.
async function resumePollChannel(platform) {
  const out = await ext.storage.local.get("syncPollChannels");
  const channels = (out && out.syncPollChannels) || {};
  if (channels[platform]) {
    channels[platform].stoppedForHumanCheck = false;
    channels[platform].backoffUntilMs = 0;
    await ext.storage.local.set({ syncPollChannels: channels });
  }
  return { ok: true, state: await pollConsentState() };
}

async function setPollInterval(minutes) {
  const PLAN = self.GT_SYNC_POLL;
  if (!PLAN) return { ok: false };
  const out = await ext.storage.local.get("syncPoll");
  const settings = (out && out.syncPoll) || {};
  settings.intervalMin = PLAN.normalizeIntervalMin(minutes);
  await ext.storage.local.set({ syncPoll: settings });
  return { ok: true, state: await pollConsentState() };
}

async function fetchSyncStatus() {
  if (!(await sellerAllowed())) return { ok: false, status: 402, channels: [] };

  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return { ok: false, status: 401, needsSignIn: true, channels: [] };
  }

  let resp;
  try {
    resp = await fetch(SYNC_STATUS_ENDPOINT, {
      headers: { Authorization: "Bearer " + gtBuyerToken },
    });
  } catch (_e) {
    return { ok: false, status: 0, channels: [] };
  }
  let json = null;
  try { json = await resp.json(); } catch (_e) { /* empty body */ }
  return {
    ok: resp.ok,
    status: resp.status,
    channels: (json && Array.isArray(json.channels)) ? json.channels : [],
  };
}

// ── US-2701: the scheduled sold-sync poll ──────────────────────────────────
//
// THE DECIDING IS NOT HERE. Every rule that stops this — consent, the interval
// floor, the engagement exclusion, the signed-out backoff, the human-check stop
// — is a pure function in sync/poll-plan.js, held by test/sync-poll.test.cjs.
// This file only opens the tab the planner named.
//
// It reuses the queue drain's shape rather than inventing a second scheduler:
// an unfocused tab, a URL that came from the bundled config, and a chrome.alarms
// sweep. An alarm is owned by the browser, so it survives the service worker
// being torn down, which setTimeout does not.
const SYNC_POLL_ALARM = "gt-sync-poll";
const SYNC_POLL_TICK_MIN = 5;
/** A polled tab that has not reported by now is closed regardless. */
const SYNC_POLL_TAB_TTL_MS = 90 * 1000;

async function syncPollSettings() {
  const out = await ext.storage.local.get(["syncPoll", "syncPollChannels", "syncPollClickwrap"]);
  return {
    settings: (out && out.syncPoll) || { enabled: false },
    channels: (out && out.syncPollChannels) || {},
    clickwrap: (out && out.syncPollClickwrap) || null,
  };
}

/**
 * Is an engagement run holding a tab right now?
 *
 * Mirrors the liveness check GT_ENGAGE_STATE does: a stored run whose tab is
 * gone is a stale record, not a live run, and treating it as live would wedge
 * the poll off forever after one crashed share pass.
 */
async function engagementInFlight() {
  try {
    const out = await ext.storage.local.get("engageRun");
    const run = out && out.engageRun;
    if (!run || typeof run.tabId !== "number") return false;
    try {
      return Boolean(await ext.tabs.get(run.tabId));
    } catch (_e) {
      await ext.storage.local.remove("engageRun");
      return false;
    }
  } catch (_e) {
    // FAIL CLOSED. If we cannot tell whether a share run is live, do not poll:
    // two automations on one closet is the thing that costs a seller their
    // account, and a skipped poll costs them forty minutes.
    return true;
  }
}

async function runSyncPollTick(nowMs) {
  const PLAN = self.GT_SYNC_POLL;
  const SELECTORS = self.GT_SYNC_SELECTORS;
  if (!PLAN || !SELECTORS) return;

  if (!(await sellerAllowed())) return;

  const stored = await syncPollSettings();
  const plan = PLAN.planPoll({
    nowMs: nowMs,
    platforms: Object.keys(SELECTORS).filter(function (k) { return SELECTORS[k].enabled; }),
    clickwrap: stored.clickwrap,
    settings: stored.settings,
    channels: stored.channels,
    engagementInFlight: await engagementInFlight(),
  });
  if (!plan.poll.length) return;

  const platform = plan.poll[0];
  // The URL is a value from the bundled config. There is no parameter for one.
  const url = PLAN.pollUrlFor(SELECTORS, platform);
  if (!url) return;

  let tab;
  try {
    // NOT focused. This is background work the seller did not just ask for, and
    // stealing focus from whatever they are doing is the fastest way to make
    // them uninstall it.
    tab = await ext.tabs.create({ url: url, active: false });
  } catch (_e) {
    return;
  }

  const channels = stored.channels;
  channels[platform] = PLAN.applyPollResult(channels[platform], null, nowMs);
  await ext.storage.local.set({
    syncPollChannels: channels,
    syncPollTab: { tabId: tab.id, platform: platform, openedAt: nowMs },
  });
}

/** Close a polled tab once it has reported, or once it has had long enough. */
async function reapSyncPollTab(nowMs) {
  const out = await ext.storage.local.get("syncPollTab");
  const rec = out && out.syncPollTab;
  if (!rec || typeof rec.tabId !== "number") return;
  if (nowMs - (rec.openedAt || 0) < SYNC_POLL_TAB_TTL_MS) return;
  try {
    await ext.tabs.remove(rec.tabId);
  } catch (_e) { /* already gone */ }
  await ext.storage.local.remove("syncPollTab");
}

/**
 * Record what a polled read reported, and close its tab.
 *
 * Called from the GT_SYNC_OBSERVE handler, because the content script's report
 * IS the poll's result — there is no second channel and no second read.
 */
async function notePollResult(batch) {
  const PLAN = self.GT_SYNC_POLL;
  if (!PLAN || !batch || !batch.platform) return;
  const out = await ext.storage.local.get(["syncPollTab", "syncPollChannels"]);
  const rec = out && out.syncPollTab;
  if (!rec || rec.platform !== batch.platform) return; // a passive read, not ours

  const channels = (out && out.syncPollChannels) || {};
  channels[batch.platform] = PLAN.applyPollResult(
    channels[batch.platform],
    { signedIn: batch.signedIn !== false, humanCheck: batch.humanCheck === true },
    Date.now(),
  );
  await ext.storage.local.set({ syncPollChannels: channels });
  try {
    await ext.tabs.remove(rec.tabId);
  } catch (_e) { /* the seller may have closed it */ }
  await ext.storage.local.remove("syncPollTab");
}

// ── US-9201: closet import ────────────────────────────────────────────────
//
// The whole flow, so the constraints read in one place:
//   1. the seller presses "Import my closet" on /dashboard/flipdesk/import;
//   2. the page messages here (GT_CLOSET_IMPORT, over the bridge or
//      externally_connectable), naming the marketplace;
//   3. this finds a tab the seller ALREADY HAS OPEN on their own closet or one
//      of their own listings. tabs.query is a read; it never opens, focuses or
//      navigates a tab, and if there is none the honest answer is "open your
//      closet first" rather than opening it for them (that would be the
//      scheduled poll's behaviour under another name, and the poll carries its
//      own consent);
//   4. the content script in that tab reads the page on request and answers
//      with the batch closet-import/extract.js allowlisted;
//   5. this posts the batch with the seller token and hands the run id back to
//      the page, which polls the ordinary import endpoints from there.
//
// The same seller gate as the Lister, by calling the same function. Fail-safe:
// a lookup gap resolves to anonymous and nothing is read or posted.

/** Tab URL patterns for one marketplace's closet and listing pages. */
function closetImportTabPatterns(platform) {
  const SEL = self.GT_CLOSET_IMPORT_SELECTORS;
  const cfg = SEL && SEL[platform];
  if (!cfg || !cfg.enabled) return [];
  const out = [];
  for (const host of cfg.hosts || []) {
    out.push("https://" + host + "/*");
    out.push("https://*." + host + "/*");
  }
  return out;
}

/**
 * "Poshmark, Mercari and Grailed" — built from the bundled adapters.
 *
 * US-3154. This sentence was typed out by hand here, in the web bundle and in
 * the edge route's 400. Three hand-written copies of one list is how US-3261
 * happened; a fourth adapter now changes all three by changing none of them.
 */
function closetImportSupportedSentence() {
  const SEL = self.GT_CLOSET_IMPORT_SELECTORS || {};
  const labels = Object.keys(SEL)
    .filter((k) => SEL[k] && SEL[k].enabled)
    .map((k) => SEL[k].label || k);
  if (labels.length === 0) return "no marketplaces yet";
  if (labels.length === 1) return labels[0];
  return labels.slice(0, -1).join(", ") + " and " + labels[labels.length - 1];
}

async function runClosetImport(msg) {
  const platform = msg && typeof msg.platform === "string" ? msg.platform.toLowerCase() : "";
  const patterns = closetImportTabPatterns(platform);
  if (patterns.length === 0) {
    return {
      ok: false,
      reason: "unsupported",
      error: "Closet import supports " + closetImportSupportedSentence() + ".",
    };
  }
  // US-3263: NO seller gate here any more. An account without a plan may bring
  // in a bounded number of listings, and the server decides that number from
  // the account's own entitlement — the extension cannot know it and must not
  // guess. Refusing here is what made the import invisible to exactly the
  // person deciding whether to pay.
  const { gtBuyerToken, installedAt } = await ext.storage.local.get(["gtBuyerToken", "installedAt"]);
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return { ok: false, status: 401, reason: "needs_sign_in", needsSignIn: true, error: "Sign in to GradeThread in the extension first." };
  }

  let tabs = [];
  try {
    tabs = await ext.tabs.query({ url: patterns });
  } catch (_e) {
    tabs = [];
  }
  // Most recently used first: the tab the seller was just looking at is the
  // one they mean. `lastAccessed` is Chrome 121+ / Firefox; absent, order is
  // whatever the browser gave us.
  tabs = (tabs || []).filter((t) => t && t.id != null).sort(function (a, b) {
    return (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0) || (b.active ? 1 : 0) - (a.active ? 1 : 0);
  });
  if (tabs.length === 0) {
    return { ok: false, reason: "no_tab", error: "Open your own closet on the marketplace in another tab, then press Import again." };
  }

  // Ask each candidate tab in turn; the first that reads a listing wins. A tab
  // on the wrong page says so and the next is tried, so a seller with their
  // closet AND a search results tab open is not told to close the search.
  let last = null;
  for (const tab of tabs) {
    let answered = null;
    try {
      answered = await ext.tabs.sendMessage(tab.id, { type: "GT_CLOSET_IMPORT_READ" });
    } catch (_e) {
      answered = null; // no reader on that page (still loading, or not a matched path)
    }
    if (!answered) continue;
    if (answered.ok && answered.batch) {
      last = answered;
      break;
    }
    if (answered.reason === "human_check" || answered.reason === "not_signed_in") {
      // Stop rather than try another tab: the marketplace asked for a person,
      // or there is nobody signed in, and either is the seller's to resolve.
      return { ok: false, reason: answered.reason, error: closetImportReasonText(answered.reason) };
    }
    last = answered;
  }
  if (!last) {
    return { ok: false, reason: "no_reader", error: "The closet tab has not finished loading. Give it a moment and press Import again." };
  }
  if (!last.ok) {
    return { ok: false, reason: last.reason || "nothing_read", error: closetImportReasonText(last.reason) };
  }

  const instanceId = await getInstanceId();
  let resp;
  try {
    resp = await fetch(CLOSET_IMPORT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GT-Extension-Id": instanceId,
        Authorization: "Bearer " + gtBuyerToken,
      },
      body: JSON.stringify(last.batch),
    });
  } catch (_e) {
    return { ok: false, status: 0, reason: "offline", error: "Couldn't reach GradeThread." };
  }
  let json = null;
  try { json = await resp.json(); } catch (_e) { /* empty body */ }
  return {
    ok: resp.ok,
    status: resp.status,
    reason: resp.ok ? null : "server",
    result: json,
    page: last.batch.page,
    listingsRead: last.batch.listings.length,
    coverage: last.batch.coverage,
    // Local only until now; the web page uses it for one number, the time
    // from install to the first imported item, and never sends it elsewhere.
    installedAt: typeof installedAt === "string" ? installedAt : null,
  };
}

function closetImportReasonText(reason) {
  switch (reason) {
    case "human_check":
      return "The marketplace is asking you to prove you are a person. Finish that in the tab, then press Import again.";
    case "not_signed_in":
      return "You are signed out of the marketplace in that tab. Sign in there, then press Import again.";
    case "not_own_closet":
      return "That closet is not yours. Open your own closet page, then press Import again.";
    case "not_own_listing":
      return "That listing is not yours. Open your own closet, or one of your own listings, then press Import again.";
    case "wrong_page":
      return "Open your own closet page (or one of your own listings) in that tab, then press Import again.";
    default:
      return "Nothing on that page read as one of your listings. Scroll so your listings are on screen, then press Import again.";
  }
}

async function postSyncObservations(msg) {
  const batch = msg && msg.batch;
  if (!batch || typeof batch !== "object" || !batch.platform) {
    return { ok: false, status: 400, error: "No observation batch." };
  }

  // The same gate the Lister uses, by calling the same function rather than a
  // second copy of the rule. Fail-safe by construction: getCapabilities resolves
  // any lookup gap to anonymous, so a hiccup never posts a seller's closet.
  if (!(await sellerAllowed())) {
    return { ok: false, status: 402, error: "Sold-sync is a FlipDesk seller feature." };
  }

  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return { ok: false, status: 401, needsSignIn: true, error: "Sign in to GradeThread to sync sales." };
  }

  const instanceId = await getInstanceId();
  let resp;
  try {
    resp = await fetch(SYNC_OBSERVE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GT-Extension-Id": instanceId,
        Authorization: "Bearer " + gtBuyerToken,
      },
      body: JSON.stringify(batch),
    });
  } catch (_e) {
    return { ok: false, status: 0, error: "Couldn't reach GradeThread." };
  }
  let json = null;
  try { json = await resp.json(); } catch (_e) { /* empty body */ }
  return { ok: resp.ok, status: resp.status, result: json };
}

/**
 * US-3042: is this an eBay item URL? Used only to decide whether a photo-less
 * request is legitimate — the server re-parses and re-validates the URL itself,
 * so this is a UX check and never a trust boundary.
 */
function isEbayListingUrl(url) {
  const EB = self.GT_EBAY_ITEM;
  if (!EB) return false;
  return !!EB.itemIdFromUrl(url);
}

async function ingestListing(msg) {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return {
      ok: false,
      status: 401,
      needsSignIn: true,
      error: "Sign in to GradeThread to check listings against your alerts.",
    };
  }
  if (!msg.url) return { ok: false, status: 400, error: "No listing address to check." };
  // US-3042: on eBay the content script sends the URL alone and the server
  // resolves the listing through eBay's Browse API, so there are no photos to
  // require here. Every other marketplace still sends what it read off the page.
  const ingestByUrlOnly = !Array.isArray(msg.imageUrls) || msg.imageUrls.length === 0;
  if (ingestByUrlOnly && !isEbayListingUrl(msg.url)) {
    return { ok: false, status: 400, error: "No listing photos to check." };
  }
  const instanceId = await getInstanceId();
  let resp;
  try {
    resp = await fetch(INGEST_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GT-Extension-Id": instanceId,
        Authorization: "Bearer " + gtBuyerToken,
      },
      body: JSON.stringify({
        url: msg.url,
        imageUrls: ingestByUrlOnly
          ? undefined
          : msg.imageUrls.slice(0, maxImagesFor(msg.maxImages)),
        title: msg.title || undefined,
        brand: msg.brand || undefined,
        condition: msg.condition || undefined,
        price: msg.price || undefined,
        watch: msg.watch === true,
      }),
    });
  } catch (_e) {
    return { ok: false, status: 0, error: "Couldn't reach GradeThread. Check your connection." };
  }
  let json = null;
  try {
    json = await resp.json();
  } catch (_e) {
    json = null;
  }
  if (resp.ok && json) return { ok: true, status: resp.status, data: json };
  // 402 is the plan/quota gate and 429 the per-day browsing bound. Both are
  // states the shopper can act on, so the server's own wording is passed
  // through rather than flattened into "something went wrong".
  return {
    ok: false,
    status: resp.status,
    needsUpgrade: resp.status === 402,
    error: (json && json.error) || "Couldn't check this listing against your alerts.",
  };
}

// ── flip mode: the sourcing appraisal (US-2238) ───────────────────────────
// Seller-only, and gated HERE as well as on the server. The entitlement check is
// not decoration: without it an unentitled install would fire a request that
// spends nothing (the server refuses) but still shows the seller a spinner and
// then an error, which reads as broken rather than as locked.
async function appraiseListing(msg) {
  const caps = await getCapabilities(false);
  if (!caps.sellerEnabled) {
    // US-3295: same two causes as the Lister gate, same rule about naming them.
    return caps.authenticated === true
      ? { ok: false, status: 403, needsUpgrade: true, error: "FlipDesk plan required." }
      : {
        ok: false,
        status: 401,
        needsSignIn: true,
        error: "Connect this extension to your GradeThread account to appraise listings.",
      };
  }
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return { ok: false, status: 401, error: "Sign in to GradeThread to appraise listings." };
  }
  // US-3042: on eBay the listing URL is the whole request and the server reads
  // the photos, title and price from eBay's Browse API.
  const byListingUrl = typeof msg.url === "string" && msg.url.length > 0;
  if (!byListingUrl && (!Array.isArray(msg.imageUrls) || msg.imageUrls.length === 0)) {
    return { ok: false, status: 400, error: "No listing photos to appraise." };
  }
  let resp;
  try {
    resp = await fetch(APPRAISE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + gtBuyerToken,
      },
      body: JSON.stringify(
        byListingUrl
          ? { url: msg.url, marketplace: msg.marketplace || undefined }
          : {
            imageUrls: msg.imageUrls.slice(0, 4),
            title: msg.title || undefined,
            brand: msg.brand || undefined,
            priceCents: typeof msg.priceCents === "number" ? msg.priceCents : undefined,
            marketplace: msg.marketplace || undefined,
          },
      ),
    });
  } catch (_e) {
    return { ok: false, status: 0, error: "Couldn't reach GradeThread. Check your connection." };
  }
  let json = null;
  try {
    json = await resp.json();
  } catch (_e) {
    json = null;
  }
  if (resp.ok && json) return { ok: true, status: resp.status, data: json };
  // 402 is the plan gate (requireFlipdesk) and 429 the monthly AI cap. Both are
  // states the seller can act on, and neither is worth a retry — so they are
  // threaded through rather than flattened into "something went wrong".
  return {
    ok: false,
    status: resp.status,
    error: (json && json.error) || "Couldn't appraise this listing right now.",
    needsUpgrade: resp.status === 402,
    quotaExhausted: resp.status === 429,
  };
}

// ── compare tray (US-2240) ────────────────────────────────────────────────
// storage.LOCAL, not session: the shopper compares across tabs and often across
// sittings ("I'll decide tonight"), so a tray that emptied on browser restart
// would lose exactly the comparison it exists to hold.
async function pinToTray(entry) {
  if (!entry || typeof entry !== "object" || !entry.key) {
    return { ok: false, error: "Nothing to pin." };
  }
  try {
    const out = await ext.storage.local.get(self.GT_CC_TRAY.KEY);
    const list = self.GT_CC_TRAY.put((out && out[self.GT_CC_TRAY.KEY]) || [], entry);
    await ext.storage.local.set({ [self.GT_CC_TRAY.KEY]: list });
    return { ok: true, count: list.length };
  } catch (_e) {
    // Storage full or unavailable. Reported as a failure so the overlay does NOT
    // flip its button to "Pinned" — a shopper who trusts that and opens an empty
    // compare table has lost the read they thought they saved.
    return { ok: false, error: "Couldn't pin this read." };
  }
}

// ── per-listing grade recall cache ────────────────────────────────────────
async function readGradeCache(listingKey) {
  if (!listingKey || typeof listingKey !== "string") return null;
  try {
    const out = await ext.storage.local.get(GRADE_CACHE_KEY);
    const map = (out && out[GRADE_CACHE_KEY]) || {};
    const entry = map[listingKey];
    if (!entry || typeof entry.at !== "number" || !entry.data) return null;
    if (Date.now() - entry.at > GRADE_CACHE_TTL_MS) return null;
    return { data: entry.data, at: entry.at };
  } catch (_e) {
    return null;
  }
}

async function clearGradeCache() {
  try {
    await ext.storage.local.remove(GRADE_CACHE_KEY);
  } catch (_e) { /* nothing to clear */ }
}

async function writeGradeCache(listingKey, data) {
  if (!listingKey || typeof listingKey !== "string" || !data) return;
  try {
    const out = await ext.storage.local.get(GRADE_CACHE_KEY);
    const map = (out && out[GRADE_CACHE_KEY]) || {};
    map[listingKey] = { data, at: Date.now() };
    // Evict the oldest entries when over the cap.
    const keys = Object.keys(map);
    if (keys.length > GRADE_CACHE_MAX) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
      for (const k of keys.slice(0, keys.length - GRADE_CACHE_MAX)) delete map[k];
    }
    await ext.storage.local.set({ [GRADE_CACHE_KEY]: map });
  } catch (_e) { /* storage unavailable/full — recall just won't warm this time */ }
}

// ── recent reads history ──────────────────────────────────────────────────
async function saveRead(read) {
  if (!read || typeof read !== "object") return;
  const { recentReads } = await ext.storage.local.get("recentReads");
  const list = Array.isArray(recentReads) ? recentReads : [];
  list.unshift({
    url: String(read.url || ""),
    title: String(read.title || "").slice(0, 200),
    marketplace: String(read.marketplace || "").slice(0, 24),
    overallScore: Number(read.overallScore),
    gradeTier: String(read.gradeTier || ""),
    confidence: Number(read.confidence),
    // US-2239: who was selling it, and what they claimed. Both are stored ONLY
    // here in storage.local — the seller handle is never attached to a grading
    // request, a telemetry ping, or anything else that leaves the device.
    // `claimedGrade` comes from the endpoint's discrepancy block, which is a
    // paid signal, so it is often absent; null is stored rather than 0 so an
    // absent claim can't be averaged as "claimed nothing".
    seller: typeof read.seller === "string" && read.seller ? read.seller.slice(0, 80) : null,
    claimedGrade: typeof read.claimedGrade === "number" && isFinite(read.claimedGrade)
      ? read.claimedGrade
      : null,
    at: Number(read.at) || Date.now(),
  });
  await ext.storage.local.set({ recentReads: list.slice(0, MAX_RECENT) });
}

// US-2239: the shopper's own history with ONE seller. A pure aggregation over
// storage.local — no network, nothing sent, nothing recorded server-side. Kept
// in the worker rather than the content script only because recentReads lives
// here; the answer is computed by the pure seller-memory module either way.
async function getSellerHistory(marketplace, seller) {
  const key = self.GT_CC_SELLER.sellerKey(marketplace, seller);
  if (!key) return null;
  try {
    const { recentReads } = await ext.storage.local.get("recentReads");
    const mine = (Array.isArray(recentReads) ? recentReads : []).filter(
      (r) => r && self.GT_CC_SELLER.sellerKey(r.marketplace, r.seller) === key,
    );
    const stats = self.GT_CC_SELLER.aggregate(mine);
    if (!stats) return null;
    return { stats: stats, copy: self.GT_CC_SELLER.sellerCopy(stats) };
  } catch (_e) {
    return null; // unreadable storage — show nothing rather than a wrong pattern
  }
}

// ── Lister job lifecycle (US-1874) ────────────────────────────────────────
// Job state lives in chrome.storage.session, NOT in module memory. Chrome kills an
// idle MV3 service worker ~30s after the last event and an open sendResponse port
// does not keep it alive, so module-scope job maps + setTimeout safety nets died
// with the worker while a slow marketplace tab was still loading — the job then
// silently vanished. storage.session survives worker death, is cleared on browser
// restart (jobs must not outlive the session), and never touches disk.
//
// The decision logic is the pure GT_LISTER_JOBS state machine (lister/job-store.js);
// everything here is the async shell around it.
const JOBS_KEY = "listerJobs";
const JOB_ALARM_PREFIX = "gt-lister-job:";
const SWEEP_ALARM = "gt-lister-sweep";

// US-3367: the gap between cross-posts. The seller's chosen gap and the
// scheduled time both live in storage.local because this worker is evicted
// between alarms and would otherwise wake up believing there is no hold.
const PACED_DRAIN_ALARM = "gt-lister-paced-drain";
const PACING_GAP_KEY = "gtPacingGapMs";
const NEXT_LIST_DRAIN_KEY = "gtNextListDrainAt";

async function readPacingGapMs() {
  const out = await ext.storage.local.get(PACING_GAP_KEY);
  return self.GT_LISTER_JOBS.pacingGapFor(out && out[PACING_GAP_KEY]);
}

async function readNextListDrainAt() {
  const out = await ext.storage.local.get(NEXT_LIST_DRAIN_KEY);
  const v = out && out[NEXT_LIST_DRAIN_KEY];
  return typeof v === "number" ? v : null;
}

/** Schedule the drain that follows a list job, and remember when. */
async function scheduleListDrain(settledAt) {
  const J = self.GT_LISTER_JOBS;
  const at = J.nextListDrainAt(settledAt, await readPacingGapMs(), J.PACING.JITTER_MS);
  if (at === null) return;
  await ext.storage.local.set({ [NEXT_LIST_DRAIN_KEY]: at });
  try {
    await ext.alarms.create(PACED_DRAIN_ALARM, { when: at });
  } catch (_e) { /* the 5-minute sweep still picks the queue up */ }
}

// pendingExternal is now only a best-effort FAST PATH: when the worker happens to
// still be alive, replying on the original port resolves the SaaS promise with no
// round trip. It is NOT the delivery guarantee — pushToSaasTab is (AC3). Anything
// in here is expected to be gone after a worker restart, and that is fine.
const pendingExternal = {};
let jobSeq = 0;

function makeJobId() {
  jobSeq += 1;
  // jobSeq restarts at 0 on every worker wake, so it alone is NOT unique across
  // suspensions — the timestamp + random suffix are what keep ids from colliding
  // with a job persisted by a previous instance of this worker.
  return (
    "job-" + Date.now() + "-" + jobSeq + "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

// storage.session read-modify-write is async, so two concurrent jobs could clobber
// each other's entry. Every mutation goes through this promise chain, which costs
// nothing at this volume and removes the race entirely.
let jobsQueue = Promise.resolve();
function withJobs(fn) {
  const run = jobsQueue.then(async () => {
    // storage.session failures must not reject outward: every caller is inside a
    // message listener that still owes a sendResponse, and an unhandled rejection
    // there means the port is never answered — reintroducing the exact hang this
    // story removes. Degrade to an empty map instead.
    let jobs = {};
    try {
      const out = await ext.storage.session.get(JOBS_KEY);
      jobs = (out && out[JOBS_KEY]) || {};
    } catch (_e) { /* unavailable — treat as no jobs */ }
    const res = await fn(jobs);
    if (res && res.jobs) {
      try {
        await ext.storage.session.set({ [JOBS_KEY]: res.jobs });
      } catch (_e) { /* full/unavailable — the alarm still backstops the job */ }
    }
    return res && res.value;
  });
  // Keep the chain alive even if one mutation throws, or every later job blocks.
  jobsQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// AC3: deliver a job result to the gradethread.com tab that started it, so
// delivery no longer depends on the original sendResponse port (or the worker that
// held it) still existing. The SaaS bridge content script relays this to the page.
// Fire-and-forget: the tab may be gone, which is not an error worth surfacing.
async function pushToSaasTab(job, result) {
  if (!job || typeof job.saasTabId !== "number") return;
  try {
    await ext.tabs.sendMessage(job.saasTabId, {
      type: "GT_LISTER_JOB_UPDATE",
      jobId: job.jobId,
      clientRef: job.clientRef,
      result: result,
    });
  } catch (_e) {
    // Tab closed, navigated away, or has no bridge (never had our content script).
    // The SaaS-side client timeout is the backstop.
  }
}

// US-3370: the result envelope a DRAINED queue row is completed with.
//
// IT IS A LIST, AND A HAND-WRITTEN LIST IS THE BUG THIS EXISTS TO CLOSE. The
// old one was three fields typed out inline (error, manual, listingUrl), and
// runFlow has returned eleven more since US-1877. `photosWitness` was one of
// them: lister/common.js has emitted it since US-2738 and US-3367 built the
// whole seller-facing rendering for it, and it never once reached the wire,
// because a list written by hand drops a field in total silence.
//
// WHY IT IS STILL A LIST AND NOT Object.assign({}, result). The other end is
// hostile to a document nobody chose. The edge runs this through
// normalizeQueuePayload, which does two things on the way in:
//
//   * REFUSES the whole completion with a 400 when any key at any depth looks
//     credential-shaped, matched on a SUFFIX, so a future flow field ending in
//     "pass" or "session" would 400 every completion carrying it. And a refused
//     completion does not fail quietly: completeQueueRow holds the result and
//     re-sends the same refused body until it gives up, which is precisely the
//     stuck-`claimed` row US-3061 was written to end.
//   * drops the result to {} WHOLE, not truncated, when the JSON goes past
//     8 KB. One oversized value would take the error string down with it.
//
// Coercion is the other half. A flow returning an object where a word belongs,
// or a list that grows without a bound (`fields` is short today and nothing
// makes it stay short), must not be able to put that shape into a row three
// clients render. So: a declared table, every value coerced and capped here,
// where the cost of a new field is a decision rather than an accident.
//
// The table is a SUPERSET of what the flows return. `ok` is the only key any
// flow produces that is deliberately absent, because the completion body
// carries its own top-level `ok` and two copies could disagree.
//
// WHAT KEEPS IT IN STEP WITH runFlow. test/queue-result-envelope.test.cjs reads
// every result literal in lister/common.js and lister/job-store.js (every
// `return {` carrying an `ok` key), and fails when a key is neither in the
// table below nor named in that test's NOT_SENT list with a reason. Adding a
// field to a flow now goes red until someone decides where it belongs.
//
// NOT used by drainQueue's own refusals. Those build small literals of their
// own (expired, unsupported, mobileUnsupported) that never come from a flow,
// and routing them through here would silently drop exactly those three keys.
const QUEUE_RESULT_FIELDS = {
  // Always sent, whatever the run did. Three clients have read these since
  // US-2481 and an absent key is not the same thing as a null one to any of
  // them, so these keep their old unconditional shape.
  error: { type: "text", max: 400, always: true },
  manual: { type: "flag", always: true },
  listingUrl: { type: "url", max: 500, always: true },
  // Everything below is sent only when the run produced it, and `undefined` is
  // load-bearing downstream: queue-view.js photoWitnessState reads
  // `photosTotal === undefined` to tell an extension build old enough to send
  // no counts at all from a run that attached nothing, and those are two
  // different sentences to a seller.
  filled: { type: "flag" },
  priceFilled: { type: "flag" },
  brandFilled: { type: "flag" },
  tagsCommitted: { type: "count" },
  tagsTotal: { type: "count" },
  photosAttached: { type: "flag" },
  photosTotal: { type: "count" },
  photosFailed: { type: "count" },
  photosUnverified: { type: "count" },
  // The one this story is named after. "page", "none" or "not-asked".
  photosWitness: { type: "text", max: 32 },
  delisted: { type: "flag" },
  revised: { type: "flag" },
  copied: { type: "flag" },
  unverified: { type: "flag" },
  // A revise that wrote some fields and not others, and which ones it wrote.
  // Names, never values: runReviseFlow pushes the field name onto this list.
  partial: { type: "flag" },
  fields: { type: "words", max: 40, maxLength: 12 },
  verifiedBy: { type: "text", max: 64 },
  // The delist could not find the listing to end at all.
  notFound: { type: "flag" },
  // A machine-readable code beside the seller-facing `error` string, for the
  // refusals that have one ("empty_payload").
  reason: { type: "text", max: 48 },
  timedOut: { type: "flag" },
  tabClosed: { type: "flag" },
  late: { type: "flag" },
  // Which selector-config version ran. A selector break reported without it is
  // a bug report with no build number on it.
  version: { type: "text", max: 32 },
};

/**
 * Project a flow result onto the queue envelope.
 *
 * Every value is coerced rather than copied: a flow that returns a string where
 * a count belongs, or an object where a word belongs, must not be able to put
 * that shape into a row three clients render.
 */
function queueResultEnvelope(result) {
  const r = result && typeof result === "object" ? result : {};
  const out = {};
  for (const name of Object.keys(QUEUE_RESULT_FIELDS)) {
    const spec = QUEUE_RESULT_FIELDS[name];
    const raw = r[name];
    if (raw === undefined && !spec.always) continue;
    if (spec.type === "flag") {
      out[name] = raw === true;
    } else if (spec.type === "count") {
      out[name] = typeof raw === "number" && isFinite(raw) ? Math.max(0, Math.round(raw)) : null;
    } else if (spec.type === "words") {
      // A short list of short names. Capped on both axes, because an array is
      // the one shape here that has no natural size.
      out[name] = Array.isArray(raw)
        ? raw.filter(function (w) { return typeof w === "string" && w !== ""; })
          .slice(0, spec.maxLength)
          .map(function (w) { return w.slice(0, spec.max); })
        : [];
    } else {
      // "text" and "url" alike: a string, or a number spelled out (version is
      // a number on some flows), capped. Anything else is not a value.
      const text = typeof raw === "string"
        ? raw
        : (typeof raw === "number" && isFinite(raw) ? String(raw) : null);
      out[name] = text === null ? null : text.slice(0, spec.max);
    }
  }
  return out;
}

// Settle a job outward on BOTH paths: the live port if we still have it, and the
// durable push. The page de-duplicates by jobId, so a double delivery is safe and
// whichever arrives first wins.
async function reportJob(job, result) {
  const cb = pendingExternal[job.jobId];
  if (cb) {
    try { cb(result); } catch (_e) { /* port closed — the push is the real path */ }
    delete pendingExternal[job.jobId];
  }
  await pushToSaasTab(job, result);
  // US-9202: a revise reports into the marker the web reads, whether it was
  // started from a page, drained from the queue, or picked up by the sweep.
  // The listing id is the job's own (from the server's pending list or the
  // page's payload, both owner-checked server-side), never from the result.
  if (job.kind === "revise" && job.reviseListingId) {
    await confirmRevise(job.reviseListingId, result);
    void drainPendingRevises();
  }
  // US-2481: a DRAINED job has no originating GradeThread tab to push to — the
  // seller queued it from their phone, possibly hours ago and on another
  // network. Its outcome goes back to the queue row instead, which is the only
  // place they will look for it.
  if (job.queueId) {
    // US-3061: through completeQueueRow, which keeps the result when the server
    // does not take it. This used to be a bare post whose answer was discarded,
    // so a dead token or one offline second at the end of a marketplace tab left
    // a FINISHED job sitting `claimed` on the server. /claim reads only `queued`
    // rows, so nothing could ever hand it back: the seller's phone showed the
    // job as still running until expires_at seven days later.
    // US-3370: through queueResultEnvelope, which is the declared field table
    // above rather than three fields typed out here. The inline version dropped
    // everything runFlow learned about the run: no photo counts, no witness, no
    // price or tag result, no config version. A seller whose Poshmark uploader
    // took the file list and rendered nothing got a row that said "done".
    await completeQueueRow(job.queueId, {
      ok: result && result.ok === true,
      result: queueResultEnvelope(result),
    });
    // Look for the next one. The drain runs a single job at a time, so without
    // this a queue of six would take six sweep ticks — half an hour — to clear
    // a browser that was open the whole time.
    //
    // US-3367: a LIST job earns a gap first, through a one-shot alarm, so six
    // cross-posts do not go up back to back. Everything else re-drains at once:
    // a delist is the urgent verb, and pacing it is how a double sale happens.
    if (self.GT_LISTER_JOBS.pacesAfter(job)) {
      await scheduleListDrain(Date.now());
    } else {
      void drainQueue();
    }
  }
  // US-1885 AC1: remember the outcome for the popup. storage.LOCAL, not session:
  // the seller's most likely move after a cross-post that went wrong is to open the
  // popup later — possibly after a browser restart — and ask what happened. A
  // session-scoped record would be gone exactly when they came looking.
  await writeLastJob(job, result);
}

// US-1877 (AC1): post-fill watches, keyed by marketplace tab id. Same
// storage.session posture as the job map — a watch must outlive the worker, since
// the seller submits minutes after the fill.
const WATCHES_KEY = "listerWatches";
let watchQueue = Promise.resolve();
function withWatches(fn) {
  const run = watchQueue.then(async () => {
    let watches = {};
    try {
      const out = await ext.storage.session.get(WATCHES_KEY);
      watches = (out && out[WATCHES_KEY]) || {};
    } catch (_e) { /* unavailable — treat as none */ }
    const res = await fn(watches);
    if (res && res.watches) {
      try {
        await ext.storage.session.set({ [WATCHES_KEY]: res.watches });
      } catch (_e) { /* full/unavailable — the seller still has "I published it" */ }
    }
    return res && res.value;
  });
  watchQueue = run.then(() => undefined, () => undefined);
  return run;
}

const LAST_JOB_KEY = "listerLastJob";
async function writeLastJob(job, result) {
  try {
    await ext.storage.local.set({
      [LAST_JOB_KEY]: self.GT_LISTER_JOBS.lastJobRecord(job, result, Date.now()),
    });
  } catch (_e) { /* storage full/unavailable — the popup just shows no last job */ }
}

// AC2: timeouts are chrome.alarms, not setTimeout — an alarm is owned by the
// browser and fires (waking the worker) even though the worker that scheduled it
// is long dead. setTimeout could never do this; it died with its worker, which is
// why a timed-out job used to hang the SaaS promise for its full client timeout.
async function scheduleJobAlarm(job) {
  try {
    await ext.alarms.create(JOB_ALARM_PREFIX + job.jobId, { when: job.deadlineAt });
  } catch (_e) { /* alarms unavailable — the SaaS client timeout still backstops */ }
}

async function clearJobAlarm(jobId) {
  try { await ext.alarms.clear(JOB_ALARM_PREFIX + jobId); } catch (_e) { /* ignore */ }
}

// End a pending job and report it. Shared by the timeout alarm and tab-close, and
// safe to call twice: markTerminal no-ops on an already-terminal job, so only the
// first caller reports (no double-settle of the SaaS promise).
async function endJob(jobId, state, makeResult) {
  const ended = await withJobs(async (jobs) => {
    const res = self.GT_LISTER_JOBS.markTerminal(jobs, jobId, state, Date.now());
    return { jobs: res.jobs, value: res.job };
  });
  if (!ended) return null;
  await clearJobAlarm(jobId);
  await reportJob(ended, makeResult(ended));
  return ended;
}

function isValidPayload(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.platform === "string" &&
    SUPPORTED_LISTER[p.platform] &&
    typeof p.title === "string" &&
    p.title.length > 0
  );
}

// US-3369: a delist is well-formed when it names a supported platform. Whether
// it can RUN (a host-pinned link, or titles to search the active-listings page
// for) is delistTargetFor's question, answered in handleDelistRequest with a
// sentence the seller can act on rather than "Invalid payload".
function isValidDelistPayload(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.platform === "string" &&
    SUPPORTED_LISTER[p.platform]
  );
}

// US-3369: the words for each reason delistTargetFor can refuse.
function delistRefusalFor(platform, reason) {
  const label = SUPPORTED_LISTER[platform] || platform;
  if (reason === "needs-handle") {
    return "GradeThread needs your " + label + " username to find this listing. " +
      "Add it on the item page in GradeThread, or end the listing on " + label + " yourself.";
  }
  if (reason === "no-titles") {
    return "GradeThread has no link or title for this " + label + " listing, so it " +
      "can't find it. End it on " + label + " yourself.";
  }
  if (reason === "bad-url") {
    return "That " + label + " link doesn't point at " + label + ", so GradeThread " +
      "won't open it. End the listing on " + label + " yourself.";
  }
  return "GradeThread has no link to this " + label + " listing and can't search " +
    label + " for it yet. End it on " + label + " yourself.";
}

// US-3369: the payload a delist job actually runs with. The fields the
// content script acts on are rebuilt here from the guard's answer, so a page
// can never set `locate` itself or slip an unsanitised title list through.
function delistJobPayload(payload, target) {
  const out = Object.assign({}, payload);
  delete out.locate;
  delete out.matchTitles;
  delete out.sellerHandle;
  if (target.locate) {
    out.locate = true;
    out.matchTitles = self.GT_LISTER_GUARD.sanitizeMatchTitles(payload.matchTitles);
  }
  return out;
}

// US-9202: a revise names a live listing (host-pinned like a delist) and at
// least one field to bring up to date.
function isValidRevisePayload(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.platform === "string" &&
    SUPPORTED_LISTER[p.platform] &&
    Array.isArray(p.fields) &&
    p.fields.length > 0 &&
    self.GT_LISTER_GUARD.isAllowedDelistUrl(
      self.GT_LISTER_SELECTORS,
      p.platform,
      p.listingUrl,
    )
  );
}

// US-9203: a relist names a live listing to copy from (host-pinned like a
// delist) and the NEW row the server created for the copy.
function isValidRelistPayload(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.platform === "string" &&
    SUPPORTED_LISTER[p.platform] &&
    typeof p.newListingId === "string" &&
    p.newListingId.length > 0 &&
    self.GT_LISTER_GUARD.isAllowedDelistUrl(
      self.GT_LISTER_SELECTORS,
      p.platform,
      p.listingUrl,
    )
  );
}

// US-2482: everything the engagement gate needs, read fresh.
//
// Read on EVERY gate call rather than cached, because the three things it holds
// are exactly the three that must not go stale mid-run: a revoked consent, a
// lowered cap, and a counter another tab just incremented. All three live in
// storage.LOCAL and never leave the device — GradeThread's servers see run
// counts at most, and never a Poshmark page, handle or cookie.
async function readEngageState() {
  const out = await ext.storage.local.get([
    "engageClickwrap",
    "engageSettings",
    "engageCounters",
  ]);
  const settings = self.GT_ENGAGE.clampSettings(out && out.engageSettings);
  const counters = self.GT_ENGAGE.rollCounters(
    out && out.engageCounters,
    Date.now(),
    new Date().getTimezoneOffset(),
  );
  return { clickwrap: (out && out.engageClickwrap) || null, settings, counters };
}

async function tosAccepted() {
  const out = await ext.storage.local.get("tosAcceptedAt");
  return Boolean(out && out.tosAcceptedAt);
}

// US-1873 gate: cross-post/delist require an active paid FlipDesk account. Checked
// on every list/delist request (cache is short + token-invalidated) so a lapse or
// an upgrade takes effect without reinstall. FAIL-SAFE: no entitlement → locked.
async function sellerAllowed() {
  const caps = await getCapabilities(false);
  return caps.lister === true;
}

// US-3295 / US-3296: null when the Lister is granted, else "signin",
// "reconnect" or "plan".
//
// These are not the same problem and they do not have the same fix. An install
// with no account token receives the ANONYMOUS entitlements from the server
// whatever the account pays, so reporting that as "upgrade your plan" sent
// Business sellers to /pricing to buy what they already had. An install whose
// token LAPSED gets the same anonymous answer, which is why it needs its own
// word: those sellers connected months ago and are not helped by being told to
// connect.
//
// US-3296: renew before judging. A token that is merely expired-and-renewable
// is not a block at all, and the seller pressing Send is the best moment to
// find that out. The call is a storage read unless the token is actually inside
// its renewal window, so this costs nothing on the ordinary path.
async function listerBlock() {
  await renewTokenIfNeeded(false);
  return self.GT_REGISTRY.listerBlockReason(await getCapabilities(false));
}

// AC5: the request handlers are async and their bodies await storage, the network
// (entitlements) and tabs.create — any of which can throw. They are invoked from a
// listener that has already returned `true` to hold the response port open, so an
// unhandled rejection used to mean the port was simply never answered and the SaaS
// promise hung to its client timeout with no diagnosis. startJob wraps every body
// so a throw ALWAYS becomes an error response.
async function startJob(kind, payload, sender, sendResponse, clientRef) {
  try {
    await beginJob(kind, payload, sender, sendResponse, clientRef);
  } catch (err) {
    try {
      sendResponse({
        ok: false,
        error:
          "The GradeThread extension hit an unexpected error starting this " +
          (kind === "delist"
            ? "delist"
            : kind === "revise"
            ? "edit sync"
            : kind === "relist"
            ? "relist"
            : "cross-post") +
          ". Try again.",
      });
    } catch (_e) { /* port already gone */ }
     
    console.error("[GradeThread Lister] job start failed", err);
  }
}

async function beginJob(kind, payload, sender, sendResponse, clientRef) {
  const isDelist = kind === "delist";

  const block = await listerBlock();
  if (block) {
    // Both flags are sent, and only one is ever true. `needsUpgrade` stays the
    // wire name an older gradethread.com build recognises; a build that does not
    // know `needsSignIn` falls through to the plain error string, which now says
    // the right thing either way.
    sendResponse({
      ok: false,
      // US-3296: "reconnect" also sets needsSignIn. An older gradethread.com
      // build has never heard of needsReconnect, and Connect is the screen that
      // fixes both — so the fallback lands somewhere useful rather than on
      // /pricing. The precise word rides on its own flag for builds that know it.
      needsSignIn: block === "signin" || block === "reconnect",
      needsReconnect: block === "reconnect",
      needsUpgrade: block === "plan",
      error: block === "reconnect"
        ? "Your GradeThread connection has expired. Open GradeThread, connect the extension again, then try again."
        : block === "signin"
        ? "The GradeThread extension is not connected to your account yet. Open it and choose Sign in, then try again."
        : isDelist
        ? "Auto-delist is a FlipDesk seller feature — upgrade your GradeThread plan to enable it."
        : "Cross-listing is a FlipDesk seller feature — upgrade your GradeThread plan to enable the Lister.",
    });
    return;
  }
  if (!(await tosAccepted())) {
    sendResponse({
      ok: false,
      needsConsent: true,
      error: isDelist
        ? "Open the GradeThread extension and accept the Lister terms before delisting."
        : "Open the GradeThread extension and accept the Lister terms before cross-listing.",
    });
    return;
  }

  // AC1 (US-1876, preserved): the list target is ALWAYS the bundled selectors config
  // value, never payload.newListingUrl — an XSS on gradethread.com can't steer
  // navigation. The delist target is the payload URL, already host-pinned to the
  // platform by isValidDelistPayload before we got here.
  let url;
  if (isDelist) {
    // US-3369: resolved by handleDelistRequest through delistTargetFor — the
    // listing link, or the seller's active-listings page from our own config.
    // Host-checked once more here, so nothing that reaches this line unvetted
    // can open a tab.
    url = payload.targetUrl;
    if (!self.GT_LISTER_GUARD.isAllowedDelistUrl(self.GT_LISTER_SELECTORS, payload.platform, url)) {
      sendResponse({ ok: false, error: "Invalid or unsupported delist payload." });
      return;
    }
  } else if (kind === "revise" || kind === "relist") {
    // US-9202 / US-9203: a revise or relist opens the listing itself,
    // host-pinned by its validator exactly as a delist URL is.
    url = payload.listingUrl;
  } else {
    // US-2479: locale-aware for the multi-domain platforms (Vinted), unchanged
    // for everything else. `payload.locale` is a KEY looked up in the bundled
    // config, never a URL — AC1 above still holds in full.
    url = self.GT_LISTER_GUARD.newListingUrlForLocale(
      self.GT_LISTER_SELECTORS,
      payload.platform,
      payload.locale,
    );
    if (!url) {
      // Distinguish the two ways this fails, because they need different things
      // from the seller. An uncovered locale is not a broken extension — it is a
      // country we have not verified the form on, and saying so (with the list of
      // ones we have) is the fail-loud contract rather than opening a tab on a
      // Vinted the seller has no account on.
      const covered = self.GT_LISTER_GUARD.localesFor(
        self.GT_LISTER_SELECTORS,
        payload.platform,
      );
      sendResponse({
        ok: false,
        manual: true,
        error: covered.length > 0 && payload.locale
          ? "GradeThread doesn't cover " + String(payload.locale).slice(0, 40) +
            " yet — please list manually there. Covered right now: " +
            covered.join(", ") + "."
          : "Unsupported marketplace.",
      });
      return;
    }
  }

  let tab;
  try {
    tab = await ext.tabs.create({ url: url, active: true });
  } catch (_e) {
    sendResponse({ ok: false, error: "Couldn't open the marketplace tab." });
    return;
  }

  const job = self.GT_LISTER_JOBS.makeJob({
    jobId: makeJobId(),
    clientRef: clientRef,
    tabId: tab.id,
    // AC3: remember which gradethread.com tab asked, so the result can be pushed
    // home later even if this worker (and its response port) is gone by then.
    saasTabId: (sender && sender.tab && sender.tab.id) ?? null,
    platform: payload.platform,
    kind: kind,
    payload: payload,
    // US-9202: which marker to confirm when the job settles.
    reviseListingId: kind === "revise" && typeof payload.listingId === "string"
      ? payload.listingId
      : null,
    now: Date.now(),
  });

  await withJobs(async (jobs) => ({ jobs: self.GT_LISTER_JOBS.put(jobs, job) }));
  await scheduleJobAlarm(job);
  // Registered only AFTER the job is durably stored: if we die between the two, the
  // alarm still fails the job cleanly rather than leaving an orphan.
  pendingExternal[job.jobId] = sendResponse;
}

// ── US-2481: drain the mobile queue ───────────────────────────────────────
//
// The seller queued work from their phone. This browser runs it the next time it
// is open. The server held WHAT to do — an item id, a platform, a locale key —
// and never a marketplace credential, which is the whole reason a queue is
// allowed to exist at all (the ADR bright line).
//
// Runs on startup, on install, and on the 5-minute sweep. ONE job at a time:
// planDrain enforces that, because six marketplace tabs opening at once in the
// browser the seller is also using is not a feature.
const QUEUE_ENDPOINT = "https://functions.gradethread.com/api/flipdesk/extension-queue";

/**
 * The queue call, with the OUTCOME kept.
 *
 * US-3061: `queueFetch` below flattens a dead token, an offline moment, a 404
 * and a 500 into the same `null`, which is fine for a poll and wrong for a
 * write. Every caller that is RECORDING something needs to know whether the
 * server took it, so the recording ones go through this and the reads keep the
 * shorter one.
 *
 * `ok` is the HTTP result and nothing more; whether the write actually landed is
 * GT_WORKER_STATE.resultAccepted's question, because a 200 that updated no rows
 * is not a failed request.
 */
async function queueFetchResult(path, init) {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") {
    return { ok: false, status: 0, body: null, reason: "no-token" };
  }
  try {
    const resp = await fetch(QUEUE_ENDPOINT + (path || ""), Object.assign({
      cache: "no-store",
      headers: {
        "Authorization": "Bearer " + gtBuyerToken,
        "Content-Type": "application/json",
      },
    }, init || {}));
    let body = null;
    try { body = await resp.json(); } catch (_e) { body = null; }
    return { ok: resp.ok, status: resp.status, body: body, reason: null };
  } catch (_e) {
    return { ok: false, status: 0, body: null, reason: "network" };
  }
}

async function queueFetch(path, init) {
  const out = await queueFetchResult(path, init);
  // Offline, or the seller's token expired. The queue is server-side state and
  // survives; the next tick tries again. Nothing is lost by failing quietly
  // here, and a toast about a background poll would be noise.
  return out.ok ? out.body : null;
}

// -- US-3061: a result is not sent until the server says it took it ---------
//
// See the "unsent results" section of queue/worker-state.js for what this is
// fixing. In short: every `/complete` post used to be fire-and-forget, so one
// lost POST left a finished job sitting `claimed` on the server for seven days
// with nothing able to pick it up, while the drain reported "ok".

/** storage.local, not session: an unsent result must survive a browser restart,
 *  which is exactly the case that loses it. */
const UNSENT_RESULTS_KEY = "gtQueueUnsentResults";
let unsentQueue = Promise.resolve();

function withUnsentResults(fn) {
  const run = unsentQueue.then(async () => {
    let store = [];
    try {
      const out = await ext.storage.local.get(UNSENT_RESULTS_KEY);
      store = (out && out[UNSENT_RESULTS_KEY]) || [];
    } catch (_e) { /* unavailable - treat as none */ }
    const res = await fn(store);
    if (res && res.store) {
      try {
        await ext.storage.local.set({ [UNSENT_RESULTS_KEY]: res.store });
      } catch (_e) { /* full/unavailable - the next attempt re-records it */ }
    }
    return res && res.value;
  });
  unsentQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Report a queue row's outcome, and keep the result if the server did not take
 * it.
 *
 * Returns true when the row is settled server-side. Every `/complete` in this
 * file goes through here - the expired rows, the unsupported ones, the refused
 * targets and the finished jobs alike - because "we told the server" was a claim
 * none of them checked.
 */
async function completeQueueRow(queueId, body) {
  if (typeof queueId !== "string" || queueId === "") return false;
  const W = self.GT_WORKER_STATE;
  const out = await queueFetchResult("/" + queueId + "/complete", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (W.resultAccepted(out, queueId)) {
    await withUnsentResults(async (store) => ({ store: W.clearUnsentResult(store, queueId) }));
    return true;
  }
  await withUnsentResults(async (store) => ({
    store: W.recordUnsentResult(store, { queueId: queueId, body: body, status: out.status }, Date.now()),
  }));
  return false;
}

/**
 * Re-send the results the server has not taken yet.
 *
 * Runs at the head of every drain, BEFORE anything is claimed: a row whose
 * result is still owed is a row the server still thinks is running, and claiming
 * more work while the last batch is unrecorded is how a backlog turns into a
 * queue that looks busy and is not.
 */
async function flushUnsentResults() {
  const W = self.GT_WORKER_STATE;
  const due = await withUnsentResults(async (store) => ({ value: W.dueUnsentResults(store, Date.now()) }));
  for (const entry of due || []) {
    const out = await queueFetchResult("/" + entry.queueId + "/complete", {
      method: "POST",
      body: JSON.stringify(entry.body),
    });
    if (W.resultAccepted(out, entry.queueId)) {
      await withUnsentResults(async (store) => ({ store: W.clearUnsentResult(store, entry.queueId) }));
      continue;
    }
    await withUnsentResults(async (store) => ({
      store: W.recordUnsentResult(
        store,
        { queueId: entry.queueId, body: entry.body, status: out.status },
        Date.now(),
      ),
    }));
  }
  // Out of attempts. Said out loud rather than dropped quietly - a result binned
  // in silence is the original defect wearing a ledger.
  await withUnsentResults(async (store) => {
    const gone = W.exhaustedUnsentResults(store);
    if (gone.length === 0) return { value: 0 };
    for (const e of gone) {
      console.error(
        "[gt] gave up re-sending a queue result after " + e.attempts +
          " attempts; the row will expire on the server:", e.queueId, "last status", e.lastStatus,
      );
    }
    return { store: W.dropExhaustedResults(store), value: gone.length };
  });
}

let drainInFlight = false;

/**
 * US-3143: the floor under web-triggered drains. See the GT_DRAIN_NOW handler
 * for why it exists — it guards against a page in a loop, not against a race.
 * Deliberately well under the 5-minute alarm, so a genuine nudge is never the
 * one refused.
 */
const DRAIN_NUDGE_MIN_GAP_MS = 30000;
let lastNudgedDrainAt = 0;

/**
 * Run the queue.
 *
 * US-3143: it now REPORTS what it did, as one of "busy" / "not-allowed" /
 * "needs-consent" / "empty" / "ok". Every caller before this one fired it into
 * the void (`void drainQueue()`) and still may — the alarm has nobody to tell.
 * The web's "drain now" nudge does: a seller looking at a pending delist while
 * their plan has lapsed needs a different answer from one whose queue is simply
 * empty, and without a return value both look identical from the page.
 *
 * The codes name a STATE, never a listing. Nothing about which jobs ran, which
 * marketplace, or which URL crosses back to the page.
 */
async function drainQueue() {
  // Re-entrancy guard: the sweep alarm and a startup event can land together,
  // and two concurrent drains would each claim the same row before either
  // marked it.
  if (drainInFlight) return "busy";
  drainInFlight = true;
  try {
    // Same gates as an interactive cross-post, checked in the same order. A
    // drained job is not a special case that gets to skip the seller's consent.
    // US-3143: nor is a web-triggered one — a nudge is a trigger, not a bypass.
    // US-3061: results the server has not taken yet go first, and they go BEFORE
    // the gates. A gate decides whether this browser may take on NEW work; an
    // owed result is a report of work the seller's own browser already did, and
    // a plan that lapsed on Tuesday must not be the reason Monday's delist is
    // still showing as running on their phone. See flushUnsentResults.
    await flushUnsentResults();

    if (!(await sellerAllowed())) return "not-allowed";
    if (!(await tosAccepted())) return "needs-consent";
    // US-3061: a marketplace has asked for a person — a login wall or a human
    // check — and only the seller can say they answered it. Claiming another
    // row now would open the same challenged page again, which is a machine
    // retrying a check it was told a human would clear. The ADR (§3.2) refuses
    // to answer one; retrying past one is the same refusal with worse manners.
    if (await workerPaused()) return "paused";

    // US-3367: inside a pacing gap after a cross-post. Checked BEFORE /claim,
    // so a row is never stamped claimed by a browser that is about to sit on
    // it — that is the US-3061 stranding bug wearing a gap.
    const hold = self.GT_LISTER_JOBS.pacingHold(
      { nextListDrainAt: await readNextListDrainAt() },
      Date.now(),
    );
    if (hold.held) return "paced";

    // US-3061: CLAIM ONLY WHAT THIS BROWSER CAN START.
    //
    // This asked for five rows and started one. planDrain put the other four in
    // `skipped`, nothing in this file ever read `skipped`, and the server had
    // already stamped all five `claimed` - while `/claim` only ever reads rows
    // whose status is `queued`. So four rows in five were taken out of the queue
    // by a browser that never ran them and could never be handed them again:
    // they sat `claimed` until expires_at seven days later, and this function
    // returned "ok" the whole time. Measured on the local stack before the fix:
    // 8 seeded rows, 20 consecutive drains, 2 done and 6 stranded.
    //
    // ONE jobs snapshot feeds both the limit and the plan, so the two cannot
    // disagree about how many slots are free and `skipped` cannot come back.
    const jobs = await withJobs(async (j) => ({ value: j }));
    const limit = self.GT_LISTER_JOBS.drainClaimLimit(jobs);
    if (limit <= 0) return "busy";

    const claimed = await queueFetch("/claim", {
      method: "POST",
      body: JSON.stringify({ limit: limit, installId: await getInstanceId() }),
    });
    const rows = (claimed && claimed.claimed) || [];
    if (rows.length === 0) return "empty";

    const plan = self.GT_LISTER_JOBS.planDrain(rows, jobs, { now: Date.now() });
    const onAndroid = await isAndroidRuntime();

    // AC6: expired rows are REPORTED, never silently dropped. A seller who
    // believes a delist is still pending is a seller heading for a double sale.
    for (const row of plan.expired) {
      await completeQueueRow(row.id, {
        ok: false,
        result: {
          expired: true,
          error: "This waited longer than a week without your desktop browser " +
            "opening, so GradeThread stopped waiting. Queue it again if you " +
            "still want it run.",
        },
      });
    }

    // A kind this build cannot carry out is reported the same way an expired one
    // is, and for the same reason: a row nothing will ever pick up is
    // indistinguishable, from the phone, from a row about to run. Before this,
    // a share row was quietly turned into a LIST job and the seller got a
    // duplicate listing out of a request to share their closet.
    for (const row of plan.unsupported || []) {
      await completeQueueRow(row.id, {
        ok: false,
        result: {
          unsupported: true,
          error: "This version of the GradeThread extension can't run a \"" +
            row.kind + "\" job. Update the extension, or start it from the " +
            "extension's own window.",
        },
      });
    }

    for (let row of plan.toRun) {
      const url = self.GT_LISTER_GUARD.newListingUrlForLocale(
        self.GT_LISTER_SELECTORS,
        row.platform,
        row.payload && row.payload.locale,
      );
      // US-3369: a delist row goes through the same delistTargetFor an
      // interactive delist does — its link, or the seller's active-listings
      // page to search — and a refusal says why in words.
      const delistTarget = row.kind === "delist"
        ? self.GT_LISTER_GUARD.delistTargetFor(self.GT_LISTER_SELECTORS, row.platform, row.payload)
        : null;
      if (delistTarget && !delistTarget.url) {
        await completeQueueRow(row.id, {
          ok: false,
          result: { manual: true, error: delistRefusalFor(row.platform, delistTarget.reason) },
        });
        continue;
      }
      if (delistTarget) {
        row = Object.assign({}, row, {
          payload: Object.assign(delistJobPayload(row.payload || {}, delistTarget), {
            targetUrl: delistTarget.url,
          }),
        });
      }
      const target = row.kind === "delist"
        ? delistTarget.url
        : row.kind === "revise" || row.kind === "relist"
        ? (row.payload && row.payload.listingUrl)
        : url;
      // The same guard as an interactive job: a delist or revise URL must be
      // https and host-match its platform, and a list URL always comes from the
      // bundled config. A queue row is server-supplied, which makes it no more
      // trusted than a message from a page.
      const allowed = row.kind === "delist" || row.kind === "revise" || row.kind === "relist"
        ? self.GT_LISTER_GUARD.isAllowedDelistUrl(
            self.GT_LISTER_SELECTORS, row.platform, target,
          )
        : Boolean(target);
      if (!allowed) {
        await completeQueueRow(row.id, {
          ok: false,
          result: { error: "GradeThread can't open that target for " + row.platform + "." },
        });
        continue;
      }

      // US-3061: a phone runs the same content scripts against a different DOM.
      // A platform nobody has checked there is REFUSED with a sentence rather
      // than attempted, because a desktop selector that misses on mobile fills
      // nothing and reports a cross-post that never happened (US-2165).
      if (onAndroid && !self.GT_LISTER_GUARD.mobileFlowAllowed(self.GT_LISTER_SELECTORS, row.platform)) {
        await completeQueueRow(row.id, {
          ok: false,
          result: {
            mobileUnsupported: true,
            error: self.GT_LISTER_GUARD.mobileRefusalFor(self.GT_LISTER_SELECTORS, row.platform),
          },
        });
        continue;
      }

      let tab;
      try {
        // NOT focused: this is background work the seller did not just ask for.
        // Stealing focus from whatever they are doing would be the fastest way
        // to make them uninstall it.
        tab = await ext.tabs.create({ url: target, active: false });
      } catch (_e) {
        // US-3061: this said "try again on the next tick; the row stays claimed",
        // and it could not. The row IS claimed, and /claim only ever hands back
        // rows whose status is `queued` - so leaving it was leaving it for seven
        // days, showing as running on the seller's phone the whole time. A
        // window that will not open is reported, per US-2165.
        await completeQueueRow(row.id, {
          ok: false,
          result: {
            error: "GradeThread could not open a " + row.platform + " tab to run " +
              "this. Queue it again with fewer windows open.",
          },
        });
        continue;
      }
      // US-3061: record that WE opened this tab. Everything the worker is
      // allowed to do later — close it on completion, report it as stale, focus
      // it for a login wall — is gated on this list, so a Poshmark tab the
      // seller opened for their own reasons is never touched. Persisted because
      // the MV3 worker is evicted between alarms and would otherwise wake up
      // owning nothing.
      await rememberWorkerTab(tab.id);

      const job = self.GT_LISTER_JOBS.jobFromQueueRow(row, {
        jobId: makeJobId(),
        tabId: tab.id,
        now: Date.now(),
      });
      if (!job) {
        // planDrain already filtered these; belt and braces. The row is claimed
        // either way, so it is REPORTED rather than left - see the tabs.create
        // branch above for why "leave it claimed" is not a retry.
        await completeQueueRow(row.id, {
          ok: false,
          result: {
            error: "This version of the GradeThread extension can't run a \"" +
              row.kind + "\" job. Update the extension.",
          },
        });
        continue;
      }
      await withJobs(async (j) => ({ jobs: self.GT_LISTER_JOBS.put(j, job) }));
      await scheduleJobAlarm(job);
    }
    return "ok";
  } finally {
    drainInFlight = false;
  }
}

// Run it when the browser opens — the moment the whole feature is named after.
//
// US-3296 AC2 rides the same wake, and it is THE case this story is about: a
// browser closed on a Friday and opened five weeks later comes up with a dead
// token and, before this, nothing that would ever mint another one. The renewal
// is fired alongside the drain rather than before it — a drain on a lapsed
// token is a 401 the queue already handles, and the next five-minute sweep
// picks the work up with the fresh token.
if (ext.runtime.onStartup) {
  ext.runtime.onStartup.addListener(function () {
    void drainQueue();
    void renewTokenIfNeeded(false);
  });
}

// ── US-3061: the worker tab ───────────────────────────────────────────────
//
// A pinned GradeThread tab that drains the queue all day. The page holds a
// runtime port so this service worker is not evicted between ticks, and asks for
// a drain every 60 seconds through the same GT_QUEUE_RUN_NOW path the popup's
// "Run these now" uses. The 5-minute SWEEP_ALARM is untouched and stays the
// fallback for every seller who never opens the tab — see the drain-nudge test's
// rule 3, which is the same trap: an optimisation that quietly replaces the
// scheduler stops the feature for everyone who does not use the optimisation.
//
// THREE PIECES OF STATE LIVE HERE RATHER THAN ON THE PAGE, because the page can
// be closed and reopened and this worker cannot be the thing that forgets:
//   • the owned-tab list — which marketplace tabs the drain itself opened;
//   • the pause — set by a login wall or a human check, cleared only by the
//     seller pressing Resume;
//   • the autostart option, read by runtime.onStartup.
const WORKER_TABS_KEY = "gtWorkerTabs";
const WORKER_PAUSE_KEY = "gtWorkerPause";
const WORKER_AUTOSTART_KEY = "gtWorkerAutostart";
const WORKER_PAGE = "worker.html";

/** Live port(s) from open worker tabs. Cleared on disconnect. */
const workerPorts = new Set();

/**
 * US-3061: are we Firefox for Android?
 *
 * `runtime.getPlatformInfo()` is the only answer that is not a user-agent guess,
 * and the drain needs it because the same extension runs the same content
 * scripts against a different DOM on a phone. Cached for the life of the worker:
 * a browser does not change operating system.
 *
 * FAILS TO "not mobile". A desktop that could not answer must not start
 * refusing every job; a phone that could not answer gets the refusal from the
 * selector probe instead, one job later and with a worse message, which is the
 * cheaper of the two mistakes.
 */
let androidRuntime = null;

async function isAndroidRuntime() {
  if (androidRuntime !== null) return androidRuntime;
  try {
    const info = await ext.runtime.getPlatformInfo();
    androidRuntime = Boolean(info && info.os === "android");
  } catch (_e) {
    androidRuntime = false;
  }
  return androidRuntime;
}

async function readWorkerTabs() {
  const out = await ext.storage.local.get(WORKER_TABS_KEY);
  const list = out && out[WORKER_TABS_KEY];
  return Array.isArray(list) ? list : [];
}

async function rememberWorkerTab(tabId) {
  const next = self.GT_WORKER_STATE.addOwnedTab(await readWorkerTabs(), tabId);
  await ext.storage.local.set({ [WORKER_TABS_KEY]: next });
}

async function forgetWorkerTab(tabId) {
  const next = self.GT_WORKER_STATE.removeOwnedTab(await readWorkerTabs(), tabId);
  await ext.storage.local.set({ [WORKER_TABS_KEY]: next });
}

/**
 * Drop owned ids whose tab is gone.
 *
 * Not housekeeping. Tab ids are reused by the browser, so a list that only ever
 * grows will eventually contain an id belonging to a tab the SELLER opened —
 * and then ownership, the one check standing between this extension and typing
 * into someone's own Poshmark tab, starts answering yes when it should answer
 * no. This is the only place that check can fail open, so it runs before every
 * read that acts on the list.
 */
async function pruneWorkerTabs() {
  const owned = await readWorkerTabs();
  if (!owned.length) return owned;
  let openIds = [];
  try {
    const tabs = await ext.tabs.query({});
    openIds = (tabs || []).map((t) => t && t.id).filter((id) => typeof id === "number");
  } catch (_e) {
    // Cannot answer, so change nothing. Pruning against an empty list here would
    // disown every live job at once.
    return owned;
  }
  const next = self.GT_WORKER_STATE.pruneOwnedTabs(owned, openIds);
  if (next.length !== owned.length) await ext.storage.local.set({ [WORKER_TABS_KEY]: next });
  return next;
}

async function workerOwnsTab(tabId) {
  return self.GT_WORKER_STATE.ownsTab(await readWorkerTabs(), tabId);
}

async function readWorkerPause() {
  const out = await ext.storage.local.get(WORKER_PAUSE_KEY);
  const p = out && out[WORKER_PAUSE_KEY];
  return p && typeof p === "object" ? p : null;
}

async function workerPaused() {
  return Boolean(await readWorkerPause());
}

/**
 * A marketplace asked for a person. Record it, and let the page say so.
 *
 * `tabId` is stored so the worker page can offer "Open that tab" — the seller
 * cannot answer a check they cannot find, and a pinned tab telling them
 * something is waiting somewhere in a window of forty tabs is not an answer.
 * It is only ever a tab the drain itself opened.
 */
async function pauseWorker(notice, tabId) {
  const info = self.GT_WORKER_STATE.pauseFor(notice);
  if (!info) return null;
  const record = {
    reason: info.reason,
    platform: info.platform,
    tabId: typeof tabId === "number" ? tabId : null,
    at: new Date().toISOString(),
  };
  await ext.storage.local.set({ [WORKER_PAUSE_KEY]: record });
  return record;
}

/**
 * The seller says they dealt with it.
 *
 * NOTHING ELSE CALLS THIS. Not a timeout, not the next drain, not a page load.
 * A drain that resumed itself after a timer would be answering a human check by
 * waiting it out, and the marketplace on the other side sees a machine retrying
 * a challenge — the exact reading the ADR's §3.2 line exists to avoid.
 */
async function resumeWorker() {
  await ext.storage.local.remove(WORKER_PAUSE_KEY);
  return { ok: true };
}

/** Owned tabs still open well past their job's deadline. Reported, never closed. */
async function staleWorkerTabs() {
  const owned = await pruneWorkerTabs();
  if (!owned.length) return [];
  const jobs = await withJobs(async (j) => ({ value: j }));
  return self.GT_WORKER_STATE.staleTabs(jobs, owned, Date.now());
}

/**
 * Close a marketplace tab the drain opened, once its job is genuinely finished.
 *
 * TWO GUARDS, and both have a real failure behind them. The tab must be one we
 * opened (otherwise a recycled id closes the seller's own tab), and the job must
 * be one with nothing left for a human to do. A `list` job leaves a FILLED FORM
 * the seller still has to submit — US-1877 starts a watch on that very tab for
 * the live URL — so closing it would throw away the cross-post it just built.
 * Same for a `relist` copy. Delist and revise finish by themselves.
 */
const WORKER_CLOSABLE_KINDS = { delist: true, revise: true };

async function closeWorkerTabForJob(job, result) {
  if (!job || typeof job.tabId !== "number") return false;
  if (!WORKER_CLOSABLE_KINDS[job.kind]) return false;
  if (!result || result.ok !== true) return false;
  if (!(await workerOwnsTab(job.tabId))) return false;
  try {
    await ext.tabs.remove(job.tabId);
  } catch (_e) {
    // Already gone, or the browser refused. Forgetting it below is the whole fix.
  }
  await forgetWorkerTab(job.tabId);
  return true;
}

/**
 * Open the worker tab, pinned.
 *
 * ONLY from the popup, the options page or runtime.onStartup — never from a
 * content script, which is why worker.html is absent from
 * web_accessible_resources and why this lives behind a runtime message rather
 * than being a URL a page could navigate to.
 */
async function openWorkerTab() {
  const url = ext.runtime.getURL(WORKER_PAGE);
  try {
    const existing = await ext.tabs.query({ url: url });
    if (existing && existing.length) {
      await ext.tabs.update(existing[0].id, { active: true });
      return { ok: true, reused: true };
    }
  } catch (_e) { /* no tabs.query match support — fall through and open one */ }
  try {
    await ext.tabs.create({ url: url, pinned: true, active: true });
    return { ok: true, reused: false };
  } catch (_e) {
    return { ok: false };
  }
}

// The keep-alive. A connected port is what stops MV3 evicting this worker while
// the tab is open; the port carries no messages and is not meant to.
if (ext.runtime.onConnect) {
  ext.runtime.onConnect.addListener(function (p) {
    if (!p || p.name !== self.GT_WORKER_STATE.PORT_NAME) return;
    workerPorts.add(p);
    p.onDisconnect.addListener(function () { workerPorts.delete(p); });
  });
}

// A tab the drain opened has been closed, by the seller or by us. Drop it so the
// owned list cannot outlive the tab and be matched by a recycled id.
if (ext.tabs && ext.tabs.onRemoved) {
  ext.tabs.onRemoved.addListener(function (tabId) { void forgetWorkerTab(tabId); });
}

// Option, default OFF: reopen the pinned tab when the browser starts. Off by
// default because a tab that appears on its own is a thing people report as a
// hijack, however useful it is.
if (ext.runtime.onStartup) {
  ext.runtime.onStartup.addListener(function () {
    void (async () => {
      const out = await ext.storage.local.get(WORKER_AUTOSTART_KEY);
      if (out && out[WORKER_AUTOSTART_KEY] === true) await openWorkerTab();
    })();
  });
}

// ── US-3142: the push wake ────────────────────────────────────────────────
//
// The queue drains on a 5-minute alarm. That is fine for a seller who is away
// and slow for the one at their desk watching a listing they know is sold. A
// push from the server wakes this worker the moment the sale lands.
//
// WHAT THE PUSH CONTAINS: {"type":"gt-drain"}. No listing, no marketplace, no
// URL, no token. It is a signal to re-read a queue this extension already owns
// and already reads every five minutes with its own credentials. That is the
// whole reason it is safe for a server to be able to send it — the worst a
// forged or replayed push can do is make the drain happen early.
//
// BROWSER SUPPORT. Chromium only. Chrome has had the Push API in extension
// service workers since MV3, and silent pushes (userVisibleOnly:false) since
// Chrome 121 — without that this would have to show the seller a notification
// every time one of their items sold on another channel. Firefox exposes no
// Push API to a WebExtension background at all (bugzilla 1378096, blocked on
// MV3 background service workers), so a Firefox seller never subscribes, is
// never sent one, and keeps the alarm. Nothing in this file degrades on that
// path; there is simply no subscription.
//
// THE PERMISSION IS OPTIONAL, DELIBERATELY. `notifications` in `permissions`
// would show an install warning AND disable the extension for every existing
// user until they re-approved it. For a feature whose entire benefit is
// "sooner", that trade is not close. It sits in `optional_permissions` and the
// seller grants it from the popup.
const PUSH_SUB_KEY = "gtPushSubscription";

/** The one payload this worker acts on. Anything else is ignored. */
const PUSH_WAKE_TYPE = "gt-drain";

if (typeof self.addEventListener === "function") {
  self.addEventListener("push", function (event) {
    let type = "";
    try {
      // A push with no body, or a body that is not our JSON, is not ours.
      // Reading it defensively rather than optimistically matters here: this
      // handler is reachable by anyone who obtains the endpoint.
      type = (event.data && event.data.json && event.data.json().type) || "";
    } catch (_e) {
      type = "";
    }
    if (type !== PUSH_WAKE_TYPE) return;
    // waitUntil, or Chrome may suspend the worker mid-drain — the drain opens
    // tabs and awaits the claim, both of which outlive the event itself.
    if (event.waitUntil) event.waitUntil(drainQueue());
    else void drainQueue();
  });
}

/** base64url (what VAPID keys ship as) → the Uint8Array subscribe() wants. */
function vapidKeyToBytes(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function pushPermissionGranted() {
  try {
    if (!ext.permissions || !ext.permissions.contains) return false;
    return await ext.permissions.contains({ permissions: ["notifications"] });
  } catch (_e) {
    return false;
  }
}

/**
 * Subscribe (or re-subscribe) and register the subscription with GradeThread.
 *
 * Called after the seller grants the permission AND on every startup, because a
 * push service can rotate an endpoint at any time. Re-registering an unchanged
 * endpoint is an upsert on the server, so running it every start is cheap and
 * is the only thing that keeps a rotated endpoint from silently going dead.
 */
async function subscribeToWake() {
  if (!(await pushPermissionGranted())) return { ok: false, reason: "no-permission" };
  if (!self.registration || !self.registration.pushManager) {
    return { ok: false, reason: "unsupported" };
  }

  const keyResp = await queueFetch("/push-key");
  const key = keyResp && keyResp.key;
  // Push is not provisioned on this deploy. Not an error the seller caused, and
  // not one they can fix.
  if (!key) return { ok: false, reason: "unprovisioned" };

  let sub;
  try {
    sub = await self.registration.pushManager.getSubscription();
    if (!sub) {
      sub = await self.registration.pushManager.subscribe({
        // Chrome 121+. The wake is machinery, not a message — a notification
        // per sold cross-listing would be the seller's own success story
        // interrupting them.
        userVisibleOnly: false,
        applicationServerKey: vapidKeyToBytes(key),
      });
    }
  } catch (_e) {
    return { ok: false, reason: "subscribe-failed" };
  }

  const json = sub.toJSON ? sub.toJSON() : null;
  if (!json || !json.endpoint || !json.keys) return { ok: false, reason: "subscribe-failed" };

  const saved = await queueFetch("/push-subscription", {
    method: "POST",
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  if (!saved || saved.ok !== true) return { ok: false, reason: "register-failed" };

  await ext.storage.local.set({ [PUSH_SUB_KEY]: json.endpoint });
  return { ok: true };
}

/** Drop the subscription here and on the server. Idempotent. */
async function unsubscribeFromWake() {
  let endpoint = null;
  try {
    const sub = self.registration && self.registration.pushManager
      ? await self.registration.pushManager.getSubscription()
      : null;
    if (sub) {
      endpoint = sub.endpoint;
      await sub.unsubscribe();
    }
  } catch (_e) { /* already gone locally */ }

  if (!endpoint) {
    const stored = await ext.storage.local.get(PUSH_SUB_KEY);
    endpoint = stored[PUSH_SUB_KEY] || null;
  }
  // Server first-or-last does not matter; both are best-effort. What matters is
  // that a subscription we can no longer receive on stops being sent to, or the
  // server accumulates dead endpoints and counts their failures forever.
  if (endpoint) {
    await queueFetch("/push-subscription", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: endpoint }),
    });
  }
  await ext.storage.local.remove(PUSH_SUB_KEY);
  return { ok: true };
}

/** What the popup renders: granted, and whether we hold a live subscription. */
async function wakeState() {
  const granted = await pushPermissionGranted();
  let subscribed = false;
  try {
    subscribed = Boolean(
      self.registration && self.registration.pushManager &&
        (await self.registration.pushManager.getSubscription()),
    );
  } catch (_e) { /* treat as not subscribed */ }
  // `supported` is what lets the popup say "your browser cannot do this" rather
  // than offering a switch that will never work. Firefox lands here.
  return {
    supported: Boolean(self.registration && self.registration.pushManager),
    granted: granted,
    subscribed: subscribed,
  };
}

// Re-register on every start: a push service may have rotated the endpoint
// while the browser was closed, and a dead endpoint fails silently forever.
if (ext.runtime.onStartup) {
  ext.runtime.onStartup.addListener(function () { void subscribeToWake(); });
}

function handleListRequest(payload, sender, sendResponse, clientRef) {
  return startJob("list", payload, sender, sendResponse, clientRef);
}

function handleDelistRequest(payload, sender, sendResponse, clientRef) {
  // US-3369: a link when we have one, the active-listings page when we do not.
  const target = self.GT_LISTER_GUARD.delistTargetFor(
    self.GT_LISTER_SELECTORS,
    payload.platform,
    payload,
  );
  if (!target.url) {
    sendResponse({ ok: false, manual: true, error: delistRefusalFor(payload.platform, target.reason) });
    return;
  }
  return startJob(
    "delist",
    Object.assign(delistJobPayload(payload, target), { targetUrl: target.url }),
    sender,
    sendResponse,
    clientRef,
  );
}

// US-9202: the web's "Apply now" on a stale listing.
function handleReviseRequest(payload, sender, sendResponse, clientRef) {
  return startJob("revise", payload, sender, sendResponse, clientRef);
}

// US-9203: the web's Relist on an extension row.
function handleRelistRequest(payload, sender, sendResponse, clientRef) {
  return startJob("relist", payload, sender, sendResponse, clientRef);
}

// ── alarms: timeouts + the terminal-job sweep ─────────────────────────────
// Registration is GUARDED for the same reason onMessageExternal is below: reading
// .addListener off an undefined namespace throws at load and takes the ENTIRE
// worker with it — including buyer research, which has nothing to do with the
// Lister. `alarms` is declared in the manifest, but a Firefox/Edge build or an
// older host that didn't grant it must degrade to "no server-side timeout" rather
// than bricking the extension.
if (ext.alarms && ext.alarms.onAlarm) {
  ext.alarms.onAlarm.addListener(function (alarm) {
    // US-2701: the sold-sync poll shares the alarm surface rather than adding
    // a second scheduler. planPoll decides whether this tick does anything.
    if (alarm && alarm.name === SYNC_POLL_ALARM) {
      const now = Date.now();
      void reapSyncPollTab(now);
      void runSyncPollTick(now);
      return;
    }

    const name = (alarm && alarm.name) || "";

    if (name === SWEEP_ALARM) {
      withJobs(async (jobs) => ({ jobs: self.GT_LISTER_JOBS.sweep(jobs, Date.now()).jobs }));
      // US-1877: expired watches go with them — an abandoned tab must not capture
      // whatever the seller browses to an hour later.
      withWatches(async (w) => ({ watches: self.GT_LISTER_JOBS.sweepWatches(w, Date.now()) }));
      // US-2481: the same tick is also when we look for work queued from the
      // seller's phone. Riding the existing 5-minute sweep rather than adding an
      // alarm is deliberate — a browser left open all day should pick up a job
      // queued at lunchtime without the seller doing anything, and one more
      // periodic alarm for that would be a second thing to get wrong.
      void drainQueue();
      // US-3296: and the account token itself. It rides this tick for exactly
      // the reason above — a browser left open for weeks must not need the
      // seller to do anything — and it is cheap, because renewTokenIfNeeded
      // returns immediately unless the token is inside its renewal window.
      void renewTokenIfNeeded(false);
      // US-9202: and the edits FlipDesk is waiting to apply on extension
      // channels. One per tick, unfocused, gated like everything else.
      void drainPendingRevises();
      // US-3067 AC6: the ending-soon count rides this tick rather than adding an
      // alarm of its own, for the reason the comment above gives. A 5-minute tick
      // against a 10-minute window means the badge can be up to five minutes
      // late, which is the honest cost of not adding a second scheduler.
      void refreshWatchBadge();
      return;
    }

    // US-3367: the gap after a cross-post has passed.
    if (name === PACED_DRAIN_ALARM) {
      void drainQueue();
      return;
    }

    if (name.indexOf(JOB_ALARM_PREFIX) !== 0) return;
    const jobId = name.slice(JOB_ALARM_PREFIX.length);
    endJob(jobId, "timedOut", (job) =>
      self.GT_LISTER_JOBS.timeoutResultFor(job, SUPPORTED_LISTER[job.platform]),
    );
  });

  // Drops terminal jobs once their late-result grace window has passed. Periodic
  // (not per-job) so it costs one alarm total rather than one per job.
  try {
    ext.alarms.create(SWEEP_ALARM, { periodInMinutes: 5 });
    ext.alarms.create(SYNC_POLL_ALARM, { periodInMinutes: SYNC_POLL_TICK_MIN });
  } catch (_e) { /* jobs just linger until the session ends */ }
}

// ── Messages from the GradeThread SaaS ────────────────────────────────────
// Two transports reach this one handler:
//   • Chromium: externally_connectable → onMessageExternal (registered below).
//   • Firefox / any: the gradethread.com bridge content script (gt-bridge.js)
//     relays them as INTERNAL messages, routed here from onMessage.
// Either way the origin is re-checked against *.gradethread.com (defense in depth;
// the bridge path especially MUST verify sender.origin, since any content script
// could otherwise post an internal message).
const EXTERNAL_TYPES = new Set([
  "GT_PING",
  "GT_LISTER_PING",
  "GT_SET_TOKEN",
  "GT_CLEAR_TOKEN",
  "GT_LISTER_LIST",
  "GT_LISTER_DELIST",
  // US-9202: apply a FlipDesk edit to a live extension-channel listing.
  "GT_LISTER_REVISE",
  // US-9203: copy a live extension-channel listing into a fresh one.
  "GT_LISTER_RELIST",
  // US-2701: the Marketplaces page reads the scheduled poll's state, turns it
  // OFF, and changes its cadence.
  //
  // GT_POLL_ACCEPT IS DELIBERATELY ABSENT, and this is the load-bearing half.
  // The clickwrap's whole guarantee is that the sentences the seller accepted
  // came from the extension's own copy (sync/poll-plan.js). A web page that
  // could grant that consent would be a page granting consent to terms IT
  // rendered — which is the exact substitution the one-copy rule exists to
  // prevent. Turning something off, and slowing it down, need no such care:
  // both are strictly safer than the state they replace.
  "GT_WEB_POLL_STATE",
  "GT_WEB_POLL_REVOKE",
  "GT_WEB_POLL_INTERVAL",
  // US-9201: "Import my closet" on the web. The page cannot read a Poshmark
  // tab; it asks the extension, which reads the closet tab the seller already
  // has open and posts the result with its own token.
  "GT_CLOSET_IMPORT",
  // US-3143: "there is queued work — run it now rather than at the next tick."
  //
  // The message carries NOTHING. No listing, no URL, no platform, no job. It is
  // a nudge to re-read a queue the extension already owns with its own token,
  // which is what keeps it safe to accept from a page: the worst a forged one
  // can do is make the extension do, a few minutes early, exactly what the
  // 5-minute alarm was going to do anyway.
  "GT_DRAIN_NOW",
]);

function handleExternalMessage(msg, sender, sendResponse) {
  if (!self.GT_LISTER_GUARD.isOriginAllowed(sender)) {
    sendResponse({ ok: false, error: "Unauthorized origin." });
    return false;
  }
  if (!msg || typeof msg.type !== "string") {
    sendResponse({ ok: false, error: "Unknown message." });
    return false;
  }

  // Unified handshake — the SaaS detects the extension + reads what it can do.
  // US-2701: the Marketplaces page's view of the scheduled poll.
  //
  // Read, turn off, slow down. There is no GT_WEB_POLL_ACCEPT and there must not
  // be: the clickwrap's guarantee is that the sentences the seller accepted came
  // from the extension's own copy, and a page that could grant that consent
  // would be granting it to terms the page itself rendered.
  if (
    msg.type === "GT_WEB_POLL_STATE" ||
    msg.type === "GT_WEB_POLL_REVOKE" ||
    msg.type === "GT_WEB_POLL_INTERVAL"
  ) {
    (async () => {
      try {
        if (msg.type === "GT_WEB_POLL_REVOKE") {
          sendResponse(await revokePollClickwrap());
        } else if (msg.type === "GT_WEB_POLL_INTERVAL") {
          sendResponse(await setPollInterval(msg.minutes));
        } else {
          sendResponse({ ok: true, state: await pollConsentState() });
        }
      } catch (_e) {
        sendResponse({ ok: false, error: "Could not read the schedule." });
      }
    })();
    return true;
  }

  if (msg.type === "GT_PING" || msg.type === "GT_LISTER_PING") {
    (async () => {
      // US-3296: a ping from gradethread.com is the best renewal opportunity
      // there is — the seller is signed in, online, and looking at us. Try
      // first, so the capabilities below describe the connection as it is AFTER
      // the renewal rather than the dead one the ping arrived to find. Throttled
      // and never fatal: a failure just leaves the state it read.
      const token = await renewTokenIfNeeded(false);
      const caps = await getCapabilities(false);
      sendResponse({
        ok: true,
        installed: true,
        name: "GradeThread",
        unified: true,
        version: ext.runtime.getManifest().version,
        platforms: SUPPORTED_LISTER,
        capabilities: caps,
        // US-3296: the connection's own state and end date, so the Marketplaces
        // setup card can show when it runs out and say "reconnect" rather than
        // "connect" once it has. "none" | "active" | "expiring" | "expired".
        tokenStatus: token.state,
        tokenExpiresAt: token.expiresAtMs
          ? new Date(token.expiresAtMs).toISOString()
          : null,
        // US-2719: the four things the SaaS's cross-posting setup has to show,
        // in one round trip. The web page could already infer "installed" from
        // the bridge marker and "signed in" from capabilities.authenticated,
        // but it had no way at all to see whether the Lister clickwrap had been
        // accepted — so a seller who never accepted it got a setup screen that
        // said everything was ready and a send that failed with needsConsent.
        //
        // Reporting the flag is not the same as granting it. Acceptance still
        // happens only in the popup, from the extension's own copy of the terms
        // (see the GT_POLL_ACCEPT note above); this says whether it happened.
        tosAccepted: await tosAccepted(),
        // Which channels the seller's own build will actually run, rather than
        // which ones it will accept a job for. A channel whose selectors are
        // unverified reports "list manually", and the setup screen should not
        // count it as ready.
        channels: Object.keys(SUPPORTED_LISTER).map(function (key) {
          var cfg = (self.GT_LISTER_SELECTORS || {})[key] || {};
          return {
            platform: key,
            label: SUPPORTED_LISTER[key],
            canList: cfg.enabled === true,
            canDelist: cfg.enabled === true && !!(cfg.delist && cfg.delist.enabled),
          };
        }),
      });
    })();
    return true;
  }

  // US-1838 / US-1885: the buyer app hands the extension its signed token after
  // login so entitlements (quota + seller gate) become account-scoped. Storing it
  // invalidates the cache so the new plan reflects immediately.
  if (msg.type === "GT_SET_TOKEN") {
    (async () => {
      if (typeof msg.token !== "string" || !msg.token) {
        sendResponse({ ok: false, error: "No token." });
        return;
      }
      // US-3296: storeToken also writes the token's expiry, which is what every
      // later "is this still good?" question is answered from. Before this the
      // extension knew it had a token and had no idea when it died.
      await storeToken(msg.token);
      const caps = await getCapabilities(true);
      const token = await readTokenState(Date.now());
      sendResponse({
        ok: true,
        capabilities: caps,
        tokenStatus: token.state,
        tokenExpiresAt: token.expiresAtMs
          ? new Date(token.expiresAtMs).toISOString()
          : null,
      });
    })();
    return true;
  }

  if (msg.type === "GT_CLEAR_TOKEN") {
    (async () => {
      // US-3296: the expiry goes with the token. This is the ONE path that may
      // erase it — a signing-out seller really is back to "never connected".
      await ext.storage.local.remove(TOKEN_KEYS);
      await invalidateEntCache();
      await clearGradeCache();
      sendResponse({ ok: true, capabilities: await getCapabilities(true) });
    })();
    return true;
  }

  if (msg.type === "GT_CLOSET_IMPORT") {
    (async () => {
      try {
        sendResponse(await runClosetImport(msg));
      } catch (_e) {
        sendResponse({ ok: false, reason: "failed", error: "Could not read the closet." });
      }
    })();
    return true;
  }

  // US-3143: the seller has a GradeThread tab open and there is queued work.
  // Run the drain now instead of leaving it to the rest of the 5-minute tick.
  //
  // NOTHING IS TAKEN FROM THE MESSAGE. The handler reads no field of `msg`, so
  // there is no payload to validate and no way for a page to name a listing, a
  // platform or a URL. It calls the same drainQueue() the alarm calls, which
  // re-reads the queue with the extension's OWN token and applies its own gates.
  //
  // The floor below is not about correctness — drainInFlight already makes a
  // concurrent nudge harmless. It is about a page in a loop: without it, a bug
  // (or a hostile script on a gradethread.com page) turns every render into a
  // queue read. Thirty seconds is well under the 5-minute alarm it is speeding
  // up, so a real nudge is never the one that gets refused.
  if (msg.type === "GT_DRAIN_NOW") {
    (async () => {
      try {
        const now = Date.now();
        if (now - lastNudgedDrainAt < DRAIN_NUDGE_MIN_GAP_MS) {
          sendResponse({ ok: true, drained: false, state: "throttled" });
          return;
        }
        lastNudgedDrainAt = now;
        const state = await drainQueue();
        sendResponse({ ok: true, drained: state === "ok", state: state });
      } catch (_e) {
        // A failed drain is the alarm's problem in five minutes' time, not the
        // seller's problem now. Say so plainly rather than surfacing an error
        // for something they did not ask for.
        sendResponse({ ok: true, drained: false, state: "error" });
      }
    })();
    return true;
  }

  if (msg.type === "GT_LISTER_DELIST") {
    const dp = msg.payload;
    if (!isValidDelistPayload(dp)) {
      sendResponse({ ok: false, error: "Invalid or unsupported delist payload." });
      return false;
    }
    handleDelistRequest(dp, sender, sendResponse, msg.clientRef);
    return true;
  }

  if (msg.type === "GT_LISTER_REVISE") {
    const rp = msg.payload;
    if (!isValidRevisePayload(rp)) {
      sendResponse({ ok: false, error: "Invalid or unsupported revise payload." });
      return false;
    }
    handleReviseRequest(rp, sender, sendResponse, msg.clientRef);
    return true;
  }

  if (msg.type === "GT_LISTER_RELIST") {
    const lp = msg.payload;
    if (!isValidRelistPayload(lp)) {
      sendResponse({ ok: false, error: "Invalid or unsupported relist payload." });
      return false;
    }
    handleRelistRequest(lp, sender, sendResponse, msg.clientRef);
    return true;
  }

  if (msg.type === "GT_LISTER_LIST") {
    const payload = msg.payload;
    if (!isValidPayload(payload)) {
      sendResponse({ ok: false, error: "Invalid or unsupported listing payload." });
      return false;
    }
    handleListRequest(payload, sender, sendResponse, msg.clientRef);
    return true;
  }

  sendResponse({ ok: false, error: "Unknown message type." });
  return false;
}

// Chromium only — Firefox has no externally_connectable / onMessageExternal, so
// guard the registration (accessing .addListener on undefined would throw and
// abort the whole worker/event-page load). Firefox reaches handleExternalMessage
// via the bridge path in onMessage below.
if (ext.runtime.onMessageExternal) {
  ext.runtime.onMessageExternal.addListener(handleExternalMessage);
}

// ── Internal messages from content scripts + popup ────────────────────────
ext.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string") {
    sendResponse(null);
    return false;
  }

  // Bridge path (US-1882): the gradethread.com bridge content script relays SaaS
  // messages here as internal messages. handleExternalMessage re-verifies the
  // sender origin (gradethread.com) before acting.
  if (EXTERNAL_TYPES.has(msg.type)) {
    return handleExternalMessage(msg, sender, sendResponse);
  }

  if (msg.type === "GT_LISTER_LOG") {

    console.debug("[GradeThread Lister][content]", msg.message);
    return false;
  }

  // ── US-3142: the popup's instant-delist switch ───────────────────────────
  //
  // INTERNAL ONLY, and not in EXTERNAL_TYPES. Two reasons, and the second is
  // the one that matters:
  //
  //   1. chrome.permissions.request() needs a user gesture, which a message
  //      from a web page does not carry. The popup asks; this only acts after.
  //   2. The same rule the poll clickwrap follows (see GT_POLL_ACCEPT's absence
  //      above): a permission the seller grants must be granted to the
  //      extension's own words in the extension's own surface, never to a
  //      sentence gradethread.com rendered.
  if (
    msg.type === "GT_WAKE_STATE" ||
    msg.type === "GT_WAKE_ENABLE" ||
    msg.type === "GT_WAKE_DISABLE"
  ) {
    (async () => {
      try {
        if (msg.type === "GT_WAKE_ENABLE") {
          const res = await subscribeToWake();
          sendResponse({ ok: res.ok, reason: res.reason, state: await wakeState() });
        } else if (msg.type === "GT_WAKE_DISABLE") {
          await unsubscribeFromWake();
          sendResponse({ ok: true, state: await wakeState() });
        } else {
          sendResponse({ ok: true, state: await wakeState() });
        }
      } catch (_e) {
        sendResponse({ ok: false, reason: "error" });
      }
    })();
    return true;
  }

  // ── US-2482: Poshmark engagement (share / follow / send offer) ───────────
  //
  // The worker owns storage and therefore owns the caps, the counters and the
  // consent record. The content script owns the DOM. That split is the whole
  // safety design: a marketplace page cannot raise a cap or forge a consent,
  // because it never holds either — it asks, per action, and is told yes or no.
  if (msg.type === "GT_ENGAGE_GATE") {
    (async () => {
      const state = await readEngageState();
      const decision = self.GT_ENGAGE.gate({
        action: msg.action,
        sellerAllowed: await sellerAllowed(),
        clickwrap: state.clickwrap,
        settings: state.settings,
        counters: state.counters,
        now: Date.now(),
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        humanCheck: msg.humanCheck === true,
      });
      // The pacing delay rides along with the decision so the page never holds
      // the floor. A content script that computed its own delay could be made to
      // compute zero.
      sendResponse(
        decision.ok
          ? Object.assign({}, decision, {
              nextDelayMs: self.GT_ENGAGE.nextDelayMs(state.settings),
            })
          : decision,
      );
    })();
    return true;
  }

  if (msg.type === "GT_ENGAGE_RECORD") {
    (async () => {
      const state = await readEngageState();
      const counters = self.GT_ENGAGE.recordAction(state.counters, msg.action, msg.count);
      await ext.storage.local.set({ engageCounters: counters });
      sendResponse({ ok: true, meter: self.GT_ENGAGE.meter(counters, state.settings, msg.action) });
    })();
    return true;
  }

  if (msg.type === "GT_ENGAGE_STATE") {
    (async () => {
      const state = await readEngageState();
      const out = await ext.storage.local.get(["engageRun", "engageLastRun"]);
      // A run whose tab is gone is not a run. Without this the record outlives
      // the closet tab, the popup shows Stop with nothing behind it, and Start
      // stays hidden — the seller's next run is blocked by a run that ended.
      if (out && out.engageRun && typeof out.engageRun.tabId === "number") {
        let alive = false;
        try {
          alive = Boolean(await ext.tabs.get(out.engageRun.tabId));
        } catch (_e) { /* closed */ }
        if (!alive) {
          await ext.storage.local.remove("engageRun");
          out.engageRun = null;
        }
      }
      sendResponse({
        ok: true,
        accepted: self.GT_ENGAGE.isClickwrapAccepted(state.clickwrap),
        clickwrapVersion: self.GT_ENGAGE.CLICKWRAP_VERSION,
        terms: self.GT_ENGAGE.CLICKWRAP_TERMS,
        settings: state.settings,
        counters: state.counters,
        meter: self.GT_ENGAGE.meter(state.counters, state.settings, "share"),
        sellerAllowed: await sellerAllowed(),
        // The popup renders these; it does not own them. A popup that kept its
        // own idea of "a run is going" would keep showing Stop after the tab
        // that was running closed.
        run: (out && out.engageRun) || null,
        lastRun: (out && out.engageLastRun) || null,
        engageEnabled: Boolean(
          self.GT_LISTER_SELECTORS.poshmark &&
          self.GT_LISTER_SELECTORS.poshmark.engage &&
          self.GT_LISTER_SELECTORS.poshmark.engage.enabled,
        ),
      });
    })();
    return true;
  }

  // ── The run trigger (US-2482 AC1) ────────────────────────────────────────
  //
  // The seller presses Start in the popup; this is what turns that into work.
  // The order matters: entitlement, then consent, then the tab, then the cap.
  // Every one of those refusals is a sentence the seller can act on, which is
  // the difference between "nothing happened" and "you are on the wrong page".
  //
  // The tab check is here rather than in the popup because this is where the
  // rest of the enforcement lives. A run is only ever sent to a tab whose URL
  // matches the closet pattern in the bundled selectors — never to a URL that
  // arrived in a message (US-1876).
  if (msg.type === "GT_ENGAGE_START") {
    (async () => {
      try {
        const action = msg.action === "follow" || msg.action === "offer" ? msg.action : "share";
        const state = await readEngageState();
        const decision = self.GT_ENGAGE.gate({
          action: action,
          sellerAllowed: await sellerAllowed(),
          clickwrap: state.clickwrap,
          settings: state.settings,
          counters: state.counters,
          now: Date.now(),
          tzOffsetMinutes: new Date().getTimezoneOffset(),
          humanCheck: false,
        });
        if (!decision.ok) {
          sendResponse({ ok: false, reason: decision.reason, error: decision.message });
          return;
        }

        const cfg = self.GT_LISTER_SELECTORS.poshmark && self.GT_LISTER_SELECTORS.poshmark.engage;
        if (!cfg || !cfg.enabled) {
          sendResponse({
            ok: false,
            reason: "disabled",
            error: "Poshmark sharing isn't switched on in this build yet.",
          });
          return;
        }

        const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
        const closetRe = new RegExp(cfg.closetUrlPattern);
        if (!tab || !tab.url || !closetRe.test(tab.url)) {
          sendResponse({
            ok: false,
            reason: "wrong_tab",
            error: "Open your Poshmark closet in this tab first, then press Start.",
          });
          return;
        }

        const runId = (crypto.randomUUID && crypto.randomUUID()) ||
          "run-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const run = {
          runId: runId,
          action: action,
          // Only read for offers. The rule lives in GT_ENGAGE.offerPrice
          // (US-2739): whole dollars, never below one, and NULL when there is
          // no usable price so the refusal below can fire. The clamp used to be
          // written out here as Math.max(1, Math.floor(...)), which turned an
          // empty price box into the number 1 - truthy - so the refusal never
          // fired and a $1 offer went to every liker in the closet.
          offerPrice: action === "offer" ? self.GT_ENGAGE.offerPrice(msg.offerPrice) : null,
          tabId: tab.id,
          startedAt: new Date().toISOString(),
        };
        if (action === "offer" && !run.offerPrice) {
          sendResponse({ ok: false, reason: "no_price", error: "Enter the offer price first." });
          return;
        }

        let started = null;
        try {
          started = await ext.tabs.sendMessage(tab.id, { type: "GT_ENGAGE_RUN", run: run });
        } catch (_e) { /* handled below */ }
        if (!started || started.ok !== true) {
          sendResponse({
            ok: false,
            reason: (started && started.reason) || "no_content_script",
            error: started && started.reason === "already_running"
              ? "A run is already going in that tab."
              : "Reload your closet tab and try again — the extension updated since it opened.",
          });
          return;
        }

        await ext.storage.local.set({ engageRun: run });
        sendResponse({ ok: true, run: run });
      } catch (e) {
        sendResponse({ ok: false, reason: "error", error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "GT_ENGAGE_STOP") {
    (async () => {
      const out = await ext.storage.local.get("engageRun");
      const run = out && out.engageRun;
      if (run && typeof run.tabId === "number") {
        try {
          await ext.tabs.sendMessage(run.tabId, { type: "GT_ENGAGE_STOP", runId: run.runId });
        } catch (_e) { /* tab gone — clearing the record below is the whole fix */ }
      }
      // Cleared either way. If the tab is gone there is nothing left to stop,
      // and leaving the record would show Stop forever with nothing behind it.
      await ext.storage.local.remove("engageRun");
      sendResponse({ ok: true });
    })();
    return true;
  }

  // A run reports twice: a NOTICE when it pauses and needs the seller (login
  // wall, human check), and a RESULT when it ends. Both used to be sent into a
  // void — the content script posted them and nothing listened, so a paused run
  // looked identical to a finished one from anywhere but the tab itself.
  if (msg.type === "GT_ENGAGE_NOTICE") {
    (async () => {
      await ext.storage.local.set({
        engageLastRun: Object.assign(
          { runId: msg.runId, at: new Date().toISOString(), paused: true },
          msg.notice || {},
        ),
      });
      // US-3061: a human check pauses the worker tab's drain too. It is the same
      // browser and the same marketplace account — a share run stopped by a
      // challenge while the drain kept opening listing tabs would be this
      // extension answering "is a person here?" with more automation.
      // pauseFor ignores a notice that is not a check, so the login-wall and
      // signed-out shapes fall through.
      await pauseWorker(msg.notice, null);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "GT_ENGAGE_RESULT") {
    (async () => {
      await ext.storage.local.set({
        engageLastRun: Object.assign(
          { runId: msg.runId, at: new Date().toISOString(), paused: false },
          msg.result || {},
        ),
      });
      await ext.storage.local.remove("engageRun");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "GT_ENGAGE_ACCEPT") {
    (async () => {
      await ext.storage.local.set({
        engageClickwrap: self.GT_ENGAGE.acceptClickwrap(new Date().toISOString()),
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "GT_ENGAGE_REVOKE") {
    (async () => {
      await ext.storage.local.remove("engageClickwrap");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "GT_ENGAGE_SETTINGS") {
    (async () => {
      // Clamped on the way IN as well as on every read. Storing an unclamped
      // value would leave a number in storage that looks like a granted request.
      //
      // MERGED over what is stored, because callers send one field. Clamping a
      // bare { pacingFloorMs } would silently reset the three caps to defaults —
      // the pace control quietly undoing a cap the seller had set.
      const current = await readEngageState();
      const settings = self.GT_ENGAGE.clampSettings(
        Object.assign({}, current.settings, msg.settings || {}),
      );
      await ext.storage.local.set({ engageSettings: settings });
      sendResponse({ ok: true, settings: settings });
    })();
    return true;
  }

  // AC1: served from storage.session, so a content script that asks AFTER the
  // worker was suspended and respawned still gets its job and the fill still runs.
  // This is the read that used to return null (job map lost with the worker) and
  // silently abandon the cross-post. Now async — hence the `true` return.
  if (msg.type === "GT_LISTER_GET_JOB") {
    (async () => {
      const tabId = sender.tab && sender.tab.id;
      const job = await withJobs(async (jobs) => ({
        value: self.GT_LISTER_JOBS.findByTab(jobs, typeof tabId === "number" ? tabId : -1),
      }));
      sendResponse(job || null);
    })();
    return true;
  }

  // US-1875 AC3: a NON-TERMINAL job notice (currently: a login wall). It reports
  // to the seller WITHOUT ending the job — the content script deliberately sends
  // no GT_LISTER_RESULT, because the work is still pending and will run once they
  // log in and the target page re-injects. It also pushes the deadline out, since
  // signing in takes longer than the job timeout that would otherwise kill it.
  if (msg.type === "GT_LISTER_NOTICE") {
    (async () => {
      const job = await withJobs(async (jobs) => ({
        value: self.GT_LISTER_JOBS.findById(jobs, msg.jobId),
      }));
      if (!job || !self.GT_LISTER_JOBS.isPending(job)) {
        sendResponse({ ok: true });
        return;
      }
      const extended = await withJobs(async (jobs) => {
        const r = self.GT_LISTER_JOBS.extendDeadline(
          jobs,
          msg.jobId,
          Date.now() + self.GT_LISTER_JOBS.LOGIN_WALL_GRACE_MS,
        );
        return { jobs: r.jobs, value: r.job };
      });
      if (extended) await scheduleJobAlarm(extended);
      // Non-terminal by construction: pushed to the SaaS tab so the seller sees
      // "log in and retry", but pendingExternal is left untouched so the promise
      // stays open for the real outcome.
      const notice = Object.assign({ ok: false, pending: true }, msg.notice);
      await pushToSaasTab(job, notice);
      // US-1885 AC1: a login wall is real, actionable job state ("waiting for you
      // to sign in") — the seller opening the popup to ask why nothing happened is
      // exactly the case this exists for. Recorded as pending, so the terminal
      // outcome overwrites it once the job actually finishes.
      await writeLastJob(job, notice);
      // US-3061: a login wall stops the WORKER TAB's drain, not just this job.
      // The next queued row is for the same seller on the same marketplace, so
      // draining on would open a second tab onto the same login page — two tabs
      // asking them to sign in, from software that is meant to be working
      // quietly. pauseWorker ignores a notice that is not a pause, so the other
      // GT_LISTER_NOTICE shapes fall through untouched.
      await pauseWorker(msg.notice, job.tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // US-2486: a multi-page job has followed a link and is continuing on the far
  // page. Like GT_LISTER_NOTICE this is deliberately NON-TERMINAL — no result is
  // sent, the job stays pending, and the content script that loads next picks it
  // up already knowing it has navigated.
  //
  // The deadline moves out for the same reason it does on a login wall: a page
  // load costs seconds the original job timeout never budgeted for, and killing
  // the job mid-navigation would report a failure for work still in flight.
  if (msg.type === "GT_LISTER_STAGE") {
    (async () => {
      const staged = await withJobs(async (jobs) => {
        const r = self.GT_LISTER_JOBS.advanceStage(jobs, msg.jobId, msg.stage, Date.now());
        if (!r.job) return { jobs: r.jobs, value: null };
        const e = self.GT_LISTER_JOBS.extendDeadline(
          r.jobs,
          msg.jobId,
          Date.now() + NAVIGATION_GRACE_MS,
        );
        return { jobs: e.jobs, value: e.job || r.job };
      });
      if (staged) await scheduleJobAlarm(staged);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "GT_LISTER_RESULT") {
    (async () => {
      const out = Object.assign({}, msg);
      delete out.type;
      delete out.jobId;

      const job = await withJobs(async (jobs) => ({
        value: self.GT_LISTER_JOBS.findById(jobs, msg.jobId),
      }));
      if (!job) {
        sendResponse({ ok: true });
        return;
      }

      if (self.GT_LISTER_JOBS.isPending(job)) {
        await withJobs(async (jobs) => ({
          jobs: self.GT_LISTER_JOBS.markTerminal(jobs, job.jobId, "done", Date.now()).jobs,
        }));
        await clearJobAlarm(job.jobId);
        await reportJob(job, out);
        // US-1877 (AC1): a FILL is not a publish — the seller still has to submit.
        // Start watching this tab for the live listing URL that submitting produces.
        // Only for a fill: a delist has no listing to capture, and a failed fill has
        // no form for the seller to submit.
        if (job.kind === "list" && out.ok && out.filled) await startListedWatch(job);
        // US-9203: the copy's form is open; the live-URL watch records the
        // new listing when the seller posts it.
        if (job.kind === "relist" && out.ok && out.copied) await startListedWatch(job);
        // US-3061: a delist or revise the worker opened has nothing left for a
        // human to do, so its tab closes itself. A `list` or `relist` tab is
        // left open on purpose — it holds a filled form the seller still has to
        // submit, and the watch above is reading that very tab.
        await closeWorkerTabForJob(job, out);
      } else {
        // AC4: the job already went terminal (we timed out, or the tab closed) and
        // the fill finished anyway. Report it as a LATE result rather than dropping
        // it — the seller needs to know the listing actually got created, or they
        // will post it a second time. This is why terminal jobs are kept for a
        // grace window instead of deleted.
        await pushToSaasTab(job, Object.assign({}, out, { late: true }));
        await withJobs(async (jobs) => ({
          jobs: self.GT_LISTER_JOBS.remove(jobs, job.jobId),
        }));
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Research + popup: async handlers.
  (async () => {
    switch (msg.type) {
      case "GT_CC_GET_CONFIG":
        sendResponse(await getRemoteConfig());
        break;
      case "GT_CC_GET_SETTINGS":
        sendResponse(await getSettings());
        break;
      case "GT_CC_GRADE": {
        const out = await gradeFromUrls(msg);
        // Warm the per-listing recall cache so a return visit shows the same grade.
        if (out && out.ok && out.data && msg.listingKey) {
          await writeGradeCache(msg.listingKey, out.data);
        }
        sendResponse(out);
        break;
      }
      // US-2237: the search-grid triage scan. Deliberately NOT cached — a grid
      // changes with every filter, sort and scroll, and a stale badge on a card
      // that is now a different listing is worse than no badge.
      case "GT_CC_SCAN":
        sendResponse(await scanCards(msg));
        break;
      // US-3060: which of these listings has a certificate. Not cached, for the
      // same reason the scan is not: a grid changes with every filter and sort,
      // and a badge on a card that is now a different listing is worse than no
      // badge. The content script's own 60-second gate is what stops this being
      // a request per scroll.
      case "GT_CC_LISTING_CERTS":
        sendResponse(await listingCertificates(msg));
        break;
      // US-3068: what the evidence pack would say for one return. A READ. The
      // send stays on the FlipDesk post-sale surface behind the seller's own
      // click, and nothing in this path touches eBay.
      case "GT_RETURN_PACK":
        sendResponse(await returnShieldPack(msg));
        break;
      // US-3067 AC5: the watch list. Three reads and writes against
      // storage.local and NOTHING ELSE — no fetch, no tab opened, no bid. The
      // whole surface is deliberately this small: every richer version of
      // "watch this lot" is an extension that acts on an auction unattended.
      case "GT_WATCH_ADD": {
        const map = WATCH.watchAdd(await readWatched(), msg.lot || {}, Date.now());
        const ok = await writeWatched(map);
        await refreshWatchBadge();
        sendResponse({ ok, lots: WATCH.watchList(map, Date.now()) });
        break;
      }
      case "GT_WATCH_REMOVE": {
        const map = WATCH.watchRemove(await readWatched(), msg.itemId);
        const ok = await writeWatched(map);
        await refreshWatchBadge();
        sendResponse({ ok, lots: WATCH.watchList(map, Date.now()) });
        break;
      }
      case "GT_WATCH_LIST":
        sendResponse({ ok: true, lots: WATCH.watchList(await readWatched(), Date.now()) });
        break;
      // US-2238: flip mode. Not cached — the seller can re-price or the comps can
      // move, and a stale ROI is the one number they'd act on.
      case "GT_CC_APPRAISE":
        sendResponse(await appraiseListing(msg));
        break;
      // US-1808: check this listing against the buyer's saved searches. Not
      // cached, and deliberately not folded into the read: it spends a metered
      // buyer action and writes a row on the buyer's account, so it happens only
      // when they ask for it.
      case "GT_CC_INGEST":
        sendResponse(await ingestListing(msg));
        break;
      // US-2698: a passive sold-sync read from the seller's own Poshmark pages.
      // Nothing here decides what sold; the server does.
      case "GT_SYNC_OBSERVE": {
        const out = await postSyncObservations(msg);
        // If this read came from a polled tab, it is also the poll's result.
        void notePollResult(msg && msg.batch);
        sendResponse(out);
        break;
      }
      // A marketplace asked the reader to prove it is a person. Nothing was
      // read and nothing is posted; this exists only so RULE 5 has something to
      // fire on. Without it the poll reopens a challenged page every interval,
      // because the content script returns before it reports anything.
      case "GT_SYNC_HUMAN_CHECK":
        await notePollResult({ platform: msg && msg.platform, humanCheck: true });
        // US-3061: same browser, same account, same challenge. The sold-sync
        // poll and the drain both stop until the seller says they cleared it.
        await pauseWorker({ humanCheck: true, platform: msg && msg.platform }, null);
        sendResponse({ ok: true });
        break;
      // US-2699: what the popup renders. Same projection as the web.
      case "GT_SYNC_STATUS":
        sendResponse(await fetchSyncStatus());
        break;
      // US-2701: the scheduled poll's own consent.
      case "GT_POLL_STATE":
        sendResponse(await pollConsentState());
        break;
      case "GT_POLL_ACCEPT":
        sendResponse(await acceptPollClickwrap());
        break;
      case "GT_POLL_REVOKE":
        sendResponse(await revokePollClickwrap());
        break;
      case "GT_POLL_INTERVAL":
        sendResponse(await setPollInterval(msg && msg.minutes));
        break;
      case "GT_POLL_RESUME":
        sendResponse(await resumePollChannel(msg && msg.platform));
        break;
      case "GT_CC_GET_CACHED":
        sendResponse(await readGradeCache(msg.listingKey));
        break;
      // US-2239: buyer-private seller pattern. Returns null below the 2-read
      // floor — one read of one item is a coincidence, not a pattern.
      // US-2240: the compare tray. Pinning replays the payload the endpoint
      // already returned, so it spends no quota and makes no request — the
      // worker is involved only because storage.local lives here.
      case "GT_CC_TRAY_PIN":
        sendResponse(await pinToTray(msg.entry));
        break;
      // Opened here rather than linked from the content script — see the comment
      // at the call site: a link would require web_accessible_resources.
      case "GT_CC_TRAY_OPEN":
        try {
          await ext.tabs.create({ url: ext.runtime.getURL("compare.html") });
          sendResponse({ ok: true });
        } catch (_e) {
          sendResponse({ ok: false });
        }
        break;
      case "GT_CC_GET_SELLER":
        sendResponse(await getSellerHistory(msg.marketplace, msg.seller));
        break;
      case "GT_CC_SAVE_READ":
        await saveRead(msg.read);
        // US-1757 AC2: the read half of the funnel. Counted HERE rather than in
        // the content script because this is the one message every completed
        // read already goes through — a second call site next to it would drift
        // the moment a new read surface is added.
        recordUsage("read");
        // US-2241: the badge follows the read that produced it, on the tab it
        // came from. sender.tab is the authority — a tab id from the message
        // body would let any content script badge any tab.
        await setScoreBadge(sender.tab && sender.tab.id, msg.read && msg.read.overallScore);
        sendResponse({ ok: true });
        break;
      // Cleared by the content script when it navigates away, so a badge never
      // outlives the listing it describes.
      case "GT_CC_CLEAR_BADGE":
        await setScoreBadge(sender.tab && sender.tab.id, null);
        sendResponse({ ok: true });
        break;
      // US-1880 (AC3): an adapter found nothing. Respond immediately and let the
      // post fly on its own — the content script has already rendered the honest
      // degrade state and must not wait on telemetry.
      case "GT_CC_SELECTOR_MISS":
        sendResponse({ ok: true });
        reportSelectorMiss(msg);
        break;
      // US-1757 (AC2): a click-through to gradethread.com from the popup, the
      // overlay or the onboarding page. Respond immediately — the browser is
      // already navigating and must not wait on a counter. The EVENT and SURFACE
      // are validated against the closed vocabulary inside recordUsage's
      // GT_USAGE.record, so a message cannot invent a counter.
      case "GT_CC_USAGE":
        sendResponse({ ok: true });
        recordUsage(msg.event, msg.surface);
        break;
      // US-1885 (AC1): the popup's pending-delist queue.
      case "GT_GET_PENDING_DELISTS":
        sendResponse(await getPendingDelists());
        break;
      // US-9202: the popup's "Needs updating" count.
      case "GT_GET_PENDING_REVISES":
        sendResponse(await getPendingRevises());
        break;
      // ── US-3062: the side panel ──────────────────────────────────────
      //
      // INTERNAL ONLY, deliberately absent from EXTERNAL_TYPES. The panel is
      // our own page; a web page asking "what item is in that tab" would be
      // asking about a tab it does not own.
      case "GT_PANEL_SUPPORTED":
        sendResponse({
          ok: true,
          supported: self.GT_PANEL_HOST.isPanelHost(
            msg.url,
            self.GT_LISTER_SELECTORS,
          ),
        });
        break;
      // The item the seller is listing in this tab, if we know of one.
      //
      // "If we know of one" is the whole contract, and the answer is allowed to
      // be nothing. It comes from the job that is running or last completed in
      // that tab — a fact the extension already has — and NOT from reading the
      // page. Reading the marketplace page to guess the item would be the exact
      // thing US-3042 removed from the eBay path.
      case "GT_PANEL_ITEM":
        sendResponse(await getPanelItem(msg.tabId, msg.url));
        break;
      // ── US-3048: the cross-listing queue ─────────────────────────────
      case "GT_QUEUE_STATE":
        sendResponse(await getQueue());
        break;
      case "GT_QUEUE_CANCEL":
        sendResponse(await cancelQueueRow(msg.id));
        break;
      case "GT_QUEUE_RETRY":
        sendResponse(await retryQueueRow(msg.id, msg.body));
        break;
      // US-3050: where each drained job has got to, keyed by the queue row it
      // came from, so a claimed row can say "Attaching photos" rather than
      // "Running now" for eleven minutes. Pending jobs only — a terminal job's
      // outcome reaches the popup through listerLastJob and the queue itself.
      case "GT_QUEUE_JOBS":
        sendResponse(await getQueueJobStages());
        break;
      // "Run now". The drain already runs on startup and on the five-minute
      // sweep; this is the seller saying "I am at the machine, go" instead of
      // waiting out a tick they cannot see. It is not a second scheduler and
      // holds no state — drainInFlight is what stops a double-tap from
      // claiming the same rows twice, and the same seller gates apply, so a
      // lapsed plan or an unaccepted clickwrap refuses here exactly as it does
      // on the alarm path.
      case "GT_QUEUE_RUN_NOW": {
        // US-3061: the drain's own outcome code is passed back. The popup
        // ignores it; the worker tab needs it, because "empty" and "your plan
        // lapsed" produce the same silence from a page that just asked for a
        // drain, and the second one has to be sayable.
        const drained = await drainQueue();
        sendResponse({ ok: true, state: drained });
        break;
      }
      // ── US-3061: the worker tab ──────────────────────────────────────
      // What the page cannot know for itself: whether a marketplace has asked
      // for a person, and which of its own tabs have outlived their deadline.
      case "GT_WORKER_STATE":
        sendResponse({
          ok: true,
          pause: await readWorkerPause(),
          staleTabs: await staleWorkerTabs(),
          // US-3061: results this browser holds because the server has not taken
          // them. Reported, because a page that says "last check 12:04, next in
          // 60s" over a backlog of unrecorded work is making the unchecked claim
          // the ledger was written to stop.
          unsentResults: await withUnsentResults(async (store) => ({
            value: self.GT_WORKER_STATE.unsentResultCount(store),
          })),
          // US-3367: when the gap after the last cross-post ends, so the page
          // can say "next cross-post in Ns" instead of a countdown to a drain
          // that will return "paced".
          pacedUntil: await readNextListDrainAt(),
        });
        break;
      // The seller says they answered the check. The ONLY thing that clears a
      // pause; see resumeWorker.
      case "GT_WORKER_RESUME":
        sendResponse(await resumeWorker());
        break;
      // Focus the tab that is waiting on them. Refused for any tab the drain did
      // not open, so a tab id in a message can never make this extension surface
      // an arbitrary page as GradeThread's own work.
      case "GT_WORKER_FOCUS": {
        const owns = await workerOwnsTab(msg.tabId);
        if (!owns) {
          sendResponse({ ok: false, reason: "not-ours" });
          break;
        }
        try {
          await ext.tabs.update(msg.tabId, { active: true });
          sendResponse({ ok: true });
        } catch (_e) {
          sendResponse({ ok: false, reason: "gone" });
        }
        break;
      }
      // "Keep GradeThread working" in the popup, and the options page's link.
      // Never reachable from a content script: worker.html is not a
      // web-accessible resource, so a page cannot navigate to it, and this
      // handler is the only other way in.
      case "GT_WORKER_OPEN":
        sendResponse(await openWorkerTab());
        break;
      // The popup's own "Get condition read" button. Routed through here rather
      // than sent straight from the popup so there is ONE path to the overlay —
      // the same message the Alt+G command and the image context menu send, so
      // a listing read from the popup lands in the same overlay, under the same
      // epoch guard, as one read any other way.
      case "GT_CC_RUN_ACTIVE": {
        let started = false;
        try {
          const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
          if (tab && typeof tab.id === "number") {
            await ext.tabs.sendMessage(tab.id, { type: "GT_CC_RUN" });
            started = true;
          }
        } catch (_e) {
          // No content script on this tab: the page loaded before the extension
          // was installed, or the host is not granted (Firefox). Reported as a
          // false rather than thrown, because the popup has a better sentence
          // for it than a console line nobody reads.
          started = false;
        }
        sendResponse({ ok: started });
        break;
      }
      // US-1873: popup + content scripts read the resolved capability map.
      case "GT_GET_CAPABILITIES":
        sendResponse(await getCapabilities(Boolean(msg.force)));
        break;
      case "GT_GET_ENTITLEMENTS":
        sendResponse(await getEntitlements(Boolean(msg.force)));
        break;
      default:
        sendResponse(null);
    }
  })();
  return true; // async sendResponse
});

// US-1877 (AC1) ── capture the live listing URL after the seller submits ──────
//
// WHY tabs.onUpdated AND NOT THE CONTENT SCRIPT. Submitting the form usually does a
// FULL PAGE LOAD: the content script is torn down and re-injected with no memory of
// having filled anything, so an in-page watch dies exactly when it is needed. The
// background sees the navigation regardless, and the watch record in
// storage.session survives the worker being suspended in between.
async function startListedWatch(job) {
  if (typeof job.tabId !== "number") return;
  const watch = self.GT_LISTER_JOBS.makeWatch({
    tabId: job.tabId,
    saasTabId: job.saasTabId,
    clientRef: job.clientRef,
    platform: job.platform,
    itemId: job.payload && job.payload.itemId,
    // US-9203: which server row the captured URL belongs to, for a relist.
    relistNewListingId: job.kind === "relist" && job.payload ? job.payload.newListingId : null,
    queueId: job.kind === "relist" ? (job.queueId || null) : null,
    now: Date.now(),
  });
  await withWatches(async (w) => ({ watches: self.GT_LISTER_JOBS.putWatch(w, watch) }));
}

// ── US-3062: the side panel, enabled per tab ──────────────────────────────
//
// Chromium only. `sidePanel.setOptions({tabId, enabled})` is what makes the
// toolbar button open the PANEL on a marketplace tab and keep opening
// popup.html everywhere else. Firefox has no per-tab equivalent, so this whole
// block is absent there and the panel page renders its own off-host state
// instead — which is why that state is not dead code.
//
// Every call is wrapped. `sidePanel` is missing on Firefox and on older
// Chromium, and an unhandled rejection in the background worker is the failure
// that takes every OTHER listener down with it.
function applyPanelForTab(tabId, url) {
  if (!ext.sidePanel || !ext.sidePanel.setOptions) return;
  if (typeof tabId !== "number") return;
  const enabled = self.GT_PANEL_HOST.isPanelHost(url, self.GT_LISTER_SELECTORS);
  try {
    const p = ext.sidePanel.setOptions({
      tabId: tabId,
      path: "panel.html",
      enabled: enabled,
    });
    if (p && typeof p.catch === "function") p.catch(function () {});
  } catch (_e) {
    // A tab that closed mid-navigation throws here. Nothing to do about it and
    // nothing worth logging: the tab is gone.
  }
}

if (ext.tabs && ext.tabs.onUpdated && ext.tabs.onUpdated.addListener) {
  ext.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    // Runs on every navigation, including the ones the watch logic below skips,
    // because the panel's availability follows the URL and nothing else.
    applyPanelForTab(tabId, (changeInfo && changeInfo.url) || (tab && tab.url));
  });
}

if (ext.tabs && ext.tabs.onUpdated && ext.tabs.onUpdated.addListener) {
  ext.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    const url = changeInfo && changeInfo.url;
    if (!url) return; // only navigations carry a url
    (async () => {
      const watch = await withWatches(async (w) => ({
        value: self.GT_LISTER_JOBS.findWatch(w, tabId, Date.now()),
      }));
      if (!watch) return;
      // The guard is strict on host AND path shape: a false capture would record
      // the wrong URL and flip the row to ACTIVE — the phantom-listing bug this
      // story exists to remove, just with a plausible-looking URL attached.
      if (!self.GT_LISTER_GUARD.isLiveListingUrl(self.GT_LISTER_SELECTORS, watch.platform, url)) {
        return;
      }
      // One capture per fill: drop the watch BEFORE pushing, so a redirect chain
      // through two listing-shaped URLs can't report twice.
      await withWatches(async (w) => ({ watches: self.GT_LISTER_JOBS.removeWatch(w, tabId) }));
      // US-9203: a relist copy went live. Confirm to the server directly — a
      // drained relist has no GradeThread tab to push to, and the server is
      // where the old row is ended and its removal queued.
      if (watch.relistNewListingId) {
        await confirmRelistListed(watch.relistNewListingId, url);
        if (watch.queueId) {
          // US-3061: checked, and held if the server does not take it. This is
          // the one completion the seller can least afford to lose - the relist
          // copy is already live on the marketplace when it is sent.
          await completeQueueRow(watch.queueId, {
            ok: true,
            result: { listingUrl: url, copied: true },
          });
        }
      } else {
        // An ordinary cross-post went live. Told to the SERVER first, and told
        // whether or not a GradeThread tab is open — that independence is the
        // whole point. The push below still runs, so an open Listing Kit
        // updates on the spot, but it is now a nicety rather than the only
        // path from "the seller submitted" to "FlipDesk knows".
        // The queue row, if there was one, was already completed by reportJob
        // when the FILL returned — a drained list job reports the fill, not the
        // publish. Completing it again here would be a second report of the same
        // row, so this branch only records the listing.
        await confirmExtensionListed(watch.itemId, watch.platform, url);
      }
      try {
        await ext.tabs.sendMessage(watch.saasTabId, {
          type: "GT_LISTER_LISTED",
          clientRef: watch.clientRef,
          platform: watch.platform,
          itemId: watch.itemId,
          listingUrl: url,
        });
      } catch (_e) {
        // The GradeThread tab is closed or navigated away. Not an error: this is
        // exactly what "I published it" (US-1877 AC2) is for.
      }
    })();
  });
}

// Tab closed → its watch is dead with it.
ext.tabs.onRemoved.addListener(function (tabId) {
  withWatches(async (w) => ({ watches: self.GT_LISTER_JOBS.removeWatch(w, tabId) }));
});

// AC4: a closed marketplace tab fails its job IMMEDIATELY. This used to delete the
// per-tab entry but leave the pending callback untouched, so closing the tab bought
// the seller a silent 120s wait for a job that could no longer complete.
ext.tabs.onRemoved.addListener(function (tabId) {
  (async () => {
    const job = await withJobs(async (jobs) => ({
      value: self.GT_LISTER_JOBS.findByTab(jobs, tabId),
    }));
    if (!job) return;
    await endJob(job.jobId, "tabClosed", (j) =>
      self.GT_LISTER_JOBS.tabClosedResultFor(j, SUPPORTED_LISTER[j.platform]),
    );
  })();
});

// ── US-2241: reaching the overlay without hunting for a pill ───────────────
//
// The overlay was only ever reachable by finding a small pill in the corner of
// somebody else's page. Three cheaper doors, all local, none touching the
// network:
//
//   • A keyboard command (Alt+G) that runs the read on the active listing.
//   • A right-click on any image: "Grade this image with GradeThread" — the one
//     case the adapter can't serve, where the shopper has spotted the photo that
//     matters and the gallery selector missed it.
//   • A toolbar badge carrying the last score for the tab it belongs to.
//
// Every registration is GUARDED for the reason background-deps.test.cjs pins:
// reading .addListener off a namespace a browser didn't grant throws at LOAD and
// takes the WHOLE worker with it — including buyer research, which has nothing to
// do with any of this.
const CONTEXT_MENU_ID = "gt-grade-image";
// US-3070: the second item. Right-click a care-tag photo anywhere on the web and
// read what is printed on it. Same contexts as the first, same removeAll
// registration, and the two ids are distinguished in one place — the click
// handler below — so a third item cannot be added without touching it.
const LABEL_MENU_ID = "gt-read-label";

// US-3070: the anonymous tag reader. NO Authorization header, deliberately: the
// endpoint is unauthenticated by design (US-9033) and rate-limited per IP, and
// sending a token would tie a care label — which carries a SIZE, a fact about a
// body — to an account for no gain.
const TAG_READ_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/tag-read";

/**
 * Fetch the image the person right-clicked and read the label off it.
 *
 * ⚠ THE SIZE CHECK HAPPENS BEFORE THE POST. The endpoint refuses over 8MB, but
 * an 11MB press photo uploaded and then refused costs the person the whole
 * upload to be told something we knew before it started.
 *
 * Nothing here is retried and nothing is stored. A rate limit or a capacity
 * refusal is an ANSWER: it comes back with a code, the card renders it as a
 * sentence with the wait, and the person decides.
 */
async function readLabelFromImage(srcUrl) {
  const LR = self.GT_LABEL_READER;
  if (!LR || !LR.isReadableImageUrl(srcUrl)) return { ok: false, data: null };
  let dataUri;
  try {
    const res = await fetch(srcUrl, { cache: "no-store" });
    if (!res.ok) return { ok: false, data: null };
    const blob = await res.blob();
    if (blob.size > LR.MAX_BYTES) {
      return { ok: true, data: { error: "That image is too large to read (8MB limit)." } };
    }
    if (!/^image\//.test(blob.type || "")) return { ok: false, data: null };
    dataUri = await blobToDataUri(blob);
  } catch (_e) {
    return { ok: false, data: null };
  }
  if (!dataUri) return { ok: false, data: null };
  try {
    const resp = await fetch(TAG_READ_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      // ⚠ JSON WITH A DATA URI, NOT MULTIPART. US-3070's AC1 says multipart;
      // prepareGradeCheckImage in public-grading.ts takes `{ image: "data:..." }`
      // and refuses anything that does not start with `data:image/`.
      body: JSON.stringify({ image: dataUri }),
    });
    return { ok: true, data: await resp.json() };
  } catch (_e) {
    return { ok: false, data: null };
  }
}

/**
 * Put the answer on the page the person right-clicked in.
 *
 * ⚠ scripting.executeScript, NOT a content script. A context-menu click is a
 * qualifying gesture for `activeTab`, which this extension already holds, so
 * this reaches ANY page with no host permission and no <all_urls> match — the
 * alternative would have read as "read and change all your data on all
 * websites" at update time.
 *
 * ⚠ AND THE SHAPING HAPPENS HERE, not in the page. GT_LABEL_READER does not
 * exist in the page: executeScript sends render()'s SOURCE, so everything it
 * needs arrives as plain data in `args`.
 */
async function showLabelCard(tabId, res) {
  const LR = self.GT_LABEL_READER;
  const CARD = self.GT_LABEL_CARD;
  if (!LR || !CARD || !ext.scripting || typeof tabId !== "number") return;
  // A transport failure renders nothing at all. Absence is not a claim, and a
  // card reading "something went wrong" on somebody else's page is worse than
  // no card: the person did not ask that page for anything.
  if (!res || !res.ok) return;
  const answer = LR.readAnswer(res.data);
  if (!answer) return;

  const rnPath = LR.rnLookupPath(answer.fields);
  try {
    await ext.scripting.executeScript({
      target: { tabId: tabId },
      func: CARD.render,
      args: [
        answer,
        {
          rows: LR.copyableRows(answer),
          siteUrl: rnPath && self.GT_ATTRIBUTION
            ? self.GT_ATTRIBUTION.siteUrl(rnPath, "label-reader")
            : null,
          ttlMs: LR.CARD_TTL_MS,
          hostId: "gt-label-card",
        },
      ],
    });
  } catch (_e) {
    // No activeTab grant, a restricted page (chrome://, the Web Store), or the
    // tab closed. Nothing to say and nowhere to say it.
  }
}

function blobToDataUri(blob) {
  return new Promise(function (resolve) {
    try {
      const r = new FileReader();
      r.onload = function () { resolve(typeof r.result === "string" ? r.result : null); };
      r.onerror = function () { resolve(null); };
      r.readAsDataURL(blob);
    } catch (_e) { resolve(null); }
  });
}


if (ext.commands && ext.commands.onCommand) {
  ext.commands.onCommand.addListener(async function (command) {
    if (command !== "run-condition-read") return;
    try {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      if (tab && typeof tab.id === "number") {
        // The content script owns the overlay; it ignores the message on a page
        // where no adapter matched, which is the correct no-op.
        await ext.tabs.sendMessage(tab.id, { type: "GT_CC_RUN" });
      }
    } catch (_e) { /* no content script on this tab — nothing to run */ }
  });
}

if (ext.contextMenus && ext.contextMenus.create) {
  // US-3113: create() does NOT throw on a duplicate id under MV3. It reports
  // through runtime.lastError in its callback, so the try/catch this used to
  // rely on never fired and Chrome logged, on every startup after an install:
  //
  //   Unchecked runtime.lastError: Cannot create item with duplicate id
  //   gt-grade-image
  //
  // Harmless in effect — the menu still works — but it is a red line in the
  // console of an extension whose whole job is to look trustworthy on somebody
  // else's marketplace, and it was reported as a bug more than once.
  //
  // removeAll first is the idiomatic fix and is genuinely idempotent: it makes
  // the second registration a no-op rather than a race we swallow. We own the
  // only menu item, so clearing all of them clears exactly ours.
  const createMenu = function () {
    const create = function () {
      ext.contextMenus.create(
        {
          id: CONTEXT_MENU_ID,
          title: "Grade this image with GradeThread",
          contexts: ["image"],
        },
        function () {
          // READING lastError is what marks it checked. Do not remove this
          // because it "does nothing" — without the read, Chrome logs the very
          // warning this block exists to stop.
          void ext.runtime.lastError;
        },
      );
      // US-3070. Same removeAll registration, so the duplicate-id warning
      // US-3113 fixed stays fixed for two items as it did for one.
      ext.contextMenus.create(
        {
          id: LABEL_MENU_ID,
          title: "Read this label with GradeThread",
          contexts: ["image"],
        },
        function () { void ext.runtime.lastError; },
      );
    };
    try {
      if (ext.contextMenus.removeAll) {
        ext.contextMenus.removeAll(create);
      } else {
        create();
      }
    } catch (_e) { /* namespace present but unusable — no menu, no crash */ }
  };
  ext.runtime.onInstalled.addListener(createMenu);
  // Menus do not survive a worker restart on every browser, so re-create on
  // startup too. removeAll above makes the repeat harmless.
  if (ext.runtime.onStartup) ext.runtime.onStartup.addListener(createMenu);

  if (ext.contextMenus.onClicked) {
    ext.contextMenus.onClicked.addListener(function (info, tab) {
      if (!info || !tab || typeof tab.id !== "number") return;

      // US-3070: the label reader. The worker fetches the bytes and posts them,
      // then hands the ANSWER to the page — the content script draws, and never
      // sees a token or an endpoint. `srcUrl` is the entire input: no page URL
      // travels, on a marketplace or anywhere else.
      if (info.menuItemId === LABEL_MENU_ID) {
        const src = info.srcUrl;
        if (!self.GT_LABEL_READER || !self.GT_LABEL_READER.isReadableImageUrl(src)) return;
        void readLabelFromImage(src).then(function (res) {
          return showLabelCard(tab.id, res);
        });
        return;
      }

      if (info.menuItemId !== CONTEXT_MENU_ID) return;
      if (!info.srcUrl || !/^https?:\/\//i.test(info.srcUrl)) return;
      // Routed through the content script rather than graded straight from here,
      // so the result lands in the same overlay, on the same page, with the same
      // epoch guard — a second, parallel result surface would be a second place
      // for a stale grade to appear.
      ext.tabs.sendMessage(tab.id, { type: "GT_CC_RUN", imageUrl: info.srcUrl })
        .catch(function () { /* no content script here */ });
    });
  }
}

// ── Watched lots (US-3067 AC5/AC6) ────────────────────────────────────────
//
// On-device only. The id, the verdict and the end time of a lot the reseller
// asked to keep, in storage.local, with NO SERVER ROW: what somebody is
// thinking of bidding on is not ours to hold, which is also why this is
// storage.local and not storage.sync.
//
// The badge is the whole of AC6 and the ceiling of it. A count when a watched
// lot is inside ten minutes, and nothing else — no notifications permission, no
// sound, no alarm of its own. A number on the toolbar can be ignored; a
// notification at 3am about a $12 jacket cannot.
const WATCH = self.GT_CC_FLIP;

async function readWatched() {
  try {
    const out = await ext.storage.local.get(WATCH.WATCH_KEY);
    return (out && out[WATCH.WATCH_KEY]) || {};
  } catch (_e) { return {}; }
}

async function writeWatched(map) {
  try {
    await ext.storage.local.set({ [WATCH.WATCH_KEY]: map });
    return true;
  } catch (_e) { return false; }
}

// ⚠ GLOBAL, not per-tab, and that is the point. setScoreBadge below writes a
// PER-TAB badge, which Chrome layers over this one — so on a listing you are
// reading you see its score, and everywhere else you see how many of your lots
// are about to close. Writing this per-tab instead would mean the count only
// appeared on whichever tab happened to be open.
async function refreshWatchBadge() {
  if (!ext.action || !WATCH) return 0;
  const n = WATCH.endingSoonCount(await readWatched(), Date.now());
  try {
    await ext.action.setBadgeText({ text: n > 0 ? String(n) : "" });
    if (n > 0) await ext.action.setBadgeBackgroundColor({ color: "#E94560" });
  } catch (_e) { /* action API unavailable — the badge is a nicety */ }
  return n;
}

// The toolbar badge: the last score for THIS tab. Per-tab, so switching tabs
// never shows the previous listing's number against the current one.
async function setScoreBadge(tabId, score) {
  if (!ext.action || typeof tabId !== "number") return;
  const n = Number(score);
  const text = isFinite(n) && n >= 1 && n <= 10 ? n.toFixed(1) : "";
  try {
    await ext.action.setBadgeText({ tabId: tabId, text: text });
    if (text) {
      await ext.action.setBadgeBackgroundColor({ tabId: tabId, color: "#0F3460" });
    }
  } catch (_e) { /* action API unavailable — the badge is a nicety */ }
}

