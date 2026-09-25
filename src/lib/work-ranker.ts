// Worth My Time, R1 06/12 (US-3171): put the most useful work first.
//
// This is where duration (R1 04/12) and value (R1 05/12) finally meet. It is
// also the file with the most ways to be quietly wrong, so most of what
// follows is about the four mistakes it exists to avoid.
//
// ── A SCORE IS A PRIORITY, NOT A PAYDAY (AC5) ───────────────────────────────
// The number this produces is cents of conservative contribution per minute of
// remaining work. It is a way of ORDERING tasks. It is not expected profit, it
// is not money the seller will earn this session, and nothing here multiplies
// it by a likelihood of selling, because nothing in R1 measures one.
//
// ── ONE ITEM IS ONE SALE (AC3) ──────────────────────────────────────────────
// The dangerous arithmetic. A jacket worth $50 needs measuring, photographing,
// pricing and drafting. Scoring each step against the item's value would make
// that jacket look like $200 of opportunity and would beat four separate
// garments that really are worth $50 each. So the value is divided by the
// WHOLE remaining chain, and every step of one item therefore scores the same
// rate. Finishing three prep steps never creates three sales worth of profit.
//
// ── A SHORT NEXT STEP IS NOT A CHEAP ITEM (AC3) ─────────────────────────────
// The same division fixes the other half. An item two minutes from publishing
// and an item forty minutes from it are not equally close to money, and
// scoring on the NEXT step alone would rank them identically. The chain is
// what separates them.
//
// ── A DEADLINE IS NEVER BURIED BY A SMALL NUMBER (AC5) ──────────────────────
// Urgent shipping is its own tier and is not scored against anything. A parcel
// that has to go today goes first even when the item barely cleared its costs,
// because missing it costs a defect rather than a margin.

import type { CandidateAction, WorkCandidate, WorkContext, WorkTool } from "@/lib/work-candidates";
import {
  estimateDuration,
  isUnestimated,
  type DurationEstimate,
  type DurationResult,
} from "@/lib/work-duration";
import { isComplete, type EvidenceSource, type ValueResult } from "@/lib/work-value";

/** Bumped when the ORDERING changes, so two plans can be told apart. */
export const RANKER_VERSION = 1;

/**
 * How close a shipping deadline has to be to jump the queue.
 *
 * Twenty-four hours, and only for a CONFIRMED deadline (AC2). An estimated one
 * derived from handling days counts calendar days rather than business days,
 * so it can be a day early; promoting on it would push real work aside for a
 * date nobody promised.
 */
export const URGENT_WINDOW_HOURS = 24;

export const RANK_TIERS = [
  "urgent_shipping",
  "valued_work",
  "research",
  // WMT-14: valued, and worth nothing or less once fees and the costs still
  // ahead come off. Kept in the plan, below the work that pays, so the seller
  // can see it and decide rather than have it silently outrank nothing.
  "below_cost",
  "unvalued",
] as const;
export type RankTier = (typeof RANK_TIERS)[number];

const TIER_ORDER: Record<RankTier, number> = {
  urgent_shipping: 0,
  valued_work: 1,
  research: 2,
  below_cost: 3,
  unvalued: 4,
};

export interface RankConflict {
  kind: "cannot_fit" | "tools_missing" | "wrong_context";
  message: string;
}

/**
 * The ONE duration resolved for a task (WMT-04).
 *
 * Carried on the ranked task so the scheduler, the rows, the header, "Why
 * this one?" and the session snapshot all read the same minutes the ranker
 * ranked on. Before this each of them called estimateDuration({action}) with
 * no override and no learned value, so a seller's corrected time never
 * showed and the ranker's cannot_fit check used a different cost from the
 * scheduler's. Null when nobody has estimated the step.
 */
export interface RankedDuration extends DurationEstimate {
  /** How many of the seller's own jobs a learned figure came from. */
  sampleCount: number | null;
}

/** A DurationResult as the ranked task carries it. */
export function rankedDurationOf(d: DurationResult): RankedDuration | null {
  if (isUnestimated(d)) return null;
  return { ...d, sampleCount: d.learnedFrom?.sampleCount ?? null };
}

