// Where every rewards notification and nudge points.
//
// The Rewards page has three tabs (standing, season, perks) and opens on
// standing. A link to the bare /dashboard/rewards therefore landed a seller who
// was told "quest complete" on a tab with no quests on it. Every link names its
// tab, and an anchor where the page has one, and tests/rewards-links_test.ts
// fails if a bare link comes back. The SPA reads ?tab= and scrolls to the hash
// (src/pages/rewards.tsx).

export const REWARDS_LINKS = {
  /** Quests and community challenges. */
  quests: "/dashboard/rewards?tab=season#quests",
  /** The season track itself. */
  season: "/dashboard/rewards?tab=season",
  /** Granted tangible rewards and the next one on the ladder. */
  milestones: "/dashboard/rewards?tab=season#milestones",
  /** The badge shelf. */
  badges: "/dashboard/rewards?tab=standing#badges",
  /** Tenure, anniversaries and the loyalty tier. */
  loyalty: "/dashboard/rewards?tab=standing#loyalty",
  /** Grade Integrity. */
  integrity: "/dashboard/rewards?tab=standing#integrity",
} as const;
