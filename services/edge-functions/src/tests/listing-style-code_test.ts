// 2026-09-02: which style code a listing files under, and what the brand
// decoders make of it. Pure; dummy env because brand-knowledge imports supabase.
//   deno test --allow-env --allow-read src/tests/listing-style-code_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { resolveListingStyleCode } = await import("../lib/listing-style-code.ts");
const { assembleBrandKnowledgePack } = await import("../lib/brand-knowledge.ts");

// A Lululemon pack with NO db decoder rows, so decodeTagCode falls back to the
// in-code DEFAULT_DECODER_SPECS (style_number, style_number_2017,
// style_number_full, size_dot).
const lulu = assembleBrandKnowledgePack({
  canonical: "Lululemon",
  key: "lululemon",
  known: true,
  category: null,
  brandRow: null,
  styleRows: [],
  decoderRows: [],
  colorwayRows: [],
  dbCharts: [],
  fallbackCharts: [],
});

Deno.test("OCR style code outranks the item attribute and the sneaker resolver", () => {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "LW3CWDS", confidence: 0.9 } },
    itemAttributes: { mpn: "OLD-1" },
    sneakerStyleCode: "DD1391-100",
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(r.styleCodeRaw, "LW3CWDS");
  assertEquals(r.source, "tag_ocr");
  // US-2714: the leading L is a brand prefix; the code files under W3CWDS.
  assertEquals(r.styleCodeNorm, "W3CWDS");
  assertEquals(r.decoded?.decoderKind, "style_number_2017");
});

Deno.test("a low-confidence OCR read is skipped in favour of the stored mpn", () => {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "LW3CWDS", confidence: 0.2 } },
    itemAttributes: { mpn: "LW7DVCS" },
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(r.styleCodeRaw, "LW7DVCS");
  assertEquals(r.source, "item_attribute");
});

Deno.test("the sneaker resolver is the last resort", () => {
  const r = resolveListingStyleCode({
    ocr: null,
    itemAttributes: null,
    sneakerStyleCode: "DD1391-100",
    brand: "Nike",
    pack: null,
  });
  assertEquals(r.styleCodeRaw, "DD1391-100");
  assertEquals(r.source, "sneaker_resolver");
  assertEquals(r.decoded, null);
});

Deno.test("the whole size-dot string decodes and canonicalises to the six-character code", () => {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "LW6AMYSP60417", confidence: 0.85 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assert(r.decoded, "expected a decoder hit");
  assertEquals(r.styleCodeNorm, "W6AMYS");
});

Deno.test("a bare size-dot number is not a code to file under", () => {
  // The size-dot decoder is region-scoped and off by default; "8" on its own
  // is a size, not a style code, and the index's minimum length keeps it out.
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "8", confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(r.styleCodeRaw, null);
  assertEquals(r.decoded, null);
});

Deno.test("no brand pack: the raw code is kept, nothing decodes", () => {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "ABC-123", confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Some Brand",
    pack: null,
  });
  assertEquals(r.styleCodeRaw, "ABC-123");
  assertEquals(r.decoded, null);
  assertEquals(r.styleCodeNorm, "ABC123");
});

Deno.test("nothing anywhere: null code, empty norm", () => {
  const r = resolveListingStyleCode({
    ocr: null,
    itemAttributes: {},
    sneakerStyleCode: null,
    brand: null,
    pack: null,
  });
  assertEquals(r, { styleCodeRaw: null, styleCodeNorm: "", source: null, decoded: null });
});
