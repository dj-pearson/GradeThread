// Cost map for FlipDesk-initiated grading submissions. Tiers map to
// GradeThread's SLA + handling priority:
//   - standard: best-effort, no SLA, cheapest
//   - premium:  ~24h SLA, prioritized in the queue
//   - express:  ~4h SLA, top priority
// Tune these centrally — every cost surface (submit, UI estimate,
// post-grade `flipdesk_grading_submissions.cost`) reads from here.

export type GradingTier = "standard" | "premium" | "express";

export const GRADING_TIERS: ReadonlySet<GradingTier> = new Set([
  "standard",
  "premium",
  "express",
]);

export const GRADING_TIER_COSTS: Record<GradingTier, number> = {
  standard: 2.99,
  premium: 5.99,
  express: 9.99,
};

export function isGradingTier(value: unknown): value is GradingTier {
  return typeof value === "string" && GRADING_TIERS.has(value as GradingTier);
}

export function tierCost(tier: GradingTier): number {
  return GRADING_TIER_COSTS[tier];
}

// Plan limits mirror grade.ts (kept in sync; consider extracting if a third
// caller appears). `-1` means unlimited.
export const PLAN_GRADE_LIMITS: Record<string, number> = {
  free: 5,
  starter: 50,
  professional: 500,
  enterprise: -1,
};

export function planLimit(plan: string): number {
  return PLAN_GRADE_LIMITS[plan] ?? 0;
}
