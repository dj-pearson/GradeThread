// eBay routes: managing live listings: price, quantity, sale, revise, end, validate and offer/inventory cleanup.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { trimTitleToLimit } from "../lib/title-trim.ts";
// US-2678: the price component scores against REALIZED sales, never against
// active asking prices, which are by definition the ones nobody bought.
import { getRealizedComps } from "../lib/sold-comps.ts";
import { filterEbayPhotos } from "../lib/item-photo-storage.ts";
import { reverseColumnAspects } from "../lib/aspect-registry.ts";
import type { RegistryItem } from "../lib/aspect-registry.ts";
import {
  applyMeasurementsBlock,
  hasCalibratedMeasurements,
  type Measurements,
  resolveMeasurementAspects,
} from "../lib/measurements.ts";
import {
  type AspectSourceMap,
  mergeSources,
  requiredMissingAspects,
  sourcesFor,
} from "../lib/aspect-provenance.ts";
import { normalizeAspectMap, reconcilePublishAspects } from "../lib/aspect-reconcile.ts";
import { healCustomValueRejection } from "../lib/ebay-size-enforcement.ts";
import {
  createOrReplaceInventoryItem,
  getCategoryAspects,
  getItemConditionPolicies,
  getMarketplaceId,
  isEbayConfigured,
  listOffersForSku,
  getOffer,
  getPublishedListingId,
  getInventoryItemAspects,
  createOrReplaceInventoryItemGroup,
  publishOfferByInventoryItemGroup,
  updateOfferFields,
  bulkUpdatePriceQuantity,
  EBAY_BULK_MAX,
  withdrawOffer,
  withdrawByInventoryItemGroup,
  deleteOffer,
  deleteInventoryItem,
  isAlreadyDeletedError,
  isOfferAlreadyEndedError,
  isNoEbayConnectionError,
} from "../lib/ebay-client.ts";
import { resolveEbayCondition, conditionDescriptionConsistency } from "../lib/publish-preflight.ts";
// US-1897: Listing Quality Score (validate surface only — see buildQualityScore).
import {
  computeListingQualityScore,
  type ListingQualityScore,
} from "../lib/listing-quality-score.ts";
import { loadFulfillmentSignals } from "../lib/business-policy-signals.ts";
import {
  EBAY_PUBLISH_GENERIC_FIX,
  ebayFailureDetail,
  resolveEbayFix,
} from "../lib/ebay-error-map.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  deriveListingOrigin,
  ebayOriginWriteLock,
  validateEbayOriginEdit,
} from "../lib/sync-precedence.ts";
// US-2166: the shared platform-agnostic lifecycle core.
import {
  applyListingPrice,
  originLockResponse,
  type OwnedListingRow,
} from "../lib/listing-lifecycle.ts";
// US-2166 (AC5): the bulk-edit handler now lives with the other
// platform-agnostic listing operations; this file only forwards to it.
import { bulkEditListingsHandler } from "./flipdesk-listings.ts";
import { resyncItemListedStatus } from "../lib/active-listings.ts";
import {
  buildPriceQtyRequest,
  chunk,
  normalizeBulkEntry,
  type PriceQtyUpdate,
} from "../lib/ebay-bulk.ts";
// US-1999: one derivation rule, and the published SKU wins over item.sku.
import { resolveInventorySku } from "../lib/ebay-sku.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import {
  clampMarkdownPct,
  createMarkdownSale,
  endMarkdownSale,
  updateMarkdownSale,
} from "../lib/ebay-marketing.ts";
import {
  allowedAspectsFromSpec,
  applyGradeListingPromotion,
  type AspectSpecRaw,
  deriveAspectsFromItem,
  type EbayEnv,
  ebayPublicPhotoUrl,
  forceColumnAspects,
  type ListingVariations,
  loadListingOwned,
  mapEbayCondition,
  type PublishContextOk,
  type PublishItem,
  shoeScaleOf,
  toEbayImageUrls,
  toRegistryAspects,
  variantSku,
} from "./flipdesk-ebay-shared.ts";
import { assemblePublishContext } from "./flipdesk-ebay-publish.ts";

export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// US-1978 (AC2): DELETE /offers/:offerId — remove a STALE UNPUBLISHED offer.
//
// Abandoned drafts leave offer records behind on eBay. They are invisible to the
// seller, they block SKU reuse, and there was no way to clear them.
//
// THE GUARD IS THE STORY. deleteOffer is not withdrawOffer: withdraw ends a live
// listing and keeps the offer; DELETE destroys the record, and on a PUBLISHED
// offer eBay ends the live listing as a side effect. So a careless delete silently
// takes down a listing the seller is actively selling — with no undo and no
// "ended" reconciliation locally, which is strictly worse than the US-1506 oversell
// case (there the row was wrong; here the listing is gone).
//
// Hence: we ask eBay for the offer's CURRENT state and refuse if it is live. We do
// not trust our own listings row for this — it can be stale (that is the entire
// premise of the sync path), and "our DB thinks it's unpublished" is not evidence
// about what is live on eBay right now.
flipdeskEbayRoutes.delete("/offers/:offerId", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const offerId = c.req.param("offerId");

  // US-268: offerId is attacker-controlled. Prove this tenant owns the listing
  // carrying it before touching eBay; a foreign offer gets the same 404 as one
  // that doesn't exist.
  const { data: listing, error: lErr } = await supabaseAdmin
    .from("listings")
    .select("id, marketplace_connection_id, listing_status")
    .eq("user_id", ownerId)
    .eq("platform_offer_id", offerId)
    .maybeSingle();
  if (lErr) {
    console.error("[ebay.offers.delete] listing lookup failed:", lErr.message);
    return c.json({ error: "Couldn't look up that offer." }, 500);
  }
  if (!listing) return c.json({ error: "Offer not found." }, 404);

  const connectionId = listing.marketplace_connection_id ?? undefined;

  // Liveness check against eBay itself, not our row.
  let live = false;
  try {
    const remote = await getOffer(ownerId, offerId, connectionId);
    live = Boolean(remote?.listingId);
  } catch (err) {
    if (isAlreadyDeletedError(err)) {
      // Already gone on eBay — the desired end state. Reconcile, don't error.
      return c.json({ ok: true, already_gone: true });
    }
    return failSafe(c, 502, "Couldn't read that offer from eBay.", err, "ebay.offers.delete.read");
  }
  if (live) {
    return c.json(
      {
        error:
          "That offer is a LIVE listing. Deleting it would take the listing down " +
          "with no way back. End the listing first, then delete the offer.",
      },
      409,
    );
  }

  try {
    await deleteOffer(ownerId, offerId, connectionId);
  } catch (err) {
    if (!isAlreadyDeletedError(err)) {
      return failSafe(c, 502, "eBay rejected the offer delete.", err, "ebay.offers.delete");
    }
  }

  await writeAuditLog(c, {
    action: "ebay.offer.delete",
    targetType: "ebay_offer",
    targetId: offerId,
    details: { listing_id: listing.id, listing_status: listing.listing_status },
  });
  return c.json({ ok: true });
});

// US-1978 (AC2): DELETE /inventory-items/:sku — remove a STALE UNPUBLISHED SKU.
//
// Same hazard, one level up: an inventory item with a live offer must never be
// deleted. eBay's own behaviour here is not something to rely on (it may refuse,
// it may cascade), so we check for ANY live offer on the SKU and refuse first.
flipdeskEbayRoutes.delete("/inventory-items/:sku", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const sku = c.req.param("sku");

  // US-268: the SKU is attacker-controlled. It must belong to one of THIS tenant's
  // inventory items.
  const { data: item, error: iErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("user_id", ownerId)
    .eq("sku", sku)
    .maybeSingle();
  if (iErr) {
    console.error("[ebay.items.delete] item lookup failed:", iErr.message);
    return c.json({ error: "Couldn't look up that SKU." }, 500);
  }
  if (!item) return c.json({ error: "SKU not found." }, 404);

  let offers: Awaited<ReturnType<typeof listOffersForSku>>;
  try {
    offers = await listOffersForSku(ownerId, sku);
  } catch (err) {
    if (isAlreadyDeletedError(err)) {
      return c.json({ ok: true, already_gone: true });
    }
    return failSafe(c, 502, "Couldn't read that SKU's offers from eBay.", err, "ebay.items.delete.read");
  }

  const liveOffers = offers.filter((o) => o.listingId);
  if (liveOffers.length > 0) {
    return c.json(
      {
        error:
          `That SKU still has ${liveOffers.length} live listing(s) on eBay. ` +
          "End them first — deleting the SKU now would take them down with no way back.",
        live_listing_ids: liveOffers.map((o) => o.listingId),
      },
      409,
    );
  }

  // Unpublished offers must go before the SKU can — eBay rejects a delete on a SKU
  // that still has offers attached. Every one of these is proven non-live above.
  for (const offer of offers) {
    try {
      await deleteOffer(ownerId, offer.offerId);
    } catch (err) {
      if (!isAlreadyDeletedError(err)) {
        return failSafe(
          c, 502,
          "Couldn't clear that SKU's stale offers.", err, "ebay.items.delete.offers",
        );
      }
    }
  }

  try {
    await deleteInventoryItem(ownerId, sku);
  } catch (err) {
    if (!isAlreadyDeletedError(err)) {
      return failSafe(c, 502, "eBay rejected the SKU delete.", err, "ebay.items.delete");
    }
  }

  await writeAuditLog(c, {
    action: "ebay.inventory_item.delete",
    targetType: "ebay_sku",
    targetId: sku,
    details: { item_id: item.id, stale_offers_removed: offers.length },
  });
  return c.json({ ok: true, stale_offers_removed: offers.length });
});

// ── Publish flow (Week 3) ──────────────────────────────────────────
//
// /listings/validate runs every pre-flight check WITHOUT touching eBay.
// /listings/push runs the same check, then:
//   1. createOrReplaceInventoryItem  (PUT, idempotent)
//   2. createOffer                   (POST, returns offerId)
//   3. publishOffer                  (POST, returns listingId)
// On success the listings + inventory_items rows are updated to reflect the
// live state. createOffer is idempotent on SKU via listOffersForSku fallback.

// ── Manage live listings (Week 4) ──────────────────────────────────
// Update price (POST .../:id/price body: { price }) and end (DELETE
// .../:id) — both look up platform_offer_id from the local listings row
// and call the Sell API. If the local row has no platform_offer_id (e.g.
// the user manually marked an item "listed" via MarkListedDialog), the
// route returns 409 and the UI falls back to local-only.

// US-2166: this path now DELEGATES to the shared lifecycle core rather than
// keeping its own copy. It stays mounted because shipped iOS, Android and
// browser-extension builds call it and cannot be redeployed — but a second
// implementation of a money-touching operation is how a fix lands in one and
// not the other, and these two had already drifted: the shared core reports
// honestly when the marketplace accepted a price our copy then failed to save,
// while this route used to ignore that write error entirely.
//
// Behaviour the delegation IMPROVES for callers of this path, all additive:
//   • the origin gate reads the row's real platform instead of a hardcoded
//     "ebay" (a Shopify row was being told eBay owns its price),
//   • a never-published draft records its price instead of 409-ing on a missing
//     offer id,
//   • a marketplace-accepted-but-locally-unsaved write is reported, not hidden.
// The success body gains `pushed` and keeps every field it had, so an older
// client that ignores the new key is unaffected.
flipdeskEbayRoutes.post("/listings/:id/price", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: { price?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return c.json({ error: "price must be a positive number" }, 400);
  }

  const res = await applyListingPrice(userId, listingId, price);
  if (!res.ok) {
    return c.json(
      res.lockedFields
        ? { error: res.error, locked_fields: res.lockedFields }
        : { error: res.error },
      res.status,
    );
  }
  return c.json({
    ok: true,
    listing_id: listingId,
    price: res.price,
    pushed: res.pushed,
  });
});

