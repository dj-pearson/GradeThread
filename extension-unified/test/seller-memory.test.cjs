// GradeThread unified extension — buyer-private seller memory (US-2239).
//
// This feature says something about a named person on a marketplace, from data
// the shopper collected themselves. Three ways it could go wrong, one test block
// each:
//
//   1. IT SPEAKS TOO SOON. One read of one item is a coincidence. Rendered as a
//      pattern, a single bad photo set becomes a verdict about a seller.
//   2. IT SPEAKS TOO STRONGLY. The line must stay an observation the shopper
//      made, never an accusation GradeThread is making — no fraud/scam/liar
//      wording anywhere in the surface.
//   3. IT LEAKS. The seller handle is stored on-device and must never be
//      attached to a request, and no seller-standing row may be written
//      anywhere (US-2148 is explicit that this needs its own model).
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

const S = loadIntoSelf("research/seller-memory.js").GT_CC_SELLER;
assert.ok(S, "research/seller-memory.js must assign self.GT_CC_SELLER");

function read(over) {
  return Object.assign(
    {
      marketplace: "ebay",
      seller: "thriftco",
      overallScore: 6,
      claimedGrade: 8,
      at: 1_700_000_000_000,
    },
    over,
  );
}

// ── 1. it refuses to speak from one sample ────────────────────────────────
assert.strictEqual(S.MIN_READS, 2, "the floor is two reads");
assert.strictEqual(
  S.aggregate([read()]),
  null,
  "ONE read must produce no aggregate. A single listing with bad photos would " +
    "otherwise render as a pattern about a person.",
);
assert.strictEqual(S.aggregate([]), null);
assert.strictEqual(S.aggregate(null), null);
assert.strictEqual(S.sellerCopy(null), null);
assert.strictEqual(
  S.sellerCopy({ reads: 1, avgClaimedDelta: -3 }),
  null,
  "even a huge gap says nothing at one read",
);
assert.deepStrictEqual(
  S.groupBySeller([read()]),
  [],
  "a seller read once must not appear in the By seller list at all",
);

// ── 2. it stays an observation, never an accusation ───────────────────────
function everyString() {
  const out = Object.values(S.STRINGS).map(String);
  for (const reads of [2, 3, 9]) {
    for (const delta of [-4, -2, -1, -0.6, -0.4, 0, 0.4, 0.6, 2, 4, null]) {
      const copy = S.sellerCopy({ reads, avgClaimedDelta: delta, avgOverall: 6, lastAt: 1 });
      if (copy) out.push(copy);
    }
  }
  return out;
}

const BANNED = /\b(fraud|fraudulent|scam|scammer|liar|lying|dishonest|counterfeit|fake|avoid this seller)\b/i;
for (const s of everyString()) {
  assert.ok(
    !BANNED.test(s),
    `seller copy "${s}" makes an accusation. This aggregate is a handful of the ` +
      "shopper's own reads with no confirmed outcome behind it — US-2148 is " +
      "explicit that a seller-adverse signal needs a human-confirmed basis, which " +
      "this does not have.",
  );
  assert.ok(
    /\byour\b/i.test(s) || /no repeat sellers/i.test(s) || /^By seller$/.test(s),
    `seller copy "${s}" must be framed as the shopper's own finding ("Your N reads…")`,
  );
}

// A small gap is not worth naming at all — it would manufacture a complaint out
// of rounding.
assert.strictEqual(S.NOTABLE_GAP, 0.5);
const tight = S.sellerCopy({ reads: 4, avgClaimedDelta: -0.4 });
assert.ok(/line up/i.test(tight), "a sub-threshold gap reads as agreement, not as a finding");

// Direction matters and must not be flipped: negative delta = read WORSE than
// claimed, which is the direction a shopper is protecting themselves against.
assert.ok(/average 2.0 points below/i.test(S.sellerCopy({ reads: 3, avgClaimedDelta: -2 })));
assert.ok(/came in 2.0 points above/i.test(S.sellerCopy({ reads: 3, avgClaimedDelta: 2 })));
assert.ok(
  /1.0 point\b/.test(S.sellerCopy({ reads: 2, avgClaimedDelta: -1 })),
  "one point is singular",
);

