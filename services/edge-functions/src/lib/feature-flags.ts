// Server-side feature flags / kill-switches (US-507) + targeting v2 (US-886).
//
// isFeatureEnabled(key, opts) reads feature_flags (migrations 00096 + 00210)
// with a short in-memory cache so flipping a flag in the DB takes effect within
// ~CACHE_TTL across the fleet WITHOUT a redeploy. Used to gate expensive /
// external-dependency flows (grading, autolister, content AI, repricing) so they
// can be switched off during an outage or cost spike.
//
// v2 (US-886) adds optional targeting on top of the global on/off kill-switch:
//   • rollout_percentage — canary % of users, bucketed by a STABLE hash of
//     key+userId (deterministic: the same user is always in or out for a flag).
//   • plan_targets        — restrict to specific user plans.
//   • user_allow/deny     — per-user always-on / always-off overrides.
//   • starts_at/ends_at   — scheduled enable/disable window.
//
// PRECEDENCE (resolveFlagRule): a global kill (enabled=false) ALWAYS wins, then
// the schedule window, then the deny list, then the allow list, then plan
// targeting, then the percentage bucket.
//
// FAIL-OPEN for availability: a missing flag row OR a DB read error defaults to
// ENABLED — a kill-switch should only ever turn something OFF when an operator
// explicitly sets enabled=false, never because of a transient DB blip or a
// fresh deploy that hasn't seeded the row.
//
// ── US-2406: plan targeting is resolved HERE, not by the caller ──
//
// v2 shipped plan_targets as `if (opts.plan && …)` — it applied only when the
// CALLER supplied a plan, and no runtime caller ever did. Every isFeatureEnabled
// call site passed nothing or `{ userId }`, so `opts.plan` was always undefined,
// the plan check was skipped, and a rule an operator had limited to Pro fell
// straight through to the percentage rollout. The failure was fail-OPEN and
// silent: the admin "who does this reach" preview was the only code that passed
// a plan, so the control looked like it worked while production ignored it.
//
// The shape chosen (AC1): isFeatureEnabled RESOLVES the plan itself from
// opts.userId — one cached lookup, so a call site only has to know who it is
// acting for, never what they pay. Two rules keep it honest:
//
//   • FAIL CLOSED (AC2). A rule that names plans is not satisfied by a caller
//     who cannot present one. No userId, an unreadable users row, or a missing
//     user all resolve OFF and log `feature_flag.plan_unresolved` — never the
//     old silent fall-through.
//   • PLAN_TARGETABLE_FLAGS (below) is the list of keys whose call sites can
//     ALL resolve a user. The admin rule editor refuses plan_targets on any
//     other key, so a cron-only flag can't be given targeting that would only
//     ever switch it off. The runtime fail-closed is the backstop for a direct
//     SQL write.
//
// The plan resolved is the EFFECTIVE plan (effectivePlanFor) — the same one the
// caps, gates and MRR read — so a canceled Pro targets as Free, and a US-2398
// comp targets as the tier it was granted.

import { supabaseAdmin } from "./supabase.ts";
import { logEvent } from "./observability.ts";
import { effectivePlanFor } from "./grade-pricing.ts";

