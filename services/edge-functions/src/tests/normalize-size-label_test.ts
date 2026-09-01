// US-3033: normalizeSizeLabel, the cohort join key for the Fit & Measurement
// Index.
//
// Two failures are possible and they are not symmetric.
//
//   UNDER-MERGING is quiet. If "W34 L32" and "34x32" stay separate, one style in
//   one size becomes two cohorts of half the size, neither clears the sample
//   floor, and the page that should exist simply never appears. Nothing errors
//   and coverage just looks lower than it is.
//
//   OVER-MERGING is worse. If "UK 10" folds into "10", or "10P" into "10", the
//   cohort mixes two different garments and publishes a median that is wrong
//   about both. A wrong number on a public page is the one outcome this whole
//   feature is built to avoid.
//
// So the table below is in two halves: what MUST merge, and what MUST NOT.
//
//   deno test --allow-env --allow-read src/tests/normalize-size-label_test.ts

import { assertEquals, assertNotEquals } from "@std/assert";

const { normalizeSizeLabel } = await import("../lib/size-systems.ts");

// ── What must merge ─────────────────────────────────────────────────────────

const MERGES: readonly (readonly [string, string])[] = [
  // Waist by inseam, every way a seller writes it.
  ["W34 L32", "34X32"],
  ["34x32", "34X32"],
  ["34X32", "34X32"],
  ["34 X 32", "34X32"],
  ["34/32", "34X32"],
  ["34-32", "34X32"],
  ["W34L32", "34X32"],
  ["w34 l32", "34X32"],

  // Waist alone. "W34" and "34" are the same garment.
  ["W34", "34"],
  ["34", "34"],
  ["W 34", "34"],

  // Alpha words and letters.
  ["Small", "S"],
  ["SM", "S"],
  ["S", "S"],
  ["Medium", "M"],
  ["MED", "M"],
  ["M", "M"],
  ["Large", "L"],
  ["LG", "L"],
  ["L", "L"],
  ["X-Large", "XL"],
  ["Extra Large", "XL"],
  ["XL", "XL"],
  ["1X", "XL"],

  // Past XL there are two spellings of one size, and they collapse to the
  // numeric form because nobody counts Xs reliably past three.
  ["XXL", "2XL"],
  ["2XL", "2XL"],
  ["2X", "2XL"],
  ["XXXL", "3XL"],
  ["3XL", "3XL"],
  ["3X", "3XL"],
  ["XXS", "2XS"],
  ["XS", "XS"],
  ["X-Small", "XS"],

  // Decorations that carry no garment meaning.
  ["Size 10", "10"],
  ["SIZE: 10", "10"],
  ["US 10", "10"],
  ["10R", "10"],
  ["  10  ", "10"],
  ["UK 10 (US 6)", "UK 10"],

  // One size, however it is spelled.
  ["One Size", "OS"],
  ["OS", "OS"],
  ["OSFA", "OS"],
  ["One Size Fits All", "OS"],
];

Deno.test("normalizeSizeLabel: labels that mean one garment collapse to one key", () => {
  for (const [raw, expected] of MERGES) {
    assertEquals(
      normalizeSizeLabel(raw),
      expected,
      `${JSON.stringify(raw)} should normalize to ${JSON.stringify(expected)}`,
    );
  }
});

// ── What must NOT merge ─────────────────────────────────────────────────────

const DISTINCT: readonly (readonly [string, string, string])[] = [
  [
    "UK 10",
    "10",
    "a national system is part of the identity, not a decoration",
  ],
  [
    "EU 38",
    "38",
    "a bare number is US here by convention, so EU 38 is a different garment",
  ],
  [
    "IT 48",
    "UK 48",
    "two systems that both print 48 are not the same size",
  ],
  [
    "10P",
    "10",
    "petite is a different cut with different measurements, which is the point of the index",
  ],
  [
    "10T",
    "10",
    "tall is a different cut for the same reason",
  ],
  [
    "10P",
    "10T",
    "petite and tall are not each other either",
  ],
  [
    "34X32",
    "34X30",
    "the inseam is half the garment",
  ],
  [
    "2XL",
    "2XS",
    "the X-run collapse must not lose the S/L end",
  ],
];

Deno.test("normalizeSizeLabel: labels that mean different garments stay apart", () => {
  for (const [a, b, why] of DISTINCT) {
    assertNotEquals(
      normalizeSizeLabel(a),
      normalizeSizeLabel(b),
      `${JSON.stringify(a)} and ${JSON.stringify(b)} must not merge: ${why}`,
    );
  }
});

// ── The unrecognised case ───────────────────────────────────────────────────

Deno.test("normalizeSizeLabel: an unrecognised label is cleaned but never merged", () => {
  // Cleaned: case and whitespace are normalized, so the same odd label written
  // twice still lands in one cohort.
  assertEquals(normalizeSizeLabel("  tall  fit  "), normalizeSizeLabel("TALL FIT"));

  // Never merged: it does not become a size it merely resembles.
  assertNotEquals(normalizeSizeLabel("TALL FIT"), "L");
  assertNotEquals(normalizeSizeLabel("YOUTH 12"), "12");
  assertNotEquals(normalizeSizeLabel("EU"), "");
});

Deno.test("normalizeSizeLabel: empty input is empty output and nothing throws", () => {
  assertEquals(normalizeSizeLabel(""), "");
  assertEquals(normalizeSizeLabel("   "), "");
  assertEquals(normalizeSizeLabel(null), "");
  assertEquals(normalizeSizeLabel(undefined), "");
  assertEquals(normalizeSizeLabel("---"), "");
});

Deno.test("normalizeSizeLabel: the group hint never changes a non-bottom answer", () => {
  // The hint exists for readability at the call site. A function whose output
  // depends on the caller's category in ways the caller cannot predict is worse
  // than one that ignores the hint, so this pins that it does.
  for (const [raw] of MERGES) {
    assertEquals(
      normalizeSizeLabel(raw, "top"),
      normalizeSizeLabel(raw, "bottom"),
      `${JSON.stringify(raw)} must not depend on the group hint`,
    );
  }
});
