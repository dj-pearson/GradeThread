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
  /** US-1854: distinct FINDS that reached the top of the share ladder (25
   *  verified click-throughs) or produced a signup. Deliberately not the same
   *  number as shareCount — see the `viral_find` entry below. */
  viralFindCount: number;
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
  // US-1854: ONE find that travelled — 25 verified click-throughs, or a signup.
  // It used to read `shareCount >= 10`, which is ten DIFFERENT finds clicked
  // once each: a medal named for a viral find that could be earned without ever
  // having one. The medal describes a single item's reach, so its criterion has
  // to be per-item too.
  { key: "viral_find", name: "Viral Find", description: "One shared grade drove 25 verified click-throughs (or a signup).", tier: "gold", icon: "TrendingUp", hidden: true, criteria: (c) => c.viralFindCount >= 1 },
  { key: "level_5", name: "Level 5", description: "Reached reward level 5.", tier: "silver", icon: "ChevronsUp", hidden: false, criteria: (c) => c.level >= 5 },
];

const BADGE_BY_KEY: Record<string, BadgeDef> = Object.fromEntries(
  BADGE_CATALOG.map((b) => [b.key, b]),
);

export function badgeByKey(key: string): BadgeDef | undefined {
  return BADGE_BY_KEY[key];
}

// ─── Public projection (US-1850 AC3) ─────────────────────────────────────────

/** One EARNED badge as it appears on a public surface (the verified-seller
 *  profile). Catalog metadata + when it was earned only — never the `context`
 *  snapshot, which holds the owner's private stats (grade counts, XP). */
export interface PublicAchievement {
  key: string;
  name: string;
  description: string;
  tier: BadgeTier;
  icon: string;
  earned_at: string;
}

/** Rarest first, so the gold medals lead. */
const TIER_RANK: Record<BadgeTier, number> = { gold: 0, silver: 1, bronze: 2 };

/**
 * Pure: earned rows → public achievement DTOs, rarest tier first and newest
 * first within a tier. A key with no catalog entry (a badge retired from
 * BADGE_CATALOG) drops out rather than rendering a nameless medal. `hidden`
 * badges DO appear once earned — hidden means "not advertised before you earn
 * it", and the reveal is the point.
 */
export function publicAchievements(
  rows: ReadonlyArray<{ badge_key: string; earned_at: string }>,
): PublicAchievement[] {
  const out: PublicAchievement[] = [];
  for (const row of rows) {
    const def = badgeByKey(row.badge_key);
    if (!def) continue;
    out.push({
      key: def.key,
      name: def.name,
      description: def.description,
      tier: def.tier,
      icon: def.icon,
      earned_at: row.earned_at,
    });
  }
  return out.sort((a, b) =>
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    b.earned_at.localeCompare(a.earned_at)
  );
}

// US-1854: the share ladder's dedupe keys are `share:<type>:<id>:<rung>`. The
// rungs that mean "this ONE find travelled" are the top click rung and a signup.
// Parsed here rather than imported from share-to-earn.ts, which imports the
// reward engine that imports this file — a cycle whose init order would decide
// whether a const is defined yet.
const VIRAL_RUNGS = new Set(["viral", "signup"]);

/**
 * Pure: how many DISTINCT finds reached a viral rung, from their ledger dedupe
 * keys. A find that hits both the click rung and a signup counts once.
 */
export function countViralFinds(referenceIds: readonly string[]): number {
  const finds = new Set<string>();
  for (const ref of referenceIds) {
    const parts = (ref ?? "").split(":");
    if (parts.length < 4 || parts[0] !== "share") continue;
    const rung = parts[parts.length - 1]!;
    if (!VIRAL_RUNGS.has(rung)) continue;
    finds.add(parts.slice(1, -1).join(":"));
  }
  return finds.size;
}

