// US-543: tag-OCR ground-truth pass. normalizeTagOcr maps the model's verbatim
// read into TagGroundTruth; mergeTagGroundTruth folds confident reads into
// knownFields (tag wins) and surfaces them as authoritative. Both pure — no
// Anthropic call — so set dummy supabase env before importing (ai-config loads
// at module init via the supabase client).
//   deno test --allow-env src/tests/ai-tag-ocr_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  normalizeTagOcr,
  mergeTagGroundTruth,
  cleanCountryOfOrigin,
  tagAttributeFill,
  TAG_GROUND_TRUTH_MIN_CONFIDENCE,
  TAG_PHOTO_TYPES,
  TAG_OCR_FALLBACK_TYPES,
  selectTagOcrPhotos,
  planTagRoleWriteback,
  shouldRunTagRolePass,
} = await import("../lib/ai-tag-ocr.ts");

Deno.test("normalizeTagOcr keeps legible string fields and clamps confidence", () => {
  const fields = normalizeTagOcr({
    brand: "  Patagonia ",
    size: "M",
    fiber_content: "100% Organic Cotton",
    style_code: "STY-123",
    rn_number: "RN 51884",
    confidence: { brand: 0.95, size: 1.4, fiber_content: -0.2, style_code: 0.8 },
  });
  assertEquals(fields.brand, { value: "Patagonia", confidence: 0.95 });
  assertEquals(fields.size, { value: "M", confidence: 1 }); // clamped to 1
  assertEquals(fields.fiber_content, { value: "100% Organic Cotton", confidence: 0 }); // clamped to 0
  assertEquals(fields.style_code, { value: "STY-123", confidence: 0.8 });
  // rn_number returned but no confidence entry -> defaults to 0.
  assertEquals(fields.rn_number, { value: "RN 51884", confidence: 0 });
});

Deno.test("normalizeTagOcr omits empty/missing/non-string fields", () => {
  const fields = normalizeTagOcr({
    brand: "   ",
    size: 42, // not a string
    style_code: "",
    confidence: {},
  });
  assertEquals(fields, {});
});

Deno.test("normalizeTagOcr is safe on garbage input", () => {
  assertEquals(normalizeTagOcr(null), {});
  assertEquals(normalizeTagOcr("nope"), {});
  assertEquals(normalizeTagOcr({ confidence: "bad" }), {});
});

Deno.test("mergeTagGroundTruth: confident reads win over prior knownFields", () => {
  const known = { brand: "Unknown", size: "L", color: "blue" };
  const { merged, groundTruth } = mergeTagGroundTruth(known, {
    brand: { value: "Nike", confidence: 0.9 },
    size: { value: "M", confidence: 0.8 },
    fiber_content: { value: "100% Cotton", confidence: 0.7 },
    style_code: { value: "DZ1234", confidence: 0.6 },
    rn_number: { value: "RN 56789", confidence: 0.95 },
  });
  // Tag overrides brand/size; fiber -> material, style_code -> style.
  assertEquals(merged.brand, "Nike");
  assertEquals(merged.size, "M");
  assertEquals(merged.material, "100% Cotton");
  assertEquals(merged.style, "DZ1234");
  assertEquals(merged.rn_number, "RN 56789");
  // Untouched prior field survives.
  assertEquals(merged.color, "blue");
  // groundTruth surfaces only the tag-sourced subset, keyed for the prompt.
  assertEquals(groundTruth, {
    brand: "Nike",
    size: "M",
    material: "100% Cotton",
    style: "DZ1234",
    rn_number: "RN 56789",
  });
  // Pure: input is not mutated.
  assertEquals(known.brand, "Unknown");
});

Deno.test("mergeTagGroundTruth: low-confidence reads never clobber known-good values", () => {
  const known = { brand: "Levi's", size: "32" };
  const below = TAG_GROUND_TRUTH_MIN_CONFIDENCE - 0.01;
  const { merged, groundTruth } = mergeTagGroundTruth(known, {
    brand: { value: "Wrangler", confidence: below },
    size: { value: "34", confidence: 0.2 },
  });
  assertEquals(merged.brand, "Levi's"); // untouched
  assertEquals(merged.size, "32"); // untouched
  assertEquals(groundTruth, {}); // nothing authoritative
});

