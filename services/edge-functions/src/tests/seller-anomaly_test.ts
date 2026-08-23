import { assertEquals } from "@std/assert";
import {
  baselineOf,
  describeAnomaly,
  detectSellerAnomaly,
  DEFAULT_SELLER_ANOMALY_THRESHOLDS as D,
  type WeekPoint,
} from "../lib/seller-anomaly.ts";

// US-2828 AC2/AC3. Every case below is a seller who would or would not be
// emailed, so the assertions are about that decision rather than about the
// arithmetic — the arithmetic is only interesting where it changes the answer.

const weeks = (...values: number[]): WeekPoint[] =>
  values.map((value, i) => ({
    week: `2026-01-${String(i + 1).padStart(2, "0")}`,
    value,
  }));

Deno.test("baselineOf excludes nothing the caller passed, and handles empty", () => {
  assertEquals(baselineOf([]), { mean: 0, stdDev: 0, weeks: 0 });
  const b = baselineOf(weeks(10, 10, 10, 10));
  assertEquals(b.mean, 10);
  assertEquals(b.stdDev, 0);
  assertEquals(b.weeks, 4);
});

Deno.test("baselineOf uses POPULATION spread, not sample", () => {
  // n rather than n-1. Stated because switching it changes every sigma by a few
  // percent and would silently move the alerting threshold for everyone.
  const b = baselineOf(weeks(2, 4, 4, 4, 5, 5, 7, 9));
  assertEquals(b.mean, 5);
  assertEquals(b.stdDev, 2);
});

Deno.test("AC2: a real spike fires", () => {
  const a = detectSellerAnomaly("Items sold", weeks(20, 22, 19, 21, 20, 18, 60));
  assertEquals(a !== null, true);
  assertEquals(a!.direction, "up");
  assertEquals(a!.week, "2026-01-07");
  assertEquals(a!.value, 60);
  assertEquals(a!.sigma > D.sigma, true);
});

Deno.test("AC2: a real collapse fires, and reports DOWN", () => {
  const a = detectSellerAnomaly("Items sold", weeks(40, 38, 41, 39, 42, 40, 2));
  assertEquals(a !== null, true);
  assertEquals(a!.direction, "down");
  assertEquals(a!.sigma < -D.sigma, true);
});

Deno.test("AC2: an ordinary week does not fire", () => {
  assertEquals(detectSellerAnomaly("Items sold", weeks(20, 22, 19, 21, 20, 18, 21)), null);
});

Deno.test("AC2: the series need not arrive sorted", () => {
  const scrambled: WeekPoint[] = [
    { week: "2026-01-07", value: 60 },
    { week: "2026-01-03", value: 19 },
    { week: "2026-01-01", value: 20 },
    { week: "2026-01-06", value: 18 },
    { week: "2026-01-04", value: 21 },
    { week: "2026-01-02", value: 22 },
    { week: "2026-01-05", value: 20 },
  ];
  const a = detectSellerAnomaly("Items sold", scrambled);
  assertEquals(a?.week, "2026-01-07", "the latest week was not identified by date");
  assertEquals(a?.value, 60);
});

Deno.test("AC2: the latest week is excluded from its own baseline", () => {
  // Including it would let a big week inflate the spread it is measured against.
  // Same data, and the baseline must describe the SIX prior weeks only.
  const a = detectSellerAnomaly("Items sold", weeks(20, 22, 19, 21, 20, 18, 60));
  assertEquals(a!.baseline.weeks, 6);
  assertEquals(Math.round(a!.baseline.mean * 10) / 10, 20);
});

Deno.test("AC3: too little history does not fire, however extreme", () => {
  // Five prior weeks plus the spike. The number is absurd and the answer is
  // still 'we do not know this seller yet'.
  assertEquals(detectSellerAnomaly("Items sold", weeks(20, 22, 19, 21, 20, 500)), null);
});

Deno.test("AC3: the seller with three sales and a 100% swing is not paged", () => {
  // The case AC3 names. Doubling from 3 to 6 is a huge sigma against a tight
  // baseline, and it is noise.
  const a = detectSellerAnomaly("Items sold", weeks(3, 2, 4, 3, 2, 3, 6));
  assertEquals(a, null, "a seller below the activity floor was flagged");
});

Deno.test("AC3: the floor is on the BASELINE, so a collapse to zero still fires", () => {
  // The decision worth reading twice. If the floor were applied to the LATEST
  // week, a seller whose activity fell off a cliff would be silenced by the
  // cliff — losing the one event most worth telling them about.
  const a = detectSellerAnomaly("Items sold", weeks(30, 28, 32, 29, 31, 30, 0));
  assertEquals(a !== null, true, "a collapse to zero was suppressed by the activity floor");
  assertEquals(a!.direction, "down");
  assertEquals(a!.value, 0);
});

