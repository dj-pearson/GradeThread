// Sold-sync status projection (US-2699).
//
// WHY THIS IS A SHARED LIB, AND THE SCAR IT IS COPIED FROM.
//
// Two surfaces ask "how is sync doing?" in two auth dialects: the SaaS with a
// Supabase JWT, and the extension popup with an HMAC extension token. That is
// exactly the shape of lib/pending-delists.ts, whose own header records what
// happens when the two drift — one surface offers to end a listing the other
// knows it cannot, and the seller is told a thing was handled when nothing was.
//
// So the query and the projection live here once, and both routes call it. A
// second door must not become a second answer.
//
// The platform list is DERIVED from EXTENSION_DELIST_PLATFORMS rather than
// written again. US-2479/US-2480 is the precedent: a second hand-written copy of
// that set went stale, and the consequence was the oversell the whole module
// exists to prevent.

import { supabaseAdmin } from "./supabase.ts";
import { EXTENSION_DELIST_PLATFORMS as DELIST_SET } from "./cross-listing-sale.ts";

/**
 * The channels sold-sync covers, in a stable order.
 *
 * DERIVED from the delist set rather than written again, and ordered so two
 * surfaces rendering the same tenant never disagree about row order. Adding a
 * platform to EXTENSION_DELIST_PLATFORMS adds a channel here, which is the point
 * — the second hand-written copy of that set is what drifted in US-2479/US-2480.
 */
export const SYNC_PLATFORMS: readonly string[] = [...DELIST_SET].sort();

/**
 * `never` is its own status, distinct from `ok`.
 *
 * A channel that has never been read is not healthy, and showing it as such is
 * how a seller concludes sync is working when the content script has never once
 * run — the exact failure the whole "zero rows is an error" rule exists to make
 * visible. It reads as "not synced yet" on both surfaces.
 */
export type SyncChannelState = "never" | "ok" | "failing" | "not_signed_in";

export interface SyncChannel {
  platform: string;
  status: SyncChannelState;
  failure_reason: string | null;
  /** Listings the last read actually saw. Null when no closet read happened. */
  listings_seen: number | null;
  last_ok_at: string | null;
  last_read_at: string | null;
  /** Rows waiting in the review queue for this channel. */
  open_reviews: number;
  /** What we believe is live there, so the UI can state the gap honestly. */
  live_listings: number;
}

export interface SyncStateRow {
  platform: string;
  status: string;
  failure_reason: string | null;
  listings_seen: number | null;
  last_ok_at: string | null;
  last_read_at: string | null;
}

function normalizeState(raw: string | null | undefined): SyncChannelState {
  if (raw === "ok" || raw === "failing" || raw === "not_signed_in") return raw;
  // Anything unrecognised reads as never-synced rather than ok. A status we
  // cannot interpret is not evidence of health.
  return "never";
}

/**
 * Pure: fold the three inputs into one row per channel.
 *
 * Exported and DB-free so the projection is unit-testable and so both surfaces
 * provably share one definition of "failing".
 */
export function projectSyncChannels(
  stateRows: readonly SyncStateRow[],
  openReviewsByPlatform: Readonly<Record<string, number>>,
  liveListingsByPlatform: Readonly<Record<string, number>>,
  platforms: readonly string[] = SYNC_PLATFORMS,
): SyncChannel[] {
  const byPlatform = new Map<string, SyncStateRow>();
  for (const row of stateRows) {
    if (row && typeof row.platform === "string") byPlatform.set(row.platform, row);
  }

  return platforms.map((platform) => {
    const row = byPlatform.get(platform) ?? null;
    const status = row ? normalizeState(row.status) : "never";
    return {
      platform,
      status,
      // A reason only ever accompanies a non-ok status. Carrying a stale reason
      // beside a healthy channel is how a seller reads a solved problem as live.
      failure_reason: status === "ok" || status === "never" ? null : (row?.failure_reason ?? null),
      listings_seen: row?.listings_seen ?? null,
      last_ok_at: row?.last_ok_at ?? null,
      last_read_at: row?.last_read_at ?? null,
      open_reviews: openReviewsByPlatform[platform] ?? 0,
      live_listings: liveListingsByPlatform[platform] ?? 0,
    };
  });
}

/**
 * Load one tenant's sync status across every extension-mechanism channel.
 *
 * `ownerId` MUST already be resolved from a trusted source (workspace middleware
 * or a verified extension token) — never from the request body.
 */
export async function loadSyncStatus(
  ownerId: string,
): Promise<{ channels: SyncChannel[]; error: unknown | null }> {
  try {
    const [stateRes, reviewRes, listingRes] = await Promise.all([
      supabaseAdmin
        .from("marketplace_sync_state")
        .select("platform, status, failure_reason, listings_seen, last_ok_at, last_read_at")
        .eq("user_id", ownerId),
      supabaseAdmin
        .from("marketplace_sync_reviews")
        .select("platform")
        .eq("user_id", ownerId)
        .eq("status", "open"),
      // Live listings are scoped through the parent item, the convention the
      // whole delist path uses (US-268 rule 2).
      supabaseAdmin
        .from("listings")
        .select("platform, inventory_items!inner(user_id)")
        .eq("inventory_items.user_id", ownerId)
        .in("platform", [...SYNC_PLATFORMS])
        .in("listing_status", ["draft", "active"]),
    ]);

    if (stateRes.error) throw stateRes.error;
    if (reviewRes.error) throw reviewRes.error;
    if (listingRes.error) throw listingRes.error;

    const reviews: Record<string, number> = {};
    for (const r of (reviewRes.data ?? []) as { platform: string }[]) {
      reviews[r.platform] = (reviews[r.platform] ?? 0) + 1;
    }
    const live: Record<string, number> = {};
    for (const l of (listingRes.data ?? []) as unknown as { platform: string }[]) {
      live[l.platform] = (live[l.platform] ?? 0) + 1;
    }

    return {
      channels: projectSyncChannels(
        (stateRes.data ?? []) as SyncStateRow[],
        reviews,
        live,
      ),
      error: null,
    };
  } catch (error) {
    return { channels: [], error };
  }
}
