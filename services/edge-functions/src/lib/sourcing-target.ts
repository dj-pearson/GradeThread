// US-2851: the margin a seller is sourcing to, read once per request.
//
// SEPARATE FROM scout-decision.ts, which is pure and must stay that way: the
// ceiling maths is unit-tested without a database, and this is the one line of
// I/O that feeds it.
//
// TENANT SCOPING (US-268). flipdesk_settings is a multi-tenant table read here
// through the service-role client, which bypasses RLS, so the query is scoped
// explicitly on user_id and the caller MUST pass
// `c.get("workspaceOwnerId") ?? c.get("userId")`. A member sourcing inside a
// workspace spends against the OWNER's target, not a target of their own.

import { supabaseAdmin } from "./supabase.ts";
import { DECISION_MAYBE_ROI } from "./scout-decision.ts";

/** The setting's own bounds, matching the CHECK in migration 00666. */
export const MIN_SOURCING_TARGET_PCT = 0;
export const MAX_SOURCING_TARGET_PCT = 1000;

/**
 * Whole percent from the settings row into the fraction the maths wants.
 *
 * Pure, and deliberately strict: a value outside the column's own range means
 * the row was written by something that bypassed the constraint, and honouring
 * it would set a spending ceiling off a number the database would have refused.
 */
export function targetRoiFromPct(pct: number | null | undefined): number {
  if (pct == null || !Number.isFinite(pct)) return DECISION_MAYBE_ROI;
  if (pct < MIN_SOURCING_TARGET_PCT || pct > MAX_SOURCING_TARGET_PCT) {
    return DECISION_MAYBE_ROI;
  }
  return pct / 100;
}

/** The slice of supabase-js this module uses, injected so it is testable. */
export interface SourcingSettingsClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<{
          data: { sourcing_target_roi_pct: number | null } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

/**
 * The seller's target return on cost, as a fraction.
 *
 * Falls back to DECISION_MAYBE_ROI on absent row, null column, or any read
 * failure. The fallback is the SAME threshold that already decides whether the
 * scout calls an item a maybe, so a seller who has never touched the setting
 * gets a ceiling consistent with the verdict printed beside it, rather than a
 * multiplier invented for this feature.
 */
export async function sourcingTargetRoi(
  ownerId: string,
  client: SourcingSettingsClient = supabaseAdmin as unknown as SourcingSettingsClient,
): Promise<number> {
  try {
    const { data, error } = await client
      .from("flipdesk_settings")
      .select("sourcing_target_roi_pct")
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error) return DECISION_MAYBE_ROI;
    return targetRoiFromPct(data?.sourcing_target_roi_pct ?? null);
  } catch {
    return DECISION_MAYBE_ROI;
  }
}
