// US-1899: the stale-listing playbook engine. These pin the staleness verdict
// and the revise suggestions, and — most importantly — that the engine NEVER
// escalates past a manual Sell-Similar HINT (no auto end/relist exists here).
import { assert, assertEquals } from "@std/assert";
import {
  decideStaleListing,
  DEFAULT_STALE_WINDOW_DAYS,
  MIN_PHOTOS,
  type StaleListingSignal,
  WEAK_TITLE_LEN,
} from "../lib/stale-listings.ts";

function base(overrides: Partial<StaleListingSignal> = {}): StaleListingSignal {
  return {
    listingId: "l1",
    title: "A".repeat(WEAK_TITLE_LEN + 5), // strong title unless overridden
    photoCount: MIN_PHOTOS + 2,
    activeDays: DEFAULT_STALE_WINDOW_DAYS + 10,
    windowImpressions: 100,
    windowViews: 0,
    watchers: 0,
    ...overrides,
  };
}

Deno.test("US-1899: zero clicks past the window marks a listing stale", () => {
  const d = decideStaleListing(base());
  assert(d.isStale);
  assertEquals(d.windowDays, DEFAULT_STALE_WINDOW_DAYS);
});

Deno.test("US-1899: a listing younger than the window is NEVER stale (fair chance)", () => {
  const d = decideStaleListing(
    base({ activeDays: DEFAULT_STALE_WINDOW_DAYS - 1 }),
  );
  assert(!d.isStale);
  assertEquals(d.suggestions.length, 0);
  assert(!d.sellSimilarEligible);
});

Deno.test("US-1899: any click in the window means NOT stale", () => {
  const d = decideStaleListing(base({ windowViews: 1 }));
  assert(!d.isStale);
});

Deno.test("US-1899: impressed-but-not-clicked suggests fixing the thumbnail", () => {
  const d = decideStaleListing(base({ windowImpressions: 500, windowViews: 0 }));
  assert(d.suggestions.some((s) => s.kind === "improve_thumbnail"));
  // Not the reprice/visibility branch — it WAS being shown.
  assert(!d.suggestions.some((s) => s.kind === "reprice"));
});

Deno.test("US-1899: not-even-shown suggests a reprice / keyword move", () => {
  const d = decideStaleListing(base({ windowImpressions: 0, windowViews: 0 }));
  assert(d.suggestions.some((s) => s.kind === "reprice"));
  assert(!d.suggestions.some((s) => s.kind === "improve_thumbnail"));
});

Deno.test("US-1899: a short title is flagged as weak", () => {
  const d = decideStaleListing(base({ title: "Nike hoodie" }));
  assert(d.suggestions.some((s) => s.kind === "weak_title"));
});

Deno.test("US-1899: a full-length title is NOT flagged weak", () => {
  const d = decideStaleListing(base({ title: "X".repeat(WEAK_TITLE_LEN) }));
  assert(!d.suggestions.some((s) => s.kind === "weak_title"));
});

Deno.test("US-1899: too few photos is flagged", () => {
  const d = decideStaleListing(base({ photoCount: MIN_PHOTOS - 1 }));
  assert(d.suggestions.some((s) => s.kind === "add_photos"));
});

Deno.test("US-1899: Sell Similar is offered ONLY after long, total zero-engagement", () => {
  // 90+ days, zero clicks, zero watchers → eligible.
  const eligible = decideStaleListing(base({ activeDays: 120, watchers: 0 }));
  assert(eligible.sellSimilarEligible);

  // Same age but it still has watchers → NOT eligible (there is live interest).
  const hasWatchers = decideStaleListing(base({ activeDays: 120, watchers: 3 }));
  assert(!hasWatchers.sellSimilarEligible);

  // Stale but only 50 days → eligible for revise, NOT yet for Sell Similar.
  const tooYoung = decideStaleListing(base({ activeDays: 50 }));
  assert(tooYoung.isStale);
  assert(!tooYoung.sellSimilarEligible);
});

Deno.test("US-1899: a configurable window is honoured", () => {
  // With a 10-day window, a 15-day live listing with zero clicks is stale...
  const stale = decideStaleListing(base({ activeDays: 15 }), { windowDays: 10 });
  assert(stale.isStale);
  assertEquals(stale.windowDays, 10);
  // ...but with the default 45-day window it is too new.
  const fresh = decideStaleListing(base({ activeDays: 15 }));
  assert(!fresh.isStale);
});

Deno.test("US-1899: a healthy listing yields no suggestions and no escalation", () => {
  const d = decideStaleListing(base({ windowViews: 12 }));
  assert(!d.isStale);
  assertEquals(d.suggestions.length, 0);
  assert(!d.sellSimilarEligible);
});
