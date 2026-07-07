// US-1708: guarded apply to Apple Search Ads.
//
// Mirrors google-ads-mutate.ts: an ALLOW-LIST of executable change types, a
// before-value read from the live account (for audit + rollback), then the real
// mutate. NOTE: the ASA Campaign Management API has NO validateOnly/dry-run, so a
// "dry-run" here only reads the before-value + validates the payload locally — it
// does NOT hit a server validate. The US-1705 guardrails still gate every real
// apply, and payload numbers are validated (a missing field rejects the op).

import {
  type AppleSearchAdsConfig,
  AppleSearchAdsError,
  appleRequest,
} from "./apple-search-ads-client.ts";

/** ASA-executable change types (subset of the analysis enum). */
export const APPLE_EXECUTABLE_CHANGE_TYPES = new Set<string>([
  "pause_campaign",
  "pause_ad_group",
  "pause_keyword",
  "adjust_budget",
  "reallocate_budget",
  "adjust_bid",
  "add_negative_keyword",
]);

export function isAppleExecutableChangeType(changeType: string): boolean {
  return APPLE_EXECUTABLE_CHANGE_TYPES.has(changeType);
}

function normStatus(v: unknown, fallback: "ENABLED" | "PAUSED"): "ENABLED" | "PAUSED" {
  const s = String(v ?? "").toUpperCase();
  return s === "ENABLED" || s === "PAUSED" ? s : fallback;
}
function posAmount(v: unknown): string | null {
  const n = typeof v === "string" ? Number(v) : (typeof v === "number" ? v : NaN);
  return Number.isFinite(n) && n >= 0 ? String(n) : null;
}

export interface AppleBuiltOperation {
  method: "PUT" | "POST";
  path: string;
  body: Record<string, unknown>;
  targetResource: string;
  /** GET path to read the current value for the audit `before` (null = none). */
  beforePath: string | null;
  extractBefore: (data: Record<string, unknown>) => Record<string, unknown>;
  afterValue: Record<string, unknown>;
}

/** Build the ASA mutate op for an allow-listed change type, or null if invalid. */
export function buildAppleMutation(
  changeType: string,
  payload: Record<string, unknown>,
): AppleBuiltOperation | null {
  if (!isAppleExecutableChangeType(changeType)) return null;
  const campaignId = String(payload.campaignId ?? "");
  const currency = String(payload.currency ?? "USD");

  switch (changeType) {
    case "pause_campaign": {
      if (!campaignId) return null;
      const status = normStatus(payload.status, "PAUSED");
      return {
        method: "PUT",
        path: `/campaigns/${campaignId}`,
        body: { campaign: { status } },
        targetResource: `campaigns/${campaignId}`,
        beforePath: `/campaigns/${campaignId}`,
        extractBefore: (d) => ({ status: (d.data as { status?: string } | undefined)?.status ?? null }),
        afterValue: { status },
      };
    }
    case "adjust_budget":
    case "reallocate_budget": {
      const amount = posAmount(payload.amount);
      if (!campaignId || amount === null) return null;
      return {
        method: "PUT",
        path: `/campaigns/${campaignId}`,
        body: { campaign: { budgetAmount: { amount, currency } } },
        targetResource: `campaigns/${campaignId}`,
        beforePath: `/campaigns/${campaignId}`,
        extractBefore: (d) => ({
          amount: (d.data as { budgetAmount?: { amount?: string } } | undefined)?.budgetAmount?.amount ?? null,
          currency,
        }),
        afterValue: { amount, currency },
      };
    }
    case "pause_ad_group": {
      const adGroupId = String(payload.adGroupId ?? "");
      if (!campaignId || !adGroupId) return null;
      const status = normStatus(payload.status, "PAUSED");
      return {
        method: "PUT",
        path: `/campaigns/${campaignId}/adgroups/${adGroupId}`,
        body: { adGroup: { status } },
        targetResource: `campaigns/${campaignId}/adgroups/${adGroupId}`,
        beforePath: `/campaigns/${campaignId}/adgroups/${adGroupId}`,
        extractBefore: (d) => ({ status: (d.data as { status?: string } | undefined)?.status ?? null }),
        afterValue: { status },
      };
    }
    case "pause_keyword": {
      const adGroupId = String(payload.adGroupId ?? "");
      const keywordId = String(payload.keywordId ?? "");
      if (!campaignId || !adGroupId || !keywordId) return null;
      const status = normStatus(payload.status, "PAUSED");
      return {
        method: "PUT",
        path: `/campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords/${keywordId}`,
        body: { status },
        targetResource: `campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords/${keywordId}`,
        beforePath: `/campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords/${keywordId}`,
        extractBefore: (d) => ({ status: (d.data as { status?: string } | undefined)?.status ?? null }),
        afterValue: { status },
      };
    }
    case "adjust_bid": {
      const adGroupId = String(payload.adGroupId ?? "");
      const keywordId = String(payload.keywordId ?? "");
      const amount = posAmount(payload.bidAmount);
      if (!campaignId || !adGroupId || !keywordId || amount === null) return null;
      return {
        method: "PUT",
        path: `/campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords/${keywordId}`,
        body: { bidAmount: { amount, currency } },
        targetResource: `campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords/${keywordId}`,
        beforePath: `/campaigns/${campaignId}/adgroups/${adGroupId}/targetingkeywords/${keywordId}`,
        extractBefore: (d) => ({
          amount: (d.data as { bidAmount?: { amount?: string } } | undefined)?.bidAmount?.amount ?? null,
          currency,
        }),
        afterValue: { amount, currency },
      };
    }
    case "add_negative_keyword": {
      const adGroupId = String(payload.adGroupId ?? "");
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!campaignId || !adGroupId || !text) return null;
      const matchType = String(payload.matchType ?? "EXACT").toUpperCase();
      return {
        method: "POST",
        path: `/campaigns/${campaignId}/adgroups/${adGroupId}/negativekeywords/bulk`,
        body: { negativeKeywords: [{ text, matchType: ["EXACT", "BROAD"].includes(matchType) ? matchType : "EXACT" }] },
        targetResource: `campaigns/${campaignId}/adgroups/${adGroupId}`,
        beforePath: null, // create — rollback = remove (not auto-supported)
        extractBefore: () => ({ existed: false }),
        afterValue: { negativeKeyword: text, matchType },
      };
    }
    default:
      return null;
  }
}