export type FeatureKey =
  | "grading"
  // US-2845: background comp condition reads. Ships DISABLED (migration 00667)
  // because the US-2842 calibration spike has not returned a GO. It doubles as
  // the kill target for the comp_read AI budget at action 'kill', so the gate
  // and the guardrail are one switch and there is no second place to look.
  | "comp_read"
  | "autolister"
  | "content_ai"
  | "repricing"
  | "authenticity_addon"
  // US-1296: Forensic Grade add-on (paid high-resolution defect-zoom
  // re-analysis). Kill-switch on top of the tier/opt-in/retention gate; the
  // route checks it before honoring the add-on so it can be disabled platform-
  // wide without a redeploy.
  | "forensic_grade"
  | "support_assistant"
  // US-1104: Garment Passport resale-value & depreciation forecast (Scout). An
  // ops kill-switch on top of the compPulls plan gate; fail-open (default on).
  | "passport_forecast"
  // US-943: autonomous trial-conversion drip engine. The /api/drip/tick cron
  // gates on this; the admin builder's "kill" flips it off so every replica
  // hard-stops within the flag cache TTL.
  | "trial_conversion_drip"
  // US-930: autonomous newsletter program. The newsletter sender checks this;
  // the admin console's master kill-switch flips it off to halt all newsletter
  // sends instantly platform-wide (within the flag cache TTL).
  | "newsletter"
  // US-929: lifecycle email-journey engine (welcome / trial-nurture / win-back).
  // The /api/jobs/journey-tick cron gates on this; flipping it off halts every
  // journey send fleet-wide within the flag cache TTL. Individual journeys also
  // gate on email_journeys.enabled (all seeded off).
  | "lifecycle_journeys"
  // US-1869: Inventory Equity liquidation-value surface. Ops kill-switch on top
  // of the base flipdesk gate; fail-open (default on) so the /api/flipdesk/equity
  // route can be disabled platform-wide without a redeploy.
  | "inventory_equity"
  // US-1762: grade from a short walk-around clip (server-side frame extraction).
  // Every frame is a Vision call billed against ONE grade, so this is also what
  // the video_grading ai_budgets row flips off on a hard monthly breach
  // (resolveFlagKey maps the feature 1:1 to this key). Fail-open (default on).
  | "video_grading"
  // US-1848: master switch for TANGIBLE reward payouts (free grade credits,
  // subscription discounts, discounted grading). Read fail-CLOSED
  // (defaultEnabled: false) — the one flag here that must not fail open, because
  // failing open would pay out real value during an outage. Cosmetic rewards
  // (XP, levels, badges, streaks) are unaffected by it.
  | "rewards_tangible"
  // US-1852: master switch for quests + time-boxed community challenges. Read
  // fail-OPEN (defaultEnabled: true), deliberately the opposite of the flag
  // above: a quest pays XP, which is free status, so an outage that silently
  // froze everyone's quest progress would do more damage than one that kept
  // paying it. Individual quests carry their own `enabled` column — retire one
  // quest with that, not the whole program with this.
  | "rewards_quests"
  // US-9127: the Claude connector's runtime kill switch, on top of the
  // MCP_ENABLED env var. The env var is the deploy-time default; this is the
  // stop button, because changing an env var means a redeploy and a rollback
  // plan that takes minutes is not one for a surface that publishes listings.
  //
  // Fail-OPEN (defaultEnabled: true) like every other ops kill switch here: an
  // outage in the flag store must not take the connector down with it. The
  // thing that must fail CLOSED on this surface is the ALLOWANCE, and that one
  // does.
  | "claude_connector";

// US-2406: the flags whose EVERY call site can name the user it is acting for,
// and therefore the only ones where plan targeting can mean anything.
//
// Membership is a property of the call sites, not of the feature. A key belongs
// here when no caller evaluates it platform-wide; add one only after checking
// that every `isFeatureEnabled("<key>")` in routes/ passes a userId.
//
// Excluded, and why — each has at least one caller with no user in hand:
//   • repricing          — handleRepriceScanCron scans every owner in one call.
//   • inventory_equity   — handleEquitySnapshotCron, same shape.
//   • newsletter,
//     lifecycle_journeys,
//     trial_conversion_drip — cron senders; the whole program is the unit.
//   • support_assistant  — isSupportAssistantLaunched() is a launch check.
// For those, targeting is refused at the admin layer instead of failing closed
// at 3am inside a cron.
export const PLAN_TARGETABLE_FLAGS: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  "grading",
  "autolister",
  "content_ai",
  "authenticity_addon",
  "forensic_grade",
  "passport_forecast",
  // US-1762: only /grade/submit evaluates it, and it always has the workspace
  // owner in hand, so plan targeting is meaningful here.
  "video_grading",
  // US-1848: grantTangibleRewards is always acting for one named user, so a
  // staged rollout (or a per-plan restriction) on reward payouts is honourable.
  "rewards_tangible",
  // US-1852: loadQuestsState is only ever called for the authed reader, so a
  // staged rollout of quests is honourable too.
  "rewards_quests",
]);

