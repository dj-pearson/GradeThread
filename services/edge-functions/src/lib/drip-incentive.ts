// US-942: resolve a campaign's conversion incentive against the live Stripe
// coupon, enforcing the max-discount guardrail, into the pure RenderableIncentive
// the drip renderer injects for {{incentive}}. Kept out of the pure drip-graph.ts
// module because it touches Stripe; shared by the engine (routes/drip.ts) and the
// admin builder preview/test-send (routes/admin-drip.ts).

import type Stripe from "stripe";
import { getStripe } from "./stripe-client.ts";
import type { DripIncentive, RenderableIncentive } from "./drip-graph.ts";

export interface ResolvedIncentive {
  /** The Stripe coupon id to pre-apply at checkout. */
  couponId: string;
  /** ISO time-box expiry (now + expiryHours). */
  expiresAt: string;
  /** The pure offer the renderer injects. */
  incentive: RenderableIncentive;
}

/** Human-facing discount label from a Stripe coupon (e.g. "20% off your first month"). */
function couponLabel(coupon: Stripe.Coupon): string {
  if (typeof coupon.percent_off === "number" && coupon.percent_off > 0) {
    const pct = Number.isInteger(coupon.percent_off)
      ? String(coupon.percent_off)
      : coupon.percent_off.toFixed(1);
    const span = coupon.duration === "once"
      ? " your first month"
      : coupon.duration === "repeating" && coupon.duration_in_months
      ? ` for ${coupon.duration_in_months} months`
      : "";
    return `${pct}% off${span}`;
  }
  if (typeof coupon.amount_off === "number" && coupon.amount_off > 0) {
    const amount = (coupon.amount_off / 100).toFixed(2);
    const cur = (coupon.currency ?? "usd").toUpperCase();
    return `${amount} ${cur} off`;
  }
  return "a special discount";
}

/**
 * Resolve a campaign incentive config into a ResolvedIncentive, or null when it
 * can't/shouldn't be surfaced:
 *   • disabled or missing couponId/promoCode,
 *   • Stripe unavailable / coupon missing / coupon invalid (deleted/expired),
 *   • the coupon's percent discount EXCEEDS the configured max (guardrail).
 * `nowMs` anchors the time-box. Best-effort: any Stripe error → null (the email
 * simply falls back to the value-only variant rather than leaking a bad offer).
 */
export async function resolveIncentive(
  config: DripIncentive | null | undefined,
  nowMs: number,
): Promise<ResolvedIncentive | null> {
  if (!config || config.enabled !== true) return null;
  if (!config.couponId?.trim() || !config.promoCode?.trim()) return null;

  const stripe = getStripe();
  if (!stripe) return null;

  let coupon: Stripe.Coupon;
  try {
    coupon = await stripe.coupons.retrieve(config.couponId.trim());
  } catch (e) {
    console.warn(
      "[drip-incentive] coupon retrieve failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
  // `valid` flips false once a coupon is exhausted/expired/deleted.
  if (!coupon || coupon.valid === false) {
    console.warn(`[drip-incentive] coupon ${config.couponId} is not valid; not surfacing`);
    return null;
  }
  // Guardrail: never surface a coupon that discounts more than the configured max.
  if (
    typeof coupon.percent_off === "number" &&
    coupon.percent_off > config.maxPercentOff
  ) {
    console.warn(
      `[drip-incentive] coupon ${config.couponId} percent_off ${coupon.percent_off} ` +
        `exceeds maxPercentOff ${config.maxPercentOff}; not surfacing`,
    );
    return null;
  }

  const expiresAt = new Date(nowMs + config.expiryHours * 60 * 60 * 1000).toISOString();
  return {
    couponId: config.couponId.trim(),
    expiresAt,
    incentive: {
      promoCode: config.promoCode.trim(),
      label: couponLabel(coupon),
      expiresAt,
    },
  };
}
