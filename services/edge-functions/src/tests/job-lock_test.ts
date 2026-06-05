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
