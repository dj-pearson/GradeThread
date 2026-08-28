// US-2971: the sweep is idempotent against a REAL database.
//
// The pure tests next door prove the planner drops already-granted marks, and
// migration 00417's UNIQUE uq_reputation_event_ref makes a duplicate emit a
// no-op at the database level. Neither of those is the same claim as "running
// the sweep twice leaves the same number of rows", which is what a backfill
// re-run actually does, so this file makes that claim directly.
//
// ENV-GATED, and skips cleanly when the fixture is absent — the same shape as
// tenant-isolation_test.ts. Required:
//   TEST_SUPABASE_URL              a Supabase REST endpoint (the throwaway local
//                                  stack is fine and is the intended target)
//   TEST_SUPABASE_SERVICE_ROLE_KEY its service-role key
//   TEST_SWEEP_USER_ID             a users.id that owns at least one
//                                  inventory_items row
//
// Running it against the local stack (see CLAUDE.md "PostgREST CAN run
// locally"): `supabase db start`, then
// `docker start supabase_rest_gradethread supabase_kong_gradethread`.
//
// ⚠ It WRITES: it sweeps a real user and leaves their pipeline events behind.
// Point it at the throwaway stack, never at production.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

const URL_ = Deno.env.get("TEST_SUPABASE_URL");
const KEY = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const USER = Deno.env.get("TEST_SWEEP_USER_ID");
const CONFIGURED = Boolean(URL_ && KEY && USER);

if (CONFIGURED) {
  // lib/supabase.ts reads these at import time, so they must be set before the
  // sweep module is pulled in below.
  Deno.env.set("SUPABASE_URL", URL_!);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", KEY!);
}

const PIPELINE_EVENT_TYPES = [
  "item_cataloged",
  "item_measured",
  "item_photographed",
  "item_comped",
  "item_drafted",
  "item_listed",
  "item_sold",
];

/** Count this user's pipeline events, straight over REST. */
async function countPipelineEvents(): Promise<number> {
  const inList = `(${PIPELINE_EVENT_TYPES.join(",")})`;
  const res = await fetch(
    `${URL_}/rest/v1/reputation_events?user_id=eq.${USER}&event_type=in.${inList}&select=id`,
    {
      headers: {
        apikey: KEY!,
        Authorization: `Bearer ${KEY}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    },
  );
  assertEquals(res.status < 400, true, `count query failed: ${res.status}`);
  const range = res.headers.get("content-range") ?? "";
  await res.body?.cancel();
  const total = range.split("/")[1];
  return Number(total);
}

Deno.test({
  name: "US-2971: sweeping twice grants each mark exactly once",
  ignore: !CONFIGURED,
  fn: async () => {
    const { sweepPipelineRewards } = await import("../lib/rewards-pipeline.ts");

    // First sweep: whatever this user has earned but never been granted.
    const first = await sweepPipelineRewards(USER!);
    const afterFirst = await countPipelineEvents();
    assertEquals(
      afterFirst >= first.marksGranted,
      true,
      "the log must hold at least what the first sweep reported granting",
    );

    // Second sweep, immediately. Every mark is now in `existing`, so the plan
    // is empty and nothing is emitted.
    const second = await sweepPipelineRewards(USER!);
    const afterSecond = await countPipelineEvents();

    assertEquals(second.marksGranted, 0, "the second sweep must grant nothing");
    assertEquals(second.xpAdded, 0, "the second sweep must add no XP");
    assertEquals(
      afterSecond,
      afterFirst,
      "the reputation_events row count must be identical after the second sweep",
    );

    // And the level cannot move on a no-op sweep.
    assertEquals(second.levelAfter, second.levelBefore, "a no-op sweep cannot level anyone up");
  },
});

Deno.test({
  name: "US-2971: a third sweep is still a no-op (not just the second)",
  ignore: !CONFIGURED,
  fn: async () => {
    // Guards the specific way this could regress: a dedupe that works once
    // because of an in-process cache rather than because of the log.
    const { sweepPipelineRewards } = await import("../lib/rewards-pipeline.ts");
    const before = await countPipelineEvents();
    const third = await sweepPipelineRewards(USER!);
    const after = await countPipelineEvents();
    assertEquals(third.marksGranted, 0);
    assertEquals(after, before);
  },
});

Deno.test({
  name: "US-2971: the sweep grants nothing derived from another tenant's items",
  ignore: !CONFIGURED,
  fn: async () => {
    // Every event the sweep wrote must key on an item this user owns. A tenant
    // filter that goes missing shows up here as a reference id pointing at
    // somebody else's inventory.
    const evRes = await fetch(
      `${URL_}/rest/v1/reputation_events?user_id=eq.${USER}` +
        `&event_type=in.(${PIPELINE_EVENT_TYPES.join(",")})&select=reference_id`,
      { headers: { apikey: KEY!, Authorization: `Bearer ${KEY}` } },
    );
    const events = (await evRes.json()) as Array<{ reference_id: string }>;
    if (events.length === 0) return; // nothing granted for this fixture user

    const itemIds = new Set(events.map((e) => e.reference_id.split(":")[0]));
    const idList = [...itemIds].join(",");
    const itemRes = await fetch(
      `${URL_}/rest/v1/inventory_items?id=in.(${idList})&select=id,user_id`,
      { headers: { apikey: KEY!, Authorization: `Bearer ${KEY}` } },
    );
    const items = (await itemRes.json()) as Array<{ id: string; user_id: string }>;

    assertEquals(items.length, itemIds.size, "every referenced item must exist");
    for (const item of items) {
      assertEquals(
        item.user_id,
        USER,
        `event referenced item ${item.id}, which belongs to another tenant`,
      );
    }
    assert(items.length > 0);
  },
});
