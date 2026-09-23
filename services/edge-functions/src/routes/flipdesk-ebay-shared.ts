// Helpers shared by the eBay route files (flipdesk-ebay-*.ts).
//
// Everything here was a top-level declaration of flipdesk-ebay.ts before the
// split and is used by more than one route file (or by none, only by callers
// outside routes/). A helper used by exactly one route file lives in that file.
// Import it through flipdesk-ebay.ts from outside the eBay route files, which
// re-exports everything the module exported before the split.

import { supabaseAdmin } from "../lib/supabase.ts";
import { publicItemPhotoUrl } from "../lib/item-photo-storage.ts";
import { applyColumnAspects, resolveItemAspects } from "../lib/aspect-registry.ts";
import type { RegistryAspect, RegistryItem } from "../lib/aspect-registry.ts";
import { resolveShoeSizeScaleForItem } from "../lib/shoe-size-scale.ts";
import { type ParcelGarmentCategory, type ShoeSizeScale } from "../lib/parcel-estimate.ts";
import { type AspectCoverage, type AspectSourceMap } from "../lib/aspect-provenance.ts";
import { type PublishAspectDiagnostic } from "../lib/aspect-reconcile.ts";
import { type PolicySet } from "../lib/ebay-client.ts";
import { ensureCertificateNumber } from "../lib/cert-number.ts";
import {
  formatGtGrade,
  GT_GRADE_FIELD_NAME,
  GT_GRADE_ITEM_SPECIFIC,
} from "../lib/gt-grade-standard.ts";
import { dedupeAndCapImages, mapGradeToBaseCondition } from "../lib/publish-preflight.ts";

/**
 * US-2796 AC3: which scale this item's stamped shoe number is on.
 *
 * The rows reaching the publish and revise paths are read with wide selects and
 * typed loosely, so this narrows once instead of at each call site. Every field
 * is optional and the resolver returns null when it cannot tell - which is
 * exactly today's behaviour, so a row that happens to be missing a column loses
 * nothing that was working.
 */
export function shoeScaleOf(item: unknown): ShoeSizeScale | null {
  const row = (item ?? {}) as {
    brand?: string | null;
    attributes?: Record<string, string | string[]> | null;
    item_category?: string | null;
    size?: string | null;
    style?: string | null;
    title?: string | null;
    description?: string | null;
    condition_notes?: string | null;
  };
  return resolveShoeSizeScaleForItem({
    brand: row.brand,
    attributes: row.attributes,
    item_category: row.item_category ?? null,
    size: row.size,
    style: row.style,
    title: row.title,
    description: row.description,
    condition_notes: row.condition_notes,
  });
}

// US-2387: ceiling on the fleet-wide connection scans (token refresh,
// performance sync, leave-feedback). A growth bound, not a budget — each scan
// fans out per connection and its cron re-runs on a schedule.
export const EBAY_CONNECTION_SCAN_CAP = 5_000;

