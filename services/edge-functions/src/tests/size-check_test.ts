// US-2916: the size checker's math, and the two cases that define it.
//
// THE MOTIVATING CASE. A Lululemon men's top measuring 17.5 in pit to pit,
// labelled Large. Lululemon's own men's chart puts a Large at a 41-43 in body
// chest, which is a 22-26.5 in flat garment. 17.5 is below the smallest size the
// brand makes, so the check must fire and say so.
//
// THE NO-FALSE-ALARM CASE. An ordinary men's tee measuring 22 in pit to pit,
// labelled L, with no brand chart on file. The generic chart's Large is exactly
// 22-26.5 in flat, so the check must stay quiet. This case is the one that keeps
// the feature usable: a checker that cries wolf on correctly sized items gets
// switched off, and then it catches nothing at all.
//
// These same two fixtures are re-run by src/lib/size-check.test.ts (web),
// ios/GradeThreadTests/SizeCheckTests.swift and
// android/app/src/test/java/com/gradethread/app/inventory/SizeCheckTest.kt,
// so the four copies cannot drift apart. src/test/size-check-fixture-parity.test.ts
// fails if any of them stops carrying the numbers.
//
//   deno test --allow-env --allow-read src/tests/size-check_test.ts

import { assert, assertEquals } from "@std/assert";

const { SIZING_CHARTS, findSizingCharts } = await import("../lib/sizing-charts.ts");
const {
  buildSizeBands,
  checkSize,
  parseChartValue,
  resolveSizeRow,
  toleranceFor,
} = await import("../lib/size-check.ts");

const chartFor = (brand: string, department: string, garmentWord: string) => {
  const found = findSizingCharts(brand, garmentWord).find(
    (c) => c.department === department,
  );
  assert(found, `no ${department} ${garmentWord} chart for ${brand || "generic"}`);
  return found;
};

// ── The motivating case ─────────────────────────────────────────────────────

Deno.test("Lululemon men's top: 17.5 in flat chest labelled Large fires", () => {
  const chart = chartFor("Lululemon", "Men", "tee");
  const bands = buildSizeBands(chart, "top");

  // Sanity on the conversion itself before judging anything with it.
  assertEquals(bands[0]?.size, "XS");
  assertEquals(bands[0]?.bands.chest, [18, 22.5]); // (33+3)/2 .. (35+10)/2
  assertEquals(bands[3]?.size, "L");
  assertEquals(bands[3]?.bands.chest, [22, 26.5]); // (41+3)/2 .. (43+10)/2

  const rowIndex = resolveSizeRow(bands, "Large");
  assertEquals(rowIndex, 3);

  const verdict = checkSize({
    bands,
    rowIndex,
    measurements: { chest: 17.5 },
    tier: "brand",
  });
  assertEquals(verdict.status, "off");
  assert(verdict.stepsOff >= 2, `stepsOff was ${verdict.stepsOff}`);
  assertEquals(verdict.impliedSize, "smaller than XS");
  assertEquals(verdict.key, "chest");
  assertEquals(verdict.expected, [22, 26.5]);
});

// ── The no-false-alarm case ─────────────────────────────────────────────────

Deno.test("generic men's tee: 22 in flat chest labelled L stays quiet", () => {
  const chart = chartFor("", "Men", "tee");
  assertEquals(chart.brandMatch.length, 0, "must be the generic fallback chart");
  const bands = buildSizeBands(chart, "top");

  const rowIndex = resolveSizeRow(bands, "L");
  assert(rowIndex !== null);
  assertEquals(bands[rowIndex]?.bands.chest, [22, 26.5]);

  const verdict = checkSize({
    bands,
    rowIndex,
    measurements: { chest: 22 },
    tier: "generic",
  });
  assertEquals(verdict.status, "ok");
  assertEquals(verdict.stepsOff, 0);
});

// ── Basis ───────────────────────────────────────────────────────────────────

Deno.test("basis 'flat' uses chart values directly, no ease", () => {
  const chart = {
    rows: [
      { size: "S", measurements: { chest: "19-20" } },
      { size: "M", measurements: { chest: "21-22" } },
    ],
  };
  assertEquals(buildSizeBands(chart, "top", "flat")[0]?.bands.chest, [19, 20]);
  // The same chart read as body measurements is a very different garment.
  assertEquals(buildSizeBands(chart, "top", "body")[0]?.bands.chest, [11, 15]);
});

