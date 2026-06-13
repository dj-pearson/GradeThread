// Unit tests for the pure helpers of the premium authenticity / counterfeit-
// confidence add-on (US-601). ai-authenticity.ts transitively imports the
// service-role supabase client at module load, so we set dummy env first and
// dynamic-import (mirrors shopify-client_test.ts).
//   deno test src/tests/ai-authenticity_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  deriveCounterfeitRisk,
  normalizeAuthenticityAssessment,
  selectAuthenticityImages,
  AUTHENTICITY_LIMITATIONS,
  AUTHENTICITY_PROMPT_VERSION,
} = await import("../lib/ai-authenticity.ts");

Deno.test("deriveCounterfeitRisk: no recognizable brand → indeterminate", () => {
  assertEquals(deriveCounterfeitRisk(0.9, 0, false), "indeterminate");
  assertEquals(deriveCounterfeitRisk(0.1, 5, false), "indeterminate");
});

Deno.test("deriveCounterfeitRisk: high confidence, no flags → low", () => {
  assertEquals(deriveCounterfeitRisk(0.95, 0, true), "low");
  assertEquals(deriveCounterfeitRisk(0.6, 0, true), "low");
});

Deno.test("deriveCounterfeitRisk: low confidence OR any flag → elevated", () => {
  assertEquals(deriveCounterfeitRisk(0.5, 0, true), "elevated");
  assertEquals(deriveCounterfeitRisk(0.9, 1, true), "elevated");
});

Deno.test("deriveCounterfeitRisk: flags AND very low confidence → high", () => {
  assertEquals(deriveCounterfeitRisk(0.3, 2, true), "high");
  assertEquals(deriveCounterfeitRisk(0.39, 1, true), "high");
});

Deno.test("normalizeAuthenticityAssessment: clean model output", () => {
  const a = normalizeAuthenticityAssessment(
    {
      is_brand_recognizable: true,
      brand_assessed: "Nike",
      authenticity_confidence: 0.91,
      signals_examined: ["brand label font", "swoosh print"],
      red_flags: [],
      supporting_signals: ["correct heat-transfer tag", "even stitching"],
      summary: "Consistent with a genuine Nike example.",
    },
    "claude-test",
  );
  assert(a.assessed);
  assertEquals(a.authenticity_confidence, 0.91);
  assertEquals(a.counterfeit_risk, "low");
  assertEquals(a.brand_assessed, "Nike");
  assertEquals(a.supporting_signals.length, 2);
  assertEquals(a.model, "claude-test");
  assertEquals(a.prompt_version, AUTHENTICITY_PROMPT_VERSION);
  // Disclosure is ALWAYS the fixed constant, never trusted to the model.
  assertEquals(a.limitations, AUTHENTICITY_LIMITATIONS);
});

Deno.test("normalizeAuthenticityAssessment: garbage → cautious indeterminate", () => {
  const a = normalizeAuthenticityAssessment(null, "m");
  assert(a.assessed);
  assertEquals(a.authenticity_confidence, 0.5);
  assertEquals(a.counterfeit_risk, "indeterminate");
  assertEquals(a.brand_assessed, null);
  assertEquals(a.red_flags, []);
  assertEquals(a.limitations, AUTHENTICITY_LIMITATIONS);
});

Deno.test("normalizeAuthenticityAssessment: clamps confidence + drops brand when unrecognized", () => {
  const a = normalizeAuthenticityAssessment(
    {
      is_brand_recognizable: false,
      brand_assessed: "Gucci", // ignored because brand not recognizable
      authenticity_confidence: 2.5, // out of range → clamped to 1
      red_flags: ["", "  ", "misaligned logo"],
    },
    "m",
  );
  assertEquals(a.authenticity_confidence, 1);
  assertEquals(a.brand_assessed, null);
  assertEquals(a.counterfeit_risk, "indeterminate");
  // Empty/whitespace red flags filtered out.
  assertEquals(a.red_flags, ["misaligned logo"]);
});

Deno.test("selectAuthenticityImages: prioritizes label/detail and caps at 6", () => {
  const imgs = [
    { imageType: "front" },
    { imageType: "back" },
    { imageType: "label" },
    { imageType: "detail" },
    { imageType: "detail_2" },
    { imageType: "defect" },
    { imageType: "label_2" },
    { imageType: "detail_3" },
  ];
  const picked = selectAuthenticityImages(imgs);
  assertEquals(picked.length, 6);
  // label + label_2 + the details should come before front/back/defect.
  assertEquals(picked[0].imageType, "label");
  assertEquals(picked[1].imageType, "label_2");
  assert(!picked.some((p) => p.imageType === "defect"));
});
