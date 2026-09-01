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
    // US-2701: the poll's decisions and the adapters it reads them against.
    // The DRIVER is in this file; these two only decide and describe.
    "sync/selectors.js",
    "closet-import/selectors.js",
    "sync/poll-plan.js",
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
// US-2238: flip mode. NOT under /api/grading/public — this one is authenticated
// and plan-gated (FlipDesk compPulls), so it lives on the seller side and needs
// the signed extension token. A request without one is a 401 by design.
const APPRAISE_ENDPOINT = "https://functions.gradethread.com/api/flipdesk/scout/appraise-url";
const ENTITLEMENTS_ENDPOINT = "https://functions.gradethread.com/api/grading/public/entitlements";
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
const MAX_RECENT = 20;
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
  const out = await ext.storage.local.get(["autoRun", "disabledHosts", "scanMode"]);
  return {
    autoRun: Boolean(out.autoRun),
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
  const [ent, settings] = await Promise.all([getEntitlements(force), getSettings()]);
  return self.GT_REGISTRY.resolveCapabilities(ent, settings);
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

async function runClosetImport(msg) {
  const platform = msg && typeof msg.platform === "string" ? msg.platform.toLowerCase() : "";
  const patterns = closetImportTabPatterns(platform);
  if (patterns.length === 0) {
    return { ok: false, reason: "unsupported", error: "Closet import supports Poshmark and Mercari." };
  }
  if (!(await sellerAllowed())) {
    return { ok: false, status: 402, reason: "seller_locked", error: "Closet import is a FlipDesk seller feature." };
  }
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
    return { ok: false, status: 403, needsUpgrade: true, error: "FlipDesk plan required." };
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
    await queueFetch("/" + job.queueId + "/complete", {
      method: "POST",
      body: JSON.stringify({
        ok: result && result.ok === true,
        result: {
          error: result && typeof result.error === "string"
            ? result.error.slice(0, 400)
            : null,
          manual: Boolean(result && result.manual),
          listingUrl: result && typeof result.listingUrl === "string"
            ? result.listingUrl
            : null,
        },
      }),
    });
    // Immediately look for the next one. The drain runs a single job at a time,
    // so without this a queue of six would take six sweep ticks — half an hour —
    // to clear a browser that was open the whole time.
    void drainQueue();
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

function isValidDelistPayload(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.platform === "string" &&
    SUPPORTED_LISTER[p.platform] &&
    self.GT_LISTER_GUARD.isAllowedDelistUrl(
      self.GT_LISTER_SELECTORS,
      p.platform,
      p.listingUrl,
    )
  );
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
          (kind === "delist" ? "delist" : kind === "revise" ? "edit sync" : "cross-post") +
          ". Try again.",
      });
    } catch (_e) { /* port already gone */ }
     
    console.error("[GradeThread Lister] job start failed", err);
  }
}

