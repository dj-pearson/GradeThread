// US-1851: the seller-facing rewards surface — level, season, perks, recaps.
//
// PERSONAL account, not a workspace resource (same call as /api/verified): a
// level and a season track belong to the human who earned them, not to whichever
// tenant they are currently acting inside. So every handler scopes strictly by
// c.get("userId") — never workspaceOwnerId, which would let a workspace member
// read the owner's XP.
//
// Nothing here spends or configures anything, and nothing here grants XP: XP
// accrues from the reward ledger (US-1849). The two writes this route can cause
// are the idempotent season-recap row when a quarter has rolled over, and
// US-1854's TRACKED SHARE — a row that records "this seller shared this find"
// and pays nothing at all. The payout for a share happens later, on the click,
// somewhere the sharer does not control (see lib/share-to-earn.ts).

import { Hono } from "hono";
import type { Context } from "hono";
import { readRewardState } from "../lib/rewards-engine.ts";
import { acknowledgeArrival, loadArrival, sweepOnDemand } from "../lib/rewards-pipeline.ts";
import { loadSellerIntegrityStanding } from "../lib/buyer-grade-confirmation.ts";
import {
  isShareTargetType,
  normalizeShareChannel,
  recordShare,
  shareLoopStats,
  visitorFingerprint,
} from "../lib/share-to-earn.ts";
import { clientIp } from "../middleware/rate-limit.ts";
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
import { loadQuestsState } from "../lib/rewards-quests.ts";
import { loadBadgeShelf } from "../lib/rewards-badges.ts";
import { loadMilestoneProgress } from "../lib/rewards-tangible.ts";
import { loadLoyaltyStanding } from "../lib/rewards-loyalty.ts";
import {
  isLeaderboardPeriod,
  LEADERBOARD_METRICS,
  leaderboardIdentity,
  type LeaderboardPeriod,
  leaderboardPath,
  normalizeAlias,
  viewerRank,
} from "../lib/leaderboards.ts";
import { boardWindow, loadBoard, loadCohort } from "../lib/leaderboards-data.ts";
import { supabaseAdmin } from "../lib/supabase.ts";

type RewardsEnv = { Variables: { userId: string } };

