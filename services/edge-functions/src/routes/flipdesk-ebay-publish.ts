// eBay routes: publishing a draft (push), relisting, and the publish port registration.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { recordPublication } from "../lib/listing-publications.ts";
import { loadActiveOfferRule } from "../lib/offer-rule-lookup.ts";
import { trimTitleWithReport } from "../lib/title-trim.ts";
import { lintTitle } from "../lib/title-lint.ts";
// US-2677: near-duplicate titles across the seller's own live listings. A
// WARNING and never a blocker -- two genuinely different garments can carry
// similar titles, and only the seller can tell.
import { duplicateTitleWarningsFor } from "../lib/title-similarity.ts";
import { filterEbayPhotos } from "../lib/item-photo-storage.ts";
import { reverseColumnAspects } from "../lib/aspect-registry.ts";
import type { RegistryItem } from "../lib/aspect-registry.ts";
import { estimateParcel } from "../lib/parcel-estimate.ts";
import {
  type AspectCoverage,
  mergeSources,
  recommendedAspectCoverage,
  requiredMissingAspects,
  sourcesFor,
} from "../lib/aspect-provenance.ts";
import {
  normalizeAspectMap,
  type PublishAspectDiagnostic,
  reconcilePublishAspects,
  type ReconcileSpec,
} from "../lib/aspect-reconcile.ts";
import { healCustomValueRejection } from "../lib/ebay-size-enforcement.ts";
import {
  createOffer,
  createOrReplaceInventoryItem,
  ebayListingUrl,
  categoryHasCachedLeafAspects,
  fetchCategoryLeafStatus,
  getCategoryAspects,
  getItemConditionPolicies,
  getMarketplaceId,
  isEbayConfigured,
  isOfferAlreadyExistsError,
  isOfferBoundToDeadListing,
  listOffersForSku,
  packageWeightAndSizeForPublish,
  type EbayPackageWeightAndSize,
  publishOrAdoptOffer,
  createOrReplaceInventoryItemGroup,
  publishItemGroupOrAdopt,
  resolveCachedDefaults,
  suggestCategories,
  syncExistingOffer,
  withdrawOffer,
  deleteOffer,
  isAlreadyDeletedError,
  isOfferAlreadyEndedError,
  type BestOfferTerms,
  type PricingSummary,
  type PolicySet,
} from "../lib/ebay-client.ts";
import {
  centsToMoneyString,
  reconcileAutoAcceptWithRule,
  resolveBestOfferThresholds,
} from "../lib/best-offer.ts";
import { finalizePublishedListing } from "../lib/ebay-publish-finalize.ts";
import { emitEvent, firstOccurrenceKey } from "../lib/user-events.ts";
import { fetchWithTimeout } from "../lib/circuit-breaker.ts";
import { captureListingAcceptance } from "../lib/listing-acceptance.ts";
import {
  checkImageReachability,
  dedupeAndCapImages,
  EBAY_MAX_IMAGES as PREFLIGHT_MAX_IMAGES,
  imageCapBlocker,
  reachabilityBlocker,
  validateConditionForCategory,
  resolveEbayCondition,
  resolveCategoryLeafStatus,
  leafCategoryBlocker,
  photoStandardsPreflight,
  type LeafCategorySuggestion,
} from "../lib/publish-preflight.ts";
import { EBAY_PUBLISH_GENERIC_FIX, resolveEbayFix } from "../lib/ebay-error-map.ts";
import { deriveListingOrigin } from "../lib/sync-precedence.ts";
// US-1999: one derivation rule, and the published SKU wins over item.sku.
import { resolveInventorySku } from "../lib/ebay-sku.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { registerEbayPublisher } from "../lib/ebay-publish-port.ts";
import { capacityAllowedForUser } from "../lib/plan-gate.ts";
import { attachPromotionAtPublish, resolvePublishAdRate } from "../lib/ebay-marketing.ts";
import {
  applyGradeListingPromotion,
  type AspectSpecRaw,
  deriveAspectsFromItem,
  type EbayEnv,
  ebayPublicPhotoUrl,
  forceColumnAspects,
  type ListingVariations,
  loadListingOwned,
  mapEbayCondition,
  normalizeVariations,
  type PublishContextOk,
  type PublishItem,
  type PublishListing,
  type PublishPhoto,
  shoeScaleOf,
  toEbayImageUrls,
  variantSku,
} from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// US-1447: listings.promo_mode ('cps' default | 'cpc' | 'smart') → the
// attachPromotionAtPublish mode. Unknown/legacy values fall back to CPS.
function promoModeFor(raw: string | null | undefined): "cps" | "cpc" | "smart" {
  return raw === "cpc" || raw === "smart" ? raw : "cps";
}

// US-473: HEAD-probe an image URL for the pre-publish reachability check. Short
// deadline; a thrown error (network/timeout) propagates so checkImageReachability
// can treat it as "reachable" (best-effort). Some CDNs reject HEAD with 405 —
// that's not a 404/410/403, so it's correctly treated as reachable.
async function headProbe(url: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetchWithTimeout(url, { method: "HEAD" }, 5_000);
  return { ok: res.ok, status: res.status };
}

/**
 * US-2790 consumer 3: the predicted parcel, for the inventory_item PUT.
 *
 * OFF BY DEFAULT. packageWeightAndSizeForPublish returns undefined unless an
 * operator has set EBAY_PACKAGE_WEIGHT_AND_SIZE=true, and an undefined optional
 * property is dropped by JSON.stringify - so with the flag off the body eBay
 * receives is byte-for-byte the one it received before this existed. That is
 * asserted by a test, not assumed.
 *
 * SINGLE-SKU PUBLISH ONLY, deliberately. A variation group is several parcels
 * behind one listing and the per-variant weights differ; guessing one for the
 * whole group would be worse than sending none. Revise is left alone for the
 * same reason it always is - it re-PUTs a listing that is already live.
 *
 * Never throws. A prediction is an improvement to a publish, not a condition
 * of one, so anything unexpected here leaves the payload exactly as it was.
 */