export interface RankedTask {
  key: string;
  itemId: string;
  action: CandidateAction;
  tier: RankTier;
  /**
   * Conservative cents per minute of REMAINING work on this item, or null in
   * every tier but `valued_work`. Ordering only -- see the header.
   */
  score: number | null;
  /** Active minutes for everything this item still needs to be sale-ready. */
  chainMinutes: number;
  /** This task's own resolved minutes (WMT-04). Null when unestimated. */
  duration: RankedDuration | null;
  /** The conservative (low) end of the contribution, or null. */
  conservativeCents: number | null;
  /**
   * The value estimate the ranker ranked on, kept as the plan's snapshot
   * (WMT-05) so "Why this one?" and the session record read it instead of
   * rebuilding it from half the inputs.
   */
  value: ValueResult;
  /** Where the price came from, or null when there was no complete estimate. */
  valueSource: EvidenceSource | null;
  /** True when the value is the seller's own corrected range. */
  valueFromOverride: boolean;
  dueAt: string | null;
  /**
   * Carried through from the candidate so the scheduler (R1 07/12) can keep
   * prerequisite order without being handed the candidates again. It was a
   * cast-and-hope optional property there first, which is a contract nothing
   * typechecks.
   */
  prerequisiteKeys: readonly string[];
  /**
   * Set when the task cannot be done as planned. A conflicted task is RETURNED
   * rather than dropped (AC2): a deadline the seller cannot meet is the single
   * most important thing to tell them, and a planner that hid it would let
   * them find out from the marketplace.
   */
  conflict: RankConflict | null;
  /**
   * Advisory only (AC4). True when the conservative rate clears the seller's
   * hourly target, null when they have not set one. It never changes the
   * order: a target is a comparison a seller asked for, not a filter they did.
   */
  meetsHourlyTarget: boolean | null;
  version: number;
}

export interface RankTaskInput {
  candidate: WorkCandidate;
  value: ValueResult;
  /**
   * Every step this ITEM still needs to reach a sale-ready listing, including
   * the candidate's own action and anything before it.
   *
   * SUPPLIED RATHER THAN DERIVED, because the candidate builder returns only
   * the NEXT action and the chain is a fact about the item's remaining ladder.
   * The ranker sums the durations itself so AC3's "including prerequisites" is
   * a property of this file and can be tested here.
   */
  remainingActions: readonly CandidateAction[];
  /** When this work became available, ISO. The oldest-first tie-break. */
  unfinishedSince?: string | null;
  /** True when `value` came from the seller's corrected range (US-3182). */
  valueFromOverride?: boolean;
}

export interface RankInput {
  /** Explicit, never a clock read: the same plan must rank the same twice. */
  now: string;
  budgetMinutes: number;
  workContext: WorkContext;
  availableTools: WorkTool[];
  /** Advisory. Null when the seller has not said (AC4). */
  hourlyTargetCents: number | null;
  tasks: readonly RankTaskInput[];
  /**
   * Where the minutes come from, when the caller knows better than the bare
   * default (US-3178 learned history, US-3182 seller corrections).
   *
   * A RESOLVER RATHER THAN A MAP OF NUMBERS, because the ranker needs a whole
   * DurationResult -- the setup charge and the "nobody has estimated this"
   * answer both matter, and a map of minutes would quietly turn an
   * unestimated step into a zero. Absent, every estimate is the default, which
   * is what every caller before R2 got.
   */
  durationFor?: DurationResolver;
}

/** How one task's minutes are looked up. Pure; the ranker never fetches. */
export type DurationResolver = (
  args: { action: CandidateAction | string; itemId: string },
) => DurationResult;

function parseInstant(v: string | null | undefined): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Active minutes for the whole remaining chain.
 *
 * An UNESTIMATED step makes the whole chain unestimated rather than being
 * skipped. Skipping it would understate the chain and inflate the rate, which
 * is the direction that wastes an evening.
 */
export function chainMinutesFor(
  actions: readonly CandidateAction[],
  resolve?: (action: CandidateAction) => DurationResult,
): number | null {
  let total = 0;
  for (const action of actions) {
    const d: DurationResult = resolve
      ? resolve(action)
      : estimateDuration({ action });
    if (isUnestimated(d)) return null;
    total += d.typical;
  }
  return total;
}

/**
 * Is this a confirmed shipping deadline inside the urgent window? (AC2)
 *
 * EXPORTED because US-3182 needs the very same answer: a snooze may never
 * hide an obligation the ranker would call urgent, and two implementations of
 * "urgent" would eventually disagree about one parcel on one evening, which
 * is the evening it matters.
 */
export function isUrgentCandidate(
  candidate: Pick<WorkCandidate, "action" | "shipBy">,
  nowMs: number,
): boolean {
  if (candidate.action !== "pack_ship") return false;
  // ESTIMATED IS NOT VERIFIED. A derived deadline counts calendar days rather
  // than business days and can be a day early; promoting on it would push real
  // work aside for a date nobody promised.
  if (candidate.shipBy.confidence !== "confirmed") return false;
  const due = parseInstant(candidate.shipBy.at);
  if (due === null) return false;
  return due - nowMs <= URGENT_WINDOW_HOURS * 3_600_000;
}

