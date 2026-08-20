// US-2690: the work-list for the background style-code sweep.
//
// The learned index (US-2246, 00503) fills one code at a time, and only when a
// seller happens to photograph a tag we have never seen. That is the speed of
// sellers, not the speed of the API. This module decides WHICH codes a sweep
// tick should spend its eBay budget on, so the index fills at API speed.
//
// ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
//
// It is not a queue. Nothing is enqueued and nothing is claimed: the work-list
// is DERIVED every tick from the codes we have seen, minus the ones already
// answered, minus the ones on cooldown. A sweep that dies mid-tick loses
// nothing — the next tick derives the same list again.
//
// Everything here is pure, so every rule below is unit-testable without eBay,
// without the database, and without a clock.

import {
  canonicalStyleCode,
  MIN_STYLE_CODE_LENGTH,
} from "./style-code-observations.ts";

export { MIN_STYLE_CODE_LENGTH };

/** Codes per tick. Well under eBay Browse's app-level daily allowance, and
 *  overridable per environment (STYLE_CODE_SWEEP_BUDGET). */
export const DEFAULT_CODES_PER_RUN = 100;

/** seen_count at or above which a code counts as answered and is not swept.
 *  Matches the point where learnedConfidence stops moving much. */
export const CONFIRMED_SEEN_COUNT = 3;

/** A code the market had nothing for is not re-asked for this long. The whole
 *  reason 00627 exists: without it a sweep re-queries its own dead ends. */
export const MISS_COOLDOWN_DAYS = 30;

/** A code that DID resolve but is still short of CONFIRMED_SEEN_COUNT gets
 *  re-asked eventually — listings turn over, and a second independent title is
 *  worth more than the first. Long, because the answer rarely changes. */
export const HIT_RECHECK_DAYS = 180;

const MS_PER_DAY = 86_400_000;

/** A code we have seen somewhere — on an item, or in the observation index. */
export interface SweepSourceRow {
  brandKey: string;
  styleCodeRaw: string;
  /** The brand as a human spells it, when the source knows it. eBay's Brand
   *  aspect filter matches display spelling, not our normalized key, so a
   *  candidate carries both. Falls back to brandKey. */
  brandLabel?: string;
}

/** An existing observation, used only to decide "already answered". */
export interface ObservationCountRow {
  brand_key: string;
  style_code_norm: string;
  seen_count: number;
}

/** A 00627 row: what the sweep already tried, and how it went. */
export interface SweepStateRow {
  brand_key: string;
  style_code_norm: string;
  titles_found: number;
  last_swept_at: string;
}

export interface SweepCandidate {
  brandKey: string;
  brandLabel: string;
  styleCodeRaw: string;
  styleCodeNorm: string;
}

export interface SweepWorkList {
  /** What this tick should ask eBay about, budget applied. */
  candidates: SweepCandidate[];
  /** Distinct codes considered before any filtering. */
  considered: number;
  /** Already answered well enough — not asked again. */
  skippedConfirmed: number;
  /** Asked recently; still inside the cooldown. */
  skippedCooldown: number;
  /** Too short to be an identity. */
  skippedTooShort: number;
  /** Eligible but over budget — LEFT for the next tick, never dropped
   *  silently. The caller logs this; a sweep that quietly truncates reads as
   *  "we covered everything". */
  deferred: number;
}

function key(brandKey: string, norm: string): string {
  return `${brandKey}|${norm}`;
}

/** Days between two instants, positive when `then` is in the past. */
function daysSince(now: Date, then: string): number {
  const t = Date.parse(then);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / MS_PER_DAY;
}

/**
 * Is this code still cooling off? A miss cools for MISS_COOLDOWN_DAYS, a hit
 * that has not reached CONFIRMED_SEEN_COUNT for HIT_RECHECK_DAYS. Exported so
 * the two windows are testable on their own.
 */
export function isCoolingOff(row: SweepStateRow, now: Date): boolean {
  const window = row.titles_found > 0 ? HIT_RECHECK_DAYS : MISS_COOLDOWN_DAYS;
  return daysSince(now, row.last_swept_at) < window;
}

/**
 * Derive this tick's work-list.
 *
 * Ordering is deliberate: codes never swept come first, then the ones swept
 * longest ago. A sweep that always started at the same end of the list would
 * spend every tick on the same codes and never reach the tail.
 */
