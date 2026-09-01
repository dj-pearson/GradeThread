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

// US-1757 AC2: the opt-in usage tally (usage-telemetry.js). The counters live in
// the background worker — this file only reports clicks and owns the toggle.
const USAGE = self.GT_USAGE;

// US-1881 AC3: Firefox's opt-in host permissions. On Chrome every probe below
// answers "granted" (Chrome grants host_permissions at install), so none of this
// renders there — it exists for the Firefox install that looks healthy and does
// nothing. See host-permissions.js for the three platform rules it encodes.
const PERMS = self.GT_HOST_PERMS;

// US-1885 AC3: versioned Lister consent — bump this when the Lister terms change
// and every seller is re-prompted (an accepted older version no longer counts).
const TOS_VERSION = "2026-07-13";

const MARKETPLACE_HOST_RE =
  /(^|\.)(ebay\.|poshmark\.|grailed\.com|mercari\.com|depop\.com|vinted\.)/i;

// One list, shared by the platform rows and the last-job line. The header of this
// file warns about hand-maintained duplicates that drift — this is that list.
//
// 2026-08-11: it had drifted. Vinted went live in selectors.js and was missing
// here, so it never appeared in the platform rows AT ALL and its last-job line
// read "vinted cross-post". Facebook was missing for the same reason and is
// added too — it renders honestly as "Coming soon" off its own `enabled: false`,
// which is better than a supported platform being invisible.
//
// The ORDER below drives the rows. It is derived against the real config, so a
// key with no entry in selectors.js is skipped rather than rendering an empty row.
const PLATFORM_LABELS = {
  poshmark: "Poshmark",
  mercari: "Mercari",
  grailed: "Grailed",
  vinted: "Vinted",
  facebook: "Facebook",
};
const PLATFORM_ORDER = ["poshmark", "mercari", "grailed", "vinted", "facebook"];

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

async function activeTabInfo() {
  try {
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) return { id: tab.id, host: new URL(tab.url).host };
  } catch (_e) { /* no activeTab access */ }
  return { id: null, host: null };
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

// ── Firefox opt-in host permissions (US-1881 AC3) ───────────────────────────
//
// The whole point is that a missing host permission produces NO error anywhere,
// so this is the only surface that can tell the person what happened. It is
// shown only when the probe says access is missing — which on Chrome it never
// does, so this block is invisible there rather than gated on a browser sniff.
//
// The click handler calls requestHostAccess FIRST and awaits nothing before it:
// permissions.request() is refused outside a user gesture, and an await ends the
// gesture. On a grant the tab is reloaded, because Firefox injects a
// newly-permitted content script on the next navigation only — without that the
// page they are looking at stays as blank as it was before they said yes.
async function initHostPermission(host, tabId) {
  const wrap = document.getElementById("hostPermWrap");
  const text = document.getElementById("hostPermText");
  const btn = document.getElementById("hostPermBtn");
  if (!wrap || !text || !btn || !PERMS) return;

  if (await PERMS.hasHostAccess(ext, host)) return;

  text.textContent =
    "This browser has not given GradeThread access to " +
    host +
    " yet, so the condition read cannot run here. Allow it and the page reloads " +
    "with the GradeThread pill in place.";
  btn.textContent = "Allow on " + host;
  wrap.hidden = false;

  btn.addEventListener("click", () => {
    const granted = PERMS.requestHostAccess(ext, host); // FIRST — keeps the gesture
    btn.disabled = true;
    granted.then(async (ok) => {
      if (!ok) {
        btn.disabled = false;
        text.textContent =
          "Access to " +
          host +
          " was not granted, so the condition read stays off on this site. You " +
          "can allow it here any time, or from Firefox's Add-ons manager.";
        return;
      }
      wrap.hidden = true;
      await PERMS.reloadTab(ext, tabId);
      window.close();
    });
  });
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

  // US-1757 (AC2): opt-in usage counts. Same shape as the toggle above, with one
  // extra step on revoke — the half-finished batch is deleted too. Leaving it
  // would let a later opt-in send activity from the period the user said no to,
  // which is the one way an off switch can still be dishonest.
  const usageEl = document.getElementById("usageTelemetry");
  const usageStored = await ext.storage.local.get(USAGE.CONSENT_KEY);
  usageEl.checked = Boolean(usageStored && usageStored[USAGE.CONSENT_KEY]);
  usageEl.addEventListener("change", async () => {
    if (usageEl.checked) await ext.storage.local.set({ [USAGE.CONSENT_KEY]: true });
    else await ext.storage.local.remove([USAGE.CONSENT_KEY, USAGE.BATCH_KEY]);
  });

  const { id: tabId, host } = await activeTabInfo();
  if (host && MARKETPLACE_HOST_RE.test(host)) {
    await initHostPermission(host, tabId);
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

// ── the three main tabs ─────────────────────────────────────────────────────
//
// The popup was one scroll holding research settings, reads, seller consent,
// a sharing meter and a diagnostic. Everyone scrolled past most of it.
//
// `userPicked` is the whole subtlety here. The default tab is chosen from
// entitlements, which arrive AFTER the first paint (renderAccount is awaited on
// a network call). Without the flag, a seller who opens the popup and taps
// Settings within that window gets yanked back to Selling when the response
// lands — the UI overriding a deliberate choice, which reads as a bug even
// though the tab it picked was "right".
const TABS = ["Reads", "Selling", "Settings"];
let userPicked = false;

function selectTab(name) {
  for (const t of TABS) {
    const btn = document.getElementById("nav" + t);
    const panel = document.getElementById("panel" + t);
    if (!btn || !panel) continue;
    const on = t === name;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    panel.hidden = !on;
  }
}

function wireMainTabs() {
  for (const t of TABS) {
    const btn = document.getElementById("nav" + t);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      userPicked = true;
      selectTab(t);
    });
  }
}

