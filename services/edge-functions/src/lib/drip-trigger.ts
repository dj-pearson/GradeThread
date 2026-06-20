// US-933: unified trigger & condition engine for the drip / journey engine.
//
// Generalizes the simple daily check sketched in US-929 into ONE evaluator that
// understands three trigger kinds:
//
//   1. event       — a user_events key (e.g. "first_grade"), optionally bounded
//                    to "has occurred since <anchor>" (e.g. since enrolled_at).
//   2. time_anchor — an anchor timestamp (signup/created_at, trial_ends_at,
//                    enrolled_at, last step sent) plus a +/- hour offset
//                    (e.g. trial_ends_at minus 2 days).
//   3. state       — a field/op/value predicate set, evaluated with the SAME
//                    compiler the audience segment engine uses (segment-
//                    predicates.ts) so there is no parallel rule language.
//
// The evaluator combines a step's trigger with AND-conditions and skip/exit
// conditions to decide, for one user/enrollment, whether the step is due now.
//
// PURE: no supabase / network / env imports. It operates entirely on a loaded
// snapshot, with `nowMs` injected, so it is deterministic and unit-testable in
// isolation (see drip-trigger_test.ts).

import {
  evaluateSegmentRules,
  SEGMENT_USER_FIELDS,
  validateRules,
} from "./segment-predicates.ts";
import type { FieldDef, SegmentRules } from "./segment-predicates.ts";

// ── Anchors ──

/** A timestamp a time-anchor trigger (or an event lower-bound) hangs off. */
export type TriggerAnchor =
  | "signup"
  | "created_at"
  | "trial_ends_at"
  | "enrolled_at"
  | "last_step_sent";

const HOUR_MS = 60 * 60 * 1000;

// ── Trigger specs ──

export interface EventTrigger {
  kind: "event";
  /** A user_events key, e.g. "first_grade". */
  event: string;
  /** Optional lower bound: the event must have occurred at-or-after this anchor
   *  (e.g. since enrolled_at). Omit/null for "has ever occurred". */
  since?: TriggerAnchor | null;
}

export interface TimeAnchorTrigger {
  kind: "time_anchor";
  anchor: TriggerAnchor;
  /** Offset from the anchor, in hours. Negative = before (e.g. -48 = 2d before). */
  offsetHours: number;
}

export interface StateTrigger {
  kind: "state";
  /** Reuses the segment field/op/value model (segment-predicates.ts). */
  rules: SegmentRules;
}

export type TriggerSpec = EventTrigger | TimeAnchorTrigger | StateTrigger;

// ── Snapshot ──

/**
 * The loaded user/enrollment snapshot the evaluator reads. Timestamps are epoch
 * ms (UTC) so all comparisons are timezone-safe; nullable anchors model missing
 * data (e.g. a no-card trial with no trial_ends_at, or a brand-new enrollment
 * that has not sent a step yet).
 */
export interface TriggerSnapshot {
  /** created_at / signup time (ms epoch). */
  signupMs: number;
  /** When the user entered this journey (ms epoch). */
  enrolledAtMs: number;
  /** Trial end (ms epoch), or null when there is no trial clock. */
  trialEndsAtMs: number | null;
  /** When the most recent step was sent (ms epoch), or null if none yet. */
  lastStepSentMs: number | null;
  /** event key → latest occurrence (ms epoch); null/absent = never occurred. */
  events?: Record<string, number | null | undefined>;
  /** State-predicate fields (segment field/op/value model), keyed by field name
   *  e.g. { subscription_status: "canceled", last_active_at: "2026-06-10T…" }. */
  fields?: Record<string, unknown>;
}

/**
 * The field allowlist for state predicates in the trigger engine: the user
 * segment columns PLUS a few snapshot-only fields the drip engine resolves
 * (conversion flag, activity recency/counts). Reuses SEGMENT_USER_FIELDS so the
 * shared columns (subscription_status, trial_ends_at, …) stay identical.
 */
export const TRIGGER_FIELDS: Record<string, FieldDef> = {
  ...SEGMENT_USER_FIELDS,
  converted: { kind: "bool" },
  last_active_at: { kind: "date_nullable" },
  grades_count: { kind: "number" },
};

export function resolveAnchorMs(
  anchor: TriggerAnchor,
  snap: TriggerSnapshot,
): number | null {
  switch (anchor) {
    case "signup":
    case "created_at":
      return snap.signupMs;
    case "enrolled_at":
      return snap.enrolledAtMs;
    case "trial_ends_at":
      return snap.trialEndsAtMs;
    case "last_step_sent":
      return snap.lastStepSentMs;
  }
}

// ── Trigger evaluation ──

/**
 * Is the trigger's signal satisfied at `nowMs`? Pure: reads only the snapshot.
 *   • event       — the event occurred at-or-before now (and at-or-after the
 *                   `since` anchor, when one is set). A missing/unresolvable
 *                   anchor drops the lower bound rather than firing falsely.
 *   • time_anchor — now has reached anchor + offset. A NULL anchor (e.g. no
 *                   trial_ends_at) never fires (AC3 null-safety).
 *   • state       — the field/op/value rules hold against the snapshot fields.
 */
