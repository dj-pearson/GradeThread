import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

type ApiKeysEnv = {
  Variables: {
    userId: string;
  };
};

export const apiKeyRoutes = new Hono<ApiKeysEnv>();

// Generate a cryptographically random API key
async function generateApiKey(): Promise<{ fullKey: string; keyHash: string; keyPrefix: string }> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const fullKey = "gt_sk_" + Array.from(randomBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const keyPrefix = fullKey.slice(0, 14); // "gt_sk_" + 8 hex chars

  // Hash the full key with SHA-256 for storage
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(fullKey));
  const keyHash = Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");

  return { fullKey, keyHash, keyPrefix };
}

// List user's API keys
apiKeyRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  const { data: keys, error } = await supabaseAdmin
    .from("api_keys")
    .select("id, name, key_prefix, last_used_at, expires_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to list API keys:", error);
    return c.json({ error: "Failed to list API keys" }, 500);
  }

  return c.json({ data: keys });
});

// Create a new API key
apiKeyRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  let body: { name?: string; expires_at?: string };
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

  // Check user's plan — only Professional and Enterprise can create API keys
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select("id, plan")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    return c.json({ error: "User not found" }, 404);
  }

  if (user.plan !== "professional" && user.plan !== "enterprise") {
    return c.json({ error: "API keys require a Professional or Enterprise plan" }, 403);
  }

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
      expires_at: expiresAt,
    })
    .select("id, name, key_prefix, expires_at, created_at")
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

// Delete/revoke an API key
apiKeyRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
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
