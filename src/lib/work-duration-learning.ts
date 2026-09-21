// Worth My Time, R2 01/06 (US-3178): learn each seller's own pace.
//
// R1's estimates are assumptions with reasons attached, and work-duration.ts
// says so in as many words: nobody has timed a seller photographing a jacket
// with this app in front of them. This is the file that replaces them with
// something measured -- for one seller, from their own confirmed minutes, and
// only once there is enough of it to mean anything.
//
// ── ONLY WHAT THE SELLER SAID (AC2) ─────────────────────────────────────────
// The clock is not a source here. R1 deliberately keeps observed, confirmed
// and corrected minutes in three separate columns (lib/work-sessions.ts), and
// only the latter two ever reach this file. A tab left open over lunch would
// otherwise teach the estimator that packing takes ninety minutes, and every
// plan after it would be wrong in the same direction with nothing to point at.
//
// ── A BATCH IS NOT N INDEPENDENT SAMPLES (AC3) ──────────────────────────────
// This is the rule that makes the whole thing honest, and the naive version is
// badly wrong. A seller who photographs four garments in a row spends the
// first one getting the lightbox out. So the run reads 12, 4, 5, 4 -- and a
// flat median over those four numbers is a number that describes neither the
// first item nor the rest.
//
// So a contiguous run of the same family in one session is split: the FIRST
// task carries setup plus one item, and the others carry one item each. The
// per-item pool learns from the others; the setup pool learns from the
// difference. A run of one cannot be split at all and is recorded as `solo`,
// which is a sample about a different quantity and is counted separately.
// `allocation` is stored on every observation so a later reader can tell which
// is which rather than inferring it.
//
// ── ONE SELLER, NEVER A POOL (AC4) ──────────────────────────────────────────
// Nothing here blends sellers. The input is one owner's rows, fetched
// owner-scoped, and there is no global prior to fall back to beyond R1's
// labeled defaults. A cross-seller average would be a better estimate on
// average and a worse one for the seller reading it, which is the wrong trade
// for a screen that says "about 5 minutes" next to their own garment.
//
// ── NOT THE MARKETING NUMBER (AC5) ──────────────────────────────────────────
// src/lib/time-saved.ts counts hypothetical manual minutes AVOIDED by
// automation. These are minutes a seller actually spent. The two must never
// meet: work-duration-independence.test.ts already fails if the estimator
// imports them, and this file is under the same rule.

import { TASK_FAMILIES, type TaskFamily } from "@/lib/work-duration";

export const LEARNING_MODEL_VERSION = 1;

/** How many of the most recent samples a median is taken over (AC1). */
export const LEARNING_WINDOW = 20;

/** Below this many samples the labeled default stands (AC1). */
export const MIN_SAMPLES = 5;

/**
 * The longest a single task's confirmed minutes may be and still be believed.
 *
 * Tied to the session limit rather than picked: MAX_BUDGET_MINUTES is 240 in
 * the planner router, so a single task claiming more than a whole session did
 * not happen the way it was recorded. The bound is a REFUSAL rather than a
 * clamp, for the same reason estimateDuration refuses a bad override: a
 * clamped 600 becomes a plausible 240 and the seller never learns the number
 * was junk.
 */
export const MAX_VALID_MINUTES = 240;

export type WorkContext = "home" | "phone_only";

/** How an observation's minutes relate to one item's work. */
export const ALLOCATIONS = ["per_item", "batch_first", "solo"] as const;
export type Allocation = (typeof ALLOCATIONS)[number];

/** One completed task, as it comes out of the database. */
export interface RawObservation {
  taskId: string;
  sessionId: string;
  /** Plan order within the session. Contiguity is read from this. */
  position: number;
  family: TaskFamily;
  context: WorkContext;
  /** Task state: only `completed` is ever learned from. */
  taskState: string;
  /** Session state: an abandoned session's minutes are not believed. */
  sessionState: string;
  confirmedMinutes: number | null;
  correctionMinutes: number | null;
  /** When the session ended, for ordering the window. ISO, server time. */
  endedAt: string | null;
}

export interface Observation {
  taskId: string;
  sessionId: string;
  position: number;
  family: TaskFamily;
  context: WorkContext;
  minutes: number;
  allocation: Allocation;
  endedAt: string | null;
}

export type RejectionReason =
  | "not_completed"
  | "session_not_completed"
  | "unconfirmed"
  | "nonpositive"
  | "nonfinite"
  | "above_bound";

export interface Rejected {
  taskId: string;
  reason: RejectionReason;
}

/**
 * What the seller actually said, for the tasks it is fair to learn from.
 *
 * A CORRECTION BEATS A CONFIRMATION, the same precedence effectiveMinutes uses
 * on the server: a person editing a number afterwards knows more than the
 * person who typed it while working.
 */
