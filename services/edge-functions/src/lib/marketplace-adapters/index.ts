import { ebayAdapter } from "./ebay.ts";
import { poshmarkAdapter } from "./poshmark.ts";
import { mercariAdapter } from "./mercari.ts";
import { depopAdapter } from "./depop.ts";
import type { CrossListingPlatform, MarketplaceAdapter } from "./types.ts";

export * from "./types.ts";

const ADAPTERS: Record<CrossListingPlatform, MarketplaceAdapter> = {
  ebay: ebayAdapter,
  poshmark: poshmarkAdapter,
  mercari: mercariAdapter,
  depop: depopAdapter,
};

export function getAdapter(platform: CrossListingPlatform): MarketplaceAdapter {
  return ADAPTERS[platform];
}
