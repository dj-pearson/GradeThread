// US-1703: the runnable guarded-apply job — approve, apply (dry-run/real), and
// rollback an ads recommendation. Re-validates the recommendation's status +
// executability server-side (never trusts the request), fails CLOSED when
// Google Ads is unconfigured, is idempotent (re-applying an applied rec no-ops),
// and audits every attempt (before/after) so a change is reversible.

import { supabaseAdmin } from "./supabase.ts";
import { googleAdsConfig, GoogleAdsError, mintGoogleAdsAccessToken } from "./google-ads-client.ts";
import { applyMutation, type ApplyOutcome, isExecutableChangeType } from "./google-ads-mutate.ts";
import { checkGuardrails, type GuardrailContext, getGuardrails } from "./ads-guardrails.ts";
import { microsToDollars } from "./google-ads-sync.ts";
import {
  appleSearchAdsConfig,
  AppleSearchAdsError,
  mintAppleAccessToken,
} from "./apple-search-ads-client.ts";
import { applyAppleMutation, buildAppleRevertPayload, isAppleExecutableChangeType } from "./apple-search-ads-mutate.ts";

export const GOOGLE_ADS_PLATFORM = "google_ads";

interface RecRow {
  id: string;
  platform: string;
  change_type: string;
  target_type: string | null;
  target_resource: string;
  status: string;
  payload: Record<string, unknown> | null;
}

/** Read today's account spend + today's real-apply count for the guardrail gate. */
async function resolveGuardrailContext(platform: string = GOOGLE_ADS_PLATFORM): Promise<GuardrailContext> {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: metrics }, { count }] = await Promise.all([
    supabaseAdmin
      .from("ads_metrics_daily")
      .select("cost_micros")
      .eq("platform", platform)
      .eq("entity_type", "campaign")
      .eq("metric_date", today),
    supabaseAdmin
      .from("ads_change_audit")
      .select("id", { count: "exact", head: true })
      .eq("platform", platform)
      .eq("action", "apply")
      .eq("dry_run", false)
      .eq("success", true)
      .gte("created_at", `${today}T00:00:00Z`),
  ]);
  const todaySpend = ((metrics ?? []) as Array<{ cost_micros: number | string }>)
    .reduce((s, r) => s + microsToDollars(r.cost_micros), 0);
  return { todaySpend, appliesThisRun: count ?? 0 };
}

/** Approve a proposed recommendation (proposed → approved). Idempotent-ish. */
export async function approveRecommendation(id: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("ads_recommendations")
    .update({ status: "approved" })
    .eq("id", id)
    .eq("status", "proposed");
  return !error;
}

export interface ApplyResult {
  ok: boolean;
  dryRun: boolean;
  outcome?: ApplyOutcome;
  message?: string;
  httpStatus: number;
}

async function auditApply(
  rec: RecRow,
  outcome: ApplyOutcome | null,
  ownerUserId: string | null,
  action: "apply" | "rollback",
  success: boolean,
  errorMsg?: string,
): Promise<void> {
  await supabaseAdmin.from("ads_change_audit").insert({
    platform: GOOGLE_ADS_PLATFORM,
    recommendation_id: rec.id,
    change_type: rec.change_type,
    target_type: rec.target_type,
    target_resource: outcome?.targetResource ?? rec.target_resource,
    before_value: outcome?.before ?? {},
    after_value: outcome?.after ?? {},
    dry_run: outcome?.dryRun ?? false,
    success,
    action,
    result: outcome?.result ?? {},
    error: errorMsg ?? null,
    owner_user_id: ownerUserId,
  });
}

/**
 * Apply (or dry-run) an APPROVED recommendation through the guarded mutate path.
 * Loads + re-validates the rec server-side; never trusts a body-supplied status.
 */
