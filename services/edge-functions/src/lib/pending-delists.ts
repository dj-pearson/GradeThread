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
import { EXTENSION_DELIST_PLATFORMS as DELIST_SET } from "./cross-listing-sale.ts";

/**
 * Platforms the extension automates — no marketplace delist API exists.
 *
 * DERIVED, not restated. This was its own hand-written list until 2026-08-11,
 * and the two had silently diverged: US-2479/US-2480 added Vinted and Facebook
 * to the set in cross-listing-sale.ts and not to the copy here.
 *
 * The consequence was not cosmetic. `delistMethodFor` resolved those two to
 * `extension`, so a sale stamped `delist_requested_at` on the sibling — and
 * then the query below, filtered by THIS list, never returned it. The seller
 * was never shown the pending delist, so the sibling stayed live and
 * purchasable: the exact double sale this module exists to prevent, reached
 * through a second copy of a list rather than through a missing feature.
 *
 * One source of truth, so the next channel cannot repeat it.
 */
export const EXTENSION_DELIST_PLATFORMS: readonly string[] = [...DELIST_SET];

/**
 * US-3369: extension platforms where the extension can find a listing WITHOUT
 * a saved link, by opening the seller's own active-listings page and matching
 * the title. The page URL lives in the extension's bundled config
 * (lister/selectors.js, `delist.locate`), never here and never in a payload.
 *
 * Vinted is absent because its wardrobe page is /member/{numeric id} and we
 * hold no such id. Poshmark is present and needs the seller's username
 * (flipdesk_settings.marketplace_handles); without one the extension says so
 * in words rather than guessing a closet.
 */
export const LOCATE_DELIST_PLATFORMS: readonly string[] = [
  "poshmark",
  "mercari",
  "grailed",
  "facebook",
];

export interface PendingDelist {
  listing_id: string;
  platform: string;
  listing_url: string | null;
  listing_status: string;
  auto_delistable: boolean;
  item_id: string;
  item_title: string | null;
  requested_at: string;
  /**
   * US-3369: the titles the extension may match on the active-listings page
   * when there is no listing_url. Most specific first: this channel's own row,
   * then the per-platform variant the kit sent, then the item.
   */
  match_titles: string[];
  /** US-3369: the seller's username on this platform, when they saved one. */
  seller_handle: string | null;
}

interface PendingDelistRow {
  id: string;
  platform: string;
  listing_url: string | null;
  listing_status: string;
  listing_title?: string | null;
  inventory_item_id: string;
  delist_requested_at: string;
  inventory_items: { user_id: string; item_title: string | null };
}

/**
 * Can the extension end this listing without the seller doing it by hand?
 *
 * US-3369 CHANGED THIS, and the old rule is worth keeping in view. It was
 * "listing_status === 'active' AND a URL". Every row this queue holds is one
 * autoEndCrossListings has ALREADY set to 'ended' locally (the garment is gone,
 * so it must stop counting as stock) and stamped, so the rule answered false
 * for every sale-triggered delist. The popup read that as "By hand" and the
 * seller ended each listing themselves, which is the report that opened this
 * story.
 *
 * Status is not the question for a stamped row. The question is whether the
 * extension has a way to reach the listing: a saved link, or a platform whose
 * active-listings page it can search. It still never reports success it did
 * not see; a search that finds nothing, or finds two, comes back as manual.
 *
 * Pure + exported so both surfaces and the tests share one definition.
 */
export function isAutoDelistable(platform: string, listingUrl: string | null): boolean {
  if (!EXTENSION_DELIST_PLATFORMS.includes(platform)) return false;
  return !!listingUrl || LOCATE_DELIST_PLATFORMS.includes(platform);
}

/** A marketplace username we are willing to put inside a URL template. */
export function isValidSellerHandle(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(v);
}

/** Only the well-formed handles, keyed by platform. Never throws. */
export function normalizeSellerHandles(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [platform, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidSellerHandle(value)) out[platform] = value;
  }
  return out;
}

/**
 * The seller's saved marketplace usernames. A failed read is an empty map, not
 * an error: a missing handle degrades one search to a sentence, and nothing
 * about a delist should fail because a convenience field could not be read.
 */
export async function loadSellerHandles(ownerId: string): Promise<Record<string, string>> {
  try {
    const { data } = await supabaseAdmin
      .from("flipdesk_settings")
      .select("marketplace_handles")
      .eq("user_id", ownerId) // US-268
      .maybeSingle();
    return normalizeSellerHandles(
      (data as { marketplace_handles?: unknown } | null)?.marketplace_handles,
    );
  } catch {
    return {};
  }
}