/** Open on the tab this person came for. Never overrides a manual choice. */
function selectDefaultTab(caps) {
  if (userPicked) return;
  selectTab(caps && caps.sellerEnabled ? "Selling" : "Reads");
}

/** The pending-delist count on the Selling tab. Hidden at zero — a "0" badge is
 *  noise, and this one is styled to mean "act on this". */
function setSellingCount(n) {
  const el = document.getElementById("navSellingCount");
  if (!el) return;
  if (!n || n < 1) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = String(n);
}

// ── seller section ──────────────────────────────────────────────────────────
// US-1885 AC1: platform status from the REAL versioned selectors config.
function renderPlatforms() {
  const ul = document.getElementById("platforms");
  ul.textContent = "";
  const cfg = self.GT_LISTER_SELECTORS || {};
  const labels = PLATFORM_LABELS;
  for (const key of PLATFORM_ORDER) {
    const p = cfg[key];
    if (!p) continue;
    // 2026-08-11: THREE states, not two.
    //
    // "Enabled" used to cover both a channel that can list AND end a listing,
    // and one that can only list. Those are not the same promise. Grailed
    // cannot auto-delist (a native browser dialog, permanently) and Vinted
    // cannot yet (unverified) — so a seller reading "Enabled" would expect a
    // sold item's sibling to come down on its own, and it will not. They get a
    // reminder instead, and this row is where that expectation is set.
    const canList = p.enabled === true;
    const canDelist = canList && !!(p.delist && p.delist.enabled);
    const li = document.createElement("li");
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = labels[key] || key;
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = !canList
      ? "not yet enabled"
      : "selectors v" + p.version + (p.lastVerified ? " · verified " + p.lastVerified : "") +
        // Short on purpose. The badge already says "List only"; this is the
        // consequence, and at three clauses the line wrapped to two and turned
        // the platform list into a wall.
        (canDelist ? "" : " · you end it by hand");
    left.appendChild(name);
    left.appendChild(metaEl);
    const badge = document.createElement("span");
    badge.className = "pop-status " + (canDelist ? "on" : canList ? "warn" : "off");
    badge.textContent = canDelist ? "Enabled" : canList ? "List only" : "Coming soon";
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

// US-2699: per-channel sold-sync health in the popup.
//
// Reads the shared projection through the extension's own door
// (/api/grading/public/sync-status), so this and the Marketplaces page can never
// disagree about whether a channel is working. They disagreeing is the failure
// lib/pending-delists.ts documents, and it matters more here: sold-sync is what
// stands between the seller and a double sale.
//
// "Sync now" does NOT poll. It re-reads the CURRENT tab if that tab is already a
// page sold-sync covers, and otherwise tells the seller which page to open. A
// button that opened a marketplace tab would be the scheduled poll (US-2701)
// wearing a different name, and that feature carries its own consent.
function syncStateLine(ch) {
  switch (ch.status) {
    case "ok":
      return ch.listings_seen === null
        ? "Syncing"
        : "Syncing — " + ch.listings_seen + " listing" +
          (ch.listings_seen === 1 ? "" : "s") + " seen";
    case "failing":
      return "Sync failing — nothing was recorded";
    case "not_signed_in":
      return "Not signed in — nothing was recorded";
    default:
      return "Not synced yet";
  }
}

// "Sync now": re-read the tab the seller is already on, if it is one sold-sync
// covers. It never opens or navigates a tab — a button that did would be the
// scheduled poll (US-2701) under another name, and that feature carries its own
// consent for exactly that reason.
//
// The honest failure is the important half. On a page sold-sync does not cover
// there is nothing to read, so the button says which page to open rather than
// reporting a successful sync of nothing.
async function runSyncNow() {
  const btn = document.getElementById("syncNowBtn");
  const note = document.getElementById("syncNote");
  if (!btn) return;
  btn.disabled = true;
  try {
    let tabs = [];
    try {
      tabs = await ext.tabs.query({ active: true, currentWindow: true });
    } catch (_e) { /* no tabs access in this context */ }
    const tab = tabs && tabs[0];
    let answered = null;
    if (tab && tab.id != null) {
      try {
        answered = await ext.tabs.sendMessage(tab.id, { type: "GT_SYNC_RUN" });
      } catch (_e) {
        answered = null; // no sold-sync content script on this page
      }
    }
    if (note) {
      note.hidden = false;
      note.textContent = answered && answered.ok
        ? "Read this page. Anything new shows up in a moment."
        : "Open your own sold page or closet on a supported marketplace, then press this again.";
    }
    if (answered && answered.ok) {
      const caps = await send({ type: "GT_GET_CAPABILITIES", force: true });
      await renderSyncStatus(caps);
    }
  } finally {
    btn.disabled = false;
  }
}

// US-2701: the scheduled poll's consent and cadence.
//
// The Accept button stays disabled until the checkbox is ticked, and the cadence
// control only exists after acceptance — so the first thing a seller meets is
// the sentences, never the switch.
async function renderPollConsent(caps) {
  const block = document.getElementById("pollBlock");
  if (!block) return;
  if (!caps || !caps.sellerEnabled) {
    block.hidden = true;
    return;
  }

  const state = await send({ type: "GT_POLL_STATE" });
  if (!state || !state.available) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const status = document.getElementById("pollStatus");
  const consent = document.getElementById("pollConsent");
  const controls = document.getElementById("pollControls");
  const terms = document.getElementById("pollTerms");
  const interval = document.getElementById("pollInterval");

  if (state.accepted && state.enabled) {
    status.textContent = "On";
    consent.hidden = true;
    controls.hidden = false;
    interval.value = String(state.intervalMin);
  } else {
    status.textContent = "Off";
    consent.hidden = false;
    controls.hidden = true;
    // Rendered from the background's copy of the terms, never from this markup.
    terms.textContent = "";
    for (const term of state.terms || []) {
      const li = document.createElement("li");
      li.textContent = term;
      terms.appendChild(li);
    }
    const check = document.getElementById("pollCheck");
    const accept = document.getElementById("pollAccept");
    if (check) check.checked = false;
    if (accept) accept.disabled = true;
  }
}

async function renderSyncStatus(caps) {
  const block = document.getElementById("syncBlock");
  if (!block) return;

  // Seller-only surface; don't even ask the server otherwise.
  if (!caps || !caps.sellerEnabled) {
    block.hidden = true;
    return;
  }

  const list = document.getElementById("syncList");
  const note = document.getElementById("syncNote");
  list.textContent = "";

  const res = await send({ type: "GT_SYNC_STATUS" });
  if (!res || !res.ok || !Array.isArray(res.channels)) {
    block.hidden = false;
    note.hidden = false;
    note.textContent = "Couldn't check sync status.";
    return;
  }

  const channels = res.channels;
  if (!channels.length) {
    block.hidden = true;
    return;
  }

  block.hidden = false;
  const trouble = channels.filter(
    (c) => c.status === "failing" || c.status === "not_signed_in",
  ).length;
  if (trouble) {
    note.hidden = false;
    note.textContent = trouble === 1
      ? "One channel needs a look. Nothing was recorded from it."
      : trouble + " channels need a look. Nothing was recorded from them.";
  } else {
    note.hidden = true;
    note.textContent = "";
  }

  for (const ch of channels) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "pop-delist-title";
    name.textContent = ch.platform;
    const state = document.createElement("span");
    state.className = "pop-delist-meta";
    state.textContent = syncStateLine(ch);
    li.appendChild(name);
    li.appendChild(state);
    list.appendChild(li);
  }
}

// US-2701: bind the scheduled-poll consent controls.
try {
  const _pollCheck = document.getElementById("pollCheck");
  const _pollAccept = document.getElementById("pollAccept");
  if (_pollCheck && _pollAccept) {
    _pollCheck.addEventListener("change", function () {
      _pollAccept.disabled = !_pollCheck.checked;
    });
    _pollAccept.addEventListener("click", function () {
      void (async function () {
        await send({ type: "GT_POLL_ACCEPT" });
        const caps = await send({ type: "GT_GET_CAPABILITIES", force: true });
        await renderPollConsent(caps);
      })();
    });
  }
  const _pollRevoke = document.getElementById("pollRevoke");
  if (_pollRevoke) {
    _pollRevoke.addEventListener("click", function () {
      void (async function () {
        await send({ type: "GT_POLL_REVOKE" });
        const caps = await send({ type: "GT_GET_CAPABILITIES", force: true });
        await renderPollConsent(caps);
      })();
    });
  }
  const _pollInterval = document.getElementById("pollInterval");
  if (_pollInterval) {
    _pollInterval.addEventListener("change", function () {
      void send({ type: "GT_POLL_INTERVAL", minutes: Number(_pollInterval.value) });
    });
  }
} catch (_e) { /* no popup markup in this context */ }

// US-2699: bind the Sync now control. Guarded because popup.js is also read as
// text by zero-dep guards that have no DOM.
try {
  const _syncBtn = document.getElementById("syncNowBtn");
  if (_syncBtn) _syncBtn.addEventListener("click", function () { void runSyncNow(); });
} catch (_e) { /* no popup markup in this context */ }

async function renderPendingDelists(caps) {
  const block = document.getElementById("delistBlock");
  if (!block) return;
  // Seller-only surface; don't even ask the server otherwise.
  if (!caps || !caps.sellerEnabled) {
    block.hidden = true;
    setSellingCount(0);
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
    // No badge on an unknown count. A tab badge is a claim about how many
    // things need ending; "we could not find out" is not zero and must not
    // render as the all-clear this whole block exists to avoid.
    setSellingCount(0);
    return;
  }

  const pending = Array.isArray(res.pending) ? res.pending : [];
  if (!pending.length) {
    // Nothing pending is genuinely good news, and only shown when we actually
    // know it — every other path above returns before here.
    block.hidden = true;
    setSellingCount(0);
    return;
  }

  block.hidden = false;
  count.textContent = String(pending.length);
  setSellingCount(pending.length);

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

// US-9202: edits waiting to reach an extension channel. Same shape as the
// delist queue above, same honesty rules: an unknown count is not zero, and a
// channel whose revise flow is not switched on says "by hand" with a link.
const REVISE_FIELD_LABELS = { price: "price", title: "title", description: "description", photos: "photos" };

async function renderPendingRevises(caps) {
  const block = document.getElementById("reviseBlock");
  if (!block) return;
  if (!caps || !caps.sellerEnabled) {
    block.hidden = true;
    return;
  }
  const list = document.getElementById("reviseList");
  const note = document.getElementById("reviseNote");
  const count = document.getElementById("reviseCount");
  list.textContent = "";

  const res = await send({ type: "GT_GET_PENDING_REVISES" });
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
    block.hidden = true;
    return;
  }
  block.hidden = false;
  count.textContent = String(pending.length);

  const SEL = (self.GT_LISTER_SELECTORS) || {};
  const canRun = (p) => Boolean(
    p.auto_revisable && SEL[p.platform] && SEL[p.platform].revise && SEL[p.platform].revise.enabled,
  );
  const manual = pending.filter((p) => !canRun(p)).length;
  if (manual) {
    note.hidden = false;
    note.textContent = manual === pending.length
      ? "These need updating by hand on the marketplace — edit sync isn't switched on for that channel yet, or GradeThread has no live link."
      : manual + " of these need updating by hand.";
  } else {
    note.hidden = false;
    note.textContent = "GradeThread applies these in a background tab within a few minutes.";
  }

  for (const p of pending) {
    const li = document.createElement("li");
    li.className = "pop-delist";
    const left = document.createElement("div");
    left.className = "pop-delist-body";
    const title = document.createElement("span");
    title.className = "pop-delist-title";
    title.textContent = p.item_title || "Untitled item";
    const meta = document.createElement("span");
    meta.className = "pop-delist-meta";
    const platform = PLATFORM_LABELS[p.platform] || p.platform || "marketplace";
    const fields = (Array.isArray(p.fields) ? p.fields : []).map((f) => REVISE_FIELD_LABELS[f] || f).join(", ");
    meta.textContent = platform + " · " + (fields || "edit") +
      (p.queued_at ? " · stale " + timeAgo(p.queued_at) : "");
    left.appendChild(title);
    left.appendChild(meta);
    li.appendChild(left);
    if (p.listing_url) {
      const open = document.createElement("a");
      open.className = "pop-linkbtn";
      open.href = p.listing_url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = canRun(p) ? "Open" : "Edit there";
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

// ── US-2482: Poshmark engagement — the meter and its own clickwrap ──────────
//
// The state lives in the BACKGROUND, not here. The popup asks for it and renders
// it. That is deliberate: the caps and the consent record are enforced where the
// runs are gated, and a popup that kept its own copy would eventually disagree
// with the thing doing the enforcing — and the seller would believe the popup.
async function renderEngagement() {
  const block = document.getElementById("engageBlock");
  if (!block) return;

  let state = null;
  try {
    state = await Promise.resolve(ext.runtime.sendMessage({ type: "GT_ENGAGE_STATE" }));
  } catch (_e) { /* worker asleep — leave the block hidden rather than guess */ }
  if (!state || !state.ok) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const status = document.getElementById("engageStatus");
  const consent = document.getElementById("engageConsent");
  const revoke = document.getElementById("engageRevoke");
  const termsList = document.getElementById("engageTerms");

  if (state.accepted) {
    status.textContent = "On";
    consent.hidden = true;
    revoke.hidden = false;
  } else {
    status.textContent = "Off";
    consent.hidden = false;
    revoke.hidden = true;
    // Rendered from the background's copy of the terms rather than written into
    // this markup, so there is exactly one place the four statements live and a
    // test can assert none of them went missing.
    termsList.textContent = "";
    for (const term of state.terms || []) {
      const li = document.createElement("li");
      li.textContent = term;
      termsList.appendChild(li);
    }
  }

  // The meter renders whether or not sharing is on — a seller deciding whether
  // to accept should be able to see the limit they would be agreeing to.
  const m = state.meter;
  const meter = document.getElementById("engageMeter");
  if (m) {
    meter.hidden = false;
    document.getElementById("engageMeterLabel").textContent = m.label;
    document.getElementById("engageMeterPct").textContent = m.pct + "%";
    const fill = document.getElementById("engageMeterFill");
    fill.style.width = Math.max(2, m.pct) + "%";
    fill.dataset.state = m.atCap ? "full" : m.pct >= 80 ? "near" : "ok";
    document.getElementById("engageMeterNote").textContent = m.note || "";
  } else {
    meter.hidden = true;
  }

  renderEngageRun(state);
}

/** How the last run (or the one in flight) reads as one line. */
function engageRunLine(state) {
  if (state.run) {
    return "Running " + state.run.action + " in your closet tab. Leave the tab open.";
  }
  const last = state.lastRun;
  if (!last) return "";
  if (last.paused) {
    return last.error || "The run paused and is waiting for you in the tab.";
  }
  if (last.ok === false) return last.error || "The last run could not start.";
  const n = typeof last.done === "number" ? last.done : 0;
  const what = (last.action || "action") + (n === 1 ? "" : "s");
  if (last.stoppedBy === "daily_cap") return "Last run: " + n + " " + what + ", then today's cap.";
  if (last.stoppedBy === "stopped") return "Last run: stopped by you after " + n + " " + what + ".";
  return "Last run: " + n + " " + what + " confirmed.";
}

function renderEngageRun(state) {
  const box = document.getElementById("engageRunBox");
  if (!box) return;
  // Start is only reachable behind the clickwrap AND behind a build where the
  // selectors are actually switched on. Showing it otherwise would offer a
  // button whose only possible outcome is the "not switched on" message.
  box.hidden = !(state.accepted && state.engageEnabled !== false);

  const start = document.getElementById("engageStart");
  const stop = document.getElementById("engageStop");
  const running = Boolean(state.run);
  start.hidden = running;
  stop.hidden = !running;

  const pace = document.getElementById("engagePace");
  if (pace && state.settings && !running) {
    // Snap to the nearest offered pace rather than adding an option: the stored
    // floor can be any clamped number (an older build, a future control).
    const want = Number(state.settings.pacingFloorMs) || 1400;
    let best = pace.options[0];
    for (const opt of pace.options) {
      if (Math.abs(Number(opt.value) - want) < Math.abs(Number(best.value) - want)) best = opt;
    }
    pace.value = best.value;
  }

  document.getElementById("engageRunStatus").textContent = engageRunLine(state);
}

function wireEngagement() {
  const check = document.getElementById("engageCheck");
  const accept = document.getElementById("engageAccept");
  const revoke = document.getElementById("engageRevoke");
  if (!check || !accept || !revoke) return;

  check.addEventListener("change", () => {
    accept.disabled = !check.checked;
  });
  accept.addEventListener("click", async () => {
    if (!check.checked) return;
    try {
      await Promise.resolve(ext.runtime.sendMessage({ type: "GT_ENGAGE_ACCEPT" }));
    } catch (_e) { /* the render below will show it did not take */ }
    check.checked = false;
    accept.disabled = true;
    await renderEngagement();
  });
  revoke.addEventListener("click", async () => {
    try {
      await Promise.resolve(ext.runtime.sendMessage({ type: "GT_ENGAGE_REVOKE" }));
    } catch (_e) { /* same */ }
    await renderEngagement();
  });

  const action = document.getElementById("engageAction");
  const priceField = document.getElementById("engagePriceField");
  const start = document.getElementById("engageStart");
  const stop = document.getElementById("engageStop");
  const pace = document.getElementById("engagePace");
  if (!action || !start || !stop || !pace) return;

  action.addEventListener("change", () => {
    priceField.hidden = action.value !== "offer";
  });

  // The pacing floor, which until now was reachable only by a message no UI
  // sent. Written through the background so it lands clamped.
  pace.addEventListener("change", async () => {
    try {
      await Promise.resolve(ext.runtime.sendMessage({
        type: "GT_ENGAGE_SETTINGS",
        settings: { pacingFloorMs: Number(pace.value) },
      }));
    } catch (_e) { /* the re-render below shows what actually stuck */ }
    await renderEngagement();
  });

  start.addEventListener("click", async () => {
    const status = document.getElementById("engageRunStatus");
    start.disabled = true;
    status.textContent = "Starting…";
    let res = null;
    try {
      res = await Promise.resolve(ext.runtime.sendMessage({
        type: "GT_ENGAGE_START",
        action: action.value,
        offerPrice: Number(document.getElementById("engagePrice").value) || 0,
      }));
    } catch (_e) { /* handled by the null check */ }
    start.disabled = false;
    if (!res || res.ok !== true) {
      // Shown here rather than swallowed: every refusal the background returns
      // is one the seller can act on (wrong tab, terms not accepted, cap hit).
      status.textContent = (res && res.error) || "Could not start the run.";
      return;
    }
    await renderEngagement();
  });

  stop.addEventListener("click", async () => {
    stop.disabled = true;
    try {
      await Promise.resolve(ext.runtime.sendMessage({ type: "GT_ENGAGE_STOP" }));
    } catch (_e) { /* the record is cleared either way */ }
    stop.disabled = false;
    await renderEngagement();
  });
}

// ── US-2484: the one-click selector check ───────────────────────────────────
//
// Enabling a channel needs a human on the live sell form, because every one of
// them is behind a login. This is that step without the devtools session: ask
// the content script to run every selector, show the verdict, and hand over a
// pasteable report.
//
// Only appears on a tab the Lister actually has a config for. Offering it on
// an arbitrary page would produce a confusing "no selectors bundled" report.
const PROBE_HOSTS = {
  poshmark: /(^|\.)poshmark\.(com|ca)$/i,
  mercari: /(^|\.)mercari\.com$/i,
  grailed: /(^|\.)grailed\.com$/i,
  vinted: /(^|\.)vinted\.[a-z.]+$/i,
  facebook: /(^|\.)facebook\.com$/i,
};

/** The lister platform for a tab's host, or null when it is not one of ours. */
function probePlatformForHost(host) {
  if (!host) return null;
  for (const [platform, re] of Object.entries(PROBE_HOSTS)) {
    if (re.test(host)) return platform;
  }
  return null;
}

let probeText = "";

async function renderProbe() {
  const block = document.getElementById("probeBlock");
  if (!block) return;
  let tab = null;
  try {
    const tabs = await Promise.resolve(ext.tabs.query({ active: true, currentWindow: true }));
    tab = (tabs && tabs[0]) || null;
  } catch (_e) { /* no tabs permission — leave it hidden */ }

  const host = tab && tab.url ? (() => {
    try { return new URL(tab.url).host; } catch (_e) { return null; }
  })() : null;
  // The Advanced section always exists now, so the idle note carries the "why
  // is there nothing here" answer instead of the whole block vanishing.
  const idle = document.getElementById("probeIdle");
  const platform = probePlatformForHost(host);
  if (!platform) {
    block.hidden = true;
    if (idle) idle.hidden = false;
    return;
  }
  block.hidden = false;
  if (idle) idle.hidden = true;
  document.getElementById("probeHost").textContent = host;
  block.dataset.platform = platform;
  block.dataset.tabId = String(tab.id);
}

/** Ask the content script for a report. Null when it is not in the tab. */
async function askProbe(tabId, platform, deep) {
  try {
    return await Promise.resolve(
      ext.tabs.sendMessage(Number(tabId), { type: "GT_LISTER_PROBE", platform, deep: Boolean(deep) }),
    );
  } catch (_e) {
    // The content script is not in this tab: the page loaded before the
    // extension was installed or updated, or it is a marketplace page the
    // manifest does not match.
    return null;
  }
}

/** Resolve once the tab finishes loading, or after `ms` either way. */
async function waitForTabLoad(tabId, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const t = await Promise.resolve(ext.tabs.get(Number(tabId)));
      if (t && t.status === "complete") return true;
    } catch (_e) {
      return false; // the tab went away; the caller reports the failure
    }
  }
  return false;
}

function wireProbe() {
  const run = document.getElementById("probeRun");
  const copy = document.getElementById("probeCopy");
  if (!run || !copy) return;

  run.addEventListener("click", async () => {
    const block = document.getElementById("probeBlock");
    const verdict = document.getElementById("probeVerdict");
    const out = document.getElementById("probeOut");
    run.disabled = true;
    verdict.hidden = false;
    verdict.textContent = "Checking…";
    verdict.dataset.state = "";

    // US-2485 round four: a control that only exists after a click never
    // reached the candidate sweep, because that sweep fires on a missing
    // REQUIRED selector and post-interaction controls are not required. So a
    // seller could be looking straight at Mercari's Delete button, or a
    // Poshmark "Shared" toast, and the report would learn nothing from either.
    // The checkbox is the seller telling us the click already happened.
    const deep = Boolean(document.getElementById("probeDeep")?.checked);
    let res = await askProbe(block.dataset.tabId, block.dataset.platform, deep);

    // US-2485: "reload it and try again" was a correct instruction and a bad
    // one. A tab open since before the extension updated is the NORMAL state
    // during a verification session — it happened on the very first Mercari
    // check — and telling someone to go and do the one thing the popup can do
    // for them is how a two-minute job becomes a dead end. So do it, once, and
    // say so. Once only: a second failure is a real one and repeating the
    // reload would just cost the seller their place on the form.
    if (!res || !res.ok) {
      verdict.textContent = "The page loaded before the extension did. Reloading it…";
      try {
        await Promise.resolve(ext.tabs.reload(Number(block.dataset.tabId)));
        await waitForTabLoad(block.dataset.tabId, 8000);
        // The content script registers its listener at document_idle, which is
        // slightly after "complete" on a heavy SPA.
        await new Promise((r) => setTimeout(r, 600));
        res = await askProbe(block.dataset.tabId, block.dataset.platform, deep);
      } catch (_e) {
        res = null;
      }
    }

    run.disabled = false;

    if (!res || !res.ok) {
      verdict.textContent =
        "Couldn't reach the page, even after a reload. Check that the address " +
        "is one this extension covers, then try again.";
      verdict.dataset.state = "bad";
      out.hidden = true;
      copy.hidden = true;
      return;
    }

    probeText = res.text || "";
    verdict.textContent = res.clean
      ? "Every required selector resolves on this page."
      : "Some required selectors are missing — the report says which.";
    verdict.dataset.state = res.clean ? "good" : "bad";
    out.textContent = probeText;
    out.hidden = false;
    copy.hidden = false;
  });

  // US-2487: arm the watcher, then go and do the thing.
  //
  // A success toast is the one control that cannot be described by looking at a
  // page — Poshmark's "Shared" banner is gone in a couple of seconds, so
  // catching it means sharing, opening this popup, ticking a box and pressing
  // a button inside that window. Four attempts produced four reports of a page
  // the toast had already left. That is the wrong instrument, not a careless
  // seller: arm it here, close the popup, share, come back and press Check.
  const watch = document.getElementById("probeWatch");
  if (watch) {
    watch.addEventListener("click", async () => {
      const block = document.getElementById("probeBlock");
      const verdict = document.getElementById("probeVerdict");
      verdict.hidden = false;
      verdict.dataset.state = "";
      let res = null;
      try {
        res = await Promise.resolve(
          ext.tabs.sendMessage(Number(block.dataset.tabId), {
            type: "GT_LISTER_WATCH",
            platform: block.dataset.platform,
          }),
        );
      } catch (_e) { res = null; }
      if (!res || !res.ok) {
        verdict.textContent = "Couldn't reach the page. Reload it and try again.";
        verdict.dataset.state = "bad";
        return;
      }
      verdict.textContent =
        // The fallback must track lister/common.js WATCH_MS. It only shows if
        // the content script answered without an `ms`, which means a version
        // skew — and a number that undersells the window makes a seller rush.
        "Watching for " + Math.round((res.ms || 60000) / 1000) + " seconds. Close this, " +
        "do the thing you want captured — share a listing, open a menu — then " +
        "open this again and press Check selectors.";
    });
  }

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(probeText);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy report"; }, 1500);
    } catch (_e) {
      // Clipboard blocked — the report is on screen and selectable anyway.
      copy.textContent = "Select the text above to copy";
    }
  });
}

