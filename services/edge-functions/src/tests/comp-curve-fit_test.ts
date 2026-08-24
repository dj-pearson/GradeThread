// US-2846: the fit, the trim and the publish gate.
//
// The gate is the load-bearing part. Everything else here exists so that when
// publishable() says yes, it is saying something that was actually measured.
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type CompReadSample,
  CURVE_MUST_BEAT_MEDIAN_BY,
  eligibleReads,
  fitCurve,
  HIGH_CONFIDENCE_BAR,
  highConfidenceCount,
  holdOutScore,
  medianCents,
  MIN_FIT_READS,
  MIN_HIGH_CONFIDENCE_READS,
  priceAtGrade,
  publishable,
  trimPriceOutliers,
} from "../lib/comp-curve-fit.ts";

interface FixtureRead extends CompReadSample {
  id: string;
  note: string;
}
const fixture: { cellKey: string; reads: FixtureRead[] } = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/comp-curve-cells.json", import.meta.url),
  ),
);

/** A clean synthetic cell: slope is exactly `slope` cents per grade point. */
function line(n: number, slope: number, base = 2000, conf = 0.8): CompReadSample[] {
  return Array.from({ length: n }, (_, i) => {
    // Round FIRST, then price off the rounded grade. Pricing off the unrounded
    // one leaves the data very slightly non-linear, which is not what a test
    // named "recovered exactly" should be measuring.
    const grade = Math.round((4 + (i * 6) / (n - 1)) * 10) / 10; // 4.0 .. 10.0
    return {
      readScore: grade,
      readConfidence: conf,
      askingPriceCents: Math.round(base + slope * grade),
      stockRejected: false,
    };
  });
}

// eligibility

Deno.test("AC6: a stock-rejected read never reaches the fit", () => {
  const clean = line(14, 500);
  const poisoned: CompReadSample[] = [
    ...clean,
    { readScore: 9.9, readConfidence: 0.95, askingPriceCents: 90000, stockRejected: true },
    { readScore: 9.8, readConfidence: 0.95, askingPriceCents: 88000, stockRejected: true },
  ];
  const a = fitCurve(clean)!;
  const b = fitCurve(poisoned)!;
  assertEquals(b.sampleSize, a.sampleSize, "a rejected read changed the sample size");
  assertAlmostEquals(b.slopeCentsPerPoint, a.slopeCentsPerPoint, 1e-6);
  assertAlmostEquals(b.interceptCents, a.interceptCents, 1e-6);
  assertEquals(eligibleReads(poisoned).length, eligibleReads(clean).length);
});

Deno.test("a read with no score, no price, or zero confidence is not fittable", () => {
  const base: CompReadSample = {
    readScore: 7,
    readConfidence: 0.8,
    askingPriceCents: 4000,
    stockRejected: false,
  };
  assertEquals(eligibleReads([base]).length, 1);
  assertEquals(eligibleReads([{ ...base, readScore: null }]).length, 0);
  assertEquals(eligibleReads([{ ...base, askingPriceCents: null }]).length, 0);
  assertEquals(eligibleReads([{ ...base, askingPriceCents: 0 }]).length, 0);
  assertEquals(eligibleReads([{ ...base, readConfidence: 0 }]).length, 0);
  assertEquals(eligibleReads([{ ...base, readConfidence: null }]).length, 0);
  assertEquals(eligibleReads([{ ...base, readScore: 11 }]).length, 0);
});

// the trim

Deno.test("AC2: the bundle listing is trimmed before the fit", () => {
  const eligible = eligibleReads(fixture.reads);
  const { kept, dropped } = trimPriceOutliers(eligible);
  assertEquals(dropped.length, 1, "expected exactly the bundle to be dropped");
  assertEquals(dropped[0].priceCents, 24000);
  assert(kept.every((r) => r.priceCents < 24000));
});

Deno.test("AC2: leaving the bundle in would have moved the slope, which is why the trim exists", () => {
  const trimmedFit = fitCurve(fixture.reads)!;
  // Same cell, but the bundle relabelled cheap enough to survive the fence.
  const untrimmed = fixture.reads.map((r) =>
    r.id === "B01" ? { ...r, askingPriceCents: 24000 } : r
  );
  const eligible = eligibleReads(untrimmed);
  const raw = eligible; // no trim
  const sw = raw.reduce((a, r) => a + r.weight, 0);
  const xbar = raw.reduce((a, r) => a + r.weight * r.grade, 0) / sw;
  const ybar = raw.reduce((a, r) => a + r.weight * r.priceCents, 0) / sw;
  let sxx = 0, sxy = 0;
  for (const r of raw) {
    sxx += r.weight * (r.grade - xbar) ** 2;
    sxy += r.weight * (r.grade - xbar) * (r.priceCents - ybar);
  }
  const untrimmedSlope = sxy / sxx;
  assert(
    Math.abs(untrimmedSlope - trimmedFit.slopeCentsPerPoint) > 50,
    `the bundle barely moved the slope (${untrimmedSlope} vs ${trimmedFit.slopeCentsPerPoint}), so this fixture no longer tests anything`,
  );
});

