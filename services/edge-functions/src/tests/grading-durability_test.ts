// US-569: AI grading is durable + idempotent — it survives a crash/redeploy
// mid-grade and never double-bills Claude.
//
// grading-pipeline.ts / stuck-submissions.ts import the service-role supabase
// client at module init, so set dummy env BEFORE the dynamic imports.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
// Pin the attempt budget so the poison-guard assertions are deterministic.
Deno.env.set("GRADING_MAX_ATTEMPTS", "3");

const { claimSubmissionForGrading } = await import("../lib/grading-pipeline.ts");
const { recoverStuckSubmissions } = await import("../lib/stuck-submissions.ts");
import type { GradingClaimUpdater } from "../lib/grading-pipeline.ts";
import type { StuckSweepStore } from "../lib/stuck-submissions.ts";

// ── claim result mapping ─────────────────────────────────────────
// claim_grade_lease returns the rich codes; claimSubmissionForGrading collapses
// the no-op ones into "already" while keeping "claimed"/"done" distinct.

function statusUpdater(
  status: "claimed" | "done" | "leased" | "exhausted" | "gone",
): GradingClaimUpdater {
  return () => Promise.resolve({ status, error: null });
}

Deno.test("claim mapping: 'claimed' → claimed (we own the grade run)", async () => {
  assertEquals(await claimSubmissionForGrading("s", statusUpdater("claimed")), "claimed");
});

Deno.test("claim mapping: 'done' → done (finalize, do not re-grade)", async () => {
  assertEquals(await claimSubmissionForGrading("s", statusUpdater("done")), "done");
});

Deno.test("claim mapping: live lease / poison / terminal all collapse to 'already'", async () => {
  assertEquals(await claimSubmissionForGrading("s", statusUpdater("leased")), "already");
  assertEquals(await claimSubmissionForGrading("s", statusUpdater("exhausted")), "already");
  assertEquals(await claimSubmissionForGrading("s", statusUpdater("gone")), "already");
});

Deno.test("claim mapping: a DB error surfaces as 'error' (caller reports it)", async () => {
  const r = await claimSubmissionForGrading(
    "s",
    () => Promise.resolve({ error: { message: "connection reset" } }),
  );
  assertEquals(r, "error");
});

// ── lease semantics: the heart of durability + idempotency ───────
// An in-memory model of claim_grade_lease (migration 00161) over a controllable
// clock. Pins the contract the RPC implements, routed through the real
// claimSubmissionForGrading so the mapping is exercised too.

const LEASE = 900_000; // 15 min in ms
const MAX = 3;

function leaseModel() {
  const db = {
    status: "pending" as string,
    leaseUntil: null as number | null,
    attempts: 0,
    hasActiveReport: false,
  };
  // The updater closes over a mutable `now` so a single test can advance time.
  let now = 0;
  const updater: GradingClaimUpdater = () => {
    // Mirror claim_grade_lease's branch order exactly.
    if (
      ["pending", "processing"].includes(db.status) &&
      (db.leaseUntil === null || db.leaseUntil < now) &&
      db.attempts < MAX &&
      !db.hasActiveReport
    ) {
      db.attempts += 1;
      db.status = "processing";
      db.leaseUntil = now + LEASE;
      return Promise.resolve({ status: "claimed", error: null });
    }
    if (db.hasActiveReport) return Promise.resolve({ status: "done", error: null });
    if (!["pending", "processing"].includes(db.status)) {
      return Promise.resolve({ status: "gone", error: null });
    }
    if (db.attempts >= MAX) return Promise.resolve({ status: "exhausted", error: null });
    return Promise.resolve({ status: "leased", error: null });
  };
  return { db, updater, setNow: (t: number) => (now = t) };
}

Deno.test("durability: the first kick claims and leases the row", async () => {
  const m = leaseModel();
  assertEquals(await claimSubmissionForGrading("s", m.updater), "claimed");
  assertEquals(m.db.attempts, 1);
  assertEquals(m.db.status, "processing");
  assert(m.db.leaseUntil !== null && m.db.leaseUntil > 0);
});

Deno.test("idempotency: a double-kick during an active lease is a no-op (Claude billed once)", async () => {
  const m = leaseModel();
  m.setNow(0);
  assertEquals(await claimSubmissionForGrading("s", m.updater), "claimed");
  // Webhook + ?pay_retry=1 fire moments later, lease still held.
  m.setNow(10_000);
  assertEquals(await claimSubmissionForGrading("s", m.updater), "already");
  assertEquals(m.db.attempts, 1, "no second claim → no second grade run");
});

