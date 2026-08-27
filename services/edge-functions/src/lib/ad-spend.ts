// US-2952: what promotion actually costs, on the page that reports profit.
//
// Promoted-listing fees and the discounts given through a sale never reached
// the money view. So the profit figure a seller reads was the profit before
// advertising — higher than the number they banked, every month they ran ads.
//
// ── ATTRIBUTED TO THE SALE, NOT TO A BUCKET ────────────────────────────────
//
// eBay bills the ad fee as its own transaction carrying the order id. Keeping
// that link is what makes "this jacket cost $4.20 to sell" answerable at all;
// summing them into one "advertising" total would answer a question nobody
// asks and lose the one they do.
//
// ── THE LINES MUST SUM TO THE TOTAL ────────────────────────────────────────
//
// `reconcileMoneyLines` exists so the page cannot show a total that disagrees
// with the rows above it. That has a name in this repo — a figure computed
// twice, in two places, that drifts — and here it would be a profit number
// nobody can reconcile against the lines it came from.
//
// Pure. The eBay call lives in the route.

/** eBay's transaction types that are advertising, not a sale or a refund. */
export const AD_FEE_TYPES = ["NON_SALE_CHARGE"] as const;

/**
 * Fee-type strings inside a NON_SALE_CHARGE that mean Promoted Listings.
 *
 * Matched loosely because eBay has used several spellings across Standard and
 * Advanced, and a type it adds tomorrow should still land in advertising rather
 * than silently disappearing from the seller's costs. The cost of a false
 * positive here is one line labelled advertising that was something else; the
 * cost of a false negative is a profit figure that is quietly too high.
 */
const AD_FEE_MARKERS = ["AD_FEE", "PROMOTED", "ADVERT", "CAMPAIGN"];

export interface RawTransaction {
  transactionId: string;
  transactionType: string;
  transactionDate: string | null;
  orderId: string | null;
  amount: { value: string; currency: string } | null;
  feeType?: string | null;
  bookingEntry?: string | null;
}

export interface AdFee {
  transactionId: string;
  orderId: string | null;
  at: string | null;
  cents: number;
}

function centsOf(amount: { value: string } | null | undefined): number | null {
  if (!amount?.value) return null;
  const n = Number(amount.value);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
}

/** Is this transaction a Promoted Listings charge? Pure. */
export function isAdFee(t: RawTransaction): boolean {
  if (!(AD_FEE_TYPES as readonly string[]).includes(t.transactionType)) return false;
  const haystack = `${t.feeType ?? ""}`.toUpperCase();
  return AD_FEE_MARKERS.some((m) => haystack.includes(m));
}

/** Pull the ad fees out of a transaction feed, keeping the order link. Pure. */
export function extractAdFees(transactions: RawTransaction[]): AdFee[] {
  const out: AdFee[] = [];
  for (const t of transactions) {
    if (!isAdFee(t)) continue;
    const cents = centsOf(t.amount);
    // A charge with no readable amount is dropped rather than counted as zero:
    // a zero would report "you spent nothing on ads" from a feed that says
    // otherwise, which is the direction that flatters the profit figure.
    if (cents == null || cents === 0) continue;
    out.push({
      transactionId: t.transactionId,
      orderId: t.orderId,
      at: t.transactionDate,
      cents,
    });
  }
  return out;
}

export interface MoneyLine {
  key: string;
  label: string;
  /** Negative for a cost, positive for income. */
  cents: number;
}

export interface ReconciledMoney {
  lines: MoneyLine[];
  totalCents: number;
}

/**
 * Build the money lines and their total, so the two cannot disagree. Pure.
 *
 * The total is the SUM of the lines by construction rather than a second
 * computation that happens to match — which is the whole point: a profit figure
 * a seller cannot reconcile against the rows above it is a figure they stop
 * trusting, and then stop using.
 *
 * A zero line is dropped, EXCEPT ad spend: "$0.00 in ad fees" is information (a
 * seller checking whether their campaign is charging), while a $0 shipping line
 * is noise.
 */
export function reconcileMoneyLines(input: {
  revenueCents: number;
  platformFeesCents: number;
  shippingCents: number;
  costOfGoodsCents: number;
  adFeesCents: number;
  promotionDiscountCents: number;
}): ReconciledMoney {
  const candidates: MoneyLine[] = [
    { key: "revenue", label: "Sales", cents: input.revenueCents },
    { key: "cogs", label: "What the items cost you", cents: -Math.abs(input.costOfGoodsCents) },
    { key: "platform_fees", label: "eBay fees", cents: -Math.abs(input.platformFeesCents) },
    { key: "shipping", label: "Shipping you paid", cents: -Math.abs(input.shippingCents) },
    { key: "ad_fees", label: "Promoted Listings fees", cents: -Math.abs(input.adFeesCents) },
    {
      key: "promotion_discounts",
      label: "Discounts you gave",
      cents: -Math.abs(input.promotionDiscountCents),
    },
  ];
  const lines = candidates.filter((l) => l.cents !== 0 || l.key === "ad_fees");
  return {
    lines,
    totalCents: lines.reduce((sum, l) => sum + l.cents, 0),
  };
}
