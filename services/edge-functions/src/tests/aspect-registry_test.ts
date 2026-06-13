// US-822: the single-source canonical-attribute → eBay-aspect registry resolver.
// Pure functions — no Anthropic/Supabase/env. Covers the 7 legacy mappings as a
// regression, the new US-821 attributes, SELECTION_ONLY validation, multi
// (features) cardinality, per-vertical (shoes) candidates, and the user-set
// precedence (never overwrite existing).
//   deno test src/tests/aspect-registry_test.ts
import { assertEquals } from "@std/assert";
import {
  ASPECT_REGISTRY,
  inferDepartment,
  type RegistryAspect,
  type RegistryItem,
  resolveItemAspects,
} from "../lib/aspect-registry.ts";

// Helpers to build aspect specs tersely.
const free = (name: string): RegistryAspect => ({ name, mode: "FREE_TEXT" });
const sel = (name: string, allowed: string[], multi = false): RegistryAspect => ({
  name,
  mode: "SELECTION_ONLY",
  multi,
  allowedValues: allowed,
});

// ── Legacy 7-mapping regression (no attributes present) ─────────────────────

Deno.test("legacy: brand/size/color/material/style fill from columns (FREE_TEXT)", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    brand: "Nike",
    size: "M",
    color: "Blue",
    material: "Cotton",
    style: "Hoodie",
  };
  const aspects = [
    free("Brand"),
    free("Size"),
    free("Color"),
    free("Material"),
    free("Type"), // style synonym
  ];
  assertEquals(resolveItemAspects(item, aspects, {}), {
    Brand: ["Nike"],
    Size: ["M"],
    Color: ["Blue"],
    Material: ["Cotton"],
    Type: ["Hoodie"],
  });
});

Deno.test("legacy: color/material synonyms (Colour, Fabric Type, Outer Shell Material)", () => {
  const item: RegistryItem = { item_category: "clothing", color: "Red", material: "Wool" };
  const aspects = [free("Colour"), free("Fabric Type"), free("Outer Shell Material")];
  assertEquals(resolveItemAspects(item, aspects, {}), {
    Colour: ["Red"],
    "Fabric Type": ["Wool"],
    "Outer Shell Material": ["Wool"],
  });
});

Deno.test("legacy: size_type defaults to Regular only for clothing", () => {
  const aspects = [free("Size Type")];
  assertEquals(
    resolveItemAspects({ item_category: "clothing" }, aspects, {}),
    { "Size Type": ["Regular"] },
  );
  // Non-clothing gets no default.
  assertEquals(resolveItemAspects({ item_category: "shoes" }, aspects, {}), {});
});

Deno.test("legacy: department inferred from text and validated against SELECTION_ONLY", () => {
  const item: RegistryItem = { item_category: "clothing", title: "Men's Nike Hoodie" };
  // SELECTION_ONLY with the real eBay value → matched.
  assertEquals(
    resolveItemAspects(item, [sel("Department", ["Men", "Women", "Unisex Adult"])], {}),
    { Department: ["Men"] },
  );
  // SELECTION_ONLY without a matching allowed value → left empty (never guess).
  assertEquals(resolveItemAspects(item, [sel("Department", ["Women"])], {}), {});
});

Deno.test("US-823: resolver normalizes a SELECTION_ONLY value (size M → Medium)", () => {
  const item: RegistryItem = { item_category: "clothing", size: "M", material: "Poly" };
  assertEquals(
    resolveItemAspects(
      item,
      [sel("Size", ["Small", "Medium", "Large"]), sel("Material", ["Cotton", "Polyester"])],
      {},
    ),
    { Size: ["Medium"], Material: ["Polyester"] },
  );
});

Deno.test("legacy: SELECTION_ONLY plural tolerance (Unisex Adult ↔ Unisex Adults)", () => {
  const item: RegistryItem = { item_category: "clothing", title: "unisex tee" };
  assertEquals(
    resolveItemAspects(item, [sel("Department", ["Unisex Adults"])], {}),
    { Department: ["Unisex Adults"] },
  );
});

// ── User-set precedence (AC4) ───────────────────────────────────────────────

Deno.test("never overwrites an existing user-set aspect", () => {
  const item: RegistryItem = { item_category: "clothing", brand: "Nike" };
  assertEquals(resolveItemAspects(item, [free("Brand")], { Brand: ["Adidas"] }), {});
});

// ── US-821 canonical attributes ─────────────────────────────────────────────

