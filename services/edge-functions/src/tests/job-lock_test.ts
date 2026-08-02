// US-503: scheduled-job overlap locks. Verifies the acquire/skip/release logic
// (including AC#3 — a second concurrent run is a no-op) with an injected RPC
// that simulates the lease semantics, no DB required.

// job-lock.ts imports supabase.ts, which throws at module init without env, so
// set dummy creds first and dynamically import (mirrors ai-photo-qa_test.ts).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { acquireJobLock, withJobLock } = await import("../lib/job-lock.ts");
type JobLockRpc = import("../lib/job-lock.ts").JobLockRpc;

// A fake job_locks store with the same "claim if free/expired" semantics the
// SQL function implements.
function fakeRpc(): { rpc: JobLockRpc; held: Set<string> } {
  const held = new Set<string>();
  const rpc: JobLockRpc = (name, args) => {
    const job = args.p_job as string;
    if (name === "try_acquire_job_lock") {
      if (held.has(job)) return Promise.resolve({ data: false, error: null });
      held.add(job);
      return Promise.resolve({ data: true, error: null });
    }
    held.delete(job);
    return Promise.resolve({ data: null, error: null });
  };
  return { rpc, held };
}

Deno.test("acquireJobLock acquires when free and releases", async () => {
  const { rpc, held } = fakeRpc();
  const lock = await acquireJobLock("job-a", 60, rpc);
  assertEquals(lock.acquired, true);
  assert(held.has("job-a"));
  await lock.release();
  assert(!held.has("job-a"));
});

Deno.test("a second concurrent run is a no-op while the first holds the lock", async () => {
  const { rpc } = fakeRpc();
  const first = await acquireJobLock("job-b", 60, rpc);
  assertEquals(first.acquired, true);

  // Second run, before the first releases → must NOT acquire.
  const second = await acquireJobLock("job-b", 60, rpc);
  assertEquals(second.acquired, false);
  assertEquals(second.reason, "locked");

  // After the first releases, a new run can acquire again.
  await first.release();
  const third = await acquireJobLock("job-b", 60, rpc);
  assertEquals(third.acquired, true);
});

Deno.test("withJobLock runs fn once and skips the overlapping run", async () => {
  const { rpc } = fakeRpc();
  let runs = 0;
  const slow = () =>
    withJobLock("job-c", 60, async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 30));
      return "done";
    }, rpc);

  // Fire two overlapping runs concurrently; exactly one should run fn.
  const [a, b] = await Promise.all([slow(), slow()]);
  assertEquals(runs, 1);
  const ran = [a, b].filter((r) => r.ran);
  const skipped = [a, b].filter((r) => !r.ran);
  assertEquals(ran.length, 1);
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0].skipped, "locked");
  assertEquals(ran[0].result, "done");
});

Deno.test("acquire fails SAFE (skip) when the RPC errors", async () => {
  const rpc: JobLockRpc = () =>
    Promise.resolve({ data: null, error: { message: "db down" } });
  const lock = await acquireJobLock("job-d", 60, rpc);
  assertEquals(lock.acquired, false);
  assertEquals(lock.reason, "lock_error");
});

Deno.test("acquire fails SAFE (skip) when the RPC throws", async () => {
  const rpc: JobLockRpc = () => Promise.reject(new Error("network"));
  const lock = await acquireJobLock("job-e", 60, rpc);
  assertEquals(lock.acquired, false);
  assertEquals(lock.reason, "lock_error");
});

// ── US-2311: the holder check ────────────────────────────────────────
//
// The fake above ignores both the lease and the holder, so it cannot express
// the bug: a run whose lease expired is legitimately displaced, and then its
// own release deletes the DISPLACING run's live lock. This one models the SQL
// in 00094 + 00512 — claim if free or expired, delete only on a holder match —
// against a clock the test moves by hand.

interface LockRow {
  lockedUntilMs: number;
  holder: string | null;
}

