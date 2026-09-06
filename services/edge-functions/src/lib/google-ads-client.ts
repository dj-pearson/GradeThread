// Google Ads API client (US-1697) — the one audited, no-op-when-unconfigured way
// every later Ads Command Center feature talks to Google Ads.
//
// Auth is an OAuth2 REFRESH-TOKEN grant (a user who has access to the Ads
// account authorized us once; we mint short-lived access tokens from the stored
// refresh token). Queries are GAQL against GOOGLE_ADS_CUSTOMER_ID, routed
// through the MCC (GOOGLE_ADS_LOGIN_CUSTOMER_ID) with the developer-token +
// login-customer-id headers.
//
// EVERYTHING no-ops when a required secret is unset — an unconfigured deployment
// never throws at boot (same posture as APNs / service-account / email). fetch
// is injectable so the whole request/response shaping is unit-testable with no
// live Google call.

import { googleFetch } from "./google-fetch.ts";
import { withBackoff } from "./ads-retry.ts";

const OAUTH_TOKEN_URI = "https://oauth2.googleapis.com/token";
// Google Ads API is versioned in the path; bump deliberately (breaking changes
// per version).
//
// A SUNSET VERSION DOES NOT 404 AS JSON — googleads.googleapis.com serves an
// HTML "Error 404 (Not Found)!!1" page, which surfaces here as an opaque
// `Google Ads query failed (404): <!DOCTYPE html>...` and reads like a bad
// request rather than a dead endpoint. That is how v18 sat here after sunset
// while ads-sync failed every morning at 08:00 (2026-08-18).
//
// Probe before bumping — an unauthenticated POST to a LIVE version returns
// 401 JSON, a sunset one returns 404 HTML:
//   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
//     -d '{"query":"select customer.id from customer"}' \
//     https://googleads.googleapis.com/v21/customers/1234567890/googleAds:search
// Measured 2026-08-18: v17/v18/v19 sunset (404 HTML), v20-v24 live (401 JSON).
//
// ⚠ RE-MEASURED 2026-09-06 AND IT HAD HAPPENED AGAIN: v19, v20 AND v21 all
// answer 404 now; v22-v26 answer 401. So this constant sat on a sunset version
// for a second time, and production said so the whole while - ads-sync recorded
// 18 consecutive `error` runs in cron_runs over three days, and
// keyword_research_runs holds `generateKeywordIdeas failed (404): <!DOCTYPE
// html>` from 2026-08-31. The paragraph above describes this exact failure;
// what was missing was anybody re-running the probe.
//
// A VERSION GOING QUIET IS THE DEFAULT HERE, NOT AN INCIDENT. Google sunsets
// roughly quarterly, so this WILL recur - scripts/ops/google-ads-version-check.mjs
// runs the probe and fails when this constant is not live.
//
// Bump to the LOWEST live version, not the newest: every version carries
// breaking changes, and the smaller hop is the one you can reason about.
export const GOOGLE_ADS_API_VERSION = "v22";
const ADS_API_BASE = "https://googleads.googleapis.com";

/** Resolved Google Ads secrets. `null` from config() when ANY required one is unset. */
export interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** MCC (manager) customer id, digits only. */
  loginCustomerId: string;
  /** The Ads account we operate on, digits only. */
  customerId: string;
}

