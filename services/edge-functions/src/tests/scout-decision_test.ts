// US-592: Scout buy-decision engine (pure).
import { assert, assertEquals } from "@std/assert";
import {
  decideBuy,
  DECISION_MIN_GRADE_CONFIDENCE,
} from "../lib/scout-decision.ts";
import type { ValueRange } from "../lib/condition-value.ts";
import type { SellThroughForecast } from "../lib/sell-through.ts";

const value = (medianCents: number | null, sufficient = true): ValueRange => ({
  lowCents: medianCents == null ? null : medianCents - 1000,
  medianCents,
  highCents: medianCents == null ? null : medianCents + 1000,
  sampleSize: sufficient ? 12 : 1,
  confidence: sufficient ? 0.8 : 0.1,
  sufficient,
  currency: "USD",
});

const sell = (label: SellThroughForecast["label"]): SellThroughForecast => ({
  sellThroughPct: label === "fast" ? 0.8 : label === "slow" ? 0.3 : 0.55,
  daysLow: 5,
  daysHigh: 20,
  label,
  sampleSize: 12,
});

Deno.test("cheap item with strong margin → buy", () => {
  // Resells $80 → net ~$69.6. Cost $8 → ~770% ROI, fast mover.
  const d = decideBuy({
    shadowGrade: 8.5,
    gradeConfidence: 0.85,
    value: value(8000),
    sellThrough: sell("fast"),
    costCents: 800,
  });
  assertEquals(d.recommendation, "buy");
  assert(d.estMarginCents! > 0);
  assert(d.roiPct! > 1);
  assertEquals(d.breakevenCents, Math.round(8000 * 0.87));
});

Deno.test("negative margin → skip", () => {
  const d = decideBuy({
    shadowGrade: 7,
    gradeConfidence: 0.85,
    value: value(2000),
    sellThrough: sell("fast"),
    costCents: 3000, // pay $30, net resale ~$17.4
  });
  assertEquals(d.recommendation, "skip");
  assert(d.estMarginCents! < 0);
});

Deno.test("insufficient comps → skip with no numbers", () => {
  const d = decideBuy({
    shadowGrade: 8,
    gradeConfidence: 0.9,
    value: value(null, false),
    sellThrough: sell("unknown"),
    costCents: 500,
  });
  assertEquals(d.recommendation, "skip");
  assertEquals(d.estProceedsCents, null);
  assertEquals(d.breakevenCents, null);
  assert(d.reason.toLowerCase().includes("comp"));
});

Deno.test("low grade confidence on a graded item is never a strong buy", () => {
  const d = decideBuy({
    shadowGrade: 9,
    gradeConfidence: DECISION_MIN_GRADE_CONFIDENCE - 0.01,
    value: value(8000),
    sellThrough: sell("fast"),
    costCents: 800,
  });
  assertEquals(d.recommendation, "maybe");
  assertEquals(d.confident, false);
});

Deno.test("no cost yet → maybe, with breakeven surfaced", () => {
  const d = decideBuy({
    shadowGrade: 8,
    gradeConfidence: 0.85,
    value: value(8000),
    sellThrough: sell("fast"),
    costCents: null,
  });
  assertEquals(d.recommendation, "maybe");
  assertEquals(d.estMarginCents, null);
  assert(d.breakevenCents! > 0);
});

Deno.test("barcode-only (no shadow grade) isn't gated on grade confidence", () => {
  const d = decideBuy({
    shadowGrade: null,
    gradeConfidence: 0,
    value: value(8000),
    sellThrough: sell("fast"),
    costCents: 800,
  });
  assertEquals(d.confident, true);
  assertEquals(d.recommendation, "buy");
});

Deno.test("great ROI but slow sell-through is demoted to maybe", () => {
  const d = decideBuy({
    shadowGrade: 8,
    gradeConfidence: 0.85,
    value: value(8000),
    sellThrough: sell("slow"),
    costCents: 800,
  });
  assertEquals(d.recommendation, "maybe");
  assert(d.reason.toLowerCase().includes("slow"));
});
