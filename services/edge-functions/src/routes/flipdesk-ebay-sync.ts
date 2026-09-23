// eBay routes: the listings pull, sync history, performance sync and the legacy-listing migrate.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  maybeFireImmediateConsignorPayout,
  reverseConsignorPayoutsForSales,
} from "../lib/consignor-payout.ts";
import {
  bulkMigrateListing,
  ebayListingUrl,
  getCategoryName,
  getTrafficReport,
  TrafficReportShapeError,
  isAnalyticsAccessDenied,
  isEbayConfigured,
  listAllOffers,
  listRecentOrders,
  listRecentTransactions,
  type RemoteOffer,
  type RemoteOrder,
  type RemoteOrderLineItem,
  type RemoteTransaction,
  getOrderTracking,
  type OrderTracking,
} from "../lib/ebay-client.ts";
import {
  absentListingState,
  type EbayListingState,
  resolveEbayListingState,
  resolveOrderOutcome,
} from "../lib/ebay-listing-state.ts";
import { runOrderReport, shouldUseFeedForOrders } from "../lib/ebay-feed.ts";
import { type FailedOrder, planOrdersWatermark } from "../lib/sync-watermark.ts";
import { emitEvent } from "../lib/user-events.ts";
import { autoEndCrossListings } from "../lib/cross-listings.ts";
import { recordEbaySale } from "../lib/passport-sale.ts";
import { recordSourceObservations, type SourceObservation } from "../lib/sync-conflicts.ts";
import { markListingPromptSold } from "../lib/listing-acceptance.ts";
import {
  type ExistingSaleRow,
  normalizeUnitCount,
  pickSaleRowForLine,
} from "../lib/ebay-order-lines.ts";
import {
  needsTrackingLookup,
  resolveShipBy,
  resolveShippedAt,
  trackingPatch,
} from "../lib/ship-deadline.ts";
import {
  getAllActiveEbaySelling,
  getItemDetails,
  type LegacyEbayListing,
} from "../lib/ebay-trading.ts";
import {
  ADOPTION_DEFAULT_ITEM_CATEGORY,
  buildCatalogPatch,
  type CatalogPatch,
  FILL_IF_BLANK_FIELDS,
  flattenAspects,
  type LocalCatalog,
} from "../lib/ebay-catalog-merge.ts";
import { itemCategoryFromEbayPath } from "../lib/ebay-item-category.ts";
import {
  adoptOrphans,
  type OrphanCandidate,
  planOrphanAdoption,
} from "../lib/ebay-orphan-adopt.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { claimSyncRun, failSyncRun } from "../lib/sync-run-lock.ts";
import { failSafe } from "../lib/http-errors.ts";
import {
  deriveListingOrigin,
  EBAY_OWNED_LISTING_FIELDS,
  LISTING_PULL_ALLOWED_ON_GT_ORIGIN,
} from "../lib/sync-precedence.ts";
import { itemHasActiveListing, resyncItemListedStatus } from "../lib/active-listings.ts";
import { mirrorEbayPhotos } from "../lib/ebay-photo-sync.ts";
// US-1999: one derivation rule, and the published SKU wins over item.sku.
import { deriveInventorySku } from "../lib/ebay-sku.ts";
// US-1968: existing-listing migration (pure response parsing + eBay's 5/call cap).
import { chunkForMigrate, parseMigrateResponse } from "../lib/ebay-migrate.ts";
import {
  notifyListingEnded,
  notifyListingLive,
  notifySaleRecorded,
} from "../lib/selling-activity-notify.ts";
import {
  getLowStockThreshold,
  notifyStockLevel,
  type StockEvent,
} from "../lib/inventory-monitor.ts";
import {
  EBAY_CONNECTION_SCAN_CAP,
  type EbayEnv,
  type ListingVariations,
  normalizeVariations,
  variantSku,
} from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// US-1968: how many listings one migrate REQUEST may carry. eBay's own cap is 5
// per CALL (chunkForMigrate enforces that); this is the separate cap on how many
// calls one HTTP request will fan out to, so a single request can't sit there
// making 40 sequential eBay calls and time out. The UI migrates in pages.
const MIGRATE_MAX_PER_REQUEST = 50;

// ── US-151: listing-performance sync (views / watchers / impressions) ──
//
// POST /api/flipdesk/ebay/sync/performance — internal cron (every 6h via
// US-131 scheduler). Pulls Sell Analytics getTrafficReport per active eBay
// connection and writes engagement metrics onto that seller's active listings.
//
// Sell Analytics is a separate grant; sellers on a pre-scope token get a 403.
// We treat that as "access not granted" (flag the connection, skip) rather than
// a failure so one un-upgraded seller never fails the whole batch. The UI reads
// marketplace_connections.analytics_access_denied to prompt a reconnect.

interface PerfListingRow {
  id: string;
  platform_listing_id: string | null;
  watchers: number;
  views_total: number;
  view_trend_7d: Array<{ date: string; views: number }> | null;
}

/** Pull metrics for one seller and write them onto their active eBay listings.
 *  Returns the per-user outcome for the batch summary. */
async function syncListingPerformanceForUser(
  userId: string,
): Promise<{ updated: number; accessDenied: boolean }> {
  let traffic;
  try {
    traffic = await getTrafficReport(userId);
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) {
      await supabaseAdmin
        .from("marketplace_connections")
        .update({ analytics_access_denied: true })
        .eq("user_id", userId)
        .eq("marketplace", "ebay");
      return { updated: 0, accessDenied: true };
    }
    // US-2835: a response we cannot parse is now LOUD and is not fatal to the
    // batch. It must not take down every other seller's sync, and it must not
    // be swallowed either — the whole point of the story is that this failure
    // mode previously produced plausible zeros and no signal at all.
    if (err instanceof TrafficReportShapeError) {
      console.error(
        "[flipdesk-ebay] traffic_report shape not understood for user",
        userId,
        "-",
        err.message,
      );
      return { updated: 0, accessDenied: false };
    }
    throw err;
  }

  // Access worked — clear any stale denial flag.
  await supabaseAdmin
    .from("marketplace_connections")
    .update({ analytics_access_denied: false })
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("analytics_access_denied", true);

  const byListingId = new Map(traffic.map((t) => [t.listingId, t]));

  // This seller's active eBay listings (tenant-scoped via inventory_items —
  // listings has no user_id of its own, US-268).
  const { data: listingRows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_listing_id, watchers, views_total, view_trend_7d, inventory_items!inner(user_id)",
    )
    .eq("platform", "ebay")
    .eq("listing_status", "active")
    .eq("inventory_items.user_id", userId)
    .not("platform_listing_id", "is", null);

  const rows = (listingRows ?? []) as unknown as PerfListingRow[];
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  let updated = 0;

  // US-565: per-day time-series rows behind the listings snapshot columns. One
  // row per (listing, today); upsert so a re-run within the day overwrites.
  const metricRows: Array<{
    listing_id: string;
    user_id: string;
    metric_date: string;
    impressions: number;
    views: number;
    watchers: number;
    click_through_rate: number | null;
  }> = [];

  for (const row of rows) {
    const metrics = row.platform_listing_id
      ? byListingId.get(row.platform_listing_id)
      : undefined;

    // watchers_count mirrors the watcher total kept fresh by the listings pull
    // (getTrafficReport doesn't return watchers) so the analytics columns are
    // self-contained. Stamp every active listing; layer traffic on when eBay
    // reported engagement for it.
    const patch: Record<string, unknown> = {
      watchers_count: row.watchers ?? 0,
      last_metrics_synced_at: nowIso,
    };

    // US-2835: views/impressions are now `number | null`, where null means eBay
    // did not report the metric rather than reported it as nothing. A listing
    // with neither is skipped entirely: writing it as 0/0 is what produced
    // 7,352 rows of zeros that read exactly like six weeks of no traffic.
    //
    // ⚠ THE REMAINING `?? 0` IS A KNOWN, BOUNDED COMPROMISE. listing_metrics
    // and the listings snapshot columns are `integer NOT NULL DEFAULT 0`
    // (00136/00159), so a half-reported record cannot store its missing half
    // honestly without a migration to make them nullable. That case is only
    // reachable when eBay sends one metric and withholds another, which the
    // all-null skip above already excludes the common form of. Making those
    // columns nullable is the proper fix and is deliberately not smuggled into
    // a bug fix.
    if (metrics && (metrics.views != null || metrics.impressions != null)) {
      // Rolling 7-day sparkline series: one point per day, latest snapshot
      // wins, keep the most recent 7.
      const prev = Array.isArray(row.view_trend_7d) ? row.view_trend_7d : [];
      const trend = prev.filter((p) => p && p.date !== today);
      trend.push({ date: today, views: metrics.views ?? 0 });
      patch.views_total = metrics.views ?? 0;
      patch.impressions_7d = metrics.impressions ?? 0;
      patch.click_through_rate = metrics.clickThroughRate;
      patch.view_trend_7d = trend.slice(-7);

      metricRows.push({
        listing_id: row.id,
        user_id: userId,
        metric_date: today,
        impressions: metrics.impressions ?? 0,
        views: metrics.views ?? 0,
        watchers: row.watchers ?? 0,
        click_through_rate: metrics.clickThroughRate,
      });
    }

    const { error } = await supabaseAdmin
      .from("listings")
      .update(patch)
      .eq("id", row.id);
    if (!error) updated += 1;
  }

  // Persist the day's time-series rows in one upsert (US-565). Best-effort: a
  // metrics-history write must never fail the snapshot sync above.
  if (metricRows.length > 0) {
    const { error: metricsErr } = await supabaseAdmin
      .from("listing_metrics")
      .upsert(metricRows, { onConflict: "listing_id,metric_date" });
    if (metricsErr) {
      console.error(
        "[flipdesk-ebay] listing_metrics upsert failed:",
        metricsErr.message,
      );
    }
  }

  return { updated, accessDenied: false };
}

flipdeskEbayRoutes.post("/sync/performance", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  const { data: conns, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-2387: bounded, and ordered so the scanned set is STABLE run to run. An
    // unordered cap would sync a different arbitrary subset each tick, which is
    // worse than syncing fewer — a seller could go unscanned indefinitely.
    .order("user_id", { ascending: true })
    .limit(EBAY_CONNECTION_SCAN_CAP);
  if (error) {
    console.error("[flipdesk-ebay] performance scan failed:", error);
    return c.json({ error: "Performance scan failed" }, 500);
  }

  const userIds = Array.from(
    new Set(((conns ?? []) as { user_id: string }[]).map((r) => r.user_id)),
  );

  let updated = 0;
  let accessDenied = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      const r = await syncListingPerformanceForUser(userId);
      updated += r.updated;
      if (r.accessDenied) accessDenied += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[flipdesk-ebay] performance sync failed for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return c.json({ scanned: userIds.length, updated, accessDenied, failed });
});

