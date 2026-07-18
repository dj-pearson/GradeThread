// GradeThread unified extension — background bootstrap ⇄ manifest guard (US-1881).
//
// THE BUG. background.js is loaded two completely different ways:
//   • Chrome  — an MV3 SERVICE WORKER. importScripts() exists, so the file pulls
//               its own deps in at the top.
//   • Firefox — a non-persistent EVENT PAGE. There is NO importScripts, so the
//               deps must be listed ahead of background.js in manifest
//               background.scripts, and the background entry must declare
//               `scripts` at all — with only `service_worker`, Firefox loads NO
//               BACKGROUND WHATSOEVER and the whole extension is inert.
//
// background.js documented this contract in its header and honoured its half of
// it. The manifest never held up the other half: it declared only service_worker
// and no scripts, so Firefox was dead on arrival.
//
// WHY A GUARD AND NOT JUST A FIX. The dep list now lives in two places that must
// agree, and only ONE of them is exercised by day-to-day Chrome development. Add a
// dep to importScripts, forget the manifest, and Chrome stays perfectly green while
// Firefox breaks — silently, in a way no other test in this repo can see. That is
// not hypothetical: US-1874 added lister/job-store.js to importScripts, and nothing
// would have caught the omission.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

// The single source of truth: what the worker actually imports.
const call = /importScripts\(([^)]*)\)/s.exec(bg);
assert.ok(call, "background.js must call importScripts (the Chrome service-worker path)");
const deps = Array.from(call[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
assert.ok(deps.length > 0, "importScripts must name at least one dep");

const background = manifest.background || {};

// ── both entry points declared ─────────────────────────────────────────────
assert.strictEqual(
  background.service_worker,
  "background.js",
  "manifest background.service_worker must be background.js (the Chrome path)",
);
assert.ok(
  Array.isArray(background.scripts),
  "manifest background.scripts is MISSING. Firefox MV3 runs the background as an " +
    "event page and reads `scripts`; with only `service_worker` it loads NO background " +
    "at all and the extension is inert (US-1881 AC1).",
);

// ── the dep list matches, in order, with background.js last ────────────────
assert.deepStrictEqual(
  background.scripts,
  [...deps, "background.js"],
  "manifest background.scripts must be exactly background.js's importScripts deps, " +
    "IN THE SAME ORDER, followed by background.js. Firefox has no importScripts, so " +
    "these files are the only way its event page gets them — and order matters, since " +
    "background.js reads self.GT_LISTER_SELECTORS / GT_LISTER_GUARD / GT_LISTER_JOBS / " +
    "GT_REGISTRY at load. Chrome ignores `scripts`, so this drift is invisible until " +
    "someone opens Firefox.",
);

// ── every listed file exists ───────────────────────────────────────────────
for (const rel of background.scripts) {
  assert.ok(
    fs.existsSync(path.join(dir, rel)),
    `manifest background.scripts references "${rel}", which does not exist`,
  );
}

// ── AMO requirements ───────────────────────────────────────────────────────
const gecko = (manifest.browser_specific_settings || {}).gecko;
assert.ok(
  gecko && typeof gecko.id === "string" && gecko.id.length > 0,
  "browser_specific_settings.gecko.id is required — AMO rejects an add-on without " +
    "an explicit id (US-1881 AC1)",
);
assert.ok(
  gecko.strict_min_version,
  "browser_specific_settings.gecko.strict_min_version is required; MV3 support " +
    "starts at Firefox 109",
);
assert.ok(
  parseFloat(gecko.strict_min_version) >= 109,
  `strict_min_version ${gecko.strict_min_version} is below 109 — Firefox had no MV3 ` +
    "support before then, so the extension could not load",
);

// ── the top-level-throw class of Firefox breakage ──────────────────────────
// Firefox has no onMessageExternal. Reading .addListener off it unguarded throws at
// LOAD, which aborts the entire background — taking buyer research down with it,
// even though research has nothing to do with external messaging. Same for any
// namespace a browser may not grant (alarms).
for (const [api, why] of [
  ["onMessageExternal", "Firefox does not implement externally_connectable/onMessageExternal"],
  ["alarms", "a browser may not grant the alarms permission"],
]) {
  const re = new RegExp(`if\\s*\\([^)]*\\b${api}\\b[^)]*\\)`);
  assert.ok(
    re.test(bg),
    `background.js registers on ${api} without an existence guard. ${why}, and reading ` +
      ".addListener off an undefined namespace throws at load — which aborts the WHOLE " +
      "background, not just that feature (US-1881 AC2).",
  );
}

// ── the SHIPPED Firefox manifest, not just the repo one ────────────────────
// Everything above tests extension-unified/manifest.json. That is NOT what AMO
// receives: scripts/package-extensions.mjs rewrites the manifest for Firefox,
// and for a long time it re-declared — rather than read — the very fields
// asserted above. So the guard passed while the shipped zip was broken three
// ways: a stale background list missing lister/job-store.js (event page loads
// with GT_LISTER_JOBS undefined → startJob throws AFTER opening the tab, the
// response never arrives, and the seller sits through a 130s timeout with the
// form untouched), a dropped strict_min_version, and a gecko id that disagreed
// with the manifest's.
//
// Asserting the transform's real output is the only version of this test that
// can see that class of bug — restating the expected values here would just
// recreate the same blind spot one file further out.
(async () => {
  const { pathToFileURL } = require("node:url");
  const pkgPath = path.resolve(dir, "..", "scripts", "package-extensions.mjs");
  const { EXTENSIONS, firefoxManifest } = await import(pathToFileURL(pkgPath).href);

  const entry = EXTENSIONS.find((e) => e.dir === "extension-unified");
  assert.ok(entry, "package-extensions.mjs must still ship the extension-unified folder");
  assert.ok(
    !entry.firefox?.blocked,
    "the unified extension is Firefox-ready (US-1881/1882: gt-bridge.js replaces " +
      "externally_connectable) — it must not be marked blocked",
  );

  const ff = firefoxManifest(manifest, entry.firefox);

  assert.deepStrictEqual(
    ff.background.scripts,
    [...deps, "background.js"],
    "the SHIPPED Firefox manifest's background.scripts must equal background.js's " +
      "importScripts deps + background.js. The packager must DERIVE this from the " +
      "manifest, never restate it: a restated list silently goes stale (it already " +
      "missed lister/job-store.js, so GT_LISTER_JOBS was undefined on Firefox and " +
      "every seller job hung for 130s with the marketplace tab open and unfilled).",
  );
  assert.ok(
    !ff.background.service_worker,
    "the Firefox variant must not keep background.service_worker alongside scripts",
  );

  const shipped = (ff.browser_specific_settings || {}).gecko || {};
  assert.strictEqual(
    shipped.id,
    gecko.id,
    "the shipped gecko id must match the repo manifest's. When they disagree, a " +
      "dev-loaded temporary add-on and the store build are different add-ons — " +
      "different storage, and an id you cannot change after AMO submission.",
  );
  assert.strictEqual(
    shipped.strict_min_version,
    gecko.strict_min_version,
    "the packager dropped strict_min_version by overwriting browser_specific_settings " +
      "wholesale; without it the add-on installs on pre-109 Firefox, which has no MV3.",
  );
  assert.ok(
    shipped.data_collection_permissions,
    "AMO requires a data-collection disclosure (mzl.la/firefox-builtin-data-consent)",
  );
  assert.ok(
    !ff.externally_connectable,
    "externally_connectable must be stripped for Firefox — unsupported, and the AMO " +
      "linter flags it; gt-bridge.js is the replacement transport (US-1882)",
  );

  console.log(
    `background-deps.test.cjs: manifest ⇄ importScripts in lockstep (${deps.length} deps), ` +
      `gecko id + min ${gecko.strict_min_version}, load-time guards present; ` +
      `shipped FF manifest derived (${ff.background.scripts.length} bg scripts, ` +
      `min ${shipped.strict_min_version}, externally_connectable stripped)`,
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// US-1877 (AC1): the live-listing capture watches from the BACKGROUND, via
// tabs.onUpdated — NOT from the content script. Submitting the form usually does a
// full page load, which tears the content script down and re-injects it with no
// memory of having filled anything, so an in-page watch would die exactly when it
// is needed. Pinned here because "move it into the content script, it's simpler"
// looks reasonable and silently breaks the common case.
assert.ok(
  /ext\.tabs\.onUpdated/.test(bg),
  "background.js must watch tabs.onUpdated for the live listing URL (US-1877 AC1) — " +
    "an in-page watch does not survive the page load that submitting triggers",
);
assert.ok(
  /isLiveListingUrl/.test(bg),
  "the capture must go through the GT_LISTER_GUARD.isLiveListingUrl host+path check — " +
    "a false capture records a wrong URL and flips the row to ACTIVE, which is the " +
    "phantom-listing bug US-1877 exists to remove",
);
