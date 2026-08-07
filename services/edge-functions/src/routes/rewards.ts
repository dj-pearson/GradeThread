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
  computeRewardState,
  loadRewardEvents,
  monotonicLevel,
} from "../lib/rewards-engine.ts";
import { levelProgress, perksForLevel } from "../lib/rewards-levels.ts";
import { computeQuestBoard } from "../lib/rewards-quests.ts";
import { loadQuestDefinitions, questsEnabled } from "../lib/rewards-quests-award.ts";
import {
  computeSeasonProgress,
  earnedSeasonFrames,
  seasonRecap,
  seasonKeyAt,
} from "../lib/rewards-seasons.ts";
import { supabaseAdmin } from "../lib/supabase.ts";

type RewardsEnv = { Variables: { userId: string } };

export const rewardsRoutes = new Hono<RewardsEnv>();

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

/**
 * GET /api/rewards/quests — the caller's live quest board (US-1852).
 *
 * Read-only. Completion is PAID on the pass that advances a quest (grantReward →
 * evaluateQuests), never here, so refreshing this page can neither award nor
 * re-award anything. A switched-off surface returns an empty board rather than a
 * 404, because "no quests running" and "quests disabled" look the same to a user
 * and should not need two client states.
 */
rewardsRoutes.get("/quests", async (c) => {
  const userId = c.get("userId");
  if (!(await questsEnabled())) return c.json({ enabled: false, quests: [] });

  const events = await loadRewardEvents(userId);
  if (!events) return c.json({ error: "Couldn't load your rewards." }, 500);

  const defs = await loadQuestDefinitions();
  return c.json({ enabled: true, quests: computeQuestBoard(defs, events, Date.now()) });
});