export const rewardsRoutes = new Hono<RewardsEnv>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/rewards/state — everything the rewards screen renders.
rewardsRoutes.get("/state", async (c) => {
  const userId = c.get("userId");
  const nowMs = Date.now();

  try {
    const tz = await loadSeasonTimezone();

    // Roll over the season that just ended, if it hasn't been recapped yet.
    // Lazy + idempotent (UNIQUE(user_id, season_key), 00542) — see
    // finalizeCompletedSeason for why this isn't a quarterly cron. Best-effort:
    // a rollover problem must not take down the whole screen.
    await finalizeCompletedSeason(userId, tz, nowMs);

    // US-2972: bring pipeline XP up to date before reading it, so a seller who
    // just finished listing sees that work on this load rather than tomorrow.
    // Throttled to one sweep per SWEEP_THROTTLE_MS and internally best-effort —
    // it returns null when throttled OR when it failed, and either way the
    // screen renders from whatever state is already stored. A sweep problem
    // must not cost the seller their rewards screen.
    await sweepOnDemand(userId, nowMs);

    const [state, season, recaps] = await Promise.all([
      readRewardState(userId),
      loadSeasonProgress(userId, tz, nowMs),
      loadSeasonRecaps(userId),
    ]);

    // A user with no rewardable action yet has no state row. That is level 0 /
    // Thrifter, not an error — everyone starts on the ladder.
    const progress = levelProgress(state?.xpPeak ?? 0, state?.xpTotal ?? 0);

    // US-1857: the badge shelf and the tangible ladder ride along on this read
    // rather than getting endpoints of their own. Both are cheap, both derive
    // from the same XP total the level card shows, and splitting them would let
    // the widget render a level the "next reward" bar disagrees with. Both are
    // internally best-effort, so neither can take the screen down.
    // US-1912 AC1/AC4: the seller's Grade Integrity standing rides this read for
    // the same reason the badge shelf does — it is cheap, it is part of the same
    // "where do I stand" answer, and it is what the US-1857 celebration diff
    // watches for a tier change. Internally best-effort (it degrades to the
    // pre-floor standing), so it cannot take the screen down.
    // US-1914 AC1: tenure rides the same read. It is the one standing on this
    // page that has nothing to do with what the seller did — which is exactly
    // why it must not be a second request that can fail on its own and leave the
    // page implying their history is gone.
    const [badges, milestones, integrity, standing] = await Promise.all([
      loadBadgeShelf(userId),
      loadMilestoneProgress(userId, progress.xpTotal),
      loadSellerIntegrityStanding(userId),
      loadLoyaltyStanding(userId, nowMs),
    ]);

    // US-2973: the one-time arrival moment, decided SERVER-side. The
    // client-side celebration diff cannot carry this: it returns nothing when
    // the previous snapshot is null, that snapshot lives in localStorage, and a
    // seller who has never opened this page is precisely who the backfill is
    // for. Best-effort — a missing celebration must not cost them the screen.
    const arrival = await loadArrival(userId, progress.level, badges?.earned?.length ?? 0);

    return c.json({
      arrival,
      badges,
      milestones,
      integrity,
      loyalty: standing
        ? {
          member_since: standing.memberSince,
          months: standing.months,
          years: standing.years,
          paid_months: standing.paidMonths,
          tier: standing.tier
            ? {
              key: standing.tier.key,
              label: standing.tier.label,
              blurb: standing.tier.blurb,
              rank: standing.tier.rank,
              credit_multiplier: standing.tier.creditMultiplier,
            }
            : null,
          next_tier: standing.nextTier
            ? {
              key: standing.nextTier.key,
              label: standing.nextTier.label,
              blurb: standing.nextTier.blurb,
              rank: standing.nextTier.rank,
              credit_multiplier: standing.nextTier.creditMultiplier,
            }
            : null,
          months_to_next: standing.monthsToNext,
          paid_months_to_next: standing.paidMonthsToNext,
          credit_multiplier: standing.creditMultiplier,
          last_anniversary_year: standing.lastAnniversaryYear,
        }
        : null,
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

// GET /api/rewards/quests — personal quests + live community challenges.
//
// Split from /state rather than folded into it because it is the expensive half:
// a community challenge scans cross-user events for its standings, and the level
// card should not wait on a leaderboard. Same personal scoping as /state — a
// quest belongs to the human, never to the workspace they are acting inside.
//
// This read EVALUATES: progress is recomputed from the ledger and a quest that
// has just been finished is claimed and paid here. That is deliberate and it is
// the season-rollover pattern (finalizeCompletedSeason) — a weekly boundary
// touches every user at one instant, and a cron fanning out across the whole
// user base to write one row each is a worse failure surface than writing it the
// next time they look. Idempotent by claim, so a refresh pays nothing twice.
// POST /api/rewards/share — record a tracked share of a graded find (US-1854).
//
// Pays NOTHING. It writes the row the share loop is measured against and banks
// the sharer's fingerprint so their own click on their own link is recognisable.
// A caller may only record a share of a find THEY own (US-268: ownership is
// resolved server-side from the certificate, never taken from the body), which
// also stops an attacker poisoning another seller's self-click set.
// POST /api/rewards/arrival/ack — the seller dismissed their arrival moment.
//
// Server-side rather than localStorage so the one-time celebration does not
// re-fire on their next device. Monotonic: acknowledgeArrival only ever moves
// the level up, so a stale click from a second tab cannot re-arm it.
rewardsRoutes.post("/arrival/ack", async (c) => {
  const userId = c.get("userId");
  const state = await readRewardState(userId);
  const progress = levelProgress(state?.xpPeak ?? 0, state?.xpTotal ?? 0);
  await acknowledgeArrival(userId, progress.level);
  return c.json({ ok: true, acknowledged_level: progress.level });
});

rewardsRoutes.post("/share", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => null)) as
    | { targetType?: unknown; targetId?: unknown; channel?: unknown }
    | null;

  if (!body || !isShareTargetType(body.targetType) || typeof body.targetId !== "string") {
    return c.json({ error: "A certificate is required." }, 400);
  }
  const channel = normalizeShareChannel(body.channel);
  if (!channel) return c.json({ error: "Unknown share channel." }, 400);

  const sharerHash = await visitorFingerprint(
    clientIp(c as unknown as Context),
    c.req.header("user-agent") ?? null,
  );

  const result = await recordShare({
    userId,
    targetType: body.targetType,
    targetId: body.targetId,
    channel,
    sharerHash,
  });

  if (!result.ok) {
    if (result.reason === "rate_limited") {
      return c.json({ error: "That's a lot of sharing — try again tomorrow." }, 429);
    }
    // not_owner and error both read as "not your certificate" to the caller: a
    // distinguishable 404 would let anyone probe which certificate ids exist.
    return c.json({ error: "Certificate not found." }, 404);
  }
  return c.json({ ok: true });
});

// POST /api/rewards/nudges/:id/click — US-1859 nudge attribution.
//
// The nudge's deep link carries `?nudge=<sendId>`; the rewards screen posts it
// back once on arrival. This is the CLICK half of the measurement — the
// conversion half is scored server-side by the cron, for the holdout arm too, so
// a user who never clicks but comes back still counts.
//
// Tenant-scoped by construction (US-268): the UPDATE carries `.eq("user_id",
// userId)` beside the id, so a guessed send id belonging to someone else stamps
// nothing. The response is the same either way — a distinguishable 404 would let
// anyone probe which sends exist.
rewardsRoutes.post("/nudges/:id/click", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ ok: true });
  try {
    await supabaseAdmin
      .from("reward_nudge_sends")
      .update({ clicked_at: new Date().toISOString() } as never)
      .eq("id", id)
      .eq("user_id", userId)
      .is("clicked_at", null);
  } catch (err) {
    // Attribution is best-effort: a measurement failure must never surface as a
    // broken rewards screen.
    console.error(
      "[rewards] nudge click stamp failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return c.json({ ok: true });
});

// GET /api/rewards/share/:targetType/:targetId — what one find has earned from
// being shared. Owner-scoped by construction: the caller's id IS the scope, so
// handing it someone else's certificate id reports zeros, never their numbers.
rewardsRoutes.get("/share/:targetType/:targetId", async (c) => {
  const userId = c.get("userId");
  const targetType = c.req.param("targetType");
  const targetId = c.req.param("targetId");
  if (!isShareTargetType(targetType) || !targetId) {
    return c.json({ error: "A certificate is required." }, 400);
  }
  try {
    return c.json(await shareLoopStats(userId, targetType, targetId));
  } catch (err) {
    console.error(
      "[rewards] share stats failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Couldn't load your share stats." }, 500);
  }
});

