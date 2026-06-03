import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  type ApiKeyScope,
  DEFAULT_API_KEY_SCOPES,
  hashApiKey,
  isWellFormedApiKey,
} from "../lib/api-key.ts";

type ApiKeyAuthEnv = {
  Variables: {
    user: { id: string; email?: string; [key: string]: unknown };
    userId: string;
    apiKeyScopes: ApiKeyScope[];
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
    .select("id, user_id, expires_at, scopes")
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

  // Set user context from the key's user_id + the key's scopes (US-356). A row
  // predating the scopes column reads back null → fall back to the full set.
  c.set("user", { id: keyRecord.user_id });
  c.set("userId", keyRecord.user_id);
  c.set(
    "apiKeyScopes",
    ((keyRecord as { scopes?: ApiKeyScope[] }).scopes) ?? [...DEFAULT_API_KEY_SCOPES],
  );

  await next();
});
