import { supabaseAdmin } from "./supabase.ts";
import {
  effectivePlanFor,
  INCLUDED_STANDARD_PER_MONTH,
  suggestPack,
  TIER_CREDIT_COST,
  TIER_PRICE_CENTS,
  type GradeTier,
} from "./grade-pricing.ts";

// ── Canonical grade billing (US-207) ─────────────────────────────
//
// Single source of truth for how a grade is paid for. Every grading entry
// point — the web /api/grade/submit flow, the FlipDesk bulk grading bridge,
// and the public API — MUST charge through runPaymentPrecedence() so caps,
// included grades, and credits stay consistent. The pure pricing math lives in
// grade-pricing.ts (unit-tested); this module adds the DB-coupled charging.

// Re-export the pure pricing surface so existing importers of grade-billing.ts
// don't need to change.
export {
  computeBatchCredits,
  effectivePlanFor,
  GRADE_TIERS,
  INCLUDED_STANDARD_PER_MONTH,
  isGradeTier,
  suggestPack,
  TIER_CREDIT_COST,
  TIER_PRICE_CENTS,
  tierPriceDollars,
} from "./grade-pricing.ts";
export type { GradeTier } from "./grade-pricing.ts";

export type PrecedenceResult =
  | { paid: true; method: "included"; newIncludedUsed: number }
  | { paid: true; method: "credits"; newBalance: number }
  | {
      paid: false;
      checkoutRequired: true;
      suggestedTier: GradeTier;
      suggestedPack: { credits: number; priceCents: number } | null;
      tierPriceCents: number;
    };

// Picks the cheapest valid payment path for a tier on a submission:
//   (1) included monthly grade (Standard only)
//   (2) debit credits
//   (3) checkoutRequired — caller opens Stripe Checkout
//
// Charges the user/workspace-owner identified by userId. Returns a
// discriminated union the route handlers and frontend can act on.
export async function runPaymentPrecedence(
  userId: string,
  submissionId: string,
  tier: GradeTier,
): Promise<PrecedenceResult> {
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select(
      "flipdesk_plan, grades_used_this_month, grade_reset_at, grade_credit_balance, subscription_status, trial_ends_at",
    )
    .eq("id", userId)
    .single();

  if (userError || !user) {
    throw new Error(`USER_NOT_FOUND: ${userId}`);
  }

  // Paused subscriptions AND expired trials (US-383) fall back to Free caps.
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
  );
  const includedCap = INCLUDED_STANDARD_PER_MONTH[effectivePlan] ?? 0;

  // Roll over the included counter if we crossed the reset boundary. (Normal
  // case is the invoice.payment_succeeded webhook resets it on cycle, but
  // Free users have no invoice — they rely on this clock check.)
  let includedUsed = user.grades_used_this_month;
  const resetAt = new Date(user.grade_reset_at);
  const rolledOver = resetAt <= new Date();
  if (rolledOver) includedUsed = 0;

  // ─ (1) Try included grades — Standard only ─
  if (tier === "standard" && includedUsed < includedCap) {
    // Optimistic concurrency: only update if grades_used_this_month hasn't
    // changed since we read it. If another submission landed in between,
    // the update affects 0 rows and we fall through.
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1);
    nextReset.setDate(1);
    nextReset.setHours(0, 0, 0, 0);

    const updatePayload: Record<string, unknown> = {
      grades_used_this_month: includedUsed + 1,
    };
    if (rolledOver) {
      updatePayload.grade_reset_at = nextReset.toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from("users")
      .update(updatePayload)
      .eq("id", userId)
      .eq(
        "grades_used_this_month",
        rolledOver ? user.grades_used_this_month : includedUsed,
      )
      .select("id");

    if (!error && data && data.length > 0) {
      await supabaseAdmin
        .from("submissions")
        .update({ payment_status: "included", paid_at: new Date().toISOString() })
        .eq("id", submissionId);
      // Ledger row for audit, balance unchanged.
      await supabaseAdmin.from("grade_credit_transactions").insert({
        user_id: userId,
        delta: 0,
        reason: "included_grant",
        balance_after: user.grade_credit_balance,
        submission_id: submissionId,
        notes: `Included Standard grade #${includedUsed + 1}/${includedCap} on ${effectivePlan}`,
      });
      return { paid: true, method: "included", newIncludedUsed: includedUsed + 1 };
    }
    // CAS failed — fall through to credits.
  }

  // ─ (2) Try credits ─
  const cost = TIER_CREDIT_COST[tier];
  if (user.grade_credit_balance >= cost) {
    const { data: newBalance, error: debitError } = await supabaseAdmin.rpc(
      "debit_grade_credits",
      {
        p_user_id: userId,
        p_credits: cost,
        p_submission_id: submissionId,
        p_notes: `${tier} grade — ${cost} credit${cost === 1 ? "" : "s"}`,
      },
    );

    if (debitError) {
      // INSUFFICIENT_CREDITS race — fall through to checkout.
      const msg = (debitError.message ?? "").toString();
      if (!msg.includes("INSUFFICIENT_CREDITS")) {
        throw new Error(`DEBIT_FAILED: ${msg}`);
      }
    } else {
      await supabaseAdmin
        .from("submissions")
        .update({ payment_status: "credits", paid_at: new Date().toISOString() })
        .eq("id", submissionId);
      return {
        paid: true,
        method: "credits",
        newBalance:
          typeof newBalance === "number"
            ? newBalance
            : user.grade_credit_balance - cost,
      };
    }
  }

  // ─ (3) Checkout required ─
  return {
    paid: false,
    checkoutRequired: true,
    suggestedTier: tier,
    suggestedPack: suggestPack(cost),
    tierPriceCents: TIER_PRICE_CENTS[tier],
  };
}
