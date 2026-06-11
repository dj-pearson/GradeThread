import { publishItemForOwner } from "../../routes/flipdesk-ebay.ts";
import { withdrawOffer } from "../ebay-client.ts";
import type { MarketplaceAdapter } from "./types.ts";

// eBay adapter — thin wrapper over the US-121 publish pipeline so cross-push
// and the single-platform publish path share the identical flow (preflight
// blockers, image reachability, offer adopt/relist semantics).
export const ebayAdapter: MarketplaceAdapter = {
  platform: "ebay",

  async publish(input) {
    const result = await publishItemForOwner(input.ownerId, input.inventoryItemId);
    if (result.ok) {
      return {
        ok: true,
        platformListingId: result.listing_id,
        listingUrl: result.listing_url,
      };
    }
    const blockers = Array.isArray(result.body.blockers)
      ? (result.body.blockers as string[])
      : undefined;
    const error =
      typeof result.body.error === "string"
        ? result.body.error
        : blockers?.join("; ") ?? "eBay publish failed.";
    return { ok: false, status: result.status, error, blockers };
  },

  async end(input) {
    if (!input.platformOfferId) {
      return {
        ok: false,
        status: 409,
        error: "This listing has no eBay offer id to withdraw.",
      };
    }
    await withdrawOffer(input.ownerId, input.platformOfferId);
    return { ok: true };
  },
};
