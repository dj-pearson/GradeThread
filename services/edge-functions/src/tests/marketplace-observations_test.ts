// US-2697: the pure sold-sync observation planner.
//
// Every case here is a rule the design doc states, and several of them are
// rules whose ABSENCE would be silent: a partial closet read that looks like a
// mass delisting, a selector regression that looks like a sell-out, a batch of
// 200 phantom sales that looks like a very good day.

import { assertEquals } from "@std/assert";
import {
  BREAKER_FLOOR,
  BREAKER_SHARE,
  dedupeKeyFor,
  planObservations,
  type KnownListing,
  type ObservationBatch,
  type SoldObservation,
} from "../lib/marketplace-observations.ts";

const PLATFORM = "poshmark";

// Spread, not `??`. An explicit `null` override is the whole point of several
// cases below (a sold row with no listing URL), and `over.x ?? default` hands
// the default straight back for exactly those — which silently turned the two
// probable-match tests into exact-match tests.

function listing(over: Partial<KnownListing> = {}): KnownListing {
  return {
    id: "l1",
    itemId: "i1",
    platform: PLATFORM,
    listingUrl: "https://poshmark.com/listing/aaa",
    title: "Carhartt Detroit Jacket",
    priceCents: 8500,
    listingStatus: "active",
    ...over,
  };
}

function sold(over: Partial<SoldObservation> = {}): SoldObservation {
  return {
    listingUrl: "https://poshmark.com/listing/aaa",
    title: "Carhartt Detroit Jacket",
    soldPriceCents: 8500,
    soldAt: "2026-08-18T12:00:00.000Z",
    orderRef: null,
    thumbAssetId: null,
    ...over,
  };
}

function batch(over: Partial<ObservationBatch> = {}): ObservationBatch {
  return {
    platform: PLATFORM,
    observedAt: "2026-08-18T12:05:00.000Z",
    signedIn: true,
    sold: [],
    closet: null,
    ...over,
  };
}

// ── the action matrix ──────────────────────────────────────────────────────

Deno.test("definitive sale + exact url match is confirmed", () => {
  const plan = planObservations({
    batch: batch({ sold: [sold()] }),
    known: [listing()],
    seenKeys: new Set(),
  });
  assertEquals(plan.channelStatus, "ok");
  assertEquals(plan.confirmed.length, 1);
  assertEquals(plan.confirmed[0].listingId, "l1");
  assertEquals(plan.review.length, 0);
  assertEquals(plan.unmatched.length, 0);
});

Deno.test("definitive sale + probable match goes to review, never to a delist", () => {
  // No URL on the sold row, but title and price single out one live listing.
  const plan = planObservations({
    batch: batch({ sold: [sold({ listingUrl: null })] }),
    known: [listing()],
    seenKeys: new Set(),
  });
  assertEquals(plan.confirmed.length, 0);
  assertEquals(plan.review.length, 1);
  assertEquals(plan.review[0].reason, "probable_match");
  assertEquals(plan.review[0].listingId, "l1");
});

Deno.test("a title+price match hitting two listings is not probable, it is unmatched", () => {
  const plan = planObservations({
    batch: batch({ sold: [sold({ listingUrl: null })] }),
    known: [listing({ id: "l1" }), listing({ id: "l2", listingUrl: "https://poshmark.com/listing/bbb" })],
    seenKeys: new Set(),
  });
  assertEquals(plan.confirmed.length, 0);
  assertEquals(plan.review.length, 0);
  assertEquals(plan.unmatched.length, 1);
});

Deno.test("definitive sale matching nothing is unmatched, and carries what a claim needs", () => {
  const plan = planObservations({
    batch: batch({ sold: [sold({ listingUrl: "https://poshmark.com/listing/zzz", title: "Unknown Coat" })] }),
    known: [listing()],
    seenKeys: new Set(),
  });
  assertEquals(plan.unmatched.length, 1);
  assertEquals(plan.unmatched[0].listingUrl, "https://poshmark.com/listing/zzz");
  assertEquals(plan.unmatched[0].title, "Unknown Coat");
});

// ── absence is only evidence on complete coverage ──────────────────────────

Deno.test("absent from a FULLY enumerated closet is an unexplained-absence review row", () => {
  const plan = planObservations({
    batch: batch({
      sold: [],
      closet: { listingUrls: ["https://poshmark.com/listing/bbb"], pagesRead: 3, reachedEnd: true },
    }),
    known: [listing({ id: "l1" }), listing({ id: "l2", listingUrl: "https://poshmark.com/listing/bbb" })],
    seenKeys: new Set(),
  });
  assertEquals(plan.review.length, 1);
  assertEquals(plan.review[0].reason, "unexplained_absence");
  assertEquals(plan.review[0].listingId, "l1");
});

