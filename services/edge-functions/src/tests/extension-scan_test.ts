// US-2237: the search-page triage scan. The whole point of this endpoint is that
// it answers a grid of 24 cards for the price of ~3 upstream calls and ZERO
// Vision calls, so the parts worth testing are exactly the pure ones that make
// that true: body parsing/capping, the condition bucketing that collapses 24
// cards into a handful of comp lookups, and the per-card verdict assembly.
//
// Prime env then dynamic-import (the route pulls in supabase.ts via quick-grade).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const {
  parseScanBody,
  bucketScanCards,
  scanCardResults,
  scanRateLimited,
  SCAN_DISCLAIMER,
} = await import("../routes/public-grading.ts");

function card(over: Record<string, unknown> = {}) {
  return {
    key: "k1",
    title: "Patagonia Better Sweater",
    priceText: "$60.00",
    conditionText: "Pre-owned",
    photoCount: 6,
    ...over,
  };
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
const STATS = { count: 12, currency: "USD", min: 30, p25: 45, median: 60, p75: 85, max: 140 };

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
  const out = scanCardResults(parsed.cards, "ebay", stats);
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
  const out = scanCardResults(parsed.cards, "ebay", stats);
  assert(out[0].claimedGrade !== out[1].claimedGrade);
  assert(
    out[0].deltaPct !== out[1].deltaPct,
    "identical prices at different claimed conditions must not score identically",
  );
});

Deno.test("scanCardResults: no stats → 'unknown', never a fabricated verdict", () => {
  const parsed = parseScanBody({ cards: [card()] });
  assert(parsed.ok);
  const out = scanCardResults(parsed.cards, "ebay", new Map());
  assertEquals(out[0].fairness, "unknown");
  assertEquals(out[0].deltaPct, null);
  // The claimed-condition read still lands — it needs no comps at all.
  assert(out[0].claimedGrade != null);
});

Deno.test("scanCardResults: too-thin comps stay 'unknown' rather than pricing", () => {
  const parsed = parseScanBody({ cards: [card({ priceText: "$60.00" })] });
  assert(parsed.ok);
  const thin = { count: 1, currency: "USD", min: 60, p25: 60, median: 60, p75: 60, max: 60 };
  const out = scanCardResults(parsed.cards, "ebay", new Map([[parsed.cards[0].key, thin]]));
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
  const out = scanCardResults(parsed.cards, "ebay", new Map());
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
  const out = scanCardResults(parsed.cards, "ebay", new Map());
  assertEquals(out.map((r) => r.thinPhotos), [true, false, false]);
});

Deno.test("scanRateLimited: its own window, 60/hr per IP", () => {
  const ip = "203.0.113.77";
  const t = Date.now();
  for (let i = 0; i < 60; i++) {
    assertEquals(scanRateLimited(ip, null, t + i).limited, false, `call ${i + 1}`);
  }
  const over = scanRateLimited(ip, null, t + 60);
  assertEquals(over.limited, true);
  assertEquals(over.scope, "ip");
});

Deno.test("scanRateLimited: caps per extension instance independent of IP", () => {
  const inst = "scan-instance-1";
  const t = Date.now();
  for (let i = 0; i < 120; i++) {
    const r = scanRateLimited(`198.51.100.${i % 200}`, inst, t + i);
    assertEquals(r.limited, false, `call ${i + 1}`);
  }
  const over = scanRateLimited("198.51.100.250", inst, t + 120);
  assertEquals(over.limited, true);
  assertEquals(over.scope, "instance");
});

Deno.test("SCAN_DISCLAIMER says plainly that no photos were analysed", () => {
  assert(/no photos were analysed/i.test(SCAN_DISCLAIMER));
});
