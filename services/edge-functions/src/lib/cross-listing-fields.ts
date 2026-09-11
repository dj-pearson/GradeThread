// US-564: per-marketplace field mapping for the cross-list fan-out.
//
// Cross-push (US-149) fans one source draft into a sibling listings row per
// platform. Historically it copied the eBay title/description verbatim into
// every sibling — ignoring each marketplace's char limits, condition wording,
// and category. This module maps the shared AI draft (US-721 platform variants,
// persisted in listings.platform_fields) onto each sibling row so the right
// fields land on the right platform.
//
// Pure (no I/O) so it unit-tests directly. The route resolves/generates the
// variants and persists what this returns.

import type { CrossListingPlatform } from "./marketplace-adapters/types.ts";
import {
  type CrossListDraft,
  getMarketplaceSpec,
  projectDraftFields,
  validateListingForPlatform,
  type ValidationResult,
} from "./marketplace-specs.ts";
import { trimToLimit } from "./platform-variants.ts";
// US-2739 owns the unit boundary. Every dollars<->cents crossing in this file
// goes through it; there is no fifth one.
import {
  centsToDollars,
  dollarsToCents,
  stepPriceCents,
} from "./marketplace-price.ts";

// The per-platform variant as persisted in listings.platform_fields (US-721).
// Schema-light by design (jsonb); every field is optional.
export interface StoredPlatformVariant {
  title?: string;
  description?: string;
  condition?: { value: string; label: string } | null;
  category?: string;
  brand?: string | null;
  color?: string | null;
  size?: string | null;
  price?: number;
  /**
   * US-2736: the price the seller set for THIS channel, as opposed to the
   * shared one the item carries.
   *
   * `price` is what the sibling row currently costs and is rewritten on every
   * push; this is the seller's intent, and it is what makes a per-channel price
   * survive. Without it a re-push had only the shared eBay number to work from,
   * so a Depop listing deliberately set $4 higher was quietly repriced back to
   * eBay's number the next time anything touched it — and nothing anywhere said
   * so. Absent means "no per-channel price was ever set", which is not the same
   * as 0 and must never be stored as 0.
   */
  price_override?: number;
  tags?: string[];
  confidence?: number;
  validation?: unknown;
  generated_at?: string;
}

/** Which of the candidate prices `resolveSiblingPrice` actually used. */
export type SiblingPriceSource = "explicit" | "override" | "shared" | "none";

export interface ResolvedSiblingPrice {
  /** Dollars, in the units this marketplace's own price field accepts. */
  price: number;
  /** The same number as integer cents — the unit every money rule works in. */
  priceCents: number;
  source: SiblingPriceSource;
}

/**
 * THE per-platform price rule for a cross-listing sibling (US-2736).
 *
 * Precedence, first POSITIVE wins — not first non-null, for the reason the kit
 * and the variant generator already give: a stale 0 on a row must not shadow a
 * real price further down the list.
 *
 *   1. explicit — the seller typed a price for this channel on this push.
 *   2. override — the seller typed one on an EARLIER push and it was stored.
 *   3. shared   — the item's own price (the eBay draft, then its target price).
 *
 * Then, and only then, the number is rounded to the marketplace's own step
 * (`MarketplaceSpec.priceStep`, 1 on Poshmark and Vinted). That last part is
 * what stopped a `listings` row from recording 3249 cents for a listing
 * Poshmark can only hold at 3200: every downstream number — profit, payout
 * reconciliation, the revise price the extension types back in — was then wrong
 * by the difference, and the row looked perfectly ordinary.
 *
 * @returns 0 cents when there is no usable candidate. Never a guess.
 */
export function resolveSiblingPrice(
  platform: CrossListingPlatform,
  input: {
    explicitPrice?: number | null;
    overridePrice?: number | null;
    sharedPrice?: number | null;
  },
): ResolvedSiblingPrice {
  const stepCents = dollarsToCents(getMarketplaceSpec(platform)?.priceStep ?? 0);
  const candidates: Array<[number | null | undefined, SiblingPriceSource]> = [
    [input.explicitPrice, "explicit"],
    [input.overridePrice, "override"],
    [input.sharedPrice, "shared"],
  ];
  for (const [value, source] of candidates) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const priceCents = stepPriceCents(dollarsToCents(value), stepCents);
    return { price: centsToDollars(priceCents), priceCents, source };
  }
  return { price: 0, priceCents: 0, source: "none" };
}

// The shared source draft a sibling is derived from (the fallback copy).
export interface SourceDraftCopy {
  listing_title: string | null;
  listing_description: string | null;
}

// What cross-push writes onto a platform's sibling listings row.
export interface SiblingListingFields {
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number;
  // The structured per-platform map, self-contained on the sibling row so the
  // Listing Kit / adapters can read it without going back to the base draft.
  // null when no AI variant exists yet (the sibling falls back to the copy).
  platform_fields: Record<string, StoredPlatformVariant> | null;
}

