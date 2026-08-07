// US-1859: re-engagement nudges — the reason to come back, and the proof it worked.
//
// Everything else in the reward system fires off the back of an action the user
// already took. This is the only part that fires because they took NONE, which
// makes it the one part that can become spam. So three constraints shape the
// whole module:
//
//   1. THE NUDGE MUST BE TRUE. Every candidate is derived from live state, not
//      from a schedule: a streak is only "at risk" when the chain really breaks
//      this week, a badge is only "near" when the remaining count is small and
//      non-zero, a quest only "expiring" when its window actually closes soon.
//      A reminder that turns out to be wrong costs the notification channel
//      permanently, and the opt-out is one-way.
//   2. AT MOST ONE, AND RARELY. `chooseNudge` returns a SINGLE candidate per
//      user per run, ranked by urgency, and only after the per-subject dedupe
//      key, the min-hours gap and the weekly cap have all cleared.
//   3. THE COUNTERFACTUAL IS RECORDED. A deterministic holdout slice gets no
//      nudge and a ledger row saying so, scored by the same conversion rule.
//      Without it "62% came back" is a number with nothing to compare to, and
//      AC3 asks for lift, not for a conversion rate.
//
// Consent is a DEDICATED category (`reward_nudges`), never a reuse: every other
// category's copy describes an account event, and "we noticed you were quiet" is
// not one. It is ADDITIONALLY gated by the `marketing` umbrella, because that is
// what a re-engagement message is, and by the suppression list for the two
// reasons that mean "stop" rather than "this address bounces".
//
// The pure half (candidate detection, ranking, capping, holdout assignment,
// conversion scoring) has no DB and no env, so the entire policy is unit-testable
// without a database — see rewards-nudges_test.ts.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { notifyUser, pushChannelEnabled } from "./notify.ts";
import { isMarketingOptedOut } from "./email-consent.ts";
import { getSuppression } from "./email-suppression.ts";
import {
  type BadgeContext,
  loadBadgeContext,
  nearestBadge,
} from "./rewards-badges.ts";
import { loadSeasonTimezone } from "./rewards-seasons.ts";
import {
  loadQuestDefinitions,
  type QuestDefinition,
  questWindow,
  type QuestWindow,
} from "./rewards-quests.ts";

// ─── Types + config ──────────────────────────────────────────────────────────

export const NUDGE_TYPES = [
  "streak_at_risk",
  "badge_near_miss",
  "quest_new",
  "quest_expiring",
  "reward_available",
] as const;

export type NudgeType = typeof NUDGE_TYPES[number];

/** The preference category this whole surface is gated on. New, never reused. */
export const NUDGE_PREF_KEY = "reward_nudges";
export const NUDGE_CONFIG_KEY = "reward_nudges_config";
/** The attribution slug stamped on every send and every deep link. */
export const NUDGE_CAMPAIGN = "reward_nudge";

export interface NudgeConfig {
  enabled: boolean;
  types: Record<NudgeType, boolean>;
  maxPerWeek: number;
  minHoursBetween: number;
  /** 0–100. The share of eligible users who get NOTHING, so lift is measurable. */
  holdoutPct: number;
  nearMissMaxRemaining: number;
  streakRiskDaysLeft: number;
  questNewWithinHours: number;
  questExpiringWithinHours: number;
  rewardExpiringWithinDays: number;
  attributionWindowDays: number;
}

export const DEFAULT_NUDGE_CONFIG: NudgeConfig = {
  enabled: true,
  types: {
    streak_at_risk: true,
    badge_near_miss: true,
    quest_new: true,
    quest_expiring: true,
    reward_available: true,
  },
  maxPerWeek: 2,
  minHoursBetween: 48,
  holdoutPct: 10,
  nearMissMaxRemaining: 3,
  streakRiskDaysLeft: 3,
  questNewWithinHours: 36,
  questExpiringWithinHours: 48,
  rewardExpiringWithinDays: 10,
  attributionWindowDays: 7,
};

