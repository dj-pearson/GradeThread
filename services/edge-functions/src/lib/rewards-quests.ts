// US-1852: QUESTS — repeating personal goals and time-boxed community
// challenges.
//
// Where this sits. Levels are identity and never decrease (US-1851); seasons are
// the quarter-long clock; quests are the WEEK. They are the short loop: a small,
// always-fresh reason to finish one more item properly and share it.
//
// Three rules carried over from the rest of the reward system, because they are
// what keep it un-farmable:
//
//   1. ONE LEDGER. Quest progress is DERIVED live from reputation_events, the
//      same log XP and seasons read (US-1849). user_quest_progress stores only a
//      snapshot and the completion claim, so it can be dropped and rebuilt.
//   2. THE SAME XP GATE. An event that scores 0 XP (unverified, or an unpaid
//      grading-spend act) counts 0 toward a quest. The quest track is un-farmable
//      by the same construction as the season track, not a second one.
//   3. IDEMPOTENT BY CLAIM. UNIQUE (user_id, quest_id, period_key) means a
//      repeating quest pays once per WINDOW, and the reputation_events dedupe key
//      (`quest:<key>:<period>`) means it pays once even if the claim is replayed.
//
// Evaluation is LAZY — it runs when the user reads their rewards, exactly like
// the season rollover (finalizeCompletedSeason) and for the same reason: a
// weekly boundary touches every user at one instant, and a cron that fans out
// across the whole user base to write one row each is a worse failure surface
// than writing that row the next time they look.
//
// The pure half (windows, period keys, progress, standings) has no DB and no
// env, so the whole policy is unit-testable.

import { supabaseAdmin } from "./supabase.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import { notifyUser } from "./notify.ts";
import {
  clampQuestXp,
  frozenXpAward,
  grantReward,
  type RewardEventType,
  REWARD_XP_CATALOG,
  xpForEvent,
} from "./rewards-engine.ts";
import { partsInTz, zonedMidnightUtcMs } from "./rewards-seasons.ts";

export const QUESTS_FLAG_KEY = "rewards_quests";

export type QuestType = "personal" | "community";
export type QuestCadence = "weekly" | "monthly" | "fixed";
/** A quest counts one reward event type, or raw XP. */
export type QuestMetric = RewardEventType | "xp";

export interface QuestDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  quest_type: QuestType;
  metric: QuestMetric;
  target: number;
  cadence: QuestCadence;
  starts_at: string | null;
  ends_at: string | null;
  xp_reward: number;
  icon: string;
  enabled: boolean;
  sort_order: number;
}

/**
 * Metrics an admin may point a quest at. `quest_completed` is deliberately
 * ABSENT: a quest counting quest completions would let two cheap quests
 * bootstrap each other into an XP loop. Mirrors the CHECK in migration 00540 —
 * the DB is the real guard, this is the one that gives a readable 400.
 */
export const QUEST_METRICS: readonly QuestMetric[] = [
  ...(Object.keys(REWARD_XP_CATALOG) as RewardEventType[]).filter(
    // `quest_completed`: a quest counting quest completions bootstraps an XP
    // loop. `share_milestone` (US-1854): its award is already the escalating
    // reach ladder, so a quest counting it pays a second, uncapped time for the
    // same viral event — and the 00540 CHECK does not allow it either, so
    // offering it would be a validator that passes and an insert that fails.
    // `integrity_tier_up` (US-1912): a tier is a standing, not an action — it
    // can move at most four times in a seller's life and it is decided by
    // BUYERS, so a quest counting it is a quest nobody can work toward. It is
    // also absent from the 00540 CHECK, so offering it would be a validator that
    // passes and an insert that 23514s.
    (t) =>
      t !== "quest_completed" && t !== "share_milestone" &&
      t !== "integrity_tier_up",
  ),
  "xp",
];

export function isQuestMetric(value: unknown): value is QuestMetric {
  return typeof value === "string" && (QUEST_METRICS as string[]).includes(value);
}

// ─── Windows ────────────────────────────────────────────────────────────────

