// 3-way sync-conflict detection (US-148): FlipDesk ↔ eBay ↔ Google Sheets.
//
// Both sync cycles call recordSourceObservations() with what their external
// source currently says about each listing. Disagreements with FlipDesk's
// value persist as one OPEN flipdesk_sync_conflicts row per (listing, field);
// the Cross-source reconciliation tab resolves them.
//
// Key semantics:
// - flipdesk_value is frozen at first detection. The eBay pull overwrites
//   price/status afterwards (eBay-wins default), so on later observations the
//   current DB value may equal the eBay value — the conflict stays open until
//   the user picks a source, or the external source returns to the ORIGINAL
//   FlipDesk value (auto_converged).
// - A field with a listings.source_of_truth entry is already decided — it is
//   never re-flagged.

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser } from "./notify.ts";
import { sendSyncConflictsEmail } from "./email.ts";

export type ConflictField = "price" | "quantity" | "listing_status" | "title";
export type ConflictSource = "ebay" | "sheets";

export interface SourceObservation {
  listingId: string;
  field: ConflictField;
  /** FlipDesk's value at observation time (pre-overwrite). */
  flipdeskValue: string | number | null;
  /** The external source's value. */
  observedValue: string | number | null;
}

export interface RecordResult {
  recorded: number;
  resolved: number;
  errors: string[];
}

/**
 * Normalize a raw value for comparison/storage: numbers canonicalized
 * ("12.50" == 12.5), strings trimmed, empty → null.
 */
