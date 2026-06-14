// US-899: cross-tenant listing-pipeline oversight — pure-logic tests.

import { assertEquals } from "@std/assert";
import {
  ageMs,
  batchActions,
  isBatchIssue,
  isStuckBatch,
  listingPublishState,
  pipelineBacklog,
  STUCK_BATCH_MS,
  STUCK_LISTING_MS,
} from "../lib/pipeline-oversight.ts";

const NOW = new Date("2026-06-14T12:00:00Z");

function minsAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

Deno.test("ageMs: clamps negatives, handles bad/empty input", () => {
  assertEquals(ageMs(minsAgo(10), NOW), 10 * 60_000);
  assertEquals(ageMs(null, NOW), null);
  assertEquals(ageMs("not-a-date", NOW), null);
  // Future timestamp → 0, never negative.
  assertEquals(ageMs(new Date(NOW.getTime() + 60_000).toISOString(), NOW), 0);
});

Deno.test("isStuckBatch: running/pending past the window is stuck", () => {
  assertEquals(isStuckBatch("running", minsAgo(20), NOW), true);
  assertEquals(isStuckBatch("pending", minsAgo(20), NOW), true);
  // Fresh running batch is not stuck.
  assertEquals(isStuckBatch("running", minsAgo(2), NOW), false);
  // Terminal statuses are never "stuck".
  assertEquals(isStuckBatch("failed", minsAgo(100), NOW), false);
  assertEquals(isStuckBatch("completed", minsAgo(100), NOW), false);
  // Exactly at threshold counts as stuck (>=).
  assertEquals(isStuckBatch("running", new Date(NOW.getTime() - STUCK_BATCH_MS).toISOString(), NOW), true);
});

Deno.test("batchActions: retry needs incomplete work + terminal-or-stuck", () => {
  // Failed batch with incomplete items → retry + not cancel (terminal).
  assertEquals(batchActions("failed", 10, 4, 2, false), { canRetry: true, canCancel: false });
  // Partial with everything succeeded → no work → no retry.
  assertEquals(batchActions("partial", 10, 10, 0, false), { canRetry: false, canCancel: false });
  // Running + fresh (not stuck) → no retry (would race the worker) but cancellable.
  assertEquals(batchActions("running", 10, 1, 0, false), { canRetry: false, canCancel: true });
  // Running + stuck + incomplete → retry AND cancel.
  assertEquals(batchActions("running", 10, 1, 0, true), { canRetry: true, canCancel: true });
  // Pending is cancellable.
  assertEquals(batchActions("pending", 5, 0, 0, false), { canRetry: false, canCancel: true });
});

Deno.test("isBatchIssue: failed/partial always; running/pending only when stuck", () => {
  assertEquals(isBatchIssue("failed", false), true);
  assertEquals(isBatchIssue("partial", false), true);
  assertEquals(isBatchIssue("running", false), false);
  assertEquals(isBatchIssue("running", true), true);
  assertEquals(isBatchIssue("completed", false), false);
});

Deno.test("listingPublishState: failed > sending > healthy; live excluded", () => {
  // A recorded publish error → failed (even if also stale-claimed).
  assertEquals(
    listingPublishState(
      { listing_status: "draft", publish_error: "eBay 500", publish_claimed_at: minsAgo(60), synced_to_ebay_at: null },
      NOW,
    ),
    "failed",
  );
  // Claimed long ago, never synced, no error → stuck "sending".
  assertEquals(
    listingPublishState(
      { listing_status: "draft", publish_error: null, publish_claimed_at: minsAgo(20), synced_to_ebay_at: null },
      NOW,
    ),
    "sending",
  );
  // Claimed recently → not yet an issue.
  assertEquals(
    listingPublishState(
      { listing_status: "draft", publish_error: null, publish_claimed_at: minsAgo(2), synced_to_ebay_at: null },
      NOW,
    ),
    null,
  );
  // Already live → never an issue, even with a stale claim.
  assertEquals(
    listingPublishState(
      { listing_status: "draft", publish_error: "old", publish_claimed_at: minsAgo(99), synced_to_ebay_at: minsAgo(1) },
      NOW,
    ),
    null,
  );
  // Exactly at the listing window → stuck.
  assertEquals(
    listingPublishState(
      {
        listing_status: "draft",
        publish_error: null,
        publish_claimed_at: new Date(NOW.getTime() - STUCK_LISTING_MS).toISOString(),
        synced_to_ebay_at: null,
      },
      NOW,
    ),
    "sending",
  );
});

Deno.test("pipelineBacklog: sums every distinct problem", () => {
  assertEquals(
    pipelineBacklog({
      failedGenerationBatches: 1,
      stuckGenerationBatches: 2,
      failedGenerationJobs: 3,
      failedPublishBatches: 4,
      stuckPublishBatches: 5,
      failedListings: 6,
      stuckListings: 7,
    }),
    28,
  );
  assertEquals(
    pipelineBacklog({
      failedGenerationBatches: 0,
      stuckGenerationBatches: 0,
      failedGenerationJobs: 0,
      failedPublishBatches: 0,
      stuckPublishBatches: 0,
      failedListings: 0,
      stuckListings: 0,
    }),
    0,
  );
});
