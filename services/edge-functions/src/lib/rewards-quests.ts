// US-1852: quests and time-boxed challenges.
//
// A quest is a WINDOW plus a PREDICATE plus a PAYOUT, and this file draws the
// line between what an operator may change and what only a code review may:
//
//   Operator (quest_definitions rows, 00539): which quests are live, how hard
//   they are, when they run, what they pay, and an on/off switch per quest.
//   Reviewer (this file): what "grade 3 items" actually MEANS. A criteria key
//   names a predicate here; an operator picks from the reviewed set. Storing a
//   rule expression in a text column would put an untypecheckable mini-language
//   in the database, and the first bad row would be a silent payout bug.
//
// Progress is DERIVED from reputation_events over the window — there is no
// user_quest_progress table, for the same reason seasons have no season table
// (rewards-seasons.ts): one log, no second source of truth, and no rollover job
// that can half-run at a boundary. A finished quest is provable years later.
//
// The payout is bounded in code even though an operator sets the number, because
// a config typo that pays 500,000 XP is indistinguishable from a compromise.
//
// Pure except for the definition loader — `nowMs` is always injected.

import { xpForEvent, type RewardEventInput, type RewardEventType } from "./rewards-engine.ts";
import { partsInTz, zonedWallToUtcMs } from "./zoned-time.ts";
import { SEASON_TIME_ZONE } from "./rewards-seasons.ts";

/** The most XP a single quest may pay, whatever the row says. */
export const QUEST_XP_MAX = 200;

/** Feature flag gating the whole quest surface. Fail-closed, like tangible. */
export const QUESTS_FLAG_KEY = "rewards_quests";

export type QuestScope = "personal" | "community";
export type QuestWindowKind = "weekly" | "monthly" | "fixed";

/**
 * A criteria key names one countable act. Every key maps to a reward event type
 * the XP catalog already scores, which is what keeps quests inside the existing
 * anti-farming design: an act that earns 0 XP also counts 0 toward a quest.
 */
export const QUEST_CRITERIA: Record<string, { label: string; eventType: RewardEventType }> = {
  grade_items: { label: "Grade items with full photo coverage", eventType: "coverage_completed" },
  share_grades: { label: "Get verified shares of your grades", eventType: "verified_share" },
  embed_badges: { label: "Embed grade badges off GradeThread", eventType: "badge_embedded" },
  fill_aspects: { label: "Complete item details on listings", eventType: "aspects_filled" },
  connect_shops: { label: "Connect marketplace shops", eventType: "marketplace_connected" },
  confirm_arrivals: { label: "Confirm graded arrivals", eventType: "grade_confirmed" },
};

export type QuestCriteriaKey = keyof typeof QUEST_CRITERIA;

/** A row from quest_definitions, in the shape the engine wants. */
export interface QuestDefinition {
  id: string;
  questKey: string;
  title: string;
  description: string;
  criteriaKey: string;
  target: number;
  xpReward: number;
  scope: QuestScope;
  windowKind: QuestWindowKind;
  startsAt: string | null;
  endsAt: string | null;
  enabled: boolean;
  sortOrder: number;
}

/** Clamp an operator-set payout into the reviewed range. */
export function clampQuestXp(xp: number): number {
  if (!Number.isFinite(xp)) return 0;
  return Math.min(QUEST_XP_MAX, Math.max(0, Math.floor(xp)));
}

// ── Windows ──────────────────────────────────────────────────────────────────

export interface QuestWindow {
  /** Stable id for THIS run of the quest — the dedupe reference. */
  instanceKey: string;
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
}

/** Midnight, in the anchor zone, of the day `nowMs` falls in. */
function zonedMidnight(nowMs: number, tz: string): number {
  const p = partsInTz(nowMs, tz);
  return zonedWallToUtcMs(p.year, p.month, p.day, 0, tz);
}

const DAY_MS = 86_400_000;

/**
 * The window a quest is running in right now, or null when it is not running.
 *
 * A repeating quest's window is derived from the clock rather than from a stored
 * cursor, so "this week" means the same seven days for every user and there is
 * no per-user reset to schedule. The instance key carries the window's start, so
 * next week's run is a DIFFERENT dedupe reference and pays again — which is the
 * whole point of a repeating quest.
 */
