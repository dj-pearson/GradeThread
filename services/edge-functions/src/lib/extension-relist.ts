// US-9203 — relisting on the extension channels.
//
// eBay relists under its existing offer (relistOwnedListing). Poshmark and
// Mercari have no write API and no "relist" call: a relist there is the
// seller's own browser copying the live listing into a fresh one and, once
// the copy is live, ending the old. This module is the server half of that:
//
//   1. createRelistDraft  — a NEW listings row for the copy (draft, same item,
//                           same cross-listing group, `relist_of` on it), and
//                           the payload the extension runs with;
//   2. completeRelist     — when the copy goes live (the extension's watch
//                           captured the new URL), activate the new row and END
//                           the old one, queueing its delist on the marketplace
//                           through the pending-delist queue if it was live.
//
// WHY A NEW ROW AND NOT A REWRITE OF THE OLD. Sold-sync (cross-listing-sale.ts,
// marketplace-observations.ts) matches a sale by listing URL and treats the
// active row as the live one. If the old row kept the old URL while the
// marketplace had a new listing, a sale of the copy would be unmatched and a
// sale of the stale one, had it not been removed, would look live. A new row
// with the new URL and an ended old row is the only shape both readers get
// right, and it is the shape eBay relists already leave behind.
//
// TENANCY (US-268): every read goes through inventory_items.user_id; ids from
// requests only reach a write after that scope.

import { supabaseAdmin } from "./supabase.ts";
import { EXTENSION_DELIST_PLATFORMS } from "./cross-listing-sale.ts";
import { markItemListed, resyncItemListedStatus } from "./active-listings.ts";
import { planExpiry } from "./extension-queue.ts";

/** Platforms that relist by copying in the seller's browser. Derived, not restated. */
export const EXTENSION_RELIST_PLATFORMS: readonly string[] = [...EXTENSION_DELIST_PLATFORMS];

export function isExtensionRelistPlatform(platform: string | null | undefined): boolean {
  return typeof platform === "string" && EXTENSION_RELIST_PLATFORMS.includes(platform);
}

export interface RelistSourceRow {
  id: string;
  inventory_item_id: string | null;
  platform: string | null;
  listing_status: string | null;
  listing_url: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  draft_id: string | null;
  platform_fields: Record<string, unknown> | null;
}

/**
 * May this row be relisted through the extension? Pure, so the button, the
 * bulk endpoint and the automation agree.
 *
 *   - an extension channel;
 *   - linked to an item;
 *   - live (the copy flow needs the listing page to copy from) or ended with a
 *     URL still on record (the page may still be there to copy);
 *   - not already relisted (a row that points at its copy is done).
 */
export function relistEligibility(
  row: RelistSourceRow,
): { ok: true } | { ok: false; reason: string } {
  if (!isExtensionRelistPlatform(row.platform)) {
    return { ok: false, reason: `${row.platform ?? "This"} is not an extension channel.` };
  }
  if (!row.inventory_item_id) {
    return { ok: false, reason: "This listing is not linked to an inventory item." };
  }
  if (!row.listing_url) {
    return { ok: false, reason: "GradeThread has no saved link for this listing, so there is nothing to copy from." };
  }
  if (row.listing_status !== "active" && row.listing_status !== "ended") {
    return { ok: false, reason: "Only a live or ended listing can be relisted." };
  }
  const pf = row.platform_fields ?? {};
  if (typeof pf.relisted_to === "string") {
    return { ok: false, reason: "This listing was already relisted." };
  }
  return { ok: true };
}

export interface RelistPayload {
  platform: string;
  /** The OLD listing, opened to copy from. Host-pinned by the extension. */
  listingUrl: string;
  listingId: string;
  newListingId: string;
  itemId: string;
  title: string | null;
  description: string | null;
  price: number | null;
}

/** The instruction the extension runs, built only from rows the server read. */
export function relistPayloadFor(old: RelistSourceRow, newListingId: string): RelistPayload {
  return {
    platform: String(old.platform),
    listingUrl: String(old.listing_url),
    listingId: old.id,
    newListingId,
    itemId: String(old.inventory_item_id),
    title: old.listing_title,
    description: old.listing_description,
    price: old.listing_price,
  };
}

/** Owner-scoped load of the row a relist starts from. */
export async function loadRelistSource(
  ownerId: string,
  listingId: string,
): Promise<RelistSourceRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, listing_status, listing_url, listing_title, listing_description, " +
        "listing_price, draft_id, platform_fields, inventory_items!inner(user_id)",
    )
    .eq("id", listingId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as RelistSourceRow & { inventory_items: { user_id: string } };
  if (row.inventory_items.user_id !== ownerId) return null;
  return row;
}

/**
 * Create the copy's row and the payload. The old row is NOT touched yet: it is
 * still live on the marketplace until the copy is, and ending it now would
 * make sold-sync blind to a sale of it in between.
 */
