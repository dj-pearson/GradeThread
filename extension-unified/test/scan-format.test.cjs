// GradeThread unified extension — scan-mode guards (US-2237).
//
// Scan mode badges a marketplace SEARCH grid without grading anything. The risk
// it carries is not a crash — it is a lie: a badge on a result card that a
// shopper reads as a GradeThread grade, when no photo was ever looked at.
//
// So the assertions here are mostly about what must NOT appear. The copy checks
// walk the whole STRINGS table and every badge this module can emit, because the
// failure mode is a well-meaning copy edit ("Grade 7.5") months from now, not a
// bug in today's code.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

// Load the content-script modules the same way Chrome does (classic scripts that
// assign onto `self`), so the test exercises the shipped file, not a copy.
function loadIntoSelf(...relPaths) {
  const selfObj = {};
  for (const rel of relPaths) {
    const src = fs.readFileSync(path.join(dir, rel), "utf8");
     
    new Function("self", "module", src)(selfObj, { exports: {} });
  }
  return selfObj;
}

const scope = loadIntoSelf("research/scan-format.js", "research/image-utils.js");
const SCAN = scope.GT_CC_SCAN;
const IMG = scope.GT_CC_IMG;
assert.ok(SCAN, "research/scan-format.js must assign self.GT_CC_SCAN");
assert.ok(IMG, "research/image-utils.js must assign self.GT_CC_IMG");

// ── the one rule: a scan badge is never a grade ───────────────────────────
//
// Every string this module can put on a card, gathered from the table AND from
// badgeFor across every combination of inputs it accepts.
function everyBadgeString() {
  const out = Object.values(SCAN.STRINGS).map(String);
  const fairness = ["low", "fair", "high", "unknown", null, undefined];
  const claims = [null, 1, 2, 4, 5.5, 6, 7, 8, 9, 9.5, 10, NaN, "8"];
  for (const f of fairness) {
    for (const c of claims) {
      for (const thin of [true, false, null]) {
        const badge = SCAN.badgeFor({ fairness: f, claimedGrade: c, thinPhotos: thin });
        if (badge) for (const p of badge.parts) out.push(p.text);
      }
    }
  }
  return out;
}

const badgeStrings = everyBadgeString();

for (const s of badgeStrings) {
  assert.ok(
    !/\bgrade[sd]?\b/i.test(s) || /condition read/i.test(s),
    `scan badge copy "${s}" uses the word "grade". Nothing on a search page has ` +
      "been graded — no photo is fetched and no Vision call is made. A shopper who " +
      "has seen the detail overlay will read that word as a GradeThread grade.",
  );
  assert.ok(
    !/\d+\.\d/.test(s),
    `scan badge copy "${s}" contains a decimal number. A 1.0-10.0 figure on a result ` +
      "card is indistinguishable from the overlay's real score.",
  );
}

// ── claimLabel: the seller's word, never our number ───────────────────────
assert.strictEqual(SCAN.claimLabel(10), "new with tags");
assert.strictEqual(SCAN.claimLabel(9), "new without tags");
assert.strictEqual(SCAN.claimLabel(8), "like new");
assert.strictEqual(SCAN.claimLabel(6), "good");
assert.strictEqual(SCAN.claimLabel(4.5), "fair");
assert.strictEqual(SCAN.claimLabel(2), "poor");
for (const junk of [null, undefined, NaN, 0, 11, -3, "", "eight", {}]) {
  assert.strictEqual(
    SCAN.claimLabel(junk),
    null,
    `claimLabel(${JSON.stringify(junk)}) must be null — an unreadable claim renders ` +
      "nothing, never a guessed tier",
  );
}

// The claim is always attributed to the seller, so no reader can take it as ours.
const claimBadge = SCAN.badgeFor({ claimedGrade: 8, fairness: "unknown" });
assert.ok(claimBadge, "a readable claim alone is worth a badge");
assert.ok(
  claimBadge.parts.every((p) => !/^like new$/i.test(p.text)),
  "the claimed condition must be attributed (e.g. 'seller: like new'), never bare",
);
assert.ok(
  claimBadge.parts.some((p) => /seller/i.test(p.text)),
  "the claim chip must name the seller as its source",
);

// ── badgeFor: nothing honest to say → no badge at all ─────────────────────
assert.strictEqual(
  SCAN.badgeFor({ claimedGrade: null, fairness: "unknown", thinPhotos: false }),
  null,
  "an unreadable card must render NO badge. A row of empty pills across a grid we " +
    "couldn't parse is worse than not shipping the feature.",
);
assert.strictEqual(SCAN.badgeFor(null), null);
assert.strictEqual(SCAN.badgeFor("nonsense"), null);

