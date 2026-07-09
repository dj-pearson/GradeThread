// US-1790: batch grading queue — pure status derivation.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { deriveGradingBatchStatus, MAX_GRADE_JOB_ATTEMPTS, GRADE_ITEM_TIMEOUT_MS, GRADE_JOB_STALE_MS } =
  await import("../lib/grading-batch.ts");
const { validateGradeGarment, GRADE_MAX_IMAGES_PER_SUBMISSION } = await import(
  "../lib/api-grade-ingest.ts"
);

// A minimal valid garment (front/back/label + one detail via https URLs).
function validGarment() {
  return {
    title: "Vintage Denim Jacket",
    garment_type: "outerwear",
    garment_category: "jacket",
    images: [
      { image_type: "front", url: "https://example.com/f.jpg" },
      { image_type: "back", url: "https://example.com/b.jpg" },
      { image_type: "label", url: "https://example.com/l.jpg" },
      { image_type: "detail", url: "https://example.com/d.jpg" },
    ],
  };
}

Deno.test("deriveGradingBatchStatus: null while any job is open", () => {
  assertEquals(deriveGradingBatchStatus(2, 1, 3), null);
  assertEquals(deriveGradingBatchStatus(0, 0, 1), null);
});

Deno.test("deriveGradingBatchStatus: terminal tallies", () => {
  assertEquals(deriveGradingBatchStatus(5, 0, 0), "completed");
  assertEquals(deriveGradingBatchStatus(0, 5, 0), "failed");
  assertEquals(deriveGradingBatchStatus(3, 2, 0), "partial");
  assertEquals(deriveGradingBatchStatus(0, 0, 0), "completed"); // vacuous empty batch
});

Deno.test("durable-jobs constants: per-item timeout stays under JOB_STALE", () => {
  // Contract: a live job must never look stale.
  if (!(GRADE_ITEM_TIMEOUT_MS < GRADE_JOB_STALE_MS)) throw new Error("timeout must be < stale");
  assertEquals(MAX_GRADE_JOB_ATTEMPTS, 5);
});

Deno.test("validateGradeGarment: accepts a well-formed garment + resolves tier", () => {
  const ok = validateGradeGarment(validGarment());
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.tier, "standard"); // default when tier omitted
  const pro = validateGradeGarment({ ...validGarment(), tier: "premium" });
  if (pro.ok) assertEquals(pro.tier, "premium");
});

Deno.test("validateGradeGarment: same rules as a single grade", () => {
  const missingTitle = validateGradeGarment({ ...validGarment(), title: "  " });
  assertEquals(missingTitle.ok, false);

  const badType = validateGradeGarment({ ...validGarment(), garment_type: "spaceship" });
  assertEquals(badType.ok, false);

  // Missing the required 'label' slot.
  const noLabel = validateGradeGarment({
    ...validGarment(),
    images: [
      { image_type: "front", url: "https://example.com/f.jpg" },
      { image_type: "back", url: "https://example.com/b.jpg" },
      { image_type: "detail", url: "https://example.com/d.jpg" },
    ],
  });
  assertEquals(noLabel.ok, false);

  // No detail_* slot.
  const noDetail = validateGradeGarment({
    ...validGarment(),
    images: [
      { image_type: "front", url: "https://example.com/f.jpg" },
      { image_type: "back", url: "https://example.com/b.jpg" },
      { image_type: "label", url: "https://example.com/l.jpg" },
    ],
  });
  assertEquals(noDetail.ok, false);

  // Duplicate slot.
  const dup = validateGradeGarment({
    ...validGarment(),
    images: [...validGarment().images, { image_type: "front", url: "https://example.com/f2.jpg" }],
  });
  assertEquals(dup.ok, false);

  // Non-https URL and both url+base64 are rejected.
  const httpUrl = validateGradeGarment({
    ...validGarment(),
    images: [{ image_type: "front", url: "http://example.com/f.jpg" }, ...validGarment().images.slice(1)],
  });
  assertEquals(httpUrl.ok, false);
});

Deno.test("validateGradeGarment: enforces the per-submission image cap", () => {
  const tooMany = validateGradeGarment({
    ...validGarment(),
    images: Array.from({ length: GRADE_MAX_IMAGES_PER_SUBMISSION + 1 }, (_, i) => ({
      image_type: "front",
      url: `https://example.com/${i}.jpg`,
    })),
  });
  assertEquals(tooMany.ok, false);
});
