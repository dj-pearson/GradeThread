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
// targeting, then the percentage bucket. Percentage only gates a call that
// SUPPLIES a userId — so existing kill-switch callers that pass no userId behave
// EXACTLY as before (global enabled + schedule only).
//
// PLAN TARGETING IS RESOLVED BY isFeatureEnabled, NOT BY THE CALLER (US-2406).
// resolveFlagRule stays pure and still only applies plan_targets when a plan is
// supplied; that used to mean the caller had to supply one, and none ever did,
// so every plan-targeted rule was live for everyone. isFeatureEnabled now looks
// the plan up from userId when — and only when — a rule actually targets plans,
// and FAILS CLOSED if it cannot resolve one. That is the single exception to
// fail-open below, and it is deliberate: fail-open on a restriction serves the
// people the operator excluded.
//
// FAIL-OPEN for availability: a missing flag row OR a DB read error defaults to
// ENABLED — a kill-switch should only ever turn something OFF when an operator
// explicitly sets enabled=false, never because of a transient DB blip or a
// fresh deploy that hasn't seeded the row.

import { supabaseAdmin } from "./supabase.ts";
import { logEvent } from "./observability.ts";
import { effectivePlanFor } from "./grade-pricing.ts";

export type FeatureKey =
  | "grading"
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
  | "inventory_equity";

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
  /** Stable user id — required for percentage rollout + allow/deny overrides. */
  userId?: string;
  /**
   * The caller's EFFECTIVE plan. Optional: US-2406 made isFeatureEnabled resolve
   * it from `userId` when a rule actually targets plans, because leaving it to
   * the caller meant it was never supplied and plan targeting never applied.
   * Pass it only to skip that lookup when you already hold the value.
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

// US-2406: the effective plan per user, same TTL as the rule cache.
//
// Only consulted when a rule ACTUALLY targets plans, so the common case — every
// kill-switch call in the fleet — still does zero extra reads. A flag with plan
// targeting costs one bounded lookup per user per 30s.
const planCache = new Map<string, { plan: string | null; expires: number }>();

const PLAN_SELECT =
  "flipdesk_plan, subscription_status, trial_ends_at, past_due_since";

/**
 * The plan a targeting rule is matched against: EFFECTIVE, not raw.
 *
 * A lapsed Pro whose caps have already dropped to Free must not be targeted as
 * Pro — the flag would hand them a feature the plan gate then refuses, which is
 * a worse experience than never offering it. This is the same resolution
 * entitlements use (effectivePlanFor), so a targeted flag and the gate behind it
 * can never disagree about what tier someone is on.
 *
 * Returns null when the user cannot be resolved. The caller treats that as
 * fail-CLOSED, deliberately: an operator who restricted a flag to paying tiers
 * gets "nobody" rather than "everybody" when we cannot tell who is asking.
 */
export async function resolveEffectivePlan(userId: string): Promise<string | null> {
  const now = Date.now();
  const hit = planCache.get(userId);
  if (hit && hit.expires > now) return hit.plan;

  let plan: string | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select(PLAN_SELECT)
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

  // A failed read is NOT cached — otherwise one blip locks a user out of every
  // targeted flag for the full TTL.
  if (plan !== null) planCache.set(userId, { plan, expires: now + CACHE_TTL_MS });
  return plan;
}
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

  // 5. Plan targeting — only when a plan is supplied. Empty list = all plans.
  if (opts.plan && rule.plan_targets.length > 0 && !rule.plan_targets.includes(opts.plan)) {
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
async function loadRule(key: string): Promise<FeatureFlagRule | null> {
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

/**
 * Injection seam, mirroring plan-gate.ts's PlanGateDeps.
 *
 * Both halves are here on purpose. Before US-2406 the only tests that could run
 * against isFeatureEnabled were the ones where the DB read FAILED — a dead
 * connection yields a null rule and the function returns the caller's default
 * before any targeting runs. So every targeting test had to go through the pure
 * resolveFlagRule instead, which is exactly why a suite full of green
 * plan-targeting assertions sat on top of a production path that never applied
 * plan targeting at all.
 */
export interface FeatureFlagDeps {
  loadPlan: (userId: string) => Promise<string | null>;
  loadRule?: (key: FeatureKey) => Promise<FeatureFlagRule | null>;
}

const defaultDeps: FeatureFlagDeps = { loadPlan: resolveEffectivePlan };

export async function isFeatureEnabled(
  key: FeatureKey,
  opts: FeatureFlagOpts = {},
  deps: FeatureFlagDeps = defaultDeps,
): Promise<boolean> {
  const failDefault = opts.defaultEnabled ?? true;
  const rule = await (deps.loadRule ?? loadRule)(key);
  if (rule === null) {
    // Missing row / read error → fail to the caller's default.
    if (!failDefault) logEvent("info", "feature_flag.disabled_hit", { key });
    return failDefault;
  }

  // US-2406: resolve the plan HERE rather than requiring every call site to.
  //
  // resolveFlagRule only applies plan_targets when a plan is supplied, and no
  // runtime caller ever supplied one — so a rule restricted to a paying tier
  // fell straight through to the percentage rollout and was live for everyone.
  // The failure was silent, fail-OPEN, and looked correct in the admin preview,
  // which was the only code that passed a plan.
  //
  // The lookup runs ONLY when a rule actually targets plans, so the fleet's
  // kill-switch calls are unchanged.
  let resolved = opts;
  if (rule.plan_targets.length > 0 && opts.plan === undefined) {
    const plan = opts.userId ? await deps.loadPlan(opts.userId) : null;
    if (plan === null) {
      // FAIL CLOSED (AC2). An operator restricted this flag to specific tiers;
      // serving a caller we cannot place is the one outcome they did not ask
      // for. Logged with a reason so it is distinguishable from a normal miss —
      // "off for everyone" with no explanation is how the original bug hid.
      logEvent("info", "feature_flag.plan_unresolved", {
        key,
        hasUserId: Boolean(opts.userId),
      });
      return false;
    }
    resolved = { ...opts, plan };
  }

  const enabled = resolveFlagRule(key, rule, resolved);
  if (!enabled) logEvent("info", "feature_flag.disabled_hit", { key });
  return enabled;
}

// Clear the cache (used after an admin toggle so the change is instant for the
// replica that handled the toggle; other replicas pick it up within the TTL).
export function clearFeatureFlagCache(): void {
  cache.clear();
  // US-2406: the plan cache too. An admin toggling a rule's plan targets is the
  // exact moment a stale per-user plan would resolve against the new list.
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
export function featureGate(key: FeatureKey) {
  return async (
    c: { json: (body: unknown, status?: number) => Response },
    next: () => Promise<void>,
  ): Promise<Response | void> => {
    if (!(await isFeatureEnabled(key))) {
      return c.json(featureDisabledBody(key), 503);
    }
    await next();
  };
}