function isUrgentShipping(task: RankTaskInput, nowMs: number): boolean {
  return isUrgentCandidate(task.candidate, nowMs);
}

/**
 * Is this a parcel the seller already owes a buyer? (WMT-13)
 *
 * Every pack_ship candidate is a sale that has not shipped, and a sale that
 * has not shipped goes first whatever its deadline says: a missed ship-by
 * costs a defect on the seller's account, not a margin. An unknown or
 * estimated date is still a date somebody is waiting on, so this does not
 * ask for one. isUrgentCandidate above is the stricter question -- a
 * confirmed deadline inside the window -- and decides the order WITHIN the
 * tier, so a date nobody promised never jumps a date somebody did.
 *
 * EXPORTED so a set-aside can never hide one either (US-3182 made the same
 * rule for urgent parcels). One answer, read in both places.
 */
export function isOwedParcel(candidate: Pick<WorkCandidate, "action">): boolean {
  return candidate.action === "pack_ship";
}

/**
 * Why this task cannot be done as planned, or null.
 *
 * The candidate builder already drops work the seller cannot do, so these fire
 * only when a task reaches the ranker anyway -- which is exactly the urgent
 * shipment whose tools are missing, and which must be SEEN rather than
 * dropped.
 */
function conflictFor(
  task: RankTaskInput,
  input: RankInput,
  ownMinutes: number,
): RankConflict | null {
  const c = task.candidate;
  if (!c.requiredContext.includes(input.workContext)) {
    return {
      kind: "wrong_context",
      message: `This needs to be done at home, and you're set to ${input.workContext.replace("_", " ")}.`,
    };
  }
  const missing = c.requiredTools.filter((t) => !input.availableTools.includes(t));
  if (missing.length > 0) {
    return {
      kind: "tools_missing",
      message: `You'd need ${missing.join(" and ").replace(/_/g, " ")} for this.`,
    };
  }
  if (ownMinutes > input.budgetMinutes) {
    return {
      kind: "cannot_fit",
      message:
        `This takes about ${ownMinutes} minutes and you have ${input.budgetMinutes}.`,
    };
  }
  return null;
}

/**
 * Rank one seller's available work.
 *
 * Pure and deterministic (AC1). `now` is an argument rather than a clock read,
 * so the same inputs rank the same way every time -- a plan that reordered
 * itself between two readings is a plan a seller stops trusting.
 */
export function rankWork(input: RankInput): RankedTask[] {
  const nowMs = parseInstant(input.now) ?? 0;
  const ranked: RankedTask[] = [];
  const resolve: DurationResolver = input.durationFor ??
    ((a) => estimateDuration({ action: a.action }));

  // AC4: at most ONE research task per plan. Unknown-value stock must not be
  // ignored forever, and it must not flood a plan either -- a seller whose
  // whole evening became price research would have been better off without us.
  let researchTaken = false;

  // Sorted first so "the one research task" is the best candidate for it
  // rather than whichever happened to be first in the input.
  const ordered = [...input.tasks].sort((a, b) =>
    compareForResearchPick(a, b, nowMs)
  );

  for (const task of ordered) {
    const own = resolve({
      action: task.candidate.action,
      itemId: task.candidate.itemId,
    });
    const ownMinutes = isUnestimated(own) ? null : own.typical;
    // The chain is resolved the same way, so a correction to a step further
    // up the ladder moves the rate this task is ranked on rather than only
    // the row's own label.
    const chain = chainMinutesFor(
      task.remainingActions,
      (a) => resolve({ action: a, itemId: task.candidate.itemId }),
    );
    const conflict = ownMinutes === null
      ? null
      : conflictFor(task, input, ownMinutes);

    // WMT-13: every unshipped sale, not only a confirmed deadline inside the
    // window. The window still orders them (compareRanked).
    const urgent = isOwedParcel(task.candidate);
    const estimate = isComplete(task.value) ? task.value : null;

    let tier: RankTier;
    if (urgent) {
      tier = "urgent_shipping";
    } else if (estimate === null && !isComplete(task.value) && task.value.researchable) {
      // The pricing-research task that would make this item rankable.
      tier = researchTaken ? "unvalued" : "research";
      if (tier === "research") researchTaken = true;
    } else if (estimate !== null && chain !== null && chain > 0) {
      tier = "valued_work";
    } else {
      // Known to be unrankable: an unsupported fee schedule, a non-USD item,
      // or a chain with a step nobody has estimated. Kept in the plan at the
      // bottom rather than hidden, because a seller who cannot see it cannot
      // fix it.
      tier = "unvalued";
    }

    const conservativeCents = estimate?.lowCents ?? null;
    const score = tier === "valued_work" && conservativeCents !== null &&
        chain !== null && chain > 0
      ? conservativeCents / chain
      : null;
    if (tier === "valued_work" && score !== null && score <= 0) {
      // WMT-14: a job that loses money per minute does not compete on rate
      // with jobs that make it.
      tier = "below_cost";
    }

    ranked.push({
      key: task.candidate.key,
      itemId: task.candidate.itemId,
      action: task.candidate.action,
      tier,
      score,
      chainMinutes: chain ?? 0,
      duration: rankedDurationOf(own),
      conservativeCents,
      value: task.value,
      valueSource: isComplete(task.value) ? task.value.evidence : null,
      valueFromOverride: task.valueFromOverride === true,
      dueAt: task.candidate.shipBy.at,
      prerequisiteKeys: task.candidate.prerequisiteKeys,
      conflict,
      meetsHourlyTarget: meetsTarget(score, input.hourlyTargetCents),
      version: RANKER_VERSION,
    });
  }

  return ranked.sort((a, b) => compareRanked(a, b, input.tasks, nowMs));
}

