// Auto-approve threshold for the mandatory grade-review workflow. Pure
// functions, no DB/env needed (the env is injectable), so the gating logic is
// unit-testable in isolation.

import { assertEquals } from "@std/assert";
import {
  autoApproveThreshold,
  shouldAutoApprove,
} from "../lib/grade-auto-approve.ts";

Deno.test("autoApproveThreshold: unset → default 0.9", () => {
  assertEquals(autoApproveThreshold(undefined), 0.9);
});

Deno.test("autoApproveThreshold: a valid (0,1] value is honored", () => {
  assertEquals(autoApproveThreshold("0.85"), 0.85);
  assertEquals(autoApproveThreshold("1"), 1);
  assertEquals(autoApproveThreshold(" 0.95 "), 0.95);
});

Deno.test("autoApproveThreshold: off / blank / out-of-range → disabled (null)", () => {
  assertEquals(autoApproveThreshold("off"), null);
  assertEquals(autoApproveThreshold("OFF"), null);
  assertEquals(autoApproveThreshold("false"), null);
  assertEquals(autoApproveThreshold("disabled"), null);
  assertEquals(autoApproveThreshold(""), null);
  assertEquals(autoApproveThreshold("0"), null);
  assertEquals(autoApproveThreshold("-0.5"), null);
  assertEquals(autoApproveThreshold("1.5"), null);
  assertEquals(autoApproveThreshold("not-a-number"), null);
});

Deno.test("shouldAutoApprove: disabled threshold never auto-approves", () => {
  assertEquals(
    shouldAutoApprove(
      { confidenceScore: 0.99, needsHumanReview: false, flagged: false },
      null,
    ),
    false,
  );
});

Deno.test("shouldAutoApprove: high-confidence, clean grade auto-approves", () => {
  assertEquals(
    shouldAutoApprove(
      { confidenceScore: 0.92, needsHumanReview: false, flagged: false },
      0.9,
    ),
    true,
  );
  // Exactly at the threshold qualifies.
  assertEquals(
    shouldAutoApprove(
      { confidenceScore: 0.9, needsHumanReview: false, flagged: false },
      0.9,
    ),
    true,
  );
});

Deno.test("shouldAutoApprove: below threshold goes to human review", () => {
  assertEquals(
    shouldAutoApprove(
      { confidenceScore: 0.89, needsHumanReview: false, flagged: false },
      0.9,
    ),
    false,
  );
});

Deno.test("shouldAutoApprove: needs_human_review always blocks auto-approve", () => {
  // Even with perfect confidence, a human-review routing wins.
  assertEquals(
    shouldAutoApprove(
      { confidenceScore: 1, needsHumanReview: true, flagged: false },
      0.9,
    ),
    false,
  );
});

Deno.test("shouldAutoApprove: a flagged grade always blocks auto-approve", () => {
  assertEquals(
    shouldAutoApprove(
      { confidenceScore: 1, needsHumanReview: false, flagged: true },
      0.9,
    ),
    false,
  );
});
