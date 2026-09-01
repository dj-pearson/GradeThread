// US-828: reconcile AI-generated / stored aspect maps against the category spec.
// Fixture-tested for the three SELECTION_ONLY outcomes the story calls out —
// valid (pass), normalizable (near-miss repaired via US-823), unmatched (kept +
// flagged at generation / omitted + diagnosed at publish) — plus unknown aspect
// names and free-text pass-through. Pure functions, no env.
//   deno test src/tests/aspect-reconcile_test.ts
import { assertEquals } from "@std/assert";
import {
  coerceNumericAspectValue,
  normalizeAspectMap,
  reconcileGeneratedAspects,
  reconcilePublishAspects,
  type ReconcileSpec,
} from "../lib/aspect-reconcile.ts";

const sel = (name: string, allowedValues: string[]): ReconcileSpec => ({
  name,
  mode: "SELECTION_ONLY",
  allowedValues,
});
const free = (name: string): ReconcileSpec => ({ name, mode: "FREE_TEXT" });

const SPECS: ReconcileSpec[] = [
  sel("Size", ["XS", "S", "M", "L", "XL"]),
  sel("Material", ["Cotton", "Polyester", "Wool"]),
  sel("Department", ["Men", "Women", "Unisex Adult"]),
  free("Brand"),
];

// ── SELECTION_ONLY value validation (AC4): valid / normalizable / unmatched ──

Deno.test("generation: valid SELECTION_ONLY value passes through unchanged", () => {
  const r = reconcileGeneratedAspects({ Size: ["L"] }, SPECS);
  assertEquals(r.aspects.Size, ["L"]);
  assertEquals(r.review, []);
});

Deno.test("generation: near-miss value is normalized via US-823 (no review)", () => {
  // "Medium" -> "M", "Poly" -> "Polyester", "Men's" -> "Men"
  const r = reconcileGeneratedAspects(
    { Size: ["Medium"], Material: ["Poly"], Department: ["Men's"] },
    SPECS,
  );
  assertEquals(r.aspects.Size, ["M"]);
  assertEquals(r.aspects.Material, ["Polyester"]);
  assertEquals(r.aspects.Department, ["Men"]);
  assertEquals(r.review, []);
});

Deno.test("generation: unmatched value is KEPT and flagged needs-review", () => {
  const r = reconcileGeneratedAspects({ Material: ["Hemp"] }, SPECS);
  // kept (not dropped) so the seller still sees it in the editor
  assertEquals(r.aspects.Material, ["Hemp"]);
  assertEquals(r.review.length, 1);
  assertEquals(r.review[0], {
    aspect: "Material",
    values: ["Hemp"],
    reason: "unmatched_value",
  });
});

Deno.test("generation: mixed values — valid kept, near-miss fixed, unmatched flagged", () => {
  const r = reconcileGeneratedAspects(
    { Material: ["Cotton", "Poly", "Hemp"] },
    SPECS,
  );
  assertEquals(r.aspects.Material, ["Cotton", "Polyester", "Hemp"]);
  assertEquals(r.review[0]?.values, ["Hemp"]);
});

Deno.test("generation: aspect name not in spec is kept + flagged unknown_aspect", () => {
  const r = reconcileGeneratedAspects({ "Sleeve Vibe": ["Breezy"] }, SPECS);
  assertEquals(r.aspects["Sleeve Vibe"], ["Breezy"]);
  assertEquals(r.review[0]?.reason, "unknown_aspect");
});

Deno.test("generation: free-text aspect passes through, never flagged", () => {
  const r = reconcileGeneratedAspects({ Brand: ["Some Indie Label"] }, SPECS);
  assertEquals(r.aspects.Brand, ["Some Indie Label"]);
  assertEquals(r.review, []);
});

Deno.test("generation: loose name match repairs casing/punctuation", () => {
  const r = reconcileGeneratedAspects({ "department": ["women"] }, SPECS);
  // canonical spec name + canonical value
  assertEquals(r.aspects.Department, ["Women"]);
  assertEquals(r.review, []);
});

Deno.test("generation: empty value arrays are skipped entirely", () => {
  const r = reconcileGeneratedAspects({ Size: [], Material: ["  "] }, SPECS);
  assertEquals(r.aspects, {});
  assertEquals(r.review, []);
});

// ── PUBLISH-time reconciliation: omit-with-diagnostics (AC3) ─────────────────

Deno.test("publish: valid value passes through, no diagnostics", () => {
  const r = reconcilePublishAspects({ Size: ["M"] }, SPECS);
  assertEquals(r.aspects.Size, ["M"]);
  assertEquals(r.omitted, []);
});

Deno.test("publish: near-miss is normalized (publishes instead of failing)", () => {
  const r = reconcilePublishAspects({ Material: ["Poly"] }, SPECS);
  assertEquals(r.aspects.Material, ["Polyester"]);
  assertEquals(r.omitted, []);
});