// POST /api/flipdesk/ebay/sync/performance/me — user-facing "Sync now" (US-2233).
// The 6h cron above is job-secret only; this lets a seller refresh their OWN
// listing metrics on demand instead of waiting. Tenant-scoped: it only ever
// touches the caller's listings — syncListingPerformanceForUser writes are keyed
// on ownerId's active listings (via inventory_items, US-268), and the id comes
// from the auth context, never the request body.
flipdeskEbayRoutes.post("/sync/performance/me", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const { updated, accessDenied } = await syncListingPerformanceForUser(ownerId);
    return c.json({ updated, accessDenied });
  } catch (err) {
    console.error(
      `[flipdesk-ebay] on-demand performance sync failed for ${ownerId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Performance sync failed" }, 500);
  }
});


// ── eBay sync helpers ──────────────────────────────────────────────

// Pulls every offer for the connected seller from the Sell Inventory API.
// Each offer's SKU is matched to inventory_items.sku for THIS user:
//   • match → upsert into `listings` (and forward inventory_items.status to 'listed' when active)
//   • no match → snapshot into `flipdesk_ebay_listings` so the user can see
//     orphaned eBay listings on the Reconciliation page.
// ── Background sync helper ─────────────────────────────────────────
// One row per sync run, written to flipdesk_sync_runs (migration 00073) so the
// Reconciliation page can show a history of what each pull did. Best-effort:
// a logging failure here must never break the sync that already ran.
interface SyncRunStats {
  startedAt: string;
  since: string | null;
  status: "success" | "partial" | "failed";
  total: number;
  matched: number;
  unmatched: number;
  skipped: number;
  legacyMatched: number;
  legacyUnmatched: number;
  legacyDuplicates: number;
  salesNew: number;
  salesUpdated: number;
  salesSkipped: number;
  salesEnriched: number;
  // US-459: cancelled/refunded sale line items handled this run.
  salesReversed: number;
  errors: string[];
}

// Finalize a run. When `runId` is present (the normal path) this UPDATES the
// `running` row claimed by claimSyncRun; otherwise it falls back to an INSERT.
async function recordSyncRun(
  userId: string,
  s: SyncRunStats,
  runId: string | null = null,
): Promise<void> {
  const fields = {
    status: s.status,
    listings_total: s.total,
    listings_matched: s.matched,
    listings_unmatched: s.unmatched,
    listings_skipped: s.skipped,
    legacy_matched: s.legacyMatched,
    legacy_unmatched: s.legacyUnmatched,
    legacy_duplicates: s.legacyDuplicates,
    sales_new: s.salesNew,
    sales_updated: s.salesUpdated,
    sales_skipped: s.salesSkipped,
    sales_enriched: s.salesEnriched,
    sales_reversed: s.salesReversed,
    error_count: s.errors.length,
    errors: s.errors.slice(0, 50),
    since: s.since,
    started_at: s.startedAt,
    finished_at: new Date().toISOString(),
  };
  try {
    if (runId) {
      await supabaseAdmin
        .from("flipdesk_sync_runs")
        .update(fields)
        .eq("id", runId);
    } else {
      await supabaseAdmin
        .from("flipdesk_sync_runs")
        .insert({ user_id: userId, marketplace: "ebay", ...fields });
    }
  } catch (err) {
    console.error("[flipdesk-ebay] failed to record sync run:", err);
  }
}

// Snapshot a sale we pulled from eBay but couldn't match to a FlipDesk
// inventory_item (no SKU match, no eBay item-id match). Without this the sale
// was silently dropped, understating Sold totals and making a "full sales"
// backfill lossy. Upsert is idempotent under retries via the unique
// (user_id, platform_order_id, line_item_id) key.
async function snapshotOrphanSale(
  userId: string,
  order: RemoteOrder,
  li: RemoteOrderLineItem,
): Promise<void> {
  try {
    await supabaseAdmin.from("flipdesk_ebay_orphan_sales").upsert(
      {
        user_id: userId,
        platform_order_id: order.orderId,
        line_item_id: li.lineItemId ?? "",
        ebay_item_id: li.legacyItemId,
        sku: li.sku,
        title: li.title,
        quantity: normalizeUnitCount(li.quantity),
        // li.itemCost is the EXTENDED line total (unit price × quantity); store
        // it as-is — it is already the line revenue, not a per-unit figure.
        sale_price: li.itemCost ? Number(li.itemCost.value) : null,
        shipping_collected: li.shippingCost
          ? Number(li.shippingCost.value)
          : null,
        tax: li.taxes ? Number(li.taxes.value) : null,
        buyer_username: order.buyerUsername,
        sold_at: order.creationDate,
        currency: li.itemCost?.currency ?? "USD",
        raw: { orderPaymentStatus: order.orderPaymentStatus },
        match_status: "unmatched",
        imported_at: new Date().toISOString(),
      },
      { onConflict: "user_id,platform_order_id,line_item_id" },
    );
  } catch (err) {
    console.error("[flipdesk-ebay] failed to snapshot orphan sale:", err);
  }
}

// Extracted from the /listings/pull handler so we can fire it as a
// detached promise and return 202 immediately.  The sync typically takes
// 60-120s (N eBay API calls + Supabase writes) which exceeds Cloudflare's
// 100s proxy timeout.  Returning 202 prevents the 524 → CORS-error cycle
// the browser would otherwise see.
/**
 * US-3110: what a pull is allowed to read from eBay.
 *
 * "full" is the historical behaviour — read every offer in the catalog (one
 * `GET /sell/inventory/v1/offer?sku=` per SKU) and every active legacy listing
 * (GetMyeBaySelling), then reconcile orders.
 *
 * "orders" skips both of those and goes straight to the orders pass. The order
 * backstop and the notification-driven sync only ever need orders, and paying a
 * whole-catalog read to find one is what put us at 25,312 Inventory calls and
 * 98.8% of the Trading quota on two connected sellers.
 */
export type EbaySyncScope = "full" | "orders";

/**
 * US-3110: how long an orders-only pull may run before it upgrades itself to a
 * full catalog read.
 *
 * eBay-side edits a seller makes in Seller Hub (a price change, a listing ended
 * by hand) reach us ONLY through the offer catalog, so this is the longest we
 * can be wrong about them. Six hours turns ~41 full catalog reads a day into 4
 * per connection while leaving the notification stream to carry anything
 * time-sensitive.
 */
export const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * US-3110: how long a GetItem specifics answer counts as current.
 *
 * The fill is fill-if-blank, so the only reason to re-ask is that the seller
 * edited the listing on eBay and added an aspect we lack. That is rare and not
 * urgent; a fortnight is generous. The point is that "eBay has no Material for
 * this shirt" is an answer worth remembering, not a question worth re-asking 41
 * times a day.
 */
export const SPECIFICS_RECHECK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * US-3111: how long a per-SKU offer read counts as current.
 *
 * The fan-out is one `GET /sell/inventory/v1/offer?sku=` per SKU across eBay's
 * whole inventory list, and most of those SKUs have no Inventory-API offer at
 * all — they are Seller-Hub listings created through Trading, so the call
 * returns nothing every time it is made.
 *
 * A day is the right window because of what the offer read UNIQUELY provides.
 * Price, quantity, title, category and listing status for ACTIVE listings come
 * from GetMyeBaySelling in about seven paged calls on the same pass, so none of
 * that goes stale. What the offer read alone tells us is the offer-level detail
 * and that a listing ENDED without selling — and eBay publishes no notification
 * topic for a listing ending, so polling is the only way we ever learn it. A
 * day late on moving an unsold listing back to Drafts is a fair trade for
 * roughly three quarters of the catalog's call volume.
 */
export const OFFER_RECHECK_MS = 24 * 60 * 60 * 1000;

interface OfferCheckRow {
  sku: string | null;
  ebay_offer_checked_at: string | null;
}

// -- US-3362: resolving an eBay SKU to a local item ----------------------
//
// THE BUG THIS REGION EXISTS FOR. The catalog pass used to resolve every eBay
// SKU through `inventory_items.sku` alone. eBay is not keyed on that column -
// it is keyed on `listings.inventory_sku`, the value `deriveInventorySku` minted
// at publish. The two agree only when the seller typed a SKU and never changed
// it, and the composer's SKU field is optional, so a blank one publishes as
// `FD-<8 hex>` against a local row holding NULL. Four classes could not resolve:
//
//   Minted   - blank SKU at publish, so eBay holds FD-xxxxxxxx and we hold NULL
//   Renamed  - the seller edited sku after publishing (the case 00477 exists for)
//   Variant  - eBay holds variantSku(base, v); only the base is stored
//   Foreign  - another tool's listing, or a locally deleted item
//
// An unresolved SKU is not merely an extra call. The item's OWN live listing is
// filed as an orphan, and ended-without-sale never fires for it, because both
// `endedItemIds.add` sites sit behind a resolved item id - so a listing ends on
// eBay and FlipDesk goes on showing it as listed.
//
// The lookup needs no migration: 00477 already created
// `idx_listings_user_inventory_sku ON listings (user_id, inventory_sku)
//  WHERE inventory_sku IS NOT NULL` for exactly this.

/** An inventory row as far as SKU resolution is concerned. */
export interface SkuIndexItem {
  id: string;
  sku: string | null;
}

/** A listing row as far as SKU resolution is concerned. */
export interface SkuIndexListing {
  inventory_item_id: string | null;
  /** The SKU eBay actually holds this listing under (pinned at publish). */
  inventory_sku: string | null;
  /** US-568 variation matrix; eBay holds one SKU per variant, not the base. */
  variations: ListingVariations | null;
}

/**
 * Pure: every SKU eBay could name for this seller, mapped to the local item.
 *
 * Precedence runs from what eBay is KNOWN to hold down to what it can be
 * inferred to hold, and an earlier pass always wins:
 *
 *   1. `listings.inventory_sku` - authoritative, written at publish time.
 *   2. `variantSku(inventory_sku, v)` - what a group listing's members are.
 *   3. `inventory_items.sku` - today's value; right until it was edited.
 *   4. `deriveInventorySku(item)` - reproduces what a blank-SKU publish minted,
 *      and covers a row that predates 00477's `inventory_sku` backfill.
 *
 * Listing rows are expected newest-first, so the most recent listing wins a
 * SKU two rows both claim. Rule 3 losing to rule 1 is the Renamed case and is
 * deliberate: if item A now carries a SKU that item B was published under, eBay
 * still holds it for B.
 *
 * Pure so the join can be proved without a database - a resolution that
 * silently matches nothing is exactly the failure this replaces.
 */
export function buildEbaySkuIndex(
  items: readonly SkuIndexItem[],
  listings: readonly SkuIndexListing[],
): Map<string, string> {
  const index = new Map<string, string>();
  const claim = (sku: string | null | undefined, itemId: string): void => {
    const key = sku?.trim();
    if (!key || !itemId) return;
    if (!index.has(key)) index.set(key, itemId);
  };
  for (const l of listings) {
    if (l.inventory_item_id) claim(l.inventory_sku, l.inventory_item_id);
  }
  for (const l of listings) {
    const base = l.inventory_sku?.trim();
    if (!base || !l.inventory_item_id) continue;
    // normalizeVariations is what the publish path itself runs before minting
    // variant SKUs, so using it here keeps the two in lockstep. A matrix that
    // has since fallen below two purchasable variants yields nothing, which is
    // the same answer publish would give today.
    const matrix = normalizeVariations(l.variations);
    if (!matrix) continue;
    for (const v of matrix.variants) {
      claim(variantSku(base, v), l.inventory_item_id);
    }
  }
  for (const it of items) claim(it.sku, it.id);
  for (const it of items) claim(deriveInventorySku(it), it.id);
  return index;
}

/**
 * Pure: the offer-recheck rows `selectSkusToSkip` needs, in eBay-SKU space.
 *
 * `ebay_offer_checked_at` is stamped on the ITEM, but the skip set is consumed
 * by `listAllOffers`, which only ever sees eBay's SKUs. Expanding one item's
 * timestamp across every SKU the index maps to it is what lets a Minted or
 * Variant SKU enter the skip set at all - before US-3362 those SKUs could
 * never be stamped, so they were re-read on every pass forever.
 */
export function offerCheckRowsForIndex(
  items: readonly { id: string; ebay_offer_checked_at: string | null }[],
  index: ReadonlyMap<string, string>,
): OfferCheckRow[] {
  const stampByItem = new Map<string, string | null>();
  for (const it of items) stampByItem.set(it.id, it.ebay_offer_checked_at);
  const rows: OfferCheckRow[] = [];
  for (const [sku, itemId] of index) {
    const at = stampByItem.get(itemId);
    if (at) rows.push({ sku, ebay_offer_checked_at: at });
  }
  return rows;
}

export interface OfferStampPlan {
  /** Unique inventory_items.id values to stamp, in first-seen order. */
  itemIds: string[];
  /** Every read SKU that resolved to a given item, for reporting back. */
  skusByItemId: Map<string, string[]>;
  /** Read SKUs with no local item at all - the Foreign residue. */
  unresolved: string[];
}

/**
 * Pure: turn the SKUs a pass read into the rows the stamp should address.
 *
 * The stamp used to be `.in("sku", chunk)`, which is the same wrong column the
 * resolution used, so it could match zero rows without erroring (PostgREST
 * answers 200 with an empty body). Keying it on the resolved id means it can
 * only miss for a SKU that genuinely has no local item, and `unresolved` names
 * exactly that set rather than leaving it as an unexplained gap.
 */
export function planOfferStamp(
  readSkus: readonly string[],
  index: ReadonlyMap<string, string>,
): OfferStampPlan {
  const itemIds: string[] = [];
  const skusByItemId = new Map<string, string[]>();
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const sku of readSkus) {
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    const itemId = index.get(sku);
    if (!itemId) {
      unresolved.push(sku);
      continue;
    }
    const existing = skusByItemId.get(itemId);
    if (existing) {
      existing.push(sku);
    } else {
      skusByItemId.set(itemId, [sku]);
      itemIds.push(itemId);
    }
  }
  return { itemIds, skusByItemId, unresolved };
}

/**
 * How many characters of `in.(...)` payload one PostgREST request may carry.
 *
 * Kong fronts prod's PostgREST with nginx defaults, so the whole request LINE -
 * method, path, query string and HTTP version - has to fit an 8 KB buffer. 4000
 * leaves better than half of that for the scheme, host, path,
 * `user_id=eq.<uuid>`, `select=`, and the percent-encoding of everything else.
 */
export const IN_FILTER_CHAR_BUDGET = 4000;

/**
 * Pure: split ids into chunks no PostgREST request line can choke on.
 *
 * THE BUG THIS EXISTS FOR, and why a fixed row count was never the right unit.
 * US-3111 chunked the offer stamp at 400 per request and that was comfortably
 * safe - for SKUs, which are short (`FD-1a2b3c4d` encodes to 14 characters with
 * its separator). US-3362 then re-keyed the same stamp onto
 * `inventory_items.id` to fix a resolution bug, and a uuid encodes to 39. The
 * constant did not move, so the payload went from ~5,600 characters to ~15,600
 * and Kong began answering **414 URI too long** to every stamp.
 *
 * Measured on prod 2026-09-13: both `ebay_offer_checked_at` and
 * `ebay_specifics_checked_at` had failed on every catalog pass since US-3362
 * deployed, the newest stamp in the table was 40 hours old, and the recheck
 * window this story exists to enforce had quietly reverted to the full fan-out
 * it replaced.
 *
 * So the chunk is measured in CHARACTERS, not rows. A future change of key -
 * uuid to composite, sku to slug - cannot re-break it, because the thing the
 * limit is actually about is now the thing being counted.
 *
 * An id that busts the budget on its own is still emitted, alone. Dropping it
 * would silently unstamp a row, which is the failure mode this whole path is
 * built to make loud.
 */
export function chunkIdsForInFilter(
  ids: readonly string[],
  budget: number = IN_FILTER_CHAR_BUDGET,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const id of ids) {
    // The value as it lands in the query string, plus the comma PostgREST needs
    // between entries (URLSearchParams encodes that comma as `%2C`).
    const cost = encodeURIComponent(id).length + 3;
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(id);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The offer fields the catalog pass routes on. */
export interface RoutableOffer {
  sku: string | null;
  listingId: string | null;
  listingStatus: string | null;
  availableQuantity: number | null;
}

/** The local listing fields the routing decision reads. */
export interface RoutableLocalListing {
  is_active: boolean | null;
  listing_status: string | null;
}

export type OfferRouting =
  /** eBay says this listing is live -> flip the item to 'listed'. */
  | { kind: "listed"; itemId: string; state: EbayListingState }
  /** eBay says it is not live -> Path A moves the item back to Drafts. */
  | { kind: "ended"; itemId: string; state: EbayListingState }
  /** No local item for this SKU -> snapshot it on Reconciliation. */
  | { kind: "orphan"; listingId: string }
  /** A genuine unpublished draft. Nothing to reconcile. */
  | { kind: "skipped" };

/**
 * Pure: what a catalog pass should do with one remote offer.
 *
 * US-3362 pulled this out of the loop because the ended-without-sale path is
 * the story's seller-facing bug and it CANNOT BE PROVED BY A SOURCE SCAN. Both
 * `endedItemIds.add` sites sit behind a resolved item id, so a test that greps
 * for `endedItemIds` passes just as happily when the resolution is broken and
 * nothing ever reaches them. Driving this function with a Minted SKU is the
 * only way to show the item actually gets there.
 *
 * `itemId` is the caller's resolution through {@link buildEbaySkuIndex}; this
 * function never resolves a SKU itself, so wiring the wrong index still shows
 * up here as `orphan`.
 */
export function routeRemoteOffer(
  offer: RoutableOffer,
  itemId: string | null,
  localListing: RoutableLocalListing | null,
): OfferRouting {
  if (!offer.listingId) {
    // No live listingId is normally a genuine draft. But when we still hold a
    // LIVE local listing for this SKU, eBay has just told us it is no longer
    // live: it ended, sold out, or was removed for a policy issue (eBay drops a
    // policy-removed listing out of the active feed entirely). Absence is its
    // own fact, distinct from any status eBay could have sent.
    const localIsLive = localListing
      ? localListing.is_active === true || localListing.listing_status === "active"
      : false;
    if (itemId && localIsLive) {
      return { kind: "ended", itemId, state: absentListingState() };
    }
    return { kind: "skipped" };
  }
  if (!itemId) return { kind: "orphan", listingId: offer.listingId };
  // US-2656 / US-2684: eBay's own word and what it means, with the quantity
  // riding along because a cancelled order leaves availableQuantity at 0 while
  // listingStatus still reads ACTIVE.
  const state = resolveEbayListingState(offer.listingStatus, offer.availableQuantity);
  return state.isActive
    ? { kind: "listed", itemId, state }
    : { kind: "ended", itemId, state };
}

/**
 * Pure: which SKUs a catalog pass may skip.
 *
 * Separated from the query so the window arithmetic — the part that decides
 * whether we spend a thousand eBay calls — is testable without a database. A
 * row with no timestamp, or an unparseable one, is never skipped: failing
 * toward an extra read is the cheap direction.
 */
export function selectSkusToSkip(
  rows: readonly OfferCheckRow[],
  nowMs: number,
  windowMs: number = OFFER_RECHECK_MS,
): Set<string> {
  const skip = new Set<string>();
  for (const row of rows) {
    if (!row.sku || !row.ebay_offer_checked_at) continue;
    const at = Date.parse(row.ebay_offer_checked_at);
    if (!Number.isFinite(at)) continue;
    // A timestamp in the future is a clock problem, not a fresh read. Treating
    // it as fresh would skip the SKU until the clock caught up.
    if (at > nowMs) continue;
    if (nowMs - at < windowMs) skip.add(row.sku);
  }
  return skip;
}

/**
 * How many unstamped SKUs a pass may name in its log line. Bounded for the same
 * reason the marketplace-event sweep bounds its error list: a catalog that
 * stamps nothing at all would otherwise print a thousand SKUs every six hours,
 * and the first ten say what the last thousand say.
 */
export const MAX_LOGGED_UNSTAMPED_SKUS = 10;

export interface OfferStampCoverage {
  read: number;
  stamped: number;
  unstamped: number;
  sample: string[];
}

/**
 * US-3110: did the offer-read stamp actually land?
 *
 * The stamp is `update(inventory_items).eq(user_id).in(sku, chunk)`, and an
 * UPDATE that matches NO ROW is not an error: PostgREST returns 200 and an
 * empty body. So a SKU that eBay's inventory list names but that has no local
 * `inventory_items` row (an orphan listing, a locally-deleted item, a SKU eBay
 * minted when it migrated a Seller-Hub listing) costs a call on EVERY pass,
 * stamps nothing, is never in the skip set, and is re-read forever. That is the
 * same shape as the item-specifics bug US-3110 fixed and the per-SKU offer bug
 * US-3111 fixed, one level down: the negative answer has nowhere to go.
 *
 * US-3111 AC4 promised a FAILED stamp write is logged rather than swallowed.
 * A stamp that succeeds while matching zero rows is not a failed write, so that
 * promise never covered the case that actually happens. This makes the gap a
 * number instead of an inference from the daily call total.
 *
 * Pure, so the arithmetic is provable without a database. `stamped` may name a
 * SKU absent from `read` (a concurrent pass stamped it); those are ignored
 * rather than subtracted, so the count can never go negative.
 */
export function unstampedOfferCoverage(
  read: readonly string[],
  stamped: readonly string[],
  sampleLimit: number = MAX_LOGGED_UNSTAMPED_SKUS,
): OfferStampCoverage {
  const landed = new Set(stamped);
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const sku of read) {
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    if (!landed.has(sku)) missing.push(sku);
  }
  return {
    read: seen.size,
    stamped: seen.size - missing.length,
    unstamped: missing.length,
    sample: sampleLimit > 0 ? missing.slice(0, sampleLimit) : [],
  };
}

async function doListingsPull(
  userId: string,
  connId: string,
  lastSyncedAt: string | null,
  backfill = false,
  // US-456: the 'running' lock row is claimed by the /listings/pull handler
  // (claimSyncRun) BEFORE this fires, so overlapping pulls are rejected. Both
  // finalizers below update it via runId; the handler's .catch fails it on an
  // unexpected throw. null only on the best-effort path where the claim errored.
  runId: string | null = null,
  scope: EbaySyncScope = "full",
): Promise<void> {
  // Gates the two active-listing passes AND, by consequence, the
  // ended-without-sale sweep: endedItemIds is populated only by those passes, so
  // an orders-only run leaves it empty and the sweep is a no-op. That ordering
  // is load-bearing — a run that skipped the catalog must never conclude that
  // every listing ended.
  const catalogPass = scope === "full";
  const startedAt = new Date().toISOString();
  // US-466: collects truncation warnings from the paginated eBay fetches (and,
  // below, per-item errors). Declared up here so the offers/inventory fetch can
  // record a ceiling hit; a non-empty list flips the run to "partial".
  const errors: string[] = [];

  // -- SKU resolution (US-3362) ----------------------------------------
  // Both preloads run BEFORE the eBay fetch, because the skip set that decides
  // which SKUs we spend a call on has to be expressed in eBay's SKUs, and that
  // translation is the index. They used to sit after the fetch and be read off
  // `inventory_items.sku` alone, which is the wrong column (see
  // buildEbaySkuIndex). Same two queries as before, two columns wider.
  //
  // Catalog fields come along so the sync can make eBay the source of truth
  // (title overwrite, brand/size/color/style/material fill-if-blank) without a
  // per-item read.
  type ItemRow = {
    id: string;
    sku: string | null;
    // US-3110: when GetItem was last asked about this item, whether or not eBay
    // had anything to give. See SPECIFICS_RECHECK_MS.
    ebay_specifics_checked_at: string | null;
    // US-3111: when we last spent an offer read on this item.
    ebay_offer_checked_at: string | null;
  } & LocalCatalog;
  const { data: itemRows, error: itemRowsError } = await supabaseAdmin
    .from("inventory_items")
    .select(
      // US-3468: ebay_aspects + ebay_category_id ride along so the pull can
      // mirror the FULL specifics map fill-if-blank per name, not just the
      // five clothing columns.
      "id, sku, title, brand, size, color, style, material, ebay_aspects, ebay_category_id, item_category, ebay_specifics_checked_at, ebay_offer_checked_at",
    )
    .eq("user_id", userId);
  if (itemRowsError) {
    // Load-bearing: with no catalog every eBay listing resolves to nothing and
    // the pass files the seller's whole inventory as orphans. Say so loudly and
    // flag the run partial rather than let that read as a clean sync.
    console.error(
      "[flipdesk-ebay] catalog preload failed:",
      itemRowsError.message,
    );
    errors.push(`catalog preload: ${itemRowsError.message.slice(0, 200)}`);
  }
  const allItems = (itemRows ?? []) as ItemRow[];
  const itemById = new Map<string, ItemRow>();
  for (const r of allItems) itemById.set(r.id, r);

  // US-405: this user's existing eBay listings, so the loops below join in
  // memory instead of a per-row SELECT. Tenant-scoped via the inner join on
  // inventory_items.user_id (listings has no user_id - US-268).
  type ExistingListingRow = {
    id: string;
    inventory_item_id: string;
    platform_listing_id: string | null;
    platform_offer_id: string | null;
    listing_url: string | null;
    listing_price: number | null;
    listing_status: string | null;
    listing_title: string | null;
    is_active: boolean | null;
    quantity: number | null;
    listed_at: string | null;
    listing_description: string | null;
    platform_category_id: string | null;
    // US-1081: provenance signals + drift marker. batch_id/synced_to_ebay_at
    // decide whether this listing is GradeThread-originated (GT is the source of
    // truth -> inbound pull must NOT overwrite eBay-owned editable fields; it only
    // records that eBay drifted in platform_fields.sync_drift).
    batch_id: string | null;
    synced_to_ebay_at: string | null;
    platform_fields: Record<string, unknown> | null;
    // US-1077: persisted provenance marker. Preserved on matched rows so a pull
    // can't relabel a GradeThread-originated listing as eBay-originated.
    listing_origin: string | null;
    // US-3362: the SKU eBay actually holds this listing under, and the variation
    // matrix whose members eBay holds under variantSku(). Both feed the index.
    inventory_sku: string | null;
    variations: ListingVariations | null;
  };
  const existingListingByItem = new Map<string, ExistingListingRow>();
  const { data: listingRows, error: listingRowsError } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform_listing_id, platform_offer_id, listing_url, listing_price, listing_status, listing_title, is_active, quantity, listed_at, listing_description, platform_category_id, batch_id, synced_to_ebay_at, platform_fields, listing_origin, inventory_sku, variations, created_at, inventory_items!inner(user_id)",
    )
    .eq("platform", "ebay")
    .eq("inventory_items.user_id", userId)
    .order("created_at", { ascending: false });
  if (listingRowsError) {
    console.error(
      "[flipdesk-ebay] listing preload failed:",
      listingRowsError.message,
    );
    errors.push(`listing preload: ${listingRowsError.message.slice(0, 200)}`);
  }
  const allListings = (listingRows ?? []) as unknown as ExistingListingRow[];
  for (const r of allListings) {
    // created_at desc -> the first row seen for an item is the most recent.
    if (r.inventory_item_id && !existingListingByItem.has(r.inventory_item_id)) {
      existingListingByItem.set(r.inventory_item_id, r);
    }
  }

  // Every SKU eBay could name, mapped to the local item. This is the fix for
  // US-3362: the pass used to consult `inventory_items.sku` and nothing else.
  const skuToItemId = buildEbaySkuIndex(allItems, allListings);

  // US-3458: the listing id is the other key eBay hands us, and it is the ONLY
  // key for a listing that was adopted from the orphan table or linked by hand
  // on the Reconciliation page, because those carry no Custom Label the SKU
  // index could resolve. Without this both passes filed such a listing as an
  // orphan again on every pull (harmless, the flip is preserved) and never
  // refreshed its price, quantity or status, so an adopted listing was a
  // snapshot from the day it was adopted. Consulted only after the SKU index,
  // which stays the authority when both answer.
  const listedEbayItemToItemId = new Map<string, string>();
  for (const r of allListings) {
    if (
      r.platform_listing_id && r.inventory_item_id &&
      !listedEbayItemToItemId.has(r.platform_listing_id)
    ) {
      listedEbayItemToItemId.set(r.platform_listing_id, r.inventory_item_id);
    }
  }
  const resolveListedItemId = (
    sku: string | null | undefined,
    ebayItemId: string | null | undefined,
  ): string | null =>
    (sku ? skuToItemId.get(sku) : undefined) ??
      (ebayItemId ? listedEbayItemToItemId.get(ebayItemId) : undefined) ??
      null;

  // US-3111: the SKUs whose offer we read recently enough to skip this pass.
  // Empty on any failure, so the worst case is the old behaviour of reading
  // every SKU - a wasted call beats a catalog that silently stops reconciling.
  const skipSkus = catalogPass
    ? selectSkusToSkip(
      offerCheckRowsForIndex(allItems, skuToItemId),
      Date.now(),
    )
    : new Set<string>();

  let offers: RemoteOffer[];
  let offerSkusRead: string[] = [];
  try {
    if (catalogPass) {
      const res = await listAllOffers(userId, errors, skipSkus);
      offers = res.offers;
      offerSkusRead = res.skusRead;
    } else {
      offers = [];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] listings/pull fetch failed:", msg);
    // Can't surface this to the client (we already returned 202), but
    // log it clearly so it shows up in Coolify's container logs — and record
    // a failed run so the user sees the attempt in the sync history.
    await recordSyncRun(userId, {
      startedAt,
      since: lastSyncedAt,
      status: "failed",
      total: 0,
      matched: 0,
      unmatched: 0,
      skipped: 0,
      legacyMatched: 0,
      legacyUnmatched: 0,
      legacyDuplicates: 0,
      salesNew: 0,
      salesUpdated: 0,
      salesSkipped: 0,
      salesEnriched: 0,
      salesReversed: 0,
      errors: [`fetch offers: ${msg.slice(0, 200)}`],
    }, runId);
    return;
  }

  // ── US-405: batched-write accumulators ──────────────────────────────
  // The offers + legacy passes below used to do a per-row SELECT, then an
  // INSERT/UPDATE, then a status flip — thousands of sequential PostgREST
  // round-trips on a large seller. Instead we pre-load existing listings into a
  // map (above, with the SKU index), accumulate every write in memory, and
  // flush them as a handful of bulk calls before the orders pass. This takes a
  // 1,000-offer sync from minutes to seconds.
  // Every column the offers/legacy passes may write to `listings`. Building a
  // FULL row for every insert AND edit (seeded from the pre-loaded snapshot,
  // then patched) keeps the upsert array uniform — and supplies all the
  // NOT NULL columns — so a single .upsert() on the primary key handles new
  // rows and updates in one round-trip.
  type ListingWrite = {
    id: string;
    inventory_item_id: string;
    platform: "ebay";
    platform_listing_id: string | null;
    platform_offer_id: string | null;
    listing_url: string | null;
    listing_price: number;
    listing_status: string | null;
    is_active: boolean;
    quantity: number | null;
    listed_at: string;
    listing_description: string | null;
    platform_category_id: string | null;
    listing_title: string | null;
    // US-1077: stamped on every flushed row — 'ebay' for new imports, preserved
    // for matched rows (a GradeThread-originated listing stays 'gradethread').
    listing_origin: "ebay" | "gradethread";
  };
  type OrphanWrite = {
    user_id: string;
    ebay_item_id: string;
    custom_label: string | null;
    title: string | null;
    current_price: number | null;
    available_quantity: number | null;
    listing_url: string | null;
    listing_format: string | null;
    start_date: string | null;
    raw: Record<string, unknown>;
    // US-3196: eBay-hosted picture URLs for an orphan. They sit here until the
    // seller links the listing or turns it into a new item, at which point the
    // frontend copies them onto item_photos as reference rows.
    photo_urls: string[];
    imported_at: string;
  };

  // Inventory statuses a "now listed on eBay" flip is allowed to advance FROM
  // (forward-only — never regress a sold/shipped item).
  const PREP_STATUSES = [
    "sourced",
    "acquired",
    "cataloged",
    "measured",
    "photographed",
    "comped",
    "drafted",
  ];

  // Accumulators flushed in one bulk call each after both listing passes.
  const pendingListing = new Map<string, ListingWrite>();
  const orphanByEbayId = new Map<string, OrphanWrite>();
  // US-3196: eBay-hosted picture URLs per matched item, mirrored onto
  // item_photos as reference rows in one batch after both passes. Accumulated
  // rather than written inline so a 400-listing catalog costs two queries, and
  // so the modern and legacy passes can both contribute to the same item.
  const photoUrlsByItem = new Map<string, string[]>();
  const addPhotoUrls = (itemId: string, urls: string[]): void => {
    if (urls.length === 0) return;
    const existing = photoUrlsByItem.get(itemId);
    if (!existing) {
      photoUrlsByItem.set(itemId, [...urls]);
      return;
    }
    for (const u of urls) if (!existing.includes(u)) existing.push(u);
  };
  // Items eBay reports as ACTIVE → flip to 'listed'. The notify set (modern
  // offers) emits the "listing is live" notification on the real transition;
  // the silent set (legacy listings) flips without notifying, matching the
  // prior behavior where only the modern pass notified.
  const listedNotifyItemIds = new Set<string>();
  const listedSilentItemIds = new Set<string>();

  // Seed (or fetch) the pending write row for an item — from the pre-loaded
  // snapshot when one exists, otherwise a fresh row with a client-generated id
  // so a later pass (and the flush) addresses the same row instead of inserting
  // a duplicate.
  function ensurePendingListing(itemId: string): ListingWrite {
    const cached = pendingListing.get(itemId);
    if (cached) return cached;
    const ex = existingListingByItem.get(itemId);
    const w: ListingWrite = ex
      ? {
          id: ex.id,
          inventory_item_id: itemId,
          platform: "ebay",
          platform_listing_id: ex.platform_listing_id ?? null,
          platform_offer_id: ex.platform_offer_id ?? null,
          listing_url: ex.listing_url ?? null,
          listing_price: ex.listing_price ?? 0,
          listing_status: ex.listing_status ?? null,
          is_active: ex.is_active ?? false,
          quantity: ex.quantity ?? null,
          listed_at: ex.listed_at ?? new Date().toISOString(),
          listing_description: ex.listing_description ?? null,
          platform_category_id: ex.platform_category_id ?? null,
          listing_title: ex.listing_title ?? null,
          // Preserve the stored provenance (deriveListingOrigin returns the
          // persisted marker when valid, else derives from the same signals).
          listing_origin: deriveListingOrigin({
            listing_origin: ex.listing_origin,
            platform: "ebay",
            platform_listing_id: ex.platform_listing_id,
            batch_id: ex.batch_id,
            synced_to_ebay_at: ex.synced_to_ebay_at,
          }),
        }
      : {
          id: crypto.randomUUID(),
          inventory_item_id: itemId,
          platform: "ebay",
          platform_listing_id: null,
          platform_offer_id: null,
          listing_url: null,
          listing_price: 0,
          listing_status: null,
          is_active: false,
          quantity: null,
          listed_at: new Date().toISOString(),
          listing_description: null,
          platform_category_id: null,
          listing_title: null,
          // A brand-new row from the eBay pull is eBay-originated.
          listing_origin: "ebay",
        };
    pendingListing.set(itemId, w);
    return w;
  }

  // Copy the defined keys of a (pin-filtered) patch onto a pending write row.
  // `undefined` means "leave the existing value" — exactly the semantics the
  // per-row update/insert relied on.
  function applyListingPatch(
    w: ListingWrite,
    patch: Record<string, unknown>,
  ): void {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (w as Record<string, unknown>)[k] = v;
    }
  }

  // US-2656: what eBay said about each matched item's listing THIS run, keyed by
  // inventory_item_id. Collected during the offer passes and consumed after the
  // orders pass, because whether a seller needs to be told anything depends on
  // something the offer loop cannot know yet: an item that stopped being active
  // because it SOLD needs no explanation, while the same eBay status on an item
  // with no sale is the thing the seller has been given a hardcoded guess about.
  const ebayStateByItem = new Map<string, EbayListingState>();

  // Catalog-backfill bookkeeping. GetItem (legacy specifics) is gated to items
  // still missing a field and capped per run, so first-sync cost tapers to ~0.
  const MAX_SPECIFICS_FETCH_PER_SYNC = 300;
  let catalogUpdated = 0;
  let specificsFetched = 0;
  let specificsCapped = false;
  // US-3110: items we asked GetItem about this run, flushed as one bulk stamp
  // below. Without this stamp a field eBay has no value for stays blank, so
  // needsSpecifics is true again on the next sync and the same item is re-read
  // forever — measured at ~3,300 Trading calls a day against a 5,000 ceiling.
  const specificsCheckedItemIds: string[] = [];

  // US-3468: eBay category id -> breadcrumb path, memoized for the run. Read
  // only for items still on the adoption default ("clothing"), whose vertical
  // the pull may correct (buildCatalogPatch), and only for eBay-originated
  // listings: a GradeThread-originated listing's item_category was chosen.
  const categoryPathById = new Map<string, Promise<string | null>>();
  const resolveCategoryPath = (categoryId: string): Promise<string | null> => {
    let p = categoryPathById.get(categoryId);
    if (!p) {
      p = getCategoryName(categoryId)
        .then((r) => r?.path ?? null)
        .catch(() => null);
      categoryPathById.set(categoryId, p);
    }
    return p;
  };
  const wantsCategoryCorrection = (
    row: ItemRow,
    origin: string | null | undefined,
  ): boolean =>
    origin !== "gradethread" &&
    (!row.item_category ||
      row.item_category === ADOPTION_DEFAULT_ITEM_CATEGORY);

  // Apply an eBay-sourced catalog patch to a matched inventory_item, keeping
  // our in-memory ItemRow in sync so the orders pass below sees fresh values.
  // Kept as a per-row UPDATE (not folded into the bulk upsert): inventory_items
  // has NOT NULL columns we don't carry here (status, etc.), and the INSERT arm
  // of an upsert would either violate them or clobber a live status. Patches are
  // gated (fill-if-blank / title-change) so steady-state syncs issue ~0 of these.
  async function applyCatalogPatch(
    itemId: string,
    row: ItemRow,
    patch: CatalogPatch,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    // Tenant-safe: itemId came from this user's own catalog preload (US-268).
    const { error } = await supabaseAdmin
      .from("inventory_items")
      .update(patch)
      .eq("id", itemId);
    if (error) {
      errors.push(`catalog ${itemId}: ${error.message.slice(0, 120)}`);
      return;
    }
    Object.assign(row, patch);
    catalogUpdated += 1;
  }

  let matched = 0;
  let unmatched = 0;
  let skipped = 0;
  // Tracks every eBay listingId we've already upserted in this pass — used
  // by the legacy Trading API pass below to skip listings already covered
  // by the modern Sell Inventory loop.
  const processedListingIds = new Set<string>();
  // Items whose eBay listing came back ended/inactive this sync. After the
  // orders pass marks genuine sales as 'sold', anything left here that's still
  // 'listed' ended WITHOUT a sale → auto-move it back to Drafts so the seller
  // can edit + relist it (Path A).
  const endedItemIds = new Set<string>();
  // US-148: what eBay said about each matched listing, captured BEFORE the
  // eBay-wins overwrite below, so cross-source conflicts keep FlipDesk's
  // original value. Recorded in one batch after the orders pass (status
  // observations for listings that ended via a genuine sale are dropped —
  // "sold vs ended" isn't a disagreement worth flagging).
  const ebayObservations: (SourceObservation & { itemId?: string })[] = [];
  // Statuses where an eBay-vs-FlipDesk status diff is meaningful; sold /
  // relisted are FlipDesk-richer states eBay can't express.
  const COMPARABLE_STATUSES = new Set(["active", "ended", "draft"]);

  // US-1081: per-listing platform_fields writes for drift bookkeeping on
  // GradeThread-originated listings (keyed by listing id). Flushed after the
  // loop. Separate from the bulk listing upsert — that upsert never carries
  // platform_fields, so these writes aren't clobbered.
  // Staged platform_fields edits, keyed by listings.id. The drift marker and the
  // US-2656 eBay-state record BOTH live in this one JSON column, so they share
  // one staging map: two writers each doing their own read-modify-write would
  // let whichever flushed last erase the other's key.
  const driftFieldWrites = new Map<string, Record<string, unknown>>();
  const stagePlatformFields = (
    listingId: string,
    prevPf: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> => {
    let cur = driftFieldWrites.get(listingId);
    if (!cur) {
      cur = { ...(prevPf ?? {}) };
      driftFieldWrites.set(listingId, cur);
    }
    return cur;
  };

  // US-1056: low-stock / stockout events observed this pull, keyed by listing id
  // (last write wins) so a listing touched by both the modern + legacy passes
  // only notifies once. Collected only for eBay-source-of-truth listings (eBay
  // owns the quantity there) and flushed AFTER the listings upsert commits, so a
  // failed write never produces a phantom alert.
  const lowStockEvents = new Map<string, StockEvent>();

  // US-1078: provenance-aware inbound merge, shared by the modern-offers and
  // legacy (Trading API) passes. Authority follows listing provenance now —
  // this RETIRES the US-148 per-field source_of_truth pin (`pinnedAgainstEbay`),
  // which is no longer read from the pull (listings.source_of_truth is
  // deprecated for the eBay↔FlipDesk axis; see vault/20-domain/sync-source-of-truth.md).
  //
  // • listing_origin='ebay'        — eBay is the source of truth: the patch is
  //   left untouched (full mirror — every eBay-owned field flows through).
  // • listing_origin='gradethread' — GradeThread is the source of truth: the
  //   eBay-owned editable fields (title/price/description/quantity/category) are
  //   deleted from the patch so the pull never clobbers a FlipDesk edit. The
  //   read-only signals (listing_status/is_active) already in the patch still
  //   flow in. Any eBay drift is recorded in platform_fields.sync_drift so the
  //   editor can offer a non-blocking "Re-push to eBay" re-assert.
  //
  // Origin is derived from the same signals US-1077 backfills from, so the
  // behavior is forward-compatible once the listing_origin column is persisted.
  const applyProvenanceMerge = (
    existing: ExistingListingRow | null,
    patch: Record<string, unknown>,
    fromEbay: {
      title?: string | null;
      price?: number | null;
      description?: string | null;
    },
  ): "ebay" | "gradethread" => {
    const origin = existing
      ? deriveListingOrigin({
          platform: "ebay",
          platform_listing_id: existing.platform_listing_id,
          batch_id: existing.batch_id,
          synced_to_ebay_at: existing.synced_to_ebay_at,
        })
      : "ebay";
    if (!existing || origin !== "gradethread") return origin;

    const drifted: string[] = [];
    const ebaySnapshot: Record<string, unknown> = {};
    const title = fromEbay.title?.trim();
    if (
      title &&
      existing.listing_title != null &&
      title !== existing.listing_title.trim()
    ) {
      drifted.push("title");
      ebaySnapshot.title = title;
    }
    if (
      fromEbay.price != null &&
      existing.listing_price != null &&
      Math.abs(fromEbay.price - existing.listing_price) > 0.005
    ) {
      drifted.push("price");
      ebaySnapshot.price = fromEbay.price;
    }
    const description = fromEbay.description?.trim();
    if (
      description &&
      existing.listing_description != null &&
      description !== existing.listing_description.trim()
    ) {
      drifted.push("description");
      ebaySnapshot.description = description;
    }

    // Keep GradeThread's values — never let eBay win on a GT-originated listing.
    //
    // US-1994: the locked set is DERIVED from sync-precedence.ts rather than
    // hand-listed here. This block used to enumerate five deletes, which drifted
    // from the module documenting the same contract — and because the module had
    // the tests and no callers, its green suite read as proof of a rule only it
    // enforced. Now there is one registry: anything eBay owns that is not in
    // LISTING_PULL_ALLOWED_ON_GT_ORIGIN (state signals + eBay-ASSIGNED identity)
    // is dropped, so adding a field to EBAY_OWNED_LISTING_FIELDS locks it here
    // automatically instead of silently leaking through.
    for (const field of EBAY_OWNED_LISTING_FIELDS) {
      if (!LISTING_PULL_ALLOWED_ON_GT_ORIGIN.includes(field)) {
        delete (patch as Record<string, unknown>)[field];
      }
    }

    // Record (or clear) the drift marker; informational only — we never pull
    // eBay's drifted value into GradeThread. Skip the write unless the marker
    // actually changes so a steady-state sync stays free.
    const prevPf = (existing.platform_fields ?? {}) as Record<string, unknown>;
    const hadDrift = !!(prevPf as { sync_drift?: unknown }).sync_drift;
    if (drifted.length > 0) {
      stagePlatformFields(existing.id, prevPf).sync_drift = {
        fields: drifted,
        ebay: ebaySnapshot,
        detected_at: new Date().toISOString(),
      };
    } else if (hadDrift) {
      delete (stagePlatformFields(existing.id, prevPf) as { sync_drift?: unknown })
        .sync_drift;
    }
    return origin;
  };

  for (const o of offers) {
    try {
      const sku = o.sku;
      // US-3362: resolved through every SKU eBay could be holding this item
      // under, not just `inventory_items.sku`. The routing below - and with it
      // both ended-without-sale branches - sits behind this one lookup, which
      // is why a wrong answer here reads as an orphan rather than as a bug.
      const resolvedItemId = resolveListedItemId(sku, o.listingId);
      const routed = routeRemoteOffer(
        o,
        resolvedItemId,
        resolvedItemId
          ? existingListingByItem.get(resolvedItemId) ?? null
          : null,
      );
      // No live listingId on this offer. Normally that's a genuine draft
      // (unpublished offer) — skip. BUT if we still hold a LIVE local listing
      // for this SKU, eBay just told us it's no longer live: the listing ended,
      // sold out, or was REMOVED BY EBAY for a policy issue (eBay drops a
      // policy-removed listing out of the active feed, so it returns with no
      // listingId). Reconcile it to ended so Path A (below) drops the item back
      // to Drafts and it becomes relistable, instead of leaving it stuck
      // "active" forever. routeRemoteOffer gates that on an existing ACTIVE
      // local row, so a legitimately unpublished draft is never touched.
      if (!o.listingId) {
        if (routed.kind === "ended") {
          // US-2656: absence is its own fact, distinct from any status eBay
          // could have sent, so it carries its own reason onto the row.
          applyListingPatch(ensurePendingListing(routed.itemId), {
            listing_status: routed.state.status,
            is_active: routed.state.isActive,
          });
          ebayStateByItem.set(routed.itemId, routed.state);
          endedItemIds.add(routed.itemId);
        }
        skipped += 1;
        continue;
      }
      // `skipped` cannot reach here (routeRemoteOffer only returns it for an
      // offer with no listingId, handled above), but narrowing on the two kinds
      // that carry an item beats asserting that.
      const onItem = routed.kind === "listed" || routed.kind === "ended"
        ? routed
        : null;
      const itemId = onItem?.itemId ?? null;
      const priceNum = o.price ? Number(o.price.value) : null;
      // US-2656: every non-ACTIVE answer used to become "ended" in a single
      // ternary here, and the reason eBay gave was dropped on the floor. The
      // resolver inside routeRemoteOffer keeps eBay's own word and what it
      // means; OUT_OF_STOCK in particular resolves to ACTIVE, because that
      // listing is still on eBay and relisting it would mint a duplicate.
      const ebayState = onItem?.state ?? null;
      const isActive = routed.kind === "listed";

      if (itemId && ebayState) {
        // US-405: the existing listing comes from the pre-loaded map, not a
        // per-row SELECT.
        const existing = existingListingByItem.get(itemId) ?? null;

        // US-148: capture eBay-vs-FlipDesk disagreements before the overwrite.
        if (existing) {
          const ebayStatus = ebayState.status;
          if (priceNum != null) {
            ebayObservations.push({
              listingId: existing.id,
              field: "price",
              flipdeskValue: existing.listing_price,
              observedValue: priceNum,
            });
          }
          // Quantity only once FlipDesk has an opinion (column seeded below).
          if (existing.quantity != null && o.availableQuantity != null) {
            ebayObservations.push({
              listingId: existing.id,
              field: "quantity",
              flipdeskValue: existing.quantity,
              observedValue: o.availableQuantity,
            });
          }
          if (
            existing.listing_status &&
            COMPARABLE_STATUSES.has(existing.listing_status)
          ) {
            ebayObservations.push({
              listingId: existing.id,
              field: "listing_status",
              flipdeskValue: existing.listing_status,
              observedValue: ebayStatus,
              itemId,
            });
          }
          if (o.title && o.title.trim()) {
            ebayObservations.push({
              listingId: existing.id,
              field: "title",
              flipdeskValue: existing.listing_title,
              observedValue: o.title,
            });
          }
        }

        const patch: Record<string, unknown> = {
          platform_listing_id: o.listingId,
          platform_offer_id: o.offerId,
          listing_url: ebayListingUrl(o.listingId),
          listing_price: priceNum ?? undefined,
          listing_status: ebayState.status,
          is_active: ebayState.isActive,
          quantity: o.availableQuantity ?? undefined,
        };
        // eBay's own listing start date is authoritative — write it through so
        // the "List Date" column is populated even on sync-discovered listings
        // (we never set listed_at on insert below otherwise). Only overwrite
        // when eBay actually returned a date.
        if (o.listingStartDate) {
          patch.listed_at = o.listingStartDate;
        }
        // Pull description back from eBay so manual Seller Hub edits don't
        // leave FlipDesk's copy stale. Skip empty strings — those usually
        // mean "API didn't return a body", not "user blanked it".
        if (o.listingDescription && o.listingDescription.trim()) {
          patch.listing_description = o.listingDescription;
        }
        if (o.categoryId) {
          patch.platform_category_id = o.categoryId;
        }

        // US-1078: provenance-aware inbound merge (shared with the legacy pass).
        // GT-originated → keep GradeThread's editable fields + record drift;
        // eBay-originated → full mirror (patch untouched). Supersedes the US-148
        // source_of_truth pin.
        const origin = applyProvenanceMerge(existing, patch, {
          title: o.title,
          price: priceNum,
          description: o.listingDescription,
        });
        // US-1056: on an eBay-source-of-truth listing, eBay's reported available
        // quantity is authoritative — record a low-stock crossing as units sell.
        // (GT-origin listings keep their own quantity, so eBay's number there is
        // drift, not real stock; skip them.)
        if (existing && origin === "ebay" && o.availableQuantity != null) {
          lowStockEvents.set(existing.id, {
            userId,
            listingId: existing.id,
            itemId,
            title: existing.listing_title,
            prevQty: existing.quantity,
            newQty: o.availableQuantity,
          });
        }
        // US-405: accumulate the write — flushed as one bulk upsert after both
        // listing passes. ensurePendingListing seeds a full row from the
        // pre-loaded snapshot (or a fresh client-id'd row), then the patch is
        // merged on top.
        applyListingPatch(ensurePendingListing(itemId), patch);
        ebayStateByItem.set(itemId, ebayState);
        // US-2656: persist eBay's OWN verdict next to ours, so the reason a
        // listing is not selling survives the collapse into two local statuses
        // and the UI can say "eBay marked this inactive" rather than "ended".
        //
        // Written only on a CHANGE. A steady-state sync of an ACTIVE listing must
        // stay free of writes (the drift marker next door is careful about the
        // same thing), and re-stamping an unchanged verdict every 30 minutes
        // would also make observed_at meaningless — its value is that it dates
        // the TRANSITION.
        if (existing) {
          const prevPf = (existing.platform_fields ?? {}) as {
            ebay_state?: { status?: string; reason?: string };
          };
          const prev = prevPf.ebay_state;
          if (
            prev?.status !== ebayState.status ||
            prev?.reason !== ebayState.reason
          ) {
            stagePlatformFields(
              existing.id,
              existing.platform_fields as Record<string, unknown> | null,
            ).ebay_state = {
              status: ebayState.status,
              reason: ebayState.reason,
              ebay_status: ebayState.ebayStatus,
              message: ebayState.message,
              observed_at: new Date().toISOString(),
            };
          }
        }
        // Forward-only status — don't regress sold/shipped items. The flip is
        // batched after the loop; the modern pass notifies on the real
        // transition (notify set), the legacy pass flips silently.
        if (isActive) {
          listedNotifyItemIds.add(itemId);
        } else {
          // eBay reports this offer's listing as ended/inactive. Remember it so
          // the post-orders reconciliation can move it back to Drafts if it
          // ended without a sale (Path A — relist of ended listings).
          endedItemIds.add(itemId);
        }
        // eBay as source of truth: title overwrite, specifics fill-if-blank.
        // Modern offers carry title + aspects (from listAllOffers) — free.
        // US-1081: for GradeThread-originated listings GradeThread owns the
        // title, so skip eBay's title overwrite (specifics still fill-if-blank).
        // US-3362: keyed on the resolved item, not on the SKU eBay sent. A
        // Minted or Renamed SKU has no `inventory_items.sku` entry to find.
        const localRow = itemById.get(itemId);
        if (localRow) {
          // US-3468: the vertical, from the breadcrumb, for items still on
          // the adoption default. One lookup per distinct category per run.
          const itemCategory =
            o.categoryId && wantsCategoryCorrection(localRow, origin)
              ? itemCategoryFromEbayPath(
                await resolveCategoryPath(o.categoryId),
              )
              : null;
          await applyCatalogPatch(
            itemId,
            localRow,
            buildCatalogPatch(localRow, {
              title: origin === "gradethread" ? null : o.title,
              specifics: flattenAspects(o.aspects),
              // US-3468: the whole map and the leaf category, so a card's
              // Sport/Player/Set or a shoe's US Shoe Size land on the item
              // and not only Brand/Size/Color/Style/Material.
              aspects: o.aspects,
              categoryId: o.categoryId,
              itemCategory,
            }),
          );
        }
        // US-3196: eBay's own pictures for this listing (product.imageUrls,
        // already on the offer). Outside the localRow guard because mirroring
        // photos needs only the item id, and gating it on the catalog row would
        // silently skip an item whose SKU map entry went missing mid-run.
        addPhotoUrls(itemId, o.imageUrls);
        matched += 1;
      } else {
        // Snapshot orphan eBay listings — surfaced on the Reconciliation page.
        // US-405: collected into a map and bulk-upserted after the loop. Keyed
        // by ebay_item_id so a duplicate id within the run can't make the bulk
        // upsert "affect a row a second time".
        orphanByEbayId.set(o.listingId, {
          user_id: userId,
          ebay_item_id: o.listingId,
          custom_label: sku ?? null,
          // US-3362: the offer already carries the title (listAllOffers reads it
          // off the inventory item), and this hard-coded null was the reason a
          // Reconciliation row could be nameless. The legacy pass that would
          // otherwise have supplied it never runs for this listing - the modern
          // pass has already put its id in processedListingIds.
          title: o.title?.trim() ? o.title : null,
          current_price: priceNum,
          available_quantity: o.availableQuantity ?? null,
          listing_url: ebayListingUrl(o.listingId),
          listing_format: o.format ?? null,
          start_date: null,
          raw: {
            offerId: o.offerId,
            listingStatus: o.listingStatus,
            categoryId: o.categoryId,
            price: o.price,
            // US-3468: carried so an adopted orphan is created WITH its
            // specifics (buildAdoptionRows) instead of waiting a sync for
            // them. Legacy orphans have none here; GetItem fills those on
            // the first sync after adoption.
            aspects: o.aspects,
          },
          photo_urls: o.imageUrls,
          // US-465 AC2: do NOT write match_status here. Omitting it means a
          // brand-new orphan gets the column default ('unmatched') on INSERT,
          // while an existing row's match_status (and matched_item_id, also
          // omitted) is PRESERVED on conflict — so a manually-linked orphan is
          // never resurrected as unmatched by a later re-sync.
          imported_at: new Date().toISOString(),
        });
        unmatched += 1;
      }
      processedListingIds.add(o.listingId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg.slice(0, 200));
    }
  }

  // ── Legacy listings (Trading API) ───────────────────────────────
  // Pulls every active listing from GetMyeBaySelling — covers items
  // created in Seller Hub or via the legacy ListItem call that never
  // became inventory_items on the new REST surface. We dedupe against
  // listingIds already processed above so an item that exists on both
  // surfaces isn't double-counted.
  let legacyMatched = 0;
  let legacyUnmatched = 0;
  let legacyDuplicates = 0;
  try {
    const legacy: LegacyEbayListing[] = catalogPass
      ? await getAllActiveEbaySelling(userId)
      : [];
    for (const l of legacy) {
      try {
        if (processedListingIds.has(l.ebayItemId)) {
          legacyDuplicates += 1;
          continue;
        }
        const sku = l.sku;
        const itemId = resolveListedItemId(sku, l.ebayItemId);

        if (itemId) {
          // Same write path as the modern flow — but no platform_offer_id
          // because legacy listings don't have a Sell Inventory offer.
          // US-405: existing listing from the pre-loaded map (may already hold
          // an in-memory write from the modern pass for this same item).
          const existing = existingListingByItem.get(itemId) ?? null;

          // US-148: GetMyeBaySelling only returns ACTIVE listings.
          if (existing) {
            const legacyQty = l.quantityAvailable ?? l.quantity;
            if (l.currentPrice != null) {
              ebayObservations.push({
                listingId: existing.id,
                field: "price",
                flipdeskValue: existing.listing_price,
                observedValue: l.currentPrice,
              });
            }
            if (existing.quantity != null && legacyQty != null) {
              ebayObservations.push({
                listingId: existing.id,
                field: "quantity",
                flipdeskValue: existing.quantity,
                observedValue: legacyQty,
              });
            }
            if (
              existing.listing_status &&
              COMPARABLE_STATUSES.has(existing.listing_status)
            ) {
              ebayObservations.push({
                listingId: existing.id,
                field: "listing_status",
                flipdeskValue: existing.listing_status,
                observedValue: "active",
                itemId,
              });
            }
            if (l.title && l.title.trim()) {
              ebayObservations.push({
                listingId: existing.id,
                field: "title",
                flipdeskValue: existing.listing_title,
                observedValue: l.title,
              });
            }
          }

          const patch: Record<string, unknown> = {
            platform_listing_id: l.ebayItemId,
            listing_url: l.listingUrl ?? ebayListingUrl(l.ebayItemId),
            listing_price: l.currentPrice ?? undefined,
            listing_status: "active",
            is_active: true,
            quantity: l.quantityAvailable ?? l.quantity ?? undefined,
          };
          // Trading API gives us ListingDetails.StartTime — write it through to
          // listed_at so the "List Date" column reflects eBay's record.
          if (l.startTime) patch.listed_at = l.startTime;
          if (l.title && l.title.trim()) patch.listing_title = l.title;
          if (l.primaryCategoryId) patch.platform_category_id = l.primaryCategoryId;
          // US-1078: provenance-aware inbound merge (shared with the modern
          // pass). GT-originated → keep GradeThread's editable fields (title/
          // price/quantity/category) + record drift; eBay-originated → full
          // mirror. GetMyeBaySelling returns no body, so no description signal.
          const origin = applyProvenanceMerge(existing, patch, {
            title: l.title,
            price: l.currentPrice ?? null,
            description: null,
          });
          // US-1056: low-stock crossing on an eBay-source-of-truth listing (see
          // the modern pass for the GT-origin caveat). Re-resolve the eBay
          // quantity here (the earlier `legacyQty` is scoped to the if-existing
          // block above).
          const newQty = l.quantityAvailable ?? l.quantity;
          if (existing && origin === "ebay" && newQty != null) {
            lowStockEvents.set(existing.id, {
              userId,
              listingId: existing.id,
              itemId,
              title: existing.listing_title,
              prevQty: existing.quantity,
              newQty,
            });
          }
          // US-405: accumulate the write (merging onto any row the modern pass
          // already seeded for this item) and the silent status flip.
          applyListingPatch(ensurePendingListing(itemId), patch);
          listedSilentItemIds.add(itemId);
          // US-3196: ActiveList carries only PictureDetails.GalleryURL, which
          // normalizes to the same URL as its full-size twin from GetItem. So
          // an item that never earns a GetItem call still gets its hero photo,
          // and one that does earn it gets the whole set with no duplicate.
          addPhotoUrls(itemId, l.pictureUrls);
          // eBay as source of truth. Legacy (GetMyeBaySelling) gives us the
          // title for free, but NOT item specifics — fetch those via GetItem
          // ONLY when this item still has a blank target field, and only while
          // under the per-sync cap (so the first backfill is bounded and later
          // syncs cost ~0 calls). Title still syncs even when the cap is hit.
          // US-3362: keyed on the resolved item, not on the SKU eBay sent.
          const localRow = itemById.get(itemId);
          if (localRow) {
            // A blank field is only worth an API call if we have not already
            // asked recently. eBay genuinely has no Material on plenty of
            // listings; re-asking every sync never fills the field, it just
            // spends the Trading quota.
            const askedAt = localRow.ebay_specifics_checked_at;
            const askedRecently = !!askedAt &&
              Date.now() - Date.parse(askedAt) < SPECIFICS_RECHECK_MS;
            // US-3468: an empty ebay_aspects map is also a blank worth one
            // call. Same 14-day stamp bounds it: an item eBay holds with no
            // specifics at all is asked again a fortnight later, not every
            // sync.
            const needsSpecifics = !askedRecently &&
              (FILL_IF_BLANK_FIELDS.some(
                (f) => !localRow[f] || !localRow[f]!.trim(),
              ) ||
                Object.keys(localRow.ebay_aspects ?? {}).length === 0);
            // US-3196: GetItem is also the ONLY source of a legacy listing's
            // full picture set — ActiveList carries one gallery thumbnail and
            // nothing else. Gating the call on blank specifics therefore gated
            // the PHOTOS on an unrelated question, and an item whose brand,
            // size, colour, style and material were already filled mirrored
            // exactly one photo, permanently. That is the "why is there only
            // one picture" report.
            //
            // Asking once per item is enough, so this reuses the stamp rather
            // than adding a second one: a null ebay_specifics_checked_at means
            // GetItem has never been called for this item, and the same bulk
            // write below stamps it either way. An item that HAS been asked is
            // not asked again for photos, so this adds one call per item on the
            // first sync after deploy and nothing after that.
            const neverAskedGetItem = !askedAt;
            const needsGetItem = needsSpecifics || neverAskedGetItem;
            let specifics: Record<string, string> = {};
            let aspects: Record<string, string[]> | null = null;
            let categoryId: string | null = l.primaryCategoryId ?? null;
            // US-3468: GetItem answers the breadcrumb outright; without that
            // call it is resolved by id, memoized per run, and only for an
            // item still on the adoption default.
            let categoryPath: string | null = null;
            if (needsGetItem) {
              if (specificsFetched < MAX_SPECIFICS_FETCH_PER_SYNC) {
                specificsFetched += 1;
                // US-3196: the same call returns the listing's full picture set,
                // so the photo mirror rides the specifics backfill rather than
                // spending Trading quota of its own.
                const details = await getItemDetails(userId, l.ebayItemId);
                specifics = details.specifics;
                aspects = details.aspects;
                categoryId = details.primaryCategoryId ?? categoryId;
                categoryPath = details.primaryCategoryPath;
                addPhotoUrls(itemId, details.pictureUrls);
                specificsCheckedItemIds.push(localRow.id);
                // Keep the in-memory row honest so a second listing pointing at
                // the same item in this run doesn't re-ask.
                localRow.ebay_specifics_checked_at = new Date().toISOString();
              } else {
                specificsCapped = true;
              }
            }
            await applyCatalogPatch(
              itemId,
              localRow,
              // US-1078: GradeThread owns the title on GT-originated listings —
              // skip eBay's title overwrite (specifics still fill-if-blank).
              buildCatalogPatch(localRow, {
                title: origin === "gradethread" ? null : l.title,
                specifics,
                // US-3468: full map + leaf category, see the modern pass.
                aspects,
                categoryId,
                itemCategory: wantsCategoryCorrection(localRow, origin)
                  ? itemCategoryFromEbayPath(
                    categoryPath ??
                      (categoryId
                        ? await resolveCategoryPath(categoryId)
                        : null),
                  )
                  : null,
              }),
            );
          }
          legacyMatched += 1;
        } else {
          // Orphan: most legacy Seller-Hub listings have no Custom Label.
          // Snapshot with the title so the Reconciliation page can show it
          // and let the user link it to a FlipDesk SKU. US-405: bulk-upserted
          // after the loop (keyed by ebay_item_id).
          orphanByEbayId.set(l.ebayItemId, {
            user_id: userId,
            ebay_item_id: l.ebayItemId,
            custom_label: sku ?? null,
            title: l.title ?? null,
            current_price: l.currentPrice ?? null,
            available_quantity: l.quantityAvailable ?? l.quantity ?? null,
            listing_url: l.listingUrl ?? null,
            listing_format: l.listingType ?? null,
            start_date: l.startTime ? l.startTime.slice(0, 10) : null,
            raw: {
              source: "trading_api",
              watchCount: l.watchCount,
              endTime: l.endTime,
              // US-3468: so adoption can file the item under the right
              // vertical (and set ebay_category_id) from the breadcrumb.
              categoryId: l.primaryCategoryId,
            },
            // ActiveList gives the gallery thumbnail only, upgraded to full
            // size. An orphan earns no GetItem call (that fill is gated on a
            // MATCHED item's blank fields), so one photo is what there is until
            // the seller links it and the next sync sees a matched item.
            photo_urls: l.pictureUrls,
            // US-465 AC2: omit match_status so a manual link survives re-sync
            // (default 'unmatched' applies only to brand-new rows; existing
            // match_status + matched_item_id are preserved on conflict).
            imported_at: new Date().toISOString(),
          });
          legacyUnmatched += 1;
        }
        processedListingIds.add(l.ebayItemId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`legacy ${l.ebayItemId}: ${msg.slice(0, 160)}`);
      }
    }
  } catch (err) {
    // Trading API failure shouldn't fail the whole pull. Common cause:
    // legacy seller account that's been migrated to Sell Inventory only.
    console.error("[flipdesk-ebay] Trading API pass failed:", err);
    errors.push(
      `trading api: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // US-3111: remember which SKUs we spent an offer read on, including the ones
  // eBay had no offer for. Chunked because a large seller's pass can name a few
  // thousand SKUs and PostgREST sends `.in()` in the URL.
  //
  // US-3362: keyed on the resolved inventory_items.id, not on `sku`. The old
  // `.in("sku", chunk)` consulted the same wrong column the resolution did, so
  // for a Minted, Renamed or Variant SKU it matched zero rows, returned 200,
  // and left the SKU to be re-read on every pass forever.
  let offerStampCoverage: OfferStampCoverage | null = null;
  let offerStampPlan: OfferStampPlan | null = null;
  if (offerSkusRead.length > 0) {
    const plan = planOfferStamp(offerSkusRead, skuToItemId);
    offerStampPlan = plan;
    // US-3110: the SKUs the stamp actually landed on, mapped back from the ids
    // PostgREST reports. Collected rather than counted so the gap can be NAMED.
    const stampedSkus: string[] = [];
    let stampWriteFailed = false;
    for (const chunk of chunkIdsForInFilter(plan.itemIds)) {
      const { data: stampedRows, error } = await supabaseAdmin
        .from("inventory_items")
        .update({ ebay_offer_checked_at: new Date().toISOString() })
        .eq("user_id", userId)
        .in("id", chunk)
        // US-3110: make the update say which rows it hit. Without this a stamp
        // that matched ZERO rows is indistinguishable from one that matched
        // every SKU, because neither returns an error.
        .select("id");
      if (error) {
        // Not fatal: an unstamped SKU is simply read again next pass, which is
        // the old behaviour. Say so, because a persistent failure here restores
        // the full fan-out silently.
        console.error(
          "[flipdesk-ebay] failed to stamp ebay_offer_checked_at:",
          error.message,
        );
        errors.push(`offer stamp: ${error.message.slice(0, 200)}`);
        stampWriteFailed = true;
        break;
      }
      for (const r of (stampedRows ?? []) as Array<{ id: string | null }>) {
        if (!r.id) continue;
        for (const sku of plan.skusByItemId.get(r.id) ?? []) {
          stampedSkus.push(sku);
        }
      }
    }
    // Only meaningful when every chunk was attempted: a bail-out leaves the
    // remaining SKUs unwritten for a reason we already recorded, and counting
    // those as unstampable would blame the schema for a PostgREST failure.
    if (!stampWriteFailed) {
      offerStampCoverage = unstampedOfferCoverage(offerSkusRead, stampedSkus);
      if (offerStampCoverage.unstamped > 0) {
        // NOT pushed onto `errors`: that would flip every single run to
        // "partial" on the Reconciliation page for a condition the seller can
        // do nothing about. The container log is where the operator reads the
        // call-volume question, so the answer goes there.
        console.warn(
          `[flipdesk-ebay] ${offerStampCoverage.unstamped} of ` +
            `${offerStampCoverage.read} offer reads could not be stamped ` +
            `(${plan.unresolved.length} of them resolve to no local ` +
            `item at all); they will be re-read every pass. sample: ` +
            `${offerStampCoverage.sample.join(", ")}`,
        );
      }
    }
  }

  // US-3110: remember which items we asked GetItem about, including the ones it
  // had nothing for. One bulk stamp, not one write per item.
  //
  // Chunked on the same character budget as the offer stamp. This one was never
  // chunked at all, and it failed on prod for the same reason and on the same
  // passes: 297 uuids in one `in.()` is roughly 11,600 characters of request
  // line, and Kong answers 414.
  if (specificsCheckedItemIds.length > 0) {
    for (const chunk of chunkIdsForInFilter(specificsCheckedItemIds)) {
      const { error } = await supabaseAdmin
        .from("inventory_items")
        .update({ ebay_specifics_checked_at: new Date().toISOString() })
        .eq("user_id", userId)
        .in("id", chunk);
      if (error) {
        // Not fatal: the worst case is that the next sync re-asks, which is the
        // behaviour we had before. Say so rather than swallowing it, because a
        // persistent failure here restores the 3,300-calls-a-day burn silently.
        console.error(
          "[flipdesk-ebay] failed to stamp ebay_specifics_checked_at:",
          error.message,
        );
        errors.push(`specifics stamp: ${error.message.slice(0, 200)}`);
        break;
      }
    }
  }

  // ── US-405: flush the batched writes from the offers + legacy passes ─────
  // A handful of bulk calls replaces the thousands of per-row round-trips the
  // loops above used to make. This runs BEFORE the ebayItemIdToItemId rebuild
  // and the orders pass below, both of which read `listings` fresh from the DB.
  if (pendingListing.size > 0) {
    // Every row is a full ListingWrite (all NOT NULL columns present), so a
    // single upsert on the primary key inserts new rows and updates existing
    // ones in one round-trip.
    const { error } = await supabaseAdmin
      .from("listings")
      .upsert(Array.from(pendingListing.values()), { onConflict: "id" });
    if (error) errors.push(`listings upsert: ${error.message.slice(0, 160)}`);
  }
  // US-1056: now that the new quantities are committed, fire low-stock /
  // stockout notifications for any listing that crossed down this pull. Read the
  // threshold once and reuse it. Best-effort: notifyStockLevel self-filters
  // (only a downward crossing alerts) and never throws.
  if (lowStockEvents.size > 0) {
    const threshold = await getLowStockThreshold();
    for (const ev of lowStockEvents.values()) {
      void notifyStockLevel(ev, threshold);
    }
  }
  // US-1081: write the drift markers for GradeThread-originated listings. These
  // touch only `platform_fields` (which the bulk upsert above never carries, so
  // they aren't clobbered) and only fire when a marker changed, so a normal
  // in-agreement sync issues none.
  for (const [listingId, platformFields] of driftFieldWrites) {
    const { error } = await supabaseAdmin
      .from("listings")
      .update({ platform_fields: platformFields } as never)
      .eq("id", listingId);
    if (error) {
      errors.push(`drift marker ${listingId}: ${error.message.slice(0, 120)}`);
    }
  }
  if (orphanByEbayId.size > 0) {
    const { error } = await supabaseAdmin
      .from("flipdesk_ebay_listings")
      .upsert(Array.from(orphanByEbayId.values()), {
        onConflict: "user_id,ebay_item_id",
      });
    if (error) errors.push(`orphan upsert: ${error.message.slice(0, 160)}`);
  }
  // US-3196: mirror eBay's pictures onto the matched items as reference rows.
  // After the listing flush so a brand-new item is already on record, and
  // non-fatal: a sync that reconciled the catalog and failed on the photos is
  // still a good sync, and the next run re-plans from the same state.
  let photosMirrored = 0;
  if (photoUrlsByItem.size > 0) {
    const mirror = await mirrorEbayPhotos(userId, photoUrlsByItem);
    photosMirrored = mirror.inserted;
    errors.push(...mirror.errors);
  }
  // US-3458: orphans with no likely local item become items now, in the same
  // pass that snapshotted them, so a seller who connected eBay to get their
  // listings in has them without opening Reconciliation. Orphans that look
  // like an existing item (same title) are held there for the seller instead.
  // After the orphan flush so this pass's new orphans are candidates, and
  // before the ebayItemIdToItemId rebuild below so this pass's orders can
  // already resolve to the items created here. Reads the WHOLE unmatched set,
  // not just this pass's, because the backlog left by every earlier pull is
  // the thing this exists to clear.
  let orphansAdopted = 0;
  let orphansLinked = 0;
  let orphansHeld = 0;
  let orphansDeferred = 0;
  if (catalogPass) {
    const { data: orphanRows, error: orphanReadError } = await supabaseAdmin
      .from("flipdesk_ebay_listings")
      .select(
        "id, ebay_item_id, custom_label, title, current_price, available_quantity, listing_url, start_date, match_status, matched_item_id, photo_urls, raw",
      )
      .eq("user_id", userId)
      .eq("match_status", "unmatched")
      .is("matched_item_id", null)
      .order("imported_at", { ascending: true })
      .limit(5000);
    if (orphanReadError) {
      errors.push(`orphan adopt (read): ${orphanReadError.message.slice(0, 160)}`);
    } else {
      const plan = planOrphanAdoption(
        (orphanRows ?? []) as unknown as OrphanCandidate[],
        allItems,
      );
      orphansHeld = plan.held.length;
      orphansDeferred = plan.deferred;
      if (plan.adopt.length > 0) {
        const adoption = await adoptOrphans(
          userId,
          plan.adopt,
          undefined,
          resolveCategoryPath,
        );
        orphansAdopted = adoption.adopted;
        orphansLinked = adoption.linked;
        photosMirrored += adoption.photos;
        errors.push(...adoption.errors);
      }
    }
  }
  // Status flips — one .in('id',[...]) update per transition. The prep-status
  // filter keeps the flip forward-only; .select() returns only the rows that
  // actually advanced, so the "listing is live" notification fires once on the
  // real transition. Run the notify flip FIRST so an item that is active on
  // BOTH the modern and legacy surfaces still notifies (the silent flip then
  // finds it already 'listed' and no-ops).
  if (listedNotifyItemIds.size > 0) {
    const { data: flipped } = await supabaseAdmin
      .from("inventory_items")
      .update({ status: "listed" })
      .eq("user_id", userId)
      .in("id", Array.from(listedNotifyItemIds))
      .in("status", PREP_STATUSES)
      .select("id, title");
    for (const r of (flipped ?? []) as Array<{
      id: string;
      title: string | null;
    }>) {
      // US-737 / US-1054: item went live on a marketplace (in-app).
      void notifyListingLive(userId, { itemTitle: r.title, itemId: r.id });
    }
  }
  if (listedSilentItemIds.size > 0) {
    await supabaseAdmin
      .from("inventory_items")
      .update({ status: "listed" })
      .eq("user_id", userId)
      .in("id", Array.from(listedSilentItemIds))
      .in("status", PREP_STATUSES);
  }

  // eBay item-id → inventory_item map, built AFTER the listing passes above so
  // it includes any listing rows just upserted this run. Used as a fallback
  // for matching order line items that carry no Custom Label (SKU) — common
  // for legacy Seller-Hub listings. Tenant-scoped via the inner join on
  // inventory_items.user_id (listings has no user_id column of its own —
  // US-268).
  const ebayItemIdToItemId = new Map<string, string>();
  try {
    const { data: ebayListingRows } = await supabaseAdmin
      .from("listings")
      .select("platform_listing_id, inventory_item_id, inventory_items!inner(user_id)")
      .eq("platform", "ebay")
      .eq("inventory_items.user_id", userId)
      .not("platform_listing_id", "is", null);
    for (const r of (ebayListingRows ?? []) as Array<{
      platform_listing_id: string | null;
      inventory_item_id: string | null;
    }>) {
      if (r.platform_listing_id && r.inventory_item_id) {
        ebayItemIdToItemId.set(r.platform_listing_id, r.inventory_item_id);
      }
    }
  } catch (err) {
    console.error("[flipdesk-ebay] failed to build ebay item-id map:", err);
  }

  // ── Orders sync (sold-state detection) ──────────────────────────
  // Pulls orders modified since last_synced_at (or 90 days on first sync;
  // ~24 months on an explicit backfill). Each line item is matched to an
  // inventory_item by SKU, then by eBay item id; unmatched sales are
  // snapshotted (not dropped).
  // Each line item's SKU is matched to inventory_items.sku; matches turn
  // into a sales row + flip inventory_items.status='sold'.
  // Normal syncs are incremental (orders modified since last_synced_at, or a
  // 90-day seed on first connect). A backfill ignores last_synced_at and
  // reaches back to eBay's practical retention limit (~24 months) so sales
  // that predate the FlipDesk connection get imported. This window applies to
  // BOTH the orders sync and the Finances fee/payout enrichment below.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  // eBay's getOrders + getTransactions reject any start date that is 2 years or
  // older (errorId 30830: "Start date must be within '2' years from present
  // date"). A 730-day window sits exactly on that boundary and gets rejected,
  // which threw the whole orders sync — so NO sales were imported even though
  // the listings pull returned 202 and the UI toasted success. Use a ~23-month
  // backfill window to stay comfortably under the cap, and clamp whatever
  // `since` we send (a stale last_synced_at could otherwise trip the same
  // limit). This floor applies to BOTH the orders sync and the Finances
  // enrichment below, since they share sinceISO.
  const ebayLookbackFloor = new Date(Date.now() - 700 * 24 * 60 * 60_000);
  const requestedSince = backfill
    ? ebayLookbackFloor.toISOString()
    : (lastSyncedAt ?? ninetyDaysAgo);
  const sinceISO =
    new Date(requestedSince).getTime() < ebayLookbackFloor.getTime()
      ? ebayLookbackFloor.toISOString()
      : requestedSince;

  let salesNew = 0;
  let salesUpdated = 0;
  let salesSkipped = 0;
  let salesReversed = 0; // US-459: cancelled/refunded line items handled.
  // US-3466: one shipping_fulfillment GET per order, shared by its line items.
  // A failed lookup is stored as null so a second line item does not retry it.
  const trackingByOrder = new Map<string, OrderTracking | null>();
  // US-2320: what the cursor is allowed to move to depends on these two.
  // `ordersFetchComplete` false means we do not know what we did not see;
  // `failedOrders` are orders we DID see and did not fully persist, so the
  // cursor can rewind to the earliest of them instead of freezing.
  let ordersFetchComplete = true;
  const failedOrders: FailedOrder[] = [];
  try {
    // US-1474: high-volume sellers (large catalog) can pull orders via the Feed
    // API report instead of paging, when EBAY_FEED_SYNC is enabled AND the
    // catalog is above the threshold. Default OFF → always the paged path. A
    // Feed failure falls back to paging so a report hiccup never breaks the
    // sales sync. `offers.length` is the catalog-size proxy (fetched above).
    let orders: RemoteOrder[];
    if (shouldUseFeedForOrders(offers.length)) {
      try {
        // The Feed report is all-or-nothing: it throws unless the whole report
        // downloaded and parsed, so reaching here means a complete read.
        orders = await runOrderReport(userId, sinceISO);
      } catch (feedErr) {
        errors.push(
          `Feed order report failed; fell back to paged order sync: ${
            feedErr instanceof Error ? feedErr.message : String(feedErr)
          }`,
        );
        const paged = await listRecentOrders(userId, sinceISO, errors);
        orders = paged.orders;
        ordersFetchComplete = paged.complete;
      }
    } else {
      const paged = await listRecentOrders(userId, sinceISO, errors);
      orders = paged.orders;
      ordersFetchComplete = paged.complete;
    }
    for (const order of orders) {
      // Failed-payment orders shouldn't flip an item to sold.
      const paid =
        order.orderPaymentStatus === "PAID" ||
        order.orderPaymentStatus === "PARTIALLY_REFUNDED" ||
        order.orderPaymentStatus === "FULLY_REFUNDED";
      if (!paid) {
        salesSkipped += order.lineItems.length;
        continue;
      }

      // Lifecycle for this order's sale rows. A cancelled order (or a fully
      // refunded one) must NOT count toward revenue/profit/sold totals, so we
      // persist it with a non-'completed' status that every metric excludes.
      // US-2656: the same classification now also answers WHERE THE GARMENT IS,
      // which a reversal alone does not tell you. A cancel before shipping left
      // it on the shelf; a refund on an order eBay records as FULFILLED means the
      // buyer had it and sent it back. The sync used to treat both as the first
      // case and put the item to `listed`, while the in-app return path
      // (US-1451) wrote `returned` — the same physical event getting two
      // different answers depending on which code noticed it first.
      const outcome = resolveOrderOutcome(order);
      const saleStatus: "completed" | "cancelled" | "refunded" = outcome.saleStatus;
      const cancelledAt =
        saleStatus === "completed"
          ? null
          : order.lastModifiedDate ?? order.creationDate ?? null;

      for (const li of order.lineItems) {
        try {
          const sku = li.sku;
          let itemId = sku ? skuToItemId.get(sku) ?? null : null;
          // Fallback: match by eBay item id when there's no Custom Label match
          // (legacy listings often have no SKU on the order line item).
          if (!itemId && li.legacyItemId) {
            itemId = ebayItemIdToItemId.get(li.legacyItemId) ?? null;
          }
          if (!itemId) {
            // Don't silently drop it — snapshot the orphan sale so Sold totals
            // stay complete and the user can link it on Reconciliation.
            await snapshotOrphanSale(userId, order, li);
            salesSkipped += 1;
            continue;
          }
          // Look up the most recent listing row for this item so we can
          // link the sale (sales.listing_id is nullable but useful).
          const { data: lst } = await supabaseAdmin
            .from("listings")
            .select("id, listing_url")
            .eq("inventory_item_id", itemId)
            .eq("platform", "ebay")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const lstRow = lst as { id: string; listing_url: string | null } | null;
          let listingId = lstRow?.id ?? null;
          const existingUrl = lstRow?.listing_url ?? null;

          // li.itemCost is eBay's lineItemCost — the EXTENDED line total (unit
          // price × quantity), NOT a per-unit price (verified vs the Fulfillment
          // API docs). So this IS the line revenue; never multiply by quantity.
          const itemCost = li.itemCost ? Number(li.itemCost.value) : 0;
          const quantity = normalizeUnitCount(li.quantity);
          const shippingCollected = li.shippingCost
            ? Number(li.shippingCost.value)
            : 0;
          const tax = li.taxes ? Number(li.taxes.value) : 0;

          // Backfill the listings row's eBay link from the order's listingId.
          // The active-listing passes above (listAllOffers / GetMyeBaySelling)
          // only return ACTIVE listings, so a listing that already sold/ended
          // never gets a listings row carrying a URL — which is why sold items
          // showed a blank "Link" in the export even though the order tells us
          // the eBay item id. Fill it here. We only WRITE the URL when it's
          // currently blank so we don't clobber the nicer slug URL the Trading
          // API gives active listings; platform_listing_id is always set.
          if (li.legacyItemId) {
            const hasUrl = !!existingUrl && existingUrl.trim() !== "";
            const urlPatch = hasUrl
              ? {}
              : { listing_url: ebayListingUrl(li.legacyItemId) };
            // A completed sale means the listing is no longer live.
            //
            // US-2656: a reversal now clears that, and the gap it closes was a
            // row that contradicted itself. `{}` meant a sale that completed and
            // was LATER cancelled kept listing_status = 'sold' forever, while the
            // item went back to 'listed' — the listing insisting it sold, the item
            // insisting it is for sale, and nothing to reconcile them. `ended` is
            // the honest word for both reversal kinds: the listing is not live
            // (the sale took it down) and it did not sell.
            //
            // US-2684: "ended" is only honest when the listing really is gone.
            // Under eBay's out-of-stock control a cancelled order leaves the
            // listing UP at quantity 0, and the offers pull earlier in this same
            // run already read it back as live — so writing ended here undid a
            // verdict taken from eBay minutes ago, and the next sync wrote it
            // back. The row flipped between "ended" and "active" every 30
            // minutes and neither word was the true one, which is
            // "live, but nobody can buy it". Trust the pull when it saw the
            // listing; fall back to ended when it did not (no eBay connection,
            // a partial pull, or an offer genuinely absent from the feed).
            const pulledState = ebayStateByItem.get(itemId) ?? null;
            const stillLiveOnEbay = pulledState?.isActive === true;
            const lifecyclePatch =
              saleStatus === "completed"
                ? { listing_status: "sold", is_active: false }
                : stillLiveOnEbay
                  ? { listing_status: pulledState!.status, is_active: true }
                  : { listing_status: "ended", is_active: false };
            if (listingId) {
              await supabaseAdmin
                .from("listings")
                .update({
                  platform_listing_id: li.legacyItemId,
                  ...urlPatch,
                  ...lifecyclePatch,
                })
                .eq("id", listingId);
              // US-547: a completed sale is the sell-through signal for the
              // listing_gen prompt that produced this draft.
              if (saleStatus === "completed") {
                await markListingPromptSold(listingId);
              }
            } else {
              // No listings row at all (sold before we ever synced the live
              // listing) — create one so the item carries its eBay link.
              const { data: created } = await supabaseAdmin
                .from("listings")
                .insert({
                  inventory_item_id: itemId,
                  platform: "ebay",
                  // US-1077: a sale we discovered with no local listings row —
                  // it lived on eBay and we never published it → eBay-originated.
                  listing_origin: "ebay",
                  platform_listing_id: li.legacyItemId,
                  listing_url: ebayListingUrl(li.legacyItemId),
                  listing_price: itemCost,
                  listing_status:
                    saleStatus === "completed" ? "sold" : "ended",
                  is_active: false,
                })
                .select("id")
                .maybeSingle();
              listingId = (created as { id: string } | null)?.id ?? null;
            }
          }

          // US-149: a completed sale ends this listing's cross-listed
          // siblings (rows sharing draft_id), honoring the per-user
          // flipdesk_settings.auto_end_cross_listings toggle. Best-effort —
          // never fails the sync.
          if (saleStatus === "completed" && listingId) {
            await autoEndCrossListings(userId, listingId);
          }

          // US-468: dedupe key is (inventory_item_id, platform_order_id,
          // line_item_id) — migration 00130 adds line_item_id to the unique
          // index so two line items of the SAME item in one order don't collapse
          // onto one row. Fetch every existing row for this item+order and let
          // pickSaleRowForLine choose the right one (adopting a legacy null-id
          // row once on the first post-migration re-sync).
          const { data: existingRows } = await supabaseAdmin
            .from("sales")
            // US-3209: shipped_at rides along so resolveShippedAt can hold its
            // forward-only rule. Without it every sync would restamp a date the
            // seller set by hand.
            // US-3466: tracking_number and carrier ride along so the tracking
            // lookup runs only while the row has none, and never overwrites a
            // carrier the seller chose.
            .select("id, line_item_id, shipped_at, tracking_number, carrier")
            .eq("inventory_item_id", itemId)
            .eq("platform_order_id", order.orderId);
          const existing = pickSaleRowForLine(
            (existingRows ?? []) as ExistingSaleRow[],
            li.lineItemId,
          );

          const salePayload = {
            inventory_item_id: itemId,
            listing_id: listingId,
            platform_order_id: order.orderId,
            line_item_id: li.lineItemId ?? "",
            quantity,
            sale_price: itemCost,
            sale_date: order.creationDate?.slice(0, 10) ?? null,
            sold_at: order.creationDate ?? null,
            buyer_username: order.buyerUsername,
            buyer_id: order.buyerUsername,
            shipping_collected: shippingCollected,
            tax,
            status: saleStatus,
            cancelled_at: cancelledAt,
            // US-2031: record what eBay actually told us instead of discarding
            // it. The orphan-sales path already kept this (:1958); the main
            // sales row dropped it, which is why the USD assumption was
            // invisible. NULL when unreported — treated as USD downstream.
            currency: li.itemCost?.currency ?? null,
            // US-3189: the carrier deadline this order is scored on. eBay's own
            // shipByDate when it gave one; otherwise resolveShipBy falls back to
            // sold_at + handling_days, and returns null when it has neither.
            //
            // handling_days stays null from THIS path on purpose: the Sell
            // Fulfillment order carries no handling time, and reading it would
            // mean a business-policy call per order — the exact call volume
            // US-3110 is cutting before the Application Growth Check. The
            // column is written by the seller-defaults path instead, and the
            // fallback lights up for every sale once it is.
            ship_by: resolveShipBy({
              shipByDate: li.shipByDate,
              soldAt: order.creationDate,
              handlingDays: null,
            }),
          };

          // US-3209: eBay already told us this shipped. Believe it.
          //
          // Merged rather than put in the payload above, because the payload is
          // reused for the UPDATE and an unconditional shipped_at there would
          // restamp the column on every sync — overwriting a date the seller
          // set by hand with a fresh one, forever. resolveShippedAt returns null
          // for "leave it alone", which is why this is a spread and not a field.
          const shippedPatch = (() => {
            const at = resolveShippedAt({
              fulfillmentStatus: order.orderFulfillmentStatus,
              existingShippedAt:
                (existing as { shipped_at?: string | null } | null)?.shipped_at ??
                  null,
              orderModifiedAt: order.lastModifiedDate,
            });
            return at ? { shipped_at: at } : {};
          })();
          Object.assign(salePayload, shippedPatch);

          // US-3466: a seller who buys the label on eBay never types the
          // tracking number into GradeThread. Read it from eBay once, while the
          // row has none. Best-effort: a failed lookup never fails the sale.
          const existingTracking = existing as
            | { tracking_number?: string | null; carrier?: string | null }
            | null;
          if (
            needsTrackingLookup({
              fulfillmentStatus: order.orderFulfillmentStatus,
              existingTracking: existingTracking?.tracking_number,
            })
          ) {
            if (!trackingByOrder.has(order.orderId)) {
              let found: OrderTracking | null = null;
              try {
                found = await getOrderTracking(userId, order.orderId);
              } catch (err) {
                console.warn(
                  "[ebay.sync] tracking lookup failed:",
                  err instanceof Error ? err.message : String(err),
                );
              }
              trackingByOrder.set(order.orderId, found);
            }
            const tracking = trackingByOrder.get(order.orderId) ?? null;
            Object.assign(
              salePayload,
              trackingPatch(tracking, existingTracking?.carrier),
            );
            // eBay's own ship date beats lastModifiedDate when we are the
            // ones stamping shipped_at for the first time.
            if (tracking?.shippedDate && "shipped_at" in shippedPatch) {
              const t = Date.parse(tracking.shippedDate);
              if (!Number.isNaN(t)) {
                Object.assign(salePayload, { shipped_at: new Date(t).toISOString() });
              }
            }
          }

          if (existing) {
            const existingSaleId = (existing as { id: string }).id;
            // US-2320: the error used to be discarded and the counter bumped
            // regardless, so a failed write was reported as a synced sale — and
            // the cursor then moved past it. Throw instead: the per-order catch
            // above records it as a failed order, which is what rewinds the
            // cursor to re-pull it.
            // US-3189/US-268: the row was found through this user's own item map,
            // so it is already owner-verified by parent — the explicit user_id
            // predicate is the second lock, and costs nothing because sales.user_id
            // is NOT NULL and trigger-maintained (00146). A sale id that is not
            // this tenant's now updates zero rows instead of one.
            const { error: updErr } = await supabaseAdmin
              .from("sales")
              .update(salePayload)
              .eq("id", existingSaleId)
              .eq("user_id", userId);
            if (updErr) throw new Error(`sale update failed: ${updErr.message}`);
            salesUpdated += 1;
            // US-2022: this sweep is the OTHER way a sale reverses — an order
            // previously synced as completed comes back CANCELED or
            // FULLY_REFUNDED. Without this, only the Post-Order route reversed
            // payouts and a refund discovered by the sweep silently kept the
            // consignor's cut paid out. Idempotent, so overlapping with the
            // Post-Order path cannot double-reverse.
            if (saleStatus !== "completed") {
              void reverseConsignorPayoutsForSales([existingSaleId], userId, {
                reason: `ebay order sync: ${saleStatus}`,
              }).catch((err) => {
                console.error("[ebay.sync] consignor payout reversal failed:", err);
              });
            }
          } else {
            const { data: insertedSale, error: insErr } = await supabaseAdmin
              .from("sales")
              .insert(salePayload)
              .select("id")
              .maybeSingle();
            // US-2320: same defect on the insert side, and worse — a failed
            // insert left `insertedSale` null, so the consignor payout and the
            // sale notification below were skipped too, while salesNew still
            // counted the sale as imported.
            if (insErr) throw new Error(`sale insert failed: ${insErr.message}`);
            salesNew += 1;
            // US-626: a brand-new sale → celebrate it on iOS (best-effort).
            // Only for genuine completed sales, never a cancelled/refunded one.
            if (saleStatus === "completed") {
              // US-1112: a consigned item just sold → fire the consignor's
              // payout immediately when the config flag is 'immediate' (no-op
              // otherwise; the consignor-payouts cron is the catch-all).
              // Best-effort — never fails the sync.
              const newSaleId = (insertedSale as { id: string } | null)?.id;
              if (newSaleId) {
                void maybeFireImmediateConsignorPayout(newSaleId, userId);
              }
              // US-737 / US-1054: a genuinely NEW completed sale (the `existing`
              // dedup guard above) → in-app + push, fired once per sale (never on
              // re-sync), push preference-gated. Best-effort.
              void notifySaleRecorded(userId, {
                itemTitle: li.title,
                price: itemCost,
                itemId,
                // US-3275: the row the Mark shipped button closes. Already in
                // hand from the insert a few lines above.
                saleId: newSaleId ?? null,
              });
              // US-932: feed the internal event stream (drip trigger substrate).
              void emitEvent(userId, "sale_recorded", {
                properties: { inventory_item_id: itemId, sale_price: itemCost },
              });
              // US-1100: capture "who it sold to" on the Garment Passport —
              // a 'sold' event + a pseudonymous sold-to node keyed by a salted
              // hash of the buyer (no PII) + a buyer claim offer. Best-effort;
              // no-op when the item has no passport. Once per NEW sale (this
              // is the dedup-guarded new-insert branch), so it never doubles.
              void recordEbaySale({
                inventoryItemId: itemId,
                ownerId: userId,
                buyerIdentifier: order.buyerUsername ?? null,
                platform: "ebay",
              });
            }
          }

          if (saleStatus === "completed") {
            // Flip the item to sold. resolveStatus-equivalent: 'sold' is a
            // terminal non-prep status so it dominates anything we'd have
            // bumped to via the offer loop above ('listed').
            await supabaseAdmin
              .from("inventory_items")
              .update({ status: "sold" })
              .eq("id", itemId)
              .not("status", "in", "(shipped,completed,returned)");
          } else if (outcome.reversal === "returned") {
            // US-2656: the buyer had it and sent it back. `returned` is the
            // relist loop's entry point and is exactly what the in-app return
            // path writes, so a return the seller handles in eBay's Seller Hub
            // now lands in the same place as one they handle here. Before this
            // it never arrived at all: the in-app path only runs from our own
            // buttons, so an eBay-side refund left the item sitting as sold.
            //
            // Allowed to move a shipped/completed item, unlike the cancel arm
            // below — a return is precisely the case where real fulfilment is
            // undone, and refusing to touch those states is what stranded it.
            await supabaseAdmin
              .from("inventory_items")
              .update({ status: "returned" })
              .eq("id", itemId)
              .in("status", ["sold", "shipped", "completed"]);
            salesReversed += 1;
          } else {
            // Cancelled before it shipped: the item never left, so it is still
            // the seller's and nothing about its condition changed. If a prior
            // sync already flipped it to 'sold', put it back. Don't touch
            // shipped/completed/returned — those represent real fulfilment, and
            // a cancel that reaches them is classified as a return above.
            await supabaseAdmin
              .from("inventory_items")
              .update({ status: "listed" })
              .eq("id", itemId)
              .eq("status", "sold");
            // The eBay listing is almost never live after a sale ended it, so
            // 'listed' can be a lie. resyncItemListedStatus is the existing
            // arbiter: it drops the item to 'drafted' unless a live listing
            // really does exist on some marketplace, so the item lands in Drafts
            // where it can be relisted instead of hiding in a Listed tab with
            // nothing behind it.
            await resyncItemListedStatus(itemId, userId);
            // US-459: report how many cancellations/returns this run handled.
            salesReversed += 1;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`order ${order.orderId}: ${msg.slice(0, 160)}`);
          // US-2320: this order was fetched and not persisted. Recording it is
          // what lets the cursor rewind to it rather than skipping past it.
          failedOrders.push({
            orderId: order.orderId,
            lastModifiedDate: order.lastModifiedDate ?? null,
          });
        }
      }
    }
  } catch (err) {
    // Orders sync failure shouldn't fail the whole pull — listings sync
    // is the more critical of the two. Log + carry on.
    console.error("[flipdesk-ebay] orders sync failed:", err);
    errors.push(
      `orders sync: ${err instanceof Error ? err.message : String(err)}`
    );
    // US-2320: carrying on is fine; carrying on AND stamping the cursor is not.
    // A throw here can happen mid-page, so we do not know which orders we never
    // saw — the only safe cursor is the one we started with.
    ordersFetchComplete = false;
  }

  // ── Finances enrichment (fees + payout) ─────────────────────────
  // For each SALE transaction we find via the Finances API, find the
  // matching sales row by platform_order_id and write through:
  //   platform_fees, payout_amount, payout_reference, net_profit
  // This is what flips the Sold tab badge from "Pending" to "Cleared".
  let salesEnriched = 0;
  try {
    const txns: RemoteTransaction[] = await listRecentTransactions(
      userId,
      sinceISO,
      errors,
    );
    // Build a quick orderId → aggregate map. SALE transactions carry gross
    // + fees; SHIPPING_LABEL transactions carry what the SELLER paid for
    // the eBay shipping label (deducted from the payout). Refunds reduce
    // gross. We sum each per-order so multi-line orders compose cleanly.
    interface OrderAgg {
      gross: number;
      fees: number;
      shippingLabelCost: number;
      payoutId: string | null;
      currency: string;
    }
    const byOrder = new Map<string, OrderAgg>();
    const upsertAgg = (orderId: string): OrderAgg => {
      const existing = byOrder.get(orderId);
      if (existing) return existing;
      const fresh: OrderAgg = {
        gross: 0,
        fees: 0,
        shippingLabelCost: 0,
        payoutId: null,
        currency: "USD",
      };
      byOrder.set(orderId, fresh);
      return fresh;
    };
    for (const t of txns) {
      if (!t.orderId) continue;
      const agg = upsertAgg(t.orderId);
      const amt = t.amount ? Number(t.amount.value) : 0;
      if (t.amount?.currency) agg.currency = t.amount.currency;
      if (t.payoutId && !agg.payoutId) agg.payoutId = t.payoutId;

      switch (t.transactionType) {
        case "SALE":
          agg.gross += amt;
          if (t.totalFeeAmount) {
            agg.fees += Number(t.totalFeeAmount.value);
          }
          break;
        case "SHIPPING_LABEL":
          // Seller-paid label. amount is positive but it's a DEBIT (deducted
          // from the payout). Sum the absolute value either way.
          agg.shippingLabelCost += Math.abs(amt);
          break;
        case "REFUND":
          // Refund issued to buyer — comes out of the seller's payout.
          // Treat as a negative adjustment to gross.
          agg.gross -= Math.abs(amt);
          break;
        // Other types (DISPUTE, CREDIT, NON_SALE_CHARGE) intentionally
        // ignored for now — they're rare and would need per-case handling.
      }
    }

    // Pull every sale this user has with a matching platform_order_id so we
    // can update + compute net_profit (needs cost_basis from inventory_items).
    const orderIds = Array.from(byOrder.keys());
    if (orderIds.length > 0) {
      const { data: salesRows } = await supabaseAdmin
        .from("sales")
        .select(
          "id, inventory_item_id, sale_price, shipping_collected, shipping_cost, grading_cost, other_costs, status, platform_order_id, inventory_items!inner(user_id, acquired_price)"
        )
        .in("platform_order_id", orderIds);

      for (const row of (salesRows ?? []) as unknown as Array<{
        id: string;
        inventory_item_id: string;
        sale_price: number | null;
        shipping_collected: number | null;
        shipping_cost: number | null;
        grading_cost: number | null;
        other_costs: number | null;
        status: string | null;
        platform_order_id: string | null;
        inventory_items: { user_id: string; acquired_price: number | null };
      }>) {
        if (row.inventory_items.user_id !== userId) continue;
        const agg = row.platform_order_id
          ? byOrder.get(row.platform_order_id)
          : null;
        if (!agg) continue;

        const fees = agg.fees;
        // Use eBay's label cost when present, otherwise keep whatever the
        // user manually entered (a USPS direct label, etc.).
        const shippingCost = agg.shippingLabelCost > 0
          ? agg.shippingLabelCost
          : row.shipping_cost ?? 0;
        // Payout = what actually hit the seller's bank: gross - fees - labels.
        // This is the cleared-funds amount, not net profit.
        const payoutAmount = Math.max(
          0,
          agg.gross - fees - agg.shippingLabelCost,
        );

        const salePrice = row.sale_price ?? 0;
        const shippingCollected = row.shipping_collected ?? 0;
        const gradingCost = row.grading_cost ?? 0;
        const otherCosts = row.other_costs ?? 0;
        const costBasis = row.inventory_items.acquired_price ?? 0;
        // US-459: net_profit must REVERSE revenue on a cancelled/refunded sale,
        // not just fee-adjust it. For those, the buyer got their money back and
        // (for a return) the item came back into inventory — so the only thing
        // left on the books is the cash the seller actually ate: the
        // refund-netted gross minus fees minus the shipping label they paid
        // (`agg.gross` already subtracts REFUND transactions). Cost basis is NOT
        // subtracted (the item is retained), and the original sale revenue is
        // NOT counted (it was refunded). This goes negative when the seller ate
        // a label/fee, which is correct.
        const reversed = row.status === "cancelled" || row.status === "refunded";
        const netProfit = reversed
          ? agg.gross - fees - agg.shippingLabelCost
          : // Completed sale: revenue - fees - your costs. Revenue is
            // sale_price + shipping_collected (tax flows to government, not the
            // seller); your costs are cost basis, shipping, grading, other.
            salePrice +
            shippingCollected -
            fees -
            shippingCost -
            gradingCost -
            otherCosts -
            costBasis;

        await supabaseAdmin
          .from("sales")
          .update({
            platform_fees: fees,
            shipping_cost: shippingCost,
            payout_amount: payoutAmount,
            payout_reference: agg.payoutId,
            net_profit: Math.round(netProfit * 100) / 100,
          })
          .eq("id", row.id);
        salesEnriched += 1;
      }
    }
  } catch (err) {
    console.error("[flipdesk-ebay] finances enrichment failed:", err);
    errors.push(
      `finances: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── Ended-without-sale → Drafts (Path A) ────────────────────────────
  // eBay reported these listings as ended/inactive this sync. The orders pass
  // above already flipped genuine sales to 'sold', so anything still in 'listed'
  // here ended without selling (expired, ended on Seller Hub, out of stock with
  // no order, etc.). Move those back to 'drafted' so they surface in the Drafts
  // tab where the seller can edit and relist them, and notify once per item.
  let endedToDraft = 0;
  // US-148: ended listings whose item has a completed sale — their
  // "ended vs active" status observation is a sale, not a conflict.
  const soldEndedItemIds = new Set<string>();
  for (const itemId of endedItemIds) {
    try {
      // Defensive: never regress an item that has a completed sale on record,
      // even if its status drifted (the 'listed'-only guard below already
      // covers the common case).
      const { data: sale } = await supabaseAdmin
        .from("sales")
        .select("id")
        .eq("inventory_item_id", itemId)
        .eq("status", "completed")
        .limit(1)
        .maybeSingle();
      if (sale) {
        soldEndedItemIds.add(itemId);
        continue;
      }

      // US-2179: the eBay listing ended, but a cross-listed item may still be
      // live on another marketplace. Regressing it to 'drafted' then would free
      // an activeListings cap slot the seller is still using and hide a live
      // listing in the Drafts tab. The eBay row is already is_active=false by
      // here (the pendingListing upsert above flushed it), so this check sees
      // only the OTHER platforms.
      if (await itemHasActiveListing(itemId, userId)) continue;

      // Forward-safe: only regress an item that's still sitting in 'listed'.
      // .select() returns the row only when the update actually applied, so the
      // notification fires once on the real transition, not on every re-sync.
      const { data: moved } = await supabaseAdmin
        .from("inventory_items")
        .update({ status: "drafted" })
        .eq("id", itemId)
        .eq("user_id", userId)
        .eq("status", "listed")
        .select("id, title");
      const row = (moved ?? [])[0] as
        | { id: string; title: string | null }
        | undefined;
      if (row) {
        endedToDraft += 1;
        // Record a seller-facing reason on the listing so the Drafts surface can
        // explain WHY it reappeared and prompt the right next step. Stored in
        // publish_error (no schema change); cleared automatically on the next
        // successful publish. Scoped to this owner's ebay listing for the item —
        // and we don't stomp a more specific publish-failure message already on
        // the row.
        //
        // US-2656: this sentence used to be a constant, and it guessed three
        // ways in one breath — "it may have ended, sold out, or been removed by
        // eBay (e.g. a policy issue)". Those need OPPOSITE actions: an ended
        // listing wants a relist, and one eBay took down wants the seller to
        // read their Seller Hub messages first, because relisting the same
        // content gets it taken down again. eBay told us which; now we say so,
        // and fall back to the old disjunction only when it genuinely didn't.
        const state = ebayStateByItem.get(itemId) ?? absentListingState();
        await supabaseAdmin
          .from("listings")
          .update({
            publish_error: (state.message ?? absentListingState().message)!.slice(0, 1000),
            publish_failed_at: new Date().toISOString(),
          })
          .eq("inventory_item_id", itemId)
          .eq("platform", "ebay")
          .is("publish_error", null);
        // US-737 / US-1054: real status transition (listed → drafted), fires once
        // (the .select() above returns the row only when the update applied).
        void notifyListingEnded(userId, { itemTitle: row.title, itemId });
      }
    } catch (err) {
      errors.push(
        `relist-reconcile ${itemId}: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          160,
        ),
      );
    }
  }

  // ── Cross-source conflict detection (US-148) ────────────────────────
  // Runs after the orders pass so status observations for genuinely-sold
  // listings can be dropped instead of flagged.
  let conflictsRecorded = 0;
  let conflictsResolved = 0;
  try {
    const toRecord = ebayObservations.filter(
      (obs) =>
        !(
          obs.field === "listing_status" &&
          obs.itemId &&
          soldEndedItemIds.has(obs.itemId)
        ),
    );
    const res = await recordSourceObservations(userId, "ebay", toRecord);
    conflictsRecorded = res.recorded;
    conflictsResolved = res.resolved;
    errors.push(...res.errors.map((e) => `conflicts: ${e.slice(0, 160)}`));
  } catch (err) {
    errors.push(
      `conflicts: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    );
  }

  // US-3110: record that the offer catalog was read. Orders-only pulls consult
  // this and upgrade themselves to a full read once it goes stale, so nothing
  // schedules the catalog reconcile separately. Stamped even when the orders
  // pass below fails — the catalog really was read, and conflating the two
  // cursors is what makes one failure re-trigger the expensive half.
  if (catalogPass) {
    await supabaseAdmin
      .from("marketplace_connections")
      .update({ last_catalog_synced_at: new Date().toISOString() })
      .eq("id", connId);
  }

  // Stamp last_synced_at so the UI can show "Synced 2m ago" + the next
  // /listings/pull picks up where this one left off.
  //
  // US-2320: this column is the ORDERS CURSOR, not a "the job ran" ping —
  // doListingsPull reads it back as `since` for the next incremental pull. It
  // used to be stamped unconditionally, so any orders failure moved the cursor
  // past orders that were never written and nothing ever asked for them again.
  const watermark = planOrdersWatermark({
    fetchComplete: ordersFetchComplete,
    failedOrders,
    now: new Date().toISOString(),
  });
  if (watermark.advance) {
    await supabaseAdmin
      .from("marketplace_connections")
      .update({ last_synced_at: watermark.to })
      .eq("id", connId);
    if (watermark.reason === "rewound") {
      console.warn(
        `[flipdesk-ebay] ${failedOrders.length} order(s) failed to persist; ` +
          `cursor rewound to ${watermark.to} so they re-pull next sync`,
      );
      errors.push(
        `orders: ${failedOrders.length} order(s) not saved — sync cursor held at ` +
          `${watermark.to} so they are re-pulled. This sync is PARTIAL.`,
      );
    }
  } else {
    // The cursor stays where it was, so the next pull re-asks for the same
    // window. The UI's completion poll watches this column, so leaving it alone
    // is also what stops "Synced just now" from claiming a sync that lost data.
    console.error(
      `[flipdesk-ebay] orders pass incomplete (${watermark.reason}); ` +
        `last_synced_at NOT advanced — the next sync re-pulls this window`,
    );
    errors.push(
      `orders: sync cursor NOT advanced (${watermark.reason}). This sync is ` +
        `PARTIAL — the missing orders will be re-pulled on the next sync.`,
    );
  }

  console.log(
    `[flipdesk-ebay] pull complete: matched=${matched} unmatched=${unmatched} ` +
      `skipped=${skipped} legacy_matched=${legacyMatched} ` +
      `legacy_unmatched=${legacyUnmatched} legacy_duplicates=${legacyDuplicates} ` +
      `sales_new=${salesNew} sales_updated=${salesUpdated} ` +
      `sales_skipped=${salesSkipped} sales_enriched=${salesEnriched} ` +
      `catalog_updated=${catalogUpdated} specifics_fetched=${specificsFetched}` +
      `${specificsCapped ? ` (capped at ${MAX_SPECIFICS_FETCH_PER_SYNC}; remaining items backfill next sync)` : ""} ` +
      `ended_to_draft=${endedToDraft} photos_mirrored=${photosMirrored} ` +
      // US-3458: adopted = new items from orphans this pass; linked = orphans
      // that already had a listing row (crash recovery or a manual link);
      // held = orphans left for the seller because an item with the same title
      // exists; deferred = adoptable orphans past the per-pass cap.
      `orphans_adopted=${orphansAdopted} orphans_linked=${orphansLinked} ` +
      `orphans_held=${orphansHeld} orphans_deferred=${orphansDeferred} ` +
      `conflicts_recorded=${conflictsRecorded} conflicts_resolved=${conflictsResolved} ` +
      // US-3110: the per-SKU offer fan-out is the largest remaining block of
      // eBay call volume, and "how many of those reads can never be cached"
      // was previously answerable only by dividing the daily call total by the
      // SKU count and guessing.
      // US-3362: offers_unresolved is the residue AFTER the join - the SKUs
      // eBay names that map to no local item at all (another tool's listing, or
      // an item deleted here). Printed next to offers_read so the operator can
      // read the fraction straight off the line instead of inferring it from
      // the daily call total.
      (offerStampCoverage
        ? `offers_read=${offerStampCoverage.read} ` +
          `offers_stamped=${offerStampCoverage.stamped} ` +
          `offers_unstamped=${offerStampCoverage.unstamped} ` +
          `offers_unresolved=${offerStampPlan?.unresolved.length ?? 0} `
        : "") +
      `errors=${errors.length}`,
  );

  // Persist the run so the Reconciliation page can show its stats. Per-phase
  // failures were collected in `errors` without aborting the pull, so a run
  // that finished with any errors is "partial", otherwise "success".
  await recordSyncRun(userId, {
    startedAt,
    since: sinceISO,
    status: errors.length > 0 ? "partial" : "success",
    total: offers.length,
    matched,
    unmatched,
    skipped,
    legacyMatched,
    legacyUnmatched,
    legacyDuplicates,
    salesNew,
    salesUpdated,
    salesSkipped,
    salesEnriched,
    salesReversed,
    errors,
  }, runId);
}

// /listings/pull — validates the connection then fires the heavy sync as a
// detached background task, returning 202 immediately.  The actual work is
// done by doListingsPull() above; the frontend polls last_synced_at to know
// when it is done.
flipdeskEbayRoutes.post("/listings/pull", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Validate that the user has an active connection before firing the job.
  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, last_synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: sync the selected (primary) connection.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) {
    return c.json({ error: "Connect your eBay account first." }, 400);
  }
  const connId = (conn as { id: string; last_synced_at: string | null }).id;
  const lastSyncedAt =
    (conn as { id: string; last_synced_at: string | null }).last_synced_at ?? null;

  // ?full=true forces a one-time historical backfill: the orders + Finances
  // sync reaches back ~24 months instead of the incremental window, so sales
  // that predate the FlipDesk connection get imported.
  const backfill = c.req.query("full") === "true";

  // US-456: claim the in-flight lock BEFORE firing. A concurrent pull for the
  // same tenant is rejected (409) instead of racing writes; a dead run is reaped
  // inside claimSyncRun so a crash can't lock the tenant out permanently.
  const claim = await claimSyncRun(userId, "ebay");
  if (claim.status === "already_running") {
    return c.json(
      { error: "A sync is already running for this account.", alreadyRunning: true },
      409,
    );
  }
  const runId = claim.status === "claimed" ? claim.runId : null;

  // Fire-and-forget — do NOT await this. Returning 202 before the work starts
  // means the HTTP connection closes immediately, safely below Cloudflare's
  // 100s proxy timeout. The frontend polls last_synced_at to detect completion.
  // The .catch finalizes the lock as failed on an unexpected throw (the success
  // /partial and early fetch-failure paths finalize themselves via runId), so
  // the run never stays stuck in 'running'.
  void doListingsPull(userId, connId, lastSyncedAt, backfill, runId).catch(
    async (err) => {
      console.error("[flipdesk-ebay] background sync crashed:", err);
      if (runId) {
        await failSyncRun(runId, err instanceof Error ? err.message : String(err));
      }
    },
  );

  return c.json({ ok: true, message: "Sync started in background." }, 202);
});

// US-471: targeted incremental sync used by the eBay Notification webhook when
// an order/sale/return topic arrives, so sold/returned state updates in
// near-real-time instead of waiting for the next manual or scheduled pull.
// Mirrors the /listings/pull handler (validate connection → claim the in-flight
// lock → fire doListingsPull incrementally) but takes no Context: it's invoked
// from processEbayWebhookEvent after the seller has been resolved from the
// verified payload. Always incremental (never a backfill) and best-effort —
// returns a status string instead of throwing so a webhook ack is never blocked.
/**
 * US-3110: decide what a caller's requested scope actually becomes.
 *
 * "orders" is a request, not a guarantee: once the offer catalog goes stale the
 * next orders-only pull upgrades itself to a full read. That keeps the catalog
 * reconcile on a schedule without a separate cron, and means a caller can never
 * starve it by asking for "orders" forever.
 *
 * Pure so the decision is testable without a database.
 */
export function resolveSyncScope(
  requested: EbaySyncScope,
  lastCatalogSyncedAt: string | null,
  nowMs: number = Date.now(),
): EbaySyncScope {
  if (requested === "full") return "full";
  if (!lastCatalogSyncedAt) return "full";
  const at = Date.parse(lastCatalogSyncedAt);
  if (!Number.isFinite(at)) return "full";
  return nowMs - at >= CATALOG_REFRESH_MS ? "full" : "orders";
}

interface EbayConnectionCursor {
  id: string;
  last_synced_at: string | null;
  last_catalog_synced_at: string | null;
}

export async function triggerEbaySyncForUser(
  userId: string,
  // Default stays "full" so every existing caller behaves exactly as before.
  // Only the two paths that demonstrably need orders alone — the notification
  // webhook and the order backstop — pass "orders".
  requestedScope: EbaySyncScope = "full",
): Promise<"started" | "already_running" | "no_connection" | "not_configured"> {
  if (!isEbayConfigured()) return "not_configured";

  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, last_synced_at, last_catalog_synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) return "no_connection";

  const row = conn as EbayConnectionCursor;
  const connId = row.id;
  const lastSyncedAt = row.last_synced_at ?? null;
  const scope = resolveSyncScope(requestedScope, row.last_catalog_synced_at ?? null);

  // Reuse the same per-tenant lock the manual pull uses: if a sync is already
  // running (manual, scheduled, or a prior webhook), don't race — the in-flight
  // run will pick up the just-changed order. claimSyncRun reaps dead runs.
  const claim = await claimSyncRun(userId, "ebay");
  if (claim.status === "already_running") return "already_running";
  const runId = claim.status === "claimed" ? claim.runId : null;

  void doListingsPull(userId, connId, lastSyncedAt, false, runId, scope).catch(
    async (err) => {
      console.error("[flipdesk-ebay] webhook-triggered sync crashed:", err);
      if (runId) {
        await failSyncRun(runId, err instanceof Error ? err.message : String(err));
      }
    },
  );
  return "started";
}

