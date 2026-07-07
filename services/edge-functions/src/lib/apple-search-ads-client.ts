// Apple Search Ads Campaign Management API client (US-1707).
//
// Auth is OAuth2 client-credentials where the client SECRET is an ES256 JWT we
// sign with our private key (same ES256 mechanics as the APNs provider token in
// apns.ts). We exchange it for an access token, then call the Search Ads API with
// the token + our orgId context header. EVERYTHING no-ops when a secret is unset
// (mirrors google-ads-client). fetch is injectable so the JWT shaping + report
// parsing are unit-tested with no live call.

import { withBackoff } from "./ads-retry.ts";

const APPLE_TOKEN_URI = "https://appleid.apple.com/auth/oauth2/token";
const APPLE_TOKEN_AUD = "https://appleid.apple.com";
export const APPLE_SEARCH_ADS_API = "https://api.searchads.apple.com/api/v5";
export const APPLE_SEARCH_ADS_PLATFORM = "apple_search_ads";

export interface AppleSearchAdsConfig {
  orgId: string;
  keyId: string;
  /** The client id (== team id for ASA); used as iss + sub of the JWT. */
  clientId: string;
  teamId: string;
  /** The .p8 private key PEM (literal or \n-escaped newlines). */
  privateKey: string;
}

export function appleSearchAdsConfig(): AppleSearchAdsConfig | null {
  const orgId = Deno.env.get("APPLE_SEARCH_ADS_ORG_ID")?.trim();
  const keyId = Deno.env.get("APPLE_SEARCH_ADS_KEY_ID")?.trim();
  const clientId = Deno.env.get("APPLE_SEARCH_ADS_CLIENT_ID")?.trim();
  const teamId = Deno.env.get("APPLE_SEARCH_ADS_TEAM_ID")?.trim() || clientId;
  const privateKey = Deno.env.get("APPLE_SEARCH_ADS_PRIVATE_KEY")?.replace(/\\n/g, "\n").trim();
  if (!orgId || !keyId || !clientId || !privateKey) return null;
  return { orgId, keyId, clientId, teamId: teamId!, privateKey };
}

export function isAppleSearchAdsConfigured(): boolean {
  return appleSearchAdsConfig() !== null;
}

export class AppleSearchAdsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AppleSearchAdsError";
  }
}

// ─── ES256 JWT (client secret) ──────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new ArrayBuffer(bin.length);
  const der = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return buf;
}

/**
 * Build the ASA client-secret JWT (ES256): header {alg,kid}, claims
 * {sub,aud,iss,iat,exp}. Signed with the .p8 private key. Exposed for testing.
 */
export async function buildClientSecretJWT(
  config: AppleSearchAdsConfig,
  now: number,
  ttlSeconds = 60 * 60,
): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64urlStr(JSON.stringify({
    sub: config.clientId,
    aud: APPLE_TOKEN_AUD,
    iss: config.teamId,
    iat: now,
    exp: now + ttlSeconds,
  }));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(config.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/** The token-exchange form body (client_credentials + the JWT secret). */
export function accessTokenRequestBody(config: AppleSearchAdsConfig, clientSecret: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: clientSecret,
    scope: "searchadsorg",
  });
}

/** Exchange the signed JWT for an access token. */
export async function mintAppleAccessToken(
  config: AppleSearchAdsConfig,
  now: number = Math.floor(Date.now() / 1000),
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const jwt = await buildClientSecretJWT(config, now);
  let res: Response;
  try {
    res = await fetchFn(APPLE_TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: accessTokenRequestBody(config, jwt).toString(),
    });
  } catch (err) {
    throw new AppleSearchAdsError(0, `ASA token request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new AppleSearchAdsError(res.status, `ASA token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { access_token?: string };
  if (!parsed.access_token) throw new AppleSearchAdsError(res.status, "ASA token response had no access_token.");
  return parsed.access_token;
}

/** Authenticated Search Ads API call (adds the Bearer + orgId context header). */
export async function appleRequest<T>(
  config: AppleSearchAdsConfig,
  token: string,
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  // US-1709: retry transient (429/5xx/network) failures with backoff.
  return withBackoff(async () => {
    let res: Response;
    try {
      res = await fetchFn(`${APPLE_SEARCH_ADS_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-AP-Context": `orgId=${config.orgId}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new AppleSearchAdsError(0, `ASA request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new AppleSearchAdsError(res.status, `ASA API ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  });
}
