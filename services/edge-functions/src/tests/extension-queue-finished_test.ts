// US-3370: which FINISHED runs the queue view still owes the seller a word about.
//
// A run that completes is `done`, and `done` was not in the GET's status filter
// at all, so a cross-post whose uploader took the file list and rendered nothing
// out of it did not render as a plain success on the queue screen. It did not
// render at all. US-3367 built the whole seller-facing sentence for that case
// and could never reach it.
//
// The fix is a third list rather than a wider status filter, and the predicate
// below is what keeps that list worth reading. Two rules pull against each
// other and both matter:
//
//   * a finished run that left work behind must be visible, and
//   * a list that fills up with successes is a list the seller stops opening,
//     taking the one row that mattered with it.
//
// Pure functions, no network, no DB.

// US-2379: this file reaches src/lib/supabase.ts through its static imports,
// so it must load the test env FIRST. Without it the suite passes only when
// another test happened to load before it.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  FINISHED_REVIEW_LIMIT,
  FINISHED_REVIEW_WINDOW_MS,
  finishedNeedsReview,
} from "../routes/flipdesk-extension-queue.ts";

Deno.test("a photo refusal is the case this exists for", () => {
  // What lister/common.js runFlow returns when the uploader was asked for a
  // preview and rendered nothing: ok, filled, and no images on the listing.
  assert(
    finishedNeedsReview({
      photosWitness: "none",
      photosTotal: 8,
      photosFailed: 8,
      photosAttached: false,
      filled: true,
    }),
    "a refused-photo run must reach the seller; it is the whole of US-3370",
  );
});

Deno.test("a clean cross-post is not queue news", () => {
  // The confirmed witness AND the silent one. Four of the five channels declare
  // no photoConfirm selector, so most ordinary runs carry no witness word at
  // all, and every one of them would otherwise land on this list.
  assertEquals(
    finishedNeedsReview({
      photosWitness: "page",
      photosTotal: 8,
      photosFailed: 0,
      photosAttached: true,
      priceFilled: true,
    }),
    false,
  );
  assertEquals(
    finishedNeedsReview({
      photosTotal: 6,
      photosFailed: 0,
      photosAttached: true,
      priceFilled: true,
      filled: true,
    }),
    false,
    "a run with no witness word is an ordinary run on four of the five channels",
  );
});

Deno.test("a partial photo attach counts, even with no witness", () => {
  // "6 of 8" is not "attached", and the seller can still fix it by hand.
  assert(finishedNeedsReview({ photosTotal: 8, photosFailed: 2, photosAttached: false }));
});

Deno.test("manual, unverified and a spoken error each qualify", () => {
  assert(finishedNeedsReview({ manual: true }));
  assert(finishedNeedsReview({ unverified: true }));
  assert(finishedNeedsReview({ error: "Poshmark never opened the price dialog." }));
});

Deno.test("the two deliberate exclusions stay excluded", () => {
  // photosUnverified maps to "unknown" in queue-view.js, which is the state of
  // every ordinary run on Mercari, Grailed, Vinted and Facebook. A row that
  // appears on every ordinary run is a row the seller learns to skip.
  assertEquals(
    finishedNeedsReview({ photosTotal: 8, photosFailed: 0, photosUnverified: 8 }),
    false,
    "an unconfirmed attach is not a refusal; only a refusal raises the alarm",
  );
  // priceFilled:false is real and actionable and no client has a sentence for
  // it. Shipping the row before the words is US-3367's mistake upside down.
  assertEquals(
    finishedNeedsReview({ photosTotal: 3, photosFailed: 0, priceFilled: false }),
    false,
  );
});

Deno.test("junk, empty and missing results do not qualify", () => {
  assertEquals(finishedNeedsReview(null), false);
  assertEquals(finishedNeedsReview({}), false);
  assertEquals(finishedNeedsReview({ error: "   " }), false, "whitespace is not a reason");
  assertEquals(finishedNeedsReview({ error: 42 } as unknown as Record<string, unknown>), false);
  assertEquals(finishedNeedsReview({ photosFailed: "two" } as unknown as Record<string, unknown>), false);
  assertEquals(finishedNeedsReview({ manual: "yes" } as unknown as Record<string, unknown>), false);
  assertEquals(finishedNeedsReview({ photosWitness: "page" }), false);
});

Deno.test("the window is a window, and the cap is a cap", () => {
  // The decision, written down where it can be read back: a queue is a to-do
  // list, not a history, so finished work leaves it. 48 hours covers a laptop
  // closed over a weekend; the cap is what keeps a heavy seller's two days from
  // becoming the payload.
  assertEquals(FINISHED_REVIEW_WINDOW_MS, 48 * 60 * 60 * 1000);
  assert(
    FINISHED_REVIEW_WINDOW_MS < 7 * 24 * 60 * 60 * 1000,
    "the review window must stay shorter than the queue's own 7-day expiry, or " +
      "a finished row outlives the work it came from",
  );
  assert(FINISHED_REVIEW_LIMIT > 0 && FINISHED_REVIEW_LIMIT <= 50);
});
