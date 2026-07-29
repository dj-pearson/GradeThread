// US-2213: a verified size on the certificate.
//
// The rules under test:
//   1. Two readings, neither of them the seller's — `submissions` has no size
//      column, so the comparison is label-read vs measurement-derived.
//   2. Agreement strengthens; disagreement WEAKENS and is recorded, and neither
//      reading is treated as the correction.
//   3. Below the bar, or no evidence at all, means NO size — never a guess, and
//      never a confidence penalty on the condition grade.
//   4. Size is informational: the composite prompt's factor weights and scoring
//      instructions are untouched (AC4).
//   5. Absent => every prompt is byte-identical to the US-2210/2212 shape.
//
//   deno test --allow-env --allow-read src/tests/grading-size_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  resolveSizeVerification,
  sizeVerificationLine,
  sizeVerifyGradingEnabled,
  SIZE_DERIVE_MIN_CONFIDENCE,
} = await import("../lib/grading-size.ts");
const { acceptedTagFields, tagGroundTruthBlock } = await import(
  "../lib/tag-ground-truth.ts"
);
const { buildCompositeUserPrompt } = await import("../lib/ai-grading.ts");
const { SIZE_ESTIMATE_LOW_CONFIDENCE, isMeasurementPhoto } = await import(
  "../lib/ai-size-estimate-core.ts"
);

const labelField = (value: string, confidence = 0.9) =>
  acceptedTagFields({ size: { value, confidence } }).find((a) => a.field === "size");

const derived = (size: string, confidence = 0.8, gender: string | null = "Women") => ({
  size,
  gender,
  confidence,
  rationale: "Waist 27in maps to a 6 on the brand chart.",
});

const GARMENT = {
  garment_type: "bottoms",
  garment_category: "pants",
  brand: "Lululemon",
  title: "Align pant",
  description: null,
  style_attributes: [],
};
// deno-lint-ignore no-explicit-any
const ANALYSES = [{ image_type: "front", observations: "clean" }] as any;

// ── 1/2. Combining the two readings ─────────────────────────────────────────

Deno.test("label alone is reported as a label read", () => {
  const v = resolveSizeVerification(labelField("M"), null);
  assertEquals(v?.size, "M");
  assertEquals(v?.source, "label");
  assertEquals(v?.confidence, 0.9);
});

Deno.test("measurements alone are reported as an inference, not a reading", () => {
  const v = resolveSizeVerification(undefined, derived("6"));
  assertEquals(v?.size, "6");
  assertEquals(v?.source, "measurements");
  assertEquals(v?.gender, "Women");
  // This is the case the whole feature exists for: no legible size label.
  assertStringIncludes(sizeVerificationLine(v), "derived from the measurement photos");
});

Deno.test("agreement is stronger than either reading alone", () => {
  const v = resolveSizeVerification(labelField("6", 0.7), derived("6", 0.85));
  assertEquals(v?.source, "label_and_measurements");
  // Independent agreement takes the HIGHER confidence.
  assertEquals(v?.confidence, 0.85);
  assertStringIncludes(sizeVerificationLine(v), "independently confirmed");
});

Deno.test("formatting differences are not a disagreement", () => {
  for (const [a, b] of [["W30 L32", "w30l32"], ["W30-L32", "W30 L32"], [" M ", "M"]]) {
    const v = resolveSizeVerification(labelField(a), derived(b));
    assertEquals(v?.source, "label_and_measurements", `${a} vs ${b}`);
    assertEquals(v?.disagreement, undefined);
  }
});

Deno.test("a real disagreement WEAKENS the result and records both readings", () => {
  const v = resolveSizeVerification(labelField("M", 0.95), derived("XL", 0.8));
  // The label is shown — a transcription beats an inference...
  assertEquals(v?.size, "M");
  assertEquals(v?.source, "label");
  // ...but a contested reading is weaker than an uncontested one, so the
  // confidence drops to the LOWER of the two rather than keeping the label's.
  assertEquals(v?.confidence, 0.8);
  assertEquals(v?.disagreement, { label: "M", measurements: "XL" });
});

Deno.test("a disagreement is surfaced without either side being called correct", () => {
  const line = sizeVerificationLine(
    resolveSizeVerification(labelField("M"), derived("XL")),
  );
  assertStringIncludes(line, "does NOT match the label");
  assertStringIncludes(line, "neither has been treated as correct");
});

Deno.test("M vs Medium is reported as a disagreement rather than silently unified", () => {
  // Deliberate: brands label in their own vocabulary, and inventing an
  // equivalence is how a FALSE agreement gets asserted. A human can dismiss a
  // spurious flag; a false agreement is silent.
  const v = resolveSizeVerification(labelField("M"), derived("Medium"));
  assert(v?.disagreement, "expected M vs Medium to be flagged, not unified");
});

// ── 3. No evidence means no size ────────────────────────────────────────────

Deno.test("a below-bar derived size is discarded, not shown", () => {
  assertEquals(
    resolveSizeVerification(undefined, derived("6", SIZE_DERIVE_MIN_CONFIDENCE - 0.01)),
    null,
  );
  assert(
    resolveSizeVerification(undefined, derived("6", SIZE_DERIVE_MIN_CONFIDENCE)) !== null,
  );
});

