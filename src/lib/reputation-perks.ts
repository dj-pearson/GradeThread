// US-1817: buyer Trust Score levels/badges/perks — WEB MIRROR.
//
// The React mirror of services/edge-functions/src/lib/buyer-reputation-perks.ts
// (which is canonical). Client surfaces show a buyer their level/badge/perks;
// the edge resolves the same matrix when a feature grants the bonus. Keep the
// LEVEL thresholds + PERK MATRIX in lockstep with the edge (same convention as
// BUYER_PLANS ↔ buyer-plans.ts). reputation-perks.test.ts pins the values.

export interface ReputationLevelMeta {
  level: number;
  slug: string;
  name: string;
  minScore: number;
}

// Thresholds mirror TRUST_LEVELS in the edge scoring engine (US-1816).
export const REPUTATION_LEVELS: ReputationLevelMeta[] = [
  { level: 0, slug: "new", name: "New", minScore: 0 },
  { level: 1, slug: "trusted", name: "Trusted", minScore: 40 },
  { level: 2, slug: "established", name: "Established", minScore: 120 },
  { level: 3, slug: "connoisseur", name: "Connoisseur", minScore: 300 },
];

export interface ReputationPerks {
  guaranteeWindowBonusDays: number;
  priorityClaimHandling: boolean;
  earlyDropAccess: boolean;
  rewardMultiplier: number;
}

// Perk matrix — MUST match REPUTATION_PERKS in the edge lib. Index === level.
export const REPUTATION_PERKS: ReputationPerks[] = [
  { guaranteeWindowBonusDays: 0, priorityClaimHandling: false, earlyDropAccess: false, rewardMultiplier: 1.0 },
  { guaranteeWindowBonusDays: 7, priorityClaimHandling: false, earlyDropAccess: false, rewardMultiplier: 1.0 },
  { guaranteeWindowBonusDays: 14, priorityClaimHandling: true, earlyDropAccess: false, rewardMultiplier: 1.1 },
  { guaranteeWindowBonusDays: 30, priorityClaimHandling: true, earlyDropAccess: true, rewardMultiplier: 1.25 },
];

function clampLevel(level: number): number {
  if (!Number.isFinite(level) || level < 0) return 0;
  const max = REPUTATION_PERKS.length - 1;
  return level > max ? max : Math.trunc(level);
}

export function resolveReputationPerks(level: number): ReputationPerks {
  return REPUTATION_PERKS[clampLevel(level)]!;
}

export function reputationLevelMeta(level: number): ReputationLevelMeta {
  return REPUTATION_LEVELS[clampLevel(level)]!;
}

/** Next level + points remaining, or null at the top (drives the progress UI). */
export function nextReputationLevel(
  score: number,
  level: number,
): { level: ReputationLevelMeta; pointsAway: number } | null {
  const next = REPUTATION_LEVELS[clampLevel(level) + 1];
  if (!next) return null;
  return { level: next, pointsAway: Math.max(0, next.minScore - Math.round(score)) };
}

/** Human-readable perk lines for a level (only the perks it actually unlocks). */
export function perkHighlights(level: number): string[] {
  const p = resolveReputationPerks(level);
  const out: string[] = [];
  if (p.guaranteeWindowBonusDays > 0) out.push(`+${p.guaranteeWindowBonusDays} days guarantee coverage`);
  if (p.rewardMultiplier > 1) out.push(`${Math.round((p.rewardMultiplier - 1) * 100)}% bonus rewards`);
  if (p.priorityClaimHandling) out.push("Priority claim handling");
  if (p.earlyDropAccess) out.push("Early access to graded drops");
  return out;
}

/** Tailwind badge classes per level (reuses the project's tint conventions —
 *  higher levels read warmer/stronger). */
export function levelBadgeClass(level: number): string {
  switch (clampLevel(level)) {
    case 3:
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
    case 2:
      return "bg-primary/10 text-primary border-primary/30";
    case 1:
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}
