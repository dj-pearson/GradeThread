// US-9205: the graded price is the draft price, not a suggestion.
//
// Grade -> condition-matched sold comps -> price was already built (the edge's
// /api/flipdesk/pricing/price, read by useGradeBandedPrice). It arrived as a
// card the seller had to apply. These helpers make it the draft's starting
// price and keep the provenance honest: what the prefill was, why, and whether
// the seller typed over it. Pure, so the three states (graded, ungraded,
// overridden) are assertable without a component.

import type { PriceSetBy } from "@/types/database";

/** The slice of the recommendation these helpers read. */
export interface PriceRecommendationLike {
  recommendedCents: number | null;
  gradeValue?: number | null;
  soldBacked?: boolean;
  sufficient?: boolean;
  compSet?: { count: number } | null;
  sellThrough?: { daysLow: number; daysHigh: number; label: string } | null;
}

export interface DraftPricePrefill {
  cents: number;
  basis: Extract<PriceSetBy, "graded" | "comp_median">;
  /** The one line under the price: grade, comps used, expected days to sell. */
  why: string;
}

function daysPhrase(rec: PriceRecommendationLike): string | null {
  const st = rec.sellThrough;
  if (!st || st.label === "unknown" || !(st.daysHigh > 0)) return null;
  return st.daysLow === st.daysHigh
    ? `about ${st.daysHigh} days to sell`
    : `${st.daysLow} to ${st.daysHigh} days to sell`;
}

function compsPhrase(rec: PriceRecommendationLike): string {
  const n = rec.compSet?.count ?? 0;
  const noun = rec.soldBacked ? (n === 1 ? "sold comp" : "sold comps") : (n === 1 ? "active ask" : "active asks");
  return `${n} ${noun}`;
}

/**
 * The price a new draft opens with, and the sentence that says why.
 *
 * Graded: the recommendation was positioned by the grade (the edge did that
 * when it was given one) and is sold-backed. Ungraded: the comp median, said
 * plainly so the seller knows a grade can still move it. Null when there is
 * nothing to price from; the field then stays empty, as it always has.
 */
export function draftPriceFrom(
  rec: PriceRecommendationLike | null | undefined,
  grade: number | null | undefined,
): DraftPricePrefill | null {
  if (!rec || rec.recommendedCents == null || !(rec.recommendedCents > 0)) return null;
  const cents = Math.round(rec.recommendedCents);
  const days = daysPhrase(rec);
  const graded = grade != null && Number.isFinite(grade) && rec.gradeValue != null;
  if (graded) {
    const parts = [`Grade ${grade.toFixed(1)}`, compsPhrase(rec)];
    if (days) parts.push(days);
    return { cents, basis: "graded", why: parts.join(", ") + "." };
  }
  const parts = [`Comp median from ${compsPhrase(rec)}`];
  if (days) parts.push(days);
  return { cents, basis: "comp_median", why: parts.join(", ") + ". No grade yet; a grade can move this." };
}

/** The three states the story names, read off the listing row. */
export type DraftPriceState = "graded" | "ungraded" | "overridden" | "unpriced";

export function draftPriceState(listing: {
  listing_price: number | string | null | undefined;
  price_set_by: PriceSetBy | null | undefined;
}): DraftPriceState {
  const price = Number(listing.listing_price);
  if (!Number.isFinite(price) || price <= 0) return "unpriced";
  switch (listing.price_set_by) {
    case "graded":
      return "graded";
    case "seller":
      return "overridden";
    case "comp_median":
      return "ungraded";
    default:
      // Rows from before the column, and rule-moved rows, read as ungraded:
      // there is no graded price on record to claim.
      return "ungraded";
  }
}

/**
 * When the grade lands after the draft was priced from the comp median, the
 * graded price is OFFERED, never applied. Null when there is nothing new to
 * offer: no graded recommendation, the price already is the graded one, or the
 * seller typed their own (a one-click update is still an offer they can take,
 * so an override does not suppress it; only a matching price does).
 */
export function gradedUpdateOffer(
  listing: { listing_price: number | string | null | undefined; price_set_by: PriceSetBy | null | undefined },
  rec: PriceRecommendationLike | null | undefined,
  grade: number | null | undefined,
): DraftPricePrefill | null {
  const prefill = draftPriceFrom(rec, grade);
  if (!prefill || prefill.basis !== "graded") return null;
  if (listing.price_set_by === "graded") return null;
  const current = Math.round(Number(listing.listing_price) * 100);
  if (Number.isFinite(current) && current === prefill.cents) return null;
  return prefill;
}

/** True when the typed price is not the prefill: the seller decided. */
export function isSellerOverride(typedCents: number | null, prefill: DraftPricePrefill | null): boolean {
  if (typedCents == null || !Number.isFinite(typedCents) || typedCents <= 0) return false;
  if (!prefill) return true;
  return typedCents !== prefill.cents;
}

/**
 * What a save writes about the price. `price_set_by` is who decided, and the
 * graded price is kept whenever one was offered so the override can be
 * compared with it later.
 */
export function priceProvenanceFor(
  typedCents: number | null,
  prefill: DraftPricePrefill | null,
  gradedOffer: DraftPricePrefill | null = null,
): { price_set_by: PriceSetBy | null; graded_price_cents: number | null; graded_price_why: string | null } {
  const graded = prefill?.basis === "graded" ? prefill : gradedOffer?.basis === "graded" ? gradedOffer : null;
  if (typedCents == null || !Number.isFinite(typedCents) || typedCents <= 0) {
    return { price_set_by: null, graded_price_cents: graded?.cents ?? null, graded_price_why: graded?.why ?? null };
  }
  if (prefill && typedCents === prefill.cents) {
    return { price_set_by: prefill.basis, graded_price_cents: graded?.cents ?? null, graded_price_why: prefill.why };
  }
  if (graded && typedCents === graded.cents) {
    return { price_set_by: "graded", graded_price_cents: graded.cents, graded_price_why: graded.why };
  }
  return { price_set_by: "seller", graded_price_cents: graded?.cents ?? null, graded_price_why: graded?.why ?? null };
}

/**
 * The audit row for an override: old = the graded price, new = the seller's.
 * Null when there is no graded price to compare against (nothing to audit) or
 * the seller did not override. Shape matches repricing_actions.
 */
export function overrideAuditRow(input: {
  userId: string;
  listingId: string;
  inventoryItemId: string | null;
  typedCents: number | null;
  graded: DraftPricePrefill | null;
}): {
  user_id: string;
  listing_id: string;
  inventory_item_id: string | null;
  old_price_cents: number;
  new_price_cents: number;
  reason: "seller_override";
  ebay_synced: false;
} | null {
  if (!input.graded || input.graded.basis !== "graded") return null;
  if (!isSellerOverride(input.typedCents, input.graded)) return null;
  return {
    user_id: input.userId,
    listing_id: input.listingId,
    inventory_item_id: input.inventoryItemId,
    old_price_cents: input.graded.cents,
    new_price_cents: input.typedCents as number,
    reason: "seller_override",
    ebay_synced: false,
  };
}

export function dollarsToCents(v: string | number | null | undefined): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
