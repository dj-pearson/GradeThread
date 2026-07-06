import { ebayAdapter } from "./ebay.ts";
import { shopifyAdapter } from "./shopify.ts";
import { poshmarkAdapter } from "./poshmark.ts";
import { mercariAdapter } from "./mercari.ts";
import { depopAdapter } from "./depop.ts";
import { etsyAdapter } from "./etsy.ts";
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