Deno.test("a small set is never trimmed: with four prices there is no distribution to speak of", () => {
  const few = eligibleReads(line(3, 500));
  assertEquals(trimPriceOutliers(few).dropped.length, 0);
});

Deno.test("identical prices have no spread, so nothing is an outlier", () => {
  const flat: CompReadSample[] = [5, 6, 7, 8, 9].map((g) => ({
    readScore: g,
    readConfidence: 0.8,
    askingPriceCents: 4000,
    stockRejected: false,
  }));
  assertEquals(trimPriceOutliers(eligibleReads(flat)).dropped.length, 0);
});

// the fit

Deno.test("AC1: a clean line is recovered exactly, slope and intercept", () => {
  const fit = fitCurve(line(14, 500, 2000))!;
  assertAlmostEquals(fit.slopeCentsPerPoint, 500, 1e-6);
  assertAlmostEquals(fit.interceptCents, 2000, 1e-6);
  assertEquals(fit.sampleSize, 14);
  assert(fit.fitConfidence > 0.5);
});

Deno.test("AC5: a flat slope comes back as zero and is not suppressed", () => {
  const flat: CompReadSample[] = [4, 5, 6, 7, 8, 9, 10].map((g) => ({
    readScore: g,
    readConfidence: 0.8,
    askingPriceCents: 4000,
    stockRejected: false,
  }));
  const fit = fitCurve(flat);
  assert(fit != null, "a flat cell must still produce a fit");
  assertAlmostEquals(fit!.slopeCentsPerPoint, 0, 1e-6);
});

Deno.test("AC5: a NEGATIVE slope comes back negative, unflattering or not", () => {
  const fit = fitCurve(line(10, -300, 9000))!;
  assert(fit.slopeCentsPerPoint < 0, `expected a negative slope, got ${fit.slopeCentsPerPoint}`);
});

Deno.test("every read at the same grade produces no fit, rather than a slope from nowhere", () => {
  const oneGrade: CompReadSample[] = [3900, 4100, 4300, 4500].map((p) => ({
    readScore: 7,
    readConfidence: 0.8,
    askingPriceCents: p,
    stockRejected: false,
  }));
  assertEquals(fitCurve(oneGrade), null);
});

Deno.test("below the minimum read count there is no fit", () => {
  assertEquals(fitCurve(line(MIN_FIT_READS - 1, 500)), null);
  assert(fitCurve(line(MIN_FIT_READS, 500)) != null);
});

Deno.test("a quoted price is never negative, however far the line is extrapolated", () => {
  // A steep cell whose fitted intercept is below zero while every sampled price
  // is comfortably positive. Extrapolating down to grade 1 goes negative, and a
  // quote of minus twenty-one dollars is not a quote.
  const fit = fitCurve(line(10, 900, -3000))!;
  assert(fit.interceptCents < 0, `expected a negative intercept, got ${fit.interceptCents}`);
  assertEquals(priceAtGrade(fit, 1), 0);
  assert(priceAtGrade(fit, 10) > 0);
});

Deno.test("confidence weights the fit: a low-confidence outlier moves it less than a confident one", () => {
  const base = line(12, 500);
  const asConfident: CompReadSample[] = [
    ...base,
    { readScore: 5, readConfidence: 0.95, askingPriceCents: 7000, stockRejected: false },
  ];
  const asDoubtful: CompReadSample[] = [
    ...base,
    { readScore: 5, readConfidence: 0.05, askingPriceCents: 7000, stockRejected: false },
  ];
  const clean = fitCurve(base)!.slopeCentsPerPoint;
  const pulled = Math.abs(fitCurve(asConfident)!.slopeCentsPerPoint - clean);
  const nudged = Math.abs(fitCurve(asDoubtful)!.slopeCentsPerPoint - clean);
  assert(pulled > nudged, `confident ${pulled} should move the slope more than doubtful ${nudged}`);
});

// the confidence bar

Deno.test("the confidence bar counts reads AFTER the trim, not before", () => {
  // The fixture's bundle reads at 0.90, well above the bar. It must not count.
  const confident = highConfidenceCount(fixture.reads);
  const naive = fixture.reads.filter(
    (r) => !r.stockRejected && (r.readConfidence ?? 0) >= HIGH_CONFIDENCE_BAR,
  ).length;
  assertEquals(confident, naive - 1, "the trimmed bundle is still being counted");
  assertEquals(confident, 13);
});

// the hold-out score

Deno.test("AC3: the score reports the curve AND the median it has to beat", () => {
  const score = holdOutScore(line(14, 500))!;
  assert(score.rounds === 14, `expected 14 rounds, got ${score.rounds}`);
  assert(score.curveErrorCents >= 0);
  assert(score.medianErrorCents > score.curveErrorCents);
  assert(score.curveErrorPct >= 0 && score.medianErrorPct > 0);
});