// 'unknown' fairness contributes nothing — a shrug rendered as a chip reads as a
// verdict, and thin comps are exactly when a wrong verdict is most likely.
const unknownOnly = SCAN.badgeFor({ claimedGrade: 6, fairness: "unknown" });
assert.strictEqual(unknownOnly.parts.length, 1, "'unknown' fairness must add no chip");

// ── badgeFor: severity follows the price verdict, warn never masks bad ────
assert.strictEqual(SCAN.badgeFor({ fairness: "low" }).cls, "gt-cc-b-good");
assert.strictEqual(SCAN.badgeFor({ fairness: "high" }).cls, "gt-cc-b-bad");
assert.strictEqual(SCAN.badgeFor({ fairness: "fair" }).cls, "gt-cc-b-neutral");
assert.strictEqual(
  SCAN.badgeFor({ fairness: "high", thinPhotos: true }).cls,
  "gt-cc-b-bad",
  "a thin-photo warning must not downgrade an over-priced card's severity",
);
assert.strictEqual(
  SCAN.badgeFor({ fairness: "unknown", thinPhotos: true }).cls,
  "gt-cc-b-warn",
  "with no price verdict, the photo warning is the severity",
);

// ── searchQueryFrom: one query for the whole grid ─────────────────────────
assert.strictEqual(
  SCAN.searchQueryFrom("https://www.ebay.com/sch/i.html?_nkw=patagonia+fleece", ["_nkw"]),
  "patagonia fleece",
);
assert.strictEqual(
  SCAN.searchQueryFrom("https://www.vinted.com/catalog?search_text=nike", ["search_text", "q"]),
  "nike",
);
assert.strictEqual(
  SCAN.searchQueryFrom("https://www.ebay.com/sch/i.html", ["_nkw"]),
  "",
  "no query param → empty string, so the endpoint simply skips comps",
);
assert.strictEqual(SCAN.searchQueryFrom("not a url", ["q"]), "");
assert.strictEqual(SCAN.searchQueryFrom(null, ["q"]), "");
assert.strictEqual(
  SCAN.searchQueryFrom("https://x.test/s?q=" + encodeURIComponent("a".repeat(400)), ["q"]).length,
  200,
  "the query is capped before it leaves the browser",
);

// ── cardKey: a card and its detail page must agree ────────────────────────
// The key is the same origin+path identity marketplace.js uses for its per-
// listing grade cache, so the card the shopper clicks and the listing they land
// on are recognisably the same item.
const withQuery = SCAN.cardKey("https://www.ebay.com/itm/12345?hash=abc&var=1", 0);
const withoutQuery = SCAN.cardKey("https://www.ebay.com/itm/12345", 3);
assert.strictEqual(withQuery, withoutQuery, "tracking params must not split the key");
assert.strictEqual(withQuery, "https://www.ebay.com/itm/12345");
assert.strictEqual(
  SCAN.cardKey("https://www.ebay.com/itm/12345/", 0),
  "https://www.ebay.com/itm/12345",
  "a trailing slash must not split the key",
);
assert.strictEqual(SCAN.cardKey("", 7), "idx:7", "a linkless card falls back to its index");
assert.strictEqual(SCAN.cardKey(null, 2), "idx:2");

// ── usableCards: no badge without a destination, no duplicate badges ──────
const cards = [
  { key: "a", href: "https://x.test/1" },
  { key: "b", href: "" }, // unclickable — a badge would advertise a dead action
  { key: "a", href: "https://x.test/1" }, // promoted listings repeat in grids
  { key: "c", href: "https://x.test/3" },
];
assert.deepStrictEqual(
  SCAN.usableCards(cards).map((c) => c.key),
  ["a", "c"],
);
assert.strictEqual(
  SCAN.usableCards(Array.from({ length: 100 }, (_, i) => ({ key: "k" + i, href: "https://x/" + i }))).length,
  SCAN.MAX_CARDS,
);
assert.strictEqual(
  SCAN.MAX_CARDS,
  24,
  "MAX_CARDS must match MAX_SCAN_CARDS in services/edge-functions/src/routes/public-grading.ts — " +
    "the server caps too, so drift just means posting cards we know will be trimmed",
);

