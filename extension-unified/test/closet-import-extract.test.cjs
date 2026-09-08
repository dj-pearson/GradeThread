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

// ── 8. Grailed (US-3155) ─────────────────────────────────────────────────
//
// Every selector and URL shape below was read off the LIVE site on 2026-09-08,
// so a case that starts failing is a Grailed change, not a guess that was
// always wrong.
{
  assert.strictEqual(
    X.listingIdFromUrl("grailed", "https://www.grailed.com/listings/100703624-ann-demeulemeester-jean-boots"),
    "100703624",
    "the numeric id LEADS the slug, unlike Poshmark's",
  );
  assert.strictEqual(
    X.listingIdFromUrl("grailed", "https://www.grailed.com/listings/100703624?g_aidx=Listing_by_quality"),
    "100703624",
    "a tracking query does not change the key",
  );
  // Not a listing: a shop page, a browse feed, or a slug carrying no id.
  assert.strictEqual(X.listingIdFromUrl("grailed", "https://www.grailed.com/users/someone"), null);
  assert.strictEqual(X.listingIdFromUrl("grailed", "https://www.grailed.com/shop/mens"), null);
  assert.strictEqual(X.listingIdFromUrl("grailed", "https://www.grailed.com/listings/ann-demeulemeester"), null);
  assert.strictEqual(X.listingIdFromUrl("grailed", "javascript:alert(1)"), null);
}

// ── 9. A Grailed tile becomes a listing, at the LARGE render ─────────────
{
  const built = X.buildListing("grailed", {
    listingUrl: "https://www.grailed.com/listings/100703624-ann-demeulemeester-jean-boots?g_aidx=x",
    title: "Ann Demeulemeester Jean Boots Santiago",
    priceText: "$283",
    sizeText: "11",
    brandText: "Ann Demeulemeester",
    photoUrls: ["https://media-assets.grailed.com/prd/listing/abc123def456?w=240"],
  }, SEL.grailed);

  assert.ok(built, "a well-formed Grailed tile builds");
  assert.strictEqual(built.platformListingId, "100703624");
  assert.strictEqual(
    built.listingUrl,
    "https://www.grailed.com/listings/100703624-ann-demeulemeester-jean-boots",
    "query dropped, canonical",
  );
  assert.strictEqual(built.priceCents, 28300);
  assert.strictEqual(built.size, "11");
  assert.strictEqual(built.brand, "Ann Demeulemeester");
  // Grailed sizes with a ?w= QUERY, so the upgrade rewrites the width in place
  // rather than a path segment. A thumbnail passing as a photo is the exact
  // failure vault/10-ops/extension-adapter-verification.md was written about.
  assert.ok(
    built.photoUrls.every((u) => /[?&]w=1400(?!\d)/.test(u)),
    `every emitted URL is the large render, got ${JSON.stringify(built.photoUrls)}`,
  );

  assert.strictEqual(
    X.buildListing("grailed", { listingUrl: "https://www.grailed.com/users/someone", title: "x" }, SEL.grailed),
    null,
    "a shop page is not a listing",
  );
}

// ── 10. The Grailed adapter claims only what was verified ────────────────
{
  assert.deepStrictEqual(SEL.grailed.hosts, ["grailed.com"]);
  assert.strictEqual(SEL.grailed.enabled, true);
  // `verified` means a human watched a real import produce full-size photos.
  // Reading the markup off the live site is not that, and this stays false
  // until somebody runs one.
  assert.strictEqual(SEL.grailed.verified, false);
  // The owner-only tell is the control that stops another seller's shop being
  // read into the catalogue. An enabled adapter must never have an empty one.
  assert.ok(
    SEL.grailed.closet.ownClosetTell && SEL.grailed.closet.ownClosetTell.length > 10,
    "an enabled closet adapter needs an owner-only tell",
  );
}
