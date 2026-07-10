// US-1817: buyer Trust Score — levels, badges & perks (edge, the CANONICAL source).
//
// Layers named levels + earned badges + PERKS on top of the deterministic score
// (US-1816, buyer-trust-score.ts). This is the single place guarantee (US-1819),
// rewards (US-1810), and alerts (US-1805) resolve a buyer's reputation bonus, so
// perks never drift between features.
//
// PRECEDENCE (documented): reputation perks are ADDITIVE BONUSES on top of the
// SUBSCRIPTION baseline (BuyerGateFlags/allowances, US-1800). Subscription
// decides the base capability; reputation only ever ADDS (a longer guarantee
// window, a reward multiplier, priority/early-access flags OR-ed on). A perk
// never REMOVES a subscription capability, so the two compose without conflict.
//
// DOWNGRADE/DECAY: perks are a pure function of the CURRENT level, which is a
// pure function of the (decaying) score. A score that decays past a threshold
// drops the level and its perks lapse automatically on the next recompute — no
// separate expiry bookkeeping. The web mirror is src/lib/reputation-perks.ts
// (keep the PERK MATRIX + resolver in lockstep, like BUYER_PLANS ↔ buyer-plans).

import { TRUST_LEVELS } from "./buyer-trust-score.ts";

export interface ReputationLevelMeta {
  level: number;
  /** Stable slug (matches buyer_trust_scores.level_label). */
  slug: string;
  /** Buyer-facing display name. */
  name: string;
  /** Minimum score to hold this level (inclusive). */
  minScore: number;
}

/** Display names for the level slugs defined by TRUST_LEVELS (US-1816). */
const LEVEL_NAMES: Record<string, string> = {
  new: "New",
  trusted: "Trusted",
  established: "Established",
  connoisseur: "Connoisseur",
};

/** Level metadata, derived from the scoring engine's TRUST_LEVELS so thresholds
 *  can never disagree between scoring and perks. Ordered low→high. */
export const REPUTATION_LEVELS: ReputationLevelMeta[] = TRUST_LEVELS.map((t) => ({
  level: t.level,
  slug: t.label,
  name: LEVEL_NAMES[t.label] ?? t.label,
  minScore: t.min,
}));

/** The reputation BONUSES a level grants. All are additive/OR-ed onto the
 *  subscription baseline by the consuming feature. */
export interface ReputationPerks {
  /** Extra days added to the base guarantee coverage window (US-1819). */
  guaranteeWindowBonusDays: number;
  /** Claims handled ahead of the standard queue. */
  priorityClaimHandling: boolean;
  /** Early access to graded drops. */
  earlyDropAccess: boolean;
  /** Multiplier on reward earnings (1.0 = no bonus). */
  rewardMultiplier: number;
}

export const NO_PERKS: ReputationPerks = {
  guaranteeWindowBonusDays: 0,
  priorityClaimHandling: false,
  earlyDropAccess: false,
  rewardMultiplier: 1.0,
};

/**
 * The perk matrix — the reputation policy, intentionally legible. Monotonic:
 * every field is >= the level below it, so climbing never costs a perk.
 * Index === level (0..3).
 */
export const REPUTATION_PERKS: ReputationPerks[] = [
  // 0 — New: no bonuses yet.
  { ...NO_PERKS },
  // 1 — Trusted: a small guarantee-window bonus.
  { guaranteeWindowBonusDays: 7, priorityClaimHandling: false, earlyDropAccess: false, rewardMultiplier: 1.0 },
  // 2 — Established: priority claims + a reward bump.
  { guaranteeWindowBonusDays: 14, priorityClaimHandling: true, earlyDropAccess: false, rewardMultiplier: 1.1 },
  // 3 — Connoisseur: the full set.
  { guaranteeWindowBonusDays: 30, priorityClaimHandling: true, earlyDropAccess: true, rewardMultiplier: 1.25 },
];

/** Clamp any level into the valid range (fail-safe: unknown/negative → 0). */
function clampLevel(level: number): number {
  if (!Number.isFinite(level) || level < 0) return 0;
  const max = REPUTATION_PERKS.length - 1;
  return level > max ? max : Math.trunc(level);
}

/** The perks a buyer at `level` currently holds. Pure; downgrade-safe. */
export function resolveReputationPerks(level: number): ReputationPerks {
  return REPUTATION_PERKS[clampLevel(level)];
}

/** Metadata for a level (name/slug/threshold), fail-safe clamped. */
export function reputationLevelMeta(level: number): ReputationLevelMeta {
  return REPUTATION_LEVELS[clampLevel(level)];
}

/** The next level up + how many points remain to reach it, or null at the top.
 *  Powers the "X to Connoisseur" progress affordance. */
export function nextReputationLevel(
  score: number,
  level: number,
): { level: ReputationLevelMeta; pointsAway: number } | null {
  const next = REPUTATION_LEVELS[clampLevel(level) + 1];
  if (!next) return null;
  return { level: next, pointsAway: Math.max(0, next.minScore - Math.round(score)) };
}

// ── Composition helpers — the ONE place features fold in the reputation bonus,
//    so precedence is applied identically everywhere. ─────────────────────────

/** Effective guarantee window = subscription base + reputation bonus (US-1819). */
export function effectiveGuaranteeWindowDays(baseDays: number, level: number): number {
  return baseDays + resolveReputationPerks(level).guaranteeWindowBonusDays;
}

/** Effective reward earnings = base * reputation multiplier (US-1810). */
export function applyRewardMultiplier(baseReward: number, level: number): number {
  return baseReward * resolveReputationPerks(level).rewardMultiplier;
}
