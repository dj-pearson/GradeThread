// GradeThread closet import — the auto-import's refusals, executed (US-3459).
//
// The background reads a seller's closet on its own when they open it. The
// decisions that bound that (signed in, not switched off, once a day, only a
// closet URL of an enabled adapter) live in closet-import/auto-plan.js so they
// can be run here without a browser. The wiring in background.js is checked
// by reading its source: the listener is tabs.onUpdated (a read), the read is
// asked of the content script, and nothing in the auto path opens a tab.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadGlobal(rel, name) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", `${src}; return self.${name};`)(scope);
}

const AUTO = loadGlobal("closet-import/auto-plan.js", "GT_CLOSET_IMPORT_AUTO");
const SEL = loadGlobal("closet-import/selectors.js", "GT_CLOSET_IMPORT_SELECTORS");

const NOW = Date.parse("2026-09-22T12:00:00Z");
const HOUR = 60 * 60 * 1000;

// ── 1. Only an enabled adapter's closet URL is a closet ────────────────────
{
  assert.strictEqual(AUTO.platformForClosetUrl(SEL, "https://poshmark.com/closet/somebody"), "poshmark");
  assert.strictEqual(AUTO.platformForClosetUrl(SEL, "https://www.mercari.com/mypage/listings"), "mercari");
  assert.strictEqual(AUTO.platformForClosetUrl(SEL, "https://www.grailed.com/users/12345-me"), "grailed");
  // A listing page is not the closet.
  assert.strictEqual(AUTO.platformForClosetUrl(SEL, "https://poshmark.com/listing/Tee-5f1e2d3c4b5a69788796a5b4"), null);
  // A lookalike host, http, and garbage all say no.
  assert.strictEqual(AUTO.platformForClosetUrl(SEL, "https://poshmark.example/closet/me"), null);
  assert.strictEqual(AUTO.platformForClosetUrl(SEL, "http://poshmark.com/closet/me"), null);
  assert.strictEqual(AUTO.platformForClosetUrl(SEL, "not a url"), null);
  assert.strictEqual(AUTO.platformForClosetUrl(SEL, null), null);
  // A disabled adapter's closet is nobody's closet to this path.
  const off = JSON.parse(JSON.stringify(SEL));
  off.poshmark.enabled = false;
  assert.strictEqual(AUTO.platformForClosetUrl(off, "https://poshmark.com/closet/me"), null);
}

// ── 2. The decision: signed in, not off, not within a day ─────────────────
{
  assert.deepStrictEqual(AUTO.decide({}, "poshmark", NOW), { run: false, reason: "needs_sign_in" });
  assert.deepStrictEqual(AUTO.decide({ gtBuyerToken: "" }, "poshmark", NOW), { run: false, reason: "needs_sign_in" });
  assert.deepStrictEqual(AUTO.decide({ gtBuyerToken: "t", closetAutoImport: false }, "poshmark", NOW), { run: false, reason: "off" });
  // Default (key absent) is ON.
  assert.deepStrictEqual(AUTO.decide({ gtBuyerToken: "t" }, "poshmark", NOW), { run: true, reason: "due" });
  // An import an hour ago holds the platform; one 25 hours ago does not.
  assert.deepStrictEqual(
    AUTO.decide({ gtBuyerToken: "t", closetAutoImportLast: { poshmark: NOW - HOUR } }, "poshmark", NOW),
    { run: false, reason: "too_soon" },
  );
  assert.deepStrictEqual(
    AUTO.decide({ gtBuyerToken: "t", closetAutoImportLast: { poshmark: NOW - 25 * HOUR } }, "poshmark", NOW),
    { run: true, reason: "due" },
  );
  // The throttle is per marketplace: Poshmark an hour ago says nothing about Mercari.
  assert.deepStrictEqual(
    AUTO.decide({ gtBuyerToken: "t", closetAutoImportLast: { poshmark: NOW - HOUR } }, "mercari", NOW),
    { run: true, reason: "due" },
  );
  // A malformed map is an empty map, never a crash.
  assert.deepStrictEqual(AUTO.decide({ gtBuyerToken: "t", closetAutoImportLast: "junk" }, "poshmark", NOW), { run: true, reason: "due" });
  assert.strictEqual(AUTO.MIN_GAP_MS, 24 * HOUR);
}