Deno.test("attributes: single-valued canonical attributes map to their aspects", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    attributes: {
      sleeve_length: "Long Sleeve",
      neckline: "Crew Neck",
      pattern: "Striped",
      fit: "Slim",
      closure: "Button",
      garment_care: "Machine Wash",
      country_of_manufacture: "Vietnam",
      vintage: "No",
      theme: "Floral",
      mpn: "ABC123",
    },
  };
  const aspects = [
    free("Sleeve Length"),
    free("Neckline"),
    free("Pattern"),
    free("Fit"),
    free("Closure"),
    free("Care Instructions"), // garment_care synonym
    free("Country/Region of Manufacture"),
    free("Vintage"),
    free("Theme"),
    free("MPN"),
  ];
  assertEquals(resolveItemAspects(item, aspects, {}), {
    "Sleeve Length": ["Long Sleeve"],
    Neckline: ["Crew Neck"],
    Pattern: ["Striped"],
    Fit: ["Slim"],
    Closure: ["Button"],
    "Care Instructions": ["Machine Wash"],
    "Country/Region of Manufacture": ["Vietnam"],
    Vintage: ["No"],
    Theme: ["Floral"],
    MPN: ["ABC123"],
  });
});

Deno.test("attributes: department/size_type from attributes beat inference/default", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    title: "Men's Hoodie", // would infer "Men"…
    attributes: { department: "Unisex Adult", size_type: "Plus" }, // …but attribute wins
  };
  assertEquals(
    resolveItemAspects(item, [free("Department"), free("Size Type")], {}),
    { Department: ["Unisex Adult"], "Size Type": ["Plus"] },
  );
});

Deno.test("attributes: features (multi) fills a MULTI aspect with all values", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    attributes: { features: ["Pockets", "Hooded", "Lined"] },
  };
  // MULTI cardinality → all values sent.
  assertEquals(
    resolveItemAspects(item, [{ name: "Features", mode: "FREE_TEXT", multi: true }], {}),
    { Features: ["Pockets", "Hooded", "Lined"] },
  );
  // SINGLE cardinality → only the first value.
  assertEquals(
    resolveItemAspects(item, [{ name: "Features", mode: "FREE_TEXT", multi: false }], {}),
    { Features: ["Pockets"] },
  );
});

Deno.test("attributes: SELECTION_ONLY multi keeps only matching allowed values", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    attributes: { features: ["Pockets", "Nonexistent", "Lined"] },
  };
  assertEquals(
    resolveItemAspects(item, [sel("Features", ["Pockets", "Lined", "Hooded"], true)], {}),
    { Features: ["Pockets", "Lined"] },
  );
});

// ── Per-vertical (shoes) candidates ─────────────────────────────────────────

Deno.test("per-vertical: shoes size maps to US Shoe Size; material to Upper Material", () => {
  const item: RegistryItem = { item_category: "shoes", size: "10", material: "Leather" };
  assertEquals(
    resolveItemAspects(item, [free("US Shoe Size"), free("Upper Material")], {}),
    { "US Shoe Size": ["10"], "Upper Material": ["Leather"] },
  );
  // The generic "Size"/"Material" candidates still work in the shoes vertical.
  assertEquals(
    resolveItemAspects(item, [free("Size"), free("Material")], {}),
    { Size: ["10"], Material: ["Leather"] },
  );
});

Deno.test("per-vertical: clothing does NOT use the shoe-only candidates", () => {
  const item: RegistryItem = { item_category: "clothing", size: "M" };
  // "US Shoe Size" is shoes-only — not a candidate for clothing.
  assertEquals(resolveItemAspects(item, [free("US Shoe Size")], {}), {});
});

// ── inferDepartment unit coverage ───────────────────────────────────────────

Deno.test("inferDepartment: order specificity (women before men, boys, etc.)", () => {
  assertEquals(inferDepartment({ item_category: null, title: "Women's Coat" }), "Women");
  assertEquals(inferDepartment({ item_category: null, title: "Men's Coat" }), "Men");
  assertEquals(inferDepartment({ item_category: null, size: "Boys 10/12" }), "Boys");
  assertEquals(inferDepartment({ item_category: null, title: "plain tee" }), null);
});

// ── Registry data sanity ────────────────────────────────────────────────────

Deno.test("registry: every entry has a key, source, and at least one aspect candidate", () => {
  for (const e of ASPECT_REGISTRY.entries) {
    assertEquals(typeof e.key, "string");
    assertEquals(e.aspects.length > 0, true);
    assertEquals(e.source === "column" || e.source === "attribute", true);
    if (e.source === "column") assertEquals(typeof e.column, "string");
    if (e.source === "attribute") assertEquals(typeof e.attribute, "string");
  }
});
