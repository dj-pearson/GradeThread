// PS-05: does this owner hold the eBay order a partial refund names, and which
// marketplace connection should the refund go through?
//
// The route used `.maybeSingle()` on platform_order_id. A multi-item eBay order
// has one sales row per line, so a two-item order made maybeSingle error, and
// the route answered 500 to every seller refunding one. Ownership is "at least
// one of this owner's sales carries the order id", and the connection is the
// first row that names one.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase.ts";

/** Cap on sales rows read for one order. An eBay order holds far fewer lines. */
export const ORDER_LINE_SCAN_CAP = 50;

export type OrderOwnership =
  | { ok: true; owned: false }
  | { ok: true; owned: true; connectionId: string | undefined; lineCount: number }
  | { ok: false; error: string };

// PostgREST returns an embed as an object for a to-one relationship and an
// array for a to-many, and which one you get depends on how it reads the FK.
// Handling both is cheaper than being wrong about it in a route that a seller
// only reaches while trying to refund somebody.
export function saleConnectionId(row: unknown): string | undefined {
  const l = (row as { listings?: unknown } | null)?.listings;
  const one = Array.isArray(l) ? l[0] : l;
  const id = (one as { marketplace_connection_id?: string | null } | null)
    ?.marketplace_connection_id;
  return id ?? undefined;
}

export async function resolveOrderOwnership(
  ownerId: string,
  orderId: string,
  db: Pick<SupabaseClient, "from"> = supabaseAdmin,
): Promise<OrderOwnership> {
  // US-2804: `sales` has NO marketplace_connection_id column. It lives on
  // `listings` (00338), and sales reaches it through listing_id.
  const { data, error } = await db
    .from("sales")
    .select("id, listings(marketplace_connection_id)")
    .eq("user_id", ownerId)
    .eq("platform_order_id", orderId)
    .limit(ORDER_LINE_SCAN_CAP);
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as unknown[];
  if (rows.length === 0) return { ok: true, owned: false };
  const withConnection = rows.map(saleConnectionId).find((id) => id);
  return { ok: true, owned: true, connectionId: withConnection, lineCount: rows.length };
}