// ── Leaderboards (US-1856) ───────────────────────────────────────────────────
//
// The seller's own view of the public boards: whether they joined, the alias
// they would appear under, and where they currently stand. Personal-scoped like
// everything else on this route — a rank belongs to the human who earned it.
//
// The PUBLIC boards are served anonymously by /api/content/public/leaderboards.json
// and share the same cohort loader and the same ranking function, so the rank
// reported here is the rank the page shows. Nothing is recomputed differently
// for the owner.

const LEADERBOARD_SITE_URL =
  Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com";

/** The users columns the leaderboard identity resolver reads. */
const LEADERBOARD_USER_COLUMNS =
  "leaderboard_opt_in, leaderboard_alias, verified_enabled, verified_handle, verified_display_name, referral_display_name, rewards_display_name";

interface LeaderboardPrefsRow {
  leaderboard_opt_in?: boolean | null;
  leaderboard_alias?: string | null;
  verified_enabled?: boolean | null;
  verified_handle?: string | null;
  verified_display_name?: string | null;
  referral_display_name?: string | null;
  rewards_display_name?: string | null;
}

/**
 * What the alias WOULD resolve to, ignoring the opt-in flag.
 *
 * The settings card has to be able to say "you'd appear as X" BEFORE the user
 * joins — otherwise the only way to find out what gets published is to publish
 * it. `leaderboardIdentity` refuses an opted-out row by design, so the preview
 * asks it the same question with the flag forced on.
 */
function previewIdentity(row: LeaderboardPrefsRow | null) {
  return leaderboardIdentity({ ...(row ?? {}), leaderboard_opt_in: true });
}