export type EbayEnv = {
  Variables: {
    userId: string;
    // Workspace owner — marketplace connections, listings, and payouts all
    // live on the workspace owner since they hold the OAuth tokens.
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

// eBay allows at most 24 pictures per listing (Inventory API product.imageUrls).
// Sending more returns error 25601 ("The size for ImageLinks cannot exceed …").
// Photos arrive sorted by sort_order, so capping keeps the cover + best shots.
// De-dup/cap logic lives in lib/publish-preflight.ts (US-473) so it's shared
// with the pre-flight blocker check and unit-tested in isolation.
export function toEbayImageUrls(urls: Array<string | null | undefined>): string[] {
  return dedupeAndCapImages(urls).urls;
}

/// Resolves the PUBLIC URL eBay should fetch for an `item_photos` row, or null
/// when the photo can't (and must not) be exposed publicly. Existing rows that
/// already carry a public `photo_url` keep working; a sensitive row whose
/// `photo_url` is empty (private bucket) is skipped rather than turned into a
/// broken `item-photos` public URL that 404s — eBay can't fetch a short-TTL
/// signed URL anyway, so these simply aren't pushed (US-979).
/// US-2265: the rule now lives in `publicItemPhotoUrl` (lib/item-photo-storage.ts)
/// so eBay, Depop, Etsy and Shopify share ONE definition of "may this photo be
/// handed to a public marketplace" — the adapters had drifted into minting a
/// public URL for private-bucket tag photos. Kept as a named wrapper because the
/// call sites read as `.map(ebayPublicPhotoUrl)`.
export function ebayPublicPhotoUrl(p: {
  photo_url: string | null;
  storage_path: string | null;
  photo_type?: string | null;
}): string | null {
  return publicItemPhotoUrl(p);
}


// ── Manage helpers ─────────────────────────────────────────────────

interface ListingRowForManage {
  id: string;
  inventory_item_id: string;
  // US-2166: the row's REAL marketplace. These routes live in the eBay
  // namespace but loadListingOwned does not filter by platform, so a non-eBay
  // listing id can reach them — and every origin gate below used to hardcode
  // "ebay", which derives the wrong provenance for such a row and can lock (or
  // fail to lock) the wrong fields. Carrying the actual value removes the
  // guess.
  platform: string | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  // The values that were actually published. A photos-only revise re-PUTs the
  // inventory_item, so we need the live title/description as the basis to
  // avoid silently reverting them to the inventory_items mirror.
  listing_title: string | null;
  listing_description: string | null;
  // US-1080: provenance signals so callers can derive listing_origin (eBay vs
  // GradeThread) and lock eBay-owned fields on eBay-originated listings.
  batch_id: string | null;
  synced_to_ebay_at: string | null;
  // US-1507: the connection that owns this listing (null on legacy/imported rows
  // → callers fall back to the primary connection) + the stored origin so the
  // relist guard can reject imported listings without re-deriving from signals.
  marketplace_connection_id: string | null;
  listing_origin: "ebay" | "gradethread" | null;
  // US-1978 (AC1): the multi-variant matrix (listings.variations) + the parent
  // item's SKU (== the inventory_item_group key at publish, US-568). A non-null
  // variations matrix means this is a GROUP listing, ended via
  // withdrawByInventoryItemGroup rather than the single-offer withdraw path.
  variations: ListingVariations | null;
  // US-1999: the item's CURRENT sku — the seller's item number, freely editable.
  // Do NOT address eBay with it; it may differ from what the listing went live
  // under. Kept only as the derivation input for pre-00477 rows.
  item_sku: string | null;
  // US-1999 (00477): the SKU this listing was PUBLISHED under. Authoritative
  // for every Inventory-API call — including the group-withdraw key, since the
  // inventory_item_group was created under the base SKU at publish time.
  inventory_sku: string | null;
}

type LoadListingResult =
  | { ok: true; listing: ListingRowForManage }
  | { ok: false; error: { error: string }; status: 404 | 403 };

export async function loadListingOwned(
  listingId: string,
  userId: string
): Promise<LoadListingResult> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, platform_offer_id, platform_listing_id, listing_title, listing_description, batch_id, synced_to_ebay_at, marketplace_connection_id, listing_origin, variations, inventory_sku, inventory_items!inner(user_id, sku)"
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!data) {
    return { ok: false, error: { error: "Listing not found" }, status: 404 };
  }
  const row = data as unknown as ListingRowForManage & {
    inventory_items: { user_id: string; sku: string | null };
  };
  if (row.inventory_items.user_id !== userId) {
    return { ok: false, error: { error: "Listing not found" }, status: 404 };
  }
  return {
    ok: true,
    listing: {
      id: row.id,
      inventory_item_id: row.inventory_item_id,
      platform: row.platform,
      platform_offer_id: row.platform_offer_id,
      platform_listing_id: row.platform_listing_id,
      listing_title: row.listing_title,
      listing_description: row.listing_description,
      batch_id: row.batch_id,
      synced_to_ebay_at: row.synced_to_ebay_at,
      marketplace_connection_id: row.marketplace_connection_id,
      listing_origin: row.listing_origin,
      // US-1978 (AC1): coerce the persisted matrix so a group listing ends via
      // the group path; carry the parent SKU (the group key) for the withdraw.
      variations: normalizeVariations(row.variations),
      item_sku: row.inventory_items.sku,
      inventory_sku: row.inventory_sku,
    },
  };
}

export interface PublishPhoto {
  id: string;
  public_url: string;
  sort_order: number;
}

