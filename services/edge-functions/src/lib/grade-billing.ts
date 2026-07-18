import { supabaseAdmin } from "./supabase.ts";
import {
  effectivePlanFor,
  INCLUDED_STANDARD_PER_MONTH,
  resolveIncludedCap,
  suggestPackFrom,
  type GradeTier,
} from "./grade-pricing.ts";
import { type FlipdeskPlan, getGradePricing, getPlanMatrix } from "./pricing-config.ts";

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
      "role, flipdesk_plan, grades_used_this_month, grade_reset_at, included_grades_this_period, grade_credit_balance, subscription_status, trial_ends_at, past_due_since",
    )
    .eq("id", userId)
    .single();

  if (userError || !user) {
    throw new Error(`USER_NOT_FOUND: ${userId}`);
  }

  // Super-admin (platform owner) grades for free, with NO cap. This is the
  // single charging chokepoint, so handling it here covers the web flow, the
  // FlipDesk bulk bridge, and the public API at once. Scoped strictly to
  // role = 'super_admin' — regular 'admin'/'reviewer' users pay normally.
  // No counter increment, no credit debit; a zero-delta ledger row keeps the
  // grade auditable. Mirror this in plan-gate's requireFlipdesk bypass so a
  // pre-gate doesn't block before charging runs.
  if (user.role === "super_admin") {
    const now = new Date().toISOString();
    await supabaseAdmin
      .from("submissions")
      .update({ payment_status: "included", paid_at: now })
      .eq("id", submissionId)
      // US-2033: scope the super-admin comp to the account being charged, for
      // the same reason as the two branches below.
      .eq("user_id", userId);
    await supabaseAdmin.from("grade_credit_transactions").insert({
      user_id: userId,
      delta: 0,
      reason: "included_grant",
      balance_after: null,
      submission_id: submissionId,
      notes: "super_admin unlimited grade (uncapped, no charge)",
    });
    return {
      paid: true,
      method: "included",
      newIncludedUsed: user.grades_used_this_month,
    };
  }

  // Paused subscriptions, expired trials (US-383), AND past_due subs beyond the
  // dunning grace window (US-395) fall back to Free caps.
  const effectivePlan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
    new Date(),
    user.past_due_since,
  );

  // US-885: tier prices, credit cost, and credit packs are now DB-driven
  // (pricing_config) with the compiled constants as fallback. Loaded once per
  // call (both reads are short-cached).
  const pricing = await getGradePricing();

  // Roll over the included counter if we crossed the reset boundary. (Normal
  // case is the invoice.payment_succeeded webhook resets it on cycle, but
  // Free users have no invoice — they rely on this clock check.)
  let includedUsed = user.grades_used_this_month;
  const resetAt = new Date(user.grade_reset_at);
  const rolledOver = resetAt <= new Date();
  if (rolledOver) includedUsed = 0;

  // US-885 (AC#2/#5): the included-grade cap is read from the live, operator-
  // editable pricing_plans matrix (DB-backed, cached) — not the hardcoded
  // INCLUDED_STANDARD_PER_MONTH map. The per-period SNAPSHOT
  // (users.included_grades_this_period) governs the cap WITHIN a period so an
  // admin edit never retroactively changes a period already in progress; the
  // live cap applies from the next reset. INCLUDED_STANDARD_PER_MONTH remains the
  // ultimate fallback (baked into FALLBACK_MATRIX) if the DB read fails.
  const planCfg = (await getPlanMatrix())[effectivePlan as FlipdeskPlan];
  const liveCap = planCfg?.includedStandardGradesPerMonth ??
    (INCLUDED_STANDARD_PER_MONTH[effectivePlan] ?? 0);
  const includedCap = resolveIncludedCap(
    user.included_grades_this_period,
    liveCap,
    rolledOver,
  );

  // ─ (1) Try included grades — Standard only, with bounded CAS retries (US-782) ─
  if (tier === "standard" && includedUsed < includedCap) {
    const nextReset = new Date();
    nextReset.setMonth(nextReset.getMonth() + 1);
    nextReset.setDate(1);
    nextReset.setHours(0, 0, 0, 0);

    const claim = await claimIncludedGrade(
      user.grades_used_this_month,
      rolledOver,
      includedCap,
      {
        casClaim: async (expectedDbUsed, didRollOver) => {
          // Set to (rolledOver ? 0 : expectedDbUsed)+1, conditioned on the column
          // still equalling expectedDbUsed (the optimistic compare).
          const updatePayload: Record<string, unknown> = {
            grades_used_this_month: (didRollOver ? 0 : expectedDbUsed) + 1,
            // US-885 (AC#5): lock the per-period included-grade cap. On rollover
            // (or the first claim of a period where it's still null) this captures
            // the current live cap; a subsequent admin edit then only takes effect
            // on the next reset, never retroactively. `includedCap` already
            // resolved to liveCap on rollover / first claim.
            included_grades_this_period: includedCap,
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
      },
    );

    if (claim.claimed) {
      await supabaseAdmin
        .from("submissions")
        .update({ payment_status: "included", paid_at: new Date().toISOString() })
        .eq("id", submissionId)
        // US-1638: defense-in-depth at the charging chokepoint — every caller
        // owner-verifies first, but scope the paid-flip to the charged account
        // so a submissionId can never mark a DIFFERENT tenant's submission paid.
        .eq("user_id", userId);
      // Zero-delta audit row, balance unchanged. US-398: balance_after is NULL
      // here — snapshotting user.grade_credit_balance was a NON-atomic read that
      // could drift if a concurrent debit/grant landed between read and insert.
      // The balance is unaffected by an included grant, so there is nothing to
      // record; balance-changing rows still carry an atomic balance_after.
      await supabaseAdmin.from("grade_credit_transactions").insert({
        user_id: userId,
        delta: 0,
        reason: "included_grant",
        balance_after: null,
        submission_id: submissionId,
        notes: `Included Standard grade #${claim.newUsed}/${includedCap} on ${effectivePlan}`,
      });
      return { paid: true, method: "included", newIncludedUsed: claim.newUsed };
    }
    // Included allowance genuinely exhausted (or retries spent) — fall through
    // to credits.
  }

  // ─ (2) Try credits ─
  const cost = pricing.tiers[tier].creditCost;
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
        .eq("id", submissionId)
        // US-2033: same scoping the included-grade flip above already carries
        // (US-1638). This branch was missed in that hardening pass. Callers do
        // owner-verify first, so this is defense-in-depth — but the failure it
        // guards is that user A's credits get DEBITED to mark user B's
        // submission paid, which is a money bug, not just a data bug.
        .eq("user_id", userId);
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
    suggestedPack: suggestPackFrom(pricing.packs, cost),
    tierPriceCents: pricing.tiers[tier].priceCents,
  };
}
