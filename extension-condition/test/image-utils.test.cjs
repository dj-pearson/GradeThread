// GradeThread Condition Check — unit test for the pure helpers (US-1755, US-1756).
//
// The extension has no CI test runner (it ships unpacked / to the stores), so
// this is a zero-dependency node assertion script. Run it manually:
//   node extension-condition/test/image-utils.test.cjs
// It guards the logic that is easy to get wrong and hard to notice break in the
// field: the config-driven image-URL upgrade, adapter resolution by host, and
// detail-page detection.

const assert = require("node:assert");
const {
  applyUrlUpgrade,
  pickImageUrl,
  dedupeUrls,
  resolveAdapter,
  isDetailPage,
  isValidConfig,
  compareVersions,
  chooseConfig,
} = require("../content/image-utils.cjs");

// ── applyUrlUpgrade (config-driven) ──────────────────────────────────────
const EBAY = { pattern: "/s-l\\d+(?:_\\d+)?(\\.[a-z0-9]+)(?=($|\\?))", replacement: "/s-l1600$1", flags: "i" };
assert.equal(
  applyUrlUpgrade("https://i.ebayimg.com/images/g/AbC/s-l64.jpg", EBAY),
  "https://i.ebayimg.com/images/g/AbC/s-l1600.jpg",
  "eBay thumbnail -> s-l1600",
);
assert.equal(
  applyUrlUpgrade("https://i.ebayimg.com/images/g/AbC/s-l140_2.webp", EBAY),
  "https://i.ebayimg.com/images/g/AbC/s-l1600.webp",
  "drops the _2 variant, keeps webp",
);
assert.equal(
  applyUrlUpgrade("https://i.ebayimg.com/g/AbC/s-l225.jpg?x=1", EBAY),
  "https://i.ebayimg.com/g/AbC/s-l1600.jpg?x=1",
  "preserves a query string",
);
const POSH = { pattern: "/s_[a-z0-9]+/", replacement: "/l_", flags: "i" };
assert.equal(
  applyUrlUpgrade("https://dcdn.example/posts/abc/s_150/photo.jpg", POSH),
  "https://dcdn.example/posts/abc/l_photo.jpg",
  "Poshmark size token upgrade",
);
assert.equal(applyUrlUpgrade("https://x/y.jpg", null), "https://x/y.jpg", "no upgrade cfg -> unchanged");
assert.equal(
  applyUrlUpgrade("https://x/y.jpg", { pattern: "(", replacement: "z" }),
  "https://x/y.jpg",
  "malformed pattern -> unchanged (never throws)",
);
assert.equal(applyUrlUpgrade("", EBAY), "", "empty string is a no-op");

// ── pickImageUrl ─────────────────────────────────────────────────────────
assert.equal(
  pickImageUrl([null, "  ", "data:image/gif;base64,AAAA", "https://x/y.jpg"]),
  "https://x/y.jpg",
  "skips placeholders, returns first http(s) URL",
);
assert.equal(pickImageUrl([null, undefined, ""]), null, "no valid candidate -> null");

// ── dedupeUrls ───────────────────────────────────────────────────────────
assert.deepEqual(dedupeUrls(["a", "a", "b", "c", "b"], 4), ["a", "b", "c"], "dedupes, preserves order");
assert.deepEqual(dedupeUrls(["a", "b", "c", "d", "e"], 4), ["a", "b", "c", "d"], "caps at the limit");

// ── resolveAdapter ───────────────────────────────────────────────────────
const ADAPTERS = {
  ebay: { hosts: ["ebay.com", "ebay.co.uk"] },
  poshmark: { hosts: ["poshmark.com"] },
};
assert.equal(resolveAdapter(ADAPTERS, "www.ebay.com").key, "ebay", "subdomain matches dotted suffix");
assert.equal(resolveAdapter(ADAPTERS, "ebay.co.uk").key, "ebay", "exact host in a multi-host adapter");
assert.equal(resolveAdapter(ADAPTERS, "www.poshmark.com").key, "poshmark", "resolves poshmark");
assert.equal(resolveAdapter(ADAPTERS, "notebay.com"), null, "no false-positive substring match");
assert.equal(resolveAdapter(ADAPTERS, "example.com"), null, "unknown host -> null");

