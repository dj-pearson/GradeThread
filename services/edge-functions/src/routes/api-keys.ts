import { type Context, Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  deliveryLimit,
  getWebhookConfig,
  listWebhookDeliveries,
  rotateWebhookSecret,
  sendTestWebhook,
  setWebhookUrl,
} from "../lib/account-webhook.ts";
import { assertPublicUrl, SsrfError } from "../lib/ssrf.ts";
import { redactError } from "../lib/log-redact.ts";
import { generateApiKey, normalizeScopes } from "../lib/api-key.ts";
import { featureAllowedForUser, requireFlipdesk } from "../lib/plan-gate.ts";
import { effectivePlanFor } from "../lib/grade-pricing.ts";
import { API_RATE_TIERS } from "../middleware/api-v1-rate.ts";

type ApiKeysEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

export const apiKeyRoutes = new Hono<ApiKeysEnv>();

// Key generation + hashing live in lib/api-key.ts so the issuer and the
// verifying middleware share one implementation (US-356).

// List user's API keys
apiKeyRoutes.get("/", async (c) => {
  // API keys are workspace-scoped; only admin+ in this workspace can manage them.
  const role = c.get("workspaceRole") ?? "owner";
  if (role !== "owner" && role !== "admin") {
    return c.json(
      { error: "Only the workspace owner and admins can manage API keys" },
      403,
    );
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const { data: keys, error } = await supabaseAdmin
    .from("api_keys")
    .select("id, name, key_prefix, scopes, last_used_at, last_rotated_at, expires_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to list API keys:", error);
    return c.json({ error: "Failed to list API keys" }, 500);
  }

  return c.json({ data: keys });
});

