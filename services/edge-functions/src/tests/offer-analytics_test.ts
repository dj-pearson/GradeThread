// US-2942: the discount-depth curve.
//
// This panel tells a seller to give away less money, so the test weight is on
// when it must REFUSE to make that claim. A recommendation drawn from eleven
// offers in one bucket and none in any other is a single observation wearing a
// finding's clothes, and a seller who acts on it loses sales for a season.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { MIN_BUCKET_SAMPLE, bucketFor, summarizeOffers } = await import(
  "../lib/offer-analytics.ts"
);
import type { AnalyticsOffer } from "../lib/offer-analytics.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-08-01T00:00:00.000Z");

/** n offers at `discountPct` off a $100 ask, `acceptedCount` of them accepted. */
function offers(discountPct: number, n: number, acceptedCount: number): AnalyticsOffer[] {
  const listPriceCents = 10_000;
  const amountCents = Math.round(listPriceCents * (1 - discountPct / 100));
  return Array.from({ length: n }, (_, i) => ({
    amountCents,
    listPriceCents,
    response: i < acceptedCount ? "accepted" : "declined",
    createdAt: new Date(T0).toISOString(),
    respondedAt: i < acceptedCount ? new Date(T0 + 2 * DAY).toISOString() : null,
  }));
}

Deno.test("bucketFor puts a boundary value in the UPPER band", () => {
  // A 10%-off offer is a 10-15 offer, not a 5-10 one. Getting this wrong shifts
  // every boundary case into the shallower bucket and flatters it.
  assertEquals(bucketFor(10)?.fromPct, 10);
  assertEquals(bucketFor(9.9)?.fromPct, 5);
  assertEquals(bucketFor(0)?.fromPct, 0);
  assertEquals(bucketFor(75)?.fromPct, 40);
  assertEquals(bucketFor(-3), null);
  assertEquals(bucketFor(Number.NaN), null);
});

Deno.test("a bucket under the minimum reports no rate at all", () => {
  const out = summarizeOffers(offers(12, MIN_BUCKET_SAMPLE - 1, 5));
  assertEquals(out.buckets.length, 1);
  assertEquals(out.buckets[0]!.acceptRate, null, "5 of 9 is not a 56% accept rate");
  assertEquals(out.buckets[0]!.accepted, 5, "the raw count is still reported");
});

Deno.test("buckets are ordered shallowest first", () => {
  // The seller reads this looking for the cheapest depth that works, so the
  // answer should be near the top, not sorted by whatever the map iterated.
  const out = summarizeOffers([
    ...offers(35, 12, 6),
    ...offers(7, 12, 5),
    ...offers(22, 12, 6),
  ]);
  assertEquals(out.buckets.map((b) => b.fromPct), [5, 20, 30]);
});

Deno.test("the efficient depth is the SHALLOWEST one that converts as well", () => {
  // 12% converts at 50%, 22% converts at 55%. Over 40 offers each that gap is
  // inside the noise, so the recommendation is the cheaper depth.
  const out = summarizeOffers([...offers(12, 40, 20), ...offers(22, 40, 22)]);
  const ed = out.efficientDepth;
  assert(ed !== null);
  assertEquals(ed!.fromPct, 10);
  assert(ed!.explanation.includes("margin of error"), ed!.explanation);
  assert(ed!.explanation.includes("40"), "the sample sizes are in the working");
});

Deno.test("no claim is made from a SINGLE usable bucket", () => {
  // One data point is not a comparison, and calling it "the efficient depth"
  // dresses an observation as a finding.
  const out = summarizeOffers(offers(12, 40, 20));
  assertEquals(out.efficientDepth, null);
});

Deno.test("no claim is made when every bucket is under the minimum", () => {
  const out = summarizeOffers([
    ...offers(12, MIN_BUCKET_SAMPLE - 1, 3),
    ...offers(22, MIN_BUCKET_SAMPLE - 1, 4),
  ]);
  assertEquals(out.efficientDepth, null);
});

Deno.test("a genuinely better deep discount is NOT undercut by the shallow one", () => {
  // 12% converts at 10%, 32% converts at 80%, over 100 offers each. The gap is
  // far outside the noise, so the recommendation must be the deep bucket — this
  // panel exists to save money, not to always say "discount less".
  const out = summarizeOffers([...offers(12, 100, 10), ...offers(32, 100, 80)]);
  const ed = out.efficientDepth;
  assert(ed !== null);
  assertEquals(ed!.fromPct, 30);
});

Deno.test("an offer with no snapshot price is ignored, not bucketed at zero", () => {
  // Without the asking price there is no discount depth. Treating it as 0% off
  // would pile every unlinked offer into the shallowest bucket and invent the
  // finding the panel is there to test.
  const out = summarizeOffers([
    { amountCents: 5000, listPriceCents: null, response: "accepted", createdAt: new Date(T0).toISOString(), respondedAt: null },
    { amountCents: null, listPriceCents: 10_000, response: "accepted", createdAt: new Date(T0).toISOString(), respondedAt: null },
    { amountCents: 5000, listPriceCents: 0, response: "accepted", createdAt: new Date(T0).toISOString(), respondedAt: null },
  ]);
  assertEquals(out.buckets.length, 0);
  assertEquals(out.totalOffers, 3, "they are counted as seen, just not bucketed");
});

Deno.test("median days-to-accept ignores offers still open", () => {
  const out = summarizeOffers(offers(12, MIN_BUCKET_SAMPLE, 4));
  assertEquals(out.buckets[0]!.medianDaysToAccept, 2);
});
