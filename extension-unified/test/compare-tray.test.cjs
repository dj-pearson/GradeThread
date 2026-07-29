// GradeThread unified extension — compare tray (US-2240).
//
// The tray stores a SNAPSHOT of a read the shopper already paid for. What can go
// wrong is mostly about that word:
//
//   1. IT SPENDS SOMETHING. Pinning must replay the payload already in hand. If
//      it ever grades again it is quietly billing the shopper for a button that
//      says "Pin".
//   2. IT DUPLICATES OR EVICTS THE WRONG THING. A re-read must UPDATE its row,
//      not add a second one the shopper then compares against itself.
//   3. IT SORTS DISHONESTLY. A listing with no readable price is not "the
//      cheapest", and a row with no score is not the worst-conditioned one.
//
// Zero-dependency node script: throws on drift.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function loadIntoSelf(rel) {
  const selfObj = {};
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  // eslint-disable-next-line no-new-func
  new Function("self", "module", src)(selfObj, { exports: {} });
  return selfObj;
}

const T = loadIntoSelf("research/compare-tray.js").GT_CC_TRAY;
assert.ok(T, "research/compare-tray.js must assign self.GT_CC_TRAY");

const DATA = {
  overallScore: 7.5,
  gradeTier: "Good",
  confidence: 0.82,
  imagesAnalyzed: 4,
  priceFairness: { verdict: "low", deltaPct: -30 },
};

function listing(over) {
  return Object.assign(
    {
      url: "https://www.ebay.com/itm/12345?hash=abc",
      title: "Patagonia Better Sweater",
      marketplace: "ebay",
      seller: "thriftco",
      priceText: "$60.00",
      thumbUrl: "https://i.ebayimg.com/x.jpg",
    },
    over,
  );
}

// ── makeEntry: a snapshot, keyed like the grade cache ─────────────────────
const entry = T.makeEntry(listing(), DATA, 1000);
assert.strictEqual(
  entry.key,
  "https://www.ebay.com/itm/12345",
  "the tray key drops query params, matching the grade cache — a card, a pin and " +
    "a listing must all resolve to the same item",
);
assert.strictEqual(entry.overallScore, 7.5);
assert.strictEqual(entry.fairness, "low");
assert.strictEqual(entry.imagesAnalyzed, 4);
assert.strictEqual(entry.at, 1000);

assert.strictEqual(
  T.makeEntry({ url: "not a url" }, DATA, 1),
  null,
  "a row we can't link back to is a dead line in the table",
);
assert.strictEqual(T.makeEntry(null, DATA, 1), null);

// A missing priceFairness (anonymous tier — it is a paid signal) is 'unknown',
// never a fabricated verdict.
assert.strictEqual(T.makeEntry(listing(), { overallScore: 7 }, 1).fairness, "unknown");
assert.strictEqual(T.fairnessLabel({ fairness: "unknown" }), "", "'unknown' renders nothing");

// ── NaN can never reach the table ─────────────────────────────────────────
for (const bad of [NaN, Infinity, null, undefined, "seven", 0, 11, -2]) {
  const e = T.makeEntry(listing(), { overallScore: bad }, 1);
  assert.strictEqual(e.overallScore, null, `overallScore ${bad} must store as null`);
  assert.strictEqual(T.scoreLabel(e), "—", "and render as an em dash, never 'NaN'");
}
assert.strictEqual(T.scoreClass(null), "gt-cc-s-none");

// ── put: a re-read updates its row, it does not duplicate it ──────────────
let list = T.put([], T.makeEntry(listing(), DATA, 1));
list = T.put(list, T.makeEntry(listing(), Object.assign({}, DATA, { overallScore: 6 }), 2));
assert.strictEqual(list.length, 1, "the same listing pinned twice is ONE row");
assert.strictEqual(list[0].overallScore, 6, "and the row carries the newer read");

// A different listing is a different row.
list = T.put(list, T.makeEntry(listing({ url: "https://www.ebay.com/itm/999" }), DATA, 3));
assert.strictEqual(list.length, 2);
assert.ok(T.has(list, "https://www.ebay.com/itm/999"));
assert.ok(!T.has(list, "https://www.ebay.com/itm/does-not-exist"));

// ── put: oldest-out at the cap, rather than refusing the click ────────────
assert.strictEqual(T.MAX, 6);
let full = [];
for (let i = 0; i < 10; i++) {
  full = T.put(full, T.makeEntry(listing({ url: "https://x.test/itm/" + i }), DATA, i));
}
assert.strictEqual(full.length, T.MAX);
assert.deepStrictEqual(
  full.map((e) => e.key),
  ["4", "5", "6", "7", "8", "9"].map((n) => "https://x.test/itm/" + n),
  "the OLDEST pins fall off — the shopper's most recent thinking survives",
);

