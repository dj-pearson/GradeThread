// Scheduled publish (publish-due) attempt cap and tick deadline.
//
// Before the cap, a scheduled draft that failed kept its schedule and became
// due again every time its claim went stale, so a permanent blocker retried
// about 144 times a day. These tests hold the decisions the route makes.
//
//   deno test src/tests/publish-due-policy_test.ts
import { assert, assertEquals } from "@std/assert";
import {
  canClaimScheduledPublish,
  MAX_SCHEDULED_PUBLISH_ATTEMPTS,
  planScheduledPublishFailure,
  PUBLISH_DUE_DEADLINE_RESERVE_MS,
  PUBLISH_DUE_LEASE_SECONDS,
  publishAttemptsOf,
  publishDueDeadlineReached,
} from "../lib/publish-due-policy.ts";

Deno.test("cap matches AutoLister's bulk publish cap of 5", () => {
  assertEquals(MAX_SCHEDULED_PUBLISH_ATTEMPTS, 5);
});

Deno.test("publishAttemptsOf: null, junk and negatives read as 0", () => {
  for (const v of [null, undefined, "abc", -3, Number.NaN]) {
    assertEquals(publishAttemptsOf(v), 0, `value ${String(v)}`);
  }
  assertEquals(publishAttemptsOf(3), 3);
  assertEquals(publishAttemptsOf("4"), 4);
});

Deno.test("canClaimScheduledPublish: allows 0..4, refuses 5 and above", () => {
  for (let n = 0; n < 5; n++) assert(canClaimScheduledPublish(n), `attempts ${n}`);
  assertEquals(canClaimScheduledPublish(5), false);
  assertEquals(canClaimScheduledPublish(9), false);
  assert(canClaimScheduledPublish(null), "a legacy null row is claimable");
});

Deno.test("planScheduledPublishFailure: attempts 1-4 keep the schedule", () => {
  const at = new Date("2026-09-23T12:34:56.000Z");
  for (let n = 1; n < 5; n++) {
    const plan = planScheduledPublishFailure(n, "Missing aspect: Size", at);
    assertEquals(plan.terminal, false, `attempt ${n}`);
    assertEquals(plan.patch, {
      publish_error: "Missing aspect: Size",
      publish_failed_at: "2026-09-23T12:34:56.000Z",
    });
    assert(!("scheduled_publish_at" in plan.patch), "must not drop the schedule early");
  }
});

Deno.test("planScheduledPublishFailure: the 5th failure drops the schedule, keeps the error", () => {
  const at = new Date("2026-09-23T12:34:56.000Z");
  const plan = planScheduledPublishFailure(5, "Missing aspect: Size", at);
  assertEquals(plan.terminal, true);
  assertEquals(plan.patch.scheduled_publish_at, null);
  assertEquals(plan.patch.publish_error, "Missing aspect: Size");
  assertEquals(plan.patch.publish_failed_at, "2026-09-23T12:34:56.000Z");
  // Reset so a seller who fixes the draft and reschedules gets a fresh budget.
  assertEquals(plan.patch.publish_attempts, 0);
});

Deno.test("planScheduledPublishFailure: stamps the failure time it is given and truncates the error", () => {
  const failedAt = new Date("2026-09-23T12:09:00.000Z");
  const plan = planScheduledPublishFailure(1, "x".repeat(1500), failedAt);
  assertEquals(plan.patch.publish_failed_at, failedAt.toISOString());
  assertEquals((plan.patch.publish_error as string).length, 1000);
});

Deno.test("a draft that always fails is published at most 5 times across ticks", () => {
  // Simulates the row across publish-due ticks: claim writes attempts + 1,
  // failure writes the plan's patch; a row with no schedule is no longer due.
  const row: { publish_attempts: number; scheduled_publish_at: string | null } = {
    publish_attempts: 0,
    scheduled_publish_at: "2026-09-23T12:00:00.000Z",
  };
  let publishCalls = 0;
  for (let tick = 0; tick < 200; tick++) {
    if (row.scheduled_publish_at === null) break;
    if (!canClaimScheduledPublish(row.publish_attempts)) break;
    row.publish_attempts += 1;
    publishCalls += 1;
    const plan = planScheduledPublishFailure(row.publish_attempts, "blocked", new Date());
    Object.assign(row, plan.patch);
  }
  assertEquals(publishCalls, 5);
  assertEquals(row.scheduled_publish_at, null);
});

Deno.test("publishDueDeadlineReached: stops claiming with the reserve left on the lease", () => {
  const start = 1_000_000;
  const leaseMs = PUBLISH_DUE_LEASE_SECONDS * 1000;
  const cutoff = leaseMs - PUBLISH_DUE_DEADLINE_RESERVE_MS;
  assertEquals(PUBLISH_DUE_LEASE_SECONDS, 240);
  assertEquals(publishDueDeadlineReached(start, start), false);
  assertEquals(publishDueDeadlineReached(start, start + cutoff - 1), false);
  assertEquals(publishDueDeadlineReached(start, start + cutoff), true);
  assertEquals(publishDueDeadlineReached(start, start + leaseMs + 5_000), true);
  assert(cutoff > 0 && cutoff < leaseMs, "the reserve must leave some of the lease to work in");
});

// The helpers above are only worth something if the route calls them. Read the
// publish-due handler's source and check the wiring, so reverting the route
// change goes red here even though the helpers still pass.
Deno.test("publish-due route: claims count attempts under the cap and failures use the plan", async () => {
  const src = await Deno.readTextFile(new URL("../routes/flipdesk-ebay.ts", import.meta.url));
  const start = src.indexOf('flipdeskEbayRoutes.post("/jobs/publish-due"');
  assert(start > -1, "publish-due handler not found");
  const end = src.indexOf("flipdeskEbayRoutes.", start + 10);
  const handler = src.slice(start, end);

  const updates = [...handler.matchAll(/\.update\(claimPatch\)([\s\S]*?)\.maybeSingle\(\)/g)];
  assertEquals(updates.length, 2, "expected the two sequential conditional claims");
  for (const [chain] of updates) {
    assert(chain.includes('.eq("publish_attempts", attempts)'), "claim must match the scanned count");
    assert(
      chain.includes('.lt("publish_attempts", MAX_SCHEDULED_PUBLISH_ATTEMPTS)'),
      "claim must re-check the cap",
    );
    assert(!chain.includes(".or("), "US-1552: no .or() on a mutation");
  }
  assert(
    /claimPatch = \{ publish_claimed_at: claimedAt, publish_attempts: attemptsAfterClaim \}/.test(handler),
    "claim must write the incremented attempt count",
  );
  assert(handler.includes("planScheduledPublishFailure(attemptsAfterClaim"), "failure must use the plan");
  assert(!handler.includes("publish_failed_at: now"), "failure must not stamp the scan-time now");
  assert(handler.includes("publishDueDeadlineReached(tickStartedMs"), "loop must check the deadline");
});
