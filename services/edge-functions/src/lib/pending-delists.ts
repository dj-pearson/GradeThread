// Pending cross-listing delists — the queue of marketplace listings that a sale
// elsewhere has ended in our DB but which still need ending in the seller's own
// browser (Poshmark / Mercari / Grailed have no delist API; US-717, US-1290).
//
// WHY THIS IS A SHARED LIB (US-1885 AC1). Two surfaces read this queue with two
// different auth dialects: the SaaS (Supabase JWT + workspace middleware) and
// the browser extension's popup (HMAC extension token). They must not answer the
// question differently — in particular `auto_delistable`, which decides whether
// the UI offers a one-click end. If the two copies drift, one surface offers to
// end a listing the other knows it cannot, and the seller is told a listing was
// handled when nothing happened. So the query and the projection live here once
// and both routes call it.
//
// TENANCY: every read is scoped through inventory_items.user_id. `listings` does
// carry a denormalized user_id (00146), but the whole delist path scopes via the
// parent item, and mixing the two is how a scope check ends up on the wrong
// column. Follow the existing convention (US-268 rule 2, ownership-via-parent).

import { supabaseAdmin } from "./supabase.ts";

/** Platforms the extension automates — no marketplace delist API exists. */
export const EXTENSION_DELIST_PLATFORMS = ["poshmark", "mercari", "grailed"] as const;

export interface PendingDelist {
  listing_id: string;
  platform: string;
  listing_url: string | null;
  listing_status: string;
  auto_delistable: boolean;
  item_id: string;
  item_title: string | null;
  requested_at: string;
}

interface PendingDelistRow {
  id: string;
  platform: string;
  listing_url: string | null;
  listing_status: string;
  inventory_item_id: string;
  delist_requested_at: string;
  inventory_items: { user_id: string; item_title: string | null };
}

/**
 * AC3: a listing can be ended BY THE EXTENSION only if it was confirmed live and
 * we hold a URL to open. A draft was never confirmed live, and a URL-less active
 * row was confirmed by hand — neither can be automated, and claiming otherwise
 * produces a "delisted" report for a listing still sitting live on the site.
 *
 * Pure + exported so both surfaces and the tests share one definition.
 */
export function isAutoDelistable(listingStatus: string, listingUrl: string | null): boolean {
  return listingStatus === "active" && !!listingUrl;
}

export function toPendingDelist(r: PendingDelistRow): PendingDelist {
  return {
    listing_id: r.id,
    platform: r.platform,
    listing_url: r.listing_url,
    listing_status: r.listing_status,
    auto_delistable: isAutoDelistable(r.listing_status, r.listing_url),
    item_id: r.inventory_item_id,
    item_title: r.inventory_items.item_title,
    requested_at: r.delist_requested_at,
  };
}

/**
 * Load the owner's pending extension delists, oldest request first.
 * `ownerId` MUST already be resolved from a trusted source (workspace middleware
 * or a verified extension token) — never from the request body.
 */
export async function loadPendingDelists(
  ownerId: string,
  opts: { limit?: number } = {},
): Promise<{ pending: PendingDelist[]; error: unknown | null }> {
  let q = supabaseAdmin
    .from("listings")
    .select(
      // US-1877 (AC3): listing_status rides along so the client can tell a
      // CONFIRMED-live sibling (auto-delistable) from a prefill we never saw go
      // live (nothing to end automatically — and we must not pretend otherwise).
      "id, platform, listing_url, listing_status, inventory_item_id, delist_requested_at, " +
        // item_title is an items_full VIEW alias; the base inventory_items table
        // has `title`. Alias it back so PendingDelistRow.item_title resolves.
        "inventory_items!inner(user_id, item_title:title)",
    )
    .eq("inventory_items.user_id", ownerId)
    .in("platform", [...EXTENSION_DELIST_PLATFORMS])
    .not("delist_requested_at", "is", null)
    .order("delist_requested_at", { ascending: true });

  if (opts.limit) q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) return { pending: [], error };
  const rows = (data ?? []) as unknown as PendingDelistRow[];
  return { pending: rows.map(toPendingDelist), error: null };
}
