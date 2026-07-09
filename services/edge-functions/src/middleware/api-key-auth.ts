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
 * Middleware that validates API keys from the X-API-Key header.
 * Hashes the provided key with SHA-256 and matches against stored key_hash.
 * Checks expiration, updates last_used_at, and sets user context.
 */
export const apiKeyAuthMiddleware = createMiddleware<ApiKeyAuthEnv>(async (c, next) => {
  const apiKey = c.req.header("X-API-Key");

  if (!apiKey) {
    return c.json({ error: "Missing X-API-Key header" }, 401);
  }

  // Validate key format (gt_sk_ prefix + 64 hex chars)
  if (!isWellFormedApiKey(apiKey)) {
    return c.json({ error: "Invalid API key format" }, 401);
  }

  // Hash the provided key (HMAC-with-pepper when configured) to match storage.
  const keyHash = await hashApiKey(apiKey);

  // Look up the key by hash
  const { data: keyRecord, error: lookupError } = await supabaseAdmin
    .from("api_keys")
    .select("id, user_id, expires_at, scopes, monthly_quota, rate_tier")
    .eq("key_hash", keyHash)
    .single();

  if (lookupError || !keyRecord) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Check if key is expired
  if (keyRecord.expires_at) {
    const expiresAt = new Date(keyRecord.expires_at);
    if (expiresAt <= new Date()) {
      return c.json({ error: "API key has expired" }, 401);
    }
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
      return c.json(
        {
          error: `Monthly API quota of ${monthlyQuota} calls reached. Resets ${state.resets_at}.`,
          code: "quota_exceeded",
          resets_at: state.resets_at,
        },
        429,
      );
    }
  }

  // Set user context from the key's user_id + the key's scopes (US-356). A row
  // predating the scopes column reads back null → fall back to the full set.
  c.set("user", { id: keyRecord.user_id });
  c.set("userId", keyRecord.user_id);
  c.set("apiKeyId", keyRecord.id);
  c.set("apiKeyPlan", apiKeyPlan);
  c.set(
    "apiKeyScopes",
    ((keyRecord as { scopes?: ApiKeyScope[] }).scopes) ?? [...DEFAULT_API_KEY_SCOPES],
  );

  await next();
});
