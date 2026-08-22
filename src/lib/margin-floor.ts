// The margin floor, with postage in it (US-2790).
//
// WHY THIS IS NOT INLINE IN THE PAGE. autolister-bulk-edit.tsx is under a
// shrink-only line ratchet (US-2520: "the AutoLister surfaces only get
// smaller"), and adding the parcel lookup there pushed it over. The ratchet was
// right: the spec names THREE call sites that need this same number — the bulk
// grid, the drafts list at two places, and the composer — and three copies of a
// pricing rule is how they end up disagreeing about what a garment costs to
// send.
//
// So the rule lives here once and the surfaces call it.

import { priceForMargin } from "./listing-profit";
import { estimateParcel, type ParcelInput } from "./parcel-estimate";
import { estimatePostage } from "./shipping-rates";

export interface MarginFloorWithPostage {
  /** The floor price, or null when the target margin is unreachable. */
  floor: number | null;
  /** Predicted postage in dollars, or null when no sourced band covers it. */
  postageUsd: number | null;
  /** Predicted billable ounces, for a UI that wants to show its working. */
  billableOz: number;
  /**
   * True when postage could NOT be predicted and the floor therefore ignores
   * it — i.e. the pre-US-2790 behaviour, for this row only.
   *
   * Surfaced rather than swallowed. Falling back to free postage silently is
   * the exact defect this module fixes; falling back and saying so is a
   * different thing.
   */
  postageUnknown: boolean;
}

/**
 * The lowest list price that still hits `targetMarginPct` once predicted
 * postage is counted as a cost.
 *
 * The estimate is PREDICTED, not quoted. At listing time there is no buyer, so
 * there is no destination and no true postage — this is a number for making a
 * pricing decision, and accounting already has the real figure from the payout
 * sync. It is strictly better than the zero it replaces.
 */
export function marginFloorWithPostage(
  item: ParcelInput,
  targetMarginPct: number,
  costBasis: number | null,
): MarginFloorWithPostage {
  const parcel = estimateParcel(item);
  const postage = estimatePostage(parcel.billableWeightOz);
  return {
    floor: priceForMargin({
      targetMarginPct,
      costBasis,
      shippingCost: postage?.priceUsd ?? null,
    }),
    postageUsd: postage?.priceUsd ?? null,
    billableOz: parcel.billableWeightOz,
    postageUnknown: postage == null,
  };
}