Deno.test("a perfectly flat baseline does not fire on any change", () => {
  // stdDev is 0, so every non-identical week is infinitely unusual. A seller who
  // sold exactly four items for six weeks and then five is not news.
  assertEquals(detectSellerAnomaly("Items sold", weeks(4, 4, 4, 4, 4, 4, 5)), null);
  // ... and not even a large one, because the spread still says nothing.
  assertEquals(detectSellerAnomaly("Items sold", weeks(40, 40, 40, 40, 40, 40, 400)), null);
});

Deno.test("null means 'nothing to say', never a zero-sigma result", () => {
  // The caller must not be able to confuse 'not enough history' with 'a normal
  // week'. Both return null, and neither returns an anomaly the caller has to
  // inspect to discard.
  for (const series of [weeks(1, 2), weeks(3, 2, 4, 3, 2, 3, 6), weeks(4, 4, 4, 4, 4, 4, 4)]) {
    assertEquals(detectSellerAnomaly("Items sold", series), null);
  }
});

Deno.test("each threshold is honoured separately", () => {
  // ⚠ THE FIXTURE HERE IS CALCULATED, NOT GUESSED, and my first attempt was
  // guessed and wrong. The baseline (20,22,19,21,20,18) has mean 20 and
  // population stdDev ~1.29, so 26 is 4.65 sigma — I had written it as a
  // just-under-threshold case and it fired hard. 22.5 is 1.94 sigma: over 1,
  // under 2.5, which is what a threshold case actually needs.
  const borderline = weeks(20, 22, 19, 21, 20, 18, 22.5);
  assertEquals(
    detectSellerAnomaly("Items sold", borderline),
    null,
    "1.94 sigma fired at a 2.5 threshold",
  );
  assertEquals(
    detectSellerAnomaly("Items sold", borderline, { ...D, sigma: 1 }) !== null,
    true,
    "1.94 sigma did not fire at a 1.0 threshold, so sigma is not being read",
  );

  // The two floors, each moved on its own so neither can be carrying the other.
  const smallSeller = weeks(3, 2, 4, 3, 2, 3, 6);
  assertEquals(detectSellerAnomaly("Items sold", smallSeller), null);
  assertEquals(
    detectSellerAnomaly("Items sold", smallSeller, { ...D, minActivity: 1 }) !== null,
    true,
    "lowering minActivity did not let the small seller through",
  );

  const shortHistory = weeks(20, 22, 19, 21, 60);
  assertEquals(detectSellerAnomaly("Items sold", shortHistory), null);
  assertEquals(
    detectSellerAnomaly("Items sold", shortHistory, { ...D, minBaselineWeeks: 4 }) !== null,
    true,
    "lowering minBaselineWeeks did not let the short history through",
  );
});

Deno.test("the default sigma is 2.5, and that is a decision", () => {
  // At 2 sigma roughly one week in twenty is 'unusual' for a seller whose
  // numbers are noise, which across a user base is a weekly email to thousands
  // of people about nothing.
  assertEquals(D.sigma, 2.5);
  assertEquals(D.minBaselineWeeks, 6);
  assertEquals(D.minActivity, 5);
});

Deno.test("describeAnomaly says what happened without jargon or a verdict", () => {
  const a = detectSellerAnomaly("Items sold", weeks(20, 22, 19, 21, 20, 18, 60))!;
  const text = describeAnomaly(a);
  assertEquals(text.includes("60"), true);
  assertEquals(text.includes("above"), true);
  assertEquals(text.includes("previous 6 weeks"), true);
  // No jargon: the reader should not need to know what a sigma is.
  for (const word of ["sigma", "deviation", "z-score", "variance"]) {
    assertEquals(text.toLowerCase().includes(word), false, `leaked jargon: ${word}`);
  }
  // No verdict: a spike in returns and a spike in sales are the same shape and
  // opposite news, so the sentence must not call either good or bad.
  for (const word of ["good", "bad", "great", "worse", "problem", "congrat"]) {
    assertEquals(text.toLowerCase().includes(word), false, `leaked a verdict: ${word}`);
  }
});

Deno.test("a whole number stays whole, a fraction keeps two places", () => {
  const whole = describeAnomaly(
    detectSellerAnomaly("Items sold", weeks(20, 22, 19, 21, 20, 18, 60))!,
  );
  assertEquals(whole.includes("60 in the week"), true, `got: ${whole}`);

  // ⚠ ALSO A CALCULATED FIXTURE. My first fractional series ran around 2.0,
  // which is below minActivity, so the detector correctly refused and the test
  // then dereferenced null. The floor applies to every metric, including the
  // ones whose natural units are small — a rate near 2 is not exempt from it
  // just because 2 is a normal-looking rate.
  const frac = describeAnomaly(
    detectSellerAnomaly("Items sold", weeks(20, 22, 19, 21, 20, 18, 26.25))!,
  );
  assertEquals(frac.includes("26.25"), true, `got: ${frac}`);
});
