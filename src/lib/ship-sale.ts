import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import type { InventoryItemUpdate, SaleUpdate } from "@/types/database";

// PS-08: one local "mark shipped" write, shared by the ship queue and the
// ship-order dialog.
//
// The two had drifted. The dialog set inventory_items.status = 'shipped', so
// the garment moved to the Shipped tab; the queue wrote only the sale, so a
// garment shipped from the queue stayed "sold" everywhere else. Both also
// trusted a sales UPDATE that resolves with { error: null } when row-level
// security matched nothing, so a write that changed no row still said
// "Marked shipped".

type Db = Pick<typeof supabase, "from">;

export interface ShipSaleInput {
  saleId: string;
  itemId: string | null;
  tracking: string;
  /** Kept as-is on the sale when blank, the same way the ship routes do. */
  carrier?: string | null;
}

/** What landed. `itemError` set means the sale shipped but the item did not move. */
export interface ShipSaleResult {
  itemError: unknown | null;
}

export const SHIP_WRITE_REFUSED =
  "Couldn't mark this shipped. It may already be shipped, or you may not have permission to change it.";

/**
 * Record the shipment on the sale. Throws when nothing changed.
 *
 * `.is("shipped_at", null)` keeps a second press from restamping a sale that
 * is already shipped, and `.select("id")` is what makes a zero-row result
 * visible at all.
 */
export async function recordSaleShipped(
  input: Omit<ShipSaleInput, "itemId">,
  db: Db = supabase,
): Promise<void> {
  const carrier = (input.carrier ?? "").trim();
  // Typed against SaleUpdate, so a misspelt column fails the build. The client's
  // generic resolves update() to `never` for every table in this schema, which
  // is why the value still has to be passed through a cast.
  const patch: SaleUpdate = {
    shipped_at: new Date().toISOString(),
    tracking_number: input.tracking,
    ...(carrier ? { carrier } : {}),
  };
  const { data, error } = await db
    .from("sales")
    .update(patch as never)
    .eq("id", input.saleId)
    .is("shipped_at", null)
    .select("id");
  if (error) throw error;
  if (!data || (data as unknown[]).length === 0) throw new Error(SHIP_WRITE_REFUSED);
}

/** Move the garment to the Shipped tab. Returns the error rather than throwing. */
export async function markItemShipped(
  itemId: string | null,
  db: Db = supabase,
): Promise<unknown | null> {
  if (!itemId) return null;
  const patch: InventoryItemUpdate = { status: "shipped" };
  const { error } = await db
    .from("inventory_items")
    .update(patch as never)
    .eq("id", itemId);
  return error ?? null;
}

/**
 * The whole local path: the sale, then the item. The sale write throws; the
 * item write is reported, because by then the shipment really did happen and
 * the caller has to say which half landed.
 */
export async function shipSale(input: ShipSaleInput, db: Db = supabase): Promise<ShipSaleResult> {
  await recordSaleShipped(input, db);
  return { itemError: await markItemShipped(input.itemId, db) };
}

/**
 * PS-09: push tracking to a marketplace that is not eBay. Rejects with
 * `.status` set, so shipOneOrder can fall back to the local write on a
 * 409 or 503 the same way it does for eBay.
 */
export async function pushMarketplaceShip(
  platform: "depop" | "shopify",
  saleId: string,
  tracking: string,
  carrier: string | null,
): Promise<void> {
  const res = await edgeFetch(
    `/api/flipdesk/${platform}/orders/${encodeURIComponent(saleId)}/ship`,
    {
      method: "POST",
      body: JSON.stringify({ tracking_number: tracking, carrier }),
    },
  );
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const err: Error & { status?: number } = new Error(
      json.detail || json.error || "Mark-shipped failed.",
    );
    err.status = res.status;
    throw err;
  }
}
