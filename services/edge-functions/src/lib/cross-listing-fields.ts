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
  type DraftFields,
  getMarketplaceSpec,
  validateListingForPlatform,
  type ValidationResult,
} from "./marketplace-specs.ts";
import { trimToLimit } from "./platform-variants.ts";

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
  tags?: string[];
  confidence?: number;
  validation?: unknown;
  generated_at?: string;
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
 * no variant has been generated. Price always comes from the composer.
 */
export function mapSiblingListingFields(
  platform: CrossListingPlatform,
  source: SourceDraftCopy,
  price: number,
  variant: StoredPlatformVariant | null | undefined,
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

  // When a variant exists, persist the clamped title/description + composer
  // price back into the structured blob so the sibling row is self-consistent.
  const merged: StoredPlatformVariant | null = variant
    ? {
      ...variant,
      title: listing_title ?? undefined,
      description: listing_description ?? undefined,
      price,
    }
    : null;

  return {
    listing_title,
    listing_description,
    listing_price: price,
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
  const draft: DraftFields = {
    title: mapped.listing_title ?? "",
    description: mapped.listing_description ?? "",
    price: mapped.listing_price,
    category: variant?.category ?? "",
    department: variant?.category ?? "",
    condition: variant?.condition?.value ?? "",
    brand: variant?.brand ?? "",
    designer: variant?.brand ?? "",
    size: variant?.size ?? "",
    color: variant?.color ?? "",
    tags: variant?.tags ?? [],
  };
  return validateListingForPlatform(platform, draft, { photoCount });
}
