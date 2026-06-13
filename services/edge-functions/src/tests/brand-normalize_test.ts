// US-544: brand canonicalization + style-code resolution. All pure functions —
// no Anthropic/Supabase — so no env setup is needed.
//   deno test src/tests/brand-normalize_test.ts
import { assertEquals } from "@std/assert";
import {
  applyCanonicalBrandAndStyle,
  canonicalizeBrand,
  detectBrandInText,
  isKnownBrand,
  resolveStyleCode,
} from "../lib/brand-normalize.ts";

// ── canonicalizeBrand ──────────────────────────────────────────────────────

Deno.test("canonicalizeBrand maps known aliases to the eBay-canonical name", () => {
  assertEquals(canonicalizeBrand("Levis"), "Levi's");
  assertEquals(canonicalizeBrand("levi"), "Levi's");
  assertEquals(canonicalizeBrand("LEVI STRAUSS"), "Levi's");
  assertEquals(canonicalizeBrand("the northface"), "The North Face");
  assertEquals(canonicalizeBrand("TNF"), "The North Face");
  // eBay-canonical casing is preserved exactly (lowercase adidas, upper GUESS).
  assertEquals(canonicalizeBrand("Adidas"), "adidas");
  assertEquals(canonicalizeBrand("guess"), "GUESS");
  assertEquals(canonicalizeBrand("abercrombie & fitch"), "Abercrombie & Fitch");
});

Deno.test("canonicalizeBrand is punctuation/space/case insensitive on the key", () => {
  assertEquals(canonicalizeBrand("L.L. Bean"), "L.L.Bean");
  assertEquals(canonicalizeBrand("under-armour"), "Under Armour");
  assertEquals(canonicalizeBrand("  TOMMY   HILFIGER "), "Tommy Hilfiger");
});

Deno.test("canonicalizeBrand passes unknown brands through cleaned, not nulled", () => {
  assertEquals(canonicalizeBrand("Acme Vintage Co"), "Acme Vintage Co");
  assertEquals(canonicalizeBrand("  Some   Brand  "), "Some Brand");
});

Deno.test("canonicalizeBrand returns null for empty/blank/nullish", () => {
  assertEquals(canonicalizeBrand(null), null);
  assertEquals(canonicalizeBrand(undefined), null);
  assertEquals(canonicalizeBrand(""), null);
  assertEquals(canonicalizeBrand("   "), null);
});

Deno.test("isKnownBrand only true for curated entries", () => {
  assertEquals(isKnownBrand("Levis"), true);
  assertEquals(isKnownBrand("nike"), true);
  assertEquals(isKnownBrand("Acme Vintage Co"), false);
  assertEquals(isKnownBrand(null), false);
  assertEquals(isKnownBrand(""), false);
});

// ── detectBrandInText (US-598 barcode autofill) ────────────────────────────

Deno.test("detectBrandInText pulls a canonical brand out of a product title", () => {
  assertEquals(
    detectBrandInText("The North Face Men's Apex Bionic Jacket Medium Black"),
    "The North Face",
  );
  assertEquals(detectBrandInText("Nike Air Max 90 Running Shoes"), "Nike");
  // Case-insensitive on the title side.
  assertEquals(detectBrandInText("vintage CARHARTT duck chore coat"), "Carhartt");
});

Deno.test("detectBrandInText prefers the longest (most specific) brand", () => {
  assertEquals(
    detectBrandInText("Polo Ralph Lauren Oxford Shirt Large"),
    "Polo Ralph Lauren",
  );
});

Deno.test("detectBrandInText is word-boundary matched (no substring false hits)", () => {
  // "Gap" must not fire inside "Gaps".
  assertEquals(detectBrandInText("Closes the Gaps Performance Tee"), null);
  // But a standalone token does match.
  assertEquals(detectBrandInText("Gap 1969 Slim Jeans 32x30"), "Gap");
});

Deno.test("detectBrandInText returns null for no match / empty", () => {
  assertEquals(detectBrandInText("Generic Cotton T-Shirt"), null);
  assertEquals(detectBrandInText(""), null);
  assertEquals(detectBrandInText(null), null);
  assertEquals(detectBrandInText(undefined), null);
});

// ── resolveStyleCode ───────────────────────────────────────────────────────

Deno.test("resolveStyleCode resolves a curated code to a canonical product", () => {
  const r = resolveStyleCode("CW2288-111");
  assertEquals(r?.brand, "Nike");
  assertEquals(r?.exact, true);
  assertEquals(r?.compQuery, "CW2288-111");
  assertEquals(r?.aspects.Brand, ["Nike"]);
  assertEquals(r?.aspects.Model, ["Air Force 1 '07"]);
  assertEquals(r?.aspects.Department, ["Men"]);
});

