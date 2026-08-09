// US-2345 AC1: the payment precedence sequence, made testable.
//
// This is THE charging chokepoint. The web flow, the FlipDesk bulk bridge, the
// batch worker and the public API all charge through it, so a bug here is a bug
// in every way the product takes money. It ran inline against the service-role
// client, so reaching any branch needed a database — which is why the branch
// order, the tenant scoping and the credit-race fall-through had no test that
// drove them.
//
// FIVE PROPERTIES, each of which is a way to charge the wrong person or the
// wrong amount:
//
//   • THE ORDER IS THE PRICING POLICY. Included → credits → checkout. Included
//     grades are already bought; credits were bought at a discount; checkout is
//     full price. Anything that runs before them charges a seller twice for the
//     same grade — and reordering would fail no branch test, because each branch
//     still works perfectly well on its own.
//   • EVERY PAID-FLIP NAMES THE ACCOUNT BEING CHARGED. The submission id comes
//     from the request. Callers owner-verify first, so this is defense in depth,
//     but the failure it guards is user A's credits being DEBITED to mark user
//     B's submission paid. That is a money bug, and the credits branch was MISSED
//     once already by the pass that added the scoping to the other two.
//   • A DEBIT FAILURE FALLS THROUGH ONLY FOR "INSUFFICIENT_CREDITS". Any other
//     ledger error THROWS. Widening it would charge a card whenever the ledger
//     was briefly unavailable, and the double charge would look like an ordinary
//     checkout to everyone including the seller.
//   • THE SUPER-ADMIN COMP IS UNCAPPED AND STILL AUDITED. It writes a zero-delta
//     ledger row rather than skipping the ledger, so a free grade is still a
//     grade someone can account for.
//   • AN INCLUDED GRANT RECORDS NO BALANCE. `balance_after` is null because
//     snapshotting the balance was a non-atomic read that drifted whenever a
//     concurrent debit landed between read and insert (US-398). A balance that is
//     sometimes a stale guess is worse than one honestly absent — reconciliation
//     trusts it.
//
// The CAS retry inside the included claim is deliberately NOT re-implemented
// here: `claimIncludedGrade` already owns it, is already pure, and is already
// tested (US-782). This sequence calls it.

import {
  type GradeTier,
  resolveIncludedCap,
  suggestPackFrom,
} from "./grade-pricing.ts";

/** The user row this decision reads. Everything else on `users` is irrelevant. */
export interface PrecedenceUser {
  role: string | null;
  grades_used_this_month: number;
  grade_credit_balance: number;
  /** The per-period cap snapshot; null means "use the live cap" (US-885). */
  included_grades_this_period: number | null;
}

/** A credit pack, as offered alongside a checkout quote. */
export interface PackOffer {
  credits: number;
  priceCents: number;
}

/** The live pricing this call resolved, already plan- and DB-aware. */
export interface PrecedencePricing {
  tierPriceCents: number;
  tierCreditCost: number;
  packs: readonly PackOffer[];
}

/** A reward discount that applies to the money path only (US-1853). */
export interface PrecedenceDiscount {
  percentOff: number;
  milestoneKey: string;
}

export interface PrecedenceIO {
  /**
   * Mark the submission paid. MUST be scoped to `userId` as well as the
   * submission id — the adapter owns that, and a test pins it at the call site.
   */
  markPaid: (status: "included" | "credits") => Promise<void>;
  /** Write the zero-delta audit row for a grade that cost no money. */
  recordGrant: (notes: string) => Promise<void>;
  /**
   * Attempt the included claim. Returns the claim result from
   * `claimIncludedGrade`, whose CAS retry is already tested separately.
   */
  claimIncluded: (
    cap: number,
  ) => Promise<{ claimed: boolean; newUsed: number }>;
  /**
   * Debit credits. `ok:false` with `insufficient:true` means the race lost and
   * the caller should fall through; `ok:false` with `insufficient:false` is a
   * broken ledger and MUST NOT fall through.
   */
  debitCredits: (
    cost: number,
  ) => Promise<
    | { ok: true; newBalance: number | null }
    | { ok: false; insufficient: boolean; message: string }
  >;
  /** The active per-grade reward discount, or null. Never throws. */
  loadDiscount: () => Promise<PrecedenceDiscount | null>;
  /** Apply a percentage discount to a price, in cents. */
  discountedCents: (priceCents: number, percentOff: number) => number;
}

