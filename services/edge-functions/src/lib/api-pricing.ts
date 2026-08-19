// US-9117: the pricing READ layer.
//
// Same shape as api-items.ts / api-listings.ts: one query, an injectable db
// handle so the tenant scoping is unit-testable, and money crossing as integer
// cents. GET /api/flipdesk/pricing/suggestions returns the raw PostgREST rows;
// this returns a narrowed summary, because a tool result is read by a model and
// dumping every column is how a useful answer becomes an unreadable one.

import { supabaseAdmin } from "./supabase.ts";

// deno-lint-ignore no-explicit-any
export type PricingDb = any;

export interface PriceSuggestionSummary {
  id: string;
  listing_id: string;
  inventory_item_id: string;
  title: string | null;
  brand: string | null;
  current_price_cents: number;
  suggested_price_cents: number;
  delta_cents: number;
  comp_count: number;
  comp_median_cents: number | null;
  reason_code: string | null;
  message: string | null;
  confidence: number | null;
  listing_url: string | null;
  updated_at: string | null;
}

/** Matches the route's own cap. A model does not need more than this at once. */
export const SUGGESTIONS_MAX = 100;

export async function listPriceSuggestions(
  ownerId: string,
  limit = 25,
  db: PricingDb = supabaseAdmin,
): Promise<PriceSuggestionSummary[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), SUGGESTIONS_MAX);

  const { data, error } = await db
    .from("repricing_suggestions")
    .select(
      "id, inventory_item_id, listing_id, current_price_cents, suggested_price_cents, " +
        "comp_median_cents, comp_count, reason_code, message, confidence, updated_at, " +
        "inventory_items!inner(title, brand), listings!inner(listing_url)",
    )
    // US-268: the suggestions table carries user_id, and the inner joins mean a
    // row whose parent item is not this owner's cannot come back either.
    .eq("user_id", ownerId)
    .eq("status", "pending")
    .order("updated_at", { ascending: false })
    .limit(capped);

  if (error) throw new Error(`suggestions query failed: ${error.message}`);

  type Row = {
    id: string;
    inventory_item_id: string;
    listing_id: string;
    current_price_cents: number | null;
    suggested_price_cents: number | null;
    comp_median_cents: number | null;
    comp_count: number | null;
    reason_code: string | null;
    message: string | null;
    confidence: number | null;
    updated_at: string | null;
    inventory_items: { title: string | null; brand: string | null } | null;
    listings: { listing_url: string | null } | null;
  };

  return ((data ?? []) as Row[]).map((r) => {
    const current = r.current_price_cents ?? 0;
    const suggested = r.suggested_price_cents ?? 0;
    return {
      id: r.id,
      listing_id: r.listing_id,
      inventory_item_id: r.inventory_item_id,
      title: r.inventory_items?.title ?? null,
      brand: r.inventory_items?.brand ?? null,
      current_price_cents: current,
      suggested_price_cents: suggested,
      delta_cents: suggested - current,
      comp_count: r.comp_count ?? 0,
      comp_median_cents: r.comp_median_cents,
      reason_code: r.reason_code,
      message: r.message,
      confidence: r.confidence,
      listing_url: r.listings?.listing_url ?? null,
      updated_at: r.updated_at,
    };
  });
}
