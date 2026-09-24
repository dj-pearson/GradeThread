// US-2173: the listings table's page-scoped detail reads, lifted out of the
// page component.
//
// ── US-2168: per-row detail, scoped to the VISIBLE PAGE ──────────────────
//
// These five reads decorate rendered rows (platform chips, draft metadata,
// publish errors, cover thumbnails, impressions/CTR). Every one of them used
// to fetch the WHOLE TENANT and then get looked up by id during render.
//
// The cover query was the worst of it: no filter and no limit on item_photos,
// so a 500-item seller with 8 photos each transferred ~4,000 rows to draw 50
// thumbnails. The other four pulled every listing row the seller owned.
//
// They key on pageRowIds, so the cost tracks what is on screen rather than what
// is in the account. The CALLER must invoke this hook below its pageRows
// computation, because that is where those ids exist — hooks run in order, so
// that position is load-bearing, not stylistic.
//
// Safe to page-scope because all five are consumed ONLY inside the row render.
// None feeds filtering, sorting or the tab counts (those come from
// useInventoryStatusCounts, a server-side grouped count). If one ever starts
// feeding a filter, it has to go back to a full-set read or the filter will
// silently only see the current page.
//
// Reads are CHUNKED: at pageSize 200 a bare .in() would put ~7.4KB of UUIDs in
// the query string and risk a URL-length rejection at the proxy.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { fetchInChunks } from "@/lib/supabase-batch";
import { deriveListingOrigin } from "@/lib/listing-origin";
import { scoreMapFromRows, type QualityScoreRow } from "@/pages/flipdesk/draft-quality";
import type { QualityScoreSummary } from "@/components/flipdesk/quality-score-chip";
import type {
  AspectReviewEntry,
  ItemFullRow,
  ListingPlatform,
} from "@/types/database";
import { blockingAspectReview } from "@/lib/aspect-review";
import type { FilterQuery } from "@/lib/item-filter";
import type { TabId } from "@/pages/flipdesk/inventory-tabs";
import type { SoldFilter, SortPreset } from "@/pages/flipdesk/listings-filter";
import type { UnlistedFilter } from "@/pages/flipdesk/inventory-tabs";
import { LISTINGS_COLUMN_LIST } from "@/pages/flipdesk/listings-columns";

// US-1568: draft listing metadata not on items_full (from the listings table).
interface DraftMetaRow {
  inventory_item_id: string;
  listing_price: number | null;
  price_is_estimated: boolean | null;
  price_comp_source: string | null;
  aspect_review: AspectReviewEntry[] | null;
  batch_id: string | null;
  scheduled_publish_at: string | null;
}

/**
 * What `flipdesk_listing_page` returns (US-2168 AC3, migration 00515).
 *
 * It lives here rather than in the page because two modules now depend on the
 * shape: the page renders it, and listings-actions.ts replays the same RPC to
 * build the CSV export. A second hand-written copy is how the two would drift.
 */
/** Everything that decides WHICH rows the listing page shows. */
export interface ListingPageCriteria {
  tab: TabId;
  search: string;
  soldFilter: SoldFilter;
  unlistedFilter: UnlistedFilter;
  filterQuery: FilterQuery;
  columnSort: { field: keyof ItemFullRow; dir: "asc" | "desc" } | null;
  sortPreset: SortPreset;
  agedThresholdDays: number;
  /**
   * INV-D1: the workspace on screen (activeWorkspaceOwnerId, else the user).
   * RLS admits every workspace the caller belongs to, so without this a
   * seller in two workspaces saw both mixed in one table.
   */
  ownerId: string;
}

/**
 * INV-D1: the cache-key prefix for the listings table. It names the WORKSPACE
 * rather than the signed-in user, so switching workspace is a different cache
 * entry and a page from one workspace is never served under another. The
 * first two elements are unchanged, so invalidateQueries({ queryKey:
 * ["items_full"] }) still sweeps it.
 */
export function listingsItemsKeyFor(ownerId: string | undefined) {
  return ["items_full", "listings", ownerId] as const;
}

/**
 * INV-6: the `flipdesk_listing_page` arguments for a set of criteria, minus
 * `p_limit` / `p_offset`. The page query and the select-all / CSV export both
 * build their call from this, so the two cannot disagree about which rows
 * match. They did: the export and select-all left out the Unlisted chip and the
 * seller's Aged threshold, so "Select all" on Unlisted > Ready picked undrafted
 * rows and then offered Publish.
 */