// ── Bulk price / quantity update (US-1046 clean surface) ────────────
// POST /listings/bulk-price-quantity — body { updates: [{ listing_id, price?,
// quantity? }] }. Updates up to 25 offers per eBay call (chunked), tenant-scoped,
// per-item success/failure reported, local listings rows updated for successes.
flipdeskEbayRoutes.post("/listings/bulk-price-quantity", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  // Bulk multi-listing actions are a Pro+ feature (US-208).
  const gate = await requireFlipdesk(c, { feature: "bulkActions", userId });
  if (gate) return gate;
  let body: { updates?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rawUpdates = Array.isArray(body.updates) ? body.updates : [];
  if (rawUpdates.length === 0) return c.json({ error: "updates required" }, 400);
  if (rawUpdates.length > 500) {
    return c.json({ error: "Too many updates (max 500)." }, 400);
  }

  const outcome = await applyBulkPriceQuantity(
    userId,
    rawUpdates as Array<Record<string, unknown>>,
  );
  if (!outcome.ok) return c.json({ error: outcome.error }, 400);
  const { results, listingIds, succeeded } = outcome;

  await writeAuditLog(c, {
    action: "ebay.bulk_price_quantity",
    targetType: "listings",
    details: { requested: listingIds.length, succeeded },
  });
  return c.json({ ok: true, results, succeeded, total: results.length });
});

type BulkPriceQtyResult = {
  listing_id: string;
  ok: boolean;
  error?: string;
  reason?: "floor" | "not_live" | "price_changed" | "origin_locked" | "local_write";
  floor?: number;
};

/**
 * The body of POST /listings/bulk-price-quantity, minus the plan gate and the
 * audit write, so it can be driven with a stand-in eBay. `push` is eBay's
 * bulk_update_price_quantity.
 *
 * Every refusal happens before any eBay call, and names its reason:
 *  - floor: the new price is under the seller's floor on the garment. The same
 *    shape /listings/bulk-price returns, so one client reads both. This used to
 *    live only in the browser, so any other client could price through it.
 *  - not_live: sold, ended or not an eBay row. A price on it can't change.
 *  - price_changed: the caller sent the price it saw and the row moved since.
 *  - origin_locked: an eBay-originated listing, which eBay owns (US-1976).
 */
export async function applyBulkPriceQuantity(
  userId: string,
  rawUpdates: Array<Record<string, unknown>>,
  push: typeof bulkUpdatePriceQuantity = (user, requests) =>
    bulkUpdatePriceQuantity(user, requests),
): Promise<
  | { ok: false; error: string }
  | { ok: true; results: BulkPriceQtyResult[]; listingIds: string[]; succeeded: number }
> {
  // Normalize + validate. price>0, quantity>=0 integer; at least one present.
  const wanted = new Map<
    string,
    { price?: number; quantity?: number; expectedPrice?: number }
  >();
  for (const u of rawUpdates) {
    if (!u || typeof u.listing_id !== "string") continue;
    const priceNum = Number(u.price);
    const qtyNum = Number(u.quantity);
    const expNum = Number(u.expected_price);
    const price = u.price != null && Number.isFinite(priceNum) && priceNum > 0
      ? priceNum
      : undefined;
    const quantity = u.quantity != null && Number.isInteger(qtyNum) && qtyNum >= 0
      ? qtyNum
      : undefined;
    const expectedPrice = u.expected_price != null && Number.isFinite(expNum)
      ? expNum
      : undefined;
    if (price === undefined && quantity === undefined) continue;
    wanted.set(u.listing_id, { price, quantity, expectedPrice });
  }
  const listingIds = [...wanted.keys()];
  if (listingIds.length === 0) return { ok: false, error: "No valid updates." };

  // Load owned listings with their SKU + offer id (tenant-scoped, US-268).
  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform, listing_status, listing_price, listing_origin, platform_listing_id, " +
        "batch_id, synced_to_ebay_at, platform_offer_id, inventory_item_id, inventory_sku, " +
        "inventory_items!inner(user_id, sku, floor_price)",
    )
    .in("id", listingIds)
    .eq("inventory_items.user_id", userId);
  const owned = (rows ?? []) as unknown as Array<{
    id: string;
    platform: string | null;
    listing_status: string | null;
    listing_price: number | null;
    listing_origin: string | null;
    platform_listing_id: string | null;
    batch_id: string | null;
    synced_to_ebay_at: string | null;
    platform_offer_id: string | null;
    inventory_item_id: string | null;
    inventory_sku: string | null;
    inventory_items: { user_id: string; sku: string | null; floor_price: number | null };
  }>;

  const results: BulkPriceQtyResult[] = [];
  const items: Array<
    PriceQtyUpdate & { listingId: string; itemId: string | null }
  > = [];
  for (const lid of listingIds) {
    const row = owned.find((r) => r.id === lid);
    const want = wanted.get(lid)!;
    if (!row) {
      results.push({ listing_id: lid, ok: false, error: "Listing not found" });
      continue;
    }
    if (row.platform !== "ebay" || row.listing_status !== "active") {
      results.push({
        listing_id: lid,
        ok: false,
        reason: "not_live",
        error: "This listing is not live on eBay, so it was not changed.",
      });
      continue;
    }
    const lockedFields = [
      ...(want.price != null ? ["listing_price"] : []),
      ...(want.quantity != null ? ["quantity"] : []),
    ];
    const lock = originLockResponse(row as unknown as OwnedListingRow, lockedFields);
    if (lock.locked) {
      results.push({
        listing_id: lid,
        ok: false,
        reason: "origin_locked",
        error: String(lock.body.error),
      });
      continue;
    }
    if (
      want.price != null &&
      want.expectedPrice != null &&
      typeof row.listing_price === "number" &&
      Math.round(row.listing_price * 100) !== Math.round(want.expectedPrice * 100)
    ) {
      results.push({
        listing_id: lid,
        ok: false,
        reason: "price_changed",
        error: "Price changed since you loaded this page.",
      });
      continue;
    }
    const floor = row.inventory_items.floor_price;
    if (
      want.price != null &&
      typeof floor === "number" &&
      Number.isFinite(floor) &&
      Math.round(want.price * 100) < Math.round(floor * 100)
    ) {
      results.push({
        listing_id: lid,
        ok: false,
        reason: "floor",
        floor,
        error: `That price goes below this item's floor of $${floor.toFixed(2)}.`,
      });
      continue;
    }
    const offerId = row.platform_offer_id;
    // US-1999: bulk reprice addresses the Inventory API by SKU, so it uses the
    // PINNED publish-time value; the item's current sku is only a pre-00477
    // fallback. Both being null still means "no eBay SKU" (a draft).
    const sku = row.inventory_sku ?? row.inventory_items.sku;
    if (!offerId || !sku) {
      results.push({ listing_id: lid, ok: false, error: "Listing has no eBay offer/SKU" });
      continue;
    }
    items.push({
      listingId: lid,
      itemId: row.inventory_item_id,
      sku,
      offerId,
      priceValue: want.price,
      quantity: want.quantity,
    });
  }

  const pushedOk = new Set<string>();
  for (const batch of chunk(items, EBAY_BULK_MAX)) {
    let entries: Array<Record<string, unknown>>;
    try {
      entries = await push(
        userId,
        batch.map((b) => buildPriceQtyRequest(b)),
      ) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const b of batch) {
        results.push({ listing_id: b.listingId, ok: false, error: msg.slice(0, 200) });
      }
      continue;
    }
    batch.forEach((b, i) => {
      const norm = normalizeBulkEntry({ offerId: b.offerId, ...(entries[i] ?? {}) }, b.offerId);
      if (norm.ok) pushedOk.add(b.listingId);
      else results.push({ listing_id: b.listingId, ok: false, error: norm.error });
    });
  }

  // Persist local rows for the successes. eBay already has the new values, so
  // a failed local write is still reported: the seller's copy is behind.
  for (const b of items) {
    if (!pushedOk.has(b.listingId)) continue;
    const patch: Record<string, unknown> = {};
    if (b.priceValue != null) {
      patch.listing_price = b.priceValue;
      // A person chose this number, so a rule that skips hand-set prices
      // leaves it alone.
      patch.price_set_by = "seller";
    }
    if (b.quantity != null) patch.quantity = b.quantity;
    if (Object.keys(patch).length > 0) {
      const { error: localErr } = await supabaseAdmin
        .from("listings")
        .update(patch as never)
        .eq("id", b.listingId)
        .eq("user_id", userId);
      if (localErr) {
        console.error("[flipdesk-ebay] bulk-price-quantity local write failed:", localErr.message);
        results.push({
          listing_id: b.listingId,
          ok: false,
          reason: "local_write",
          error: "Live on eBay, but our copy did not save. It will correct on the next sync.",
        });
        continue;
      }
    }
    results.push({ listing_id: b.listingId, ok: true });
    // US-1504: mirror a successful reprice onto the item's target_price so the
    // canvas "not pushed to eBay" badge stays truthful (see the single-price
    // handler). Only when the price actually changed.
    if (b.priceValue != null && b.itemId) {
      await supabaseAdmin
        .from("inventory_items")
        .update({ target_price: b.priceValue })
        .eq("id", b.itemId)
        .eq("user_id", userId);
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return { ok: true, results, listingIds, succeeded };
}

// ── Bulk-edit live listings (US-1292) ───────────────────────────────
// US-2166 (AC5): the handler MOVED to routes/flipdesk-listings.ts. It was
// always adapter-driven and never eBay-specific — only its mount point was
// wrong, which is exactly what the story called out. This path stays registered
// because shipped iOS, Android and browser-extension builds call it and cannot
// be redeployed; it forwards rather than keeping a second copy.
flipdeskEbayRoutes.post("/listings/bulk-edit", (c) => bulkEditListingsHandler(c));


// ── Markdown / Sale events (US-1045) ────────────────────────────────
// POST /listings/:id/sale — start an eBay markdown Sale (strike-through price +
// watcher notification) instead of a silent price revise. DELETE ends it and
// restores the original price (markdown is an overlay). The promotion id is
// stored in listings.platform_fields so we can end/reconcile it later.

flipdeskEbayRoutes.post("/listings/:id/sale", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  let body: { percent_off?: unknown; end_date?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const percentOff = Number(body.percent_off);
  if (!Number.isFinite(percentOff) || percentOff <= 0) {
    return c.json({ error: "percent_off must be a positive number" }, 400);
  }
  const endDate = typeof body.end_date === "string" ? body.end_date : undefined;

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);
  if (!row.listing.platform_listing_id) {
    return c.json(
      { error: "This listing has no eBay listing id. Sync or republish first." },
      409,
    );
  }

  // If a Sale already exists on this listing, update it in place (PUT) so we
  // don't orphan the old promotion on eBay and watchers keep the same Sale;
  // otherwise create a fresh one.
  const { data: cur } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  const existingPf =
    ((cur as { platform_fields?: Record<string, unknown> } | null)
      ?.platform_fields) ?? {};
  const existingPromotionId =
    typeof existingPf.markdown_promotion_id === "string"
      ? existingPf.markdown_promotion_id
      : null;

  let promotionId: string | null;
  try {
    if (existingPromotionId) {
      await updateMarkdownSale(userId, existingPromotionId, {
        ebayListingId: row.listing.platform_listing_id,
        percentOff,
        endDate,
      });
      promotionId = existingPromotionId;
    } else {
      promotionId = await createMarkdownSale(userId, {
        ebayListingId: row.listing.platform_listing_id,
        percentOff,
        endDate,
      });
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the Sale event.", err, "ebay.markdown.create");
  }

  const pf = {
    ...existingPf,
    markdown_promotion_id: promotionId,
    markdown_pct: clampMarkdownPct(percentOff),
  };
  await supabaseAdmin
    .from("listings")
    .update({ platform_fields: pf } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: existingPromotionId ? "ebay.markdown.update" : "ebay.markdown.start",
    targetType: "listing",
    targetId: listingId,
    details: { promotion_id: promotionId, percent_off: percentOff },
  });
  return c.json({
    ok: true,
    listing_id: listingId,
    promotion_id: promotionId,
    updated: Boolean(existingPromotionId),
  });
});