export interface PublishItem {
  id: string;
  user_id: string;
  title: string | null;
  brand: string | null;
  sku: string | null;
  size: string | null;
  description: string | null;
  condition_notes: string | null;
  target_price: number | null;
  grade_value: number | null;
  grade_label: string | null;
  // Public certificate URL, populated when a FlipDesk item is graded
  // (grading-pipeline.ts). Read by the cert-number promotion (text only —
  // US-2382 removed the last image treatment).
  certificate_url: string | null;
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  // US-825: per-aspect provenance parallel to ebay_aspects.
  ebay_aspect_sources: AspectSourceMap | null;
  item_category: string | null;
  // US-2790: the GARMENT enum, and it is NOT item_category. item_category is a
  // merchandising value; feeding it to estimateParcel would fall through to the
  // `other` base weight while still reporting basis ["category"], which is a
  // confident-looking number from a wrong input. The two are read separately
  // and only this one reaches the estimator.
  garment_category: ParcelGarmentCategory | null;
  color: string | null;
  material: string | null;
  style: string | null;
  // US-2790: the tape measurements grading took, which is what makes the
  // predicted parcel better than a category average.
  measurements: Record<string, number | string> | null;
  // US-821 canonical attributes (jsonb). US-822 maps these onto eBay aspects.
  attributes: Record<string, string | string[]> | null;
  status: string;
}

// US-568: multi-variant matrix persisted in listings.variations (migration
// 00160). Mirrors src/types/database.ts ListingVariation(s).
interface ListingVariation {
  aspects: Record<string, string>;
  quantity: number;
  price_cents?: number | null;
  sku_suffix?: string | null;
}
// US-2166: exported so the eBay adapter can type the variation matrix it now
// receives on delist (a group listing has no offer id and must end by group key).
export interface ListingVariations {
  specifications: string[];
  variants: ListingVariation[];
}

// US-568: defensively coerce the persisted JSON into a usable variation matrix.
// Returns null when there is nothing publishable (no specs, fewer than 2
// variants, or every variant out of stock) so the publish path stays on the
// single-SKU flow. Drops malformed variants rather than failing the publish.
export function normalizeVariations(
  raw: ListingVariations | null | undefined,
): ListingVariations | null {
  if (!raw || typeof raw !== "object") return null;
  const specs = Array.isArray(raw.specifications)
    ? raw.specifications
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim())
    : [];
  if (specs.length === 0) return null;
  const variants = Array.isArray(raw.variants)
    ? raw.variants
      .map((v): ListingVariation | null => {
        if (!v || typeof v !== "object" || !v.aspects) return null;
        const aspects: Record<string, string> = {};
        for (const spec of specs) {
          const val = v.aspects[spec];
          if (typeof val === "string" && val.trim() !== "") {
            aspects[spec] = val.trim();
          }
        }
        // Every varies-by spec must have a value for this combination.
        if (Object.keys(aspects).length !== specs.length) return null;
        const quantity =
          typeof v.quantity === "number" && v.quantity > 0
            ? Math.floor(v.quantity)
            : 0;
        return {
          aspects,
          quantity,
          price_cents:
            typeof v.price_cents === "number" && v.price_cents > 0
              ? v.price_cents
              : null,
          sku_suffix:
            typeof v.sku_suffix === "string" && v.sku_suffix.trim() !== ""
              ? v.sku_suffix.trim()
              : null,
        };
      })
      .filter((v): v is ListingVariation => v !== null && v.quantity > 0)
    : [];
  // A "variation" listing needs at least two purchasable combinations.
  if (variants.length < 2) return null;
  return { specifications: specs, variants };
}

// US-568: derive a stable, eBay-safe SKU for one variant from the base SKU. Uses
// the explicit suffix when present, else a slug of the variation values.
export function variantSku(baseSku: string, variant: ListingVariation): string {
  const suffix =
    variant.sku_suffix ??
    Object.values(variant.aspects)
      .join("-")
      .replace(/[^a-zA-Z0-9-]+/g, "")
      .toUpperCase();
  return `${baseSku}-${suffix || "V"}`.slice(0, 50);
}