function num(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** Coerce an arbitrary settings blob into a usable config. Never throws. */
export function normalizeNudgeConfig(raw: unknown): NudgeConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_NUDGE_CONFIG;
  const r = raw as Record<string, unknown>;
  const rawTypes = (r.types && typeof r.types === "object" ? r.types : {}) as Record<string, unknown>;
  const types = {} as Record<NudgeType, boolean>;
  for (const t of NUDGE_TYPES) {
    types[t] = bool(rawTypes[t], DEFAULT_NUDGE_CONFIG.types[t]);
  }
  return {
    enabled: bool(r.enabled, DEFAULT_NUDGE_CONFIG.enabled),
    types,
    maxPerWeek: num(r.max_per_week, DEFAULT_NUDGE_CONFIG.maxPerWeek, 0, 14),
    minHoursBetween: num(r.min_hours_between, DEFAULT_NUDGE_CONFIG.minHoursBetween, 0, 336),
    holdoutPct: num(r.holdout_pct, DEFAULT_NUDGE_CONFIG.holdoutPct, 0, 50),
    nearMissMaxRemaining: num(
      r.near_miss_max_remaining,
      DEFAULT_NUDGE_CONFIG.nearMissMaxRemaining,
      1,
      50,
    ),
    streakRiskDaysLeft: num(r.streak_risk_days_left, DEFAULT_NUDGE_CONFIG.streakRiskDaysLeft, 1, 7),
    questNewWithinHours: num(
      r.quest_new_within_hours,
      DEFAULT_NUDGE_CONFIG.questNewWithinHours,
      1,
      336,
    ),
    questExpiringWithinHours: num(
      r.quest_expiring_within_hours,
      DEFAULT_NUDGE_CONFIG.questExpiringWithinHours,
      1,
      336,
    ),
    rewardExpiringWithinDays: num(
      r.reward_expiring_within_days,
      DEFAULT_NUDGE_CONFIG.rewardExpiringWithinDays,
      1,
      90,
    ),
    attributionWindowDays: num(
      r.attribution_window_days,
      DEFAULT_NUDGE_CONFIG.attributionWindowDays,
      1,
      60,
    ),
  };
}

export async function loadNudgeConfig(): Promise<NudgeConfig> {
  return normalizeNudgeConfig(await getSetting<unknown>(NUDGE_CONFIG_KEY, null));
}

// ─── Candidates ──────────────────────────────────────────────────────────────

export interface NudgeCandidate {
  type: NudgeType;
  /** What the nudge is ABOUT — a badge/quest/milestone key, or 'streak'. */
  subjectKey: string;
  /** The window it belongs to. With subjectKey this is what "once" means. */
  periodKey: string;
  title: string;
  body: string;
  /** In-app deep link. The send id + campaign are appended at delivery. */
  link: string;
}

/**
 * Urgency order. A deadline the user can still act on outranks an open-ended
 * "you're close" — the near-miss will still be true tomorrow, the expiring quest
 * will not. Fixed rather than configurable: the ordering IS the policy, and an
 * operator reordering it would silently change which nudge people ever see,
 * because only one is sent.
 */