/** True when plan targeting on `key` can be honoured by all of its callers. */
export function isPlanTargetable(key: string): boolean {
  return PLAN_TARGETABLE_FLAGS.has(key as FeatureKey);
}

// The full targeting rule for one flag (one feature_flags row).
export interface FeatureFlagRule {
  enabled: boolean;
  rollout_percentage: number;
  plan_targets: string[];
  user_allow: string[];
  user_deny: string[];
  starts_at: string | null;
  ends_at: string | null;
}

export interface FeatureFlagOpts {
  /**
   * Stable user id — required for percentage rollout, allow/deny overrides AND
   * (US-2406) plan targeting, which is resolved from it. Pass it wherever the
   * call is made on behalf of one user.
   */
  userId?: string;
  /**
   * The caller's EFFECTIVE plan. Normally left unset: isFeatureEnabled resolves
   * it from `userId` when the rule needs one (US-2406). Supply it only when the
   * plan is already known and no lookup should happen — the admin preview does,
   * so it can score a whole sample of users without a query each.
   */
  plan?: string;
  /**
   * Fail behaviour for a MISSING row or a DB read error. Defaults to true
   * (fail-open) for availability of established flows; pass false for a
   * pre-launch flow that must stay OFF unless an operator explicitly enables it
   * (the support assistant, US-844).
   */
  defaultEnabled?: boolean;
  /** Evaluation time (epoch ms) — for the schedule window. Defaults to now. */
  now?: number;
}

const CACHE_TTL_MS = 30_000;
// Cache the raw RULE per key (not a resolved boolean) so per-user resolution can
// run on each call without an extra DB read. `rule === null` = missing row / read
// error (the caller's defaultEnabled then applies).
const cache = new Map<string, { rule: FeatureFlagRule | null; expires: number }>();

const RULE_SELECT =
  "enabled, rollout_percentage, plan_targets, user_allow, user_deny, starts_at, ends_at";

function normalizeRule(d: Record<string, unknown>): FeatureFlagRule {
  const pct = typeof d.rollout_percentage === "number" ? d.rollout_percentage : 100;
  return {
    // enabled is `not null default true`; treat anything but an explicit false
    // as enabled so a legacy row (pre-00210) without the column still works.
    enabled: d.enabled !== false,
    rollout_percentage: Math.max(0, Math.min(100, pct)),
    plan_targets: Array.isArray(d.plan_targets) ? (d.plan_targets as string[]) : [],
    user_allow: Array.isArray(d.user_allow) ? (d.user_allow as string[]) : [],
    user_deny: Array.isArray(d.user_deny) ? (d.user_deny as string[]) : [],
    starts_at: typeof d.starts_at === "string" ? d.starts_at : null,
    ends_at: typeof d.ends_at === "string" ? d.ends_at : null,
  };
}

