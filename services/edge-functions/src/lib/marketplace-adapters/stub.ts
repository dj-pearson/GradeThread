import { mapSiblingListingFields } from "../cross-listing-fields.ts";
import {
  type CrossListingPlatform,
  type MarketplaceAdapter,
  notImplemented,
} from "./types.ts";

// Stub adapter factory (US-708, supersedes the per-file stubs from US-149).
// Every connection/listing/sync method returns the typed 501 NotImplemented so
// cross-push can mint the platform's local `listings` row today and publish it
// once the integration ships — the registry never silently falls through to
// eBay. mapDraftToListing is real (it's pure), so the sibling row is mapped
// correctly the moment the platform is selected.
export function makeStubAdapter(
  platform: CrossListingPlatform,
): MarketplaceAdapter {
  return {
    platform,
    connect: () => Promise.resolve(notImplemented(platform)),
    refreshToken: () => Promise.resolve(notImplemented(platform)),
    publish: () => Promise.resolve(notImplemented(platform)),
    updateListing: () => Promise.resolve(notImplemented(platform)),
    delist: () => Promise.resolve(notImplemented(platform)),
    syncListings: () => Promise.resolve(notImplemented(platform)),
    syncOrders: () => Promise.resolve(notImplemented(platform)),
    mapDraftToListing: (input) =>
      mapSiblingListingFields(platform, input.source, input.price, input.variant),
  };
}