const NUDGE_PRIORITY: Record<NudgeType, number> = {
  streak_at_risk: 0,
  reward_available: 1,
  quest_expiring: 2,
  quest_new: 3,
  badge_near_miss: 4,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ── Streak at risk (BUYER only — see the reward-ledger contract) ─────────────

export interface StreakRiskInput {
  /** Monday-anchored week keys (shared season tz) with ≥1 confirmation. */
  activeWeeks: ReadonlySet<string>;
  /** This week's key + the previous week's, resolved by the caller's calendar. */
  thisWeekKey: string;
  previousWeekKeys: readonly string[];
  /** Whole days left before this week's window closes. */
  daysLeftInWeek: number;
}

/**
 * Is a buyer's confirmation streak genuinely about to break?
 *
 * Three conditions, and the third is why this cannot just be "they were quiet":
 *   • a chain exists — last week has a confirmation, so there is something to
 *     lose. Telling someone with no streak that their streak is at risk is the
 *     fastest way to teach them the notification is noise;
 *   • this week has none yet — the grace rule (the current week never breaks a
 *     chain by being young) is exactly the window this nudge lives in;
 *   • the chain has no banked FREEZE to spend. A freeze bridges a missed week,
 *     so a chain that owns one is not at risk. `bankedFreezes` is estimated
 *     CONSERVATIVELY from the unbridged run, which can only OVER-count what is
 *     banked — and over-counting suppresses the nudge, which is the safe
 *     direction to be wrong in.
 *
 * Pure. The calendar is resolved by the caller from `questWindow`, so this
 * shares the ONE reward calendar rather than deriving a second one.
 */
export function detectStreakRisk(
  input: StreakRiskInput,
  config: NudgeConfig,
): { runWeeks: number; bankedFreezes: number; atRisk: boolean } {
  const { activeWeeks, thisWeekKey, previousWeekKeys, daysLeftInWeek } = input;

  // The unbridged run of active weeks ending at LAST week.
  let runWeeks = 0;
  for (const key of previousWeekKeys) {
    if (!activeWeeks.has(key)) break;
    runWeeks++;
  }
  // Mirrors FREEZE_EARNED_EVERY_WEEKS / MAX_BANKED_FREEZES in
  // src/lib/buyer-rewards-summary.ts — one freeze per 4 active weeks, max 2.
  const bankedFreezes = Math.min(2, Math.floor(runWeeks / 4));

  const atRisk = runWeeks > 0 &&
    !activeWeeks.has(thisWeekKey) &&
    bankedFreezes === 0 &&
    daysLeftInWeek <= config.streakRiskDaysLeft;

  return { runWeeks, bankedFreezes, atRisk };
}

export function streakCandidate(runWeeks: number, thisWeekKey: string): NudgeCandidate {
  return {
    type: "streak_at_risk",
    subjectKey: "streak",
    periodKey: thisWeekKey,
    title: `Keep your ${runWeeks}-week streak`,
    body:
      `You've confirmed an arrival ${runWeeks} weeks running. One confirmation before ` +
      `the week ends keeps the chain going.`,
    link: "/buyer/rewards",
  };
}

// ── Badge near miss ─────────────────────────────────────────────────────────

export function nearMissCandidate(
  ctx: BadgeContext,
  earnedKeys: ReadonlySet<string>,
  config: NudgeConfig,
): NudgeCandidate | null {
  const miss = nearestBadge(ctx, earnedKeys, config.nearMissMaxRemaining);
  if (!miss) return null;
  const unit = miss.remaining === 1 ? "one more" : `${miss.remaining} more`;
  return {
    type: "badge_near_miss",
    subjectKey: miss.badge.key,
    // A near miss for a given badge is worth saying ONCE, ever — the distance
    // only shrinks, so re-announcing it every week is nagging about the same
    // fact. If they earn it the badge fires its own celebration instead.
    periodKey: "once",
    title: `${unit} for ${miss.badge.name}`,
    body: `You're at ${miss.current} of ${miss.target}. ${miss.badge.description}`,
    link: "/dashboard/rewards",
  };
}

// ── Quests ──────────────────────────────────────────────────────────────────

export interface QuestNudgeInput {
  quest: Pick<QuestDefinition, "key" | "name" | "description" | "quest_type" | "target">;
  window: QuestWindow;
  /** Live progress toward the quest's target inside this window. */
  current: number;
  /** True once the completion has been claimed for this window. */
  complete: boolean;
}

/**
 * A quest/challenge worth saying something about right now, or null.
 *
 * TWO distinct moments, not one:
 *   • `quest_new` — the window OPENED recently and they have not started. This
 *     is the announcement AC1 asks for, and it is bounded to the opening hours
 *     so a Thursday reminder about Monday's quest doesn't read as an
 *     announcement.
 *   • `quest_expiring` — the window CLOSES soon and they are part-way. Only
 *     part-way: nudging someone with zero progress toward a target they never
 *     started is a chore reminder, not a nudge, and nudging someone who already
 *     finished is just wrong.
 */
export function questCandidate(
  input: QuestNudgeInput,
  config: NudgeConfig,
  nowMs: number,
): NudgeCandidate | null {
  const { quest, window, current, complete } = input;
  if (complete) return null;
  const target = Math.max(1, quest.target);
  if (current >= target) return null;

  const msLeft = window.endMs - nowMs;
  if (msLeft <= 0) return null;

  const noun = quest.quest_type === "community" ? "challenge" : "quest";

  if (
    config.types.quest_expiring &&
    current > 0 &&
    msLeft <= config.questExpiringWithinHours * HOUR_MS
  ) {
    const remaining = target - current;
    return {
      type: "quest_expiring",
      subjectKey: quest.key,
      periodKey: window.periodKey,
      title: `${quest.name} ends soon`,
      body:
        `You're at ${current} of ${target} — ${remaining} more finishes the ${noun} ` +
        `before this window closes.`,
      link: "/dashboard/rewards",
    };
  }

  const msOpen = nowMs - window.startMs;
  if (
    config.types.quest_new &&
    current === 0 &&
    msOpen >= 0 &&
    msOpen <= config.questNewWithinHours * HOUR_MS
  ) {
    return {
      type: "quest_new",
      subjectKey: quest.key,
      periodKey: window.periodKey,
      title: `New ${noun}: ${quest.name}`,
      body: quest.description,
      link: "/dashboard/rewards",
    };
  }

  return null;
}

// ── Reward available ────────────────────────────────────────────────────────

export interface ExpiringGrantInput {
  milestoneKey: string;
  label: string;
  rewardType: string;
  rewardValue: number;
  /** ISO. A grant with no expiry has no deadline, so it is not "available soon". */
  expiresAt: string | null;
}

/**
 * A granted reward with a real deadline, or null.
 *
 * Tangible milestones are GRANTED, never claimed (the ledger contract), so there
 * is no "you have an unclaimed reward" state to announce — announcing one would
 * invent a step the user can fail to take. What genuinely needs saying is that a
 * time-boxed grant (a discount, an entitlement) is about to lapse unused.
 */
export function expiringRewardCandidate(
  grants: readonly ExpiringGrantInput[],
  config: NudgeConfig,
  nowMs: number,
): NudgeCandidate | null {
  const horizon = nowMs + config.rewardExpiringWithinDays * DAY_MS;
  let soonest: { grant: ExpiringGrantInput; expiresMs: number } | null = null;
  for (const grant of grants) {
    const expiresMs = Date.parse(grant.expiresAt ?? "");
    if (!Number.isFinite(expiresMs)) continue;
    if (expiresMs <= nowMs || expiresMs > horizon) continue;
    if (!soonest || expiresMs < soonest.expiresMs) soonest = { grant, expiresMs };
  }
  if (!soonest) return null;

  const days = Math.max(1, Math.ceil((soonest.expiresMs - nowMs) / DAY_MS));
  return {
    type: "reward_available",
    subjectKey: soonest.grant.milestoneKey,
    // Keyed to the expiry date, so a re-granted or extended reward can nudge
    // again while the same deadline never does.
    periodKey: new Date(soonest.expiresMs).toISOString().slice(0, 10),
    title: `Your ${soonest.grant.label} reward expires soon`,
    body: `It's yours until ${new Date(soonest.expiresMs).toISOString().slice(0, 10)} — ` +
      `${days === 1 ? "1 day" : `${days} days`} left to use it.`,
    link: "/dashboard/rewards",
  };
}

// ─── Ranking + frequency cap ─────────────────────────────────────────────────

/** One prior send, as the cap reads it. */
export interface RecentSend {
  nudgeType: string;
  subjectKey: string;
  periodKey: string;
  sentAtMs: number;
}

export type NudgeDecision =
  | { action: "send"; candidate: NudgeCandidate }
  | { action: "skip"; reason: string };

/** The dedupe identity of a candidate — mirrors the UNIQUE index in 00546. */
export function nudgeKey(c: Pick<NudgeCandidate, "type" | "subjectKey" | "periodKey">): string {
  return `${c.type}|${c.subjectKey}|${c.periodKey}`;
}

/**
 * Pick the ONE nudge to send now, or explain why none.
 *
 * Order: drop candidates whose type is switched off or that were already sent
 * for this subject+window, rank the survivors by urgency, then apply the two
 * time caps. The caps are checked AFTER the dedupe filter on purpose — a
 * candidate we would never send anyway must not consume the weekly budget, or a
 * user with one stale repeat candidate would be silently capped out of every
 * other nudge forever.
 *
 * Holdout rows count toward the caps too. They are a decision that was made
 * about this user, and letting the holdout slice accumulate un-capped candidates
 * would make its members MORE eligible than the treated group the moment the
 * experiment ends — which would bias the very comparison it exists to enable.
 */
export function chooseNudge(
  candidates: readonly NudgeCandidate[],
  recent: readonly RecentSend[],
  config: NudgeConfig,
  nowMs: number,
): NudgeDecision {
  if (!config.enabled) return { action: "skip", reason: "disabled" };

  const alreadySent = new Set(
    recent.map((r) => `${r.nudgeType}|${r.subjectKey}|${r.periodKey}`),
  );
  const eligible = candidates
    .filter((c) => config.types[c.type])
    .filter((c) => !alreadySent.has(nudgeKey(c)))
    .sort((a, b) => NUDGE_PRIORITY[a.type] - NUDGE_PRIORITY[b.type]);

  if (eligible.length === 0) return { action: "skip", reason: "no_candidate" };

  if (config.maxPerWeek <= 0) return { action: "skip", reason: "capped_week" };

  const weekAgo = nowMs - 7 * DAY_MS;
  const sentThisWeek = recent.filter((r) => r.sentAtMs >= weekAgo).length;
  if (sentThisWeek >= config.maxPerWeek) return { action: "skip", reason: "capped_week" };

  const lastSentMs = recent.reduce((max, r) => Math.max(max, r.sentAtMs), 0);
  if (lastSentMs > 0 && nowMs - lastSentMs < config.minHoursBetween * HOUR_MS) {
    return { action: "skip", reason: "capped_gap" };
  }

  return { action: "send", candidate: eligible[0]! };
}

// ─── Holdout ─────────────────────────────────────────────────────────────────

/**
 * Deterministic holdout assignment: the same user is always on the same side.
 *
 * Deterministic rather than random per-run because a user who is randomly held
 * out on Monday and nudged on Tuesday is in neither group, and their outcome
 * contaminates both. FNV-1a over the user id — not a crypto hash, and it does
 * not need to be: it needs to be stable, uniform enough, and computable without
 * a round trip.
 */
export function isHoldout(userId: string, holdoutPct: number): boolean {
  const pct = Math.min(50, Math.max(0, Math.floor(holdoutPct)));
  if (pct <= 0) return false;
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100 < pct;
}

// ─── Consent ─────────────────────────────────────────────────────────────────

type Prefs = Record<string, unknown> | null | undefined;

/**
 * Suppression reasons that mean STOP, not "this address bounces".
 *
 * A hard bounce is a deliverability fact about one mailbox and says nothing
 * about in-app or push. A complaint or a global unsubscribe is a person telling
 * us to stop contacting them; honoring that only on the channel they happened to
 * use would be reading the letter and ignoring the sentence.
 */
const STOP_SUPPRESSION_REASONS = new Set(["complaint", "unsubscribe_all"]);

export interface NudgeConsent {
  allowed: boolean;
  reason: string;
  /** Channels the delivery will actually attempt. */
  channels: string[];
}

/** Pure: may this user receive a nudge, and on which channels? */
export function evaluateNudgeConsent(
  prefs: Prefs,
  suppressionReason: string | null,
): NudgeConsent {
  const denied = (reason: string): NudgeConsent => ({ allowed: false, reason, channels: [] });

  if (suppressionReason && STOP_SUPPRESSION_REASONS.has(suppressionReason)) {
    return denied("suppressed");
  }
  // The dedicated toggle. Opt-out model (absence ⇒ on), like every sibling
  // category — the consent this category asks for is its own existence in the
  // settings list, not a second confirmation.
  const cat = prefs && typeof prefs === "object"
    ? (prefs as Record<string, unknown>)[NUDGE_PREF_KEY]
    : undefined;
  const catObj = cat && typeof cat === "object" ? cat as Record<string, unknown> : {};
  if (catObj.in_app === false && catObj.push === false) return denied("pref_off");

  // A re-engagement nudge IS marketing, so the umbrella every marketing send
  // honors applies here too. Someone who unsubscribed from all marketing has not
  // agreed to be pulled back in through a different channel.
  if (isMarketingOptedOut(prefs, "email")) return denied("marketing_opt_out");

  const channels: string[] = [];
  if (catObj.in_app !== false) channels.push("in_app");
  if (catObj.push !== false && pushChannelEnabled(prefs as never, NUDGE_PREF_KEY)) {
    channels.push("push");
  }
  if (channels.length === 0) return denied("pref_off");
  return { allowed: true, reason: "ok", channels };
}

// ─── Attribution ─────────────────────────────────────────────────────────────

export interface ConversionSignal {
  /** ms epoch of a rewardable act (a reputation event or a buyer confirmation). */
  occurredAtMs: number;
  kind: string;
}

/**
 * Did this send convert? Pure.
 *
 * ONE rule for every nudge type, and the same rule for the holdout rows — a
 * rewardable action inside the attribution window that started after the
 * decision. Per-type conversion rules would each be defensible and collectively
 * unusable: the lift number needs one denominator and one numerator, or the
 * types cannot be compared and the holdout cannot be subtracted.
 */
export function scoreConversion(
  sentAtMs: number,
  signals: readonly ConversionSignal[],
  config: NudgeConfig,
  nowMs: number,
): { converted: boolean; kind: string | null; atMs: number | null; windowClosed: boolean } {
  const windowEnd = sentAtMs + config.attributionWindowDays * DAY_MS;
  let first: ConversionSignal | null = null;
  for (const s of signals) {
    if (s.occurredAtMs <= sentAtMs || s.occurredAtMs > windowEnd) continue;
    if (!first || s.occurredAtMs < first.occurredAtMs) first = s;
  }
  return {
    converted: first !== null,
    kind: first?.kind ?? null,
    atMs: first?.occurredAtMs ?? null,
    windowClosed: nowMs > windowEnd,
  };
}

// ─── Lift report (pure) ──────────────────────────────────────────────────────

export interface LiftRow {
  nudge_type: NudgeType | string;
  sent: number;
  sent_converted: number;
  sent_clicked: number;
  holdout: number;
  holdout_converted: number;
  /** Percentage points: sent conversion rate minus holdout conversion rate. */
  lift_pp: number | null;
}

/**
 * Fold raw send rows into a per-type lift table.
 *
 * `lift_pp` is deliberately NULL when the holdout arm is empty rather than 0 or
 * the raw conversion rate. A missing control is not a control that measured
 * zero, and reporting the treated rate as the lift is exactly the mistake the
 * holdout was added to prevent.
 */
export function summarizeLift(
  rows: ReadonlyArray<{
    nudge_type: string;
    holdout: boolean;
    converted_at: string | null;
    clicked_at: string | null;
  }>,
): LiftRow[] {
  const byType = new Map<string, LiftRow>();
  for (const r of rows) {
    let row = byType.get(r.nudge_type);
    if (!row) {
      row = {
        nudge_type: r.nudge_type,
        sent: 0,
        sent_converted: 0,
        sent_clicked: 0,
        holdout: 0,
        holdout_converted: 0,
        lift_pp: null,
      };
      byType.set(r.nudge_type, row);
    }
    if (r.holdout) {
      row.holdout++;
      if (r.converted_at) row.holdout_converted++;
    } else {
      row.sent++;
      if (r.converted_at) row.sent_converted++;
      if (r.clicked_at) row.sent_clicked++;
    }
  }
  for (const row of byType.values()) {
    if (row.sent === 0 || row.holdout === 0) continue;
    const treated = (row.sent_converted / row.sent) * 100;
    const control = (row.holdout_converted / row.holdout) * 100;
    row.lift_pp = Math.round((treated - control) * 10) / 10;
  }
  return [...byType.values()].sort((a, b) => a.nudge_type.localeCompare(b.nudge_type));
}

// ─── DB half (service-role; every per-user query scoped by user_id — US-268) ──

/** The Monday-anchored week the shared reward calendar is in, plus its neighbours. */
export function weekCalendar(nowMs: number, tz: string, backWeeks = 12): {
  thisWeekKey: string;
  previousWeekKeys: string[];
  windowEndMs: number;
  earliestStartMs: number;
} {
  const weekly = { cadence: "weekly" as const, starts_at: null, ends_at: null };
  const current = questWindow(weekly, nowMs, tz)!;
  const previousWeekKeys: string[] = [];
  let cursorMs = current.startMs - 1;
  let earliestStartMs = current.startMs;
  for (let i = 0; i < backWeeks; i++) {
    const w = questWindow(weekly, cursorMs, tz);
    if (!w) break;
    previousWeekKeys.push(w.periodKey);
    earliestStartMs = w.startMs;
    cursorMs = w.startMs - 1;
  }
  return {
    thisWeekKey: current.periodKey,
    previousWeekKeys,
    windowEndMs: current.endMs,
    earliestStartMs,
  };
}

interface UserNudgeContext {
  prefs: Prefs;
  email: string | null;
}

async function loadUserContext(userId: string): Promise<UserNudgeContext> {
  const { data } = await supabaseAdmin
    .from("users")
    .select("notification_preferences, email")
    .eq("id", userId)
    .maybeSingle();
  const row = data as { notification_preferences?: Prefs; email?: string | null } | null;
  return { prefs: row?.notification_preferences ?? null, email: row?.email ?? null };
}

/** This user's recent nudge ledger rows (the frequency cap's input). */
export async function loadRecentSends(userId: string, sinceMs: number): Promise<RecentSend[]> {
  const { data, error } = await supabaseAdmin
    .from("reward_nudge_sends")
    .select("nudge_type, subject_key, period_key, sent_at")
    .eq("user_id", userId)
    .gte("sent_at", new Date(sinceMs).toISOString())
    .order("sent_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[rewards-nudges] recent-send load failed:", error.message);
    return [];
  }
  return ((data ?? []) as Array<{
    nudge_type: string;
    subject_key: string;
    period_key: string;
    sent_at: string;
  }>).map((r) => ({
    nudgeType: r.nudge_type,
    subjectKey: r.subject_key,
    periodKey: r.period_key,
    sentAtMs: Date.parse(r.sent_at) || 0,
  }));
}