// US-596: usage/billing dashboard data — call volume from the api_usage_events
// ledger plus the owner's current rate-limit tier + quota. Admin/owner only,
// scoped to the workspace owner's usage.
apiKeyRoutes.get("/usage", async (c) => {
  const role = c.get("workspaceRole") ?? "owner";
  if (role !== "owner" && role !== "admin") {
    return c.json(
      { error: "Only the workspace owner and admins can view API usage" },
      403,
    );
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const daysParam = parseInt(c.req.query("days") ?? "30", 10);
  const days = Number.isFinite(daysParam) ? Math.min(365, Math.max(1, daysParam)) : 30;

  // Resolve the owner's effective plan (mirrors api-key-auth's resolution) so
  // the dashboard shows the SAME rate tier the live API enforces.
  let plan = "free";
  const { data: owner } = await supabaseAdmin
    .from("users")
    .select("role, flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .eq("id", userId)
    .single();
  if (owner) {
    plan = owner.role === "super_admin"
      ? "super_admin"
      : effectivePlanFor(
        owner.flipdesk_plan,
        owner.subscription_status,
        owner.trial_ends_at,
        new Date(),
        owner.past_due_since,
      );
  }
  const tier = API_RATE_TIERS[plan] ?? API_RATE_TIERS.free;

  const { data: summary, error } = await supabaseAdmin.rpc("api_usage_summary", {
    p_user_id: userId,
    p_days: days,
  });
  if (error) {
    console.error("Failed to load API usage summary:", error);
    return c.json({ error: "Failed to load API usage" }, 500);
  }

  // The page gates on the OWNER's plan, never the viewer's own. Answering it
  // here means an admin of a Business workspace is not shown an upsell, and a
  // Business user acting in a Free workspace is not shown a key table the
  // create route will refuse.
  const apiAccess = await featureAllowedForUser(userId, "apiAccess");

  // Overage credits are only spent by a key carrying a monthly_quota, and
  // nothing sets one yet (US-1792 follow-up). The card hides itself until one
  // exists, so a seller is never offered a balance nothing can draw down.
  const { count: quotaKeys } = await supabaseAdmin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .not("monthly_quota", "is", null);
  const { data: wallet } = await supabaseAdmin
    .from("api_credit_wallet")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();

  return c.json({
    data: {
      summary,
      plan,
      api_access: apiAccess,
      overage: {
        quota_enabled: (quotaKeys ?? 0) > 0,
        balance: Number((wallet as { balance?: number } | null)?.balance ?? 0),
      },
      rate_limits: {
        read_per_minute: tier.read,
        write_per_minute: tier.write,
        window_seconds: 60,
      },
    },
  });
});

// US-596: white-label branding for the embeddable grade widget. GET returns the
// owner's stored config; PUT validates + persists it. Admin/owner only.
interface PartnerBranding {
  company_name?: string;
  brand_color?: string;
  logo_url?: string;
  support_url?: string;
}

function sanitizeBranding(input: unknown): PartnerBranding | { error: string } {
  if (input === null || typeof input !== "object") {
    return { error: "branding must be an object" };
  }
  const b = input as Record<string, unknown>;
  const out: PartnerBranding = {};

  if (b.company_name !== undefined && b.company_name !== null && b.company_name !== "") {
    if (typeof b.company_name !== "string" || b.company_name.length > 80) {
      return { error: "company_name must be a string of 80 characters or fewer" };
    }
    out.company_name = b.company_name.trim();
  }
  if (b.brand_color !== undefined && b.brand_color !== null && b.brand_color !== "") {
    if (typeof b.brand_color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.brand_color)) {
      return { error: "brand_color must be a hex color like #0F3460" };
    }
    out.brand_color = b.brand_color;
  }
  for (const field of ["logo_url", "support_url"] as const) {
    const v = b[field];
    if (v !== undefined && v !== null && v !== "") {
      if (typeof v !== "string" || v.length > 500) {
        return { error: `${field} must be a string of 500 characters or fewer` };
      }
      let parsed: URL;
      try {
        parsed = new URL(v);
      } catch {
        return { error: `${field} must be a valid URL` };
      }
      if (parsed.protocol !== "https:") {
        return { error: `${field} must be an https URL` };
      }
      out[field] = v;
    }
  }
  return out;
}

apiKeyRoutes.get("/branding", async (c) => {
  const role = c.get("workspaceRole") ?? "owner";
  if (role !== "owner" && role !== "admin") {
    return c.json({ error: "Only the workspace owner and admins can manage branding" }, 403);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("partner_branding")
    .eq("id", userId)
    .single();
  if (error) {
    console.error("Failed to load partner branding:", error);
    return c.json({ error: "Failed to load branding" }, 500);
  }
  return c.json({ data: (data?.partner_branding as PartnerBranding) ?? {} });
});

apiKeyRoutes.put("/branding", async (c) => {
  const role = c.get("workspaceRole") ?? "owner";
  if (role !== "owner" && role !== "admin") {
    return c.json({ error: "Only the workspace owner and admins can manage branding" }, 403);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // White-label is a Business-plan feature, gated by the same flag as API access.
  const gate = await requireFlipdesk(c, { feature: "apiAccess", userId });
  if (gate) return gate;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const branding = sanitizeBranding(body);
  if ("error" in branding) {
    return c.json({ error: branding.error }, 400);
  }

  const { error } = await supabaseAdmin
    .from("users")
    .update({ partner_branding: branding })
    .eq("id", userId);
  if (error) {
    console.error("Failed to save partner branding:", error);
    return c.json({ error: "Failed to save branding" }, 500);
  }
  return c.json({ data: branding });
});

// ── Account webhook, from the dashboard (extensions-api plan, action 5) ──
//
// The same one-endpoint-per-account webhook /api/v1/webhook manages with an API
// key, here with the session, so a customer can set the URL, send a signed test
// event and read the delivery log without writing code. Owner/admin only, like
// every other route in this file, and always the workspace OWNER's endpoint.
// The logic is lib/account-webhook.ts, shared with the public API.

function webhookManager(c: Context<ApiKeysEnv>): { ownerId: string } | Response {
  const role = c.get("workspaceRole") ?? "owner";
  if (role !== "owner" && role !== "admin") {
    return c.json({ error: "Only the workspace owner and admins can manage the webhook" }, 403);
  }
  return { ownerId: c.get("workspaceOwnerId") ?? c.get("userId") };
}

apiKeyRoutes.get("/webhook", async (c) => {
  const who = webhookManager(c);
  if (who instanceof Response) return who;
  try {
    return c.json({ data: await getWebhookConfig(who.ownerId) });
  } catch (err) {
    console.error("Failed to read webhook:", redactError(err));
    return c.json({ error: "Failed to load webhook" }, 500);
  }
});

// Body { url: string | null }. null clears it. The response carries
// signing_secret only when this call created the endpoint.
apiKeyRoutes.put("/webhook", async (c) => {
  const who = webhookManager(c);
  if (who instanceof Response) return who;
  const gate = await requireFlipdesk(c, { feature: "apiAccess", userId: who.ownerId });
  if (gate) return gate;

  let body: { url?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const raw = body.url;
  let url: string | null;
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    url = null;
  } else if (typeof raw !== "string" || raw.length > 2000) {
    return c.json({ error: "url must be a string of 2000 characters or fewer, or null" }, 400);
  } else {
    url = raw.trim();
    // US-345: same set-time SSRF check as PATCH /api/v1/webhook.
    try {
      await assertPublicUrl(url);
    } catch (err) {
      return c.json({
        error: err instanceof SsrfError ? `URL rejected: ${err.message}` : "That is not a valid URL",
      }, 400);
    }
  }

  try {
    const { signing_secret } = await setWebhookUrl(who.ownerId, url);
    return c.json({ data: { ...(await getWebhookConfig(who.ownerId)), signing_secret } });
  } catch (err) {
    console.error("Failed to save webhook:", redactError(err));
    return c.json({ error: "Failed to save webhook" }, 500);
  }
});

apiKeyRoutes.post("/webhook/secret/rotate", async (c) => {
  const who = webhookManager(c);
  if (who instanceof Response) return who;
  const gate = await requireFlipdesk(c, { feature: "apiAccess", userId: who.ownerId });
  if (gate) return gate;
  try {
    const rotated = await rotateWebhookSecret(who.ownerId);
    if (!rotated) return c.json({ error: "No webhook is set" }, 404);
    return c.json({ data: rotated });
  } catch (err) {
    console.error("Failed to rotate webhook secret:", redactError(err));
    return c.json({ error: "Failed to rotate webhook secret" }, 500);
  }
});

// Sends one signed webhook.test event now and answers with how it went. It is
// logged as a delivery, with a single attempt so a dead endpoint is not retried.
apiKeyRoutes.post("/webhook/test", async (c) => {
  const who = webhookManager(c);
  if (who instanceof Response) return who;
  const gate = await requireFlipdesk(c, { feature: "apiAccess", userId: who.ownerId });
  if (gate) return gate;
  try {
    const result = await sendTestWebhook(who.ownerId);
    if (!result) return c.json({ error: "No webhook is set" }, 404);
    return c.json({ data: result });
  } catch (err) {
    console.error("Failed to send test webhook:", redactError(err));
    return c.json({ error: "Failed to send test event" }, 500);
  }
});

apiKeyRoutes.get("/webhook/deliveries", async (c) => {
  const who = webhookManager(c);
  if (who instanceof Response) return who;
  try {
    return c.json({ data: await listWebhookDeliveries(who.ownerId, deliveryLimit(c.req.query("limit"))) });
  } catch (err) {
    console.error("Failed to list webhook deliveries:", redactError(err));
    return c.json({ error: "Failed to load deliveries" }, 500);
  }
});

// Create a new API key
apiKeyRoutes.post("/", async (c) => {
  // API keys are workspace-scoped; only admin+ in this workspace can manage them.
  const role = c.get("workspaceRole") ?? "owner";
  if (role !== "owner" && role !== "admin") {
    return c.json(
      { error: "Only the workspace owner and admins can manage API keys" },
      403,
    );
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { name?: string; expires_at?: string; scopes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { name, expires_at } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "name is required" }, 400);
  }

  if (name.trim().length > 100) {
    return c.json({ error: "name must be 100 characters or fewer" }, 400);
  }

  // US-356: validate requested scopes (defaults to the full set when omitted).
  const scopes = normalizeScopes(body.scopes);
  if (scopes === null) {
    return c.json(
      { error: "scopes must be a non-empty array of: read, submit, webhook_manage" },
      400,
    );
  }

  // US-382: API access is a gated feature. Enforce via the single source of
  // truth (requireFlipdesk → users.flipdesk_plan), replacing the stale legacy
  // users.plan check (the legacy 'professional'/'enterprise' values no longer
  // track the live FlipDesk plan, so paid resellers were being mis-gated). A
  // caller without the apiAccess feature gets 402 FEATURE_LOCKED.
  const apiGate = await requireFlipdesk(c, { feature: "apiAccess", userId });
  if (apiGate) return apiGate;

  // Limit number of API keys per user (max 10)
  const { count, error: countError } = await supabaseAdmin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  if (countError) {
    console.error("Failed to count API keys:", countError);
    return c.json({ error: "Failed to create API key" }, 500);
  }

  if ((count ?? 0) >= 10) {
    return c.json({ error: "Maximum of 10 API keys allowed. Please revoke an existing key first." }, 400);
  }

  // Validate expiration date if provided
  let expiresAt: string | null = null;
  if (expires_at) {
    const expirationDate = new Date(expires_at);
    if (isNaN(expirationDate.getTime())) {
      return c.json({ error: "Invalid expiration date" }, 400);
    }
    if (expirationDate <= new Date()) {
      return c.json({ error: "Expiration date must be in the future" }, 400);
    }
    expiresAt = expirationDate.toISOString();
  }

  // Generate the API key
  const { fullKey, keyHash, keyPrefix } = await generateApiKey();

  // Store the hashed key
  const { data: newKey, error: insertError } = await supabaseAdmin
    .from("api_keys")
    .insert({
      user_id: userId,
      name: name.trim(),
      key_hash: keyHash,
      key_prefix: keyPrefix,
      scopes,
      expires_at: expiresAt,
    })
    .select("id, name, key_prefix, scopes, expires_at, created_at")
    .single();

  if (insertError) {
    console.error("Failed to create API key:", insertError);
    return c.json({ error: "Failed to create API key" }, 500);
  }

  // Return full key ONCE — it cannot be retrieved again
  return c.json({
    data: {
      ...newKey,
      full_key: fullKey,
    },
  }, 201);
});

// Rotate an API key (US-356): issue a new secret for the SAME row, keeping its
// name/scopes/expiry, and invalidate the old secret immediately. The new
// plaintext is returned once. Use this instead of delete+create so the key's
// identity/scopes are preserved across the rotation.
apiKeyRoutes.post("/:id/rotate", async (c) => {
  const role = c.get("workspaceRole") ?? "owner";
  if (role !== "owner" && role !== "admin") {
    return c.json(
      { error: "Only the workspace owner and admins can manage API keys" },
      403,
    );
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const keyId = c.req.param("id");

  if (!keyId) {
    return c.json({ error: "Key ID is required" }, 400);
  }

  // Confirm ownership before mutating (US-268: never mutate by id alone).
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("api_keys")
    .select("id")
    .eq("id", keyId)
    .eq("user_id", userId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "API key not found" }, 404);
  }

  const { fullKey, keyHash, keyPrefix } = await generateApiKey();

  const { data: rotated, error: updateError } = await supabaseAdmin
    .from("api_keys")
    .update({
      key_hash: keyHash,
      key_prefix: keyPrefix,
      last_rotated_at: new Date().toISOString(),
      last_used_at: null,
    })
    .eq("id", keyId)
    .eq("user_id", userId)
    .select("id, name, key_prefix, scopes, expires_at, created_at, last_rotated_at")
    .single();

  if (updateError || !rotated) {
    console.error("Failed to rotate API key:", updateError);
    return c.json({ error: "Failed to rotate API key" }, 500);
  }

  return c.json({
    data: {
      ...rotated,
      full_key: fullKey,
    },
  });
});

// Delete/revoke an API key
apiKeyRoutes.delete("/:id", async (c) => {
  // API keys are workspace-scoped; only admin+ in this workspace can manage them.
  const role = c.get("workspaceRole") ?? "owner";
  if (role !== "owner" && role !== "admin") {
    return c.json(
      { error: "Only the workspace owner and admins can manage API keys" },
      403,
    );
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const keyId = c.req.param("id");

  if (!keyId) {
    return c.json({ error: "Key ID is required" }, 400);
  }

  // Verify the key belongs to the user
  const { data: key, error: fetchError } = await supabaseAdmin
    .from("api_keys")
    .select("id, user_id")
    .eq("id", keyId)
    .eq("user_id", userId)
    .single();

  if (fetchError || !key) {
    return c.json({ error: "API key not found" }, 404);
  }

  const { error: deleteError } = await supabaseAdmin
    .from("api_keys")
    .delete()
    .eq("id", keyId)
    .eq("user_id", userId);

  if (deleteError) {
    console.error("Failed to delete API key:", deleteError);
    return c.json({ error: "Failed to revoke API key" }, 500);
  }

  return c.json({ message: "API key revoked successfully" });
});
