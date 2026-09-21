// Worth My Time, R1 02/12 (US-3167): the transition rules and the timing math.
//
// THE DIVISION OF LABOUR IS THE POINT. This file drives the rules a person can
// read a refusal from. The rules only a DATABASE can hold -- two concurrent
// Starts, a retried event, a stale revision, a deleted item, erasure -- are
// proved by scripts/check-work-session-storage.mjs against a real Postgres,
// because a unit test cannot tell a check-then-write from an atomic one.
//
// Run alone:
//   deno test --allow-net --allow-env --allow-read src/tests/work-sessions_test.ts

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  canTransitionSession,
  canTransitionTask,
  checkRevision,
  effectiveMinutes,
  isActionable,
  observedMinutes,
  SESSION_STATES,
  TASK_STATES,
  timingRetryKey,
  type SessionState,
  type TaskState,
} from "../lib/work-sessions.ts";

// ── Session transitions (AC2) ───────────────────────────────────────

Deno.test("a session walks the path a real work block takes", () => {
  assert(canTransitionSession("planned", "active").ok);
  assert(canTransitionSession("active", "paused").ok);
  assert(canTransitionSession("paused", "active").ok);
  assert(canTransitionSession("active", "completed").ok);
  assert(canTransitionSession("paused", "completed").ok);
});

Deno.test("a plan can be abandoned without pretending it was worked", () => {
  // Forcing planned -> active -> abandoned would record a session that never
  // happened as having been worked, and R2's learning would train on it.
  assert(canTransitionSession("planned", "abandoned").ok);
});

Deno.test("nothing leaves a terminal session state", () => {
  for (const from of ["completed", "abandoned"]) {
    for (const to of SESSION_STATES) {
      const r = canTransitionSession(from, to);
      assert(!r.ok, `${from} -> ${to} must be refused`);
      // A no-op reports as no_change rather than terminal; both are refusals
      // and the distinction is what the client renders.
      assert(r.refusal.code === "terminal" || r.refusal.code === "no_change");
    }
  }
});

Deno.test("a session cannot skip from planned straight to paused or completed", () => {
  for (const to of ["paused", "completed"] as SessionState[]) {
    const r = canTransitionSession("planned", to);
    assert(!r.ok);
    assertEquals(r.refusal.code, "illegal");
  }
});

Deno.test("a no-op transition is REFUSED, because it is a double-submit", () => {
  // Letting active -> active through writes a second timing event for a
  // transition that did not happen, which is exactly the double-counting AC3
  // exists to stop.
  const r = canTransitionSession("active", "active");
  assert(!r.ok);
  assertEquals(r.refusal.code, "no_change");
});

Deno.test("an unknown state is refused rather than treated as new", () => {
  for (const [from, to] of [["zombie", "active"], ["active", "zombie"]]) {
    const r = canTransitionSession(from!, to!);
    assert(!r.ok);
    assertEquals(r.refusal.code, "unknown_state");
  }
});

Deno.test("the transition TABLE and the terminal LIST cannot drift apart", () => {
  // Found by a sabotage that did NOT fire. Adding `completed: ["active"]` to
  // the table left every test green, because the terminal check runs BEFORE
  // the table is consulted -- so the table entry was unreachable and the
  // belt-and-braces hid the change rather than catching it.
  //
  // Two layers guarding the same rule is right; two layers DISAGREEING about
  // it is how the wrong one eventually wins. This asserts they agree, which is
  // the only thing the behavioural cases above cannot see.
  for (const state of ["completed", "abandoned"] as SessionState[]) {
    for (const to of SESSION_STATES) {
      const r = canTransitionSession(state, to);
      assert(!r.ok, `${state} -> ${to} must be refused`);
      if (state !== to) {
        assertEquals(
          r.refusal.code,
          "terminal",
          `${state} -> ${to} refused for the wrong reason: the table and the terminal list disagree`,
        );
      }
    }
  }
  for (const state of ["completed", "skipped", "invalidated"] as TaskState[]) {
    for (const to of TASK_STATES) {
      const r = canTransitionTask(state, to);
      assert(!r.ok);
      if (state !== to) assertEquals(r.refusal.code, "terminal");
    }
  }
});