// GET /sync-runs — recent sync-run history for the Reconciliation page.
// Tenant-scoped to the workspace owner (the account the sync runs on behalf
// of). Returns the freshest runs first; default 20, capped at 50.
flipdeskEbayRoutes.get("/sync-runs", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit")) || 20, 1),
    50,
  );
  const { data, error } = await supabaseAdmin
    .from("flipdesk_sync_runs")
    .select("*")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) return failSafe(c, 500, "Couldn't load sync runs.", error, "ebay.sync-runs");
  return c.json({ runs: data ?? [] });
});

// US-1968: bring EXISTING eBay (Trading-created) listings under management.
//
// Imported listings are read-only mirrors: revise/reprice/withdraw/relist all
// refuse origin='ebay'. bulk_migrate_listing converts them into managed
// Inventory offers. See lib/ebay-migrate.ts for why the returned SKU is the
// load-bearing part — flipping origin without persisting it produces a row that
// is marked managed, is NOT addressable by any Inventory call, and has ALSO
// stopped being refreshed by the inbound pull (SYNC_SOURCE_OF_TRUTH only lets
// the pull overwrite EBAY_OWNED_LISTING_FIELDS while origin='ebay'). That is
// strictly worse than the mirror it replaced, so origin and inventory_sku are
// written in the SAME update, and only when eBay returned a SKU.
flipdeskEbayRoutes.post("/listings/migrate", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const requestedIds = Array.isArray(body.listing_ids)
    ? [...new Set(body.listing_ids.filter((v): v is string => typeof v === "string"))]
    : [];
  if (requestedIds.length === 0) {
    return c.json({ error: "listing_ids (array) is required" }, 400);
  }
  if (requestedIds.length > MIGRATE_MAX_PER_REQUEST) {
    return c.json(
      {
        error:
          `Too many listings in one request (max ${MIGRATE_MAX_PER_REQUEST}). ` +
          `Migrate in smaller batches.`,
      },
      400,
    );
  }

  // US-268: the ids come from the request body, so they are attacker input.
  // Scope the read by the OWNER's tenant and act only on what comes back —
  // never on the requested ids directly.
  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_listing_id, platform_offer_id, listing_origin, listing_status, is_active, inventory_sku, marketplace_connection_id, batch_id, synced_to_ebay_at",
    )
    .in("id", requestedIds)
    .eq("platform", "ebay")
    .eq("user_id", userId);
  const owned = (rows ?? []) as Array<{
    id: string;
    platform_listing_id: string | null;
    platform_offer_id: string | null;
    listing_origin: string | null;
    listing_status: string | null;
    is_active: boolean | null;
    inventory_sku: string | null;
    marketplace_connection_id: string | null;
    batch_id: string | null;
    synced_to_ebay_at: string | null;
  }>;

  // US-268: if NONE of the requested ids belong to this tenant, deny outright
  // rather than returning 200 with a per-item "not found". Two reasons: a bulk
  // 200 makes a cross-tenant probe indistinguishable from a success at the
  // status level (the tenant-isolation suite asserts on status, and so would a
  // reviewer), and "you asked only for listings that aren't yours" genuinely is
  // a 404. A MIXED request still returns 200 with per-item reasons, because the
  // caller's own listings must not be held hostage to one bad id.
  if (owned.length === 0) {
    return c.json({ error: "Listing not found" }, 404);
  }

  const results: Array<{
    listing_id: string;
    status: "migrated" | "already_managed" | "skipped" | "failed";
    sku?: string | null;
    offer_id?: string | null;
    reason?: string;
  }> = [];

  // Eligibility, and the reason for each rejection — AC3 applies to OUR skips
  // just as much as to eBay's, otherwise a listing vanishes from the result
  // with no explanation of why it was never attempted.
  const eligible: typeof owned = [];
  for (const id of requestedIds) {
    const row = owned.find((r) => r.id === id);
    if (!row) {
      results.push({ listing_id: id, status: "skipped", reason: "Listing not found" });
      continue;
    }
    // Idempotency (AC4): a row already migrated is a no-op, not an error, so a
    // retry after a partial batch is safe and reports the same end state.
    if (row.inventory_sku && row.listing_origin !== "ebay") {
      results.push({
        listing_id: id,
        status: "already_managed",
        sku: row.inventory_sku,
        offer_id: row.platform_offer_id,
      });
      continue;
    }
    const origin = deriveListingOrigin({
      listing_origin: row.listing_origin,
      platform: "ebay",
      platform_listing_id: row.platform_listing_id,
      batch_id: row.batch_id,
      synced_to_ebay_at: row.synced_to_ebay_at,
    });
    if (origin !== "ebay") {
      results.push({
        listing_id: id,
        status: "skipped",
        reason:
          "This listing was published from FlipDesk and is already managed — migration only applies to listings created on eBay.",
      });
      continue;
    }
    if (!row.platform_listing_id) {
      results.push({
        listing_id: id,
        status: "skipped",
        reason: "No eBay listing id on this row, so there is nothing to migrate.",
      });
      continue;
    }
    const live = row.is_active === true ||
      row.listing_status === "active" ||
      row.listing_status === "relisted";
    if (!live) {
      results.push({
        listing_id: id,
        status: "skipped",
        reason: "Only ACTIVE eBay listings can be migrated.",
      });
      continue;
    }
    eligible.push(row);
  }

  // eBay caps the call at 5 listings; chunk and keep going on a batch error so
  // one bad batch cannot fail the rest.
  for (const batch of chunkForMigrate(eligible)) {
    const byEbayId = new Map(batch.map((r) => [r.platform_listing_id as string, r]));
    let outcomes: ReturnType<typeof parseMigrateResponse>;
    try {
      const raw = await bulkMigrateListing(
        userId,
        batch.map((r) => r.platform_listing_id as string),
        // Migrate through the connection that owns the listing (null → primary),
        // or a multi-store seller's migration lands on the wrong account.
        batch[0]?.marketplace_connection_id ?? undefined,
      );
      outcomes = parseMigrateResponse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[flipdesk-ebay] bulkMigrateListing failed:", err);
      for (const r of batch) {
        results.push({ listing_id: r.id, status: "failed", reason: msg.slice(0, 300) });
      }
      continue;
    }

    // A listing eBay simply omitted from responses[] must not disappear.
    const answered = new Set<string>();
    for (const outcome of outcomes) {
      const row = byEbayId.get(outcome.listingId);
      if (!row) continue; // not ours / not in this batch — ignore defensively
      answered.add(outcome.listingId);

      if (!outcome.ok || !outcome.sku) {
        results.push({
          listing_id: row.id,
          status: "failed",
          reason: outcome.reason ?? "eBay declined the migration.",
        });
        continue;
      }

      // The single write that makes the row managed. inventory_sku and the
      // origin flip travel TOGETHER — see this block's header.
      const { error: updErr } = await supabaseAdmin
        .from("listings")
        .update({
          inventory_sku: outcome.sku,
          ...(outcome.offerId ? { platform_offer_id: outcome.offerId } : {}),
          listing_origin: "gradethread" as const,
        })
        .eq("id", row.id)
        .eq("user_id", userId);
      if (updErr) {
        // eBay migrated it but we failed to record it. Say so precisely: the
        // listing IS an Inventory offer now, and a retry is safe because the
        // migration itself is idempotent on eBay's side.
        results.push({
          listing_id: row.id,
          status: "failed",
          reason:
            `Migrated on eBay (SKU ${outcome.sku}) but could not be saved locally: ` +
            `${updErr.message}. Retry — the migration is idempotent.`,
        });
        continue;
      }
      results.push({
        listing_id: row.id,
        status: "migrated",
        sku: outcome.sku,
        offer_id: outcome.offerId,
      });
    }
    for (const r of batch) {
      if (!answered.has(r.platform_listing_id as string)) {
        results.push({
          listing_id: r.id,
          status: "failed",
          reason: "eBay returned no result for this listing.",
        });
      }
    }
  }

  const summary = {
    migrated: results.filter((r) => r.status === "migrated").length,
    already_managed: results.filter((r) => r.status === "already_managed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
  return c.json({ ok: true, summary, results });
});
