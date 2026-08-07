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
import { awardBadges } from "./rewards-badges.ts";
import { grantTangibleRewards } from "./rewards-tangible.ts";
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

/**
 * US-1851 rule: a level NEVER decreases. XP comes from an append-only log so it
 * is monotone in the normal case, but a voided event, a `verified` flip, or a
 * re-weighting of REWARD_XP_CATALOG could each pull a recomputed total down —
 * and a status that can be taken away is not status. This floor is applied
 * wherever a fresh level is about to overwrite a stored one. It lives here
 * beside the curve rather than in rewards-levels.ts because the engine writes
 * the cache, and importing the other way would close a module cycle.
 */
export function monotonicLevel(
  storedLevel: number | null | undefined,
  computedLevel: number,
): number {
  const stored = Number.isFinite(storedLevel as number)
    ? Math.max(0, Math.floor(storedLevel as number))
    : 0;
  const computed = Number.isFinite(computedLevel) ? Math.max(0, Math.floor(computedLevel)) : 0;
  return Math.max(stored, computed);
}

// ─── Coverage gate ───────────────────────────────────────────────────────────

/** The photo slots a submission must carry to earn `coverage_completed`. */
const COVERAGE_REQUIRED_TYPES = ["front", "back", "label"] as const;

/**
 * True when a submission has FULL grading coverage: the three required views
 * plus at least one detail shot (the same set the grade API requires, US-1848).
 *
 * The reward is deliberately tied to coverage rather than to grading at all —
 * XP should pull toward the photos that make a grade trustworthy, not toward
 * volume. Pure, so the policy is testable without a submission.
 */