export interface PublishListing {
  id: string;
  // US-1999 (00477): the SKU eBay holds this listing under. Authoritative for
  // every Inventory call on an already-published listing — a relist must reuse
  // it rather than re-derive from the seller-editable inventory_items.sku.
  inventory_sku: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  // US-312/US-1504: true when listing_price is the AI ESTIMATE (no eBay comps),
  // not a seller-chosen price. At publish, a real item.target_price wins over an
  // estimate so we never list at a stale estimate after the seller set a target.
  price_is_estimated: boolean | null;
  // US-319/320/321: edits made in the composer/bulk editor must reach eBay.
  // These mirror the columns added in 00052_autolister_schema.sql.
  ebay_condition: string | null;
  ebay_condition_description: string | null;
  quantity: number | null;
  best_offer_enabled: boolean | null;
  // US-562 / US-2405: per-listing best-offer auto-clear thresholds (cents), set
  // by the seller by hand. Null means no threshold — the offer waits for them.
  best_offer_auto_accept_cents: number | null;
  best_offer_auto_decline_cents: number | null;
  // US-542 comp range used to derive best-offer thresholds when no override.
  price_range_low_cents: number | null;
  price_range_high_cents: number | null;
  platform_category_id: string | null;
  item_specifics_override: Record<string, string[]> | null;
  // US-825: per-aspect provenance parallel to item_specifics_override.
  item_specifics_sources: AspectSourceMap | null;
  scheduled_publish_at: string | null;
  // US-2382: badge_enabled (00027) and slab_image_mode (00180) are NOT read
  // here on purpose, and are no longer selected either. They were still in the
  // SELECT list after the 2026-06-25 policy retired the image treatment, and
  // that is precisely how US-2247 concluded "publish reads these columns" and
  // shipped a seller-facing switch that did nothing. Being fetched is not
  // being used; the cheapest way to stop that inference recurring is to stop
  // fetching them.
  // US-555: per-listing eBay business-policy overrides (bulk-assigned in the
  // AutoLister grid). When set they win over the account-level defaults at
  // publish; null falls back to the seller's default policy set. Column names
  // mirror listings.{shipping,payment,return}_policy_id (00052).
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  // US-561: Promoted Listings — promo_rate_pct is the seller's accepted/adjusted
  // ad rate (null → use the category suggestion); promo_opt_out turns promotion
  // off for this listing entirely.
  promo_rate_pct: number | null;
  promo_opt_out: boolean | null;
  // 00432: tri-state per-listing promotion override (NULL = inherit the seller
  // default users.promote_listings_by_default; true/false explicit).
  promote_override: boolean | null;
  // US-1447: per-listing Promoted-Listings mode ('cps'|'cpc'|'smart'); null →
  // seller default → cps.
  promo_mode: string | null;
  // US-568: format + auction terms + variation matrix (migration 00160).
  listing_format: string | null;
  auction_start_price_cents: number | null;
  auction_reserve_price_cents: number | null;
  auction_buy_it_now_price_cents: number | null;
  auction_duration: string | null;
  variations: ListingVariations | null;
  // US-1509: provenance + live-state signals so publish never repurposes a row
  // that mirrors an eBay-native listing (deriveListingOrigin inputs + is_active).
  listing_origin: string | null;
  listing_status: string | null;
  is_active: boolean | null;
  platform_listing_id: string | null;
  batch_id: string | null;
  synced_to_ebay_at: string | null;
}