flipdeskEbayRoutes.delete("/listings/:id/sale", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);

  const { data: cur } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  const pf = ((cur as { platform_fields?: Record<string, unknown> } | null)
    ?.platform_fields) ?? {};
  const promotionId = typeof pf.markdown_promotion_id === "string"
    ? pf.markdown_promotion_id
    : null;
  if (!promotionId) {
    return c.json({ error: "No active Sale on this listing." }, 409);
  }

  try {
    await endMarkdownSale(userId, promotionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A 404 (already ended/deleted) is fine — fall through to clear local state.
    if (!/\(404\)|not found/i.test(msg)) {
      return failSafe(c, 502, "eBay rejected ending the Sale.", err, "ebay.markdown.end");
    }
  }

  delete pf.markdown_promotion_id;
  delete pf.markdown_pct;
  await supabaseAdmin
    .from("listings")
    .update({ platform_fields: pf } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.markdown.end",
    targetType: "listing",
    targetId: listingId,
    details: { promotion_id: promotionId },
  });
  return c.json({ ok: true, listing_id: listingId });
});

// US-1079: record a failed outbound push on the listing, reusing the publish
// path's publish_error/publish_failed_at columns so the UI can surface
// "last failed: X" on reload and offer a retry. Stores a short, user-facing
// message (mapped from eBay's structured error ids when available), never the
// raw eBay blob. Ownership of `listingId` is already verified by the caller
// (loadListingOwned), so updating by id here is tenant-safe.
async function persistReviseFailure(
  listingId: string,
  err: unknown,
): Promise<void> {
  try {
    const msg = resolveEbayFix(err, EBAY_PUBLISH_GENERIC_FIX).message;
    await supabaseAdmin
      .from("listings")
      .update({
        publish_error: msg.slice(0, 1000),
        publish_failed_at: new Date().toISOString(),
      })
      .eq("id", listingId);
  } catch (logErr) {
    console.error(
      "[flipdesk-ebay] could not persist revise failure:",
      logErr,
    );
  }
}

// US-1081/US-1079: a successful push re-asserts GradeThread's values onto eBay,
// so any recorded eBay-drift marker is resolved — clear it so the "eBay differs"
// indicator disappears without waiting for the next inbound sync. Also clears any
// prior push failure (publish_error/publish_failed_at) so the retry banner goes
// away once the push succeeds.
//
// Lifted out of the offer path in US-2395 so the group path clears the SAME
// state. A revise that succeeded through one mechanism and left the drift marker
// standing because it took the other branch would show "eBay differs" on a
// listing that no longer does.
//
// US-2684: `restocked` clears the out-of-stock marker too. The marker is written
// by the inbound pull and only ON A CHANGE, so nothing would have rewritten it
// until eBay's next differing answer — leaving the "nobody can buy this" banner
// standing over a listing the seller had just put back in stock, for up to the
// full sync interval. The banner is the whole mechanism here; one that lies
// after the fix is worse than no banner, because the seller stops believing the
// next one. Only the out-of-stock reason is cleared: an `inactive` verdict
// (eBay took the listing down) is not something a quantity push resolves.
async function clearReviseDrift(
  listingId: string,
  opts: { restocked?: boolean } = {},
): Promise<void> {
  const { data: cur } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  const pf = ((cur as { platform_fields?: Record<string, unknown> } | null)
    ?.platform_fields) ?? {};
  const update: Record<string, unknown> = {
    publish_error: null,
    publish_failed_at: null,
  };
  if ((pf as { sync_drift?: unknown }).sync_drift) {
    delete (pf as { sync_drift?: unknown }).sync_drift;
    update.platform_fields = pf;
  }
  const state = (pf as { ebay_state?: { reason?: string } }).ebay_state;
  if (opts.restocked && state?.reason === "out_of_stock") {
    delete (pf as { ebay_state?: unknown }).ebay_state;
    update.platform_fields = pf;
  }
  await supabaseAdmin
    .from("listings")
    .update(update as never)
    .eq("id", listingId);
}

// Revises a live listing — title / description / price / quantity / photo order.
// Photos and aspects flow through the inventory_item PUT (which is sourced from
// current local state), so editing a photo via the photo manager and then
// hitting revise with `photos: true` syncs the new image set + order to eBay.
//
// IMPORTANT (US-310/eBay): listings created through the Sell Inventory API
// CANNOT be edited on eBay's own site ("Inventory-based listing management is
// not currently supported by this tool"). This endpoint is the supported way
// to push edits back — including a photo reorder with no other change.
// US-2404: the per-listing revise, extracted from POST /listings/:id/revise so
// the bulk route can run the SAME code rather than a second copy of it. A bulk
// action whose refusals drift from the single-item ones is how a seller ends up
// told 40 listings were pushed when eBay refused 12.
//
// It returns a { status, body } pair instead of a Response because it is called
// once per row by the bulk handler; the single-listing route hands the pair
// straight to c.json and is otherwise unchanged.
// US-2404: the per-request cap on a bulk resubmit. Lower than the 100 that
// /bulk-price allows, because a revise is several eBay API calls per listing
// rather than one, and the request has to finish inside a gateway timeout. The
// client chunks a larger selection into requests of this size and shows progress.
const MAX_BULK_REVISE_ITEMS = 25;

interface ReviseOnePatch {
  title?: string;
  description?: string;
  listingPrice?: number;
  quantity?: number;
  syncPhotos?: boolean;
  resyncFields?: boolean;
}

interface ReviseOneResult {
  status: 200 | 400 | 403 | 404 | 409 | 422 | 502 | 503;
  body: Record<string, unknown>;
}

function jsonResult(
  body: Record<string, unknown>,
  status: ReviseOneResult["status"] = 200,
): ReviseOneResult {
  return { body, status };
}