Deno.test("publish: unmatched SELECTION_ONLY value is OMITTED + diagnosed", () => {
  const r = reconcilePublishAspects({ Material: ["Hemp"] }, SPECS);
  // aspect omitted entirely (its only value was invalid)
  assertEquals(r.aspects.Material, undefined);
  assertEquals(r.omitted.length, 1);
  assertEquals(r.omitted[0], {
    aspect: "Material",
    omittedValues: ["Hemp"],
    reason: "unmatched_value",
  });
});

Deno.test("publish: partial — valid value kept, invalid one omitted", () => {
  const r = reconcilePublishAspects({ Material: ["Cotton", "Hemp"] }, SPECS);
  assertEquals(r.aspects.Material, ["Cotton"]);
  assertEquals(r.omitted[0]?.omittedValues, ["Hemp"]);
});

Deno.test("publish: unknown aspect name passes through unchanged (no over-drop)", () => {
  const r = reconcilePublishAspects({ "Custom Thing": ["x"] }, SPECS);
  assertEquals(r.aspects["Custom Thing"], ["x"]);
  assertEquals(r.omitted, []);
});

Deno.test("publish: free-text aspect passes through unchanged", () => {
  const r = reconcilePublishAspects({ Brand: ["Indie"] }, SPECS);
  assertEquals(r.aspects.Brand, ["Indie"]);
  assertEquals(r.omitted, []);
});

Deno.test("publish: SELECTION_ONLY with no allowed values is treated as free text", () => {
  const r = reconcilePublishAspects({ Pattern: ["Paisley"] }, [
    { name: "Pattern", mode: "SELECTION_ONLY", allowedValues: [] },
  ]);
  assertEquals(r.aspects.Pattern, ["Paisley"]);
  assertEquals(r.omitted, []);
});

// ── US-1505: string-valued legacy maps must not throw / dead-end publish ──

Deno.test("normalizeAspectMap: coerces string values to string[]", () => {
  assertEquals(normalizeAspectMap({ Fit: "Slim", Brand: "Nike" }), {
    Fit: ["Slim"],
    Brand: ["Nike"],
  });
});

Deno.test("normalizeAspectMap: passes arrays through, dedupes + drops blanks", () => {
  assertEquals(
    normalizeAspectMap({ Size: ["M", "M", " "], Color: [], Nope: null }),
    { Size: ["M"] },
  );
});

Deno.test("normalizeAspectMap: coerces non-string scalars and null map", () => {
  assertEquals(normalizeAspectMap({ Year: 2024, Vintage: true }), {
    Year: ["2024"],
    Vintage: ["true"],
  });
  assertEquals(normalizeAspectMap(null), {});
  assertEquals(normalizeAspectMap(undefined), {});
});

Deno.test("publish: string-valued map does NOT throw (US-1505 dead-end)", () => {
  // A template row persisted as {Fit:"Slim"} used to hit (rawValues ?? []).filter
  // on a string → TypeError → bogus "Could not load eBay specifics" blocker.
  const r = reconcilePublishAspects(
    { Fit: "Slim" } as unknown as Record<string, string[]>,
    [free("Fit")],
  );
  assertEquals(r.aspects.Fit, ["Slim"]);
  assertEquals(r.omitted, []);
});

Deno.test("publish: normalized then reconciled string map validates SELECTION_ONLY", () => {
  const r = reconcilePublishAspects(
    normalizeAspectMap({ Size: "m", Brand: "Levi's" }),
    SPECS,
  );
  assertEquals(r.aspects.Size, ["M"]); // near-miss casing repaired
  assertEquals(r.aspects.Brand, ["Levi's"]);
  assertEquals(r.omitted, []);
});

// ── NUMBER-typed aspects: eBay parses the value, and a word fails the publish ──
// Live case: a Women's Tops draft carried Fabric Weight="Midweight"; eBay
// answered the publish with 25002 "Fabric weight must be greater than 0. Enter
// up to 1 number after the decimal." and NOTHING listed.

const num = (name: string): ReconcileSpec => ({
  name,
  mode: "FREE_TEXT",
  dataType: "NUMBER",
});

Deno.test("coerceNumericAspectValue: accepts, strips units, rounds to 1dp", () => {
  assertEquals(coerceNumericAspectValue("16"), "16");
  assertEquals(coerceNumericAspectValue("16.5"), "16.5");
  assertEquals(coerceNumericAspectValue(" 16 oz "), "16");
  assertEquals(coerceNumericAspectValue("8.5 oz/yd²"), "8.5");
  assertEquals(coerceNumericAspectValue("5,5"), "5.5");
  assertEquals(coerceNumericAspectValue("16.75"), "16.8");
});