export interface PublishContextOk {
  ok: true;
  // US-1507: the eBay connection this publish resolves to (primary), persisted onto
  // the listings row so a later revise/end/price acts via the SAME account.
  connectionId: string;
  item: PublishItem;
  listing: PublishListing | null;
  photos: PublishPhoto[];
  // null when blockers includes a missing-policy entry. Push must re-check.
  policies: PolicySet | null;
  blockers: string[];
  // US-1890: non-blocking title-quality findings (duplicate tokens, ALL-CAPS,
  // promotional filler) for the composer to surface. Publish is not blocked.
  // US-1896 also folds picture-standards (hero <1600px zoom-disabled) warnings here.
  warnings: string[];
  // US-1896: hero-thumbnail reorder nudge ("your search thumbnail is a tag shot —
  // drag a full front view first"), or null when the first photo is a full view.
  photoNudge: string | null;
  // US-1895: how many of eBay's RECOMMENDED aspects (ranked by 30-day buyer
  // search volume) the listing fills — surfaced non-blocking in the composer.
  recommendedCoverage: AspectCoverage;
  // US-828: aspect values omitted from the eBay payload for value-validation
  // reasons, so the client can surface "X was not sent" (empty = nothing dropped).
  aspectDiagnostics: PublishAspectDiagnostic[];
  /** US-3474: free-text values sent as written, off eBay's list. Never blocks. */
  aspectOffList: PublishAspectDiagnostic[];
  // US-1897: raw signals for the Listing Quality Score — NOT a score. They are
  // values this function already computes for blockers/warnings; surfacing them
  // structured keeps the scorer off string-matching the blocker array, which
  // would break silently the first time a message is reworded.
  qualitySignals: {
    titlePolicyViolations: string[];
    titleWarnings: string[];
    photoBlockers: string[];
    photoWarnings: string[];
    photoCount: number;
    categoryLeafStatus: "leaf" | "non_leaf" | "not_found" | "unverified";
    categoryWasSuggested: boolean;
    requiredMissing: string[];
  };
  sku: string;
  summary: {
    title: string;
    description: string;
    priceValue: string; // eBay wants string-typed money
    currency: string;
    condition: string;
    conditionDescription: string;
    categoryId: string;
    aspects: Record<string, string[]>;
    quantity: number;
    bestOfferEnabled: boolean;
    // US-562: best-offer auto-clear thresholds as eBay money strings, already
    // clamped to eBay's constraints (decline < accept < price). Null when no
    // valid threshold applies — Best Offer is still enabled, just unbounded.
    bestOfferAutoAccept: string | null;
    bestOfferAutoDecline: string | null;
    // US-561: effective Promoted Listings ad rate (%) to attach at publish, or
    // null when the listing shouldn't be promoted (00432: off by default unless
    // the per-listing override or the seller default opts in).
    promotedAdRate: number | null;
    // 00432: resolved Promoted Listings mode (listing choice → seller default →
    // cps). Only meaningful when promotedAdRate != null.
    promotedMode: "cps" | "cpc" | "smart";
    // US-568: listing format + auction terms (money as eBay strings) + the
    // variation matrix. format is "FIXED_PRICE" (default) or "AUCTION"; the
    // auction* values are only meaningful for AUCTION. variations is null for a
    // single-SKU listing.
    format: "FIXED_PRICE" | "AUCTION";
    auctionStartPrice: string | null;
    auctionReservePrice: string | null;
    auctionBuyItNowPrice: string | null;
    auctionDuration: string;
    variations: ListingVariations | null;
  };
}

// eBay getCategoryAspects raw aspect shape (subset we read).
export interface AspectSpecRaw {
  localizedAspectName?: string;
  aspectConstraint?: {
    aspectRequired?: boolean;
    aspectMode?: string;
    itemToAspectCardinality?: string; // "SINGLE" | "MULTI"
    // US-1895: "REQUIRED" | "RECOMMENDED" | "OPTIONAL".
    aspectUsage?: string;
    // "STRING" (default) | "NUMBER" | "DATE". NUMBER aspects are mode
    // FREE_TEXT but eBay still parses the value as a number — see
    // aspect-reconcile.ts coerceNumericAspectValue.
    aspectDataType?: string;
  };
  aspectValues?: Array<{ localizedValue?: string }>;
  // US-1895: eBay's real 30-day buyer-search-volume ranking for the aspect.
  relevanceIndicator?: { searchCount?: number };
}

// US-1503: name -> allowedValues[] map ([] = free-text) from the raw category
// spec, the shape resolveMeasurementAspects (measurements.ts) expects. Mirrors
// ai-listing.ts extractAllowedAspects, which isn't exported.
export function allowedAspectsFromSpec(
  aspectList: AspectSpecRaw[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const a of aspectList) {
    const name = (a.localizedAspectName ?? "").trim();
    if (!name) continue;
    out[name] = (a.aspectValues ?? [])
      .map((v) => v.localizedValue ?? "")
      .filter((v) => v.length > 0);
  }
  return out;
}

