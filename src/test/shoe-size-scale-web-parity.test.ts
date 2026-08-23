import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SHOE_SIZE_SCALE_ATTRIBUTE,
  SHOE_SIZE_SCALES,
  statedShoeSizeScale,
} from "@/lib/shoe-size-scale";
import { resolveMeasurementAspects } from "@/lib/measurements";

// US-2796 AC3 on the WEB, and why the web needed it at all.
//
// The edge's resolveMeasurementAspects only fills aspects that are still BLANK.
// So anything the composer prefills arrives at publish as an EXISTING value and
// is never corrected — a UK 9 the web put into "US Shoe Size" reaches the live
// listing even though the edge's own publish path would have refused it. Fixing
// the edge alone left that hole open, which is what this closes.
//
// ⚠ THE WEB MIRRORS ONLY THE STATED HALF, deliberately. The edge also infers a
// scale from the brand's curated sizing charts; `sizing-charts.ts` and
// `size-systems.ts` are edge-only, and copying 26 brands' footwear charts into
// the bundle would create a second definition of a large table that nothing
// compares. The residual gap is stated in the module and here: an item whose
// scale is only INFERABLE (a Dr. Martens with nothing recorded) still gets its
// number into "US Shoe Size" on this path. That is unchanged from before, so it
// is a gap rather than a regression, and it shrinks as the capture pass records
// the scale off the size stamp.

const EDGE = resolve(process.cwd(), "services/edge-functions/src/lib/shoe-size-scale.ts");

/**
 * The CODE of a named function: body bounded by the closing brace at column 0,
 * with comments and line endings normalised away.
 *
 * Comments are stripped because the two copies legitimately carry different
 * commentary — the edge one records the [s-] regex bug it shipped with for a few
 * minutes, which has no business on the web side. A parity check that compared
 * prose would forbid either file from explaining itself, and would fail against
 * two correct implementations. The contract is that the LOGIC matches.
 */
