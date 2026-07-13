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
  importScripts("lister/selectors.js", "lister/lister-guard.js", "registry.js");
}
const ext = globalThis.browser || globalThis.chrome;

// ── endpoints / constants ────────────────────────────────────────────────
const SITE = "https://gradethread.com";
const GRADE_ENDPOINT = "https://functions.gradethread.com/api/grading/public/grade-from-url";
const ENTITLEMENTS_ENDPOINT = "https://functions.gradethread.com/api/grading/public/entitlements";
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
  const out = await ext.storage.local.get(["autoRun", "disabledHosts"]);
  return {
    autoRun: Boolean(out.autoRun),
    disabledHosts: Array.isArray(out.disabledHosts) ? out.disabledHosts : [],
  };
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
  return {
    ok: false,
    status: resp.status,
    error: (json && json.error) || "Couldn't grade this listing right now.",
  };
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
    at: Number(read.at) || Date.now(),
  });
  await ext.storage.local.set({ recentReads: list.slice(0, MAX_RECENT) });
}

// ── Lister job lifecycle ──────────────────────────────────────────────────
// jobsByTab maps a freshly-opened marketplace tab to its queued job;
// pendingExternal maps a jobId to the SaaS sendResponse so the content script's
// result is relayed back to the GradeThread tab that started the job.
const jobsByTab = {};
const pendingExternal = {};
let jobSeq = 0;

function makeJobId() {
  jobSeq += 1;
  return "job-" + jobSeq + "-" + Date.now();
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

async function handleListRequest(payload, sendResponse) {
  if (!(await sellerAllowed())) {
    sendResponse({
      ok: false,
      needsUpgrade: true,
      error: "Cross-listing is a FlipDesk seller feature — upgrade your GradeThread plan to enable the Lister.",
    });
    return;
  }
  if (!(await tosAccepted())) {
    sendResponse({
      ok: false,
      needsConsent: true,
      error: "Open the GradeThread extension and accept the Lister terms before cross-listing.",
    });
    return;
  }

  // AC1: the new-listing URL is ALWAYS the bundled selectors config value, never
  // payload.newListingUrl — an XSS on gradethread.com can't steer navigation.
  const newListingUrl = self.GT_LISTER_GUARD.newListingUrlFor(
    self.GT_LISTER_SELECTORS,
    payload.platform,
  );
  if (!newListingUrl) {
    sendResponse({ ok: false, error: "Unsupported marketplace." });
    return;
  }

  const jobId = makeJobId();
  let tab;
  try {
    tab = await ext.tabs.create({ url: newListingUrl, active: true });
  } catch (_e) {
    sendResponse({ ok: false, error: "Couldn't open the marketplace tab." });
    return;
  }

  jobsByTab[tab.id] = { jobId: jobId, platform: payload.platform, payload: payload };
  pendingExternal[jobId] = sendResponse;

  setTimeout(function () {
    if (pendingExternal[jobId]) {
      try {
        pendingExternal[jobId]({
          ok: false,
          timedOut: true,
          error:
            "Timed out waiting for the " + SUPPORTED_LISTER[payload.platform] +
            " form. List manually if the tab didn't prefill.",
        });
      } catch (_e) { /* port may be gone */ }
      delete pendingExternal[jobId];
    }
  }, 120000);
}

async function handleDelistRequest(payload, sendResponse) {
  if (!(await sellerAllowed())) {
    sendResponse({
      ok: false,
      needsUpgrade: true,
      error: "Auto-delist is a FlipDesk seller feature — upgrade your GradeThread plan to enable it.",
    });
    return;
  }
  if (!(await tosAccepted())) {
    sendResponse({
      ok: false,
      needsConsent: true,
      error: "Open the GradeThread extension and accept the Lister terms before delisting.",
    });
    return;
  }

  const jobId = makeJobId();
  let tab;
  try {
    tab = await ext.tabs.create({ url: payload.listingUrl, active: true });
  } catch (_e) {
    sendResponse({ ok: false, error: "Couldn't open the marketplace tab." });
    return;
  }

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
            "Timed out ending the " + SUPPORTED_LISTER[payload.platform] +
            " listing. End it manually if the tab didn't.",
        });
      } catch (_e) { /* port may be gone */ }
      delete pendingExternal[jobId];
    }
  }, 120000);
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
    handleDelistRequest(dp, sendResponse);
    return true;
  }

  if (msg.type === "GT_LISTER_LIST") {
    const payload = msg.payload;
    if (!isValidPayload(payload)) {
      sendResponse({ ok: false, error: "Invalid or unsupported listing payload." });
      return false;
    }
    handleListRequest(payload, sendResponse);
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

  // Lister: synchronous per-tab handlers (no async needed).
  if (msg.type === "GT_LISTER_GET_JOB") {
    const tabId = sender.tab && sender.tab.id;
    sendResponse((tabId != null && jobsByTab[tabId]) || null);
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
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) delete jobsByTab[tabId];
    return false;
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
      case "GT_CC_GET_CACHED":
        sendResponse(await readGradeCache(msg.listingKey));
        break;
      case "GT_CC_SAVE_READ":
        await saveRead(msg.read);
        sendResponse({ ok: true });
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

// Clean up if the marketplace tab is closed before reporting.
ext.tabs.onRemoved.addListener(function (tabId) {
  delete jobsByTab[tabId];
});

// Exposed for popup/deep links (kept in one place).
self.GT_SITE = SITE;
