// Depop Selling API connector for FlipDesk (US-713) — OAuth 2.0 Authorization
//
// ↳ SHARED CONTRACT: vault/30-platform/marketplace-connector-contract.md —
//   the kill-switch / PKCE / token-encryption / refresh shape all connectors use.
// Code + PKCE, encrypted token storage, and proactive token refresh. This module
// owns the CONNECTION lifecycle only (connect → store → refresh → disconnect);
// the publish/order-sync write path is US-714 (the adapter's listing methods
// still return 501 until then).
//
// GATING (US-713 AC#3): the ENTIRE connector is gated behind DEPOP_ENABLED.
// Depop's partner API is private and access is pending the US-712 application,
// so isDepopEnabled() is FALSE unless an operator both sets DEPOP_ENABLED=true
// AND provides the OAuth creds. Every Depop edge endpoint 503s while it's off,
// so there is no fake connect flow before partner access is live.
//
// PKCE (US-713 AC#1): unlike eBay/Shopify, Depop requires PKCE. /oauth/start
// generates a random code_verifier, stashes it on the single-use oauth_states
// row (migration 00175), and sends the S256 code_challenge to Depop; the token
// exchange in /oauth/callback presents the verifier. No client secret is exposed
// to the browser, and an intercepted code is useless without the verifier.
//
// Tokens: Depop issues a short-lived access token + a refresh token (OAuth 2.0).
// We store BOTH encrypted in marketplace_connections (marketplace='depop'),
// AES-GCM-bound to the owning user_id as AAD (US-352), identical to the eBay
// path. getDepopAccessToken() refreshes inline when expiry is near, and the
// shared token-refresh cron (alongside eBay, US-120 pattern) sweeps connections
// nearing expiry.
//
// Required env (Coolify Shared Variables), ALL only consulted when DEPOP_ENABLED:
//   DEPOP_ENABLED          "true" to turn the connector on (default off)
//   DEPOP_CLIENT_ID        the partner app's client id
//   DEPOP_CLIENT_SECRET    the partner app's client secret
//   DEPOP_REDIRECT_URI     https://functions.gradethread.com/api/flipdesk/depop/oauth/callback
//   DEPOP_AUTH_URL         optional; default https://partnerapi.depop.com/oauth/authorize
//   DEPOP_TOKEN_URL        optional; default https://partnerapi.depop.com/oauth/token
//   DEPOP_SCOPES           optional; default = the US-713 read+write set
//   EDGE_ENCRYPTION_KEY    (shared with the eBay/Shopify paths)

import { supabaseAdmin } from "./supabase.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";

const DEPOP_TIMEOUT_MS = 20_000;

// US-713 AC#1: the full multi-seller scope set requested from Depop (matches the
// US-712 partner application and vault/30-platform/cross-listing.md §2).
const DEFAULT_SCOPES = [
  "products_read",
  "products_write",
  "orders_read",
  "orders_write",
  "offers_read",
  "offers_write",
  "shop_read",
].join(" ");

const DEFAULT_AUTH_URL = "https://partnerapi.depop.com/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://partnerapi.depop.com/oauth/token";

// All env reads trim whitespace (copy-paste guard) and treat "" as unset —
// mirrors ebay-client/shopify-client readEnv so a stray space can't break a host.
function readEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

// The master kill-switch: the connector is live ONLY when an operator explicitly
// flips DEPOP_ENABLED on AND the OAuth creds are present. Defaults OFF so no
// Depop surface appears (or accepts a connect) before partner access is granted.
export function isDepopEnabled(): boolean {
  const flag = (readEnv("DEPOP_ENABLED") ?? "").toLowerCase();
  const on = flag === "true" || flag === "1" || flag === "yes" || flag === "on";
  return on && !!(readEnv("DEPOP_CLIENT_ID") && readEnv("DEPOP_CLIENT_SECRET"));
}