Deno.test("coerceNumericAspectValue: rejects words, ranges, zero, negatives", () => {
  assertEquals(coerceNumericAspectValue("Midweight"), null);
  assertEquals(coerceNumericAspectValue("Heavy"), null);
  assertEquals(coerceNumericAspectValue("16-18"), null); // range: no single value
  assertEquals(coerceNumericAspectValue("0"), null);
  assertEquals(coerceNumericAspectValue("0.04"), null); // rounds to 0
  assertEquals(coerceNumericAspectValue("-2"), null);
  assertEquals(coerceNumericAspectValue(""), null);
});

Deno.test("publish: unparseable NUMBER aspect is omitted, not sent (25002)", () => {
  const r = reconcilePublishAspects({ "Fabric Weight": ["Midweight"] }, [
    num("Fabric Weight"),
  ]);
  assertEquals(r.aspects["Fabric Weight"], undefined);
  assertEquals(r.omitted, [
    {
      aspect: "Fabric Weight",
      omittedValues: ["Midweight"],
      reason: "unmatched_value",
    },
  ]);
});

Deno.test("publish: NUMBER aspect with a unit is repaired, not dropped", () => {
  const r = reconcilePublishAspects({ "Fabric Weight": ["16 oz"] }, [
    num("Fabric Weight"),
  ]);
  assertEquals(r.aspects["Fabric Weight"], ["16"]);
  assertEquals(r.omitted, []);
});

Deno.test("publish: one bad NUMBER value costs the specific, not the listing", () => {
  const r = reconcilePublishAspects(
    { "Fabric Weight": ["Midweight"], Size: ["M"], Brand: ["Indie"] },
    [...SPECS, num("Fabric Weight")],
  );
  assertEquals(r.aspects.Size, ["M"]);
  assertEquals(r.aspects.Brand, ["Indie"]);
  assertEquals(r.omitted.length, 1);
});

Deno.test("publish: STRING aspects are untouched by numeric validation", () => {
  const r = reconcilePublishAspects({ Brand: ["16 Candles"] }, [free("Brand")]);
  assertEquals(r.aspects.Brand, ["16 Candles"]);
  assertEquals(r.omitted, []);
});

Deno.test("generation: bad NUMBER value is KEPT and flagged for the seller", () => {
  const r = reconcileGeneratedAspects({ "Fabric Weight": ["Midweight"] }, [
    num("Fabric Weight"),
  ]);
  assertEquals(r.aspects["Fabric Weight"], ["Midweight"]); // visible, fixable
  assertEquals(r.review, [
    {
      aspect: "Fabric Weight",
      values: ["Midweight"],
      reason: "unmatched_value",
    },
  ]);
});

Deno.test("generation: repairable NUMBER value is normalized with no review", () => {
  const r = reconcileGeneratedAspects({ "Fabric Weight": ["16 oz"] }, [
    num("Fabric Weight"),
  ]);
  assertEquals(r.aspects["Fabric Weight"], ["16"]);
  assertEquals(r.review, []);
});

// ── eBay standardized sizes (2026-09): the size family is a closed list even
// when the cached Taxonomy payload still says SUGGESTED or FREE_TEXT. ──────

Deno.test("a size aspect with allowed values is closed whatever its cached mode", () => {
  const specs: ReconcileSpec[] = [
    { name: "Size Type", mode: "SUGGESTED", allowedValues: ["Regular", "Plus", "Petite"] },
    { name: "Size", mode: "FREE_TEXT", allowedValues: ["S", "M", "L"] },
    { name: "US Shoe Size", mode: "SUGGESTED", allowedValues: ["8", "8.5", "9"] },
    { name: "Color", mode: "SUGGESTED", allowedValues: ["Black", "Blue"] },
  ];
  const r = reconcilePublishAspects(
    { "Size Type": ["Standard"], Size: ["Large"], "US Shoe Size": ["8.5"], Color: ["Taupe"] },
    specs,
  );
  assertEquals(r.aspects["Size Type"], ["Regular"]);
  assertEquals(r.aspects["Size"], ["L"]);
  assertEquals(r.aspects["US Shoe Size"], ["8.5"]);
  assertEquals(r.aspects["Color"], ["Taupe"], "a non-size SUGGESTED aspect still passes free text");
  assertEquals(r.omitted, []);
});

Deno.test("a custom size value that matches nothing is omitted and diagnosed, never sent", () => {
  const specs: ReconcileSpec[] = [
    { name: "Size Type", mode: "SUGGESTED", allowedValues: ["Regular", "Plus"] },
  ];
  const r = reconcilePublishAspects({ "Size Type": ["Misses"] }, specs);
  assertEquals(r.aspects["Size Type"], undefined);
  assertEquals(r.omitted, [{ aspect: "Size Type", omittedValues: ["Misses"], reason: "unmatched_value" }]);
});

Deno.test("a size aspect eBay shipped no values for still takes free text", () => {
  const specs: ReconcileSpec[] = [{ name: "Size", mode: "FREE_TEXT", allowedValues: [] }];
  const r = reconcilePublishAspects({ Size: ["32x30"] }, specs);
  assertEquals(r.aspects["Size"], ["32x30"]);
});
