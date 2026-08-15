// US-2309: the post-composite caps, and the fact that quick-grade now runs them.
//
//   deno test --allow-env --allow-read src/tests/post-composite-caps_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  PARTIAL_IMAGE_CONFIDENCE_CAP,
  PEER_NORM_CONFIDENCE_CAP,
  VERIFICATION_DISCREPANCY_REVIEW_MIN,
  applyPostCompositeCaps,
} from "../lib/post-composite-caps.ts";

const BASE = {
  confidence: 0.92,
  ceiling: 1,
  reviewThreshold: 0.75,
  partialImageSet: false,
  verificationDiscrepancies: 0,
  peerNormCap: null,
};

Deno.test("US-2309: an uncapped grade passes through untouched", () => {
  const r = applyPostCompositeCaps({ ...BASE });
  assertEquals(r.confidence, 0.92);
  assertEquals(r.ceiling, 1);
  assertEquals(r.needsHumanReview, false);
  assertEquals(r.applied, []);
});

Deno.test("US-2309: a partial image set caps confidence AND the ceiling", () => {
  // The ceiling half is the one that has been forgotten before (US-2299): a cap
  // that lowers only the value still routes to a human, so it looks handled,
  // while the next provenance boost lifts the stored number back over it.
  const r = applyPostCompositeCaps({ ...BASE, partialImageSet: true });
  assertEquals(r.confidence, PARTIAL_IMAGE_CONFIDENCE_CAP);
  assertEquals(r.ceiling, PARTIAL_IMAGE_CONFIDENCE_CAP);
  assertEquals(r.needsHumanReview, true);
  assert(r.applied.includes("partial_image_set"));
});

Deno.test("US-2309: a peer-norm outlier caps to the peer-norm number, not the partial one", () => {
  // These two constants are DIFFERENT (0.6 and 0.7) and the skill records that
  // a doc and a code comment both once claimed they matched.
  const r = applyPostCompositeCaps({ ...BASE, peerNormCap: PEER_NORM_CONFIDENCE_CAP });
  assertEquals(r.confidence, PEER_NORM_CONFIDENCE_CAP);
  assertEquals(r.ceiling, PEER_NORM_CONFIDENCE_CAP);
  assertEquals(r.needsHumanReview, true);
});

Deno.test("US-2309: caps compose by MIN — the most conservative one wins", () => {
  const r = applyPostCompositeCaps({
    ...BASE,
    partialImageSet: true,
    peerNormCap: PEER_NORM_CONFIDENCE_CAP,
  });
  assertEquals(r.confidence, Math.min(PARTIAL_IMAGE_CONFIDENCE_CAP, PEER_NORM_CONFIDENCE_CAP));
  assertEquals(r.applied.length, 2);
});

Deno.test("US-2309: order does not change the outcome", () => {
  // Every step is a MIN, so a refactor that reorders them cannot change a grade.
  // Asserted rather than assumed, because the pipeline's inline version applies
  // them in a fixed sequence and someone will eventually move one.
  const both = applyPostCompositeCaps({
    ...BASE,
    partialImageSet: true,
    verificationDiscrepancies: 3,
    peerNormCap: PEER_NORM_CONFIDENCE_CAP,
  });
  const alsoBoth = applyPostCompositeCaps({
    ...BASE,
    peerNormCap: PEER_NORM_CONFIDENCE_CAP,
    verificationDiscrepancies: 3,
    partialImageSet: true,
  });
  assertEquals(both.confidence, alsoBoth.confidence);
  assertEquals(both.ceiling, alsoBoth.ceiling);
});

Deno.test("US-2309: one discrepancy shaves but does not force review; two do", () => {
  const one = applyPostCompositeCaps({ ...BASE, verificationDiscrepancies: 1 });
  assertEquals(one.confidence < BASE.confidence, true);
  assertEquals(one.needsHumanReview, false);

  const two = applyPostCompositeCaps({
    ...BASE,
    verificationDiscrepancies: VERIFICATION_DISCREPANCY_REVIEW_MIN,
  });
  assertEquals(two.needsHumanReview, true);
});

Deno.test("US-2309: the discrepancy shave is bounded", () => {
  const many = applyPostCompositeCaps({ ...BASE, verificationDiscrepancies: 12 });
  // 12 * 0.1 would take it to zero; the cap is 0.2 total, as in the pipeline.
  assertEquals(Number(many.confidence.toFixed(2)), 0.72);
});

Deno.test("US-2309: confidence never goes below zero", () => {
  const r = applyPostCompositeCaps({ ...BASE, confidence: 0.05, verificationDiscrepancies: 5 });
  assertEquals(r.confidence >= 0, true);
});

Deno.test("US-2309: the flat threshold still applies to whatever survives", () => {
  const r = applyPostCompositeCaps({ ...BASE, confidence: 0.7 });
  assertEquals(r.needsHumanReview, true, "0.7 is below the 0.75 threshold");
  assertEquals(r.applied, [], "the threshold is not a cap and must not report as one");
});

Deno.test("US-2309: a cap never RAISES confidence or the ceiling", () => {
  // The contract's one-way rule, asserted directly rather than inferred from the
  // individual cases above.
  for (const discrepancies of [0, 1, 2, 5]) {
    for (const partial of [false, true]) {
      for (const peer of [null, PEER_NORM_CONFIDENCE_CAP]) {
        const r = applyPostCompositeCaps({
          ...BASE,
          confidence: 0.8,
          ceiling: 0.9,
          partialImageSet: partial,
          verificationDiscrepancies: discrepancies,
          peerNormCap: peer,
        });
        assert(r.confidence <= 0.8, `confidence rose to ${r.confidence}`);
        assert(r.ceiling <= 0.9, `ceiling rose to ${r.ceiling}`);
      }
    }
  }
});

// ── The wiring, which is the half the story is actually about ────────────────

const QUICK_GRADE_SRC = Deno.readTextFileSync(
  new URL("../lib/quick-grade.ts", import.meta.url),
);

Deno.test("US-2309: quick-grade no longer returns the composite's verdict raw", () => {
  // The defect, in one line: `needsHumanReview: composite.needs_human_review`.
  assertEquals(
    /needsHumanReview:\s*composite\.needs_human_review\s*,/.test(QUICK_GRADE_SRC),
    false,
    "quick-grade is passing the composite's review flag straight out again, so " +
      "none of the post-composite caps reach Snap-to-Value or the extension",
  );
  assert(QUICK_GRADE_SRC.includes("applyPostCompositeCaps"));
});

Deno.test("US-2309: quick-grade ORs the review flag rather than replacing it", () => {
  // compositeGrade may already have forced review for a reason the caps know
  // nothing about — an authenticity flag, a defaulted factor. Replacing the flag
  // would silently un-flag those.
  assert(
    /needsHumanReview:\s*composite\.needs_human_review\s*\|\|\s*capped\.needsHumanReview/
      .test(QUICK_GRADE_SRC),
    "quick-grade replaces the composite's review flag instead of adding to it",
  );
});

Deno.test("US-2309: quick-grade passes the missing-close-up signal to the composite", () => {
  // A quick grade is usually front/back shots off a listing, so this is the
  // common case here rather than the exception.
  assert(QUICK_GRADE_SRC.includes("fabricCloseupMissing"));
});

Deno.test("US-2309: quick-grade returns its ceiling", () => {
  // Nothing boosts a quick grade today. The ceiling leaves the function anyway,
  // so the next caller to add a boost does not have to discover the rule.
  assert(/confidenceCeiling:\s*capped\.ceiling/.test(QUICK_GRADE_SRC));
});