function renderSellerSections(caps) {
  const seller = document.getElementById("sellerSection");
  const locked = document.getElementById("sellerLockedSection");
  // 2026-08-11: the anonymous case now has its OWN block. It used to hide all
  // three, which was fine when this lived at the bottom of one long scroll —
  // there was simply nothing there. As a TAB it would have rendered blank, and
  // a blank panel reads as broken rather than as "not for you".
  const anon = document.getElementById("sellerSignedOutSection");
  if (caps && caps.sellerEnabled) {
    seller.hidden = false;
    locked.hidden = true;
    if (anon) anon.hidden = true;
    renderPlatforms();
    renderLastJob();
    renderPendingDelists(caps);
    renderPendingRevises(caps);
  void renderSyncStatus(caps);
  void renderPollConsent(caps);
    renderConsent();
    void renderEngagement();
  } else if (caps && caps.authenticated) {
    // Signed in but no active FlipDesk plan → honest upsell, not a dead section.
    seller.hidden = true;
    locked.hidden = false;
    if (anon) anon.hidden = true;
    setSellingCount(0);
  } else {
    seller.hidden = true;
    locked.hidden = true;
    if (anon) anon.hidden = false;
    setSellingCount(0);
  }
}

// ── sign-in / connect ───────────────────────────────────────────────────────
//
// US-1881 AC3: on Firefox the token comes home through gt-bridge.js, an ordinary
// content script on gradethread.com — there is no externally_connectable to fall
// back on. So an un-granted site permission does not fail the sign-in, it HANGS
// it: the connect page opens, mints the token, posts it, and nothing is
// listening. `siteAccessMissing` is resolved once at render time, and the click
// handler asks for the origins before opening the tab (first statement, gesture
// intact) — on Chrome the flag is false and this path is never taken.
let siteAccessMissing = false;

