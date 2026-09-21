// Worth My Time, R2 05/06 (US-3182): let the seller correct the planner.
//
// Every number this feature shows is an estimate, and the seller standing in
// their garage knows things the estimator never will: that this jacket takes
// twenty minutes because of the lining, that the comp is wrong, that they are
// not touching the fleece until next month. Until now they could only ignore
// the plan, and a plan you ignore is a plan you stop opening.
//
// ── A PLANNER OVERRIDE IS NOT A PRICE (AC1) ─────────────────────────────────
// This is the boundary the whole file exists to hold. A seller saying "I
// think this is worth $40 for planning purposes" must NEVER change
// inventory_items.target_price, a grade report, or anything the books read.
// Those have their own screens, their own audit trails and their own
// consequences -- a planner correction that quietly repriced a live listing
// would be the worst bug this feature could ship. So overrides live in their
// own table, are read only by the planner, and the canonical row is never
// written. `overrides-never-touch-canonical_test.ts` holds the line.
//
// ── THE ORIGINAL IS KEPT (AC2) ──────────────────────────────────────────────
// Every correction stores what it replaced, who said so and when. A seller
// who overrode a duration in March and cannot remember the real estimate has
// no way back otherwise, and "reset to our estimate" has nothing to reset to.
//
// ── SUPPRESSION NEVER HIDES A DEADLINE (AC3) ────────────────────────────────
// Skip, snooze and dismiss all mean "not now". None of them may hide a
// shipping obligation that has since become urgent: a buyer has paid, the
// clock is the marketplace's rather than ours, and a seller who snoozed a
// garment last week did not agree to miss a ship-by date this week. That is
// one line of code and it is the most important line in the file.
//
// ── DISMISSING IS NOT TRAINING DATA (AC4) ───────────────────────────────────
// R2 01/06 learns from CONFIRMED completed work. An override is an opinion
// about the future and a dismissal is a preference; neither is a measurement
// of how long something took. Feeding them to the learner would let a seller
// who overrides optimistically train the estimator to agree with them.

export const OVERRIDES_MODEL_VERSION = 1;

/** What a seller can correct. Each maps to one planner input and no more. */
export const OVERRIDE_KINDS = [
  "task_minutes",
  "value_range",
  "remaining_cost",
] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

/** How a seller can set something aside. */
export const SUPPRESSION_KINDS = ["skip_session", "snooze", "dismiss"] as const;
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];

/** How long a snooze lasts. Named so the UI and the rule cannot disagree. */
export const SNOOZE_DAYS = 7;

/**
 * The largest correction that is a correction rather than a typo.
 *
 * Tied to the session limit, like the learning bound: a single task claiming
 * more than a whole session did not happen the way it was typed. Refused with
 * a reason rather than clamped, because a clamped 6000 becomes a plausible
 * 240 and the seller never learns their number was thrown away.
 */
export const MAX_OVERRIDE_MINUTES = 240;

/** A value correction above this is almost certainly cents typed as dollars. */
export const MAX_OVERRIDE_CENTS = 100_000_00;

export type ValidationError =
  | "not_a_number"
  | "not_finite"
  | "negative"
  | "zero_minutes"
  | "above_minutes_bound"
  | "above_value_bound"
  | "range_inverted"
  | "unknown_kind";

export interface OverrideValue {
  /** For task_minutes and remaining_cost. */
  amount?: number | null;
  /** For value_range, in cents. */
  lowCents?: number | null;
  highCents?: number | null;
}

export interface Validated {
  ok: true;
  kind: OverrideKind;
  value: OverrideValue;
}

export interface Invalid {
  ok: false;
  errors: ValidationError[];
}

/**
 * Is this a correction we can act on?
 *
 * EVERY ERROR IS COLLECTED, not just the first. A seller who typed two bad
 * numbers should be told both, rather than fixing one and being told about
 * the next -- the same rule parseWorkPreferencesPatch follows in R1.
 *
 * ZERO IS VALID FOR A COST AND NOT FOR A DURATION. "This costs me nothing
 * more" is a real statement; "this takes no time" is not, and accepting it
 * would sort the task to the front of every plan forever.
 */
