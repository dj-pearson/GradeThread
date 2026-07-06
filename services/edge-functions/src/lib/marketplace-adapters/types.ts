// Marketplace adapter contract (US-708) — the abstraction US-149/US-564/US-599
// all assumed but was never fully built. One adapter per marketplace FlipDesk
// can connect, publish, update, sync, and delist on. eBay and Shopify are fully
// wired (eBay → US-121 publish pipeline; Shopify → the Admin API, US-599);
// Poshmark, Mercari, and Depop are stubs whose connection/listing/sync methods
// return a typed NotImplemented so the registry can mint their local `listings`
// rows today and publish them once each integration ships — no caller changes
// needed. Their mapDraftToListing is real (it's pure), so a sibling row is
// mapped correctly the moment the platform is selected.
//
// SECURITY (US-268): every adapter method that touches a tenant table is keyed
// to the `ownerId` the dispatcher passes. `marketplace_connections` (00008) is
// the single token store for EVERY adapter — per-provider OAuth scopes live in
// its `scopes[]` column — so adding a connector never adds a token table.

import type {
  SiblingListingFields,
  SourceDraftCopy,
  StoredPlatformVariant,
} from "../cross-listing-fields.ts";

export type CrossListingPlatform =
  | "ebay"
  | "shopify"
  | "poshmark"
  | "mercari"
  | "depop"
  | "etsy";

export const CROSS_LISTING_PLATFORMS: readonly CrossListingPlatform[] = [
  "ebay",
  "shopify",
  "poshmark",
  "mercari",
  "depop",
  "etsy",
];

export function isCrossListingPlatform(v: string): v is CrossListingPlatform {
  return (CROSS_LISTING_PLATFORMS as readonly string[]).includes(v);
}

// ── Connection lifecycle ─────────────────────────────────────────────────────

export interface AdapterConnectInput {
  /** Workspace owner whose connection is being established (tenant scope). */
  ownerId: string;
  /** CSRF state round-tripped through the provider's OAuth consent. */
  state: string;
  /** Per-shop providers (Shopify) need the shop domain up front; ignored else. */
  shop?: string | null;
}

export type AdapterConnectResult =
  | { ok: true; consentUrl: string }
  | { ok: false; status: number; error: string };

export interface AdapterOwnerInput {
  ownerId: string;
}

// ── Listing lifecycle ────────────────────────────────────────────────────────

export interface AdapterPublishInput {
  /** Workspace owner the listing belongs to (tenant scope, US-268). */
  ownerId: string;
  inventoryItemId: string;
  /** The denormalized listings row created for this platform. */
  listingRowId: string;
  /** Per-platform price chosen in the composer. */
  price: number;
}

// Every wired adapter's publish is an idempotent create-or-replace, so updating
// a live listing is just a re-publish — updateListing reuses publish's inputs.
export type AdapterUpdateInput = AdapterPublishInput;

export interface AdapterEndInput {
  ownerId: string;
  listingRowId: string;
  platformOfferId: string | null;
  platformListingId: string | null;
}

export type AdapterResult =
  | { ok: true; platformListingId?: string; listingUrl?: string }
  | { ok: false; status: number; error: string; blockers?: string[] };

// ── Sync (pull marketplace state into the local tables) ───────────────────────

export type AdapterSyncResult =
  | { ok: true; detail?: string }
  | { ok: false; status: number; error: string };

// ── Draft → listing mapping (pure, no I/O) ────────────────────────────────────

export interface AdapterPhoto {
  url: string;
  sortOrder?: number;
}

export interface AdapterDraftInput {
  /** The shared source draft a sibling is derived from (fallback copy). */
  source: SourceDraftCopy;
  /** Per-platform price chosen in the composer. */
  price: number;
  /** The AI-generated per-platform variant (US-721), when one exists. */
  variant?: StoredPlatformVariant | null;
  /** Resolved listing photos, ordered. Carried for adapters that need them. */
  photos?: AdapterPhoto[];
  /** Category aspects / item-specifics (eBay) the mapping may fold in. */
  aspects?: Record<string, string[]>;
}

// ── The contract ──────────────────────────────────────────────────────────────

export interface MarketplaceAdapter {
  platform: CrossListingPlatform;

  /** Begin OAuth: returns the provider consent URL to redirect the owner to. */
  connect(input: AdapterConnectInput): Promise<AdapterConnectResult>;
  /** Refresh the owner's stored access token (no-op for non-expiring tokens). */
  refreshToken(input: AdapterOwnerInput): Promise<AdapterResult>;

  /** Push the platform's `listings` row live on the marketplace. */
  publish(input: AdapterPublishInput): Promise<AdapterResult>;
  /** Update an already-live listing (idempotent create-or-replace). */
  updateListing(input: AdapterUpdateInput): Promise<AdapterResult>;
  /** End/withdraw the live listing on the marketplace. */
  delist(input: AdapterEndInput): Promise<AdapterResult>;

  /** Pull live listings from the marketplace into the local tables. */
  syncListings(input: AdapterOwnerInput): Promise<AdapterSyncResult>;
  /** Pull recent orders from the marketplace into the local tables. */
  syncOrders(input: AdapterOwnerInput): Promise<AdapterSyncResult>;

  /** Map a shared draft (+ photos/aspects) onto this platform's listing row. */
  mapDraftToListing(input: AdapterDraftInput): SiblingListingFields;
}

// A single 501 shape, structurally assignable to the false branch of every
// adapter result union (AdapterResult / AdapterConnectResult / AdapterSyncResult),
// so an unwired capability returns it directly — never a thrown error and never
// a silent eBay fallthrough (closes the US-599 gap).
export type NotImplementedResult = { ok: false; status: 501; error: string };

export function notImplemented(
  platform: CrossListingPlatform,
): NotImplementedResult {
  return {
    ok: false,
    status: 501,
    error:
      `${platform} isn't wired up yet — the listing was saved locally and ` +
      `can be pushed once the ${platform} integration ships.`,
  };
}
