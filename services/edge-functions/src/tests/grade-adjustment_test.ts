// US-1293 / US-474: the shared grade-adjustment write used by the operator
// review queue (/api/admin/grading/review/:id/adjust) and dispute resolution.
//
// Covers the adjust → reseal → flag-cleared chain end-to-end against an injected
// in-memory client: corrected factor scores are written, the certificate is
// resealed (hash + signature + version) for a certified report, and the queue
// flags (human_reviewed / needs_human_review / claim lock) are cleared in the
// SAME atomic update — so a reviewed item leaves the queue and the claim frees.
//
// cert-integrity.ts reads CERT_SIGNING_KEY at first use; set it BEFORE importing.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("CERT_SIGNING_KEY", "test-cert-signing-key-grade-adjustment");

const { applyGradeAdjustment } = await import("../lib/grade-adjustment.ts");
const { verifyCertIntegrity, _resetSigningKeyCacheForTest } = await import(
  "../lib/cert-integrity.ts"
);
_resetSigningKeyCacheForTest();

import type { CheckedUpdateClient } from "../lib/db-write.ts";
import type { FactorScores } from "../lib/human-review.ts";

// A tiny CheckedUpdateClient that records the update payload + targeted id and
// reports exactly one affected row (so updateByIdChecked passes).
function makeCaptureClient() {
  const captured: { table?: string; id?: string; values?: Record<string, unknown> } = {};
  const client: CheckedUpdateClient = {
    from(table: string) {
      captured.table = table;
      return {
        update(values: Record<string, unknown>) {
          captured.values = values;
          return {
            eq(_column: string, value: string) {
              captured.id = value;
              return {
                select(_columns: string) {
                  return Promise.resolve({ data: [{ id: value }], error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, captured };
}

const FACTORS: FactorScores = {
  fabric_condition_score: 7.5,
  structural_integrity_score: 8.0,
  cosmetic_appearance_score: 7.0,
  functional_elements_score: 8.5,
  odor_cleanliness_score: 9.0,
};

Deno.test("adjust → reseal → flags cleared for a CERTIFIED report", async () => {
  const { client, captured } = makeCaptureClient();

  const result = await applyGradeAdjustment(
    client,
    {
      id: "report-1",
      certificate_id: "cert-1",
      ai_summary: "Adjusted by reviewer.",
      buyer_writeup: "Buyer-facing writeup.",
    },
    FACTORS,
    // The operator-queue caller's extras: clear the review flags + claim lock.
    { human_reviewed: true, needs_human_review: false, review_claimed_by: null, review_claimed_at: null },
  );

  // Reseal happened (certified report).
  assert(result.resealed, "a certified report must be resealed");
  assertEquals(captured.id, "report-1");
  const values = captured.values!;

  // Corrected per-factor scores were written.
  for (const k of Object.keys(FACTORS) as (keyof FactorScores)[]) {
    assertEquals(values[k], FACTORS[k]);
  }
  // Overall + tier recomputed: 7.5*.30 + 8*.25 + 7*.20 + 8.5*.15 + 9*.10
  // = 2.25 + 2.0 + 1.4 + 1.275 + 0.9 = 7.825 → 8.0 (half-point round).
  assertEquals(values.overall_score, 8.0);
  assertEquals(result.overall_score, 8.0);
  assertEquals(values.grade_tier, "Excellent");

  // Reseal fields present and the recomputed hash VERIFIES over the new fields.
  assert(typeof values.content_hash === "string" && (values.content_hash as string).length === 64);
  assert(values.content_signature, "signature present");
  const verify = await verifyCertIntegrity(
    {
      certificate_id: "cert-1",
      overall_score: 8.0,
      grade_tier: "Excellent",
      ...FACTORS,
      ai_summary: "Adjusted by reviewer.",
      buyer_writeup: "Buyer-facing writeup.",
    },
    values.content_hash as string,
    values.content_signature as string,
    values.integrity_version as number,
  );
  assertEquals(verify.status, "verified");

  // Queue flags + claim lock cleared in the same write.
  assertEquals(values.human_reviewed, true);
  assertEquals(values.needs_human_review, false);
  assertEquals(values.review_claimed_by, null);
  assertEquals(values.review_claimed_at, null);
});

Deno.test("adjust on an UN-certified report skips reseal but still clears flags", async () => {
  const { client, captured } = makeCaptureClient();

  const result = await applyGradeAdjustment(
    client,
    { id: "report-2", certificate_id: null, ai_summary: "x", buyer_writeup: null },
    FACTORS,
    { human_reviewed: true, needs_human_review: false, review_claimed_by: null, review_claimed_at: null },
  );

  assertEquals(result.resealed, false);
  const values = captured.values!;
  assertEquals(values.content_hash, undefined);
  assertEquals(values.human_reviewed, true);
  assertEquals(values.needs_human_review, false);
  assertEquals(values.review_claimed_by, null);
});
