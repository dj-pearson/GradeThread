// US-2227 AC2: validating a partial refund before it moves money.
//
// Pure and separate from the dialog for the usual reason — this is the check
// that stands between a typo and a real refund on a real buyer's card, and it
// should be assertable without rendering anything.
//
// ── THE ROUTE THIS FEEDS, AND WHY IT IS NOT THE ONE THE AC NAMES ────────────
//
// US-2227 AC1 says the partial refund goes "through the existing eBay post-order
// refund edge route". It cannot: POST /returns/:returnId/refund calls eBay's
// Post-Order /return/{id}/issue_refund, which takes only an optional comment —
// there is no amount in the request, and a return refund is for the return's
// full value.
//
// The route that DOES take an amount is POST /orders/:orderId/refund
// (US-1978 AC3), and its own header describes exactly the case this story asks
// for: "there's a mark I missed — keep it, here's $10 back". It already
// validates, already refuses an order-level amount and line items together, and
// already proves the sale belongs to this tenant before calling eBay. It simply
// had no frontend caller.
//
// So the fix is not a new capability, it is connecting one that shipped unwired.

/** Cents, so the comparison never runs on floating-point dollars. */
export interface RefundValidation {
  ok: boolean;
  /** Parsed amount in cents. Only meaningful when ok. */
  cents: number;
  /** Seller-facing reason. Null when ok. */
  error: string | null;
}

/** eBay wants a decimal string like "10.00". */
export function centsToEbayValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Validate a typed refund amount against the order total.
 *
 * `orderTotal` is dollars, or null when it could not be looked up. A NULL TOTAL
 * DOES NOT SKIP THE UPPER BOUND SILENTLY — it refuses, because the alternative
 * is letting a seller over-refund on the one path where we could not check, and
 * "we did not know" is not a reason to move more money than the order was
 * worth. eBay would reject it too, but a rejection after the request is a worse
 * experience than a refusal before it, and eBay's error text is not written for
 * a seller.
 */
export function validateRefundAmount(
  raw: string,
  orderTotal: number | null,
): RefundValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, cents: 0, error: "Enter a refund amount." };
  }
  // Number("") is 0 and Number("1,50") is NaN — parse explicitly rather than
  // letting a comma decimal separator read as "nothing typed".
  const dollars = Number(trimmed.replace(/[$\s]/g, ""));
  if (!Number.isFinite(dollars)) {
    return { ok: false, cents: 0, error: "That is not a number." };
  }
  // Round to cents FIRST, so 0.004 is caught as zero rather than passing the
  // > 0 test and then being sent to eBay as "0.00".
  const cents = Math.round(dollars * 100);
  if (cents <= 0) {
    return { ok: false, cents: 0, error: "The refund must be more than $0." };
  }
  if (orderTotal == null || !Number.isFinite(orderTotal) || orderTotal <= 0) {
    return {
      ok: false,
      cents,
      error:
        "We couldn't read this order's total, so we can't check the refund against it. Refund from eBay directly.",
    };
  }
  const totalCents = Math.round(orderTotal * 100);
  if (cents > totalCents) {
    return {
      ok: false,
      cents,
      error: `That is more than the order total of $${(totalCents / 100).toFixed(2)}.`,
    };
  }
  return { ok: true, cents, error: null };
}

/**
 * Is this a full refund rather than a partial one?
 *
 * Worth naming because the two are different eBay conversations: a full refund
 * on an open return belongs on the RETURN route, which closes the case. Sending
 * the full amount through the order route instead would refund the buyer and
 * leave the return sitting open.
 */
export function isFullRefund(cents: number, orderTotal: number | null): boolean {
  if (orderTotal == null || !Number.isFinite(orderTotal)) return false;
  return cents >= Math.round(orderTotal * 100);
}