// ── isSearchPage: a detail page always wins ───────────────────────────────
const cfg = loadIntoSelf("research/selectors.js").GT_CC_CONFIG;
const ebay = IMG.resolveAdapter(cfg.adapters, "www.ebay.com");
assert.ok(ebay.search, "every adapter must carry a search block for scan mode");
assert.strictEqual(IMG.isSearchPage(ebay, "/sch/i.html"), true);
assert.strictEqual(IMG.isSearchPage(ebay, "/itm/12345"), false);
assert.strictEqual(IMG.isDetailPage(ebay, "/itm/12345"), true);
assert.strictEqual(
  IMG.isSearchPage({ detect: { pathIncludes: ["/itm/"] } }, "/itm/1"),
  false,
  "an adapter with no search block is never scanned",
);

// Every adapter's search block is complete enough to act on: without a card
// selector there is nothing to badge, and without a link the badge's CTA is dead.
for (const [key, a] of Object.entries(cfg.adapters)) {
  // US-3067: a SOURCING adapter must have NO search block, and that is the
  // stronger half of this loop rather than an exemption from it. The scan is
  // the anonymous condition read applied to a results grid, and on a sourcing
  // site there is no seller claim to check -- a search block here would put
  // grades on a charity's donation photos. Absence is enforced, not tolerated.
  if (a.sourcing === true) {
    assert.ok(
      !a.search,
      `sourcing adapter ${key} must NOT carry a search block (US-3067 AC4)`,
    );
    continue;
  }
  assert.ok(a.search, `adapter ${key} is missing its search block`);
  assert.ok(
    Array.isArray(a.search.card) && a.search.card.length,
    `adapter ${key}.search.card must list at least one result-tile selector`,
  );
  assert.ok(
    Array.isArray(a.search.link) && a.search.link.length,
    `adapter ${key}.search.link must list at least one listing-link selector`,
  );
  assert.ok(
    a.search.detect && Array.isArray(a.search.detect.pathIncludes) &&
      a.search.detect.pathIncludes.length,
    `adapter ${key}.search.detect.pathIncludes must say which paths are search pages`,
  );
  // A path that is BOTH a detail and a search match would flip-flop between the
  // two surfaces depending on evaluation order.
  for (const p of a.search.detect.pathIncludes) {
    assert.ok(
      !IMG.isDetailPage(a, p),
      `adapter ${key}: search path "${p}" also matches its detail detect — the two ` +
        "surfaces would fight over the same page",
    );
  }
}

// ── the content script must honour the server's signal guard ──────────────
const mkt = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");
assert.ok(
  /claimed-condition-and-price/.test(mkt),
  "marketplace.js must refuse to render a scan response whose `signal` is not " +
    "'claimed-condition-and-price'. If the endpoint ever returns graded reads on " +
    "this path, the badges must not silently start presenting them as triage.",
);
assert.ok(
  /GT_CC_SCAN/.test(fs.readFileSync(path.join(dir, "background.js"), "utf8")),
  "background.js must route GT_CC_SCAN — content scripts have no network path of their own",
);

console.log(
  `scan-format.test.cjs: ${badgeStrings.length} badge strings carry no grade wording or score, ` +
    `${Object.keys(cfg.adapters).length} adapters have complete search blocks`,
);

// ── the re-scan tick must stop when we leave the search page ──────────────
//
// Grids paginate by infinite scroll, so a periodic tick re-scans for cards the
// initial pass never saw. That tick is gated on `onSearchPage`, and boot() bails
// BEFORE setting it for a page that is neither a detail nor a search page — so
// invalidate() (which runs on every navigation) is the only thing that can clear
// it. Without that clear, navigating from a search page to a page boot bails on
// leaves the tick running the OLD adapter's card selectors against the NEW page.
const SRC = mkt
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

const invalidateBody = /function invalidate\(\)\s*\{([\s\S]*?)\n {2}\}/.exec(SRC);
assert.ok(invalidateBody, "marketplace.js must still define invalidate()");
assert.ok(
  /onSearchPage\s*=\s*false/.test(invalidateBody[1]),
  "invalidate() must clear onSearchPage. It runs on every navigation, and it is the " +
    "only clear that covers a navigation to a page boot() bails on before it sets " +
    "the flag — otherwise the re-scan tick keeps badging with a stale adapter.",
);
assert.ok(
  /scanning\s*=\s*false/.test(invalidateBody[1]),
  "invalidate() must drop an in-flight scan — its cards belong to the previous grid",
);
assert.ok(
  /if\s*\(!onSearchPage\s*\|\|\s*!scanEnabled\s*\|\|\s*scanning\)\s*return;/.test(SRC),
  "the re-scan tick must be gated on onSearchPage + scanEnabled + not-already-scanning",
);
