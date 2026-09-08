// US-9115: the AI-action quota gate.
//
// Moved verbatim out of routes/flipdesk-ai.ts, where it had been exported and
// imported by four other ROUTE modules. It is context-free and already returns
// a typed outcome; what it was not is reachable from a lib without importing a
// route, which is the thing that blocks a connector tool from applying the same
// gate the UI applies.
//
// It is the ENABLEMENT gate and the limit resolution, plus a fast rejection for
// a caller that is already over. It is NOT the enforcement point: reserveAiAction
// (lib/ai-metering.ts) is, because a check-then-act pair races at the boundary
// and a row-locking CAS does not.

import { supabaseAdmin } from "./supabase.ts";
import {
  effectiveAiActionsUsed,
  QUOTA_EXHAUSTED_TOP_UP_MESSAGE,
  SELF_CAP_REACHED_MESSAGE,
} from "./ai-metering.ts";
import {
  ACTION_CREDIT_COSTS,
  readActionCreditBalanceSafe,
} from "./action-credits.ts";
import { effectiveAiCap } from "./plan-gate.ts";
import { effectivePlanFor } from "./grade-pricing.ts";
import { getPlanMatrix } from "./pricing-config.ts";

/** The answer to "may this owner spend an AI action, and how many are left". */
export type QuotaResult =
  | {
    ok: true;
    limit: number;
    used: number;
    /**
     * US-3138: may an exhausted allowance fall through to the Action Credit
     * wallet? False ONLY when the seller's own cap (users.ai_action_limit) is
     * the binding one.
     *
     * This flag exists because `limit` above is already min(plan, self-cap), so
     * by the time it reaches reserve_ai_action_v2 nothing can tell which cap
     * bit. Hitting your OWN limit must not silently spend money: that limit is
     * a spending guard, and answering it with a purchase is backwards. Pass the
     * whole QuotaResult to withAiAction / reserveAiActionSafe rather than
     * `quota.limit`, or this decision is lost.
     */
    allowCredits: boolean;
  }
  | { ok: false; status: 403 | 404 | 429; body: Record<string, unknown> };

// FlipDesk tier. MUST mirror PLAN_MATRIX.aiActionsPerMonth in plan-gate.ts
// (asserted by grade-pricing/plan-gate tests). Exported so AutoLister batch
// generation (flipdesk-autolister.ts) shares the exact same per-plan budget.
//
// US-2179: this is now the COMPILED FALLBACK, not the live source. checkQuota
// reads getPlanMatrix() (the operator-editable pricing_plans row) and only lands
// here when that row is missing or unreadable — same precedence plan-gate uses
// via FALLBACK_MATRIX. Keep the numbers in lockstep with FALLBACK_MATRIX;
// ai-quota_test.ts asserts it.
export const AI_ACTION_LIMITS: Record<string, number> = {
  free: 25,
  starter: 200,
  pro: 750,
  business: 2000,
};

/**
 * US-3138: may an exhausted allowance fall through to the Action Credit wallet?
 *
 * The seller's self-cap (users.ai_action_limit) only ever LOWERS the plan's
 * cap -- effectiveAiCap is min(plan, self) -- so the PLAN is the binding
 * constraint exactly when the self-cap is absent or no tighter than it. When
 * the self-cap is the tighter one, hitting it must refuse rather than spend:
 * that setting exists to stop runaway spend, and answering it with a purchase
 * is backwards.
 *
 * Pure and exported so the rule is a named thing with its own tests, rather
 * than a comparison buried in the middle of checkQuota where a later edit can
 * invert it without anyone noticing.
 */
export function creditsAllowedFor(
  planLimit: number,
  userLimit: number | null | undefined,
): boolean {
  if (userLimit == null) return true;
  return userLimit >= planLimit;
}

