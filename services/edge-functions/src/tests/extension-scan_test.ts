// US-2237: the search-page triage scan. The whole point of this endpoint is that
// it answers a grid of 24 cards for the price of ~3 upstream calls and ZERO
// Vision calls, so the parts worth testing are exactly the pure ones that make
// that true: body parsing/capping, the condition bucketing that collapses 24
// cards into a handful of comp lookups, and the per-card verdict assembly.
//
// Imports lib/extension-scan.ts, NOT the route. That is deliberate: the route
// pulls in hono, supabase and the eBay client, none of which this logic needs —
// and requiring them meant these assertions could only ever run in CI. Asserting
// with node:assert (a Deno builtin) rather than @std/assert keeps the whole file
// resolvable with no network at all, so the decision math is checkable anywhere.
//
// The rate limiter stays in the route (it owns per-instance state) and is covered
// by grade-check_test.ts alongside the grading window it mirrors.
import assert from "node:assert/strict";

import {
  bucketScanCards,
  hydrateEbayScanCards,
  parseScanBody,
  type ScanCardFacts,
  type ScanCardInput,
  SCAN_DISCLAIMER,
  type ScanCompStats,
  scanCardResults,
} from "../lib/extension-scan.ts";
import { valueRangeFromStats } from "../lib/condition-value-math.ts";

const assertEquals = (a: unknown, b: unknown, msg?: string) => assert.deepEqual(a, b, msg);

function card(over: Record<string, unknown> = {}) {
  return {
    key: "k1",
    title: "Patagonia Better Sweater",
    priceText: "$60.00",
    conditionText: "Pre-owned",
    photoCount: 6,
    // US-3042: null unless a case says otherwise — every marketplace but eBay
    // sends the tile's text, and on eBay this is the ONLY field sent.
    ebayItemId: null,
    ...over,
  } as ScanCardInput;
}

Deno.test("parseScanBody: caps at 24 cards and keeps the first 24", () => {
  const cards = Array.from({ length: 40 }, (_, i) => card({ key: `k${i}` }));
  const r = parseScanBody({ cards });
  assert(r.ok);
  assertEquals(r.cards.length, 24);
  assertEquals(r.cards[0].key, "k0");
  assertEquals(r.cards[23].key, "k23");
});

Deno.test("parseScanBody: drops keyless/malformed cards instead of failing the request", () => {
  // One bad card on a real grid must degrade THAT card, not blank the page.
  const r = parseScanBody({
    cards: [card({ key: "good" }), { title: "no key" }, null, "nonsense", card({ key: "good2" })],
  });
  assert(r.ok);
  assertEquals(r.cards.map((c) => c.key), ["good", "good2"]);
});

Deno.test("parseScanBody: rejects a non-array or empty cards list", () => {
  assertEquals(parseScanBody({}).ok, false);
  assertEquals(parseScanBody({ cards: "nope" }).ok, false);
  assertEquals(parseScanBody({ cards: [] }).ok, false);
  assertEquals(parseScanBody({ cards: [{ title: "keyless" }] }).ok, false);
});

Deno.test("parseScanBody: clamps photoCount and trims oversized strings", () => {
  const r = parseScanBody({
    cards: [card({ photoCount: -4 }), card({ key: "k2", photoCount: 5000 }), card({
      key: "k3",
      photoCount: "seven",
    })],
    query: "x".repeat(500),
    brand: "y".repeat(500),
  });
  assert(r.ok);
  assertEquals(r.cards[0].photoCount, 0);
  assertEquals(r.cards[1].photoCount, 99);
  assertEquals(r.cards[2].photoCount, null);
  assertEquals(r.query.length, 200);
  assertEquals(r.brand.length, 80);
});

Deno.test("bucketScanCards: collapses many cards into one bucket per condition", () => {
  const parsed = parseScanBody({
    cards: [
      card({ key: "a", conditionText: "Pre-owned" }),
      card({ key: "b", conditionText: "Used" }),
      card({ key: "c", conditionText: "New with tags" }),
      card({ key: "d", conditionText: "pre-owned" }),
    ],
  });
  assert(parsed.ok);
  const buckets = bucketScanCards(parsed.cards, "ebay");
  // Pre-owned/Used/pre-owned all land in the same conditionId → one comp call.
  assertEquals(buckets.length, 2);
  assertEquals(buckets[0].keys.length, 3, "largest bucket sorts first");
  assertEquals(buckets[1].keys, ["c"]);
});

