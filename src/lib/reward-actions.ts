// Where the work that moves each reward happens.
//
// Every goal, quest and badge on the Rewards page used to be dead text: it
// said what to do and offered no way to go and do it. This maps each one to
// the screen that moves it, so the page works as a to-do list. Keys are the
// quest METRIC (a RewardEventType, or "xp"), the season GOAL key, and the
// BADGE key; src/lib/__tests__/reward-actions.test.ts reads the edge catalogs
// and fails if a key is added there without an action here.

export interface RewardAction {
  href: string;
  /** The link text: a short imperative. */
  label: string;
}

export interface BadgeAction extends RewardAction {
  /** The badge as a goal, for a locked medal ("Grade 100 items"). */
  goal: string;
}

const GRADE: RewardAction = { href: "/dashboard/submissions/new", label: "Grade an item" };
const PIPELINE: RewardAction = { href: "/dashboard/flipdesk/pipeline", label: "Open the pipeline" };
const LISTINGS: RewardAction = { href: "/dashboard/flipdesk/listings", label: "Go to listings" };
const VERIFIED_SHARE: RewardAction = { href: "/dashboard/flipdesk/verified", label: "Share a grade" };
const CONNECT: RewardAction = {
  href: "/dashboard/flipdesk/marketplaces",
  label: "Connect a marketplace",
};

/** By quest metric: a RewardEventType, or "xp". */
export const METRIC_ACTIONS: Readonly<Record<string, RewardAction>> = {
  coverage_completed: GRADE,
  verified_purchase: GRADE,
  grade_confirmed: { ...LISTINGS, label: "List a graded item" },
  aspects_filled: { href: "/dashboard/flipdesk/listings", label: "Fill specifics" },
  badge_embedded: { href: "/dashboard/flipdesk/verified", label: "Add your badge" },
  verified_share: VERIFIED_SHARE,
  marketplace_connected: CONNECT,
  item_cataloged: { href: "/dashboard/flipdesk/intake", label: "Add item" },
  item_measured: PIPELINE,
  item_photographed: PIPELINE,
  item_comped: { href: "/dashboard/flipdesk/pricing", label: "Price an item" },
  item_drafted: PIPELINE,
  item_listed: { ...LISTINGS, label: "List an item" },
  item_sold: LISTINGS,
  xp: PIPELINE,
};

/** By season goal key (rewards-seasons.ts SEASON_GOALS). */
export const GOAL_ACTIONS: Readonly<Record<string, RewardAction>> = {
  full_coverage: METRIC_ACTIONS.coverage_completed!,
  spread_the_grade: METRIC_ACTIONS.badge_embedded!,
  share_the_work: METRIC_ACTIONS.verified_share!,
  listing_quality: METRIC_ACTIONS.aspects_filled!,
  season_xp: METRIC_ACTIONS.xp!,
};

/** By badge key (rewards-badges.ts BADGE_CATALOG). */
export const BADGE_ACTIONS: Readonly<Record<string, BadgeAction>> = {
  first_grade: { ...GRADE, goal: "Grade your first item" },
  grades_10: { ...GRADE, goal: "Grade 10 items" },
  grades_100: { ...GRADE, goal: "Grade 100 items" },
  grades_1000: { ...GRADE, goal: "Grade 1,000 items" },
  perfect_10: { ...GRADE, goal: "Grade an item a flawless 10.0" },
  nwt_find: { ...GRADE, goal: "Grade a new-with-tags item" },
  streak_7: { ...PIPELINE, goal: "Be active 7 days in a row" },
  connected: { ...CONNECT, goal: "Connect a marketplace" },
  first_share: { ...VERIFIED_SHARE, goal: "Share a verified grade" },
  viral_find: { ...VERIFIED_SHARE, goal: "Get 25 verified clicks on one shared grade" },
  level_5: { ...PIPELINE, goal: "Reach level 5" },
};

export function actionForMetric(metric: string): RewardAction | null {
  return METRIC_ACTIONS[metric] ?? null;
}

export function actionForGoal(key: string): RewardAction | null {
  return GOAL_ACTIONS[key] ?? null;
}

export function actionForBadge(key: string): BadgeAction | null {
  return BADGE_ACTIONS[key] ?? null;
}

/**
 * Where a granted reward is used, and what the link says. Mirrors the edge's
 * grantDestination so the notification and the page agree.
 */
export function grantAction(rewardType: string): RewardAction {
  if (rewardType === "subscription_discount") {
    return { href: "/dashboard/billing", label: "Apply to your plan" };
  }
  if (rewardType === "per_grade_discount") {
    return { href: "/dashboard/submissions/new", label: "Use it on a grade" };
  }
  return { href: "/dashboard/submissions/new", label: "Use a free grade" };
}

/**
 * "On pace for 3 of 5 goals." Projects each incomplete goal's current rate to
 * the end of the season. Null before 5% of the season has passed, when a
 * projection is noise.
 */
export function seasonPaceLine(
  goals: ReadonlyArray<{ current: number; target: number; complete: boolean }>,
  elapsed: number,
): string | null {
  if (goals.length === 0 || !(elapsed >= 0.05)) return null;
  const onPace = goals.filter((g) =>
    g.complete || (elapsed > 0 && g.current / Math.min(1, elapsed) >= g.target)
  ).length;
  return `On pace for ${onPace} of ${goals.length} ${goals.length === 1 ? "goal" : "goals"}.`;
}
