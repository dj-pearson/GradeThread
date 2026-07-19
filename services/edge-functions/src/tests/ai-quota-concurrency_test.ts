// US-387: AI-action cap atomicity — concurrency integration test.
//
// reserve_ai_action(p_user_id, p_limit) (migration 00087) is the single,
// row-locking check-and-increment that flipdesk-ai.ts now calls before every
// billable AI action (replacing the old checkQuota→increment_ai_actions TOCTOU).
// This test proves the atomicity guarantee that a pure unit test cannot: fire N
// parallel reservations at the cap boundary and confirm the counter NEVER
// exceeds the cap and exactly (cap - used) of them win.
//
// Env-gated + SKIPs cleanly when no DB fixture is configured (same pattern as
// tenant-isolation_test.ts). Required env:
//   TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE_KEY  — a DB with the schema
//   TEST_QUOTA_USER_ID                                  — a throwaway users row
// The user row is mutated (ai_actions_used_this_month / reset_at) and left at
// the cap; use a dedicated fixture user.
//   deno test --allow-net --allow-env src/tests/ai-quota-concurrency_test.ts
import { assert, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { requireIntegrationFixtures } from "./integration-required.ts";

const URL = Deno.env.get("TEST_SUPABASE_URL");
const KEY = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const USER = Deno.env.get("TEST_QUOTA_USER_ID");
const CONFIGURED = Boolean(URL && KEY && USER);

// US-2038 AC3 (class b): skip locally, but FAIL LOUDLY in a lane that
// declared it would run these — a silent skip and a pass look identical.
const RUN = requireIntegrationFixtures(
  "ai-quota-concurrency",
  ["TEST_SUPABASE_URL", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_QUOTA_USER_ID"],
  CONFIGURED,
);

Deno.test({
  name: "reserve_ai_action: N parallel reservations cannot exceed the cap",
  ignore: !RUN,
  fn: async () => {
    const db = createClient(URL!, KEY!, { auth: { persistSession: false } });

    const CAP = 100;
    const HEADROOM = 3; // only this many reservations should win
    const startUsed = CAP - HEADROOM;

    // Seed the boundary: used = cap-3, reset stamped this month so no rollover.
    const { error: seedErr } = await db
      .from("users")
      .update({
        ai_actions_used_this_month: startUsed,
        ai_actions_reset_at: new Date().toISOString(),
      })
      .eq("id", USER!);
    assertEquals(seedErr, null, "seed update should succeed");

    // Fire 25 reservations in parallel — well over the 3-slot headroom.
    const N = 25;
    const outcomes = await Promise.all(
      Array.from({ length: N }, () =>
        db.rpc("reserve_ai_action", { p_user_id: USER!, p_limit: CAP })),
    );

    const granted = outcomes.filter((o) => o.data === true).length;
    const refused = outcomes.filter((o) => o.data === false).length;

    // Exactly the headroom is granted; the rest are atomically refused.
    assertEquals(granted, HEADROOM, "only the headroom may be granted");
    assertEquals(refused, N - HEADROOM, "everything past the cap is refused");

    // The persisted counter lands exactly on the cap — never above it.
    const { data: after } = await db
      .from("users")
      .select("ai_actions_used_this_month")
      .eq("id", USER!)
      .single();
    assertEquals(
      (after as { ai_actions_used_this_month: number }).ai_actions_used_this_month,
      CAP,
      "counter must land exactly on the cap",
    );

    // A further reservation at the cap is refused (no off-by-one).
    const extra = await db.rpc("reserve_ai_action", { p_user_id: USER!, p_limit: CAP });
    assert(extra.data === false, "a reservation at the cap must be refused");
  },
});