/** The buyer's confirmation weeks, keyed on the shared reward calendar. */
export async function loadConfirmationWeeks(
  userId: string,
  sinceMs: number,
  tz: string,
): Promise<Set<string>> {
  const weeks = new Set<string>();
  const { data, error } = await supabaseAdmin
    .from("grade_outcomes")
    .select("created_at")
    .eq("buyer_user_id", userId)
    .eq("match_status", "confirmed")
    .gte("created_at", new Date(sinceMs).toISOString())
    .limit(500);
  if (error) {
    console.error("[rewards-nudges] confirmation load failed:", error.message);
    return weeks;
  }
  const weekly = { cadence: "weekly" as const, starts_at: null, ends_at: null };
  for (const row of (data ?? []) as Array<{ created_at: string }>) {
    const t = Date.parse(row.created_at);
    if (!Number.isFinite(t)) continue;
    const w = questWindow(weekly, t, tz);
    if (w) weeks.add(w.periodKey);
  }
  return weeks;
}

/** Time-boxed tangible grants still in force. */
async function loadExpiringGrants(userId: string): Promise<ExpiringGrantInput[]> {
  const { data, error } = await supabaseAdmin
    .from("reward_tangible_grants")
    .select("milestone_key, reward_type, reward_value, expires_at")
    .eq("user_id", userId)
    .eq("status", "granted")
    .not("expires_at", "is", null)
    .limit(50);
  if (error) {
    console.error("[rewards-nudges] grant load failed:", error.message);
    return [];
  }
  return ((data ?? []) as Array<{
    milestone_key: string;
    reward_type: string;
    reward_value: number | string;
    expires_at: string | null;
  }>).map((r) => ({
    milestoneKey: r.milestone_key,
    label: r.milestone_key.replace(/_/g, " "),
    rewardType: r.reward_type,
    rewardValue: Number(r.reward_value) || 0,
    expiresAt: r.expires_at,
  }));
}

