import { ebayAdapter } from "./ebay.ts";
import { shopifyAdapter } from "./shopify.ts";
import { poshmarkAdapter } from "./poshmark.ts";
import { mercariAdapter } from "./mercari.ts";
import { depopAdapter } from "./depop.ts";
import { etsyAdapter } from "./etsy.ts";
import { whatnotAdapter } from "./whatnot.ts";
import { grailedAdapter } from "./grailed.ts";
import { vintedAdapter } from "./vinted.ts";
import { facebookAdapter } from "./facebook.ts";
import {
  type CrossListingPlatform,
  isCrossListingPlatform,
  type MarketplaceAdapter,
} from "./types.ts";

export * from "./types.ts";

const ADAPTERS: Record<CrossListingPlatform, MarketplaceAdapter> = {
  ebay: ebayAdapter,
  shopify: shopifyAdapter,
  poshmark: poshmarkAdapter,
  mercari: mercariAdapter,
  depop: depopAdapter,
  etsy: etsyAdapter,
  whatnot: whatnotAdapter,
  // US-3447: extension channels. Their publish path is the extension work
  // queue, not this adapter, so a stub is correct here; they are registered
  // because CROSS_LISTING_PLATFORMS is what the /cross-push route validates
  // against, and an unlisted channel 400s the entire fan-out.
  grailed: grailedAdapter,
  vinted: vintedAdapter,
  facebook: facebookAdapter,
};

// Registry lookup for an already-narrowed platform.
export function getAdapter(platform: CrossListingPlatform): MarketplaceAdapter {
  return ADAPTERS[platform];
}

// US-708: resolve an adapter from a raw `listings.platform` string. Returns
// null for an unknown platform so the dispatcher can surface a typed
// NotImplemented instead of silently treating it as eBay (the US-599 gap). Use
// this — never a hardcoded eBay branch — when routing by a stored platform.
export function resolveAdapter(
  platform: string | null | undefined,
): MarketplaceAdapter | null {
  if (!platform || !isCrossListingPlatform(platform)) return null;
  return ADAPTERS[platform];
}
