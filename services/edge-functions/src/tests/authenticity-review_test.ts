// US-2140: authenticity review outcomes + the golden-set promotion rules.
// Pure logic only — no supabase load, so no dummy env needed.

import { assert, assertEquals } from "@std/assert";
import {
  canPromoteToGoldenSet,
  isDangerousOverride,
  overrodeModel,
  validateReviewOutcome,
} from "../lib/authenticity-review.ts";

// ── override detection across two vocabularies ──────────────────────────────

Deno.test("overrodeModel maps the model vocabulary before comparing", () => {
  assertEquals(overrodeModel("likely_authentic", "authentic"), false);
  assertEquals(overrodeModel("red_flags", "counterfeit"), false);
  assertEquals(overrodeModel("inconclusive", "inconclusive"), false);

  assert(overrodeModel("likely_authentic", "counterfeit"));
  assert(overrodeModel("red_flags", "authentic"));
  assert(overrodeModel("inconclusive", "authentic"));
});

Deno.test("overrodeModel: a pass that never ran is not an override", () => {
  // Nothing to disagree with — counting this as an override would inflate the
  // model's apparent error rate with cases it never saw.
  assertEquals(overrodeModel(null, "counterfeit"), false);
});

Deno.test("isDangerousOverride: only model-said-authentic, reviewer-said-fake", () => {
  assert(isDangerousOverride("likely_authentic", "counterfeit"));
  // The reverse is a false alarm: it cost a seller a review, not a buyer a fake.
  assertEquals(isDangerousOverride("red_flags", "authentic"), false);
  assertEquals(isDangerousOverride("inconclusive", "counterfeit"), false);
  assertEquals(isDangerousOverride(null, "counterfeit"), false);
});

// ── promotion into the golden set ───────────────────────────────────────────

const GOOD = { reviewer_verdict: "counterfeit" as const, reasoning: "Date code impossible for the line." };

Deno.test("canPromoteToGoldenSet: a well-formed decisive review promotes", () => {
  assertEquals(canPromoteToGoldenSet(GOOD, 3, false).ok, true);
});

Deno.test("canPromoteToGoldenSet: inconclusive is a valid review but a poor eval case", () => {
  const r = canPromoteToGoldenSet(
    { reviewer_verdict: "inconclusive", reasoning: "Could not tell." },
    3,
    false,
  );
  assertEquals(r.ok, false);
  assert(r.reason?.includes("inconclusive"));
});

Deno.test("canPromoteToGoldenSet: an unexplained label cannot be audited later", () => {
  assertEquals(canPromoteToGoldenSet({ ...GOOD, reasoning: "   " }, 3, false).ok, false);
  assertEquals(canPromoteToGoldenSet({ ...GOOD, reasoning: null }, 3, false).ok, false);
});

Deno.test("canPromoteToGoldenSet: no images means nothing to replay", () => {
  assertEquals(canPromoteToGoldenSet(GOOD, 0, false).ok, false);
});

Deno.test("canPromoteToGoldenSet: promotion is idempotent-by-refusal", () => {
  const r = canPromoteToGoldenSet(GOOD, 3, true);
  assertEquals(r.ok, false);
  assert(r.reason?.includes("already"));
});

// ── write validation ────────────────────────────────────────────────────────

Deno.test("validateReviewOutcome accepts a minimal valid body", () => {
  assertEquals(
    validateReviewOutcome({ grade_report_id: "abc", reviewer_verdict: "authentic" }),
    null,
  );
});

Deno.test("validateReviewOutcome rejects a missing report or a junk verdict", () => {
  assert(validateReviewOutcome({ reviewer_verdict: "authentic" })?.includes("grade_report_id"));
  assert(
    validateReviewOutcome({ grade_report_id: "abc", reviewer_verdict: "probably fine" })
      ?.includes("reviewer_verdict"),
  );
  assert(
    validateReviewOutcome({
      grade_report_id: "abc",
      reviewer_verdict: "authentic",
      tells_relied_on: "date_code",
    })?.includes("tells_relied_on"),
  );
});
