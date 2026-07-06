// Whatnot partner API connector for FlipDesk (US-1661) — OAuth 2.0 Authorization
// Code + PKCE, encrypted token storage, and proactive token refresh. This module
// owns the CONNECTION lifecycle only (connect → store → refresh → disconnect);
// the publish/order-sync write path is US-1662 (the adapter's listing methods
// return a typed 503 until then).
//
// GATING (US-1661): the ENTIRE connector is gated behind WHATNOT_ENABLED.
// Whatnot's partner API is private and access is application-gated, so
// isWhatnotEnabled() is FALSE unless an operator both sets WHATNOT_ENABLED=true
// AND provides the OAuth creds. Every Whatnot edge endpoint 503s while it's off,
// so there is no fake connect flow before partner access is granted.
//
// ⚠️ MODELED: Whatnot's partner API has no public docs. The auth/token URLs,
// scopes, and token shape below are MODELED on a standard OAuth 2.0 + PKCE
// partner app (the Depop pattern) and MUST be reconciled against the live API
// once partner access lands. Everything is overridable via env so a shape change
// is config, not code.
//
// PKCE (RFC 7636): /oauth/start generates a random code_verifier, stashes it on
// the single-use oauth_states row (migration 00175), and sends the S256
// code_challenge; the token exchange in /oauth/callback presents the verifier.
//
// Tokens: stored encrypted in marketplace_connections (marketplace='whatnot'),
// AES-GCM-bound to the owning user_id as AAD (US-352), identical to the eBay/Depop
// path. getWhatnotAccessToken() refreshes inline near expiry, and the shared
// token-refresh cron sweeps connections nearing expiry.
//
// Required env (Coolify Shared Variables), ALL only consulted when WHATNOT_ENABLED:
//   WHATNOT_ENABLED        "true" to turn the connector on (default off)
//   WHATNOT_CLIENT_ID      the partner app's client id
//   WHATNOT_CLIENT_SECRET  the partner app's client secret
//   WHATNOT_REDIRECT_URI   https://functions.gradethread.com/api/flipdesk/whatnot/oauth/callback
//   WHATNOT_AUTH_URL       optional; default https://www.whatnot.com/oauth/authorize
//   WHATNOT_TOKEN_URL      optional; default https://api.whatnot.com/oauth/token
//   WHATNOT_SCOPES         optional; default = the modeled read+write set
//   EDGE_ENCRYPTION_KEY    (shared with the eBay/Shopify/Depop/Etsy paths)

import { supabaseAdmin } from "./supabase.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";

const WHATNOT_TIMEOUT_MS = 20_000;

// ⚠️ MODELED scope set — reconcile against the live partner API.
const DEFAULT_SCOPES = [
  "listings:read",
  "listings:write",
  "orders:read",
  "shop:read",
].join(" ");

const DEFAULT_AUTH_URL = "https://www.whatnot.com/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://api.whatnot.com/oauth/token";

function readEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Master kill-switch: live ONLY when WHATNOT_ENABLED is on AND creds are present.
export function isWhatnotEnabled(): boolean {
  const flag = (readEnv("WHATNOT_ENABLED") ?? "").toLowerCase();
  const on = flag === "true" || flag === "1" || flag === "yes" || flag === "on";
  return on && !!(readEnv("WHATNOT_CLIENT_ID") && readEnv("WHATNOT_CLIENT_SECRET"));
}

export function getWhatnotScopes(): string {
  return readEnv("WHATNOT_SCOPES") ?? DEFAULT_SCOPES;
}

// ── PKCE ──────────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
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
  const clientId = readEnv("WHATNOT_CLIENT_ID");
  const redirectUri = readEnv("WHATNOT_REDIRECT_URI");
  if (!clientId || !redirectUri) {
    throw new Error("WHATNOT_CLIENT_ID / WHATNOT_REDIRECT_URI are not set.");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: getWhatnotScopes(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authUrl = readEnv("WHATNOT_AUTH_URL") ?? DEFAULT_AUTH_URL;
  return `${authUrl}?${params.toString()}`;
}

export interface WhatnotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
): Promise<WhatnotTokenResponse> {
  const clientId = readEnv("WHATNOT_CLIENT_ID");
  const clientSecret = readEnv("WHATNOT_CLIENT_SECRET");
  const redirectUri = readEnv("WHATNOT_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "WHATNOT_CLIENT_ID / WHATNOT_CLIENT_SECRET / WHATNOT_REDIRECT_URI are not set.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });
  const tokenUrl = readEnv("WHATNOT_TOKEN_URL") ?? DEFAULT_TOKEN_URL;
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
    WHATNOT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whatnot token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as WhatnotTokenResponse;
}

