// US-1849: Rewards XP/points engine — the ONE ledger for BOTH the seller/user
// XP track and the buyer Trust Score track (US-1815..1818). It REUSES
// reputation_events (00417) as the append-only event log — the buyer Trust
// scorer and this XP scorer read the same log; each ignores the other's event
// types. There is intentionally NO parallel ledger.
//
// The pure engine (catalog + xpForEvent + levelForXp + computeRewardState) takes
// plain data and unit-tests without a DB. grantReward is the idempotent primitive
// every rewardable source calls; it emits one reputation_events row (idempotent
// on the dedupe key) and recomputes the user_reward_state cache.

import { emitReputationEvent } from "./buyer-trust-score.ts";
import { supabaseAdmin } from "./supabase.ts";

// Reward-only event types (added to the reputation_events CHECK in 00443). The
// trust scorer ignores these; the XP catalog scores them.
export type RewardEventType =
  | "coverage_completed"
  | "badge_embedded"
  | "aspects_filled"
  | "marketplace_connected"
  | "verified_share"
  // Shared with the trust track — these ALSO carry XP (a paid grade / confirmed
  // arrival is both a trust signal and a rewardable action).
  | "verified_purchase"
  | "grade_confirmed";

/**
 * Per-event XP, weighted by BUSINESS / MOAT contribution rather than raw effort
 * (US-1849): the acts that compound GradeThread's advantages score highest — a
 * grade badge embedded OFF-platform (authority spread), a marketplace connected
 * (stickiness), full photo coverage (grading quality) — above cheap busywork.
 * This table IS the reward policy; legible by design.
 */
export const REWARD_XP_CATALOG: Record<RewardEventType, number> = {
  badge_embedded: 50, // grade authority spread off-platform — the strongest moat act
  marketplace_connected: 40, // platform stickiness / lock-in
  grade_confirmed: 30, // post-sale ground truth (paid only — see xpForEvent)
  coverage_completed: 25, // full photo coverage → grading quality (paid only)
  verified_share: 20, // verified share-click — viral loop
  verified_purchase: 15, // a paid, grade-linked purchase (paid only)
  aspects_filled: 10, // listing quality / SEO surface
};

// Events that consume real AI grading spend. Per US-1849 AC4 these award XP ONLY
// when the action was PAID or credit-consuming, so free/junk submissions earn
// nothing and grade-XP is self-limiting against farming.
const GRADING_SPEND_EVENTS = new Set<RewardEventType>([
  "grade_confirmed",
  "coverage_completed",
  "verified_purchase",
]);

/**
 * XP for one event. A grading-spend event earns 0 unless `paid` is true (AC4).
 * Unverified events earn 0 (anti-gaming) — the caller passes verified.
 */
export function xpForEvent(
  eventType: RewardEventType,
  opts: { paid?: boolean; verified?: boolean } = {},
): number {
  if (opts.verified === false) return 0;
  const base = REWARD_XP_CATALOG[eventType];
  if (base === undefined) return 0;
  if (GRADING_SPEND_EVENTS.has(eventType) && !opts.paid) return 0;
  return base;
}

// ─── Level curve ─────────────────────────────────────────────────────────────
// Level N needs N² × LEVEL_BASE XP: a gentle quadratic so early levels come fast
// and later ones take real, sustained contribution. Legible + reconstructable.
export const LEVEL_BASE = 100;

export function levelForXp(xpTotal: number): number {
  if (xpTotal <= 0) return 0;
  return Math.floor(Math.sqrt(xpTotal / LEVEL_BASE));
}

/** XP required to reach `level` (the floor of the level's band). */
export function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  return level * level * LEVEL_BASE;
}

// ─── Pure state reducer ──────────────────────────────────────────────────────

export interface RewardEventInput {
  eventType: RewardEventType;
  occurredAt: string; // ISO
  verified: boolean;
  /** Whether the underlying action was paid/credit-consuming (grading-spend gate). */
  paid?: boolean;
}

export interface RewardState {
  xpTotal: number;
  level: number;
  currentStreak: number;
  longestStreak: number;
}

const DAY_MS = 86_400_000;

function dayKey(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : NaN;
}