async function reviseOneListing(
  listingId: string,
  userId: string,
  patch: ReviseOnePatch,
): Promise<ReviseOneResult> {
  const nextTitle = patch.title;
  const nextDesc = patch.description;
  const nextPrice = patch.listingPrice;
  const nextQty = patch.quantity;
  const hasTitle = nextTitle !== undefined;
  const hasDesc = nextDesc !== undefined;
  const hasPrice = nextPrice !== undefined;
  const hasQty = nextQty !== undefined;
  const syncPhotos = patch.syncPhotos === true;
  const resyncFields = patch.resyncFields === true;

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return jsonResult(row.error, row.status);

  // US-2166 DECISION (owner's call, 2026-07-31): revise is an eBay OPERATOR, not
  // a platform-agnostic lifecycle step, so it deliberately stays here rather
  // than moving alongside price and end. What "revise" means on eBay — item
  // aspects, leaf categories, markdown Sale overlays, inventory_item vs offer
  // field split — has no counterpart on the marketplaces the adapter covers.
  // Forcing it into a shared shape would produce an operation that is eBay's
  // everywhere except in name. This matches AC3, which already said the
  // aspects/markdown pieces stay eBay-side; AC1 listing revise alongside price
  // and end is resolved in AC3's favour.
  //
  // Being the eBay operator means SAYING SO. loadListingOwned does not filter by
  // platform, so a Shopify or Etsy listing id can reach this handler; before
  // this it would have gone on to call eBay's inventory/offer APIs with that
  // row's ids. Refuse it plainly and point at the route that does handle it.
  if ((row.listing.platform ?? "ebay") !== "ebay") {
    return jsonResult(
      {
        error:
          `This is a ${row.listing.platform} listing, and revise is an eBay-only operation. ` +
          "Change its price with the listing price endpoint, or edit it on that marketplace.",
        code: "not_an_ebay_listing",
      },
      409,
    );
  }

  // US-1080: eBay-originated listings are a read-only mirror in GradeThread —
  // eBay owns title/description/price/photos. Revising those here would be
  // overwritten on the next inbound sync, so reject the write server-side
  // (defense in depth behind the locked UI). Origin is derived from existing
  // signals until US-1077 persists listing_origin. The request maps title →
  // listing_title, description → listing_description, listing_price, and
  // photos → product imagery — all EBAY_OWNED_LISTING_FIELDS.
  const origin = deriveListingOrigin({
    // US-1976: consult the persisted marker first (parity with the /price + end
    // gates), falling back to the provenance signals until it backfills.
    listing_origin: row.listing.listing_origin,
    // US-2166: the row's own platform, not a literal.
    platform: row.listing.platform,
    platform_listing_id: row.listing.platform_listing_id,
    batch_id: row.listing.batch_id,
    synced_to_ebay_at: row.listing.synced_to_ebay_at,
  });
  if (origin === "ebay") {
    const requested = [
      hasTitle && "listing_title",
      hasDesc && "listing_description",
      hasPrice && "listing_price",
      hasQty && "quantity",
    ].filter((f): f is string => typeof f === "string");
    const { locked } = validateEbayOriginEdit(origin, requested);
    // US-1490: category/condition/specifics are eBay-owned too, so a resync of
    // them on an eBay-originated listing is just as unsafe as a title/price edit.
    if (locked.length > 0 || syncPhotos || resyncFields) {
      const extra = [
        syncPhotos ? "photos" : null,
        resyncFields ? "specifics" : null,
      ].filter((f): f is string => f !== null);
      return jsonResult(
        {
          error:
            "This listing was created on eBay, so eBay owns its title, price, description, and photos. Edit it on eBay — changes here would be overwritten on the next sync.",
          locked_fields: [...locked, ...extra],
        },
        409
      );
    }
  }

  // US-2395 AC1/AC2: which mechanism pushes this revision. Group FIRST, and
  // keyed on the PINNED inventory_sku, so a SKU rename cannot aim the revise at
  // a group that no longer exists. A variation listing has no offer id and never
  // will — eBay publishes it by inventory_item_group — which is why an
  // offer-first read of the same row concluded "no mechanism" and 409'd.
  const reviseStrategy = resolveReviseStrategy({
    variations: row.listing.variations ?? null,
    itemSku: row.listing.inventory_sku ?? null,
    platformOfferId: row.listing.platform_offer_id ?? null,
  });

  if (reviseStrategy.kind === "none") {
    return jsonResult(
      {
        error:
          "This listing has no eBay offer id. Sync from eBay or republish to enable edits.",
      },
      409
    );
  }

  // Acted on AFTER the shared assembly below rather than here: the group push
  // needs the same title, description, aspects, photos and condition the offer
  // path spends the next two hundred lines building, and a second copy of that
  // assembly is how the two paths would start disagreeing about what a revision
  // contains.
  const groupRevise = reviseStrategy.kind === "group";
  const offerId = reviseStrategy.kind === "offer" ? reviseStrategy.offerId : "";
  const itemId = row.listing.inventory_item_id;

  // Update local state first so the inventory_item PUT below reads the
  // canonical (post-edit) values. Any eBay error rolls back via the
  // user re-syncing; we keep local as the source of truth.
  const localUpdates: Record<string, unknown> = {};
  if (hasTitle) localUpdates.listing_title = nextTitle;
  if (hasDesc) localUpdates.listing_description = nextDesc;
  if (hasPrice) localUpdates.listing_price = nextPrice;
  if (hasQty) localUpdates.quantity = nextQty;
  // A photos-only revise has nothing to write locally — skip the no-op update
  // (an empty PATCH would error on PostgREST).
  if (Object.keys(localUpdates).length > 0) {
    await supabaseAdmin.from("listings").update(localUpdates).eq("id", listingId);
  }

  // US-1490: resolved eBay leaf category, lifted so the offer-side PUT below can
  // re-assert it on the live offer when a resync was requested (the category
  // lives on the offer, not the inventory item). Set inside the re-PUT branch.
  let reviseCategoryId: string | null = null;
  // US-1502: when a resync (re)asserts the grade, the promoted description (with
  // the "Cert #…" line) is lifted here so the offer-side PUT pushes it as the
  // live listingDescription too — otherwise a stored offer description would
  // shadow the product.description we just updated.
  let reviseGradeDesc: string | null = null;

  // Re-PUT the inventory_item when product fields changed (title / desc), a photo
  // sync was requested, OR a structured-field resync was requested (US-1490 —
  // category/condition/specifics). We send full state — photos, aspects, brand —
  // so any drift from the photo manager / category picker also syncs here.
  //
  // US-2395: `|| groupRevise` is load-bearing rather than tidy. A price-only or
  // quantity-only revise satisfies none of the first four conditions, so this
  // block is skipped — and the GROUP branch lives inside it. Without this the
  // request would fall through to the offer-side push at the end and call
  // updateOfferFields with the empty offerId a group listing resolves to. The
  // extra item and group PUTs a price-only group revise now performs are the
  // same idempotent ones publish sends, and the group is being re-published in
  // that path anyway.
  if (hasTitle || hasDesc || syncPhotos || resyncFields || groupRevise) {
    const { data: itemRow } = await supabaseAdmin
      .from("inventory_items")
      .select(
        "id, user_id, title, brand, size, color, material, style, item_category, attributes, sku, description, condition_notes, grade_value, grade_label, certificate_url, ebay_aspects, ebay_aspect_sources, ebay_category_id, measurements, ai_field_sources"
      )
      .eq("id", itemId)
      .maybeSingle();
    if (!itemRow || (itemRow as { user_id: string }).user_id !== userId) {
      return jsonResult({ error: "Item not found" }, 404);
    }
    const item = itemRow as {
      id: string;
      user_id: string;
      title: string | null;
      brand: string | null;
      size: string | null;
      color: string | null;
      material: string | null;
      style: string | null;
      item_category: string | null;
      attributes: Record<string, string | string[]> | null;
      sku: string | null;
      description: string | null;
      condition_notes: string | null;
      grade_value: number | null;
      grade_label: string | null;
      certificate_url: string | null;
      ebay_aspects: Record<string, string[]> | null;
      ebay_aspect_sources: Record<string, string> | null;
      ebay_category_id: string | null;
      measurements: Measurements;
    };

    // US-2593: the item's own title follows the listing title. `listings` and
    // `inventory_items` each carry a title and only the listing one ever moved,
    // so the Inventory tab of a synced Google Sheet (which reads
    // inventory_items.title) kept the name the item was created with while eBay
    // showed the corrected one. Enforced HERE as well as in the web composer so
    // a revise from iOS or Android carries the same rule — this is the eBay
    // path, so a per-platform cross-listing title can never reach the column.
    const revisedTitle = hasTitle ? (nextTitle as string).trim() : "";
    if (revisedTitle && revisedTitle !== (item.title ?? "").trim()) {
      await supabaseAdmin
        .from("inventory_items")
        .update({ title: revisedTitle })
        .eq("id", item.id)
        .eq("user_id", userId);
      item.title = revisedTitle;
    }

    // US-1088+: the structured columns (Brand/Size/Color/Material/Style) are the
    // source of truth for their eBay item specifics. eBay shows these from item
    // specifics, not the title — so any edit on the main listing must propagate,
    // overwriting the previously-pushed value (which otherwise lingers and shows
    // as <UNKNOWN>/stale to buyers). Rebuild the aspect map from the columns on
    // every revise, then persist it so the composer + next publish stay in sync.
    const { data: listingRow } = await supabaseAdmin
      .from("listings")
      .select(
        "platform_category_id, item_specifics_override, item_specifics_sources, ebay_condition, ebay_condition_description",
      )
      .eq("id", listingId)
      .maybeSingle();
    reviseCategoryId =
      (listingRow as { platform_category_id?: string | null } | null)
        ?.platform_category_id ?? item.ebay_category_id ?? null;
    // US-1505: legacy rows may be string-valued; coerce to string[] before
    // forceColumnAspects / the eBay re-PUT (a bare string would 400 eBay).
    const baseAspects: Record<string, string[]> = normalizeAspectMap(
      (listingRow as
        | { item_specifics_override?: Record<string, unknown> | null }
        | null)?.item_specifics_override ??
        (item.ebay_aspects as Record<string, unknown> | null),
    );
    // Pull the category's real aspect spec (cached) so synonyms / SELECTION_ONLY
    // validation match; degrade gracefully to the default column names on error.
    let reviseAspectList: AspectSpecRaw[] | null = null;
    if (reviseCategoryId) {
      try {
        const resp = await getCategoryAspects(reviseCategoryId);
        const raw = (resp.aspects as Record<string, unknown>).aspects;
        if (Array.isArray(raw)) reviseAspectList = raw as AspectSpecRaw[];
      } catch (err) {
        console.error("[flipdesk-ebay] revise aspect spec fetch failed:", err);
      }
    }
    // Reverse column sync (mirrors assemblePublishContext): fold MANUAL
    // specifics edits back into their columns before the columns are
    // re-asserted below — otherwise a Brand typed in a specifics editor is
    // clobbered by the stale column on every revise.
    {
      const overrideSources = (listingRow as {
        item_specifics_override?: Record<string, unknown> | null;
        item_specifics_sources?: Record<string, string> | null;
      } | null);
      const aspectSources = ((overrideSources?.item_specifics_override != null
        ? overrideSources.item_specifics_sources
        : item.ebay_aspect_sources) ?? {}) as Record<string, string | undefined>;
      const writeBack = reverseColumnAspects(
        item as unknown as RegistryItem,
        baseAspects,
        aspectSources,
        reviseAspectList ? toRegistryAspects(reviseAspectList) : null,
      );
      if (Object.keys(writeBack).length > 0) {
        Object.assign(item, writeBack);
        const { error: wbErr } = await supabaseAdmin
          .from("inventory_items")
          .update(writeBack as never)
          .eq("id", itemId);
        if (wbErr) {
          console.error(
            `[flipdesk-ebay] revise column write-back failed for ${itemId}: ${wbErr.message}`,
          );
        }
      }
    }
    const aspects = forceColumnAspects(
      item as unknown as RegistryItem,
      reviseAspectList,
      baseAspects,
    );
    // Gap-fill the aspects the columns don't own the same way publish does.
    // forceColumnAspects only re-asserts Brand/Size/Color/Material/Style; the
    // attribute- and inference-backed required specifics (Department, Size Type,
    // …) came from deriveAspectsFromItem on the publish path and had no
    // equivalent here — so a listing whose stored override was missing one could
    // be published (publish filled it) yet fail EVERY later revise with eBay's
    // "The item specific X is missing". Same resolver, same never-overwrite rule.
    const reviseDerivedKeys: string[] = [];
    if (reviseAspectList && reviseAspectList.length > 0) {
      const derived = deriveAspectsFromItem(
        item as unknown as PublishItem,
        reviseAspectList,
        aspects,
      );
      for (const [k, v] of Object.entries(derived)) {
        aspects[k] = v;
        reviseDerivedKeys.push(k);
      }
    }

    // US-1502/US-1503: on a structured resync, fold the CURRENT measurements +
    // grade into the aspect map + description BEFORE we persist/PUT so the live
    // listing, the persisted override, and the composer all agree. Idempotent:
    // resolveMeasurementAspects only fills free-text measurement aspects the
    // category exposes (never clobbering set values); applyMeasurementsBlock
    // replaces its own block; applyGradeListingPromotion force-overwrites the
    // grade specific + de-dupes the cert line. Result (with the "Cert #…" line)
    // is lifted to reviseGradeDesc so the inventory PUT + offer both push it.
    if (resyncFields) {
      const meas = item.measurements;
      let desc = (
        (hasDesc ? (nextDesc as string) : null) ??
        row.listing.listing_description ??
        item.description ??
        item.title ??
        ""
      ).trim();
      if (meas && Object.keys(meas).length > 0) {
        const measAspects = resolveMeasurementAspects(
          meas,
          allowedAspectsFromSpec(reviseAspectList ?? []),
          aspects,
          "in",
          // US-2796 AC3, same rule on the revise path: a revise that re-derived
          // measurement aspects would otherwise put the US-named aspect back.
          shoeScaleOf(item),
        );
        for (const [k, v] of Object.entries(measAspects)) aspects[k] = v;
        desc = applyMeasurementsBlock(desc, meas, "in", {
          calibrated: hasCalibratedMeasurements(
            (item as { ai_field_sources?: Record<string, unknown> | null })
              .ai_field_sources,
          ),
        });
      }
      // Run unconditionally: for ungraded items this is a no-op past the
      // off-eBay link strip, and the strip must reach EVERY revise so a legacy
      // linked credential block in a stored description can't ride a revise
      // back onto the live listing.
      desc = await applyGradeListingPromotion(item, aspects, desc, {
        force: true,
      });
      reviseGradeDesc = desc;
    }

    // Resolve + auto-correct the condition the same way the publish path does:
    // the seller's stored ebay_condition wins over the grade-derived default,
    // then it's reconciled against the category's allow-list so a revise re-PUT
    // never sends a condition eBay rejects (error 25021). Best-effort — a policy
    // fetch failure leaves the resolved value untouched.
    const listingCondition = (
      listingRow as { ebay_condition?: string | null } | null
    )?.ebay_condition;
    let reviseCondition =
      listingCondition && listingCondition.trim()
        ? listingCondition.trim()
        : mapEbayCondition(item.grade_value, item.grade_label);
    if (reviseCategoryId) {
      try {
        const { conditionIds } = await getItemConditionPolicies(reviseCategoryId);
        // US-1894: apparel-aware resolve (2025 pre-loved bands on apparel leaves)
        // + allow-list remap; explicit editor value still wins.
        const remapped = resolveEbayCondition({
          explicit: listingCondition,
          grade: item.grade_value,
          label: item.grade_label,
          allowedConditionIds: conditionIds,
        });
        if (remapped !== null && remapped !== reviseCondition) {
          console.log(
            `[flipdesk-ebay] revise condition "${reviseCondition}" resolved to ` +
              `"${remapped}" for category ${reviseCategoryId}`,
          );
          reviseCondition = remapped;
        }
      } catch (err) {
        console.warn(
          "[flipdesk-ebay] revise condition-policy (non-blocking):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const reviseConditionDescription =
      (
        (listingRow as { ebay_condition_description?: string | null } | null)
          ?.ebay_condition_description ??
        item.condition_notes ??
        ""
      ).trim() || undefined;
    // Persist the rebuilt map so the in-app eBay specifics editor and the next
    // publish reflect the current columns (canonical = listing override; mirror
    // onto the item too for legacy/no-listing reads). US-1503: also persist the
    // resync-regenerated description (measurements block + grade line) so the
    // composer + next revise's fallback don't re-serve the publish-time snapshot.
    // US-825: anything the gap-fill just derived is attributed
    // `inventory_derived`, merged over the existing provenance so an AI- or
    // user-attributed aspect is never downgraded. Without this the next revise's
    // reverseColumnAspects would read a derived value as unattributed.
    const reviseSources =
      reviseDerivedKeys.length > 0
        ? mergeSources(
            (((listingRow as {
              item_specifics_sources?: AspectSourceMap | null;
            } | null)?.item_specifics_sources ??
              item.ebay_aspect_sources ??
              {}) as AspectSourceMap),
            sourcesFor(reviseDerivedKeys, "inventory_derived"),
            aspects,
          )
        : null;
    await supabaseAdmin
      .from("listings")
      .update({
        item_specifics_override: aspects,
        ...(reviseSources ? { item_specifics_sources: reviseSources } : {}),
        ...(reviseGradeDesc != null
          ? { listing_description: reviseGradeDesc }
          : {}),
      })
      .eq("id", listingId);
    await supabaseAdmin
      .from("inventory_items")
      .update({
        ebay_aspects: aspects,
        ...(reviseSources ? { ebay_aspect_sources: reviseSources } : {}),
      })
      .eq("id", itemId);
    // US-1999: address the SKU eBay actually holds this listing under. Deriving
    // from item.sku here is what let a post-publish SKU rename send the revise
    // to a key eBay never had — creating an orphan inventory item while the
    // offer-id-keyed calls below still hit the real offer.
    const sku = resolveInventorySku(row.listing, item);

    const { data: photoRows } = await supabaseAdmin
      .from("item_photos")
      .select("storage_path, photo_url, photo_type, photo_role, sort_order")
      .eq("inventory_item_id", itemId)
      .order("sort_order", { ascending: true });
    // US-1549: 'internal' photos (price tags, receipts) never go to eBay.
    const imageUrls = toEbayImageUrls(
      filterEbayPhotos(
        (photoRows ?? []) as Array<{
          storage_path: string | null;
          photo_url: string | null;
          photo_type: string | null;
        }>,
      ).map(ebayPublicPhotoUrl)
    );

    // When the caller didn't override title/desc (e.g. a photos-only sync),
    // fall back to the values that were actually PUBLISHED (the listing row),
    // then the inventory_items mirror — never let a photo reorder silently
    // revert the live title/description.
    // US-1890: the revise/grade-resync re-PUT is often automated (photos-only
    // sync, grade line refresh), so a stored over-length title can't be fixed by
    // a human here — trim it on a word boundary defensively so eBay never rejects
    // the revision for a >80-char title.
    const finalTitle = trimTitleToLimit(
      hasTitle
        ? (nextTitle as string)
        : (row.listing.listing_title ?? item.title ?? "").trim(),
    );
    const finalDesc = hasDesc
      ? (nextDesc as string)
      : (
          row.listing.listing_description ??
          item.description ??
          finalTitle
        ).trim() || finalTitle;

    // US-1502/US-1503: reviseGradeDesc was computed above (measurements block +
    // grade promotion) when a resync ran; otherwise use the plain finalDesc.
    const reviseDesc = reviseGradeDesc ?? finalDesc;

    // Same value-validation rule the publish path applies (US-828 + NUMBER-typed
    // aspects): the PERSISTED map above keeps the seller's value so they can fix
    // it in the composer, but what goes OVER THE WIRE is reconciled — one
    // unparseable specific must not fail the whole revision the way it fails a
    // publish (25002). No spec loaded ⇒ send the map as-is, as before.
    const reviseWireAspects = reviseAspectList
      ? (() => {
          const r = reconcilePublishAspects(
            aspects,
            reviseAspectList
              .map((a) => ({
                name: a.localizedAspectName ?? "",
                mode: a.aspectConstraint?.aspectMode ?? "FREE_TEXT",
                allowedValues: (a.aspectValues ?? [])
                  .map((v) => v.localizedValue ?? "")
                  .filter((v) => v.length > 0),
                dataType: a.aspectConstraint?.aspectDataType,
              }))
              .filter((s) => s.name.length > 0),
          );
          if (r.omitted.length > 0) {
            console.warn(
              `[flipdesk-ebay] revise omitted ${r.omitted.length} aspect value(s) ` +
                `for item ${itemId}: ${JSON.stringify(r.omitted)}`,
            );
          }
          return r.aspects;
        })()
      : aspects;

    // Pre-flight the SAME required-aspect rule publish enforces. eBay rejects a
    // revision whose specifics are missing a required aspect ("The item specific
    // Department is missing"), and relaying that raw text after a wasted round
    // trip left the seller with no idea where to fix it. Check the wire map (a
    // required aspect whose only value failed value-validation reads as missing,
    // which is what eBay will say too) and answer with the composer instruction.
    if (reviseAspectList && reviseAspectList.length > 0) {
      const missing = requiredMissingAspects(reviseAspectList, reviseWireAspects);
      if (missing.length > 0) {
        console.warn(
          `[flipdesk-ebay] revise blocked for item ${itemId} (category ` +
            `${reviseCategoryId}): required specifics unfilled: ${missing.join(", ")}`,
        );
        await persistReviseFailure(
          listingId,
          new Error(`Required eBay specifics missing: ${missing.join(", ")}`),
        );
        return jsonResult(
          {
            error: "Required eBay item specifics are missing.",
            detail:
              `eBay requires ${missing.slice(0, 4).join(", ")}` +
              (missing.length > 4 ? ` and ${missing.length - 4} more` : "") +
              " for this category. Open the item, fill " +
              (missing.length === 1 ? "it" : "them") +
              " in the eBay item specifics editor, then save again.",
            missing_aspects: missing,
          },
          422,
        );
      }
    }

    // Move the live listing's CATEGORY before the specifics that only fit the
    // new one. eBay judges an inventory_item PUT against the category the
    // listing is in right now, and judges an offer category change against the
    // aspects the inventory item holds right now — so the obvious order
    // (specifics, then category, which is what the offer PUT further down does)
    // deadlocks on a re-categorisation:
    //
    //   • specifics first → judged by the OLD category → "The item specific
    //     Dress Length is missing" (a Dresses aspect our Tops map correctly
    //     dropped), and the route returns before the category ever moves. Every
    //     retry fails identically, so the listing can never leave the wrong
    //     category from here.
    //   • category first  → judged by the OLD aspects → "The item specific Type
    //     is missing" (a Tops aspect the Dresses map never had).
    //
    // Neither end of the swap is legal on its own, so bridge it: PUT the UNION
    // of what eBay already holds and what we're about to send (satisfies BOTH
    // categories' required aspects), move the offer's category, and let the
    // normal PUT below drop the leftovers under the new category. Best-effort
    // throughout — if any step fails we fall through to the existing path and
    // its error handling, which is no worse than before this existed.
    //
    // The bridge is best-effort, but its failure is NOT invisible: whatever
    // goes wrong here is what the seller's next error is really about, and
    // swallowing it left a re-categorised listing that refused every push with
    // an error naming an aspect its category no longer has, while nothing
    // anywhere recorded which step actually broke. The reason is carried to
    // the inventory-PUT failure below and reported with it.
    let categoryBridgeError: string | null = null;
    // US-2395: the bridge reads the LIVE OFFER, and a group listing has none.
    // Its category is re-asserted per variant offer in the group branch below.
    if (resyncFields && reviseCategoryId && !groupRevise) {
      try {
        const liveOffer = await getOffer(
          userId,
          offerId,
          row.listing.marketplace_connection_id ?? undefined,
        );
        const liveCategoryId =
          typeof liveOffer.categoryId === "string" ? liveOffer.categoryId : null;
        // Bridge when the live category differs — and ALSO when eBay didn't
        // report one at all. A missing categoryId used to skip the bridge
        // entirely, which is the same silent no-op as never having it: we
        // cannot prove the categories match, and the cost of bridging when
        // they already do is one superset PUT that the normal re-PUT below
        // immediately narrows. "Unknown" belongs with "different", not with
        // "same".
        if (liveCategoryId !== reviseCategoryId) {
          console.warn(
            `[flipdesk-ebay] listing ${listingId}: eBay category ` +
              `${liveCategoryId} → ${reviseCategoryId}; bridging via a union PUT`,
          );
          const liveAspects = await getInventoryItemAspects(
            userId,
            sku,
            row.listing.marketplace_connection_id ?? undefined,
          );
          if (liveAspects && Object.keys(liveAspects).length > 0) {
            await createOrReplaceInventoryItem(
              userId,
              sku,
              {
                product: {
                  title: finalTitle,
                  description: reviseDesc,
                  aspects: { ...liveAspects, ...reviseWireAspects },
                  imageUrls,
                  brand:
                    typeof item.brand === "string" && item.brand.trim()
                      ? item.brand.trim()
                      : "Unbranded",
                  mpn: "Does Not Apply",
                },
                condition: reviseCondition,
                conditionDescription: reviseConditionDescription,
                availability: { shipToLocationAvailability: { quantity: 1 } },
              },
              row.listing.marketplace_connection_id ?? undefined,
            );
          }
          await updateOfferFields(
            userId,
            offerId,
            { categoryId: reviseCategoryId },
            row.listing.marketplace_connection_id ?? undefined,
          );
        }
      } catch (err) {
        categoryBridgeError = err instanceof Error ? err.message : String(err);
        console.error(
          `[flipdesk-ebay] category bridge failed for listing ${listingId} ` +
            `(falling through to the normal re-PUT):`,
          err,
        );
      }
    }

    // US-2395 AC1/AC3: the group branch. Everything it needs is now built, and
    // from here the single-offer path below is untouched — this returns before
    // reaching it. The blast radius is exactly the listings that answered 409
    // until now, which is why this can land without a real listing to test
    // against: it cannot make the common path worse than it is.
    if (groupRevise && reviseStrategy.kind === "group") {
      return await reviseVariationGroup({
        userId,
        listingId,
        groupKey: reviseStrategy.groupKey,
        variations: row.listing.variations as ListingVariations,
        title: finalTitle,
        description: reviseDesc,
        aspects: reviseWireAspects,
        imageUrls,
        condition: reviseCondition,
        conditionDescription: reviseConditionDescription,
        brand:
          typeof item.brand === "string" && item.brand.trim()
            ? item.brand.trim()
            : "Unbranded",
        price: hasPrice ? (nextPrice as number) : undefined,
        categoryId: resyncFields && reviseCategoryId ? reviseCategoryId : undefined,
        listingDescription: hasDesc ? (nextDesc as string) : (reviseGradeDesc ?? undefined),
        quantityRequested: hasQty,
        connectionId: row.listing.marketplace_connection_id ?? undefined,
        localUpdates,
        photosSynced: syncPhotos || hasTitle || hasDesc || resyncFields,
      });
    }

    try {
      await createOrReplaceInventoryItem(userId, sku, {
        product: {
          title: finalTitle,
          description: reviseDesc,
          aspects:
            Object.keys(reviseWireAspects).length > 0
              ? reviseWireAspects
              : undefined,
          imageUrls,
          // Mirror the publish path (US: error 25002 <BrandMPN>): eBay requires a
          // Brand+MPN product identifier on every inventory_item PUT, so the
          // revise re-PUT must send the SAME defaults publish does — otherwise a
          // title/description/photo edit drops the MPN and eBay 400s the revision.
          brand:
            typeof item.brand === "string" && item.brand.trim()
              ? item.brand.trim()
              : "Unbranded",
          mpn: "Does Not Apply",
        },
        condition: reviseCondition,
        conditionDescription: reviseConditionDescription,
        availability: { shipToLocationAvailability: { quantity: 1 } },
      },
        // US-1507: revise via the listing's own connection (null → primary).
        row.listing.marketplace_connection_id ?? undefined);
    } catch (err) {
      console.error("[flipdesk-ebay] revise inventory_item failed:", err);
      // When the category bridge above failed, THIS error is a consequence of
      // that failure, not an independent fact: eBay is judging the new
      // specifics against a category we did not manage to move the listing out
      // of. Reporting only the downstream message is what made this look
      // unfixable — the seller is told to supply an aspect their category no
      // longer has, with no hint that a prior step is the reason. Carry the
      // cause, so the error names the step that actually broke.
      const reported = categoryBridgeError
        ? new Error(
            `${err instanceof Error ? err.message : String(err)} ` +
              `(the eBay category change did not apply first: ${categoryBridgeError})`,
          )
        : err;
      // US-1079: persist the failure on the listing (publish_error/
      // publish_failed_at) so the UI can surface it + offer a retry on reload.
      await persistReviseFailure(listingId, reported);
      const healedDetail = (await healCustomValueRejection({
        err,
        categoryId: reviseCategoryId,
        itemId,
        listingId,
      }))?.message;
      // 422 (not 502): an eBay business-rule rejection is a data problem, not a
      // gateway failure. A 5xx gets intercepted by the Traefik/Coolify error page
      // (which strips CORS headers — see main.ts), so the browser sees a bare
      // "CORS blocked" instead of this detail. 422 passes through with the body.
      return jsonResult(
        {
          error: "eBay rejected the revision.",
          // US-1511: mapped/human detail only (mirrors the publish path's
          // US-567 contract) — the raw eBay blob stays in the log above.
          detail:
            (healedDetail ?? ebayFailureDetail(err, EBAY_PUBLISH_GENERIC_FIX)) +
            (categoryBridgeError
              ? " This listing's eBay category could not be changed first" +
                ` (${categoryBridgeError}), so eBay checked your item specifics` +
                " against its OLD category. Fix that and the specifics will" +
                " follow."
              : ""),
          ...(categoryBridgeError
            ? { category_bridge_error: categoryBridgeError }
            : {}),
        },
        422
      );
    }
  }

  // Offer side handles price + listing description + quantity + category
  // (offer.listingDescription overrides product.description, availableQuantity
  // controls the listed quantity, categoryId is the eBay leaf category). Batched
  // into one PUT. US-1490: a resync re-asserts the category on the live offer.
  // US-2395: never for a group. The group branch above returns, so reaching here
  // with groupRevise set would mean a new early-exit path skipped it — and the
  // offerId a group resolves to is the empty string, which would put a malformed
  // eBay request on the seller's live listing. Cheap guard against a mistake
  // that would only show up in production.
  if (!groupRevise && (hasPrice || hasDesc || hasQty || resyncFields)) {
    try {
      await updateOfferFields(userId, offerId, {
        price: hasPrice ? (nextPrice as number) : undefined,
        // US-1502: push the grade-promoted description (Cert # line) to the live
        // offer on a resync even when the seller didn't edit the description —
        // else a stored offer listingDescription shadows the product.description.
        listingDescription: hasDesc
          ? (nextDesc as string)
          : (reviseGradeDesc ?? undefined),
        availableQuantity: hasQty ? (nextQty as number) : undefined,
        categoryId: resyncFields && reviseCategoryId ? reviseCategoryId : undefined,
      },
        // US-1507: revise via the listing's own connection (null → primary).
        row.listing.marketplace_connection_id ?? undefined);
    } catch (err) {
      console.error("[flipdesk-ebay] revise offer failed:", err);
      // US-1079: persist the failure on the listing (publish_error/
      // publish_failed_at) so the UI can surface it + offer a retry on reload.
      await persistReviseFailure(listingId, err);
      const healedOfferDetail = (await healCustomValueRejection({
        err,
        categoryId: reviseCategoryId,
        itemId,
        listingId,
      }))?.message;
      // 422 (not 502): see the inventory_item branch above — an eBay rejection is
      // a data problem; a 5xx loses its CORS headers to the proxy error page.
      return jsonResult(
        {
          error: "eBay rejected the offer revision.",
          // US-1511: mapped/human detail only — raw blob stays in the log above.
          detail: healedOfferDetail ?? ebayFailureDetail(err, EBAY_PUBLISH_GENERIC_FIX),
        },
        422
      );
    }
  }

  await clearReviseDrift(listingId, {
    restocked: hasQty && (nextQty as number) > 0,
  });

  return jsonResult({
    ok: true,
    listing_id: listingId,
    updated: localUpdates,
    photos_synced: syncPhotos || hasTitle || hasDesc || resyncFields,
  });
}

flipdeskEbayRoutes.post("/listings/:id/revise", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: {
    title?: unknown;
    description?: unknown;
    listing_price?: unknown;
    quantity?: unknown;
    photos?: unknown;
    resync_ebay_fields?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const nextTitle =
    typeof body.title === "string" ? body.title.trim() : undefined;
  const nextDesc =
    typeof body.description === "string" ? body.description.trim() : undefined;
  const nextPrice =
    body.listing_price !== undefined && body.listing_price !== null
      ? Number(body.listing_price)
      : undefined;
  // US-1079: full eBay-owned field coverage — quantity pushes up too, not just
  // price. A non-negative integer (0 ends availability without withdrawing).
  const nextQty =
    body.quantity !== undefined && body.quantity !== null
      ? Number(body.quantity)
      : undefined;

  const hasTitle = nextTitle !== undefined;
  const hasDesc = nextDesc !== undefined;
  const hasPrice = nextPrice !== undefined;
  const hasQty = nextQty !== undefined;
  // `photos: true` forces the inventory_item re-PUT so the current photo set
  // and sort order reach eBay even when no text field changed.
  const syncPhotos = body.photos === true;
  // US-1490: `resync_ebay_fields: true` re-asserts the eBay-owned STRUCTURED
  // fields the seller edited post-publish — category, condition, and item
  // specifics — which the inventory re-PUT (aspects + condition) and the offer
  // category push below already source from the DB. It forces both pushes even
  // when no title/description/photo changed (a specifics/condition/category-only
  // edit), so "Save & resubmit" on the web composer reaches a live listing.
  const resyncFields = body.resync_ebay_fields === true;

  if (!hasTitle && !hasDesc && !hasPrice && !hasQty && !syncPhotos && !resyncFields) {
    return c.json(
      {
        error:
          "Provide at least one of: title, description, listing_price, quantity, photos, resync_ebay_fields",
      },
      400
    );
  }
  if (hasTitle && !nextTitle) {
    return c.json({ error: "title cannot be empty" }, 400);
  }
  if (
    hasPrice &&
    (!Number.isFinite(nextPrice) || (nextPrice as number) <= 0)
  ) {
    return c.json({ error: "listing_price must be a positive number" }, 400);
  }
  if (
    hasQty &&
    (!Number.isInteger(nextQty) || (nextQty as number) < 0)
  ) {
    return c.json(
      { error: "quantity must be a non-negative integer" },
      400
    );
  }

  const outcome = await reviseOneListing(listingId, userId, {
    title: nextTitle,
    description: nextDesc,
    listingPrice: nextPrice,
    quantity: nextQty,
    syncPhotos,
    resyncFields,
  });
  return c.json(outcome.body, outcome.status);
});

// ── Bulk resubmit (US-2404) ─────────────────────────────────────────
// POST /listings/bulk-revise — body { listing_ids: string[] }.
//
// The Active tab's bulk-bar equivalent of the composer's "Save & resubmit to
// eBay": for each selected listing, re-assert what is already SAVED in
// GradeThread — item specifics, category, condition (resync_ebay_fields) and the
// photo set (photos) — against the live eBay listing. It sends no new field
// values of its own, so there is nothing here for a stale render to get wrong.
//
// IT CALLS reviseOneListing, THE SAME FUNCTION THE SINGLE ROUTE CALLS. That is
// the whole point of the extraction above: every refusal the one-at-a-time path
// makes — a non-eBay platform row, an eBay-originated mirror listing (US-1080),
// a row the caller does not own — is made here identically, because it is the
// same code. A bulk action whose refusals drift from the single-item ones is how
// a seller gets told 40 listings were pushed when eBay refused 12.
//
// SEQUENTIAL, not parallel: a revise is several eBay API calls per listing
// (inventory PUT + offer update), and firing 25 of those at once is how you meet
// a rate limit. The client chunks the selection so each request stays short.
//
// PER-ROW RESULTS, never a bare success count. bulk-price's own header records
// what the shape before it did: it "quietly wrote the local price for every
// non-eBay row and reported it as updated locally only". A row eBay refused
// comes back ok:false with its reason, and reviseOneListing has already left
// that row's local state alone.
flipdeskEbayRoutes.post("/listings/bulk-revise", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  // Bulk multi-listing actions are a Pro+ feature (US-208), same gate as
  // /bulk-price and /listings/bulk-price-quantity.
  const gate = await requireFlipdesk(c, { feature: "bulkActions", userId });
  if (gate) return gate;

  let body: { listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const ids = Array.isArray(body.listing_ids)
    ? [...new Set(body.listing_ids.filter((x): x is string => typeof x === "string" && !!x))]
    : [];
  if (ids.length === 0) {
    return c.json({ error: "listing_ids is required." }, 400);
  }
  if (ids.length > MAX_BULK_REVISE_ITEMS) {
    return c.json(
      { error: `Too many listings (max ${MAX_BULK_REVISE_ITEMS}).` },
      400,
    );
  }

  const results: Array<{
    listing_id: string;
    ok: boolean;
    status: number;
    error?: string;
    code?: string;
  }> = [];
  for (const listingId of ids) {
    let outcome: ReviseOneResult;
    try {
      outcome = await reviseOneListing(listingId, userId, {
        syncPhotos: true,
        resyncFields: true,
      });
    } catch (err) {
      // One row throwing must not abandon the rest of the selection — the seller
      // would have no way to tell which of the remaining ids ran.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[flipdesk-ebay] bulk-revise ${listingId} threw:`, message);
      results.push({ listing_id: listingId, ok: false, status: 500, error: message });
      continue;
    }
    const ok = outcome.status === 200 && outcome.body.ok === true;
    results.push({
      listing_id: listingId,
      ok,
      status: outcome.status,
      ...(ok ? {} : {
        error: typeof outcome.body.error === "string"
          ? outcome.body.error
          : "eBay refused the update.",
        ...(typeof outcome.body.code === "string" ? { code: outcome.body.code } : {}),
      }),
    });
  }

  const pushed = results.filter((r) => r.ok).length;
  return c.json({
    ok: true,
    requested: ids.length,
    pushed,
    failed: ids.length - pushed,
    results,
  });
});

flipdeskEbayRoutes.delete("/listings/:id", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);

  // US-1976: an eBay-originated listing is a read-only mirror — eBay owns its
  // lifecycle, so reject an end from FlipDesk with the same 409 + locked_fields
  // contract as /revise. Ending it here would either fight eBay's own state or
  // be overwritten on the next inbound sync. Checked BEFORE the offer-id branch
  // so an eBay-origin row that carries an offer id is still rejected as locked.
  const endLock = ebayOriginWriteLock(
    {
      listing_origin: row.listing.listing_origin,
      // US-2166: the row's own platform, not a literal.
      platform: row.listing.platform,
      platform_listing_id: row.listing.platform_listing_id,
      batch_id: row.listing.batch_id,
      synced_to_ebay_at: row.listing.synced_to_ebay_at,
    },
    ["listing_status", "is_active"],
  );
  if (endLock.locked) {
    return c.json(
      {
        error:
          "This listing was created on eBay, so eBay owns its lifecycle. End it on eBay — ending it here would be overwritten on the next sync.",
        locked_fields: endLock.lockedFields,
      },
      409
    );
  }

  // Best-effort withdraw of the live eBay offer, then ALWAYS reconcile the local
  // row to ended. A withdraw can legitimately fail because the listing is already
  // not live — the seller ended it on eBay, eBay removed it for a policy issue,
  // or a prior end already withdrew it. Previously that threw a 502 and left the
  // row stuck "active", so "End"/"Relist" became no-ops on a policy-removed
  // listing. Now only a TRANSIENT failure (rate-limit / eBay 5xx) blocks the end
  // so the user can retry; an already-not-live offer reconciles locally.
  let endedOnEbay = false;
  let note: string | null = null;

  // US-1506/US-1978: a withdraw (single-offer OR group) fails for the same three
  // reasons, handled identically. Returns an abort Response to return to the
  // caller, or a reconcile-note string when the listing was already not live.
  const classifyWithdrawFailure = (
    err: unknown,
  ): { abort: Response } | { note: string } => {
    // US-1506: a disconnected eBay account throws BEFORE the withdraw runs, so
    // the listing is still LIVE on eBay. Never reconcile it to ended — that would
    // tell the seller it's gone while buyers can still purchase it (oversell).
    // Fail with actionable reconnect copy instead.
    if (isNoEbayConnectionError(err)) {
      console.warn(
        "[flipdesk-ebay] end: no eBay connection — listing left active:",
        err instanceof Error ? err.message : String(err),
      );
      return {
        abort: c.json(
          {
            error:
              "Your eBay account isn't connected, so we couldn't end this live " +
              "listing on eBay. Reconnect eBay in Marketplaces, then end it again.",
          },
          409,
        ),
      };
    }
    if (!isOfferAlreadyEndedError(err)) {
      console.error("[flipdesk-ebay] withdraw failed (transient):", err);
      return {
        abort: c.json(
          {
            error: "eBay rejected the end-listing call. Please try again.",
            // US-1511: mapped/human detail only — raw blob stays in the log above.
            detail: ebayFailureDetail(
              err,
              "eBay couldn't end this listing just now. It's still live — try again in a moment.",
            ),
          },
          502,
        ),
      };
    }
    console.warn(
      "[flipdesk-ebay] end: listing already not live, reconciling locally:",
      err instanceof Error ? err.message : String(err),
    );
    return { note: "eBay shows this listing was already inactive; ended in FlipDesk." };
  };

  // US-1978 (AC1): a multi-variation listing is ONE eBay listing spanning an
  // inventory_item_group, so it has NO single platform_offer_id — it must be
  // ended by its GROUP KEY. resolveEndStrategy resolves group FIRST so a
  // variation listing never falls through to the "no offer linked" no-op that
  // previously left it live on eBay forever.
  const strategy = resolveEndStrategy({
    variations: row.listing.variations,
    // US-1999: the inventory_item_group was created under the BASE SKU at
    // publish, so the withdraw key is the PINNED sku — not the item's current
    // one, which a rename would have moved out from under the live group.
    itemSku: row.listing.inventory_sku ?? row.listing.item_sku,
    platformOfferId: row.listing.platform_offer_id,
  });
  // US-1507: end via the account that owns the listing (null → primary).
  const endConnectionId = row.listing.marketplace_connection_id ?? undefined;
  if (strategy.kind === "group") {
    try {
      await withdrawByInventoryItemGroup(userId, strategy.groupKey, endConnectionId);
      endedOnEbay = true;
    } catch (err) {
      const outcome = classifyWithdrawFailure(err);
      if ("abort" in outcome) return outcome.abort;
      note = outcome.note;
    }
  } else if (strategy.kind === "offer") {
    try {
      await withdrawOffer(userId, strategy.offerId, endConnectionId);
      endedOnEbay = true;
    } catch (err) {
      const outcome = classifyWithdrawFailure(err);
      if ("abort" in outcome) return outcome.abort;
      // US-2641: classifyWithdrawFailure INFERS "already not live" from a 4xx.
      // The inference is usually right, and when it is wrong the row is marked
      // ended while buyers can still buy — the failure the seller cannot see.
      // One read of the offer settles it, and only on this failure path.
      const stillLive = await getPublishedListingId(
        userId,
        strategy.offerId,
        endConnectionId,
      );
      if (stillLive) {
        console.error(
          `[flipdesk-ebay] end: withdraw of offer ${strategy.offerId} failed but ` +
            `listing ${stillLive} is STILL LIVE — refusing to mark it ended`,
        );
        return c.json(
          {
            error: "eBay refused to end this listing and it is still live.",
            detail:
              `eBay would not end listing ${stillLive}. End it in Seller Hub, ` +
              "then mark it ended here.",
          },
          502,
        );
      }
      note = outcome.note;
    }
  } else {
    note = "No eBay offer was linked; ended in FlipDesk only.";
  }

  await supabaseAdmin
    .from("listings")
    .update({ listing_status: "ended", is_active: false })
    .eq("id", listingId);
  // Move the item back to drafted so the user can relist if they want — but only
  // once nothing is live anywhere (US-2179). Ending the eBay listing of an item
  // that is still live on a cross-listed channel used to mark it a draft, which
  // both freed an activeListings slot the seller was still using and hid a
  // selling listing in the Drafts tab.
  await resyncItemListedStatus(row.listing.inventory_item_id, userId);

  return c.json({ ok: true, listing_id: listingId, ended_on_ebay: endedOnEbay, note });
});

flipdeskEbayRoutes.post("/listings/validate", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = await readItemId(c);
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);
  const result = await assemblePublishContext(userId, itemId);
  if (!result.ok) return c.json(result.error, result.status);
  return c.json({
    ok: result.blockers.length === 0,
    blockers: result.blockers,
    // US-1890: non-blocking title-quality warnings (duplicate/ALL-CAPS/filler).
    // US-1896 also folds picture-standards (hero <1600px zoom) warnings in here.
    warnings: result.warnings,
    // US-1896: hero-thumbnail reorder nudge (first photo is a tag/detail shot).
    photoNudge: result.photoNudge,
    // US-828: aspects that won't be sent for value-validation reasons, so the
    // composer can warn "X was not sent" before the seller publishes.
    aspectDiagnostics: result.aspectDiagnostics,
    aspectOffList: result.aspectOffList,
    // US-1895: recommended-aspect coverage (N/M + ranked missing) for the meter.
    recommendedCoverage: result.recommendedCoverage,
    // US-1897 (AC2): the 0-100 Listing Quality Score + component breakdown,
    // each component naming the surface that fixes it. Persisted as a
    // side-effect so the drafts list and pipeline board can sort by it.
    qualityScore: await scoreAndPersist(userId, result),
    summary: result.summary,
  });
});

