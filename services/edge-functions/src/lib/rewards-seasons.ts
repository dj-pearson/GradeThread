// US-1851: quarterly SEASONS — the seller-side loyalty primitive, replacing the
// weekly streak.
//
// Why not streaks. Reselling is bursty and seasonal: a picker can spend three
// weeks sourcing estate sales and list nothing, then list forty items in a
// weekend. A calendar streak punishes exactly that rhythm — miss a day, lose the
// thing you built — so it converts a normal working month into a status loss.
// Seasons keep the "there is a clock" motivation without putting identity at
// risk: a season has goals and ends with a recap, and when it ends your LEVEL and
// your medals are untouched. Recency competition belongs on the weekly
// leaderboards (US-1856), not on who you are.
//
// Streaks are not gone — they moved to the only surface with a genuinely daily
// rhythm: the buyer extension + confirmation flow (US-1814), where the grace /
// freeze rules live in src/lib/buyer-rewards-summary.ts.
//
// The pure half (season windows, goal catalog, progress reducer, recap builder)
// has no DB and no env. The DB half derives progress from reputation_events —
// there is no season ledger, because US-1849's one-ledger rule still holds.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { REWARD_XP_CATALOG, type RewardEventType, xpForEvent } from "./rewards-engine.ts";
import { levelForXp } from "./rewards-engine.ts";
import { tierForLevel } from "./rewards-levels.ts";

// ─── Timezone helpers (same shape as newsletter-schedule.ts) ─────────────────

export const SEASON_TIMEZONE_SETTING_KEY = "rewards_season_timezone";
export const DEFAULT_SEASON_TIMEZONE = "America/Chicago";

/** True when `tz` is an IANA zone this runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Coerce an untrusted configured zone. An unknown zone degrades to UTC — a
 *  season boundary must never throw on a config typo. */
export function normalizeSeasonTimezone(raw: unknown): string {
  const tz = typeof raw === "string" ? raw.trim() : "";
  if (!tz) return DEFAULT_SEASON_TIMEZONE;
  return isValidTimeZone(tz) ? tz : "UTC";
}

interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of a UTC instant as observed in `tz`. */
function partsInTz(utcMs: number, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Minutes `tz` is offset from UTC at the given instant (positive east of UTC). */
function tzOffsetMinutes(utcMs: number, tz: string): number {
  const p = partsInTz(utcMs, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - utcMs) / 60_000;
}

/** The UTC instant of local midnight on `year-month-day` in `tz` (DST-aware). */
function zonedMidnightUtcMs(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const off1 = tzOffsetMinutes(guess, tz);
  let utc = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(utc, tz);
  if (off2 !== off1) utc = guess - off2 * 60_000;
  return utc;
}

// ─── Season windows ──────────────────────────────────────────────────────────

export interface SeasonWindow {
  /** Canonical identity, e.g. "2026-Q3". */
  key: string;
  /** Human label, e.g. "Q3 2026". */
  label: string;
  year: number;
  /** 1–4. */
  quarter: number;
  /** Inclusive start instant (ms). */
  startMs: number;
  /** EXCLUSIVE end instant (ms) — the next season's start. */
  endMs: number;
}

const QUARTER_START_MONTH = [1, 4, 7, 10]; // 1-indexed months

function buildSeason(year: number, quarter: number, tz: string): SeasonWindow {
  const q = Math.min(4, Math.max(1, quarter));
  const startMonth = QUARTER_START_MONTH[q - 1];
  const nextYear = q === 4 ? year + 1 : year;
  const nextMonth = q === 4 ? 1 : QUARTER_START_MONTH[q];
  return {
    key: `${year}-Q${q}`,
    label: `Q${q} ${year}`,
    year,
    quarter: q,
    startMs: zonedMidnightUtcMs(year, startMonth, 1, tz),
    endMs: zonedMidnightUtcMs(nextYear, nextMonth, 1, tz),
  };
}

/**
 * The season containing `nowMs`, with its boundaries resolved as real wall-clock
 * quarter starts in `tz`. DST-aware: the boundary is local midnight on the 1st of
 * January / April / July / October, not a naive UTC instant.
 */
export function seasonForInstant(nowMs: number, tz: string): SeasonWindow {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const p = partsInTz(nowMs, zone);
  const quarter = Math.floor((p.month - 1) / 3) + 1;
  return buildSeason(p.year, quarter, zone);
}

/** The season immediately before `season`. */
export function previousSeason(season: SeasonWindow, tz: string): SeasonWindow {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  return season.quarter === 1
    ? buildSeason(season.year - 1, 4, zone)
    : buildSeason(season.year, season.quarter - 1, zone);
}

/** Fraction of the season elapsed at `nowMs`, 0–1. Clamped at both ends. */
export function seasonElapsedFraction(season: SeasonWindow, nowMs: number): number {
  const span = Math.max(1, season.endMs - season.startMs);
  return Math.min(1, Math.max(0, (nowMs - season.startMs) / span));
}

// ─── Season goals ────────────────────────────────────────────────────────────

export interface SeasonGoal {
  key: string;
  name: string;
  description: string;
  /** The reward event type this goal counts, or "xp" for the season XP goal. */
  metric: RewardEventType | "xp";
  /** How many of `metric` complete the goal. */
  target: number;
  /** lucide icon name for the goal row. */
  icon: string;
}

/**
 * The season track. Four action goals plus one XP goal, all achievable inside a
 * quarter by a working reseller and all pointed at acts that compound the moat
 * (the same weighting REWARD_XP_CATALOG uses). Completing them earns the season
 * recap's cosmetic honours — never credits, never a discount.
 *
 * Targets are quarter-sized on purpose: a seller who takes a slow month can
 * still finish the track in the other two.
 */
export const SEASON_GOALS: readonly SeasonGoal[] = [
  {
    key: "full_coverage",
    name: "Photograph it properly",
    description: "Grade 15 items with full photo coverage.",
    metric: "coverage_completed",
    target: 15,
    icon: "Camera",
  },
  {
    key: "spread_the_grade",
    name: "Spread the grade",
    description: "Get 3 grade badges embedded off GradeThread.",
    metric: "badge_embedded",
    target: 3,
    icon: "Globe",
  },
  {
    key: "share_the_work",
    name: "Share the work",
    description: "Share 10 verified grades.",
    metric: "verified_share",
    target: 10,
    icon: "Share2",
  },
  {
    key: "listing_quality",
    name: "Listing quality",
    description: "Fill item specifics on 25 listings.",
    metric: "aspects_filled",
    target: 25,
    icon: "ListChecks",
  },
  {
    // The catch-all, for a seller whose quarter is shaped differently from the
    // four goals above. Its target is set BELOW what sweeping those four pays
    // (15×25 + 3×50 + 10×20 + 25×10 = 975 XP) on purpose: a track where you can
    // finish every task and still fail the summary line is a broken track.
    key: "season_xp",
    name: "Season XP",
    description: "Earn 900 XP this season.",
    metric: "xp",
    target: 900,
    icon: "Zap",
  },
];

export interface SeasonGoalProgress extends SeasonGoal {
  current: number;
  complete: boolean;
  /** 0–100. */
  percent: number;
}

export interface SeasonEventInput {
  eventType: RewardEventType;
  occurredAt: string; // ISO
  verified: boolean;
  paid?: boolean;
}

export interface SeasonProgress {
  season: SeasonWindow;
  /** XP earned inside the season window. Lifetime XP is unaffected by rollover. */
  xpEarned: number;
  goals: SeasonGoalProgress[];
  goalsCompleted: number;
  goalsTotal: number;
  /** 0–1, how far through the season's calendar we are. */
  elapsed: number;
  /** ISO of the season's end — what the UI counts down to. */
  endsAt: string;
}

/**
 * Reduce a user's reward events to season progress. Pure and deterministic.
 *
 * Only events INSIDE the window count, and only ones that actually scored XP —
 * an unverified event, or an unpaid grading-spend event, earns nothing toward a
 * season for exactly the reasons it earns no XP (US-1849 AC4). That keeps the
 * season track un-farmable by the same construction rather than a second one.
 */
export function computeSeasonProgress(
  events: SeasonEventInput[],
  season: SeasonWindow,
  nowMs: number,
): SeasonProgress {
  const counts = new Map<string, number>();
  let xpEarned = 0;

  for (const ev of events) {
    const t = Date.parse(ev.occurredAt);
    if (!Number.isFinite(t) || t < season.startMs || t >= season.endMs) continue;
    const xp = xpForEvent(ev.eventType, { paid: ev.paid, verified: ev.verified });
    if (xp <= 0) continue;
    xpEarned += xp;
    counts.set(ev.eventType, (counts.get(ev.eventType) ?? 0) + 1);
  }

  const goals: SeasonGoalProgress[] = SEASON_GOALS.map((g) => {
    const current = g.metric === "xp" ? xpEarned : counts.get(g.metric) ?? 0;
    const target = Math.max(1, g.target);
    return {
      ...g,
      current,
      complete: current >= target,
      percent: Math.min(100, Math.round((current / target) * 100)),
    };
  });

  return {
    season,
    xpEarned,
    goals,
    goalsCompleted: goals.filter((g) => g.complete).length,
    goalsTotal: goals.length,
    elapsed: seasonElapsedFraction(season, nowMs),
    endsAt: new Date(season.endMs).toISOString(),
  };
}

// ─── Season recap ────────────────────────────────────────────────────────────

export interface SeasonRecap {
  season_key: string;
  season_label: string;
  season_started_at: string;
  season_ended_at: string;
  xp_earned: number;
  goals_completed: number;
  goals_total: number;
  level_at_end: number;
  tier_at_end: string;
  highlights: {
    goals: Array<{ key: string; name: string; current: number; target: number; complete: boolean }>;
    /** Cosmetic honours awarded for the season — never anything of real value. */
    honours: string[];
  };
}

/**
 * Freeze a completed season into its recap row shape. Pure.
 *
 * The honours are the ONLY thing a season "pays". They are strings the recap
 * card renders: no credits, no discounts, no capability. A season that resets
 * must reset cleanly, and a reset that clawed back something valuable would not
 * be clean.
 */
export function buildSeasonRecap(
  progress: SeasonProgress,
  levelAtEnd: number,
): SeasonRecap {
  const honours: string[] = [];
  if (progress.goalsCompleted === progress.goalsTotal && progress.goalsTotal > 0) {
    honours.push("season_complete");
  } else if (progress.goalsCompleted >= 3) {
    honours.push("season_strong");
  } else if (progress.goalsCompleted >= 1) {
    honours.push("season_started");
  }
  if (progress.xpEarned >= 2500) honours.push("season_high_xp");

  return {
    season_key: progress.season.key,
    season_label: progress.season.label,
    season_started_at: new Date(progress.season.startMs).toISOString(),
    season_ended_at: new Date(progress.season.endMs).toISOString(),
    xp_earned: progress.xpEarned,
    goals_completed: progress.goalsCompleted,
    goals_total: progress.goalsTotal,
    level_at_end: levelAtEnd,
    tier_at_end: tierForLevel(levelAtEnd).key,
    highlights: {
      goals: progress.goals.map((g) => ({
        key: g.key,
        name: g.name,
        current: g.current,
        target: g.target,
        complete: g.complete,
      })),
      honours,
    },
  };
}

// ─── DB half (service-role; every query scoped by user_id — US-268) ──────────

/** The configured season boundary zone. Falls back to the default on any error. */
export async function loadSeasonTimezone(): Promise<string> {
  try {
    return normalizeSeasonTimezone(
      await getSetting<unknown>(SEASON_TIMEZONE_SETTING_KEY, DEFAULT_SEASON_TIMEZONE),
    );
  } catch {
    return DEFAULT_SEASON_TIMEZONE;
  }
}

const REWARD_TYPES = new Set<string>(Object.keys(REWARD_XP_CATALOG));

/**
 * Load a user's reward events at or after `sinceMs`. Tenant-scoped by user_id
 * (US-268 — the service-role client bypasses RLS). Returns [] on a DB error, so
 * a season surface degrades to "no progress yet" rather than 500ing.
 */
async function loadRewardEvents(userId: string, sinceMs: number): Promise<SeasonEventInput[]> {
  const { data, error } = await supabaseAdmin
    .from("reputation_events")
    .select("event_type, occurred_at, verified, metadata")
    .eq("user_id", userId)
    .gte("occurred_at", new Date(sinceMs).toISOString())
    .order("occurred_at", { ascending: true });
  if (error) {
    console.error("[rewards-seasons] event load failed:", error.message);
    return [];
  }
  const out: SeasonEventInput[] = [];
  for (const r of data ?? []) {
    const row = r as {
      event_type: string;
      occurred_at: string;
      verified: boolean;
      metadata: Record<string, unknown> | null;
    };
    if (!REWARD_TYPES.has(row.event_type)) continue;
    out.push({
      eventType: row.event_type as RewardEventType,
      occurredAt: row.occurred_at,
      verified: row.verified,
      paid: row.metadata?.paid === true,
    });
  }
  return out;
}

/** Live progress in the CURRENT season for one user. */
export async function loadSeasonProgress(
  userId: string,
  tz: string,
  nowMs: number,
): Promise<SeasonProgress> {
  const season = seasonForInstant(nowMs, tz);
  const events = await loadRewardEvents(userId, season.startMs);
  return computeSeasonProgress(events, season, nowMs);
}

/**
 * Lazily finalize the season that just ended, if it has not been recapped yet.
 *
 * Rollover is LAZY (on read) rather than a cron on purpose: a season boundary
 * touches every user at the same instant, and a quarterly job that has to fan out
 * across the whole user base to write one row each is a worse failure surface
 * than writing that row the next time the user looks at their rewards. It is
 * idempotent either way — UNIQUE (user_id, season_key) on user_season_recaps
 * (00539) means a concurrent second call inserts nothing.
 *
 * Returns the recap when this call created it, null otherwise (already recapped,
 * nothing to recap, or a best-effort failure).
 */
export async function finalizeCompletedSeason(
  userId: string,
  tz: string,
  nowMs: number,
): Promise<SeasonRecap | null> {
  try {
    const current = seasonForInstant(nowMs, tz);
    const prev = previousSeason(current, tz);

    const { data: existing } = await supabaseAdmin
      .from("user_season_recaps")
      .select("id")
      .eq("user_id", userId)
      .eq("season_key", prev.key)
      .maybeSingle();
    if (existing) return null;

    const events = await loadRewardEvents(userId, prev.startMs);
    const progress = computeSeasonProgress(events, prev, prev.endMs);
    // Nothing happened last season — don't manufacture an empty recap card.
    if (progress.xpEarned === 0 && progress.goalsCompleted === 0) return null;

    // Level as it stood at season end: the monotonic peak, which by definition
    // cannot have been higher then than it is now.
    const { data: state } = await supabaseAdmin
      .from("user_reward_state")
      .select("xp_peak, xp_total")
      .eq("user_id", userId)
      .maybeSingle();
    const s = state as { xp_peak?: number; xp_total?: number } | null;
    const levelAtEnd = levelForXp(Math.max(s?.xp_peak ?? 0, s?.xp_total ?? 0));

    const recap = buildSeasonRecap(progress, levelAtEnd);
    const { error } = await supabaseAdmin
      .from("user_season_recaps")
      .upsert({ user_id: userId, ...recap } as never, {
        onConflict: "user_id,season_key",
        ignoreDuplicates: true,
      });
    if (error) {
      console.error("[rewards-seasons] recap insert failed:", error.message);
      return null;
    }
    return recap;
  } catch (err) {
    console.error(
      "[rewards-seasons] finalizeCompletedSeason failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** A user's past season recaps, newest first. Scoped by user_id (US-268). */
export async function loadSeasonRecaps(userId: string, limit = 8): Promise<SeasonRecap[]> {
  const { data, error } = await supabaseAdmin
    .from("user_season_recaps")
    .select(
      "season_key, season_label, season_started_at, season_ended_at, xp_earned, goals_completed, goals_total, level_at_end, tier_at_end, highlights",
    )
    .eq("user_id", userId)
    .order("season_ended_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[rewards-seasons] recap load failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as SeasonRecap[];
}