function effective(raw: RawObservation): number | null {
  if (raw.correctionMinutes != null) return raw.correctionMinutes;
  if (raw.confirmedMinutes != null) return raw.confirmedMinutes;
  return null;
}

export interface ValidationResult {
  kept: RawObservation[];
  rejected: Rejected[];
}

/**
 * Throw out everything that is not a believable record of work done (AC2).
 *
 * Every exclusion here is a thing that would otherwise teach the estimator
 * something false, and each is refused for its own reason rather than filtered
 * by one broad predicate -- the reasons are returned so a diagnostic can say
 * WHY a seller with forty sessions still has no learned estimate.
 *
 * `skipped` and `invalidated` never reach this: a skipped task has no minutes
 * because it was not done, and an invalidated one was closed because the item
 * sold or moved. An ABANDONED session is excluded even where its tasks say
 * completed, because abandoning is what a seller does when they walk away, and
 * the last task before they did is the one most likely to be mistimed.
 */
export function validObservations(raw: readonly RawObservation[]): ValidationResult {
  const kept: RawObservation[] = [];
  const rejected: Rejected[] = [];
  for (const r of raw) {
    if (r.taskState !== "completed") {
      rejected.push({ taskId: r.taskId, reason: "not_completed" });
      continue;
    }
    if (r.sessionState !== "completed") {
      rejected.push({ taskId: r.taskId, reason: "session_not_completed" });
      continue;
    }
    const m = effective(r);
    if (m === null) {
      // The clock's own reading is deliberately NOT a fallback. A task
      // finished without an answer teaches nothing, and guessing from the
      // wall clock is exactly what AC2 excludes.
      rejected.push({ taskId: r.taskId, reason: "unconfirmed" });
      continue;
    }
    if (!Number.isFinite(m)) {
      rejected.push({ taskId: r.taskId, reason: "nonfinite" });
      continue;
    }
    if (m <= 0) {
      rejected.push({ taskId: r.taskId, reason: "nonpositive" });
      continue;
    }
    if (m > MAX_VALID_MINUTES) {
      rejected.push({ taskId: r.taskId, reason: "above_bound" });
      continue;
    }
    kept.push(r);
  }
  return { kept, rejected };
}

/**
 * Split each contiguous same-family run into per-item and setup observations
 * (AC3).
 *
 * A run is consecutive POSITIONS in one session sharing a family, which is
 * exactly what the R1 scheduler charges setup once for -- the two definitions
 * have to agree or the estimator learns about a batching the plan never made.
 * A gap in positions breaks a run even when the family matches, because the
 * seller did something else in between and put the lightbox down.
 */
export function allocate(raw: readonly RawObservation[]): Observation[] {
  const bySession = new Map<string, RawObservation[]>();
  for (const r of raw) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }

  const out: Observation[] = [];
  for (const rows of bySession.values()) {
    const ordered = [...rows].sort((a, b) => a.position - b.position);
    let run: RawObservation[] = [];
    const flush = () => {
      if (run.length === 0) return;
      run.forEach((r, i) => {
        out.push({
          taskId: r.taskId,
          sessionId: r.sessionId,
          position: r.position,
          family: r.family,
          context: r.context,
          minutes: effective(r)!,
          // A run of one is `solo`: it contains setup AND one item and there
          // is nothing to subtract it from, so it is a sample about a
          // different quantity than the two below.
          allocation: run.length === 1 ? "solo" : i === 0 ? "batch_first" : "per_item",
          endedAt: r.endedAt,
        });
      });
      run = [];
    };
    for (const r of ordered) {
      const prev = run[run.length - 1];
      const continues = prev !== undefined &&
        prev.family === r.family &&
        prev.position + 1 === r.position;
      if (!continues) flush();
      run.push(r);
    }
    flush();
  }
  return out;
}

export interface LearnedDuration {
  family: TaskFamily;
  context: WorkContext;
  /** The median of the window, in minutes. */
  typicalMinutes: number;
  /** How many observations the median was taken over. */
  sampleCount: number;
  /** The range actually seen, so a caller can say how varied it was (AC1). */
  observedLowMinutes: number;
  observedHighMinutes: number;
  /** Which pool this came from. Never mixes the three. */
  allocation: Allocation;
  version: number;
}

/** Median of a non-empty list. Even counts take the mean of the middle two. */
function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The most recent observations first.
 *
 * Sessions end at a moment; tasks within one have no separate end time, so the
 * session's end orders them and the position breaks the tie. A row with no end
 * time sorts LAST rather than first: an unfinished-looking row should never
 * displace a dated one from a twenty-sample window.
 */
function newestFirst(a: Observation, b: Observation): number {
  if (a.endedAt !== b.endedAt) {
    if (a.endedAt === null) return 1;
    if (b.endedAt === null) return -1;
    return a.endedAt < b.endedAt ? 1 : -1;
  }
  return b.position - a.position;
}

