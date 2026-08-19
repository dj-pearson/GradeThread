import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  type ApiKeyScope,
  DEFAULT_API_KEY_SCOPES,
  hashApiKey,
  isWellFormedApiKey,
} from "../lib/api-key.ts";
import { effectivePlanFor } from "../lib/grade-pricing.ts";
import { billingMonthStartIso, computeQuotaState } from "../lib/api-quota.ts";

type ApiKeyAuthEnv = {
  Variables: {
    user: { id: string; email?: string; [key: string]: unknown };
    userId: string;
    apiKeyScopes: ApiKeyScope[];
    // US-800: the calling key's id (rate-limit subject — bucketed per key, not
    // per user) and the owner's effective plan (rate-limit tier). "super_admin"
    // is funneled through the plan slot so the platform owner gets headroom.
    apiKeyId: string;
    apiKeyPlan: string;
  };
};

/**
 * US-9104: read the key from either transport.
 *
 * `X-API-Key` is the historical header and every existing /api/v1 partner sends
 * it, so it stays first and stays working. `Authorization: Bearer` is added
 * because MCP clients have no other way to send a credential — Claude Code's
 * custom-header config and the Messages API connector's `authorization_token`
 * both land there — and OAuth 2.1 mandates that header for resource requests
 * (US-9122 will resolve OAuth tokens through the same slot).
 *
 * A bearer token is only claimed when it carries the `gt_sk_` prefix. That
 * restraint is deliberate: /api/v1 callers may already send `Authorization` for
 * something else, and claiming any bearer would turn today's "Missing
 * X-API-Key header" into "Invalid API key format" for them. Anything else in
 * that header is left alone — an OAuth access token is US-9122's to resolve,
 * and /mcp reports the difference itself.
 */
export const API_KEY_PREFIX = "gt_sk_";

export function extractApiKey(headerOf: (name: string) => string | undefined): string | undefined {
  const direct = headerOf("X-API-Key");
  if (direct) return direct;
  const bearer = extractBearerToken(headerOf);
  return bearer?.startsWith(API_KEY_PREFIX) ? bearer : undefined;
}

/** The raw `Authorization: Bearer` value, whatever it is. */
export function extractBearerToken(
  headerOf: (name: string) => string | undefined,
): string | undefined {
  const authorization = headerOf("Authorization");
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : undefined;
}

/** Why an API key could not be turned into a caller identity. */
export type ApiKeyAuthFailure =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "unknown" }
  | { kind: "expired" }
  | { kind: "quota_exceeded"; quota: number; resetsAt: string };

export interface ApiKeyIdentity {
  userId: string;
  apiKeyId: string;
  apiKeyPlan: string;
  scopes: ApiKeyScope[];
}

export type ApiKeyResolution =
  | { ok: true; identity: ApiKeyIdentity }
  | { ok: false; failure: ApiKeyAuthFailure };

/**
 * Turn a raw key into a caller identity, or say why it cannot.
 *
 * Split out of the middleware (US-9104) so /api/v1 and /mcp share one
 * definition of key validity, plan tiering and quota. They must NOT share an
 * error shape: /api/v1's `{ error: string }` 401 predates the envelope and
 * partners parse it, while an MCP client can only read JSON-RPC. Two
 * middlewares, one resolver.
 */
