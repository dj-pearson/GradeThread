// US-909: the admin notification-center recipient policy is pure + must stay
// deterministic. admin-notifications.ts imports lib/supabase.ts at module load
// (which throws on an unset SUPABASE_URL), so set env FIRST, then dynamic-import.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");

const { resolveNotifyMode } = await import("../lib/admin-notifications.ts");

Deno.test("explicit targets always notify just those admins", () => {
  assertEquals(resolveNotifyMode("ticket.assigned", "info", 1), "explicit");
  // explicit wins even for a critical event (don't also broadcast).
  assertEquals(resolveNotifyMode("anything", "critical", 2), "explicit");
});

Deno.test("a critical event with no explicit targets broadcasts to all admins", () => {
  assertEquals(resolveNotifyMode("billing.reconciliation", "critical", 0), "broadcast");
});

Deno.test("a job failure broadcasts regardless of severity", () => {
  assertEquals(resolveNotifyMode("job.failed", "warning", 0), "broadcast");
});

Deno.test("routine info/warning events notify no one (they stay in the feed)", () => {
  assertEquals(resolveNotifyMode("maintenance.created", "info", 0), "none");
  assertEquals(resolveNotifyMode("newsletter.deliverability", "warning", 0), "none");
});