export function validateOverride(
  kind: string,
  value: OverrideValue,
): Validated | Invalid {
  const errors: ValidationError[] = [];
  if (!(OVERRIDE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, errors: ["unknown_kind"] };
  }

  const check = (n: unknown, allowZero: boolean, bound: number): ValidationError[] => {
    const out: ValidationError[] = [];
    if (typeof n !== "number") { out.push("not_a_number"); return out; }
    if (!Number.isFinite(n)) { out.push("not_finite"); return out; }
    if (n < 0) out.push("negative");
    if (!allowZero && n === 0) out.push("zero_minutes");
    if (n > bound) {
      out.push(bound === MAX_OVERRIDE_MINUTES ? "above_minutes_bound" : "above_value_bound");
    }
    return out;
  };

  if (kind === "task_minutes") {
    errors.push(...check(value.amount, false, MAX_OVERRIDE_MINUTES));
  } else if (kind === "remaining_cost") {
    errors.push(...check(value.amount, true, MAX_OVERRIDE_CENTS));
  } else {
    errors.push(...check(value.lowCents, true, MAX_OVERRIDE_CENTS));
    errors.push(...check(value.highCents, true, MAX_OVERRIDE_CENTS));
    if (
      typeof value.lowCents === "number" && typeof value.highCents === "number" &&
      Number.isFinite(value.lowCents) && Number.isFinite(value.highCents) &&
      value.lowCents > value.highCents
    ) {
      // A range where the bottom is above the top is not a range. Silently
      // swapping them would record a number the seller did not type.
      errors.push("range_inverted");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, kind: kind as OverrideKind, value };
}

export interface StoredOverride {
  inventoryItemId: string;
  actionKey: string | null;
  kind: OverrideKind;
  value: OverrideValue;
  /** What the planner said before the seller changed it (AC2). */
  originalValue: OverrideValue | null;
  source: "seller";
  updatedAt: string;
}

export interface StoredSuppression {
  inventoryItemId: string;
  actionKey: string | null;
  kind: SuppressionKind;
  /** For skip_session: the session it applies to, and no other. */
  sessionId: string | null;
  /** For snooze: when it stops applying. */
  until: string | null;
  createdAt: string;
}

export interface SuppressionContext {
  /** Server time. A parameter, so snooze expiry is testable with a fixed clock. */
  now: string;
  /** The session being planned, when there is one. */
  sessionId?: string | null;
  /**
   * TRUE when this task is an unfulfilled shipping obligation that is now
   * urgent. Passed in rather than derived, because the ranker already decided
   * it and a second opinion here could disagree with the plan.
   */
  urgentShipping?: boolean;
}

export type SuppressionVerdict =
  | { suppressed: false; reason: null }
  | { suppressed: false; reason: "urgent_shipping_overrides_suppression" }
  | { suppressed: false; reason: "snooze_expired" }
  | { suppressed: true; reason: SuppressionKind };

/**
 * Is this task set aside right now?
 *
 * THE FIRST BRANCH IS THE WHOLE POINT (AC3). A buyer has paid and the clock
 * is the marketplace's. A seller who snoozed a garment last week did not
 * agree to miss a ship-by date this week, and a planner that hid it would let
 * them find out from a late-shipment metric.
 *
 * Nothing here marks anything sold or archived, and nothing deletes. A
 * suppression is a row saying "not now" and it is the only effect.
 */
export function isSuppressed(
  suppressions: readonly StoredSuppression[],
  ctx: SuppressionContext,
): SuppressionVerdict {
  if (ctx.urgentShipping) {
    return { suppressed: false, reason: "urgent_shipping_overrides_suppression" };
  }

  const now = Date.parse(ctx.now);
  let sawExpiredSnooze = false;

  for (const s of suppressions) {
    if (s.kind === "dismiss") {
      // Until the seller resets it. No clock, deliberately: "stop suggesting
      // this" that quietly came back in a week would be worse than not
      // offering it.
      return { suppressed: true, reason: "dismiss" };
    }
    if (s.kind === "skip_session") {
      // THIS session only. A skip is "not in this sitting", and carrying it
      // into tomorrow's plan would silently turn it into a dismissal.
      if (ctx.sessionId && s.sessionId === ctx.sessionId) {
        return { suppressed: true, reason: "skip_session" };
      }
      continue;
    }
    if (s.kind === "snooze") {
      const until = s.until ? Date.parse(s.until) : NaN;
      // An unparseable or absent `until` does NOT suppress. A snooze with no
      // end is a dismissal nobody asked for.
      if (!Number.isFinite(until)) continue;
      if (Number.isFinite(now) && now < until) {
        return { suppressed: true, reason: "snooze" };
      }
      sawExpiredSnooze = true;
    }
  }

  if (sawExpiredSnooze) return { suppressed: false, reason: "snooze_expired" };
  return { suppressed: false, reason: null };
}

/** When a snooze started now would end. Pure, so the UI and the row agree. */
export function snoozeUntil(now: string, days = SNOOZE_DAYS): string {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error("snoozeUntil needs a real time.");
  return new Date(at + days * 86_400_000).toISOString();
}

// ── Precedence (AC4) ────────────────────────────────────────────────

export type MinutesSource = "override" | "learned" | "default";

export interface MinutesDecision {
  minutes: number;
  source: MinutesSource;
  /** What the planner would have said without the override. */
  withoutOverride: number | null;
}

/**
 * Which duration wins.
 *
 * OVERRIDE, THEN LEARNED, THEN DEFAULT, and this is the same order
 * estimateDuration already implements -- stated again here because this is
 * the module a seller's correction flows through, and a reader needs to see
 * that a correction beats their own learned history. It should: the learned
 * median is what they USUALLY take, and the override is what they are telling
 * us about THIS garment.
 *
 * `withoutOverride` is carried so the UI can show the difference before
 * replacing an active plan (AC2), rather than the seller having to remember
 * what it said.
 */
export function decideMinutes(args: {
  overrideMinutes: number | null;
  learnedMinutes: number | null;
  defaultMinutes: number;
}): MinutesDecision {
  const fallback = args.learnedMinutes ?? args.defaultMinutes;
  if (args.overrideMinutes != null && args.overrideMinutes > 0) {
    return {
      minutes: args.overrideMinutes,
      source: "override",
      withoutOverride: fallback,
    };
  }
  if (args.learnedMinutes != null && args.learnedMinutes > 0) {
    return { minutes: args.learnedMinutes, source: "learned", withoutOverride: null };
  }
  return { minutes: args.defaultMinutes, source: "default", withoutOverride: null };
}

export interface PlanDifference {
  key: string;
  beforeMinutes: number | null;
  afterMinutes: number;
  /** True when the task no longer fits the budget because of the change. */
  nowDoesNotFit: boolean;
}

/**
 * What an override would do to the plan the seller is looking at (AC2, AC4).
 *
 * SHOWN BEFORE REPLACING, never applied silently. A seller who corrects one
 * duration and finds three other jobs gone has been given a different plan
 * without being asked, and the next thing they do is stop correcting things.
 *
 * `nowDoesNotFit` is a plain fact rather than a refusal: the correction is
 * still recorded, and the seller is told what it costs.
 */
export function differenceFromOverride(args: {
  key: string;
  decision: MinutesDecision;
  remainingBudgetMinutes: number;
}): PlanDifference {
  return {
    key: args.key,
    beforeMinutes: args.decision.withoutOverride,
    afterMinutes: args.decision.minutes,
    nowDoesNotFit: args.decision.minutes > args.remainingBudgetMinutes,
  };
}

/**
 * Is this correction something the duration learner may read? Always no.
 *
 * A one-line function so the rule has a name and a test (AC4). An override is
 * an opinion about the future; the learner trains on CONFIRMED minutes from
 * completed work. Without this a seller who overrides optimistically would
 * train the estimator to agree with them, and the estimates would drift
 * toward what they hoped rather than what happened.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function isTrainingData(_override: StoredOverride): false {
  return false;
}

// ── Looking corrections up (AC2, AC3) ───────────────────────────────

/**
 * Everything one seller has corrected or set aside, plus the server's clock.
 *
 * `now` COMES FROM THE SERVER. A snooze that expired according to a laptop
 * whose clock is a day out is a snooze that expired for nobody else, and the
 * seller would see a row come back or stay hidden with no way to explain it.
 */
export interface OverrideBook {
  overrides: readonly StoredOverride[];
  suppressions: readonly StoredSuppression[];
  now: string;
}

export function emptyBook(now: string): OverrideBook {
  return { overrides: [], suppressions: [], now };
}

/**
 * The correction that applies to one task, or null.
 *
 * An EXACT action match wins over an item-wide one. A seller who said "this
 * garment is worth $40" and then "photographing this one takes 20 minutes"
 * meant the second to be about photographing, not about the garment.
 */
export function overrideFor(
  book: OverrideBook,
  kind: OverrideKind,
  itemId: string,
  actionKey: string | null = null,
): StoredOverride | null {
  let itemWide: StoredOverride | null = null;
  for (const o of book.overrides) {
    if (o.kind !== kind || o.inventoryItemId !== itemId) continue;
    if (actionKey !== null && o.actionKey === actionKey) return o;
    if (o.actionKey === null) itemWide = o;
  }
  return itemWide;
}

/** Corrected minutes for one task, or null to leave the estimator alone. */
export function minutesOverrideFor(
  book: OverrideBook,
  itemId: string,
  actionKey: string,
): number | null {
  const o = overrideFor(book, "task_minutes", itemId, actionKey);
  const n = o?.value.amount;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** A corrected sale range for one garment, or null. */
export function valueOverrideFor(
  book: OverrideBook,
  itemId: string,
): { lowCents: number; highCents: number } | null {
  const o = overrideFor(book, "value_range", itemId);
  const low = o?.value.lowCents;
  const high = o?.value.highCents;
  if (typeof low !== "number" || typeof high !== "number") return null;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return null;
  return { lowCents: low, highCents: high };
}

/** A corrected remaining cost for one garment, in cents, or null. */
export function costOverrideFor(book: OverrideBook, itemId: string): number | null {
  const o = overrideFor(book, "remaining_cost", itemId);
  const n = o?.value.amount;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Is this task set aside right now? (AC3)
 *
 * A row with no action_key covers the whole garment; one with an action_key
 * covers that step only. Both are read here, and `urgentShipping` still beats
 * every one of them -- isSuppressed owns that rule and this only feeds it.
 */
export function suppressionVerdictFor(
  book: OverrideBook,
  args: {
    itemId: string;
    actionKey?: string | null;
    sessionId?: string | null;
    urgentShipping?: boolean;
  },
): SuppressionVerdict {
  const mine = book.suppressions.filter((s) =>
    s.inventoryItemId === args.itemId &&
    (s.actionKey === null || s.actionKey === (args.actionKey ?? null))
  );
  return isSuppressed(mine, {
    now: book.now,
    sessionId: args.sessionId ?? null,
    urgentShipping: args.urgentShipping,
  });
}