export interface WhatnotRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export async function refreshWhatnotToken(
  refreshToken: string,
): Promise<WhatnotRefreshResponse> {
  const clientId = readEnv("WHATNOT_CLIENT_ID");
  const clientSecret = readEnv("WHATNOT_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("WHATNOT_CLIENT_ID / WHATNOT_CLIENT_SECRET are not set.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenUrl = readEnv("WHATNOT_TOKEN_URL") ?? DEFAULT_TOKEN_URL;
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
    WHATNOT_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whatnot token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as WhatnotRefreshResponse;
}

// US-463 pattern: classify a refresh failure PERMANENT vs TRANSIENT. Pure + tested.
export function isPermanentWhatnotAuthFailure(err: unknown): boolean {
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
  return false;
}

export const WHATNOT_RECONNECT_MESSAGE =
  "Whatnot disconnected: your authorization was revoked or expired. Please reconnect your Whatnot shop.";

// ── Connection storage ────────────────────────────────────────────────

export async function upsertWhatnotConnection(args: {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  scope: string;
  accountHandle?: string | null;
  externalAccountId?: string | null;
}): Promise<void> {
  const access = await encryptToken(args.accessToken, { aad: args.userId });
  const refresh = await encryptToken(args.refreshToken, { aad: args.userId });
  const expiresAt = new Date(
    Date.now() + args.accessExpiresInSeconds * 1000,
  ).toISOString();
  const handle = args.accountHandle ?? null;

  const lookup = supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", args.userId)
    .eq("marketplace", "whatnot");
  const { data: existing, error: lookupErr } = handle === null
    ? await lookup.is("account_handle", null).maybeSingle()
    : await lookup.eq("account_handle", handle).maybeSingle();
  if (lookupErr) {
    throw new Error(`Failed to look up Whatnot connection: ${lookupErr.message}`);
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
  if (args.externalAccountId) patch.external_account_id = args.externalAccountId;

  if (existing) {
    const { error } = await supabaseAdmin
      .from("marketplace_connections")
      .update(patch)
      .eq("id", (existing as { id: string }).id);
    if (error) {
      throw new Error(`Failed to update Whatnot connection: ${error.message}`);
    }
    return;
  }
  const { error } = await supabaseAdmin
    .from("marketplace_connections")
    .insert({
      user_id: args.userId,
      marketplace: "whatnot",
      account_handle: handle,
      ...patch,
    });
  if (error) {
    throw new Error(`Failed to insert Whatnot connection: ${error.message}`);
  }
}

export interface WhatnotConnection {
  id: string;
  accountHandle: string | null;
  shopId: string | null;
  token: string;
}

export async function getWhatnotAccessToken(userId: string): Promise<string> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select(
      "id, access_token_encrypted, refresh_token_encrypted, token_expires_at, account_handle",
    )
    .eq("user_id", userId)
    .eq("marketplace", "whatnot")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load Whatnot connection: ${error.message}`);
  }
  if (!row) {
    throw new Error("No active Whatnot connection for this user.");
  }
  const r = row as {
    id: string;
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
    token_expires_at: string | null;
  };
  if (!r.access_token_encrypted) {
    throw new Error("No active Whatnot connection for this user.");
  }

  const expiresAt = r.token_expires_at ? new Date(r.token_expires_at).getTime() : 0;
  const refreshNeeded = !expiresAt || expiresAt - Date.now() < 60_000;
  if (!refreshNeeded) {
    return await decryptToken(r.access_token_encrypted, { aad: userId });
  }
  if (!r.refresh_token_encrypted) {
    throw new Error("Whatnot access token expired and no refresh token is stored.");
  }

  const refreshToken = await decryptToken(r.refresh_token_encrypted, { aad: userId });
  try {
    const fresh = await refreshWhatnotToken(refreshToken);
    const encryptedAccess = await encryptToken(fresh.access_token, { aad: userId });
    const expiresAtNew = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
    const patch: Record<string, unknown> = {
      access_token_encrypted: encryptedAccess,
      token_expires_at: expiresAtNew,
      last_refresh_attempt_at: new Date().toISOString(),
      refresh_error: null,
    };
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
    const permanent = isPermanentWhatnotAuthFailure(err);
    await supabaseAdmin
      .from("marketplace_connections")
      .update({
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_error: permanent ? WHATNOT_RECONNECT_MESSAGE : msg.slice(0, 500),
        ...(permanent ? { is_active: false } : {}),
      })
      .eq("id", r.id);
    if (permanent) {
      console.warn(`[whatnot-client] permanent auth failure for user ${userId}; deactivated`);
    }
    throw err;
  }
}

export async function getWhatnotConnection(
  userId: string,
): Promise<WhatnotConnection | null> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, account_handle, external_account_id")
    .eq("user_id", userId)
    .eq("marketplace", "whatnot")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load Whatnot connection: ${error.message}`);
  }
  if (!row) return null;
  const r = row as {
    id: string;
    account_handle: string | null;
    external_account_id: string | null;
  };
  let token: string;
  try {
    token = await getWhatnotAccessToken(userId);
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

export async function refreshExpiringWhatnotConnections(
  horizonMs = 24 * 60 * 60_000,
): Promise<{ scanned: number; refreshed: number; failed: number }> {
  if (!isWhatnotEnabled()) return { scanned: 0, refreshed: 0, failed: 0 };

  const horizon = new Date(Date.now() + horizonMs).toISOString();
  const { data: expiring, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "whatnot")
    .eq("is_active", true)
    .lt("token_expires_at", horizon);
  if (error) {
    console.error("[whatnot-client] refresh scan failed:", error);
    return { scanned: 0, refreshed: 0, failed: 0 };
  }

  const userIds = Array.from(
    new Set(((expiring ?? []) as { user_id: string }[]).map((r) => r.user_id)),
  );
  let refreshed = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await getWhatnotAccessToken(userId);
      refreshed += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[whatnot-client] refresh failed for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { scanned: userIds.length, refreshed, failed };
}