export function questWindow(
  def: QuestDefinition,
  nowMs: number,
  tz: string = SEASON_TIME_ZONE,
): QuestWindow | null {
  const bounded = (startMs: number, endMs: number): QuestWindow => ({
    instanceKey: `${def.questKey}:${new Date(startMs).toISOString().slice(0, 10)}`,
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  });

  if (def.windowKind === "fixed") {
    const startMs = def.startsAt ? Date.parse(def.startsAt) : Number.NaN;
    const endMs = def.endsAt ? Date.parse(def.endsAt) : Number.NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    if (nowMs < startMs || nowMs >= endMs) return null;
    return bounded(startMs, endMs);
  }

  // A repeating quest may still carry an operator window that switches it on and
  // off; outside it, the quest simply is not running.
  if (def.startsAt && nowMs < Date.parse(def.startsAt)) return null;
  if (def.endsAt && nowMs >= Date.parse(def.endsAt)) return null;

  const p = partsInTz(nowMs, tz);
  if (def.windowKind === "monthly") {
    const startMs = zonedWallToUtcMs(p.year, p.month, 1, 0, tz);
    const nextYear = p.month === 12 ? p.year + 1 : p.year;
    const nextMonth = p.month === 12 ? 1 : p.month + 1;
    return bounded(startMs, zonedWallToUtcMs(nextYear, nextMonth, 1, 0, tz));
  }

  // Weekly, Monday-anchored — the same week the North Star listing goal uses, so
  // a seller is never asked to hold two different ideas of "this week".
  const midnight = zonedMidnight(nowMs, tz);
  const isoDow = (new Date(midnight).getUTCDay() + 6) % 7; // 0=Mon
  // Re-derive through the zoned converter rather than subtracting 7 days of
  // milliseconds: a DST change inside the week would put the Monday an hour off.
  const mondayParts = partsInTz(midnight - isoDow * DAY_MS, tz);
  const startMs = zonedWallToUtcMs(mondayParts.year, mondayParts.month, mondayParts.day, 0, tz);
  const endParts = partsInTz(startMs + 7 * DAY_MS + 12 * 3_600_000, tz);
  const endMs = zonedWallToUtcMs(endParts.year, endParts.month, endParts.day, 0, tz);
  return bounded(startMs, endMs);
}

// ── Progress ─────────────────────────────────────────────────────────────────

export interface QuestProgress {
  questKey: string;
  title: string;
  description: string;
  scope: QuestScope;
  criteriaKey: string;
  criteriaLabel: string;
  target: number;
  count: number;
  complete: boolean;
  /** 0–100, whole numbers. */
  pct: number;
  xpReward: number;
  instanceKey: string;
  endsAt: string;
  /** Whole days left in the window, floored. */
  daysRemaining: number;
}

/**
 * Score one quest against a user's own reward events. Returns null when the
 * quest is not running, is switched off, or names a criteria key this build does
 * not know — an unknown key is IGNORED rather than thrown, so rolling the code
 * back below a quest's criteria cannot take the whole surface down.
 */
export function computeQuestProgress(
  def: QuestDefinition,
  events: RewardEventInput[],
  nowMs: number,
  tz: string = SEASON_TIME_ZONE,
): QuestProgress | null {
  if (!def.enabled) return null;
  const criteria = QUEST_CRITERIA[def.criteriaKey];
  if (!criteria) return null;
  const win = questWindow(def, nowMs, tz);
  if (!win) return null;

  let count = 0;
  for (const ev of events) {
    if (ev.eventType !== criteria.eventType) continue;
    const t = Date.parse(ev.occurredAt);
    if (!Number.isFinite(t) || t < win.startMs || t >= win.endMs) continue;
    // Only an act that actually earned XP counts. An unpaid or unverified event
    // scores 0 in the ledger, and letting it tick a quest would reopen the
    // farming route the paid gate closed.
    if (xpForEvent(ev.eventType, { paid: ev.paid, verified: ev.verified }) <= 0) continue;
    count++;
  }

  const target = Math.max(1, Math.floor(def.target));
  return {
    questKey: def.questKey,
    title: def.title,
    description: def.description,
    scope: def.scope,
    criteriaKey: def.criteriaKey,
    criteriaLabel: criteria.label,
    target,
    count,
    complete: count >= target,
    pct: Math.min(100, Math.round((count / target) * 100)),
    xpReward: clampQuestXp(def.xpReward),
    instanceKey: win.instanceKey,
    endsAt: win.endIso,
    daysRemaining: Math.max(0, Math.floor((win.endMs - nowMs) / DAY_MS)),
  };
}

/** Score every definition, dropping the ones not currently running. */
export function computeQuestBoard(
  defs: QuestDefinition[],
  events: RewardEventInput[],
  nowMs: number,
  tz: string = SEASON_TIME_ZONE,
): QuestProgress[] {
  return defs
    .map((d) => computeQuestProgress(d, events, nowMs, tz))
    .filter((p): p is QuestProgress => p !== null);
}

/** Row → engine shape. Tolerates the nulls a partially-filled row can carry. */
export function questDefinitionFromRow(row: Record<string, unknown>): QuestDefinition {
  return {
    id: String(row.id ?? ""),
    questKey: String(row.quest_key ?? ""),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    criteriaKey: String(row.criteria_key ?? ""),
    target: Number(row.target ?? 0),
    xpReward: Number(row.xp_reward ?? 0),
    scope: row.scope === "community" ? "community" : "personal",
    windowKind: row.window_kind === "monthly"
      ? "monthly"
      : row.window_kind === "fixed"
      ? "fixed"
      : "weekly",
    startsAt: typeof row.starts_at === "string" ? row.starts_at : null,
    endsAt: typeof row.ends_at === "string" ? row.ends_at : null,
    enabled: row.enabled === true,
    sortOrder: Number(row.sort_order ?? 0),
  };
}
