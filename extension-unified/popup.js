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
const ext = globalThis.browser || globalThis.chrome;

// US-1753 AC3: every link out of this popup is a funnel entry, so it is built by
// the shared helper (attribution.js) rather than by string concatenation here.
// The helper is the only place gradethread.com is spelled out, and
// test/attribution.test.cjs fails the build on any bare one that creeps back in.
const ATTR = self.GT_ATTRIBUTION;

// US-1885 AC3: versioned Lister consent — bump this when the Lister terms change
// and every seller is re-prompted (an accepted older version no longer counts).
const TOS_VERSION = "2026-07-13";

const MARKETPLACE_HOST_RE =
  /(^|\.)(ebay\.|poshmark\.|grailed\.com|mercari\.com|depop\.com|vinted\.)/i;

// One list, shared by the platform rows and the last-job line. The header of this
// file warns about hand-maintained duplicates that drift — this is that list.
const PLATFORM_LABELS = { poshmark: "Poshmark", mercari: "Mercari", grailed: "Grailed" };

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
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) return new URL(tab.url).host;
  } catch (_e) { /* no activeTab access */ }
  return null;
}

function send(msg) {
  // Promise form works on both Chrome (MV3) and Firefox (browser.*); a failure
  // (worker asleep / no receiver) resolves to null rather than rejecting.
  try {
    return Promise.resolve(ext.runtime.sendMessage(msg)).catch(() => null);
  } catch (_e) {
    return Promise.resolve(null);
  }
}

// ── links / version ────────────────────────────────────────────────────────
function initStaticLinks() {
  const version = document.getElementById("version");
  version.textContent = "v" + ext.runtime.getManifest().version;
  document.getElementById("privacy").href = ATTR.siteUrl("/privacy", "popup");
  document.getElementById("help").href = ATTR.siteUrl("/", "popup");
  document.getElementById("termsLink").href = ATTR.siteUrl("/acceptable-use", "popup");
  const upgrade = document.getElementById("upgradeBtn");
  if (upgrade) {
    upgrade.href = ATTR.siteUrl("/pricing", "popup", { campaign: "lister-upgrade" });
  }
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
  const { autoRun, disabledHosts, scanMode } = await ext.storage.local.get([
    "autoRun",
    "disabledHosts",
    "scanMode",
  ]);
  const disabled = Array.isArray(disabledHosts) ? disabledHosts : [];

  const autoEl = document.getElementById("autoRun");
  autoEl.checked = Boolean(autoRun);
  autoEl.addEventListener("change", () => {
    ext.storage.local.set({ autoRun: autoEl.checked });
  });

  // US-2237: scan mode defaults ON, so it reads `!== false` rather than
  // Boolean() — the opposite of autoRun directly above. autoRun spends a Vision
  // call per listing and must be opted into; a scan spends none. Switching it ON
  // REMOVES the key instead of storing true, so "default" and "explicitly on"
  // stay the same stored state and a later default change can't strand anyone.
  const scanEl = document.getElementById("scanMode");
  scanEl.checked = scanMode !== false;
  scanEl.addEventListener("change", async () => {
    if (scanEl.checked) await ext.storage.local.remove("scanMode");
    else await ext.storage.local.set({ scanMode: false });
  });

  // US-1880 (AC3): opt-in selector-failure reporting. Unchecked unless the key
  // is explicitly true, so absent/unset reads as OFF; unchecking removes the key
  // outright rather than storing false, so a revoke leaves nothing behind.
  const telemetryEl = document.getElementById("selectorTelemetry");
  const { selectorTelemetry } = await ext.storage.local.get("selectorTelemetry");
  telemetryEl.checked = Boolean(selectorTelemetry);
  telemetryEl.addEventListener("change", async () => {
    if (telemetryEl.checked) await ext.storage.local.set({ selectorTelemetry: true });
    else await ext.storage.local.remove("selectorTelemetry");
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
      const cur = (await ext.storage.local.get("disabledHosts")).disabledHosts || [];
      const set = new Set(Array.isArray(cur) ? cur : []);
      if (box.checked) set.delete(host);
      else set.add(host);
      await ext.storage.local.set({ disabledHosts: Array.from(set) });
    });
  }
}

