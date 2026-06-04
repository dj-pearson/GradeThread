// US-402: clear scheduled-downgrade state on the schedule lifecycle, not a
// plan-string match.
import { assertEquals } from "@std/assert";
import {
  type PendingDowngradeState,
  shouldClearPendingDowngrade,
} from "../lib/pending-downgrade.ts";

const NOW = Date.parse("2026-06-04T00:00:00Z");
const PAST = "2026-06-01T00:00:00Z";
const FUTURE = "2026-06-30T00:00:00Z";

function pending(overrides: Partial<PendingDowngradeState> = {}): PendingDowngradeState {
  return {
    pendingPlan: "starter",
    pendingInterval: "monthly",
    pendingScheduleId: "sub_sched_1",
    pendingEffectiveAt: FUTURE,
    ...overrides,
  };
}

Deno.test("no pending state → never clears", () => {
  const none: PendingDowngradeState = {
    pendingPlan: null,
    pendingInterval: null,
    pendingScheduleId: null,
    pendingEffectiveAt: null,
  };
  assertEquals(shouldClearPendingDowngrade(none, "starter", "monthly", null, NOW), false);
});

Deno.test("schedule just ATTACHED (same id still present) → keep the banner", () => {
  // subscription.updated fires when the schedule is attached; plan unchanged.
  assertEquals(
    shouldClearPendingDowngrade(pending(), "pro", "monthly", "sub_sched_1", NOW),
    false,
  );
});

Deno.test("plan downgrade ACTIVATED (schedule released, plan matches) → clear", () => {
  assertEquals(
    shouldClearPendingDowngrade(pending(), "starter", "monthly", null, NOW),
    true,
  );
});

Deno.test("interval-only downgrade to YEARLY clears pending (US-402 AC)", () => {
  // pro/monthly → pro/yearly: the plan string never changes, so the old
  // plan-string match could never clear this. Schedule released + interval now
  // 'yearly' matches the target → clear.
  const p = pending({ pendingPlan: "pro", pendingInterval: "yearly" });
  // While the schedule is still attached, it must NOT clear early.
  assertEquals(shouldClearPendingDowngrade(p, "pro", "monthly", "sub_sched_1", NOW), false);
  // Once activated (schedule gone, interval now yearly) → clear.
  assertEquals(shouldClearPendingDowngrade(p, "pro", "yearly", null, NOW), true);
});

Deno.test("schedule replaced by a DIFFERENT id counts as gone", () => {
  assertEquals(
    shouldClearPendingDowngrade(pending(), "starter", "monthly", "sub_sched_2", NOW),
    true,
  );
});

Deno.test("stale reconcile: schedule gone + effective date passed → clear even without a clean target match", () => {
  const p = pending({ pendingEffectiveAt: PAST });
  assertEquals(shouldClearPendingDowngrade(p, "business", "monthly", null, NOW), true);
});

Deno.test("schedule gone, target not matched, effective NOT passed → keep", () => {
  const p = pending({ pendingEffectiveAt: FUTURE });
  assertEquals(shouldClearPendingDowngrade(p, "business", "monthly", null, NOW), false);
});
