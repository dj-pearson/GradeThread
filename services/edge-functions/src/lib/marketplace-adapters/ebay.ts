import {
  publishItemForOwner,
  triggerEbaySyncForUser,
} from "../../routes/flipdesk-ebay.ts";
import {
  buildConsentUrl,
  getUserAccessToken,
  isEbayConfigured,
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

  // The eBay pull-sync reconciles both listings and orders in one run.
  async syncListings(input) {
    return syncResultFrom(await triggerEbaySyncForUser(input.ownerId));
  },
  async syncOrders(input) {
    return syncResultFrom(await triggerEbaySyncForUser(input.ownerId));
  },

  mapDraftToListing(input) {
    return mapSiblingListingFields("ebay", input.source, input.price, input.variant);
  },
};