// Checks AI enablement + monthly cap for a user. `pending` lets a batch
// caller account for actions it is about to consume in the same request.
// Always pass the WORKSPACE OWNER's id — that's whose plan and AI quota apply.
// Exported for reuse by AutoLister batch generation (flipdesk-autolister.ts).
export async function checkQuota(
  ownerId: string,
  pending = 0
): Promise<QuotaResult> {
  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select(
      "role, flipdesk_plan, subscription_status, trial_ends_at, past_due_since, ai_enrichment_enabled, ai_actions_used_this_month, ai_actions_reset_at, ai_action_limit"
    )
    .eq("id", ownerId)
    .single();

  if (error || !user) {
    return { ok: false, status: 404, body: { error: "User not found" } };
  }
  // US-2179: the platform owner bypasses the cap, matching requireFlipdesk's
  // super_admin short-circuit and grade-billing's. Without this the owner was
  // the one account gated by plan on the AI routes while being ungated
  // everywhere else. Scoped strictly to 'super_admin' — 'admin'/'reviewer'
  // accounts stay on their plan's allowance. -1 = unlimited.
  if (user.role === "super_admin") {
    return {
      ok: true,
      limit: -1,
      used: user.ai_actions_used_this_month ?? 0,
      allowCredits: false, // unlimited never reaches the wallet
    };
  }
  if (!user.ai_enrichment_enabled) {
    return {
      ok: false,
      status: 403,
      body: {
        error:
          "AI enrichment is turned off for your account. Enable it in Settings.",
        action: "upgrade",
      },
    };
  }

  // US-386: resolve the AI cap from the FlipDesk plan (paused + expired-trial
  // fall back to Free via effectivePlanFor), then honor the user's optional
  // self-cap (users.ai_action_limit) — min(planLimit, userLimit). The old code
  // read the deprecated `plan` column (capping every paid tier at Free) and
  // selected ai_action_limit but never applied it.
  //
  // US-2179: two parity fixes with requireFlipdesk, which resolves the same
  // question for every non-AI capacity:
  //   • past_due_since is now passed, so a subscription past the dunning grace
  //     window drops to Free caps here too. Omitting it made effectivePlanFor
  //     fail OPEN (its documented no-anchor behavior) and kept full paid AI
  //     allowances for delinquent accounts on every route below.
  //   • the cap comes from getPlanMatrix() — the operator-editable, DB-backed
  //     matrix (US-587) — instead of the compiled AI_ACTION_LIMITS table. Admin
  //     edits to aiActionsPerMonth silently did not apply to AI actions, and
  //     because this `limit` is what gets handed to reserve_ai_action, the
  //     AUTHORITATIVE enforcement point was being fed the stale number.
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
    new Date(),
    user.past_due_since,
  );
  const matrix = await getPlanMatrix();
  const planConfig = matrix[effectivePlan as keyof typeof matrix];
  const planLimit = planConfig?.aiActionsPerMonth ??
    AI_ACTION_LIMITS[effectivePlan] ?? AI_ACTION_LIMITS.free!;
  const limit = effectiveAiCap(planLimit, user.ai_action_limit ?? null);
  // US-2179: the rollover predicate now lives in ai-metering.ts, shared with
  // plan-gate's readUsage and the billing-summary meter (it used to be a local
  // isPriorMonth here and simply absent in the other two readers).
  const used = effectiveAiActionsUsed(
    user.ai_actions_used_this_month,
    user.ai_actions_reset_at,
  );
  const allowCredits = creditsAllowedFor(planLimit, user.ai_action_limit);

  if (limit !== -1 && used + pending >= limit) {
    // US-3138: the allowance is gone, but that is no longer the end of it. Ask
    // the wallet before refusing, or a seller who has already paid gets a 429
    // for actions they own.
    //
    // Credits needed = (pending + 1) - (limit - used): the caller wants one
    // more beyond what it has already accounted for, and only the part that
    // does not fit in the allowance costs a credit.
    if (allowCredits) {
      const shortfall = used + pending + 1 - limit;
      const needed = shortfall * ACTION_CREDIT_COSTS.ai_action;
      const balance = await readActionCreditBalanceSafe(ownerId);
      if (balance >= needed) {
        // reserve_ai_action_v2 is still the enforcement point and will refuse
        // per-action if the wallet empties mid-batch. This only says "do not
        // stop them here".
        return { ok: true, limit, used, allowCredits };
      }
      return {
        ok: false,
        status: 429,
        body: {
          error: QUOTA_EXHAUSTED_TOP_UP_MESSAGE,
          actions_remaining: Math.max(0, limit - used),
          can_top_up: true,
          credit_balance: balance,
          credits_needed: needed,
        },
      };
    }

    // The seller's own limit is what bit. Different message, no offer to sell
    // them anything, and the number they set so they can find it in Settings.
    return {
      ok: false,
      status: 429,
      body: {
        error: SELF_CAP_REACHED_MESSAGE,
        actions_remaining: Math.max(0, limit - used),
        can_top_up: false,
        self_limit: limit,
        plan_limit: planLimit,
      },
    };
  }
  return { ok: true, limit, used, allowCredits };
}
