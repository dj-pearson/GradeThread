// Bulk-edit live listings (US-1292) — pure decision + orchestration module.
// No network/env, so it unit-tests without the supabase env dance.
//
// A reseller multi-selects live listings and edits shared fields (price,
// quantity, eBay condition, business policies, category) in one shot. The edge
// route loads the owned listings (tenant-scoped, US-268), normalizes the
// requested edit here, decides per-listing whether the edit is allowed under the
// provenance/field-ownership model (US-1080), then pushes each survivor to its
// marketplace through the adapter abstraction (US-708). Every per-item outcome
// is reported as ok | blocked | error so a partial-failure batch is legible.

import { isEbayOwned } from "./sync-precedence.ts";

/** Hard cap on a single bulk-edit batch (matches AutoLister's publish cap). */
export const MAX_BULK_EDIT_ITEMS = 100;

/** The editable fields a bulk edit may carry, keyed by their listings column. */
export interface BulkEditPatch {
  listing_price?: number;
  quantity?: number;
  ebay_condition?: string;
  ebay_condition_description?: string;
  shipping_policy_id?: string;
  payment_policy_id?: string;
  return_policy_id?: string;
  platform_category_id?: string;
}

/** Raw request shape (`price`/`quantity` are friendlier than the column names). */
export interface RawBulkEdit {
  price?: unknown;
  quantity?: unknown;
  ebay_condition?: unknown;
  ebay_condition_description?: unknown;
  shipping_policy_id?: unknown;
  payment_policy_id?: unknown;
  return_policy_id?: unknown;
  platform_category_id?: unknown;
}

/**
 * Validate + normalize a requested edit into a listings-column patch. Drops any
 * field that fails validation; returns null when nothing valid remains (so the
 * route can 400 instead of running an empty batch).
 *
 * • price            → listing_price (finite, > 0)
 * • quantity         → quantity (integer, ≥ 0)
 * • string fields    → kept only when a non-blank trimmed string
 */
export function normalizeBulkEdit(raw: RawBulkEdit | null | undefined): BulkEditPatch | null {
  if (!raw || typeof raw !== "object") return null;
  const patch: BulkEditPatch = {};

  const price = Number(raw.price);
  if (raw.price != null && Number.isFinite(price) && price > 0) {
    patch.listing_price = price;
  }
  const qty = Number(raw.quantity);
  if (raw.quantity != null && Number.isInteger(qty) && qty >= 0) {
    patch.quantity = qty;
  }

  const strFields: Array<keyof BulkEditPatch> = [
    "ebay_condition",
    "ebay_condition_description",
    "shipping_policy_id",
    "payment_policy_id",
    "return_policy_id",
    "platform_category_id",
  ];
  for (const f of strFields) {
    const v = (raw as Record<string, unknown>)[f];
    if (typeof v === "string" && v.trim() !== "") {
      (patch as Record<string, unknown>)[f] = v.trim();
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export interface ListingEditPlan {
  /** "apply" = at least one field is writable; "blocked" = all fields locked. */
  status: "apply" | "blocked";
  /** Field names that may be written (and pushed to the marketplace). */
  apply: string[];
  /** Field names refused because the listing is marketplace-originated. */
  locked: string[];
}

/**
 * Decide which requested fields may be written to a listing given its origin.
 *
 * For an eBay-originated listing (`listing_origin='ebay'`) eBay is the source of
 * truth, so every eBay-owned field is locked — writing it would just be
 * overwritten on the next pull (US-1080). For a GradeThread-originated listing
 * all fields are writable. When every requested field is locked the listing is
 * reported as `blocked`, never silently skipped.
 */
export function planListingEdit(
  origin: "ebay" | "gradethread",
  fieldNames: string[],
): ListingEditPlan {
  const apply: string[] = [];
  const locked: string[] = [];
  for (const f of fieldNames) {
    if (origin === "ebay" && isEbayOwned(f)) locked.push(f);
    else apply.push(f);
  }
  return { status: apply.length === 0 ? "blocked" : "apply", apply, locked };
}

export type BulkEditItemStatus = "ok" | "blocked" | "error";

export interface BulkEditItemResult {
  listing_id: string;
  status: BulkEditItemStatus;
  /** Present on "error". */
  error?: string;
  /** Present on "blocked": the eBay-owned fields that were refused. */
  locked?: string[];
}

export interface BulkEditSummary {
  ok: number;
  blocked: number;
  error: number;
}

/** Roll up per-item outcomes into ok/blocked/error counts. */
export function summarizeBulkEdit(results: BulkEditItemResult[]): BulkEditSummary {
  const summary: BulkEditSummary = { ok: 0, blocked: 0, error: 0 };
  for (const r of results) summary[r.status] += 1;
  return summary;
}

/** Minimal per-listing facts the orchestrator needs to decide an outcome. */
export interface LoadedListing {
  id: string;
  origin: "ebay" | "gradethread";
}

/**
 * Run the bulk edit over the requested ids, producing one ok|blocked|error
 * result per id (order preserved). I/O is injected so this stays pure:
 *
 * • `resolve` returns the owned/loaded listing for an id, or null when the id
 *   was not found / not owned by the caller (→ "error").
 * • `apply` performs the side effects (persist locally + push to the
 *   marketplace via the adapter) for the writable fields, returning ok/error.
 *   It is only called for listings whose plan is "apply"; a thrown error is
 *   caught and reported as "error" so one bad item never aborts the batch.
 */
export async function processBulkEdit(
  requestedIds: string[],
  fieldNames: string[],
  resolve: (id: string) => LoadedListing | null,
  apply: (listing: LoadedListing, applyFields: string[]) => Promise<{ ok: boolean; error?: string }>,
): Promise<BulkEditItemResult[]> {
  const results: BulkEditItemResult[] = [];
  for (const id of requestedIds) {
    const listing = resolve(id);
    if (!listing) {
      results.push({ listing_id: id, status: "error", error: "Listing not found" });
      continue;
    }
    const plan = planListingEdit(listing.origin, fieldNames);
    if (plan.status === "blocked") {
      results.push({ listing_id: id, status: "blocked", locked: plan.locked });
      continue;
    }
    try {
      const r = await apply(listing, plan.apply);
      results.push(
        r.ok
          ? { listing_id: id, status: "ok" }
          : { listing_id: id, status: "error", error: r.error ?? "Update failed" },
      );
    } catch (err) {
      results.push({
        listing_id: id,
        status: "error",
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }
  return results;
}
