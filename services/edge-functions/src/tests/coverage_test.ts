import { assert, assertEquals } from "@std/assert";
import {
  computeCoverage,
  inspectionTemplate,
  type CoverageImageSignal,
} from "../lib/coverage.ts";

// A fully-documented submission: front + back + label + a close-up detail.
const FULL: CoverageImageSignal[] = [
  { image_type: "front" },
  { image_type: "back" },
  { image_type: "label" },
  { image_type: "detail" },
];

Deno.test("fully-documented set reaches ~100% coverage", () => {
  const r = computeCoverage("t-shirt", FULL);
  assertEquals(r.coverage_pct, 100);
  assertEquals(r.missing_zones, []);
  // Every applicable zone is covered.
  assertEquals(
    r.covered_zones.sort(),
    r.applicable_zones.slice().sort(),
  );
});

Deno.test("front-only set scores low", () => {
  const r = computeCoverage("t-shirt", [{ image_type: "front" }]);
  // Only the front zone is documented by a lone front shot.
  assertEquals(r.covered_zones, ["front"]);
  assert(r.missing_zones.length > 0);
  assert(r.coverage_pct < 30, `expected low coverage, got ${r.coverage_pct}`);
});

Deno.test("legitimately-absent zones are excluded from the denominator, not counted missing", () => {
  // A scarf has no pockets / closure / cuffs — those must not appear at all.
  const template = inspectionTemplate("scarf").map((z) => z.id);
  assertEquals(template, ["front", "back", "branding"]);

  const r = computeCoverage("scarf", FULL);
  for (const absent of ["pockets", "closure", "cuffs", "collar_neckline"]) {
    assert(
      !r.applicable_zones.includes(absent),
      `${absent} should not be applicable to a scarf`,
    );
    assert(
      !r.missing_zones.includes(absent),
      `${absent} should not be counted missing on a scarf`,
    );
  }
  // front + back + label(=branding) document every scarf zone.
  assertEquals(r.coverage_pct, 100);
  assertEquals(r.missing_zones, []);
});

Deno.test("a category with absent zones is graded over the smaller denominator", () => {
  // A skirt legitimately has no inseam/crotch and (here) no pockets.
  const skirt = inspectionTemplate("skirt").map((z) => z.id);
  assert(!skirt.includes("inseam_crotch"));
  assert(!skirt.includes("pockets"));

  // front + label only: covers front + branding of 6 zones → not penalized for
  // the inapplicable inseam/pocket zones.
  const r = computeCoverage("skirt", [
    { image_type: "front" },
    { image_type: "label" },
  ]);
  assertEquals(r.applicable_zones.length, 6);
  assertEquals(r.covered_zones.sort(), ["branding", "front"]);
  assertEquals(r.coverage_pct, Math.round((2 / 6) * 100));
});

Deno.test("vision zone hints credit a zone even from a generic view", () => {
  // A front shot whose detected issue is on the hem credits the hem zone,
  // because the per-image vision hint names it.
  const r = computeCoverage("jeans", [
    { image_type: "front", zone_hints: ["frayed hem at left leg"] },
  ]);
  assert(r.covered_zones.includes("front"));
  assert(r.covered_zones.includes("hem"));
});

Deno.test("hints only credit zones the garment actually has", () => {
  // "buckle" maps to hardware, but a t-shirt has no hardware zone, so the hint
  // is ignored rather than inflating coverage.
  const r = computeCoverage("t-shirt", [
    { image_type: "front", zone_hints: ["decorative buckle"] },
  ]);
  assert(!r.applicable_zones.includes("hardware"));
  assert(!r.covered_zones.includes("hardware"));
});

Deno.test("unknown garment category falls back to a minimal template", () => {
  const r = computeCoverage("nonsense-category", FULL);
  assertEquals(r.applicable_zones, ["front", "back", "branding"]);
});

Deno.test("empty submission covers nothing", () => {
  const r = computeCoverage("jeans", []);
  assertEquals(r.covered_zones, []);
  assertEquals(r.coverage_pct, 0);
  assertEquals(r.missing_zones, r.applicable_zones);
});