/** Pure: the catalog keys the context satisfies. Deterministic + DB-free. */
export function evaluateBadges(ctx: BadgeContext): string[] {
  return BADGE_CATALOG.filter((b) => b.criteria(ctx)).map((b) => b.key);
}

// ─── The owner's shelf (US-1857) ─────────────────────────────────────────────
//
// The PUBLIC projection above shows only what a seller has earned. The shelf is
// the private one: earned medals PLUS the ones still to earn, because a gallery
// with nothing to aim at is a trophy case, not a shelf.

/** One catalog badge as the shelf renders it. `earned_at` null = not earned. */
export interface BadgeShelfEntry {
  key: string;
  name: string;
  description: string;
  tier: BadgeTier;
  icon: string;
  earned_at: string | null;
}

export interface BadgeShelf {
  earned: BadgeShelfEntry[];
  upcoming: BadgeShelfEntry[];
  earned_count: number;
  /**
   * The shelf's denominator: the ADVERTISED catalog plus any hidden badge this
   * user has already earned. A hidden badge nobody has earned stays out of the
   * count — "3 of 12" when the visible list holds 11 is a leak that a surprise
   * exists, which is the one thing `hidden` is for.
   */
  total: number;
}

/** Pure: earned rows + the catalog → the shelf. */
export function badgeShelf(
  rows: ReadonlyArray<{ badge_key: string; earned_at: string }>,
): BadgeShelf {
  const earned: BadgeShelfEntry[] = publicAchievements(rows).map((a) => ({
    key: a.key,
    name: a.name,
    description: a.description,
    tier: a.tier,
    icon: a.icon,
    earned_at: a.earned_at,
  }));
  const earnedKeys = new Set(earned.map((e) => e.key));
  const upcoming: BadgeShelfEntry[] = BADGE_CATALOG
    .filter((b) => !b.hidden && !earnedKeys.has(b.key))
    .map((b) => ({
      key: b.key,
      name: b.name,
      description: b.description,
      tier: b.tier,
      icon: b.icon,
      earned_at: null,
    }));
  return {
    earned,
    upcoming,
    earned_count: earned.length,
    total: earned.length + upcoming.length,
  };
}

/** The caller's own shelf. Tenant-scoped by userId; best-effort — a failed read
 *  renders an empty shelf rather than taking down the rewards screen. */
export async function loadBadgeShelf(userId: string): Promise<BadgeShelf> {
  const { data, error } = await supabaseAdmin
    .from("user_badges")
    .select("badge_key, earned_at")
    .eq("user_id", userId);
  if (error) {
    console.error("[rewards-badges] shelf load failed:", error.message);
    return badgeShelf([]);
  }
  return badgeShelf((data ?? []) as Array<{ badge_key: string; earned_at: string }>);
}

// ─── Award engine (service-role; scoped by user_id — US-268) ─────────────────

const EMPTY_CONTEXT: BadgeContext = {
  gradeCount: 0,
  perfect10Count: 0,
  nwtCount: 0,
  longestStreak: 0,
  shareCount: 0,
  viralFindCount: 0,
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

  // US-1854: the per-find viral count. Read as dedupe keys rather than counted
  // in SQL because the medal is per FIND, not per event — two rungs on one find
  // must not read as two viral finds.
  const { data: shareMilestones } = await supabaseAdmin
    .from("reputation_events")
    .select("reference_id")
    .eq("user_id", userId)
    .eq("event_type", "share_milestone")
    .eq("verified", true)
    .limit(1000);
  ctx.viralFindCount = countViralFinds(
    ((shareMilestones ?? []) as Array<{ reference_id: string }>).map((r) => r.reference_id),
  );

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
      return { shareCount: c.shareCount };
    case "viral_find":
      return { viralFindCount: c.viralFindCount };
    case "connected":
      return { marketplaceCount: c.marketplaceCount };
    case "level_5":
      return { level: c.level, xpTotal: c.xpTotal };
    default:
      return { gradeCount: c.gradeCount };
  }
}
