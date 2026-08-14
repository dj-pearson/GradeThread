// US-2570: a certificate-number collision does not fail a paid grade.
//
// The uniqueness guarantee has always been the partial unique index (00307), not
// generateUniqueCertNumber()'s SELECT-then-INSERT loop — so a collision arrived
// at the grade_reports insert and threw "Failed to create grade report record".
// The money came back via reverseChargeForUngradedSubmission, but the seller
// lost the grade they had waited for.
//
// The dangerous version of this fix is a retry that swallows any 23505. That
// would paper over a real integrity violation forever, regenerating a
// certificate number while the actual problem went unreported — so the predicate
// is narrowed by CONSTRAINT NAME, and that is what most of this file pins.

import { assert, assertEquals } from "@std/assert";
import {
  CERT_NUMBER_CONSTRAINT,
  isCertificateNumberConflict,
  randomCertNumber,
} from "../lib/cert-number.ts";

Deno.test("a certificate-number collision is recognised", () => {
  assert(
    isCertificateNumberConflict({
      code: "23505",
      message:
        `duplicate key value violates unique constraint "${CERT_NUMBER_CONSTRAINT}"`,
    }),
  );
});

Deno.test("a DIFFERENT unique violation is NOT retried", () => {
  // The whole safety argument. grade_reports carries other unique constraints,
  // and treating one of those as a certificate collision would loop on it while
  // the real defect stayed invisible.
  assertEquals(
    isCertificateNumberConflict({
      code: "23505",
      message: 'duplicate key value violates unique constraint "grade_reports_pkey"',
    }),
    false,
  );
});

Deno.test("a non-23505 error is never a collision", () => {
  for (const error of [
    { code: "42703", message: `column "${CERT_NUMBER_CONSTRAINT}" does not exist` },
    { code: "23503", message: "foreign key violation" },
    { code: null, message: "network unreachable" },
    null,
    undefined,
  ]) {
    assertEquals(isCertificateNumberConflict(error), false, JSON.stringify(error));
  }
});

Deno.test("a 23505 with no message does not match", () => {
  // Fail closed. An unattributable unique violation is a real error, and
  // guessing it was the certificate number would retry the wrong thing.
  assertEquals(isCertificateNumberConflict({ code: "23505", message: null }), false);
  assertEquals(isCertificateNumberConflict({ code: "23505" }), false);
});

// ── The retry loop ─────────────────────────────────────────────────────────

/**
 * The loop's shape, exercised against a fake insert. The real one is 130 lines
 * of column literals inside processSubmission and reaches supabaseAdmin
 * directly; this models the control flow the story is actually about.
 */
async function insertWithRetry(
  attempts: number,
  insert: (certNumber: string) => Promise<{ error: { code?: string; message?: string } | null }>,
  regenerate: () => Promise<string>,
): Promise<{ ok: boolean; tries: number; lastNumber: string }> {
  let certNumber = "GT-AAAAAAA";
  let tries = 0;
  for (let i = 0; i < attempts; i++) {
    tries++;
    const { error } = await insert(certNumber);
    if (!error) return { ok: true, tries, lastNumber: certNumber };
    if (!isCertificateNumberConflict(error)) break;
    certNumber = await regenerate();
  }
  return { ok: false, tries, lastNumber: certNumber };
}

const COLLISION = {
  code: "23505",
  message: `duplicate key value violates unique constraint "${CERT_NUMBER_CONSTRAINT}"`,
};

Deno.test("a single collision retries once and succeeds", () => {
  let calls = 0;
  return insertWithRetry(
    3,
    () => Promise.resolve({ error: ++calls === 1 ? COLLISION : null }),
    () => Promise.resolve("GT-BBBBBBB"),
  ).then((out) => {
    assertEquals(out.ok, true);
    assertEquals(out.tries, 2);
    assertEquals(out.lastNumber, "GT-BBBBBBB", "the retry must use a NEW number");
  });
});

Deno.test("retries are BOUNDED — a persistent collision gives up", async () => {
  // Exhausting the bound still throws in the real path, which is what keeps the
  // existing refund behaviour intact.
  let calls = 0;
  const out = await insertWithRetry(
    3,
    () => {
      calls++;
      return Promise.resolve({ error: COLLISION });
    },
    () => Promise.resolve(randomCertNumber()),
  );
  assertEquals(out.ok, false);
  assertEquals(calls, 3);
});

Deno.test("a non-collision error stops IMMEDIATELY, without regenerating", async () => {
  let regenerated = 0;
  const out = await insertWithRetry(
    3,
    () => Promise.resolve({ error: { code: "23502", message: "null value in column" } }),
    () => {
      regenerated++;
      return Promise.resolve("GT-CCCCCCC");
    },
  );
  assertEquals(out.ok, false);
  assertEquals(out.tries, 1);
  assertEquals(regenerated, 0, "a real failure must not burn certificate numbers");
});

Deno.test("a first-try success never regenerates", async () => {
  let regenerated = 0;
  const out = await insertWithRetry(
    3,
    () => Promise.resolve({ error: null }),
    () => {
      regenerated++;
      return Promise.resolve("GT-DDDDDDD");
    },
  );
  assertEquals(out.ok, true);
  assertEquals(out.tries, 1);
  assertEquals(regenerated, 0);
});

// ── Wiring ─────────────────────────────────────────────────────────────────

Deno.test("the pipeline retries, logs, and still throws when exhausted", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  assert(
    src.includes("isCertificateNumberConflict(reportError)"),
    "the retry must be narrowed by the constraint predicate, not by 23505 alone",
  );
  assert(
    src.includes("CERT_NUMBER_INSERT_ATTEMPTS"),
    "the retry must be bounded by a named constant",
  );
  assert(
    /console\.warn\([\s\S]{0,200}certificate number collision/.test(src),
    "a collision must be logged with the submission id — otherwise the rate is " +
      "invisible and widening the code space has no evidence behind it",
  );
  assert(
    src.includes('throw new Error("Failed to create grade report record")'),
    "exhausting the retries must still throw, so reverseChargeForUngradedSubmission " +
      "still returns the money",
  );
  assert(
    src.includes("certificate_number: certificateNumberAttempt"),
    "the insert must use the REGENERATED number, not the original",
  );
});

Deno.test("the integrity hash is not invalidated by a regenerated number", async () => {
  // cert-integrity seals certificate_id, scores, tier and summary — not the
  // human-readable number. If it ever seals the number, this retry has to
  // recompute the hash too, and this test is the reminder.
  const integrity = await Deno.readTextFile(
    new URL("../lib/cert-integrity.ts", import.meta.url),
  );
  const fields = integrity.slice(
    integrity.indexOf("export interface CertIntegrityFields"),
    integrity.indexOf("export interface CertIntegrity {"),
  );
  assertEquals(
    /certificate_number/.test(fields),
    false,
    "cert integrity must not seal certificate_number, or US-2570's retry would " +
      "produce a certificate whose stored hash no longer matches its fields",
  );
});