function leaseAwareRpc(clock: { nowMs: number }): {
  rpc: JobLockRpc;
  rows: Map<string, LockRow>;
} {
  const rows = new Map<string, LockRow>();
  const rpc: JobLockRpc = (name, args) => {
    const job = args.p_job as string;
    const holder = (args.p_holder ?? null) as string | null;
    if (name === "try_acquire_job_lock") {
      const existing = rows.get(job);
      // ON CONFLICT ... WHERE locked_until < now()
      const free = !existing || existing.lockedUntilMs < clock.nowMs;
      if (!free) return Promise.resolve({ data: false, error: null });
      rows.set(job, {
        lockedUntilMs: clock.nowMs + (args.p_lease_seconds as number) * 1000,
        holder,
      });
      return Promise.resolve({ data: true, error: null });
    }
    // delete ... where job_name = p_job and (p_holder is null or holder = p_holder)
    const row = rows.get(job);
    if (row && (holder === null || row.holder === holder)) rows.delete(job);
    return Promise.resolve({ data: null, error: null });
  };
  return { rpc, rows };
}

Deno.test("US-2311: a displaced run's release leaves the new holder's lock intact", async () => {
  const clock = { nowMs: 0 };
  const { rpc, rows } = leaseAwareRpc(clock);

  // t=0:00 — tick 1 acquires a 300s lease.
  const tick1 = await acquireJobLock("autolister-reclaim", 300, rpc);
  assertEquals(tick1.acquired, true);
  const holder1 = rows.get("autolister-reclaim")?.holder;
  assert(typeof holder1 === "string" && holder1.length > 0, "a holder is stored");

  // t=5:00.1 — tick 1 is still running; its lease has expired, so tick 2
  // legitimately steals the lock. This part is correct and intended.
  //
  // Just PAST the lease, not exactly on it: the SQL steal condition is
  // `locked_until < now()`, so at the exact boundary the lock is still held.
  clock.nowMs = 300_100;
  const tick2 = await acquireJobLock("autolister-reclaim", 300, rpc);
  assertEquals(tick2.acquired, true);
  const holder2 = rows.get("autolister-reclaim")?.holder;
  assert(holder2 !== holder1, "the steal replaced the holder");

  // t=5:30 — tick 1 finally finishes and releases. BEFORE the holder check this
  // deleted tick 2's live lock.
  clock.nowMs = 330_000;
  await tick1.release();
  assertEquals(
    rows.get("autolister-reclaim")?.holder,
    holder2,
    "tick 2 still holds its lock after tick 1's release",
  );

  // t=10:00 — tick 3. Tick 2's lease runs to t=10:00, so the only reason tick 3
  // could acquire here is the lock having been wrongly deleted. It must not run
  // concurrently with tick 2.
  clock.nowMs = 599_000;
  const tick3 = await acquireJobLock("autolister-reclaim", 300, rpc);
  assertEquals(tick3.acquired, false);
  assertEquals(tick3.reason, "locked");
});

Deno.test("US-2311: the holder still releases its OWN lock normally", async () => {
  const clock = { nowMs: 0 };
  const { rpc, rows } = leaseAwareRpc(clock);
  const lock = await acquireJobLock("email-retry", 600, rpc);
  assertEquals(lock.acquired, true);
  await lock.release();
  assertEquals(rows.has("email-retry"), false);
  // And the next tick can start immediately rather than waiting out the lease.
  clock.nowMs = 1_000;
  assertEquals((await acquireJobLock("email-retry", 600, rpc)).acquired, true);
});

Deno.test("US-2311: every acquisition gets a distinct holder token", async () => {
  const clock = { nowMs: 0 };
  const { rpc, rows } = leaseAwareRpc(clock);
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const lock = await acquireJobLock("job-token", 60, rpc);
    assertEquals(lock.acquired, true);
    const h = rows.get("job-token")?.holder;
    assert(typeof h === "string");
    seen.add(h);
    await lock.release();
  }
  assertEquals(seen.size, 5, "a reused token would make the check meaningless");
});
