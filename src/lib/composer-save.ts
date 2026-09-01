// US-2248/US-2249: the composer's save payloads, as pure functions.
//
// Why this file exists: the composer had TWO hand-written save paths —
// saveDraft() and saveLiveListing() — and the live one had quietly fallen a
// dozen columns behind. A seller editing a listing that was live on eBay could
// change the promote rate, the Best Offer thresholds, the listing format or the
// primary photo, hit Save, get a success toast, and lose all of it: the live
// UPDATE simply didn't name those columns. The same drift hid the Storage & SKU
// card behind its own second Save button, so "Save draft" discarded a SKU edit.
//
// One builder per destination table, shared by every save path, means a new
// field is wired once and cannot be live-only or draft-only by accident. Pure
// in / pure out, so the payloads are asserted directly in tests instead of
// through a mounted 3000-line page.
import type {
  ListingInsert,
  ListingStatus,
  ItemCategory,
  ItemStatus,
  PriceSetBy,
} from "@/types/database";
import type { ListingFormatValue } from "@/components/flipdesk/listing-format-controls";

/** The composer's listing-side form state, already resolved to storable shapes. */
export type ComposerListingState = {
  title: string;
  description: string;
  ebayCondition: string;
  conditionDesc: string;
  /** Resolved by resolveListingFields() — first positive of form/target/list. */
  resolvedPrice: number;
  resolvedCategoryId: string | null;
  resolvedAspects: Record<string, string[]> | null;
  resolvedSources: Record<string, string | undefined>;
  /** ISO instant, or null for "publish when I say so". */
  scheduledPublishAt: string | null;
  primaryPhotoId: string | null;
  promoteEnabled: boolean;
  promoMode: "cps" | "cpc" | "smart";
  /** Raw input string; parsed here so a blank/garbage value stores NULL. */
  promoRate: string;
  listingFormat: ListingFormatValue;
  bestOfferEnabled: boolean;
  bestOfferAcceptCents: number | null;
  bestOfferDeclineCents: number | null;
  /** US-2250: multi-quantity listings. Raw input string. */
  quantity: string;
  /** US-2251: per-listing eBay business policies; null = account default. */
  shippingPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  /**
   * US-9205: who set the price and the graded price that was offered. Optional
   * so the older callers and tests that build this state by hand keep working;
   * a save without it leaves the three columns untouched.
   */
  priceProvenance?: {
    price_set_by: PriceSetBy | null;
    graded_price_cents: number | null;
    graded_price_why: string | null;
  };
};

/** eBay's hard cap on a listing title. Enforced on the input, not at save. */
export const TITLE_MAX = 80;
/** eBay's cap on the buyer-facing condition description (Sell Inventory API). */
export const CONDITION_DESC_MAX = 1000;

/**
 * US-2260: statuses a SALE owns. Reaching one of these means a sales row exists
 * (RecordSaleDialog / the eBay order sync writes it and advances the status), so
 * the composer's status dropdown must not offer them as words to pick — a bare
 * status write leaves Sold totals, P&L and reconciliation disagreeing with
 * inventory, with nothing to surface the gap.
 */
export const SALE_OWNED_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  "sold",
  "shipped",
  "completed",
  "returned",
]);

/**
 * US-568: turn the format editor state into the listings columns. Dollar strings
 * convert to integer cents; auction columns null out for fixed-price listings,
 * and variations null out for auctions / empty matrices.
 */
export function buildFormatPayload(
  v: ListingFormatValue,
): Partial<ListingInsert> {
  const dollarsToCents = (s: string): number | null => {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
  };
  const isAuction = v.format === "auction";
  return {
    listing_format: v.format,
    auction_start_price_cents: isAuction
      ? dollarsToCents(v.auctionStartPrice)
      : null,
    auction_reserve_price_cents: isAuction
      ? dollarsToCents(v.auctionReservePrice)
      : null,
    auction_buy_it_now_price_cents: isAuction
      ? dollarsToCents(v.auctionBuyItNowPrice)
      : null,
    auction_duration: isAuction ? v.auctionDuration : null,
    // Variations only apply to fixed-price listings; drop empty matrices.
    variations:
      !isAuction && v.variations && v.variations.variants.length > 0
        ? v.variations
        : null,
  };
}

