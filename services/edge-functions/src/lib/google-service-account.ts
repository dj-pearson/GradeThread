import { googleFetch } from "./google-fetch.ts";

// Google service-account OAuth2 — mints a short-lived access token from a
// service-account JSON key, for server-to-server Google APIs. Shared by FCM
// (lib/fcm.ts, scope firebase.messaging) and the Google Play purchase verifier
// (scope androidpublisher). Mirrors the ES256 provider-JWT pattern in apns.ts,
// but Google uses RS256 + a JWT-bearer token exchange.
//
// The SA key JSON is injected via an env var (raw JSON, or base64 of the JSON —
// base64 sidesteps newline/quoting issues in some secret stores). Everything
// no-ops cleanly when the env var is unset, so an unconfigured deployment never
// throws (same posture as APNs/email).

const TOKEN_URI = "https://oauth2.googleapis.com/token";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

/**
 * Parse a service-account key from an env value — accepts raw JSON or base64 of
 * the JSON. Returns null when unset/blank/malformed (caller treats as
 * "unconfigured"), never throws.
 */
export function parseServiceAccount(
  envValue: string | undefined | null,
): ServiceAccount | null {
  const raw = (envValue ?? "").trim();
  if (!raw) return null;
  let text = raw;
  if (!raw.startsWith("{")) {
    // Looks like base64 — decode it.
    try {
      text = atob(raw.replace(/\s+/g, ""));
    } catch {
      return null;
    }
  }
  try {
    const obj = JSON.parse(text) as Partial<ServiceAccount>;
    if (
      typeof obj.client_email !== "string" ||
      typeof obj.private_key !== "string" ||
      !obj.client_email ||
      !obj.private_key
    ) {
      return null;
    }
    return {
      client_email: obj.client_email,
      // Secret stores often escape the PEM newlines.
      private_key: obj.private_key.replace(/\\n/g, "\n"),
      project_id: typeof obj.project_id === "string" ? obj.project_id : undefined,
      token_uri: typeof obj.token_uri === "string" ? obj.token_uri : undefined,
    };
  } catch {
    return null;
  }
}

// ─── JWT signing (RS256) ────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new ArrayBuffer(bin.length);
  const der = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return buf;
}

/**
 * Build the signed JWT-bearer assertion for the token exchange. Exported for
 * tests (the claim set + signature are deterministic given `nowSec`).
 */
export async function buildAssertionJwt(
  sa: ServiceAccount,
  scope: string,
  nowSec: number,
): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlStr(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri ?? TOKEN_URI,
      iat: nowSec,
      exp: nowSec + 3600, // Google caps assertion lifetime at 1h.
    }),
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// ─── Access-token exchange (cached) ─────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // epoch seconds
}
const tokenCache = new Map<string, CachedToken>();

/**
 * Get a cached Google access token for the service account + scope. Re-mints
 * when within 60s of expiry. Throws on a failed exchange (the caller decides
 * whether that's fatal — the push/verify callers log + degrade).
 */
export async function getAccessToken(
  sa: ServiceAccount,
  scope: string,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cacheKey = `${sa.client_email}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - 60 > nowSec) return cached.token;

  const assertion = await buildAssertionJwt(sa, scope, nowSec);
  const res = await googleFetch(sa.token_uri ?? TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`google token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("google token exchange returned no access_token");
  }
  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: nowSec + (json.expires_in ?? 3600),
  });
  return json.access_token;
}

/** Test-only: clear the access-token cache between cases. */
export function _resetTokenCacheForTest(): void {
  tokenCache.clear();
}
