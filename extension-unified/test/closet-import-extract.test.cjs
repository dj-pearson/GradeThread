// GradeThread closet import — the allowlist and the parsers (US-9201).
//
// The privacy promise of closet-import/extract.js is that buildListing emits
// exactly ALLOWED_LISTING_FIELDS and nothing a caller hands it. This test
// hands it a row full of things that must never leave the device and asserts
// they did not.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadGlobal(rel, name) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  return new Function("self", `${src}; return self.${name};`)(scope);
}

const X = loadGlobal("closet-import/extract.js", "GT_CLOSET_IMPORT_EXTRACT");
const SEL = loadGlobal("closet-import/selectors.js", "GT_CLOSET_IMPORT_SELECTORS");

const POSH_ID = "5f1e2d3c4b5a69788796a5b4";

// ── 1. The allowlist is the whole output ───────────────────────────────────
{
  const built = X.buildListing("poshmark", {
    listingUrl: `https://poshmark.com/listing/Nice-Tee-${POSH_ID}?src=closet`,
    title: " Nice Tee ",
    priceText: "$24.50",
    sizeText: "M",
    brandText: "Madewell",
    conditionText: "Like new",
    photoUrls: ["https://di2ponv0v5otw.cloudfront.net/posts/2026/01/s_abcdef1234.jpg"],
    // Everything below must vanish.
    buyerName: "someone",
    shippingAddress: "1 Main St",
    sessionCookie: "abc",
    html: "<div>",
    seller: "me",
  }, SEL.poshmark);
  assert.ok(built, "a keyed, titled row builds");
  assert.deepStrictEqual(Object.keys(built).sort(), [...X.ALLOWED_LISTING_FIELDS].sort());
  assert.strictEqual(built.listingUrl, `https://poshmark.com/listing/Nice-Tee-${POSH_ID}`, "query dropped, canonical");
  assert.strictEqual(built.platformListingId, POSH_ID);
  assert.strictEqual(built.title, "Nice Tee");
  assert.strictEqual(built.priceCents, 2450);
  assert.strictEqual(built.size, "M");
  assert.strictEqual(built.brand, "Madewell");
  assert.strictEqual(built.condition, "Like new");
  assert.strictEqual(built.detail, false);
  assert.deepStrictEqual(
    built.photoUrls,
    ["https://di2ponv0v5otw.cloudfront.net/posts/2026/01/l_abcdef1234.jpg"],
    "the Poshmark s_ thumbnail is upgraded to the l_ render through the adapter rule",
  );
  assert.strictEqual(JSON.stringify(built).includes("someone"), false);
  assert.strictEqual(JSON.stringify(built).includes("Main St"), false);
}

// ── 2. Rows that cannot be keyed or named do not build ────────────────────
{
  assert.strictEqual(X.buildListing("poshmark", { listingUrl: "https://poshmark.com/closet/me", title: "x" }, SEL.poshmark), null);
  assert.strictEqual(X.buildListing("poshmark", { listingUrl: `https://poshmark.com/listing/${POSH_ID}` }, SEL.poshmark), null, "no title");
  assert.strictEqual(X.buildListing("mercari", { listingUrl: "https://www.mercari.com/search?keyword=x", title: "x" }, SEL.mercari), null);
  assert.strictEqual(X.buildListing("mercari", null, SEL.mercari), null);
  assert.strictEqual(X.buildListing("depop", { listingUrl: "https://www.depop.com/products/x", title: "x" }, {}), null, "unknown platform has no id shape");
}

// ── 3. Marketplace ids, both shapes ───────────────────────────────────────
{
  assert.strictEqual(X.listingIdFromUrl("mercari", "https://www.mercari.com/us/item/m12345678901/"), "m12345678901");
  assert.strictEqual(X.listingIdFromUrl("mercari", "https://www.mercari.com/item/m98765432109?x=1"), "m98765432109");
  assert.strictEqual(X.listingIdFromUrl("poshmark", `https://poshmark.com/listing/${POSH_ID.toUpperCase()}`), POSH_ID);
  assert.strictEqual(X.listingIdFromUrl("poshmark", "javascript:alert(1)"), null);
  assert.strictEqual(X.listingIdFromUrl("poshmark", 12), null);
}

