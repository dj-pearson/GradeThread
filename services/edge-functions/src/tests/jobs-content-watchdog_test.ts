// Unit tests for the content scheduler/webhook watchdog logic (US-869).
//
// evaluateWatchdog is pure — no DB/email — so we assert the 3-hour stall window
// and the 25%-failure threshold directly. jobs-content-watchdog.ts imports the
// service-role supabase client at module load, so set dummy env BEFORE the
// dynamic import.
//
//   deno test --allow-env src/tests/jobs-content-watchdog_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { evaluateWatchdog, watchdogThresholds } = await import(
  "../routes/jobs-content-watchdog.ts"
);

const T = watchdogThresholds();
const NOW = 1_700_000_000_000; // fixed epoch ms — Date.now() not used in evaluate
const HOUR = 60 * 60 * 1000;

function codes(flags: { code: string }[]): string[] {
  return flags.map((f) => f.code).sort();
}

Deno.test("healthy: recent tick + low webhook failure rate raises nothing", () => {
  const r = evaluateWatchdog(
    {
      nowMs: NOW,
      lastHealthyTickMs: NOW - 1 * HOUR, // 1h ago — within the 3h window
      webhookAttempts: 20,
      webhookFailures: 1, // 5%
    },
    T,
  );
  assertEquals(r.flags, []);
});

Deno.test("a stale heartbeat flags stalled_scheduler", () => {
  const r = evaluateWatchdog(
    {
      nowMs: NOW,
      lastHealthyTickMs: NOW - 5 * HOUR, // 5h ago — past the 3h window
      webhookAttempts: 10,
      webhookFailures: 0,
    },
    T,
  );
  assertEquals(codes(r.flags), ["stalled_scheduler"]);
  assert(r.hoursSinceHealthyTick != null && r.hoursSinceHealthyTick > 3);
});

Deno.test("no healthy tick on record flags stalled_scheduler", () => {
  const r = evaluateWatchdog(
    { nowMs: NOW, lastHealthyTickMs: null, webhookAttempts: 0, webhookFailures: 0 },
    T,
  );
  assertEquals(codes(r.flags), ["stalled_scheduler"]);
  assertEquals(r.hoursSinceHealthyTick, null);
});

Deno.test("a high webhook failure rate flags elevated_webhook_failures", () => {
  const r = evaluateWatchdog(
    {
      nowMs: NOW,
      lastHealthyTickMs: NOW - 1 * HOUR,
      webhookAttempts: 8,
      webhookFailures: 3, // 37.5% > 25%
    },
    T,
  );
  assertEquals(codes(r.flags), ["elevated_webhook_failures"]);
});

Deno.test("the min-sample guard suppresses a high rate on too few attempts", () => {
  const r = evaluateWatchdog(
    {
      nowMs: NOW,
      lastHealthyTickMs: NOW - 1 * HOUR,
      webhookAttempts: 2, // below MIN_WEBHOOK_ATTEMPTS (4)
      webhookFailures: 2, // 100% but not enough sample
    },
    T,
  );
  assertEquals(r.flags, []);
});

Deno.test("a stale heartbeat AND a high failure rate flag BOTH (AC#6)", () => {
  const r = evaluateWatchdog(
    {
      nowMs: NOW,
      lastHealthyTickMs: NOW - 6 * HOUR, // stalled
      webhookAttempts: 12,
      webhookFailures: 6, // 50% failure
    },
    T,
  );
  assertEquals(codes(r.flags), [
    "elevated_webhook_failures",
    "stalled_scheduler",
  ]);
});

Deno.test("a rate exactly at the threshold does NOT flag (strictly greater)", () => {
  const r = evaluateWatchdog(
    {
      nowMs: NOW,
      lastHealthyTickMs: NOW - 1 * HOUR,
      webhookAttempts: 8,
      webhookFailures: 2, // exactly 25%
    },
    T,
  );
  assertEquals(r.flags, []);
});
