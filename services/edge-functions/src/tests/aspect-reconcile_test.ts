// US-828: reconcile AI-generated / stored aspect maps against the category spec.
// Fixture-tested for the three SELECTION_ONLY outcomes the story calls out —
// valid (pass), normalizable (near-miss repaired via US-823), unmatched (kept +
// flagged at generation / omitted + diagnosed at publish) — plus unknown aspect
// names and free-text pass-through. Pure functions, no env.
//   deno test src/tests/aspect-reconcile_test.ts
import { assertEquals } from "@std/assert";
import {
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