export interface QuestWindow {
  /** Identity of this INSTANCE of the quest: 'w2026-08-03', 'm2026-08', 'fixed'. */
  periodKey: string;
  /** Inclusive start instant (ms). */
  startMs: number;
  /** EXCLUSIVE end instant (ms). */
  endMs: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The Monday-anchored week containing the local date `y-m-d`.
 *
 * The period key is the MONDAY'S DATE rather than a week NUMBER on purpose:
 * ISO-week numbering has genuinely surprising year boundaries (30 Dec 2025 is
 * week 1 of 2026), and a key that is wrong once a year is a key that pays a
 * quest twice or not at all once a year. A date has no such rules.
 */
function weekWindow(y: number, m: number, d: number, tz: string): QuestWindow {
  const dayMs = 86_400_000;
  const asUtc = Date.UTC(y, m - 1, d);
  // getUTCDay: 0=Sunday. Shift so Monday is 0.
  const offsetDays = (new Date(asUtc).getUTCDay() + 6) % 7;
  const monday = new Date(asUtc - offsetDays * dayMs);
  const nextMonday = new Date(asUtc + (7 - offsetDays) * dayMs);
  const mY = monday.getUTCFullYear();
  const mM = monday.getUTCMonth() + 1;
  const mD = monday.getUTCDate();
  return {
    periodKey: `w${mY}-${pad2(mM)}-${pad2(mD)}`,
    startMs: zonedMidnightUtcMs(mY, mM, mD, tz),
    endMs: zonedMidnightUtcMs(
      nextMonday.getUTCFullYear(),
      nextMonday.getUTCMonth() + 1,
      nextMonday.getUTCDate(),
      tz,
    ),
  };
}

/**
 * The window a quest is running in at `nowMs`, or null when it is not running
 * (a fixed quest whose dates haven't started or have passed).
 *
 * Weekly/monthly boundaries resolve in the SHARED season timezone, so "this
 * week" means the same thing on the quests card as it does on the season track.
 */
export function questWindow(
  quest: Pick<QuestDefinition, "cadence" | "starts_at" | "ends_at">,
  nowMs: number,
  tz: string,
): QuestWindow | null {
  if (quest.cadence === "fixed") {
    const start = Date.parse(quest.starts_at ?? "");
    const end = Date.parse(quest.ends_at ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (nowMs < start || nowMs >= end) return null;
    return { periodKey: "fixed", startMs: start, endMs: end };
  }

  const p = partsInTz(nowMs, tz);
  if (quest.cadence === "monthly") {
    const nextY = p.month === 12 ? p.year + 1 : p.year;
    const nextM = p.month === 12 ? 1 : p.month + 1;
    return {
      periodKey: `m${p.year}-${pad2(p.month)}`,
      startMs: zonedMidnightUtcMs(p.year, p.month, 1, tz),
      endMs: zonedMidnightUtcMs(nextY, nextM, 1, tz),
    };
  }
  return weekWindow(p.year, p.month, p.day, tz);
}

// ─── Progress ───────────────────────────────────────────────────────────────

export interface QuestEventInput {
  eventType: RewardEventType;
  occurredAt: string; // ISO
  verified: boolean;
  paid?: boolean;
  xpAward?: number;
}

export interface QuestProgress {
  current: number;
  target: number;
  complete: boolean;
  /** 0–100. */
  percent: number;
}

/**
 * Count a user's qualifying events inside the window. Pure.
 *
 * Only events that actually SCORED XP count: an unverified event, or an unpaid
 * grading-spend event, moves no quest. That is the same gate US-1849 AC4 put on
 * XP itself, applied here rather than reinvented — so there is exactly one
 * definition of "this action counted".
 */
export function computeQuestProgress(
  events: QuestEventInput[],
  quest: Pick<QuestDefinition, "metric" | "target">,
  window: QuestWindow,
): QuestProgress {
  let current = 0;
  for (const ev of events) {
    const t = Date.parse(ev.occurredAt);
    if (!Number.isFinite(t) || t < window.startMs || t >= window.endMs) continue;
    const xp = xpForEvent(ev.eventType, {
      paid: ev.paid,
      verified: ev.verified,
      xpAward: ev.xpAward,
    });
    if (xp <= 0) continue;
    if (quest.metric === "xp") current += xp;
    else if (ev.eventType === quest.metric) current += 1;
  }
  const target = Math.max(1, quest.target);
  return {
    current,
    target,
    complete: current >= target,
    percent: Math.min(100, Math.round((current / target) * 100)),
  };
}

// ─── Standings (the leaderboard half of a community challenge) ──────────────

export interface StandingInput {
  userId: string;
  handle: string | null;
  displayName: string | null;
  score: number;
}

export interface Standing {
  rank: number;
  handle: string;
  display_name: string;
  score: number;
  is_you: boolean;
}

/**
 * Rank challenge participants. Pure.
 *
 * ONLY sellers with a public GradeThread Verified profile are listed — a
 * challenge board is a public surface, and being counted in a challenge is not
 * consent to be named on one. Everyone's events still count toward their OWN
 * score; publicity decides whether the name is shown, and therefore whether a
 * rank among the shown names exists for them.
 *
 * Ties break on handle so the order is stable between reads rather than
 * whatever the query happened to return.
 */
export function rankStandings(
  rows: StandingInput[],
  viewerId: string | null,
  limit = 10,
): { standings: Standing[]; viewerRank: number | null } {
  const ranked = rows
    .filter((r) => r.score > 0 && !!r.handle)
    .sort((a, b) => b.score - a.score || (a.handle ?? "").localeCompare(b.handle ?? ""))
    .map((r, i) => ({
      rank: i + 1,
      handle: r.handle!,
      display_name: r.displayName ?? r.handle!,
      score: r.score,
      is_you: !!viewerId && r.userId === viewerId,
    }));
  const mine = ranked.find((r) => r.is_you);
  return { standings: ranked.slice(0, Math.max(1, limit)), viewerRank: mine?.rank ?? null };
}

// ─── DB half (service-role; scope every per-user query by user_id — US-268) ──

/** Every enabled quest, ordered for display. Returns [] on a DB error. */
export async function loadQuestDefinitions(): Promise<QuestDefinition[]> {
  const { data, error } = await supabaseAdmin
    .from("reward_quests")
    .select(
      "id, key, name, description, quest_type, metric, target, cadence, starts_at, ends_at, xp_reward, icon, enabled, sort_order",
    )
    .eq("enabled", true)
    .order("sort_order", { ascending: true })
    .order("key", { ascending: true });
  if (error) {
    console.error("[rewards-quests] definition load failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as QuestDefinition[];
}

const REWARD_TYPES = new Set<string>(Object.keys(REWARD_XP_CATALOG));

function toQuestEvent(row: {
  event_type: string;
  occurred_at: string;
  verified: boolean;
  metadata: Record<string, unknown> | null;
}): QuestEventInput | null {
  if (!REWARD_TYPES.has(row.event_type)) return null;
  return {
    eventType: row.event_type as RewardEventType,
    occurredAt: row.occurred_at,
    verified: row.verified,
    paid: row.metadata?.paid === true,
    xpAward: frozenXpAward(row.metadata),
  };
}

/** One user's reward events at or after `sinceMs`. Tenant-scoped (US-268). */
async function loadUserEvents(userId: string, sinceMs: number): Promise<QuestEventInput[]> {
  const { data, error } = await supabaseAdmin
    .from("reputation_events")
    .select("event_type, occurred_at, verified, metadata")
    .eq("user_id", userId)
    .gte("occurred_at", new Date(sinceMs).toISOString())
    .order("occurred_at", { ascending: true });
  if (error) {
    console.error("[rewards-quests] event load failed:", error.message);
    return [];
  }
  const out: QuestEventInput[] = [];
  for (const r of data ?? []) {
    const ev = toQuestEvent(r as Parameters<typeof toQuestEvent>[0]);
    if (ev) out.push(ev);
  }
  return out;
}

export interface QuestView extends QuestDefinition {
  period_key: string;
  window_ends_at: string;
  progress: QuestProgress;
  completed_at: string | null;
  xp_awarded: number;
}

export interface ChallengeView extends QuestView {
  standings: Standing[];
  your_rank: number | null;
  /** False when the viewer has no public profile, so no rank can be shown. */
  you_are_listed: boolean;
}

export interface QuestsState {
  enabled: boolean;
  quests: QuestView[];
  challenges: ChallengeView[];
  season_timezone: string;
}

/**
 * Persist a quest's progress snapshot and, when it has just been finished, claim
 * the completion and pay the XP.
 *
 * CLAIM BEFORE PAY, the rewards-tangible pattern: the `completed_at IS NULL`
 * guard on the update is what makes two concurrent evaluations (two tabs, a
 * retry) award once. `grantReward`'s dedupe key is the second guarantee, so even
 * a claim that somehow ran twice cannot emit two ledger rows.
 *
 * Best-effort throughout — a quest problem must never fail the rewards screen.
 */
async function persistQuestProgress(
  userId: string,
  quest: QuestDefinition,
  window: QuestWindow,
  progress: QuestProgress,
): Promise<{ completedAt: string | null; xpAwarded: number }> {
  const { data: upserted, error } = await supabaseAdmin
    .from("user_quest_progress")
    .upsert(
      {
        user_id: userId,
        quest_id: quest.id,
        quest_key: quest.key,
        period_key: window.periodKey,
        progress: progress.current,
        target: progress.target,
      } as never,
      { onConflict: "user_id,quest_id,period_key" },
    )
    .select("completed_at, xp_awarded")
    .maybeSingle();
  if (error) {
    console.error("[rewards-quests] progress upsert failed:", error.message);
    return { completedAt: null, xpAwarded: 0 };
  }
  const row = upserted as { completed_at: string | null; xp_awarded: number } | null;
  if (row?.completed_at) return { completedAt: row.completed_at, xpAwarded: row.xp_awarded };
  if (!progress.complete) return { completedAt: null, xpAwarded: 0 };

  const xp = clampQuestXp(quest.xp_reward);
  const completedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("user_quest_progress")
    .update({ completed_at: completedAt, xp_awarded: xp } as never)
    .eq("user_id", userId)
    .eq("quest_id", quest.id)
    .eq("period_key", window.periodKey)
    .is("completed_at", null)
    .select("id");
  if (claimErr) {
    console.error("[rewards-quests] completion claim failed:", claimErr.message);
    return { completedAt: null, xpAwarded: 0 };
  }
  // Empty = a concurrent evaluation claimed it first. Not ours to pay.
  if (!claimed || claimed.length === 0) return { completedAt: null, xpAwarded: 0 };

  if (xp > 0) {
    await grantReward(userId, "quest_completed", {
      // One award per quest per window, forever.
      referenceId: `quest:${quest.key}:${window.periodKey}`,
      source: "quests",
      metadata: {
        quest_key: quest.key,
        quest_type: quest.quest_type,
        period_key: window.periodKey,
        // The amount, frozen. Editing the quest later never rewrites this.
        quest_xp: xp,
      },
    });
  }
  await notifyUser(userId, {
    type: "system",
    title: "Quest complete",
    message: xp > 0
      ? `${quest.name} — +${xp} XP.`
      : `${quest.name} — done.`,
    link: "/dashboard/rewards",
  }).catch(() => {});

  return { completedAt, xpAwarded: xp };
}

/**
 * Cross-user standings for a community challenge.
 *
 * This is a deliberately simple scan — pull the window's events for the metric
 * and fold them in memory — because a challenge window is short and the volume
 * inside it is bounded. US-1856 (leaderboards) is where a materialized aggregate
 * belongs; building one here for a board that renders a top ten would be
 * infrastructure ahead of a need. The row cap below is the safety valve, and it
 * is LOGGED when it bites rather than silently truncating the board.
 */
const STANDINGS_ROW_CAP = 5000;

export async function loadChallengeStandings(
  quest: QuestDefinition,
  window: QuestWindow,
  viewerId: string,
): Promise<{ standings: Standing[]; viewerRank: number | null; viewerListed: boolean }> {
  const empty = { standings: [], viewerRank: null, viewerListed: false };
  if (quest.metric === "xp") {
    // An XP-metric challenge would need every reward type in the window, which
    // is a different (and much larger) scan. Not supported as a community
    // challenge today — the admin form refuses it, and this is the backstop.
    return empty;
  }

  const { data, error } = await supabaseAdmin
    .from("reputation_events")
    .select("user_id, event_type, occurred_at, verified, metadata")
    .eq("event_type", quest.metric)
    .gte("occurred_at", new Date(window.startMs).toISOString())
    .lt("occurred_at", new Date(window.endMs).toISOString())
    .limit(STANDINGS_ROW_CAP);
  if (error) {
    console.error("[rewards-quests] standings load failed:", error.message);
    return empty;
  }
  const rows = (data ?? []) as Array<{
    user_id: string;
    event_type: string;
    occurred_at: string;
    verified: boolean;
    metadata: Record<string, unknown> | null;
  }>;
  if (rows.length >= STANDINGS_ROW_CAP) {
    console.warn(
      `[rewards-quests] standings for ${quest.key} hit the ${STANDINGS_ROW_CAP}-row cap — ` +
        "the board is a partial view of the window.",
    );
  }

  const scores = new Map<string, number>();
  for (const r of rows) {
    const ev = toQuestEvent(r);
    if (!ev) continue;
    if (xpForEvent(ev.eventType, { paid: ev.paid, verified: ev.verified }) <= 0) continue;
    scores.set(r.user_id, (scores.get(r.user_id) ?? 0) + 1);
  }
  if (scores.size === 0) return empty;

  // Public identity only. A seller who never turned on their Verified profile is
  // scored but not named.
  const { data: profiles, error: profErr } = await supabaseAdmin
    .from("users")
    .select("id, verified_handle, verified_display_name")
    .in("id", [...scores.keys()])
    .eq("verified_enabled", true)
    .not("verified_handle", "is", null);
  if (profErr) {
    console.error("[rewards-quests] standings profile load failed:", profErr.message);
    return empty;
  }

  const inputs: StandingInput[] = ((profiles ?? []) as Array<{
    id: string;
    verified_handle: string | null;
    verified_display_name: string | null;
  }>).map((p) => ({
    userId: p.id,
    handle: p.verified_handle,
    displayName: p.verified_display_name,
    score: scores.get(p.id) ?? 0,
  }));

  const { standings, viewerRank } = rankStandings(inputs, viewerId);
  return {
    standings,
    viewerRank,
    viewerListed: inputs.some((i) => i.userId === viewerId),
  };
}

/**
 * Everything the quests surface renders for one user, evaluating (and paying)
 * any quest they have just finished on the way through.
 *
 * `tz` is the shared season timezone — passed in rather than re-read so one
 * rewards request resolves every window against the same calendar.
 */
export async function loadQuestsState(
  userId: string,
  tz: string,
  nowMs: number = Date.now(),
): Promise<QuestsState> {
  const off: QuestsState = { enabled: false, quests: [], challenges: [], season_timezone: tz };
  try {
    // Fail-OPEN, unlike the tangible rail: quests pay XP, which is free status.
    // An outage that silently froze everyone's quest progress would do more
    // damage than one that kept paying it, and the money rail downstream has its
    // own fail-CLOSED switch.
    const enabled = await isFeatureEnabled(QUESTS_FLAG_KEY, { userId, defaultEnabled: true });
    if (!enabled) return off;

    const defs = await loadQuestDefinitions();
    const live = defs
      .map((q) => ({ quest: q, window: questWindow(q, nowMs, tz) }))
      .filter((x): x is { quest: QuestDefinition; window: QuestWindow } => x.window !== null);
    if (live.length === 0) return { ...off, enabled: true };

    // One event read for every window, from the earliest boundary in play.
    const since = Math.min(...live.map((x) => x.window.startMs));
    const events = await loadUserEvents(userId, since);

    const quests: QuestView[] = [];
    const challenges: ChallengeView[] = [];
    for (const { quest, window } of live) {
      const progress = computeQuestProgress(events, quest, window);
      const { completedAt, xpAwarded } = await persistQuestProgress(
        userId,
        quest,
        window,
        progress,
      );
      const view: QuestView = {
        ...quest,
        period_key: window.periodKey,
        window_ends_at: new Date(window.endMs).toISOString(),
        progress,
        completed_at: completedAt,
        xp_awarded: xpAwarded,
      };
      if (quest.quest_type === "community") {
        const board = await loadChallengeStandings(quest, window, userId);
        challenges.push({
          ...view,
          standings: board.standings,
          your_rank: board.viewerRank,
          you_are_listed: board.viewerListed,
        });
      } else {
        quests.push(view);
      }
    }

    return { enabled: true, quests, challenges, season_timezone: tz };
  } catch (err) {
    console.error(
      "[rewards-quests] state load failed:",
      err instanceof Error ? err.message : String(err),
    );
    return off;
  }
}
