// Etsy Open API v3 connector for FlipDesk (US-1659) — OAuth 2.0 Authorization
//
// ↳ SHARED CONTRACT: vault/30-platform/marketplace-connector-contract.md —
//   this file documents only Etsy's deltas (the x-api-key requirement).
// Code + PKCE, encrypted token storage, and proactive token refresh. This module
// owns the CONNECTION lifecycle only (connect → store → refresh → disconnect);
// the publish/order-sync write path is US-1660 (the adapter's listing methods
// return a typed 503 until then).
//
// GATING (US-1659): the ENTIRE connector is gated behind ETSY_ENABLED. Etsy
// requires each app to be approved for the "commercial" (write) scopes before it
// may create listings on other sellers' shops, so isEtsyEnabled() is FALSE unless
// an operator both sets ETSY_ENABLED=true AND provides the app keystring. Every
// Etsy edge endpoint 503s while it's off, so there is no fake connect flow before
// approval lands.
//
// PKCE (RFC 7636): Etsy's OAuth is PKCE-only — the app keystring is the public
// client_id and there is NO client secret in the token exchange. /oauth/start
// generates a random code_verifier, stashes it on the single-use oauth_states row
// (migration 00175), and sends the S256 code_challenge to Etsy; the token
// exchange in /oauth/callback presents the verifier. An intercepted code is
// useless without the verifier.
//
// Tokens: Etsy issues a short-lived access token (expires_in 3600s) + a refresh
// token. We store BOTH encrypted in marketplace_connections (marketplace='etsy'),
// AES-GCM-bound to the owning user_id as AAD (US-352), identical to the eBay/Depop
// path. getEtsyAccessToken() refreshes inline when expiry is near, and the shared
// token-refresh cron sweeps connections nearing expiry.
//
// ⚠️ x-api-key: every Etsy DATA API call (etsy-api.ts) must send BOTH the OAuth
// Bearer token AND `x-api-key: <keystring>`. The token endpoint does NOT need
// x-api-key (client_id in the body identifies the app).
//
// Required env (Coolify Shared Variables), ALL only consulted when ETSY_ENABLED:
//   ETSY_ENABLED        "true" to turn the connector on (default off)
//   ETSY_KEYSTRING      the app's keystring (used as BOTH client_id AND x-api-key)
//   ETSY_REDIRECT_URI   https://functions.gradethread.com/api/flipdesk/etsy/oauth/callback
//   ETSY_AUTH_URL       optional; default https://www.etsy.com/oauth/connect
//   ETSY_TOKEN_URL      optional; default https://api.etsy.com/v3/public/oauth/token
//   ETSY_SCOPES         optional; default = the US-1659 read+write set
//   EDGE_ENCRYPTION_KEY (shared with the eBay/Shopify/Depop paths)

import { supabaseAdmin } from "./supabase.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";

const ETSY_TIMEOUT_MS = 20_000;

// US-1659: the scope set requested from Etsy. listings_r/w/d for the listing
// lifecycle, transactions_r for order sync (US-1660), shops_r for shop identity,
// email_r so the connect handshake resolves the seller. Matches the app's
// registered scopes — Etsy 400s if the consent scope exceeds what's registered.
const DEFAULT_SCOPES = [
  "listings_r",
  "listings_w",
  "listings_d",
  "transactions_r",
  "shops_r",
  "email_r",
].join(" ");

const DEFAULT_AUTH_URL = "https://www.etsy.com/oauth/connect";
const DEFAULT_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

// All env reads trim whitespace (copy-paste guard) and treat "" as unset —
// mirrors ebay-client/depop-client readEnv so a stray space can't break a host.
function readEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

// The master kill-switch: the connector is live ONLY when an operator explicitly
// flips ETSY_ENABLED on AND the keystring is present. Defaults OFF so no Etsy
// surface appears (or accepts a connect) before the app is approved.
export function isEtsyEnabled(): boolean {
  const flag = (readEnv("ETSY_ENABLED") ?? "").toLowerCase();
  const on = flag === "true" || flag === "1" || flag === "yes" || flag === "on";
  return on && !!readEnv("ETSY_KEYSTRING");
}