/**
 * The 90-day Sold window, expressed without a migration.
 *
 * flipdesk_listing_page's p_sold_filter knows d7/d30/ytd and treats anything
 * else as "all". 'd90' is sent instead as a sale_date >= rule in p_filter,
 * which flipdesk_filter_matches already evaluates. That only composes with an
 * AND filter: under an OR filter the rule would widen the result rather than
 * narrow it, so there the window is dropped and the tab shows every sale.
 */
function soldWindowArgs(
  soldFilter: SoldFilter,
  filterQuery: FilterQuery,
  now: Date,
): { p_sold_filter: string; p_filter: FilterQuery } {
  if (soldFilter !== "d90") return { p_sold_filter: soldFilter, p_filter: filterQuery };
  if (filterQuery.combinator === "or" && filterQuery.rules.length > 0) {
    return { p_sold_filter: "all", p_filter: filterQuery };
  }
  const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  return {
    p_sold_filter: "all",
    p_filter: {
      combinator: "and",
      rules: [
        ...filterQuery.rules,
        { id: "sold-window-d90", field: "sale_date", op: "gte", value: from },
      ],
    },
  };
}

export function listingPageArgs(c: ListingPageCriteria, now: Date = new Date()) {
  const window = c.tab === "sold"
    ? soldWindowArgs(c.soldFilter, c.filterQuery, now)
    : { p_sold_filter: c.soldFilter, p_filter: c.filterQuery };
  return {
    p_tab: c.tab,
    p_search: c.search,
    p_sold_filter: window.p_sold_filter,
    // Only consulted on the Unlisted tab, like p_sold_filter on Sold.
    p_unlisted_filter: c.unlistedFilter,
    p_filter: window.p_filter,
    p_column_sort: c.columnSort,
    p_sort_preset: c.sortPreset,
    // "Year to date" means the VIEWER's year; the database cannot know it.
    p_ytd_start: new Date(new Date().getFullYear(), 0, 1).toISOString(),
    // The projection stays in ONE place (listings-columns.ts) and is sent to
    // the server rather than restated in SQL, where it would drift the first
    // time a column was added.
    p_columns: LISTINGS_COLUMN_LIST,
    // US-3195: only consulted on the Aged tab.
    p_aged_threshold_days: c.agedThresholdDays,
    // INV-D1 (migration 00833): one workspace. The server checks the caller
    // may read it (42501 otherwise) and treats null as the caller's own rows.
    p_owner_id: c.ownerId || null,
  };
}

/** The page's cover photo per item, plus whether it has the required photos. */
export interface PageCover {
  thumbnail_url: string | null;
  photo_url: string | null;
  hasRequiredPhotos: boolean;
}

export interface ListingPageResult {
  total: number;
  rows: ItemFullRow[];
  soldAgg: {
    count: number;
    gross: number;
    net: number;
    avgMargin: number | null;
  } | null;
  buyerCounts: Record<string, number>;
}

export interface DraftMeta {
  listingPrice: number | null;
  priceIsEstimated: boolean;
  priceCompSource: string | null;
  aspectCount: number;
  batchId: string | null;
  scheduledPublishAt: string | null;
}

// One chip in the Platforms column (US-149) — a listings row this item has
// on a marketplace, cross-listing siblings included.
export interface PlatformChip {
  id: string;
  platform: ListingPlatform;
  status: string;
  origin: "ebay" | "gradethread";
  /** US-3451: what the channel strip needs to derive the row's state. */
  listing_url: string | null;
  delist_requested_at: string | null;
  listed_unconfirmed: boolean;
  updated_at: string | null;
}

export interface PageRowDetailsInput {
  userId: string | undefined;
  pageRows: ItemFullRow[];
  pageRowIds: string[];
  /** Whether the page can hold drafted rows (Unlisted), so draft metadata is read. */
  hasDrafts: boolean;
  isActive: boolean;
}

