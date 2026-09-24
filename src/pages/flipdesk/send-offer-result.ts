// OM-12: the arithmetic and the wording both Send-offer cards share.
//
// The ranked list and the manual picker used to disagree: one confirmed with
// the exposure and capped at 60%, the other sent up to 90% on one click; one
// reported a partial multi-store send as a full one. Both read these now.

import type { EbaySendOfferResult, OfferCurve } from "@/hooks/use-ebay";
import { SEND_OFFER_MAX_PCT, SEND_OFFER_MIN_PCT } from "@/lib/offer-limits";
import { formatMoney } from "@/pages/flipdesk/offer-economics";

/**
 * The most a send can give away if every offer is accepted, in cents. Null
 * when any selected listing has no price on record, because a total that
 * silently skips an item is a smaller number than the truth.
 */
export function discountExposureCents(
  priceCents: Array<number | null | undefined>,
  pct: number,
): number | null {
  if (priceCents.some((p) => p == null)) return null;
  return priceCents.reduce<number>((sum, p) => sum + Math.round((p ?? 0) * (pct / 100)), 0);
}

/** "Send 12% off to 4 listings?" plus what it can cost, for the confirm. */
export function sendConfirmCopy(
  count: number,
  pct: number,
  exposureCents: number | null,
  noun = "listing",
): { title: string; description: string } {
  return {
    title: `Send ${pct}% off to ${count} ${noun}${count === 1 ? "" : "s"}?`,
    description: exposureCents == null
      ? "Some of these have no price on record, so we can't total what this could cost. Offers go to everyone watching them and can be accepted immediately."
      : `If every one is accepted this gives away ${formatMoney(exposureCents)}. Offers go to everyone watching and can be accepted immediately.`,
  };
}

export interface SendOutcome {
  /** True when some listings went and some did not. */
  partial: boolean;
  message: string;
  /** The ids to keep selected so a retry resends only these. */
  failedIds: string[];
}

/** How a send-offer answer reads to the seller. */
export function describeSendResult(
  res: EbaySendOfferResult,
  requested: number,
  noun = "listing",
): SendOutcome {
  const failed = res.failed ?? [];
  const failedIds = failed.flatMap((f) => f.ids);
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (failedIds.length === 0) {
    return { partial: false, message: `Offer sent on ${plural(res.count)}.`, failedIds };
  }
  const why = failed[0]?.detail ? ` ${failed[0].detail}` : "";
  return {
    partial: true,
    message: `Sent to ${res.count} of ${plural(requested)}. The rest are still selected.${why}`,
    failedIds,
  };
}

/** "$50.00 -> $45.00" for a picker row. Null without a price. */
export function discountedPriceLabel(
  priceCents: number | null | undefined,
  pct: number | null,
  currency = "USD",
): string | null {
  if (priceCents == null || pct == null) return null;
  const after = Math.round(priceCents * (1 - pct / 100));
  return `${formatMoney(priceCents, currency)} -> ${formatMoney(after, currency)}`;
}

/**
 * OM-12: the discount the efficient bucket starts at, as a whole percent the
 * Send tab will take, or null. The curve used to stop at the insight; this is
 * what carries it into the next offer the seller sends.
 */
export function efficientDiscountPct(curve: OfferCurve): number | null {
  const depth = curve.efficientDepth;
  if (!depth) return null;
  const from = depth.fromPct ?? curve.buckets.find((b) => b.key === depth.key)?.fromPct;
  if (from == null || !Number.isFinite(from)) return null;
  const n = Math.round(from);
  return n >= SEND_OFFER_MIN_PCT && n <= SEND_OFFER_MAX_PCT ? n : null;
}