export function getEtsyScopes(): string {
  return readEnv("ETSY_SCOPES") ?? DEFAULT_SCOPES;
}

// The app keystring — used as the OAuth client_id AND the x-api-key data-API
// header. Exported so etsy-api.ts sends it on every call.
export function getEtsyKeystring(): string | undefined {
  return readEnv("ETSY_KEYSTRING");
}

// ── PKCE ──────────────────────────────────────────────────────────────
// RFC 7636. The verifier is a high-entropy random string; the challenge is its
// base64url-encoded SHA-256 (method S256). Both pure (Web Crypto only) + tested.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  // 32 random bytes → 43-char base64url string (within RFC 7636's 43–128 range).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

// ── OAuth ─────────────────────────────────────────────────────────────

export function buildConsentUrl(state: string, codeChallenge: string): string {
  const clientId = readEnv("ETSY_KEYSTRING");
  const redirectUri = readEnv("ETSY_REDIRECT_URI");
  if (!clientId || !redirectUri) {
    throw new Error("ETSY_KEYSTRING / ETSY_REDIRECT_URI are not set.");
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: getEtsyScopes(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authUrl = readEnv("ETSY_AUTH_URL") ?? DEFAULT_AUTH_URL;
  return `${authUrl}?${params.toString()}`;
}

export interface EtsyTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope?: string;
}

// Exchanges the authorization code for tokens, presenting the PKCE verifier.
// Etsy's token endpoint is a standard OAuth 2.0 form POST; client_id is the
// keystring and there is NO client secret (PKCE authenticates the client).
export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
): Promise<EtsyTokenResponse> {
  const clientId = readEnv("ETSY_KEYSTRING");
  const redirectUri = readEnv("ETSY_REDIRECT_URI");
  if (!clientId || !redirectUri) {
    throw new Error("ETSY_KEYSTRING / ETSY_REDIRECT_URI are not set.");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });
  const tokenUrl = readEnv("ETSY_TOKEN_URL") ?? DEFAULT_TOKEN_URL;
  const res = await fetchWithTimeout(
    tokenUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    },
    ETSY_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Etsy token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EtsyTokenResponse;
}

export interface EtsyRefreshResponse {
  access_token: string;
  // OAuth servers may rotate the refresh token on use; we persist a new one when
  // present and otherwise keep the existing one.
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export async function refreshEtsyToken(
  refreshToken: string,
): Promise<EtsyRefreshResponse> {
  const clientId = readEnv("ETSY_KEYSTRING");
  if (!clientId) {
    throw new Error("ETSY_KEYSTRING is not set.");
  }
  // PKCE apps refresh with client_id + refresh_token (no secret). Per OAuth 2.0,
  // omit `scope` on refresh so the new access token inherits the scopes the
  // refresh token already grants (sending a wider scope would 400 invalid_scope).
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  const tokenUrl = readEnv("ETSY_TOKEN_URL") ?? DEFAULT_TOKEN_URL;
  const res = await fetchWithTimeout(
    tokenUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    },
    ETSY_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Etsy token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EtsyRefreshResponse;
}

// US-463 pattern: classify a refresh failure as PERMANENT (refresh token
// revoked/expired/invalid — only re-consent fixes it) vs TRANSIENT (5xx / 429 /
// network blip — retry can succeed). Pure + unit-tested.
export function isPermanentEtsyAuthFailure(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    /\binvalid_grant\b|\binvalid_client\b|\bunauthorized_client\b|\binvalid_scope\b|token_revoked|\brevoked\b/
      .test(msg)
  ) {
    return true;
  }
  const status = Number(msg.match(/failed \((\d{3})\)/)?.[1] ?? 0);
  if (status >= 500 || status === 429) return false;
  if (status === 400 || status === 401 || status === 403) return true;
  // Network/timeout/unknown → transient (never deactivate on a blip).
  return false;
}

