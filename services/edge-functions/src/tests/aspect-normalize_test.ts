// US-823: aspect VALUE normalization — exact/plural/synonym/token matching of a
// canonical stored value against an aspect's SELECTION_ONLY allowedValues, with
// a hard "no confident match → null" rule and FREE_TEXT pass-through.
// Pure functions — no env. Fixtures mirror realistic eBay clothing aspects.
//   deno test src/tests/aspect-normalize_test.ts
import { assertEquals } from "@std/assert";
import {
  type AspectValueSpec,
  normalizeAspectValue,
} from "../lib/aspect-normalize.ts";

const sel = (name: string, allowedValues: string[]): AspectValueSpec => ({
  name,
  mode: "SELECTION_ONLY",
  allowedValues,
});

// Realistic eBay clothing allowedValues fixtures.
const SIZE = ["XS", "S", "M", "L", "XL", "XXL"];
const SIZE_PAREN = ["S (Small)", "M (Medium)", "L (Large)"];
const DEPARTMENT = ["Men", "Women", "Unisex Adult", "Boys", "Girls"];
const MATERIAL = ["Cotton", "Polyester", "Wool", "Spandex", "Leather"];
const SIZE_TYPE = ["Regular", "Plus", "Petite", "Big & Tall"];

// ── FREE_TEXT pass-through (AC5) ────────────────────────────────────────────

Deno.test("FREE_TEXT: original value passes through untouched, never normalized", () => {
  assertEquals(
    normalizeAspectValue("M", { name: "Size", mode: "FREE_TEXT", allowedValues: [] }),
    "M",
  );
  // No mode (defaults to free) also passes through.
  assertEquals(normalizeAspectValue("Poly", { name: "Material" }), "Poly");
});

// ── Exact / plural match (legacy regression) ────────────────────────────────

Deno.test("exact match returns the allowed value with eBay's casing", () => {
  assertEquals(normalizeAspectValue("m", sel("Size", SIZE)), "M");
  assertEquals(normalizeAspectValue("WOMEN", sel("Department", DEPARTMENT)), "Women");
});

Deno.test("plural tolerance (Unisex Adult ↔ Unisex Adults)", () => {
  assertEquals(
    normalizeAspectValue("Unisex Adult", sel("Department", ["Unisex Adults"])),
    "Unisex Adults",
  );
});

// ── Synonym rewrites (AC1) ──────────────────────────────────────────────────

Deno.test("size synonyms: M → Medium, S → Small, XL → X-Large", () => {
  const SPELLED = ["Small", "Medium", "Large", "X-Large"];
  assertEquals(normalizeAspectValue("M", sel("Size", SPELLED)), "Medium");
  assertEquals(normalizeAspectValue("S", sel("Size", SPELLED)), "Small");
  assertEquals(normalizeAspectValue("XL", sel("Size", SPELLED)), "X-Large");
  // …and the reverse direction (spelled stored, abbreviated allowed).
  assertEquals(normalizeAspectValue("Medium", sel("Size", SIZE)), "M");
});

Deno.test("material synonyms: Poly → Polyester, Lycra → Spandex", () => {
  assertEquals(normalizeAspectValue("Poly", sel("Material", MATERIAL)), "Polyester");
  assertEquals(normalizeAspectValue("Lycra", sel("Material", MATERIAL)), "Spandex");
  assertEquals(
    normalizeAspectValue("Rayon", sel("Fabric Type", ["Viscose", "Cotton"])),
    "Viscose",
  );
});

Deno.test("department synonyms: Men's / Mens → Men", () => {
  assertEquals(normalizeAspectValue("Men's", sel("Department", DEPARTMENT)), "Men");
  assertEquals(normalizeAspectValue("Mens", sel("Department", DEPARTMENT)), "Men");
  assertEquals(normalizeAspectValue("Ladies", sel("Department", DEPARTMENT)), "Women");
});

Deno.test("size type synonyms: Big and Tall → Big & Tall, Standard → Regular", () => {
  assertEquals(
    normalizeAspectValue("Big and Tall", sel("Size Type", SIZE_TYPE)),
    "Big & Tall",
  );
  assertEquals(normalizeAspectValue("Standard", sel("Size Type", SIZE_TYPE)), "Regular");
});

// ── Parenthetical abbreviation fallback ─────────────────────────────────────

Deno.test("parenthetical: M → 'M (Medium)', Medium → 'M (Medium)'", () => {
  assertEquals(normalizeAspectValue("M", sel("Size", SIZE_PAREN)), "M (Medium)");
  assertEquals(normalizeAspectValue("Medium", sel("Size", SIZE_PAREN)), "M (Medium)");
});

