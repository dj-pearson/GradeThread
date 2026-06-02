// Unit tests for the photo-authenticity aggregation (US-336/US-338).
//
// aggregateAuthenticity is pure — it synthesizes per-image manipulation /
// screenshot flags into the garment-level signal. ai-grading.ts imports the
// service-role supabase client at load, so set dummy env BEFORE the dynamic
// import.
//
//   deno test --allow-env src/tests/authenticity_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { aggregateAuthenticity } = await import("../lib/ai-grading.ts");

type Authenticity = {
  manipulation_suspected: boolean;
  manipulation_confidence: number;
  tells: string[];
  screenshot_or_watermark: boolean;
  screenshot_watermark_reason: string;
};

// Minimal PerImageAnalysis with an authenticity block.
function img(imageType: string, a?: Partial<Authenticity>) {
  return {
    image_type: imageType,
    detected_issues: [],
    condition_signals: [],
    style_attributes: [],
    estimated_scores: {
      fabric_condition: 8,
      structural_integrity: 8,
      cosmetic_appearance: 8,
      functional_elements: 8,
      odor_cleanliness: 8,
    },
    authenticity: a
      ? {
          manipulation_suspected: false,
          manipulation_confidence: 0,
          tells: [],
          screenshot_or_watermark: false,
          screenshot_watermark_reason: "",
          ...a,
        }
      : undefined,
  };
}

Deno.test("clean images → passed, not suspected", () => {
  const r = aggregateAuthenticity([img("front"), img("back", {})]);
  assertEquals(r.manipulation_suspected, false);
  assertEquals(r.screenshot_or_watermark_detected, false);
  assertEquals(r.flagged_image_types, []);
  assert(r.summary.toLowerCase().includes("passed"));
});

Deno.test("low-confidence manipulation flag is treated as noise", () => {
  const r = aggregateAuthenticity([
    img("front", { manipulation_suspected: true, manipulation_confidence: 0.4, tells: ["faint smudge"] }),
  ]);
  assertEquals(r.manipulation_suspected, false);
  assertEquals(r.flagged_image_types, []);
});

Deno.test("confident manipulation escalates with tells + image type + max confidence", () => {
  const r = aggregateAuthenticity([
    img("front", { manipulation_suspected: true, manipulation_confidence: 0.7, tells: ["cloned texture at knee"] }),
    img("defect", { manipulation_suspected: true, manipulation_confidence: 0.85, tells: ["smoothing near hem"] }),
    img("back"),
  ]);
  assertEquals(r.manipulation_suspected, true);
  assertEquals(r.manipulation_confidence, 0.85);
  assertEquals(r.flagged_image_types.sort(), ["defect", "front"]);
  assert(r.tells.includes("cloned texture at knee"));
  assert(r.tells.includes("smoothing near hem"));
  assert(r.summary.includes("human review"));
});

Deno.test("screenshot/watermark is detected independently of manipulation", () => {
  const r = aggregateAuthenticity([
    img("front", { screenshot_or_watermark: true, screenshot_watermark_reason: "eBay UI visible" }),
  ]);
  assertEquals(r.screenshot_or_watermark_detected, true);
  assertEquals(r.manipulation_suspected, false);
  assert(r.flagged_image_types.includes("front"));
  assert(r.tells.includes("eBay UI visible"));
});

Deno.test("missing authenticity blocks (historical/eval traces) are ignored safely", () => {
  const r = aggregateAuthenticity([img("front"), img("back")]);
  assertEquals(r.manipulation_suspected, false);
  assertEquals(r.tells, []);
});