// ── Task transitions (AC2) ──────────────────────────────────────────

Deno.test("a task can be released back to pending without being skipped", () => {
  // Pausing a session releases its active task. Recording that as `skipped`
  // would tell R2 the seller CHOSE not to do it, which is a different fact.
  assert(canTransitionTask("active", "pending").ok);
  assert(canTransitionTask("pending", "active").ok);
  assert(canTransitionTask("active", "completed").ok);
});

Deno.test("a task can be invalidated from pending AND from active", () => {
  // The item sold out from under the seller. That can happen while they are
  // halfway through the task, so both doors have to be open.
  assert(canTransitionTask("pending", "invalidated").ok);
  assert(canTransitionTask("active", "invalidated").ok);
});

Deno.test("nothing leaves a terminal task state, invalidated included", () => {
  for (const from of ["completed", "skipped", "invalidated"]) {
    for (const to of TASK_STATES) {
      const r = canTransitionTask(from, to);
      assert(!r.ok, `${from} -> ${to} must be refused`);
    }
  }
});

// ── Timing retry keys (AC3) ─────────────────────────────────────────

Deno.test("the retry key is derived from the event, not minted per attempt", () => {
  // A client generating a fresh uuid per try deduplicates NOTHING: the retry
  // after a timeout carries a different key and lands as a second event. Two
  // requests expressing the same intent must produce the same key.
  const a = timingRetryKey("task-1", "task_started", 1);
  const b = timingRetryKey("task-1", "task_started", 1);
  assertEquals(a, b);

  // ...and a genuine second start, after a pause, is a different event.
  assert(a !== timingRetryKey("task-1", "task_started", 2));
  assert(a !== timingRetryKey("task-2", "task_started", 1));
  assert(a !== timingRetryKey("task-1", "task_paused", 1));
});

Deno.test("a retry key refuses inputs that would collide silently", () => {
  assertThrows(() => timingRetryKey("", "task_started", 1));
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assertThrows(() => timingRetryKey("task-1", "task_started", bad));
  }
});

// ── Observed time (AC3) ─────────────────────────────────────────────

const T = (min: number) => new Date(Date.UTC(2026, 8, 21, 10, min)).toISOString();

Deno.test("observed minutes are the paired intervals, in any input order", () => {
  const events = [
    { kind: "task_paused" as const, occurredAt: T(12) },
    { kind: "task_started" as const, occurredAt: T(0) },
    { kind: "task_completed" as const, occurredAt: T(25) },
    { kind: "task_started" as const, occurredAt: T(20) },
  ];
  // 0->12 is 12, 20->25 is 5.
  assertEquals(observedMinutes({ events }), 17);
});

Deno.test("an unpaired start contributes NOTHING", () => {
  // The alternative is charging a seller for the hours between closing a
  // laptop and opening it again, which is the number that would then teach the
  // estimator that photographing a jacket takes nine hours.
  assertEquals(observedMinutes({ events: [{ kind: "task_started", occurredAt: T(0) }] }), 0);
  // A stop with no start is ignored rather than counted from zero.
  assertEquals(observedMinutes({ events: [{ kind: "task_paused", occurredAt: T(30) }] }), 0);
});

Deno.test("a duplicate start keeps the FIRST, so time is never shortened", () => {
  // Two starts with no stop between them means the unique index should have
  // refused one. Taking the later would silently shorten the interval and read
  // as the seller having worked less than they did.
  const events = [
    { kind: "task_started" as const, occurredAt: T(0) },
    { kind: "task_started" as const, occurredAt: T(8) },
    { kind: "task_completed" as const, occurredAt: T(20) },
  ];
  assertEquals(observedMinutes({ events }), 20);
});

Deno.test("an unparseable timestamp is skipped, not counted as 1970", () => {
  const events = [
    { kind: "task_started" as const, occurredAt: "not a date" },
    { kind: "task_completed" as const, occurredAt: T(10) },
  ];
  assertEquals(observedMinutes({ events }), 0);
});

// ── Which number is the truth (AC3) ─────────────────────────────────