Deno.test("bucketScanCards: unreadable conditions bucket as Used, not dropped", () => {
  // Only eBay reliably prints a condition on the card. Dropping the rest would
  // silently make scan mode an eBay-only feature.
  const parsed = parseScanBody({
    cards: [card({ key: "a", conditionText: "" }), card({ key: "b", conditionText: "¯\\_(ツ)_/¯" })],
  });
  assert(parsed.ok);
  const buckets = bucketScanCards(parsed.cards, null);
  assertEquals(buckets.length, 1);
  assertEquals(buckets[0].conditionId, "3000");
  assertEquals(buckets[0].keys, ["a", "b"]);
});

// A comp distribution wide enough to clear MIN_VALUE_COMPS, in dollars.
const STATS: ScanCompStats = {
  count: 12,
  currency: "USD",
  min: 30,
  p25: 45,
  median: 60,
  p75: 85,
  max: 140,
};

// The REAL band builder the route injects. Using the production function here —
// rather than a stub — is the point: the seam exists to drop the eBay client, not
// to replace the pricing maths with something that always agrees with the test.
const buildBand = (stats: ScanCompStats, grade: number | null) => {
  const range = valueRangeFromStats(stats, grade, stats.currency);
  if (!range.sufficient || range.lowCents == null || range.medianCents == null || range.highCents == null) {
    return null;
  }
  return { lowCents: range.lowCents, medianCents: range.medianCents, highCents: range.highCents };
};

Deno.test("scanCardResults: prices each card against its bucket's comp stats", () => {
  const parsed = parseScanBody({
    cards: [
      card({ key: "cheap", priceText: "$20.00" }),
      card({ key: "fair", priceText: "$60.00" }),
      card({ key: "dear", priceText: "$400.00" }),
    ],
  });
  assert(parsed.ok);
  const stats = new Map(parsed.cards.map((c) => [c.key, STATS]));
  const out = scanCardResults(parsed.cards, "ebay", stats, buildBand);
  assertEquals(out.map((r) => r.fairness), ["low", "fair", "high"]);
  assertEquals(out[0].priceCents, 2000);
});

Deno.test("scanCardResults: one comp fetch, different bands per claimed condition", () => {
  // Same bucket, same stats — but a NWT claim positions higher in the band than
  // a "fair" claim, so the identical price can read differently. This is what
  // makes bucketing safe.
  const parsed = parseScanBody({
    cards: [
      card({ key: "nwt", conditionText: "New with tags", priceText: "$80.00" }),
      card({ key: "fair", conditionText: "Fair", priceText: "$80.00" }),
    ],
  });
  assert(parsed.ok);
  const stats = new Map(parsed.cards.map((c) => [c.key, STATS]));
  const out = scanCardResults(parsed.cards, "ebay", stats, buildBand);
  assert(out[0].claimedGrade !== out[1].claimedGrade);
  assert(
    out[0].deltaPct !== out[1].deltaPct,
    "identical prices at different claimed conditions must not score identically",
  );
});

Deno.test("scanCardResults: no stats → 'unknown', never a fabricated verdict", () => {
  const parsed = parseScanBody({ cards: [card()] });
  assert(parsed.ok);
  const out = scanCardResults(parsed.cards, "ebay", new Map(), buildBand);
  assertEquals(out[0].fairness, "unknown");
  assertEquals(out[0].deltaPct, null);
  // The claimed-condition read still lands — it needs no comps at all.
  assert(out[0].claimedGrade != null);
});

Deno.test("scanCardResults: too-thin comps stay 'unknown' rather than pricing", () => {
  const parsed = parseScanBody({ cards: [card({ priceText: "$60.00" })] });
  assert(parsed.ok);
  const thin: ScanCompStats = { count: 1, currency: "USD", min: 60, p25: 60, median: 60, p75: 60, max: 60 };
  const out = scanCardResults(parsed.cards, "ebay", new Map([[parsed.cards[0].key, thin]]), buildBand);
  assertEquals(out[0].fairness, "unknown");
});