/**
 * Per-marketplace field mapping (US-564 AC3). Prefers the AI-generated variant
 * (US-721) for title/description and carries its structured fields
 * (condition/category/tags/brand/size/color) onto the sibling row. Falls back
 * to the shared source draft copy, trimmed to the platform's char limits, when
 * no variant has been generated.
 *
 * PRICE (US-2736). The caller decides WHICH price this sibling gets — it is the
 * one that knows about explicit overrides and stored ones. This function decides
 * what UNITS it lands in, and it is the only place that does, so `listing_price`
 * and `platform_fields[platform].price` cannot come out of here disagreeing.
 * `priceOverride`, when given, is persisted alongside so the NEXT push can read
 * the seller's per-channel intent back instead of falling to the shared price.
 */
export function mapSiblingListingFields(
  platform: CrossListingPlatform,
  source: SourceDraftCopy,
  price: number,
  variant: StoredPlatformVariant | null | undefined,
  /** The seller's per-channel price, to record on the sibling. Null = none. */
  priceOverride?: number | null,
): SiblingListingFields {
  const spec = getMarketplaceSpec(platform);
  const titleMax = spec?.titleMaxLength ?? null;
  const descMax = spec?.descriptionMaxLength ?? null;

  const rawTitle = variant?.title ?? source.listing_title ?? "";
  const rawDesc = variant?.description ?? source.listing_description ?? "";

  // A platform with no title field (Depop: titleMaxLength === null) carries no
  // title; every other platform's title is clamped to its cap.
  const listing_title = spec && spec.titleMaxLength == null
    ? null
    : (trimToLimit(rawTitle, titleMax) || null);
  const listing_description = trimToLimit(rawDesc, descMax) || null;

  // US-2736: the marketplace's own units, once, here. `resolveSiblingPrice` is
  // handed the caller's already-chosen number in the `shared` slot on purpose —
  // the precedence was settled before this call; what is left is the rounding.
  const listing_price = resolveSiblingPrice(platform, { sharedPrice: price }).price;
  const storedOverride = typeof priceOverride === "number" &&
      Number.isFinite(priceOverride) && priceOverride > 0
    ? resolveSiblingPrice(platform, { sharedPrice: priceOverride }).price
    : null;

  // When a variant exists, persist the clamped title/description + the resolved
  // price back into the structured blob so the sibling row is self-consistent.
  // An override with NO variant still needs somewhere to live, so it gets a
  // price-only blob rather than being dropped — a seller who priced a channel
  // before generating its kit is the ordinary case, not an edge one.
  const merged: StoredPlatformVariant | null = variant
    ? {
      ...variant,
      title: listing_title ?? undefined,
      description: listing_description ?? undefined,
      price: listing_price,
      ...(storedOverride != null ? { price_override: storedOverride } : {}),
    }
    : storedOverride != null
    ? { price: listing_price, price_override: storedOverride }
    : null;

  return {
    listing_title,
    listing_description,
    listing_price,
    platform_fields: merged ? { [platform]: merged } : null,
  };
}

/**
 * US-725: cross-list pre-flight validation for a mapped sibling, run by the
 * cross-push fan-out BEFORE it asks the platform's API adapter to publish.
 * Projects the mapped sibling (clamped title/description + the structured
 * per-platform variant) onto the registry's DraftFields shape and validates it
 * against that platform's spec (required fields, char limits, allowed condition
 * value, category/tag rules — US-719/720/722). Error-level issues block publish;
 * warnings are advisory. eBay validates itself in assemblePublishContext, so
 * this is the shared check for the other API-push siblings (Shopify/Depop/…).
 */
export function validateSiblingForPublish(
  platform: CrossListingPlatform,
  mapped: SiblingListingFields,
  photoCount?: number,
): ValidationResult {
  const variant = mapped.platform_fields?.[platform];
  // US-3202: the projection moved into marketplace-specs.ts so the composer's
  // per-channel readiness readout runs the SAME one. It used to be inlined
  // here, which meant the only way to show a seller what would block a publish
  // was to re-derive it in the SPA and hope the two stayed in step.
  //
  // The title/description arriving here are already clamped by
  // mapSiblingListingFields, so projectDraftFields' own clamp is a no-op on this
  // path and the behaviour is unchanged.
  const draft: CrossListDraft = {
    title: mapped.listing_title ?? "",
    description: mapped.listing_description ?? "",
    price: mapped.listing_price,
    category: variant?.category ?? "",
    condition: variant?.condition?.value ?? "",
    brand: variant?.brand ?? "",
    size: variant?.size ?? "",
    color: variant?.color ?? "",
    tags: variant?.tags ?? [],
  };
  return validateListingForPlatform(
    platform,
    projectDraftFields(platform, draft),
    { photoCount },
  );
}
