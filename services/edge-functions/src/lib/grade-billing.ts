import { supabaseAdmin } from "./supabase.ts";
import {
  effectivePlanFor,
  INCLUDED_STANDARD_PER_MONTH,
  type GradeTier,
} from "./grade-pricing.ts";
import { type FlipdeskPlan, getGradePricing, getPlanMatrix } from "./pricing-config.ts";
import { discountedCents, loadActiveDiscount } from "./rewards-tangible.ts";
import {
  performPaymentPrecedence,
  type PrecedenceIO,
} from "./grade-precedence.ts";

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
  bulkChargeKey,
  computeBatchCredits,
  CREDIT_PACKS,
  effectivePlanFor,
  GRADE_TIERS,
  INCLUDED_STANDARD_PER_MONTH,
  isGradeTier,
  resolveIncludedCap,
  suggestPack,
  suggestPackFrom,
  TIER_CREDIT_COST,
  TIER_PRICE_CENTS,
  TIER_SLA_HOURS,
  tierPriceDollars,
  tierSupportsAuthenticityAddon,
  tierSupportsForensicAddon,
  forensicAddonEnabled,
} from "./grade-pricing.ts";
export type { GradeTier } from "./grade-pricing.ts";

// ── Included-grade CAS claim with bounded retries (US-782) ───────────
//
// Claiming a monthly included grade is an optimistic compare-and-swap on
// users.grades_used_this_month. Under concurrent submissions, the loser of a CAS
// used to fall straight through to credits/checkout — even when included grades
// remained (cap=3, two concurrent submits: the winner claims used 0→1; the loser
// read used=0, its CAS misses, and it paid with credits despite 2 included left).
//
// This re-reads fresh usage on a miss and RETRIES the claim (bounded), so the
// included allowance is fully consumed before falling back. Each retry is itself
// a CAS, so two retriers can't both claim the same slot (no double-consume); the
// bound + the cap guard make livelock impossible. Pure + injectable so the race
// is unit-testable without a DB.

export interface IncludedClaimDeps {
  // Attempt the CAS: set grades_used_this_month from `expectedDbUsed` to
  // (rolledOver ? 0 : expectedDbUsed) + 1, conditioned on the column still
  // equalling `expectedDbUsed`. Returns claimed=true iff exactly one row updated.
  casClaim: (expectedDbUsed: number, rolledOver: boolean) => Promise<{ claimed: boolean }>;
  // Re-read the live counter after a miss: the actual column value + whether the
  // reset boundary has passed (rollover).
  reread: () => Promise<{ dbUsed: number; rolledOver: boolean } | null>;
}

export interface IncludedClaimResult {
  claimed: boolean;
  // The new LOGICAL used count after a successful claim (for newIncludedUsed);
  // on failure, the last-known logical used (≥ cap or after a dropped re-read).
  newUsed: number;
}

export async function claimIncludedGrade(
  initialDbUsed: number,
  initialRolledOver: boolean,
  cap: number,
  deps: IncludedClaimDeps,
  maxRetries = 3,
): Promise<IncludedClaimResult> {
  let dbUsed = initialDbUsed;
  let rolledOver = initialRolledOver;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const logicalUsed = rolledOver ? 0 : dbUsed;
    if (logicalUsed >= cap) return { claimed: false, newUsed: logicalUsed };

    const { claimed } = await deps.casClaim(dbUsed, rolledOver);
    if (claimed) return { claimed: true, newUsed: logicalUsed + 1 };

    // CAS miss — another submission moved the counter. Out of retries → give up.
    if (attempt === maxRetries) return { claimed: false, newUsed: logicalUsed };

    const fresh = await deps.reread();
    if (!fresh) return { claimed: false, newUsed: logicalUsed };
    dbUsed = fresh.dbUsed;
    rolledOver = fresh.rolledOver;
  }
  return { claimed: false, newUsed: rolledOver ? 0 : dbUsed };
}