export async function createRelistDraft(
  ownerId: string,
  old: RelistSourceRow,
  source: "button" | "bulk" | "automation" | "mobile",
): Promise<{ ok: true; newListingId: string; payload: RelistPayload } | { ok: false; status: 409 | 500; error: string }> {
  const eligible = relistEligibility(old);
  if (!eligible.ok) return { ok: false, status: 409, error: eligible.reason };
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("listings")
    .insert({
      inventory_item_id: old.inventory_item_id,
      platform: old.platform,
      listing_origin: "gradethread",
      listing_status: "draft",
      is_active: false,
      listing_price: old.listing_price ?? 0,
      listing_title: old.listing_title,
      listing_description: old.listing_description,
      draft_id: old.draft_id,
      platform_fields: {
        relist_of: old.id,
        relist_requested_at: nowIso,
        relist_source: source,
      },
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[extension-relist] draft insert failed:", error?.message);
    return { ok: false, status: 500, error: "Could not create the relist draft." };
  }
  // Leave a forward pointer so a second press does not mint a second copy.
  const pf = { ...(old.platform_fields ?? {}), relist_pending_to: (data as { id: string }).id };
  await supabaseAdmin
    .from("listings")
    .update({ platform_fields: pf })
    .eq("id", old.id)
    .eq("user_id", ownerId);
  const newListingId = (data as { id: string }).id;
  return { ok: true, newListingId, payload: relistPayloadFor(old, newListingId) };
}

/**
 * The copy is live. Activate the new row with its URL, end the old row, and
 * if the old listing was still live on the marketplace queue its delist so
 * the seller's browser removes it (pending-delists) — the same door a sale
 * elsewhere uses, so the double-listing window is bounded the same way.
 */
export async function completeRelist(
  ownerId: string,
  newListingId: string,
  listingUrl: string,
): Promise<{ ok: true; old_listing_id: string | null; old_delist_queued: boolean } | { ok: false; status: 404 | 409 | 500; error: string }> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select("id, inventory_item_id, platform, listing_status, platform_fields, inventory_items!inner(user_id)")
    .eq("id", newListingId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  const row = data as unknown as {
    id: string;
    inventory_item_id: string;
    platform: string;
    listing_status: string | null;
    platform_fields: Record<string, unknown> | null;
    inventory_items: { user_id: string };
  } | null;
  if (!row || row.inventory_items.user_id !== ownerId) {
    return { ok: false, status: 404, error: "Listing not found." };
  }
  const oldId = typeof row.platform_fields?.relist_of === "string" ? row.platform_fields.relist_of : null;
  if (!oldId) return { ok: false, status: 409, error: "This listing is not a relist copy." };

  const nowIso = new Date().toISOString();
  const { error: newErr } = await supabaseAdmin
    .from("listings")
    .update({
      listing_status: "active",
      is_active: true,
      listing_url: listingUrl,
      listed_at: nowIso,
      platform_fields: { ...(row.platform_fields ?? {}), relist_completed_at: nowIso },
    })
    .eq("id", row.id);
  if (newErr) return { ok: false, status: 500, error: "Could not record the new listing." };

  // The old row: end it, and if it was live on the marketplace queue the
  // removal. Scoped through the parent item like everything else here.
  const { data: oldData } = await supabaseAdmin
    .from("listings")
    .select("id, listing_status, listing_url, platform_fields, inventory_items!inner(user_id)")
    .eq("id", oldId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  const old = oldData as unknown as {
    id: string;
    listing_status: string | null;
    listing_url: string | null;
    platform_fields: Record<string, unknown> | null;
  } | null;
  let queuedDelist = false;
  if (old) {
    const wasLive = old.listing_status === "active" && !!old.listing_url;
    const oldPf: Record<string, unknown> = {
      ...(old.platform_fields ?? {}),
      relisted_to: row.id,
      relisted_at: nowIso,
    };
    delete oldPf.relist_pending_to;
    await supabaseAdmin
      .from("listings")
      .update({
        listing_status: "ended",
        is_active: false,
        platform_fields: oldPf,
        ...(wasLive ? { delist_requested_at: nowIso } : {}),
      })
      .eq("id", old.id);
    queuedDelist = wasLive;
  }

  await markItemListed(row.inventory_item_id, ownerId);
  await resyncItemListedStatus(row.inventory_item_id, ownerId);
  return { ok: true, old_listing_id: old?.id ?? null, old_delist_queued: queuedDelist };
}

/**
 * Hand a relist to the seller's desktop through the US-2481 queue. Used by the
 * bulk endpoint and the automation engine, neither of which has a browser
 * tab to send the job to. The payload is the server-built one; the queue row
 * carries the OLD listing id so the drain host-pins its URL like a delist.
 */
export async function enqueueRelistWork(
  ownerId: string,
  payload: RelistPayload,
  source: "web" | "mobile" | "automation",
): Promise<{ ok: true; queue_id: string } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("extension_work_queue")
    .insert({
      user_id: ownerId,
      kind: "relist",
      platform: payload.platform,
      inventory_item_id: payload.itemId,
      listing_id: payload.listingId,
      payload,
      source: source === "automation" ? "web" : source,
      expires_at: planExpiry(Date.now()),
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[extension-relist] queue insert failed:", error?.message);
    return { ok: false, error: "Could not queue the relist for your desktop." };
  }
  return { ok: true, queue_id: (data as { id: string }).id };
}

