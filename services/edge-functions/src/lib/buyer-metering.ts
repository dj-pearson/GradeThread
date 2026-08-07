// US-1800: the ONE reserve/refund contract for metered BUYER actions.
//
// Buyer plans include monthly allowances for a few metered actions (extension
// checks, authenticity credits, video-grade credits). Every such action counts
// against the buyer's monthly cap through the atomic reserve_buyer_meter CAS
// (migration 00413): reserve BEFORE the work, refund if the work throws. Mirrors
// ai-metering.ts (withAiAction) but keyed per-meter. The cap comes from the
// buyer's entitlements (buyer-entitlements.ts allowances; -1 = unlimited).
//
// Debit precedence (US-1800 AC2): included monthly allowance → (future) buyer
// credit balance → upgrade prompt. This module implements the included-allowance
// leg + the exhausted→upgrade signal; a purchasable buyer-credit fallback is
// layered on when buyer credit packs ship (US-1801).

import { supabaseAdmin } from "./supabase.ts";
import type { BuyerAllowances } from "./buyer-plans.ts";
import { redeemRewardCredit, refundRewardCredit } from "./buyer-rewards.ts";

// The metered actions + which allowance caps each (keys of BuyerAllowances).
export type BuyerMeterKey = "extension_checks" | "authenticity_credits" | "video_grades";

// `satisfies` rather than a `Record<…>` annotation on purpose: the annotation
// would widen every value to `keyof BuyerAllowances`, so indexing allowances
// through it yields the union of ALL allowance types (including the non-numeric
// alertFrequency) and a caller has to cast to get its cap back. This keeps the
// exhaustiveness check AND the literal key, so the cap reads as a number.
export const BUYER_METER_ALLOWANCE = {
  extension_checks: "extensionChecksPerMonth",
  authenticity_credits: "authenticityCreditsPerMonth",
  video_grades: "videoGradeCreditsPerMonth",
} as const satisfies Record<BuyerMeterKey, keyof BuyerAllowances>;

export const BUYER_QUOTA_EXHAUSTED_MESSAGE =
  "You've used this month's allowance for this feature. Upgrade your plan or wait for the monthly reset.";

/** Thrown by withBuyerMeter when the monthly allowance is exhausted (→ 402/429). */
export class BuyerQuotaExhaustedError extends Error {
  readonly meter: BuyerMeterKey;
  constructor(meter: BuyerMeterKey) {
    super(BUYER_QUOTA_EXHAUSTED_MESSAGE);
    this.name = "BuyerQuotaExhaustedError";
    this.meter = meter;
  }
}

/**
 * Atomically reserve one unit of a buyer meter against the monthly cap
 * (-1 = unlimited). Fail-CLOSED: an rpc error logs and reads as "not reserved"
 * so a broken counter never hands out free over-cap actions.
 */
export async function reserveBuyerMeter(
  ownerId: string,
  meter: BuyerMeterKey,
  limit: number,
): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc("reserve_buyer_meter", {
      p_user_id: ownerId,
      p_meter: meter,
      p_limit: limit,
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (err) {
    console.error("[buyer-metering] reserve_buyer_meter failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Return a reserved unit to the pool when the work it paid for failed. */
export async function refundBuyerMeter(ownerId: string, meter: BuyerMeterKey): Promise<void> {
  const { error } = await supabaseAdmin.rpc("refund_buyer_meter", {
    p_user_id: ownerId,
    p_meter: meter,
  });
  if (error) {
    console.error("[buyer-metering] refund_buyer_meter failed:", error.message);
  }
}

interface BuyerMeterDeps {
  reserve: (ownerId: string, meter: BuyerMeterKey, limit: number) => Promise<boolean>;
  refund: (ownerId: string, meter: BuyerMeterKey) => Promise<void>;
  // US-1813: the reward-credit fallback leg of the debit precedence.
  redeemReward: (ownerId: string, meter: BuyerMeterKey) => Promise<boolean>;
  refundReward: (ownerId: string, meter: BuyerMeterKey) => Promise<void>;
}

const DEFAULT_BUYER_METER_DEPS: BuyerMeterDeps = {
  reserve: reserveBuyerMeter,
  refund: refundBuyerMeter,
  redeemReward: redeemRewardCredit,
  refundReward: refundRewardCredit,
};

/**
 * Which pocket a debit came out of. Persisted by any caller whose work outlives
 * the request that paid for it (US-1841 stamps it on the submission), because a
 * refund must return to the SAME pocket and nothing else records which one it was.
 */
export type BuyerMeterSource = "allowance" | "reward";

/**
 * Spend one unit under the full US-1800 debit precedence:
 *  1. reserve the monthly allowance atomically (fail-closed),
 *  2. else redeem one US-1813 reward credit,
 *  3. else null — the caller answers with the upgrade prompt.
 *
 * Returns which pocket paid, so the caller can refund the right one later.
 *
 * `limit` is the buyer's monthly cap for this meter — read it from
 * getBuyerEntitlements(userId).allowances[BUYER_METER_ALLOWANCE[meter]].
 * `deps` is injectable for tests only.
 *
 * This is the ONE implementation of the precedence. withBuyerMeter below is the
 * request-scoped wrapper over it, and the buyer video grade (US-1841) calls it
 * directly because the work it pays for finishes in a background pipeline, long
 * after the HTTP response — a try/finally cannot span that.
 */
export async function debitBuyerMeter(
  ownerId: string,
  meter: BuyerMeterKey,
  limit: number,
  deps: BuyerMeterDeps = DEFAULT_BUYER_METER_DEPS,
): Promise<BuyerMeterSource | null> {
  if (await deps.reserve(ownerId, meter, limit)) return "allowance";
  // At the monthly cap, fall through to a reward credit before failing.
  if (await deps.redeemReward(ownerId, meter)) return "reward";
  return null;
}

/** Return a debited unit to the pocket it came from. Never crosses them. */
export async function refundBuyerMeterSource(
  ownerId: string,
  meter: BuyerMeterKey,
  source: BuyerMeterSource,
  deps: BuyerMeterDeps = DEFAULT_BUYER_METER_DEPS,
): Promise<void> {
  if (source === "reward") await deps.refundReward(ownerId, meter);
  else await deps.refund(ownerId, meter);
}

/**
 * Run one metered buyer action under the reserve/refund contract: debit through
 * the precedence above, run the work, and refund the SAME source the spend came
 * from if it throws. Throws BuyerQuotaExhaustedError (→ 402/429 upgrade prompt)
 * when neither pocket can pay.
 */
export async function withBuyerMeter<T>(
  ownerId: string,
  meter: BuyerMeterKey,
  limit: number,
  fn: () => Promise<T>,
  deps: BuyerMeterDeps = DEFAULT_BUYER_METER_DEPS,
): Promise<T> {
  const source = await debitBuyerMeter(ownerId, meter, limit, deps);
  if (!source) throw new BuyerQuotaExhaustedError(meter);
  try {
    return await fn();
  } catch (err) {
    await refundBuyerMeterSource(ownerId, meter, source, deps);
    throw err;
  }
}
