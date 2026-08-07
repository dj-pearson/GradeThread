// US-1851: the seller-facing rewards surface — level, season, perks, recaps.
//
// PERSONAL account, not a workspace resource (same call as /api/verified): a
// level and a season track belong to the human who earned them, not to whichever
// tenant they are currently acting inside. So every handler scopes strictly by
// c.get("userId") — never workspaceOwnerId, which would let a workspace member
// read the owner's XP.
//
// Read-only. Nothing here grants, spends or configures anything: XP accrues from
// the reward ledger (US-1849) and the only write this route can cause is the
// idempotent season-recap row when a quarter has rolled over.

import { Hono } from "hono";
import { readRewardState } from "../lib/rewards-engine.ts";
import {
  levelProgress,
  lockedPerks,
  unlockedPerks,
} from "../lib/rewards-levels.ts";
import {
  finalizeCompletedSeason,
  loadSeasonProgress,
  loadSeasonRecaps,
  loadSeasonTimezone,
} from "../lib/rewards-seasons.ts";

type RewardsEnv = { Variables: { userId: string } };

export const rewardsRoutes = new Hono<RewardsEnv>();

// GET /api/rewards/state — everything the rewards screen renders.
rewardsRoutes.get("/state", async (c) => {
  const userId = c.get("userId");
  const nowMs = Date.now();

  try {
    const tz = await loadSeasonTimezone();

    // Roll over the season that just ended, if it hasn't been recapped yet.
    // Lazy + idempotent (UNIQUE(user_id, season_key), 00539) — see
    // finalizeCompletedSeason for why this isn't a quarterly cron. Best-effort:
    // a rollover problem must not take down the whole screen.
    await finalizeCompletedSeason(userId, tz, nowMs);

    const [state, season, recaps] = await Promise.all([
      readRewardState(userId),
      loadSeasonProgress(userId, tz, nowMs),
      loadSeasonRecaps(userId),
    ]);

    // A user with no rewardable action yet has no state row. That is level 0 /
    // Thrifter, not an error — everyone starts on the ladder.
    const progress = levelProgress(state?.xpPeak ?? 0, state?.xpTotal ?? 0);

    return c.json({
      level: {
        level: progress.level,
        xp_total: progress.xpTotal,
        xp_peak: progress.xpPeak,
        tier: progress.tier,
        next_tier: progress.nextTier,
        xp_into_level: progress.xpIntoLevel,
        xp_level_span: progress.xpLevelSpan,
        xp_to_next_level: progress.xpToNextLevel,
        percent_to_next_level: progress.percentToNextLevel,
        xp_to_next_tier: progress.xpToNextTier,
      },
      season: {
        key: season.season.key,
        label: season.season.label,
        starts_at: new Date(season.season.startMs).toISOString(),
        ends_at: season.endsAt,
        elapsed: season.elapsed,
        xp_earned: season.xpEarned,
        goals: season.goals,
        goals_completed: season.goalsCompleted,
        goals_total: season.goalsTotal,
      },
      recaps,
      perks: {
        unlocked: unlockedPerks(progress.level),
        locked: lockedPerks(progress.level),
      },
      season_timezone: tz,
    });
  } catch (err) {
    console.error(
      "[rewards] state load failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Couldn't load your rewards." }, 500);
  }
});
