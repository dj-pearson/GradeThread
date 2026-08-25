import type { ListingFormat } from "@/types/database";
import type { SellerListingDefaults } from "@/hooks/use-seller-listing-defaults";

// US-2852: turn a seller's listing defaults into the composer's starting state.
//
// THE ONE RULE: these SEED a draft that has no listings row yet. The moment a
// listing row exists, its own columns own every value here — including the
// falsey ones. `best_offer_enabled = false` on a saved listing is a decision the
// seller made, not an absent value, so it must not be re-seeded from a default
// that happens to say true. That is why every resolver below takes the saved
// listing first and only falls through when the whole row is missing.
//
// Kept pure and out of composer.tsx so the precedence is testable without
// mounting a 3,000-line page.

/** eBay's five auction durations, mirrored from AUCTION_DURATIONS in constants.ts. */
const VALID_DURATIONS = new Set([
  "DAYS_1",
  "DAYS_3",
  "DAYS_5",
  "DAYS_7",
  "DAYS_10",
]);

export const PLATFORM_AUCTION_DURATION = "DAYS_7";
export const PLATFORM_LISTING_FORMAT: ListingFormat = "fixed_price";
export const PLATFORM_QUANTITY = 1;

/** The subset of a saved listings row the seed cares about. Null = no row yet. */
export interface SeedListingRow {
  listing_format?: string | null;
  auction_duration?: string | null;
  best_offer_enabled?: boolean | null;
  best_offer_auto_accept_cents?: number | null;
  best_offer_auto_decline_cents?: number | null;
  quantity?: number | null;
}

export function resolveSeedFormat(
  listing: SeedListingRow | null | undefined,
  defaults: SellerListingDefaults | null | undefined,
): ListingFormat {
  if (listing) {
    return listing.listing_format === "auction" ? "auction" : "fixed_price";
  }
  return defaults?.default_listing_format === "auction"
    ? "auction"
    : defaults?.default_listing_format === "fixed_price"
      ? "fixed_price"
      : PLATFORM_LISTING_FORMAT;
}

export function resolveSeedAuctionDuration(
  listing: SeedListingRow | null | undefined,
  defaults: SellerListingDefaults | null | undefined,
): string {
  if (listing?.auction_duration) return listing.auction_duration;
  const d = defaults?.default_auction_duration;
  return d && VALID_DURATIONS.has(d) ? d : PLATFORM_AUCTION_DURATION;
}

export function resolveSeedQuantity(
  listing: SeedListingRow | null | undefined,
  defaults: SellerListingDefaults | null | undefined,
  format: ListingFormat,
): number {
  if (listing?.quantity != null && listing.quantity > 0) return listing.quantity;
  // An auction is single-quantity by definition — a default of 5 must not leak
  // into one (resolveQuantity would override it at save anyway, but seeding the
  // box with 5 and saving 1 is a lie the seller reads before we correct it).
  if (format === "auction") return PLATFORM_QUANTITY;
  const q = defaults?.default_listing_quantity;
  return q != null && Number.isFinite(q) && q > 0
    ? Math.floor(q)
    : PLATFORM_QUANTITY;
}

/** Best Offer is a separate opt-in per format — see the 00668 column comment. */
export function resolveSeedBestOfferEnabled(
  listing: SeedListingRow | null | undefined,
  defaults: SellerListingDefaults | null | undefined,
  format: ListingFormat,
): boolean {
  if (listing) return listing.best_offer_enabled ?? false;
  return format === "auction"
    ? (defaults?.default_best_offer_on_auction ?? false)
    : (defaults?.default_best_offer_enabled ?? false);
}

/**
 * Percent-of-price default -> whole cents. Returns null when there is no
 * default, when Best Offer is off, or when there is no price to take a percent
 * of yet — a threshold derived from a zero price is the US-2405 bug in a new
 * costume, so it is dropped rather than guessed.
 *
 * The caller still runs resolveBestOfferThresholds() over the pair; this only
 * produces candidates.
 */
export function seedBestOfferCents(
  pct: number | null | undefined,
  priceCents: number,
): number | null {
  if (pct == null || !Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  if (!Number.isFinite(priceCents) || priceCents <= 0) return null;
  const cents = Math.round((priceCents * pct) / 100);
  return cents > 0 ? cents : null;
}

export interface SeedBestOffer {
  enabled: boolean;
  acceptCents: number | null;
  declineCents: number | null;
}

/**
 * The whole Best Offer seed in one call. For a saved listing it is a pass-through
 * of the stored cents; for a new draft it converts the seller's percentages
 * against `priceCents`.
 */
export function resolveSeedBestOffer(
  listing: SeedListingRow | null | undefined,
  defaults: SellerListingDefaults | null | undefined,
  format: ListingFormat,
  priceCents: number,
): SeedBestOffer {
  const enabled = resolveSeedBestOfferEnabled(listing, defaults, format);
  if (listing) {
    return {
      enabled,
      acceptCents: listing.best_offer_auto_accept_cents ?? null,
      declineCents: listing.best_offer_auto_decline_cents ?? null,
    };
  }
  if (!enabled) return { enabled: false, acceptCents: null, declineCents: null };
  return {
    enabled,
    acceptCents: seedBestOfferCents(defaults?.default_best_offer_accept_pct, priceCents),
    declineCents: seedBestOfferCents(defaults?.default_best_offer_decline_pct, priceCents),
  };
}
