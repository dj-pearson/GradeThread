// US-933: the unified trigger & condition engine is pure, so these run with no
// DB/env. They assert the AC4 fixture table directly: trial ends in 2 days ⇒
// due; already graded ⇒ skip the nudge; converted ⇒ exit — plus null-anchor
// safety, event "since enrolled_at", and that state predicates reuse the
// segment field/op/value model.

import { assert, assertEquals } from "@std/assert";
import {
  evaluateStepTrigger,
  evaluateTrigger,
  resolveAnchorMs,
  type TriggerSnapshot,
  type TriggerStep,
  validateTriggerSpec,
} from "../lib/drip-trigger.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-19T12:00:00.000Z");

/** A baseline mid-trial enrollment: signed up & enrolled 12 days ago, trial
 *  ends in 2 days, no step sent yet, not converted, never graded. */
function baseSnapshot(over: Partial<TriggerSnapshot> = {}): TriggerSnapshot {
  return {
    signupMs: NOW - 12 * DAY,
    enrolledAtMs: NOW - 12 * DAY,
    trialEndsAtMs: NOW + 2 * DAY,
    lastStepSentMs: null,
    events: {},
    fields: { subscription_status: "trialing", converted: false, grades_count: 0 },
    ...over,
  };
}

// ── AC4 fixture table ──

interface Fixture {
  name: string;
  step: TriggerStep;
  snap: TriggerSnapshot;
  expect: "due" | "wait" | "skip" | "exit";
}

const FIXTURES: Fixture[] = [
  {
    name: "trial ends in 2 days -> due (trial_ends_at minus 2 days)",
    step: { trigger: { kind: "time_anchor", anchor: "trial_ends_at", offsetHours: -48 } },
    snap: baseSnapshot(),
    expect: "due",
  },
  {
    name: "trial ends in 5 days -> wait (not yet within the 2-day window)",
    step: { trigger: { kind: "time_anchor", anchor: "trial_ends_at", offsetHours: -48 } },
    snap: baseSnapshot({ trialEndsAtMs: NOW + 5 * DAY }),
    expect: "wait",
  },
  {
    name: "no trial_ends_at -> wait (null anchor never fires)",
    step: { trigger: { kind: "time_anchor", anchor: "trial_ends_at", offsetHours: -48 } },
    snap: baseSnapshot({ trialEndsAtMs: null }),
    expect: "wait",
  },
  {
    name: "already graded -> skip the activation nudge",
    step: {
      trigger: { kind: "time_anchor", anchor: "enrolled_at", offsetHours: 72 },
      skipWhen: { match: "all", conditions: [{ field: "grades_count", op: "gt", value: 0 }] },
    },
    snap: baseSnapshot({ fields: { grades_count: 3 } }),
    expect: "skip",
  },
  {
    name: "not yet graded -> nudge is due",
    step: {
      trigger: { kind: "time_anchor", anchor: "enrolled_at", offsetHours: 72 },
      skipWhen: { match: "all", conditions: [{ field: "grades_count", op: "gt", value: 0 }] },
    },
    snap: baseSnapshot({ fields: { grades_count: 0 } }),
    expect: "due",
  },
  {
    name: "converted -> exit the journey (beats a due trigger)",
    step: {
      trigger: { kind: "time_anchor", anchor: "trial_ends_at", offsetHours: -48 },
      exitWhen: { match: "all", conditions: [{ field: "converted", op: "eq", value: true }] },
    },
    snap: baseSnapshot({ fields: { converted: true } }),
    expect: "exit",
  },
  {
    name: "state predicate: subscription_status != active -> due",
    step: {
      trigger: {
        kind: "state",
        rules: { match: "all", conditions: [{ field: "subscription_status", op: "neq", value: "active" }] },
      },
    },
    snap: baseSnapshot({ fields: { subscription_status: "canceled" } }),
    expect: "due",
  },
  {
    name: "state predicate: subscription_status != active -> wait when active",
    step: {
      trigger: {
        kind: "state",
        rules: { match: "all", conditions: [{ field: "subscription_status", op: "neq", value: "active" }] },
      },
    },
    snap: baseSnapshot({ fields: { subscription_status: "active" } }),
    expect: "wait",
  },
  {
    name: "AND-conditions unmet -> skip even when trigger fired",
    step: {
      trigger: { kind: "time_anchor", anchor: "trial_ends_at", offsetHours: -48 },
      conditions: { match: "all", conditions: [{ field: "grades_count", op: "gte", value: 1 }] },
    },
    snap: baseSnapshot({ fields: { grades_count: 0 } }),
    expect: "skip",
  },
];

for (const f of FIXTURES) {
  Deno.test(`evaluateStepTrigger: ${f.name}`, () => {
    assertEquals(evaluateStepTrigger(f.step, f.snap, NOW).outcome, f.expect);
  });
}

// ── Event triggers: "has occurred since enrolled_at" (AC3) ──