// Normalize eBay's raw aspect spec into the registry's RegistryAspect shape.
export function toRegistryAspects(aspectList: AspectSpecRaw[]): RegistryAspect[] {
  return aspectList.map((a) => ({
    name: a.localizedAspectName ?? "",
    mode: a.aspectConstraint?.aspectMode,
    multi: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
    allowedValues: (a.aspectValues ?? [])
      .map((v) => v.localizedValue ?? "")
      .filter((v) => v.length > 0),
  }));
}

// Map an item's canonical fields (legacy columns + US-821 attributes) onto a
// category's aspects so we can fill required specifics without an AI pass.
// US-822: this is now a thin adapter over the single-source ASPECT_REGISTRY —
// it normalizes eBay's raw aspect shape into the registry's RegistryAspect and
// delegates the field→aspect mapping + SELECTION_ONLY validation to
// resolveItemAspects. Returns only aspects NOT already in `existing`; user-set
// values are never overwritten.
export function deriveAspectsFromItem(
  item: PublishItem,
  aspectList: AspectSpecRaw[],
  existing: Record<string, string[]>,
): Record<string, string[]> {
  return resolveItemAspects(item, toRegistryAspects(aspectList), existing);
}

// US-1088+: the structured columns (brand/size/color/material/style) OWN their
// eBay aspects. Force the CURRENT column values onto the aspect map so a later
// edit on the main listing (e.g. changing Size) propagates to eBay instead of
// the stale value surviving (resolveItemAspects never overwrites). Column-backed
// aspects are overwritten or cleared; AI / manual / attribute aspects untouched.
// When the category's real aspect spec isn't available, falls back to the
// registry's default aspect names (FREE_TEXT) so the common fields still sync.
export function forceColumnAspects(
  item: RegistryItem,
  aspectList: AspectSpecRaw[] | null,
  existing: Record<string, string[]>,
): Record<string, string[]> {
  const aspects: RegistryAspect[] =
    aspectList && aspectList.length > 0
      ? toRegistryAspects(aspectList)
      : COLUMN_ASPECT_FALLBACK;
  return applyColumnAspects(existing, item, aspects);
}

// Default aspect names for the column-backed fields, used when no category spec
// is loaded (mirrors the registry's first candidate for each column entry). All
// treated as FREE_TEXT so the raw column value is sent verbatim.
const COLUMN_ASPECT_FALLBACK: RegistryAspect[] = [
  { name: "Brand", mode: "FREE_TEXT", multi: false },
  { name: "Size", mode: "FREE_TEXT", multi: false },
  { name: "Color", mode: "FREE_TEXT", multi: false },
  { name: "Material", mode: "FREE_TEXT", multi: false },
  { name: "Style", mode: "FREE_TEXT", multi: false },
];

// eBay-policy: the grade authority signal is TEXT ONLY and contains NO links.
// Two hard rules eBay enforces here:
//   • No badge/QR overlay on listing PHOTOS (third-party-grading marks risk
//     account suspension) — handled by NOT attaching any graded image.
//   • No off-eBay LINKS in the listing — eBay treats a certificate URL in the
//     description as "offering to buy/sell outside eBay" and HIDES the listing
//     (observed policy hit, ref 2-106523659851). So we never put the cert URL in
//     the description, and we strip any that an older saved description carries.
// The grade rides in a "Condition Grade" item specific + the grade text the
// client template already wrote (which references the cert by NUMBER, not URL).
// Applied to EVERY graded item. Mutates `aspects` in place; returns the
// link-stripped description.
//
// US-1284: the field name + item-specific key come from the shared GradeThread
// Standard (lib/gt-grade-standard.ts) so eBay embeds the grade the same canonical
// way every other adapter does. eBay is the one platform that must NOT carry the
// off-site machine-readable marker (it bans off-eBay links), so the grade rides
// the structured "Condition Grade" aspect + the cert NUMBER instead.
export async function applyGradeListingPromotion(
  // Narrow structural type — the publish path passes a full PublishItem, the
  // revise + grade-resync paths pass their own row; all this reads is the grade
  // + cert url.
  item: Pick<PublishItem, "grade_value" | "certificate_url">,
  aspects: Record<string, string[]>,
  description: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  let out = stripCertLinks(description);
  if (item.grade_value == null) return out;

  const grade = formatGtGrade(item.grade_value);

  // Item specific, e.g. "Condition Grade = GradeThread 9.5". Structured + shows
  // in the eBay spec table. On the publish path we never overwrite a value the
  // seller already set. US-1502: a grade RESYNC (opts.force) must overwrite it —
  // a grade earned after list-first, or a DOWNGRADED human re-review, has to
  // replace whatever (possibly overstated) value is live so we never leave an
  // inflated Condition Grade on eBay.
  const gradeSpecific = `${GT_GRADE_FIELD_NAME.replace(" Grade", "")} ${grade}`;
  if (opts.force || !aspects[GT_GRADE_ITEM_SPECIFIC]?.length) {
    aspects[GT_GRADE_ITEM_SPECIFIC] = [gradeSpecific];
  }

  // PSA-style certificate NUMBER as plain text — never a URL (eBay bans off-eBay
  // links). Buyers type it into /verify themselves. Ensure the report has a
  // number (lazy backfill), then make sure the description carries "Cert #...".
  const certId = certificateIdFromUrl(item.certificate_url);
  if (certId) {
    const number = await ensureCertificateNumber(certId);
    if (number && !out.includes(number)) out = appendCertNumber(out, grade, number);
  }
  return out;
}

