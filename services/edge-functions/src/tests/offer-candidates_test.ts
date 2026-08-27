// US-2943: the daily send-offer list.
//
// The cooldown is the point. eBay lets a seller offer the same watchers a
// discount repeatedly, and doing that trains a watcher to wait: if 10% off
// arrives every Monday, the rational move is never to buy at full price. The
// tests below pin that the list refuses to repeat itself, and that the ordering
// puts the offers most likely to convert at the top.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { OFFER_COOLDOWN_DAYS, rankOfferCandidates, totalDiscountExposureCents } = await import(
  "../lib/offer-candidates.ts"
);
import type { OfferCandidate } from "../lib/offer-candidates.ts";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const item = (over: Partial<OfferCandidate> & { listingId: string }): OfferCandidate => ({
  title: over.listingId,
  priceCents: 5_000,
  watchers: 0,
  daysListed: 10,
  lastOfferedAt: null,
  ...over,
});

Deno.test("an item offered inside the cooldown is SUPPRESSED, not ranked", () => {
  const out = rankOfferCandidates(
    [
      item({ listingId: "fresh", lastOfferedAt: null }),
      item({ listingId: "recent", lastOfferedAt: daysAgo(2) }),
      item({ listingId: "old", lastOfferedAt: daysAgo(OFFER_COOLDOWN_DAYS + 1) }),
    ],
    NOW,
  );
  assertEquals(out.candidates.map((c) => c.listingId).sort(), ["fresh", "old"]);
  assertEquals(out.suppressed.map((c) => c.listingId), ["recent"]);
});

Deno.test("the cooldown boundary lets an item back in on the day it expires", () => {
  const out = rankOfferCandidates(
    [item({ listingId: "edge", lastOfferedAt: daysAgo(OFFER_COOLDOWN_DAYS) })],
    NOW,
  );
  assertEquals(out.candidates.length, 1);
  assertEquals(out.suppressed.length, 0);
});

Deno.test("watchers outrank age, by a distance", () => {
  // A discount reaches people already watching. Nine watchers is nine chances;
  // an unwatched item is a discount sent into an empty room, however old.
  const out = rankOfferCandidates(
    [
      item({ listingId: "ancient", watchers: 0, daysListed: 300 }),
      item({ listingId: "watched", watchers: 9, daysListed: 3 }),
    ],
    NOW,
  );
  assertEquals(out.candidates.map((c) => c.listingId), ["watched", "ancient"]);
});

Deno.test("age breaks a watcher tie", () => {
  const out = rankOfferCandidates(
    [
      item({ listingId: "newer", watchers: 4, daysListed: 5 }),
      item({ listingId: "older", watchers: 4, daysListed: 90 }),
    ],
    NOW,
  );
  assertEquals(out.candidates.map((c) => c.listingId), ["older", "newer"]);
});

Deno.test("an UNKNOWN age sorts last within its watcher group", () => {
  // "We do not know how long this has been up" is not a reason to discount it
  // ahead of one we know has sat for ninety days.
  const out = rankOfferCandidates(
    [
      item({ listingId: "unknown", watchers: 4, daysListed: null }),
      item({ listingId: "known", watchers: 4, daysListed: 1 }),
    ],
    NOW,
  );
  assertEquals(out.candidates.map((c) => c.listingId), ["known", "unknown"]);
});

Deno.test("exposure is the WORST case: every offer taken", () => {
  // A seller pressing "send 12% off to 40 items" is entitled to the largest
  // number that can come out of it, not an expected value.
  const total = totalDiscountExposureCents(
    [item({ listingId: "a", priceCents: 10_000 }), item({ listingId: "b", priceCents: 5_000 })],
    10,
  );
  assertEquals(total, 1_500);
});

Deno.test("exposure is NULL when any item has no price", () => {
  // A total that silently omits the items it could not price is worse than no
  // total — it reads as complete.
  assertEquals(
    totalDiscountExposureCents(
      [item({ listingId: "a", priceCents: 10_000 }), item({ listingId: "b", priceCents: null })],
      10,
    ),
    null,
  );
  assertEquals(totalDiscountExposureCents([item({ listingId: "a" })], 0), null);
});

Deno.test("ranking does not mutate its input", () => {
  const input = [item({ listingId: "a", watchers: 1 }), item({ listingId: "b", watchers: 9 })];
  const before = input.map((i) => i.listingId);
  rankOfferCandidates(input, NOW);
  assertEquals(input.map((i) => i.listingId), before);
  assert(true);
});
