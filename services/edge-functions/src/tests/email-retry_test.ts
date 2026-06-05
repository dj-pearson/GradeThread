// US-498: email outbox backoff schedule. email-retry.ts imports supabase at
// module init, so set dummy env before the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { backoffMs } = await import("../lib/email-retry.ts");

Deno.test("backoff increases with attempts and caps", () => {
  const b1 = backoffMs(0);
  const b2 = backoffMs(1);
  const b3 = backoffMs(2);
  const b4 = backoffMs(3);
  const b5 = backoffMs(4);
  // Monotonically non-decreasing.
  assert(b1 <= b2 && b2 <= b3 && b3 <= b4 && b4 <= b5);
  // First retry ~1 min, cap at 6h.
  assertEquals(b1, 60_000);
  assertEquals(b5, 360 * 60_000);
});

Deno.test("backoff is clamped at the max for attempts beyond the schedule", () => {
  assertEquals(backoffMs(99), 360 * 60_000);
});
