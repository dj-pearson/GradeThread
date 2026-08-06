// US-822: the single-source canonical-attribute → eBay-aspect registry resolver.
// Pure functions — no Anthropic/Supabase/env. Covers the 7 legacy mappings as a
// regression, the new US-821 attributes, SELECTION_ONLY validation, multi
// (features) cardinality, per-vertical (shoes) candidates, and the user-set
// precedence (never overwrite existing).
//   deno test src/tests/aspect-registry_test.ts
import { assertEquals } from "@std/assert";
import {
  applyColumnAspects,
  ASPECT_REGISTRY,
  columnAspectProjection,
  columnBackedAspectNames,
  inferDepartment,
  type RegistryAspect,
  type RegistryItem,
  resolveItemAspects,
  reverseColumnAspects,
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

Deno.test("legacy: color/material synonyms resolve to the highest-priority name present", () => {
  const item: RegistryItem = { item_category: "clothing", color: "Red", material: "Wool" };
  const aspects = [free("Colour"), free("Fabric Type"), free("Outer Shell Material")];
  // A field fills the ONE aspect it owns — the first of its registry candidates
  // this category exposes. "Material" is absent, so "Fabric Type" wins and
  // "Outer Shell Material" is left free. Filling every synonym (the old
  // behaviour) is what made a coat's shell material and its fabric type one
  // inseparable value, and what pinned Women's Tops "Fabric Type" to "Material".
  assertEquals(resolveItemAspects(item, aspects, {}), {
    Colour: ["Red"],
    "Fabric Type": ["Wool"],
  });
});

Deno.test("a category exposing two names for one field binds only the first", () => {
  // Women's Tops (53159) exposes BOTH "Style" and "Type" for the style column,
  // and BOTH "Material" and "Fabric Type" for the material column. The seller
  // could not set Type=Blouse while Style=Sheath: whichever name the column did
  // not own was overwritten from the column on every save, so the row looked
  // editable and silently reverted.
  const item: RegistryItem = {
    item_category: "clothing",
    style: "Sheath",
    material: "Jersey",
  };
  const aspects = [free("Type"), free("Style"), free("Material"), free("Fabric Type")];
  assertEquals(resolveItemAspects(item, aspects, {}), {
    Style: ["Sheath"],
    Material: ["Jersey"],
  });
  // The forward projection agrees: it must not touch the free neighbours.
  const projected = applyColumnAspects(
    { Type: ["Blouse"], "Fabric Type": ["Rayon"] },
    item,
    aspects,
  );
  assertEquals(projected, {
    Type: ["Blouse"],
    "Fabric Type": ["Rayon"],
    Style: ["Sheath"],
    Material: ["Jersey"],
  });
  // …and so does the reverse pass, given the spec: an edit to the free "Type"
  // row is NOT a rename of the style column.
  assertEquals(
    reverseColumnAspects(
      item,
      { Type: ["Blouse"], Style: ["Sheath"] },
      { Type: "manual", Style: "inventory_derived" },
      aspects,
    ),
    {},
  );
  // An edit to the OWNED row still writes back.
  assertEquals(
    reverseColumnAspects(
      item,
      { Type: ["Blouse"], Style: ["Wrap"] },
      { Type: "manual", Style: "manual" },
      aspects,
    ),
    { style: "Wrap" },
  );
});

// ── US-1088+: columns OWN their aspects (overwrite on main-listing edit) ─────

Deno.test("applyColumnAspects overwrites a stale column-backed aspect from the column", () => {
  // Buyer-facing bug: Size was published as "M", the seller changes the column
  // to "L"; resolveItemAspects would keep "M" (never overwrites). The column
  // projection forces the new value.
  const item: RegistryItem = { item_category: "clothing", size: "L", brand: "Nike" };
  const aspects = [free("Size"), free("Brand")];
  const existing = { Size: ["M"], Brand: ["Nike"], "Sleeve Length": ["Long"] };
  assertEquals(applyColumnAspects(existing, item, aspects), {
    Size: ["L"], // forced from the column
    Brand: ["Nike"],
    "Sleeve Length": ["Long"], // untouched (not a column-backed aspect)
  });
});

Deno.test("applyColumnAspects is overwrite-only: a blank column never wipes an existing value by default", () => {
  // The column is empty but the aspect was AI/manually filled — must survive.
  const item: RegistryItem = { item_category: "clothing", size: "" };
  assertEquals(
    applyColumnAspects({ Size: ["One Size"] }, item, [free("Size")]),
    { Size: ["One Size"] },
  );
  // Opt-in clearEmpty removes it (caller knows the seller blanked the field).
  assertEquals(
    applyColumnAspects({ Size: ["One Size"] }, item, [free("Size")], {
      clearEmpty: true,
    }),
    {},
  );
});

Deno.test("applyColumnAspects leaves non-column (attribute/AI) aspects alone", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    brand: "Levi's",
    attributes: { pattern: "Striped" },
  };
  // Pattern is attribute-sourced; an AI value for it must not be overwritten.
  const existing = { Pattern: ["Solid"], Brand: ["Old"] };
  assertEquals(applyColumnAspects(existing, item, [free("Brand"), free("Pattern")]), {
    Pattern: ["Solid"], // attribute-backed → not touched here
    Brand: ["Levi's"], // column-backed → forced
  });
});

