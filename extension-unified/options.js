// GradeThread unified extension — settings page (US-2241)
//
// The popup is the wrong home for everything: it is 360px wide, it opens over a
// marketplace page while the shopper is mid-task, and the per-site opt-outs were
// only reachable while standing ON the site you wanted to re-enable — so turning
// one back on meant remembering which one you'd turned off and navigating there.
//
// This page is the durable surface: every toggle, the full list of disabled
// sites with a way to undo each, and the local-data controls. It touches the
// network never.

const ext = globalThis.browser || globalThis.chrome;
const TRAY = self.GT_CC_TRAY;

function flash() {
  const el = document.getElementById("cleared");
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 2000);
}

// ── toggles ─────────────────────────────────────────────────────────────────
async function initToggles() {
  const { autoRun, scanMode, selectorTelemetry } = await ext.storage.local.get([
    "autoRun",
    "scanMode",
    "selectorTelemetry",
  ]);

  const auto = document.getElementById("autoRun");
  auto.checked = Boolean(autoRun);
  auto.addEventListener("change", () => ext.storage.local.set({ autoRun: auto.checked }));

  // Defaults ON, so it reads `!== false` — and switching it back ON removes the
  // key rather than storing true, keeping "default" and "explicitly on" the same
  // stored state. Same rule as the popup; both read the same key.
  const scan = document.getElementById("scanMode");
  scan.checked = scanMode !== false;
  scan.addEventListener("change", async () => {
    if (scan.checked) await ext.storage.local.remove("scanMode");
    else await ext.storage.local.set({ scanMode: false });
  });

  // Defaults OFF, and revoking REMOVES the key rather than storing false, so a
  // revoke leaves nothing behind.
  const tel = document.getElementById("selectorTelemetry");
  tel.checked = Boolean(selectorTelemetry);
  tel.addEventListener("change", async () => {
    if (tel.checked) await ext.storage.local.set({ selectorTelemetry: true });
    else await ext.storage.local.remove("selectorTelemetry");
  });
}

// ── per-site opt-outs ───────────────────────────────────────────────────────
// The popup can only turn a site OFF while you're on it, which means it can only
// turn one back on the same way. This is the undo.
async function renderDisabled() {
  const ul = document.getElementById("disabledList");
  const empty = document.getElementById("disabledEmpty");
  const { disabledHosts } = await ext.storage.local.get("disabledHosts");
  const hosts = Array.isArray(disabledHosts) ? disabledHosts : [];

  ul.textContent = "";
  empty.hidden = hosts.length > 0;

  for (const host of hosts) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = host;
    li.appendChild(name);

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "cmp-linkbtn";
    undo.textContent = "Turn back on";
    undo.addEventListener("click", async () => {
      const cur = (await ext.storage.local.get("disabledHosts")).disabledHosts || [];
      const next = (Array.isArray(cur) ? cur : []).filter((h) => h !== host);
      await ext.storage.local.set({ disabledHosts: next });
      renderDisabled();
    });
    li.appendChild(undo);
    ul.appendChild(li);
  }
}

// ── local data ──────────────────────────────────────────────────────────────
async function renderCounts() {
  const out = await ext.storage.local.get(["recentReads", TRAY.KEY, "gradeCacheByKey"]);
  const reads = Array.isArray(out.recentReads) ? out.recentReads.length : 0;
  const tray = Array.isArray(out[TRAY.KEY]) ? out[TRAY.KEY].length : 0;
  const cache = out.gradeCacheByKey ? Object.keys(out.gradeCacheByKey).length : 0;
  document.getElementById("readsCount").textContent = String(reads);
  document.getElementById("trayCount").textContent = String(tray);
  document.getElementById("cacheCount").textContent = String(cache);
}

function wireClears() {
  // Clearing reads clears the seller aggregate in the same action, because the
  // aggregate IS the reads — leaving a "By seller" view populated after the
  // shopper cleared their history would be the opposite of what they asked for.
  document.getElementById("clearReads").addEventListener("click", async () => {
    await ext.storage.local.remove("recentReads");
    await renderCounts();
    flash();
  });
  document.getElementById("clearTray").addEventListener("click", async () => {
    await ext.storage.local.remove(TRAY.KEY);
    await renderCounts();
    flash();
  });
  document.getElementById("clearCache").addEventListener("click", async () => {
    await ext.storage.local.remove("gradeCacheByKey");
    await renderCounts();
    flash();
  });
}

// ── shortcut ────────────────────────────────────────────────────────────────
async function initShortcut() {
  const kbd = document.getElementById("shortcut");
  try {
    const all = await ext.commands.getAll();
    const cmd = all.find((c) => c.name === "run-condition-read");
    // Show what is ACTUALLY bound: the manifest's Alt+G is only a suggestion,
    // and the browser silently drops it when another extension claimed it first.
    if (cmd && cmd.shortcut) kbd.textContent = cmd.shortcut;
    else kbd.textContent = "not set";
  } catch (_e) { /* commands API unavailable — leave the suggested default */ }

  document.getElementById("openShortcuts").addEventListener("click", () => {
    // Chromium exposes a settings page for this; Firefox does not, so fall back
    // to its add-on manager rather than opening a URL that 404s.
    const url = ext.runtime.getURL("").startsWith("moz-extension://")
      ? "about:addons"
      : "chrome://extensions/shortcuts";
    ext.tabs.create({ url }).catch(() => { /* the browser blocked it */ });
  });
}

// US-3055: the theme control. System is the absent key; the change lands on
// this page at once through GT_THEME.init's storage listener, and on the
// popup and the overlay through the same key.
async function initTheme() {
  const sel = document.getElementById("theme");
  if (!sel) return;
  const current = await self.GT_THEME.init(ext, document);
  sel.value = current || "";
  sel.addEventListener("change", async () => {
    await self.GT_THEME.save(ext, sel.value || null);
  });
}

(async function () {
  document.getElementById("version").textContent = "v" + ext.runtime.getManifest().version;
  await Promise.all([initTheme(), initToggles(), renderDisabled(), renderCounts(), initShortcut()]);
  wireClears();
})();
