// GradeThread Condition Check — background service worker (US-1755)
//
// The content script never calls the grading endpoint directly: a background
// fetch carries the extension's own origin (chrome-extension://<id>), which is
// what the server's CORS allowlist (EXTENSION_ALLOWED_ORIGINS) trusts, and it
// isn't subject to the eBay page's CSP. The worker also owns the per-install
// instance id (sent as X-GT-Extension-Id so this install's quota is separate
// from the shared web grade-checker), the remotely-updatable selector config
// cache, the buyer's settings, and the local "recent reads" history.
//
// PRIVACY: the extension reads only the public image URLs already on the eBay
// page and sends them to GradeThread's public endpoint. No cookies permission,
// no eBay account access, nothing persisted server-side (the endpoint writes no
// rows). Reads are stored locally in chrome.storage.local only.

const ENDPOINT = "https://functions.gradethread.com/api/grading/public/grade-from-url";
const SITE = "https://gradethread.com";
const CONFIG_URL = "https://gradethread.com/extension/marketplace-selectors.json";
// US-1879: honest TTLs — a good fetch is trusted for 6h, but a MISS (unreachable
// / bad shape) is only cached ~10min so a transient outage doesn't strand every
// read on the bundled default for a full 6h.
const CONFIG_TTL_HIT_MS = 6 * 60 * 60 * 1000;
const CONFIG_TTL_MISS_MS = 10 * 60 * 1000;
const CONFIG_CACHE_KEY = "ccConfigCache";
const MAX_RECENT = 20;

// ── per-install instance id (quota key) ──────────────────────────────────
async function getInstanceId() {
  const { instanceId } = await chrome.storage.local.get("instanceId");
  if (instanceId) return instanceId;
  const id = (crypto.randomUUID && crypto.randomUUID()) ||
    "gt-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  await chrome.storage.local.set({ instanceId: id });
  return id;
}

chrome.runtime.onInstalled.addListener(() => {
  getInstanceId(); // materialise the id on install
});

// ── remotely-updatable selector config (cached) ──────────────────────────
// US-1879: the cache lives in chrome.storage.session, not SW module memory —
// Chrome kills an idle service worker ~30s after the last event, so a module var
// almost never survived and every restart re-fetched. storage.session persists
// for the browser session (cleared on browser close), giving the TTLs real teeth.

function validConfig(c) {
  return c && typeof c === "object" && c.adapters && typeof c.adapters === "object" &&
    Object.keys(c.adapters).length > 0;
}

async function readConfigCache() {
  try {
    const out = await chrome.storage.session.get(CONFIG_CACHE_KEY);
    return out && out[CONFIG_CACHE_KEY] ? out[CONFIG_CACHE_KEY] : null;
  } catch (_e) {
    return null;
  }
}

async function writeConfigCache(entry) {
  try {
    await chrome.storage.session.set({ [CONFIG_CACHE_KEY]: entry });
  } catch (_e) { /* session storage unavailable — degrade to always-fetch */ }
}

async function getRemoteConfig() {
  const now = Date.now();
  const cached = await readConfigCache();
  if (cached && typeof cached.at === "number") {
    // A hit (config present) is trusted for 6h; a miss only ~10min.
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
    // No hosted override (or unreachable). Cache the miss briefly (short TTL) so
    // we don't hammer the URL, and let the content script keep its bundled default.
    await writeConfigCache({ at: now, config: null });
    return null;
  }
}

// ── settings ──────────────────────────────────────────────────────────────
async function getSettings() {
  const out = await chrome.storage.local.get(["autoRun", "disabledHosts"]);
  return {
    autoRun: Boolean(out.autoRun),
    disabledHosts: Array.isArray(out.disabledHosts) ? out.disabledHosts : [],
  };
}

// ── recent reads history ────────────────────────────────────────────────
async function saveRead(read) {
  if (!read || typeof read !== "object") return;
  const { recentReads } = await chrome.storage.local.get("recentReads");
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
  await chrome.storage.local.set({ recentReads: list.slice(0, MAX_RECENT) });
}

// ── the grade call ─────────────────────────────────────────────────────
async function gradeFromUrls({ imageUrls, brand, title, condition, marketplace, price }) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { ok: false, status: 400, error: "No listing photos to grade." };
  }
  const instanceId = await getInstanceId();
  // US-1838: a signed buyer token (stored after the account is connected) unlocks
  // the paid signals + separates quota from anonymous use. Absent → anonymous.
  const headers = {
    "Content-Type": "application/json",
    "X-GT-Extension-Id": instanceId,
  };
  try {
    const { gtBuyerToken } = await chrome.storage.local.get("gtBuyerToken");
    if (gtBuyerToken && typeof gtBuyerToken === "string") headers["Authorization"] = "Bearer " + gtBuyerToken;
  } catch (_e) { /* no token → anonymous */ }
  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        imageUrls: imageUrls.slice(0, 4),
        brand: brand || undefined,
        title: title || undefined,
        // US-1834: the seller's claimed condition + marketplace, so the endpoint
        // can score a claimed-vs-objective discrepancy. Both optional (degrades).
        condition: condition || undefined,
        marketplace: marketplace || undefined,
        // US-1835: the listing price, so the endpoint can rate price fairness.
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

// ── message router ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") {
    sendResponse(null);
    return false;
  }
  (async () => {
    switch (msg.type) {
      case "GT_CC_GET_CONFIG":
        sendResponse(await getRemoteConfig());
        break;
      case "GT_CC_GET_SETTINGS":
        sendResponse(await getSettings());
        break;
      case "GT_CC_GRADE":
        sendResponse(await gradeFromUrls(msg));
        break;
      case "GT_CC_SAVE_READ":
        await saveRead(msg.read);
        sendResponse({ ok: true });
        break;
      default:
        sendResponse(null);
    }
  })();
  return true; // async sendResponse
});

// Exposed for popup/deep links (kept in one place).
self.GT_CC_SITE = SITE;
