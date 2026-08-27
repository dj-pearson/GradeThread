// US-2937: the SNAD accuracy signal.
//
// The refusals are the feature. A buyer types "not as described" for reasons
// that have nothing to do with the grade — wrong size, screen colour, or
// because it is the reason that gets free return postage. So this module is
// judged on what it DOES NOT record:
//
//   • a non-SNAD reason,
//   • a case with no local item (nothing to attribute the signal to),
//   • an item with no grade report (no grade to hold accountable),
//   • the same order twice, when a return and its escalated case both land.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  NON_SALE_OUTCOME_SOURCES,
  SNAD_OUTCOME_SOURCE,
  isSnadObservation,
  recordSnadObservations,
} = await import("../lib/grade-snad-signal.ts");
import type { SnadCandidate, SnadSignalDeps } from "../lib/grade-snad-signal.ts";

Deno.test("isSnadObservation needs a condition complaint AND a linked item", () => {
  assert(isSnadObservation({
    caseId: "r1",
    reason: "NOT_AS_DESCRIBED",
    inventoryItemId: "i1",
    saleId: "s1",
  }));
  assertEquals(
    isSnadObservation({
      caseId: "r2",
      reason: "BUYER_CHANGED_MIND",
      inventoryItemId: "i1",
      saleId: "s1",
    }),
    false,
    "a changed-mind return says nothing about the grade",
  );
  assertEquals(
    isSnadObservation({
      caseId: "r3",
      reason: "NOT_AS_DESCRIBED",
      inventoryItemId: null,
      saleId: null,
    }),
    false,
    "an unlinked case would put a signal against nothing",
  );
});

function makeDeps(
  candidates: SnadCandidate[],
  reports: Record<string, string>,
): { deps: SnadSignalDeps; written: Array<{ gradeReportId: string; saleId: string | null }> } {
  const written: Array<{ gradeReportId: string; saleId: string | null }> = [];
  return {
    written,
    deps: {
      loadCandidates: () => Promise.resolve(candidates),
      loadReportIds: (itemIds) =>
        Promise.resolve(
          new Map(itemIds.filter((id) => reports[id]).map((id) => [id, reports[id]!])),
        ),
      record: (rows) => {
        for (const r of rows) written.push({ gradeReportId: r.gradeReportId, saleId: r.saleId });
        return Promise.resolve(rows.length);
      },
    },
  };
}

Deno.test("a SNAD return on a graded item records exactly one observation", async () => {
  const { deps, written } = makeDeps(
    [{ caseId: "r1", reason: "NOT_AS_DESCRIBED", inventoryItemId: "i1", saleId: "s1" }],
    { i1: "report-1" },
  );
  assertEquals(await recordSnadObservations("u1", deps), 1);
  assertEquals(written, [{ gradeReportId: "report-1", saleId: "s1" }]);
});

Deno.test("a non-SNAD reason produces NO observation", async () => {
  const { deps, written } = makeDeps(
    [{ caseId: "r1", reason: "BUYER_CHANGED_MIND", inventoryItemId: "i1", saleId: "s1" }],
    { i1: "report-1" },
  );
  assertEquals(await recordSnadObservations("u1", deps), 0);
  assertEquals(written.length, 0);
});

Deno.test("an ungraded item produces no observation, and is not an error", async () => {
  // Most sellers list plenty of ungraded stock. This is the common case, not a
  // failure, and it must not log or throw.
  const { deps, written } = makeDeps(
    [{ caseId: "r1", reason: "NOT_AS_DESCRIBED", inventoryItemId: "i1", saleId: "s1" }],
    {},
  );
  assertEquals(await recordSnadObservations("u1", deps), 0);
  assertEquals(written.length, 0);
});

Deno.test("a return and its escalated case on one order write ONE row", async () => {
  // Both are SNAD, both link to the same item and sale. Two rows would race the
  // same unique index and, worse, would read as two disputes on one garment.
  const { deps, written } = makeDeps(
    [
      { caseId: "r1", reason: "NOT_AS_DESCRIBED", inventoryItemId: "i1", saleId: "s1" },
      { caseId: "k1", reason: "SNAD", inventoryItemId: "i1", saleId: "s1" },
    ],
    { i1: "report-1" },
  );
  assertEquals(await recordSnadObservations("u1", deps), 1);
  assertEquals(written.length, 1);
});

Deno.test("a load failure is zero observations, not a thrown sweep", async () => {
  const deps: SnadSignalDeps = {
    loadCandidates: () => Promise.reject(new Error("db down")),
    loadReportIds: () => Promise.resolve(new Map()),
    record: () => Promise.resolve(0),
  };
  assertEquals(await recordSnadObservations("u1", deps), 0);
});

Deno.test("the SNAD source is excluded from every sale figure", () => {
  // The rule that keeps this a signal rather than a verdict. If the source ever
  // stops being in this list, a return starts counting as a graded sale in the
  // public stats and as a dispute in the outcome feedback with no human check.
  assert(
    (NON_SALE_OUTCOME_SOURCES as readonly string[]).includes(SNAD_OUTCOME_SOURCE),
    "marketplace_snad must never count as a sale outcome",
  );
  assert(
    (NON_SALE_OUTCOME_SOURCES as readonly string[]).includes("buyer_arrival"),
    "the pre-existing exclusion must survive",
  );
});