/**
 * Reduce a user's reward events to XP total, level, and activity streaks. Streaks
 * count consecutive UTC days with ≥1 XP-earning event; currentStreak is the run
 * ending at the most recent active day (a snapshot from the log — US-1851 refines
 * the live "did they act today" decay). Pure + deterministic.
 */
export function computeRewardState(events: RewardEventInput[]): RewardState {
  let xpTotal = 0;
  const activeDays = new Set<number>();
  for (const ev of events) {
    const xp = xpForEvent(ev.eventType, { paid: ev.paid, verified: ev.verified });
    if (xp <= 0) continue;
    xpTotal += xp;
    const d = dayKey(ev.occurredAt);
    if (Number.isFinite(d)) activeDays.add(d);
  }

  // Streaks over the sorted distinct active days.
  const days = [...activeDays].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1]! + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  // currentStreak = the run ending at the LAST active day.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (i === days.length - 1) current = 1;
    else if (days[i] === days[i + 1]! - 1) current += 1;
    else break;
  }

  return { xpTotal, level: levelForXp(xpTotal), currentStreak: current, longestStreak: longest };
}

// ─── DB helpers (service-role; scope every query by user_id — US-268) ─────────

export interface GrantRewardOptions {
  /** Idempotency handle from the source domain (submissionId, cardId, …). One
   *  event per (user, type, referenceId) — replays/retries never double-award. */
  referenceId?: string;
  /** Grading-spend gate (AC4): only a paid/credit-consuming action earns grade XP. */
  paid?: boolean;
  /** Anti-gaming: false records an audit-only, non-scoring event. */
  verified?: boolean;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
  source?: string;
}

/**
 * The idempotent reward primitive every rewardable source calls. Emits ONE
 * reputation_events row (idempotent on the dedupe key via emitReputationEvent)
 * and recomputes the user_reward_state cache. Returns the fresh state, or null
 * on a best-effort recompute failure (the emit still landed). Tenant-scoped by
 * userId (US-268).
 */
export async function grantReward(
  userId: string,
  eventType: RewardEventType,
  opts: GrantRewardOptions = {},
): Promise<RewardState | null> {
  await emitReputationEvent(userId, {
    eventType,
    verified: opts.verified ?? true,
    referenceId: opts.referenceId ?? "",
    // Persist the paid gate so a recompute from the log stays truthful.
    metadata: { ...(opts.metadata ?? {}), paid: opts.paid ?? false },
    source: opts.source ?? "rewards",
    occurredAt: opts.occurredAt,
  });
  return recomputeRewardState(userId);
}

/** The reward event types the XP scorer reads (the trust-only types are skipped). */
const REWARD_TYPES = new Set<RewardEventType>(
  Object.keys(REWARD_XP_CATALOG) as RewardEventType[],
);

/**
 * Recompute `userId`'s XP/level/streaks from the reputation_events log and upsert
 * user_reward_state. Idempotent + reconstructable. Best-effort: logs + returns
 * null on a DB error rather than throwing. Scoped by user_id (US-268).
 */
export async function recomputeRewardState(
  userId: string,
): Promise<RewardState | null> {
  const { data, error } = await supabaseAdmin
    .from("reputation_events")
    .select("event_type, occurred_at, verified, metadata")
    .eq("user_id", userId)
    .order("occurred_at", { ascending: true });
  if (error) {
    console.error("[rewards] event load failed:", error.message);
    return null;
  }

  const events: RewardEventInput[] = [];
  for (const r of data ?? []) {
    const row = r as {
      event_type: string;
      occurred_at: string;
      verified: boolean;
      metadata: Record<string, unknown> | null;
    };
    if (!REWARD_TYPES.has(row.event_type as RewardEventType)) continue;
    events.push({
      eventType: row.event_type as RewardEventType,
      occurredAt: row.occurred_at,
      verified: row.verified,
      paid: row.metadata?.paid === true,
    });
  }

  const state = computeRewardState(events);
  const { error: upErr } = await supabaseAdmin
    .from("user_reward_state")
    .upsert(
      {
        user_id: userId,
        xp_total: state.xpTotal,
        level: state.level,
        current_streak: state.currentStreak,
        longest_streak: state.longestStreak,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "user_id" },
    );
  if (upErr) {
    console.error("[rewards] reward-state upsert failed:", upErr.message);
    return null;
  }
  return state;
}