Deno.test("crash + redeploy: an expired lease is RESUMED (re-claimed), not lost", async () => {
  const m = leaseModel();
  m.setNow(0);
  assertEquals(await claimSubmissionForGrading("s", m.updater), "claimed");
  // Container crashes mid-grade; no report written, no terminal status. The
  // reaper runs after the lease expires.
  m.setNow(LEASE + 1);
  assertEquals(await claimSubmissionForGrading("s", m.updater), "claimed", "resume re-claims");
  assertEquals(m.db.attempts, 2, "resume counts as another attempt");
});

Deno.test("idempotency: a crash AFTER the report exists finalizes, never re-grades", async () => {
  const m = leaseModel();
  m.setNow(0);
  assertEquals(await claimSubmissionForGrading("s", m.updater), "claimed");
  // The grade completed (report written) but the process died before the
  // status='completed' flip. The lease later expires and the reaper re-kicks.
  m.db.hasActiveReport = true;
  m.setNow(LEASE + 1);
  assertEquals(await claimSubmissionForGrading("s", m.updater), "done", "→ finalize path");
  assertEquals(m.db.attempts, 1, "no re-grade → Claude not billed again");
});

Deno.test("poison guard: after MAX crashed attempts the claim is 'exhausted'", async () => {
  const m = leaseModel();
  for (let i = 1; i <= MAX; i++) {
    m.setNow(i * (LEASE + 1));
    assertEquals(await claimSubmissionForGrading("s", m.updater), "claimed");
  }
  assertEquals(m.db.attempts, MAX);
  // The next resume can't claim — the reaper will fail + refund instead.
  m.setNow((MAX + 1) * (LEASE + 1));
  assertEquals(await claimSubmissionForGrading("s", m.updater), "already");
});

// ── reaper orchestration: resume vs poison-fail ──────────────────

function fakeStuckStore(
  rows: Array<{ id: string; grading_attempts: number }>,
  over: Partial<StuckSweepStore> = {},
): { store: StuckSweepStore; calls: { resumed: string[]; refunded: string[] } } {
  const calls = { resumed: [] as string[], refunded: [] as string[] };
  const store: StuckSweepStore = {
    findStuck: () => Promise.resolve(rows),
    resume: (id) => {
      calls.resumed.push(id);
    },
    failAndRefund: (id) => {
      calls.refunded.push(id);
      return Promise.resolve(true);
    },
    ...over,
  };
  return { store, calls };
}

Deno.test("reaper: under-budget orphans are resumed, not refunded", async () => {
  const { store, calls } = fakeStuckStore([
    { id: "a", grading_attempts: 1 },
    { id: "b", grading_attempts: 2 },
  ]);
  const r = await recoverStuckSubmissions(store);
  assertEquals(r.resumed, 2);
  assertEquals(r.refunded, 0);
  assertEquals(calls.resumed, ["a", "b"]);
  assertEquals(calls.refunded, []);
});

Deno.test("reaper: an orphan that exhausted its budget is failed + refunded", async () => {
  const { store, calls } = fakeStuckStore([
    { id: "poison", grading_attempts: 3 }, // == MAX
  ]);
  const r = await recoverStuckSubmissions(store);
  assertEquals(r.resumed, 0);
  assertEquals(r.refunded, 1);
  assertEquals(calls.refunded, ["poison"]);
  assertEquals(calls.resumed, []);
});

Deno.test("reaper: a row that completed in the race window is left alone", async () => {
  const { store } = fakeStuckStore(
    [{ id: "poison", grading_attempts: 3 }],
    { failAndRefund: () => Promise.resolve(false) }, // status no longer 'processing'
  );
  const r = await recoverStuckSubmissions(store);
  assertEquals(r.refunded, 0, "the conditional UPDATE didn't own it → not counted");
});

Deno.test("reaper: nothing stuck → zero counts, no side effects", async () => {
  const { store, calls } = fakeStuckStore([]);
  const r = await recoverStuckSubmissions(store);
  assertEquals(r, { scanned: 0, resumed: 0, refunded: 0, failed: 0 });
  assertEquals(calls.resumed, []);
  assertEquals(calls.refunded, []);
});
