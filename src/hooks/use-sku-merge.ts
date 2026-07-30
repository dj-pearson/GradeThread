// US-2263: duplicate-SKU recovery, lifted out of the composer.
//
// This has nothing to do with composing a listing. It exists because
// inventory_items carries a partial unique index on (user_id, sku), so ANY save
// that writes a SKU already taken by another row is rejected — and the useful
// answer is almost never "pick a different SKU". It is "you scanned the same
// garment twice; merge the two records". The merge RPC re-points photos,
// listings, sales and grading history onto the survivor, deletes the duplicate,
// and claims the SKU atomically.
//
// It lives here rather than in the composer because the recovery is identical
// wherever a SKU is written, and because 160 lines of constraint-error parsing
// in the middle of a form component is how the composer got to 3800 lines.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/utils";
import { rowToMergeValues, type MergeValues } from "@/lib/merge-values";
import type { InventoryItemRow } from "@/types/database";

export interface SkuMergeState {
  sku: string;
  existingId: string;
  current: MergeValues;
  existing: MergeValues;
}

/**
 * Is this error the (user_id, sku) partial unique index rejecting a duplicate?
 *
 * supabase-js rejects with a PostgrestError PLAIN OBJECT, not an Error instance,
 * so the pg code/message/details are read directly — an `err instanceof Error`
 * gate here stringifies to "[object Object]" and misses the constraint entirely.
 */
export function isSkuDuplicateError(err: unknown): boolean {
  const pgErr = err as { code?: string; message?: string; details?: string };
  if (pgErr?.code !== "23505") return false;
  const text = `${pgErr.message ?? ""} ${pgErr.details ?? ""}`;
  return (
    text.includes("idx_inventory_items_user_sku") ||
    text.toLowerCase().includes("sku")
  );
}

/**
 * Map the merge dialog's chosen field values back to inventory_items columns.
 * Only the keys the user took from the EXISTING record are written; everything
 * else already carries the survivor's value. Trim → null, numeric prices,
 * empties → null.
 *
 * Pure, and exported so the mapping is testable without a merge.
 */
export function mergeOverridesToItemUpdate(
  v: Partial<MergeValues>,
  fallbackTitle: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const strTrim = (s: string) => (s.trim() === "" ? null : s.trim());
  const priceNum = (s: string) => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  if (v.title !== undefined) out.title = v.title.trim() || fallbackTitle || "";
  if (v.container !== undefined) out.container = strTrim(v.container);
  if (v.brand !== undefined) out.brand = strTrim(v.brand);
  if (v.style !== undefined) out.style = strTrim(v.style);
  if (v.size !== undefined) out.size = strTrim(v.size);
  if (v.color !== undefined) out.color = strTrim(v.color);
  if (v.material !== undefined) out.material = strTrim(v.material);
  if (v.description !== undefined) out.description = strTrim(v.description);
  if (v.condition_notes !== undefined)
    out.condition_notes = strTrim(v.condition_notes);
  if (v.item_category !== undefined)
    out.item_category = v.item_category === "" ? null : v.item_category;
  if (v.sourced_by !== undefined) out.sourced_by = strTrim(v.sourced_by);
  if (v.status !== undefined) out.status = v.status;
  if (v.acquired_date !== undefined) out.acquired_date = v.acquired_date || null;
  if (v.acquired_price !== undefined)
    out.acquired_price = priceNum(v.acquired_price);
  if (v.target_price !== undefined) out.target_price = priceNum(v.target_price);
  if (v.comp_set !== undefined)
    out.comp_set = v.comp_set.filter(
      (c) => Number.isFinite(c.price) && c.price > 0,
    );
  if (v.measurements !== undefined)
    out.measurements =
      Object.keys(v.measurements).length > 0 ? v.measurements : null;
  return out;
}

