// US-1703: guarded apply to Google Ads.
//
// The ONLY path that mutates the live Google Ads account. Every apply is:
//   1. ALLOW-LISTED — only the change types below map to a mutate; anything else
//      (e.g. fix_rsa_gap, an unknown type) is rejected, never executed.
//   2. DRY-RUN FIRST — a validateOnly=true mutate must succeed before the real
//      validateOnly=false mutate runs.
//   3. AUDITED + REVERSIBLE — the pre-mutate value is read from the live account
//      and returned as `before`, so ads_change_audit can store it for rollback.
//
// Payload numbers are validated/clamped; a missing required field rejects the op.
// fetch is injected so the whole request shaping is unit-tested with no live call.

import {
  GOOGLE_ADS_API_VERSION,
  type GoogleAdsConfig,
  GoogleAdsError,
  runGaql,
} from "./google-ads-client.ts";

const ADS_API_BASE = "https://googleads.googleapis.com";

/** Change types that map to a real Google Ads mutate (subset of the analysis enum). */
export const EXECUTABLE_CHANGE_TYPES = new Set<string>([
  "pause_campaign",
  "pause_ad_group",
  "pause_keyword",
  "adjust_budget",
  "reallocate_budget",
  "adjust_bid",
  "adjust_tcpa",
  "add_negative_keyword",
]);

export function isExecutableChangeType(changeType: string): boolean {
  return EXECUTABLE_CHANGE_TYPES.has(changeType);
}

function res(config: GoogleAdsConfig, kind: string, id: string): string {
  return `customers/${config.customerId}/${kind}/${id}`;
}

function posMicros(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function normStatus(v: unknown, fallback: "ENABLED" | "PAUSED"): "ENABLED" | "PAUSED" {
  const s = String(v ?? "").toUpperCase();
  return s === "ENABLED" || s === "PAUSED" ? s : fallback;
}

export interface BuiltOperation {
  /** The googleAds:mutate mutateOperation. */
  op: Record<string, unknown>;
  targetResource: string;
  /** GAQL to read the current value for the audit `before` (null = nothing to read). */
  beforeQuery: string | null;
  /** Extract the before-value object from the beforeQuery rows. */
  extractBefore: (rows: Record<string, unknown>[]) => Record<string, unknown>;
  /** The value we're setting, for the audit `after`. */
  afterValue: Record<string, unknown>;
}

/**
 * Build the mutate operation for an allow-listed change type from its payload.
 * Returns null when the type isn't executable or a required payload field is
 * missing/invalid — the caller rejects (never guesses).
 */
export function buildMutateOperation(
  changeType: string,
  payload: Record<string, unknown>,
  config: GoogleAdsConfig,
): BuiltOperation | null {
  if (!isExecutableChangeType(changeType)) return null;

  switch (changeType) {
    case "pause_campaign": {
      const id = String(payload.campaignId ?? "");
      if (!id) return null;
      const status = normStatus(payload.status, "PAUSED");
      const resource = res(config, "campaigns", id);
      return {
        op: { campaignOperation: { update: { resourceName: resource, status }, updateMask: "status" } },
        targetResource: resource,
        beforeQuery: `SELECT campaign.status FROM campaign WHERE campaign.id = ${id}`,
        extractBefore: (rows) => ({ status: (rows[0]?.campaign as { status?: string } | undefined)?.status ?? null }),
        afterValue: { status },
      };
    }
    case "pause_ad_group": {
      const id = String(payload.adGroupId ?? "");
      if (!id) return null;
      const status = normStatus(payload.status, "PAUSED");
      const resource = res(config, "adGroups", id);
      return {
        op: { adGroupOperation: { update: { resourceName: resource, status }, updateMask: "status" } },
        targetResource: resource,
        beforeQuery: `SELECT ad_group.status FROM ad_group WHERE ad_group.id = ${id}`,
        extractBefore: (rows) => ({ status: (rows[0]?.adGroup as { status?: string } | undefined)?.status ?? null }),
        afterValue: { status },
      };
    }
    case "pause_keyword": {
      const agId = String(payload.adGroupId ?? "");
      const critId = String(payload.criterionId ?? "");
      if (!agId || !critId) return null;
      const status = normStatus(payload.status, "PAUSED");
      const resource = res(config, "adGroupCriteria", `${agId}~${critId}`);
      return {
        op: { adGroupCriterionOperation: { update: { resourceName: resource, status }, updateMask: "status" } },
        targetResource: resource,
        beforeQuery:
          `SELECT ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.criterion_id = ${critId} AND ad_group.id = ${agId}`,
        extractBefore: (rows) => ({ status: (rows[0]?.adGroupCriterion as { status?: string } | undefined)?.status ?? null }),
        afterValue: { status },
      };
    }
    case "adjust_budget":
    case "reallocate_budget": {
      const id = String(payload.campaignBudgetId ?? "");
      const amountMicros = posMicros(payload.amountMicros);
      if (!id || amountMicros === null) return null;
      const resource = res(config, "campaignBudgets", id);
      return {
        op: {
          campaignBudgetOperation: {
            update: { resourceName: resource, amountMicros: String(amountMicros) },
            updateMask: "amount_micros",
          },
        },
        targetResource: resource,
        beforeQuery: `SELECT campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.id = ${id}`,
        extractBefore: (rows) => ({
          amountMicros: (rows[0]?.campaignBudget as { amountMicros?: string } | undefined)?.amountMicros ?? null,
        }),
        afterValue: { amountMicros: String(amountMicros) },
      };
    }
    case "adjust_bid": {
      const agId = String(payload.adGroupId ?? "");
      const critId = String(payload.criterionId ?? "");
      const cpcBidMicros = posMicros(payload.cpcBidMicros);
      if (!agId || !critId || cpcBidMicros === null) return null;
      const resource = res(config, "adGroupCriteria", `${agId}~${critId}`);
      return {
        op: {
          adGroupCriterionOperation: {
            update: { resourceName: resource, cpcBidMicros: String(cpcBidMicros) },
            updateMask: "cpc_bid_micros",
          },
        },
        targetResource: resource,
        beforeQuery:
          `SELECT ad_group_criterion.cpc_bid_micros FROM ad_group_criterion WHERE ad_group_criterion.criterion_id = ${critId} AND ad_group.id = ${agId}`,
        extractBefore: (rows) => ({
          cpcBidMicros: (rows[0]?.adGroupCriterion as { cpcBidMicros?: string } | undefined)?.cpcBidMicros ?? null,
        }),
        afterValue: { cpcBidMicros: String(cpcBidMicros) },
      };
    }
    case "adjust_tcpa": {
      const id = String(payload.campaignId ?? "");
      const targetCpaMicros = posMicros(payload.targetCpaMicros);
      if (!id || targetCpaMicros === null) return null;
      const resource = res(config, "campaigns", id);
      return {
        op: {
          campaignOperation: {
            update: { resourceName: resource, maximizeConversions: { targetCpaMicros: String(targetCpaMicros) } },
            updateMask: "maximize_conversions.target_cpa_micros",
          },
        },
        targetResource: resource,
        beforeQuery:
          `SELECT campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.id = ${id}`,
        extractBefore: (rows) => ({
          targetCpaMicros:
            ((rows[0]?.campaign as { maximizeConversions?: { targetCpaMicros?: string } } | undefined)
              ?.maximizeConversions?.targetCpaMicros) ?? null,
        }),
        afterValue: { targetCpaMicros: String(targetCpaMicros) },
      };
    }
    case "add_negative_keyword": {
      const campaignId = String(payload.campaignId ?? "");
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!campaignId || !text) return null;
      const matchType = String(payload.matchType ?? "EXACT").toUpperCase();
      return {
        op: {
          campaignCriterionOperation: {
            create: {
              campaign: res(config, "campaigns", campaignId),
              negative: true,
              keyword: { text, matchType: ["EXACT", "PHRASE", "BROAD"].includes(matchType) ? matchType : "EXACT" },
            },
          },
        },
        targetResource: res(config, "campaigns", campaignId),
        // A create has no prior value; rollback = remove (recorded, handled by revert).
        beforeQuery: null,
        extractBefore: () => ({ existed: false }),
        afterValue: { negativeKeyword: text, matchType },
      };
    }
    default:
      return null;
  }
}