Deno.test("a correction beats a confirmation beats the clock", () => {
  // The order is about who knew most. Someone editing afterwards has more
  // information than someone typing during the work, who has more than a clock
  // that cannot see the doorbell.
  assertEquals(
    effectiveMinutes({ observed: 40, confirmed: 25, correction: 30 }),
    { minutes: 30, source: "correction" },
  );
  assertEquals(
    effectiveMinutes({ observed: 40, confirmed: 25, correction: null }),
    { minutes: 25, source: "confirmed" },
  );
  assertEquals(
    effectiveMinutes({ observed: 40, confirmed: null, correction: null }),
    { minutes: 40, source: "observed" },
  );
});

Deno.test("a confirmed ZERO is a real answer, not a missing one", () => {
  // The seller opened the task and did nothing. `??` or a falsy check here
  // would fall through to the clock and record the interruption as work.
  assertEquals(
    effectiveMinutes({ observed: 40, confirmed: 0, correction: null }),
    { minutes: 0, source: "confirmed" },
  );
  assertEquals(
    effectiveMinutes({ observed: 40, confirmed: 25, correction: 0 }),
    { minutes: 0, source: "correction" },
  );
});

// ── Optimistic concurrency (AC4) ────────────────────────────────────

Deno.test("a stale revision is refused and says what it saw", () => {
  assert(checkRevision(4, 4).ok);
  const r = checkRevision(4, 5);
  assert(!r.ok);
  assertEquals(r.refusal.code, "stale_revision");
  assertEquals(r.refusal.expected, 4);
  assertEquals(r.refusal.actual, 5);
});

Deno.test("a MISSING revision is refused, not treated as a fresh write", () => {
  // The dangerous default. A client that forgets to send one would otherwise
  // win every race, which is the exact silent overwrite AC4 is about.
  for (const bad of [undefined, null, "4", 4.5, Number.NaN]) {
    const r = checkRevision(bad, 4);
    assert(!r.ok, `${String(bad)} must be refused`);
  }
});

// ── Tombstones (AC4) ────────────────────────────────────────────────

Deno.test("a task whose item was deleted keeps its history and stops being work", () => {
  const live = { inventoryItemId: "item-1", itemTitleSnapshot: "Carhartt jacket" };
  const dead = { inventoryItemId: null, itemTitleSnapshot: "Carhartt jacket" };
  assert(isActionable(live, "pending"));
  assert(isActionable(live, "active"));
  assert(
    !isActionable(dead, "pending"),
    "a task pointing at nothing must never be handed to a seller as work",
  );
  // The snapshot survives either way -- the seller's record of the hour they
  // spent is theirs whether or not the garment still exists.
  assertEquals(dead.itemTitleSnapshot, "Carhartt jacket");
});

Deno.test("a finished task is never actionable, item or no item", () => {
  const live = { inventoryItemId: "item-1", itemTitleSnapshot: "x" };
  for (const state of ["completed", "skipped", "invalidated"] as TaskState[]) {
    assert(!isActionable(live, state), `${state} must not be actionable`);
  }
});

// ── The no-model-calls contract (AC1, inherited from R1 01/12) ──────

Deno.test("AC1: the session rules need no model call", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/work-sessions.ts", import.meta.url),
  );
  const code = src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
  for (const banned of ["anthropic", "messages.create", "messages.stream", "fetch("]) {
    assert(
      !code.includes(banned),
      `work-sessions.ts names "${banned}": R1 planning is rule-based with no model calls`,
    );
  }
});

// ── US-1552: never .or() on a mutation ──────────────────────────────

Deno.test("AC5: no .or() on an UPDATE or DELETE anywhere in this story's code", async () => {
  // The self-hosted prod PostgREST rejects logical operators on mutations with
  // a 42703 naming a column that does not exist, while the newer local stack
  // accepts them -- so CI cannot catch this and a scan is the only guard there
  // is.
  for (
    const rel of [
      "../lib/work-sessions.ts",
      "../lib/work-preferences.ts",
      "../routes/flipdesk-work-preferences.ts",
    ]
  ) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    assert(
      !/\.(update|delete)\([^)]*\)[\s\S]{0,400}?\.or\(/.test(src),
      `${rel} calls .or() on a mutation (US-1552)`,
    );
  }
});
