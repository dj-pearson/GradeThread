// US-592: Scout buy-decision engine (pure).
import { assert, assertEquals } from "@std/assert";
import {
  decideBuy,
  DECISION_MIN_GRADE_CONFIDENCE,
} from "../lib/scout-decision.ts";
import type { ValueRange } from "../lib/condition-value.ts";
import { ebayNetProceedsCents } from "../lib/ebay-fees.ts";
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
  // Resells $80 → net ~$69. Cost $8 → ~760% ROI, fast mover.
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
  // US-2325: derived from the SHARED fee model rather than restated as a
  // literal. This used to read Math.round(8000 * 0.87), hard-coding ScoutAI's
  // private 13%-and-no-fixed-fee — so it would have kept passing while ScoutAI
  // drifted away from the profit estimate the seller is actually shown, which
  // is exactly the divergence this story is about.
  assertEquals(d.breakevenCents, ebayNetProceedsCents(8000));
});

Deno.test("US-2325: the decision nets fees the same way the composer does", () => {
  // The point of the story, asserted directly: a buy/skip verdict and the
  // profit screen the seller lands on next must not disagree. Both run the one
  // model now, INCLUDING the fixed per-order fee ScoutAI never modelled — worth
  // the most, proportionally, on the cheap items a sourcing tool surfaces most.
  const d = decideBuy({
    shadowGrade: 8,
    gradeConfidence: 0.9,
    value: value(1200),
    sellThrough: sell("fast"),
    costCents: 500,
  });
  assertEquals(d.estProceedsCents, ebayNetProceedsCents(1200));
  // 13.6% of $12 is $1.64; the fixed $0.40 is another 3.3% of the sale on top.
  // Rate corrected from 0.1325 under US-9003 — see the note on EBAY_FEE_RATE.
  assertEquals(d.estProceedsCents, 1200 - (Math.ceil(1200 * 0.136) + 40));
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