// ── 4. Prices: null, never zero, for the unreadable ───────────────────────
{
  assert.strictEqual(X.parsePriceCents("$1,234.56"), 123456);
  assert.strictEqual(X.parsePriceCents("US$85"), 8500);
  assert.strictEqual(X.parsePriceCents("Make an offer"), null);
  assert.strictEqual(X.parsePriceCents(""), null);
  assert.strictEqual(X.parsePriceCents(null), null);
}

// ── 5. Photos: upgrade before dedupe, dedupe by asset, cap at MAX_PHOTOS ──
{
  const urls = [
    "https://di2ponv0v5otw.cloudfront.net/posts/1/s_aaaaaaaaaa.jpg",
    "https://di2ponv0v5otw.cloudfront.net/posts/1/m_aaaaaaaaaa.jpg", // same asset, another size
    "https://di2ponv0v5otw.cloudfront.net/posts/1/l_aaaaaaaaaa.jpg", // same asset, already large
    "http://di2ponv0v5otw.cloudfront.net/posts/1/l_bbbbbbbbbb.jpg", // http: refused
    "data:image/png;base64,xxxx", // refused
  ];
  for (let i = 0; i < 12; i++) urls.push(`https://di2ponv0v5otw.cloudfront.net/posts/1/s_${String(i).padStart(10, "c")}.jpg`);
  const out = X.preparePhotoUrls(urls, SEL.poshmark);
  assert.strictEqual(out.length, X.MAX_PHOTOS, `capped at ${X.MAX_PHOTOS}`);
  assert.strictEqual(out[0], "https://di2ponv0v5otw.cloudfront.net/posts/1/l_aaaaaaaaaa.jpg");
  assert.ok(out.every((u) => /\/l_/.test(u)), "every emitted URL is the large render");
  assert.ok(out.every((u) => u.startsWith("https://")));
  assert.strictEqual(new Set(out).size, out.length, "no duplicates");
}

// ── 6. srcset picks the widest candidate whatever the order ──────────────
{
  assert.strictEqual(
    X.srcsetLargest("https://x/a.jpg 800w, https://x/b.jpg 1600w, https://x/c.jpg 400w"),
    "https://x/b.jpg",
  );
  assert.strictEqual(X.srcsetLargest(""), null);
}

// ── 7. The batch dedupes by id and coerces coverage ───────────────────────
{
  const url = `https://poshmark.com/listing/Tee-${POSH_ID}`;
  const batch = X.buildBatch({
    platform: "poshmark",
    page: "closet",
    adapter: SEL.poshmark,
    rawListings: [
      { listingUrl: url, title: "Tee", priceText: "$10" },
      { listingUrl: url, title: "Tee again", priceText: "$9" },
      { listingUrl: "https://poshmark.com/closet/me", title: "not a listing" },
    ],
    coverage: { tilesRead: 3, reachedEnd: "yes" },
  });
  assert.strictEqual(batch.platform, "poshmark");
  assert.strictEqual(batch.page, "closet");
  assert.strictEqual(batch.listings.length, 1);
  assert.strictEqual(batch.listings[0].title, "Tee");
  assert.deepStrictEqual(batch.coverage, { tilesRead: 3, reachedEnd: false }, "a non-boolean reachedEnd under-claims");
  assert.deepStrictEqual(Object.keys(batch).sort(), ["coverage", "listings", "page", "platform"]);
  const other = X.buildBatch({ platform: "mercari", page: "weird", rawListings: "nope" });
  assert.strictEqual(other.page, "closet");
  assert.deepStrictEqual(other.listings, []);
}

// ── 8. A malformed adapter rule never throws into the read ────────────────
{
  assert.strictEqual(X.applyUrlUpgrade("https://x/s_1.jpg", { pattern: "(", replacement: "x" }), "https://x/s_1.jpg");
  assert.strictEqual(X.applyUrlUpgrade("https://x/s_1.jpg", null), "https://x/s_1.jpg");
  assert.deepStrictEqual(X.dedupeUrls(["https://x/a", "https://x/a"], 5, "("), ["https://x/a"]);
}

console.log("closet-import-extract.test.cjs: allowlist holds, ids/prices/photos parse, batch dedupes");
