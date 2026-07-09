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

// The metered actions + which allowance caps each (keys of BuyerAllowances).
export type BuyerMeterKey = "extension_checks" | "authenticity_credits" | "video_grades";

export const BUYER_METER_ALLOWANCE: Record<BuyerMeterKey, keyof BuyerAllowances> = {
  extension_checks: "extensionChecksPerMonth",
  authenticity_credits: "authenticityCreditsPerMonth",
  video_grades: "videoGradeCreditsPerMonth",
};

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
}

/**
 * Run one metered buyer action under the reserve/refund contract:
 *  - reserve atomically first (fail-closed); throws BuyerQuotaExhaustedError at
 *    the cap so callers map it to a 402/429 upgrade prompt,
 *  - run the work,
 *  - refund if the work throws (the failure isn't the buyer's spend), rethrow.
 *
 * `limit` is the buyer's monthly cap for this meter — read it from
 * getBuyerEntitlements(userId).allowances[BUYER_METER_ALLOWANCE[meter]].
 * `deps` is injectable for tests only.
 */
export async function withBuyerMeter<T>(
  ownerId: string,
  meter: BuyerMeterKey,
  limit: number,
  fn: () => Promise<T>,
  deps: BuyerMeterDeps = { reserve: reserveBuyerMeter, refund: refundBuyerMeter },
): Promise<T> {
  const reserved = await deps.reserve(ownerId, meter, limit);
  if (!reserved) throw new BuyerQuotaExhaustedError(meter);
  try {
    return await fn();
  } catch (err) {
    await deps.refund(ownerId, meter);
    throw err;
  }
}
