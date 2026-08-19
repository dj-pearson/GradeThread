// US-9110: the comp surface the connector is allowed to expose.
//
// WHAT THIS DELIBERATELY DOES NOT RETURN. No listing titles, no seller names,
// no URLs, no per-listing rows — only the aggregate GradeThread already shows
// in-product: sample size, the p25/median/p75 band, the currency, the source
// and a confidence. Serving third-party listing data through a connector is
// redistribution, and the fastest way to lose the eBay keyset the rest of
// FlipDesk depends on. The same line is what parks the buyer story (US-9128).
//
// The aggregate itself comes from lib/sold-comps.ts unchanged, so the connector
// and the dashboard quote the same number from the same cache. Nothing here
// issues its own eBay call.

import { supabaseAdmin } from "./supabase.ts";
import { getRealizedComps, MIN_SOLD_COMPS } from "./sold-comps.ts";

// deno-lint-ignore no-explicit-any
export type CompsDb = any;

export interface CompsAnswer {
  /** Where the realized prices came from. */
  source: "ebay_sold" | "private_sales";
  /** How many realized sales the band is computed from. */
  sample_size: number;
  currency: string;
  low_cents: number | null;
  median_cents: number | null;
  high_cents: number | null;
  /** 0..1, derived from sample size. */
  confidence: number;
  /**
   * Said out loud with every answer. A median off three sales is not a price,
   * and a model that omits the sample size will present it as one.
   */
  caveat: string;
}

export class CompsUnavailableError extends Error {}

/**
 * The item fields a comp lookup needs, read tenant-scoped.
 *
 * A comp lookup keyed on an ITEM rather than free text is the honest shape for
 * a connector: it uses the category the item already resolved, so the answer is
 * about the thing the seller is holding rather than about whatever string the
 * model guessed.
 */
export async function compBasisForItem(
  tenantId: string,
  itemId: string,
  db: CompsDb = supabaseAdmin,
): Promise<
  { categoryId: string; brand: string | null; size: string | null; title: string } | null
> {
  const { data, error } = await db
    .from("inventory_items")
    .select("id, title, brand, size, ebay_category_id")
    .eq("id", itemId)
    .eq("user_id", tenantId)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const categoryId = row.ebay_category_id;
  if (typeof categoryId !== "string" || !categoryId) {
    throw new CompsUnavailableError(
      "This item has no eBay category yet, so there is nothing to compare it against. " +
        "Catalog or draft the item first.",
    );
  }
  return {
    categoryId,
    brand: (row.brand as string | null) ?? null,
    size: (row.size as string | null) ?? null,
    title: String(row.title ?? ""),
  };
}

function caveatFor(count: number, source: string): string {
  const window = source === "private_sales"
    ? "the seller's own sales over the last 12 months"
    : "recent eBay sold listings";
  if (count < MIN_SOLD_COMPS * 2) {
    return `Based on only ${count} realized sale(s) from ${window}. That is a small sample: ` +
      `treat the range as a rough indication, not a price.`;
  }
  return `Based on ${count} realized sale(s) from ${window}.`;
}

/**
 * The aggregate for one item, or null when there is not enough realized data.
 *
 * Null is a real answer here and must be reported as one. sold-comps.ts returns
 * null below MIN_SOLD_COMPS precisely so a caller cannot quote a price off two
 * data points; inventing a fallback would undo that.
 */
export async function compsForItem(
  tenantId: string,
  itemId: string,
  db: CompsDb = supabaseAdmin,
  // Injectable so the redistribution boundary — "only aggregates leave this
  // function" — is testable without an eBay call.
  resolveComps: typeof getRealizedComps = getRealizedComps,
): Promise<{ basis: { title: string; brand: string | null }; comps: CompsAnswer | null } | null> {
  const basis = await compBasisForItem(tenantId, itemId, db);
  if (!basis) return null;

  const realized = await resolveComps({
    ownerId: tenantId,
    categoryId: basis.categoryId,
    brand: basis.brand ?? undefined,
    size: basis.size ?? undefined,
    q: basis.title || undefined,
  });

  if (!realized) {
    return { basis: { title: basis.title, brand: basis.brand }, comps: null };
  }

  return {
    basis: { title: basis.title, brand: basis.brand },
    comps: {
      source: realized.source,
      sample_size: realized.count,
      currency: realized.currency,
      low_cents: realized.lowCents,
      median_cents: realized.medianCents,
      high_cents: realized.highCents,
      confidence: realized.confidence,
      caveat: caveatFor(realized.count, realized.source),
    },
  };
}
