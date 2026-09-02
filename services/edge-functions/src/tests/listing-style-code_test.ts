// 2026-09-02: which style code a listing files under, and what the brand
// decoders make of it. Pure; dummy env because brand-knowledge imports supabase.
//   deno test --allow-env --allow-read src/tests/listing-style-code_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  resolveListingStyleCode,
  styleCodeSpellings,
  learnedStyleForListing,
  applyLearnedStyleToListing,
  STYLE_NAME_GROUND_TRUTH_KEY,
} = await import("../lib/listing-style-code.ts");
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

Deno.test("the whole rim as OCR'd, with S read as 5, decodes to the style number", () => {
  // Prod dry run 2026-09-02: the dot showed LM5609S.0419 around "36"; the
  // model returned the full rim with the colour letter read as a digit.
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "LM56095.0419.000054.000", confidence: 0.72 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(r.styleCodeRaw, "LM5609S.0419");
  assertEquals(r.styleCodeNorm, "M5609S");
  assertEquals(r.decoded?.decoderKind, "style_number");
  assertEquals(r.decoded?.season, "Winter");
  assertEquals(r.decoded?.year, "2019");
});

Deno.test("styleCodeSpellings: original first, prefixes, then the letter-slot fix", () => {
  assertEquals(styleCodeSpellings("LM56095.0419.000054.000"), [
    "LM56095.0419.000054.000",
    "LM56095.0419",
    "LM56095",
    "LM5609S.0419.000054.000",
    "LM5609S.0419",
    "LM5609S",
  ]);
  assertEquals(styleCodeSpellings("DD1391-100"), ["DD1391-100"]);
  // A spelling that decodes nowhere leaves the code as read.
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "ABC-125.99", confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Some Brand",
    pack: null,
  });
  assertEquals(r.styleCodeRaw, "ABC-125.99");
  assertEquals(r.decoded, null);
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

// ── the product name from the style-code index ─────────────────────────────

Deno.test("learnedStyleForListing: a resolved name is a fact, an observation is only a candidate", () => {
  const resolved = learnedStyleForListing(
    {
      productTitle: "Scuba Oversized Half-Zip",
      seenCount: 4,
      confidence: 0.8,
      evidenceUrl: null,
      resolvedName: "Scuba Oversized Half-Zip",
      resolvedSource: "consensus",
    },
    "Lululemon",
    "LW3CWDS",
  );
  assertEquals(resolved.resolvedName, "Scuba Oversized Half-Zip");
  assertEquals(resolved.resolvedSource, "consensus");
  assertEquals(resolved.candidateName, null);

  const observed = learnedStyleForListing(
    {
      productTitle: "Lululemon Scuba Oversized Half Zip LW3CWDS Womens Size 6 Black EUC",
      seenCount: 2,
      confidence: 0.5,
      evidenceUrl: null,
    },
    "Lululemon",
    "LW3CWDS",
  );
  assertEquals(observed.resolvedName, null);
  assert(observed.candidateName && observed.candidateName.toLowerCase().includes("scuba"));

  assertEquals(learnedStyleForListing(null, "Lululemon", "LW3CWDS").resolvedName, null);
});

Deno.test("applyLearnedStyleToListing: fills style, the ground-truth block and attributes.model, fill-only", () => {
  const out = applyLearnedStyleToListing({
    learned: {
      resolvedName: "Scuba Oversized Half-Zip",
      resolvedSource: "consensus",
      candidateName: null,
      confidence: 0.8,
    },
    knownFields: { brand: "Lululemon", style: "LW3CWDS" },
    tagGroundTruth: { brand: "Lululemon" },
    tagAttributes: { mpn: "W3CWDS" },
    sellerTypedStyle: null,
  });
  assertEquals(out.knownFields.style, "Scuba Oversized Half-Zip");
  assertEquals(out.tagGroundTruth?.[STYLE_NAME_GROUND_TRUTH_KEY], "Scuba Oversized Half-Zip");
  assertEquals(out.tagGroundTruth?.brand, "Lululemon");
  assertEquals(out.tagAttributes.model, "Scuba Oversized Half-Zip");
  assertEquals(out.tagAttributes.mpn, "W3CWDS");
});

Deno.test("applyLearnedStyleToListing: a seller-typed style is never replaced; a candidate writes nothing", () => {
  const typed = applyLearnedStyleToListing({
    learned: {
      resolvedName: "Scuba Oversized Half-Zip",
      resolvedSource: "consensus",
      candidateName: null,
      confidence: 0.8,
    },
    knownFields: { style: "Hooded Scuba" },
    tagGroundTruth: undefined,
    tagAttributes: {},
    sellerTypedStyle: "Hooded Scuba",
  });
  assertEquals(typed.knownFields.style, "Hooded Scuba");
  assertEquals(typed.tagGroundTruth?.[STYLE_NAME_GROUND_TRUTH_KEY], "Scuba Oversized Half-Zip");
  assertEquals(typed.tagAttributes.model, "Scuba Oversized Half-Zip");

  const guess = applyLearnedStyleToListing({
    learned: {
      resolvedName: null,
      resolvedSource: null,
      candidateName: "Scuba Oversized Half Zip",
      confidence: 0.5,
    },
    knownFields: {},
    tagGroundTruth: undefined,
    tagAttributes: {},
    sellerTypedStyle: null,
  });
  assertEquals(guess.knownFields.style, undefined);
  assertEquals(guess.tagGroundTruth, undefined);
  assertEquals(guess.tagAttributes.model, undefined);
});