export const ETSY_RECONNECT_MESSAGE =
  "Etsy disconnected: your authorization was revoked or expired. Please reconnect your Etsy shop.";

// ── Connection storage ────────────────────────────────────────────────

export async function upsertEtsyConnection(args: {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  scope: string;
  accountHandle?: string | null;
  /** Stable Etsy shop id (US-1660) — the key inbound events resolve on. */
  externalAccountId?: string | null;
}): Promise<void> {
  // US-352: bind both ciphertexts to the owning user_id (AES-GCM AAD) so a token
  // blob can't be replayed onto another tenant's connection row.
  const access = await encryptToken(args.accessToken, { aad: args.userId });
  const refresh = await encryptToken(args.refreshToken, { aad: args.userId });
  const expiresAt = new Date(
    Date.now() + args.accessExpiresInSeconds * 1000,
  ).toISOString();
  const handle = args.accountHandle ?? null;

  // NULLs are distinct in unique indexes, so a null handle can't upsert by the
  // UNIQUE(user_id, marketplace, account_handle) constraint — find-or-insert,
  // matching the eBay/Depop path.
  const lookup = supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", args.userId)
    .eq("marketplace", "etsy");
  const { data: existing, error: lookupErr } = handle === null
    ? await lookup.is("account_handle", null).maybeSingle()
    : await lookup.eq("account_handle", handle).maybeSingle();
  if (lookupErr) {
    throw new Error(`Failed to look up Etsy connection: ${lookupErr.message}`);
  }

  const patch: Record<string, unknown> = {
    access_token_encrypted: access,
    refresh_token_encrypted: refresh,
    token_expires_at: expiresAt,
    scopes: args.scope ? args.scope.split(/[\s,]+/).filter(Boolean) : [],
    is_active: true,
    last_synced_at: null,
    refresh_error: null,
  };
  // Store the stable shop id when we resolved one (US-1660) so order sync can
  // match the seller. Never overwrite an existing id with null on a re-connect.
  if (args.externalAccountId) patch.external_account_id = args.externalAccountId;

  if (existing) {
    const { error } = await supabaseAdmin
      .from("marketplace_connections")
      .update(patch)
      .eq("id", (existing as { id: string }).id);
    if (error) {
      throw new Error(`Failed to update Etsy connection: ${error.message}`);
    }
    return;
  }
  const { error } = await supabaseAdmin
    .from("marketplace_connections")
    .insert({
      user_id: args.userId,
      marketplace: "etsy",
      account_handle: handle,
      ...patch,
    });
  if (error) {
    throw new Error(`Failed to insert Etsy connection: ${error.message}`);
  }
}

export interface EtsyConnection {
  id: string;
  accountHandle: string | null;
  /** Stable Etsy shop id captured at connect (external_account_id). */
  shopId: string | null;
  token: string;
}

