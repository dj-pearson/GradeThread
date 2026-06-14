// Shared cross-source conflict resolution (US-148 / US-898).
//
// The user-facing Reconciliation page (routes/flipdesk-reconciliation.ts) and
// the cross-tenant admin sync console (routes/admin-marketplace-ops.ts) both
// "pick the winning source" for an open flipdesk_sync_conflicts row: apply the
// winning value to the listing, pin the choice in listings.source_of_truth (so
// the eBay pull won't overwrite it and detection won't re-flag it), and close
// the conflict. This module is the single implementation of that flow so the
// two surfaces can never drift.
//
// TENANT SCOPING (US-268): every resolution is scoped to `ownerId` — conflicts
// are loaded with `.eq("user_id", ownerId)` and listings are touched only via
// ids taken from those owner-scoped rows. The admin console resolves the owner
// from the conflict row BEFORE calling in, so it can never resolve across
// tenants either.

import { supabaseAdmin } from "./supabase.ts";

export type ConflictFieldName = "price" | "quantity" | "listing_status" | "title";
export type WinningSource = "flipdesk" | "ebay" | "sheets";

export const WINNING_SOURCES = new Set<string>(["flipdesk", "ebay", "sheets"]);

// listing_status DB enum values a resolution is allowed to write.
const RESOLVABLE_STATUSES = new Set(["draft", "active", "ended", "sold", "relisted"]);

// Columns selected for an open conflict row.
export const CONFLICT_SELECT =
  "id, listing_id, field_name, flipdesk_value, ebay_value, sheets_value, suggested_action, detected_at";

export interface SyncConflictRow {
  id: string;
  listing_id: string;
  field_name: ConflictFieldName;
  flipdesk_value: string | null;
  ebay_value: string | null;
  sheets_value: string | null;
  suggested_action: string | null;
  detected_at: string;
}

// Parses + validates the winning value for a field. Stored values are
// normalized strings (see lib/sync-conflicts.ts normalizeConflictValue).
// Returns the listings-column patch, or an error string.
export function conflictPatchFor(
  field: ConflictFieldName,
  value: string | null,
): { patch: Record<string, unknown> } | { error: string } {
  if (value === null || value === "") {
    return { error: "That source has no value for this field." };
  }
  switch (field) {
    case "price": {
      const n = Number.parseFloat(value);
      if (!Number.isFinite(n) || n < 0) {
        return { error: `Not a usable price: "${value}".` };
      }
      return { patch: { listing_price: n } };
    }
    case "quantity": {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0) {
        return { error: `Not a usable quantity: "${value}".` };
      }
      return { patch: { quantity: n } };
    }
    case "listing_status": {
      const s = value.trim().toLowerCase();
      // eBay reports "ended_by_seller"; FlipDesk's enum only has "ended".
      const mapped = s === "ended_by_seller" ? "ended" : s;
      if (!RESOLVABLE_STATUSES.has(mapped)) {
        return { error: `Not a usable status: "${value}".` };
      }
      return { patch: { listing_status: mapped, is_active: mapped === "active" } };
    }
    case "title": {
      return { patch: { listing_title: value } };
    }
  }
}

export interface ResolveResult {
  resolved: number;
  failed: Array<{ conflict_id: string; error: string }>;
}

