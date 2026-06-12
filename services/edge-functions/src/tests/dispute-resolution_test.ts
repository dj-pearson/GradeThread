// US-474: admin grade-correction / dispute writes must actually persist.
//
// The old dispute UI mutated grade_reports/disputes/submissions via the BROWSER
// Supabase client; with no admin UPDATE policy those writes no-oped under RLS
// while reporting success. The fix moves them to a service-role edge route that
// VERIFIES a row changed (updateByIdChecked) and reseals the certificate on a
// grade adjustment (applyGradeAdjustment). These tests assert both guarantees
// against an in-memory fake client:
//   1. an admin adjustment is persisted and readable back from the DB (AC3),
//      and its resealed certificate verifies as authentic;
//   2. a by-id write that matches no row surfaces a real error (AC2).
//
// cert-integrity.ts reads CERT_SIGNING_KEY at first use; set it BEFORE importing.
import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.env.set("CERT_SIGNING_KEY", "test-cert-signing-key-dispute-resolution");

const { applyGradeAdjustment } = await import("../lib/grade-adjustment.ts");
const { updateByIdChecked, ZeroRowsAffectedError } = await import(
  "../lib/db-write.ts"
);
const { verifyCertIntegrity, _resetSigningKeyCacheForTest } = await import(
  "../lib/cert-integrity.ts"
);
_resetSigningKeyCacheForTest();

import type { CheckedUpdateClient } from "../lib/db-write.ts";
import type { FactorScores } from "../lib/human-review.ts";

// ── In-memory fake of the supabase-js update→eq→select chain ──────────
// Implements just enough of the client for updateByIdChecked: an UPDATE matched
// by a column equality, returning the affected rows' ids — and a get() so the
// test can read the row back exactly as a later SELECT would.
class FakeDb {
  private tables: Record<string, Map<string, Record<string, unknown>>> = {};

  seed(table: string, row: Record<string, unknown>) {
    (this.tables[table] ??= new Map()).set(row.id as string, { ...row });
  }

  get(table: string, id: string): Record<string, unknown> | null {
    return this.tables[table]?.get(id) ?? null;
  }

  from(table: string) {
    const store = (this.tables[table] ??= new Map());
    return {
      update: (values: Record<string, unknown>) => ({
        eq: (column: string, value: string) => ({
          select: (_columns: string) => {
            const affected: Array<{ id: string }> = [];
            for (const [id, row] of store) {
              if (row[column] === value) {
                Object.assign(row, values);
                affected.push({ id });
              }
            }
            return Promise.resolve({ data: affected, error: null });
          },
        }),
      }),
    };
  }
}

const ALL_FIVE = (n: number): FactorScores => ({
  fabric_condition_score: n,
  structural_integrity_score: n,
  cosmetic_appearance_score: n,
  functional_elements_score: n,
  odor_cleanliness_score: n,
});

// ── 1. adjustment persists + is readable back + reseals authentically ──

Deno.test("admin grade adjustment is persisted and readable back from the DB", async () => {
  const db = new FakeDb();
  db.seed("grade_reports", {
    id: "gr-1",
    submission_id: "sub-1",
    certificate_id: "cert-1",
    ai_summary: "AI summary",
    buyer_writeup: "Buyer writeup",
    overall_score: 5.0,
    grade_tier: "Fair",
    ...ALL_FIVE(5),
  });

  const factors = ALL_FIVE(8);
  const result = await applyGradeAdjustment(
    db as unknown as CheckedUpdateClient,
    {
      id: "gr-1",
      certificate_id: "cert-1",
      ai_summary: "AI summary",
      buyer_writeup: "Buyer writeup",
    },
    factors,
    { human_reviewed: true, needs_human_review: false },
  );

  assertEquals(result.overall_score, 8);
  assertEquals(result.grade_tier, "Excellent");
  assert(result.resealed, "a certified report reseals");

  // Read the row back exactly as a follow-up SELECT would.
  const row = db.get("grade_reports", "gr-1");
  assert(row, "row still present");
  assertEquals(row.overall_score, 8);
  assertEquals(row.grade_tier, "Excellent");
  assertEquals(row.fabric_condition_score, 8);
  assertEquals(row.human_reviewed, true);
  assertEquals(row.needs_human_review, false);
  assert(typeof row.content_hash === "string", "content_hash was resealed");

  // The persisted, resealed certificate must VERIFY over the NEW fields — a
  // human-corrected certificate stays authentic (US-475).
  const verify = await verifyCertIntegrity(
    {
      certificate_id: "cert-1",
      overall_score: 8,
      grade_tier: "Excellent",
      ...factors,
      ai_summary: "AI summary",
      buyer_writeup: "Buyer writeup",
    },
    row.content_hash as string,
    row.content_signature as string | null,
    row.integrity_version as number,
  );
  assertEquals(verify.status, "verified");
  assert(verify.verified);
});

// ── 2. a by-id write matching no row surfaces a real error ─────────────

Deno.test("updateByIdChecked throws ZeroRowsAffectedError when no row matches", async () => {
  const db = new FakeDb();
  db.seed("disputes", { id: "d-1", status: "open" });

  // Wrong id → 0 rows → throw (the bug being fixed: the old client path
  // reported success on a 0-row no-op).
  await assertRejects(
    () =>
      updateByIdChecked(db as unknown as CheckedUpdateClient, "disputes", "missing", {
        status: "resolved",
      }),
    ZeroRowsAffectedError,
  );

  // The matching id updates and is readable back.
  await updateByIdChecked(db as unknown as CheckedUpdateClient, "disputes", "d-1", {
    status: "resolved",
  });
  assertEquals(db.get("disputes", "d-1")?.status, "resolved");
});