// US-1897 (AC2): compute the score and persist the sortable scalar.
//
// The write is BEST-EFFORT and deliberately awaited-but-swallowed: preflight is
// what tells a seller whether they can publish, and it must not start failing
// because a score column is missing (this ships with migration 00476, and the
// edge can briefly run ahead of it) or because the row was deleted mid-request.
// A missing score costs a sort key; a thrown preflight costs the publish.
//
// Only the scalar is stored. The breakdown is recomputed every call so it can
// never drift from the live weights — see 00476.
async function scoreAndPersist(
  ownerId: string,
  ctx: PublishContextOk,
): Promise<ListingQualityScore> {
  const score = await buildQualityScore(ownerId, ctx);
  // A draft that has never been listed has no listings row yet; there is
  // nothing to sort, so nothing to store.
  if (!ctx.listing?.id) return score;
  try {
    // Tenant-safe without an extra filter: ctx.listing came from
    // assemblePublishContext, which loaded it scoped to this owner. The id is
    // ours by construction, never from the request body (US-268).
    await supabaseAdmin
      .from("listings")
      .update({
        quality_score: score.score,
        quality_blocked: score.blocked,
        quality_scored_at: new Date().toISOString(),
      })
      .eq("id", ctx.listing.id);
  } catch (err) {
    console.error(
      "US-1897 quality score persist (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
  return score;
}

// US-1897: assemble the quality score from the preflight's structured signals.
//
// Lives here rather than inside assemblePublishContext on purpose: it needs one
// extra DB read (business policies) and one extra check, and the publish and
// auto-publish paths share that function. Scoring is a validate-time concern, so
// the hot path should not pay for it.
async function buildQualityScore(
  ownerId: string,
  ctx: PublishContextOk,
): Promise<ListingQualityScore> {
  const qs = ctx.qualitySignals;

  // US-1894's consistency check shipped tested but was never called by any
  // production path — this is its first real caller. Guarded so a listing with
  // no resolved condition reports "unknown" rather than a confident verdict.
  const conditionText = ctx.summary.conditionDescription || null;
  const condition = ctx.summary.condition
    ? conditionDescriptionConsistency(
      ctx.summary.condition as Parameters<typeof conditionDescriptionConsistency>[0],
      conditionText,
    )
    : null;

  return computeListingQualityScore({
    title: {
      text: ctx.summary.title || null,
      policyViolations: qs.titlePolicyViolations,
      warnings: qs.titleWarnings,
    },
    aspects: {
      requiredMissing: qs.requiredMissing,
      recommendedFilled: ctx.recommendedCoverage.filled,
      recommendedTotal: ctx.recommendedCoverage.total,
    },
    photos: {
      blockers: qs.photoBlockers,
      warnings: qs.photoWarnings,
      nudge: ctx.photoNudge,
      count: qs.photoCount,
    },
    category: {
      leafStatus: qs.categoryLeafStatus,
      // We only KNOW the chosen category matches eBay's suggestion when we just
      // resolved it from one. Otherwise it is genuinely unknown — asserting
      // false would penalise every hand-picked category we never cross-checked.
      matchesSuggestion: qs.categoryWasSuggested ? true : null,
    },
    condition: {
      consistent: condition ? condition.ok : null,
      warnings: condition ? condition.warnings : [],
    },
    fulfillment: await loadFulfillmentSignals(ownerId),
    // US-2678: judged against what comparable items actually SOLD for, which is
    // what getRealizedComps returns and what active Browse comps are not.
    // Marketplace Insights is a gated scope, so null here is ordinary and makes
    // the component "unknown" rather than a guess.
    price: {
      // summary.priceValue is the resolved publish price as a fixed-2 STRING
      // (resolvePublishPrice -> toFixed), so it is parsed rather than read as a
      // number. "0.00" is the no-price sentinel and must not score as free.
      listingCents: (() => {
        const dollars = Number.parseFloat(ctx.summary.priceValue);
        return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null;
      })(),
      realized: await loadRealizedBand(ownerId, ctx),
    },
  });
}

/**
 * US-2678: the realized comp band for the quality score's price component.
 *
 * NON-THROWING. A quality SCORE must never be the reason a seller cannot see
 * their publish blockers, so every failure returns null, which the component
 * reads as "unknown" and drops from the score entirely.
 */
async function loadRealizedBand(
  ownerId: string,
  ctx: PublishContextOk,
): Promise<{ lowCents: number | null; medianCents: number | null; highCents: number | null; count: number } | null> {
  const categoryId = ctx.listing?.platform_category_id ?? ctx.item.ebay_category_id ?? null;
  if (!categoryId) return null;
  try {
    const realized = await getRealizedComps({
      ownerId,
      categoryId,
      brand: ctx.item.brand ?? undefined,
      q: ctx.summary.title || undefined,
      size: ctx.item.size ?? undefined,
    });
    if (!realized) return null;
    return {
      lowCents: realized.lowCents,
      medianCents: realized.medianCents,
      highCents: realized.highCents,
      count: realized.count,
    };
  } catch (err) {
    console.error("[flipdesk-ebay] realized band for quality score:", err);
    return null;
  }
}

// US-1978 (AC1): decide HOW to end a listing from its persisted shape — the
// pure, unit-tested core of the DELETE /listings/:id branch. A variation listing
// (a publishable variations matrix + a group key) ends via
// withdrawByInventoryItemGroup; a single-SKU listing with a live offer ends via
// withdrawOffer; anything else ends locally only. GROUP is resolved FIRST because
// a variation listing carries NO platform_offer_id and would otherwise no-op live
// on eBay forever.
export type EndStrategy =
  | { kind: "group"; groupKey: string }
  | { kind: "offer"; offerId: string }
  | { kind: "local" };

// US-2395 AC2: which mechanism revises this listing.
//
// Deliberately the same shape and the same ORDER as resolveEndStrategy below —
// group FIRST. A multi-variation listing is published through
// publish_by_inventory_item_group and eBay never mints a platform_offer_id for
// it, so an offer-first resolver reads a group listing as having no mechanism at
// all. That is exactly the bug: revise 409'd with "no eBay offer id" on a
// listing that was never going to have one, which froze every variation listing
// the moment it went live.
//
// The group key is the PINNED listings.inventory_sku, not the item's current
// sku. The inventory_item_group was created under the base SKU at publish, so a
// later SKU rename would otherwise point the revise at a group that does not
// exist — the same reasoning US-1999 applied to the withdraw path.
//
// `kind: "none"` is NOT the same as end's `"local"`: ending locally is a
// meaningful outcome (the listing is closed in FlipDesk), whereas a revise with
// no mechanism has done nothing and must say so.
export type ReviseStrategy =
  | { kind: "group"; groupKey: string }
  | { kind: "offer"; offerId: string }
  | { kind: "none" };

/**
 * US-2395 AC1/AC3: push a revision through the inventory_item_group.
 *
 * The publish path (publishVariationListing) is the reference for the shapes
 * here, and this is deliberately NOT a call into it: publish CREATES offers and
 * writes a listings row, and a revise must do neither. What it shares is the
 * payload shape, so a variant item built here matches one built there.
 *
 * Order matters and is the same as publish. Variant items first, because the
 * group references them; the group second, because it carries what the buyer
 * reads (title, description, photos); the per-variant offers third, because
 * price and category live there and not on the item; the publish call last.
 *
 * THE PUBLISH CALL AT THE END IS THE UNVERIFIED PART, said plainly rather than
 * buried. For an already-published group, publish_by_inventory_item_group is
 * how eBay applies pending item and group changes, and it returns the same
 * listing id. If eBay instead rejects it as already published, the error
 * surfaces as a 422 with its own message rather than being swallowed — which is
 * the failure mode worth having, because the alternative is reporting success
 * on a listing that did not change. US-2395 AC7 is the check against a real
 * multi-variation listing, and it stays open until someone runs it.
 *
 * QUANTITY IS DELIBERATELY REFUSED. Quantity on a group is per variant; one
 * number applied to every variant would multiply the seller's stock by the
 * number of variants, silently. The response says so instead.
 */
async function reviseVariationGroup(args: {
  userId: string;
  listingId: string;
  groupKey: string;
  variations: ListingVariations;
  title: string;
  description: string;
  aspects: Record<string, string[]>;
  imageUrls: string[];
  condition: string;
  conditionDescription: string | undefined;
  brand: string;
  price: number | undefined;
  categoryId: string | undefined;
  listingDescription: string | undefined;
  quantityRequested: boolean;
  connectionId: string | undefined;
  localUpdates: Record<string, unknown>;
  photosSynced: boolean;
}): Promise<ReviseOneResult> {
  const {
    userId,
    listingId,
    groupKey,
    variations,
    title,
    description,
    aspects,
    imageUrls,
    condition,
    conditionDescription,
    brand,
    price,
    categoryId,
    listingDescription,
    quantityRequested,
    connectionId,
    localUpdates,
    photosSynced,
  } = args;

  const variantSkus: string[] = [];
  const specValues = new Map<string, Set<string>>();
  for (const spec of variations.specifications) specValues.set(spec, new Set());
  for (const v of variations.variants) {
    for (const spec of variations.specifications) {
      const val = v.aspects[spec];
      if (val) specValues.get(spec)!.add(val);
    }
  }

  try {
    // 1. Every variant item carries the shared edit plus its own variation
    //    values. eBay needs the varies-by aspect present on every member item,
    //    so the per-variant values are written LAST and win.
    for (const variant of variations.variants) {
      const vSku = variantSku(groupKey, variant);
      variantSkus.push(vSku);
      const variantAspects: Record<string, string[]> = { ...aspects };
      for (const [name, value] of Object.entries(variant.aspects)) {
        variantAspects[name] = [value];
      }
      await createOrReplaceInventoryItem(
        userId,
        vSku,
        {
          product: {
            title,
            description,
            aspects:
              Object.keys(variantAspects).length > 0 ? variantAspects : undefined,
            imageUrls,
            brand,
            mpn: "Does Not Apply",
          },
          condition,
          conditionDescription,
          availability: {
            shipToLocationAvailability: { quantity: variant.quantity },
          },
        },
        connectionId,
      );
    }

    // 2. The group is what the buyer actually reads.
    const specifications = variations.specifications.map((name) => ({
      name,
      values: [...(specValues.get(name) ?? [])],
    }));
    const colorSpec = variations.specifications.find((s) => /colou?r/i.test(s));
    await createOrReplaceInventoryItemGroup(userId, groupKey, {
      title,
      description,
      imageUrls,
      aspects,
      variantSKUs: variantSkus,
      variesBy: {
        specifications,
        ...(colorSpec ? { aspectsImageVariesBy: [colorSpec] } : {}),
      },
    });

    // 3. Price and category live on the per-variant offers, which were created
    //    at publish and whose ids we never stored — that absence is the whole
    //    reason this listing has no platform_offer_id. Look each one up by SKU.
    //    A variant with a per-variant price keeps it: a base-price edit must not
    //    flatten a deliberately-differentiated variant.
    if (price !== undefined || categoryId || listingDescription) {
      for (const variant of variations.variants) {
        const vSku = variantSku(groupKey, variant);
        const offers = await listOffersForSku(userId, vSku);
        const live = offers.find((o) => !!o.offerId);
        if (!live) continue;
        await updateOfferFields(
          userId,
          live.offerId,
          {
            price:
              price !== undefined && variant.price_cents == null ? price : undefined,
            listingDescription,
            categoryId,
          },
          connectionId,
        );
      }
    }

    // 4. Apply it. See the note above on why this call is the unverified part.
    await publishOfferByInventoryItemGroup(userId, groupKey, getMarketplaceId());
  } catch (err) {
    console.error("[flipdesk-ebay] variation group revise failed:", err);
    await persistReviseFailure(listingId, err);
    return jsonResult(
      {
        error: "eBay rejected the variation revision.",
        detail: ebayFailureDetail(err, EBAY_PUBLISH_GENERIC_FIX),
      },
      422,
    );
  }

  await clearReviseDrift(listingId);
  await supabaseAdmin
    .from("listings")
    .update({ synced_to_ebay_at: new Date().toISOString() })
    .eq("id", listingId);

  return jsonResult({
    ok: true,
    listing_id: listingId,
    updated: localUpdates,
    photos_synced: photosSynced,
    variation_group: groupKey,
    variants_pushed: variantSkus.length,
    ...(quantityRequested
      ? {
          quantity_skipped:
            "Quantity on a variation listing is per variant. Edit the variant " +
            "quantities and resubmit; one number here would have been applied " +
            "to every variant.",
        }
      : {}),
  });
}

export function resolveReviseStrategy(input: {
  variations: ListingVariations | null;
  itemSku: string | null;
  platformOfferId: string | null;
}): ReviseStrategy {
  if (input.variations && input.itemSku) {
    return { kind: "group", groupKey: input.itemSku };
  }
  if (input.platformOfferId) {
    return { kind: "offer", offerId: input.platformOfferId };
  }
  return { kind: "none" };
}

export function resolveEndStrategy(input: {
  variations: ListingVariations | null;
  itemSku: string | null;
  platformOfferId: string | null;
}): EndStrategy {
  if (input.variations && input.itemSku) {
    return { kind: "group", groupKey: input.itemSku };
  }
  if (input.platformOfferId) {
    return { kind: "offer", offerId: input.platformOfferId };
  }
  return { kind: "local" };
}

// ── Publish-flow helpers ───────────────────────────────────────────

async function readItemId(
  c: Context<EbayEnv>
): Promise<string | null> {
  try {
    const body = (await c.req.json()) as { inventory_item_id?: unknown };
    return typeof body.inventory_item_id === "string"
      ? body.inventory_item_id
      : null;
  } catch {
    return null;
  }
}

// US-1502: push the current grade onto an item's LIVE GradeThread-origin eBay
// listing — the "Condition Grade" item specific + the "Cert #…" description line.
// Fired best-effort from the grading finalize path (grading-pipeline.ts
// applyTerminalCompletion) whenever a grade LANDS or is CORRECTED (incl. a human
// DOWNGRADE), so a list-first-then-grade item — or a re-review — never leaves an
// absent/overstated grade live. No-op unless the item has an active GT-origin
// listing (a real platform_offer_id, not an eBay-imported mirror) and a grade.
// MUST stay best-effort at the call site — a resync failure must never break
// grade completion.
export async function resyncGradeToLiveListing(
  userId: string,
  itemId: string,
): Promise<{ resynced: boolean; reason?: string }> {
  // 1) Guard: item exists, owned, graded.
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, size, color, material, style, item_category, attributes, sku, description, condition_notes, grade_value, grade_label, certificate_url, ebay_aspects, ebay_category_id",
    )
    .eq("id", itemId)
    .maybeSingle();
  const item = itemRow as
    | (Record<string, unknown> & { user_id: string; grade_value: number | null })
    | null;
  if (!item || item.user_id !== userId) {
    return { resynced: false, reason: "item_not_found" };
  }
  if (item.grade_value == null) return { resynced: false, reason: "no_grade" };

  // 2) Guard: an ACTIVE GradeThread-origin listing with a real offer id. eBay-
  //    imported listings (no offer id / listing_origin "ebay") are read-only
  //    mirrors — never push to them.
  const { data: listingRow } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, platform_offer_id, platform_category_id, item_specifics_override, ebay_condition, ebay_condition_description, listing_description, listing_status, listing_origin, marketplace_connection_id, inventory_sku",
    )
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .not("platform_offer_id", "is", null)
    .in("listing_status", ["active", "relisted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const listing = listingRow as
    | {
        id: string;
        listing_title: string | null;
        platform_offer_id: string | null;
        platform_category_id: string | null;
        item_specifics_override: Record<string, unknown> | null;
        ebay_condition: string | null;
        ebay_condition_description: string | null;
        listing_description: string | null;
        listing_status: string | null;
        listing_origin: string | null;
        marketplace_connection_id: string | null;
        // US-1999 (00477): the SKU this listing went live under.
        inventory_sku: string | null;
      }
    | null;
  if (!listing?.platform_offer_id) {
    return { resynced: false, reason: "no_live_listing" };
  }
  if (listing.listing_origin === "ebay") {
    return { resynced: false, reason: "ebay_origin" };
  }

  const offerId = listing.platform_offer_id;
  const categoryId = listing.platform_category_id ??
    (item.ebay_category_id as string | null) ?? null;

  // 3) Rebuild the aspect map from the columns (US-1088), then FORCE-assert the
  //    grade specific over whatever is live (US-1502 overwrite).
  const baseAspects = normalizeAspectMap(
    listing.item_specifics_override ??
      (item.ebay_aspects as Record<string, unknown> | null),
  );
  let aspectList: AspectSpecRaw[] | null = null;
  if (categoryId) {
    try {
      const resp = await getCategoryAspects(categoryId);
      const raw = (resp.aspects as Record<string, unknown>).aspects;
      if (Array.isArray(raw)) aspectList = raw as AspectSpecRaw[];
    } catch (err) {
      console.warn(
        "[flipdesk-ebay] grade-resync aspect spec fetch (non-blocking):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const aspects = forceColumnAspects(
    item as unknown as RegistryItem,
    aspectList,
    baseAspects,
  );

  // 4) Promote the CURRENT live/mirror description with the cert line.
  const baseDesc = (
    listing.listing_description ??
    (item.description as string | null) ??
    (item.title as string | null) ??
    ""
  ).trim();
  const promotedDesc = await applyGradeListingPromotion(
    {
      grade_value: item.grade_value,
      certificate_url: item.certificate_url as string | null,
    },
    aspects,
    baseDesc,
    { force: true },
  );

  // 5) Condition (same rule as publish/revise) + photos for the full re-PUT
  //    (createOrReplaceInventoryItem REPLACES the item, so we send full state).
  let condition = listing.ebay_condition?.trim() ||
    mapEbayCondition(item.grade_value, item.grade_label as string | null);
  if (categoryId) {
    try {
      const { conditionIds } = await getItemConditionPolicies(categoryId);
      // US-1894: apparel-aware resolve + allow-list remap; explicit value wins.
      const remapped = resolveEbayCondition({
        explicit: listing.ebay_condition,
        grade: item.grade_value,
        label: item.grade_label as string | null,
        allowedConditionIds: conditionIds,
      });
      if (remapped && remapped !== condition) condition = remapped;
    } catch { /* best-effort — leave the resolved condition */ }
  }
  const conditionDescription =
    (listing.ebay_condition_description ??
      (item.condition_notes as string | null) ??
      "").trim() || undefined;

  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("storage_path, photo_url, photo_type, photo_role, sort_order")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });
  // US-1549: 'internal' photos (price tags, receipts) never go to eBay.
  const imageUrls = toEbayImageUrls(
    filterEbayPhotos(
      (photoRows ?? []) as Array<{
        storage_path: string | null;
        photo_url: string | null;
        photo_type: string | null;
      }>,
    ).map(ebayPublicPhotoUrl),
  );

  // US-1999: re-PUT the inventory item eBay actually has, not whatever the
  // seller's item number says today. This path is automated (it fires on grade
  // completion), so a mismatch here would silently create orphan inventory
  // items with no human in the loop to notice.
  const sku = resolveInventorySku(listing, { id: itemId, sku: item.sku as string | null });
  const finalTitle = (
    listing.listing_title ?? (item.title as string | null) ?? ""
  ).trim();

  // 6) Push to eBay. On failure, persist it on the listing (US-1079 retry banner)
  //    and report back — the caller keeps grade completion succeeding regardless.
  try {
    // US-1507: push via the listing's own connection (null → primary).
    const connId = listing.marketplace_connection_id ?? undefined;
    await createOrReplaceInventoryItem(userId, sku, {
      product: {
        title: finalTitle,
        description: promotedDesc,
        aspects: Object.keys(aspects).length > 0 ? aspects : undefined,
        imageUrls,
        brand:
          typeof item.brand === "string" && (item.brand as string).trim()
            ? (item.brand as string).trim()
            : "Unbranded",
        mpn: "Does Not Apply",
      },
      condition,
      conditionDescription,
      availability: { shipToLocationAvailability: { quantity: 1 } },
    }, connId);
    await updateOfferFields(userId, offerId, {
      listingDescription: promotedDesc,
      categoryId: categoryId ?? undefined,
    }, connId);
  } catch (err) {
    console.error("[flipdesk-ebay] grade-resync eBay push failed:", err);
    await persistReviseFailure(listing.id, err);
    return { resynced: false, reason: "ebay_error" };
  }

  // 7) Persist the rebuilt aspects + promoted description so the composer and the
  //    next publish/revise stay in sync.
  await supabaseAdmin
    .from("listings")
    .update({ item_specifics_override: aspects, listing_description: promotedDesc })
    .eq("id", listing.id);
  await supabaseAdmin
    .from("inventory_items")
    .update({ ebay_aspects: aspects })
    .eq("id", itemId);

  return { resynced: true };
}