// Stable, dependency-free bucket in [0, 100): FNV-1a 32-bit over the input. The
// same (key, userId) always maps to the same bucket, so a user never flickers
// in/out as the cache refreshes or replicas differ.
export function stableBucket(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

// Pure resolution of a rule for one caller. Exported so the admin "who this
// resolves to" preview runs the EXACT same logic against the proposed rule, and
// so it is unit-testable without a DB.
export function resolveFlagRule(
  key: string,
  rule: FeatureFlagRule,
  opts: FeatureFlagOpts = {},
): boolean {
  // 1. Global kill always wins (AC#4).
  if (!rule.enabled) return false;

  // 2. Schedule window applies to everyone.
  const now = opts.now ?? Date.now();
  if (rule.starts_at) {
    const t = Date.parse(rule.starts_at);
    if (Number.isFinite(t) && now < t) return false;
  }
  if (rule.ends_at) {
    const t = Date.parse(rule.ends_at);
    if (Number.isFinite(t) && now > t) return false;
  }

  const userId = opts.userId;
  // 3. Per-user deny (after kill/schedule, before everything else).
  if (userId && rule.user_deny.includes(userId)) return false;
  // 4. Per-user allow overrides plan + percentage.
  if (userId && rule.user_allow.includes(userId)) return true;

  // 5. Plan targeting. Empty list = all plans, so an untargeted rule is
  // unaffected. A rule that DOES name plans applies to every caller: US-2406
  // made the missing-plan case FAIL CLOSED rather than skip the check, because
  // skipping it is what let a Pro-only flag serve the whole user base. Callers
  // reach this with no plan only when isFeatureEnabled could not resolve one —
  // it logs `feature_flag.plan_unresolved` there, so an off here is traceable.
  if (rule.plan_targets.length > 0 && !(opts.plan && rule.plan_targets.includes(opts.plan))) {
    return false;
  }

  // 6. Percentage rollout — only meaningful for a userId-aware call. A no-userId
  // kill-switch caller can't be bucketed, so it is treated as targeted-in
  // (unchanged legacy behaviour). Operators using % rollout pass a userId.
  if (!userId) return true;
  if (rule.rollout_percentage >= 100) return true;
  if (rule.rollout_percentage <= 0) return false;
  return stableBucket(`${key}:${userId}`) < rule.rollout_percentage;
}

// Load + cache the raw rule for a key. Returns null on a missing row or read
// error (the caller's defaultEnabled then applies).
async function dbLoadRule(key: string): Promise<FeatureFlagRule | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.rule;

  let rule: FeatureFlagRule | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from("feature_flags")
      .select(RULE_SELECT)
      .eq("key", key)
      .maybeSingle();
    if (error) {
      logEvent("warn", "feature_flag.read_error", { key });
    } else if (data) {
      rule = normalizeRule(data as Record<string, unknown>);
    }
    // No row → stays null (caller's defaultEnabled applies, fail-open by default).
  } catch {
    logEvent("warn", "feature_flag.read_error", { key });
  }

  cache.set(key, { rule, expires: now + CACHE_TTL_MS });
  return rule;
}

// ── US-2406: effective-plan resolution for plan-targeted rules ──
//
// Cached on the same 30s clock as the rule itself, so a targeted flag costs at
// most one extra users read per user per TTL — and zero for the overwhelmingly
// common untargeted rule, which never asks. Bounded because this process is
// long-lived and the key space is "every user who hit a targeted flag": past
// the cap the whole map is dropped rather than evicted one by one, which costs
// a re-read and cannot leak.
const PLAN_CACHE_MAX = 5_000;
// `plan === null` = not resolvable (missing user / read error). Cached like any
// other answer so a hot loop against a broken read doesn't hammer the DB; the
// consequence is bounded by the TTL.
const planCache = new Map<string, { plan: string | null; expires: number }>();

async function dbLoadEffectivePlan(userId: string): Promise<string | null> {
  const now = Date.now();
  const hit = planCache.get(userId);
  if (hit && hit.expires > now) return hit.plan;

  let plan: string | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
      .eq("id", userId)
      .maybeSingle();
    if (error) {
      logEvent("warn", "feature_flag.plan_read_error", { userId });
    } else if (data) {
      const u = data as {
        flipdesk_plan: string | null;
        subscription_status: string | null;
        trial_ends_at: string | null;
        past_due_since: string | null;
      };
      // The same resolution the caps and gates use — a lapsed Pro targets as
      // Free, a comp targets as its granted tier.
      plan = effectivePlanFor(
        u.flipdesk_plan ?? "free",
        u.subscription_status,
        u.trial_ends_at,
        new Date(now),
        u.past_due_since,
      );
    }
  } catch {
    logEvent("warn", "feature_flag.plan_read_error", { userId });
  }

  if (planCache.size >= PLAN_CACHE_MAX) planCache.clear();
  planCache.set(userId, { plan, expires: now + CACHE_TTL_MS });
  return plan;
}

