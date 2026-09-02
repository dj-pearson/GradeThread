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
  styleCodeRimWindows,
  rimDecoderSpecs,
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

// ── US-3086: the rim is a circle, so the OCR can start anywhere on it ───────

/** What the listing path files, for a code read off a Lululemon size dot. */
function luluCode(raw: string, pack: typeof lulu | null = lulu) {
  return resolveListingStyleCode({
    ocr: { style_code: { value: raw, confidence: 0.85 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack,
  });
}

Deno.test("a rim transcribed from a random start point still decodes to its style number", () => {
  // Real strings from the 2026-09-02 prod backfill (US-3085), filed raw because
  // styleCodeSpellings only ever tried PREFIXES of what the model returned.
  const start = luluCode("LW3DUTS224000011302");
  assertEquals(start.styleCodeRaw, "LW3DUTS");
  assertEquals(start.styleCodeNorm, "W3DUTS");
  assertEquals(start.decoded?.decoderKind, "style_number_2017");

  const short = luluCode("LW5EGTS253");
  assertEquals(short.styleCodeRaw, "LW5EGTS");
  assertEquals(short.styleCodeNorm, "W5EGTS");

  // The same salvage from the STORED attribute, with no OCR at all: this is
  // what backfill-tag-reads.ts --redo-undecoded re-plans from (US-3086 AC3).
  const stored = resolveListingStyleCode({
    ocr: null,
    itemAttributes: { mpn: "LW3DUTS224000011302" },
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(stored.source, "item_attribute");
  assertEquals(stored.styleCodeNorm, "W3DUTS");

  // Eleven characters of date block before the code, and the colour initial
  // came back as the digit that looks like it (O read as 0).
  const midCircle = luluCode("0000F80000DLW5B0303");
  assertEquals(midCircle.styleCodeRaw, "LW5B03O");
  assertEquals(midCircle.styleCodeNorm, "W5B03O");
  assertEquals(midCircle.decoded?.decoderKind, "style_number_2017");
});

Deno.test("a rim whose colour slot is a digit no decoder shape accepts is left as read", () => {
  // The other two of the five. Neither can be salvaged without INVENTING a
  // character, and a made-up style code is filed, indexed and shown to buyers.
  //
  // S7502T9LM4C847: the only W/M is the M of "LM4C847", so the colour slot is
  //   forced to the trailing "7", and 7 is not in CONFUSABLE_LETTER, so every
  //   letter of the alphabet fits there equally well, so the decoder proves
  //   nothing about which one was printed.
  // ERNSFD78042289140204: contains no W and no M in any rotation, so no
  //   anchored Lululemon shape can match any window of it at all.
  for (const raw of ["S7502T9LM4C847", "ERNSFD78042289140204"]) {
    const r = luluCode(raw);
    assertEquals(r.styleCodeRaw, raw);
    assertEquals(r.decoded, null);
  }
});

Deno.test("the rotation search never fires outside a resolved pack", () => {
  // Same rim, no pack: the brand key alone must not buy a substring search.
  const noPack = luluCode("0000F80000DLW5B0303", null);
  assertEquals(noPack.styleCodeRaw, "0000F80000DLW5B0303");
  assertEquals(noPack.decoded, null);
  assertEquals(styleCodeRimWindows("0000F80000DLW5B0303", []), []);

  // A brand whose pack carries no decoders at all gets no windows either.
  assertEquals(rimDecoderSpecs("nike", []), []);
  // ...and the size-dot decoder stays out of the search, so a two-digit window
  // can never be read as a size.
  assertEquals(
    rimDecoderSpecs("lululemon", []).map((s) => s.decoderKind),
    ["style_number", "style_number_2017", "style_number_full"],
  );

  // A Nike style code and an unknown brand's code are untouched by any of this.
  const nike = resolveListingStyleCode({
    ocr: { style_code: { value: "DD1391-100", confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Nike",
    pack: null,
  });
  assertEquals(nike.styleCodeRaw, "DD1391-100");
  assertEquals(nike.decoded, null);
  const unknown = resolveListingStyleCode({
    ocr: { style_code: { value: "ABC-123", confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Some Brand",
    pack: null,
  });
  assertEquals(unknown.styleCodeRaw, "ABC-123");
  assertEquals(unknown.decoded, null);
});

Deno.test("styleCodeRimWindows: exact windows first, in spec order, repairs last", () => {
  const specs = rimDecoderSpecs("lululemon", []);
  // The code as read is never returned - the caller has already tried it.
  assert(!styleCodeRimWindows("LW3DUTS224000011302", specs).includes(
    "LW3DUTS224000011302",
  ));
  assertEquals(styleCodeRimWindows("LW3DUTS224000011302", specs)[0], "LW3DUTS");
  // Label prose is not a style code: "WOMENS" matches the 2017 shape exactly
  // and carries no digit, which is what tells the two apart.
  assertEquals(styleCodeRimWindows("SCUBAWOMENSHOODIE", specs), []);
  assertEquals(luluCode("SCUBAWOMENSHOODIE").decoded, null);
  // A code that already reads straight through offers only itself without the
  // brand prefix, which canonicalises to the same six characters.
  assertEquals(styleCodeRimWindows("LW5EGTS", specs), ["W5EGTS"]);
  // Nothing at or below the length a code needs to be an identity is searched.
  assertEquals(styleCodeRimWindows("W5EG", specs), []);
  // A repaired window is only offered when nothing matched as transcribed.
  assertEquals(styleCodeRimWindows("0000F80000DLW5B0303", specs), [
    "LW5B03O",
    "W5B03O",
  ]);
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