Deno.test("columnAspectProjection: SELECTION_ONLY miss leaves the existing value (no wipe)", () => {
  const item: RegistryItem = { item_category: "clothing", size: "XS" };
  const { set, clear } = columnAspectProjection(item, [
    sel("Size", ["Small", "Medium", "Large"]),
  ]);
  // "XS" doesn't normalize into the allowed list → neither set nor cleared.
  assertEquals(set, {});
  assertEquals(clear, []);
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

// ── reverseColumnAspects (aspect edits flow back to their columns) ──────────

Deno.test("reverse: a MANUAL aspect edit overwrites a differing column", () => {
  const item: RegistryItem = { item_category: "clothing", brand: "Nike", size: "M" };
  assertEquals(
    reverseColumnAspects(
      item,
      { Brand: ["Adidas"], Size: ["M"] },
      { Brand: "manual", Size: "manual" },
    ),
    { brand: "Adidas" }, // Size unchanged → no patch entry
  );
});

Deno.test("reverse: manual and AI values fill a BLANK column", () => {
  const item: RegistryItem = { item_category: "clothing", brand: null, color: "" };
  assertEquals(
    reverseColumnAspects(
      item,
      { Brand: ["Levi's"], Colour: ["Indigo"] },
      { Brand: "manual", Colour: "ai_extracted" },
    ),
    { brand: "Levi's", color: "Indigo" },
  );
});

Deno.test("reverse: AI never overwrites a populated column", () => {
  const item: RegistryItem = { item_category: "clothing", brand: "Nike" };
  assertEquals(
    reverseColumnAspects(item, { Brand: ["Adidas"] }, { Brand: "ai_extracted" }),
    {},
  );
});

Deno.test("reverse: derived / unattributed values never flow back", () => {
  const item: RegistryItem = { item_category: "clothing", brand: "Nike", size: null };
  assertEquals(
    reverseColumnAspects(
      item,
      // "Medium" is the normalized projection of size "M" — writing it back
      // would churn the column; unattributed Brand could be a stale mirror.
      { Size: ["Medium"], Brand: ["Adidas"] },
      { Size: "inventory_derived" },
    ),
    {},
  );
});

Deno.test("reverse: synonym + per-vertical candidates match (US Shoe Size → size)", () => {
  const item: RegistryItem = { item_category: "shoes", size: "9", material: "Suede" };
  assertEquals(
    reverseColumnAspects(
      item,
      { "US Shoe Size": ["10"], "Upper Material": ["Leather"] },
      { "US Shoe Size": "manual", "Upper Material": "manual" },
    ),
    { size: "10", material: "Leather" },
  );
});

Deno.test("reverse: blank/absent aspects never clear a column", () => {
  const item: RegistryItem = { item_category: "clothing", brand: "Nike" };
  assertEquals(reverseColumnAspects(item, { Brand: [""] }, { Brand: "manual" }), {});
  assertEquals(reverseColumnAspects(item, {}, {}), {});
});

Deno.test("reverse: attribute-backed aspects (Department etc.) are ignored", () => {
  const item: RegistryItem = { item_category: "clothing" };
  assertEquals(
    reverseColumnAspects(item, { Department: ["Men"] }, { Department: "manual" }),
    {},
  );
});

// ── Revise parity: the gap-fill the revise path was missing ─────────────────
//
// Publish ran resolveItemAspects (via deriveAspectsFromItem) over the category
// spec, which is what filled attribute- and inference-backed REQUIRED aspects
// like Department. Revise only ran applyColumnAspects (Brand/Size/Color/
// Material/Style), so a listing whose stored item_specifics_override lacked
// Department published fine and then failed EVERY revise with eBay's "The item
// specific Department is missing". These pin the resolver behaviour the revise
// path now depends on.

Deno.test("revise parity: column-only forcing leaves a required Department unfilled", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    title: "Maeve The Collette Black Wide Leg Cropped Pants",
    brand: "Maeve",
    size: "6",
    color: "Black",
  };
  const spec = [
    free("Brand"),
    free("Size"),
    free("Color"),
    sel("Department", ["Men", "Women", "Unisex Adult", "Girls", "Boys"]),
  ];
  // What the revise path used to send: columns re-asserted, nothing else.
  const columnsOnly = applyColumnAspects({}, item, spec);
  assertEquals(columnsOnly.Department, undefined);
});

