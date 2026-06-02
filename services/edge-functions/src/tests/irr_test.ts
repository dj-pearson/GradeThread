// US-334: inter-rater reliability math unit tests.
//
// Pure stats — no network/DB. Includes a hand-computed Krippendorff's alpha
// oracle so the coefficient is pinned, not just sanity-checked.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  compareAiToHumans,
  computeIrrReport,
  consensusScores,
  type ItemRatings,
  krippendorffAlphaInterval,
  pairwiseAgreement,
} from "../lib/irr.ts";

Deno.test("pairwise agreement: perfect agreement", () => {
  const items: ItemRatings[] = [
    { item_id: "a", scores: [7, 7, 7] },
    { item_id: "b", scores: [9, 9] },
  ];
  const r = pairwiseAgreement(items, 0.5);
  assertEquals(r.agreement_within, 1);
  assertEquals(r.mae, 0);
  // a: C(3,2)=3 pairs, b: 1 pair => 4
  assertEquals(r.pair_count, 4);
});

Deno.test("pairwise agreement: half-point tolerance boundary is inclusive", () => {
  const items: ItemRatings[] = [{ item_id: "a", scores: [7.0, 7.5] }];
  const r = pairwiseAgreement(items, 0.5);
  assertEquals(r.agreement_within, 1); // diff exactly 0.5 counts as agreement
  assertEquals(r.mae, 0.5);
});

Deno.test("pairwise agreement: disagreement beyond tolerance", () => {
  const items: ItemRatings[] = [{ item_id: "a", scores: [6, 8] }];
  const r = pairwiseAgreement(items, 0.5);
  assertEquals(r.agreement_within, 0);
  assertEquals(r.mae, 2);
});

Deno.test("krippendorff alpha: perfect agreement is 1", () => {
  const items: ItemRatings[] = [
    { item_id: "a", scores: [7, 7] },
    { item_id: "b", scores: [9, 9, 9] },
  ];
  assertEquals(krippendorffAlphaInterval(items), 1);
});

Deno.test("krippendorff alpha: hand-computed oracle ≈ 0.390", () => {
  // Worked by hand (see irr.ts header math):
  //   ratings: [6,6],[7,8],[9,7] ; Do=10/6, De=82/30 ; alpha=1-Do/De≈0.3902
  const items: ItemRatings[] = [
    { item_id: "1", scores: [6, 6] },
    { item_id: "2", scores: [7, 8] },
    { item_id: "3", scores: [9, 7] },
  ];
  const alpha = krippendorffAlphaInterval(items);
  assert(alpha !== null);
  assertAlmostEquals(alpha!, 0.3902, 0.001);
});

Deno.test("krippendorff alpha: ignores single-rated items, null when none pairable", () => {
  assertEquals(
    krippendorffAlphaInterval([{ item_id: "a", scores: [7] }]),
    null,
  );
});

Deno.test("krippendorff alpha: systematic disagreement goes negative", () => {
  // Raters anti-correlated across items -> worse than chance.
  const items: ItemRatings[] = [
    { item_id: "a", scores: [2, 9] },
    { item_id: "b", scores: [9, 2] },
    { item_id: "c", scores: [2, 9] },
  ];
  const alpha = krippendorffAlphaInterval(items);
  assert(alpha !== null && alpha < 0, `expected negative alpha, got ${alpha}`);
});

Deno.test("consensus = per-item mean of human scores", () => {
  const c = consensusScores([
    { item_id: "a", scores: [6, 8] },
    { item_id: "b", scores: [9, 9, 9] },
    { item_id: "c", scores: [] },
  ]);
  assertEquals(c.get("a"), 7);
  assertEquals(c.get("b"), 9);
  assertEquals(c.has("c"), false);
});

Deno.test("AI vs humans: AI matching consensus meets the human baseline", () => {
  const items: ItemRatings[] = [
    { item_id: "a", scores: [7, 7] },
    { item_id: "b", scores: [8, 8] },
  ];
  const ai = new Map([["a", 7], ["b", 8]]);
  const cmp = compareAiToHumans(items, ai, 0.5);
  assert(cmp !== null);
  assertEquals(cmp!.ai_agreement_within, 1);
  assertEquals(cmp!.human_agreement_within, 1);
  assert(cmp!.ai_meets_human);
});

Deno.test("AI vs humans: AI worse than humans does not meet baseline", () => {
  const items: ItemRatings[] = [
    { item_id: "a", scores: [7, 7] }, // consensus 7
    { item_id: "b", scores: [8, 8] }, // consensus 8
  ];
  const ai = new Map([["a", 9], ["b", 10]]); // AI off by 2 on both
  const cmp = compareAiToHumans(items, ai, 0.5);
  assert(cmp !== null);
  assertEquals(cmp!.ai_agreement_within, 0);
  assertEquals(cmp!.human_agreement_within, 1);
  assertEquals(cmp!.ai_meets_human, false);
});

Deno.test("AI vs humans: null when no overlapping items", () => {
  const items: ItemRatings[] = [{ item_id: "a", scores: [7, 7] }];
  assertEquals(compareAiToHumans(items, new Map([["z", 7]]), 0.5), null);
});

Deno.test("computeIrrReport: assembles counts + sufficiency flag", () => {
  const items: ItemRatings[] = [
    { item_id: "a", scores: [7, 7, 8] },
    { item_id: "b", scores: [6] }, // not pairable
  ];
  const report = computeIrrReport(items);
  assertEquals(report.item_count, 2);
  assertEquals(report.pairable_item_count, 1);
  assertEquals(report.rater_count, 3);
  assertEquals(report.sufficient_sample, false); // < MIN_CITABLE_ITEMS
  assertEquals(report.ai_vs_human, null); // no AI scores supplied
});