export function normalizeConflictValue(
  field: ConflictField,
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  const s = value.trim();
  if (s === "") return null;
  if (field === "price" || field === "quantity") {
    const n = Number.parseFloat(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? String(n) : s;
  }
  return s;
}

/**
 * Auto-flag rule (US-148): eBay reports the listing ended while FlipDesk still
 * says active → suggest "Mark ended in FlipDesk" (= accept eBay's status).
 */
export function suggestedActionFor(
  field: ConflictField,
  flipdeskValue: string | null,
  ebayValue: string | null,
): string | null {
  if (
    field === "listing_status" &&
    flipdeskValue === "active" &&
    (ebayValue === "ended" || ebayValue === "ended_by_seller")
  ) {
    return "mark_ended_in_flipdesk";
  }
  return null;
}

interface OpenConflictRow {
  id: string;
  listing_id: string;
  field_name: ConflictField;
  flipdesk_value: string | null;
  ebay_value: string | null;
  sheets_value: string | null;
}

/**
 * Record what `source` currently says about a batch of listings, upserting
 * open conflicts where it disagrees with FlipDesk and auto-resolving ones
 * where it returned to FlipDesk's original value. Fires the threshold email /
 * in-app notification when the user's open count crosses their configured
 * threshold. `userId` must already be tenant-resolved (US-268).
 */
export async function recordSourceObservations(
  userId: string,
  source: ConflictSource,
  observations: SourceObservation[],
): Promise<RecordResult> {
  const result: RecordResult = { recorded: 0, resolved: 0, errors: [] };
  if (observations.length === 0) return result;

  const valueCol = source === "ebay" ? "ebay_value" : "sheets_value";
  const listingIds = [...new Set(observations.map((o) => o.listingId))];

  // Decided fields (source_of_truth set) are skipped entirely.
  const { data: listingRows, error: listingErr } = await supabaseAdmin
    .from("listings")
    .select("id, source_of_truth")
    .in("id", listingIds);
  if (listingErr) {
    result.errors.push(`load listings: ${listingErr.message}`);
    return result;
  }
  const sotByListing = new Map<string, Record<string, string>>(
    ((listingRows ?? []) as { id: string; source_of_truth: Record<string, string> | null }[])
      .map((r) => [r.id, r.source_of_truth ?? {}]),
  );

  const prevOpen = await countOpenConflicts(userId);

  const { data: openRows, error: openErr } = await supabaseAdmin
    .from("flipdesk_sync_conflicts")
    .select("id, listing_id, field_name, flipdesk_value, ebay_value, sheets_value")
    .eq("user_id", userId)
    .is("resolved_at", null)
    .in("listing_id", listingIds);
  if (openErr) {
    result.errors.push(`load open conflicts: ${openErr.message}`);
    return result;
  }
  const openByKey = new Map<string, OpenConflictRow>(
    ((openRows ?? []) as OpenConflictRow[]).map((r) => [
      `${r.listing_id}:${r.field_name}`,
      r,
    ]),
  );

  const inserts: Record<string, unknown>[] = [];
  const nowIso = new Date().toISOString();

  for (const obs of observations) {
    // Listing unknown (e.g. deleted mid-sync) or field already decided → skip.
    const sot = sotByListing.get(obs.listingId);
    if (!sot || sot[obs.field]) continue;

    const observed = normalizeConflictValue(obs.field, obs.observedValue);
    const flipdesk = normalizeConflictValue(obs.field, obs.flipdeskValue);
    const existing = openByKey.get(`${obs.listingId}:${obs.field}`);

    if (existing) {
      if (observed === existing.flipdesk_value) {
        // External source came back to FlipDesk's original value.
        const { error } = await supabaseAdmin
          .from("flipdesk_sync_conflicts")
          .update({
            [valueCol]: observed,
            resolved_at: nowIso,
            resolution: "auto_converged",
          })
          .eq("id", existing.id);
        if (error) result.errors.push(`resolve ${obs.field}: ${error.message}`);
        else result.resolved += 1;
      } else if (existing[valueCol] !== observed) {
        // Source moved again — refresh its side of the open conflict.
        const ebayVal = source === "ebay" ? observed : existing.ebay_value;
        const { error } = await supabaseAdmin
          .from("flipdesk_sync_conflicts")
          .update({
            [valueCol]: observed,
            detected_at: nowIso,
            suggested_action: suggestedActionFor(
              obs.field,
              existing.flipdesk_value,
              ebayVal,
            ),
          })
          .eq("id", existing.id);
        if (error) result.errors.push(`update ${obs.field}: ${error.message}`);
        else result.recorded += 1;
      }
      continue;
    }

    if (observed === flipdesk) continue; // sources agree — nothing to flag

    inserts.push({
      user_id: userId,
      listing_id: obs.listingId,
      field_name: obs.field,
      flipdesk_value: flipdesk,
      [valueCol]: observed,
      suggested_action: suggestedActionFor(
        obs.field,
        flipdesk,
        source === "ebay" ? observed : null,
      ),
      detected_at: nowIso,
    });
  }

  if (inserts.length > 0) {
    const { error } = await supabaseAdmin
      .from("flipdesk_sync_conflicts")
      .insert(inserts);
    if (error) {
      // A concurrent sync may have inserted the same (listing, field) — the
      // partial unique index rejects the batch; retry row-by-row, skipping dups.
      for (const row of inserts) {
        const { error: rowErr } = await supabaseAdmin
          .from("flipdesk_sync_conflicts")
          .insert(row);
        if (!rowErr) result.recorded += 1;
        else if (rowErr.code !== "23505") {
          result.errors.push(`insert ${row.field_name}: ${rowErr.message}`);
        }
      }
    } else {
      result.recorded += inserts.length;
    }
  }

  await maybeNotifyThreshold(userId, prevOpen, result);
  return result;
}

async function countOpenConflicts(userId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("flipdesk_sync_conflicts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("resolved_at", null);
  return count ?? 0;
}

// One email + in-app notification per upward crossing of the user-configured
// threshold (users.sync_conflict_email_threshold, NULL = disabled). Stateless:
// staying above the threshold never re-sends; dropping below and crossing
// again does.
async function maybeNotifyThreshold(
  userId: string,
  prevOpen: number,
  result: RecordResult,
): Promise<void> {
  try {
    const newOpen = await countOpenConflicts(userId);
    if (newOpen <= prevOpen) return;

    const { data: userRow } = await supabaseAdmin
      .from("users")
      .select("email, full_name, sync_conflict_email_threshold, notification_preferences")
      .eq("id", userId)
      .maybeSingle();
    const u = userRow as {
      email: string | null;
      full_name: string | null;
      sync_conflict_email_threshold: number | null;
      notification_preferences: Record<string, { email?: boolean }> | null;
    } | null;
    const threshold = u?.sync_conflict_email_threshold;
    if (!threshold || threshold < 1) return;
    if (!(prevOpen < threshold && newOpen >= threshold)) return;

    void notifyUser(userId, {
      type: "system",
      title: "Sync conflicts need review",
      message:
        `${newOpen} cross-source conflicts are open — FlipDesk, eBay, and ` +
        "Google Sheets disagree. Pick the source of truth on the Reconciliation page.",
      link: "/dashboard/flipdesk/reconciliation",
    });

    // Email channel honors the selling-activity preference (default on).
    if (u?.notification_preferences?.selling_activity?.email === false) return;
    if (u?.email) {
      await sendSyncConflictsEmail(u.email, {
        userName: u.full_name ?? "there",
        openCount: newOpen,
        threshold,
      });
    }
  } catch (err) {
    result.errors.push(
      `threshold notify: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