async function beginJob(kind, payload, sender, sendResponse, clientRef) {
  const isDelist = kind === "delist";

  if (!(await sellerAllowed())) {
    sendResponse({
      ok: false,
      needsUpgrade: true,
      error: isDelist
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
  if (isDelist || kind === "revise") {
    // US-9202: a revise opens the listing itself, host-pinned by
    // isValidRevisePayload exactly as a delist URL is.
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

async function queueFetch(path, init) {
  const { gtBuyerToken } = await ext.storage.local.get("gtBuyerToken");
  if (!gtBuyerToken || typeof gtBuyerToken !== "string") return null;
  try {
    const resp = await fetch(QUEUE_ENDPOINT + (path || ""), Object.assign({
      cache: "no-store",
      headers: {
        "Authorization": "Bearer " + gtBuyerToken,
        "Content-Type": "application/json",
      },
    }, init || {}));
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_e) {
    // Offline, or the seller's token expired. The queue is server-side state and
    // survives; the next tick tries again. Nothing is lost by failing quietly
    // here, and a toast about a background poll would be noise.
    return null;
  }
}

let drainInFlight = false;

async function drainQueue() {
  // Re-entrancy guard: the sweep alarm and a startup event can land together,
  // and two concurrent drains would each claim the same row before either
  // marked it.
  if (drainInFlight) return;
  drainInFlight = true;
  try {
    // Same gates as an interactive cross-post, checked in the same order. A
    // drained job is not a special case that gets to skip the seller's consent.
    if (!(await sellerAllowed())) return;
    if (!(await tosAccepted())) return;

    const claimed = await queueFetch("/claim", {
      method: "POST",
      body: JSON.stringify({ limit: 5, installId: await getInstanceId() }),
    });
    const rows = (claimed && claimed.claimed) || [];
    if (rows.length === 0) return;

    const jobs = await withJobs(async (j) => ({ value: j }));
    const plan = self.GT_LISTER_JOBS.planDrain(rows, jobs, { now: Date.now() });

    // AC6: expired rows are REPORTED, never silently dropped. A seller who
    // believes a delist is still pending is a seller heading for a double sale.
    for (const row of plan.expired) {
      await queueFetch("/" + row.id + "/complete", {
        method: "POST",
        body: JSON.stringify({
          ok: false,
          result: {
            expired: true,
            error: "This waited longer than a week without your desktop browser " +
              "opening, so GradeThread stopped waiting. Queue it again if you " +
              "still want it run.",
          },
        }),
      });
    }

    // A kind this build cannot carry out is reported the same way an expired one
    // is, and for the same reason: a row nothing will ever pick up is
    // indistinguishable, from the phone, from a row about to run. Before this,
    // a share row was quietly turned into a LIST job and the seller got a
    // duplicate listing out of a request to share their closet.
    for (const row of plan.unsupported || []) {
      await queueFetch("/" + row.id + "/complete", {
        method: "POST",
        body: JSON.stringify({
          ok: false,
          result: {
            unsupported: true,
            error: "This version of the GradeThread extension can't run a \"" +
              row.kind + "\" job. Update the extension, or start it from the " +
              "extension's own window.",
          },
        }),
      });
    }

    for (const row of plan.toRun) {
      const url = self.GT_LISTER_GUARD.newListingUrlForLocale(
        self.GT_LISTER_SELECTORS,
        row.platform,
        row.payload && row.payload.locale,
      );
      const target = row.kind === "delist" || row.kind === "revise"
        ? (row.payload && row.payload.listingUrl)
        : url;
      // The same guard as an interactive job: a delist or revise URL must be
      // https and host-match its platform, and a list URL always comes from the
      // bundled config. A queue row is server-supplied, which makes it no more
      // trusted than a message from a page.
      const allowed = row.kind === "delist" || row.kind === "revise"
        ? self.GT_LISTER_GUARD.isAllowedDelistUrl(
            self.GT_LISTER_SELECTORS, row.platform, target,
          )
        : Boolean(target);
      if (!allowed) {
        await queueFetch("/" + row.id + "/complete", {
          method: "POST",
          body: JSON.stringify({
            ok: false,
            result: { error: "GradeThread can't open that target for " + row.platform + "." },
          }),
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
        continue; // try again on the next tick; the row stays claimed
      }

      const job = self.GT_LISTER_JOBS.jobFromQueueRow(row, {
        jobId: makeJobId(),
        tabId: tab.id,
        now: Date.now(),
      });
      if (!job) continue; // planDrain already filtered these; belt and braces
      await withJobs(async (j) => ({ jobs: self.GT_LISTER_JOBS.put(j, job) }));
      await scheduleJobAlarm(job);
    }
  } finally {
    drainInFlight = false;
  }
}

// Run it when the browser opens — the moment the whole feature is named after.
if (ext.runtime.onStartup) {
  ext.runtime.onStartup.addListener(function () { void drainQueue(); });
}

function handleListRequest(payload, sender, sendResponse, clientRef) {
  return startJob("list", payload, sender, sendResponse, clientRef);
}

function handleDelistRequest(payload, sender, sendResponse, clientRef) {
  return startJob("delist", payload, sender, sendResponse, clientRef);
}

// US-9202: the web's "Apply now" on a stale listing.
function handleReviseRequest(payload, sender, sendResponse, clientRef) {
  return startJob("revise", payload, sender, sendResponse, clientRef);
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
      // US-9202: and the edits FlipDesk is waiting to apply on extension
      // channels. One per tick, unfocused, gated like everything else.
      void drainPendingRevises();
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
      const caps = await getCapabilities(false);
      sendResponse({
        ok: true,
        installed: true,
        name: "GradeThread",
        unified: true,
        version: ext.runtime.getManifest().version,
        platforms: SUPPORTED_LISTER,
        capabilities: caps,
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
      await ext.storage.local.set({ gtBuyerToken: msg.token });
      await invalidateEntCache();
      // Entitlements (which paid signals a grade includes) just changed, so drop
      // the recall cache — a return visit should re-grade with the new account's
      // tier rather than replay the anonymous read.
      await clearGradeCache();
      const caps = await getCapabilities(true);
      sendResponse({ ok: true, capabilities: caps });
    })();
    return true;
  }

  if (msg.type === "GT_CLEAR_TOKEN") {
    (async () => {
      await ext.storage.local.remove("gtBuyerToken");
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
          // Only read for offers, and clamped so a bad field cannot send a
          // one-cent offer to every liker in the closet.
          offerPrice: action === "offer" ? Math.max(1, Math.floor(Number(msg.offerPrice) || 0)) : null,
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
    now: Date.now(),
  });
  await withWatches(async (w) => ({ watches: self.GT_LISTER_JOBS.putWatch(w, watch) }));
}

if (ext.tabs.onUpdated && ext.tabs.onUpdated.addListener) {
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
  const createMenu = function () {
    try {
      ext.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: "Grade this image with GradeThread",
        contexts: ["image"],
      });
    } catch (_e) { /* already created (worker restart) — harmless */ }
  };
  ext.runtime.onInstalled.addListener(createMenu);
  // Menus do not survive a worker restart on every browser, so re-create on
  // startup too. A duplicate-id create throws and is swallowed above.
  if (ext.runtime.onStartup) ext.runtime.onStartup.addListener(createMenu);

  if (ext.contextMenus.onClicked) {
    ext.contextMenus.onClicked.addListener(function (info, tab) {
      if (!info || info.menuItemId !== CONTEXT_MENU_ID) return;
      if (!info.srcUrl || !/^https?:\/\//i.test(info.srcUrl)) return;
      if (!tab || typeof tab.id !== "number") return;
      // Routed through the content script rather than graded straight from here,
      // so the result lands in the same overlay, on the same page, with the same
      // epoch guard — a second, parallel result surface would be a second place
      // for a stale grade to appear.
      ext.tabs.sendMessage(tab.id, { type: "GT_CC_RUN", imageUrl: info.srcUrl })
        .catch(function () { /* no content script here */ });
    });
  }
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

