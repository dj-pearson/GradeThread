// US-1558: active-learning review routing — information-value scoring + the
// SLA-guarded queue ordering. Pure math, fully deterministic.
import { assert, assertEquals } from "@std/assert";

const {
  defectComboKey,
  informationValue,
  rankReviews,
} = await import("../lib/review-info-value.ts");

const CTX = {
  goldenByCategory: { jeans: 40, hoodie: 0 },
  exemplarsByCategory: { jeans: 8 },
  comboCounts: { "hole_puncture+stain": 25, clean: 100 },
  thresholdForCategory: (cat: string | null) => (cat === "jeans" ? 0.65 : 0.75),
};

Deno.test("US-1558: defectComboKey is order-insensitive, deduped, 'clean' for none", () => {
  assertEquals(defectComboKey(["stain", "hole_puncture"]), "hole_puncture+stain");
  assertEquals(defectComboKey(["stain", "stain"]), "stain");
  assertEquals(defectComboKey([]), "clean");
  assertEquals(defectComboKey(["", "  "]), "clean");
});

Deno.test("US-1558: uncovered category + boundary confidence + rare combo scores high", () => {
  const high = informationValue(
    { garmentCategory: "hoodie", confidence: 0.74, defectTypes: ["snag_pull"] },
    CTX,
  );
  const low = informationValue(
    { garmentCategory: "jeans", confidence: 0.95, defectTypes: ["hole_puncture", "stain"] },
    CTX,
  );
  assert(high.score > low.score, `${high.score} !> ${low.score}`);
  assert(high.factors.novelty > 0.9, "zero-coverage category is maximally novel");
  assert(high.factors.calibrationGap > 0.9, "0.74 sits on the 0.75 boundary");
  assertEquals(high.factors.rarity, 1, "unseen combo");
  // Reasons name the dominant factors for the reviewer.
  assert(high.reasons.includes("novel category"));
  assert(high.reasons.includes("near review threshold"));
});

Deno.test("US-1558: calibration gap uses the CATEGORY threshold (US-1557)", () => {
  // 0.66 is far from the flat 0.75 but right on jeans' calibrated 0.65.
  const jeans = informationValue(
    { garmentCategory: "jeans", confidence: 0.66, defectTypes: [] },
    CTX,
  );
  const other = informationValue(
    { garmentCategory: "dress", confidence: 0.66, defectTypes: [] },
    CTX,
  );
  assert(jeans.factors.calibrationGap > other.factors.calibrationGap);
});

Deno.test("US-1558: heavily-seen combos and categories score low", () => {
  const iv = informationValue(
    { garmentCategory: "jeans", confidence: 0.3, defectTypes: [] },
    CTX,
  );
  assert(iv.factors.novelty < 0.1, "48 labels of coverage ≈ nothing new");
  assert(iv.factors.rarity <= 0.01, "the clean combo is everywhere");
  assertEquals(iv.factors.calibrationGap, 0, "0.3 is far from every threshold");
});

Deno.test("US-1558: rankReviews floats SLA-overdue items regardless of score", () => {
  const day = 24 * 3_600_000;
  const order = rankReviews(
    [
      { waitingMs: 1 * 3_600_000, infoScore: 0.95 }, // hot but fresh
      { waitingMs: 30 * 3_600_000, infoScore: 0.05 }, // overdue, boring
      { waitingMs: 26 * 3_600_000, infoScore: 0.5 }, // overdue, less old
      { waitingMs: 2 * 3_600_000, infoScore: 0.4 },
    ],
    day,
  );
  // Overdue first, oldest-first among themselves; then by score.
  assertEquals(order, [1, 2, 0, 3]);
});