export function getDepopScopes(): string {
  return readEnv("DEPOP_SCOPES") ?? DEFAULT_SCOPES;
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
  const clientId = readEnv("DEPOP_CLIENT_ID");
  const redirectUri = readEnv("DEPOP_REDIRECT_URI");
  if (!clientId || !redirectUri) {
    throw new Error("DEPOP_CLIENT_ID / DEPOP_REDIRECT_URI are not set.");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: getDepopScopes(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authUrl = readEnv("DEPOP_AUTH_URL") ?? DEFAULT_AUTH_URL;
  return `${authUrl}?${params.toString()}`;
}

export interface DepopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope?: string;
}

// Exchanges the authorization code for tokens, presenting the PKCE verifier.
// Depop's token endpoint is a standard OAuth 2.0 form POST.
export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
): Promise<DepopTokenResponse> {
  const clientId = readEnv("DEPOP_CLIENT_ID");
  const clientSecret = readEnv("DEPOP_CLIENT_SECRET");
  const redirectUri = readEnv("DEPOP_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("DEPOP_CLIENT_ID / DEPOP_CLIENT_SECRET / DEPOP_REDIRECT_URI are not set.");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });
  const tokenUrl = readEnv("DEPOP_TOKEN_URL") ?? DEFAULT_TOKEN_URL;
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
    DEPOP_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Depop token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as DepopTokenResponse;
}

export interface DepopRefreshResponse {
  access_token: string;
  // OAuth servers may rotate the refresh token on use; we persist a new one when
  // present and otherwise keep the existing one.
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export async function refreshDepopToken(
  refreshToken: string,
): Promise<DepopRefreshResponse> {
  const clientId = readEnv("DEPOP_CLIENT_ID");
  const clientSecret = readEnv("DEPOP_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("DEPOP_CLIENT_ID / DEPOP_CLIENT_SECRET are not set.");
  }
  // Per OAuth 2.0, omit `scope` on refresh so the new access token inherits the
  // scopes the refresh token already grants (same rationale as eBay refresh —
  // sending a wider scope would 400 with invalid_scope).
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenUrl = readEnv("DEPOP_TOKEN_URL") ?? DEFAULT_TOKEN_URL;
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
    DEPOP_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Depop token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as DepopRefreshResponse;
}

// US-463 pattern: classify a refresh failure as PERMANENT (refresh token
// revoked/expired/invalid — only re-consent fixes it) vs TRANSIENT (5xx / 429 /
// network blip — retry can succeed). Pure + unit-tested.
export function isPermanentDepopAuthFailure(err: unknown): boolean {
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

export const DEPOP_RECONNECT_MESSAGE =
  "Depop disconnected: your authorization was revoked or expired. Please reconnect your Depop shop.";

// ── Connection storage ────────────────────────────────────────────────

export async function upsertDepopConnection(args: {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  scope: string;
  accountHandle?: string | null;
  /** Stable Depop shop id (US-714) — the key inbound webhooks resolve on. */
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
  // matching the eBay path.
  const lookup = supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", args.userId)
    .eq("marketplace", "depop");
  const { data: existing, error: lookupErr } = handle === null
    ? await lookup.is("account_handle", null).maybeSingle()
    : await lookup.eq("account_handle", handle).maybeSingle();
  if (lookupErr) {
    throw new Error(`Failed to look up Depop connection: ${lookupErr.message}`);
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
  // Store the stable shop id when we resolved one (US-714) so order webhooks can
  // match the seller. Never overwrite an existing id with null on a re-connect.
  if (args.externalAccountId) patch.external_account_id = args.externalAccountId;

  if (existing) {
    const { error } = await supabaseAdmin
      .from("marketplace_connections")
      .update(patch)
      .eq("id", (existing as { id: string }).id);
    if (error) {
      throw new Error(`Failed to update Depop connection: ${error.message}`);
    }
    return;
  }
  const { error } = await supabaseAdmin
    .from("marketplace_connections")
    .insert({
      user_id: args.userId,
      marketplace: "depop",
      account_handle: handle,
      ...patch,
    });
  if (error) {
    throw new Error(`Failed to insert Depop connection: ${error.message}`);
  }
}

export interface DepopConnection {
  id: string;
  accountHandle: string | null;
  token: string;
}

// Returns a valid Depop access token, refreshing if it expires within 60s.
// Throws if the user has no active Depop connection or refresh fails permanently.
// Tenant-scoped: caller passes the workspace owner id (connections live on the
// owner, like eBay/Shopify).
export async function getDepopAccessToken(userId: string): Promise<string> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select(
      "id, access_token_encrypted, refresh_token_encrypted, token_expires_at, account_handle",
    )
    .eq("user_id", userId)
    .eq("marketplace", "depop")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Depop connection: ${error.message}`);
  }
  if (!row) {
    throw new Error("No active Depop connection for this user.");
  }
  const r = row as {
    id: string;
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
    token_expires_at: string | null;
  };
  if (!r.access_token_encrypted) {
    throw new Error("No active Depop connection for this user.");
  }

  const expiresAt = r.token_expires_at
    ? new Date(r.token_expires_at).getTime()
    : 0;
  const refreshNeeded = !expiresAt || expiresAt - Date.now() < 60_000;
  if (!refreshNeeded) {
    return await decryptToken(r.access_token_encrypted, { aad: userId });
  }
  if (!r.refresh_token_encrypted) {
    throw new Error("Depop access token expired and no refresh token is stored.");
  }

  const refreshToken = await decryptToken(r.refresh_token_encrypted, {
    aad: userId,
  });
  try {
    const fresh = await refreshDepopToken(refreshToken);
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
    // Persist a rotated refresh token when Depop returns one.
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
    const permanent = isPermanentDepopAuthFailure(err);
    // PERMANENT (revoked/expired refresh token) → deactivate + store a reconnect
    // message so the UI prompts re-auth and the cron stops hammering a dead grant.
    // TRANSIENT (5xx/429/network) → leave is_active=true so a later retry works.
    await supabaseAdmin
      .from("marketplace_connections")
      .update({
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_error: permanent ? DEPOP_RECONNECT_MESSAGE : msg.slice(0, 500),
        ...(permanent ? { is_active: false } : {}),
      })
      .eq("id", r.id);
    if (permanent) {
      console.warn(`[depop-client] permanent auth failure for user ${userId}; deactivated`);
    }
    throw err;
  }
}

// Returns the owner's active Depop connection (decrypted access token, refreshed
// if near-expiry) or null when none is connected / refresh failed. Used by the
// US-714 publish + sync paths. Tenant-scoped.
export async function getDepopConnection(
  userId: string,
): Promise<DepopConnection | null> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, account_handle")
    .eq("user_id", userId)
    .eq("marketplace", "depop")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load Depop connection: ${error.message}`);
  }
  if (!row) return null;
  const r = row as { id: string; account_handle: string | null };
  let token: string;
  try {
    token = await getDepopAccessToken(userId);
  } catch {
    return null;
  }
  return { id: r.id, accountHandle: r.account_handle, token };
}

// Sweeps every active Depop connection whose token expires within the horizon
// and refreshes it inline (getDepopAccessToken renews near-expiry). Called by
// the shared token-refresh cron alongside eBay (US-713 AC#2). No-op (and never
// scans) while the connector is disabled. Returns a batch summary.
// US-2387: ceiling on the token-refresh scan. A growth bound, not a budget —
// the refresh is per-connection and the cron re-runs on a schedule.
const TOKEN_REFRESH_SCAN_CAP = 5_000;

export async function refreshExpiringDepopConnections(
  horizonMs = 24 * 60 * 60_000,
): Promise<{ scanned: number; refreshed: number; failed: number }> {
  if (!isDepopEnabled()) return { scanned: 0, refreshed: 0, failed: 0 };

  const horizon = new Date(Date.now() + horizonMs).toISOString();
  const { data: expiring, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "depop")
    .eq("is_active", true)
    .lt("token_expires_at", horizon)
    // US-2387: bounded, and ordered by URGENCY. This scan grows with the seller
    // base, and the cap only ever drops connections whose tokens expire LATEST
    // — the ones a later tick picks up anyway. An unordered cap would refresh an
    // arbitrary subset and let a soon-expiring token fall through it repeatedly.
    .order("token_expires_at", { ascending: true })
    .limit(TOKEN_REFRESH_SCAN_CAP);
  if (error) {
    console.error("[depop-client] refresh scan failed:", error);
    return { scanned: 0, refreshed: 0, failed: 0 };
  }

  const userIds = Array.from(
    new Set(((expiring ?? []) as { user_id: string }[]).map((r) => r.user_id)),
  );
  let refreshed = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await getDepopAccessToken(userId);
      refreshed += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[depop-client] refresh failed for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { scanned: userIds.length, refreshed, failed };
}