export type PrecedenceResult =
  | { paid: true; method: "included"; newIncludedUsed: number }
  | { paid: true; method: "credits"; newBalance: number }
  | {
      paid: false;
      checkoutRequired: true;
      suggestedTier: GradeTier;
      suggestedPack: { credits: number; priceCents: number } | null;
      /** What the grade will actually cost — already discounted (US-1853). */
      tierPriceCents: number;
      /** Undiscounted list price, present only when a reward discount applied. */
      listPriceCents?: number;
      /** The reward discount applied to tierPriceCents, in whole percent. */
      rewardDiscountPercent?: number;
      /** The milestone that granted it, for the quote's explanatory line. */
      rewardMilestoneKey?: string;
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
  /**
   * US-2289 AC2: optional dedupe key for the CREDIT debit.
   *
   * A batch job that is reclaimed after a stale lease re-enters this path. The
   * root fix stops it creating a second submission, but passing the job's own
   * id here makes the charge itself idempotent at the database — the second
   * call finds the ledger row, debits nothing and returns the current balance.
   * Omitted (the default) the behaviour is exactly as before.
   */
  idempotencyKey?: string | null,
): Promise<PrecedenceResult> {
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select(
      "role, flipdesk_plan, grades_used_this_month, grade_reset_at, included_grades_this_period, grade_credit_balance, subscription_status, trial_ends_at, past_due_since",
    )
    .eq("id", userId)
    .single();

  if (userError || !user) {
    throw new Error(`USER_NOT_FOUND: ${userId}`);
  }

  // US-2345 AC1: the SEQUENCE — branch order, the tenant-scoped paid-flip, the
  // credit-race fall-through and the checkout quote — lives in
  // lib/grade-precedence.ts so every branch is reachable without a database.
  // Everything below is the IO adapter binding it to the service-role client,
  // and it is the ONLY place this path touches that client. A guard test pins
  // that there is exactly one of each write.
  //
  // The inputs are resolved HERE rather than inside the sequence because both
  // come from reads this function already made; the sequence owns the ORDER and
  // the failure handling, not the derivation.
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
    new Date(),
    user.past_due_since,
  );

  // US-885: tier prices, credit cost, and credit packs are DB-driven
  // (pricing_config) with the compiled constants as fallback.
  const pricing = await getGradePricing();

  // Roll over the included counter if we crossed the reset boundary. The normal
  // case is the invoice.payment_succeeded webhook resetting it on cycle, but
  // Free users have no invoice — they rely on this clock check.
  const rolledOver = new Date(user.grade_reset_at) <= new Date();

  // US-885 (AC#2/#5): the cap comes from the live, operator-editable plan
  // matrix; the per-period snapshot then governs WITHIN a period so an admin
  // edit never changes a period already in progress. INCLUDED_STANDARD_PER_MONTH
  // is the ultimate fallback if the DB read fails.
  const planCfg = (await getPlanMatrix())[effectivePlan as FlipdeskPlan];
  const liveCap = planCfg?.includedStandardGradesPerMonth ??
    (INCLUDED_STANDARD_PER_MONTH[effectivePlan] ?? 0);

  const nextReset = new Date();
  nextReset.setMonth(nextReset.getMonth() + 1);
  nextReset.setDate(1);
  nextReset.setHours(0, 0, 0, 0);

  return await performPaymentPrecedence({
    user: {
      role: user.role,
      grades_used_this_month: user.grades_used_this_month,
      grade_credit_balance: user.grade_credit_balance,
      included_grades_this_period: user.included_grades_this_period,
    },
    tier,
    rolledOver,
    liveCap,
    effectivePlan,
    pricing: {
      tierPriceCents: pricing.tiers[tier].priceCents,
      tierCreditCost: pricing.tiers[tier].creditCost,
      packs: pricing.packs,
    },
  }, <PrecedenceIO> {
    markPaid: async (status) => {
      await supabaseAdmin
        .from("submissions")
        .update({ payment_status: status, paid_at: new Date().toISOString() })
        .eq("id", submissionId)
        // US-1638/US-2033: scope the paid-flip to the account being CHARGED.
        // Callers owner-verify first, so this is defense in depth — but the
        // failure it guards is user A's credits being debited to mark user B's
        // submission paid, which is a money bug rather than a data bug.
        .eq("user_id", userId);
    },
    recordGrant: async (notes) => {
      // Zero-delta audit row. US-398: balance_after is NULL because
      // snapshotting the balance was a NON-atomic read that drifted if a
      // concurrent debit landed between read and insert. An included grant does
      // not move the balance, so there is nothing honest to record.
      await supabaseAdmin.from("grade_credit_transactions").insert({
        user_id: userId,
        delta: 0,
        reason: "included_grant",
        balance_after: null,
        submission_id: submissionId,
        notes,
      });
    },
    claimIncluded: (cap) =>
      claimIncludedGrade(user.grades_used_this_month, rolledOver, cap, {
        casClaim: async (expectedDbUsed, didRollOver) => {
          const updatePayload: Record<string, unknown> = {
            grades_used_this_month: (didRollOver ? 0 : expectedDbUsed) + 1,
            // US-885 (AC#5): lock the per-period cap on the first claim of a
            // period, so a later admin edit applies from the next reset only.
            included_grades_this_period: cap,
          };
          if (didRollOver) updatePayload.grade_reset_at = nextReset.toISOString();
          const { data, error } = await supabaseAdmin
            .from("users")
            .update(updatePayload)
            .eq("id", userId)
            .eq("grades_used_this_month", expectedDbUsed)
            .select("id");
          return { claimed: !error && Array.isArray(data) && data.length > 0 };
        },
        reread: async () => {
          const { data } = await supabaseAdmin
            .from("users")
            .select("grades_used_this_month, grade_reset_at")
            .eq("id", userId)
            .maybeSingle();
          if (!data) return null;
          const row = data as { grades_used_this_month: number; grade_reset_at: string };
          return {
            dbUsed: row.grades_used_this_month,
            rolledOver: new Date(row.grade_reset_at) <= new Date(),
          };
        },
      }),
    debitCredits: async (cost) => {
      const { data: newBalance, error } = await supabaseAdmin.rpc(
        "debit_grade_credits",
        {
          p_user_id: userId,
          p_credits: cost,
          p_submission_id: submissionId,
          p_notes: `${tier} grade — ${cost} credit${cost === 1 ? "" : "s"}`,
          p_idempotency_key: idempotencyKey ?? null,
        },
      );
      if (error) {
        const msg = (error.message ?? "").toString();
        return { ok: false, insufficient: msg.includes("INSUFFICIENT_CREDITS"), message: msg };
      }
      return { ok: true, newBalance: typeof newBalance === "number" ? newBalance : null };
    },
    loadDiscount: () => loadActiveDiscount(userId, "per_grade_discount"),
    discountedCents,
  });
}
