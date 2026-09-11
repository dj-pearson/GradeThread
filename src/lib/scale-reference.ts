// US-3332: ask for a standard object beside every flaw, so the grader can size
// it instead of guessing. The sizes mirror the edge copy in
// services/edge-functions/src/lib/scale-reference.ts; both are pinned by
// services/edge-functions/src/tests/scale-reference_test.ts.

export const US_QUARTER_MM = 24.26;
export const ID1_CARD_MM = { long: 85.6, short: 53.98 } as const;
export const MEASURE_CARD_MM = { long: 190.5, short: 139.7 } as const;

/** Shown on the defect group and on flaw-capable slots. */
export const SCALE_REFERENCE_HINT =
  "Lay a coin, a bank card or your MeasureCard right beside the flaw, so we can measure it instead of guessing.";
