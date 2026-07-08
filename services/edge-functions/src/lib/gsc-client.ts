// US-308: Google Search Console (Search Analytics) client.
//
// Service-account flow: we sign a JWT with the SA private key (RS256), trade
// it for an access token at oauth2.googleapis.com/token, then call the
// Search Analytics endpoint. Tokens cache in-process for their TTL so the
// daily cron does ONE auth round-trip per run, not per page query.
//
// Required env:
//   GSC_SERVICE_ACCOUNT_EMAIL   service account email
//   GSC_SERVICE_ACCOUNT_PRIVATE_KEY  PEM (PKCS#8), with literal \n line breaks
//   GSC_SITE_URL                site property, e.g. sc-domain:gradethread.com
//                               or https://gradethread.com/
//
// We expose `isGscConfigured()` so callers can return a clear "not
// configured" instead of crashing when env isn't wired yet — the rest of
// the SEO infrastructure (US-307, US-309) still runs.

import { createSharedTokenCache } from "./coherent-cache.ts";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEARCH_ANALYTICS_ENDPOINT =
  "https://searchconsole.googleapis.com/webmasters/v3/sites";

export function isGscConfigured(): boolean {
  return !!(
    Deno.env.get("GSC_SERVICE_ACCOUNT_EMAIL") &&
    Deno.env.get("GSC_SERVICE_ACCOUNT_PRIVATE_KEY") &&
    Deno.env.get("GSC_SITE_URL")
  );
}

export function getGscSiteUrl(): string {
  return Deno.env.get("GSC_SITE_URL") ?? "";
}

// US-571: the GSC access token is shared across the cluster (not minted per
// replica). Refreshed when within 60s of expiry.
const tokenCache = createSharedTokenCache({
  cacheKey: "gsc-access-token",
  skewMs: 60_000,
});

async function getAccessToken(): Promise<string> {
  return await tokenCache.get(async () => {
    const email = Deno.env.get("GSC_SERVICE_ACCOUNT_EMAIL");
    const rawKey = Deno.env.get("GSC_SERVICE_ACCOUNT_PRIVATE_KEY");
    if (!email || !rawKey) {
      throw new Error("GSC service account env not configured");
    }

    const assertion = await buildAssertion(email, rawKey);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GSC token exchange failed (${res.status}): ${text}`);
    }
    const json = await res.json() as { access_token: string; expires_in: number };
    return { token: json.access_token, expiresInMs: json.expires_in * 1000 };
  });
}

async function buildAssertion(email: string, pemKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const claim = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: email,
        scope: GSC_SCOPE,
        aud: TOKEN_ENDPOINT,
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const signingInput = `${header}.${claim}`;

  const key = await importPkcs8Key(pemKey);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function importPkcs8Key(pemKey: string): Promise<CryptoKey> {
  // Coolify env vars are single-line, so the PEM arrives with escaped newlines.
  // Collapse \n / \\n / \r escapes to real newlines, drop the PEM labels (any
  // variant), and strip quotes + whitespace — leaving ONLY the base64 body. This
  // is robust to double-escaped newlines (a stray backslash) and wrapping quotes,
  // the two things that make atob throw "Failed to decode base64".
  const cleaned = pemKey
    .replace(/\\+[rn]/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/["'\s]/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    const bad = [...new Set(cleaned.replace(/[A-Za-z0-9+/=]/g, ""))];
    throw new Error(
      `GSC_SERVICE_ACCOUNT_PRIVATE_KEY is not valid base64 after cleaning (offending chars: ${JSON.stringify(bad)}) — check for double-escaped \\n or a hidden character in the env value.`,
    );
  }
  const der = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type GscDimension = "date" | "query" | "page" | "country" | "device";

export interface SearchAnalyticsRow {
  keys?: string[]; // matches the dimensions in the request, in order
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
}

/**
 * Run a Search Analytics query against the configured site property. GSC
 * paginates with `startRow` + `rowLimit` (max 25k); we fetch in chunks until
 * the response returns fewer rows than the limit.
 */
export async function querySearchAnalytics(opts: {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  dimensions: GscDimension[];
  rowLimit?: number;
}): Promise<SearchAnalyticsRow[]> {
  if (!isGscConfigured()) {
    throw new Error("GSC not configured");
  }
  const siteUrl = getGscSiteUrl();
  const token = await getAccessToken();
  const url = `${SEARCH_ANALYTICS_ENDPOINT}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const rowLimit = Math.min(opts.rowLimit ?? 25_000, 25_000);

  const all: SearchAnalyticsRow[] = [];
  let startRow = 0;
  // Cap pages so a runaway response can't pull millions of rows.
  for (let page = 0; page < 20; page++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: opts.startDate,
        endDate: opts.endDate,
        dimensions: opts.dimensions,
        rowLimit,
        startRow,
        // We group by `page` (and `query`), so per Google's API rules the
        // aggregation MUST be "auto" — "byPage" with page/query dimensions is an
        // invalid combination that returns 0 rows. "auto" still de-dupes by
        // canonical page since `page` is a requested dimension.
        aggregationType: "auto",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GSC searchAnalytics.query failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    const body = await res.json() as SearchAnalyticsResponse;
    const rows = body.rows ?? [];
    all.push(...rows);
    if (rows.length < rowLimit) break;
    startRow += rows.length;
  }
  return all;
}
