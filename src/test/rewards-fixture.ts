// A complete, plausible RewardsState for page-level tests.
import type { RewardsState } from "@/hooks/use-rewards";

export function rewardsFixture(over: Partial<RewardsState> = {}): RewardsState {
  return {
    level: {
      level: 4,
      xp_total: 420,
      xp_peak: 450,
      tier: { key: "picker", name: "Picker", minLevel: 3, blurb: "Finding your eye.", icon: "Search" },
      next_tier: { key: "archivist", name: "Archivist", minLevel: 8, blurb: "", icon: "Library" },
      xp_into_level: 50,
      xp_level_span: 200,
      xp_to_next_level: 150,
      percent_to_next_level: 25,
      xp_to_next_tier: 900,
    },
    season: {
      key: "2026-Q3",
      label: "Q3 2026",
      starts_at: "2026-07-01T00:00:00.000Z",
      ends_at: "2099-10-01T00:00:00.000Z",
      elapsed: 0.5,
      xp_earned: 120,
      goals: [
        {
          key: "full_coverage",
          name: "Grade 10 items",
          description: "Grade with full photo coverage.",
          target: 10,
          current: 3,
          complete: false,
          percent: 30,
          icon: "Camera",
        },
      ],
      goals_completed: 0,
      goals_total: 1,
    },
    recaps: [],
    perks: { unlocked: [], locked: [] },
    arrival: null,
    badges: { earned: [], upcoming: [], earned_count: 0, total: 0 },
    milestones: { enabled: false, granted: [], next: null },
    integrity: {
      tier: "building",
      label: "Building history",
      displayable: false,
      integrity_score: 100,
      confirmed_count: 0,
      disputed_count: 0,
      avg_coverage_pct: null,
      tenure_days: null,
      graded_volume: 0,
      reasons: [],
      next_tier: null,
      next_tier_gaps: [],
      tier_changed_at: null,
    },
    loyalty: null,
    season_timezone: "America/Chicago",
    ...over,
  };
}
