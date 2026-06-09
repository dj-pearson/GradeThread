// Unit tests for the eBay sync concurrency guard + reaper (US-456).
//
// The DB-touching functions (claimSyncRun/failSyncRun/reapStuckSyncRuns) need a
// live Postgres + the partial unique index to exercise meaningfully (covered by
// the migration in db-migrations CI); here we pin the pure decision helpers that
// govern WHEN a run is reaped and HOW the stuck threshold is read.
//
// sync-run-lock.ts imports the service-role client (via supabase.ts) at module
// load, which throws without env — set dummy creds before the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isStuckRun, stuckThresholdMs } = await import("../lib/sync-run-lock.ts");

const MIN = 60_000;

Deno.test("isStuckRun: false before the threshold, true at/after it", () => {
  const now = new Date("2026-06-09T12:00:00Z");
  const threshold = 15 * MIN;
  // Started 5 min ago → still running, not stuck.
  assertEquals(
    isStuckRun(new Date(now.getTime() - 5 * MIN).toISOString(), now, threshold),
    false,
  );
  // Started exactly 15 min ago → stuck (>=).
  assertEquals(
    isStuckRun(new Date(now.getTime() - 15 * MIN).toISOString(), now, threshold),
    true,
  );
  // Started 30 min ago → stuck.
  assertEquals(
    isStuckRun(new Date(now.getTime() - 30 * MIN).toISOString(), now, threshold),
    true,
  );
});

Deno.test("isStuckRun: missing/invalid start is treated as stuck (reapable)", () => {
  const now = new Date();
  assert(isStuckRun(null, now, 15 * MIN));
  assert(isStuckRun("not-a-date", now, 15 * MIN));
});

Deno.test("stuckThresholdMs: default 15m, env override, ignores junk/non-positive", () => {
  Deno.env.delete("SYNC_STUCK_THRESHOLD_MIN");
  assertEquals(stuckThresholdMs(), 15 * MIN);

  Deno.env.set("SYNC_STUCK_THRESHOLD_MIN", "5");
  assertEquals(stuckThresholdMs(), 5 * MIN);

  Deno.env.set("SYNC_STUCK_THRESHOLD_MIN", "0"); // non-positive → default
  assertEquals(stuckThresholdMs(), 15 * MIN);

  Deno.env.set("SYNC_STUCK_THRESHOLD_MIN", "abc"); // junk → default
  assertEquals(stuckThresholdMs(), 15 * MIN);

  Deno.env.delete("SYNC_STUCK_THRESHOLD_MIN");
});