Deno.test("outerwear takes more ease than a top", () => {
  const chart = { rows: [{ size: "M", measurements: { chest: "38-40" } }] };
  assertEquals(buildSizeBands(chart, "top")[0]?.bands.chest, [20.5, 25]);
  assertEquals(buildSizeBands(chart, "outerwear")[0]?.bands.chest, [22, 28]);
});

Deno.test("inseam compares directly: no halving, no ease", () => {
  const chart = { rows: [{ size: "32", measurements: { inseam: "32" } }] };
  assertEquals(buildSizeBands(chart, "bottom")[0]?.bands.inseam, [32, 32]);
});

// ── Parsing ─────────────────────────────────────────────────────────────────

Deno.test("chart values parse as ranges and singletons; junk is skipped", () => {
  assertEquals(parseChartValue("34-36"), [34, 36]);
  assertEquals(parseChartValue("31"), [31, 31]);
  assertEquals(parseChartValue("30.5"), [30.5, 30.5]);
  assertEquals(parseChartValue("one size"), null);
  assertEquals(parseChartValue(""), null);
  assertEquals(parseChartValue(undefined), null);
  // Never coerced to zero — a phantom zero band would sit below every real
  // size and make correctly sized items look enormous.
  assertEquals(parseChartValue("n/a"), null);
});

Deno.test("Sweaty Betty's 'us' cross-reference key is not read as a measurement", () => {
  const chart = chartFor("Sweaty Betty", "Women", "legging");
  const hasUs = chart.rows.some((r) => "us" in r.measurements);
  assert(hasUs, "fixture drifted: the Sweaty Betty chart no longer carries 'us'");
  for (const row of buildSizeBands(chart, "bottom")) {
    assert(!("us" in row.bands), `row ${row.size} built a band from the 'us' key`);
  }
  // The real keys still built bands, so the skip is a skip and not a wipeout.
  assert(buildSizeBands(chart, "bottom")[0]?.bands.waist);
});

// ── Label matching ──────────────────────────────────────────────────────────

Deno.test("size labels resolve across the spellings sellers actually use", () => {
  const alpha = buildSizeBands(
    {
      rows: [
        { size: "XS", measurements: { chest: "33-35" } },
        { size: "S", measurements: { chest: "35-37" } },
        { size: "M", measurements: { chest: "38-40" } },
        { size: "L", measurements: { chest: "41-43" } },
        { size: "XXL", measurements: { chest: "47-49" } },
      ],
    },
    "top",
  );
  assertEquals(resolveSizeRow(alpha, "Large"), 3);
  assertEquals(resolveSizeRow(alpha, "l"), 3);
  assertEquals(resolveSizeRow(alpha, "  L  "), 3);
  assertEquals(resolveSizeRow(alpha, "2XL"), 4);
  assertEquals(resolveSizeRow(alpha, "XXL"), 4);
  assertEquals(resolveSizeRow(alpha, "extra small"), 0);
  // No match is null, never index 0.
  assertEquals(resolveSizeRow(alpha, "42R"), null);
  assertEquals(resolveSizeRow(alpha, ""), null);
  assertEquals(resolveSizeRow(alpha, null), null);

  const numeric = buildSizeBands(
    { rows: [{ size: "6", measurements: { bust: "34.5-35.5" } }, { size: "8", measurements: { bust: "36-37" } }] },
    "top",
  );
  assertEquals(resolveSizeRow(numeric, "8"), 1);
  assertEquals(resolveSizeRow(numeric, "08"), 1);

  const compound = buildSizeBands(
    {
      rows: [
        { size: "UK 10 / S", measurements: { waist: "27" } },
        { size: "UK 12 / M", measurements: { waist: "29" } },
      ],
    },
    "bottom",
  );
  assertEquals(resolveSizeRow(compound, "M"), 1);
  assertEquals(resolveSizeRow(compound, "UK 12"), 1);
  // A bare 12 is not a UK 12: the corpus warns that assuming so is the costliest
  // error on these brands, so it must not match.
  assertEquals(resolveSizeRow(compound, "12"), null);
});

// ── Tolerance and verdict shape ─────────────────────────────────────────────