// ── 3. The stamp keeps other marketplaces and never mutates its input ─────
{
  const before = { mercari: 5 };
  const after = AUTO.stamp(before, "poshmark", NOW);
  assert.deepStrictEqual(after, { mercari: 5, poshmark: NOW });
  assert.deepStrictEqual(before, { mercari: 5 });
  assert.deepStrictEqual(AUTO.stamp(undefined, "grailed", 7), { grailed: 7 });
}

// ── 4. A tab update yields a URL on a navigation or a completed load only ─
{
  assert.strictEqual(AUTO.urlFromTabUpdate({ url: "https://poshmark.com/closet/me" }, { url: "x" }), "https://poshmark.com/closet/me");
  assert.strictEqual(AUTO.urlFromTabUpdate({ status: "complete" }, { url: "https://poshmark.com/closet/me" }), "https://poshmark.com/closet/me");
  assert.strictEqual(AUTO.urlFromTabUpdate({ status: "loading" }, { url: "https://poshmark.com/closet/me" }), null);
  assert.strictEqual(AUTO.urlFromTabUpdate({ title: "x" }, { url: "https://poshmark.com/closet/me" }), null);
  assert.strictEqual(AUTO.urlFromTabUpdate(null, null), null);
}

// ── 5. Background wiring: a read, asked, never a tab of its own ───────────
{
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  const start = bg.indexOf("async function maybeAutoClosetImport(");
  const end = bg.indexOf("async function postSyncObservations(");
  assert.ok(start > 0 && end > start, "maybeAutoClosetImport must sit before postSyncObservations");
  const fn = bg.slice(start, end);
  assert.ok(/GT_CLOSET_IMPORT_AUTO/.test(fn), "the auto path must decide through closet-import/auto-plan.js");
  assert.ok(/AUTO\.decide\(/.test(fn), "the auto path must call decide() before reading");
  assert.ok(/GT_CLOSET_IMPORT_READ/.test(fn), "the auto path must ASK the content script to read");
  assert.ok(/postClosetBatch\(/.test(fn), "the auto path must post through the same function as the button");
  assert.ok(/AUTO\.stamp\(/.test(fn), "a successful auto-import must stamp the platform");
  for (const [pattern, what] of [
    [/tabs\.create/, "opens a tab"],
    [/tabs\.update/, "navigates a tab"],
    [/window\.open\s*\(/, "opens a window"],
    [/setInterval\s*\(/, "polls"],
    [/alarms\.create/, "schedules"],
  ]) {
    assert.ok(!pattern.test(fn), `the auto-import path ${what} (${pattern}); it may only read a tab the seller opened`);
  }
  // Only a CLOSET read is acted on; a detail page is not "opening the closet".
  assert.ok(/page !== "closet"/.test(fn), "the auto path must ignore detail-page reads");
  // The listener is tabs.onUpdated, feeding the decision through the pure helper.
  assert.ok(/AUTO\.urlFromTabUpdate\(changeInfo, tab\)/.test(bg), "tabs.onUpdated must derive the URL through urlFromTabUpdate");
  assert.ok(/maybeAutoClosetImport\(tabId, url\)\.catch\(/.test(bg), "a failed auto read must never reject into the worker");
  // The decision reads its inputs from storage under the keys options.js writes.
  assert.ok(/"closetAutoImport", "closetAutoImportLast"/.test(fn), "the auto path must read the setting and the stamp");
  const options = fs.readFileSync(path.join(dir, "options.js"), "utf8");
  assert.ok(/closetAutoImport: false/.test(options), "options.js must store the OFF state as an explicit false");
  assert.ok(/storage\.local\.remove\("closetAutoImport"\)/.test(options), "options.js must remove the key to switch back on (default on)");
  const html = fs.readFileSync(path.join(dir, "options.html"), "utf8");
  assert.ok(/id="closetAutoImport"/.test(html), "options.html must carry the toggle");
  const onboarding = fs.readFileSync(path.join(dir, "onboarding.html"), "utf8");
  assert.ok(/import into FlipDesk on their own/.test(onboarding), "onboarding must state the automatic import in one sentence");
  // Firefox has no importScripts: the manifest must list the plan file too.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.ok((manifest.background.scripts || []).includes("closet-import/auto-plan.js"), "manifest background.scripts must list closet-import/auto-plan.js");
}

console.log("closet-import-auto.test.cjs: the auto-import decides in a pure file, asks before reading, and opens nothing");