export function buildSweepWorkList(args: {
  seen: readonly SweepSourceRow[];
  observations: readonly ObservationCountRow[];
  sweeps: readonly SweepStateRow[];
  budget: number;
  now: Date;
}): SweepWorkList {
  const { seen, observations, sweeps, budget, now } = args;

  const confirmed = new Set<string>();
  for (const o of observations) {
    if (o.seen_count >= CONFIRMED_SEEN_COUNT) {
      confirmed.add(key(o.brand_key, o.style_code_norm));
    }
  }

  const sweptAt = new Map<string, SweepStateRow>();
  for (const s of sweeps) sweptAt.set(key(s.brand_key, s.style_code_norm), s);

  const deduped = new Map<string, SweepCandidate>();
  let skippedTooShort = 0;
  for (const row of seen) {
    // US-2714: the CANONICAL spelling, so the four ways one Lululemon code can
    // be transcribed are one candidate and one row rather than four of each.
    const norm = canonicalStyleCode(row.brandKey, row.styleCodeRaw);
    if (norm.length < MIN_STYLE_CODE_LENGTH) {
      skippedTooShort++;
      continue;
    }
    const k = key(row.brandKey, norm);
    // First raw spelling wins: they normalize to the same code, and the first
    // is as good a display form as any.
    if (!deduped.has(k)) {
      deduped.set(k, {
        brandKey: row.brandKey,
        brandLabel: row.brandLabel?.trim() || row.brandKey,
        styleCodeRaw: row.styleCodeRaw.trim(),
        styleCodeNorm: norm,
      });
    }
  }

  let skippedConfirmed = 0;
  let skippedCooldown = 0;
  const eligible: Array<{ candidate: SweepCandidate; sweptMsAgo: number }> = [];
  for (const [k, candidate] of deduped) {
    if (confirmed.has(k)) {
      skippedConfirmed++;
      continue;
    }
    const state = sweptAt.get(k);
    if (state && isCoolingOff(state, now)) {
      skippedCooldown++;
      continue;
    }
    eligible.push({
      candidate,
      // Never swept sorts first (Infinity), then oldest-swept.
      sweptMsAgo: state ? daysSince(now, state.last_swept_at) : Number.POSITIVE_INFINITY,
    });
  }

  eligible.sort((a, b) => b.sweptMsAgo - a.sweptMsAgo);
  const take = Math.max(0, Math.floor(budget));

  return {
    candidates: eligible.slice(0, take).map((e) => e.candidate),
    considered: deduped.size,
    skippedConfirmed,
    skippedCooldown,
    skippedTooShort,
    deferred: Math.max(0, eligible.length - take),
  };
}

// ── Sweeping one code ───────────────────────────────────────────────────────
//
// The transport is injected rather than imported, for the same reason
// style-code-observations injects its writer: the interesting behaviour is what
// happens on a miss and on a throw, and neither is worth an eBay call to test.

/** Public listing text only — the 00503 rule, unchanged by the sweep. */
export interface SweepHit {
  title: string;
  url: string | null;
}

export interface SweepDeps {
  /** Search the market for one code. Should return [] rather than throw on a
   *  clean miss; a throw is treated as an error, not as a miss. */
  search: (candidate: SweepCandidate) => Promise<SweepHit[]>;
  /** Keep what the market called it. Fire-and-forget in the caller. */
  observe: (
    candidate: SweepCandidate,
    hits: readonly SweepHit[],
  ) => Promise<unknown>;
  /** Record the ATTEMPT, hit or miss. This is the half 00503 cannot store. */
  markSwept: (candidate: SweepCandidate, titlesFound: number) => Promise<unknown>;
  /** US-2691: derive and store the consensus NAME from this tick's titles.
   *  Optional so a caller that only wants evidence can leave it out. */
  resolveName?: (
    candidate: SweepCandidate,
    hits: readonly SweepHit[],
  ) => Promise<unknown>;
}

/**
 * Sweep one code. Never throws: a sweep is a background improvement and a bad
 * code must not end the tick.
 *
 * A miss is still marked swept — that is the entire point of 00627. An ERROR is
 * NOT marked swept, because "eBay was down" is not evidence about the code, and
 * recording it would put the code on a 30-day cooldown for someone else's outage.
 */
export async function sweepOneCode(
  candidate: SweepCandidate,
  deps: SweepDeps,
): Promise<SweepOutcome> {
  let hits: SweepHit[];
  try {
    hits = await deps.search(candidate);
  } catch (err) {
    console.error(
      `[style-code-sweep] search failed for ${candidate.styleCodeNorm}:`,
      err instanceof Error ? err.message : String(err),
    );
    return "error";
  }

  try {
    if (hits.length > 0) {
      await deps.observe(candidate, hits);
      // The consensus is derived from THIS tick's titles, which is more of them
      // than 00503 keeps: recordStyleCodeObservations caps what it stores at
      // MAX_TITLES_PER_OBSERVATION, and a name wants every title it can get.
      if (deps.resolveName) await deps.resolveName(candidate, hits);
    }
    await deps.markSwept(candidate, hits.length);
  } catch (err) {
    console.error(
      `[style-code-sweep] write failed for ${candidate.styleCodeNorm}:`,
      err instanceof Error ? err.message : String(err),
    );
    return "error";
  }

  return hits.length > 0 ? "learned" : "no_hits";
}

/** What one code's sweep did. */
export type SweepOutcome = "learned" | "no_hits" | "error";

export interface SweepSummary {
  learned: number;
  noHits: number;
  errors: number;
}

/** Roll outcomes up for the cron's response body. Pure. */
export function summarizeSweep(
  outcomes: readonly SweepOutcome[],
): SweepSummary {
  const summary: SweepSummary = { learned: 0, noHits: 0, errors: 0 };
  for (const o of outcomes) {
    if (o === "learned") summary.learned++;
    else if (o === "no_hits") summary.noHits++;
    else summary.errors++;
  }
  return summary;
}
