// Marketplace adapter interface for cross-listing dispatch (US-149).
//
// Each platform FlipDesk can push a draft to implements this interface. eBay
// is fully wired (delegates to the US-121 publish pipeline); Poshmark, Mercari,
// and Depop are stubs that return 501 so the cross-push endpoint can create
// their denormalized listings rows today and publish them once each
// integration ships — no caller changes needed.

export type CrossListingPlatform = "ebay" | "poshmark" | "mercari" | "depop";

export const CROSS_LISTING_PLATFORMS: readonly CrossListingPlatform[] = [
  "ebay",
  "poshmark",
  "mercari",
  "depop",
];

export function isCrossListingPlatform(v: string): v is CrossListingPlatform {
  return (CROSS_LISTING_PLATFORMS as readonly string[]).includes(v);
}

export interface AdapterPublishInput {
  /** Workspace owner the listing belongs to (tenant scope, US-268). */
  ownerId: string;
  inventoryItemId: string;
  /** The denormalized listings row created for this platform. */
  listingRowId: string;
  /** Per-platform price chosen in the composer. */
  price: number;
}

export interface AdapterEndInput {
  ownerId: string;
  listingRowId: string;
  platformOfferId: string | null;
  platformListingId: string | null;
}

export type AdapterResult =
  | { ok: true; platformListingId?: string; listingUrl?: string }
  | { ok: false; status: number; error: string; blockers?: string[] };

export interface MarketplaceAdapter {
  platform: CrossListingPlatform;
  /** Push the platform's listings row live on the marketplace. */
  publish(input: AdapterPublishInput): Promise<AdapterResult>;
  /** End/withdraw the live listing on the marketplace. */
  end(input: AdapterEndInput): Promise<AdapterResult>;
}

export function notImplemented(platform: CrossListingPlatform): AdapterResult {
  return {
    ok: false,
    status: 501,
    error:
      `${platform} publishing isn't wired up yet — the listing was saved ` +
      `locally and can be pushed once the ${platform} integration ships.`,
  };
}
