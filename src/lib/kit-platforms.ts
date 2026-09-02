// US-3046: which marketplaces the cross-list copy kit is written for.
//
// One list, read by the composer's Listing Kit (its tabs) and by the drafts
// page (its "fill the kit" bulk action), so a channel that joins one cannot be
// missing from the other. The edge holds the same list in
// services/edge-functions/src/lib/cross-list-kit.ts and its test pins the
// order; if this list changes, that one changes in the same commit.

import {
  manualKitPlatforms,
  type MarketplacePlatform,
} from "@/lib/marketplace-specs";
import { filterChannels } from "@/lib/cross-post-channels";

// Copy-paste targets: the no-API platforms (Poshmark/Mercari/Grailed/Vinted)
// plus Depop until its partner API is live (US-712/713/714). Shopify + eBay
// push via their adapters, so they're not copy-paste targets. Facebook is
// deliberately absent: its lister flow is still `verifying` in selectors.js,
// so a tab here would offer a send that reports "list manually".
export const KIT_PLATFORMS: MarketplacePlatform[] = [
  "poshmark",
  "mercari",
  "depop",
  "grailed",
  "vinted",
].filter((p) =>
  p === "depop" ? true : manualKitPlatforms().includes(p as MarketplacePlatform)
) as MarketplacePlatform[];

/**
 * The kit channels for this seller, for the KIT'S OWN button.
 *
 * Narrowed by the selection, never empty: a selection that excludes every
 * copy-paste channel (an eBay-and-Shopify seller) still gets the full set
 * rather than a card with no tabs and no explanation. The edge's
 * kitPlatformsForSeller applies the same rule to the batch, minus that
 * fallback: a seller who switched every copy-paste channel off gets no kit.
 */
export function kitPlatformsFor(
  selected: string[] | null | undefined,
): MarketplacePlatform[] {
  const narrowed = filterChannels(KIT_PLATFORMS, selected);
  return narrowed.length > 0 ? narrowed : KIT_PLATFORMS;
}