/**
 * Advisory comparison against the seller's hourly target (AC4).
 *
 * Null when they have not set one, and NULL IS NOT FALSE: a seller with no
 * target has not failed to meet it. Nothing about the ordering reads this.
 */
function meetsTarget(
  score: number | null,
  hourlyTargetCents: number | null,
): boolean | null {
  if (hourlyTargetCents === null || score === null) return null;
  return score * 60 >= hourlyTargetCents;
}

/** Earliest confirmed deadline first, for picking which research task to keep. */
function compareForResearchPick(
  a: RankTaskInput,
  b: RankTaskInput,
  nowMs: number,
): number {
  const ua = isUrgentShipping(a, nowMs) ? 0 : 1;
  const ub = isUrgentShipping(b, nowMs) ? 0 : 1;
  if (ua !== ub) return ua - ub;
  const sa = a.unfinishedSince ?? "";
  const sb = b.unfinishedSince ?? "";
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.candidate.key < b.candidate.key ? -1 : 1;
}

/**
 * The full order (AC1).
 *
 * Tier, then the tier's own rule, then a deterministic chain of tie-breaks:
 * due time, oldest unfinished work, then the stable key. The last one can
 * never tie, so the sort is total and two runs cannot disagree.
 */
function compareRanked(
  a: RankedTask,
  b: RankedTask,
  tasks: readonly RankTaskInput[],
  nowMs: number,
): number {
  if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) {
    return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  }
  if (a.tier === "urgent_shipping") {
    // A CONFIRMED deadline inside the window first (WMT-13): an estimated
    // date can be a day early and an unknown one is not a date at all, so
    // neither jumps a parcel eBay actually named a day for.
    const ua = dueSoon(a.key, tasks, nowMs);
    const ub = dueSoon(b.key, tasks, nowMs);
    if (ua !== ub) return ua ? -1 : 1;
    // Then soonest deadline first. A conflict does not demote it: the seller
    // most needs to see the parcel they cannot ship.
    const da = parseInstant(a.dueAt);
    const db = parseInstant(b.dueAt);
    if (da !== db) return (da ?? Number.MAX_SAFE_INTEGER) - (db ?? Number.MAX_SAFE_INTEGER);
  } else if (a.tier === "valued_work" || a.tier === "below_cost") {
    if (a.score !== b.score) return (b.score ?? 0) - (a.score ?? 0);
  }
  const da = parseInstant(a.dueAt);
  const db = parseInstant(b.dueAt);
  if (da !== db) {
    return (da ?? Number.MAX_SAFE_INTEGER) - (db ?? Number.MAX_SAFE_INTEGER);
  }
  const sa = sinceOf(a.key, tasks);
  const sb = sinceOf(b.key, tasks);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function dueSoon(key: string, tasks: readonly RankTaskInput[], nowMs: number): boolean {
  const t = tasks.find((x) => x.candidate.key === key);
  return t ? isUrgentCandidate(t.candidate, nowMs) : false;
}

function sinceOf(key: string, tasks: readonly RankTaskInput[]): string {
  const t = tasks.find((x) => x.candidate.key === key);
  // An absent timestamp sorts LAST among ties rather than first: work whose
  // age nobody recorded should not jump ahead of work that is provably old.
  return t?.unfinishedSince ?? "￿";
}
