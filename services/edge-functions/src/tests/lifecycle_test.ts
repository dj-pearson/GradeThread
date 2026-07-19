// US-2010: graceful shutdown — stop claiming NEW work, drain what is running.
//
// The property that actually matters is the CLAIM REFUSAL, not the drain. A job
// claimed two seconds before the container exits holds its lease for the full
// JOB_STALE_MS/BATCH_STALE_MS window (6–15 min) before a reclaim sweep finds
// it, so the seller sees minutes of apparent stall. A job never claimed is just
// run by the next tick. That is why the guard sits in acquireJobLock — the one
// chokepoint the whole cron fleet passes through.
//
//   deno test --allow-env src/tests/lifecycle_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  beginShutdown,
  isShuttingDown,
  canClaimNewWork,
  trackInFlight,
  inFlightCount,
  awaitDrain,
  __resetLifecycleForTests,
} = await import("../lib/lifecycle.ts");
const { acquireJobLock } = await import("../lib/job-lock.ts");

function reset() {
  __resetLifecycleForTests();
}

Deno.test("a fresh process claims work and is not shutting down", () => {
  reset();
  assertEquals(isShuttingDown(), false);
  assertEquals(canClaimNewWork(), true);
});

Deno.test("beginShutdown stops new claims immediately", () => {
  reset();
  beginShutdown();
  assertEquals(isShuttingDown(), true);
  assertEquals(canClaimNewWork(), false);
});

// THE LOAD-BEARING ONE. Every cron in the fleet goes through acquireJobLock, so
// this single guard is what prevents a deploy from stranding a freshly-claimed
// job for 6–15 minutes. The rpc below would return true (lock available) — the
// refusal must happen BEFORE it is ever consulted.
Deno.test("acquireJobLock refuses while draining, without touching the DB", async () => {
  reset();
  beginShutdown();
  let rpcCalled = false;
  const lock = await acquireJobLock("any-job", 60, () => {
    rpcCalled = true;
    return Promise.resolve({ data: true, error: null });
  });
  assertEquals(lock.acquired, false);
  assertEquals(lock.reason, "shutting_down");
  assertEquals(rpcCalled, false, "must not even attempt the claim while draining");
});

Deno.test("acquireJobLock still works normally before shutdown", async () => {
  reset();
  const lock = await acquireJobLock("any-job", 60, () =>
    Promise.resolve({ data: true, error: null }));
  assertEquals(lock.acquired, true);
});

// A second SIGTERM must not restart the drain clock or re-run the handler.
Deno.test("beginShutdown is idempotent", () => {
  reset();
  beginShutdown(1000);
  beginShutdown(9999);
  assertEquals(isShuttingDown(), true);
});

// ── in-flight tracking ──────────────────────────────────────────────

Deno.test("trackInFlight counts up and back down", async () => {
  reset();
  assertEquals(inFlightCount(), 0);
  const done = trackInFlight(() => {
    assertEquals(inFlightCount(), 1);
    return Promise.resolve("ok");
  });
  assertEquals(await done, "ok");
  assertEquals(inFlightCount(), 0);
});

// A throwing handler MUST release its slot. Otherwise one failed request leaks a
// permanent in-flight count and every subsequent deploy waits the full drain
// deadline — a slow leak whose only symptom is "shutdown always takes 8s".
Deno.test("trackInFlight releases its slot even when the handler throws", async () => {
  reset();
  await trackInFlight(() => Promise.reject(new Error("boom"))).catch(() => {});
  assertEquals(inFlightCount(), 0, "a thrown handler must not leak an in-flight slot");
});

// ── drain ───────────────────────────────────────────────────────────

Deno.test("awaitDrain returns immediately when nothing is in flight", async () => {
  reset();
  assertEquals(await awaitDrain(5_000, { sleep: () => Promise.resolve() }), true);
});

Deno.test("awaitDrain waits for in-flight work, then reports drained", async () => {
  reset();
  const holder: { release: (() => void) | null } = { release: null };
  const work = trackInFlight(
    () => new Promise<void>((resolve) => { holder.release = resolve; }),
  );
  assertEquals(inFlightCount(), 1);

  // Let the drain poll a few times, then finish the work.
  let polls = 0;
  const drained = awaitDrain(5_000, {
    sleep: () => {
      if (++polls === 3) holder.release?.();
      return Promise.resolve();
    },
  });
  assertEquals(await drained, true);
  await work;
  assert(polls >= 3, "should have polled while work was outstanding");
});

// Exiting with one straggler beats being SIGKILLed mid-drain: Docker sends
// SIGKILL after its grace period regardless, so the deadline must win.
Deno.test("awaitDrain gives up at the deadline rather than hanging forever", async () => {
  reset();
  const holder: { release: (() => void) | null } = { release: null };
  const work = trackInFlight(
    () => new Promise<void>((resolve) => { holder.release = resolve; }),
  );

  let clock = 0;
  const drained = await awaitDrain(1_000, {
    sleep: () => { clock += 400; return Promise.resolve(); },
    now: () => clock,
  });
  assertEquals(drained, false, "must report NOT drained when the deadline is hit");
  holder.release?.();
  await work;
});
