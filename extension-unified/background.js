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
    "lister/selectors.js",
    "lister/lister-guard.js",
    "lister/job-store.js",
    "registry.js",
    "research/seller-memory.js",
    "research/compare-tray.js",
  );
}
const ext = globalThis.browser || globalThis.chrome;

// ── endpoints / constants ────────────────────────────────────────────────
const SITE = "https://gradethread.com";
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
const SELECTOR_HEALTH_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/selector-health";
const PENDING_DELISTS_ENDPOINT =
  "https://functions.gradethread.com/api/grading/public/pending-delists";
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
const GRADE_CACHE_MAX = 100;

const SUPPORTED_LISTER = {
  poshmark: "Poshmark",
  mercari: "Mercari",
  grailed: "Grailed",
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
    try {
      ext.tabs.create({ url: ext.runtime.getURL("onboarding.html") });
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
async function gradeFromUrls({ imageUrls, brand, title, condition, marketplace, price }) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
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
      body: JSON.stringify({
        imageUrls: imageUrls.slice(0, 4),
        brand: brand || undefined,
        title: title || undefined,
        condition: condition || undefined,
        marketplace: marketplace || undefined,
        price: price || undefined,
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
  if (!Array.isArray(msg.imageUrls) || msg.imageUrls.length === 0) {
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
      body: JSON.stringify({
        imageUrls: msg.imageUrls.slice(0, 4),
        title: msg.title || undefined,
        brand: msg.brand || undefined,
        priceCents: typeof msg.priceCents === "number" ? msg.priceCents : undefined,
        marketplace: msg.marketplace || undefined,
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
          (kind === "delist" ? "delist" : "cross-post") + ". Try again.",
      });
    } catch (_e) { /* port already gone */ }
    // eslint-disable-next-line no-console
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
  if (isDelist) {
    url = payload.listingUrl;
  } else {
    url = self.GT_LISTER_GUARD.newListingUrlFor(self.GT_LISTER_SELECTORS, payload.platform);
    if (!url) {
      sendResponse({ ok: false, error: "Unsupported marketplace." });
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
    now: Date.now(),
  });

  await withJobs(async (jobs) => ({ jobs: self.GT_LISTER_JOBS.put(jobs, job) }));
  await scheduleJobAlarm(job);
  // Registered only AFTER the job is durably stored: if we die between the two, the
  // alarm still fails the job cleanly rather than leaving an orphan.
  pendingExternal[job.jobId] = sendResponse;
}

function handleListRequest(payload, sender, sendResponse, clientRef) {
  return startJob("list", payload, sender, sendResponse, clientRef);
}

function handleDelistRequest(payload, sender, sendResponse, clientRef) {
  return startJob("delist", payload, sender, sendResponse, clientRef);
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
    const name = (alarm && alarm.name) || "";

    if (name === SWEEP_ALARM) {
      withJobs(async (jobs) => ({ jobs: self.GT_LISTER_JOBS.sweep(jobs, Date.now()).jobs }));
      // US-1877: expired watches go with them — an abandoned tab must not capture
      // whatever the seller browses to an hour later.
      withWatches(async (w) => ({ watches: self.GT_LISTER_JOBS.sweepWatches(w, Date.now()) }));
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
  if (msg.type === "GT_PING" || msg.type === "GT_LISTER_PING") {
    (async () => {
      const caps = await getCapabilities(false);
      sendResponse({
        ok: true,
        installed: true,
        name: "GradeThread",
        unified: true,
        platforms: SUPPORTED_LISTER,
        capabilities: caps,
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

  if (msg.type === "GT_LISTER_DELIST") {
    const dp = msg.payload;
    if (!isValidDelistPayload(dp)) {
      sendResponse({ ok: false, error: "Invalid or unsupported delist payload." });
      return false;
    }
    handleDelistRequest(dp, sender, sendResponse, msg.clientRef);
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
    // eslint-disable-next-line no-console
    console.debug("[GradeThread Lister][content]", msg.message);
    return false;
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
        sendResponse({ ok: true });
        break;
      // US-1880 (AC3): an adapter found nothing. Respond immediately and let the
      // post fly on its own — the content script has already rendered the honest
      // degrade state and must not wait on telemetry.
      case "GT_CC_SELECTOR_MISS":
        sendResponse({ ok: true });
        reportSelectorMiss(msg);
        break;
      // US-1885 (AC1): the popup's pending-delist queue.
      case "GT_GET_PENDING_DELISTS":
        sendResponse(await getPendingDelists());
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

// Exposed for popup/deep links (kept in one place).
self.GT_SITE = SITE;
