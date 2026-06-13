// US-844: the SINGLE source of truth for whether the AI Support Assistant is
// live and WHO gets it. Both the engine (routes/support-assistant.ts) and the
// frontend widget (via GET /api/support/assistant/eligibility, which calls the
// helpers here) consume this module, so there is exactly one place that decides
// "is the assistant available, and is this caller eligible".
//
// Two independent dials:
//
//   1. LAUNCH KILL-SWITCH — the `support_assistant` feature flag (feature_flags
//      table, migration 00189). isSupportAssistantLaunched() reads it FAIL-CLOSED:
//      a missing row OR a DB read error resolves to DISABLED. This is the opposite
//      of the generic isFeatureEnabled() default (fail-open) on purpose — a
//      pre-launch / partially-merged assistant must NEVER expose itself because of
//      a transient blip or an un-seeded row. Flip the flag to enabled=false at any
//      time to fully disable the assistant fleet-wide within the cache TTL, no
//      redeploy.
//
//   2. TIER-ELIGIBILITY / ROLLOUT PHASE — SUPPORT_ASSISTANT_PHASE narrows WHICH
//      plans see the assistant once the kill-switch is on. The phased rollout is
//      internal -> business -> paid (all paid tiers); see SUPPORT_ASSISTANT.md.
//      Free is never eligible. Bump the phase constant as the rollout progresses.

import type { FlipdeskPlan } from "./pricing-config.ts";
import { isFeatureEnabled } from "./feature-flags.ts";

// The kill-switch flag key (also seeded into feature_flags by migration 00189).
export const SUPPORT_ASSISTANT_FLAG = "support_assistant" as const;

// Phased rollout: internal (admins only) -> business (Business tier) ->
// paid (every paid tier). "off" disables eligibility independently of the flag.
export type SupportAssistantPhase = "off" | "internal" | "business" | "paid";

// CURRENT phase. Launch target is "paid" (all paid tiers; Business is the
// priority tier per the abuse caps + escalation handling). Set to "internal" or
// "business" for a more conservative ramp BEFORE widening, then advance here.
export const SUPPORT_ASSISTANT_PHASE: SupportAssistantPhase = "paid";

// Which plans are eligible at each phase. Free is intentionally never present.
const PHASE_ELIGIBLE_PLANS: Record<
  SupportAssistantPhase,
  ReadonlySet<FlipdeskPlan>
> = {
  off: new Set<FlipdeskPlan>(),
  // internal: nobody is eligible by PLAN — access is granted by admin role
  // (see isPlanEligibleForAssistant's isAdmin path), so staff can dogfood it.
  internal: new Set<FlipdeskPlan>(),
  business: new Set<FlipdeskPlan>(["business"]),
  paid: new Set<FlipdeskPlan>(["starter", "pro", "business"]),
};

// The set of plans eligible at a given phase (defaults to the current phase).
export function eligiblePlansForPhase(
  phase: SupportAssistantPhase = SUPPORT_ASSISTANT_PHASE,
): ReadonlySet<FlipdeskPlan> {
  return PHASE_ELIGIBLE_PLANS[phase];
}

// Is THIS caller eligible by the tier policy? Platform admins are always
// eligible (so staff can use/test it in any phase, including "internal").
export function isPlanEligibleForAssistant(
  plan: FlipdeskPlan,
  opts: { isAdmin?: boolean; phase?: SupportAssistantPhase } = {},
): boolean {
  const phase = opts.phase ?? SUPPORT_ASSISTANT_PHASE;
  if (phase === "off") return opts.isAdmin === true;
  if (opts.isAdmin) return true;
  return PHASE_ELIGIBLE_PLANS[phase].has(plan);
}

// FAIL-CLOSED launch check. Unlike isFeatureEnabled()'s fail-open default, a
// missing flag row or a DB read error resolves to DISABLED here.
export function isSupportAssistantLaunched(): Promise<boolean> {
  return isFeatureEnabled(SUPPORT_ASSISTANT_FLAG, { defaultEnabled: false });
}