export type PrecedenceOutcome =
  | { paid: true; method: "included"; newIncludedUsed: number }
  | { paid: true; method: "credits"; newBalance: number }
  | {
    paid: false;
    checkoutRequired: true;
    suggestedTier: GradeTier;
    suggestedPack: PackOffer | null;
    tierPriceCents: number;
    listPriceCents?: number;
    rewardDiscountPercent?: number;
    rewardMilestoneKey?: string;
  };

/** Thrown for a ledger failure that is NOT "not enough credits". */
export class DebitFailedError extends Error {
  constructor(message: string) {
    super(`DEBIT_FAILED: ${message}`);
    this.name = "DebitFailedError";
  }
}

/**
 * Charge one grade, cheapest valid path first.
 *
 * `rolledOver` and `liveCap` are resolved by the caller because both come from
 * reads it already made — the point of this function is the ORDER and the
 * failure handling, not re-deriving inputs.
 */
export async function performPaymentPrecedence(
  args: {
    user: PrecedenceUser;
    tier: GradeTier;
    /** True when the reset boundary has passed since the counter was written. */
    rolledOver: boolean;
    /** The plan's current included-grade cap, before the snapshot rule. */
    liveCap: number;
    /** Resolved plan name, for the audit row's prose only. */
    effectivePlan: string;
    pricing: PrecedencePricing;
  },
  io: PrecedenceIO,
): Promise<PrecedenceOutcome> {
  const { user, tier, pricing } = args;

  // ── The platform owner grades free, uncapped ──
  //
  // Handled at the chokepoint rather than per-caller so it covers the web flow,
  // the bulk bridge and the public API at once. Scoped strictly to super_admin —
  // ordinary `admin`/`reviewer` accounts pay like anyone else, which is the
  // whole reason this is a role check and not an is-staff check.
  if (user.role === "super_admin") {
    await io.markPaid("included");
    await io.recordGrant("super_admin unlimited grade (uncapped, no charge)");
    return {
      paid: true,
      method: "included",
      // Deliberately the UNCHANGED counter: nothing was consumed, so reporting
      // an incremented value would make a free grade look like it ate one of
      // the seller's included allowance.
      newIncludedUsed: user.grades_used_this_month,
    };
  }

  const includedUsed = args.rolledOver ? 0 : user.grades_used_this_month;
  const includedCap = resolveIncludedCap(
    user.included_grades_this_period,
    args.liveCap,
    args.rolledOver,
  );

  // ── (1) Included monthly grades — STANDARD only ──
  //
  // Premium and Express always cost money. Letting them draw on the included
  // allowance would sell a $12.99 grade for a $2.99 one.
  if (tier === "standard" && includedUsed < includedCap) {
    const claim = await io.claimIncluded(includedCap);
    if (claim.claimed) {
      await io.markPaid("included");
      await io.recordGrant(
        `Included Standard grade #${claim.newUsed}/${includedCap} on ${args.effectivePlan}`,
      );
      return { paid: true, method: "included", newIncludedUsed: claim.newUsed };
    }
    // Allowance genuinely exhausted, or the retries were spent. Fall through.
  }

  // ── (2) Credits ──
  const cost = pricing.tierCreditCost;
  if (user.grade_credit_balance >= cost) {
    const debit = await io.debitCredits(cost);
    if (debit.ok) {
      await io.markPaid("credits");
      return {
        paid: true,
        method: "credits",
        // The RPC's returned balance is authoritative; the local subtraction is
        // only a fallback for a driver that returned no value, and it can be
        // stale by a concurrent grant.
        newBalance: debit.newBalance ?? user.grade_credit_balance - cost,
      };
    }
    // ONLY the race falls through. A broken ledger must not become a card
    // charge — the seller would pay twice and it would look like a normal
    // checkout to everyone, including them.
    if (!debit.insufficient) throw new DebitFailedError(debit.message);
  }

  // ── (3) Checkout ──
  //
  // The reward discount (US-1853) bites HERE and only here. Included grades are
  // already free, and shaving the credit cost would make a discount worth less
  // the more credits someone holds. A failed lookup reads as "no discount" —
  // full price, the safe direction for a read that gates money.
  const discount = await io.loadDiscount();
  const listPriceCents = pricing.tierPriceCents;
  return {
    paid: false,
    checkoutRequired: true,
    suggestedTier: tier,
    suggestedPack: suggestPackFrom(pricing.packs as PackOffer[], cost),
    tierPriceCents: discount
      ? io.discountedCents(listPriceCents, discount.percentOff)
      : listPriceCents,
    ...(discount
      ? {
        listPriceCents,
        rewardDiscountPercent: discount.percentOff,
        rewardMilestoneKey: discount.milestoneKey,
      }
      : {}),
  };
}