Deno.test("the derive bar is the existing low-confidence boundary, not a new number", () => {
  // A size too soft for the AutoLister to call an answer is far too soft to
  // print on a certificate. One threshold, one meaning, two callers.
  assertEquals(SIZE_DERIVE_MIN_CONFIDENCE, SIZE_ESTIMATE_LOW_CONFIDENCE);
});

Deno.test("no evidence at all yields no size", () => {
  assertEquals(resolveSizeVerification(undefined, null), null);
  assertEquals(resolveSizeVerification(undefined, derived("", 0.99)), null);
  assertEquals(resolveSizeVerification(undefined, derived("   ", 0.99)), null);
});

Deno.test("a below-bar derived size falls back to the label rather than blocking it", () => {
  const v = resolveSizeVerification(labelField("M"), derived("XL", 0.2));
  assertEquals(v?.source, "label");
  // The weak inference must not raise a disagreement it is not entitled to.
  assertEquals(v?.disagreement, undefined);
});

Deno.test("the rollout gate is OFF unless explicitly enabled", () => {
  const prior = Deno.env.get("GRADING_SIZE_VERIFY");
  try {
    Deno.env.delete("GRADING_SIZE_VERIFY");
    assertEquals(sizeVerifyGradingEnabled(), false);
    Deno.env.set("GRADING_SIZE_VERIFY", "false");
    assertEquals(sizeVerifyGradingEnabled(), false);
    for (const on of ["1", "true", "YES", "on"]) {
      Deno.env.set("GRADING_SIZE_VERIFY", on);
      assertEquals(sizeVerifyGradingEnabled(), true, on);
    }
  } finally {
    if (prior === undefined) Deno.env.delete("GRADING_SIZE_VERIFY");
    else Deno.env.set("GRADING_SIZE_VERIFY", prior);
  }
});

Deno.test("the pipeline's photo gate matches the measurement predicate", () => {
  // The gate is what keeps the feature free on submissions with no flat-lays.
  for (const t of ["measurement_chest", "measurement_waist", "measurement_inseam", "flatlay"]) {
    assert(isMeasurementPhoto(t), `${t} should gate the size pass on`);
  }
  for (const t of ["front", "back", "label", "detail", "defect", undefined]) {
    assert(!isMeasurementPhoto(t), `${t} must not gate the size pass on`);
  }
});

// ── 4. Size is informational: scoring untouched (AC4) ───────────────────────

Deno.test("a verified size changes the identity block and NOTHING about scoring", () => {
  const accepted = acceptedTagFields({ brand: { value: "Lululemon", confidence: 0.9 } });
  const v = resolveSizeVerification(undefined, derived("6"));
  const block = tagGroundTruthBlock(accepted, null, v);
  const withSize = buildCompositeUserPrompt(ANALYSES, GARMENT, "", "", block);
  const without = buildCompositeUserPrompt(ANALYSES, GARMENT);

  const weights =
    "Apply the factor weights (Fabric 30%, Structural 25%, Cosmetic 20%, Functional 15%, Odor 10%)";
  assertStringIncludes(withSize, weights);
  assertStringIncludes(without, weights);
  // The ONLY difference is the trusted identity block.
  assertEquals(withSize.replace(`\n${block}\n`, ""), without);
});

Deno.test("the block names the size's PROVENANCE, not just the size", () => {
  // "Size: M" and "Size: M, inferred from a flat-lay" are different claims and
  // only the second is honest about being an inference.
  const readOff = tagGroundTruthBlock([], null, resolveSizeVerification(labelField("M"), null));
  assertStringIncludes(readOff, "read from the size label");
  const inferred = tagGroundTruthBlock([], null, resolveSizeVerification(undefined, derived("6")));
  assertStringIncludes(inferred, "derived from the measurement photos");
});

Deno.test("a verified size supersedes the raw size line instead of duplicating it", () => {
  const accepted = acceptedTagFields({
    brand: { value: "Lululemon", confidence: 0.9 },
    size: { value: "6", confidence: 0.9 },
  });
  const block = tagGroundTruthBlock(accepted, null, resolveSizeVerification(
    accepted.find((a) => a.field === "size"),
    derived("6"),
  ));
  // Exactly one line mentions the size.
  const sizeLines = block.split("\n").filter((l) => l.startsWith("- Size:"));
  assertEquals(sizeLines.length, 1);
  assert(!block.includes("- Size: 6\n- Size:"), "size must not be stated twice");
});

// ── 5. Strictly additive ────────────────────────────────────────────────────

Deno.test("no size verification leaves the block byte-identical to the US-2212 shape", () => {
  const accepted = acceptedTagFields({ brand: { value: "Lululemon", confidence: 0.9 } });
  assertEquals(tagGroundTruthBlock(accepted, null, null), tagGroundTruthBlock(accepted, null));
  assertEquals(tagGroundTruthBlock(accepted, null), tagGroundTruthBlock(accepted));
});

Deno.test("no fields, no era and no size still means no block at all", () => {
  assertEquals(tagGroundTruthBlock([], null, null), "");
});

Deno.test("a size alone is enough to render a block", () => {
  // An illegible label can still be sized from the flat-lays, and that is the
  // motivating case for the whole feature.
  const block = tagGroundTruthBlock([], null, resolveSizeVerification(undefined, derived("6")));
  assertStringIncludes(block, "Size: Women 6");
});

Deno.test("sizeVerificationLine renders nothing for no verification", () => {
  assertEquals(sizeVerificationLine(null), "");
});
