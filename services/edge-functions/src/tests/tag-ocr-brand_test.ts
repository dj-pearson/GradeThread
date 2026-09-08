// US-3139: brand off a raw OCR string. Pure — no Anthropic, no Supabase.
//   deno test src/tests/tag-ocr-brand_test.ts
import { assertEquals } from "@std/assert";
import {
  brandFromOcrText,
  repairOcrConfusions,
} from "../lib/tag-ocr-brand.ts";

// ── repairOcrConfusions ────────────────────────────────────────────────────

Deno.test("repairOcrConfusions folds the digits an engine mistakes for letters", () => {
  assertEquals(repairOcrConfusions("LEV1S"), "LEVIS");
  assertEquals(repairOcrConfusions("N0RTH FACE"), "NORTH FACE");
  assertEquals(repairOcrConfusions("5UPREME"), "SUPREME");
  assertEquals(repairOcrConfusions("8URBERRY"), "BURBERRY");
});

Deno.test("repairOcrConfusions leaves a genuine number alone", () => {
  // A digit surrounded by digits is a number, not a mangled letter.
  assertEquals(repairOcrConfusions("SIZE 32 X 34"), "SIZE 32 X 34");
  assertEquals(repairOcrConfusions("RN 105050"), "RN 105050");
  assertEquals(repairOcrConfusions("100% COTTON"), "100% COTTON");
});

// ── brandFromOcrText: the plain hits ───────────────────────────────────────

Deno.test("brandFromOcrText reads a canonical brand straight off the label", () => {
  assertEquals(
    brandFromOcrText("THE NORTH FACE\n100% NYLON\nMADE IN VIETNAM"),
    "The North Face",
  );
  assertEquals(brandFromOcrText("CARHARTT\nSIZE XL"), "Carhartt");
});

Deno.test("brandFromOcrText resolves a misspelling through the alias table", () => {
  assertEquals(brandFromOcrText("LEVIS\n505\n32 X 34"), "Levi's");
  assertEquals(brandFromOcrText("LEVI STRAUSS & CO"), "Levi's");
});

Deno.test("brandFromOcrText resolves a multi-word alias the scan would split", () => {
  // "THE NORTHFACE" is not the canonical spelling, so only the window lookup
  // reaches it.
  assertEquals(brandFromOcrText("THE NORTHFACE"), "The North Face");
});

Deno.test("brandFromOcrText survives the digit confusions", () => {
  assertEquals(brandFromOcrText("LEV1S 501"), "Levi's");
  assertEquals(brandFromOcrText("THE N0RTH FACE"), "The North Face");
});

Deno.test("brandFromOcrText is case and punctuation insensitive", () => {
  assertEquals(brandFromOcrText("patagonia."), "Patagonia");
  assertEquals(brandFromOcrText("  RALPH   LAUREN  "), "Ralph Lauren");
});

// ── brandFromOcrText: the things it must NOT say ───────────────────────────

Deno.test("brandFromOcrText refuses the ordinary-word brands on prose", () => {
  // Every one of these is a real canonical that DETECT_EXCLUDED_FROM_TEXT keeps
  // out of a text scan. A care label is prose, so the same guard applies here.
  assertEquals(brandFromOcrText("MOTHER OF PEARL BUTTONS"), null);
  assertEquals(brandFromOcrText("SUNGLASSES FRAME"), null);
  assertEquals(brandFromOcrText("A NEW ERA OF COMFORT"), null);
  assertEquals(brandFromOcrText("TURN GARMENT INSIDE OUT"), null);
});

Deno.test("brandFromOcrText finds nothing in a pure care instruction", () => {
  assertEquals(
    brandFromOcrText("MACHINE WASH COLD\nTUMBLE DRY LOW\nDO NOT BLEACH"),
    null,
  );
  assertEquals(brandFromOcrText("100% COTTON\nRN 12345\nMADE IN CHINA"), null);
});

Deno.test("brandFromOcrText is null for empty or speckle-only text", () => {
  assertEquals(brandFromOcrText(""), null);
  assertEquals(brandFromOcrText("   "), null);
  assertEquals(brandFromOcrText("~~ || .. --"), null);
  assertEquals(brandFromOcrText(null), null);
  assertEquals(brandFromOcrText(undefined), null);
});

Deno.test("brandFromOcrText prefers the longer brand when two could match", () => {
  // "Polo Ralph Lauren" must beat the contained "Ralph Lauren".
  assertEquals(brandFromOcrText("POLO RALPH LAUREN"), "Polo Ralph Lauren");
});

Deno.test("brandFromOcrText does not mint a brand out of a single stray letter run", () => {
  // Two-letter windows are not looked up: an OCR fragment is not a brand.
  assertEquals(brandFromOcrText("XL"), null);
  assertEquals(brandFromOcrText("S M L"), null);
});
