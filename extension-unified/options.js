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

  await initQuickLook();
}

// ── US-3066: the on-device quick look ───────────────────────────────────────
//
// HIDDEN where the browser cannot do it, rather than disabled. A greyed-out
// control on Firefox invites a support question with no answer; an absent one
// is simply a feature that browser does not have.
//
// The model download is ONLY ever started from here, by a click. Chrome's
// LanguageModel.create() on a "downloadable" model pulls a multi-gigabyte file,
// and starting that from a content script — on page load, on someone's mobile
// tether, because they opened a Poshmark listing — is not a decision the
// extension gets to make for them.
async function initQuickLook() {
  const row = document.getElementById("quickLookRow");
  const box = document.getElementById("quickLook");
  const state = document.getElementById("quickLookState");
  const dl = document.getElementById("quickLookDownload");
  if (!row || !box || !state || !dl) return;

  const LOCAL = self.GT_CC_LOCAL;
  const availability = LOCAL ? await LOCAL.detect(self) : "unavailable";
  if (availability === "unavailable") return; // stays hidden

  row.hidden = false;
  const { quickLook } = await ext.storage.local.get(["quickLook"]);
  // Defaults ON where the model is available, and turning it back on REMOVES
  // the key, so "default" and "explicitly on" are one stored state. Same rule
  // as scanMode above.
  box.checked = quickLook !== false;
  box.addEventListener("change", async () => {
    if (box.checked) await ext.storage.local.remove("quickLook");
    else await ext.storage.local.set({ quickLook: false });
  });

  if (availability === "available") {
    state.textContent = "The on-device model is ready.";
    return;
  }

  // downloadable
  state.textContent =
    "The on-device model is not downloaded yet. Nothing happens until you ask " +
    "for it.";
  dl.hidden = false;
  dl.addEventListener("click", async () => {
    dl.disabled = true;
    state.textContent = "Starting the download…";
    try {
      const session = await self.LanguageModel.create({
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            const pct = typeof e.loaded === "number"
              ? Math.round(e.loaded * 100)
              : null;
            state.textContent = pct === null
              ? "Downloading the on-device model…"
              : `Downloading the on-device model… ${pct}%`;
          });
        },
      });
      if (session && typeof session.destroy === "function") session.destroy();
      state.textContent = "The on-device model is ready.";
      dl.hidden = true;
    } catch (_e) {
      // Named, not swallowed. A download that fails silently leaves the toggle
      // on and nothing working, which is the worst of both.
      state.textContent =
        "The download did not finish. You can try again, and the quick look " +
        "stays off until it does.";
      dl.disabled = false;
    }
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