export function mutateUrl(config: GoogleAdsConfig): string {
  return `${ADS_API_BASE}/${GOOGLE_ADS_API_VERSION}/customers/${config.customerId}/googleAds:mutate`;
}

/** POST googleAds:mutate with one operation. validateOnly=true is the dry run. */
export async function googleAdsMutate(
  config: GoogleAdsConfig,
  token: string,
  operation: Record<string, unknown>,
  validateOnly: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(mutateUrl(config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": config.developerToken,
        "login-customer-id": config.loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mutateOperations: [operation], validateOnly }),
    });
  } catch (err) {
    throw new GoogleAdsError(0, "network", `Mutate request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new GoogleAdsError(response.status, response.status === 401 ? "unauthorized" : "request", `Google Ads mutate failed (${response.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface ApplyOutcome {
  changeType: string;
  targetResource: string;
  dryRun: boolean;
  success: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  result: Record<string, unknown>;
}

/**
 * Guarded apply: reject non-allow-listed types, read the before-value, run a
 * dry-run mutate, and (unless dryRun) run the real mutate. Throws GoogleAdsError
 * for a rejected type or a failed dry-run so nothing is applied on a bad op.
 */
export async function applyMutation(
  config: GoogleAdsConfig,
  token: string,
  args: { changeType: string; payload: Record<string, unknown>; dryRun: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<ApplyOutcome> {
  const built = buildMutateOperation(args.changeType, args.payload, config);
  if (!built) {
    throw new GoogleAdsError(0, "request", `Change type "${args.changeType}" is not allow-listed for apply, or its payload is invalid.`);
  }

  // Capture the before-value from the live account (for audit + rollback).
  let before: Record<string, unknown> = {};
  if (built.beforeQuery) {
    const rows = await runGaql(config, token, built.beforeQuery, fetchFn);
    before = built.extractBefore(rows);
  } else {
    before = built.extractBefore([]);
  }

  // 1) Dry-run FIRST — must succeed before the real mutate.
  const dryResult = await googleAdsMutate(config, token, built.op, true, fetchFn);
  if (args.dryRun) {
    return {
      changeType: args.changeType,
      targetResource: built.targetResource,
      dryRun: true,
      success: true,
      before,
      after: built.afterValue,
      result: dryResult,
    };
  }

  // 2) Real mutate.
  const result = await googleAdsMutate(config, token, built.op, false, fetchFn);
  return {
    changeType: args.changeType,
    targetResource: built.targetResource,
    dryRun: false,
    success: true,
    before,
    after: built.afterValue,
    result,
  };
}