Deno.test("partial coverage yields ZERO inferred absences — the bug that would have shipped", () => {
  // Page 1 of 8. Everything on pages 2-8 is 'missing' and none of it is evidence.
  const plan = planObservations({
    batch: batch({
      sold: [],
      closet: { listingUrls: ["https://poshmark.com/listing/bbb"], pagesRead: 1, reachedEnd: false },
    }),
    known: [listing({ id: "l1" }), listing({ id: "l2", listingUrl: "https://poshmark.com/listing/bbb" })],
    seenKeys: new Set(),
  });
  assertEquals(plan.review.filter((r) => r.reason === "unexplained_absence").length, 0);
});

Deno.test("no closet observation at all yields zero inferred absences", () => {
  const plan = planObservations({
    batch: batch({ sold: [], closet: null }),
    known: [listing(), listing({ id: "l2", listingUrl: "https://poshmark.com/listing/bbb" })],
    seenKeys: new Set(),
  });
  assertEquals(plan.review.length, 0);
  assertEquals(plan.channelStatus, "ok");
});

// ── zero rows where many were expected ─────────────────────────────────────

Deno.test("a closet read returning nothing while listings are live is a FAILING channel", () => {
  const plan = planObservations({
    batch: batch({
      sold: [],
      closet: { listingUrls: [], pagesRead: 1, reachedEnd: true },
    }),
    known: [listing({ id: "l1" }), listing({ id: "l2", listingUrl: "https://poshmark.com/listing/bbb" })],
    seenKeys: new Set(),
  });
  assertEquals(plan.channelStatus, "failing");
  assertEquals(plan.confirmed.length, 0);
  assertEquals(plan.review.length, 0);
  assertEquals(plan.unmatched.length, 0);
});

Deno.test("zero SOLD rows is the normal case and never marks the channel failing", () => {
  const plan = planObservations({
    batch: batch({
      sold: [],
      closet: { listingUrls: ["https://poshmark.com/listing/aaa"], pagesRead: 1, reachedEnd: true },
    }),
    known: [listing()],
    seenKeys: new Set(),
  });
  assertEquals(plan.channelStatus, "ok");
});

Deno.test("an empty closet read with NO known live listings is honest emptiness, not a failure", () => {
  const plan = planObservations({
    batch: batch({ sold: [], closet: { listingUrls: [], pagesRead: 1, reachedEnd: true } }),
    known: [],
    seenKeys: new Set(),
  });
  assertEquals(plan.channelStatus, "ok");
});

Deno.test("a not-signed-in batch reports that and writes nothing", () => {
  const plan = planObservations({
    batch: batch({ signedIn: false, sold: [sold()] }),
    known: [listing()],
    seenKeys: new Set(),
  });
  assertEquals(plan.channelStatus, "not_signed_in");
  assertEquals(plan.confirmed.length, 0);
});

// ── the circuit breaker ────────────────────────────────────────────────────

Deno.test("a batch reporting more sales than the breaker allows confirms NOTHING", () => {
  const known: KnownListing[] = [];
  const soldRows: SoldObservation[] = [];
  for (let i = 0; i < 120; i++) {
    const url = `https://poshmark.com/listing/${i}`;
    known.push(listing({ id: `l${i}`, itemId: `i${i}`, listingUrl: url }));
  }
  // 200 phantom sales against a 120-listing closet: a broken page, not a good day.
  for (let i = 0; i < 200; i++) {
    soldRows.push(sold({ listingUrl: `https://poshmark.com/listing/${i}` }));
  }
  const plan = planObservations({
    batch: batch({ sold: soldRows }),
    known,
    seenKeys: new Set(),
  });
  assertEquals(plan.breakerTripped, true);
  assertEquals(plan.confirmed.length, 0);
  assertEquals(plan.review.some((r) => r.reason === "circuit_breaker"), true);
});

Deno.test("a real busy hour under the breaker still confirms", () => {
  const known: KnownListing[] = [];
  for (let i = 0; i < 120; i++) {
    known.push(listing({ id: `l${i}`, itemId: `i${i}`, listingUrl: `https://poshmark.com/listing/${i}` }));
  }
  const soldRows = [0, 1, 2, 3, 4, 5].map((i) =>
    sold({ listingUrl: `https://poshmark.com/listing/${i}` })
  );
  const plan = planObservations({ batch: batch({ sold: soldRows }), known, seenKeys: new Set() });
  assertEquals(plan.breakerTripped, false);
  assertEquals(plan.confirmed.length, 6);
});