export function hasFullGradeCoverage(images: Array<{ image_type: string }>): boolean {
  const types = new Set(images.map((i) => i.image_type));
  if (!COVERAGE_REQUIRED_TYPES.every((t) => types.has(t))) return false;
  return [...types].some((t) => t === "detail" || t.startsWith("detail_"));
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
 * ending at the most recent active day. Pure + deterministic.
 *
 * US-1851 RESOLVED what these streaks are for, and the answer is: internal
 * measurement, not seller identity. A daily streak punishes the gap between
 * sourcing trips, and reselling is bursty — so no seller surface renders
 * `currentStreak`; sellers see SEASON progress (rewards-seasons.ts) instead, and
 * the only streak shown to a human is the buyer confirmation streak, where a
 * genuinely weekly action exists (src/lib/buyer-streak.ts). `longestStreak`
 * survives because the `streak_7` badge is a historical fact about what someone
 * once did, which is a different claim from "keep it up or lose it". The
 * no-seller-surface half of that decision is pinned by a test in
 * rewards-levels_test.ts.
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

// ─── Off-platform embed gate ─────────────────────────────────────────────────

/** Hosts that are US, not somebody else's page. A badge served to one of these
 *  is our own surface rendering it — not an embed that spread our authority. */
const OWN_HOSTS = new Set([
  "gradethread.com",
  "www.gradethread.com",
  "localhost",
  "127.0.0.1",
]);

/**
 * True when a `Referer` proves the badge image was rendered on a page we do NOT
 * own — the `badge_embedded` signal (AC3's strongest moat act: grade authority
 * spread off-platform).
 *
 * Deliberately conservative: a MISSING or unparseable referer is NOT an embed.
 * A direct hit on the badge URL, a privacy-stripped referer, or a hotlink check
 * proves nothing, and this event carries the catalog's highest XP — so the
 * default has to be "no". Pure, so the policy is testable without a request.
 */
export function isOffPlatformEmbedReferer(referer: string | null | undefined): boolean {
  if (!referer) return false;
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (OWN_HOSTS.has(host)) return false;
  // Any gradethread subdomain (functions., api., staging., …) is still us.
  if (host === "gradethread.com" || host.endsWith(".gradethread.com")) return false;
  return true;
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
  // Replay short-circuit. The emit below is already idempotent, but everything
  // AFTER it (full event reload, badge re-award, tangible-reward evaluation) is
  // not free — and some sources replay hard: a badge image is re-served on every
  // cache miss across every PoP. When the dedupe key already has a row, nothing
  // about the ledger changed, so return the cached state instead of redoing the
  // work. Falls THROUGH to the full path when no state row exists yet, so an
  // earlier emit whose recompute failed still gets repaired.
  const alreadyGranted = await hasRewardEvent(userId, eventType, opts.referenceId);
  if (alreadyGranted) {
    const cached = await readRewardState(userId);
    if (cached) return cached;
  }

  await emitReputationEvent(userId, {
    eventType,
    verified: opts.verified ?? true,
    referenceId: opts.referenceId ?? "",
    // Persist the paid gate so a recompute from the log stays truthful.
    metadata: { ...(opts.metadata ?? {}), paid: opts.paid ?? false },
    source: opts.source ?? "rewards",
    occurredAt: opts.occurredAt,
  });
  const state = await recomputeRewardState(userId);
  // US-1850: re-check achievements after a rewardable action (best-effort — a
  // badge-award failure never fails the reward grant).
  try {
    await awardBadges(userId);
  } catch (err) {
    console.error(
      "[rewards] badge award failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  // US-1848: the cosmetic award above is free and unconditional; this is the
  // TANGIBLE half, and it is gated — kill-switch (fail-closed), budget ceilings
  // and one-claim-per-milestone idempotency all live inside. It reads the state
  // we just recomputed, so a milestone is evaluated against the XP the action it
  // rides on actually produced. Best-effort: never fails the reward grant.
  if (state) {
    await grantTangibleRewards(userId, state.xpTotal);
  }
  return state;
}

/**
 * Has this exact (user, type, referenceId) reward already landed? Only meaningful
 * for a source that supplies a dedupe key — a keyless grant can't be replayed
 * against, so it always reports false. Best-effort: a DB error reports false and
 * the caller falls through to the (idempotent) full path.
 */
async function hasRewardEvent(
  userId: string,
  eventType: RewardEventType,
  referenceId: string | undefined,
): Promise<boolean> {
  if (!referenceId) return false;
  const { data, error } = await supabaseAdmin
    .from("reputation_events")
    .select("id")
    .eq("user_id", userId)
    .eq("event_type", eventType)
    .eq("reference_id", referenceId)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

/** Read the cached reward state, or null when there is none / on error. */
async function readRewardState(userId: string): Promise<RewardState | null> {
  const { data, error } = await supabaseAdmin
    .from("user_reward_state")
    .select("xp_total, level, current_streak, longest_streak")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as {
    xp_total: number;
    level: number;
    current_streak: number;
    longest_streak: number;
  };
  return {
    xpTotal: row.xp_total,
    level: row.level,
    currentStreak: row.current_streak,
    longestStreak: row.longest_streak,
  };
}

/**
 * Award the `marketplace_connected` moat act (AC3) — the shared wiring every
 * provider's connect path calls, so the five of them can't drift apart.
 *
 * Call it ONLY from the first-connect branch: the dedupe key is the marketplace
 * plus the account, so a disconnect/reconnect of the SAME shop never re-earns,
 * while genuinely connecting a second marketplace does. Best-effort by
 * construction — a reward problem must never fail an OAuth callback the seller
 * is mid-way through.
 */
export async function grantMarketplaceConnectedReward(
  userId: string,
  marketplace: string,
  account: string | null | undefined,
): Promise<void> {
  try {
    await grantReward(userId, "marketplace_connected", {
      referenceId: `${marketplace}:${account ?? "primary"}`,
      source: marketplace,
      metadata: { marketplace },
    });
  } catch (err) {
    console.error(
      `[rewards] marketplace_connected grant failed (${marketplace}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
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

  const computed = computeRewardState(events);
  // US-1851: never write a level below the one already banked. The recompute is
  // the ONLY writer, so this floor is the whole guarantee — and it also means a
  // catalog re-weighting can be shipped without demoting anybody.
  const prior = await readRewardState(userId);
  const state: RewardState = {
    ...computed,
    level: monotonicLevel(prior?.level, computed.level),
    // Same reasoning for the best-ever streak: it is a historical fact, and a
    // recompute that loses old events must not erase it.
    longestStreak: Math.max(prior?.longestStreak ?? 0, computed.longestStreak),
  };
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