// Extract the certificate_id (UUID) from a "<site>/cert/<id>" URL.
function certificateIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/cert\/([^/?#]+)/);
  return m?.[1] ?? null;
}

// Place "— Cert #GT-XXXXX" right after the "Condition Grade <n>" phrase the
// template wrote; if the description has no grade line, append a fresh one.
function appendCertNumber(
  description: string,
  grade: string,
  number: string,
): string {
  const re = new RegExp(`(Condition Grade\\s*${grade.replace(".", "\\.")})`);
  if (re.test(description)) return description.replace(re, `$1 — Cert #${number}`);
  const line = `Graded by GradeThread — Condition Grade ${grade} — Cert #${number}`;
  return description.trim() ? `${description.trim()}\n\n${line}` : line;
}

// Remove any off-eBay GradeThread link from a listing description so a
// published eBay listing never trips the off-eBay-links policy — covers the
// old template line ("View the full condition certificate: <url>"), any bare
// /cert/ URL, AND the US-1126 verified-seller credential block that older
// AutoLister generations embedded WITH an <a href> to /verified/<handle>
// (current generations are link-free, but stored drafts still carry it and
// eBay hides listings over it). Exported for tests.
export function stripCertLinks(description: string): string {
  return (
    description
      // Legacy linked credential block: drop the anchor entirely — "See every
      // verified grade ↗" is meaningless without its link. Non-greedy so only
      // the anchor goes, not the rest of the block (name + stats stay).
      .replace(
        /<a\b[^>]*href="[^"]*gradethread\.com\/verified\/[^"]*"[^>]*>.*?<\/a>/gis,
        "",
      )
      // Any other anchor pointing off-eBay at gradethread.com: unwrap to its
      // text so no URL survives in the markup.
      .replace(
        /<a\b[^>]*href="[^"]*gradethread\.com[^"]*"[^>]*>(.*?)<\/a>/gis,
        "$1",
      )
      .replace(/^.*View the full condition certificate:.*$/gim, "")
      .replace(/^.*https?:\/\/\S*\/cert\/\S*.*$/gim, "")
      // Bare /verified/ profile URLs in plain-text descriptions (the old
      // plain-variant "See every verified grade: <url>" line).
      .replace(/^.*See every verified grade:.*$/gim, "")
      .replace(/https?:\/\/\S*gradethread\.com\/verified\/\S*/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// Maps GradeThread's 1-10 grade to an eBay clothing condition string. Delegates
// to the shared, unit-tested base ladder in publish-preflight.ts (single-source
// with US-1894's apparel-band mapping). This produces the pre-remap DEFAULT; the
// publish/revise path resolves the final condition via resolveEbayCondition,
// which switches to eBay's 2025 pre-loved apparel bands on apparel leaves and
// then remaps against the category allow-list (never overstating quality).
export function mapEbayCondition(
  grade: number | null,
  label: string | null,
): string {
  return mapGradeToBaseCondition(grade, label);
}