// put on junk never throws and never corrupts the list.
assert.deepStrictEqual(T.put(null, null), []);
assert.deepStrictEqual(T.put(undefined, { key: "" }), []);
assert.deepStrictEqual(T.remove(null, "x"), []);

// ── sortRows: missing values sink, in BOTH directions ─────────────────────
const rows = [
  T.makeEntry(listing({ url: "https://x.test/a", priceText: "$100" }), { overallScore: 5 }, 1),
  T.makeEntry(listing({ url: "https://x.test/b", priceText: "$20" }), { overallScore: 9 }, 2),
  T.makeEntry(listing({ url: "https://x.test/c", priceText: "Make an offer" }), { overallScore: 7 }, 3),
  T.makeEntry(listing({ url: "https://x.test/d", priceText: "$50" }), { overallScore: NaN }, 4),
];

assert.deepStrictEqual(
  T.sortRows(rows, "price").map((e) => e.priceText),
  ["$20", "$50", "$100", "Make an offer"],
  "cheapest first, and a listing with no readable price is NOT the cheapest — it " +
    "sinks, because 'Make an offer' sorting to the top would read as free",
);
assert.deepStrictEqual(
  T.sortRows(rows, "score").map((e) => T.scoreLabel(e)),
  ["9.0", "7.0", "5.0", "—"],
  "best condition first, and an ungraded row sinks rather than counting as worst",
);
assert.deepStrictEqual(
  T.sortRows(rows, "recent").map((e) => e.at),
  [4, 3, 2, 1],
  "the default is the order the shopper built, newest first",
);
// Sorting must not mutate the caller's array — the view re-sorts on every change.
const before = rows.map((e) => e.key);
T.sortRows(rows, "price");
assert.deepStrictEqual(rows.map((e) => e.key), before, "sortRows must be non-mutating");

// ── priceCents matches the server's parser ────────────────────────────────
assert.strictEqual(T.priceCents({ priceText: "$1,299.00" }), 129900);
assert.strictEqual(T.priceCents({ priceText: "Make an offer" }), null);
assert.strictEqual(T.priceCents({}), null);
assert.strictEqual(T.priceCents(null), null);

// ── the tray costs nothing to fill ────────────────────────────────────────
const mkt = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");
const pinBlock = /function pinControls\([^)]*\)\s*\{([\s\S]*?)\n  \}/.exec(mkt);
assert.ok(pinBlock, "marketplace.js must define pinControls");
assert.ok(
  !/GT_CC_GRADE|runGrade\(\)/.test(pinBlock[1]),
  "pinning must replay the payload already in `data`. Re-grading here would spend " +
    "the shopper's quota on a button labelled 'Pin to compare'.",
);
assert.ok(
  /makeEntry\(/.test(pinBlock[1]),
  "the row must be built from the already-returned grade payload",
);

const cmp = fs.readFileSync(path.join(dir, "compare.js"), "utf8");
assert.ok(
  !/\bfetch\s*\(/.test(cmp),
  "the compare view must render entirely from storage — it is a record of reads " +
    "the shopper already has, not a live re-query",
);

// ── the tray survives a browser restart ───────────────────────────────────
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const pinFn = /async function pinToTray\([\s\S]*?\n\}/.exec(bg);
assert.ok(pinFn, "background.js must define pinToTray");
assert.ok(
  /storage\.local/.test(pinFn[0]) && !/storage\.session/.test(pinFn[0]),
  "the tray is storage.LOCAL. Shoppers compare across sittings ('I'll decide " +
    "tonight'), and storage.session empties on browser restart — losing exactly " +
    "the comparison the tray exists to hold.",
);
assert.ok(
  /return \{ ok: false/.test(pinFn[0]),
  "a failed write must report failure, so the overlay does not flip to 'Pinned' " +
    "over a read that was never stored",
);

// The compare page must NOT be web-accessible: it is opened by the worker via
// tabs.create, so it never needs to be a navigation target for marketplace pages.
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
assert.ok(
  !manifest.web_accessible_resources,
  "compare.html is opened through the worker (GT_CC_TRAY_OPEN → tabs.create). " +
    "Linking to it from a content script would require web_accessible_resources, " +
    "exposing the page to every marketplace we run on to save one message.",
);
assert.ok(/GT_CC_TRAY_OPEN/.test(bg), "the worker must handle GT_CC_TRAY_OPEN");
for (const f of ["compare.html", "compare.js", "compare.css"]) {
  assert.ok(fs.existsSync(path.join(dir, f)), `${f} must exist — the worker opens it`);
}

console.log(
  "compare-tray.test.cjs: pinning spends nothing, re-reads update in place, " +
    "oldest-out at 6, missing price/score sink in sorts, tray survives restart",
);
