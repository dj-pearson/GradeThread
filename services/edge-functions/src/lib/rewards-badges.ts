// US-1850: achievements / badges / medals — a code CATALOG of definitions
// (criteria are predicates, so they live in code) + an idempotent award engine
// that evaluates each user's criteria off the reward ledger (US-1849) and their
// grade data, and records unlocks in user_badges (00444).
//
// The evaluation core (evaluateBadges over a BadgeContext) is pure + unit-tested;
// awardBadges assembles the context from queries and upserts the newly-earned.

import { supabaseAdmin } from "./supabase.ts";

export type BadgeTier = "bronze" | "silver" | "gold";

/** The stats a badge criterion reads. Assembled by awardBadges; the pure
 *  evaluator never queries — it just tests predicates over this. */
export interface BadgeContext {
  gradeCount: number;
  perfect10Count: number; // grades with an overall_score of 10.0
  nwtCount: number; // grades tiered NWT (new with tags)
  longestStreak: number; // consecutive active days (reward state)
  shareCount: number; // verified_share reward events
  marketplaceCount: number; // marketplace_connected reward events
  xpTotal: number;
  level: number;
}

export interface BadgeDef {
  key: string;
  name: string;
  description: string;
  tier: BadgeTier;
  icon: string; // lucide icon name (rendered client-side / on the card)
  /** Hidden until earned (a surprise) — not shown in the "to earn" list. */
  hidden: boolean;
  /** Earned when this predicate is true for the user's context. */
  criteria: (c: BadgeContext) => boolean;
}

// The catalog IS the achievement policy — legible, versioned, testable. Tiers
// escalate the same axis (10/100/1000 grades) so collectors have a ladder.
export const BADGE_CATALOG: readonly BadgeDef[] = [
  { key: "first_grade", name: "First Grade", description: "Graded your first item.", tier: "bronze", icon: "Sparkles", hidden: false, criteria: (c) => c.gradeCount >= 1 },
  { key: "grades_10", name: "Getting Started", description: "Graded 10 items.", tier: "bronze", icon: "Award", hidden: false, criteria: (c) => c.gradeCount >= 10 },
  { key: "grades_100", name: "Century", description: "Graded 100 items.", tier: "silver", icon: "Medal", hidden: false, criteria: (c) => c.gradeCount >= 100 },
  { key: "grades_1000", name: "Master Grader", description: "Graded 1,000 items.", tier: "gold", icon: "Trophy", hidden: false, criteria: (c) => c.gradeCount >= 1000 },
  { key: "perfect_10", name: "Perfect 10", description: "Graded an item a flawless 10.0.", tier: "silver", icon: "Star", hidden: false, criteria: (c) => c.perfect10Count >= 1 },
  { key: "nwt_find", name: "NWT Find", description: "Graded a new-with-tags item.", tier: "bronze", icon: "Tag", hidden: false, criteria: (c) => c.nwtCount >= 1 },
  { key: "streak_7", name: "7-Day Streak", description: "Active 7 days in a row.", tier: "silver", icon: "Flame", hidden: false, criteria: (c) => c.longestStreak >= 7 },
  { key: "connected", name: "Plugged In", description: "Connected a marketplace.", tier: "bronze", icon: "Plug", hidden: false, criteria: (c) => c.marketplaceCount >= 1 },
  { key: "first_share", name: "First Share", description: "Shared a verified grade.", tier: "bronze", icon: "Share2", hidden: false, criteria: (c) => c.shareCount >= 1 },
  { key: "viral_find", name: "Viral Find", description: "A shared grade earned 10 verified clicks.", tier: "gold", icon: "TrendingUp", hidden: true, criteria: (c) => c.shareCount >= 10 },
  { key: "level_5", name: "Level 5", description: "Reached reward level 5.", tier: "silver", icon: "ChevronsUp", hidden: false, criteria: (c) => c.level >= 5 },
];

const BADGE_BY_KEY: Record<string, BadgeDef> = Object.fromEntries(
  BADGE_CATALOG.map((b) => [b.key, b]),
);

export function badgeByKey(key: string): BadgeDef | undefined {
  return BADGE_BY_KEY[key];
}

/** Pure: the catalog keys the context satisfies. Deterministic + DB-free. */
export function evaluateBadges(ctx: BadgeContext): string[] {
  return BADGE_CATALOG.filter((b) => b.criteria(ctx)).map((b) => b.key);
}

// ─── Award engine (service-role; scoped by user_id — US-268) ─────────────────

