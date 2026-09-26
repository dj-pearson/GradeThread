// US-3537: the final review re-check uses the threshold compositeGrade used.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  reconcileNeedsReview,
  reviewConfidenceThreshold,
} from "../lib/ai-config.ts";

Deno.test("US-3537: a calibrated 0.65 threshold keeps a 0.70 grade out of review", () => {
  assertEquals(reconcileNeedsReview(false, 0.70, 0.65), false);
  // The flat default would have re-flagged it, which was the bug.
  assert(0.70 < reviewConfidenceThreshold());
  assertEquals(reconcileNeedsReview(false, 0.70), true);
});

Deno.test("US-3537: an existing flag is never cleared, and undefined means flat", () => {
  assertEquals(reconcileNeedsReview(true, 0.99, 0.65), true);
  assertEquals(
    reconcileNeedsReview(false, 0.70, undefined),
    reconcileNeedsReview(false, 0.70),
  );
});

Deno.test("US-3537: compositeGrade reports its threshold and the pipeline passes it on", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  assert(
    (await read("../lib/ai-grading.ts")).includes(
      "review_threshold: effectiveThreshold,",
    ),
  );
  const pipe = await read("../lib/grading-pipeline.ts");
  const at = pipe.indexOf(
    "compositeResult.needs_human_review = reconcileNeedsReview(",
  );
  assert(
    at > 0 &&
      pipe.slice(at, at + 400).includes("compositeResult.review_threshold,"),
  );
});
