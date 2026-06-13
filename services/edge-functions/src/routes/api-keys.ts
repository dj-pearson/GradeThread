import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { generateApiKey, normalizeScopes } from "../lib/api-key.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
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

  return c.json({
    data: {
      summary,
      plan,
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