/** Strip dashes/spaces from a customer id ("123-456-7890" → "1234567890"). */
export function normalizeCustomerId(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

/**
 * Resolve the Google Ads config from env. Returns null when any required secret
 * is unset/blank — callers treat that as "Ads not configured" and no-op. Never
 * throws.
 */
export function googleAdsConfig(): GoogleAdsConfig | null {
  const developerToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")?.trim();
  const clientId = Deno.env.get("GOOGLE_ADS_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("GOOGLE_ADS_CLIENT_SECRET")?.trim();
  const refreshToken = Deno.env.get("GOOGLE_ADS_REFRESH_TOKEN")?.trim();
  const loginCustomerId = normalizeCustomerId(Deno.env.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID") ?? "");
  const customerId = normalizeCustomerId(Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") ?? "");
  if (
    !developerToken || !clientId || !clientSecret || !refreshToken ||
    !loginCustomerId || !customerId
  ) {
    return null;
  }
  return { developerToken, clientId, clientSecret, refreshToken, loginCustomerId, customerId };
}

/** True when every required Google Ads secret is present. */
export function isGoogleAdsConfigured(): boolean {
  return googleAdsConfig() !== null;
}

export class GoogleAdsError extends Error {
  constructor(
    readonly status: number,
    /** Machine-readable classification for the admin status surface. */
    readonly kind: "unauthorized" | "developer_token" | "rate_limited" | "request" | "network",
    message: string,
  ) {
    super(message);
    this.name = "GoogleAdsError";
  }
}

/** The token-exchange request body shape (form-encoded), exposed for testing. */
export function accessTokenRequestBody(config: GoogleAdsConfig): URLSearchParams {
  return new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });
}

/**
 * Mint a short-lived access token from the refresh token. Returns null when
 * unconfigured; throws GoogleAdsError on an auth failure (invalid_grant → the
 * refresh token was revoked and needs re-auth).
 */
export async function mintGoogleAdsAccessToken(
  config: GoogleAdsConfig,
  fetchFn: typeof fetch = googleFetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(OAUTH_TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: accessTokenRequestBody(config).toString(),
    });
  } catch (err) {
    throw new GoogleAdsError(0, "network", `Token request failed: ${errText(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    // invalid_grant = the refresh token was revoked/expired → re-auth needed.
    const reAuth = text.includes("invalid_grant");
    throw new GoogleAdsError(
      res.status,
      "unauthorized",
      reAuth
        ? "Google Ads refresh token is no longer valid — re-authorize the Ads connection."
        : `Google Ads token exchange failed (${res.status}).`,
    );
  }
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(text) as { access_token?: string };
  } catch {
    throw new GoogleAdsError(res.status, "request", "Malformed token response.");
  }
  if (!parsed.access_token) {
    throw new GoogleAdsError(res.status, "request", "Token response had no access_token.");
  }
  return parsed.access_token;
}

/** A single GAQL result row is an opaque nested object; callers type their projection. */
export type GaqlRow = Record<string, unknown>;

export function gaqlSearchUrl(config: GoogleAdsConfig): string {
  return `${ADS_API_BASE}/${GOOGLE_ADS_API_VERSION}/customers/${config.customerId}/googleAds:search`;
}

export function gaqlHeaders(config: GoogleAdsConfig, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "developer-token": config.developerToken,
    // The MCC that the customer sits under — required for manager-linked reads.
    "login-customer-id": config.loginCustomerId,
    "Content-Type": "application/json",
  };
}

/**
 * Run a GAQL query against the configured customer, following pagination, and
 * return the flat list of result rows. `token` comes from
 * mintGoogleAdsAccessToken. Throws GoogleAdsError with a classified `kind` on
 * failure so the admin surface can render an actionable message.
 */
export async function runGaql(
  config: GoogleAdsConfig,
  token: string,
  query: string,
  fetchFn: typeof fetch = googleFetch,
): Promise<GaqlRow[]> {
  const rows: GaqlRow[] = [];
  let pageToken: string | undefined;
  const url = gaqlSearchUrl(config);
  const headers = gaqlHeaders(config, token);

  do {
    const body = JSON.stringify(pageToken ? { query, pageToken } : { query });
    // US-1709: retry transient (429/5xx/network) failures with backoff per page.
    const page = await withBackoff(async () => {
      let res: Response;
      try {
        res = await fetchFn(url, { method: "POST", headers, body });
      } catch (err) {
        throw new GoogleAdsError(0, "network", `Google Ads request failed: ${errText(err)}`);
      }
      const text = await res.text();
      if (!res.ok) throw classifyGaqlError(res.status, text);
      try {
        return JSON.parse(text) as { results?: GaqlRow[]; nextPageToken?: string };
      } catch {
        throw new GoogleAdsError(res.status, "request", "Malformed Google Ads response.");
      }
    });
    if (Array.isArray(page.results)) rows.push(...page.results);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return rows;
}

/** Map an HTTP error + body into a classified GoogleAdsError. */
function classifyGaqlError(status: number, body: string): GoogleAdsError {
  const lower = body.toLowerCase();
  if (status === 401) {
    return new GoogleAdsError(status, "unauthorized", "Google Ads auth expired — re-authorize the connection.");
  }
  if (status === 429) {
    return new GoogleAdsError(status, "rate_limited", "Google Ads rate limit reached — try again shortly.");
  }
  if (
    lower.includes("developer_token_not_approved") ||
    lower.includes("developer token") ||
    lower.includes("not approved")
  ) {
    return new GoogleAdsError(
      status,
      "developer_token",
      "The Google Ads developer token isn't approved for this account yet — a test token can only query test accounts; apply for Basic Access.",
    );
  }
  if (status === 403) {
    return new GoogleAdsError(status, "unauthorized", "Google Ads denied access (403) — check the developer token + account access.");
  }
  return new GoogleAdsError(status, "request", `Google Ads query failed (${status}): ${body.slice(0, 200)}`);
}

// ── US-1704: offline click-conversion upload ─────────────────────────────
export interface ClickConversion {
  gclid: string;
  conversionAction: string;
  /** "yyyy-MM-dd HH:mm:ss+HH:mm" (Google's required format, with tz offset). */
  conversionDateTime: string;
  conversionValue: number;
  currencyCode: string;
}

export function uploadConversionsUrl(config: GoogleAdsConfig): string {
  return `${ADS_API_BASE}/${GOOGLE_ADS_API_VERSION}/customers/${config.customerId}:uploadClickConversions`;
}

/**
 * Upload offline click conversions (gclid → conversion action + value) via the
 * ConversionUploadService with partialFailure, so one bad row doesn't sink the
 * batch. Returns the per-row results + any partialFailureError.
 */
export async function uploadClickConversions(
  config: GoogleAdsConfig,
  token: string,
  conversions: ClickConversion[],
  fetchFn: typeof fetch = googleFetch,
): Promise<{ results: unknown[]; partialFailureError?: unknown }> {
  let response: Response;
  try {
    response = await fetchFn(uploadConversionsUrl(config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": config.developerToken,
        "login-customer-id": config.loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ conversions, partialFailure: true }),
    });
  } catch (err) {
    throw new GoogleAdsError(0, "network", `Conversion upload failed: ${errText(err)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new GoogleAdsError(
      response.status,
      response.status === 401 ? "unauthorized" : "request",
      `Conversion upload failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text) as { results: unknown[]; partialFailureError?: unknown };
  } catch {
    return { results: [] };
  }
}

export type AdsConnectionStatus =
  | { ok: true; descriptiveName: string; currencyCode: string; timeZone: string }
  | { ok: false; configured: boolean; kind: string; message: string };

/**
 * Read-only connection check for the admin 'Ads connection' status surface:
 * mints a token and runs a tiny GAQL for the customer's name/currency/time zone.
 * Returns a configured:false status (never throws) when secrets are unset, and a
 * classified, actionable message on any auth/token error.
 */
export async function checkAdsConnection(
  fetchFn: typeof fetch = googleFetch,
): Promise<AdsConnectionStatus> {
  const config = googleAdsConfig();
  if (!config) {
    return { ok: false, configured: false, kind: "unconfigured", message: "Google Ads is not configured (missing GOOGLE_ADS_* secrets)." };
  }
  try {
    const token = await mintGoogleAdsAccessToken(config, fetchFn);
    const rows = await runGaql(
      config,
      token,
      "SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1",
      fetchFn,
    );
    const customer = (rows[0]?.customer ?? {}) as {
      descriptiveName?: string;
      currencyCode?: string;
      timeZone?: string;
    };
    return {
      ok: true,
      descriptiveName: customer.descriptiveName ?? "(unnamed)",
      currencyCode: customer.currencyCode ?? "",
      timeZone: customer.timeZone ?? "",
    };
  } catch (err) {
    if (err instanceof GoogleAdsError) {
      return { ok: false, configured: true, kind: err.kind, message: err.message };
    }
    return { ok: false, configured: true, kind: "unknown", message: errText(err) };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
