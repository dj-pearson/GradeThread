// US-1691: unit tests for the grading half of the "State of Secondhand
// Condition" report — average grade by garment type + most common flaws.
//
// buildSecondhandConditionStats is pure. secondhand-condition.ts imports the
// service-role supabase client at load, so set dummy env BEFORE the dynamic
// import (mirrors resale-condition_test.ts).
//
//   deno test --allow-env src/tests/secondhand-condition_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildSecondhandConditionStats, flawTypesForItem, SECONDHAND_MIN_SAMPLE } =
  await import("../lib/secondhand-condition.ts");

type Row = Parameters<typeof buildSecondhandConditionStats>[0][number];

function row(p: Partial<Row>): Row {
  return { garment_type: "tops", overall_score: 8, defects_found: [], ...p };
}

function defects(...types: string[]): unknown {
  return types.map((t) => ({ defect_type: t, severity: "minor" }));
}

function repeat(n: number, p: Partial<Row>): Row[] {
  return Array.from({ length: n }, () => row(p));
}

Deno.test("flawTypesForItem dedupes per item and coerces unknown types", () => {
  assertEquals(flawTypesForItem(defects("stain", "stain", "pilling")).sort(), [
    "pilling",
    "stain",
  ]);
  // An off-taxonomy string folds to `other` rather than being dropped.
  assertEquals(flawTypesForItem(defects("moth_damage")), ["other"]);
  assertEquals(flawTypesForItem(null), []);
  assertEquals(flawTypesForItem("not an array"), []);
});

Deno.test("a thin garment type publishes its count but no mean", () => {
  const stats = buildSecondhandConditionStats(
    repeat(SECONDHAND_MIN_SAMPLE - 1, { garment_type: "tops", overall_score: 7 }),
  );
  const tops = stats.by_garment_type.find((t) => t.key === "tops")!;
  assertEquals(tops.graded_items, SECONDHAND_MIN_SAMPLE - 1);
  assertEquals(tops.average_grade, null);
  assertEquals(tops.flaw_rate, null);
  assertEquals(tops.most_common_flaw, null);
  // Platform-wide is thin too, so no headline mean either.
  assertEquals(stats.average_grade, null);
});

Deno.test("a sufficient garment type publishes a 1dp mean and flaw rate", () => {
  const rows = [
    ...repeat(20, { garment_type: "outerwear", overall_score: 9, defects_found: defects("pilling") }),
    ...repeat(10, { garment_type: "outerwear", overall_score: 8, defects_found: [] }),
  ];
  const stats = buildSecondhandConditionStats(rows);
  const outer = stats.by_garment_type.find((t) => t.key === "outerwear")!;
  assertEquals(outer.graded_items, 30);
  // (20×9 + 10×8) / 30 = 8.666… → 8.7
  assertEquals(outer.average_grade, 8.7);
  assertEquals(outer.flaw_rate, roundedShare(20, 30));
  assertEquals(outer.most_common_flaw?.defect_type, "pilling");
  assertEquals(outer.most_common_flaw?.label, "Pilling");
  assertEquals(outer.most_common_flaw?.items, 20);
});

function roundedShare(items: number, n: number): number {
  return Math.round((items / n) * 10_000) / 10_000;
}

Deno.test("common flaws rank by the number of ITEMS, not defect count", () => {
  const rows = [
    // 30 garments each with THREE stains — must count as 30 items, not 90.
    ...repeat(30, { garment_type: "tops", defects_found: defects("stain", "stain", "stain") }),
    ...repeat(12, { garment_type: "tops", defects_found: defects("pilling") }),
  ];
  const stats = buildSecondhandConditionStats(rows);
  assertEquals(stats.common_flaws[0]?.defect_type, "stain");
  assertEquals(stats.common_flaws[0]?.items, 30);
  assertEquals(stats.common_flaws[1]?.defect_type, "pilling");
  assertEquals(stats.common_flaws[1]?.items, 12);
  assertEquals(stats.sample.graded_items, 42);
  assertEquals(stats.sample.items_with_flaws, 42);
  // One (item, type) pair per garment after dedupe.
  assertEquals(stats.sample.flaw_observations, 42);
});

Deno.test("`other` never becomes a garment type's headline flaw", () => {
  const rows = [
    ...repeat(30, { garment_type: "bottoms", defects_found: defects("moth_damage") }),
    ...repeat(5, { garment_type: "bottoms", defects_found: defects("fading") }),
  ];
  const stats = buildSecondhandConditionStats(rows);
  const bottoms = stats.by_garment_type.find((t) => t.key === "bottoms")!;
  assertEquals(bottoms.most_common_flaw?.defect_type, "fading");
  // It is still reported in the full list — withheld from the headline, not hidden.
  assert(stats.common_flaws.some((f) => f.defect_type === "other"));
});

Deno.test("rows with no usable grade or an off-enum type never inflate a cohort", () => {
  const rows = [
    ...repeat(30, { garment_type: "tops", overall_score: 7 }),
    ...repeat(5, { garment_type: "tops", overall_score: null }),
    ...repeat(5, { garment_type: "tops", overall_score: Number.NaN }),
    ...repeat(4, { garment_type: "spacesuit", overall_score: 2 }),
    ...repeat(4, { garment_type: null, overall_score: 2 }),
  ];
  const stats = buildSecondhandConditionStats(rows);
  const tops = stats.by_garment_type.find((t) => t.key === "tops")!;
  assertEquals(tops.graded_items, 30);
  assertEquals(tops.average_grade, 7);
  // The 8 untypeable-but-real grades still count platform-wide.
  assertEquals(stats.sample.graded_items, 38);
  // …and no junk row appears as a garment type.
  assertEquals(stats.by_garment_type.length, 6);
  assert(!stats.by_garment_type.some((t) => t.key === "spacesuit"));
});

Deno.test("empty input yields a fully null, publishable-as-pending report", () => {
  const stats = buildSecondhandConditionStats([]);
  assertEquals(stats.average_grade, null);
  assertEquals(stats.common_flaws, []);
  assertEquals(stats.sample.graded_items, 0);
  assert(stats.by_garment_type.every((t) => t.average_grade === null && t.graded_items === 0));
});
