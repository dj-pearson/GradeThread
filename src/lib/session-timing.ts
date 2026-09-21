// Worth My Time, R1 11/12 (US-3176): what a running session knows about
// itself.
//
// Pure, so every rule below is testable without a browser, a clock or a
// database. The session's STATE lives on the server (routes/flipdesk-planner.ts
// and lib/work-sessions.ts own the transitions); what lives here is the
// reading of it: which task is current, how much is left, and what the clock is
// and is not evidence of.
//
// ── A HIDDEN TAB IS NOT EVIDENCE OF ANYTHING (AC3) ──────────────────────────
// This is the rule the whole file exists for, and both of the obvious
// implementations are wrong.
//
// Subtracting hidden time assumes the seller stopped working. They almost
// certainly did not: photographing a jacket means putting the laptop down and
// picking up a camera, and measuring means both hands on a tape. The tab is
// hidden for exactly the minutes the work is happening. Subtract them and the
// photography estimate trains toward zero.
//
// Counting hidden time assumes they kept working. Also wrong, and worse:
// somebody who closes the lid and comes back after dinner gets charged for the
// dinner, and every estimate built on that is inflated forever.
//
// So we do neither. The clock keeps running, the hidden stretch is MEASURED
// and REPORTED, and the seller is asked. `effectiveMinutes` on the server
// already prefers what the person said over what the clock said; this is the
// half that makes sure they are asked when it matters, and not nagged when it
// does not.
//
// ── NOTHING HERE DECIDES A TASK IS DONE ─────────────────────────────────────
// `reconcile()` compares what the plan asked for against the item's durable
// facts and reports the disagreement. It does not block completion and it does
// not complete anything. A seller who photographed a garment on their phone and
// has not uploaded yet is telling the truth when they say they did the work,
// and a screen that called them a liar would be wrong. Equally, a timer that
// stopped is not a photograph. Both facts get said.

import { factsOf } from "@/lib/workflow";
import type { ItemListRow } from "@/lib/item-list-columns";

export const SESSION_TIMING_VERSION = 1;

/**
 * Below this, a hidden stretch is not worth mentioning.
 *
 * Switching to a tab to look something up, or a notification stealing focus,
 * is half a minute and is not the seller leaving. Asking about it every time
 * trains them to dismiss the question, which costs the answer in the cases
 * that do matter.
 */
export const HIDDEN_NOISE_FLOOR_MS = 60_000;

export interface HiddenSpan {
  /** ms since epoch. */
  from: number;
  /** ms since epoch, or null while the tab is still hidden. */
  to: number | null;
}

/**
 * How long the tab was hidden inside a window, in milliseconds.
 *
 * An open span (`to: null`) is clamped to the window's end rather than
 * ignored: the tab being hidden RIGHT NOW is the commonest case at the moment
 * the seller comes back and presses Done, and dropping it would report zero
 * for the one measurement that matters.
 */
export function hiddenMsDuring(
  spans: readonly HiddenSpan[],
  from: number,
  to: number,
): number {
  if (!(to > from)) return 0;
  let total = 0;
  for (const span of spans) {
    const start = Math.max(span.from, from);
    const end = Math.min(span.to ?? to, to);
    if (end > start) total += end - start;
  }
  return total;
}

export interface TimingCertainty {
  observedMinutes: number;
  hiddenMinutes: number;
  /** True when a stretch long enough to matter went unobserved. */
  uncertain: boolean;
  /**
   * What to put next to the number. Empty when there is nothing to say --
   * an empty string is the signal not to render the line at all.
   */
  sentence: string;
}

/**
 * Read the clock, and say honestly what it did and did not see.
 *
 * The sentence never asserts which way it went. "You may have been working or
 * you may have been away" is the true statement, and a screen that guessed
 * would be wrong roughly half the time while sounding certain both times.
 */
export function timingCertainty(args: {
  startedAt: number;
  endedAt: number;
  hidden: readonly HiddenSpan[];
}): TimingCertainty {
  const elapsed = Math.max(0, args.endedAt - args.startedAt);
  const hiddenMs = hiddenMsDuring(args.hidden, args.startedAt, args.endedAt);
  // Work that happened took more than no time. Math.round puts anything under
  // thirty seconds at zero, and a recorded zero is not a small number -- it is
  // a claim that the task is free, and R2 learns from these. So a nonzero
  // elapsed floors at one minute. Zero stays available for the case it is
  // actually true: no elapsed window at all.
  const observedMinutes = elapsed === 0 ? 0 : Math.max(1, Math.round(elapsed / 60_000));
  const hiddenMinutes = Math.round(hiddenMs / 60_000);
  const uncertain = hiddenMs >= HIDDEN_NOISE_FLOOR_MS;
  return {
    observedMinutes,
    hiddenMinutes,
    uncertain,
    sentence: uncertain
      ? `This tab was in the background for about ${hiddenMinutes} of those ` +
        `${observedMinutes} minutes. You may have been working on the item or ` +
        `you may have been away, so change the number if it's wrong.`
      : "",
  };
}

// ── Where the session is ────────────────────────────────────────────

export interface SessionTaskView {
  id: string;
  position: number;
  state: string;
  action_key: string;
  inventory_item_id: string | null;
  item_title: string | null;
  bin: string | null;
  estimate_minutes: number | null;
  confirmed_minutes?: number | null;
  actionable: boolean;
}