Deno.test("the breaker floor protects a small closet from a 20-percent-of-nothing threshold", () => {
  // 5 live listings: 20% is 1, but the floor is BREAKER_FLOOR, so 4 sales pass.
  const known = [0, 1, 2, 3, 4].map((i) =>
    listing({ id: `l${i}`, itemId: `i${i}`, listingUrl: `https://poshmark.com/listing/${i}` })
  );
  const soldRows = [0, 1, 2, 3].map((i) => sold({ listingUrl: `https://poshmark.com/listing/${i}` }));
  const plan = planObservations({ batch: batch({ sold: soldRows }), known, seenKeys: new Set() });
  assertEquals(BREAKER_FLOOR, 5);
  assertEquals(BREAKER_SHARE, 0.2);
  assertEquals(plan.breakerTripped, false);
  assertEquals(plan.confirmed.length, 4);
});

// ── count reconciliation ───────────────────────────────────────────────────

Deno.test("a closet that shrank by more than the sales explain raises its own gap row", () => {
  // 10 known live, closet shows 3, only 1 sale explains it. 6 unaccounted for.
  const known = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
    listing({ id: `l${i}`, itemId: `i${i}`, listingUrl: `https://poshmark.com/listing/${i}` })
  );
  const plan = planObservations({
    batch: batch({
      sold: [sold({ listingUrl: "https://poshmark.com/listing/0" })],
      closet: {
        listingUrls: [
          "https://poshmark.com/listing/1",
          "https://poshmark.com/listing/2",
          "https://poshmark.com/listing/3",
        ],
        pagesRead: 1,
        reachedEnd: true,
      },
    }),
    known,
    seenKeys: new Set(),
  });
  const gap = plan.review.find((r) => r.reason === "count_gap");
  assertEquals(gap !== undefined, true);
  assertEquals(gap?.unexplained, 6);
});

Deno.test("no gap row when every disappearance is explained by a sale", () => {
  const known = [0, 1].map((i) =>
    listing({ id: `l${i}`, itemId: `i${i}`, listingUrl: `https://poshmark.com/listing/${i}` })
  );
  const plan = planObservations({
    batch: batch({
      sold: [sold({ listingUrl: "https://poshmark.com/listing/0" })],
      closet: { listingUrls: ["https://poshmark.com/listing/1"], pagesRead: 1, reachedEnd: true },
    }),
    known,
    seenKeys: new Set(),
  });
  assertEquals(plan.review.some((r) => r.reason === "count_gap"), false);
});

// ── dedupe ─────────────────────────────────────────────────────────────────

Deno.test("replaying an identical batch confirms nothing the second time", () => {
  const first = planObservations({
    batch: batch({ sold: [sold()] }),
    known: [listing()],
    seenKeys: new Set(),
  });
  assertEquals(first.confirmed.length, 1);

  const second = planObservations({
    batch: batch({ sold: [sold()] }),
    known: [listing()],
    seenKeys: new Set([first.confirmed[0].dedupeKey]),
  });
  assertEquals(second.confirmed.length, 0);
});

Deno.test("the order reference is the dedupe key when the platform supplies one", () => {
  const withRef = dedupeKeyFor(PLATFORM, sold({ orderRef: "PM-123", soldAt: "2026-08-18T12:00:00.000Z" }));
  const sameRefDifferentTime = dedupeKeyFor(
    PLATFORM,
    sold({ orderRef: "PM-123", soldAt: "2026-08-19T09:00:00.000Z" }),
  );
  // Same order, re-read later with a different displayed date: still one sale.
  assertEquals(withRef, sameRefDifferentTime);
});

Deno.test("without an order reference the key falls back to url plus sold date", () => {
  const a = dedupeKeyFor(PLATFORM, sold({ orderRef: null }));
  const b = dedupeKeyFor(PLATFORM, sold({ orderRef: null }));
  const c = dedupeKeyFor(PLATFORM, sold({ orderRef: null, soldAt: "2026-08-19T12:00:00.000Z" }));
  assertEquals(a, b);
  assertEquals(a === c, false);
});

// ── the planner stays pure ─────────────────────────────────────────────────

Deno.test("the planner does not mutate its inputs", () => {
  const known = [listing()];
  const input = batch({ sold: [sold()] });
  const knownCopy = JSON.parse(JSON.stringify(known));
  const inputCopy = JSON.parse(JSON.stringify(input));
  planObservations({ batch: input, known, seenKeys: new Set() });
  assertEquals(known, knownCopy);
  assertEquals(input, inputCopy);
});

Deno.test("a sold row for a listing already marked sold locally is not re-confirmed", () => {
  const plan = planObservations({
    batch: batch({ sold: [sold()] }),
    known: [listing({ listingStatus: "sold" })],
    seenKeys: new Set(),
  });
  assertEquals(plan.confirmed.length, 0);
});