/**
 * The two DB reads isFeatureEnabled depends on. Swappable so US-2406's
 * behaviour can be pinned through the REAL entry point rather than only through
 * the pure resolveFlagRule helper — testing the helper is exactly what let the
 * defect ship, since the helper was correct and production never fed it a plan.
 * Mirrors the injectable-deps pattern in lib/plan-gate.ts.
 */
export interface FeatureFlagDeps {
  loadRule(key: string): Promise<FeatureFlagRule | null>;
  loadEffectivePlan(userId: string): Promise<string | null>;
}

const defaultDeps: FeatureFlagDeps = {
  loadRule: dbLoadRule,
  loadEffectivePlan: dbLoadEffectivePlan,
};
let deps: FeatureFlagDeps = defaultDeps;

export const __testing = {
  /** Replace one or both readers. Returns a restore function. */
  setDeps(partial: Partial<FeatureFlagDeps>): () => void {
    const previous = deps;
    deps = { ...deps, ...partial };
    clearFeatureFlagCache();
    return () => {
      deps = previous;
      clearFeatureFlagCache();
    };
  },
  resetDeps(): void {
    deps = defaultDeps;
    clearFeatureFlagCache();
  },
};

export async function isFeatureEnabled(
  key: FeatureKey,
  opts: FeatureFlagOpts = {},
): Promise<boolean> {
  const failDefault = opts.defaultEnabled ?? true;
  const rule = await deps.loadRule(key);
  if (rule === null) {
    // Missing row / read error → fail to the caller's default.
    if (!failDefault) logEvent("info", "feature_flag.disabled_hit", { key });
    return failDefault;
  }

  // US-2406: resolve the plan the rule is about to be judged against. Only when
  // the rule actually names plans — an untargeted flag stays a single cached
  // read, exactly as before.
  let resolved = opts;
  if (rule.plan_targets.length > 0 && opts.plan === undefined) {
    const plan = opts.userId ? await deps.loadEffectivePlan(opts.userId) : null;
    if (plan === null) {
      // The rule WILL now fail closed. Say why, loudly enough to find: either
      // the call site is platform-wide (the key should not be plan-targetable —
      // see PLAN_TARGETABLE_FLAGS) or the users read failed.
      logEvent("warn", "feature_flag.plan_unresolved", {
        key,
        reason: opts.userId ? "lookup_failed" : "no_user_id",
      });
    }
    resolved = { ...opts, plan: plan ?? undefined };
  }

  const enabled = resolveFlagRule(key, rule, resolved);
  if (!enabled) logEvent("info", "feature_flag.disabled_hit", { key });
  return enabled;
}

// Clear the cache (used after an admin toggle so the change is instant for the
// replica that handled the toggle; other replicas pick it up within the TTL).
// Drops the resolved-plan cache too: a rule edit can turn an untargeted flag
// into a targeted one, and a stale plan would decide the first TTL of it.
export function clearFeatureFlagCache(): void {
  cache.clear();
  planCache.clear();
}

// Standard 503 body for a disabled flow.
export function featureDisabledBody(key: FeatureKey): { error: string; code: string } {
  return {
    error: `The ${key} feature is temporarily unavailable. Please try again shortly.`,
    code: "FEATURE_DISABLED",
  };
}

// Hono middleware that 503s a whole route group when its flag is off. Use for
// flows with many endpoints (e.g. content AI) instead of gating each handler.
//
// US-2406: forwards the request's userId when the auth middleware has set one,
// so a route group gated this way honours plan targeting and percentage rollout
// like any hand-written call site. Read defensively — the middleware is also
// mounted ahead of unauthenticated paths, and a missing userId simply means the
// rule is evaluated without one.
export function featureGate(key: FeatureKey) {
  return async (
    c: { json: (body: unknown, status?: number) => Response },
    next: () => Promise<void>,
  ): Promise<Response | void> => {
    const ctx = c as { get?: (k: string) => unknown };
    const raw = typeof ctx.get === "function" ? ctx.get("userId") : undefined;
    const userId = typeof raw === "string" && raw ? raw : undefined;
    if (!(await isFeatureEnabled(key, { userId }))) {
      return c.json(featureDisabledBody(key), 503);
    }
    await next();
  };
}
