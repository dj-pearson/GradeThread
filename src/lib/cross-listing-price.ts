// US-3317: the per-channel price rule, on the SPA side of the boundary.
//
// MIRRORED, character for character below this header, from
// services/edge-functions/src/lib/cross-listing-fields.ts — `resolveSiblingPrice`
// and the two types it returns, and nothing else from that file. The edge and
// the SPA share no module graph, so the rule that decides what one item costs on
// one marketplace has to exist twice; the two copies are pinned token-for-token
// by src/test/cross-listing-price-mirror.test.ts, the same arrangement
// marketplace-price.ts and aspect-normalize.ts already have.
//
// WHY THE SPA NEEDS IT. Three callers build a price for one marketplace: the
// cross-push fan-out, the queued extension job, and the Listing Kit's
// send-to-extension button. The first two are on the edge and agree. The desk
// was the third opinion — listing-kit.tsx read the eBay draft row and sent the
// SHARED price, so an item a seller had priced at $40 on Poshmark reached the
// extension at eBay's $52 whenever they pressed the button themselves, while the
// same item queued from their phone went at $40. The path a human chose
// deliberately was the one that disagreed with the stored row, and nothing
// anywhere said so.
//
// NOT A FOURTH UNIT CROSSING. Every dollars<->cents conversion below still goes
// through src/lib/marketplace-price.ts, which is itself the mirror of the edge's
// copy. This file adds a precedence rule, not a unit rule.

import { getMarketplaceSpec, type MarketplacePlatform } from "@/lib/marketplace-specs";
import {
  centsToDollars,
  dollarsToCents,
  stepPriceCents,
} from "@/lib/marketplace-price";

// The edge names this type after its cross-listing adapter registry; the SPA's
// name for the same marketplaces is MarketplacePlatform. Aliased here rather
// than renamed in the body, so the mirrored code below stays identical.
type CrossListingPlatform = MarketplacePlatform;

/** Which of the candidate prices `resolveSiblingPrice` actually used. */
export type SiblingPriceSource = "explicit" | "override" | "shared" | "none";

export interface ResolvedSiblingPrice {
  /** Dollars, in the units this marketplace's own price field accepts. */
  price: number;
  /** The same number as integer cents — the unit every money rule works in. */
  priceCents: number;
  source: SiblingPriceSource;
}

/**
 * THE per-platform price rule for a cross-listing sibling (US-2736).
 *
 * Precedence, first POSITIVE wins — not first non-null, for the reason the kit
 * and the variant generator already give: a stale 0 on a row must not shadow a
 * real price further down the list.
 *
 *   1. explicit — the seller typed a price for this channel on this push.
 *   2. override — the seller typed one on an EARLIER push and it was stored.
 *   3. shared   — the item's own price (the eBay draft, then its target price).
 *
 * Then, and only then, the number is rounded to the marketplace's own step
 * (`MarketplaceSpec.priceStep`, 1 on Poshmark and Vinted). That last part is
 * what stopped a `listings` row from recording 3249 cents for a listing
 * Poshmark can only hold at 3200: every downstream number — profit, payout
 * reconciliation, the revise price the extension types back in — was then wrong
 * by the difference, and the row looked perfectly ordinary.
 *
 * @returns 0 cents when there is no usable candidate. Never a guess.
 */
export function resolveSiblingPrice(
  platform: CrossListingPlatform,
  input: {
    explicitPrice?: number | null;
    overridePrice?: number | null;
    sharedPrice?: number | null;
  },
): ResolvedSiblingPrice {
  const stepCents = dollarsToCents(getMarketplaceSpec(platform)?.priceStep ?? 0);
  const candidates: Array<[number | null | undefined, SiblingPriceSource]> = [
    [input.explicitPrice, "explicit"],
    [input.overridePrice, "override"],
    [input.sharedPrice, "shared"],
  ];
  for (const [value, source] of candidates) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const priceCents = stepPriceCents(dollarsToCents(value), stepCents);
    return { price: centsToDollars(priceCents), priceCents, source };
  }
  return { price: 0, priceCents: 0, source: "none" };
}