function predictedPackageForPublish(
  item: PublishItem,
): EbayPackageWeightAndSize | undefined {
  try {
    const parcel = estimateParcel({
      garmentCategory: item.garment_category,
      material: item.material,
      measurements: item.measurements,
      size: item.size,
      sizeScale: shoeScaleOf(item),
    });
    return packageWeightAndSizeForPublish(parcel);
  } catch (err) {
    console.warn(
      "[flipdesk-ebay] parcel prediction failed (publishing without it):",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

export type PublishItemResult =
  | {
    ok: true;
    listing_id: string;
    listing_url: string;
    offer_id: string;
    sku: string;
    // US-783: the listing is live on eBay but the local DB sync didn't land;
    // a reconcile marker was recorded for the pull-sync. The caller reports
    // success, not a publish failure.
    sync_pending?: boolean;
  }
  | { ok: false; status: 400 | 404 | 422 | 500 | 502 | 503; body: Record<string, unknown> };

// Publish one owned item to eBay (inventory PUT → offer POST → publish POST).
// Parameterized by ownerId so both the authed /listings/push handler and the
// scheduled publish-due worker (US-322) reuse the identical flow. Returns a
// result union instead of an HTTP response so non-HTTP callers can use it.
export async function publishItemForOwner(
  ownerId: string,
  itemId: string,
  opts: { relist?: boolean } = {},
): Promise<PublishItemResult> {
  const ctx = await assemblePublishContext(ownerId, itemId);
  if (!ctx.ok) return { ok: false, status: ctx.status, body: ctx.error };
  if (ctx.blockers.length > 0 || !ctx.policies) {
    return {
      ok: false,
      status: 422,
      body: {
        ok: false,
        blockers: ctx.blockers.length > 0
          ? ctx.blockers
          : ["eBay business policies are not configured."],
      },
    };
  }

  const { item, listing, photos, policies, sku } = ctx;

  // Grade authority signal — TEXT ONLY (eBay-policy pivot). We never overlay a
  // badge or attach the QR "slab" onto listing PHOTOS — third-party-grading
  // marks / QR codes burned into images risk eBay account suspension. Instead
  // the grade rides in a "Condition Grade" item specific + a cert link in the
  // description, and buyers verify on the standalone /cert/:id lookup page.
  // Runs ONLY on the real publish path (not the per-load /listings/validate).
  // Mutates ctx.summary.aspects in place + returns the updated description, so
  // it reaches both the single-SKU and variation publish paths below.
  ctx.summary.description = await applyGradeListingPromotion(
    item,
    ctx.summary.aspects,
    ctx.summary.description,
  );

  // US-473: pre-publish image reachability. eBay fetches imageUrls server-side
  // at publish; an unreachable URL fails the whole publish with an opaque error
  // (and our proxy can surface a 502). HEAD-probe the URLs first and turn a
  // definitive 404/410/403 into a fixable blocker. Best-effort — transient
  // errors/timeouts are treated as reachable so a flaky CDN moment never blocks
  // a legitimate publish. Kept out of assemblePublishContext (called on every
  // composer load) so it only costs the actual publish path.
  const reach = await checkImageReachability(
    photos.map((p) => p.public_url),
    headProbe,
  );
  const reachBlocker = reachabilityBlocker(reach);
  if (reachBlocker) {
    return { ok: false, status: 422, body: { ok: false, blockers: [reachBlocker] } };
  }

  // Relist (end-old-then-relist): when the caller asks to relist, withdraw any
  // existing offer first so the publish below mints a brand-new listing id
  // instead of publishOrAdoptOffer (US-464) adopting a stale/removed one. eBay
  // only allows one live offer per SKU, so we end the old listing rather than
  // create a duplicate. We attempt the withdraw whenever an offer id exists —
  // NOT only when our local row still reads "active" — because a listing eBay
  // removed for a policy issue (or one the seller ended on eBay) can still read
  // active locally yet must be withdrawn before a fresh publish; conversely a
  // stale offer the row already thinks ended must still be cleared. An
  // already-not-live offer throws here, which is expected (isOfferAlreadyEnded);
  // only an unexpected/transient failure is worth logging loudly.
  if (opts.relist) {
    const { data: liveRow } = await supabaseAdmin
      .from("listings")
      .select("platform_offer_id, is_active, listing_status, marketplace_connection_id")
      .eq("inventory_item_id", itemId)
      .eq("platform", "ebay")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const live = liveRow as
      | {
        platform_offer_id: string | null;
        is_active: boolean | null;
        listing_status: string | null;
        marketplace_connection_id: string | null;
      }
      | null;
    if (live?.platform_offer_id) {
      try {
        // US-1507: withdraw via the OLD listing's own connection (null → primary).
        await withdrawOffer(
          ownerId,
          live.platform_offer_id,
          live.marketplace_connection_id ?? undefined,
        );
      } catch (err) {
        if (!isOfferAlreadyEndedError(err)) {
          // Unexpected failure — proceed anyway; publish will adopt rather than
          // mint a fresh listing, which the caller can re-run.
          console.warn(
            "[flipdesk-ebay] relist: withdrawOffer before re-publish failed (continuing):",
            err instanceof Error ? err.message : String(err),
          );
        }
        // Already-not-live offer → nothing to withdraw; continue to re-publish.
      }
    }
  }

  // 1. Ensure the SKU is persisted on the item so reconciliation works
  //    (eBay's "Custom label" maps back to this).
  if (sku !== item.sku) {
    await supabaseAdmin
      .from("inventory_items")
      .update({ sku })
      .eq("id", itemId);
  }

  try {
    // US-568: multi-variant listings take a separate publish path — each variant
    // is its own inventory_item (SKU) grouped into an inventory_item_group, then
    // published as ONE multi-variation listing. Returns early; the single-SKU
    // flow below never runs for variation listings.
    if (ctx.summary.variations) {
      return await publishVariationListing({
        ownerId,
        itemId,
        baseSku: sku,
        ctx,
        item,
        listing,
        photos,
        policies,
        variations: ctx.summary.variations,
      });
    }

    // 2. Push inventory_item (idempotent PUT). Quantity, aspects, and
    //    condition all come from the publish context, which already resolved
    //    listing-row edits ahead of inventory defaults (US-319/320/321).
    await createOrReplaceInventoryItem(ownerId, sku, {
      product: {
        title: ctx.summary.title,
        description: ctx.summary.description,
        aspects: ctx.summary.aspects,
        imageUrls: toEbayImageUrls(photos.map((p) => p.public_url)),
        // eBay requires a Brand+MPN product identifier (error 25002
        // <BrandMPN>). Default Brand to "Unbranded" and MPN to "Does Not
        // Apply" — the standard values for used items without a manufacturer
        // part number — so the offer publishes instead of being rejected.
        brand:
          typeof item.brand === "string" && item.brand.trim()
            ? item.brand.trim()
            : "Unbranded",
        mpn: "Does Not Apply",
        // US-1475: adopt the eBay Catalog product if one was matched (optional;
        // eBay ignores an absent epid, so this is safe when unset).
        epid:
          typeof (item as { ebay_epid?: string | null }).ebay_epid === "string"
            ? ((item as { ebay_epid?: string | null }).ebay_epid as string)
            : undefined,
      },
      condition: ctx.summary.condition,
      conditionDescription:
        ctx.summary.conditionDescription || undefined,
      availability: {
        shipToLocationAvailability: { quantity: ctx.summary.quantity },
      },
      // US-2790: the predicted parcel. undefined (and therefore absent from the
      // JSON) unless EBAY_PACKAGE_WEIGHT_AND_SIZE=true.
      packageWeightAndSize: predictedPackageForPublish(item),
    });

    // US-562: build the shared bestOfferTerms once so the create and re-sync
    // paths send identical auto-accept/decline thresholds. Omitted entirely
    // when Best Offer is off. US-568: eBay does not allow Best Offer on auction
    // offers, so it's suppressed unless the format is FIXED_PRICE.
    const bestOfferTerms: BestOfferTerms | undefined = ctx.summary
      .bestOfferEnabled && ctx.summary.format === "FIXED_PRICE"
      ? {
          bestOfferEnabled: true,
          ...(ctx.summary.bestOfferAutoAccept
            ? {
                autoAcceptPrice: {
                  value: ctx.summary.bestOfferAutoAccept,
                  currency: ctx.summary.currency,
                },
              }
            : {}),
          ...(ctx.summary.bestOfferAutoDecline
            ? {
                autoDeclinePrice: {
                  value: ctx.summary.bestOfferAutoDecline,
                  currency: ctx.summary.currency,
                },
              }
            : {}),
        }
      : undefined;

    // US-568: build the pricingSummary for the resolved format. FIXED_PRICE
    // sends `price`; AUCTION sends `auctionStartPrice` (+ optional reserve and a
    // Buy It Now `price`). listingDuration is GTC for fixed-price, DAYS_n for
    // auctions (resolved in assemblePublishContext).
    const pricingSummary: PricingSummary =
      ctx.summary.format === "AUCTION"
        ? {
            auctionStartPrice: {
              value: ctx.summary.auctionStartPrice ?? ctx.summary.priceValue,
              currency: ctx.summary.currency,
            },
            ...(ctx.summary.auctionReservePrice
              ? {
                  auctionReservePrice: {
                    value: ctx.summary.auctionReservePrice,
                    currency: ctx.summary.currency,
                  },
                }
              : {}),
            ...(ctx.summary.auctionBuyItNowPrice
              ? {
                  price: {
                    value: ctx.summary.auctionBuyItNowPrice,
                    currency: ctx.summary.currency,
                  },
                }
              : {}),
          }
        : {
            price: {
              value: ctx.summary.priceValue,
              currency: ctx.summary.currency,
            },
          };
    const listingDuration = ctx.summary.auctionDuration;

    // 3. Create or reuse an offer for this SKU.
    const offerPolicies = {
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId: policies.paymentPolicyId,
      returnPolicyId: policies.returnPolicyId,
      ...(bestOfferTerms ? { bestOfferTerms } : {}),
    };
    const mintOffer = () =>
      createOffer(ownerId, {
        sku,
        marketplaceId: getMarketplaceId(),
        format: ctx.summary.format,
        availableQuantity: ctx.summary.quantity,
        categoryId: ctx.summary.categoryId,
        listingDescription: ctx.summary.description,
        listingDuration,
        listingPolicies: offerPolicies,
        pricingSummary,
        merchantLocationKey: policies.merchantLocationKey,
      });

    let offerId: string;
    try {
      const created = await mintOffer();
      offerId = created.offerId;
    } catch (err) {
      if (!isOfferAlreadyExistsError(err)) throw err;
      const existing = await listOffersForSku(ownerId, sku);
      const found = existing.find((o) => !!o.offerId);
      if (!found) throw err;
      offerId = found.offerId;

      // US-2641: an offer eBay has bound to a DEAD listing cannot be published
      // again. When a seller ends the listing on eBay's own site, the offer
      // survives still pointing at the ended listing, and every re-publish of it
      // answers 25001 "A system error has occurred. Internal Server Error" —
      // which is what a seller who ended a listing on eBay and then relisted from
      // FlipDesk actually got, four times in a row, with nothing that could ever
      // clear it. eBay's recovery is to destroy the offer and create a new one.
      //
      // listOffersForSku already returns the offer's status and its listing's, so
      // the check costs no extra call. It is narrow by construction: an offer that
      // simply failed to publish (a missing item specific) carries no listingId
      // and is left alone, so an ordinary rejection never churns the offer id.
      if (
        isOfferBoundToDeadListing({
          status: found.status,
          listing: {
            listingId: found.listingId ?? undefined,
            listingStatus: found.listingStatus ?? undefined,
          },
        })
      ) {
        console.warn(
          `[flipdesk-ebay] offer ${offerId} is bound to dead listing ` +
            `${found.listingId} (offer status ${found.status ?? "?"}, listing ` +
            `status ${found.listingStatus ?? "?"}) — recreating it before publish`,
        );
        // deleteOffer is destructive and would end a LIVE listing as a side
        // effect; isOfferBoundToDeadListing has just established this one is not
        // live, which is the guard its contract asks the caller to supply.
        try {
          await deleteOffer(ownerId, offerId, ctx.connectionId ?? undefined);
        } catch (delErr) {
          if (!isAlreadyDeletedError(delErr)) throw delErr;
        }
        const remade = await mintOffer();
        offerId = remade.offerId;
      } else {
        // The existing offer was created on an earlier attempt and may carry a
        // stale shipping policy / price / category (eBay 25007 keeps firing on
        // publish until the offer itself is corrected). Push the current draft +
        // selected policies onto it before publishing.
        await syncExistingOffer(ownerId, offerId, {
          availableQuantity: ctx.summary.quantity,
          categoryId: ctx.summary.categoryId,
          listingDescription: ctx.summary.description,
          listingDuration,
          listingPolicies: offerPolicies,
          pricingSummary,
          merchantLocationKey: policies.merchantLocationKey,
        });
      }
    }

    // 4. Publish — or ADOPT an already-published listing (US-464). If a prior
    //    attempt published this offer remotely but crashed before persisting
    //    the local listings row (step 5), publishOrAdoptOffer returns that live
    //    listingId instead of re-publishing, so a retry can't create a duplicate
    //    live listing.
    const published = await publishOrAdoptOffer(ownerId, offerId);
    const listingId = published.listingId;
    const url = ebayListingUrl(listingId);

    // 5. Persist the live state. Upsert the listings row so a re-publish
    //    of the same item points at the new eBay listingId. synced_to_ebay_at
    //    marks the draft as live (clears any prior publish failure).
    const listingPayload = {
      inventory_item_id: itemId,
      platform: "ebay" as const,
      // US-1077: published from FlipDesk → GradeThread-originated.
      listing_origin: "gradethread" as const,
      // US-1507: stamp the connection that published this so a later revise/end/
      // price acts via the SAME account even after the primary is switched.
      marketplace_connection_id: ctx.connectionId,
      platform_listing_id: listingId,
      platform_offer_id: offerId,
      // US-1999: PIN the SKU this went live under. Every later Inventory call
      // reads this instead of re-deriving from the seller-editable
      // inventory_items.sku, so renaming the item's SKU can no longer orphan
      // the live listing.
      inventory_sku: sku,
      platform_category_id: ctx.summary.categoryId,
      listing_url: url,
      listing_price: Number(ctx.summary.priceValue),
      listing_title: ctx.summary.title,
      listing_description: ctx.summary.description,
      listing_status: "active" as const,
      is_active: true,
      listed_at: new Date().toISOString(),
      synced_to_ebay_at: new Date().toISOString(),
      publish_error: null,
      publish_failed_at: null,
    };

    // US-2704: record the FIRST publish, here rather than at the wire.
    //
    // The wire-level funnel resolves a listing by inventory_sku or
    // platform_offer_id, and neither is on the listings row until the persist
    // below runs — createOrReplaceInventoryItem is step 2 and this is step 5.
    // So the snapshot inside that call correctly skips, and the ORIGINAL
    // description, which is the single most useful row this table will ever
    // hold, would never be recorded at all. Deferred until after persist for
    // the same reason: the row it attaches to has to exist first.
    const recordFirstPublish = () =>
      recordPublication(supabaseAdmin, {
        ownerUserId: ownerId,
        sku,
        offerId,
        description: ctx.summary.description,
        aspects: ctx.summary.aspects,
        price: Number(ctx.summary.priceValue),
      });

    // US-783: the listing is LIVE on eBay now. A failure on the local writes
    // below is NOT a publish failure — retry, then fall back to a reconcile
    // marker (the pull-sync adopts the orphan by SKU) and return success with
    // sync_pending. NEVER surface a publish error for an eBay-side success.
    const { syncPending } = await finalizePublishedListing({
      persist: async () => {
        if (listing?.id) {
          const { error } = await supabaseAdmin
            .from("listings")
            .update(listingPayload)
            .eq("id", listing.id);
          if (error) throw new Error(`listings update: ${error.message}`);
        } else {
          const { error } = await supabaseAdmin.from("listings").insert(listingPayload);
          if (error) throw new Error(`listings insert: ${error.message}`);
        }
        const { error: itemErr } = await supabaseAdmin
          .from("inventory_items")
          .update({ status: "listed" })
          .eq("id", itemId);
        if (itemErr) throw new Error(`inventory_items update: ${itemErr.message}`);
      },
      recordReconcile: async () => {
        // Snapshot the orphaned-but-live listing into the same table the pull-
        // sync + Reconciliation page use, so it's adopted on the next sync.
        await supabaseAdmin
          .from("flipdesk_ebay_listings")
          .upsert(
            {
              user_id: ownerId,
              ebay_item_id: listingId,
              custom_label: sku,
              title: ctx.summary.title,
              current_price: Number(ctx.summary.priceValue),
              listing_url: url,
              raw: { offerId, source: "publish_orphan", inventory_item_id: itemId },
              match_status: "unmatched",
              imported_at: new Date().toISOString(),
            },
            { onConflict: "user_id,ebay_item_id" },
          );
        console.error(
          `[flipdesk-ebay] publish ${listingId} is LIVE but local write failed — ` +
            `recorded reconcile marker; pull-sync will adopt it`,
        );
      },
    });

    // US-2704: now the listings row exists, so the snapshot has something to
    // attach to. Awaited rather than fire-and-forget: this is the row a dispute
    // pack is built from, and a publish is rare enough to pay one write for it.
    // recordPublication swallows its own failures by contract, so this cannot
    // turn a live listing into a failed publish.
    await recordFirstPublish();

    // US-932: the listing is live → record it to the internal event stream (the
    // drip trigger substrate), alongside existing analytics. Fire-and-forget;
    // first_listing is once-per-user (idempotent via dedupe_key).
    void emitEvent(ownerId, "listing_published", {
      properties: { listing_id: listingId, sku },
    });
    void emitEvent(ownerId, "first_listing", {
      dedupeKey: firstOccurrenceKey("first_listing", ownerId),
    });

    // US-561: attach an eBay Promoted Listings ad at the resolved rate (the
    // seller's accepted/adjusted rate, or the category suggestion) unless they
    // opted out. BEST-EFFORT — the listing is already live, so a Marketing API
    // failure records promo_status='failed' on the row but never fails publish.
    if (ctx.summary.promotedAdRate != null && ctx.summary.promotedAdRate > 0) {
      await attachPromotionAtPublish({
        userId: ownerId,
        listingRowId: listing?.id ?? null,
        ebayListingId: listingId,
        ratePct: ctx.summary.promotedAdRate,
        // US-1447: honour the listing's chosen promotion mode (CPS / CPC / Smart).
        mode: ctx.summary.promotedMode,
      });
    }

    // US-547: capture the seller-acceptance signal — diff the AI's generated
    // snapshot against the now-published (post-edit) values, attributed to the
    // listing_gen prompt version. Non-fatal; no-op for non-AI drafts.
    if (listing?.id) {
      await captureListingAcceptance(listing.id);
    }

    return {
      ok: true,
      listing_id: listingId,
      listing_url: url,
      offer_id: offerId,
      sku,
      sync_pending: syncPending,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // US-567: keep the raw eBay detail SERVER-SIDE (logs only) and surface a
    // short, actionable message mapped from eBay's structured error IDs.
    console.error("[flipdesk-ebay] publish failed:", msg);
    const ebayErrorIds = (err as { ebayErrorIds?: number[] }).ebayErrorIds;
    // Surface eBay's REAL reason (25002 is overloaded — "Inseam is missing" et al.)
    const fix = resolveEbayFix(err, EBAY_PUBLISH_GENERIC_FIX);
    // eBay standardized sizes (2026-09): a custom-value rejection means our
    // cached spec is stale. Refetch it, repair the stored specifics against
    // the fresh list, and tell the seller what changed or what to pick.
    const healed = await healCustomValueRejection({
      err,
      categoryId: ctx.summary.categoryId,
      itemId,
      listingId: listing?.id ?? null,
    });
    const userMessage = healed?.message ?? fix.message;
    if (healed && !fix.field) fix.field = "specifics";
    // US-321: persist the failure on the draft listing so the queue/UI can
    // surface "last failed: X" on reload, and US-325 retry can target it. Store
    // the user-facing message (not the raw eBay blob).
    if (listing?.id) {
      try {
        await supabaseAdmin
          .from("listings")
          .update({
            publish_error: userMessage.slice(0, 1000),
            publish_failed_at: new Date().toISOString(),
          })
          .eq("id", listing.id);
      } catch (logErr) {
        console.error("[flipdesk-ebay] could not persist publish_error:", logErr);
      }
    }
    return {
      // 422, NOT 5xx: a publish rejection (eBay 400, policy gap, etc.) is a
      // business failure, not a gateway error. Traefik/Coolify intercepts
      // gateway-class 5xx (502/503/504) with its own error page that strips
      // CORS headers, so the browser shows an opaque CORS error instead of the
      // real eBay message. 422 stays inside the app's CORS-handled path so the
      // dialog can surface `detail` to the seller.
      ok: false,
      status: 422,
      body: {
        ok: false,
        error: "Publish failed",
        // US-567: actionable mapped message (raw eBay detail stays in logs).
        detail: userMessage,
        ...(fix?.field ? { fix_field: fix.field } : {}),
        ...(ebayErrorIds && ebayErrorIds.length > 0
          ? { ebay_error_ids: ebayErrorIds }
          : {}),
      },
    };
  }
}

// US-568: publish a multi-variant (size/color) listing. Each variant becomes
// its own inventory_item (SKU) carrying the variation aspects; they're tied
// together by an inventory_item_group and published as ONE listing via
// publish_by_inventory_item_group. Mirrors publishItemForOwner's persistence so
// the local listings/inventory rows end up identical to a single-SKU publish.
async function publishVariationListing(args: {
  ownerId: string;
  itemId: string;
  baseSku: string;
  ctx: PublishContextOk;
  item: PublishItem;
  listing: PublishListing | null;
  photos: PublishPhoto[];
  policies: PolicySet;
  variations: ListingVariations;
}): Promise<PublishItemResult> {
  const { ownerId, itemId, baseSku, ctx, item, listing, photos, policies, variations } =
    args;
  const imageUrls = toEbayImageUrls(photos.map((p) => p.public_url));
  const brand =
    typeof item.brand === "string" && item.brand.trim()
      ? item.brand.trim()
      : "Unbranded";

  // Build the varies-by specification → value-set map from the variant matrix.
  const specValues = new Map<string, Set<string>>();
  for (const spec of variations.specifications) specValues.set(spec, new Set());
  for (const v of variations.variants) {
    for (const spec of variations.specifications) {
      const val = v.aspects[spec];
      if (val) specValues.get(spec)!.add(val);
    }
  }

  // 1. Create each variant inventory item. Its aspects = the shared aspects plus
  //    this variant's variation values (eBay needs the varies-by aspect present
  //    on every member item). availability = the per-variant quantity.
  const variantSkus: string[] = [];
  for (const variant of variations.variants) {
    const vSku = variantSku(baseSku, variant);
    variantSkus.push(vSku);
    const aspects: Record<string, string[]> = { ...ctx.summary.aspects };
    for (const [name, value] of Object.entries(variant.aspects)) {
      aspects[name] = [value];
    }
    await createOrReplaceInventoryItem(ownerId, vSku, {
      product: {
        title: ctx.summary.title,
        description: ctx.summary.description,
        aspects,
        imageUrls,
        brand,
        mpn: "Does Not Apply",
      },
      condition: ctx.summary.condition,
      conditionDescription: ctx.summary.conditionDescription || undefined,
      availability: {
        shipToLocationAvailability: { quantity: variant.quantity },
      },
    });
  }

  // 2. Group the variants. variesBy declares the buyer-selectable specs; we let
  //    the photo vary by "Color" when it's one of the specs.
  const specifications = variations.specifications.map((name) => ({
    name,
    values: [...(specValues.get(name) ?? [])],
  }));
  const colorSpec = variations.specifications.find((s) => /colou?r/i.test(s));
  await createOrReplaceInventoryItemGroup(ownerId, baseSku, {
    title: ctx.summary.title,
    description: ctx.summary.description,
    imageUrls,
    aspects: ctx.summary.aspects,
    variantSKUs: variantSkus,
    variesBy: {
      specifications,
      ...(colorSpec ? { aspectsImageVariesBy: [colorSpec] } : {}),
    },
  });

  // US-568: Best Offer terms are valid for variation (fixed-price) listings.
  const bestOfferTerms: BestOfferTerms | undefined = ctx.summary.bestOfferEnabled
    ? {
        bestOfferEnabled: true,
        ...(ctx.summary.bestOfferAutoAccept
          ? {
              autoAcceptPrice: {
                value: ctx.summary.bestOfferAutoAccept,
                currency: ctx.summary.currency,
              },
            }
          : {}),
        ...(ctx.summary.bestOfferAutoDecline
          ? {
              autoDeclinePrice: {
                value: ctx.summary.bestOfferAutoDecline,
                currency: ctx.summary.currency,
              },
            }
          : {}),
      }
    : undefined;

  // 3. One offer per variant SKU (price = per-variant override, else the base
  //    price). Reuse an existing offer on retry (offer-already-exists → sync).
  for (const variant of variations.variants) {
    const vSku = variantSku(baseSku, variant);
    const value =
      variant.price_cents != null
        ? centsToMoneyString(variant.price_cents)
        : ctx.summary.priceValue;
    const offerFields = {
      availableQuantity: variant.quantity,
      categoryId: ctx.summary.categoryId,
      listingDescription: ctx.summary.description,
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId: policies.paymentPolicyId,
        returnPolicyId: policies.returnPolicyId,
        ...(bestOfferTerms ? { bestOfferTerms } : {}),
      },
      pricingSummary: { price: { value, currency: ctx.summary.currency } },
      merchantLocationKey: policies.merchantLocationKey,
    };
    try {
      await createOffer(ownerId, {
        sku: vSku,
        marketplaceId: getMarketplaceId(),
        format: "FIXED_PRICE",
        ...offerFields,
      });
    } catch (err) {
      if (!isOfferAlreadyExistsError(err)) throw err;
      const existing = await listOffersForSku(ownerId, vSku);
      const found = existing.find((o) => !!o.offerId);
      if (!found) throw err;
      await syncExistingOffer(ownerId, found.offerId, offerFields);
    }
  }

  // 4. Publish the whole group as one multi-variation listing (adopt on retry).
  const published = await publishItemGroupOrAdopt(
    ownerId,
    baseSku,
    variantSkus,
    getMarketplaceId(),
  );
  const listingId = published.listingId;
  const url = ebayListingUrl(listingId);

  // 5. Persist. Quantity is the total across variants; price is the base price.
  const totalQuantity = variations.variants.reduce(
    (sum, v) => sum + v.quantity,
    0,
  );
  const listingPayload = {
    inventory_item_id: itemId,
    platform: "ebay" as const,
    // US-1077: published from FlipDesk → GradeThread-originated.
    listing_origin: "gradethread" as const,
    // US-1507: stamp the publishing connection (see single-SKU payload above).
    marketplace_connection_id: ctx.connectionId,
    platform_listing_id: listingId,
    // US-1999: for a multi-variation listing the pinned SKU is the BASE sku —
    // it is the inventory_item_group key, and each variant SKU is derived from
    // it by variantSku(). Pinning the base therefore pins every variant.
    inventory_sku: baseSku,
    platform_category_id: ctx.summary.categoryId,
    listing_url: url,
    listing_price: Number(ctx.summary.priceValue),
    listing_title: ctx.summary.title,
    listing_description: ctx.summary.description,
    listing_status: "active" as const,
    is_active: true,
    quantity: totalQuantity,
    listed_at: new Date().toISOString(),
    synced_to_ebay_at: new Date().toISOString(),
    publish_error: null,
    publish_failed_at: null,
  };

  const { syncPending } = await finalizePublishedListing({
    persist: async () => {
      if (listing?.id) {
        const { error } = await supabaseAdmin
          .from("listings")
          .update(listingPayload)
          .eq("id", listing.id);
        if (error) throw new Error(`listings update: ${error.message}`);
      } else {
        const { error } = await supabaseAdmin.from("listings").insert(listingPayload);
        if (error) throw new Error(`listings insert: ${error.message}`);
      }
      const { error: itemErr } = await supabaseAdmin
        .from("inventory_items")
        .update({ status: "listed" })
        .eq("id", itemId);
      if (itemErr) throw new Error(`inventory_items update: ${itemErr.message}`);
    },
    recordReconcile: async () => {
      await supabaseAdmin.from("flipdesk_ebay_listings").upsert(
        {
          user_id: ownerId,
          ebay_item_id: listingId,
          custom_label: baseSku,
          title: ctx.summary.title,
          current_price: Number(ctx.summary.priceValue),
          listing_url: url,
          raw: {
            source: "publish_orphan_variation",
            inventory_item_id: itemId,
            group_key: baseSku,
          },
          match_status: "unmatched",
          imported_at: new Date().toISOString(),
        },
        { onConflict: "user_id,ebay_item_id" },
      );
      console.error(
        `[flipdesk-ebay] variation publish ${listingId} is LIVE but local write ` +
          `failed — recorded reconcile marker; pull-sync will adopt it`,
      );
    },
  });

  // US-932: variation group is live → internal event stream (drip substrate).
  void emitEvent(ownerId, "listing_published", {
    properties: { listing_id: listingId, sku: baseSku },
  });
  void emitEvent(ownerId, "first_listing", {
    dedupeKey: firstOccurrenceKey("first_listing", ownerId),
  });

  if (ctx.summary.promotedAdRate != null && ctx.summary.promotedAdRate > 0) {
    await attachPromotionAtPublish({
      userId: ownerId,
      listingRowId: listing?.id ?? null,
      ebayListingId: listingId,
      ratePct: ctx.summary.promotedAdRate,
      // US-1447: honour the listing's chosen promotion mode (CPS / CPC / Smart).
      mode: ctx.summary.promotedMode,
    });
  }

  if (listing?.id) await captureListingAcceptance(listing.id);

  return {
    ok: true,
    listing_id: listingId,
    listing_url: url,
    offer_id: variantSkus[0] ?? baseSku,
    sku: baseSku,
    sync_pending: syncPending,
  };
}

flipdeskEbayRoutes.post("/listings/push", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { itemId, relist } = await readPushBody(c);
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);

  // US-382: enforce the active-listing cap server-side (was UI-only). Skip the
  // +1 when this exact item is ALREADY listed — a re-publish/revise of a live
  // listing must not be blocked or counted twice (the cap counts items in
  // status 'listed', which already includes it).
  const { data: existing } = await supabaseAdmin
    .from("inventory_items")
    .select("status")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  const alreadyListed = (existing as { status?: string } | null)?.status === "listed";
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "activeListings", delta: alreadyListed ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const result = await publishItemForOwner(userId, itemId, { relist });
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({
    ok: true,
    listing_id: result.listing_id,
    listing_url: result.listing_url,
    offer_id: result.offer_id,
    sku: result.sku,
    // US-783: true → the listing is live on eBay but the local sync is pending;
    // the UI should say "live, syncing shortly" rather than treat it as failed.
    sync_pending: result.sync_pending ?? false,
  });
});

// US-560: quantity-aware relist of a sold-out evergreen item. One call
// replenishes the listing quantity, reuses the existing eBay offer for the SKU,
// and republishes — so a seller never has to rebuild a listing from scratch.
//   • Replenish: bumps listings.quantity to the requested value (default 1,
//     floored at 1) so assemblePublishContext resolves availableQuantity > 0.
//   • Reuse the offer: publishItemForOwner({ relist: true }) ends a still-live
//     offer then re-publishes the SAME SKU offer via syncExistingOffer +
//     publishOrAdoptOffer (no duplicate offer).
//   • Never live at 0: the publish context floors quantity at 1, and we floor
//     the replenish target at 1, so a previously-sold item can't go live empty.
//   • Idempotent: publishOrAdoptOffer adopts an already-live listing and the
//     quantity write is a fixed set, so a retry converges to the same state.
// ── US-9118: the relist body, as a function ────────────────────────────────
//
// The HTTP handler below calls this, and lib/ebay-publish-port.ts registers it
// so the connector's relist tool runs the SAME guards. Sliced verbatim out of
// the handler; the capacity gate swapped requireFlipdesk for its context-free
// sibling, which resolves the plan identically and refuses with the same
// numbers.
//
// ⚠ THE ORDER MATTERS: the quantity is replenished BEFORE publishing, so the
// publish context resolves a non-zero availableQuantity. Calling
// publishItemForOwner({relist:true}) directly would relist at quantity zero.

type RelistOutcome = { status: number; body: Record<string, unknown> };

const relistJson = (
  body: Record<string, unknown>,
  status = 200,
): RelistOutcome => ({ status, body });
const relistOk = (body: Record<string, unknown>): RelistOutcome => relistJson(body, 200);

export async function relistOwnedListing(
  userId: string,
  listingId: string,
  replenishQty: number,
): Promise<RelistOutcome> {
  if (!isEbayConfigured()) {
    return relistJson({ error: "eBay is not configured on this server." }, 503);
  }
  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return { status: row.status, body: row.error as Record<string, unknown> };
  // US-1507: refuse to relist an eBay-ORIGINATED (imported) listing. The withdraw
  // needs a platform_offer_id we never have for imported rows, so the old live
  // listing would never end AND the re-publish would upsert onto this same row —
  // repurposing the mirror of a still-live eBay-native listing into a duplicate
  // GradeThread listing with a corrupted mirror. Mirror the revise guard (US-1080)
  // and the iOS-side hide, defense in depth.
  const relistOrigin = deriveListingOrigin({
    platform: "ebay",
    platform_listing_id: row.listing.platform_listing_id,
    batch_id: row.listing.batch_id,
    synced_to_ebay_at: row.listing.synced_to_ebay_at,
  });
  if (relistOrigin === "ebay") {
    return relistJson(
      {
        error:
          "This listing was created on eBay, not in FlipDesk, so it can't be relisted here. End it on eBay (or in FlipDesk) and create a fresh FlipDesk listing to sell it again.",
      },
      409,
    );
  }
  if (!row.listing.inventory_item_id) {
    return relistJson(
      { error: "This listing is not linked to an inventory item; cannot relist." },
      409,
    );
  }
  const itemId = row.listing.inventory_item_id;

  // Enforce the active-listing cap (mirrors /listings/push). A sold-out item is
  // no longer in 'listed' status, so relisting re-occupies a slot (+1); skip the
  // increment when this exact item is somehow still counted as listed.
  const { data: existing } = await supabaseAdmin
    .from("inventory_items")
    .select("status")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  const alreadyListed = (existing as { status?: string } | null)?.status === "listed";
  // US-9118: the context-free sibling, so the connector's relist tool cannot be
  // the one entry point that skips the active-listing cap. Same resolution and
  // the same numbers requireFlipdesk would have refused with.
  const cap = await capacityAllowedForUser(userId, {
    kind: "activeListings",
    delta: alreadyListed ? 0 : 1,
  });
  if (!cap.allowed) {
    return {
      status: 402,
      body: {
        error: "CAP_REACHED",
        cap: cap.cap,
        used: cap.used,
        delta: cap.delta,
        limit: cap.limit,
        plan: cap.plan,
      },
    };
  }

  // Replenish the quantity on the draft listing row BEFORE publishing so the
  // publish context resolves the new availableQuantity for both the inventory
  // PUT and the (reused) offer. Idempotent — a fixed set, safe under retry.
  const { error: qtyErr } = await supabaseAdmin
    .from("listings")
    .update({ quantity: replenishQty })
    .eq("id", listingId);
  if (qtyErr) {
    console.error("[flipdesk-ebay] relist: quantity replenish failed:", qtyErr);
    return relistJson({ error: "Could not replenish listing quantity." }, 500);
  }

  const result = await publishItemForOwner(userId, itemId, { relist: true });
  if (!result.ok) return { status: result.status, body: result.body };
  return relistOk({
    ok: true,
    listing_id: result.listing_id,
    listing_url: result.listing_url,
    offer_id: result.offer_id,
    sku: result.sku,
    quantity: replenishQty,
    sync_pending: result.sync_pending ?? false,
  });
}

flipdeskEbayRoutes.post("/listings/:id/relist", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: { quantity?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  // Respect an explicit replenish quantity; otherwise default to 1. Floor at 1
  // (non-positive / non-integer requests clamp up) so a republished
  // previously-sold item never goes live at quantity 0.
  const requested = Number(body.quantity);
  const replenishQty =
    Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;

  const outcome = await relistOwnedListing(userId, listingId, replenishQty);
  return c.json(outcome.body, outcome.status as 200);
});

// Loads a local listings row by id and verifies the user owns the parent
// inventory_item (the listings table doesn't have a user_id column).
// US-1504: the single "which price wins" rule at publish. An AutoLister draft's
// listing_price may be an AI ESTIMATE (no eBay comps); when the seller set a real
// target price, the TARGET wins over the estimate — otherwise we'd publish at the
// stale estimate ($25) after the seller chose $40. A non-estimate draft price
// (seller-edited in the composer) leads; target is the fallback. Returns null
// when neither is a usable (> 0) price.
export function resolvePublishPrice(
  listingPrice: number | null,
  priceIsEstimated: boolean,
  targetPrice: number | null,
): number | null {
  const listingUsable = listingPrice != null && listingPrice > 0;
  const targetUsable = targetPrice != null && targetPrice > 0;
  if (targetUsable && priceIsEstimated) return targetPrice;
  if (listingUsable) return listingPrice;
  if (targetUsable) return targetPrice;
  return null;
}

// Push body reader that also surfaces the optional `relist` flag. The body can
// only be consumed once, so callers that need both fields use this instead of
// readItemId().
async function readPushBody(
  c: Context<EbayEnv>
): Promise<{ itemId: string | null; relist: boolean }> {
  try {
    const body = (await c.req.json()) as {
      inventory_item_id?: unknown;
      relist?: unknown;
    };
    return {
      itemId:
        typeof body.inventory_item_id === "string"
          ? body.inventory_item_id
          : null,
      relist: body.relist === true,
    };
  } catch {
    return { itemId: null, relist: false };
  }
}

/**
 * US-2944: what the item behind a listing cost, in cents, owner-scoped.
 *
 * Read here rather than added to the PublishListing select because it is needed
 * on exactly one branch (best-offer enabled with an active rule) and widening
 * the publish query would make every publish pay for it.
 *
 * Null on any miss — an unknown cost means the margin floor does not apply at
 * publish time, and the offer runner still enforces it hourly. Assuming zero
 * would make the floor push the auto-accept to nothing.
 */
async function acquiredCostCentsForListing(
  ownerId: string,
  listingId: string | null,
): Promise<number | null> {
  if (!listingId) return null;
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("inventory_items!inner(user_id, acquired_price)")
    .eq("id", listingId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  if (error) {
    console.error("[flipdesk-ebay] acquired cost lookup:", error.message);
    return null;
  }
  const row = data as
    | {
      inventory_items:
        | { acquired_price: number | null }
        | { acquired_price: number | null }[]
        | null;
    }
    | null;
  const inv = Array.isArray(row?.inventory_items) ? row?.inventory_items[0] : row?.inventory_items;
  const cost = inv?.acquired_price;
  return typeof cost === "number" && Number.isFinite(cost) ? Math.round(cost * 100) : null;
}

interface PublishContextErr {
  ok: false;
  error: { error: string };
  status: 400 | 404 | 500 | 503;
}

type PublishContext = PublishContextOk | PublishContextErr;

// NOTE: the Digital-Slab listing-image attachment (formerly slabImageUrlForItem
// / applySlabImagePromotion) was removed in the eBay-policy pivot — graded
// images are never attached to listings now (see applyGradeListingPromotion).
// The slab page itself (functions/slab/cert/[id].ts) still serves standalone /
// social use; we just don't ride it onto marketplace photos.

// Exported so the AutoLister auto-publish path (US-955) can run the SAME publish
// pre-flight (blockers + policies) the manual /listings/validate + publish use,
// to decide which green drafts are clean enough to auto-publish.
// ── US-9116: hand the publish path to lib/ebay-publish-port.ts ─────────────
//
// The connector's publish tool cannot import a route, so the route registers.
// The ADAPTING happens here, next to the context definition, so a new blocker
// or a renamed field is a compile error where someone is already looking rather
// than a silently-missing line in a preview a seller is about to approve.
//
// Registered at module load; main.ts imports this module, so any request that
// can reach the tool has already run it.
registerEbayPublisher({
  preview: async (ownerId, itemId) => {
    const ctx = await assemblePublishContext(ownerId, itemId);
    if (!ctx.ok) {
      return {
        ready: false,
        blockers: [String((ctx.error as { error?: unknown }).error ?? "Cannot publish this item.")],
        warnings: [],
        title: "",
        price: null,
        quantity: 0,
        categoryId: null,
        policiesReady: false,
        photoCount: 0,
        condition: null,
      };
    }
    return {
      // Mirrors publishItemForOwner's own gate exactly: it refuses when there
      // are blockers OR no policies, so a preview that called itself ready on
      // one of those would be a preview that lies.
      ready: ctx.blockers.length === 0 && ctx.policies !== null,
      blockers: ctx.blockers,
      warnings: ctx.warnings,
      title: ctx.listing?.listing_title ?? ctx.item.title ?? "",
      price: resolvePublishPrice(
        ctx.listing?.listing_price ?? null,
        ctx.listing?.price_is_estimated === true,
        ctx.item.target_price ?? null,
      ),
      quantity: Math.max(1, ctx.listing?.quantity ?? 1),
      categoryId: ctx.listing?.platform_category_id ?? ctx.item.ebay_category_id ?? null,
      policiesReady: ctx.policies !== null,
      photoCount: ctx.photos.length,
      condition: ctx.listing?.ebay_condition ?? null,
    };
  },
  publish: (ownerId, itemId, opts) => publishItemForOwner(ownerId, itemId, opts ?? {}),
  relist: (ownerId, listingId, quantity) =>
    relistOwnedListing(ownerId, listingId, quantity),
});

export async function assemblePublishContext(
  userId: string,
  itemId: string
): Promise<PublishContext> {
  if (!isEbayConfigured()) {
    return {
      ok: false,
      error: { error: "eBay is not configured on this server." },
      status: 503,
    };
  }

  // Verify connection up front so getDefaultPolicies + push share a fail-fast.
  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: publish through the selected (primary) connection.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) {
    return {
      ok: false,
      error: { error: "Connect your eBay account first." },
      status: 400,
    };
  }

  // NOTE: list_price is NOT a real column on inventory_items — it only exists
  // as a derived alias inside the items_full view (l.listing_price AS list_price).
  // Including it here triggers PostgreSQL 42703 (undefined column) and PostgREST
  // returns data:null, which the caller used to mis-report as "Item not found".
  // The publish-time price priority is now listing.listing_price → target_price.
  const { data: itemRow, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(
      // US-2790: garment_category + measurements feed the predicted parcel.
      // Both are real columns on inventory_items (00002 and the measurement
      // capture work), NOT view-only aliases - the note above about list_price
      // is about a column that only exists inside items_full, and these are not
      // that. flipdesk-logistics.ts reads the same two off this same table.
      "id, user_id, title, brand, sku, size, description, condition_notes, target_price, grade_value, grade_label, certificate_url, ebay_category_id, ebay_aspects, ebay_aspect_sources, ebay_epid, item_category, garment_category, color, material, style, measurements, attributes, status"
    )
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr) {
    // PostgREST silently returns data: null when the SELECT column list is
    // invalid (missing column, etc.) — without this log we'd mis-diagnose
    // the failure as "row not found". The most common cause is a column
    // referenced in the select that hasn't been migrated yet.
    console.error(
      `[flipdesk-ebay] publish lookup: inventory_items query errored for ${itemId} ` +
        `— code=${itemErr.code} message=${itemErr.message} details=${itemErr.details ?? ""} hint=${itemErr.hint ?? ""}`,
    );
    return { ok: false, error: { error: "Item lookup failed" }, status: 500 };
  }
  if (!itemRow) {
    console.warn(
      `[flipdesk-ebay] publish lookup: inventory_items row ${itemId} does not exist (caller userId=${userId})`,
    );
    return { ok: false, error: { error: "Item not found" }, status: 404 };
  }
  if ((itemRow as PublishItem).user_id !== userId) {
    console.warn(
      `[flipdesk-ebay] publish lookup: ownership mismatch for item ${itemId} ` +
        `— row user_id=${(itemRow as PublishItem).user_id}, caller userId=${userId}`,
    );
    return { ok: false, error: { error: "Item not found" }, status: 404 };
  }
  const item = itemRow as PublishItem;

  // 00432: seller's Promoted-Listings defaults — used when a listing hasn't made
  // an explicit per-listing choice (promote_override IS NULL). Best-effort: a
  // missing row leaves promotion off-by-default (the safe direction).
  const { data: ownerRow } = await supabaseAdmin
    .from("users")
    .select(
      "promote_listings_by_default, default_promo_rate_pct, default_promo_mode",
    )
    .eq("id", userId)
    .maybeSingle();
  const owner = ownerRow as {
    promote_listings_by_default: boolean | null;
    default_promo_rate_pct: number | null;
    default_promo_mode: string | null;
  } | null;

  // Most recent eBay-platform listing draft for this item (if any).
  // Pull the AutoLister-edited columns too — composer/bulk-edit writes here
  // and these must reach eBay at publish (US-319/320/321).
  const { data: listingRow } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, listing_description, listing_price, price_is_estimated, ebay_condition, ebay_condition_description, quantity, best_offer_enabled, best_offer_auto_accept_cents, best_offer_auto_decline_cents, price_range_low_cents, price_range_high_cents, platform_category_id, item_specifics_override, item_specifics_sources, scheduled_publish_at, shipping_policy_id, payment_policy_id, return_policy_id, promo_rate_pct, promo_opt_out, promote_override, promo_mode, listing_format, auction_start_price_cents, auction_reserve_price_cents, auction_buy_it_now_price_cents, auction_duration, variations, listing_origin, listing_status, is_active, platform_listing_id, batch_id, synced_to_ebay_at, inventory_sku",
    )
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let listing = (listingRow as PublishListing | null) ?? null;

  // US-1509: an eBay-ORIGINATED row is a read-only mirror of a listing that
  // lives natively on eBay — publish must never source draft fields from it and,
  // above all, never repurpose it in step 5 (that corrupted the mirror while the
  // real listing stayed live, yielding duplicate live listings). Drop it from
  // the context so a publish inserts a FRESH row; if the mirror is still LIVE,
  // block the publish outright — listing the same item again is exactly the
  // duplicate-live-listing class this guard exists to prevent.
  let liveEbayMirrorBlocker: string | null = null;
  if (listing) {
    const rowOrigin = deriveListingOrigin({
      listing_origin: listing.listing_origin,
      platform: "ebay",
      platform_listing_id: listing.platform_listing_id,
      batch_id: listing.batch_id,
      synced_to_ebay_at: listing.synced_to_ebay_at,
    });
    if (rowOrigin === "ebay") {
      const live = listing.is_active === true ||
        listing.listing_status === "active" ||
        listing.listing_status === "relisted";
      if (live) {
        liveEbayMirrorBlocker =
          "This item is already live on eBay (a listing created on eBay). " +
          "End it on eBay or unlink it before publishing from FlipDesk — " +
          "publishing again would create a duplicate live listing.";
      }
      listing = null;
    }
  }

  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    // US-1896: width/height feed the picture-standards preflight (dimensions),
    // photo_type feeds the hero-thumbnail nudge.
    .select("id, storage_path, photo_url, photo_type, photo_role, sort_order, width, height")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });

  // US-1549: 'internal' photos (price tags, receipts) are excluded from the
  // whole publish context — they never reach eBay, never count toward the
  // photo blockers, and never surface as the composer's gallery.
  const listablePhotoRows = filterEbayPhotos((photoRows ?? []) as Array<{
    id: string;
    storage_path: string | null;
    photo_url: string | null;
    photo_type: string | null;
    // US-2462: declared so the select above cannot lose it silently.
    photo_role: string | null;
    sort_order: number;
    width: number | null;
    height: number | null;
  }>);
  const photos: PublishPhoto[] = listablePhotoRows.map((p) => {
    // Prefer the stored public URL; fall back to computing one from the
    // storage_path — but never for sensitive private-bucket photos (US-979).
    return {
      id: p.id,
      public_url: ebayPublicPhotoUrl(p) ?? "",
      sort_order: p.sort_order,
    };
  });

  const blockers: string[] = [];
  // US-1896: picture-standards results (non-blocking zoom warning + hero-thumbnail
  // reorder nudge) are collected here in the photo section below and merged into
  // the response after the title-quality warnings are built.
  const photoWarnings: string[] = [];
  let photoNudge: string | null = null;
  // US-1897: structured signals captured for the Listing Quality Score. These
  // are values already computed below for blockers/warnings; capturing them
  // keeps the score off string-sniffing the blocker array, which would break
  // silently the first time a message is reworded.
  let qsPhotoBlockers: string[] = [];
  let qsPhotoWarnings: string[] = [];
  let qsTitlePolicyViolations: string[] = [];
  let qsCategoryLeafStatus: "leaf" | "non_leaf" | "not_found" | "unverified" = "unverified";
  // US-1509: surfaced first — nothing else matters while the item is already live.
  if (liveEbayMirrorBlocker) blockers.push(liveEbayMirrorBlocker);
  // Category resolution: listing-row override wins (AutoLister writes here);
  // fall back to inventory_items for legacy / single-item composer flows.
  let categoryId = listing?.platform_category_id ?? item.ebay_category_id ?? null;
  // US-1893: track whether we JUST resolved the category from a Taxonomy
  // suggestion (which is always a leaf) so the leaf-guard below can skip a
  // redundant probe for it.
  let categoryWasSuggested = false;
  // Auto-resolve a real eBay leaf category when the item never got one. Items
  // created via the single-item composer / manual catalog skip AutoLister's
  // suggestCategories step (ai-listing.ts), so categoryId is null even though
  // the item has a brand/title. Our internal item_category enum is NOT an eBay
  // category, so we resolve against the Taxonomy API from the strongest free
  // text we have and persist the result so this lookup only runs once.
  if (!categoryId) {
    const query = [item.brand, item.title, item.item_category]
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0)
      .join(" ")
      .trim();
    if (query) {
      try {
        const suggestions = await suggestCategories(query);
        if (suggestions.length > 0) {
          categoryId = suggestions[0]!.categoryId;
          categoryWasSuggested = true; // a Taxonomy suggestion is always a leaf.
          qsCategoryLeafStatus = "leaf"; // US-1897: and it matches the suggestion.
          // Persist so subsequent publishes (and the composer) reuse it.
          // Prefer the listing row when one exists; always mirror onto the
          // item so legacy/no-listing flows pick it up too.
          if (listing?.id) {
            await supabaseAdmin
              .from("listings")
              .update({ platform_category_id: categoryId })
              .eq("id", listing.id);
          }
          await supabaseAdmin
            .from("inventory_items")
            .update({ ebay_category_id: categoryId })
            .eq("id", itemId);
        }
      } catch (err) {
        console.error("[flipdesk-ebay] publish category auto-resolve:", err);
      }
    }
  }
  if (!categoryId) blockers.push("Pick an eBay category.");
  // US-1893: leaf-category guard. A manually-set / imported / legacy category id
  // can be a PARENT node, which eBay rejects at publish with an opaque error (and
  // a non-leaf is filtered out of Browse and gets the wrong required-aspect set).
  // Verify leaf-ness up front — cache-first, so an already-validated category
  // costs no live Taxonomy call — and on a non-leaf/unknown id surface a fixable
  // blocker naming the top get_category_suggestions leaf as the one-click fix.
  // Skip when we JUST resolved the id from a suggestion (guaranteed leaf).
  if (categoryId && !categoryWasSuggested) {
    try {
      const leafStatus = await resolveCategoryLeafStatus(categoryId, {
        hasCachedLeaf: categoryHasCachedLeafAspects,
        probeLeafStatus: fetchCategoryLeafStatus,
      });
      qsCategoryLeafStatus = leafStatus;
      if (leafStatus === "non_leaf" || leafStatus === "not_found") {
        // Same suggestion mechanism the category-check card uses (suggestCategories).
        const fixQuery = [item.brand, item.title, item.item_category]
          .map((s) => (typeof s === "string" ? s.trim() : ""))
          .filter((s) => s.length > 0)
          .join(" ")
          .trim();
        let suggestion: LeafCategorySuggestion | null = null;
        if (fixQuery) {
          try {
            const suggestions = await suggestCategories(fixQuery);
            if (suggestions.length > 0) suggestion = suggestions[0]!;
          } catch (err) {
            console.error("[flipdesk-ebay] leaf-guard suggestion lookup:", err);
          }
        }
        const blocker = leafCategoryBlocker(categoryId, leafStatus, suggestion);
        if (blocker) blockers.push(blocker);
      }
    } catch (err) {
      // Never let the guard itself break a publish — log and continue.
      console.error("[flipdesk-ebay] leaf-category guard:", err);
    }
  }
  // Aspect map: prefer item_specifics_override (the AutoLister-edited copy);
  // fall back to the inventory mirror. The inventory mirror feeds legacy flows.
  // US-1505: coerce string-valued legacy rows ({Fit:"Slim"}) to string[] before
  // any array consumer (forceColumnAspects / reconcilePublishAspects) touches it.
  const aspectMap: Record<string, string[]> = normalizeAspectMap(
    (listing?.item_specifics_override as Record<string, unknown> | null) ??
      (item.ebay_aspects as Record<string, unknown> | null),
  );
  // Reverse column sync: a MANUAL Brand/Size/Color/Material/Style edit in a
  // specifics editor (composer, bulk edit, iOS) is the newest human intent for
  // that shared field — fold it back into the item column BEFORE
  // forceColumnAspects below re-asserts the columns, or the stale column would
  // clobber the edit and the seller would face the double-entry it was meant to
  // fix. AI-extracted values only fill blank columns; derived/unattributed
  // values never flow back. Pick the provenance map that pairs with whichever
  // store aspectMap came from.
  {
    const aspectSources = ((listing?.item_specifics_override != null
      ? listing.item_specifics_sources
      : item.ebay_aspect_sources) ?? {}) as Record<string, string | undefined>;
    const writeBack = reverseColumnAspects(
      item as unknown as RegistryItem,
      aspectMap,
      aspectSources,
    );
    if (Object.keys(writeBack).length > 0) {
      Object.assign(item, writeBack); // downstream projection reads the new values
      const { error: wbErr } = await supabaseAdmin
        .from("inventory_items")
        .update(writeBack as never)
        .eq("id", itemId);
      if (wbErr) {
        console.error(
          `[flipdesk-ebay] publish column write-back failed for ${itemId}: ${wbErr.message}`,
        );
      }
    }
  }
  let requiredMissing: string[] = [];
  // US-1895: recommended-aspect coverage (non-blocking); populated alongside the
  // required-blocker check below from the same category spec.
  let recommendedCoverage: AspectCoverage = { filled: 0, total: 0, missing: [] };
  // US-828: aspects the publish path declined to send for VALUE-validation
  // reasons (a SELECTION_ONLY value not in eBay's allowed set, even after the
  // US-823 normalizer). Surfaced in the publish/validate response so the client
  // can say "X was not sent" instead of the value vanishing silently.
  let aspectDiagnostics: PublishAspectDiagnostic[] = [];
  // The map actually sent to eBay — `aspectMap` minus value-validation omissions
  // (with near-misses normalized). Kept separate from the PERSISTED aspectMap so
  // the draft retains the seller's flagged values for them to fix (US-828 keeps
  // unmatched values visible rather than dropping them at generation).
  let sanitizedAspects: Record<string, string[]> = aspectMap;
  if (categoryId) {
    try {
      const aspectsResp = await getCategoryAspects(categoryId);
      const raw = (aspectsResp.aspects as Record<string, unknown>).aspects;
      const list = Array.isArray(raw) ? (raw as AspectSpecRaw[]) : [];

      // US-1088+: the structured columns (Brand/Size/Color/Material/Style) OWN
      // their eBay aspects. Force the current column values onto the map first —
      // overwriting any stale value a previous publish left behind (which buyers
      // would otherwise see as the old/<UNKNOWN> specific) and clearing aspects
      // whose column was blanked. resolveItemAspects (below) never overwrites, so
      // without this a later column edit would never reach an already-built map.
      const forced = forceColumnAspects(
        item as unknown as RegistryItem,
        list,
        aspectMap,
      );
      let columnAspectsChanged = false;
      for (const k of Object.keys(aspectMap)) {
        if (!(k in forced)) {
          delete aspectMap[k];
          columnAspectsChanged = true;
        }
      }
      for (const [k, v] of Object.entries(forced)) {
        if (JSON.stringify(aspectMap[k]) !== JSON.stringify(v)) {
          aspectMap[k] = v;
          columnAspectsChanged = true;
        }
      }

      // Auto-fill specifics from the item's structured columns so manually
      // cataloged items (which never ran AutoLister's AI aspect pass) don't
      // block publish on Brand/Size/Color/etc. that we already know. Only
      // fills aspects not already present; SELECTION_ONLY aspects are filled
      // only when the column value matches one of eBay's allowed values.
      const derived = deriveAspectsFromItem(item, list, aspectMap);
      if (Object.keys(derived).length > 0 || columnAspectsChanged) {
        Object.assign(aspectMap, derived);
        // US-825: record provenance for what we just auto-filled / re-asserted
        // from columns (inventory_derived), merged onto whatever sources already
        // existed so an AI- or user-attributed aspect is never downgraded —
        // except the column-owned ones we just forced, which ARE now derived.
        const priorSources =
          (listing?.id
            ? listing.item_specifics_sources
            : item.ebay_aspect_sources) ?? {};
        const derivedKeys = [
          ...new Set([...Object.keys(derived), ...Object.keys(forced)]),
        ];
        const sources = mergeSources(
          priorSources,
          sourcesFor(derivedKeys, "inventory_derived"),
          aspectMap,
        );
        // Persist so the offer payload AND the composer's specifics editor
        // reflect what we filled. item_specifics_override is the listing-level
        // canonical copy; mirror to the item when there's no listing row yet.
        if (listing?.id) {
          await supabaseAdmin
            .from("listings")
            .update({
              item_specifics_override: aspectMap,
              item_specifics_sources: sources,
            })
            .eq("id", listing.id);
        } else {
          // US-826: this deterministic (no-AI) gap-fill IS the recovery path
          // for a partial one-call prep — clear the refill flag now that the
          // item's aspects are populated from its own columns.
          await supabaseAdmin
            .from("inventory_items")
            .update({
              ebay_aspects: aspectMap,
              ebay_aspect_sources: sources,
              ebay_aspects_refill_needed: false,
            })
            .eq("id", itemId);
        }
      }

      // US-828: validate aspect VALUES against the category spec before the
      // offer build. SELECTION_ONLY near-misses are normalized (US-823) so they
      // publish; values eBay still won't accept are OMITTED from the outgoing
      // payload and recorded as diagnostics. Unknown aspect names + free-text
      // pass through unchanged, so this only ever omits for value-validation
      // reasons. The PERSISTED aspectMap is untouched — the draft keeps the
      // flagged value for the seller to fix.
      const reconcileSpecs: ReconcileSpec[] = list
        .map((a) => ({
          name: a.localizedAspectName ?? "",
          mode: a.aspectConstraint?.aspectMode ?? "FREE_TEXT",
          allowedValues: (a.aspectValues ?? [])
            .map((v) => v.localizedValue ?? "")
            .filter((v) => v.length > 0),
          dataType: a.aspectConstraint?.aspectDataType,
        }))
        .filter((s) => s.name.length > 0);
      const reconciled = reconcilePublishAspects(aspectMap, reconcileSpecs);
      sanitizedAspects = reconciled.aspects;
      aspectDiagnostics = reconciled.omitted;
      if (aspectDiagnostics.length > 0) {
        console.warn(
          `[flipdesk-ebay] omitted ${aspectDiagnostics.length} aspect value(s) for ` +
            `item ${itemId} (category ${categoryId}) — not in eBay's allowed set: ` +
            JSON.stringify(aspectDiagnostics),
        );
      }

      // US-825: the SAME required-aspect rule the client pre-publish checklist
      // uses (requiredMissingAspects) — blocker and checklist can't disagree.
      // Run on the sanitized map so a required aspect whose only value was
      // invalid (and thus omitted) correctly surfaces as a fixable blocker.
      requiredMissing = requiredMissingAspects(list, sanitizedAspects);
      // US-1895: recommended coverage from the SAME spec + sanitized map, so the
      // composer meter and the required blocker are computed from one source.
      recommendedCoverage = recommendedAspectCoverage(list, sanitizedAspects);
      if (requiredMissing.length > 0) {
        // Diagnostic: log WHY each missing aspect couldn't be auto-filled —
        // its mode, a sample of eBay's allowed values, and the item text we
        // tried to infer from. Lets us close the gap without guessing.
        const diag = requiredMissing.map((name) => {
          const spec = list.find((a) => a.localizedAspectName === name);
          const allowed = (spec?.aspectValues ?? [])
            .map((v) => v.localizedValue ?? "")
            .filter((v) => v.length > 0);
          return {
            name,
            mode: spec?.aspectConstraint?.aspectMode ?? "?",
            allowedSample: allowed.slice(0, 12),
            allowedCount: allowed.length,
          };
        });
        console.warn(
          `[flipdesk-ebay] required specifics unfilled for item ${itemId} ` +
            `(category ${categoryId}): ${JSON.stringify(diag)} ` +
            `| item title=${JSON.stringify(item.title)} style=${JSON.stringify(item.style)} ` +
            `item_category=${JSON.stringify(item.item_category)}`,
        );
        // A required aspect we OMITTED (value eBay wouldn't take) reads as
        // "unfilled" to the seller who can plainly see a value in the composer.
        // Say what was actually wrong with it instead.
        const omittedRequired = requiredMissing.filter((name) =>
          aspectDiagnostics.some((d) => d.aspect === name),
        );
        for (const name of omittedRequired.slice(0, 3)) {
          const bad = aspectDiagnostics.find((d) => d.aspect === name);
          const spec = list.find((a) => a.localizedAspectName === name);
          const numeric =
            (spec?.aspectConstraint?.aspectDataType ?? "").toUpperCase() === "NUMBER";
          blockers.push(
            `eBay won't accept "${bad?.omittedValues[0] ?? ""}" for ${name}` +
              (numeric
                ? " — it needs a number (e.g. 8.5), no units or words."
                : " — pick one of eBay's allowed values in the composer."),
          );
        }
        const plainMissing = requiredMissing.filter(
          (n) => !omittedRequired.includes(n),
        );
        if (plainMissing.length > 0) {
          blockers.push(
            `Fill required eBay specifics in the composer: ${plainMissing.slice(0, 4).join(", ")}${
              plainMissing.length > 4 ? "…" : ""
            }`
          );
        }
      }
    } catch (err) {
      // US-1505: distinguish an internal bug (e.g. a TypeError from a malformed
      // aspect map) from a genuine category-spec FETCH failure. The old code
      // surfaced BOTH as "Could not load eBay specifics… Try again." — a
      // retry-forever dead end when the real fault was code, not eBay.
      if (err instanceof TypeError) {
        console.error(
          "[flipdesk-ebay] INTERNAL aspect-reconcile error (not an eBay fetch):",
          err,
        );
        blockers.push(
          "Internal error preparing eBay specifics. Please contact support if this persists.",
        );
      } else {
        console.error("[flipdesk-ebay] aspect fetch for validate:", err);
        blockers.push(
          "Could not load eBay specifics for this category. Try again.",
        );
      }
    }
  }

  const photosWithUrl = photos.filter((p) => !!p.public_url);
  if (photosWithUrl.length === 0) {
    blockers.push("Add at least one photo.");
  } else {
    // US-473/US-566: enforce eBay's 24-image cap as a fixable pre-flight blocker
    // (with de-dup + sort_order preserved) so an over-cap set surfaces here
    // instead of a raw eBay 25601 mid-publish. Duplicates are silently de-duped;
    // only a genuine over-cap (after de-dup) blocks so the seller consciously
    // picks which shots to keep rather than losing a defect photo silently.
    const capResult = dedupeAndCapImages(
      photosWithUrl.map((p) => p.public_url),
      PREFLIGHT_MAX_IMAGES,
    );
    const capBlocker = imageCapBlocker(capResult, PREFLIGHT_MAX_IMAGES);
    if (capBlocker) blockers.push(capBlocker);

    // US-1896: eBay picture-standards preflight over the photos that will
    // actually reach eBay. A sub-500px photo is a fixable blocker; a hero under
    // 1600px is a zoom warning; a tag/detail/defect hero triggers the reorder
    // nudge. Fail-open on unknown dimensions (older rows without width/height).
    const standards = photoStandardsPreflight(
      listablePhotoRows
        .filter((p) => !!ebayPublicPhotoUrl(p))
        .map((p) => ({
          photo_type: p.photo_type,
          width: p.width ?? null,
          height: p.height ?? null,
          sort_order: p.sort_order,
        })),
    );
    for (const b of standards.blockers) blockers.push(b);
    for (const w of standards.warnings) photoWarnings.push(w);
    photoNudge = standards.nudge;
    qsPhotoBlockers = [...standards.blockers];
    qsPhotoWarnings = [...standards.warnings];
  }

  // Price priority: explicit listing edits beat inventory defaults so a user
  // who changed the price in the composer or bulk-edit actually publishes that.
  // A listing_price of 0 means "never priced" (bulk draft-create and old
  // composer saves wrote 0 when the price box was empty) — it must FALL
  // THROUGH to the item's target price instead of blocking publish on an item
  // the user already priced. (list_price isn't a real column on
  // inventory_items — only an alias on the items_full view — so it's not in
  // the fallback chain.)
  const priceNumber = resolvePublishPrice(
    listing?.listing_price ?? null,
    listing?.price_is_estimated === true,
    item.target_price ?? null,
  );
  if (!priceNumber || priceNumber <= 0) {
    blockers.push("Set a target price.");
  }

  // US-1890: guarantee an eBay-legal title before it reaches the Inventory API.
  // The composer caps input at 80, but a stored/bulk-edited/API-written title can
  // still be over-length or carry policy phrases — trim on a word boundary (the
  // legal form always feeds summary.title as a backstop) and surface a fixable
  // preflight blocker + policy/quality lint.
  const rawTitle = (listing?.listing_title ?? item.title ?? "").trim();
  const titleTrim = trimTitleWithReport(rawTitle);
  const title = titleTrim.title;
  const titleWarnings: string[] = [];
  if (!title) {
    blockers.push("Set a title.");
  } else if (titleTrim.trimmed) {
    blockers.push(
      `Title is over eBay's 80-character limit. Trim to: "${title}"`,
    );
  }
  if (rawTitle) {
    const lint = lintTitle(rawTitle);
    for (const v of lint.policyViolations) blockers.push(v);
    titleWarnings.push(...lint.warnings);
    qsTitlePolicyViolations = [...lint.policyViolations];
  }

  // US-2677 (AC2): does this read like one of the seller's OTHER live listings
  // in the same category? Scoped to the resolved owner inside the helper
  // (US-268), and excluding this listing's own row, which would otherwise match
  // itself perfectly on every edit.
  //
  // Warnings, never blockers. eBay penalises the STORE for near-duplicates
  // rather than rejecting the listing, so there is no publish-time error to
  // pre-empt -- only a slow store the seller would never connect to a cause.
  if (rawTitle && categoryId) {
    try {
      titleWarnings.push(
        ...(await duplicateTitleWarningsFor(userId, rawTitle, categoryId, listing?.id ?? null)),
      );
    } catch (err) {
      // A courtesy check must never be why a seller cannot see their blockers.
      console.error("[flipdesk-ebay] duplicate-title check:", err);
    }
  }

  // Look up policies last — only blocks if everything else is ready, but
  // surface the missing prereqs as part of `blockers` either way.
  // US-314: read from the cached business_policies table first; only refresh
  // from eBay when the cache is empty or partial.
  let policies: PolicySet | null = null;
  try {
    const policyResult = await resolveCachedDefaults(userId);
    if ("missing" in policyResult) {
      // Split the two failure modes: business policies are configured in eBay
      // Seller Hub, but a merchant (inventory) location can ONLY be created
      // from FlipDesk (eBay has no Seller Hub UI for it). Pointing both at the
      // business-policies help page is the wrong fix for a missing location.
      const missingPolicies = policyResult.missing.filter(
        (m) => m !== "merchant location",
      );
      if (missingPolicies.length > 0) {
        const help = policyResult.details?.helpUrl
          ? ` (set them up at ${policyResult.details.helpUrl})`
          : "";
        blockers.push(
          `Configure eBay business policies on your seller account: ${missingPolicies.join(", ")}.${help}`,
        );
      }
      if (policyResult.missing.includes("merchant location")) {
        blockers.push(
          "Set your eBay ship-from location: open FlipDesk → Marketplaces → eBay and add it (one-time).",
        );
      }
    } else {
      policies = policyResult;
      // US-555: a per-listing policy override (bulk-assigned in the AutoLister
      // grid) wins over the account default. Each id is left to fall back when
      // null, so a partial override (e.g. only return policy) still publishes
      // with the account defaults for the rest.
      if (listing) {
        policies = {
          ...policies,
          fulfillmentPolicyId:
            listing.shipping_policy_id ?? policies.fulfillmentPolicyId,
          paymentPolicyId:
            listing.payment_policy_id ?? policies.paymentPolicyId,
          returnPolicyId: listing.return_policy_id ?? policies.returnPolicyId,
        };
      }
    }
  } catch (err) {
    // Token-refresh / scope errors land here. Surface a hint so the seller
    // knows reconnecting eBay (re-consenting at /oauth/start) is the fix.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] policy lookup:", err);
    if (/invalid_scope|token refresh failed/i.test(msg)) {
      blockers.push(
        "Your eBay connection needs to be refreshed. Disconnect and reconnect eBay on the Marketplaces page to grant the latest permissions.",
      );
    } else {
      blockers.push("Could not load your eBay business policies. Try again.");
    }
  }

  const description = (listing?.listing_description ?? item.description ?? title).trim() ||
    title;
  // US-1999: a RELIST reuses the listing row, so the SKU eBay already holds it
  // under wins over item.sku (which the seller may have edited since). Only a
  // never-published item mints a fresh one.
  const sku = resolveInventorySku(listing, item);
  // Condition: explicit editor value wins; only fall back to grade-derived
  // mapping when the user/AI hasn't set one.
  let condition = (listing?.ebay_condition && listing.ebay_condition.trim())
    ? listing.ebay_condition.trim()
    : mapEbayCondition(item.grade_value, item.grade_label);
  const conditionDescription =
    (listing?.ebay_condition_description ?? item.condition_notes ?? "").trim();

  // US-566 / US-1296+: reconcile the resolved condition with the leaf category's
  // allowed conditions (Sell Metadata get_item_condition_policies, cached). eBay
  // rejects a publish (error 25021) when the condition id isn't accepted by the
  // category — e.g. apparel categories reject LIKE_NEW (2750). Auto-pick the
  // nearest ALLOWED condition of equal-or-worse quality so publish just works
  // without overstating; only block when no honest option exists (the category
  // accepts only better/unrepresentable conditions). Best-effort: a policy-fetch
  // failure or an unrestricted category leaves the condition untouched.
  if (categoryId) {
    try {
      const { conditionIds } = await getItemConditionPolicies(categoryId);
      // US-1894: apparel-aware resolve (2025 pre-loved bands on apparel leaves)
      // + allow-list remap. Non-apparel categories resolve identically to the
      // legacy base→remap path. Explicit editor value still wins.
      const remapped = resolveEbayCondition({
        explicit: listing?.ebay_condition,
        grade: item.grade_value,
        label: item.grade_label,
        allowedConditionIds: conditionIds,
      });
      if (remapped === null) {
        const condBlocker = validateConditionForCategory(condition, conditionIds);
        if (condBlocker) blockers.push(condBlocker);
      } else if (remapped !== condition) {
        console.log(
          `[flipdesk-ebay] condition "${condition}" resolved to "${remapped}" ` +
            `for category ${categoryId}`,
        );
        condition = remapped;
      }
    } catch (err) {
      console.warn(
        "[flipdesk-ebay] condition-policy validate (non-blocking):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Quantity: default 1 for single-item resellers; respect the column when set.
  const quantity = listing?.quantity && listing.quantity > 0 ? listing.quantity : 1;
  const bestOfferEnabled = listing?.best_offer_enabled === true;

  // US-562 / US-2405: the best-offer auto-accept/decline thresholds are the
  // seller's own numbers, read straight off the listing. NOTHING is derived
  // from the comp band any more — a NULL column means the seller left the box
  // blank, so no threshold is sent and every offer waits for them. The helper
  // clamps to eBay's constraints (decline < accept < price) and nulls anything
  // invalid.
  let bestOfferAutoAccept: string | null = null;
  let bestOfferAutoDecline: string | null = null;
  if (bestOfferEnabled) {
    const priceCents = priceNumber ? Math.round(priceNumber * 100) : 0;
    // US-2944: eBay's auto-accept fires the instant a bid lands and knows
    // nothing about the rule's margin floor, so a stored threshold BELOW an
    // active rule's number is a hole — an offer in the gap gets taken at a
    // price the rule would have refused. Raise it here, before it is pushed.
    //
    // One direction only. A blank threshold stays blank (US-2405), and a
    // seller stricter than their own rule is left alone.
    const activeRule = await loadActiveOfferRule(userId);
    const reconciled = reconcileAutoAcceptWithRule({
      priceCents,
      sellerAcceptCents: listing?.best_offer_auto_accept_cents ?? null,
      ruleAcceptAtPct: activeRule?.acceptAtPct ?? null,
      ruleMarginFloorPct: activeRule?.marginFloorPct ?? 10,
      itemCostCents: await acquiredCostCentsForListing(userId, listing?.id ?? null),
    });
    const thresholds = resolveBestOfferThresholds({
      priceCents,
      acceptCents: reconciled.autoAcceptCents,
      declineCents: listing?.best_offer_auto_decline_cents ?? null,
    });
    bestOfferAutoAccept =
      thresholds.autoAcceptCents != null
        ? centsToMoneyString(thresholds.autoAcceptCents)
        : null;
    bestOfferAutoDecline =
      thresholds.autoDeclineCents != null
        ? centsToMoneyString(thresholds.autoDeclineCents)
        : null;
  }

  // US-568: resolve the listing format + auction terms. Auction prices are
  // stored in cents; convert to eBay money strings. A draft marked 'auction'
  // without a start price falls back to the listing price as the starting bid.
  const format: "FIXED_PRICE" | "AUCTION" =
    listing?.listing_format === "auction" ? "AUCTION" : "FIXED_PRICE";
  const centsToStr = (c: number | null | undefined): string | null =>
    typeof c === "number" && c > 0 ? centsToMoneyString(c) : null;
  const auctionStartPrice =
    format === "AUCTION"
      ? (centsToStr(listing?.auction_start_price_cents) ??
        (priceNumber ? priceNumber.toFixed(2) : null))
      : null;
  const auctionReservePrice =
    format === "AUCTION"
      ? centsToStr(listing?.auction_reserve_price_cents)
      : null;
  const auctionBuyItNowPrice =
    format === "AUCTION"
      ? centsToStr(listing?.auction_buy_it_now_price_cents)
      : null;
  const auctionDuration =
    format === "AUCTION"
      ? (listing?.auction_duration?.trim() || "DAYS_7")
      : "GTC";
  // US-568: variation matrix — keep only non-empty, well-formed entries.
  const variations = normalizeVariations(listing?.variations ?? null);

  const summary: PublishContextOk["summary"] = {
    title,
    description,
    priceValue: priceNumber ? priceNumber.toFixed(2) : "0.00",
    currency: "USD",
    condition,
    conditionDescription,
    categoryId: categoryId ?? "",
    // US-828: send the value-validated map (near-misses normalized, invalid
    // SELECTION_ONLY values omitted), not the raw persisted aspectMap.
    aspects: sanitizedAspects,
    quantity,
    bestOfferEnabled,
    bestOfferAutoAccept,
    bestOfferAutoDecline,
    format,
    auctionStartPrice,
    auctionReservePrice,
    auctionBuyItNowPrice,
    auctionDuration,
    variations,
    // 00432: resolve the ad rate — a legacy opt-out wins, else the per-listing
    // override, else the seller default (off by default). Rate: listing choice →
    // seller default → category suggestion. The composer surfaces the same
    // suggestion so the resolution stays transparent + adjustable.
    promotedAdRate: resolvePublishAdRate({
      optOut: listing?.promo_opt_out,
      promoteOverride: listing?.promote_override,
      defaultPromote: owner?.promote_listings_by_default ?? false,
      chosenRatePct: listing?.promo_rate_pct,
      defaultRatePct: owner?.default_promo_rate_pct,
      categoryId,
    }),
    // Mode: per-listing choice → seller default → cps.
    promotedMode: promoModeFor(listing?.promo_mode ?? owner?.default_promo_mode),
  };

  return {
    ok: true,
    // US-1507: the connection publish resolved to (see the conn lookup above).
    connectionId: conn.id as string,
    item,
    listing,
    photos: photosWithUrl,
    policies,
    blockers,
    // US-1890 title-quality warnings + US-1896 picture-standards (zoom) warnings.
    warnings: [...titleWarnings, ...photoWarnings],
    // US-1896: hero-thumbnail reorder nudge ("your search thumbnail is a tag
    // shot — drag a full front view first"), or null when the hero is fine.
    photoNudge,
    recommendedCoverage,
    aspectDiagnostics,
    sku,
    summary,
    // US-1897: structured inputs for the Listing Quality Score. Deliberately
    // raw signals, not a score — the score is computed on the validate surface
    // so the publish hot path pays nothing for it.
    qualitySignals: {
      titlePolicyViolations: qsTitlePolicyViolations,
      titleWarnings: [...titleWarnings],
      photoBlockers: qsPhotoBlockers,
      photoWarnings: qsPhotoWarnings,
      photoCount: photosWithUrl.length,
      categoryLeafStatus: qsCategoryLeafStatus,
      categoryWasSuggested,
      requiredMissing: [...requiredMissing],
    },
  };
}
