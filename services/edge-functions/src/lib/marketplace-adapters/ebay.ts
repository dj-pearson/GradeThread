import {
  type ListingVariations,
  publishItemForOwner,
  resolveEndStrategy,
  triggerEbaySyncForUser,
} from "../../routes/flipdesk-ebay.ts";
import {
  buildConsentUrl,
  getPublishedListingId,
  getUserAccessToken,
  isEbayConfigured,
  isOfferAlreadyEndedError,
  withdrawByInventoryItemGroup,
  withdrawOffer,
} from "../ebay-client.ts";

import { mapSiblingListingFields } from "../cross-listing-fields.ts";
import type {
  AdapterResult,
  AdapterSyncResult,
  MarketplaceAdapter,
} from "./types.ts";

// eBay adapter (US-708) — implements the MarketplaceAdapter contract as a thin
// wrapper over the already-wired eBay code with NO behavior change:
//   • publish/updateListing → the US-121 publishItemForOwner pipeline (an
//     idempotent inventory-PUT → offer → publish, so an update is a re-publish)
//   • delist               → ebay-client.withdrawOffer
//   • connect/refreshToken → ebay-client consent URL + token refresh, backed by
//     marketplace_connections (the single token store, scopes[] column)
//   • syncListings/syncOrders → triggerEbaySyncForUser (one pull does both)
//   • mapDraftToListing    → the pure cross-listing field mapping (US-564)

// Maps a triggerEbaySyncForUser status into the adapter sync result.
function syncResultFrom(
  status: Awaited<ReturnType<typeof triggerEbaySyncForUser>>,
): AdapterSyncResult {
  switch (status) {
    case "started":
      return { ok: true, detail: "Sync started." };
    case "already_running":
      return { ok: true, detail: "A sync is already running." };
    case "no_connection":
      return { ok: false, status: 400, error: "Connect your eBay account first." };
    case "not_configured":
      return { ok: false, status: 503, error: "eBay is not configured." };
  }
}

export const ebayAdapter: MarketplaceAdapter = {
  platform: "ebay",

  connect(input) {
    if (!isEbayConfigured()) {
      return Promise.resolve({
        ok: false as const,
        status: 503,
        error: "eBay is not configured.",
      });
    }
    try {
      return Promise.resolve({ ok: true as const, consentUrl: buildConsentUrl(input.state) });
    } catch (err) {
      return Promise.resolve({
        ok: false as const,
        status: 500,
        error: err instanceof Error ? err.message : "Could not start eBay connect.",
      });
    }
  },

  async refreshToken(input) {
    try {
      // getUserAccessToken refreshes the stored token if it expires within 60s.
      await getUserAccessToken(input.ownerId);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        status: 401,
        error: err instanceof Error ? err.message : "eBay token refresh failed.",
      };
    }
  },

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
    const error = typeof result.body.error === "string"
      ? result.body.error
      : blockers?.join("; ") ?? "eBay publish failed.";
    return { ok: false, status: result.status, error, blockers };
  },

  // An eBay update is an idempotent re-publish: createOrReplaceInventoryItem +
  // adopt/relist the existing offer. Same flow, same tenant scoping as publish.
  updateListing(input) {
    return ebayAdapter.publish(input);
  },

  async delist(input): Promise<AdapterResult> {
    // US-2166: use the SAME pure decision the eBay-namespaced DELETE route uses
    // (US-1978). A multi-variation listing publishes as an inventory_item_group
    // and carries no platform_offer_id, so the old offer-id-only check reported
    // "no offer id to withdraw" and left it LIVE on eBay. Group is resolved
    // first for exactly that reason.
    const strategy = resolveEndStrategy({
      variations: (input.variations ?? null) as ListingVariations | null,
      itemSku: input.itemSku ?? null,
      platformOfferId: input.platformOfferId,
    });
    // US-1507: withdraw through the account that PUBLISHED this listing, not
    // through whichever connection happens to be primary now. The eBay-namespaced
    // end route has done this since US-1507; this one did not, so a seller with a
    // second eBay connection got a 4xx the caller then read as "already ended" —
    // row marked ended, listing still live and still sellable.
    const connectionId = input.connectionId ?? undefined;
    if (strategy.kind === "group") {
      await withdrawByInventoryItemGroup(input.ownerId, strategy.groupKey, connectionId);
      return { ok: true };
    }
    if (strategy.kind === "offer") {
      try {
        await withdrawOffer(input.ownerId, strategy.offerId, connectionId);
      } catch (err) {
        // US-2641: "eBay refused the withdraw" is not the same fact as "the
        // listing is not live", and the End route treats the first as the second
        // — it marks the row ended and answers ok. That inference is usually
        // right and silently catastrophic when it is wrong: the seller is told
        // the item is off eBay while buyers can still buy it. So ASK. One read of
        // the offer settles it, and it only runs on the failure path.
        if (!isOfferAlreadyEndedError(err)) throw err;
        const stillLive = await getPublishedListingId(
          input.ownerId,
          strategy.offerId,
          connectionId,
        );
        if (stillLive) {
          return {
            ok: false,
            status: 502,
            error:
              "eBay refused to end this listing and it is still live " +
              `(listing ${stillLive}). End it in Seller Hub, then mark it ended here.`,
          };
        }
        // Confirmed not live — let the caller reconcile, which is what
        // isOfferAlreadyEndedError exists for.
        throw err;
      }
      return { ok: true };
    }
    // Nothing live to withdraw. The caller decides whether that is a clean
    // "already gone" or a conflict; saying so honestly beats inventing an id.
    return {
      ok: false,
      status: 409,
      error: "This listing has no eBay offer id to withdraw.",
    };
  },

  // The eBay pull-sync reconciles both listings and orders in one run.
  async syncListings(input) {
    return syncResultFrom(await triggerEbaySyncForUser(input.ownerId, "full"));
  },
  // US-3110: an order sync does not need the offer catalog. Asking for "orders"
  // skips the per-SKU fan-out; resolveSyncScope upgrades it to a full read
  // anyway once the catalog is stale.
  async syncOrders(input) {
    return syncResultFrom(await triggerEbaySyncForUser(input.ownerId, "orders"));
  },

  mapDraftToListing(input) {
    return mapSiblingListingFields("ebay", input.source, input.price, input.variant);
  },
};
