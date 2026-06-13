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
  assertEquals(normalizeAspectValue("Chartreuse", sel("Color", ["Red", "Blue", "Green"])), null);
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