Deno.test("scanCardResults: claimedGrade is the SELLER's claim, not our read", () => {
  const parsed = parseScanBody({
    cards: [card({ key: "nwt", conditionText: "New with tags" }), card({
      key: "fair",
      conditionText: "Fair",
    })],
  });
  assert(parsed.ok);
  const out = scanCardResults(parsed.cards, "ebay", new Map(), buildBand);
  assertEquals(out[0].claimedGrade, 10);
  assertEquals(out[1].claimedGrade, 4.5);
  // No graded-read fields may appear on a scan card — a number a shopper could
  // mistake for a GradeThread grade is the one failure this feature can't have.
  for (const row of out) {
    assert(!("overallScore" in row));
    assert(!("gradeTier" in row));
    assert(!("confidence" in row));
  }
});

Deno.test("scanCardResults: thinPhotos flags only a card that printed a low count", () => {
  const parsed = parseScanBody({
    cards: [
      card({ key: "thin", photoCount: 1 }),
      card({ key: "ok", photoCount: 8 }),
      card({ key: "unknown", photoCount: null }),
    ],
  });
  assert(parsed.ok);
  const out = scanCardResults(parsed.cards, "ebay", new Map(), buildBand);
  assertEquals(out.map((r) => r.thinPhotos), [true, false, false]);
});

// REPINNED 2026-09-11 (US-3372). This read `/no photos were analysed/i` and had
// been red since 2026-09-10, when US-3233's US-spelling sweep (94983093e) turned
// the disclaimer's "analysed" into "analyzed". The guard was pinned to a
// SPELLING, so a correction the repo requires everywhere else broke it, and the
// thing it exists to protect (that the scan tells the seller plainly it read no
// photos) went unasserted for a day inside a suite whose failures CLAUDE.md
// said were expected.
//
// Spelling is not this guard's job: scripts/check-us-spelling.mjs owns
// analysed -> analyzed and scans services/edge-functions/src, so pinning it here
// duplicated an assertion that already had a home and put this one at its mercy.
// The character class hands spelling back to that guard.
//
// Both halves are asserted now, because the disclaimer misleads if either goes.
// "No photos were analyzed" alone does not say what the number IS based on, and
// the stated-condition-and-price basis alone reads like a graded result.
Deno.test("SCAN_DISCLAIMER says plainly that no photos were analyzed", () => {
  assert(
    /no photos were analy[sz]ed/i.test(SCAN_DISCLAIMER),
    `the scan must say it read no photos: ${SCAN_DISCLAIMER}`,
  );
  assert(
    /stated condition/i.test(SCAN_DISCLAIMER) &&
      /price/i.test(SCAN_DISCLAIMER),
    `the scan must name what it IS based on: ${SCAN_DISCLAIMER}`,
  );
});

// ── US-3042: an eBay grid's card fields come from Browse, not the tile ───────
//
// Scan mode was the same compliance finding as the detail-page scrape, one
// screen earlier and 24 times per page: it read each eBay result tile's title,
// price and condition and posted them to us. On eBay the caller now sends a key
// and an item id, and these are the replacements.

function facts(over: Partial<ScanCardFacts> = {}): ScanCardFacts {
  return {
    title: "Patagonia Better Sweater Fleece Jacket",
    priceCents: 6000,
    currency: "USD",
    conditionId: "3000",
    conditionLabel: "Pre-owned",
    ...over,
  };
}

Deno.test("parseScanBody: keeps a valid eBay item id and refuses anything else", () => {
  const r = parseScanBody({
    cards: [
      { key: "k1", ebayItemId: "123456789012" },
      { key: "k2", ebayItemId: " 123456789012 " },
      { key: "k3", ebayItemId: "12345" },
      { key: "k4", ebayItemId: "not-an-id" },
      { key: "k5", ebayItemId: 123456789012 },
      { key: "k6" },
    ],
  });
  assert(r.ok);
  assertEquals(r.cards[0].ebayItemId, "123456789012");
  assertEquals(r.cards[1].ebayItemId, "123456789012", "trimmed");
  for (const i of [2, 3, 4, 5]) {
    assertEquals(r.cards[i].ebayItemId, null, `card ${i} must not carry an id`);
  }
});