Deno.test("resolveStyleCode normalizes spacing/case before curated lookup", () => {
  const r = resolveStyleCode("  cw2288 111 ");
  assertEquals(r?.brand, "Nike");
  assertEquals(r?.exact, true);
  assertEquals(r?.styleCode, "CW2288-111");
});

Deno.test("resolveStyleCode infers brand from Nike/adidas/NB formats", () => {
  assertEquals(resolveStyleCode("DV0833-100")?.brand, "Nike"); // 2 letters+4-3
  assertEquals(resolveStyleCode("555088-061")?.brand, "Nike"); // 6-3 numeric
  assertEquals(resolveStyleCode("GZ5230")?.brand, "adidas"); // 2 letters+4
  assertEquals(resolveStyleCode("S79166")?.brand, "adidas"); // 1 letter+5
  assertEquals(resolveStyleCode("M990GL6")?.brand, "New Balance");
  // Inferred (non-curated) codes are not exact.
  assertEquals(resolveStyleCode("DV0833-100")?.exact, false);
});

Deno.test("resolveStyleCode returns null for non-style 'style' values", () => {
  assertEquals(resolveStyleCode("Slim Fit"), null);
  assertEquals(resolveStyleCode("Relaxed"), null);
  assertEquals(resolveStyleCode(""), null);
  assertEquals(resolveStyleCode(null), null);
});

Deno.test("resolveStyleCode uses a sneaker brandHint for unrecognized-format codes", () => {
  // Unknown format, but a known sneaker brand + alphanumeric code -> treat as code.
  const r = resolveStyleCode("ABC1234X", "Nike");
  assertEquals(r?.brand, "Nike");
  assertEquals(r?.exact, false);
  assertEquals(r?.compQuery, "ABC1234X");
  // Non-sneaker brand hint does NOT force a code match.
  assertEquals(resolveStyleCode("ABC1234X", "Levi's"), null);
});

// ── applyCanonicalBrandAndStyle ───────────────────────────────────────────

Deno.test("applyCanonicalBrandAndStyle forces canonical Brand (replaces model value)", () => {
  const out = applyCanonicalBrandAndStyle(
    { Brand: ["Levis"], Color: ["Blue"] },
    "Levi's",
    null,
  );
  assertEquals(out.Brand, ["Levi's"]);
  assertEquals(out.Color, ["Blue"]); // untouched
});

Deno.test("applyCanonicalBrandAndStyle honors an allowedNames constraint for Brand casing", () => {
  // The category's canonical aspect name casing wins.
  const out = applyCanonicalBrandAndStyle(
    { brand: ["Levis"] },
    "Levi's",
    null,
    ["Brand", "Size", "Color"],
  );
  assertEquals(out.Brand, ["Levi's"]);
});

Deno.test("applyCanonicalBrandAndStyle skips Brand when the category omits it", () => {
  const out = applyCanonicalBrandAndStyle(
    { Color: ["Blue"] },
    "Levi's",
    null,
    ["Size", "Color"], // no Brand allowed
  );
  assertEquals(out.Brand, undefined);
});

Deno.test("applyCanonicalBrandAndStyle adds style aspects only when allowed and absent", () => {
  const resolution = resolveStyleCode("CW2288-111")!;
  const out = applyCanonicalBrandAndStyle(
    { Department: ["Women"] }, // model already set Department -> keep it
    "Nike",
    resolution,
    ["Brand", "Model", "Department", "Type"],
  );
  assertEquals(out.Brand, ["Nike"]);
  assertEquals(out.Model, ["Air Force 1 '07"]); // allowed + absent -> filled
  assertEquals(out.Department, ["Women"]); // model value preserved, not clobbered
  assertEquals(out.Type, ["Athletic"]);
});

Deno.test("applyCanonicalBrandAndStyle skips product aspects with no allowedNames constraint", () => {
  const resolution = resolveStyleCode("CW2288-111")!;
  const out = applyCanonicalBrandAndStyle({}, "Nike", resolution);
  // Brand still forced (universally safe), but Model/Type are NOT pushed
  // unconstrained (would risk publish rejection in a non-shoe category).
  assertEquals(out.Brand, ["Nike"]);
  assertEquals(out.Model, undefined);
  assertEquals(out.Type, undefined);
});

Deno.test("applyCanonicalBrandAndStyle is pure (does not mutate input)", () => {
  const input = { Brand: ["Levis"] };
  applyCanonicalBrandAndStyle(input, "Levi's", null);
  assertEquals(input.Brand, ["Levis"]);
});
