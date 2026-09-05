// research/listing-badge.js — the on-marketplace verified badge (US-3060 AC5).
//
// The rule this file exists to hold: ABSENCE IS NOT A CLAIM. A miss, a 4xx, a
// 5xx, a dead network and a malformed body all render nothing. There is no
// "unverified" badge, because every ungraded listing on the page would become
// something our extension appears to have judged, and most of those sellers
// have never heard of us.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// A UMD content script, kept `.js` because Chrome rejects a `.cjs` content
// script. The repo is type:module, so require() of a .js returns an empty
// object rather than throwing — the quiet version of this mistake. Load it the
// way Chrome does: run the source with an injected `self`.
function load(rel, global, seed) {
  const src = fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
  const selfObj = seed || {};
  new Function("self", src)(selfObj);
  assert.ok(selfObj[global], `${rel} must assign self.${global}`);
  return selfObj[global];
}

const BADGE = load("research/listing-badge.js", "GT_LISTING_BADGE");

// ── The id rule is MIRRORED, so pin it to its source ────────────────────────
//
// listing-badge.js carries its own copy of the Poshmark and Mercari id regexes
// because the closet-import bundle is not loaded on a marketplace listing page.
// Three copies of one rule is a real cost; this is what makes it safe. A change
// in closet-import/extract.js fails HERE rather than quietly leaving the badge
// looking up ids the server keys differently.
(function idRegexesMatchTheirSource() {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "closet-import", "extract.js"),
    "utf8",
  );
  for (const [name, re] of [
    ["POSHMARK_ID_RE", BADGE.POSHMARK_ID_RE],
    ["MERCARI_ID_RE", BADGE.MERCARI_ID_RE],
  ]) {
    const literal = re.toString();
    assert.ok(
      src.includes(literal),
      `${name} is ${literal}, which does not appear in closet-import/extract.js. ` +
        `The two must stay identical — the server keys listings by whichever ` +
        `one wrote the row.`,
    );
  }
})();

// ── Id extraction, per platform ─────────────────────────────────────────────

(function ebayIdsComeFromTheUrl() {
  // US-3042's rule: on eBay the ONLY thing read off the page is the item id.
  assert.strictEqual(
    BADGE.listingIdFromUrl("ebay", "https://www.ebay.com/itm/123456789012"),
    "123456789012",
  );
  // A slugged eBay URL still ends in the id.
  assert.strictEqual(
    BADGE.listingIdFromUrl("ebay", "https://www.ebay.co.uk/itm/vintage-jacket/265412345678"),
    "265412345678",
  );
  // Too short, too long, and not a number at all.
  for (const url of [
    "https://www.ebay.com/itm/12345678",
    "https://www.ebay.com/itm/1234567890123456",
    "https://www.ebay.com/sch/i.html?_nkw=jacket",
    "https://www.ebay.com/b/Mens-Coats/57988",
  ]) {
    assert.strictEqual(BADGE.listingIdFromUrl("ebay", url), null, url);
  }
})();

(function poshmarkAndMercariIds() {
  assert.strictEqual(
    BADGE.listingIdFromUrl(
      "poshmark",
      "https://poshmark.com/listing/Patagonia-Fleece-5f3a1b2c3d4e5f6a7b8c9d0e",
    ),
    "5f3a1b2c3d4e5f6a7b8c9d0e",
  );
  assert.strictEqual(
    BADGE.listingIdFromUrl("mercari", "https://www.mercari.com/us/item/m12345678901/"),
    "m12345678901",
  );
  // A closet page, a search page and a brand page are not listings.
  for (const [p, url] of [
    ["poshmark", "https://poshmark.com/closet/someone"],
    ["poshmark", "https://poshmark.com/brand/Patagonia"],
    ["mercari", "https://www.mercari.com/search/?keyword=jacket"],
    ["mercari", "https://www.mercari.com/us/item/notanid/"],
  ]) {
    assert.strictEqual(BADGE.listingIdFromUrl(p, url), null, `${p} ${url}`);
  }
})();