// ── 3. the maths ──────────────────────────────────────────────────────────
const agg = S.aggregate([
  read({ overallScore: 6, claimedGrade: 8 }),
  read({ overallScore: 7, claimedGrade: 8, at: 1_700_000_100_000 }),
]);
assert.strictEqual(agg.reads, 2);
assert.strictEqual(agg.avgOverall, 6.5);
assert.strictEqual(agg.avgClaimedDelta, -1.5);
assert.strictEqual(agg.lastAt, 1_700_000_100_000, "lastAt is the newest read, not the first");

// A read with no claim still counts as a read, but cannot fabricate a delta.
const partial = S.aggregate([
  read({ overallScore: 6, claimedGrade: 8 }),
  read({ overallScore: 7, claimedGrade: null }),
]);
assert.strictEqual(partial.reads, 2, "the shopper did look at both");
assert.strictEqual(partial.deltaReads, 1, "but only one carried a claim");
assert.strictEqual(partial.avgClaimedDelta, -2, "and the delta averages only that one");

// No claims at all → null delta, NOT zero. "We have no claim data" and "they
// claim it accurately" are different answers and 0 renders as the second.
const noClaims = S.aggregate([read({ claimedGrade: null }), read({ claimedGrade: null })]);
assert.strictEqual(noClaims.avgClaimedDelta, null);
assert.strictEqual(S.sellerCopy(noClaims), null, "and with no claims there is nothing to say");

// Garbage scores are dropped, never averaged in.
const dirty = S.aggregate([
  read({ overallScore: 6 }),
  read({ overallScore: NaN }),
  read({ overallScore: 99 }),
  read({ overallScore: 8 }),
  null,
  "nonsense",
]);
assert.strictEqual(dirty.reads, 2, "only the two real scores count");
assert.strictEqual(dirty.avgOverall, 7);

// ── sellerKey: normalised, and namespaced by marketplace ──────────────────
assert.strictEqual(S.sellerKey("ebay", "ThriftCo"), S.sellerKey("ebay", " thriftco "));
assert.notStrictEqual(
  S.sellerKey("ebay", "thriftco"),
  S.sellerKey("poshmark", "thriftco"),
  "the same handle on two marketplaces is two different people",
);
for (const junk of [null, undefined, "", "   ", 42, {}, "x".repeat(81)]) {
  assert.strictEqual(
    S.sellerKey("ebay", junk),
    null,
    `sellerKey with ${JSON.stringify(junk)} must be null — an unreadable seller never aggregates`,
  );
}

// ── groupBySeller ─────────────────────────────────────────────────────────
const rows = S.groupBySeller([
  read({ seller: "alpha", at: 10 }),
  read({ seller: "alpha", at: 20 }),
  read({ seller: "beta", at: 30 }),
  read({ seller: "gamma", at: 900 }),
  read({ seller: "gamma", at: 999 }),
  read({ seller: null, at: 50 }),
  read({ seller: "", at: 60 }),
]);
assert.deepStrictEqual(
  rows.map((r) => r.seller),
  ["gamma", "alpha"],
  "single-read sellers are omitted, and rows sort newest-first",
);
assert.ok(
  rows.every((r) => r.seller),
  "reads with no seller must not pool into a '(no seller)' bucket — that would " +
    "average unrelated listings from unrelated people into one meaningless number",
);

// ── 4. nothing leaves the device ──────────────────────────────────────────
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
const mkt = fs.readFileSync(path.join(dir, "research", "marketplace.js"), "utf8");

// The seller must not appear in any outbound request body. Every fetch body in
// the worker is checked rather than a single known one, so a future endpoint
// can't quietly start carrying it.
for (const m of bg.matchAll(/JSON\.stringify\(\{([\s\S]*?)\}\)/g)) {
  assert.ok(
    !/\bseller\b/.test(m[1]),
    "a request body in background.js references `seller`. The handle is stored " +
      "on-device only; attaching it to a request turns an anonymous grading call " +
      "into a record of who this person shops from.",
  );
}
assert.ok(
  !/reputation_events|buyer_trust_scores/.test(bg + mkt),
  "US-2148: no seller-standing row may be written from here. A score built on a " +
    "handful of unconfirmed reads is a product decision with its own model, not " +
    "an extension feature.",
);
assert.ok(
  /GT_CC_GET_SELLER/.test(bg),
  "background.js must serve GT_CC_GET_SELLER (recentReads lives in its storage)",
);
assert.ok(
  /storage\.local/.test(bg),
  "the aggregate must be computed from storage.local, not fetched",
);

console.log(
  "seller-memory.test.cjs: two-read floor holds, copy stays an observation, " +
    "delta direction correct, handle never leaves the device",
);