/** Quest progress snapshots for the live windows (the cheap read — the full lazy
 *  evaluation belongs to GET /api/rewards/quests, not to a background sweep). */
async function loadQuestSnapshots(
  userId: string,
  live: ReadonlyArray<{ quest: QuestDefinition; window: QuestWindow }>,
): Promise<Map<string, { current: number; complete: boolean }>> {
  const out = new Map<string, { current: number; complete: boolean }>();
  if (live.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("user_quest_progress")
    .select("quest_key, period_key, progress, completed_at")
    .eq("user_id", userId)
    .in("period_key", [...new Set(live.map((l) => l.window.periodKey))])
    .limit(200);
  if (error) {
    console.error("[rewards-nudges] quest snapshot load failed:", error.message);
    return out;
  }
  for (const row of (data ?? []) as Array<{
    quest_key: string;
    period_key: string;
    progress: number;
    completed_at: string | null;
  }>) {
    out.set(`${row.quest_key}|${row.period_key}`, {
      current: row.progress ?? 0,
      complete: !!row.completed_at,
    });
  }
  return out;
}

export interface NudgeRunContext {
  config: NudgeConfig;
  tz: string;
  nowMs: number;
  calendar: ReturnType<typeof weekCalendar>;
  liveQuests: Array<{ quest: QuestDefinition; window: QuestWindow }>;
}

/** Everything the run shares across users — loaded once, not per user. */
export async function buildRunContext(nowMs: number = Date.now()): Promise<NudgeRunContext> {
  const [config, tz] = await Promise.all([loadNudgeConfig(), loadSeasonTimezone()]);
  const defs = await loadQuestDefinitions();
  const liveQuests = defs
    .map((quest) => ({ quest, window: questWindow(quest, nowMs, tz) }))
    .filter((x): x is { quest: QuestDefinition; window: QuestWindow } => x.window !== null);
  return { config, tz, nowMs, calendar: weekCalendar(nowMs, tz), liveQuests };
}

/** Every candidate this user has right now, unranked and uncapped. */
export async function collectCandidates(
  userId: string,
  ctx: NudgeRunContext,
  opts: { buyer: boolean; seller: boolean },
): Promise<NudgeCandidate[]> {
  const out: NudgeCandidate[] = [];
  const { config, nowMs } = ctx;

  if (opts.buyer && config.types.streak_at_risk) {
    const activeWeeks = await loadConfirmationWeeks(userId, ctx.calendar.earliestStartMs, ctx.tz);
    const daysLeftInWeek = Math.max(0, Math.ceil((ctx.calendar.windowEndMs - nowMs) / DAY_MS));
    const risk = detectStreakRisk(
      {
        activeWeeks,
        thisWeekKey: ctx.calendar.thisWeekKey,
        previousWeekKeys: ctx.calendar.previousWeekKeys,
        daysLeftInWeek,
      },
      config,
    );
    if (risk.atRisk) out.push(streakCandidate(risk.runWeeks, ctx.calendar.thisWeekKey));
  }

  if (!opts.seller) return out;

  if (config.types.badge_near_miss) {
    const [badgeCtx, earnedRes] = await Promise.all([
      loadBadgeContext(userId),
      supabaseAdmin.from("user_badges").select("badge_key").eq("user_id", userId),
    ]);
    const earned = new Set(
      ((earnedRes.data ?? []) as Array<{ badge_key: string }>).map((r) => r.badge_key),
    );
    const candidate = nearMissCandidate(badgeCtx, earned, config);
    if (candidate) out.push(candidate);
  }

  if (config.types.quest_new || config.types.quest_expiring) {
    const snapshots = await loadQuestSnapshots(userId, ctx.liveQuests);
    for (const { quest, window } of ctx.liveQuests) {
      const snap = snapshots.get(`${quest.key}|${window.periodKey}`);
      const candidate = questCandidate(
        {
          quest,
          window,
          current: snap?.current ?? 0,
          complete: snap?.complete ?? false,
        },
        config,
        nowMs,
      );
      if (candidate) out.push(candidate);
    }
  }

  if (config.types.reward_available) {
    const candidate = expiringRewardCandidate(await loadExpiringGrants(userId), config, nowMs);
    if (candidate) out.push(candidate);
  }

  return out;
}

export type NudgeOutcome = "sent" | "holdout" | "skipped";

export interface NudgeResult {
  outcome: NudgeOutcome;
  reason: string;
  type?: NudgeType;
}

/**
 * Evaluate and (maybe) deliver ONE nudge for one user. Best-effort throughout:
 * a nudge failure must never fail the sweep, so every step logs and degrades.
 */
export async function nudgeUser(
  userId: string,
  ctx: NudgeRunContext,
  opts: { buyer: boolean; seller: boolean },
): Promise<NudgeResult> {
  if (!userId) return { outcome: "skipped", reason: "no_user" };
  const { config, nowMs } = ctx;
  if (!config.enabled) return { outcome: "skipped", reason: "disabled" };

  try {
    // Consent FIRST: the reads below are not free, and someone who opted out is
    // not a candidate for anything.
    const user = await loadUserContext(userId);
    const suppression = user.email ? await getSuppression(user.email) : null;
    const consent = evaluateNudgeConsent(user.prefs, suppression?.reason ?? null);
    if (!consent.allowed) return { outcome: "skipped", reason: consent.reason };

    const candidates = await collectCandidates(userId, ctx, opts);
    if (candidates.length === 0) return { outcome: "skipped", reason: "no_candidate" };

    const recent = await loadRecentSends(userId, nowMs - 30 * DAY_MS);
    const decision = chooseNudge(candidates, recent, config, nowMs);
    if (decision.action !== "send") return { outcome: "skipped", reason: decision.reason };

    const candidate = decision.candidate;
    const holdout = isHoldout(userId, config.holdoutPct);

    // CLAIM BEFORE DELIVER, the rewards-tangible pattern: the UNIQUE index is
    // what makes two overlapping runs (a retry, a manual trigger beside the
    // cron) notify once. A 23505 means somebody else got there first.
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from("reward_nudge_sends")
      .insert({
        user_id: userId,
        nudge_type: candidate.type,
        subject_key: candidate.subjectKey,
        period_key: candidate.periodKey,
        campaign: NUDGE_CAMPAIGN,
        holdout,
        channels: holdout ? [] : consent.channels,
        sent_at: new Date(nowMs).toISOString(),
      } as never)
      .select("id")
      .maybeSingle();
    if (claimErr) {
      if (claimErr.code === "23505") return { outcome: "skipped", reason: "already_sent" };
      console.error("[rewards-nudges] claim failed:", claimErr.message);
      return { outcome: "skipped", reason: "claim_failed" };
    }

    if (holdout) {
      return { outcome: "holdout", reason: "holdout", type: candidate.type };
    }

    const sendId = (claimed as { id: string } | null)?.id ?? null;
    await notifyUser(userId, {
      type: "reward_nudge",
      title: candidate.title,
      message: candidate.body,
      link: nudgeLink(candidate.link, sendId),
    });

    return { outcome: "sent", reason: "ok", type: candidate.type };
  } catch (err) {
    console.error(
      `[rewards-nudges] user ${userId} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return { outcome: "skipped", reason: "error" };
  }
}

/**
 * The attributed deep link. `?nudge=<id>` is what the SPA posts back on open, and
 * the utm pair is what makes the visit legible to the same analytics every other
 * campaign lands in — one send, one identity, two readers.
 */
export function nudgeLink(path: string, sendId: string | null): string {
  if (!sendId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}nudge=${sendId}&utm_source=gradethread&utm_medium=notification` +
    `&utm_campaign=${NUDGE_CAMPAIGN}`;
}

// ─── The attribution pass ────────────────────────────────────────────────────

/** Rewardable acts by this user after `sinceMs` — the conversion signal. */
async function loadConversionSignals(
  userId: string,
  sinceMs: number,
): Promise<ConversionSignal[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const [events, outcomes] = await Promise.all([
    supabaseAdmin
      .from("reputation_events")
      .select("event_type, occurred_at")
      .eq("user_id", userId)
      .gte("occurred_at", sinceIso)
      .order("occurred_at", { ascending: true })
      .limit(200),
    supabaseAdmin
      .from("grade_outcomes")
      .select("created_at")
      .eq("buyer_user_id", userId)
      .eq("match_status", "confirmed")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  const signals: ConversionSignal[] = [];
  for (const r of (events.data ?? []) as Array<{ event_type: string; occurred_at: string }>) {
    const t = Date.parse(r.occurred_at);
    if (Number.isFinite(t)) signals.push({ occurredAtMs: t, kind: r.event_type });
  }
  for (const r of (outcomes.data ?? []) as Array<{ created_at: string }>) {
    const t = Date.parse(r.created_at);
    if (Number.isFinite(t)) signals.push({ occurredAtMs: t, kind: "grade_confirmed" });
  }
  return signals;
}

/**
 * Score every open send (sent AND holdout) whose attribution window is still
 * relevant. Idempotent: a row that already carries `converted_at` is not re-read,
 * and a row whose window has closed without a signal is left alone — a null
 * conversion IS the measurement, and stamping it would lose the distinction
 * between "did not convert" and "not scored yet" for nothing.
 */
export async function runAttributionPass(
  config: NudgeConfig,
  nowMs: number = Date.now(),
  maxRows = 2000,
): Promise<{ scanned: number; converted: number }> {
  const windowMs = config.attributionWindowDays * DAY_MS;
  const { data, error } = await supabaseAdmin
    .from("reward_nudge_sends")
    .select("id, user_id, sent_at")
    .is("converted_at", null)
    .gte("sent_at", new Date(nowMs - windowMs).toISOString())
    .order("sent_at", { ascending: false })
    .limit(maxRows);
  if (error) {
    console.error("[rewards-nudges] attribution scan failed:", error.message);
    return { scanned: 0, converted: 0 };
  }

  const rows = (data ?? []) as Array<{ id: string; user_id: string; sent_at: string }>;
  // Group by user so one signal read serves every open row that user holds.
  const byUser = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  let converted = 0;
  for (const [userId, userRows] of byUser) {
    try {
      const earliest = userRows.reduce(
        (min, r) => Math.min(min, Date.parse(r.sent_at) || nowMs),
        nowMs,
      );
      const signals = await loadConversionSignals(userId, earliest);
      if (signals.length === 0) continue;
      for (const row of userRows) {
        const sentAtMs = Date.parse(row.sent_at);
        if (!Number.isFinite(sentAtMs)) continue;
        const verdict = scoreConversion(sentAtMs, signals, config, nowMs);
        if (!verdict.converted || verdict.atMs == null) continue;
        const { error: upErr } = await supabaseAdmin
          .from("reward_nudge_sends")
          .update({
            converted_at: new Date(verdict.atMs).toISOString(),
            conversion_kind: verdict.kind,
          } as never)
          .eq("id", row.id)
          .eq("user_id", userId)
          .is("converted_at", null);
        if (!upErr) converted++;
      }
    } catch (err) {
      console.error(
        `[rewards-nudges] attribution for ${userId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { scanned: rows.length, converted };
}