(function unknownPlatformsAndJunk() {
  // depop and grailed have no id extractor, so they are not badge platforms —
  // a platform in the list with no extractor is a request that always misses.
  assert.strictEqual(BADGE.isBadgePlatform("depop"), false);
  assert.strictEqual(BADGE.isBadgePlatform("grailed"), false);
  assert.strictEqual(
    BADGE.listingIdFromUrl("depop", "https://www.depop.com/products/x-y/"),
    null,
  );
  for (const bad of [null, undefined, 42, "", "not a url", "javascript:alert(1)"]) {
    assert.strictEqual(BADGE.listingIdFromUrl("ebay", bad), null, String(bad));
  }
})();

// ── The batch ───────────────────────────────────────────────────────────────

(function batchDeDuplicatesThenCaps() {
  const one = "https://www.ebay.com/itm/123456789012";
  // A grid repeats promoted listings. Eight copies of one item is ONE id, not
  // eight slots spent and not a rejected request.
  const ids = BADGE.badgeIdsFromUrls("ebay", new Array(8).fill(one));
  assert.deepStrictEqual(ids, ["123456789012"]);

  // Thirty distinct ids cap at MAX_IDS, and the cap matches the server's.
  const many = [];
  for (let i = 0; i < 30; i++) many.push(`https://www.ebay.com/itm/12345678${1000 + i}`);
  assert.strictEqual(BADGE.badgeIdsFromUrls("ebay", many).length, BADGE.MAX_IDS);
  assert.strictEqual(BADGE.MAX_IDS, 24);

  // Non-listing hrefs are dropped rather than sent, so a grid of mostly
  // category links does not spend the batch on them.
  const mixed = [one, "https://www.ebay.com/b/Mens/57988", "", null];
  assert.deepStrictEqual(BADGE.badgeIdsFromUrls("ebay", mixed), ["123456789012"]);
  assert.deepStrictEqual(BADGE.badgeIdsFromUrls("ebay", []), []);
  assert.deepStrictEqual(BADGE.badgeIdsFromUrls("ebay", null), []);
})();

(function requestUrlIsEncoded() {
  const url = BADGE.badgeRequestUrl("https://functions.gradethread.com/", "ebay", ["1", "2"]);
  assert.strictEqual(
    url,
    "https://functions.gradethread.com/api/grading/public/listing-certificates?platform=ebay&ids=1%2C2",
  );
  assert.ok(url.indexOf(BADGE.ENDPOINT) !== -1);
})();

// ── The 60-second refusal ───────────────────────────────────────────────────

(function oneRequestPerPageNotPerScroll() {
  let now = 1_000_000;
  const gate = BADGE.makeBadgeGate(() => now);

  assert.strictEqual(gate.allow(), true, "the first ask must go through");
  assert.strictEqual(gate.allow(), false, "an immediate second ask must be refused");

  now += 59_000;
  assert.strictEqual(gate.allow(), false, "still inside the window");

  now += 2_000; // 61s since the first
  assert.strictEqual(gate.allow(), true, "past the window, allowed again");
  assert.strictEqual(gate.allow(), false, "and the window restarts from THAT ask");

  assert.strictEqual(BADGE.REFUSAL_WINDOW_MS, 60_000);
})();

(function askingSpendsTheSlotEvenIfTheFetchFails() {
  // Deliberate: a page erroring in a retry loop must not become a request per
  // retry. The caller that asked has spent its slot whether or not it went on
  // to fetch anything.
  let now = 0;
  const gate = BADGE.makeBadgeGate(() => now);
  assert.strictEqual(gate.allow(), true);
  now += 100;
  for (let i = 0; i < 20; i++) assert.strictEqual(gate.allow(), false);
})();

// ── Reading the answer: every failure renders nothing ───────────────────────

(function malformedBodiesProduceNoBadges() {
  for (const body of [
    null,
    undefined,
    "",
    "not json",
    42,
    {},
    { certificates: null },
    { certificates: "nope" },
    { certificates: {} },
    { found: 3 }, // a count with no rows
  ]) {
    assert.deepStrictEqual(
      Object.keys(BADGE.badgesFromResponse(body)),
      [],
      `a badge was produced from ${JSON.stringify(body)}`,
    );
  }
})();

