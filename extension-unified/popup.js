// GradeThread unified extension — role-aware popup (US-1885)
//
// One popup, capability-driven. It asks the background for the resolved
// capability map (GT_GET_CAPABILITIES) and renders only what the account grants:
//   • Condition Check (research) — always: recent reads, auto-run, per-site toggle.
//   • Seller tools (Lister) — only when seller-entitled: platform status read from
//     the ACTUAL versioned selectors config (no hand-maintained duplicate that
//     drifts), plus versioned + revocable Lister consent.
// Signed-out shows an honest "sign in to unlock"; sign-in launches the US-1838
// token flow on gradethread.com, which posts the signed token back to the
// extension (GT_SET_TOKEN) so entitlements + quota become account-scoped.

// Cross-browser API alias (Firefox: `browser`/promises; Chrome: `chrome`).
const chrome = globalThis.browser || globalThis.chrome;

const SITE = "https://gradethread.com";

// US-1885 AC3: versioned Lister consent — bump this when the Lister terms change
// and every seller is re-prompted (an accepted older version no longer counts).
const TOS_VERSION = "2026-07-13";

const MARKETPLACE_HOST_RE =
  /(^|\.)(ebay\.|poshmark\.|grailed\.com|mercari\.com|depop\.com|vinted\.)/i;

const PLAN_LABELS = {
  free: "Free",
  guard: "Guard",
  connoisseur: "Connoisseur",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
};

function titlePlan(key) {
  return PLAN_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Free");
}

function scoreClass(score) {
  if (score >= 9) return "s-excellent";
  if (score >= 7) return "s-good";
  if (score >= 5) return "s-fair";
  if (score >= 3) return "s-poor";
  return "s-bad";
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

async function activeHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) return new URL(tab.url).host;
  } catch (_e) { /* no activeTab access */ }
  return null;
}

function send(msg) {
  // Promise form works on both Chrome (MV3) and Firefox (browser.*); a failure
  // (worker asleep / no receiver) resolves to null rather than rejecting.
  try {
    return Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => null);
  } catch (_e) {
    return Promise.resolve(null);
  }
}

// ── links / version ────────────────────────────────────────────────────────
function initStaticLinks() {
  const version = document.getElementById("version");
  version.textContent = "v" + chrome.runtime.getManifest().version;
  document.getElementById("privacy").href = SITE + "/privacy?utm_source=extension&utm_medium=popup";
  document.getElementById("help").href = SITE + "/?utm_source=extension&utm_medium=popup";
  document.getElementById("termsLink").href = SITE + "/acceptable-use?utm_source=extension&utm_medium=popup";
  const upgrade = document.getElementById("upgradeBtn");
  if (upgrade) upgrade.href = SITE + "/pricing?utm_source=extension&utm_medium=popup&utm_campaign=lister-upgrade";
}

// ── account section ─────────────────────────────────────────────────────────
function renderAccount(caps) {
  const state = document.getElementById("acctState");
  const summary = document.getElementById("acctSummary");
  const badges = document.getElementById("acctBadges");
  const connect = document.getElementById("connectBtn");
  const disconnect = document.getElementById("disconnectBtn");
  const roleSub = document.getElementById("roleSub");
  badges.textContent = "";

  const authed = caps && caps.authenticated;
  if (authed) {
    state.textContent = "Connected";
    disconnect.hidden = false;
    connect.textContent = "Refresh account";
    const buyer = document.createElement("span");
    buyer.className = "pop-badge buyer";
    buyer.textContent = "Buyer · " + titlePlan(caps.buyerPlan);
    badges.appendChild(buyer);
    if (caps.sellerEnabled) {
      const seller = document.createElement("span");
      seller.className = "pop-badge seller";
      seller.textContent = "FlipDesk · " + titlePlan(caps.flipdeskPlan);
      badges.appendChild(seller);
      summary.textContent = "Buyer research + seller Lister are unlocked.";
      roleSub.textContent = "Seller";
    } else {
      summary.textContent = "Buyer research is unlocked. Add FlipDesk for seller tools.";
      roleSub.textContent = "Buyer";
    }
  } else {
    state.textContent = "Not signed in";
    disconnect.hidden = true;
    connect.textContent = "Sign in to unlock";
    summary.textContent =
      "Buyer research works right now, no account needed. Sign in to raise your read limit; add FlipDesk to cross-post as a seller.";
    roleSub.textContent = "Condition Check";
  }
}

