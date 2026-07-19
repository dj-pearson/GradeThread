// US-2145: seller appeal mechanics — withdrawal, reseal contract, and what an
// appeal outcome does (and deliberately does not) imply. Pure logic.

import { assert, assertEquals } from "@std/assert";
import {
  resealFieldsAfterWithdrawal,
  resolveAppeal,
  validateAppeal,
  withdrawAssessment,
} from "../lib/authenticity-appeal.ts";
import type { CertIntegrityFields } from "../lib/cert-integrity.ts";

const NOW = "2026-07-19T12:00:00Z";

Deno.test("withdrawal CLEARS the verdict rather than flipping it to authentic", () => {
  // An upheld appeal means the assessment should never have been published. It
  // does not mean we now positively vouch for the item — asserting that would be
  // the same overreach in the other direction.
  const w = withdrawAssessment(
    { verdict: "red_flags", verdict_confidence: 0.5, summary: "Stitching irregular." },
    "Seller supplied the retail receipt.",
    NOW,
  );
  assert(w);
  assertEquals(w.verdict, null);
  assertEquals(w.verdict_confidence, null);
  assertEquals(w.withdrawn, true);
  assertEquals(w.withdrawn_at, NOW);
});

Deno.test("withdrawal preserves what was originally said", () => {
  // The record of the original assessment survives; only the operative verdict
  // goes. Erasing it would destroy the evidence an appeal was even necessary.
  const w = withdrawAssessment(
    { verdict: "red_flags", summary: "Stitching irregular.", limitations: "Photo-only." },
    "receipt",
    NOW,
  );
  assertEquals(w?.summary, "Stitching irregular.");
  assertEquals(w?.limitations, "Photo-only.");
});

Deno.test("withdrawal of a non-existent assessment is a no-op", () => {
  assertEquals(withdrawAssessment(null, "reason", NOW), null);
});

Deno.test("the reseal clears the verdict and leaves the SCORES untouched", () => {
  // An authenticity appeal says nothing about the garment's condition. Silently
  // re-deriving a grade here would change a number nobody contested.
  const current = {
    certificate_id: "CERT-1",
    overall_score: 7.4,
    grade_tier: "very_good",
    fabric_condition_score: 7,
    structural_integrity_score: 8,
    cosmetic_appearance_score: 7,
    functional_elements_score: 8,
    odor_cleanliness_score: 7,
    ai_summary: "Solid.",
    authenticity_verdict: "red_flags",
    authenticity_verdict_confidence: 0.5,
  } as CertIntegrityFields;

  const next = resealFieldsAfterWithdrawal(current);
  assertEquals(next.authenticity_verdict, null);
  assertEquals(next.authenticity_verdict_confidence, null);
  assertEquals(next.overall_score, 7.4);
  assertEquals(next.grade_tier, "very_good");
  assertEquals(next.ai_summary, "Solid.");
});

Deno.test("an upheld appeal withdraws, reseals, and yields an 'authentic' case", () => {
  const r = resolveAppeal("upheld");
  assertEquals(r.withdraw, true);
  assertEquals(r.promoteAsAuthentic, true);
  // A confirmed FALSE POSITIVE is the most valuable label the system can get —
  // it is the error direction nothing else measures.
  assertEquals(r.reviewerVerdict, "authentic");
});

Deno.test("a REJECTED appeal produces no golden-set case", () => {
  // Upholding the original verdict is not the same as a human independently
  // confirming the item is counterfeit — the reviewer may just have found the
  // appeal unpersuasive. Treating that as ground truth would seed the golden set
  // with labels nobody verified.
  const r = resolveAppeal("rejected");
  assertEquals(r.withdraw, false);
  assertEquals(r.promoteAsAuthentic, false);
  assertEquals(r.reviewerVerdict, null);
});

Deno.test("an appeal needs a substantive reason", () => {
  const ok = { grade_report_id: "abc", reason: "I have the original retail receipt and tags." };
  assertEquals(validateAppeal(ok), null);

  assert(validateAppeal({ reason: ok.reason })?.includes("grade_report_id"));
  assert(validateAppeal({ grade_report_id: "abc", reason: "wrong" })?.includes("describe"));
  assert(validateAppeal({ grade_report_id: "abc" })?.includes("describe"));
});