(function oneBadRowCostsThatRowAndNotThePage() {
  const good = { listingId: "111", grade: 8.5, tier: "Excellent", path: "/cert/GT-1" };
  const out = BADGE.badgesFromResponse({
    certificates: [
      null,
      { listingId: "", grade: 9, tier: "Mint", path: "/cert/x" }, // no id
      { listingId: "222", grade: null, tier: "Mint", path: "/cert/x" }, // no grade
      { listingId: "333", grade: 9, tier: "", path: "/cert/x" }, // no tier
      { listingId: "444", grade: 9, tier: "Mint", path: "" }, // nowhere to go
      { listingId: "555", grade: Infinity, tier: "Mint", path: "/cert/x" },
      good,
    ],
  });
  assert.deepStrictEqual(Object.keys(out), ["111"]);
  assert.deepStrictEqual(out["111"], good);
})();

(function duplicateRowsResolveFirstWins() {
  const out = BADGE.badgesFromResponse({
    certificates: [
      { listingId: "dup", grade: 8, tier: "A", path: "/cert/FIRST" },
      { listingId: "dup", grade: 9, tier: "B", path: "/cert/SECOND" },
    ],
  });
  assert.strictEqual(out["dup"].path, "/cert/FIRST");
})();

// ── What it renders ─────────────────────────────────────────────────────────

(function labelPutsTheGradeFirst() {
  assert.strictEqual(
    BADGE.badgeLabel({ grade: 8.5, tier: "Excellent" }),
    "8.5 · Excellent",
  );
  // One decimal always, because 9 and 9.0 next to each other on a grid reads
  // like two different precisions of claim.
  assert.strictEqual(BADGE.badgeLabel({ grade: 9, tier: "Mint" }), "9.0 · Mint");
  assert.strictEqual(BADGE.badgeLabel(null), "");
  assert.ok(BADGE.STRINGS.attribution.indexOf("GradeThread") !== -1);
})();

(function certificateLinkGoesThroughAttributionJs() {
  // Built by the REAL attribution.js, not a hand-rolled query string, so this
  // asserts the shape the certificate page will actually receive.
  const ATTR = load("attribution.js", "GT_ATTRIBUTION");
  const url = BADGE.certificateUrl(ATTR, { path: "/cert/GT-ABC" }, "poshmark");
  const u = new URL(url);

  assert.strictEqual(u.origin + u.pathname, "https://gradethread.com/cert/GT-ABC");

  // ⚠ THE PLATFORM IS IN utm_campaign, AND utm_source STAYS "extension".
  // attribution.js puts utm_source=extension on every link the extension places
  // on the site — that is how extension traffic is told apart from every other
  // channel. The first version of certificateUrl overwrote it with the
  // marketplace name, which would have made this one link type invisible as
  // extension traffic to answer a question utm_campaign already answers.
  assert.strictEqual(u.searchParams.get("utm_source"), "extension");
  assert.strictEqual(u.searchParams.get("utm_medium"), "badge");
  assert.strictEqual(u.searchParams.get("utm_campaign"), "poshmark");

  // utm_medium=badge is what the certificate page keys the arrival note and the
  // badge_certificate_click event on (src/lib/badge-arrival.ts). Without it the
  // whole site side of the loop is silent.
  assert.strictEqual(BADGE.certificateUrl(ATTR, null, "ebay"), null);

  // ⚠ AND WITH NO ATTRIBUTION MODULE IT RETURNS NULL, NOT A HAND-BUILT LINK.
  // The first version fell back to a literal https://gradethread.com URL, and
  // attribution.test.cjs refused it by name: a hand-built link reaches the site
  // with no funnel tags and its signups are recorded as direct traffic. Null is
  // also the rule the rest of this file follows — a badge with nowhere honest
  // to point does not render.
  assert.strictEqual(BADGE.certificateUrl(null, { path: "/cert/X" }, "ebay"), null);
})();

console.log("listing-badge.test.cjs: ok");
