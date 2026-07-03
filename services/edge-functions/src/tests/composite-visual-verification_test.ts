// US-1537: composite visual verification — deterministic image selection,
// discrepancy-parse hardening, and the verification prompt addendum.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  normalizeVerificationDiscrepancies,
  selectVerificationImages,
  VISUAL_VERIFICATION_ADDENDUM,
} = await import("../lib/ai-grading.ts");

function analysis(
  imageType: string,
  issues: Array<{ severity: "minor" | "moderate" | "major"; intentional?: boolean }> = [],
) {
  return {
    image_type: imageType,
    detected_issues: issues.map((i) => ({
      issue: "x",
      defect_type: "stain",
      severity: i.severity,
      repairability: "permanent",
      size_bucket: "small",
      area_pct: null,
      size_confidence: 0.8,
      location: "front",
      is_intentional: i.intentional === true,
      bbox: null,
    })),
    style_attributes: [],
    condition_signals: [],
    estimated_scores: {
      fabric_condition: 7,
      structural_integrity: 7,
      cosmetic_appearance: 7,
      functional_elements: 7,
      odor_cleanliness: 7,
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("US-1537: selection leads front/back then the worst-defect angles", () => {
  const picked = selectVerificationImages([
    analysis("label"),
    analysis("back"),
    analysis("detail", [{ severity: "major" }]),
    analysis("front"),
    analysis("detail_2", [{ severity: "minor" }]),
  ]);
  assertEquals(picked, ["front", "back", "detail", "detail_2"]);
});

Deno.test("US-1537: cap respected; ties break by count then name (deterministic)", () => {
  const picked = selectVerificationImages(
    [
      analysis("front"),
      analysis("back"),
      analysis("detail_b", [{ severity: "moderate" }]),
      analysis("detail_a", [{ severity: "moderate" }, { severity: "minor" }]),
      analysis("detail_c", [{ severity: "major" }]),
    ],
    3,
  );
  // front, back, then the single worst (major) angle.
  assertEquals(picked, ["front", "back", "detail_c"]);

  const four = selectVerificationImages([
    analysis("front"),
    analysis("back"),
    analysis("detail_b", [{ severity: "moderate" }]),
    analysis("detail_a", [{ severity: "moderate" }, { severity: "minor" }]),
  ]);
  // Same severity: higher genuine-defect count wins (detail_a before detail_b).
  assertEquals(four, ["front", "back", "detail_a", "detail_b"]);
});

Deno.test("US-1537: intentional-only issues never make an image a defect angle", () => {
  const picked = selectVerificationImages([
    analysis("front"),
    analysis("flatlay", [{ severity: "major", intentional: true }]),
  ]);
  assertEquals(picked, ["front"]);
});

Deno.test("US-1537: missing front/back tolerated; clean sets pick nothing extra", () => {
  assertEquals(
    selectVerificationImages([analysis("label"), analysis("detail")]),
    [],
  );
  assertEquals(
    selectVerificationImages([
      analysis("back"),
      analysis("detail", [{ severity: "minor" }]),
    ]),
    ["back", "detail"],
  );
});

Deno.test("US-1537: discrepancy parse hardens against garbage", () => {
  assertEquals(normalizeVerificationDiscrepancies(undefined), []);
  assertEquals(normalizeVerificationDiscrepancies("not-an-array"), []);
  assertEquals(
    normalizeVerificationDiscrepancies([
      "front claimed clean; stain visible",
      "",
      42,
      { note: "x" },
      "  padded  ",
    ]),
    ["front claimed clean; stain visible", "padded"],
  );
  assertEquals(
    normalizeVerificationDiscrepancies(Array.from({ length: 30 }, () => "d")).length,
    10,
  );
});

Deno.test("US-1537: the addendum instructs verification before scoring", () => {
  assert(VISUAL_VERIFICATION_ADDENDUM.includes("VISUAL VERIFICATION"));
  assert(VISUAL_VERIFICATION_ADDENDUM.includes("verification_discrepancies"));
  assert(VISUAL_VERIFICATION_ADDENDUM.includes("Before finalizing factor scores"));
});
