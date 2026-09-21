// Worth My Time, R1 02/12 (US-3167): the state machine a work session runs on.
//
// A session is a block of time a seller sits down to work. It holds an ordered
// list of tasks, and a stream of timing events recording when each one started,
// paused and finished. This module owns the RULES; the tables that hold them
// are 00818 and the planner that fills them is R1 06/12 onward.
//
// ── WHAT IS DELIBERATELY NOT STORED (AC1) ───────────────────────────────────
// No photos, no buyer addresses, no garment notes. A session row references an
// item and snapshots the few facts a plan was built on -- the bin it is in, the
// estimate and where that estimate came from -- and nothing else. History is a
// record of WORK, and the moment it becomes a second copy of the item it also
// becomes a second thing to erase, a second thing to leak and a second thing to
// keep in step.
//
// ── WHY THE GUARDS ARE HERE AND ALSO IN THE DATABASE ────────────────────────
// Every rule below is enforced twice on purpose, and the two are not
// redundant. This module refuses a bad transition with a sentence a seller can
// read; the partial unique indexes and CHECKs in 00818 refuse it under
// CONCURRENCY, which no amount of application code can do on its own. Two tabs
// pressing Start at the same moment both pass a check-then-write in JavaScript
// and only one survives a unique index.

/** Where a session is in its life. */
export const SESSION_STATES = [
  "planned",
  "active",
  "paused",
  "completed",
  "abandoned",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Where one task within a session is. */
export const TASK_STATES = [
  "pending",
  "active",
  "completed",
  "skipped",
  "invalidated",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * The legal session moves.
 *
 * `planned -> abandoned` is legal and matters: a seller who builds a plan and
 * walks away has abandoned it, and forcing them through `active` first would
 * record a session that never happened as having been worked.
 *
 * Nothing leaves a terminal state. A session that was completed and then
 * reopened would make every number derived from it -- minutes worked, tasks
 * finished, the R2 learning in US-3178 -- a moving target.
 */
const SESSION_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  planned: ["active", "abandoned"],
  active: ["paused", "completed", "abandoned"],
  paused: ["active", "completed", "abandoned"],
  completed: [],
  abandoned: [],
};

/**
 * The legal task moves.
 *
 * `invalidated` is what happens when the world moved under a task: the item
 * sold, or was deleted, or somebody else already photographed it. It is
 * reachable from `pending` and from `active`, because a seller can be halfway
 * through a task when the item sells out from under them.
 *
 * `active -> pending` is legal and is how pausing a session releases its task
 * without recording it as skipped. Skipping is a CHOICE the seller made and
 * R2's learning reads it as one; a pause is not.
 */
const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  pending: ["active", "skipped", "invalidated"],
  active: ["pending", "completed", "skipped", "invalidated"],
  completed: [],
  skipped: [],
  invalidated: [],
};

/**
 * Terminal states are DERIVED from the tables above, never listed a second
 * time.
 *
 * They used to be two hand-written lists, and a sabotage that added
 * `completed: ["active"]` to the table left every test green -- the terminal
 * check ran first, so the table entry was unreachable and the belt-and-braces
 * HID the change rather than catching it. Two layers guarding one rule is
 * fine; two layers that can disagree about it is how the wrong one eventually
 * wins. One table, one derivation, nothing to drift.
 */
export const TERMINAL_SESSION_STATES: readonly SessionState[] = SESSION_STATES
  .filter((s) => SESSION_TRANSITIONS[s].length === 0);

export const TERMINAL_TASK_STATES: readonly TaskState[] = TASK_STATES
  .filter((t) => TASK_TRANSITIONS[t].length === 0);

export interface TransitionRefusal {
  code: "unknown_state" | "terminal" | "illegal" | "no_change";
  message: string;
}

/**
 * May this session move? Pure, so the rule is testable without a database.
 *
 * A no-op (`active -> active`) is REFUSED rather than allowed through. It is
 * almost always a double-submit, and letting it pass writes a second timing
 * event for a transition that did not happen -- which is exactly the
 * double-counting AC3 is about.
 */