export interface UseSkuMerge {
  /** Non-null while the merge dialog should be open. */
  mergeState: SkuMergeState | null;
  merging: boolean;
  /**
   * Call from a save's error path. Returns true when the error WAS a SKU
   * collision and the dialog has been opened — the caller stops there, because
   * the offending update already rolled back. False means "not mine, keep
   * throwing".
   */
  offerSkuMerge: (err: unknown, sku: string) => Promise<boolean>;
  /** Confirmed merge. `extraPatch` carries edits the rolled-back save lost. */
  confirmMerge: (
    overrides: Partial<MergeValues>,
    extraPatch?: Record<string, unknown>,
  ) => Promise<void>;
  cancelMerge: () => void;
}

export function useSkuMerge(item: {
  id: string;
  user_id: string;
  item_title: string | null;
} | null): UseSkuMerge {
  const qc = useQueryClient();
  const [mergeState, setMergeState] = useState<SkuMergeState | null>(null);
  const [merging, setMerging] = useState(false);

  async function offerSkuMerge(err: unknown, sku: string): Promise<boolean> {
    if (!item) return false;
    if (!isSkuDuplicateError(err)) return false;
    const newSku = sku.trim();
    // Load both raw rows (the pre-existing SKU owner + this survivor) so the
    // dialog can compare field-by-field. `.limit(1)` (not `.maybeSingle()`) so a
    // stray >1-row state can't itself throw and mask the duplicate.
    const [dupRes, survRes] = await Promise.all([
      supabase
        .from("inventory_items")
        .select("*")
        .eq("user_id", item.user_id)
        .eq("sku", newSku)
        .neq("id", item.id)
        .order("updated_at", { ascending: false })
        .limit(1),
      supabase.from("inventory_items").select("*").eq("id", item.id).limit(1),
    ]);
    const dupRow = (dupRes.data ?? [])[0] as InventoryItemRow | undefined;
    const survRow = (survRes.data ?? [])[0] as InventoryItemRow | undefined;
    if (dupRow && survRow) {
      setMergeState({
        sku: newSku,
        existingId: dupRow.id,
        current: rowToMergeValues(survRow),
        existing: rowToMergeValues(dupRow),
      });
    } else {
      // The index says the SKU is taken, but we couldn't load the other row
      // (RLS, a filter, or it was just deleted). Say so plainly.
      toast.error(
        `SKU "${newSku}" is already used by another item, but it couldn't be loaded to merge — refresh and try again.`,
      );
    }
    return true;
  }

  async function confirmMerge(
    overrides: Partial<MergeValues>,
    extraPatch: Record<string, unknown> = {},
  ) {
    if (!item || !mergeState) return;
    setMerging(true);
    try {
      const rpcClient = supabase as unknown as {
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: Error | null }>;
      };
      const { error } = await rpcClient.rpc("merge_inventory_items", {
        p_survivor_id: item.id,
        p_duplicate_id: mergeState.existingId,
        p_sku: mergeState.sku,
      });
      if (error) throw error;

      // The RPC already claimed the SKU; persist the resolved field choices plus
      // whatever the rolled-back save never committed.
      const patch = {
        ...mergeOverridesToItemUpdate(overrides, item.item_title ?? ""),
        ...extraPatch,
      };
      setMergeState(null);
      // Photos/listings/sales were re-pointed server-side — refresh broadly.
      await qc.invalidateQueries();
      try {
        const { error: upErr } = await supabase
          .from("inventory_items")
          .update(patch as never)
          .eq("id", item.id);
        if (upErr) throw upErr;
        toast.success("Records merged — this item now owns the SKU.");
      } catch (persistErr) {
        // The merge committed; only the field choices failed to save.
        toast.error(
          `Records merged, but saving your field choices failed: ${errorMessage(
            persistErr,
          )}. Review the item and save again.`,
        );
      }
    } catch (err) {
      toast.error(`Merge failed: ${errorMessage(err)}`);
    } finally {
      setMerging(false);
    }
  }

  return {
    mergeState,
    merging,
    offerSkuMerge,
    confirmMerge,
    cancelMerge: () => setMergeState(null),
  };
}