export function evaluateTrigger(
  spec: TriggerSpec,
  snap: TriggerSnapshot,
  nowMs: number,
): boolean {
  switch (spec.kind) {
    case "event": {
      const occurredMs = spec.event ? snap.events?.[spec.event] : null;
      if (occurredMs == null) return false;
      if (occurredMs > nowMs) return false;
      if (spec.since) {
        const sinceMs = resolveAnchorMs(spec.since, snap);
        if (sinceMs != null && occurredMs < sinceMs) return false;
      }
      return true;
    }
    case "time_anchor": {
      const base = resolveAnchorMs(spec.anchor, snap);
      if (base == null) return false;
      return nowMs >= base + spec.offsetHours * HOUR_MS;
    }
    case "state": {
      return evaluateSegmentRules(spec.rules, TRIGGER_FIELDS, snap.fields ?? {}, nowMs);
    }
  }
}

// ── Combined step decision ──

/**
 * One drip/journey step's firing rules. The trigger says WHEN; the condition
 * groups say WHETHER to send, skip, or leave the journey. All groups reuse the
 * segment field/op/value model.
 */
export interface TriggerStep {
  trigger: TriggerSpec;
  /** AND-conditions: ALL must hold for the step to be due (else it is skipped,
   *  re-evaluated next tick). */
  conditions?: SegmentRules;
  /** Skip THIS step (retry later) when these match — e.g. already graded ⇒ skip
   *  the activation nudge. */
  skipWhen?: SegmentRules;
  /** Exit the WHOLE journey when these match — e.g. converted ⇒ stop the drip.
   *  Checked first, so an exit wins even before the trigger is due. */
  exitWhen?: SegmentRules;
}

export type TriggerOutcome = "due" | "wait" | "skip" | "exit";

export interface TriggerDecision {
  outcome: TriggerOutcome;
  reason: string;
}

/**
 * Resolve, for one user/enrollment snapshot at `nowMs`, whether a step is due.
 * Order matters:
 *   1. exitWhen   ⇒ "exit"  (terminal — e.g. converted; beats everything)
 *   2. trigger not satisfied ⇒ "wait"
 *   3. skipWhen   ⇒ "skip"  (e.g. already graded — the nudge is moot)
 *   4. conditions (AND) unmet ⇒ "skip"
 *   5. otherwise  ⇒ "due"
 */
export function evaluateStepTrigger(
  step: TriggerStep,
  snap: TriggerSnapshot,
  nowMs: number,
): TriggerDecision {
  const fields = snap.fields ?? {};
  if (step.exitWhen && evaluateSegmentRules(step.exitWhen, TRIGGER_FIELDS, fields, nowMs)) {
    return { outcome: "exit", reason: "exit condition met" };
  }
  if (!evaluateTrigger(step.trigger, snap, nowMs)) {
    return { outcome: "wait", reason: "trigger not due" };
  }
  if (step.skipWhen && evaluateSegmentRules(step.skipWhen, TRIGGER_FIELDS, fields, nowMs)) {
    return { outcome: "skip", reason: "skip condition met" };
  }
  if (step.conditions && !evaluateSegmentRules(step.conditions, TRIGGER_FIELDS, fields, nowMs)) {
    return { outcome: "skip", reason: "AND-conditions not satisfied" };
  }
  return { outcome: "due", reason: "trigger due" };
}

// ── Builder-side validation ──

export interface TriggerValidation {
  ok: boolean;
  errors: string[];
}

const VALID_ANCHORS = new Set<TriggerAnchor>([
  "signup",
  "created_at",
  "trial_ends_at",
  "enrolled_at",
  "last_step_sent",
]);

/** Validate a raw trigger spec for the builder (returns all problems found). The
 *  state kind's rules are validated against TRIGGER_FIELDS via the shared
 *  compiler so the builder and evaluator agree on what is legal. */
export function validateTriggerSpec(raw: unknown): TriggerValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["trigger must be an object"] };
  }
  const spec = raw as Partial<TriggerSpec> & Record<string, unknown>;
  switch (spec.kind) {
    case "event": {
      if (typeof spec.event !== "string" || !spec.event.trim()) {
        errors.push("event trigger needs a non-empty event key");
      }
      if (spec.since != null && !VALID_ANCHORS.has(spec.since as TriggerAnchor)) {
        errors.push(`event trigger has an invalid 'since' anchor: ${String(spec.since)}`);
      }
      break;
    }
    case "time_anchor": {
      if (!VALID_ANCHORS.has(spec.anchor as TriggerAnchor)) {
        errors.push(`time_anchor trigger has an invalid anchor: ${String(spec.anchor)}`);
      }
      if (typeof spec.offsetHours !== "number" || !Number.isFinite(spec.offsetHours)) {
        errors.push("time_anchor trigger needs a finite offsetHours");
      }
      break;
    }
    case "state": {
      try {
        validateRules(spec.rules, TRIGGER_FIELDS);
      } catch (e) {
        errors.push(`state trigger rules invalid: ${(e as Error).message}`);
      }
      break;
    }
    default:
      errors.push(`unknown trigger kind: ${String(spec.kind)}`);
  }
  return { ok: errors.length === 0, errors };
}
