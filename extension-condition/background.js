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
const CONFIG_URL = "https://gradethread.com/extension/ebay-selectors.json";
const CONFIG_TTL_MS = 6 * 60 * 60 * 1000; // refresh the hosted selectors every 6h
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
let configCache = null; // { at, config }

function validConfig(c) {
  return c && typeof c === "object" && c.ebay && Array.isArray(c.ebay.gallery);
}

async function getRemoteConfig() {
  const now = Date.now();
  if (configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.config;
  try {
    const resp = await fetch(CONFIG_URL, { cache: "no-cache" });
    if (!resp.ok) throw new Error("config " + resp.status);
    const json = await resp.json();
    if (!validConfig(json)) throw new Error("config shape");
    configCache = { at: now, config: json };
    return json;
  } catch (_e) {
    // No hosted override (or unreachable). Cache the miss briefly so we don't
    // hammer the URL, and let the content script keep its bundled default.
    configCache = { at: now, config: null };
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
    overallScore: Number(read.overallScore),
    gradeTier: String(read.gradeTier || ""),
    confidence: Number(read.confidence),
    at: Number(read.at) || Date.now(),
  });
  await chrome.storage.local.set({ recentReads: list.slice(0, MAX_RECENT) });
}

// ── the grade call ─────────────────────────────────────────────────────
async function gradeFromUrls({ imageUrls, brand, title }) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { ok: false, status: 400, error: "No listing photos to grade." };
  }
  const instanceId = await getInstanceId();
  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GT-Extension-Id": instanceId,
      },
      body: JSON.stringify({
        imageUrls: imageUrls.slice(0, 4),
        brand: brand || undefined,
        title: title || undefined,
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