// ── isDetailPage ─────────────────────────────────────────────────────────
assert.equal(isDetailPage({ detect: { pathIncludes: ["/itm/"] } }, "/itm/123"), true, "pathIncludes match");
assert.equal(isDetailPage({ detect: { pathIncludes: ["/itm/"] } }, "/sch/i.html"), false, "non-item path");
assert.equal(isDetailPage({ detect: { pathRegex: "^/items/\\d+" } }, "/items/999"), true, "pathRegex match");
assert.equal(isDetailPage({ detect: {} }, "/anything"), false, "no detect rules -> false");

// ── compareVersions (US-1879) ────────────────────────────────────────────
assert.equal(compareVersions("2026.07.4", "2026.07.4"), 0, "equal versions");
assert.equal(compareVersions("2026.07.10", "2026.07.4"), 1, "10 > 4 numerically (not lexically)");
assert.equal(compareVersions("2026.07.4", "2026.07.10"), -1, "4 < 10");
assert.equal(compareVersions("2026.08.0", "2026.07.99"), 1, "minor bump beats patch");
assert.equal(compareVersions("2027.1.0", "2026.12.9"), 1, "year bump wins");
assert.equal(compareVersions("2026.07", "2026.07.0"), 0, "missing patch == .0");
assert.equal(compareVersions("2026.07.4-draft", "2026.07.4"), -1, "pre-release < release");
assert.equal(compareVersions("2026.07.4", "2026.07.4-draft"), 1, "release > pre-release");
assert.equal(compareVersions("", "2026.07.4"), -1, "empty parses as 0 → older");
assert.equal(compareVersions(null, undefined), 0, "both empty → equal");

// ── isValidConfig (US-1879) ──────────────────────────────────────────────
assert.equal(isValidConfig({ adapters: { ebay: {} } }), true, "non-empty adapters map is valid");
assert.equal(isValidConfig({ adapters: {} }), false, "empty adapters map is invalid");
assert.equal(isValidConfig({}), false, "no adapters is invalid");
assert.equal(isValidConfig(null), false, "null is invalid");

// ── chooseConfig (US-1879: remote only ever upgrades) ─────────────────────
const BUNDLED = { version: "2026.07.4", adapters: { ebay: { hosts: ["ebay.com"] } } };
const newer = { version: "2026.07.9", adapters: { ebay: { hosts: ["ebay.com", "ebay.fr"] } } };
const older = { version: "2026.06.1", adapters: { ebay: { hosts: ["ebay.com"] } } };
const same = { version: "2026.07.4", adapters: { ebay: { hosts: ["ebay.com"] }, vinted: {} } };

assert.equal(chooseConfig(BUNDLED, newer).config, newer, "newer remote is used");
assert.equal(chooseConfig(BUNDLED, newer).reason, "upgrade", "newer → upgrade");
assert.equal(chooseConfig(BUNDLED, same).config, same, "same-version remote is used (>=)");
assert.equal(chooseConfig(BUNDLED, older).config, BUNDLED, "older remote is REJECTED (no downgrade)");
assert.equal(chooseConfig(BUNDLED, older).reason, "downgrade-blocked", "older → downgrade-blocked");
assert.equal(chooseConfig(BUNDLED, null).config, BUNDLED, "no remote → bundled");
assert.equal(chooseConfig(BUNDLED, { version: "9.9.9" }).config, BUNDLED, "invalid remote (no adapters) → bundled");
assert.equal(chooseConfig(BUNDLED, { adapters: {} }).reason, "invalid-remote", "empty-adapters remote → invalid-remote");

console.log("image-utils.test.cjs: all assertions passed");