export async function resolveApiKeyIdentity(rawKey: string | undefined): Promise<ApiKeyResolution> {
  if (!rawKey) return { ok: false, failure: { kind: "missing" } };
  if (!isWellFormedApiKey(rawKey)) return { ok: false, failure: { kind: "malformed" } };

  // Hash the provided key (HMAC-with-pepper when configured) to match storage.
  const keyHash = await hashApiKey(rawKey);

  const { data: keyRecord, error: lookupError } = await supabaseAdmin
    .from("api_keys")
    .select("id, user_id, expires_at, scopes, monthly_quota, rate_tier")
    .eq("key_hash", keyHash)
    .single();

  if (lookupError || !keyRecord) return { ok: false, failure: { kind: "unknown" } };

  if (keyRecord.expires_at) {
    const expiresAt = new Date(keyRecord.expires_at);
    if (expiresAt <= new Date()) return { ok: false, failure: { kind: "expired" } };
  }

  // Update last_used_at (fire-and-forget, don't block the request)
  supabaseAdmin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRecord.id)
    .then(({ error }) => {
      if (error) {
        console.error("Failed to update last_used_at for API key:", keyRecord.id, error);
      }
    });

  // Resolve the owner's effective plan for rate-limit tiering (US-800). Mirrors
  // plan-gate's resolution so a paused/expired-trial/past-due owner is tiered at
  // their real (downgraded) plan rather than the plan they once paid for. A
  // failed lookup falls back to "free" (the tightest tier) rather than blocking
  // the request — rate limiting is best-effort, not an entitlement gate.
  let apiKeyPlan = "free";
  const { data: owner } = await supabaseAdmin
    .from("users")
    .select("role, flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .eq("id", keyRecord.user_id)
    .single();
  if (owner) {
    apiKeyPlan = owner.role === "super_admin" ? "super_admin" : effectivePlanFor(
      owner.flipdesk_plan,
      owner.subscription_status,
      owner.trial_ends_at,
      new Date(),
      owner.past_due_since,
    );
  }

  // US-1791: a per-key rate_tier (e.g. 'enterprise') overrides the plan-derived
  // per-minute tier. Falls through to the plan tier when unset.
  const keyTier = (keyRecord as { rate_tier?: string | null }).rate_tier;
  if (keyTier) apiKeyPlan = keyTier;

  // US-1791: monthly usage quota. When the key carries a monthly_quota, count its
  // api_usage_events for the current UTC month and 429 once exhausted. NULL quota
  // = unlimited (the historical behavior for every existing key).
  const monthlyQuota = (keyRecord as { monthly_quota?: number | null }).monthly_quota ?? null;
  if (monthlyQuota != null) {
    const now = new Date();
    const { count } = await supabaseAdmin
      .from("api_usage_events")
      .select("id", { count: "exact", head: true })
      .eq("api_key_id", keyRecord.id)
      .gte("created_at", billingMonthStartIso(now));
    const state = computeQuotaState(monthlyQuota, count ?? 0, now);
    if (state.exceeded) {
      // US-1792: over the monthly quota — draw down a prepaid, never-expiring API
      // overage credit (atomic) instead of 429ing. debit_api_credits returns the
      // new balance (>=0) on success, or -1 when the wallet can't cover it.
      const { data: newBalance, error: debitErr } = await supabaseAdmin.rpc("debit_api_credits", {
        p_user_id: keyRecord.user_id,
        p_credits: 1,
        p_notes: `overage: key ${keyRecord.id}`,
      });
      const covered = !debitErr && typeof newBalance === "number" && newBalance >= 0;
      if (!covered) {
        return {
          ok: false,
          failure: { kind: "quota_exceeded", quota: monthlyQuota, resetsAt: state.resets_at },
        };
      }
    }
  }

  return {
    ok: true,
    identity: {
      userId: keyRecord.user_id,
      apiKeyId: keyRecord.id,
      apiKeyPlan,
      // A row predating the scopes column reads back null → fall back to the
      // full set (US-356), so adding scopes never breaks an existing key.
      scopes: ((keyRecord as { scopes?: ApiKeyScope[] }).scopes) ?? [...DEFAULT_API_KEY_SCOPES],
    },
  };
}

/** Put a resolved identity on the request context. */
export function applyApiKeyIdentity(
  c: {
    set: (key: string, value: unknown) => void;
  },
  identity: ApiKeyIdentity,
): void {
  c.set("user", { id: identity.userId });
  c.set("userId", identity.userId);
  c.set("apiKeyId", identity.apiKeyId);
  c.set("apiKeyPlan", identity.apiKeyPlan);
  c.set("apiKeyScopes", identity.scopes);
}

/**
 * Middleware that validates API keys from the X-API-Key header, or from
 * `Authorization: Bearer` since US-9104.
 * Hashes the provided key with SHA-256 and matches against stored key_hash.
 * Checks expiration, updates last_used_at, and sets user context.
 *
 * The response bodies here are deliberately unchanged: /api/v1's 401 is a bare
 * `{ error: string }` and its 429 carries `code: "quota_exceeded"`, both of
 * which predate the envelope and are documented in the public OpenAPI spec.
 * /mcp needs different shapes and gets them from middleware/mcp-auth.ts.
 */
export const apiKeyAuthMiddleware = createMiddleware<ApiKeyAuthEnv>(async (c, next) => {
  const resolution = await resolveApiKeyIdentity(extractApiKey((name) => c.req.header(name)));

  if (!resolution.ok) {
    switch (resolution.failure.kind) {
      case "missing":
        return c.json({ error: "Missing X-API-Key header" }, 401);
      case "malformed":
        return c.json({ error: "Invalid API key format" }, 401);
      case "unknown":
        return c.json({ error: "Invalid API key" }, 401);
      case "expired":
        return c.json({ error: "API key has expired" }, 401);
      case "quota_exceeded":
        return c.json(
          {
            error:
              `Monthly API quota of ${resolution.failure.quota} calls reached. Buy an overage pack or wait — resets ${resolution.failure.resetsAt}.`,
            code: "quota_exceeded",
            resets_at: resolution.failure.resetsAt,
          },
          429,
        );
    }
  }

  applyApiKeyIdentity(c, resolution.identity);
  await next();
});