// Resolve one or more open conflicts for a single tenant. `resolutions` is the
// already-validated (conflict_id, source) list — last entry wins if the same
// conflict appears twice. Applies the winning value per listing (grouping N
// field picks on one listing into a single update), pins each choice in
// source_of_truth, and closes each conflict.
export async function applyConflictResolutions(
  ownerId: string,
  resolutions: Array<{ conflictId: string; source: WinningSource }>,
): Promise<ResolveResult> {
  const bySource = new Map<string, WinningSource>();
  for (const r of resolutions) bySource.set(r.conflictId, r.source);

  const failed: Array<{ conflict_id: string; error: string }> = [];
  if (bySource.size === 0) return { resolved: 0, failed };

  // Tenant scope (US-268): conflicts load .eq(user_id); listings are touched
  // only via ids taken from those rows. Already-resolved ids fall out here.
  const { data: conflictsRaw, error: loadErr } = await supabaseAdmin
    .from("flipdesk_sync_conflicts")
    .select(CONFLICT_SELECT)
    .eq("user_id", ownerId)
    .is("resolved_at", null)
    .in("id", [...bySource.keys()]);
  if (loadErr) {
    // Surface as a per-conflict failure for every requested id.
    for (const id of bySource.keys()) {
      failed.push({ conflict_id: id, error: "Failed to load conflict." });
    }
    return { resolved: 0, failed };
  }
  const conflicts = (conflictsRaw ?? []) as SyncConflictRow[];

  for (const id of bySource.keys()) {
    if (!conflicts.some((cf) => cf.id === id)) {
      failed.push({ conflict_id: id, error: "Conflict not found or already resolved." });
    }
  }

  // Current source_of_truth per listing, merged once per listing below.
  const listingIds = [...new Set(conflicts.map((cf) => cf.listing_id))];
  const sotByListing = new Map<string, Record<string, string>>();
  if (listingIds.length > 0) {
    const { data: listingsRaw, error: listingsErr } = await supabaseAdmin
      .from("listings")
      .select("id, source_of_truth")
      .in("id", listingIds);
    if (listingsErr) {
      for (const cf of conflicts) {
        failed.push({ conflict_id: cf.id, error: "Failed to load listing." });
      }
      return { resolved: 0, failed };
    }
    for (const l of (listingsRaw ?? []) as Array<{
      id: string;
      source_of_truth: Record<string, string> | null;
    }>) {
      sotByListing.set(l.id, { ...(l.source_of_truth ?? {}) });
    }
  }

  // Group per listing so N field picks on one listing are a single update.
  const byListing = new Map<
    string,
    { patch: Record<string, unknown>; resolvedIds: Array<{ id: string; source: WinningSource }> }
  >();
  for (const cf of conflicts) {
    const source = bySource.get(cf.id)!;
    const value =
      source === "flipdesk"
        ? cf.flipdesk_value
        : source === "ebay"
          ? cf.ebay_value
          : cf.sheets_value;
    const parsed = conflictPatchFor(cf.field_name, value);
    if ("error" in parsed) {
      failed.push({ conflict_id: cf.id, error: parsed.error });
      continue;
    }
    const sot = sotByListing.get(cf.listing_id);
    if (!sot) {
      failed.push({ conflict_id: cf.id, error: "Listing no longer exists." });
      continue;
    }
    sot[cf.field_name] = source;
    const group = byListing.get(cf.listing_id) ?? { patch: {}, resolvedIds: [] };
    Object.assign(group.patch, parsed.patch);
    group.resolvedIds.push({ id: cf.id, source });
    byListing.set(cf.listing_id, group);
  }

  let resolved = 0;
  const nowIso = new Date().toISOString();
  for (const [listingId, group] of byListing) {
    const { error: updateErr } = await supabaseAdmin
      .from("listings")
      .update({ ...group.patch, source_of_truth: sotByListing.get(listingId) })
      .eq("id", listingId);
    if (updateErr) {
      for (const r of group.resolvedIds) {
        failed.push({ conflict_id: r.id, error: "Failed to apply value to listing." });
      }
      console.error(
        `[sync-conflict-resolve] listing ${listingId} update failed:`,
        updateErr.message,
      );
      continue;
    }
    for (const r of group.resolvedIds) {
      const { error: closeErr } = await supabaseAdmin
        .from("flipdesk_sync_conflicts")
        .update({ resolved_at: nowIso, resolution: r.source })
        .eq("id", r.id)
        .eq("user_id", ownerId);
      if (closeErr) {
        // Value applied but the row didn't close — detection will simply
        // auto-converge it next sync (the source now matches the DB).
        failed.push({ conflict_id: r.id, error: "Applied, but failed to close the conflict." });
        continue;
      }
      resolved += 1;
    }
  }

  return { resolved, failed };
}