export async function applyRecommendation(
  opts: { recId: string; dryRun: boolean; ownerUserId?: string | null },
): Promise<ApplyResult> {
  const { data, error } = await supabaseAdmin
    .from("ads_recommendations")
    .select("id, platform, change_type, target_type, target_resource, status, payload")
    .eq("id", opts.recId)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, dryRun: opts.dryRun, message: "Recommendation not found.", httpStatus: 404 };
  }
  const rec = data as RecRow;
  const isApple = rec.platform === "apple_search_ads";

  // Idempotent: a real re-apply of an applied rec is a no-op (dry-run still runs).
  if (rec.status === "applied" && !opts.dryRun) {
    return { ok: true, dryRun: false, message: "Already applied.", httpStatus: 200 };
  }
  // Only an APPROVED recommendation may apply (or be dry-run-checked).
  if (rec.status !== "approved") {
    return { ok: false, dryRun: opts.dryRun, message: "Recommendation must be approved before applying.", httpStatus: 409 };
  }
  const executable = isApple ? isAppleExecutableChangeType(rec.change_type) : isExecutableChangeType(rec.change_type);
  if (!executable) {
    return { ok: false, dryRun: opts.dryRun, message: "This change type is report-only and cannot be applied.", httpStatus: 422 };
  }

  // Resolve the platform's config; fail CLOSED when unconfigured.
  const googleCfg = isApple ? null : googleAdsConfig();
  const appleCfg = isApple ? appleSearchAdsConfig() : null;
  if ((isApple && !appleCfg) || (!isApple && !googleCfg)) {
    return { ok: false, dryRun: opts.dryRun, message: `${isApple ? "Apple Search Ads" : "Google Ads"} is not configured.`, httpStatus: 400 };
  }

  const mutateArgs = { changeType: rec.change_type, payload: rec.payload ?? {} };
  // Platform-dispatched mutate (both return the same outcome shape).
  const mutate = async (dryRun: boolean): Promise<ApplyOutcome> => {
    if (isApple) {
      const token = await mintAppleAccessToken(appleCfg!);
      return applyAppleMutation(appleCfg!, token, { ...mutateArgs, dryRun });
    }
    const token = await mintGoogleAdsAccessToken(googleCfg!);
    return applyMutation(googleCfg!, token, { ...mutateArgs, dryRun });
  };

  try {
    // Always dry-run first — captures before/after (a server validate for Google;
    // a local validate for ASA, which has no server dry-run).
    const dryOutcome = await mutate(true);
    if (opts.dryRun) {
      await auditApply(rec, dryOutcome, opts.ownerUserId ?? null, "apply", true);
      return { ok: true, dryRun: true, outcome: dryOutcome, httpStatus: 200 };
    }

    // US-1705: hard guardrails gate BEFORE the real mutate (both platforms).
    const guardrails = await getGuardrails();
    const ctx = await resolveGuardrailContext(rec.platform);
    const check = checkGuardrails(rec.change_type, dryOutcome.before, dryOutcome.after, guardrails, ctx);
    if (!check.allowed) {
      await auditApply(rec, dryOutcome, opts.ownerUserId ?? null, "apply", false, `guardrail: ${check.reason}`);
      return { ok: false, dryRun: false, message: `Blocked by a guardrail — ${check.reason}`, httpStatus: 422 };
    }

    const outcome = await mutate(false);
    await auditApply(rec, outcome, opts.ownerUserId ?? null, "apply", true);
    await supabaseAdmin.from("ads_recommendations").update({ status: "applied" }).eq("id", rec.id);
    return { ok: true, dryRun: false, outcome, httpStatus: 200 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditApply(rec, null, opts.ownerUserId ?? null, "apply", false, message);
    const bad = err instanceof GoogleAdsError || err instanceof AppleSearchAdsError;
    return { ok: false, dryRun: opts.dryRun, message, httpStatus: bad ? 502 : 500 };
  }
}

/** Parse the entity ids out of a resource name for rebuilding a revert payload. */
export function idsFromResource(resource: string): Record<string, string> {
  const parts = resource.split("/");
  const kind = parts[parts.length - 2];
  const id = parts[parts.length - 1] ?? "";
  switch (kind) {
    case "campaigns":
      return { campaignId: id };
    case "adGroups":
      return { adGroupId: id };
    case "campaignBudgets":
      return { campaignBudgetId: id };
    case "adGroupCriteria": {
      const [agId, critId] = id.split("~");
      return { adGroupId: agId ?? "", criterionId: critId ?? "" };
    }
    default:
      return {};
  }
}