export interface SessionProgress {
  /** The task the seller is on, or the next one they could start. */
  current: SessionTaskView | null;
  /** True when `current` is already running rather than merely next up. */
  currentIsActive: boolean;
  done: SessionTaskView[];
  skipped: SessionTaskView[];
  /** Closed because the item sold, moved or was deleted under them. */
  invalidated: SessionTaskView[];
  /** Still to do, in plan order, excluding whatever `current` is. */
  upcoming: SessionTaskView[];
  /**
   * Everything a finished session did NOT get through: still-open work plus
   * anything skipped.
   *
   * It exists because `upcoming` is the wrong number to report here and reads
   * exactly like the right one. `upcoming` deliberately excludes `current`, so
   * a session ended with one job left counted zero and the screen said nothing
   * had been carried over. Counting what is not settled cannot make that
   * mistake, because it does not depend on which task the screen is pointing
   * at.
   */
  leftOverCount: number;
  /** Estimated minutes left, counting `current` when it is not yet running. */
  remainingMinutes: number;
  /**
   * Minutes the seller has CONFIRMED, never minutes a clock guessed. A task
   * finished without an answer contributes nothing, which is why this can read
   * lower than the wall clock and should.
   */
  confirmedMinutes: number;
  /** True when every task has reached a state it cannot leave. */
  allSettled: boolean;
}

const OPEN_STATES = new Set(["pending", "active"]);

/**
 * Read a session's task list into what the screen shows.
 *
 * ORDER IS THE PLAN'S ORDER, always. Re-sorting by anything else -- shortest
 * first, nearest bin, highest value -- would quietly undo the ranking and the
 * batching that six earlier stories exist to produce.
 */
export function sessionProgress(
  tasks: readonly SessionTaskView[],
): SessionProgress {
  const ordered = [...tasks].sort((a, b) => a.position - b.position);
  const active = ordered.find((t) => t.state === "active") ?? null;
  const open = ordered.filter((t) => OPEN_STATES.has(t.state) && t.actionable);
  const current = active ?? open.find((t) => t.state === "pending") ?? null;

  const upcoming = open.filter((t) => t.id !== current?.id);
  // `current` counts toward the remaining work unless it is already running,
  // in which case its minutes are being spent rather than waiting.
  const remainingSource = active ? upcoming : (current ? [current, ...upcoming] : upcoming);

  return {
    current,
    currentIsActive: active !== null,
    done: ordered.filter((t) => t.state === "completed"),
    skipped: ordered.filter((t) => t.state === "skipped"),
    invalidated: ordered.filter((t) => t.state === "invalidated"),
    upcoming,
    remainingMinutes: remainingSource.reduce(
      (sum, t) => sum + (t.estimate_minutes ?? 0),
      0,
    ),
    confirmedMinutes: ordered.reduce(
      (sum, t) => sum + (t.confirmed_minutes ?? 0),
      0,
    ),
    leftOverCount: ordered.filter(
      (t) => OPEN_STATES.has(t.state) || t.state === "skipped",
    ).length,
    allSettled: ordered.length > 0 && ordered.every((t) => !OPEN_STATES.has(t.state)),
  };
}

// ── Reconciling a task against the item (AC2) ───────────────────────

export interface Reconciliation {
  /** True when the item's durable facts show the work landed. */
  landed: boolean;
  /**
   * What to say when it did not. Empty when it did, or when this action has
   * no durable fact to check -- absence of a check is not evidence of failure
   * and must not produce a warning.
   */
  note: string;
}

const LANDED: Record<string, { check: (i: ItemListRow) => boolean; missing: string }> = {
  measure: {
    check: (i) => factsOf(i).hasMeasurements,
    missing: "We still don't see measurements saved on this item.",
  },
  photograph: {
    check: (i) => factsOf(i).hasRequiredPhotos,
    missing: "We still don't see the required photos on this item.",
  },
  price_research: {
    check: (i) => factsOf(i).hasTargetPrice,
    missing: "We still don't see a price on this item.",
  },
  draft_review: {
    check: (i) => factsOf(i).hasDraftListing,
    missing: "We still don't see a draft listing for this item.",
  },
};

/**
 * Did the work actually land on the item?
 *
 * THIS IS A REPORT, NOT A GATE (AC2). Stopping a timer is not a photograph and
 * closing a drawer is not a listing, so the screen must not treat either as
 * one -- but the seller is also allowed to be right when the system has not
 * caught up. So: say what we can see, let them decide, and record what they
 * said. `publish` and `pack_ship` are deliberately absent, because publishing
 * and shipping have their own routes, their own confirmations and their own
 * failures; inventing a check here would be a second opinion about a fact
 * somebody else owns.
 */
export function reconcile(
  actionKey: string,
  item: ItemListRow | null | undefined,
): Reconciliation {
  const rule = LANDED[actionKey];
  if (!rule) return { landed: true, note: "" };
  // No item to read is not the same as work that did not land. It happens
  // while the refetch is in flight, and a warning that flickers on every
  // reload is a warning nobody reads.
  if (!item) return { landed: true, note: "" };
  return rule.check(item)
    ? { landed: true, note: "" }
    : { landed: false, note: rule.missing };
}