// Returns a valid Etsy access token, refreshing if it expires within 60s.
// Throws if the user has no active Etsy connection or refresh fails permanently.
// Tenant-scoped: caller passes the workspace owner id (connections live on the
// owner, like eBay/Depop).
export async function getEtsyAccessToken(userId: string): Promise<string> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select(
      "id, access_token_encrypted, refresh_token_encrypted, token_expires_at, account_handle",
    )
    .eq("user_id", userId)
    .eq("marketplace", "etsy")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Etsy connection: ${error.message}`);
  }
  if (!row) {
    throw new Error("No active Etsy connection for this user.");
  }
  const r = row as {
    id: string;
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
    token_expires_at: string | null;
  };
  if (!r.access_token_encrypted) {
    throw new Error("No active Etsy connection for this user.");
  }

  const expiresAt = r.token_expires_at
    ? new Date(r.token_expires_at).getTime()
    : 0;
  const refreshNeeded = !expiresAt || expiresAt - Date.now() < 60_000;
  if (!refreshNeeded) {
    return await decryptToken(r.access_token_encrypted, { aad: userId });
  }
  if (!r.refresh_token_encrypted) {
    throw new Error("Etsy access token expired and no refresh token is stored.");
  }

  const refreshToken = await decryptToken(r.refresh_token_encrypted, {
    aad: userId,
  });
  try {
    const fresh = await refreshEtsyToken(refreshToken);
    const encryptedAccess = await encryptToken(fresh.access_token, {
      aad: userId,
    });
    const expiresAtNew = new Date(
      Date.now() + fresh.expires_in * 1000,
    ).toISOString();
    const patch: Record<string, unknown> = {
      access_token_encrypted: encryptedAccess,
      token_expires_at: expiresAtNew,
      last_refresh_attempt_at: new Date().toISOString(),
      refresh_error: null,
    };
    // Persist a rotated refresh token when Etsy returns one.
    if (fresh.refresh_token) {
      patch.refresh_token_encrypted = await encryptToken(fresh.refresh_token, {
        aad: userId,
      });
    }
    await supabaseAdmin
      .from("marketplace_connections")
      .update(patch)
      .eq("id", r.id);
    return fresh.access_token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permanent = isPermanentEtsyAuthFailure(err);
    // PERMANENT (revoked/expired refresh token) → deactivate + store a reconnect
    // message so the UI prompts re-auth and the cron stops hammering a dead grant.
    // TRANSIENT (5xx/429/network) → leave is_active=true so a later retry works.
    await supabaseAdmin
      .from("marketplace_connections")
      .update({
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_error: permanent ? ETSY_RECONNECT_MESSAGE : msg.slice(0, 500),
        ...(permanent ? { is_active: false } : {}),
      })
      .eq("id", r.id);
    if (permanent) {
      console.warn(`[etsy-client] permanent auth failure for user ${userId}; deactivated`);
    }
    throw err;
  }
}

// Returns the owner's active Etsy connection (decrypted access token, refreshed
// if near-expiry) or null when none is connected / refresh failed. Used by the
// US-1660 publish + sync paths. Tenant-scoped.
export async function getEtsyConnection(
  userId: string,
): Promise<EtsyConnection | null> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, account_handle, external_account_id")
    .eq("user_id", userId)
    .eq("marketplace", "etsy")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load Etsy connection: ${error.message}`);
  }
  if (!row) return null;
  const r = row as {
    id: string;
    account_handle: string | null;
    external_account_id: string | null;
  };
  let token: string;
  try {
    token = await getEtsyAccessToken(userId);
  } catch {
    return null;
  }
  return {
    id: r.id,
    accountHandle: r.account_handle,
    shopId: r.external_account_id,
    token,
  };
}

// Sweeps every active Etsy connection whose token expires within the horizon and
// refreshes it inline (getEtsyAccessToken renews near-expiry). Called by the
// shared token-refresh cron alongside eBay/Depop. No-op (and never scans) while
// the connector is disabled. Returns a batch summary.
export async function refreshExpiringEtsyConnections(
  horizonMs = 24 * 60 * 60_000,
): Promise<{ scanned: number; refreshed: number; failed: number }> {
  if (!isEtsyEnabled()) return { scanned: 0, refreshed: 0, failed: 0 };

  const horizon = new Date(Date.now() + horizonMs).toISOString();
  const { data: expiring, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "etsy")
    .eq("is_active", true)
    .lt("token_expires_at", horizon);
  if (error) {
    console.error("[etsy-client] refresh scan failed:", error);
    return { scanned: 0, refreshed: 0, failed: 0 };
  }

  const userIds = Array.from(
    new Set(((expiring ?? []) as { user_id: string }[]).map((r) => r.user_id)),
  );
  let refreshed = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await getEtsyAccessToken(userId);
      refreshed += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[etsy-client] refresh failed for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { scanned: userIds.length, refreshed, failed };
}
