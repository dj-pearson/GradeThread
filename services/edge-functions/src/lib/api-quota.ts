// US-1791: per-API-key MONTHLY usage quota (distinct from the per-minute rate
// limit in api-v1-rate.ts). A key can carry a `monthly_quota` (null = unlimited);
// once its api_usage_events count for the current UTC calendar month reaches the
// quota, further calls get a 429 quota_exceeded until the month rolls over.
//
// Pure helpers here (period boundaries + the exceeded decision) are unit-tested;
// the count query + enforcement live in api-key-auth.ts.

/** Start of the current UTC calendar month (the usage window start). */
export function billingMonthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Start of next UTC month — when the quota resets. */
export function quotaResetIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export interface QuotaState {
  /** null = unlimited. */
  quota: number | null;
  used: number;
  /** null when unlimited. */
  remaining: number | null;
  exceeded: boolean;
  resets_at: string;
}

/**
 * Decide quota state from a key's quota + its usage this period. A null/absent
 * quota is unlimited. Pure + exported for tests.
 */
export function computeQuotaState(
  quota: number | null | undefined,
  used: number,
  now: Date,
): QuotaState {
  const resets_at = quotaResetIso(now);
  if (quota == null || !Number.isFinite(quota) || quota < 0) {
    return { quota: null, used, remaining: null, exceeded: false, resets_at };
  }
  return {
    quota,
    used,
    remaining: Math.max(0, quota - used),
    exceeded: used >= quota,
    resets_at,
  };
}