/**
 * Reconstruct the payload that restores `before` for an update-type change.
 * Returns null for create-type changes (e.g. add_negative_keyword), whose
 * rollback would be a removal — not auto-supported.
 */
export function buildRevertPayload(
  changeType: string,
  targetResource: string,
  before: Record<string, unknown>,
): Record<string, unknown> | null {
  const ids = idsFromResource(targetResource);
  switch (changeType) {
    case "pause_campaign":
    case "pause_ad_group":
    case "pause_keyword":
      if (before.status == null) return null;
      return { ...ids, status: before.status };
    case "adjust_budget":
    case "reallocate_budget":
      if (before.amountMicros == null) return null;
      return { ...ids, amountMicros: before.amountMicros };
    case "adjust_bid":
      if (before.cpcBidMicros == null) return null;
      return { ...ids, cpcBidMicros: before.cpcBidMicros };
    case "adjust_tcpa":
      if (before.targetCpaMicros == null) return null;
      return { ...ids, targetCpaMicros: before.targetCpaMicros };
    default:
      return null; // create-type (add_negative_keyword) — manual removal
  }
}

export interface RevertResult {
  ok: boolean;
  message?: string;
  outcome?: ApplyOutcome;
  httpStatus: number;
}

/** Roll back a prior applied change by re-applying its stored before-value. */
export async function revertChange(
  opts: { auditId: string; ownerUserId?: string | null },
): Promise<RevertResult> {
  const { data, error } = await supabaseAdmin
    .from("ads_change_audit")
    .select("id, platform, recommendation_id, change_type, target_type, target_resource, before_value, dry_run, success, action")
    .eq("id", opts.auditId)
    .maybeSingle();
  if (error || !data) return { ok: false, message: "Audit entry not found.", httpStatus: 404 };
  const audit = data as {
    platform: string;
    recommendation_id: string | null;
    change_type: string;
    target_type: string | null;
    target_resource: string;
    before_value: Record<string, unknown>;
    dry_run: boolean;
    success: boolean;
    action: string;
  };
  if (audit.dry_run || !audit.success || audit.action !== "apply") {
    return { ok: false, message: "Only a successful real apply can be rolled back.", httpStatus: 409 };
  }
  const isApple = audit.platform === "apple_search_ads";

  const payload = isApple
    ? buildAppleRevertPayload(audit.change_type, audit.target_resource, audit.before_value ?? {})
    : buildRevertPayload(audit.change_type, audit.target_resource, audit.before_value ?? {});
  if (!payload) {
    return { ok: false, message: "Rollback isn't supported for this change type.", httpStatus: 422 };
  }

  const googleCfg = isApple ? null : googleAdsConfig();
  const appleCfg = isApple ? appleSearchAdsConfig() : null;
  if ((isApple && !appleCfg) || (!isApple && !googleCfg)) {
    return { ok: false, message: `${isApple ? "Apple Search Ads" : "Google Ads"} is not configured.`, httpStatus: 400 };
  }

  const recStub: RecRow = {
    id: audit.recommendation_id ?? opts.auditId,
    platform: audit.platform,
    change_type: audit.change_type,
    target_type: audit.target_type,
    target_resource: audit.target_resource,
    status: "approved",
    payload,
  };
  const mutate = async (dryRun: boolean): Promise<ApplyOutcome> => {
    if (isApple) {
      const token = await mintAppleAccessToken(appleCfg!);
      return applyAppleMutation(appleCfg!, token, { changeType: audit.change_type, payload, dryRun });
    }
    const token = await mintGoogleAdsAccessToken(googleCfg!);
    return applyMutation(googleCfg!, token, { changeType: audit.change_type, payload, dryRun });
  };
  try {
    // Dry-run first, then real (same guarded path).
    await mutate(true);
    const outcome = await mutate(false);
    await auditApply(recStub, outcome, opts.ownerUserId ?? null, "rollback", true);
    return { ok: true, outcome, httpStatus: 200 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditApply(recStub, null, opts.ownerUserId ?? null, "rollback", false, message);
    const bad = err instanceof GoogleAdsError || err instanceof AppleSearchAdsError;
    return { ok: false, message, httpStatus: bad ? 502 : 500 };
  }
}
