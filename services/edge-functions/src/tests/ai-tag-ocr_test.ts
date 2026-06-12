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
  TAG_GROUND_TRUTH_MIN_CONFIDENCE,
  TAG_PHOTO_TYPES,
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