async function renderReads() {
  const ul = document.getElementById("reads");
  const { recentReads } = await ext.storage.local.get("recentReads");
  const list = Array.isArray(recentReads) ? recentReads : [];
  if (!list.length) return; // keep the empty-state <li>
  ul.textContent = "";
  for (const r of list) {
    const li = document.createElement("li");
    li.className = "pop-read";
    const a = document.createElement("a");
    // r.url is the marketplace listing this read came from — somebody else's
    // site, so it is never rewritten. Only the fallback is ours, and it is
    // tagged like every other link out of here.
    a.href = r.url || ATTR.siteUrl("/", "popup", { campaign: "recent-reads" });
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

// ── US-2240: the compare tray's entry point ─────────────────────────────────
// Shown only when something is pinned — an "Open compare (0)" button is a dead
// door, and the overlay is where pinning actually happens.
async function renderCompareLink() {
  const btn = document.getElementById("openCompare");
  const count = document.getElementById("compareCount");
  let list = [];
  try {
    const out = await ext.storage.local.get(self.GT_CC_TRAY.KEY);
    list = (out && out[self.GT_CC_TRAY.KEY]) || [];
  } catch (_e) { /* unreadable — leave the button hidden */ }
  if (!Array.isArray(list) || !list.length) return;
  count.textContent = String(list.length);
  btn.hidden = false;
  btn.addEventListener("click", () => {
    ext.tabs.create({ url: ext.runtime.getURL("compare.html") });
  });
}

// ── US-2239: "By seller" ────────────────────────────────────────────────────
//
// The same recentReads list, grouped by who was selling. This is the whole point
// of storing the seller with each read: a shopper who has read four items from
// one closet has learned something about that closet, and until now the
// extension threw it away every time the overlay closed.
//
// Local, always. groupBySeller is pure and runs over storage.local — no request
// is made, and no seller handle has ever left this device.
async function renderSellers() {
  const ul = document.getElementById("sellers");
  const empty = document.getElementById("sellersEmpty");
  const note = document.getElementById("sellersNote");
  const { recentReads } = await ext.storage.local.get("recentReads");
  const rows = self.GT_CC_SELLER.groupBySeller(recentReads);

  ul.textContent = "";
  if (!rows.length) {
    // Deliberately not "no sellers": the list is empty because nobody has been
    // read TWICE yet, and saying so tells the shopper how to fill it.
    const li = document.createElement("li");
    li.className = "pop-empty";
    li.textContent = self.GT_CC_SELLER.STRINGS.noneYet;
    ul.appendChild(li);
    note.hidden = true;
    empty.hidden = true;
    return;
  }
  note.hidden = false;

  for (const row of rows) {
    const li = document.createElement("li");
    li.className = "pop-read";

    const score = document.createElement("span");
    score.className = "pop-read-score " + scoreClass(row.stats.avgOverall);
    score.textContent = row.stats.avgOverall.toFixed(1);

    const body = document.createElement("span");
    body.className = "pop-read-body";
    const title = document.createElement("div");
    title.className = "pop-read-title";
    title.textContent = row.seller;
    const meta = document.createElement("div");
    meta.className = "pop-read-meta";
    // The copy line when there is a claim gap worth naming; otherwise the plain
    // counts. Either way it is phrased as what the SHOPPER found.
    meta.textContent = row.copy ||
      (row.marketplace + " · " + row.stats.reads + " reads · " + timeAgo(row.stats.lastAt));
    body.appendChild(title);
    body.appendChild(meta);

    li.appendChild(score);
    li.appendChild(body);
    ul.appendChild(li);
  }
}

function wireHistoryTabs() {
  const tabReads = document.getElementById("tabReads");
  const tabSellers = document.getElementById("tabSellers");
  const reads = document.getElementById("reads");
  const sellers = document.getElementById("sellers");
  const note = document.getElementById("sellersNote");
  let sellersRendered = false;

  function show(which) {
    const onSellers = which === "sellers";
    reads.hidden = onSellers;
    sellers.hidden = !onSellers;
    note.hidden = !onSellers || !sellersRendered;
    tabReads.classList.toggle("is-on", !onSellers);
    tabSellers.classList.toggle("is-on", onSellers);
    tabReads.setAttribute("aria-selected", String(!onSellers));
    tabSellers.setAttribute("aria-selected", String(onSellers));
  }

  tabReads.addEventListener("click", () => show("reads"));
  tabSellers.addEventListener("click", async () => {
    // Rendered on first open rather than at boot: it groups the whole read
    // history, and the popup should paint before doing that work.
    if (!sellersRendered) {
      await renderSellers();
      sellersRendered = true;
    }
    show("sellers");
  });
}

// ── seller section ──────────────────────────────────────────────────────────
// US-1885 AC1: platform status from the REAL versioned selectors config.
function renderPlatforms() {
  const ul = document.getElementById("platforms");
  ul.textContent = "";
  const cfg = self.GT_LISTER_SELECTORS || {};
  const order = ["poshmark", "mercari", "grailed"];
  const labels = PLATFORM_LABELS;
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

// US-1885 AC1: the last Lister job outcome.
//
// The popup showed no job state at all, which is worst exactly when it matters: a
// cross-post that timed out, or a delist we couldn't verify, left the seller with
// nowhere to find out what happened. The background records each outcome to
// storage.local (see writeLastJob), so this is a read — no message round trip, and
// it still works while the worker is asleep.
const LAST_JOB_KEY = "listerLastJob";

// Each outcome gets its own copy because they call for different actions: a
// timeout means retry, an unverified delist means go and CHECK the marketplace,
// and a login wall means finish signing in. Collapsing them into "failed" is how
// the seller ends up double-posting.
const JOB_OUTCOME = {
  done: { cls: "on", label: "Done" },
  pending: { cls: "warn", label: "Waiting" },
  timedOut: { cls: "off", label: "Timed out" },
  tabClosed: { cls: "off", label: "Tab closed" },
  unverified: { cls: "warn", label: "Unconfirmed" },
  failed: { cls: "off", label: "Failed" },
};

function jobWhat(rec) {
  const platform = PLATFORM_LABELS[rec.platform] || rec.platform || "marketplace";
  const verb = rec.kind === "delist" ? "delist" : "cross-post";
  return platform + " " + verb;
}

async function renderLastJob() {
  const block = document.getElementById("lastJobBlock");
  if (!block) return;
  let rec = null;
  try {
    const out = await ext.storage.local.get(LAST_JOB_KEY);
    rec = out && out[LAST_JOB_KEY];
  } catch (_e) { /* unreadable — show nothing rather than a wrong state */ }

  if (!rec || !rec.platform) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const meta = JOB_OUTCOME[rec.outcome] || JOB_OUTCOME.failed;
  const status = document.getElementById("lastJobStatus");
  status.className = "pop-status " + meta.cls;
  // A late success is still a success, but the seller needs to know we'd already
  // told them it timed out — otherwise they post it a second time.
  status.textContent = rec.late && rec.ok ? "Done (late)" : meta.label;

  document.getElementById("lastJobWhat").textContent = jobWhat(rec);
  document.getElementById("lastJobWhen").textContent = rec.at ? timeAgo(rec.at) : "";

  const err = document.getElementById("lastJobError");
  if (rec.error && !rec.ok) {
    err.hidden = false;
    err.textContent = rec.error;
  } else if (rec.late && rec.ok) {
    err.hidden = false;
    err.textContent =
      "This finished after we reported a timeout — check the marketplace before posting it again.";
  } else {
    err.hidden = true;
    err.textContent = "";
  }
}

// US-1885 AC1: pending cross-listing delists.
//
// When an item sells on one marketplace, its siblings on Poshmark/Mercari/Grailed
// have no delist API — they can only be ended in the seller's own browser, which
// is exactly what this extension is. Until now it never showed the queue, so a
// sold item stayed live until the seller happened to open the SaaS and look.
//
// Unlike renderLastJob (a storage read) this needs the network, so it goes
// through the worker. Every non-OK state gets its OWN copy: rendering "nothing
// to end" for a expired token, a lapsed plan, or an offline fetch would be a
// false all-clear on the one screen a seller checks to avoid double-selling.
const DELIST_REASON = {
  "signed-out": "Sign in to see listings that still need ending.",
  "no-plan": "A FlipDesk plan is required to manage cross-listings.",
  error: "Couldn't check for listings that need ending. Try again in a moment.",
};

async function renderPendingDelists(caps) {
  const block = document.getElementById("delistBlock");
  if (!block) return;
  // Seller-only surface; don't even ask the server otherwise.
  if (!caps || !caps.sellerEnabled) {
    block.hidden = true;
    return;
  }

  const list = document.getElementById("delistList");
  const note = document.getElementById("delistNote");
  const count = document.getElementById("delistCount");
  list.textContent = "";

  const res = await send({ type: "GT_GET_PENDING_DELISTS" });

  if (!res || !res.ok) {
    const reason = (res && res.reason) || "error";
    block.hidden = false;
    count.textContent = "";
    note.hidden = false;
    note.textContent = DELIST_REASON[reason] || DELIST_REASON.error;
    return;
  }

  const pending = Array.isArray(res.pending) ? res.pending : [];
  if (!pending.length) {
    // Nothing pending is genuinely good news, and only shown when we actually
    // know it — every other path above returns before here.
    block.hidden = true;
    return;
  }

  block.hidden = false;
  count.textContent = String(pending.length);

  // A listing we cannot open cannot be ended by the extension. Say so plainly
  // rather than offering an action that would silently do nothing.
  const manual = pending.filter((p) => !p.auto_delistable).length;
  if (manual) {
    note.hidden = false;
    note.textContent = manual === pending.length
      ? "These need ending by hand on the marketplace — GradeThread doesn't have a live link for them."
      : manual + " of these need ending by hand (no live link saved).";
  } else {
    note.hidden = true;
    note.textContent = "";
  }

  for (const p of pending) {
    const li = document.createElement("li");
    li.className = "pop-delist";

    const left = document.createElement("div");
    left.className = "pop-delist-body";

    const title = document.createElement("span");
    title.className = "pop-delist-title";
    // item_title is nullable in the DB; never render a bare "null".
    title.textContent = p.item_title || "Untitled item";

    const meta = document.createElement("span");
    meta.className = "pop-delist-meta";
    const platform = PLATFORM_LABELS[p.platform] || p.platform || "marketplace";
    meta.textContent = p.requested_at ? platform + " · " + timeAgo(p.requested_at) : platform;

    left.appendChild(title);
    left.appendChild(meta);
    li.appendChild(left);

    if (p.auto_delistable && p.listing_url) {
      const open = document.createElement("a");
      open.className = "pop-linkbtn";
      open.href = p.listing_url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "Open";
      li.appendChild(open);
    } else {
      const badge = document.createElement("span");
      badge.className = "pop-status warn";
      badge.textContent = "By hand";
      li.appendChild(badge);
    }
    list.appendChild(li);
  }
}

// US-1885 AC3: versioned + revocable consent.
async function renderConsent() {
  const out = await ext.storage.local.get(["tosAcceptedAt", "tosVersion"]);
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
    await ext.storage.local.set({
      tosAcceptedAt: new Date().toISOString(),
      tosVersion: TOS_VERSION,
    });
    renderConsent();
  });
  revoke.addEventListener("click", async () => {
    await ext.storage.local.remove(["tosAcceptedAt", "tosVersion"]);
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
    renderLastJob();
    renderPendingDelists(caps);
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
    const url = ATTR.siteUrl("/connect-extension", "popup", {
      campaign: "connect",
      params: { ext: ext.runtime.id },
    });
    try {
      ext.tabs.create({ url });
    } catch (_e) {
      window.open(url, "_blank", "noopener");
    }
  });
  disconnect.addEventListener("click", async () => {
    await ext.storage.local.remove("gtBuyerToken");
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
  wireHistoryTabs();
  renderCompareLink();
  // Render research immediately (works offline / anonymous), then fold in the
  // account-driven sections once entitlements resolve.
  await Promise.all([initResearch(), renderReads()]);
  const caps = await send({ type: "GT_GET_CAPABILITIES", force: true });
  applyCapabilities(caps || { research: true, authenticated: false, sellerEnabled: false });
})();
