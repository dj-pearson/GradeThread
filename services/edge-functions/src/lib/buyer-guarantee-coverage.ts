// US-1820: insured "Grade-Locked" purchase guarantee — COVERAGE & ELIGIBILITY.
//
// When a buyer links a purchase (US-1811), we SNAPSHOT whether it's covered and
// on what terms. Snapshot — not live — is the whole point: eligibility resolves
// from the buyer's entitlement tier (US-1800) + Trust Score level (US-1817) AT
// PURCHASE TIME and is frozen, so a later downgrade never voids an in-force
// claim (US-1820 AC2). Terms are config-driven (getSetting, no migration to
// tune). This is the NEW BUYER guarantee — distinct from the seller-side
// grade-fee `guarantee_claims` (US-1276). Claim intake/payout is US-1821.
//
// The reputation window bonus is applied through the SHARED perk resolver
// (effectiveGuaranteeWindowDays) so the "one source" precedence from US-1817
// holds: subscription baseline window + additive reputation bonus.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { getBuyerEntitlements } from "./buyer-entitlements.ts";
import { effectiveGuaranteeWindowDays } from "./buyer-reputation-perks.ts";
import { logEvent } from "./observability.ts";

const DAY_MS = 86_400_000;

export interface CoverageConfig {
  /** Master switch — false marks every new purchase ineligible ('disabled'). */
  enabled: boolean;
  /** Base coverage window (days) before the reputation bonus. */
  baseWindowDays: number;
  /** Max payout per covered claim (cents). */
  payoutCapCents: number;
  /** Minimum grade delta (arrival vs certified) that qualifies as a material
   *  mismatch — a claim below this is not a covered event. */
  gradeDeltaThreshold: number;
}

export const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  enabled: true,
  baseWindowDays: 30,
  payoutCapCents: 20_000, // $200 cap
  gradeDeltaThreshold: 1.0, // ≥ 1.0 grade points off = material
};

export interface CoverageInput {
  /** Does the buyer's plan unlock the purchase guarantee (US-1800)? */
  hasGuaranteeEntitlement: boolean;
  /** Trust Score level at purchase (US-1817) — drives the window bonus. */
  trustLevel: number;
  /** ISO purchase date; falls back to nowMs when the buyer didn't record one. */
  purchasedAt: string | null;
  config: CoverageConfig;
  nowMs: number;
}

export interface CoverageResult {
  eligible: boolean;
  /** Machine reason when ineligible (surfaced to the buyer), null when eligible. */
  reason: string | null;
  windowDays: number;
  /** ISO instant the coverage lapses, or null when ineligible. */
  coveredUntil: string | null;
  payoutCapCents: number;
  gradeDeltaThreshold: number;
}

/**
 * Resolve coverage terms for a purchase. PURE (takes config + nowMs) so the
 * eligibility matrix and window math are unit-tested without a DB. Ineligible
 * results still carry the terms that WOULD apply, so the UI can explain what an
 * upgrade unlocks.
 */
export function resolveCoverageTerms(input: CoverageInput): CoverageResult {
  const { config, trustLevel } = input;
  const windowDays = effectiveGuaranteeWindowDays(config.baseWindowDays, trustLevel);
  const base = {
    windowDays,
    payoutCapCents: config.payoutCapCents,
    gradeDeltaThreshold: config.gradeDeltaThreshold,
  };

  if (!config.enabled) {
    return { eligible: false, reason: "coverage_disabled", coveredUntil: null, ...base };
  }
  if (!input.hasGuaranteeEntitlement) {
    return { eligible: false, reason: "plan_not_covered", coveredUntil: null, ...base };
  }

  const startMs = input.purchasedAt ? Date.parse(input.purchasedAt) : input.nowMs;
  const anchorMs = Number.isFinite(startMs) ? startMs : input.nowMs;
  const coveredUntil = new Date(anchorMs + windowDays * DAY_MS).toISOString();
  return { eligible: true, reason: null, coveredUntil, ...base };
}

/**
 * Snapshot coverage for an owned purchase at link time. Reads the buyer's
 * entitlement + trust level NOW, resolves terms, and upserts the frozen record.
 * Best-effort: a failure never blocks the purchase link (coverage can be
 * re-snapshotted) — it logs and returns null. Scoped by user_id (US-268).
 */
export async function snapshotCoverageForPurchase(
  userId: string,
  purchaseId: string,
  nowMs: number = Date.now(),
): Promise<CoverageResult | null> {
  try {
    const config = await getSetting<CoverageConfig>(
      "buyer_guarantee_coverage",
      DEFAULT_COVERAGE_CONFIG,
    );

    // Ownership + purchase context, scoped by user_id.
    const { data: purchase } = await supabaseAdmin
      .from("buyer_purchases")
      .select("id, purchased_at")
      .eq("id", purchaseId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!purchase) return null;

    const ent = await getBuyerEntitlements(userId);
    const { data: trust } = await supabaseAdmin
      .from("buyer_trust_scores")
      .select("level")
      .eq("user_id", userId)
      .maybeSingle();
    const trustLevel = (trust as { level: number } | null)?.level ?? 0;

    const result = resolveCoverageTerms({
      hasGuaranteeEntitlement: ent.gateFlags.purchaseGuarantee === true,
      trustLevel,
      purchasedAt: (purchase as { purchased_at: string | null }).purchased_at,
      config,
      nowMs,
    });

    const { error } = await supabaseAdmin.from("purchase_coverage").upsert(
      {
        user_id: userId,
        purchase_id: purchaseId,
        eligible: result.eligible,
        ineligible_reason: result.reason,
        plan_at_purchase: ent.plan,
        level_at_purchase: trustLevel,
        window_days: result.windowDays,
        payout_cap_cents: result.payoutCapCents,
        grade_delta_threshold: result.gradeDeltaThreshold,
        covered_until: result.coveredUntil,
      } as never,
      { onConflict: "purchase_id" },
    );
    if (error) {
      logEvent("warn", "guarantee-coverage.snapshot_failed", { purchaseId, error: error.message });
      return null;
    }
    return result;
  } catch (err) {
    logEvent("warn", "guarantee-coverage.snapshot_error", {
      purchaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
