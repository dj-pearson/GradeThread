// US-2505: the review claim must bind the DECIDING routes (approve / adjust /
// send-back), not just /claim. Before this, two operators — one on
// /admin/grading, one on the /admin/reviews page that never claimed at all —
// could both finalize the same report and each insert a `human_reviews` row.

import { assertEquals } from "@std/assert";
import {
  REVIEW_CLAIM_TTL_SEC,
  reviewClaimVerdict,
} from "../lib/review-claim.ts";

const ME = "admin-1";
const OTHER = "admin-2";
const NOW = Date.parse("2026-08-14T12:00:00.000Z");

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

const base = {
  humanReviewed: false as boolean | null,
  claimedBy: null as string | null,
  claimedAt: null as string | null,
  adminId: ME,
  nowMs: NOW,
};

Deno.test("unclaimed report: anyone may decide (claiming stays optional)", () => {
  assertEquals(reviewClaimVerdict(base), "ok");
});

Deno.test("my own fresh claim does not block me", () => {
  assertEquals(
    reviewClaimVerdict({ ...base, claimedBy: ME, claimedAt: at(60_000) }),
    "ok",
  );
});

Deno.test("another operator's FRESH claim blocks the decision", () => {
  assertEquals(
    reviewClaimVerdict({ ...base, claimedBy: OTHER, claimedAt: at(60_000) }),
    "held_by_other",
  );
});

Deno.test("another operator's STALE claim does not wedge the queue", () => {
  const justPastTtl = REVIEW_CLAIM_TTL_SEC * 1000 + 1;
  assertEquals(
    reviewClaimVerdict({ ...base, claimedBy: OTHER, claimedAt: at(justPastTtl) }),
    "ok",
  );
});

Deno.test("the TTL boundary is exclusive: one ms inside still holds", () => {
  const justInsideTtl = REVIEW_CLAIM_TTL_SEC * 1000 - 1;
  assertEquals(
    reviewClaimVerdict({ ...base, claimedBy: OTHER, claimedAt: at(justInsideTtl) }),
    "held_by_other",
  );
});

Deno.test("a claim with an unparseable timestamp is not a lock", () => {
  assertEquals(
    reviewClaimVerdict({ ...base, claimedBy: OTHER, claimedAt: "not-a-date" }),
    "ok",
  );
});

// The AC that makes "one human_reviews row per finalized report" true: an
// already-decided report refuses a second decision from ANYONE, including the
// reviewer who made the first one and including an unclaimed report.
Deno.test("an already-reviewed report refuses a second decision", () => {
  assertEquals(
    reviewClaimVerdict({ ...base, humanReviewed: true }),
    "already_reviewed",
  );
  assertEquals(
    reviewClaimVerdict({ ...base, humanReviewed: true, claimedBy: ME, claimedAt: at(1) }),
    "already_reviewed",
  );
  assertEquals(
    reviewClaimVerdict({
      ...base,
      humanReviewed: true,
      claimedBy: OTHER,
      claimedAt: at(REVIEW_CLAIM_TTL_SEC * 1000 + 1),
    }),
    "already_reviewed",
  );
});

Deno.test("already-reviewed outranks a fresh claim held by someone else", () => {
  // Both conditions true — the caller should be told it is decided, which is
  // the actionable message, not that someone else is looking at it.
  assertEquals(
    reviewClaimVerdict({
      ...base,
      humanReviewed: true,
      claimedBy: OTHER,
      claimedAt: at(1_000),
    }),
    "already_reviewed",
  );
});