/** Parse the entity ids out of an ASA resource path for a revert payload. */
export function idsFromAppleResource(resource: string): Record<string, string> {
  const parts = resource.split("/");
  const out: Record<string, string> = {};
  for (let i = 0; i < parts.length - 1; i += 2) {
    const kind = parts[i];
    const id = parts[i + 1] ?? "";
    if (kind === "campaigns") out.campaignId = id;
    else if (kind === "adgroups") out.adGroupId = id;
    else if (kind === "targetingkeywords") out.keywordId = id;
  }
  return out;
}

/**
 * Reconstruct the payload that restores `before` for an ASA update-type change.
 * Returns null for create-type changes (add_negative_keyword) whose rollback is a
 * removal — not auto-supported.
 */
export function buildAppleRevertPayload(
  changeType: string,
  targetResource: string,
  before: Record<string, unknown>,
): Record<string, unknown> | null {
  const ids = idsFromAppleResource(targetResource);
  switch (changeType) {
    case "pause_campaign":
    case "pause_ad_group":
    case "pause_keyword":
      if (before.status == null) return null;
      return { ...ids, status: before.status };
    case "adjust_budget":
    case "reallocate_budget":
      if (before.amount == null) return null;
      return { ...ids, amount: before.amount, currency: before.currency ?? "USD" };
    case "adjust_bid":
      if (before.amount == null) return null;
      return { ...ids, bidAmount: before.amount, currency: before.currency ?? "USD" };
    default:
      return null;
  }
}

export interface AppleApplyOutcome {
  changeType: string;
  targetResource: string;
  dryRun: boolean;
  success: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  result: Record<string, unknown>;
}

/**
 * Guarded ASA apply: reject non-allow-listed types, read before-value, and
 * (unless dryRun) run the real mutate. ASA has no server dry-run, so dryRun only
 * reads the before-value + validates locally.
 */
export async function applyAppleMutation(
  config: AppleSearchAdsConfig,
  token: string,
  args: { changeType: string; payload: Record<string, unknown>; dryRun: boolean },
  request?: <T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<T>,
): Promise<AppleApplyOutcome> {
  const built = buildAppleMutation(args.changeType, args.payload);
  if (!built) {
    throw new AppleSearchAdsError(0, `Change type "${args.changeType}" is not allow-listed for Apple Search Ads apply, or its payload is invalid.`);
  }
  const call = request ??
    (<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown) =>
      appleRequest<T>(config, token, method as "GET" | "POST", path, body));

  let before: Record<string, unknown> = built.extractBefore({});
  if (built.beforePath) {
    const data = await call<Record<string, unknown>>("GET", built.beforePath);
    before = built.extractBefore(data);
  }

  if (args.dryRun) {
    // No ASA server-side validate — the payload was built + validated locally.
    return { changeType: args.changeType, targetResource: built.targetResource, dryRun: true, success: true, before, after: built.afterValue, result: { validated: "local" } };
  }

  const result = await call<Record<string, unknown>>(built.method, built.path, built.body);
  return { changeType: args.changeType, targetResource: built.targetResource, dryRun: false, success: true, before, after: built.afterValue, result: result ?? {} };
}
