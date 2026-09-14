import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useBulkEditListings, useEbayReviseListing, type BulkEditFields, type ReviseListingPatch } from "@/hooks/use-ebay";
import { cellLock, type GridListing, type GridRow, type GridCol } from "./grid-columns";

const LISTING_COLUMNS = "id,inventory_item_id,platform,listing_status,listing_origin,platform_listing_id,batch_id,synced_to_ebay_at,listing_title,listing_price,quantity,platform_category_id,ebay_condition,ebay_condition_description,shipping_policy_id,payment_policy_id,return_policy_id,item_specifics_override,item_specifics_sources,variations";

export function useGridListings(rows: GridRow[], ownerId: string | undefined) {
  const ids = rows.flatMap(row => row.listing_id ? [row.listing_id] : []);
  return useQuery({
    queryKey: ["grid-listings", ownerId, ids],
    enabled: !!ownerId && ids.length > 0,
    queryFn: async () => {
      // The inventory page is bounded at 100 rows. Resolve its exact listing
      // ids, never another marketplace's listing for the same garment.
      const { data, error } = await supabase.from("listings").select(LISTING_COLUMNS).in("id", ids);
      if (error) throw error;
      return new Map((data as unknown as GridListing[] ?? []).map(row => [row.id, row]));
    },
  });
}

export function useSaveGridListing() {
  const revise = useEbayReviseListing();
  const bulkEdit = useBulkEditListings();
  return async (row: GridRow, edits: Record<string, string>, columns: GridCol[]) => {
    if (Object.keys(edits).length === 0) return;
    if (!row.listing) throw new Error("The listing could not be loaded. Reload and try again.");
    const { data, error } = await supabase.from("listings").select(LISTING_COLUMNS)
      .eq("id", row.listing.id).eq("inventory_item_id", row.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This listing is no longer available.");
    const fresh = data as unknown as GridListing;
    const latest: GridRow = { ...row, listing: fresh };
    const patch: Record<string, unknown> = {};
    const policyPatch: BulkEditFields = {};
    const revisePatch: ReviseListingPatch = {};
    const aspects = { ...fresh.item_specifics_override };
    const sources = { ...fresh.item_specifics_sources };
    for (const [field, raw] of Object.entries(edits)) {
      const col = columns.find(candidate => candidate.field === field);
      if (!col) throw new Error("A column is no longer available. Reload and try again.");
      const locked = cellLock(latest, col);
      if (locked) throw new Error(locked);
      // A retry may find our prior write after eBay refused it. That is safe;
      // an unrelated edit made since this grid loaded must not be overwritten.
      const current = col.get(latest);
      if (current !== col.get(row) && current !== raw) throw new Error(`${col.label} changed elsewhere. Reload before replacing it.`);
      const value = raw.trim();
      if (field.startsWith("aspect.")) {
        const name = field.slice(7);
        aspects[name] = value ? value.split(";").map(part => part.trim()).filter(Boolean) : [];
        sources[name] = "manual";
        patch.item_specifics_override = aspects;
        patch.item_specifics_sources = sources;
        revisePatch.resync_ebay_fields = true;
      } else {
        const name = field.slice(8);
        patch[name] = col.numeric ? Number(value) : value;
        if (name === "listing_title") revisePatch.title = value;
        else if (name === "listing_price") {
          revisePatch.listing_price = Number(value);
          patch.price_set_by = "seller";
        } else if (name === "quantity") revisePatch.quantity = Number(value);
        else if (col.policy) Object.assign(policyPatch, { [name]: value });
        else revisePatch.resync_ebay_fields = true;
      }
    }
    // Drafts stay drafts. The bulk marketplace endpoint may publish, so it
    // must never be used to save a draft's cells.
    const { data: saved, error: writeError } = await supabase.from("listings").update(patch as never)
      .eq("id", fresh.id).eq("inventory_item_id", row.id)
      .eq("listing_status", fresh.listing_status).select("id").maybeSingle();
    if (writeError) throw writeError;
    if (!saved) throw new Error("The listing changed while saving. Reload and try again.");
    if (fresh.listing_status !== "active") return;
    try {
      if (Object.keys(policyPatch).length > 0) {
        const result = await bulkEdit.mutateAsync({ items: [{ listing_id: fresh.id, edit: policyPatch }] });
        const applied = result.results.find(entry => entry.listing_id === fresh.id);
        if (applied?.status !== "ok") throw new Error(applied?.error ?? "eBay did not confirm the policy changes.");
      }
      if (Object.keys(revisePatch).length > 0) await revise.mutateAsync({ listingId: fresh.id, patch: revisePatch });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "eBay did not confirm the update.";
      throw new Error(`Saved in GradeThread; eBay still needs an update. ${reason}`);
    }
  };
}
