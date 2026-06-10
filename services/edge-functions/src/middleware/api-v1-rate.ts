// Per-key, plan-tiered rate-limit policy for the public API (US-800).
//
// The shared rateLimiter (middleware/rate-limit.ts) owns the window math,
// distributed counter, fail-closed fallback, and headers. This module supplies
// the three /api/v1-specific knobs:
//   • subject  — bucket by API key id (not user) so one key can't drain another
//   • limit    — per-minute budget chosen by the owner's effective plan
//   • errorBody — the { data, error, meta } envelope the rest of /api/v1 uses
//
// The context vars (apiKeyId, apiKeyPlan) are set by apiKeyAuthMiddleware, which
// runs before these limiters on /api/v1/*.

import type { Context } from "hono";

export interface ApiRateTier {
  /** GET budget per minute (reads are cheap). */
  read: number;
  /** POST/PATCH budget per minute — the submit path spends AI credits per call,
   *  so it is kept tight regardless of read headroom. */
  write: number;
}

// API access is gated to the `business` plan at key creation (plan-gate
// `apiAccess`), so `business` is the live tier. The lower rows are defensive
// fallbacks for a key whose owner has since downgraded (existing keys keep
// working but get the smaller budget), and `super_admin` gives the platform
// owner headroom for internal tooling. Centralized here so limits change
// without touching call sites.
export const API_RATE_TIERS: Record<string, ApiRateTier> = {
  free: { read: 30, write: 5 },
  starter: { read: 60, write: 10 },
  pro: { read: 120, write: 20 },
  business: { read: 240, write: 40 },
  super_admin: { read: 1000, write: 200 },
};

const DEFAULT_TIER: ApiRateTier = API_RATE_TIERS.free;

// Read a string context var without the route's typed Env declaring it. The
// limiters mount at app level where these keys aren't in the static Env, so a
// direct c.get("apiKeyPlan") wouldn't type-check.
function ctxStr(c: Context, key: string): string | undefined {
  try {
    const v = (c.get as (k: string) => unknown)(key);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function apiV1Tier(c: Context): ApiRateTier {
  const plan = ctxStr(c, "apiKeyPlan") ?? "free";
  return API_RATE_TIERS[plan] ?? DEFAULT_TIER;
}

export function apiV1ReadLimit(c: Context): number {
  return apiV1Tier(c).read;
}

export function apiV1WriteLimit(c: Context): number {
  return apiV1Tier(c).write;
}

// Bucket by API key id so multiple keys held by one user don't share — and
// can't drain — a single budget. Falls back to user id, then null (the
// fail-closed limiter buckets a null subject rather than waving it through).
export function apiV1Subject(c: Context): string | null {
  const keyId = ctxStr(c, "apiKeyId");
  if (keyId) return `apikey:${keyId}`;
  const userId = ctxStr(c, "userId");
  return userId ? `user:${userId}` : null;
}

// 429 body in the same envelope (`{ data, error: { message, details }, meta }`)
// the rest of /api/v1 returns, so a client's error parsing stays uniform.
export function apiV1RateLimitBody(info: { retryAfter: number }): unknown {
  return {
    data: null,
    error: {
      message: `Rate limit exceeded. Retry after ${info.retryAfter}s.`,
      details: [],
    },
    meta: { retry_after_seconds: info.retryAfter },
  };
}