Deno.test("AC3: on a flat cell the median wins, and the score says so plainly", () => {
  // Price is pure noise around 4000 with no relationship to grade at all.
  const noise = [4200, 3800, 4100, 3900, 4300, 3700, 4000, 4400, 3600, 4050, 3950, 4150];
  const reads: CompReadSample[] = noise.map((p, i) => ({
    readScore: 4 + i * 0.5,
    readConfidence: 0.8,
    askingPriceCents: p,
    stockRejected: false,
  }));
  const score = holdOutScore(reads)!;
  const fit = fitCurve(reads);
  const verdict = publishable(reads, fit, score);
  assertEquals(verdict.ok, false);
  assert(
    verdict.reason.startsWith("no_better_than_median"),
    `expected the median to win, got ${verdict.reason}`,
  );
});

Deno.test("too small to hold anything out means no score, not a made-up one", () => {
  assertEquals(holdOutScore(line(MIN_FIT_READS, 500)), null);
});

// the gate

Deno.test("AC4: a perfect fit on too few confident reads still does not publish", () => {
  const reads = line(MIN_HIGH_CONFIDENCE_READS - 1, 500);
  const verdict = publishable(reads, fitCurve(reads), holdOutScore(reads));
  assertEquals(verdict.ok, false);
  assert(verdict.reason.startsWith("too_few_confident_reads"), verdict.reason);
});

Deno.test("AC4: the same fit with enough confident reads publishes", () => {
  const reads = line(MIN_HIGH_CONFIDENCE_READS, 500);
  const verdict = publishable(reads, fitCurve(reads), holdOutScore(reads));
  assertEquals(verdict.ok, true, verdict.reason);
  assert(verdict.reason.startsWith("beats_median_by"));
});

Deno.test("AC4: reads that clear the count but sit below the confidence bar do not count", () => {
  const doubtful = line(MIN_HIGH_CONFIDENCE_READS + 4, 500, 2000, HIGH_CONFIDENCE_BAR - 0.1);
  const verdict = publishable(doubtful, fitCurve(doubtful), holdOutScore(doubtful));
  assertEquals(verdict.ok, false);
  assert(verdict.reason.startsWith("too_few_confident_reads"), verdict.reason);
});

Deno.test("AC4: a tie loses. The margin is the constant, and it bites", () => {
  const reads = line(MIN_HIGH_CONFIDENCE_READS, 500);
  const score = holdOutScore(reads)!;
  // Hand the gate a curve that is exactly one hair short of the margin.
  const justUnder = {
    ...score,
    curveErrorCents: score.medianErrorCents * (1 - CURVE_MUST_BEAT_MEDIAN_BY + 0.001),
  };
  assertEquals(publishable(reads, fitCurve(reads), justUnder).ok, false);
  const justOver = {
    ...score,
    curveErrorCents: score.medianErrorCents * (1 - CURVE_MUST_BEAT_MEDIAN_BY - 0.001),
  };
  assertEquals(publishable(reads, fitCurve(reads), justOver).ok, true);
});

Deno.test("AC4: no fit and no score are refused by name, not by crashing", () => {
  const reads = line(MIN_HIGH_CONFIDENCE_READS, 500);
  assertEquals(publishable(reads, null, null).reason, "no_fit");
  assertEquals(publishable(reads, fitCurve(reads), null).reason, "no_holdout_score");
});

Deno.test("AC4: an exact median has nothing to beat and does not publish", () => {
  const reads = line(MIN_HIGH_CONFIDENCE_READS, 500);
  const score = { ...holdOutScore(reads)!, medianErrorCents: 0 };
  assertEquals(publishable(reads, fitCurve(reads), score).reason, "median_already_exact");
});

// the fixture cell, end to end

Deno.test("the fixture cell publishes, and the numbers are stated rather than assumed", () => {
  const fit = fitCurve(fixture.reads)!;
  const score = holdOutScore(fixture.reads)!;
  const verdict = publishable(fixture.reads, fit, score);
  assertEquals(fit.trimmed, 1);
  assertEquals(fit.sampleSize, 15);
  assertEquals(verdict.ok, true, verdict.reason);
  assert(fit.slopeCentsPerPoint > 400 && fit.slopeCentsPerPoint < 800, `slope ${fit.slopeCentsPerPoint}`);
  assert(
    score.curveErrorCents < score.medianErrorCents / 2,
    `curve ${score.curveErrorCents} vs median ${score.medianErrorCents}`,
  );
});

Deno.test("medianCents is the plain median, including the even-count case", () => {
  assertEquals(medianCents([]), 0);
  assertEquals(medianCents([100]), 100);
  assertEquals(medianCents([100, 200]), 150);
  assertEquals(medianCents([300, 100, 200]), 200);
});

// AC1: pure

Deno.test("AC1: the module makes no network call and pulls in no I/O client", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/comp-curve-fit.ts", import.meta.url),
  );
  assert(!/\bfetch\s*\(/.test(src), "comp-curve-fit.ts calls fetch");
  assert(!/from\s+"\.\/(ebay-client|supabase)\.ts"/.test(src), "it imports an I/O client");
  assert(!/\bDeno\.env\b/.test(src), "it reads env");
  assert(!/^import /m.test(src), "a pure maths module should need no imports at all");
});