export function usePageRowDetails({
  userId,
  pageRows,
  pageRowIds,
  hasDrafts,
  isActive,
}: PageRowDetailsInput) {
  // US-149: which marketplaces each item is listed on (draft/active/sold rows
  // across the cross-listing group) — drives the Platforms column chips.
  const { data: platformsByItem } = useQuery({
    queryKey: ["item_listing_platforms", userId, pageRowIds],
    enabled: !!userId && pageRowIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, PlatformChip[]>> => {
      // US-3451: the strip derives each channel's state (channel-state.ts)
      // from these rows, so the four columns it reads ride the same request
      // rather than a second one per row. `listed_unconfirmed` is one JSON
      // key rather than the whole platform_fields blob, which carries every
      // channel's AI copy and would multiply the page read by the kit.
      // Ended rows are read too: an ended row with a delist stamp is a
      // listing still live on the marketplace, which is the one state a
      // seller most needs to see on the table.
      const rows = await fetchInChunks<{
        id: string;
        inventory_item_id: string;
        platform: ListingPlatform;
        listing_status: string;
        listing_origin: string | null;
        platform_listing_id: string | null;
        batch_id: string | null;
        synced_to_ebay_at: string | null;
        listing_url: string | null;
        delist_requested_at: string | null;
        listed_unconfirmed: string | null;
        updated_at: string | null;
      }>(pageRowIds, async (chunk) => {
        const { data, error } = await supabase
          .from("listings")
          .select(
            "id, inventory_item_id, platform, listing_status, listing_origin, platform_listing_id, batch_id, synced_to_ebay_at, " +
              "listing_url, delist_requested_at, listed_unconfirmed:platform_fields->>listed_unconfirmed, updated_at",
          )
          .in("inventory_item_id", chunk)
          .in("listing_status", ["draft", "active", "sold", "ended"]);
        return { data: data as unknown[] | null, error };
      });
      const map = new Map<string, PlatformChip[]>();
      for (const row of rows) {
        const arr = map.get(row.inventory_item_id) ?? [];
        arr.push({
          id: row.id,
          platform: row.platform,
          status: row.listing_status,
          origin: deriveListingOrigin(row),
          listing_url: row.listing_url,
          delist_requested_at: row.delist_requested_at,
          listed_unconfirmed: row.listed_unconfirmed === "true",
          updated_at: row.updated_at,
        });
        map.set(row.inventory_item_id, arr);
      }
      return map;
    },
  });

  // US-1568 AC3: the listing-level draft metadata the AutoLister cockpit shows
  // (price + "estimated" badge, aspect_review count, batch link, scheduled-drop
  // date) that ISN'T on the items_full view. RLS scopes it to the caller's own
  // listings; pageRowIds scopes it to what's rendered.
  const { data: draftMetaByItem } = useQuery({
    queryKey: ["item_draft_meta", userId, pageRowIds],
    enabled: !!userId && hasDrafts && pageRowIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, DraftMeta>> => {
      const rows = await fetchInChunks<DraftMetaRow>(pageRowIds, async (chunk) => {
        const { data, error } = await supabase
          .from("listings")
          .select(
            "inventory_item_id, listing_price, price_is_estimated, price_comp_source, aspect_review, batch_id, scheduled_publish_at",
          )
          .in("inventory_item_id", chunk)
          .eq("listing_status", "draft")
          .not("batch_id", "is", null);
        return { data: data as unknown[] | null, error };
      });
      const map = new Map<string, DraftMeta>();
      for (const row of rows) {
        // One draft per item in practice; if several, the first (any) is fine.
        if (!map.has(row.inventory_item_id)) {
          map.set(row.inventory_item_id, {
            listingPrice: row.listing_price,
            priceIsEstimated: row.price_is_estimated === true,
            priceCompSource: row.price_comp_source ?? null,
            aspectCount: Array.isArray(row.aspect_review) ? blockingAspectReview(row.aspect_review).length : 0,
            batchId: row.batch_id ?? null,
            scheduledPublishAt: row.scheduled_publish_at ?? null,
          });
        }
      }
      return map;
    },
  });

  // Per-item "needs attention" reason for eBay listings the sync (or an end)
  // moved back to Drafts because eBay no longer shows them active — ended, sold
  // out, or removed for a policy issue. The edge stores the reason in
  // listings.publish_error; we surface it as a warning on the Drafts row.
  const { data: publishIssuesByItem } = useQuery({
    queryKey: ["items_full", "listings", "publish_issues", userId, pageRowIds],
    enabled: !!userId && pageRowIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, string>> => {
      const rows = await fetchInChunks<{
        inventory_item_id: string | null;
        publish_error: string | null;
      }>(pageRowIds, async (chunk) => {
        const { data, error } = await supabase
          .from("listings")
          .select("inventory_item_id, publish_error")
          .in("inventory_item_id", chunk)
          .eq("platform", "ebay")
          .not("publish_error", "is", null);
        return { data: data as unknown[] | null, error };
      });
      const map = new Map<string, string>();
      for (const row of rows) {
        if (row.inventory_item_id && row.publish_error) {
          map.set(row.inventory_item_id, row.publish_error);
        }
      }
      return map;
    },
  });

  // Cover photo per item for the row thumbnail (parity with iOS). The cover =
  // the LOWEST sort_order photo per item (same rule as iOS SyncEngine
  // .primaryPhotos); the URL prefers the generated thumbnail via itemPhotoThumb().
  // Ordered ascending, first row per item wins.
  const { data: coverByItem } = useQuery({
    queryKey: ["items_full", "listings", "covers", userId, pageRowIds],
    enabled: !!userId && pageRowIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, PageCover>> => {
      const rows = await fetchInChunks<{
        inventory_item_id: string | null;
        thumbnail_url: string | null;
        photo_url: string | null;
        photo_type: string | null;
      }>(pageRowIds, async (chunk) => {
        const { data, error } = await supabase
          .from("item_photos")
          .select("inventory_item_id, thumbnail_url, photo_url, sort_order, photo_type")
          .in("inventory_item_id", chunk)
          .order("sort_order", { ascending: true });
        return { data: data as unknown[] | null, error };
      });
      const map = new Map<string, PageCover>();
      const types = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!row.inventory_item_id) continue;
        // First (lowest sort_order) row per item is the cover. Chunking preserves
        // this: each chunk is ordered, and an item's photos never span chunks
        // because chunking is BY ITEM ID.
        if (!map.has(row.inventory_item_id)) {
          map.set(row.inventory_item_id, {
            thumbnail_url: row.thumbnail_url,
            photo_url: row.photo_url,
            hasRequiredPhotos: false,
          });
        }
        if (row.photo_type) {
          const set = types.get(row.inventory_item_id) ?? new Set<string>();
          set.add(row.photo_type);
          types.set(row.inventory_item_id, set);
        }
      }
      // INV-14: the same rule as items_full.has_required_photos (a front AND
      // a back), which the listings projection leaves out because it is a
      // per-row subquery. The page's own photo read answers it for free, and
      // the Next column needs it to say "Add photos" only when that is true.
      for (const [id, cover] of map) {
        const t = types.get(id);
        cover.hasRequiredPhotos = !!t && t.has("front") && t.has("back");
      }
      return map;
    },
  });

  // US-151: per-item analytics metrics (impressions / CTR) for the Active tab.
  const { data: metricsByItem } = useQuery({
    queryKey: ["item_listing_metrics", userId, pageRowIds],
    enabled: !!userId && isActive && pageRowIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, { impressions: number; ctr: number | null }>> => {
      const rows = await fetchInChunks<{
        inventory_item_id: string;
        impressions_7d: number | null;
        click_through_rate: number | null;
      }>(pageRowIds, async (chunk) => {
        const { data, error } = await supabase
          .from("listings")
          .select("inventory_item_id, impressions_7d, click_through_rate")
          .in("inventory_item_id", chunk)
          .eq("platform", "ebay")
          .eq("listing_status", "active");
        return { data: data as unknown[] | null, error };
      });
      const map = new Map<string, { impressions: number; ctr: number | null }>();
      for (const row of rows) {
        map.set(row.inventory_item_id, {
          impressions: row.impressions_7d ?? 0,
          ctr: row.click_through_rate,
        });
      }
      return map;
    },
  });

  // US-2170: the Listing Quality Score, on the surface where listings are
  // actually managed.
  //
  // The score has been computed, persisted (listings.quality_score, 00476) and
  // unit-tested since US-1897 — and rendered in exactly ONE place, the AutoLister
  // drafts cockpit. The "one 0-100 number per listing" was invisible to anyone
  // working the inventory table.
  //
  // Keyed by LISTING id, not item id: items_full lateral-joins one listing per
  // item (most recent by listed_at) and exposes it as listing_id, and every other
  // listing-derived cell in this row — price, status, days listed — comes from
  // that same row. Scoring a different listing than the one the row displays
  // would put two listings' facts in one line.
  //
  // The error→empty-map fallback is deliberate and copied from the drafts
  // cockpit: if this ever runs against a database where the column is missing,
  // PostgREST answers 42703 and would take the WHOLE query down. An empty map
  // just means every row reads "not scored", which is exactly what it would be.
  const pageListingIds = useMemo(
    () =>
      pageRows
        .map((r) => r.listing_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    [pageRows],
  );
  const { data: qualityByListing = {} } = useQuery({
    queryKey: ["item_listing_quality", userId, pageListingIds],
    enabled: !!userId && (hasDrafts || isActive) && pageListingIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Record<string, QualityScoreSummary>> => {
      try {
        const rows = await fetchInChunks<QualityScoreRow>(
          pageListingIds,
          async (chunk) => {
            const { data, error } = await supabase
              .from("listings")
              .select("id, quality_score, quality_blocked")
              .in("id", chunk);
            return { data: data as unknown[] | null, error };
          },
        );
        return scoreMapFromRows(rows);
      } catch {
        return {};
      }
    },
  });

  return {
    platformsByItem,
    draftMetaByItem,
    publishIssuesByItem,
    coverByItem,
    metricsByItem,
    qualityByListing,
  };
}
