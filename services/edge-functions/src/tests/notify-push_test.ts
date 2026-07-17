// US-1901: the push-channel gate in notify.ts. deliverPush pulls in the
// service-role supabase client at init, so set dummy env BEFORE the dynamic
// import (per the LEARNINGS playbook), then unit-test the pure gate decision.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { pushChannelEnabled } = await import("../lib/notify.ts");

Deno.test("pushChannelEnabled defaults ON; only an explicit false suppresses", () => {
  // No prefs at all → default on.
  assertEquals(pushChannelEnabled(null, "offers"), true);
  assertEquals(pushChannelEnabled(undefined, "offers"), true);
  // Category present but no push flag → default on.
  assertEquals(pushChannelEnabled({ offers: {} }, "offers"), true);
  assertEquals(pushChannelEnabled({ offers: { in_app: true } }, "offers"), true);
  // Explicit opt-out suppresses.
  assertEquals(pushChannelEnabled({ offers: { push: false } }, "offers"), false);
  // Opt-out on a DIFFERENT category doesn't affect this one.
  assertEquals(pushChannelEnabled({ payouts: { push: false } }, "offers"), true);
  // A null prefKey (always-on types, e.g. system) always allows, even if some
  // other category is opted out.
  assertEquals(pushChannelEnabled({ payouts: { push: false } }, null), true);
});