async function initSiteAccess() {
  const hint = document.getElementById("sitePermHint");
  if (!PERMS) return;
  siteAccessMissing = !(await PERMS.hasSiteAccess(ext));
  if (hint) hint.hidden = !siteAccessMissing;
}

function wireAccount() {
  const connect = document.getElementById("connectBtn");
  const disconnect = document.getElementById("disconnectBtn");
  // The Selling tab's own sign-in button. It forwards to the real control in
  // Settings rather than duplicating the connect flow — that flow carries the
  // Firefox permission dance (see below), and a second copy of it is a second
  // copy to get wrong.
  const sellerSignIn = document.getElementById("sellerSignInBtn");
  if (sellerSignIn) {
    sellerSignIn.addEventListener("click", () => {
      userPicked = true;
      selectTab("Settings");
      connect.click();
    });
  }
  connect.addEventListener("click", () => {
    // Launches the US-1838 token flow: the connect page mints an extension token
    // (POST /api/buyer/extension-token) and posts it back via GT_SET_TOKEN so this
    // install becomes account-scoped. `ext` lets the page target this extension id.
    const url = ATTR.siteUrl("/connect-extension", "popup", {
      campaign: "connect",
      params: { ext: ext.runtime.id },
    });
    const openConnectTab = () => {
      try {
        ext.tabs.create({ url });
      } catch (_e) {
        window.open(url, "_blank", "noopener");
      }
    };
    // Ask first when the bridge origin is missing, then open the tab either way:
    // a refusal still deserves the page (they may sign in and grant later), it
    // just will not complete the handshake — which the hint above already says.
    if (siteAccessMissing && PERMS) {
      PERMS.requestSiteAccess(ext).then((ok) => {
        if (ok) {
          siteAccessMissing = false;
          const hint = document.getElementById("sitePermHint");
          if (hint) hint.hidden = true;
        }
        openConnectTab();
      });
      return;
    }
    openConnectTab();
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
  selectDefaultTab(caps);
}

// ── boot ─────────────────────────────────────────────────────────────────────
(async function () {
  initStaticLinks();
  // US-1757 AC2: ONE delegated listener for every gradethread.com link in the
  // popup — the footer, the upgrade CTA, the sign-in link, the recent-reads
  // fallback, and whatever a later feature adds. Per-anchor wiring would go
  // stale on the next render; this cannot. The surface comes off the link's own
  // utm_medium, so the click and the signup it produces are filed alike.
  USAGE.trackSiteClicks(document, "popup", {
    isSiteUrl: ATTR.isSiteUrl,
    send: (event, surface) => send({ type: "GT_CC_USAGE", event, surface }),
  });
  wireMainTabs();
  wireAccount();
  wireConsent();
  wireEngagement(); // US-2482
  wireProbe();      // US-2484
  wireHistoryTabs();
  // US-2484: rendered UNCONDITIONALLY, not from renderSellerSections.
  //
  // It is a diagnostic — it runs our own bundled selectors against the page
  // already open and reports which resolve. It shows no seller data and grants
  // nothing, so a plan gate bought nothing. It cost something real, though: the
  // seller section hides whenever the entitlements fetch fails (that path
  // fail-safes to anonymous), so the tool for debugging a broken extension
  // disappeared in exactly the situation you would open it.
  void renderProbe();
  renderCompareLink();
  // Render research immediately (works offline / anonymous), then fold in the
  // account-driven sections once entitlements resolve.
  await Promise.all([initResearch(), renderReads(), initSiteAccess()]);
  const caps = await send({ type: "GT_GET_CAPABILITIES", force: true });
  applyCapabilities(caps || { research: true, authenticated: false, sellerEnabled: false });
})();
