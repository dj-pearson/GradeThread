// US-775: human-review scoring + certificate-reseal helpers.
//
// cert-integrity.ts reads CERT_SIGNING_KEY at first use; set it BEFORE importing
// so the reseal produces a signature we can verify here.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("CERT_SIGNING_KEY", "test-cert-signing-key-human-review");

const {
  clampScore,
  computeWeightedOverall,
  scoreToGradeTier,
  resealCertificate,
} = await import("../lib/human-review.ts");
const { verifyCertIntegrity, _resetSigningKeyCacheForTest } = await import(
  "../lib/cert-integrity.ts"
);
_resetSigningKeyCacheForTest();

import type { FactorScores } from "../lib/human-review.ts";

// ── scoring ──────────────────────────────────────────────────────

Deno.test("clampScore bounds to 1..10 in 0.5 steps", () => {
  assertEquals(clampScore(0), 1);
  assertEquals(clampScore(11), 10);
  assertEquals(clampScore(7.3), 7.5);
  assertEquals(clampScore(7.1), 7.0);
  assertEquals(clampScore(NaN), 1);
});

Deno.test("computeWeightedOverall applies PRD weights, rounded to 0.5", () => {
  const all8: FactorScores = {
    fabric_condition_score: 8,
    structural_integrity_score: 8,
    cosmetic_appearance_score: 8,
    functional_elements_score: 8,
    odor_cleanliness_score: 8,
  };
  assertEquals(computeWeightedOverall(all8), 8); // weights sum to 1

  // 10*.30 + 6*.25 + 6*.20 + 6*.15 + 6*.10 = 3 + 1.5 + 1.2 + 0.9 + 0.6 = 7.2 → 7.0
  const mixed: FactorScores = {
    fabric_condition_score: 10,
    structural_integrity_score: 6,
    cosmetic_appearance_score: 6,
    functional_elements_score: 6,
    odor_cleanliness_score: 6,
  };
  assertEquals(computeWeightedOverall(mixed), 7.0);
});

Deno.test("scoreToGradeTier maps the boundaries", () => {
  assertEquals(scoreToGradeTier(10), "NWT");
  assertEquals(scoreToGradeTier(9), "NWOT");
  assertEquals(scoreToGradeTier(8), "Excellent");
  assertEquals(scoreToGradeTier(7), "Very Good");
  assertEquals(scoreToGradeTier(6), "Good");
  assertEquals(scoreToGradeTier(5), "Fair");
  assertEquals(scoreToGradeTier(3), "Poor");
});

// ── reseal (the correctness fix) ─────────────────────────────────

Deno.test("resealCertificate produces integrity that VERIFIES against the adjusted fields", async () => {
  const factors: FactorScores = {
    fabric_condition_score: 7.5,
    structural_integrity_score: 8.0,
    cosmetic_appearance_score: 7.0,
    functional_elements_score: 8.5,
    odor_cleanliness_score: 9.0,
  };
  const overall = computeWeightedOverall(factors);
  const tier = scoreToGradeTier(overall);

  const integrity = await resealCertificate({
    certificate_id: "cert-abc",
    overall_score: overall,
    grade_tier: tier,
    ...factors,
    ai_summary: "Adjusted by reviewer.",
    buyer_writeup: "Longer buyer-facing writeup.",
  });

  assert(integrity.content_hash.length === 64, "sha-256 hex");
  assert(integrity.content_signature, "signature present with CERT_SIGNING_KEY set");

  // The public verify path must accept the resealed hash over the SAME fields.
  const verify = await verifyCertIntegrity(
    {
      certificate_id: "cert-abc",
      overall_score: overall,
      grade_tier: tier,
      ...factors,
      ai_summary: "Adjusted by reviewer.",
      buyer_writeup: "Longer buyer-facing writeup.",
    },
    integrity.content_hash,
    integrity.content_signature,
    integrity.integrity_version,
  );
  assertEquals(verify.status, "verified");
  assert(verify.verified);
});

Deno.test("a reseal for adjusted scores does NOT verify against the OLD scores (tamper-evident)", async () => {
  const factors: FactorScores = {
    fabric_condition_score: 6.0,
    structural_integrity_score: 6.0,
    cosmetic_appearance_score: 6.0,
    functional_elements_score: 6.0,
    odor_cleanliness_score: 6.0,
  };
  const overall = computeWeightedOverall(factors);
  const integrity = await resealCertificate({
    certificate_id: "cert-xyz",
    overall_score: overall,
    grade_tier: scoreToGradeTier(overall),
    ...factors,
    ai_summary: "x",
    buyer_writeup: null,
  });

  // Verify against a DIFFERENT (stale) overall_score → mismatch.
  const verify = await verifyCertIntegrity(
    {
      certificate_id: "cert-xyz",
      overall_score: 9.0, // stale value an attacker (or un-resealed row) would carry
      grade_tier: "NWOT",
      ...factors,
      ai_summary: "x",
      buyer_writeup: null,
    },
    integrity.content_hash,
    integrity.content_signature,
    integrity.integrity_version,
  );
  assertEquals(verify.status, "mismatch");
});
