// US-2919: the queue's and the grid's shared size-versus-measurements wiring.
//
// Both surfaces ask the same question of the same batch — does each draft's size
// agree with what it measures? — so both fetch the same band tables and run the
// same check. This holds all of it, partly to keep one copy of the rule and
// partly because both pages sit under the US-2520 shrink-only ratchet, which
// says in as many words to move a piece out rather than raise the ceiling.

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { toastError } from "@/lib/toast-error";
import { inferDepartment } from "@/lib/ebay-prefill";
import {
  buildSizeConflicts,
  type SizeCheckableDraft,
  type SizeConflict,
} from "@/pages/flipdesk/autolister/group-warnings";
import { useSizeBandsForDrafts } from "@/pages/flipdesk/autolister/use-size-bands";
import type { ItemAttrs } from "@/pages/flipdesk/autolister/use-item-attrs";

/**
 * A draft the size check can read, from whatever fields the calling surface
 * happens to hold. `gender` is a STATED department when the caller has one (an
 * eBay Department specific the seller typed) and inferred from the text only
 * when it does not — the endpoint drops to a generic chart on null rather than
 * guessing, so a wrong guess here is strictly worse than none.
 */
export function sizeCheckableDraft(input: {
  itemId: string;
  name: string | null;
  brand: string | null;
  garment: string | null;
  size: string | null;
  style?: string | null;
  statedDepartment?: string | null;
  measurements: Record<string, unknown> | null;
}): SizeCheckableDraft {
  const stated = (input.statedDepartment ?? "").trim();
  return {
    itemId: input.itemId,
    name: input.name ?? "",
    brand: input.brand,
    garment: input.garment,
    gender:
      stated ||
      inferDepartment({
        title: input.name,
        brand: input.brand,
        size: input.size,
        color: null,
        material: null,
        style: input.style ?? null,
        description: null,
        condition_notes: null,
        item_category: input.garment,
      }),
    size: input.size,
    measurements: input.measurements,
  };
}

/** The mis-sized drafts in a batch, keyed by inventory item id. */
export function useSizeConflicts(
  drafts: readonly SizeCheckableDraft[],
): Record<string, SizeConflict> {
  const bands = useSizeBandsForDrafts(drafts);
  return useMemo(() => {
    const map: Record<string, SizeConflict> = {};
    for (const c of buildSizeConflicts(drafts, bands)) map[c.itemId] = c;
    return map;
  }, [drafts, bands]);
}

/** The fields the bulk grid holds that the size check reads. `EditRow` satisfies it. */
export interface SizeCheckableGridRow {
  itemId: string;
  title: string;
  brand: string;
  size: string;
  department: string;
}

/**
 * The bulk grid's mis-sized rows.
 *
 * Reads each row's LIVE size, brand and department rather than the item's, so
 * correcting one in the grid clears its own warning immediately instead of
 * waiting for a save. Falls back to the item's stored columns for anything the
 * seller has not overridden, which is what the grid's placeholders already show.
 */
export function useSizeConflictsForGrid(
  rows: readonly SizeCheckableGridRow[],
  itemAttrs: Readonly<Record<string, ItemAttrs>>,
): Record<string, SizeConflict> {
  const drafts = useMemo(
    () =>
      rows.map((r) => {
        const a = itemAttrs[r.itemId];
        return sizeCheckableDraft({
          itemId: r.itemId,
          name: r.title || a?.title || null,
          brand: r.brand.trim() || a?.brand || null,
          garment: a?.garmentCategory ?? a?.itemCategory ?? null,
          size: r.size.trim() || a?.size || null,
          style: a?.style ?? null,
          // A typed Department beats anything inferred from the title.
          statedDepartment: r.department,
          measurements: a?.measurements ?? null,
        });
      }),
    [rows, itemAttrs],
  );
  return useSizeConflicts(drafts);
}

/**
 * Write a corrected size straight to the item.
 *
 * The QUEUE uses this: its rows are not an editable form, so the fix has to
 * land immediately. The bulk grid does NOT — there the fix patches the row and
 * saves with the rest of the batch, so a seller can sweep a dozen size fixes
 * and press Save once.
 */
export function useApplySizeFix(): (itemId: string, nextSize: string) => Promise<void> {
  const qc = useQueryClient();
  return async (itemId: string, nextSize: string) => {
    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({ size: nextSize } as never)
        .eq("id", itemId);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["autolister_item_meta"] });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(`Size changed to ${nextSize}.`);
    } catch (err) {
      toastError(err, "Couldn't save the size.");
    }
  };
}
