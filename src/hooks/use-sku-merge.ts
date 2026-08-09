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
import { useRef, useState } from "react";
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
function isSkuDuplicateError(err: unknown): boolean {
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

/**
 * What the failing save hands over so the merge can put it back.
 *
 * US-2445. THE SAVE THAT COLLIDED IS THE ONLY THING THAT KNOWS WHAT IT WAS
 * WRITING. The previous design had the caller name the lost fields by hand as an
 * `extraPatch`, and the composer named two of them — `location_bin` and
 * `container`. Everything else the seller had edited was silently dropped,
 * including the listing title, because the composer's save writes
 * `inventory_items` FIRST and returns on the collision, so the `listings` update
 * carrying `listing_title` never ran at all. The seller then pushed to eBay and
 * got the old title, and it flowed on into the synced sheet.
 *
 * So the save registers ITSELF as the retry. There is no hand-written subset to
 * fall behind — the same code path that failed is the one that runs again, which
 * is the only version of this that cannot rot.
 */
export interface SkuMergeRecovery {
  /**
   * The inventory_items patch the collided update was carrying. Used ONLY to
   * show the dialog what will actually survive — the seller was choosing
   * between two database rows, neither of which held their pending edit.
   */
  pendingItemPatch?: Record<string, unknown>;
  /**
   * Re-run the whole save. Called after the merge commits and the SKU is free.
   * Its own duplicate-SKU handling is suppressed for this call (see
   * `retryingRef`) so a second collision surfaces as an error instead of
   * re-opening this dialog on top of itself.
   *
   * MUST RESOLVE TO THE SAVED ID, OR null/undefined ON FAILURE. Both composer
   * saves catch their own errors and `return null`, so awaiting one and
   * watching only for a throw would report "your edits were saved" over a save
   * that had just failed and toasted about it — the exact confident-success
   * this fix exists to remove. The resolved value is checked, not just the
   * absence of an exception.
   */
  retrySave?: () => Promise<string | null | undefined>;
}

/**
 * US-2445, PURE: what the survivor will actually look like after the merge.
 *
 * The dialog was being handed the raw database row while the save that would
 * have changed it had just rolled back — so the seller chose between two
 * versions of the past and neither was their edit. Overlaying the patch the
 * collided save was carrying is what makes "This item" mean what its label says.
 *
 * NO PATCH IS NOT AN EMPTY PATCH. An absent recovery leaves the row untouched
 * rather than spreading `{}` over it and implying we knew there were no pending
 * edits — the two are the same object here but not the same claim, and the
 * caller can tell them apart.
 */
export function composeSurvivorView(
  row: InventoryItemRow,
  pendingItemPatch?: Record<string, unknown> | null,
): InventoryItemRow {
  if (!pendingItemPatch) return row;
  return { ...row, ...pendingItemPatch } as InventoryItemRow;
}

/**
 * US-2445, PURE: did the post-merge retry actually save?
 *
 * THREE OUTCOMES, NEVER TWO. `none` (there was nothing to retry — an older
 * caller, or a merge offered outside a save) must not read as `saved`, and a
 * FALSY id must not either. Both composer saves catch their own errors and
 * `return null`, so awaiting one and watching only for a throw reports success
 * over a save that just failed and toasted about it — which is the confident
 * success this whole fix exists to remove.
 */
export function composeRetryOutcome(input: {
  attempted: boolean;
  savedId?: string | null;
  error?: string | null;
}): { state: "none" | "saved" | "failed"; reason: string | null } {
  if (!input.attempted) return { state: "none", reason: null };
  if (input.error) return { state: "failed", reason: input.error };
  if (!input.savedId) {
    return {
      state: "failed",
      reason: "the save reported a failure of its own",
    };
  }
  return { state: "saved", reason: null };
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
  offerSkuMerge: (
    err: unknown,
    sku: string,
    recovery?: SkuMergeRecovery,
  ) => Promise<boolean>;
  /**
   * Confirmed merge: claim the SKU, re-run the save that rolled back, then
   * apply the field choices made in the dialog.
   */
  confirmMerge: (overrides: Partial<MergeValues>) => Promise<void>;
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
  // The retry the collided save handed over. A ref, not state: it is read once
  // inside confirmMerge and must never trigger a render or be captured stale.
  const recoveryRef = useRef<SkuMergeRecovery | null>(null);
  // True only while the post-merge retry is in flight. Without it, a retry that
  // collides AGAIN would call offerSkuMerge and re-open this dialog from inside
  // its own confirm handler — a loop that looks like the app hanging.
  const retryingRef = useRef(false);

  async function offerSkuMerge(
    err: unknown,
    sku: string,
    recovery?: SkuMergeRecovery,
  ): Promise<boolean> {
    if (!item) return false;
    if (!isSkuDuplicateError(err)) return false;
    // A collision during the retry is a REAL failure, not another merge to
    // offer: the SKU was just claimed by this very item, so hitting the index
    // again means something else is wrong and the caller should see the error.
    if (retryingRef.current) return false;
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
      recoveryRef.current = recovery ?? null;
      // OVERLAY THE PENDING EDIT. `survRow` is what the database holds, and the
      // save that would have changed it just rolled back — so showing it raw
      // asks the seller to choose between two versions of the past, neither of
      // which is their edit. Deriving the overlay from the SAME patch the save
      // was writing (rather than a second hand-listed set of fields) is what
      // keeps this honest as columns are added.
      setMergeState({
        sku: newSku,
        existingId: dupRow.id,
        current: rowToMergeValues(
          composeSurvivorView(survRow, recovery?.pendingItemPatch),
        ),
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

  async function confirmMerge(overrides: Partial<MergeValues>) {
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

      const recovery = recoveryRef.current;
      recoveryRef.current = null;
      setMergeState(null);
      // Photos/listings/sales were re-pointed server-side — refresh broadly.
      await qc.invalidateQueries();

      // 1) RE-RUN THE SAVE THAT ROLLED BACK. The SKU is free now, so the update
      //    that failed will land — and with it every column the seller edited,
      //    including the `listings` write (listing_title) that the composer's
      //    item-first ordering meant never ran at all. This is what makes the
      //    edit reach eBay and the synced sheet.
      let savedId: string | null | undefined = null;
      let retryError: string | null = null;
      if (recovery?.retrySave) {
        retryingRef.current = true;
        try {
          savedId = await recovery.retrySave();
        } catch (retryErr) {
          retryError = errorMessage(retryErr);
        } finally {
          retryingRef.current = false;
        }
      }
      const retry = composeRetryOutcome({
        attempted: !!recovery?.retrySave,
        savedId,
        error: retryError,
      });

      // 2) THEN the dialog's field choices, so they win. An override exists only
      //    where the seller explicitly took the OTHER record's value, and that
      //    decision is newer than the form they were editing before the
      //    collision. Applying it first would let the retry overwrite it.
      const patch = mergeOverridesToItemUpdate(overrides, item.item_title ?? "");
      try {
        if (Object.keys(patch).length > 0) {
          const { error: upErr } = await supabase
            .from("inventory_items")
            .update(patch as never)
            .eq("id", item.id);
          if (upErr) throw upErr;
        }
        await qc.invalidateQueries();
        // THREE OUTCOMES, NOT TWO. "Merged and your edits are saved" and
        // "merged but your edits are not" are opposite facts for the seller
        // about to push to eBay, and a single success toast over the second one
        // is how the old title reached the marketplace without anyone noticing.
        if (retry.state === "failed") {
          toast.error(
            `Records merged and this item owns the SKU — but re-saving your edits failed: ${retry.reason}. Your changes are still on screen; save again before publishing.`,
            { duration: 12_000 },
          );
        } else if (retry.state === "none") {
          toast.success("Records merged — this item now owns the SKU.");
        } else {
          toast.success("Records merged and your edits saved.");
        }
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
    cancelMerge: () => {
      // Drop the retry with the dialog. Holding a stale continuation would let
      // the NEXT merge re-run a save the seller already walked away from.
      recoveryRef.current = null;
      setMergeState(null);
    },
  };
}