export interface LearningResult {
  /** Keyed `${family}|${context}|${allocation}`. */
  learned: Map<string, LearnedDuration>;
  rejected: Rejected[];
  /** Every pool that has samples, including the ones below the floor. */
  pools: {
    key: string;
    family: TaskFamily;
    context: WorkContext;
    allocation: Allocation;
    sampleCount: number;
    /** False when the pool is below MIN_SAMPLES and the default still wins. */
    learned: boolean;
  }[];
  version: number;
}

export function poolKey(
  family: TaskFamily,
  context: WorkContext,
  allocation: Allocation,
): string {
  return `${family}|${context}|${allocation}`;
}

/**
 * Learn one seller's durations.
 *
 * MEDIAN, NOT MEAN (AC1 names the median and the reason is worth keeping): one
 * afternoon where the seller was interrupted mid-measure and confirmed 40
 * minutes would drag a mean of five samples up by seven minutes and stay there.
 * A median ignores it, which is the correct response to a real number that
 * describes something other than the work.
 *
 * CONTEXTS ARE NEVER MIXED. Photographing at home with a lightbox and
 * photographing phone-only are different jobs with the same name, and pooling
 * them produces a number that is wrong in both.
 */
export function learnDurations(raw: readonly RawObservation[]): LearningResult {
  const { kept, rejected } = validObservations(raw);
  const allocated = allocate(kept);

  const byPool = new Map<string, Observation[]>();
  for (const o of allocated) {
    const key = poolKey(o.family, o.context, o.allocation);
    const list = byPool.get(key) ?? [];
    list.push(o);
    byPool.set(key, list);
  }

  const learned = new Map<string, LearnedDuration>();
  const pools: LearningResult["pools"] = [];
  for (const [key, all] of byPool) {
    const window = [...all].sort(newestFirst).slice(0, LEARNING_WINDOW);
    const first = window[0]!;
    const enough = window.length >= MIN_SAMPLES;
    pools.push({
      key,
      family: first.family,
      context: first.context,
      allocation: first.allocation,
      sampleCount: window.length,
      learned: enough,
    });
    if (!enough) continue;
    const values = window.map((o) => o.minutes);
    learned.set(key, {
      family: first.family,
      context: first.context,
      typicalMinutes: median(values),
      sampleCount: window.length,
      observedLowMinutes: Math.min(...values),
      observedHighMinutes: Math.max(...values),
      allocation: first.allocation,
      version: LEARNING_MODEL_VERSION,
    });
  }

  pools.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { learned, rejected, pools, version: LEARNING_MODEL_VERSION };
}

/**
 * The per-item duration to plan with, or null to keep the default.
 *
 * WHICH POOL ANSWERS, and why it is not simply "the biggest one". `per_item`
 * is the quantity the planner needs, because the scheduler charges setup
 * separately and would otherwise pay for it twice. `solo` is the fallback,
 * because a seller who never batches has no per-item pool at all and their
 * solo times ARE their per-item times plus a setup the scheduler will add
 * again -- so it is used, and the caller is told which pool answered so the
 * double-count is visible rather than hidden. `batch_first` is never returned:
 * it is setup plus an item by construction and belongs to setup learning.
 */
export function learnedFor(
  result: LearningResult,
  family: TaskFamily,
  context: WorkContext,
): LearnedDuration | null {
  return result.learned.get(poolKey(family, context, "per_item")) ??
    result.learned.get(poolKey(family, context, "solo")) ??
    null;
}

/**
 * What a batch's setup costs this seller, when their history can say (AC3).
 *
 * The difference between the first task of a run and the typical one after it.
 * Returned only when BOTH pools cleared the floor, because a difference
 * between a measured number and a guessed one is not a measurement. Negative
 * differences are refused rather than floored at zero: a first task that is
 * faster than the rest means the run was not what this model thinks it was,
 * and reporting zero would hide that.
 */
export function learnedSetupFor(
  result: LearningResult,
  family: TaskFamily,
  context: WorkContext,
): { setupMinutes: number; sampleCount: number } | null {
  const first = result.learned.get(poolKey(family, context, "batch_first"));
  const item = result.learned.get(poolKey(family, context, "per_item"));
  if (!first || !item) return null;
  const diff = first.typicalMinutes - item.typicalMinutes;
  if (!(diff > 0)) return null;
  return {
    setupMinutes: diff,
    sampleCount: Math.min(first.sampleCount, item.sampleCount),
  };
}

/** Every pool key a seller could ever have, for a diagnostic to iterate. */
export function allPoolKeys(): string[] {
  const out: string[] = [];
  for (const family of TASK_FAMILIES) {
    for (const context of ["home", "phone_only"] as const) {
      for (const allocation of ALLOCATIONS) {
        out.push(poolKey(family, context, allocation));
      }
    }
  }
  return out;
}