/**
 * US-2250: the quantity that will publish. An auction is single-quantity by
 * definition, and a variation matrix owns the total (each variant carries its
 * own), so both override the input rather than trusting a stale box.
 */
export function resolveQuantity(state: {
  quantity: string;
  listingFormat: ListingFormatValue;
}): number {
  const { listingFormat: f } = state;
  if (f.format === "auction") return 1;
  const variants = f.variations?.variants ?? [];
  if (variants.length > 0) {
    const total = variants.reduce((sum, v) => sum + (v.quantity ?? 0), 0);
    return Math.max(1, total);
  }
  const n = Number.parseInt(state.quantity, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Every listings column the composer owns, at every status. Both save paths go
 * through here, so a column can never be wired into one and forgotten in the
 * other — the bug this module exists to make unrepresentable.
 *
 * Deliberately NOT here: inventory_item_id, platform, listing_status, is_active
 * and reviewed_at. Those describe the row's lifecycle rather than its content,
 * and a save on a live/sold row must not touch them.
 */
export function buildListingFields(
  state: ComposerListingState,
): Partial<ListingInsert> {
  const promoRate = (() => {
    if (!state.promoteEnabled || state.promoMode !== "cps") return null;
    const r = Number.parseFloat(state.promoRate);
    return Number.isFinite(r) && r > 0 ? r : null;
  })();
  return {
    listing_price: state.resolvedPrice,
    listing_title: state.title.trim(),
    listing_description: state.description.trim() || null,
    ebay_condition: state.ebayCondition || null,
    ebay_condition_description: state.conditionDesc.trim() || null,
    platform_category_id: state.resolvedCategoryId,
    item_specifics_override: state.resolvedAspects,
    item_specifics_sources: state.resolvedSources as Record<string, string>,
    primary_photo_id: state.primaryPhotoId,
    // Saving = a human reviewed the price, so it's no longer an unverified
    // AI estimate.
    price_is_estimated: false,
    // US-9205: graded / comp_median / seller, and the graded price kept beside
    // an override so the two can be compared with the sale price later.
    ...(state.priceProvenance ?? {}),
    // 00432: an explicit per-listing override — saving the composer is a
    // deliberate decision, so it no longer inherits the seller default.
    // promo_opt_out stays in sync for the legacy read sites (item page,
    // marketplaces, scheduled drops).
    promote_override: state.promoteEnabled,
    promo_opt_out: !state.promoteEnabled,
    // US-1447: CPC/Smart ignore the % (the bid is the ad-group max-CPC), so
    // only CPS stores a rate.
    promo_mode: state.promoMode,
    promo_rate_pct: promoRate,
    ...buildFormatPayload(state.listingFormat),
    // US-1898: publish already consumes these columns.
    best_offer_enabled: state.bestOfferEnabled,
    best_offer_auto_accept_cents: state.bestOfferEnabled
      ? state.bestOfferAcceptCents
      : null,
    best_offer_auto_decline_cents: state.bestOfferEnabled
      ? state.bestOfferDeclineCents
      : null,
    // US-2250: multi-quantity listings.
    quantity: resolveQuantity(state),
    // US-2382: badge_enabled and slab_image_mode are deliberately NOT written.
    // US-2247 wrote them believing publish read them; publish only SELECTs
    // them, and nothing branches on either. The columns stay on the table
    // (their migrations are immutable) but no surface may write one — see
    // no-dead-column-writes.test.ts, which fails if this comes back.
    // US-2251: per-listing business policies. NULL = fall back to the account
    // default, which is what publish does.
    shipping_policy_id: state.shippingPolicyId,
    payment_policy_id: state.paymentPolicyId,
    return_policy_id: state.returnPolicyId,
  };
}

/**
 * The full insert/update payload for a listing that has NOT gone live: adds the
 * lifecycle columns and the publish schedule.
 *
 * `existingStatus` is the status already on the row (undefined when inserting).
 * Hard-coding "draft" here would demote an ended/sold listing on an ordinary
 * save, now that this editor opens at every status.
 */
export function buildDraftListingPayload(
  state: ComposerListingState,
  ctx: {
    inventoryItemId: string;
    existingStatus?: ListingStatus | null;
    /** Injected so the payload stays pure and assertable. */
    reviewedAt: string;
  },
): ListingInsert {
  return {
    inventory_item_id: ctx.inventoryItemId,
    platform: "ebay",
    listing_status: ctx.existingStatus ?? "draft",
    ...buildListingFields(state),
    scheduled_publish_at: state.scheduledPublishAt,
    // US-1568: a composer Save IS the human review — the draft leaves the
    // AutoLister 'needs review' queue and lives on in Inventory → Drafts.
    reviewed_at: ctx.reviewedAt,
    // Draft-only. A live row's is_active is owned by the publish/end flow.
    ...(ctx.existingStatus && ctx.existingStatus !== "draft"
      ? {}
      : { is_active: false }),
  } as ListingInsert;
}

/**
 * US-1490/US-2248: the in-place patch for a listing that is LIVE on eBay. Same
 * content columns as a draft save — the whole point — minus the lifecycle
 * columns and minus scheduled_publish_at (a live listing has already published;
 * writing a future drop time would misrepresent it, so the composer hides the
 * schedule control in live mode rather than storing a value it won't honour).
 */
export function buildLiveListingPatch(
  state: ComposerListingState,
): Partial<ListingInsert> {
  return buildListingFields(state);
}

/** The composer's inventory_items-side form state. */
export type ComposerItemState = {
  resolvedCategoryId: string | null;
  resolvedAspects: Record<string, string[]> | null;
  resolvedSources: Record<string, string | undefined>;
  measurements: Record<string, number | string>;
  /** Parsed cost basis; null clears it. */
  effectiveCost: number | null;
  sourcedBy: string;
  acquiredDate: string;
  /** Only written when the seller picked the coarse category by hand. */
  categoryTouched: boolean;
  itemCategory: ItemCategory | "";
  /** US-2249: the Storage & SKU card now rides the main save. */
  storageSku: string;
  storageLocation: string;
  storageContainer: string;
  /** Already run through resolveStatus() by the caller. */
  resolvedStatus: ItemStatus;
};

/**
 * US-2249: every inventory_items column the composer owns, in ONE patch. The
 * Storage & SKU fields used to need their own Save button, so "Save draft"
 * silently discarded a SKU edit made moments earlier in the same form.
 *
 * `extra` folds in the caller's derived patches (aspect write-back, category
 * cascade) which need hooks/registries this pure module shouldn't reach for.
 */
export function buildItemPatch(
  state: ComposerItemState,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const trimOrNull = (s: string) => (s.trim() === "" ? null : s.trim());
  return {
    status: state.resolvedStatus,
    ebay_category_id: state.resolvedCategoryId,
    ebay_aspects: state.resolvedAspects,
    ebay_aspect_sources: state.resolvedSources,
    // US-1567: measurements edited in the composer save with the listing.
    measurements:
      Object.keys(state.measurements).length > 0 ? state.measurements : null,
    // Written unconditionally (including back to null when cleared) so cost
    // behaves like every other field here rather than being write-once.
    acquired_price: state.effectiveCost,
    sourced_by: trimOrNull(state.sourcedBy),
    acquired_date: state.acquiredDate || null,
    ...(state.categoryTouched
      ? { item_category: state.itemCategory === "" ? null : state.itemCategory }
      : {}),
    // US-2249: storage/logistics, formerly behind their own Save.
    sku: trimOrNull(state.storageSku),
    location_bin: trimOrNull(state.storageLocation),
    container: trimOrNull(state.storageContainer),
    ...extra,
  };
}