Deno.test("event first_grade since enrolled_at: occurred after enrollment -> due", () => {
  const snap = baseSnapshot({ events: { first_grade: NOW - 1 * DAY } });
  assert(evaluateTrigger({ kind: "event", event: "first_grade", since: "enrolled_at" }, snap, NOW));
});

Deno.test("event first_grade since enrolled_at: occurred BEFORE enrollment -> not due", () => {
  // Enrolled 12d ago; the grade happened 20d ago (pre-enrollment) -> excluded.
  const snap = baseSnapshot({ events: { first_grade: NOW - 20 * DAY } });
  assert(!evaluateTrigger({ kind: "event", event: "first_grade", since: "enrolled_at" }, snap, NOW));
});

Deno.test("event never occurred -> not due", () => {
  const snap = baseSnapshot({ events: {} });
  assert(!evaluateTrigger({ kind: "event", event: "first_grade", since: "enrolled_at" }, snap, NOW));
});

Deno.test("event in the future (after now) -> not due", () => {
  const snap = baseSnapshot({ events: { first_grade: NOW + 1 * DAY } });
  assert(!evaluateTrigger({ kind: "event", event: "first_grade" }, snap, NOW));
});

Deno.test("event without a since bound -> due once it has ever occurred", () => {
  const snap = baseSnapshot({ events: { first_grade: NOW - 30 * DAY } });
  assert(evaluateTrigger({ kind: "event", event: "first_grade" }, snap, NOW));
});

// ── Time-anchor: signup + N days, and last_step_sent ──

Deno.test("time_anchor signup + 7 days: due on day 12, not on day 3", () => {
  const trig = { kind: "time_anchor", anchor: "signup", offsetHours: 7 * 24 } as const;
  assert(evaluateTrigger(trig, baseSnapshot(), NOW)); // signup 12d ago
  assert(!evaluateTrigger(trig, baseSnapshot({ signupMs: NOW - 3 * DAY }), NOW));
});

Deno.test("time_anchor last_step_sent + 24h: null last-send never fires", () => {
  const trig = { kind: "time_anchor", anchor: "last_step_sent", offsetHours: 24 } as const;
  assert(!evaluateTrigger(trig, baseSnapshot({ lastStepSentMs: null }), NOW));
  assert(evaluateTrigger(trig, baseSnapshot({ lastStepSentMs: NOW - 2 * DAY }), NOW));
});

// ── Anchor resolution + timezone safety ──

Deno.test("resolveAnchorMs maps each anchor; trial_ends_at can be null", () => {
  const snap = baseSnapshot({ trialEndsAtMs: null });
  assertEquals(resolveAnchorMs("signup", snap), snap.signupMs);
  assertEquals(resolveAnchorMs("created_at", snap), snap.signupMs);
  assertEquals(resolveAnchorMs("enrolled_at", snap), snap.enrolledAtMs);
  assertEquals(resolveAnchorMs("trial_ends_at", snap), null);
});

Deno.test("date state predicate compares in UTC ms regardless of ISO offset", () => {
  // last_active_at 10 days ago, "within_days 7" should be FALSE (stale).
  const stale = baseSnapshot({ fields: { last_active_at: new Date(NOW - 10 * DAY).toISOString() } });
  assert(
    !evaluateTrigger(
      { kind: "state", rules: { match: "all", conditions: [{ field: "last_active_at", op: "within_days", value: 7 }] } },
      stale,
      NOW,
    ),
  );
  // Active 2 days ago, "within_days 7" should be TRUE.
  const fresh = baseSnapshot({ fields: { last_active_at: new Date(NOW - 2 * DAY).toISOString() } });
  assert(
    evaluateTrigger(
      { kind: "state", rules: { match: "all", conditions: [{ field: "last_active_at", op: "within_days", value: 7 }] } },
      fresh,
      NOW,
    ),
  );
});

// ── Builder validation ──

Deno.test("validateTriggerSpec accepts the three valid kinds", () => {
  assert(validateTriggerSpec({ kind: "event", event: "first_grade", since: "enrolled_at" }).ok);
  assert(validateTriggerSpec({ kind: "time_anchor", anchor: "trial_ends_at", offsetHours: -48 }).ok);
  assert(
    validateTriggerSpec({
      kind: "state",
      rules: { match: "all", conditions: [{ field: "subscription_status", op: "neq", value: "active" }] },
    }).ok,
  );
});

Deno.test("validateTriggerSpec rejects bad kind / anchor / unknown field", () => {
  assert(!validateTriggerSpec({ kind: "nope" }).ok);
  assert(!validateTriggerSpec({ kind: "time_anchor", anchor: "moon", offsetHours: 1 }).ok);
  assert(!validateTriggerSpec({ kind: "event", event: "" }).ok);
  assert(
    !validateTriggerSpec({
      kind: "state",
      rules: { match: "all", conditions: [{ field: "definitely_not_a_field", op: "eq", value: "x" }] },
    }).ok,
  );
});
