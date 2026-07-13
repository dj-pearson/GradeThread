// US-1816: buyer Trust Score — event-sourced reputation model + scoring engine.
//
// The score is a DETERMINISTIC, documented function of a buyer's reputation
// event log (reputation_events, 00417) — no black box, no ML. The whole point
// is explainability and abuse-resistance:
//
//   • Only VERIFIED events score. An unverified event is logged for audit and
//     contributes exactly 0 — a buyer can never self-award reputation.
//   • Positive signals DECAY (recent behaviour is weighted over old), while
//     PENALTIES decay far more slowly — abuse should stick.
//   • The score is reconstructable from the log at any time: pass the events +
//     `nowMs` and you get the same number. buyer_trust_scores is only a cache.
//
// The DB-touching emit/recompute helpers live at the bottom; the pure engine
// (everything above `emitReputationEvent`) takes plain data so it is unit-tested
// without a database — the reference style is condition-index's selectDueSeeds.

import { supabaseAdmin } from "./supabase.ts";

// ─── Event model (lockstep with the CHECK in migration 00417) ────────────────
export type ReputationEventType =
  | "verified_purchase"
  | "grade_confirmed"
  | "dispute_upheld"
  | "dispute_overturned"
  | "chargeback_penalty"
  | "tenure";

/** The minimal event shape the scorer needs (a projection of a table row). */
export interface ReputationEventInput {
  eventType: ReputationEventType;
  /** ISO timestamp the event occurred (drives decay). */
  occurredAt: string;
  /** Anti-gaming gate: false = recorded but scores 0. */
  verified: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Base points per event type, BEFORE decay. Documented and intentionally
 * legible — this table IS the reputation policy.
 *   grade_confirmed   — buyer confirmed arrival matched the grade: the strongest
 *                       honest-buyer signal (post-sale ground truth).
 *   verified_purchase — a completed, grade-linked purchase.
 *   dispute_upheld    — filed a dispute later found VALID: honest reporting, a
 *                       small positive (never a reason to penalise).
 *   dispute_overturned— filed a dispute found FALSE/frivolous: an abuse signal.
 *   chargeback_penalty— a payment chargeback: the heaviest abuse signal.
 *   tenure            — one longevity tick (e.g. a month survived); capped in
 *                       aggregate by MAX_TENURE_POINTS so age can't dominate.
 */
export const REPUTATION_POINTS: Record<ReputationEventType, number> = {
  grade_confirmed: 30,
  verified_purchase: 8,
  dispute_upheld: 3,
  dispute_overturned: -20,
  chargeback_penalty: -50,
  tenure: 2,
};

/** Half-lives (days) governing how a contribution fades with age. Penalties
 *  fade far slower than positives so abuse can't be waited out cheaply. */
export const POSITIVE_HALF_LIFE_DAYS = 540; // ~18 months
export const PENALTY_HALF_LIFE_DAYS = 1460; // ~4 years

/** Tenure is cumulative longevity, not a decaying moment — cap its total so a
 *  long-lived but inactive account can't coast to a high level on age alone. */
export const MAX_TENURE_POINTS = 48; // ~2 years of monthly ticks at +2

/** Level thresholds (inclusive lower bound). Perks/badges are US-1817; here we
 *  only assign the numeric level + a stable slug the UI can key off. */
export const TRUST_LEVELS: ReadonlyArray<{ level: number; label: string; min: number }> = [
  { level: 0, label: "new", min: 0 },
  { level: 1, label: "trusted", min: 40 },
  { level: 2, label: "established", min: 120 },
  { level: 3, label: "connoisseur", min: 300 },
];

export interface TrustScoreResult {
  score: number;
  level: number;
  levelLabel: string;
  /** Verified events that scored (excludes unverified + zero-weight). */
  scoredEventCount: number;
  /** Total events seen (for the cache's event_count / debugging). */
  totalEventCount: number;
  /** Positive vs penalty split of the final (decayed) contribution, for the
   *  "why is my score X" explanation surface (US-1818). */
  positivePoints: number;
  penaltyPoints: number;
}

/** Exponential decay factor in [0,1] for a contribution `ageDays` old. */
function decayFactor(ageDays: number, halfLifeDays: number): number {
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Map a raw score to its level (highest threshold not exceeding the score). */
export function levelForScore(score: number): { level: number; label: string } {
  let match = TRUST_LEVELS[0];
  for (const t of TRUST_LEVELS) {
    if (score >= t.min) match = t;
  }
  return { level: match.level, label: match.label };
}

/**
 * The scoring engine. Deterministic in (events, nowMs): same inputs → same
 * result, always. Tenure is summed then capped; every other verified event
 * contributes `basePoints * decay(age)`, positives and penalties on their own
 * half-lives. The final score is `max(0, round(positives - penalties + tenure))`
 * — penalties can suppress a score to 0 but never below it.
 */
export function computeTrustScore(
  events: ReputationEventInput[],
  nowMs: number,
): TrustScoreResult {
  let positive = 0;
  let penalty = 0;
  let tenure = 0;
  let scored = 0;

  for (const ev of events) {
    if (!ev.verified) continue; // anti-gaming: unverified never scores
    const base = REPUTATION_POINTS[ev.eventType];
    if (base === undefined) continue; // unknown type (forward-compat) → ignore

    if (ev.eventType === "tenure") {
      tenure += base; // capped in aggregate below; no decay on longevity
      scored += 1;
      continue;
    }

    const ageDays = Math.max(0, (nowMs - Date.parse(ev.occurredAt)) / DAY_MS);
    if (base >= 0) {
      positive += base * decayFactor(ageDays, POSITIVE_HALF_LIFE_DAYS);
    } else {
      // Penalties carry a longer half-life; accumulate their magnitude.
      penalty += -base * decayFactor(ageDays, PENALTY_HALF_LIFE_DAYS);
    }
    scored += 1;
  }

  const cappedTenure = Math.min(tenure, MAX_TENURE_POINTS);
  const positivePoints = positive + cappedTenure;
  const raw = positivePoints - penalty;
  const score = Math.max(0, Math.round(raw));
  const { level, label } = levelForScore(score);

  return {
    score,
    level,
    levelLabel: label,
    scoredEventCount: scored,
    totalEventCount: events.length,
    positivePoints: Math.round(positivePoints * 100) / 100,
    penaltyPoints: Math.round(penalty * 100) / 100,
  };
}

// ─── DB helpers (service-role; scope every query by user_id — US-268) ────────

export interface EmitReputationEventInput {
  // US-1849: the reputation_events ledger is shared with the rewards XP track,
  // so the emitter accepts any event_type in the DB CHECK set (ReputationEventType
  // for trust + RewardEventType for XP) — hence `string`. The DB CHECK is the
  // validity guard; callers pass their own typed union (grantReward → RewardEventType).
  eventType: ReputationEventType | string;
  /** Defaults true; pass false to record an unverified (non-scoring) event. */
  verified?: boolean;
  magnitude?: number | null;
  source?: string;
  /** Idempotency handle from the producing domain (sale id, dispute id, …). */
  referenceId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

/**
 * Record a reputation event for `userId`, idempotently. A repeat emission with
 * the same (type, referenceId) is a no-op (the unique index absorbs it), so a
 * retried producer never double-counts. Returns true when a NEW row landed.
 * Does NOT recompute the score — callers batch a recompute after emitting.
 */
export async function emitReputationEvent(
  userId: string,
  input: EmitReputationEventInput,
): Promise<boolean> {
  const row = {
    user_id: userId,
    event_type: input.eventType,
    verified: input.verified ?? true,
    magnitude: input.magnitude ?? null,
    source: input.source ?? "system",
    reference_id: input.referenceId ?? "",
    metadata: input.metadata ?? {},
    occurred_at: input.occurredAt ?? new Date().toISOString(),
  };
  const { error } = await supabaseAdmin
    .from("reputation_events")
    // ignoreDuplicates: the unique (user, type, reference) index makes a retry
    // a silent no-op rather than a 23505 the caller must handle.
    .upsert(row as never, {
      onConflict: "user_id,event_type,reference_id",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw new Error(`emitReputationEvent failed: ${error.message}`);
  return true;
}

/**
 * Recompute `userId`'s Trust Score from the full event log and upsert the
 * cache. Idempotent and reconstructable — running it twice with no new events
 * yields the same row. `nowMs` is injectable for testing/backfill.
 */
export async function recomputeTrustScore(
  userId: string,
  nowMs: number = Date.now(),
): Promise<TrustScoreResult> {
  const { data, error } = await supabaseAdmin
    .from("reputation_events")
    .select("event_type, occurred_at, verified")
    .eq("user_id", userId)
    .order("occurred_at", { ascending: true });
  if (error) throw new Error(`recomputeTrustScore load failed: ${error.message}`);

  const events: ReputationEventInput[] = (data ?? []).map((r) => ({
    eventType: (r as { event_type: ReputationEventType }).event_type,
    occurredAt: (r as { occurred_at: string }).occurred_at,
    verified: (r as { verified: boolean }).verified,
  }));

  const result = computeTrustScore(events, nowMs);

  const { error: upErr } = await supabaseAdmin
    .from("buyer_trust_scores")
    .upsert(
      {
        user_id: userId,
        score: result.score,
        level: result.level,
        level_label: result.levelLabel,
        event_count: result.totalEventCount,
        computed_at: new Date(nowMs).toISOString(),
      } as never,
      { onConflict: "user_id" },
    );
  if (upErr) throw new Error(`recomputeTrustScore upsert failed: ${upErr.message}`);
  return result;
}