// ── research settings ───────────────────────────────────────────────────────
async function initResearch() {
  const { autoRun, disabledHosts } = await chrome.storage.local.get(["autoRun", "disabledHosts"]);
  const disabled = Array.isArray(disabledHosts) ? disabledHosts : [];

  const autoEl = document.getElementById("autoRun");
  autoEl.checked = Boolean(autoRun);
  autoEl.addEventListener("change", () => {
    chrome.storage.local.set({ autoRun: autoEl.checked });
  });

  const host = await activeHost();
  if (host && MARKETPLACE_HOST_RE.test(host)) {
    const wrap = document.getElementById("siteToggleWrap");
    const label = document.getElementById("siteToggleLabel");
    const box = document.getElementById("siteEnabled");
    wrap.hidden = false;
    label.textContent = "Enabled on " + host;
    box.checked = !disabled.includes(host);
    box.addEventListener("change", async () => {
      const cur = (await chrome.storage.local.get("disabledHosts")).disabledHosts || [];
      const set = new Set(Array.isArray(cur) ? cur : []);
      if (box.checked) set.delete(host);
      else set.add(host);
      await chrome.storage.local.set({ disabledHosts: Array.from(set) });
    });
  }
}

async function renderReads() {
  const ul = document.getElementById("reads");
  const { recentReads } = await chrome.storage.local.get("recentReads");
  const list = Array.isArray(recentReads) ? recentReads : [];
  if (!list.length) return; // keep the empty-state <li>
  ul.textContent = "";
  for (const r of list) {
    const li = document.createElement("li");
    li.className = "pop-read";
    const a = document.createElement("a");
    a.href = r.url || SITE;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const score = document.createElement("span");
    score.className = "pop-read-score " + scoreClass(Number(r.overallScore));
    score.textContent = Number(r.overallScore).toFixed(1);

    const body = document.createElement("span");
    body.className = "pop-read-body";
    const title = document.createElement("div");
    title.className = "pop-read-title";
    title.textContent = r.title || "Listing";
    const meta = document.createElement("div");
    meta.className = "pop-read-meta";
    const mkt = r.marketplace ? r.marketplace + " · " : "";
    meta.textContent = mkt + (r.gradeTier ? r.gradeTier + " · " : "") + timeAgo(Number(r.at) || Date.now());
    body.appendChild(title);
    body.appendChild(meta);

    a.appendChild(score);
    a.appendChild(body);
    li.appendChild(a);
    ul.appendChild(li);
  }
}

// ── seller section ──────────────────────────────────────────────────────────
// US-1885 AC1: platform status from the REAL versioned selectors config.
function renderPlatforms() {
  const ul = document.getElementById("platforms");
  ul.textContent = "";
  const cfg = self.GT_LISTER_SELECTORS || {};
  const order = ["poshmark", "mercari", "grailed"];
  const labels = { poshmark: "Poshmark", mercari: "Mercari", grailed: "Grailed" };
  for (const key of order) {
    const p = cfg[key];
    if (!p) continue;
    const li = document.createElement("li");
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = labels[key];
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = p.enabled
      ? "selectors v" + p.version + (p.lastVerified ? " · verified " + p.lastVerified : "")
      : "not yet enabled";
    left.appendChild(name);
    left.appendChild(metaEl);
    const badge = document.createElement("span");
    badge.className = "pop-status " + (p.enabled ? "on" : "off");
    badge.textContent = p.enabled ? "Enabled" : "Coming soon";
    li.appendChild(left);
    li.appendChild(badge);
    ul.appendChild(li);
  }
}