export function canTransitionSession(
  from: string,
  to: string,
): { ok: true } | { ok: false; refusal: TransitionRefusal } {
  if (!(SESSION_STATES as readonly string[]).includes(from)) {
    return {
      ok: false,
      refusal: { code: "unknown_state", message: `Unknown session state: ${from}.` },
    };
  }
  if (!(SESSION_STATES as readonly string[]).includes(to)) {
    return {
      ok: false,
      refusal: { code: "unknown_state", message: `Unknown session state: ${to}.` },
    };
  }
  if (from === to) {
    return {
      ok: false,
      refusal: {
        code: "no_change",
        message: `This session is already ${from}.`,
      },
    };
  }
  if (TERMINAL_SESSION_STATES.includes(from as SessionState)) {
    return {
      ok: false,
      refusal: {
        code: "terminal",
        message: `This session is ${from} and can't be reopened.`,
      },
    };
  }
  if (!SESSION_TRANSITIONS[from as SessionState].includes(to as SessionState)) {
    return {
      ok: false,
      refusal: {
        code: "illegal",
        message: `A session can't go from ${from} to ${to}.`,
      },
    };
  }
  return { ok: true };
}

/** May this task move? Same shape and the same no-op rule. */
export function canTransitionTask(
  from: string,
  to: string,
): { ok: true } | { ok: false; refusal: TransitionRefusal } {
  if (!(TASK_STATES as readonly string[]).includes(from)) {
    return {
      ok: false,
      refusal: { code: "unknown_state", message: `Unknown task state: ${from}.` },
    };
  }
  if (!(TASK_STATES as readonly string[]).includes(to)) {
    return {
      ok: false,
      refusal: { code: "unknown_state", message: `Unknown task state: ${to}.` },
    };
  }
  if (from === to) {
    return {
      ok: false,
      refusal: { code: "no_change", message: `This task is already ${from}.` },
    };
  }
  if (TERMINAL_TASK_STATES.includes(from as TaskState)) {
    return {
      ok: false,
      refusal: {
        code: "terminal",
        message: `This task is ${from} and can't be changed.`,
      },
    };
  }
  if (!TASK_TRANSITIONS[from as TaskState].includes(to as TaskState)) {
    return {
      ok: false,
      refusal: { code: "illegal", message: `A task can't go from ${from} to ${to}.` },
    };
  }
  return { ok: true };
}

// ── Timing (AC3) ────────────────────────────────────────────────────

export const TIMING_EVENT_KINDS = [
  "task_started",
  "task_paused",
  "task_completed",
  "session_paused",
  "session_resumed",
] as const;
export type TimingEventKind = (typeof TIMING_EVENT_KINDS)[number];

export interface TimingEvent {
  kind: TimingEventKind;
  /** SERVER time. A client clock is not evidence of when anything happened. */
  occurredAt: string;
}

/**
 * The retry key an event is deduplicated on.
 *
 * WHY IT IS DERIVED AND NOT A RANDOM UUID FROM THE CLIENT. A client that
 * generates a fresh id per attempt deduplicates nothing: the retry after a
 * timeout carries a different key and lands as a second event. Keying on what
 * the event IS -- this task, this kind, this attempt number -- means a retry of
 * the same intent produces the same key and the unique index refuses it.
 *
 * `attempt` is the caller's count of how many times this task has entered this
 * state, not how many times it has retried the HTTP call. Starting a task,
 * pausing it and starting it again is attempt 2 and is a real second event.
 */
export function timingRetryKey(
  taskId: string,
  kind: TimingEventKind,
  attempt: number,
): string {
  if (!taskId) throw new Error("timingRetryKey needs a task id.");
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("timingRetryKey needs an attempt number of 1 or more.");
  }
  return `${taskId}:${kind}:${attempt}`;
}

export interface ElapsedInput {
  /** Every timing event for one task, in any order. */
  events: readonly TimingEvent[];
}

/**
 * Observed elapsed minutes: the wall clock between starts and their stops.
 *
 * OBSERVED IS NOT CONFIRMED AND THE THREE ARE STORED SEPARATELY (AC1, AC3).
 * Observed is what the clock says. Confirmed is what the seller says they
 * actually spent, which is lower whenever they answered the door. A correction
 * is a later edit of the confirmed figure. Collapsing them would make every
 * estimate in R2 learn from time spent making tea.
 *
 * Unpaired events are IGNORED rather than guessed at: a start with no stop
 * contributes nothing, because the alternative is charging a seller for the
 * hours between closing a laptop and opening it again.
 */
