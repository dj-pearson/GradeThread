// US-3044: the fill-rate measurement is pure, so it is pinned here and the
// operator script (scripts/aspect-fill-report.ts) only does the reads.
//
//   deno test --allow-env --allow-read --allow-net src/tests/aspect-fill-report_test.ts
import { assertEquals } from "@std/assert";
import {
  aspectFillStats,
  aspectFillStatsByCategory,
  type FillDraftRow,
  leastMoved,
  renderFillTable,
} from "../lib/aspect-fill-report.ts";

const stat = (rows: FillDraftRow[], aspect: string) =>
  aspectFillStats(rows).find((s) => s.aspect === aspect)!;

Deno.test("filled under any spelling counts once; a blank value is not filled", () => {
  const rows: FillDraftRow[] = [
    {
      platform_category_id: "1",
      item_specifics_override: {
        "Country/Region of Manufacture": ["Vietnam"],
        Theme: [""],
      },
      aspect_coverage: null,
    },
    {
      platform_category_id: "1",
      item_specifics_override: {
        "country of origin": ["Portugal"],
        Theme: ["Sports"],
      },
      aspect_coverage: null,
    },
  ];
  assertEquals(stat(rows, "Country of Origin"), {
    aspect: "Country of Origin",
    filled: 2,
    exposed: 2,
    drafts: 2,
  });
  assertEquals(stat(rows, "Theme"), {
    aspect: "Theme",
    filled: 1,
    exposed: 1,
    drafts: 2,
  });
});

Deno.test("an aspect reported missing is exposed but not filled; an unmentioned one is neither", () => {
  const rows: FillDraftRow[] = [
    {
      platform_category_id: "1",
      item_specifics_override: { Brand: ["Nike"] },
      aspect_coverage: {
        required: { missing: [] },
        recommended: { missing: ["Theme", "Garment Care"] },
      },
    },
    {
      platform_category_id: "1",
      item_specifics_override: { Brand: ["Nike"] },
      aspect_coverage: {
        required: { missing: ["Department"] },
        recommended: { missing: [] },
      },
    },
  ];
  assertEquals(stat(rows, "Theme"), {
    aspect: "Theme",
    filled: 0,
    exposed: 1,
    drafts: 2,
  });
  assertEquals(stat(rows, "Department"), {
    aspect: "Department",
    filled: 0,
    exposed: 1,
    drafts: 2,
  });
  // Character was never filled and never reported missing: exposure unknown.
  assertEquals(stat(rows, "Character"), {
    aspect: "Character",
    filled: 0,
    exposed: 0,
    drafts: 2,
  });
});

Deno.test("per-category tables fold away thin leaves and sort by size", () => {
  const row = (cat: string | null): FillDraftRow => ({
    platform_category_id: cat,
    item_specifics_override: { Theme: ["Sports"] },
    aspect_coverage: null,
  });
  const out = aspectFillStatsByCategory(
    [
      row("A"),
      row("A"),
      row("A"),
      row("B"),
      row("B"),
      row("B"),
      row("B"),
      row("C"),
      row(null),
    ],
    3,
  );
  assertEquals(out.map((c) => [c.categoryId, c.drafts]), [["B", 4], ["A", 3]]);
});

Deno.test("renderFillTable shows both denominators and a dash for zero exposure", () => {
  const table = renderFillTable([
    { aspect: "Theme", filled: 3, exposed: 4, drafts: 10 },
    { aspect: "Character", filled: 0, exposed: 0, drafts: 10 },
  ]);
  assertEquals(table.split("\n")[2], "| Theme | 3/4 | 75% | 30% |");
  assertEquals(table.split("\n")[3], "| Character | 0/0 | - | 0% |");
});

Deno.test("leastMoved names the aspect whose exposed rate changed least, skipping unexposed", () => {
  const before = [
    { aspect: "Theme", filled: 1, exposed: 10, drafts: 10 },
    { aspect: "Model", filled: 2, exposed: 10, drafts: 10 },
    { aspect: "Character", filled: 0, exposed: 0, drafts: 10 },
  ];
  const after = [
    { aspect: "Theme", filled: 8, exposed: 10, drafts: 10 },
    { aspect: "Model", filled: 3, exposed: 10, drafts: 10 },
    { aspect: "Character", filled: 5, exposed: 10, drafts: 10 },
  ];
  assertEquals(leastMoved(before, after), {
    aspect: "Model",
    before: 0.2,
    after: 0.3,
  });
  assertEquals(leastMoved([], after), null);
});