// ── Whole-word containment fallback ─────────────────────────────────────────

Deno.test("whole-word: Crew → 'Crew Neck' when unambiguous", () => {
  assertEquals(
    normalizeAspectValue("Crew", sel("Neckline", ["Crew Neck", "V-Neck", "Scoop Neck"])),
    "Crew Neck",
  );
});

// ── Ambiguity refusal & null (AC4) ──────────────────────────────────────────

Deno.test("ambiguity: refuses when more than one allowed value contains the token", () => {
  assertEquals(
    normalizeAspectValue("Long", sel("Style", ["Long Sleeve", "Long Coat"])),
    null,
  );
  // Cotton appears in two allowed values → no exact match, refuse.
  assertEquals(
    normalizeAspectValue("Cotton", sel("Material", ["100% Cotton", "Cotton Blend"])),
    null,
  );
});

Deno.test("null: no synonym, no token, no match → left for manual entry", () => {
  // US-3016 changed this deliberately: Chartreuse IS a green, and eBay's Color
  // list has no finer bucket to put it in, so narrowing beats an empty aspect.
  assertEquals(normalizeAspectValue("Chartreuse", sel("Color", ["Red", "Blue", "Green"])), "Green");
  // Still null when NO bucket in its family is offered by the category.
  assertEquals(normalizeAspectValue("Chartreuse", sel("Color", ["Red", "Blue"])), null);
  // SELECTION_ONLY with empty allowed list → null (can't validate).
  assertEquals(normalizeAspectValue("Red", sel("Color", [])), null);
  // Plus-size numeric is deliberately NOT merged with alpha sizes (conservative).
  assertEquals(normalizeAspectValue("1X", sel("Size", ["XL", "XXL"])), null);
});

Deno.test("never guesses across distinct semantic colors (Beige ≠ Tan)", () => {
  assertEquals(normalizeAspectValue("Beige", sel("Color", ["Tan", "Brown"])), null);
  // …but orthographic color variants do match (Grey → Gray).
  assertEquals(normalizeAspectValue("Grey", sel("Color", ["Gray", "Black"])), "Gray");
});

// ── US-3016: descriptive-value family narrowing ─────────────────────────────
//
// eBay's SELECTION_ONLY lists are coarse; the AI capture pass is not. These
// cover the bridge between them. Fixtures are eBay's real apparel lists.

const COLOR = [
  "Beige",
  "Black",
  "Blue",
  "Brown",
  "Gold",
  "Gray",
  "Green",
  "Ivory",
  "Multicolor",
  "Orange",
  "Pink",
  "Purple",
  "Red",
  "Silver",
  "White",
  "Yellow",
];
const DRESS_LENGTH = ["Short", "Knee Length", "Midi", "Long", "Hi-Low", "Asymmetric"];
const SKIRT_LENGTH = ["Mini", "Midi", "Maxi"];
const SLEEVE = ["Sleeveless", "Short Sleeve", "3/4 Sleeve", "Long Sleeve"];
const NECKLINE = ["Crew Neck", "V-Neck", "Scoop Neck", "Collared", "Hooded", "Turtleneck"];
const PATTERN = [
  "Solid",
  "Striped",
  "Plaid",
  "Floral",
  "Animal Print",
  "Graphic Print",
  "Camouflage",
];

Deno.test("color: a single-word descriptive color narrows to its eBay bucket", () => {
  assertEquals(normalizeAspectValue("Taupe", sel("Color", COLOR)), "Beige");
  assertEquals(normalizeAspectValue("Burgundy", sel("Color", COLOR)), "Red");
  assertEquals(normalizeAspectValue("Charcoal", sel("Color", COLOR)), "Gray");
  assertEquals(normalizeAspectValue("Teal", sel("Color", COLOR)), "Blue");
  assertEquals(normalizeAspectValue("Mustard", sel("Color", COLOR)), "Yellow");
  assertEquals(normalizeAspectValue("Cream", sel("Color", COLOR)), "Ivory");
  assertEquals(normalizeAspectValue("Lavender", sel("Color", COLOR)), "Purple");
  assertEquals(normalizeAspectValue("Coral", sel("Color", COLOR)), "Pink");
  assertEquals(normalizeAspectValue("Tie-Dye", sel("Color", COLOR)), "Multicolor");
});

Deno.test("color: a compound color reads right to left to find its base", () => {
  assertEquals(normalizeAspectValue("Sage Green", sel("Color", COLOR)), "Green");
  assertEquals(normalizeAspectValue("Light Blue", sel("Color", COLOR)), "Blue");
  assertEquals(normalizeAspectValue("Dark Olive Green", sel("Color", COLOR)), "Green");
  assertEquals(normalizeAspectValue("Heather Charcoal", sel("Color", COLOR)), "Gray");
  assertEquals(normalizeAspectValue("Rose Gold", sel("Color", COLOR)), "Gold");
});