export function observedMinutes(input: ElapsedInput): number {
  const sorted = [...input.events].sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0
  );
  let total = 0;
  let openedAt: number | null = null;
  for (const e of sorted) {
    const t = Date.parse(e.occurredAt);
    if (!Number.isFinite(t)) continue;
    if (e.kind === "task_started" || e.kind === "session_resumed") {
      // A second start with no stop between them is a duplicate the unique
      // index should have refused. Keep the FIRST: taking the later one would
      // silently shorten the interval and read as the seller working less.
      if (openedAt === null) openedAt = t;
      continue;
    }
    if (
      e.kind === "task_paused" || e.kind === "task_completed" ||
      e.kind === "session_paused"
    ) {
      if (openedAt === null) continue;
      if (t > openedAt) total += t - openedAt;
      openedAt = null;
    }
  }
  return Math.round(total / 60_000);
}

/**
 * What a task's minutes actually are, given what was observed and what the
 * seller said.
 *
 * The order is deliberate: a correction beats a confirmation beats the clock.
 * A person editing a number afterwards has more information than the person
 * who typed it during the work, who in turn has more than the clock.
 */
export function effectiveMinutes(args: {
  observed: number;
  confirmed: number | null;
  correction: number | null;
}): { minutes: number; source: "correction" | "confirmed" | "observed" } {
  if (args.correction != null && Number.isFinite(args.correction)) {
    return { minutes: args.correction, source: "correction" };
  }
  if (args.confirmed != null && Number.isFinite(args.confirmed)) {
    return { minutes: args.confirmed, source: "confirmed" };
  }
  return { minutes: args.observed, source: "observed" };
}

// ── Optimistic concurrency (AC4) ────────────────────────────────────

export interface RevisionRefusal {
  code: "stale_revision";
  message: string;
  expected: number;
  actual: number;
}

/**
 * Does the writer hold the revision they think they do?
 *
 * TWO TABS ARE THE CASE THIS EXISTS FOR. Both load the session at revision 4,
 * both edit, both write. Without this the second write silently wins and the
 * first seller's completed task vanishes with no error anywhere. With it the
 * second write is refused and the client reloads.
 *
 * Pure, so the rule is testable without a database -- but the DATABASE is what
 * enforces it, through `where revision = $expected` on the update. A check
 * here and an unguarded write there would be theatre.
 */
export function checkRevision(
  expected: unknown,
  actual: number,
): { ok: true } | { ok: false; refusal: RevisionRefusal } {
  if (typeof expected !== "number" || !Number.isInteger(expected)) {
    return {
      ok: false,
      refusal: {
        code: "stale_revision",
        message: "This change is missing its revision. Reload and try again.",
        expected: -1,
        actual,
      },
    };
  }
  if (expected !== actual) {
    return {
      ok: false,
      refusal: {
        code: "stale_revision",
        message:
          "Someone else changed this session while you were working. Reload to see it.",
        expected,
        actual,
      },
    };
  }
  return { ok: true };
}

// ── Item tombstones (AC4) ───────────────────────────────────────────

export interface TaskItemRef {
  inventoryItemId: string | null;
  /** The title as it was when the plan was made. Never refreshed. */
  itemTitleSnapshot: string | null;
}

/**
 * Can this task still be worked?
 *
 * A DELETED ITEM LEAVES THE ROW, AND THE ROW MUST NOT BE ACTIONABLE. The
 * history is worth keeping -- a seller's record of the hour they spent is
 * theirs whether or not the garment still exists -- but a task pointing at
 * nothing must never be handed to them as work. The FK is ON DELETE SET NULL
 * and this is the read that makes the null mean something.
 */
export function isActionable(ref: TaskItemRef, state: TaskState): boolean {
  if (TERMINAL_TASK_STATES.includes(state)) return false;
  return ref.inventoryItemId !== null;
}
