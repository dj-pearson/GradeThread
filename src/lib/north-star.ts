// North Star metric helpers (US-597): "Items Listed Per Week".
//
// Pure, dependency-free date math so it's trivially unit-testable. The FlipDesk
// overview feeds these the `list_date` (= listings.listed_at) of every item to
// derive the weekly goal progress + a "don't break the chain" listing streak.
//
// Weeks are Monday-anchored in the viewer's local timezone — the same mental
// model resellers use ("this week's listings") and what the weekly digest cron
// celebrates.

import { NORTH_STAR_MILESTONES, NORTH_STAR_WEEKLY_GOAL } from "./constants";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00 (local) of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // getDay(): 0=Sun..6=Sat. Shift so Monday is the first day.
  const isoDow = (x.getDay() + 6) % 7; // 0=Mon..6=Sun
  x.setDate(x.getDate() - isoDow);
  return x;
}

/** Stable YYYY-MM-DD key for the Monday that starts `d`'s week. */
export function weekKey(d: Date): string {
  const monday = startOfWeek(d);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const day = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface NorthStarStats {
  /** Items listed in the current (Monday-anchored) week. */
  listedThisWeek: number;
  /** The weekly target. */
  goal: number;
  /** 0..1 progress toward the weekly goal (clamped). */
  progress: number;
  /** Whether the weekly goal has been hit. */
  goalMet: boolean;
  /** Consecutive weeks (ending this or last week) with ≥1 item listed. */
  streakWeeks: number;
  /** All-time count of items that have ever been listed (non-null list date). */
  lifetimeListed: number;
  /** Next lifetime milestone not yet reached, or null once all are passed. */
  nextMilestone: number | null;
  /** Items remaining to reach `nextMilestone` (0 when none left). */
  toNextMilestone: number;
}

/**
 * Compute the North Star surface from each item's list date.
 *
 * @param listDates  one entry per item; null/undefined = never listed
 * @param opts.goal  weekly target (defaults to NORTH_STAR_WEEKLY_GOAL)
 * @param opts.now   reference "now" (defaults to current time — injectable for tests)
 */
export function computeNorthStar(
  listDates: Array<string | Date | null | undefined>,
  opts: { goal?: number; now?: Date } = {},
): NorthStarStats {
  const goal = opts.goal ?? NORTH_STAR_WEEKLY_GOAL;
  const now = opts.now ?? new Date();
  const currentWeekStart = startOfWeek(now).getTime();
  const currentWeekEnd = currentWeekStart + WEEK_MS;

  const weeksWithListing = new Set<string>();
  let listedThisWeek = 0;
  let lifetimeListed = 0;

  for (const raw of listDates) {
    if (raw == null) continue;
    const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
    if (isNaN(t)) continue;
    lifetimeListed++;
    weeksWithListing.add(weekKey(new Date(t)));
    if (t >= currentWeekStart && t < currentWeekEnd) listedThisWeek++;
  }

  // Streak: walk backward a week at a time while each week has ≥1 listing. An
  // empty *current* week doesn't break the chain (the week isn't over yet) — we
  // start counting from last week in that case.
  let streakWeeks = 0;
  let cursor = currentWeekStart;
  if (!weeksWithListing.has(weekKey(new Date(cursor)))) cursor -= WEEK_MS;
  while (weeksWithListing.has(weekKey(new Date(cursor)))) {
    streakWeeks++;
    cursor -= WEEK_MS;
  }

  return assemble({ listedThisWeek, lifetimeListed, streakWeeks, goal });
}

/** One Monday-anchored week and how many items were listed in it. */
export interface WeekBucket {
  /** Monday of the week as YYYY-MM-DD — the same key `weekKey` produces. */
  week: string;
  count: number;
}

/**
 * The same surface, from week buckets instead of one date per item (US-2547).
 *
 * The Overview no longer holds every item in the browser, so the streak walk
 * gets pre-grouped weeks from `flipdesk_overview_metrics`, which buckets on
 * `date_trunc('week', … at time zone <viewer>)` — Monday-anchored in the
 * viewer's zone, which is exactly what `weekKey` computes here.
 *
 * `lifetimeListed` is passed separately rather than summed from the buckets:
 * the aggregate caps the buckets at two years, and summing a capped list would
 * quietly walk an old account's milestone backwards.
 */
export function computeNorthStarFromWeeks(
  weeks: readonly WeekBucket[],
  opts: { goal?: number; now?: Date; lifetimeListed?: number } = {},
): NorthStarStats {
  const goal = opts.goal ?? NORTH_STAR_WEEKLY_GOAL;
  const now = opts.now ?? new Date();

  const counts = new Map<string, number>();
  for (const b of weeks) {
    if (!b || typeof b.week !== "string") continue;
    const n = Number(b.count);
    if (!Number.isFinite(n) || n <= 0) continue;
    counts.set(b.week, (counts.get(b.week) ?? 0) + n);
  }

  const currentWeekStart = startOfWeek(now).getTime();
  const listedThisWeek = counts.get(weekKey(new Date(currentWeekStart))) ?? 0;

  let streakWeeks = 0;
  let cursor = currentWeekStart;
  // An empty CURRENT week doesn't break the chain — the week isn't over yet.
  if (!counts.has(weekKey(new Date(cursor)))) cursor -= WEEK_MS;
  while (counts.has(weekKey(new Date(cursor)))) {
    streakWeeks++;
    cursor -= WEEK_MS;
  }

  const lifetimeListed =
    opts.lifetimeListed ?? [...counts.values()].reduce((a, b) => a + b, 0);

  return assemble({ listedThisWeek, lifetimeListed, streakWeeks, goal });
}

function assemble(input: {
  listedThisWeek: number;
  lifetimeListed: number;
  streakWeeks: number;
  goal: number;
}): NorthStarStats {
  const { listedThisWeek, lifetimeListed, streakWeeks, goal } = input;
  const nextMilestone =
    NORTH_STAR_MILESTONES.find((m) => m > lifetimeListed) ?? null;

  const safeGoal = goal > 0 ? goal : 1;
  return {
    listedThisWeek,
    goal,
    progress: Math.max(0, Math.min(1, listedThisWeek / safeGoal)),
    goalMet: listedThisWeek >= goal,
    streakWeeks,
    lifetimeListed,
    nextMilestone,
    toNextMilestone: nextMilestone == null ? 0 : nextMilestone - lifetimeListed,
  };
}