Deno.test("color: the fallback prefers the exact bucket when the category has it", () => {
  // Navy is its own allowed value here, so step 3's equivalence group wins and
  // the family never runs.
  assertEquals(normalizeAspectValue("Navy Blue", sel("Color", ["Navy", "Blue"])), "Navy");
  // Without Navy, the family lands it on Blue rather than dropping it.
  assertEquals(normalizeAspectValue("Navy", sel("Color", COLOR)), "Blue");
});

Deno.test("length: the same value maps to whichever vocabulary the category uses", () => {
  assertEquals(normalizeAspectValue("Mini", sel("Dress Length", DRESS_LENGTH)), "Short");
  assertEquals(normalizeAspectValue("Mini", sel("Skirt Length", SKIRT_LENGTH)), "Mini");
  assertEquals(normalizeAspectValue("Maxi", sel("Dress Length", DRESS_LENGTH)), "Long");
  assertEquals(normalizeAspectValue("Maxi", sel("Skirt Length", SKIRT_LENGTH)), "Maxi");
  assertEquals(
    normalizeAspectValue("Above the Knee", sel("Dress Length", DRESS_LENGTH)),
    "Short",
  );
  assertEquals(normalizeAspectValue("Tea Length", sel("Dress Length", DRESS_LENGTH)), "Midi");
  assertEquals(normalizeAspectValue("High-Low", sel("Dress Length", DRESS_LENGTH)), "Hi-Low");
  assertEquals(
    normalizeAspectValue("Floor Length", sel("Dress Length", DRESS_LENGTH)),
    "Long",
  );
});

Deno.test("sleeve, neckline and pattern narrow the same way", () => {
  assertEquals(normalizeAspectValue("Tank", sel("Sleeve Length", SLEEVE)), "Sleeveless");
  assertEquals(normalizeAspectValue("Cap Sleeve", sel("Sleeve Length", SLEEVE)), "Short Sleeve");
  assertEquals(normalizeAspectValue("Elbow", sel("Sleeve Length", SLEEVE)), "3/4 Sleeve");
  assertEquals(normalizeAspectValue("Mock Neck", sel("Neckline", NECKLINE)), "Turtleneck");
  assertEquals(normalizeAspectValue("Button-Down", sel("Neckline", NECKLINE)), "Collared");
  assertEquals(normalizeAspectValue("Tartan", sel("Pattern", PATTERN)), "Plaid");
  assertEquals(normalizeAspectValue("Leopard", sel("Pattern", PATTERN)), "Animal Print");
  // ...and refused outright when the category offers no bucket for it.
  assertEquals(normalizeAspectValue("Leopard", sel("Pattern", ["Solid", "Striped"])), null);
  assertEquals(normalizeAspectValue("Camo", sel("Pattern", PATTERN)), "Camouflage");
});

Deno.test("family kind is picked by the most specific word in the aspect name", () => {
  // "Sleeve Length" is a sleeve, not a hem.
  assertEquals(normalizeAspectValue("Long", sel("Sleeve Length", SLEEVE)), "Long Sleeve");
  assertEquals(normalizeAspectValue("Long", sel("Dress Length", DRESS_LENGTH)), "Long");
  // "Hardware Color" is a color, not a piece of hardware.
  assertEquals(
    normalizeAspectValue("Gunmetal", sel("Hardware Color", ["Gold", "Silver", "Black"])),
    "Silver",
  );
});

Deno.test("family narrowing never fires on FREE_TEXT or an unmapped aspect", () => {
  // FREE_TEXT still passes the seller's own words straight through.
  assertEquals(
    normalizeAspectValue("Sage Green", { name: "Color", mode: "FREE_TEXT", allowedValues: [] }),
    "Sage Green",
  );
  // No family table for Brand, so an unknown value is still refused.
  assertEquals(normalizeAspectValue("Taupe", sel("Brand", ["Nike", "Adidas"])), null);
});

Deno.test("family narrowing runs LAST, so exact and synonym matches still win", () => {
  // Olive is offered outright — do not coarsen it to Green.
  assertEquals(normalizeAspectValue("Olive", sel("Color", ["Olive", "Green"])), "Olive");
  // Grey/Gray is an equivalence (step 3), not a family narrowing.
  assertEquals(normalizeAspectValue("Grey", sel("Color", COLOR)), "Gray");
});
