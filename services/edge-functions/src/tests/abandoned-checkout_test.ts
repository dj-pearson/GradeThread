// US-773: abandoned-checkout sweep + idempotent grading claim.
//
// grading-pipeline.ts and stuck-submissions.ts import the service-role supabase
// client at module init, so set dummy env BEFORE the dynamic imports.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { claimSubmissionForGrading } = await import("../lib/grading-pipeline.ts");
const { recoverAbandonedCheckouts } = await import("../lib/stuck-submissions.ts");
import type { GradingClaimUpdater } from "../lib/grading-pipeline.ts";
import type { AbandonedSweepStore } from "../lib/stuck-submissions.ts";

// ── claimSubmissionForGrading: the double-kick idempotency ────────

// A fake updater that models the real conditional UPDATE: the first claim wins
// (returns a row), every later claim for the same id finds grading_started_at
// already set and returns no row.
function oneShotUpdater(): GradingClaimUpdater {
  const claimed = new Set<string>();
  return (submissionId) => {
    if (claimed.has(submissionId)) {
      return Promise.resolve({ row: null, error: null });
    }
    claimed.add(submissionId);
    return Promise.resolve({ row: { id: submissionId }, error: null });
  };
}

Deno.test("grading claim: the first kick claims (pipeline starts once)", async () => {
  const r = await claimSubmissionForGrading("sub_1", oneShotUpdater());
  assertEquals(r, "claimed");
});

Deno.test("grading claim: a double-kick is a no-op (only one grade run)", async () => {
  const update = oneShotUpdater();
  const first = await claimSubmissionForGrading("sub_1", update);
  const second = await claimSubmissionForGrading("sub_1", update);
  assertEquals(first, "claimed");
  assertEquals(second, "already"); // duplicate kick → no second grade
});

Deno.test("grading claim: distinct submissions each claim independently", async () => {
  const update = oneShotUpdater();
  assertEquals(await claimSubmissionForGrading("a", update), "claimed");
  assertEquals(await claimSubmissionForGrading("b", update), "claimed");
});

Deno.test("grading claim: a DB error surfaces as 'error' (caller will report it)", async () => {
  const r = await claimSubmissionForGrading(
    "sub_1",
    () => Promise.resolve({ row: null, error: { message: "connection reset" } }),
  );
  assertEquals(r, "error");
});

// ── recoverAbandonedCheckouts: sweep orchestration ───────────────

function fakeStore(over: Partial<AbandonedSweepStore> = {}): {
  store: AbandonedSweepStore;
  calls: { expired: string[]; rekicked: string[] };
} {
  const calls = { expired: [] as string[], rekicked: [] as string[] };
  const store: AbandonedSweepStore = {
    findAbandonedUnpaid: () => Promise.resolve([]),
    expireIfStillAbandoned: (id) => {
      calls.expired.push(id);
      return Promise.resolve(true);
    },
    findStrandedPaid: () => Promise.resolve([]),
    rekick: (id) => {
      calls.rekicked.push(id);
    },
    ...over,
  };
  return { store, calls };
}

Deno.test("sweep: expires the unpaid abandoned rows the scan returns", async () => {
  const { store, calls } = fakeStore({
    findAbandonedUnpaid: () => Promise.resolve(["a", "b"]),
  });
  const r = await recoverAbandonedCheckouts(store);
  assertEquals(r.expired, 2);
  assertEquals(calls.expired, ["a", "b"]);
  assertEquals(r.rekicked, 0);
});

Deno.test("sweep: a row paid in the race window is NOT counted as expired", async () => {
  // expireIfStillAbandoned returns false for "b" — it got paid between the scan
  // and the conditional UPDATE, so it must not be expired.
  const { store } = fakeStore({
    findAbandonedUnpaid: () => Promise.resolve(["a", "b"]),
    expireIfStillAbandoned: (id) => Promise.resolve(id !== "b"),
  });
  const r = await recoverAbandonedCheckouts(store);
  assertEquals(r.expired, 1); // only "a"
});

Deno.test("sweep: stranded-paid rows are re-kicked, abandoned rows are not", async () => {
  const { store, calls } = fakeStore({
    findAbandonedUnpaid: () => Promise.resolve(["u1"]),
    findStrandedPaid: () => Promise.resolve(["p1", "p2"]),
  });
  const r = await recoverAbandonedCheckouts(store);
  assertEquals(r.expired, 1);
  assertEquals(r.rekicked, 2);
  assertEquals(calls.rekicked, ["p1", "p2"]);
  // The re-kicked rows are paid — they are never expired.
  assert(!calls.expired.includes("p1"));
  assert(!calls.expired.includes("p2"));
});

Deno.test("sweep: nothing to do → zero counts, no side effects", async () => {
  const { store, calls } = fakeStore();
  const r = await recoverAbandonedCheckouts(store);
  assertEquals(r, { expired: 0, rekicked: 0 });
  assertEquals(calls.expired, []);
  assertEquals(calls.rekicked, []);
});
