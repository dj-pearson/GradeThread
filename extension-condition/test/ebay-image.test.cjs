// GradeThread Condition Check — unit test for the pure image helpers (US-1755).
//
// The extension has no CI test runner (it ships unpacked / to the stores), so
// this is a zero-dependency node assertion script. Run it manually:
//   node extension-condition/test/ebay-image.test.cjs
// It guards the two bits of logic that are easy to get wrong and hard to notice
// break in the field: upgrading eBay thumbnail URLs to full size, and deduping.

const assert = require("node:assert");
const { upgradeEbayImageUrl, pickImageUrl, dedupeUrls } = require("../content/ebay-image.cjs");

// ── upgradeEbayImageUrl ──────────────────────────────────────────────────
assert.equal(
  upgradeEbayImageUrl("https://i.ebayimg.com/images/g/AbC/s-l64.jpg"),
  "https://i.ebayimg.com/images/g/AbC/s-l1600.jpg",
  "upgrades a thumbnail to s-l1600",
);
assert.equal(
  upgradeEbayImageUrl("https://i.ebayimg.com/images/g/AbC/s-l500.webp"),
  "https://i.ebayimg.com/images/g/AbC/s-l1600.webp",
  "keeps the webp extension",
);
assert.equal(
  upgradeEbayImageUrl("https://i.ebayimg.com/images/g/AbC/s-l140_2.jpg"),
  "https://i.ebayimg.com/images/g/AbC/s-l1600.jpg",
  "drops the _2 variant suffix",
);
assert.equal(
  upgradeEbayImageUrl("https://i.ebayimg.com/thumbs/images/g/AbC/s-l225.jpg?foo=1"),
  "https://i.ebayimg.com/thumbs/images/g/AbC/s-l1600.jpg?foo=1",
  "preserves a query string after the extension",
);
assert.equal(
  upgradeEbayImageUrl("https://example.com/photo-s-l64.jpg"),
  "https://example.com/photo-s-l64.jpg",
  "leaves a non-eBay URL untouched",
);
assert.equal(upgradeEbayImageUrl(""), "", "empty string is a no-op");
assert.equal(upgradeEbayImageUrl(null), null, "null is a no-op");

// ── pickImageUrl ─────────────────────────────────────────────────────────
assert.equal(
  pickImageUrl([null, "  ", "data:image/gif;base64,AAAA", "https://x/y.jpg"]),
  "https://x/y.jpg",
  "skips placeholders and returns the first http(s) URL",
);
assert.equal(pickImageUrl([null, undefined, ""]), null, "no valid candidate → null");

// ── dedupeUrls ───────────────────────────────────────────────────────────
assert.deepEqual(
  dedupeUrls(["a", "a", "b", "c", "b"], 4),
  ["a", "b", "c"],
  "dedupes preserving order",
);
assert.deepEqual(
  dedupeUrls(["a", "b", "c", "d", "e"], 4),
  ["a", "b", "c", "d"],
  "caps at the limit",
);
assert.deepEqual(dedupeUrls([], 4), [], "empty input → empty output");

console.log("ebay-image.test.cjs: all assertions passed");
