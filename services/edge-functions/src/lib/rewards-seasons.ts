// US-1851: quarterly SEASONS — the seller-side recency track, replacing streaks.
//
// WHY seasons and not streaks. A calendar streak punishes a gap, and reselling
// is bursty by nature: a picker who sources hard for three weekends and then
// takes a month off is a good seller, not a lapsed one. A daily streak would
// tell them otherwise every time they opened the app, and the only way to
// protect it is to log in and do something small — which is engagement theatre,
// not contribution. So seller identity is built from LEVEL (permanent, US-1851
// rule 1) and seller recency from a SEASON (a 13-week track that resets for
// everybody at once). Head-to-head recency competition lives on the weekly
// leaderboards (US-1856), where losing costs you nothing you had.
//
// WHY nothing is stored. A season's progress is a WINDOW over the same
// append-only reputation_events log everything else reads — so it "resets" by
// the window moving, with no rollover job, no wipe, and no state that can be
// half-migrated at a boundary. A past season stays reconstructable forever,
// which is also how an earned season frame survives its season.
//
// Pure — no DB, no env. `nowMs` is always injected.

import { xpForEvent, type RewardEventInput, type RewardEventType } from "./rewards-engine.ts";
import { partsInTz, zonedWallToUtcMs } from "./zoned-time.ts";

/**
 * Seasons are GLOBAL, not per-seller: everyone's Q3 starts at the same instant,
 * or a leaderboard spanning a season would compare different windows. US Eastern
 * is the anchor because it is the zone the product's own quarters are announced
 * in; the point is that ONE zone is used, not which.
 */
export const SEASON_TIME_ZONE = "America/New_York";

/** How many of a season's goals must be completed to earn its frame. */
export const SEASON_FRAME_GOAL_THRESHOLD = 2;

const QUARTER_LABELS = ["Winter", "Spring", "Summer", "Fall"] as const;

export interface SeasonGoal {
  key: string;
  label: string;
  eventType: RewardEventType;
  target: number;
}

/**
 * A season's goal set. Deliberately drawn from the SAME event types the XP
 * catalog already scores — a season adds a fresh frame around existing work, it
 * does not invent errands. Targets are sized so a working reseller clears two
 * of four in a quarter without changing what they do.
 */
export const SEASON_GOALS: readonly SeasonGoal[] = [
  {
    key: "full_coverage",
    label: "Grade 25 items with full photo coverage",
    eventType: "coverage_completed",
    target: 25,
  },
  {
    key: "shares",
    label: "Earn 10 verified shares of your grades",
    eventType: "verified_share",
    target: 10,
  },
  {
    key: "embeds",
    label: "Get your grade badge onto 3 listings off GradeThread",
    eventType: "badge_embedded",
    target: 3,
  },
  {
    key: "aspects",
    label: "Complete the item details on 20 listings",
    eventType: "aspects_filled",
    target: 20,
  },
] as const;

// ── Season identity ──────────────────────────────────────────────────────────

/** The season key ("2026-Q3") an instant falls in. */
export function seasonKeyAt(nowMs: number, tz: string = SEASON_TIME_ZONE): string {
  const p = partsInTz(nowMs, tz);
  return `${p.year}-Q${Math.floor((p.month - 1) / 3) + 1}`;
}

interface ParsedSeason {
  year: number;
  quarter: number; // 1–4
}

function parseSeasonKey(key: string): ParsedSeason | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key.trim());
  if (!m) return null;
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

export interface SeasonBounds {
  key: string;
  /** Human label, e.g. "Summer 2026". */
  label: string;
  /** First instant of the season (inclusive). */
  startMs: number;
  /** First instant of the NEXT season (exclusive) — the season's end. */
  endMs: number;
  startIso: string;
  endIso: string;
}

/**
 * The half-open [start, end) window of a season, as UTC instants. Half-open on
 * purpose: an event at the exact rollover belongs to the new season and to
 * exactly one season, so the four quarters partition the year with no event
 * counted twice and none lost.
 */
