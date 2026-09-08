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
import { DECISION_MAYBE_ROI, type SourcingCosts } from "./scout-decision.ts";

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

/** The settings row this module reads, as far as it cares. */
export interface SourcingSettingsRow {
  sourcing_target_roi_pct: number | null;
  // US-3193 (00770). Optional on the type so a caller injecting an older fake
  // still compiles; absent reads as null, which means "use the code default".
  sourcing_shipping_cost_cents?: number | null;
  sourcing_supplies_cost_cents?: number | null;
  sourcing_grading_cost_cents?: number | null;
}

/** The slice of supabase-js this module uses, injected so it is testable. */
export interface SourcingSettingsClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<{
          data: SourcingSettingsRow | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

/** Every column the sourcing surfaces read, in one select. */
const SOURCING_SETTINGS_COLUMNS =
  "sourcing_target_roi_pct, sourcing_shipping_cost_cents, sourcing_supplies_cost_cents, sourcing_grading_cost_cents";

/**
 * US-3193: the seller's own cost lines for the buy ceiling.
 *
 * Same tenant scoping and same failure posture as sourcingTargetRoi: any read
 * failure returns an empty object, which means every line falls back to its
 * documented default rather than to zero. Falling back to zero on a failed read
 * would raise the ceiling exactly when we know least.
 */
export async function sourcingCosts(
  ownerId: string,
  client: SourcingSettingsClient = supabaseAdmin as unknown as SourcingSettingsClient,
): Promise<SourcingCosts> {
  try {
    const { data, error } = await client
      .from("flipdesk_settings")
      .select(SOURCING_SETTINGS_COLUMNS)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error || !data) return {};
    return {
      shippingCents: data.sourcing_shipping_cost_cents ?? null,
      suppliesCents: data.sourcing_supplies_cost_cents ?? null,
      gradingCents: data.sourcing_grading_cost_cents ?? null,
    };
  } catch {
    return {};
  }
}

/**
 * The target AND the cost lines in ONE read.
 *
 * Every ceiling needs both, and two round trips for two sets of columns on the
 * same row is a request the seller waits through twice while standing in a shop.
 */
export async function sourcingParams(
  ownerId: string,
  client: SourcingSettingsClient = supabaseAdmin as unknown as SourcingSettingsClient,
): Promise<{ targetRoi: number; costs: SourcingCosts }> {
  try {
    const { data, error } = await client
      .from("flipdesk_settings")
      .select(SOURCING_SETTINGS_COLUMNS)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error || !data) return { targetRoi: DECISION_MAYBE_ROI, costs: {} };
    return {
      targetRoi: targetRoiFromPct(data.sourcing_target_roi_pct ?? null),
      costs: {
        shippingCents: data.sourcing_shipping_cost_cents ?? null,
        suppliesCents: data.sourcing_supplies_cost_cents ?? null,
        gradingCents: data.sourcing_grading_cost_cents ?? null,
      },
    };
  } catch {
    return { targetRoi: DECISION_MAYBE_ROI, costs: {} };
  }
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
      .select(SOURCING_SETTINGS_COLUMNS)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error) return DECISION_MAYBE_ROI;
    return targetRoiFromPct(data?.sourcing_target_roi_pct ?? null);
  } catch {
    return DECISION_MAYBE_ROI;
  }
}
