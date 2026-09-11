// US-3381 / US-2520. The step where a staging session stops being browser state
// and becomes rows: each photo group turns into an inventory_items row (new, or
// the seller's existing SKU) plus its item_photos rows in gallery order.
//
// Extracted from autolister.tsx, which sits at its shrink-only ceiling exactly,
// so the SKU read below could not gain its error check in place. It is also the
// right home for it: this is one transaction-shaped unit with four writes and
// two reads in it, and none of it touches page state.

import { supabase } from "@/lib/supabase";
import { toastWarning } from "@/lib/toast-error";
import { FLIPDESK_PHOTO_TYPES } from "@/lib/constants";
import type { StagedPhoto } from "@/stores/autolister-upload-store";
import { stagedSortName } from "./staged-sort-name";
import { groupPhotoType, type WarnableGroup } from "./group-warnings";

type PhotoRole = (typeof FLIPDESK_PHOTO_TYPES)[number];

// Canonical gallery rank -- FLIPDESK_PHOTO_TYPES order IS the sort order
// (front -> back -> tag -> detail -> measurements -> defect -> extras ->
// universal -> internal), the same rank photo-order.ts derives everywhere else.
const ROLE_ORDER: Record<PhotoRole, number> = Object.fromEntries(
  FLIPDESK_PHOTO_TYPES.map((t, i) => [t, i]),
) as Record<PhotoRole, number>;

/** Only the group fields this step reads, so the module owns no page state. */
export interface PersistableGroup extends WarnableGroup {
  /** The seller's own inventory SKU / listing number, when they gave one. */
  sku?: string;
  /** photoId -> the `item_photos.photo_role` qualifier (US-2461). */
  photoRoles?: Record<string, string>;
  /** True once the seller hand-placed photos: their order becomes sort_order. */
  manualOrder?: boolean;
}

/**
 * Turn each group into an inventory item with its photos attached, and hand
 * back the item ids in group order. Groups holding no staged photo are skipped.
 *
 * Throws on any refused write, and on a refused SKU lookup: the caller wraps
 * this in its own try/catch and reports through toastError.
 */
export async function persistGroupsAsItems(args: {
  ownerId: string;
  targets: readonly PersistableGroup[];
  stagedById: ReadonlyMap<string, StagedPhoto>;
}): Promise<string[]> {
  const { ownerId, targets, stagedById } = args;
  const itemIds: string[] = [];
  for (const g of targets) {
    const photos = g.photoIds
      .map((pid) => stagedById.get(pid))
      .filter((p): p is StagedPhoto => !!p);
    if (photos.length === 0) continue;

    // US-533: cover first (front), then the rest in the canonical photo-type
    // order (back -> tag -> detail -> measurements -> defect -> extras;
    // internal last). photo_type carries the assigned role so the eBay gallery
    // is well-ordered and labeled, not all "detail".
    // US-1543: once the seller hand-placed photos (drag-reorder / positional
    // drop), THEIR order wins -- it becomes sort_order verbatim (cover still
    // first; roles still label each photo).
    // US-2769: retyping the cover has to reach what ships, not just the UI.
    const roleOf = (p: StagedPhoto): PhotoRole => groupPhotoType(g, p.id);
    // US-2461: the qualifier rides alongside the type. The cover is a `front`,
    // which takes none. Same for the qualifier: a cover retyped "brand label"
    // keeps it.
    const qualifierOf = (p: StagedPhoto): string | null =>
      g.photoRoles?.[p.id] ?? null;
    const ordered = [...photos].sort((a, b) => {
      if (a.id === g.coverId) return -1;
      if (b.id === g.coverId) return 1;
      return g.manualOrder
        ? g.photoIds.indexOf(a.id) - g.photoIds.indexOf(b.id)
        : ROLE_ORDER[roleOf(a)] - ROLE_ORDER[roleOf(b)];
    });

    // SKU binding: if the seller gave a SKU that already exists in their
    // inventory, attach the photos to THAT item and keep its sheet-imported
    // fields for field-by-field reconciliation against the AI draft. Otherwise
    // create a fresh item, stamping the SKU when provided.
    const sku = g.sku?.trim() || "";
    let itemId: string;
    let existingId: string | null = null;
    if (sku) {
      // US-3381 AC5. This read used to drop its error, and the story it came
      // from argued that was survivable because the null took the INSERT branch
      // and the partial unique index on (user_id, sku) rejected it. It does --
      // but what the seller then reads is "duplicate key value violates unique
      // constraint idx_inventory_items_user_sku", the throw aborts the whole
      // attach loop, and the groups after this one never get their photos,
      // while the groups before it already have real items. Loud, yes; usable,
      // no. Checking it says which of the two things actually went wrong.
      const { data: existing, error: skuErr } = await supabase
        .from("inventory_items")
        .select("id")
        .eq("user_id", ownerId)
        .eq("sku", sku)
        .maybeSingle();
      if (skuErr) throw skuErr;
      existingId = (existing as { id: string } | null)?.id ?? null;
    }
    if (existingId) {
      itemId = existingId;
      const { error: statusErr } = await supabase
        .from("inventory_items")
        .update({ status: "photographed" } as never)
        .eq("id", itemId);
      // US-3376: dropped, this stranded the item in its old pipeline tab.
      if (statusErr) {
        toastWarning(
          statusErr,
          "Photos attached, but the item didn't move to Photographed.",
          { action: "advance item status" },
        );
      }
    } else {
      const { data: item, error: itemErr } = await supabase
        .from("inventory_items")
        .insert({
          user_id: ownerId,
          title: g.name.trim() || "AutoLister item",
          sku: sku || null,
          status: "photographed",
        } as never)
        .select("id")
        .single();
      if (itemErr || !item) throw itemErr ?? new Error("Item create failed");
      itemId = (item as { id: string }).id;
    }

    const photoRows = ordered.map((p, idx) => ({
      inventory_item_id: itemId,
      photo_url: p.url,
      storage_path: p.storagePath,
      thumbnail_url: p.thumbnailUrl,
      thumbnail_storage_path: p.thumbnailStoragePath,
      photo_type: roleOf(p),
      photo_role: qualifierOf(p),
      sort_order: idx,
      width: p.width,
      height: p.height,
      bytes: p.bytes,
      // US-1539: photo provenance -- the client-read EXIF capture time and the
      // source file's name, persisted as scalars (the stored image bytes stay
      // metadata-stripped) so grouping is reconstructable and filename-sequence
      // grouping survives beyond this session. stagedSortName also recovers the
      // name from sourceSig for photos staged before sourceName existed.
      captured_at:
        p.capturedAtMs != null ? new Date(p.capturedAtMs).toISOString() : null,
      original_filename: stagedSortName(p),
    }));
    const { error: photoErr } = await supabase
      .from("item_photos")
      .insert(photoRows as never);
    if (photoErr) throw photoErr;

    itemIds.push(itemId);
  }
  return itemIds;
}