export function seasonBounds(key: string, tz: string = SEASON_TIME_ZONE): SeasonBounds | null {
  const parsed = parseSeasonKey(key);
  if (!parsed) return null;
  const { year, quarter } = parsed;
  const startMonth = (quarter - 1) * 3 + 1;
  const startMs = zonedWallToUtcMs(year, startMonth, 1, 0, tz);
  const endYear = quarter === 4 ? year + 1 : year;
  const endMonth = quarter === 4 ? 1 : startMonth + 3;
  const endMs = zonedWallToUtcMs(endYear, endMonth, 1, 0, tz);
  return {
    key: `${year}-Q${quarter}`,
    label: `${QUARTER_LABELS[quarter - 1]} ${year}`,
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/** The season an instant is in, already resolved to bounds. */
export function currentSeason(nowMs: number, tz: string = SEASON_TIME_ZONE): SeasonBounds {
  // seasonKeyAt always produces a parseable key, so the bang is safe.
  return seasonBounds(seasonKeyAt(nowMs, tz), tz)!;
}

// ── Progress ─────────────────────────────────────────────────────────────────

export interface SeasonGoalProgress {
  key: string;
  label: string;
  target: number;
  count: number;
  complete: boolean;
  /** 0–100, whole numbers. */
  pct: number;
}

export interface SeasonProgress {
  seasonKey: string;
  label: string;
  startIso: string;
  endIso: string;
  /** Whole days left, floored, 0 once the season has ended. */
  daysRemaining: number;
  /** XP earned INSIDE this season (the lifetime total is untouched by rollover). */
  xpThisSeason: number;
  goals: SeasonGoalProgress[];
  goalsCompleted: number;
  /** True once enough goals are done that the season's frame is earned. */
  frameEarned: boolean;
  /** The frame key this season awards, e.g. "season:2026-Q3". */
  frameKey: string;
}

const DAY_MS = 86_400_000;

/** The share-card frame key a season awards. Namespaced so it can never collide
 *  with a LEVEL frame from rewards-levels.ts. */
export function seasonFrameKey(seasonKey: string): string {
  return `season:${seasonKey}`;
}

/**
 * Score one season's window. Only events that actually EARNED XP count toward a
 * goal — an unverified or unpaid event scores 0 in the ledger, and letting it
 * tick a season goal would reopen exactly the farming route the paid gate closed.
 */
export function computeSeasonProgress(
  events: RewardEventInput[],
  nowMs: number,
  tz: string = SEASON_TIME_ZONE,
  seasonKey?: string,
): SeasonProgress {
  const bounds = (seasonKey ? seasonBounds(seasonKey, tz) : null) ?? currentSeason(nowMs, tz);

  let xpThisSeason = 0;
  const counts = new Map<RewardEventType, number>();
  for (const ev of events) {
    const t = Date.parse(ev.occurredAt);
    if (!Number.isFinite(t) || t < bounds.startMs || t >= bounds.endMs) continue;
    const xp = xpForEvent(ev.eventType, { paid: ev.paid, verified: ev.verified });
    if (xp <= 0) continue;
    xpThisSeason += xp;
    counts.set(ev.eventType, (counts.get(ev.eventType) ?? 0) + 1);
  }

  const goals: SeasonGoalProgress[] = SEASON_GOALS.map((g) => {
    const count = counts.get(g.eventType) ?? 0;
    return {
      key: g.key,
      label: g.label,
      target: g.target,
      count,
      complete: count >= g.target,
      pct: Math.min(100, Math.round((count / g.target) * 100)),
    };
  });
  const goalsCompleted = goals.filter((g) => g.complete).length;

  return {
    seasonKey: bounds.key,
    label: bounds.label,
    startIso: bounds.startIso,
    endIso: bounds.endIso,
    daysRemaining: Math.max(0, Math.floor((bounds.endMs - nowMs) / DAY_MS)),
    xpThisSeason,
    goals,
    goalsCompleted,
    frameEarned: goalsCompleted >= SEASON_FRAME_GOAL_THRESHOLD,
    frameKey: seasonFrameKey(bounds.key),
  };
}

export interface SeasonRecap {
  seasonKey: string;
  label: string;
  xpEarned: number;
  goalsCompleted: number;
  goalsTotal: number;
  frameEarned: boolean;
  frameKey: string;
  /** The goal that came closest without finishing — the "so close" line. */
  nearMiss: SeasonGoalProgress | null;
}

/**
 * The season-end recap. Reads exactly like the live progress because it IS the
 * same computation over a closed window — there is no separate end-of-season
 * snapshot to drift from what the seller was shown all quarter.
 */
export function seasonRecap(
  events: RewardEventInput[],
  seasonKey: string,
  tz: string = SEASON_TIME_ZONE,
): SeasonRecap | null {
  const bounds = seasonBounds(seasonKey, tz);
  if (!bounds) return null;
  // Score at the season's own end so daysRemaining/goal counts describe the
  // finished quarter rather than "now".
  const p = computeSeasonProgress(events, bounds.endMs, tz, bounds.key);
  const unfinished = p.goals.filter((g) => !g.complete).sort((a, b) => b.pct - a.pct);
  return {
    seasonKey: p.seasonKey,
    label: p.label,
    xpEarned: p.xpThisSeason,
    goalsCompleted: p.goalsCompleted,
    goalsTotal: p.goals.length,
    frameEarned: p.frameEarned,
    frameKey: p.frameKey,
    nearMiss: unfinished.length > 0 && unfinished[0]!.count > 0 ? unfinished[0]! : null,
  };
}

/**
 * Every season frame this user has earned, oldest first. Derived rather than
 * stored: walking the seasons the log actually spans means a frame earned in
 * 2026-Q1 is still provable in 2030 without a badge row to migrate. Bounded by
 * the log's own span, and a user with no events gets an empty list.
 */
export function earnedSeasonFrames(
  events: RewardEventInput[],
  tz: string = SEASON_TIME_ZONE,
): string[] {
  const stamps = events
    .map((e) => Date.parse(e.occurredAt))
    .filter((t) => Number.isFinite(t));
  if (stamps.length === 0) return [];

  const earned: string[] = [];
  const last = Math.max(...stamps);
  let cursor = currentSeason(Math.min(...stamps), tz);
  // Walk forward one season at a time. `endMs` is the next season's first
  // instant, so stepping to it lands exactly on the following quarter.
  while (cursor.startMs <= last) {
    const p = computeSeasonProgress(events, cursor.endMs, tz, cursor.key);
    if (p.frameEarned) earned.push(p.frameKey);
    cursor = currentSeason(cursor.endMs, tz);
  }
  return earned;
}