/**
 * The titles to search for, most specific first, deduplicated, at most four,
 * each clipped. Pure.
 */
export function matchTitlesFor(candidates: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = c.trim().slice(0, 200);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === 4) break;
  }
  return out;
}

/**
 * Per item, the per-platform variant titles the listing kit stored on the
 * item's draft (platform_fields[platform].title, US-721). Those are the words
 * the seller actually posted on Poshmark or Mercari, which is often not the
 * eBay title. Owner-scoped through the parent item. Never throws.
 */
export async function loadVariantTitles(
  ownerId: string,
  itemIds: readonly string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (itemIds.length === 0) return out;
  try {
    const { data } = await supabaseAdmin
      .from("listings")
      .select("inventory_item_id, platform_fields, inventory_items!inner(user_id)")
      .eq("inventory_items.user_id", ownerId) // US-268
      .in("inventory_item_id", [...itemIds])
      .order("created_at", { ascending: false });
    for (
      const row of (data ?? []) as unknown as {
        inventory_item_id: string;
        platform_fields: Record<string, unknown> | null;
      }[]
    ) {
      const pf = row.platform_fields;
      if (!pf || typeof pf !== "object") continue;
      const map = out.get(row.inventory_item_id) ?? {};
      for (const [platform, v] of Object.entries(pf)) {
        const title = (v as { title?: unknown } | null)?.title;
        if (typeof title === "string" && title.trim() && !map[platform]) map[platform] = title;
      }
      out.set(row.inventory_item_id, map);
    }
  } catch {
    // Titles are a search aid. Without the variant, the item title still goes.
  }
  return out;
}

export function toPendingDelist(
  r: PendingDelistRow,
  extra: { variantTitle?: string | null; sellerHandle?: string | null } = {},
): PendingDelist {
  return {
    listing_id: r.id,
    platform: r.platform,
    listing_url: r.listing_url,
    listing_status: r.listing_status,
    auto_delistable: isAutoDelistable(r.platform, r.listing_url),
    item_id: r.inventory_item_id,
    item_title: r.inventory_items.item_title,
    requested_at: r.delist_requested_at,
    match_titles: matchTitlesFor([
      r.listing_title,
      extra.variantTitle,
      r.inventory_items.item_title,
    ]),
    seller_handle: extra.sellerHandle ?? null,
  };
}

/**
 * Load the owner's pending extension delists, oldest request first.
 * `ownerId` MUST already be resolved from a trusted source (workspace middleware
 * or a verified extension token) — never from the request body.
 */
export async function loadPendingDelists(
  ownerId: string,
  opts: { limit?: number; itemId?: string } = {},
): Promise<{ pending: PendingDelist[]; error: unknown | null }> {
  let q = supabaseAdmin
    .from("listings")
    .select(
      // US-1877 (AC3): listing_status rides along so the client can tell a
      // CONFIRMED-live sibling (auto-delistable) from a prefill we never saw go
      // live (nothing to end automatically — and we must not pretend otherwise).
      "id, platform, listing_url, listing_status, listing_title, inventory_item_id, " +
        "delist_requested_at, " +
        // item_title is an items_full VIEW alias; the base inventory_items table
        // has `title`. Alias it back so PendingDelistRow.item_title resolves.
        "inventory_items!inner(user_id, item_title:title)",
    )
    .eq("inventory_items.user_id", ownerId)
    .in("platform", [...EXTENSION_DELIST_PLATFORMS])
    .not("delist_requested_at", "is", null)
    .order("delist_requested_at", { ascending: true });

  // US-3144: the phone arrives from a push about ONE item and should show that
  // item's listings, not the whole queue. Optional, and applied ON TOP of the
  // owner scope rather than instead of it — an itemId is a client-supplied id,
  // so a foreign one must narrow to nothing rather than widen anything.
  if (opts.itemId) q = q.eq("inventory_item_id", opts.itemId);

  if (opts.limit) q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) return { pending: [], error };
  const rows = (data ?? []) as unknown as PendingDelistRow[];
  if (rows.length === 0) return { pending: [], error: null };

  // US-3369: what the extension needs to FIND a listing it has no link to.
  const [variants, handles] = await Promise.all([
    loadVariantTitles(ownerId, [...new Set(rows.map((r) => r.inventory_item_id))]),
    loadSellerHandles(ownerId),
  ]);
  return {
    pending: rows.map((r) =>
      toPendingDelist(r, {
        variantTitle: variants.get(r.inventory_item_id)?.[r.platform] ?? null,
        sellerHandle: handles[r.platform] ?? null,
      })
    ),
    error: null,
  };
}