function functionCode(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}(`);
  expect(start, `${name} is gone`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  expect(end, `${name} has no closing brace`).toBeGreaterThan(start);
  return src
    .slice(start, end + 2)
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

describe("US-2796: the web's stated-scale parser matches the edge's", () => {
  it("parses the same tokens the edge does", () => {
    // Behavioural first, because the source check below can only prove sameness,
    // not correctness — two identical wrong copies would pass it.
    for (const scale of SHOE_SIZE_SCALES) {
      expect(statedShoeSizeScale({ [SHOE_SIZE_SCALE_ATTRIBUTE]: scale })).toBe(scale);
    }
    for (const v of ["us_women", "US_WOMEN", " us women ", "US-Women"]) {
      expect(statedShoeSizeScale({ [SHOE_SIZE_SCALE_ATTRIBUTE]: v }), v).toBe("us_women");
    }
    expect(statedShoeSizeScale({ [SHOE_SIZE_SCALE_ATTRIBUTE]: ["eu", "uk"] })).toBe("eu");
    for (const junk of ["", "   ", "mens", "US Mens", "42", "true"]) {
      expect(statedShoeSizeScale({ [SHOE_SIZE_SCALE_ATTRIBUTE]: junk }), junk).toBeNull();
    }
    expect(statedShoeSizeScale(null)).toBeNull();
    expect(statedShoeSizeScale(undefined)).toBeNull();
  });

  it("is the SAME implementation as the edge, not a lookalike", () => {
    // Same pattern measurement-aspect-coverage.test.ts uses for the web/edge
    // MEASUREMENT_SPECS blocks. A behavioural test cannot catch a divergence in
    // a case neither test happens to try; comparing the source can.
    const edge = readFileSync(EDGE, "utf8");
    const web = readFileSync(resolve(process.cwd(), "src/lib/shoe-size-scale.ts"), "utf8");
    expect(functionCode(web, "statedShoeSizeScale")).toEqual(
      functionCode(edge, "statedShoeSizeScale"),
    );
  });

  it("usableCandidates is mirrored too, which is the gap that caused this", () => {
    // THE SAME MISTAKE ONE LEVEL DOWN, and it is why this case exists rather
    // than only the one above. US-2813 records that the web and edge
    // measurements.ts are mirrors and that nothing compared them until it added
    // a check — but that check covers MEASUREMENT_SPECS, the DATA. The resolver
    // was never compared, which is how the edge grew a five-argument
    // resolveMeasurementAspects and the web kept a four-argument one for an hour
    // while every suite stayed green and a UK size kept reaching live listings.
    //
    // usableCandidates is the rule those two copies now share. Comparing it is
    // cheap and it closes the exact class of gap that produced this file.
    const edge = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/measurements.ts"),
      "utf8",
    );
    const web = readFileSync(resolve(process.cwd(), "src/lib/measurements.ts"), "utf8");
    const code = (src: string) => {
      const start = src.indexOf("function usableCandidates(");
      expect(start, "usableCandidates is gone").toBeGreaterThan(-1);
      const end = src.indexOf("\n}", start);
      return src
        .slice(start, end + 2)
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    };
    expect(code(web)).toEqual(code(edge));
  });

  it("declares the same five scales as the edge, in the same order", () => {
    const edge = readFileSync(EDGE, "utf8");
    const listed = /SHOE_SIZE_SCALES: readonly ShoeSizeScale\[\] = \[([\s\S]*?)\]/.exec(edge);
    expect(listed, "the edge no longer declares SHOE_SIZE_SCALES").not.toBeNull();
    const fromEdge = [...(listed?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    // Order is not cosmetic here: it is the order a reader assumes and the order
    // the extraction prompt lists, so a silent reorder is a drift signal.
    expect([...SHOE_SIZE_SCALES]).toEqual(fromEdge);
  });

  it("the attribute key is the same string on both sides", () => {
    const edge = readFileSync(EDGE, "utf8");
    const key = /SHOE_SIZE_SCALE_ATTRIBUTE = "([a-z_]+)"/.exec(edge);
    expect(key, "the edge no longer declares the attribute key").not.toBeNull();
    // If these ever differ, each side reads a key the other never writes and the
    // feature is silently off — with both test suites green.
    expect(SHOE_SIZE_SCALE_ATTRIBUTE).toBe(key?.[1]);
  });
});

describe("US-2796 AC3: the web prefill refuses a US-named aspect for a non-US size", () => {
  const BOTH = { "US Shoe Size": [], "Shoe Size": [] };

  it("a UK size falls through to the scale-neutral aspect", () => {
    const out = resolveMeasurementAspects({ size_us: 9 }, BOTH, {}, "in", "uk");
    expect(out["US Shoe Size"]).toBeUndefined();
    expect(out["Shoe Size"]).toEqual(["US 9"]);
  });

  it("US scales are untouched, including us_women", () => {
    for (const scale of ["us_men", "us_women"] as const) {
      const out = resolveMeasurementAspects({ size_us: 9 }, BOTH, {}, "in", scale);
      expect(out["US Shoe Size"], scale).toEqual(["US 9"]);
    }
  });

  it("passing no scale is identical to the old four-argument call", () => {
    const legacy = resolveMeasurementAspects({ size_us: 9 }, BOTH, {}, "in");
    expect(resolveMeasurementAspects({ size_us: 9 }, BOTH, {}, "in", null)).toEqual(legacy);
    expect(legacy["US Shoe Size"]).toEqual(["US 9"]);
  });

  it("a bust measurement is not filtered by a shoe rule", () => {
    // "Bust" contains "us". Both guards in usableCandidates are individually
    // inert; this is the case where the pair matters.
    const out = resolveMeasurementAspects({ bust: 20 }, { Bust: [] }, {}, "in", "uk");
    expect(out["Bust"]).toEqual(["40 in"]);
  });

  it("the composer prefill actually passes a scale", () => {
    // A SOURCE SCAN, because this is the one thing the behavioural cases above
    // cannot reach: they call resolveMeasurementAspects directly, so dropping
    // the fifth argument at the ONE call site that matters leaves every one of
    // them green while the fix stops applying to anything a seller sees.
    //
    // Comments stripped first: the call site carries a comment naming
    // statedShoeSizeScale and US-2796, so a raw scan passes against a call that
    // no longer makes it.
    const src = readFileSync(resolve(process.cwd(), "src/lib/ebay-prefill.ts"), "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

    expect(
      /resolveMeasurementAspects\([\s\S]{0,300}?statedShoeSizeScale\(/.test(src),
      "ebay-prefill calls resolveMeasurementAspects without a resolved scale, so " +
        "a UK size goes back to filling 'US Shoe Size' in the composer — and the " +
        "edge only fills BLANK aspects, so that value survives to the live listing.",
    ).toBe(true);
  });
});
