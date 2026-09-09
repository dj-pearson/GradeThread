// US-3196: the database half of the eBay photo mirror. The decisions live in
// ebay-photo-mirror.ts, which stays pure; this file only reads and writes.
//
// Called once per sync with every (item, picture URLs) pair both listing passes
// collected, so a 400-listing catalog costs two queries rather than 800.

import { supabaseAdmin } from "./supabase.ts";
import {
  type ExistingPhoto,
  type MirrorInsert,
  planPhotoMirror,
} from "./ebay-photo-mirror.ts";

/** PostgREST sends `.in()` in the URL, so the id lists are chunked. */
const CHUNK = 200;

export interface MirrorResult {
  /** item_photos rows inserted. */
  inserted: number;
  /** Items that got at least one new reference photo. */
  itemsTouched: number;
  /** Non-fatal problems, in the shape the sync's error list expects. */
  errors: string[];
}

/**
 * Writes eBay's pictures onto their items as reference rows.
 *
 * US-268. `byItem` is built from rows the sync already loaded under
 * `.eq("user_id", ownerId)`, but this re-verifies rather than trusting that,
 * because it is the only thing standing between a future caller with a
 * looser item list and a photo written onto another tenant's garment. The
 * verification is one query for the whole batch, so the cost of being sure is
 * roughly nothing.
 */
export async function mirrorEbayPhotos(
  ownerId: string,
  byItem: Map<string, string[]>,
): Promise<MirrorResult> {
  const result: MirrorResult = { inserted: 0, itemsTouched: 0, errors: [] };
  const requested = [...byItem.keys()].filter((id) => (byItem.get(id) ?? []).length > 0);
  if (requested.length === 0) return result;

  // 1. Which of these items does this tenant actually own?
  const owned = new Set<string>();
  for (let i = 0; i < requested.length; i += CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("inventory_items")
      .select("id")
      .eq("user_id", ownerId)
      .in("id", requested.slice(i, i + CHUNK));
    if (error) {
      result.errors.push(`photo mirror (ownership): ${error.message.slice(0, 160)}`);
      return result;
    }
    for (const row of (data ?? []) as Array<{ id: string }>) owned.add(row.id);
  }
  const itemIds = requested.filter((id) => owned.has(id));
  if (itemIds.length === 0) return result;

  // 2. What photos do those items already carry? Read for EVERY item in the
  //    batch, including ones with none — planPhotoMirror needs the empty list
  //    to tell "no photos yet" from "photos we were not told about".
  const existingByItem = new Map<string, ExistingPhoto[]>();
  for (const id of itemIds) existingByItem.set(id, []);
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("item_photos")
      .select("inventory_item_id, remote_source, remote_source_url")
      .in("inventory_item_id", itemIds.slice(i, i + CHUNK));
    if (error) {
      result.errors.push(`photo mirror (read): ${error.message.slice(0, 160)}`);
      return result;
    }
    for (
      const row of (data ?? []) as Array<
        { inventory_item_id: string } & ExistingPhoto
      >
    ) {
      existingByItem.get(row.inventory_item_id)?.push({
        remote_source: row.remote_source,
        remote_source_url: row.remote_source_url,
      });
    }
  }

  // 3. Plan, then one insert for the whole batch.
  const rows: Array<MirrorInsert & { inventory_item_id: string }> = [];
  for (const itemId of itemIds) {
    const planned = planPhotoMirror(
      byItem.get(itemId) ?? [],
      existingByItem.get(itemId) ?? [],
    );
    if (planned.length === 0) continue;
    result.itemsTouched += 1;
    for (const row of planned) rows.push({ ...row, inventory_item_id: itemId });
  }
  if (rows.length === 0) return result;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin.from("item_photos").insert(slice as never);
    if (error) {
      // Not fatal. A sync that mirrored the catalog and failed on the photos is
      // still a useful sync, and the next run re-plans from the same state.
      result.errors.push(`photo mirror (insert): ${error.message.slice(0, 160)}`);
      return result;
    }
    result.inserted += slice.length;
  }
  return result;
}