Deno.test("mergeTagGroundTruth: confidence exactly at threshold is accepted", () => {
  const { merged, groundTruth } = mergeTagGroundTruth(
    {},
    { brand: { value: "Carhartt", confidence: TAG_GROUND_TRUTH_MIN_CONFIDENCE } },
  );
  assertEquals(merged.brand, "Carhartt");
  assertEquals(groundTruth.brand, "Carhartt");
});

Deno.test("TAG_PHOTO_TYPES covers the tag/care-label photo types", () => {
  assertEquals(TAG_PHOTO_TYPES.has("tag"), true);
  assertEquals(TAG_PHOTO_TYPES.has("tag_2"), true);
  assertEquals(TAG_PHOTO_TYPES.has("front"), false);
  assertEquals(TAG_PHOTO_TYPES.has("detail"), false);
});

// ── 2026-09-02: the label's other three facts ────────────────────────────────

Deno.test("normalizeTagOcr keeps care, country and product line", () => {
  const fields = normalizeTagOcr({
    brand: "Nike",
    care_instructions: " Machine wash cold, tumble dry low ",
    country_of_origin: "Made in Vietnam",
    product_line: "Dri-FIT",
    confidence: { brand: 0.9, care_instructions: 0.8, country_of_origin: 0.95, product_line: 0.7 },
  });
  assertEquals(fields.care_instructions, { value: "Machine wash cold, tumble dry low", confidence: 0.8 });
  // The prefix is stripped at the read, so eBay's Country of Origin list
  // (bare names) has something to land on.
  assertEquals(fields.country_of_origin, { value: "Vietnam", confidence: 0.95 });
  assertEquals(fields.product_line, { value: "Dri-FIT", confidence: 0.7 });
});

Deno.test("cleanCountryOfOrigin strips the printed prefix in the languages labels use", () => {
  assertEquals(cleanCountryOfOrigin("Made in Vietnam"), "Vietnam");
  assertEquals(cleanCountryOfOrigin("MADE IN U.S.A."), "U.S.A");
  assertEquals(cleanCountryOfOrigin("Hecho en Mexico"), "Mexico");
  assertEquals(cleanCountryOfOrigin("Fabrique au Portugal"), "Portugal");
  assertEquals(cleanCountryOfOrigin("Vietnam"), "Vietnam");
  assertEquals(cleanCountryOfOrigin("  Sri Lanka. "), "Sri Lanka");
});

Deno.test("a country that is only a prefix is dropped, not stored as 'Made in'", () => {
  assertEquals(normalizeTagOcr({ country_of_origin: "Made in ", confidence: {} }), {});
});

Deno.test("mergeTagGroundTruth maps the new reads onto the attribute keys the registry uses", () => {
  const { merged, groundTruth } = mergeTagGroundTruth({}, {
    care_instructions: { value: "Hand wash", confidence: 0.9 },
    country_of_origin: { value: "Portugal", confidence: 0.9 },
    product_line: { value: "Align", confidence: 0.8 },
  });
  assertEquals(merged, {
    garment_care: "Hand wash",
    country_of_manufacture: "Portugal",
    product_line: "Align",
  });
  assertEquals(groundTruth, merged);
});

Deno.test("tagAttributeFill: confident reads land on attributes, fill-only", () => {
  const fill = tagAttributeFill(
    {
      style_code: { value: "CJ1682-010", confidence: 0.9 },
      care_instructions: { value: "Machine wash cold", confidence: 0.8 },
      country_of_origin: { value: "Vietnam", confidence: 0.95 },
      product_line: { value: "Dri-FIT", confidence: 0.7 },
      brand: { value: "Nike", confidence: 0.99 }, // not an attribute; ignored here
    },
    { product_line: "Tech Fleece" }, // the seller typed this one
  );
  assertEquals(fill, {
    garment_care: "Machine wash cold",
    country_of_manufacture: "Vietnam",
    // The label's style code IS the MPN eBay asks for.
    mpn: "CJ1682-010",
  });
});

Deno.test("tagAttributeFill: a low-confidence read never reaches the item", () => {
  const fill = tagAttributeFill(
    { country_of_origin: { value: "Vietnam", confidence: TAG_GROUND_TRUTH_MIN_CONFIDENCE - 0.01 } },
    null,
  );
  assertEquals(fill, {});
});

Deno.test("tagAttributeFill: an existing array or object value is respected", () => {
  const fill = tagAttributeFill(
    { care_instructions: { value: "Hand wash", confidence: 0.9 } },
    { garment_care: ["Machine Washable"] },
  );
  assertEquals(fill, {});
});

