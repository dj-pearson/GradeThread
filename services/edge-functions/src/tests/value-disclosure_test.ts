// US-2850: the wording is the deliverable, so the wording is what gets asserted.
//
// These are not string-formatting tests. Each one pins a claim the product is
// not allowed to make, and every one of them had already been made in shipped
// copy before this story.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  classifySlope,
  describeValueBasis,
  FLAT_SLOPE_FLOOR_CENTS,
  money,
} from "../lib/value-disclosure.ts";

const MEASURED = {
  source: "measured_curve" as const,
  sufficient: true,
  sampleSize: 14,
  medianCents: 6000,
  slopeCentsPerPoint: 900,
  measuredAt: "2026-08-24T00:00:00.000Z",
};

function words(b: { headline: string; detail: string }): string {
  return `${b.headline} ${b.detail}`.toLowerCase();
}

// ── the two claims we may not make ──────────────────────────────────

Deno.test("nothing CLAIMS sold unless the prices really are sold", () => {
  // The ban is on the affirmative claim, not the word. "not what anything sold
  // for" is the sentence doing the work, and it necessarily contains "sold".
  // Drop the denial sentence first. It is the sentence doing the work and it
  // necessarily contains the word, so matching on it would fail the copy for
  // being correct.
  const withoutDenial = (s: string) => s.replace("not what anything sold for", "");
  const claims = [
    /\bsold for\b/,
    /\bcomparable sales\b/,
    /\brecent sales\b/,
    /\bcompleted sales\b/,
    /\bsold comps\b/,
    /\bthese items actually sold\b/,
  ];
  for (
    const input of [
      MEASURED,
      { ...MEASURED, source: "comp_median" as const },
      { ...MEASURED, sufficient: false },
      { ...MEASURED, slopeCentsPerPoint: 0 },
      { ...MEASURED, slopeCentsPerPoint: -900 },
    ]
  ) {
    const said = withoutDenial(words(describeValueBasis(input)));
    for (const re of claims) {
      assert(!re.test(said), `claimed sold prices without them (${re}): ${said}`);
    }
  }
});

Deno.test("the asking-price disclaimer is present on every priced answer", () => {
  // AC1. Not "may be present": every surface renders this string verbatim, so
  // if it ever stops being emitted the disclosure silently disappears.
  for (
    const input of [MEASURED, { ...MEASURED, source: "comp_median" as const }]
  ) {
    const said = words(describeValueBasis(input));
    assert(said.includes("asking right now"), said);
    assert(said.includes("not what anything sold for"), said);
  }
});

Deno.test("with sold prices it says so, and only then", () => {
  const sold = describeValueBasis({ ...MEASURED, source: "comp_median", soldPrices: true });
  assert(words(sold).includes("sold for"));
  const asking = describeValueBasis({ ...MEASURED, source: "comp_median" });
  assert(words(asking).includes("asking"));
});

Deno.test("a comp read is never called a grade", () => {
  for (
    const input of [
      MEASURED,
      { ...MEASURED, source: "comp_median" as const },
      { ...MEASURED, slopeCentsPerPoint: 5 },
      { ...MEASURED, slopeCentsPerPoint: -5000 },
      { ...MEASURED, sufficient: false },
    ]
  ) {
    const said = words(describeValueBasis(input));
    for (const banned of ["graded listing", "graded comp", "we graded", "graded item"]) {
      assert(!said.includes(banned), `called a comp read a grade: ${said}`);
    }
  }
});

// ── sample size ─────────────────────────────────────────────────────

Deno.test("the sample size is always stated, and pluralised", () => {
  assert(describeValueBasis(MEASURED).headline.includes("14 listings"));
  assert(describeValueBasis({ ...MEASURED, sampleSize: 1 }).headline.includes("1 listing "));
  const median = describeValueBasis({ ...MEASURED, source: "comp_median", sampleSize: 22 });
  assert(median.headline.includes("22 listings"));
});

// ── the measured case ───────────────────────────────────────────────

Deno.test("a real slope is quoted in money per grade point", () => {
  const b = describeValueBasis(MEASURED);
  assertEquals(b.slopeShape, "rises_with_condition");
  assert(b.detail.includes("$9"), b.detail);
  assert(b.detail.includes("grade point"), b.detail);
});

Deno.test("a flat slope is said in plain words, not dressed up", () => {
  const b = describeValueBasis({ ...MEASURED, slopeCentsPerPoint: 30 });
  assertEquals(b.slopeShape, "flat");
  assert(b.detail.includes("barely moves the price"), b.detail);
  // And it must not also quote a per-point figure, which would contradict it.
  assert(!b.detail.includes("grade point is worth"), b.detail);
});

Deno.test("a negative slope is reported, not suppressed for being unflattering", () => {
  const b = describeValueBasis({ ...MEASURED, slopeCentsPerPoint: -1500 });
  assertEquals(b.slopeShape, "falls_with_condition");
  assert(b.detail.includes("ask less"), b.detail);
});

Deno.test("flat is judged against the item's own price, with a floor", () => {
  // 2% of a $600 item is $12, so a $5/point slope on it is noise.
  assertEquals(classifySlope(500, 60000), "flat");
  // The same $5/point on a $20 item is a quarter of its value per point.
  assertEquals(classifySlope(500, 2000), "rises_with_condition");
  // The floor stops a near-free item being called sloped over rounding.
  assertEquals(classifySlope(FLAT_SLOPE_FLOOR_CENTS - 1, 100), "flat");
  assertEquals(classifySlope(null, 6000), null);
});

// ── the fallback case ───────────────────────────────────────────────

Deno.test("no measured curve means the median is labelled unadjusted", () => {
  const b = describeValueBasis({ ...MEASURED, source: "comp_median" });
  assertEquals(b.source, "comp_median");
  assert(b.headline.toLowerCase().includes("unadjusted"), b.headline);
  assert(b.detail.includes("not adjusted for condition"), b.detail);
  // AC2: never a fabricated slope on a cell that has no curve.
  assertEquals(b.slopeCentsPerPoint, null);
  assertEquals(b.slopeShape, null);
});

Deno.test("a comp median never claims a slope even when handed one", () => {
  const b = describeValueBasis({
    ...MEASURED,
    source: "comp_median",
    slopeCentsPerPoint: 5000,
  });
  assertEquals(b.slopeCentsPerPoint, null);
  assert(!b.detail.includes("grade point"), b.detail);
});

Deno.test("insufficient says so and refuses to price", () => {
  const b = describeValueBasis({ ...MEASURED, sufficient: false });
  assert(b.headline.includes("Not enough listings"), b.headline);
  assert(b.detail.includes("not going to invent one"), b.detail);
});

// ── money ───────────────────────────────────────────────────────────

Deno.test("money is whole dollars above ten, and never negative-signed", () => {
  assertEquals(money(1200), "$12");
  assertEquals(money(-1200), "$12");
  assertEquals(money(450), "$4.50");
  assertEquals(money(1200, "GBP"), "£12");
  assertEquals(money(1200, "SEK"), "12 SEK");
});