Deno.test("hydrateEbayScanCards: REPLACES the card fields with eBay's own", () => {
  // A caller sending page text alongside the id must not be able to steer the
  // verdict — the same reason hydrateEbayListingBody replaces rather than merges.
  const [out] = hydrateEbayScanCards(
    [card({ key: "k1", ebayItemId: "123456789012", title: "STEERED", priceText: "$1.00", conditionText: "New" })],
    "ebay",
    new Map([["123456789012", facts()]]),
  );
  assertEquals(out.title, "Patagonia Better Sweater Fleece Jacket");
  assertEquals(out.priceText, "60.00");
  assertEquals(out.conditionText, "3000", "eBay's own conditionId, not the tile's label");
  assertEquals(out.photoCount, null, "no result tile prints a photo count");
  assertEquals(out.key, "k1", "the caller's key survives so the client can match rows");
});

Deno.test("hydrateEbayScanCards: an unresolvable card is dropped, never left as page text", () => {
  const out = hydrateEbayScanCards(
    [
      card({ key: "resolved", ebayItemId: "123456789012", title: "PAGE" }),
      card({ key: "unresolved", ebayItemId: "999999999999", title: "PAGE" }),
      card({ key: "no-id", ebayItemId: null, title: "PAGE" }),
    ],
    "ebay",
    new Map([["123456789012", facts()]]),
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].key, "resolved");
  assert(
    !out.some((c) => c.title === "PAGE"),
    "a card we could not read from eBay gets no badge — it never falls back to the tile",
  );
});

Deno.test("hydrateEbayScanCards: falls back to the condition LABEL, and to no price", () => {
  const [out] = hydrateEbayScanCards(
    [card({ key: "k1", ebayItemId: "123456789012" })],
    "EBAY",
    new Map([["123456789012", facts({ conditionId: null, priceCents: null })]]),
  );
  assertEquals(out.conditionText, "Pre-owned");
  assertEquals(out.priceText, "", "no price is empty, never a zero the shopper would compare");
});

Deno.test("hydrateEbayScanCards: every other marketplace passes through untouched", () => {
  // Poshmark, Mercari, Grailed, Depop and Vinted publish no API to read
  // instead. That is a real difference, not an inconsistency.
  const cards = [card({ key: "k1", title: "Poshmark tile" })];
  for (const mp of ["poshmark", "mercari", null, ""]) {
    assertEquals(hydrateEbayScanCards(cards, mp, new Map()), cards, `${mp} must pass through`);
  }
});

Deno.test("hydrateEbayScanCards: the replaced fields still drive the verdict", () => {
  // End to end through the pure half: eBay's conditionId must bucket and price
  // exactly like the tile text it replaced, or the badge silently changes.
  const hydrated = hydrateEbayScanCards(
    [card({ key: "k1", ebayItemId: "123456789012", title: "", priceText: "", conditionText: "" })],
    "ebay",
    new Map([["123456789012", facts({ priceCents: 3000 })]]),
  );
  const [row] = scanCardResults(hydrated, "ebay", new Map([["k1", STATS]]), buildBand);
  assertEquals(row.priceCents, 3000, "the price came from eBay and still parses");
  assert(row.claimedGrade !== null, "eBay's conditionId still reads as a claimed condition");
  assertEquals(row.fairness, "low", "well under the comp band");
});

Deno.test("the /scan route hydrates and then uses the HYDRATED cards", async () => {
  // The decay this stops: `hydrateEbayScanCards` is pure and well tested, and
  // none of that matters if the route calls it and then goes on to bucket and
  // score `parsed.cards` anyway. Rewiring one of the two call sites back is a
  // one-word edit that no behavioural test here can see, and the badge would
  // quietly be computed from page text again.
  //
  // Read with line endings normalised: a Windows checkout hands this file CRLF,
  // and a needle spanning a newline would silently miss.
  const src = (await Deno.readTextFile(
    new URL("../routes/public-grading.ts", import.meta.url),
  )).replace(/\r\n/g, "\n");

  assert(
    src.includes("hydrateEbayScanCards("),
    "the /scan route no longer reads eBay's own card fields",
  );
  assert(
    src.includes("readEbayCardsByLegacyIds("),
    "the /scan route no longer fetches the cards from Browse",
  );
  for (const call of ["bucketScanCards(scanCards,", "scanCardResults(\n          scanCards,"]) {
    assert(
      src.includes(call),
      `the /scan route must pass the HYDRATED cards here, not parsed.cards: ${call}`,
    );
  }
  assert(
    !/bucketScanCards\(parsed\.cards|scanCardResults\(\s*parsed\.cards/.test(src),
    "the /scan route still scores the caller's own card text somewhere",
  );
});
