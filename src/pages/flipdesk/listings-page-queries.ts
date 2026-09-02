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
      const rows = await fetchInChunks<{
        id: string;
        inventory_item_id: string;
        platform: ListingPlatform;
        listing_status: string;
        listing_origin: string | null;
        platform_listing_id: string | null;
        batch_id: string | null;
        synced_to_ebay_at: string | null;
      }>(pageRowIds, async (chunk) => {
        const { data, error } = await supabase
          .from("listings")
          .select(
            "id, inventory_item_id, platform, listing_status, listing_origin, platform_listing_id, batch_id, synced_to_ebay_at",
          )
          .in("inventory_item_id", chunk)
          .in("listing_status", ["draft", "active", "sold"]);
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
            aspectCount: Array.isArray(row.aspect_review) ? row.aspect_review.length : 0,
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
    queryFn: async (): Promise<
      Map<string, { thumbnail_url: string | null; photo_url: string | null }>
    > => {
      const rows = await fetchInChunks<{
        inventory_item_id: string | null;
        thumbnail_url: string | null;
        photo_url: string | null;
      }>(pageRowIds, async (chunk) => {
        const { data, error } = await supabase
          .from("item_photos")
          .select("inventory_item_id, thumbnail_url, photo_url, sort_order")
          .in("inventory_item_id", chunk)
          .order("sort_order", { ascending: true });
        return { data: data as unknown[] | null, error };
      });
      const map = new Map<
        string,
        { thumbnail_url: string | null; photo_url: string | null }
      >();
      for (const row of rows) {
        // First (lowest sort_order) row per item is the cover. Chunking preserves
        // this: each chunk is ordered, and an item's photos never span chunks
        // because chunking is BY ITEM ID.
        if (row.inventory_item_id && !map.has(row.inventory_item_id)) {
          map.set(row.inventory_item_id, {
            thumbnail_url: row.thumbnail_url,
            photo_url: row.photo_url,
          });
        }
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