const EMPTY_CONTEXT: BadgeContext = {
  gradeCount: 0,
  perfect10Count: 0,
  nwtCount: 0,
  longestStreak: 0,
  shareCount: 0,
  marketplaceCount: 0,
  xpTotal: 0,
  level: 0,
};

/** Assemble a user's badge context from their grade + reward data. Best-effort:
 *  a failed sub-query leaves that stat at 0 (a badge just doesn't unlock yet),
 *  never throws. Tenant-scoped by userId. */
export async function loadBadgeContext(userId: string): Promise<BadgeContext> {
  const ctx: BadgeContext = { ...EMPTY_CONTEXT };

  // Grade stats — grade_reports scope to the user via submissions.user_id.
  const grades = supabaseAdmin
    .from("grade_reports")
    .select("id, submissions!inner(user_id)", { count: "exact", head: true })
    .eq("submissions.user_id", userId);
  const perfect = supabaseAdmin
    .from("grade_reports")
    .select("id, submissions!inner(user_id)", { count: "exact", head: true })
    .eq("submissions.user_id", userId)
    .eq("overall_score", 10);
  const nwt = supabaseAdmin
    .from("grade_reports")
    .select("id, submissions!inner(user_id)", { count: "exact", head: true })
    .eq("submissions.user_id", userId)
    .eq("grade_tier", "NWT");

  const [{ count: gradeCount }, { count: perfect10 }, { count: nwtCount }] =
    await Promise.all([grades, perfect, nwt]);
  ctx.gradeCount = gradeCount ?? 0;
  ctx.perfect10Count = perfect10 ?? 0;
  ctx.nwtCount = nwtCount ?? 0;

  // Reward-event counts (verified only).
  const shares = supabaseAdmin
    .from("reputation_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("event_type", "verified_share")
    .eq("verified", true);
  const markets = supabaseAdmin
    .from("reputation_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("event_type", "marketplace_connected")
    .eq("verified", true);
  const [{ count: shareCount }, { count: marketplaceCount }] = await Promise.all([
    shares,
    markets,
  ]);
  ctx.shareCount = shareCount ?? 0;
  ctx.marketplaceCount = marketplaceCount ?? 0;

  // XP / level / streak from the reward-state cache.
  const { data: state } = await supabaseAdmin
    .from("user_reward_state")
    .select("xp_total, level, longest_streak")
    .eq("user_id", userId)
    .maybeSingle();
  if (state) {
    const s = state as { xp_total: number; level: number; longest_streak: number };
    ctx.xpTotal = s.xp_total ?? 0;
    ctx.level = s.level ?? 0;
    ctx.longestStreak = s.longest_streak ?? 0;
  }

  return ctx;
}

/**
 * Evaluate + award any newly-earned badges for a user. Idempotent: the unique
 * (user_id, badge_key) index makes a re-award a no-op, so this is safe to call
 * after every rewardable action. Returns the keys awarded THIS call (empty when
 * nothing new). Best-effort — logs + returns [] on a DB error.
 */
export async function awardBadges(userId: string): Promise<string[]> {
  const ctx = await loadBadgeContext(userId);
  const earned = evaluateBadges(ctx);
  if (earned.length === 0) return [];

  const rows = earned.map((badge_key) => ({
    user_id: userId,
    badge_key,
    context: contextSnapshotFor(badge_key, ctx),
  }));
  const { data, error } = await supabaseAdmin
    .from("user_badges")
    .upsert(rows as never, {
      onConflict: "user_id,badge_key",
      ignoreDuplicates: true,
    })
    .select("badge_key");
  if (error) {
    console.error("[rewards-badges] award upsert failed:", error.message);
    return [];
  }
  // Only rows that ACTUALLY inserted (ignoreDuplicates drops already-earned).
  return ((data ?? []) as Array<{ badge_key: string }>).map((r) => r.badge_key);
}

// The single stat that earned a badge, snapshotted for the shareable card.
function contextSnapshotFor(key: string, c: BadgeContext): Record<string, number> {
  switch (key) {
    case "perfect_10":
      return { perfect10Count: c.perfect10Count };
    case "nwt_find":
      return { nwtCount: c.nwtCount };
    case "streak_7":
      return { longestStreak: c.longestStreak };
    case "first_share":
    case "viral_find":
      return { shareCount: c.shareCount };
    case "connected":
      return { marketplaceCount: c.marketplaceCount };
    case "level_5":
      return { level: c.level, xpTotal: c.xpTotal };
    default:
      return { gradeCount: c.gradeCount };
  }
}