// GET /api/rewards/leaderboard — opt-in state + the caller's standing.
rewardsRoutes.get("/leaderboard", async (c) => {
  const userId = c.get("userId");
  const rawPeriod = c.req.query("period");
  const period: LeaderboardPeriod = isLeaderboardPeriod(rawPeriod) ? rawPeriod : "all_time";

  try {
    const { data } = await supabaseAdmin
      .from("users")
      .select(LEADERBOARD_USER_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    const row = data as LeaderboardPrefsRow | null;
    const preview = previewIdentity(row);
    const optIn = row?.leaderboard_opt_in === true;

    // Nothing to rank against until they join — and loading the cohort + four
    // aggregations for someone who cannot appear on any of them is pure waste.
    if (!optIn || !preview) {
      return c.json({
        opt_in: optIn,
        alias: row?.leaderboard_alias ?? null,
        resolved_alias: preview?.alias ?? null,
        handle: preview?.handle ?? null,
        period,
        standings: [],
        board_url: leaderboardPath(),
      });
    }

    const tz = await loadSeasonTimezone();
    const window = boardWindow(period, Date.now(), tz);
    const cohort = await loadCohort();

    const standings = [];
    for (const metric of LEADERBOARD_METRICS) {
      const board = await loadBoard(metric.key, cohort, window, {
        brandSlug: null,
        category: null,
      });
      const mine = viewerRank(board.candidates, LEADERBOARD_SITE_URL, userId);
      standings.push({
        metric: metric.key,
        name: metric.name,
        score_label: metric.scoreLabel,
        secondary_label: metric.secondaryLabel,
        icon: metric.icon,
        path: leaderboardPath(metric.key),
        // null rank = a zero score this window. That is "not on the board yet",
        // never "last" — the UI must not invent a position that doesn't exist.
        rank: mine?.rank ?? null,
        score: mine?.score ?? 0,
        secondary: mine?.secondary ?? 0,
        tied: mine?.tied ?? false,
        of: board.candidates.filter((x) => x.score > 0).length,
      });
    }

    return c.json({
      opt_in: true,
      alias: row?.leaderboard_alias ?? null,
      resolved_alias: preview.alias,
      handle: preview.handle,
      period,
      standings,
      board_url: leaderboardPath(),
    });
  } catch (err) {
    console.error(
      "[rewards] leaderboard state failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Couldn't load your leaderboard standing." }, 500);
  }
});

// PUT /api/rewards/leaderboard — join, leave, or rename.
//
// Scoped to the caller's OWN row (`.eq("id", userId)`), never an id from the
// body — US-268, and the reason this write lives on the edge rather than as a
// client self-update.
rewardsRoutes.put("/leaderboard", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => null)) as
    | { enabled?: unknown; alias?: unknown }
    | null;
  if (!body) return c.json({ error: "Invalid JSON body." }, 400);

  const update: Record<string, unknown> = {};
  let nextAlias: string | null | undefined;
  if (body.alias !== undefined) {
    nextAlias = normalizeAlias(body.alias);
    update.leaderboard_alias = nextAlias;
  }

  if (body.enabled !== undefined) {
    const enabled = body.enabled === true;
    if (enabled) {
      // Joining with no resolvable alias would publish a row with nothing to
      // call it, so refuse rather than fall back to anything identifying.
      const { data } = await supabaseAdmin
        .from("users")
        .select(LEADERBOARD_USER_COLUMNS)
        .eq("id", userId)
        .maybeSingle();
      const merged: LeaderboardPrefsRow = { ...((data as LeaderboardPrefsRow | null) ?? {}) };
      if (nextAlias !== undefined) merged.leaderboard_alias = nextAlias;
      if (!previewIdentity(merged)) {
        return c.json(
          { error: "Add a display name before joining the leaderboards." },
          400,
        );
      }
    }
    update.leaderboard_opt_in = enabled;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "Nothing to update." }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .update(update as never)
    .eq("id", userId)
    .select(LEADERBOARD_USER_COLUMNS)
    .maybeSingle();
  if (error) {
    console.error("[rewards] leaderboard opt-in update failed:", error.message);
    return c.json({ error: "Couldn't update your leaderboard settings." }, 500);
  }
  const row = data as LeaderboardPrefsRow | null;
  const preview = previewIdentity(row);
  return c.json({
    opt_in: row?.leaderboard_opt_in === true,
    alias: row?.leaderboard_alias ?? null,
    resolved_alias: preview?.alias ?? null,
    handle: preview?.handle ?? null,
  });
});

rewardsRoutes.get("/quests", async (c) => {
  const userId = c.get("userId");
  try {
    const tz = await loadSeasonTimezone();
    return c.json(await loadQuestsState(userId, tz, Date.now()));
  } catch (err) {
    console.error(
      "[rewards] quests load failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Couldn't load your quests." }, 500);
  }
});
