// US-1851: the seller's own progression — level, tier, season, perks.
//
// Read-only and personal (no workspace middleware): progression belongs to the
// individual account that earned it, so ownership is `c.get("userId")` directly
// and every query below is filtered by it. The service-role client bypasses RLS
// (US-268), so that filter IS the boundary.
//
// The response is assembled from the append-only reputation_events log rather
// than from a stored season row — see rewards-seasons.ts for why nothing is
// persisted per season.

import { Hono } from "hono";
import {
  monotonicLevel,
  type RewardEventInput,
  type RewardEventType,
  REWARD_XP_CATALOG,
  computeRewardState,
} from "../lib/rewards-engine.ts";
import { levelProgress, perksForLevel } from "../lib/rewards-levels.ts";
import {
  computeSeasonProgress,
  earnedSeasonFrames,
  seasonRecap,
  seasonKeyAt,
} from "../lib/rewards-seasons.ts";
import { supabaseAdmin } from "../lib/supabase.ts";

type RewardsEnv = { Variables: { userId: string } };

export const rewardsRoutes = new Hono<RewardsEnv>();

const REWARD_TYPES = new Set(Object.keys(REWARD_XP_CATALOG) as RewardEventType[]);

/** Load one user's XP-scoring events. Tenant-scoped by user_id (US-268). */
async function loadRewardEvents(userId: string): Promise<RewardEventInput[] | null> {
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
  return events;
}

/**
 * GET /api/rewards/me — the caller's progression.
 *
 * XP and level come from the derived cache when it exists (it carries the
 * never-decreases floor); the season is recomputed from the log every time,
 * because a season is a window and windows move without anything being written.
 */
rewardsRoutes.get("/me", async (c) => {
  const userId = c.get("userId");

  const events = await loadRewardEvents(userId);
  if (!events) return c.json({ error: "Couldn't load your rewards." }, 500);

  const { data: cached } = await supabaseAdmin
    .from("user_reward_state")
    .select("xp_total, level")
    .eq("user_id", userId)
    .maybeSingle();
  const cachedRow = cached as { xp_total?: number; level?: number } | null;

  // The cache is derived, so a missing row is not an error — it just means this
  // account has never had a reward event recomputed. Fall back to the log.
  const fromLog = computeRewardState(events);
  const xpTotal = cachedRow?.xp_total ?? fromLog.xpTotal;
  const level = monotonicLevel(cachedRow?.level, fromLog.level);

  const nowMs = Date.now();
  const progress = levelProgress(xpTotal, level);
  const season = computeSeasonProgress(events, nowMs);
  const perks = perksForLevel(level);

  return c.json({
    xpTotal: progress.xpTotal,
    level: progress.level,
    tier: progress.tier,
    nextTier: progress.nextTier,
    progress: {
      xpIntoLevel: progress.xpIntoLevel,
      xpForNextLevel: progress.xpForNextLevel,
      xpToNextLevel: progress.xpToNextLevel,
      pctToNextLevel: progress.pctToNextLevel,
      xpToNextTier: progress.xpToNextTier,
    },
    season,
    perks,
    seasonFrames: earnedSeasonFrames(events),
  });
});

/**
 * GET /api/rewards/seasons/:key/recap — one finished season, scored over its own
 * closed window. `:key` is validated by seasonBounds inside seasonRecap, so a
 * junk key is a 400 rather than a silent empty season.
 */
rewardsRoutes.get("/seasons/:key/recap", async (c) => {
  const userId = c.get("userId");
  const key = c.req.param("key");

  const events = await loadRewardEvents(userId);
  if (!events) return c.json({ error: "Couldn't load your rewards." }, 500);

  const recap = seasonRecap(events, key);
  if (!recap) return c.json({ error: "Unknown season." }, 400);
  return c.json({ recap, isCurrent: key === seasonKeyAt(Date.now()) });
});