Deno.test("revise parity: the resolver fills Department from the item's own text", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    title: "Maeve The Collette Black Wide Leg Cropped Pants",
    style: "Women's wide leg trouser",
    brand: "Maeve",
    size: "6",
    color: "Black",
  };
  const spec = [
    free("Brand"),
    free("Size"),
    free("Color"),
    sel("Department", ["Men", "Women", "Unisex Adult", "Girls", "Boys"]),
  ];
  const columnsOnly = applyColumnAspects({}, item, spec);
  const derived = resolveItemAspects(item, spec, columnsOnly);
  assertEquals(derived.Department, ["Women"]);
});

Deno.test("revise parity: gap-fill never overwrites a Department the seller set", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    title: "Women's wide leg trouser",
  };
  const spec = [sel("Department", ["Men", "Women", "Unisex Adult"])];
  assertEquals(
    resolveItemAspects(item, spec, { Department: ["Unisex Adult"] }),
    {},
  );
});

// The iOS item page renders the specifics INLINE, alongside the item's own
// Brand/Size/Color/Material/Style inputs. It hides the aspects those columns
// already own so the seller never sees one value in two inputs — the
// double-entry confusion. This is the list it hides by, and it is purely
// structural (no item needed), so the client can ask as soon as it has a
// category.
Deno.test("columnBackedAspectNames names the aspects a main-page column owns", () => {
  const names = columnBackedAspectNames([
    free("Brand"),
    sel("Color", ["Black", "Blue"]),
    free("Material"),
    free("Style"),
    sel("Size", ["S", "M"]),
    // NOT column-backed — these have no main-page input, so they must stay
    // visible in the inline section or they'd be unreachable.
    sel("Department", ["Men", "Women"]),
    free("Sleeve Length"),
    free("Pattern"),
  ]);
  assertEquals(names.sort(), ["Brand", "Color", "Material", "Size", "Style"]);
});

Deno.test("columnBackedAspectNames matches synonyms and per-vertical names", () => {
  // "Colour" is the registry's synonym for Color; "US Shoe Size" is the shoes
  // extra for Size. Both are owned by a column, so both must be hidden — miss
  // one and the seller gets a duplicate field on exactly the categories where
  // it is most confusing.
  assertEquals(columnBackedAspectNames([free("Colour")]), ["Colour"]);
  assertEquals(columnBackedAspectNames([free("US Shoe Size")]), ["US Shoe Size"]);
  assertEquals(columnBackedAspectNames([free("Fabric Type")]), ["Fabric Type"]);
  // Case-insensitive against eBay's own casing, and echoed back verbatim so the
  // client can match its spec list exactly.
  assertEquals(columnBackedAspectNames([free("BRAND")]), ["BRAND"]);
});

Deno.test("columnBackedAspectNames is empty for a category with none, and dedupes", () => {
  assertEquals(columnBackedAspectNames([free("Occasion"), free("Theme")]), []);
  assertEquals(columnBackedAspectNames([]), []);
  // A malformed spec repeating an aspect must not yield it twice.
  assertEquals(columnBackedAspectNames([free("Brand"), free("Brand")]), ["Brand"]);
  assertEquals(columnBackedAspectNames([{ name: "  " } as RegistryAspect]), []);
});