// US-1885 AC3: versioned + revocable consent.
async function renderConsent() {
  const out = await chrome.storage.local.get(["tosAcceptedAt", "tosVersion"]);
  const accepted = out && out.tosAcceptedAt && out.tosVersion === TOS_VERSION;
  const note = document.getElementById("acceptedNote");
  const check = document.getElementById("tosCheck");
  const btn = document.getElementById("acceptTos");
  const revoke = document.getElementById("revokeTos");
  const staleAccept = out && out.tosAcceptedAt && out.tosVersion !== TOS_VERSION;

  if (accepted) {
    note.hidden = false;
    note.textContent = "Terms accepted " + new Date(out.tosAcceptedAt).toLocaleDateString() + ".";
    check.checked = true;
    check.disabled = true;
    btn.hidden = true;
    revoke.hidden = false;
  } else {
    note.hidden = !staleAccept;
    if (staleAccept) note.textContent = "The Lister terms were updated — please re-accept.";
    check.checked = false;
    check.disabled = false;
    btn.hidden = false;
    btn.disabled = true;
    revoke.hidden = true;
  }
}

function wireConsent() {
  const check = document.getElementById("tosCheck");
  const btn = document.getElementById("acceptTos");
  const revoke = document.getElementById("revokeTos");
  check.addEventListener("change", () => {
    btn.disabled = !check.checked;
  });
  btn.addEventListener("click", async () => {
    if (!check.checked) return;
    await chrome.storage.local.set({
      tosAcceptedAt: new Date().toISOString(),
      tosVersion: TOS_VERSION,
    });
    renderConsent();
  });
  revoke.addEventListener("click", async () => {
    await chrome.storage.local.remove(["tosAcceptedAt", "tosVersion"]);
    renderConsent();
  });
}

function renderSellerSections(caps) {
  const seller = document.getElementById("sellerSection");
  const locked = document.getElementById("sellerLockedSection");
  if (caps && caps.sellerEnabled) {
    seller.hidden = false;
    locked.hidden = true;
    renderPlatforms();
    renderConsent();
  } else if (caps && caps.authenticated) {
    // Signed in but no active FlipDesk plan → honest upsell, not a dead section.
    seller.hidden = true;
    locked.hidden = false;
  } else {
    seller.hidden = true;
    locked.hidden = true;
  }
}

// ── sign-in / connect ───────────────────────────────────────────────────────
function wireAccount() {
  const connect = document.getElementById("connectBtn");
  const disconnect = document.getElementById("disconnectBtn");
  connect.addEventListener("click", () => {
    // Launches the US-1838 token flow: the connect page mints an extension token
    // (POST /api/buyer/extension-token) and posts it back via GT_SET_TOKEN so this
    // install becomes account-scoped. `ext` lets the page target this extension id.
    const url = SITE + "/connect-extension?ext=" + encodeURIComponent(chrome.runtime.id) +
      "&utm_source=extension&utm_medium=popup";
    try {
      chrome.tabs.create({ url });
    } catch (_e) {
      window.open(url, "_blank", "noopener");
    }
  });
  disconnect.addEventListener("click", async () => {
    await chrome.storage.local.remove("gtBuyerToken");
    const caps = await send({ type: "GT_GET_CAPABILITIES", force: true });
    applyCapabilities(caps || {});
  });
}

function applyCapabilities(caps) {
  renderAccount(caps);
  renderSellerSections(caps);
}

// ── boot ─────────────────────────────────────────────────────────────────────
(async function () {
  initStaticLinks();
  wireAccount();
  wireConsent();
  // Render research immediately (works offline / anonymous), then fold in the
  // account-driven sections once entitlements resolve.
  await Promise.all([initResearch(), renderReads()]);
  const caps = await send({ type: "GT_GET_CAPABILITIES", force: true });
  applyCapabilities(caps || { research: true, authenticated: false, sellerEnabled: false });
})();