// 2026-09-02: which photos the OCR pass reads, and how a role pass may relabel.

Deno.test("selectTagOcrPhotos: tag-typed first, label-like fallbacks after, capped", () => {
  const photos = [
    { id: "d1", type: "detail" },
    { id: "m1", type: "marking" },
    { id: "t2", type: "tag_2" },
    { id: "i1", type: "interior" },
    { id: "t1", type: "tag" },
    { id: "x", type: "internal" },
    { id: "f", type: "front" },
  ];
  const picked = selectTagOcrPhotos(photos).map((p) => p.id);
  // tag types keep their input order, then the fallbacks in input order.
  assertEquals(picked, ["t2", "t1", "m1", "i1"]);
});

Deno.test("selectTagOcrPhotos: never picks internal, and honours the cap", () => {
  const photos = [
    { id: "x", type: "internal" },
    { id: "a", type: "tag" },
    { id: "b", type: "tag" },
    { id: "c", type: "tag_2" },
    { id: "d", type: "interior" },
    { id: "e", type: "marking" },
  ];
  assertEquals(selectTagOcrPhotos(photos, 2).map((p) => p.id), ["a", "b"]);
  assertEquals(selectTagOcrPhotos(photos).map((p) => p.id), ["a", "b", "c", "d"]);
  assertEquals(TAG_OCR_FALLBACK_TYPES.has("internal"), false);
});

Deno.test("selectTagOcrPhotos: empty when nothing label-like exists", () => {
  assertEquals(selectTagOcrPhotos([{ type: "front" }, { type: "detail" }]), []);
});

Deno.test("planTagRoleWriteback: classifier tags become OCR photos; only detail rows are relabelled", () => {
  const photos = [
    { id: "a", type: "front" },
    { id: "b", type: "detail" },
    { id: "c", type: "" },
    { id: "d", type: "back" },
  ];
  const { tagPhotos, writeback } = planTagRoleWriteback(photos, {
    a: "front",
    b: "tag",
    c: "tag",
    d: "tag", // seller typed it back; the classifier does not get to change that
  });
  assertEquals(tagPhotos.map((p) => p.id), ["b", "c", "d"]);
  assertEquals(writeback, ["b", "c"]);
});

Deno.test("planTagRoleWriteback: no tag in the roles yields nothing", () => {
  const { tagPhotos, writeback } = planTagRoleWriteback(
    [{ id: "a", type: "detail" }],
    { a: "detail" },
  );
  assertEquals(tagPhotos, []);
  assertEquals(writeback, []);
});

// US-3047: the role pass is a vision call, so it has to be worth one. The
// ledger showed tag OCR reaching 4% of drafts because the label was filed
// under `detail`; the fix asks the classifier which photo is the label. What
// it must NOT do is ask on an item where every photo already carries a
// deliberate role and none of them is a tag — there the answer is already
// known and the call is pure cost.
Deno.test("shouldRunTagRolePass: a detail-defaulted photo is worth asking about", () => {
  assertEquals(
    shouldRunTagRolePass([
      { id: "a", type: "front" },
      { id: "b", type: "detail" },
    ]),
    true,
  );
});

Deno.test("shouldRunTagRolePass: an untyped photo is worth asking about", () => {
  assertEquals(
    shouldRunTagRolePass([{ id: "a", type: "front" }, { id: "b" }]),
    true,
  );
  assertEquals(
    shouldRunTagRolePass([{ id: "a", type: "front" }, { id: "b", type: null }]),
    true,
  );
});

Deno.test("shouldRunTagRolePass: every photo already roled -> skip the call", () => {
  assertEquals(
    shouldRunTagRolePass([
      { id: "a", type: "front" },
      { id: "b", type: "back" },
      { id: "c", type: "defect" },
    ]),
    false,
  );
});

Deno.test("shouldRunTagRolePass: fewer than two identified photos -> skip", () => {
  assertEquals(shouldRunTagRolePass([{ id: "a", type: "detail" }]), false);
  assertEquals(shouldRunTagRolePass([]), false);
  // Photos with no id cannot be written back to, so they do not count.
  assertEquals(
    shouldRunTagRolePass([{ id: "a", type: "detail" }, { type: "detail" }]),
    false,
  );
});