Deno.test("tolerance is one step on a real chart and two on a generic one", () => {
  assertEquals(toleranceFor("verified"), 1);
  assertEquals(toleranceFor("brand"), 1);
  assertEquals(toleranceFor("generic"), 2);

  const bands = buildSizeBands(
    {
      rows: [
        { size: "S", measurements: { chest: "35-37" } },
        { size: "M", measurements: { chest: "38-40" } },
        { size: "L", measurements: { chest: "41-43" } },
        { size: "XL", measurements: { chest: "44-46" } },
      ],
    },
    "top",
  );
  // S band is [19, 23.5]; a 19 in flat chest labelled L is two rows down.
  const oneStep = { bands, rowIndex: 2, measurements: { chest: 19 }, tier: "brand" as const };
  assertEquals(checkSize(oneStep).stepsOff, 2);
  assertEquals(checkSize(oneStep).status, "off");
  assertEquals(checkSize({ ...oneStep, tier: "generic" }).status, "off");

  // M band is [20.5, 25]; a 20.5 labelled L is exactly one row down, which a
  // generic chart is not confident enough to call.
  const borderline = { bands, rowIndex: 2, measurements: { chest: 20.5 }, tier: "brand" as const };
  assertEquals(checkSize(borderline).stepsOff, 1);
  assertEquals(checkSize(borderline).status, "off");
  assertEquals(checkSize({ ...borderline, tier: "generic" }).status, "ok");
});

Deno.test("above the largest band names that edge, not 'unknown'", () => {
  const bands = buildSizeBands(
    { rows: [{ size: "S", measurements: { chest: "35-37" } }, { size: "M", measurements: { chest: "38-40" } }] },
    "top",
  );
  const v = checkSize({ bands, rowIndex: 0, measurements: { chest: 40 }, tier: "brand" });
  assertEquals(v.status, "off");
  assertEquals(v.impliedSize, "larger than M");
});

Deno.test("the key with the largest disagreement drives the note", () => {
  const bands = buildSizeBands(
    {
      rows: [
        { size: "XS", measurements: { waist: "25", hip: "35" } },
        { size: "S", measurements: { waist: "27", hip: "37" } },
        { size: "M", measurements: { waist: "29", hip: "39" } },
        { size: "L", measurements: { waist: "31", hip: "41" } },
      ],
    },
    "bottom",
  );
  // Waist bands: XS [13, 15], S [14, 16], M [15, 17], L [16, 18].
  // Hip bands:   XS [18.5, 21.5], S [19.5, 22.5], M [20.5, 23.5], L [21.5, 24.5].
  // Labelled L, waist reads XS-small while the hip is only one row off.
  const v = checkSize({
    bands,
    rowIndex: 3,
    measurements: { waist: 13.5, hip: 21 },
    tier: "brand",
  });
  assertEquals(v.key, "waist");
  assertEquals(v.status, "off");
  assert(v.stepsOff >= 2);
});

Deno.test("unknown when the size cannot be placed or nothing can be compared", () => {
  const bands = buildSizeBands({ rows: [{ size: "M", measurements: { chest: "38-40" } }] }, "top");
  assertEquals(checkSize({ bands, rowIndex: null, measurements: { chest: 21 }, tier: "brand" }).status, "unknown");
  assertEquals(checkSize({ bands, rowIndex: 0, measurements: {}, tier: "brand" }).status, "unknown");
  assertEquals(checkSize({ bands, rowIndex: 0, measurements: { chest: 21 }, tier: "none" }).status, "unknown");
  assertEquals(checkSize({ bands: [], rowIndex: 0, measurements: { chest: 21 }, tier: "brand" }).status, "unknown");
  // A group with no body dimension builds no bands at all.
  const watch = buildSizeBands({ rows: [{ size: "M", measurements: { chest: "38-40" } }] }, "watch");
  assertEquals(checkSize({ bands: watch, rowIndex: 0, measurements: { chest: 21 }, tier: "brand" }).status, "unknown");
});

Deno.test("the module is pure: no network, env or model import", async () => {
  const src = await Deno.readTextFile(new URL("../lib/size-check.ts", import.meta.url));
  for (const banned of ["fetch(", "Deno.env", "anthropic", "createClient"]) {
    assert(!src.includes(banned), `size-check.ts must not reference ${banned}`);
  }
  assertEquals(SIZING_CHARTS.length > 0, true);
});
