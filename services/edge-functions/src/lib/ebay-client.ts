// Thin wrapper around the eBay OAuth + REST surface area FlipDesk needs.
//
// Two token flavors live here:
//   1. App token  — client_credentials grant. Used for Taxonomy + Browse
//      (public catalog data). Single token shared by the whole edge service;
//      cached in-memory until ~5 minutes before expiry.
//   2. User token — authorization_code grant. Per-seller. Stored encrypted
//      in marketplace_connections; refreshed lazily on use.
//
// All endpoint hosts switch between sandbox and production based on EBAY_ENV.

import { supabaseAdmin } from "./supabase.ts";
// US-2704: the snapshot funnel. Every write below that changes what a buyer
// reads records it, because an INAD defence is the listing text that was live
// and nothing else kept it.
import { recordPublication } from "./listing-publications.ts";
import { grantMarketplaceConnectedReward } from "./rewards-engine.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";
import {
  isRateLimitError,
  isRetryableError,
  parseRetryAfterHeader as parseRetryAfter,
  type RetryOptions,
  withRetry,
} from "./retry.ts";
import { fetchWithTimeout, getBreaker } from "./circuit-breaker.ts";
import {
  isSizeToken,
  normalizeTitleToken,
  TITLE_COLOR_TOKENS,
  TITLE_FILLER_TOKENS,
} from "./title-tokens.ts";
import { createSharedTokenCache, type SharedTokenCache } from "./coherent-cache.ts";
import { recordEbayCall } from "./ebay-call-log.ts";

// US-499: bounded deadline on every eBay HTTP call. eBay is occasionally slow;
// without a deadline a bulk publish/sync can stall the container.
const EBAY_TIMEOUT_MS = 20_000;

// US-499: one shared breaker for all eBay traffic (request paths AND the
// reprice/sync crons). Only TRANSIENT failures (5xx/429/timeout/network) count
// toward opening — a 4xx (revoked token, bad request) means eBay is up.
function ebayBreaker() {
  return getBreaker("ebay", {
    failureThreshold: 5,
    cooldownMs: 30_000,
    isFailure: isRetryableError,
  });
}

// US-3042: the ONE place an eBay request is counted. Every eBay HTTP call in
// the service reaches the network through this function — ebayFetch,
// ebayResilientFetch and fetchAuthedOnce all delegate here, and the side-channel
// libs (feed, disputes' side path) call it directly. Putting the counter
// anywhere else means a family gets added later and is silently uncounted,
// which is exactly how we ended up with no numbers at all.
//
// The count is taken in a `finally` so a timeout or connection reset is counted
// too (as status_class 'error'). It never throws — see lib/ebay-call-log.ts.
export async function countedEbayFetch(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = EBAY_TIMEOUT_MS,
  // Trading API only: one URL serves every operation, so without the call name
  // all of Trading collapses into a single indistinguishable row.
  callName?: string,
): Promise<Response> {
  let status: number | null = null;
  try {
    const res = await fetchWithTimeout(input, init, timeoutMs);
    status = res.status;
    return res;
  } finally {
    recordEbayCall({
      url: input,
      method: init.method ?? "GET",
      status,
      callName,
    });
  }
}

// US-499: every eBay HTTP call goes through here so none can hang forever. The
// token/taxonomy/browse paths use this directly; the authed Sell API path adds
// the breaker on top (see fetchAuthed).
function ebayFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  return countedEbayFetch(input, init ?? {}, EBAY_TIMEOUT_MS);
}

// US-1966: the main Sell path (fetchAuthed) has the breaker + withRetry +
// Retry-After handling, but the side-channel families (Finances, Marketing,
// Disputes, Post-Order) rolled their own bare fetch with none of it, so they
// threw hard under load. These two helpers bring those families to parity.
//
// `fetchWithEbayRetry` wraps a single fetch attempt in withRetry, throwing a
// rich retryable error (status + retryAfterMs) ONLY on 429/5xx so the backoff
// honors eBay's Retry-After and the breaker counts transient failures. EVERY
// other response (2xx, 404, 204, other 4xx) is RETURNED unchanged, so each
// family keeps its own status-specific handling (e.g. Finances' 404/204 → stop
// paginating, Disputes' benign 404). Exported for unit tests (inject a fake
// `doFetch` + a no-op `sleep`).
export async function fetchWithEbayRetry(
  doFetch: () => Promise<Response>,
  opts: { label?: string } & RetryOptions = {},
): Promise<Response> {
  const { label, ...retry } = opts;
  return await withRetry(async () => {
    const res = await doFetch();
    if (res.status === 429 || res.status >= 500) {
      // Free the socket and keep the body for context; 429/5xx bodies aren't
      // matched on errorId (they're transient), so consuming it here is safe.
      const text = await res.text().catch(() => "");
      const err = new Error(
        `eBay ${label ?? "request"} failed (${res.status}): ${text.slice(0, 400)}`,
      ) as Error & { status: number; retryAfterMs?: number };
      err.status = res.status;
      const ra = parseRetryAfter(
        res.headers.get("retry-after") ??
          res.headers.get("x-ebay-c-rlogid-retry-after"),
      );
      if (ra !== null) err.retryAfterMs = ra;
      throw err;
    }
    return res;
  }, retry);
}

// `ebayResilientFetch` composes the shared breaker OUTSIDE the retry (US-499: a
// fully-retried-then-failed call counts as one breaker failure) around
// fetchWithEbayRetry over a timeout-bounded fetch. The side-channel families
// call THIS instead of a raw fetch.
// US-2160: `retry` forwards RetryOptions to the inner withRetry. It exists for
// one reason — a NON-IDEMPOTENT call (buying a shipping label charges the
// seller and eBay offers no idempotency key) must pass `{ maxAttempts: 1 }`, so
// a 5xx surfaces as an error the seller resolves by re-checking rather than
// silently billing twice. Omit it and the default 3-attempt backoff applies,
// which is what every existing caller wants.
export function ebayResilientFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: { timeoutMs?: number; label?: string; retry?: RetryOptions } = {},
): Promise<Response> {
  const label = opts.label ??
    `${init.method ?? "GET"} ${typeof url === "string" ? url : url.toString()}`;
  // US-3042: counted, and counted per ATTEMPT — the retry lives inside, so a
  // call that succeeds on its third try is three calls against eBay's quota and
  // is recorded as three. That gap between attempts and successes is the signal
  // worth having when the daily number starts climbing.
  const callName = typeof init.headers === "object" && init.headers !== null
    ? (init.headers as Record<string, string>)["X-EBAY-API-CALL-NAME"]
    : undefined;
  return ebayBreaker().execute(() =>
    fetchWithEbayRetry(
      () =>
        countedEbayFetch(url, init, opts.timeoutMs ?? EBAY_TIMEOUT_MS, callName),
      { label, ...(opts.retry ?? {}) },
    )
  );
}

export type EbayEnv = "sandbox" | "production";

// All env reads go through here — they trim whitespace from copy-paste and
// treat empty strings as "unset". eBay's OAuth host rejects requests with
// "OAuth client not found" if a single trailing space sneaks into the App ID,
// so be paranoid.
function readEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function getEbayEnv(): EbayEnv {
  const raw = readEnv("EBAY_ENV")?.toLowerCase();
  return raw === "production" ? "production" : "sandbox";
}

export function isEbayConfigured(): boolean {
  return !!(
    readEnv("EBAY_APP_ID") &&
    readEnv("EBAY_CERT_ID") &&
    readEnv("EBAY_RU_NAME")
  );
}

// Sanitized snapshot for the /oauth/debug endpoint. Never returns secrets;
// shows enough for a human to spot env-var problems (env, host, RuName format).
// When `userId` is provided, the snapshot includes per-user connection state
// (account_handle presence) so US-315 backfill can be verified at a glance.
/**
 * The eBay username of this user's active connection, or null.
 *
 * US-2816: needed to tell an offer the seller RECEIVED from one they SENT.
 * GetBestOffers returns both, with no direction field, and the only thing
 * separating them is whether the offer's Buyer is this account.
 *
 * Returns null rather than throwing when there is no connection, no handle,
 * or the read fails: every caller must treat null as 'cannot tell' and leave
 * behaviour unchanged. Guessing wrong here silently hides real offers.
 */
export async function getEbayAccountHandle(
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("account_handle")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const handle = (data as { account_handle: string | null }).account_handle;
  return handle?.trim() || null;
}
export async function debugSnapshot(
  userId?: string,
): Promise<{
  configured: boolean;
  env: EbayEnv;
  auth_host: string;
  api_host: string;
  marketplace_id: string;
  category_tree_id: string;
  app_id_present: boolean;
  app_id_prefix: string | null;
  cert_id_present: boolean;
  dev_id_present: boolean;
  ru_name_present: boolean;
  ru_name_looks_like_url: boolean;
  edge_encryption_key_present: boolean;
  edge_encryption_key_byte_length: number | null;
  account_handle_present: boolean | null;
  /**
   * US-2325 AC4: what eBay says the category tree id should be, next to what we
   * have configured. Null when eBay is not configured at all — there is nothing
   * to ask and a failed call would read as drift.
   */
  category_tree_reconcile: TreeIdReconcile | null;
}> {
  const appId = readEnv("EBAY_APP_ID");
  const ruName = readEnv("EBAY_RU_NAME");
  const encKey = readEnv("EDGE_ENCRYPTION_KEY");
  let keyBytes: number | null = null;
  if (encKey) {
    try {
      keyBytes = atob(encKey).length;
    } catch {
      keyBytes = -1; // signals "not valid base64"
    }
  }

  // Per-user check (US-315): true if this user's active eBay connection has
  // a non-null account_handle. null when no userId was passed (env-only view).
  let accountHandlePresent: boolean | null = null;
  if (userId) {
    accountHandlePresent = (await getEbayAccountHandle(userId)) != null;
  }

  // Asked HERE rather than on a schedule because this is the surface an
  // operator already opens when eBay behaves oddly, and a stale tree id is
  // exactly that class of problem — category suggestions quietly wrong, aspects
  // cached for 30 days against the wrong tree. One extra call on a diagnostics
  // endpoint is not a hot path.
  const treeReconcile = isEbayConfigured()
    ? await reconcileCategoryTreeId()
    : null;

  return {
    configured: isEbayConfigured(),
    env: getEbayEnv(),
    auth_host: authHost(),
    api_host: apiHost(),
    marketplace_id: getMarketplaceId(),
    category_tree_id: getCategoryTreeId(),
    app_id_present: !!appId,
    // Just the leading and trailing characters — enough to confirm SBX vs PRD
    // and spot whitespace, but not enough to leak.
    app_id_prefix: appId
      ? `${appId.slice(0, 12)}…${appId.slice(-6)} (len ${appId.length})`
      : null,
    cert_id_present: !!readEnv("EBAY_CERT_ID"),
    dev_id_present: !!readEnv("EBAY_DEV_ID"),
    ru_name_present: !!ruName,
    // A common confusion: people paste the redirect URL into EBAY_RU_NAME
    // instead of the RuName identifier. Flag that explicitly.
    ru_name_looks_like_url: ruName ? /^https?:\/\//i.test(ruName) : false,
    edge_encryption_key_present: !!encKey,
    edge_encryption_key_byte_length: keyBytes,
    account_handle_present: accountHandlePresent,
    category_tree_reconcile: treeReconcile,
  };
}

// Host resolution. Auth host serves the consent page; API host serves the
// token + REST endpoints.
export function authHost(): string {
  return getEbayEnv() === "production"
    ? "https://auth.ebay.com"
    : "https://auth.sandbox.ebay.com";
}

export function apiHost(): string {
  return getEbayEnv() === "production"
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";
}

// eBay routes some Sell APIs through a separate "apiz" host. Currently only
// Finances — everything else we call (Inventory, Fulfillment, Account,
// Analytics, Taxonomy, Browse, Trading) sits on apiHost().
export function apizHost(): string {
  return getEbayEnv() === "production"
    ? "https://apiz.ebay.com"
    : "https://apiz.sandbox.ebay.com";
}

function getScopes(): string {
  return (
    readEnv("EBAY_SCOPES") ??
    [
      "https://api.ebay.com/oauth/api_scope",
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.marketing",
      "https://api.ebay.com/oauth/api_scope/sell.account",
      // Required by /sell/fulfillment/v1/order for sold-state + sale-row sync.
      // Users connected BEFORE this scope was added must reconnect — old
      // tokens were issued without it and Fulfillment API silently 403s.
      "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
      // Required by /sell/finances/v1/transaction for fees + payout sync
      // (lets sales rows flip from "Pending" to "Cleared" with real numbers).
      "https://api.ebay.com/oauth/api_scope/sell.finances",
      // US-151: required by /sell/analytics/v1/traffic_report for per-listing
      // views/impressions/CTR. Users connected BEFORE this scope was added must
      // reconnect — old tokens 403 the Analytics API, which the performance sync
      // detects and flags (marketplace_connections.analytics_access_denied).
      "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
      // Required by ALL /sell/fulfillment/v1/payment_dispute* methods
      // (ebay-disputes.ts). eBay scopes the payment_dispute resource to its own
      // dedicated scope — sell.fulfillment does NOT cover it, despite the shared
      // URL prefix. Generally available (not eBay-gated). Users connected BEFORE
      // this scope was added must reconnect at /oauth/start — their tokens
      // insufficient-scope every dispute read/accept/contest call.
      "https://api.ebay.com/oauth/api_scope/sell.payment.dispute",
      // NOTE: the two eBay-restricted scopes below are intentionally NOT
      // requested. They are granted in Sandbox but NOT on our Production
      // keyset (eBay gates them behind extra licensing/contracts), so
      // including them makes the production consent screen fail with
      // `invalid_scope` and blocks every (re)connect. Both features degrade
      // without their scope (identity → account_handle stays null; negotiation
      // → /sell/negotiation calls 403). If the production keyset is ever
      // granted them, re-add the line(s) and have sellers re-consent at
      // /oauth/start:
      //   commerce.identity.readonly  (US-315): /commerce/identity/v1/user →
      //     seller account_handle, used by account-deletion webhook matching.
      //   "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
      //   sell.negotiation            (US-673): /sell/negotiation/v1 send-
      //     offer-to-interested-buyers.
      //   "https://api.ebay.com/oauth/api_scope/sell.negotiation",
    ].join(" ")
  );
}

// US-1510: whether this deployment's OAuth consent requests the sell.negotiation
// scope. The default scope list above deliberately omits it (the production
// keyset isn't licensed for it — requesting it fails the whole consent screen),
// so unless EBAY_SCOPES explicitly includes it, every /sell/negotiation call is
// a guaranteed 403. The send-offer surfaces gate on this to return a clean
// `feature_unavailable` instead of letting clients round-trip into that 403.
// Incoming Best Offers (Trading API, sell scope) are NOT affected by this.
export function isNegotiationScopeAvailable(): boolean {
  return getScopes().includes("api_scope/sell.negotiation");
}

// US-2160: same question for sell.logistics (buy a shipping label). The Sell
// Logistics API is a LIMITED RELEASE surface — eBay grants the scope per keyset
// after an application, exactly like sell.negotiation — so it is absent from the
// default list above for the same reason: requesting an unlicensed scope fails
// the whole consent screen and blocks every (re)connect. Every label surface
// gates on this so a seller learns the feature is off BEFORE they try to buy
// postage, instead of discovering it from a 403 mid-checkout.
export function isLogisticsScopeAvailable(): boolean {
  return getScopes().includes("api_scope/sell.logistics");
}

function basicAuthHeader(): string {
  const appId = readEnv("EBAY_APP_ID");
  const certId = readEnv("EBAY_CERT_ID");
  if (!appId || !certId) {
    throw new Error("EBAY_APP_ID / EBAY_CERT_ID are not set.");
  }
  return `Basic ${btoa(`${appId}:${certId}`)}`;
}

// ── User OAuth ──────────────────────────────────────────────────────

export function buildConsentUrl(state: string): string {
  const appId = readEnv("EBAY_APP_ID");
  const ruName = readEnv("EBAY_RU_NAME");
  if (!appId || !ruName) {
    throw new Error("EBAY_APP_ID / EBAY_RU_NAME are not set.");
  }
  const params = new URLSearchParams({
    client_id: appId,
    response_type: "code",
    // eBay's `redirect_uri` parameter takes the RuName, not the URL itself.
    redirect_uri: ruName,
    scope: getScopes(),
    state,
  });
  return `${authHost()}/oauth2/authorize?${params.toString()}`;
}

export interface EbayUserTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  refresh_token: string;
  refresh_token_expires_in: number; // seconds
  token_type: string;
}

// US-315: read the seller's eBay identity (account handle) using a raw token.
// Called directly after exchangeCodeForTokens (no DB row exists yet) and from
// the refresh path's backfill. Returns null on failure — the caller treats it
// as non-fatal so identity outages don't break connect or refresh.
//
// US-472: the account_handle / external_account_id this captures is what
// webhooks link payout/order/return events on, so a transient miss at connect
// time means inbound events for that seller have nothing to match until the next
// token refresh hydrates the row. To make first-connect linkage reliable we now
// RETRY the lookup on a transient failure (network blip / 5xx / 429) with a short
// backoff before giving up. A genuine 4xx (e.g. missing scope) is not retried.
export async function getUserIdentityFromToken(
  accessToken: string,
  attempts = 3,
): Promise<{ username: string | null; externalAccountId: string | null } | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await ebayFetch(`${apiHost()}/commerce/identity/v1/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        },
      });
      if (!res.ok) {
        // 5xx / 429 are worth another try; a 4xx (bad scope/token) is terminal.
        const transient = res.status >= 500 || res.status === 429;
        await res.body?.cancel();
        if (transient && attempt < attempts) {
          await delay(attempt * 300);
          continue;
        }
        console.warn(
          `[ebay-client] identity lookup returned ${res.status} (attempt ${attempt}/${attempts}); account_handle stays null`,
        );
        return null;
      }
      const body = await res.json() as {
        username?: string;
        userId?: string;
      };
      // US-364: capture eBay's stable `userId` (the same id the account-deletion
      // webhook sends) so deletion + webhook linkage can match on it instead of
      // the free-text handle.
      return {
        username: body.username ?? body.userId ?? null,
        externalAccountId: body.userId ?? null,
      };
    } catch (err) {
      // Network/abort errors are transient — retry before giving up.
      if (attempt < attempts) {
        await delay(attempt * 300);
        continue;
      }
      console.warn(
        `[ebay-client] identity lookup threw (attempt ${attempt}/${attempts}):`,
        err,
      );
      return null;
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// US-364: best-effort upstream revocation of a user's eBay grant on disconnect /
// account deletion, so a long-lived refresh token isn't left valid at eBay after
// the connection is removed locally.
//
// eBay does not publish an RFC-7009 revocation endpoint on every keyset, so this
// is gated on `EBAY_TOKEN_REVOKE_URL` ("where supported"). When the env var is
// unset we skip the network call and report "unsupported" — the caller still
// deactivates + nulls the stored tokens regardless. The function NEVER throws;
// revocation is strictly advisory hardening on top of local deactivation.
export async function revokeEbayUserToken(
  token: string,
  tokenType: "refresh_token" | "access_token" = "refresh_token",
): Promise<"revoked" | "unsupported" | "failed"> {
  const revokeUrl = readEnv("EBAY_TOKEN_REVOKE_URL");
  if (!revokeUrl) return "unsupported";
  try {
    const res = await ebayFetch(revokeUrl, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token, token_type_hint: tokenType }),
    });
    // RFC 7009 returns 200 on success AND for an already-invalid token. Treat any
    // 2xx as revoked; a 404/501 means the keyset doesn't expose the endpoint.
    if (res.ok) return "revoked";
    if (res.status === 404 || res.status === 501) return "unsupported";
    console.warn(
      `[ebay-client] token revocation returned ${res.status}; continuing with local deactivation`,
    );
    return "failed";
  } catch (err) {
    console.warn("[ebay-client] token revocation threw (continuing):", err);
    return "failed";
  }
}

export async function exchangeCodeForTokens(
  code: string
): Promise<EbayUserTokenResponse> {
  const ruName = readEnv("EBAY_RU_NAME");
  if (!ruName) throw new Error("EBAY_RU_NAME is not set.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ruName,
  });
  const res = await ebayFetch(`${apiHost()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EbayUserTokenResponse;
}

export interface EbayUserRefreshResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// US-463: classify a token-refresh failure as PERMANENT (the refresh token is
// revoked/expired/invalid — only re-consent fixes it) vs TRANSIENT (5xx / 429 /
// network blip — a later retry can succeed). Pure + unit-tested. refreshUserToken
// throws "eBay token refresh failed (NNN): <body>", so both the OAuth error code
// in the body and the HTTP status are available to classify on.
export function isPermanentEbayAuthFailure(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Canonical OAuth permanent-grant signals from the response body.
  if (
    /\binvalid_grant\b|\binvalid_client\b|\bunauthorized_client\b|\binvalid_scope\b|token_revoked|\brevoked\b/
      .test(msg)
  ) {
    return true;
  }
  // Fall back to the HTTP status in "failed (NNN)": 5xx/429 are transient, other
  // 4xx auth errors (400/401/403) are permanent.
  const status = Number(msg.match(/failed \((\d{3})\)/)?.[1] ?? 0);
  if (status >= 500 || status === 429) return false;
  if (status === 400 || status === 401 || status === 403) return true;
  // Network/timeout/unknown → transient (never deactivate on a blip).
  return false;
}

// Clear, seller-facing reason stored on the connection when we deactivate it, so
// the UI banner can tell them to reconnect.
export const EBAY_RECONNECT_MESSAGE =
  "eBay disconnected: your authorization was revoked or expired. Please reconnect your eBay account.";

// ── US-151: Sell Analytics getTrafficReport ──────────────────────────
//
// Per-listing engagement (views / impressions / click-through-rate) over a
// rolling window. Sell Analytics is a SEPARATE grant beyond basic OAuth — a
// token issued before the sell.analytics.readonly scope was added (or a seller
// whose account lacks Analytics access) gets a 403. The performance sync treats
// that as "access not granted" rather than an error, flips the per-connection
// analytics_access_denied flag, and prompts a reconnect in the UI.

/** True when an error from getTrafficReport means the seller hasn't granted
 *  Sell Analytics access (403 / insufficient-scope) rather than a transient
 *  failure. Such an error must NOT trip retries or the breaker. */
export function isAnalyticsAccessDenied(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 403 || status === 401) return true;
  const ids = (err as { ebayErrorIds?: number[] } | null)?.ebayErrorIds ?? [];
  // 1100 = insufficient permissions / scope on the Analytics API.
  if (ids.includes(1100)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /insufficient (permissions|scope)|not authorized|access.*denied/.test(msg);
}

export interface ListingTraffic {
  /** eBay listing id (platform_listing_id). */
  listingId: string;
  /**
   * ⚠ NULL MEANS "eBay DID NOT REPORT IT", AND ZERO MEANS ZERO. These were
   * plain numbers until US-2835, and a metric eBay never sent arrived as 0 —
   * which is how six weeks of unparsed reports read as six weeks of no traffic.
   * A caller that needs a number must decide what an absent one means; it is
   * not this function's decision to make it a 0.
   */
  views: number | null;
  impressions: number | null;
  /** Click-through-rate as a fraction (0-1), or null when eBay omits it. */
  clickThroughRate: number | null;
}

/**
 * The shape eBay's sell/analytics traffic_report actually returns.
 *
 * ⚠ `metrics` IS THE REAL FIELD. eBay's srl:Header type carries `dimensionKeys`
 * and `metrics`; `metricKeys` was this file's invention and is why US-2835
 * happened. It stays here, optional, so a body carrying the old spelling still
 * parses rather than becoming zeros — but nothing in production sends it.
 *
 * Every field is optional because eBay omits them freely, and that permissive-
 * ness is exactly what let a wrong name go unnoticed: `header.metricKeys` on a
 * body that has no such key is `undefined`, not a type error. The parser now
 * refuses instead of coping.
 */
export interface TrafficReportResponse {
  header?: {
    dimensionKeys?: Array<{ key?: string }>;
    /** eBay's real spelling. */
    metrics?: Array<{ key?: string }>;
    /** Legacy/defensive. Never sent by the live API. */
    metricKeys?: Array<{ key?: string }>;
  };
  records?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ applicable?: boolean; value?: string | null }>;
  }>;
}

/**
 * Thrown when a traffic report carries records but no metric header we can map.
 *
 * The whole point of US-2835: the old code answered that case with zeros, which
 * is indistinguishable from a seller having no traffic. An exception reaches a
 * log; 7,352 rows of zeros did not.
 */
export class TrafficReportShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrafficReportShapeError";
  }
}

/**
 * Pull a per-listing traffic report for the trailing `days` (default 7).
 * Returns one row per listing eBay reports engagement for; listings with no
 * activity may be absent. Throws on a real API error — callers classify with
 * isAnalyticsAccessDenied to handle the no-access case gracefully.
 */
export async function getTrafficReport(
  userId: string,
  days = 7,
): Promise<ListingTraffic[]> {
  // eBay's date filter is an inclusive YYYYMMDD..YYYYMMDD range; metrics lag a
  // day so the window ends "yesterday".
  const end = new Date(Date.now() - 24 * 60 * 60_000);
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60_000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const marketplaceId = getMarketplaceId();

  // Metric order we request — parsed back by index from header.metricKeys.
  const metrics = [
    "LISTING_IMPRESSION_TOTAL",
    "LISTING_VIEWS_TOTAL",
    "CLICK_THROUGH_RATE",
  ];
  const filter =
    `marketplace_ids:{${marketplaceId}},` +
    `date_range:[${ymd(start)}..${ymd(end)}]`;
  const qs = new URLSearchParams({
    dimension: "LISTING",
    metric: metrics.join(","),
    filter,
    sort: "LISTING_VIEWS_TOTAL",
  });

  const report = await fetchAuthed<TrafficReportResponse>(
    userId,
    `/sell/analytics/v1/traffic_report?${qs.toString()}`,
  );

  return parseTrafficReport(report);
}

/**
 * Turn one traffic_report body into rows. Pure: no eBay, no database, no clock.
 *
 * US-2835 EXTRACTED THIS SO IT COULD BE TESTED AT ALL. It lived inline inside
 * getTrafficReport, behind a token and a network call, and had no test of any
 * kind — which is how it read the wrong header field for six weeks while
 * writing 7,352 rows of zeros that looked exactly like "no traffic".
 */
export function parseTrafficReport(
  report: TrafficReportResponse,
): ListingTraffic[] {
  // Map header metric keys -> column index so we don't depend on eBay echoing
  // our requested order. `metrics` is eBay's real field; `metricKeys` is the
  // name this file used to read and is kept only as a fallback.
  const metricCols = new Map<string, number>();
  const defs = report.header?.metrics ?? report.header?.metricKeys ?? [];
  defs.forEach((m, i) => {
    if (m?.key) metricCols.set(m.key, i);
  });

  const records = report.records ?? [];

  // THE REFUSAL THAT WOULD HAVE SAVED SIX WEEKS. Records but no mappable metric
  // header means the response shape is not the one this parser understands.
  // Returning zeros for it is indistinguishable from a seller with no traffic,
  // which is precisely why nobody noticed. An empty report with no records is
  // not this case: there is nothing to map and nothing that needed mapping.
  if (records.length > 0 && metricCols.size === 0) {
    throw new TrafficReportShapeError(
      "traffic_report returned " + records.length +
        " record(s) but no mappable metric header. Expected header.metrics " +
        "(eBay srl:Header); saw keys: " +
        JSON.stringify(Object.keys(report.header ?? {})),
    );
  }

  /** The metric, or null when eBay did not report a usable value for it. */
  const num = (
    vals: Array<{ applicable?: boolean; value?: string | null }>,
    key: string,
  ): number | null => {
    const i = metricCols.get(key);
    if (i == null) return null;
    const cell = vals[i];
    if (!cell) return null;
    // eBay's Value type carries `applicable`; false means the metric does not
    // apply to this row. Reading that as 0 is the same lie by a smaller margin.
    if (cell.applicable === false) return null;
    if (cell.value == null || cell.value === "") return null;
    const n = Number(cell.value);
    return Number.isFinite(n) ? n : null;
  };

  const out: ListingTraffic[] = [];
  for (const rec of records) {
    const listingId = rec.dimensionValues?.[0]?.value;
    if (!listingId) continue;
    const vals = rec.metricValues ?? [];
    const impressions = num(vals, "LISTING_IMPRESSION_TOTAL");
    const views = num(vals, "LISTING_VIEWS_TOTAL");
    const ctr = num(vals, "CLICK_THROUGH_RATE");

    // A record eBay reported nothing usable for carries no information. It used
    // to become a row of zeros, and 7,352 of those is what this story is about.
    if (impressions == null && views == null && ctr == null) continue;

    out.push({
      listingId,
      impressions: impressions == null ? null : Math.round(impressions),
      views: views == null ? null : Math.round(views),
      // eBay returns CTR as a percentage (e.g. 4.2 = 4.2%); store a fraction.
      clickThroughRate: ctr == null ? null : ctr / 100,
    });
  }
  return out;
}

// ── US-1473: Sell Analytics account-health signals ───────────────────
//
// Account-LEVEL health, distinct from per-listing traffic above: the Seller
// Standards profile (Top Rated / Above / Below Standard, current + projected)
// and the customer-service defect metrics. Same `sell.analytics.readonly` grant
// as getTrafficReport, so `isAnalyticsAccessDenied` classifies a no-access 403
// here too, and the sync treats it as "not granted" rather than an error.

export type SellerStandardsLevel =
  | "TOP_RATED"
  | "ABOVE_STANDARD"
  | "BELOW_STANDARD"
  | string;

export interface SellerStandardsProfile {
  cycle: "CURRENT" | "PROJECTED";
  program: string;
  standardsLevel: SellerStandardsLevel | null;
  evaluationDate: string | null;
  evaluationReason: string | null;
}

interface SellerStandardsResponse {
  standardsLevel?: string;
  program?: string;
  cycle?: string;
  evaluationDate?: string;
  evaluationReason?: string;
}

// The Seller Standards "program" the account is evaluated under is
// marketplace-specific. Most markets roll up to PROGRAM_GLOBAL; the US, UK, and
// Germany-cluster run their own program.
function standardsProgramFor(marketplaceId: string): string {
  switch (marketplaceId) {
    case "EBAY_US":
      return "PROGRAM_US";
    case "EBAY_GB":
      return "PROGRAM_UK";
    case "EBAY_DE":
    case "EBAY_AT":
    case "EBAY_CH":
      return "PROGRAM_DE";
    default:
      return "PROGRAM_GLOBAL";
  }
}

/**
 * The seller's standards profile for one evaluation `cycle` (CURRENT =
 * last completed evaluation; PROJECTED = where the account is trending). Throws
 * on a real API error — callers classify with `isAnalyticsAccessDenied` for the
 * no-access case.
 */
export async function getSellerStandardsProfile(
  userId: string,
  cycle: "CURRENT" | "PROJECTED" = "CURRENT",
): Promise<SellerStandardsProfile> {
  const program = standardsProgramFor(getMarketplaceId());
  const data = await fetchAuthed<SellerStandardsResponse>(
    userId,
    `/sell/analytics/v1/seller_standards_profile/${program}/${cycle}`,
  );
  return {
    cycle,
    program: data.program ?? program,
    standardsLevel: data.standardsLevel ?? null,
    evaluationDate: data.evaluationDate ?? null,
    evaluationReason: data.evaluationReason ?? null,
  };
}

export type CustomerServiceMetricType =
  | "ITEM_NOT_AS_DESCRIBED"
  | "ITEM_NOT_RECEIVED";

export interface CustomerServiceMetricResult {
  metricType: CustomerServiceMetricType;
  cycle: "CURRENT" | "PROJECTED";
  /** The seller's own defect rate for the metric (fraction 0–1), or null. */
  rate: number | null;
  /** The seller's own defect count for the metric, or null. */
  count: number | null;
}

interface CustomerServiceMetricResponse {
  customerServiceMetricStatistics?: Array<{
    metricValues?: Array<{ basis?: string; value?: string | number | null }>;
  }>;
}

/**
 * A single customer-service defect metric for the account. eBay's response
 * nests statistics by peer-benchmark basis; we extract only the seller's own
 * value (`basis: "SELLER"`) defensively and return nulls when the shape doesn't
 * carry it, so a card degrades to "—" rather than throwing.
 */
export async function getCustomerServiceMetric(
  userId: string,
  metricType: CustomerServiceMetricType,
  cycle: "CURRENT" | "PROJECTED" = "CURRENT",
): Promise<CustomerServiceMetricResult> {
  const data = await fetchAuthed<CustomerServiceMetricResponse>(
    userId,
    `/sell/analytics/v1/customer_service_metric/${metricType}/${cycle}`,
  );
  let rate: number | null = null;
  let count: number | null = null;
  for (const stat of data.customerServiceMetricStatistics ?? []) {
    for (const mv of stat.metricValues ?? []) {
      const n = Number(mv.value);
      if (!Number.isFinite(n)) continue;
      // eBay reports the seller's own figure under the SELLER basis; peer
      // benchmarks use other bases we deliberately ignore here.
      if (mv.basis === "SELLER") {
        // A rate arrives as a percentage (e.g. 1.2 = 1.2%); a count is an int.
        if (n <= 100 && !Number.isInteger(n)) rate = n / 100;
        else count = Math.round(n);
      }
    }
  }
  return { metricType, cycle, rate, count };
}

// ── US-1422: Sell Compliance — Listing Health ───────────────────────
//
// eBay's Compliance API flags listings that violate policy or are missing
// required item specifics (ASPECTS_ADOPTION etc.). A reseller running hundreds
// of AI-generated listings accumulates these silently → search demotion / hidden
// listings. Uses the sell.inventory grant (already requested), so a token issued
// before that scope 403s — isAnalyticsAccessDenied classifies that no-access
// case here too (same 403/1100 shape), and callers degrade gracefully.

export interface ListingViolationSummary {
  /** e.g. ASPECTS_ADOPTION, PRODUCT_ADOPTION, HTTPS, OUTSIDE_EBAY_BUYING. */
  complianceType: string;
  listingCount: number;
}

interface ViolationSummaryResponse {
  violationSummaries?: Array<{
    complianceType?: string;
    listingCount?: number;
  }>;
}

/**
 * Per-compliance-type counts of the seller's non-compliant listings. Throws on a
 * real API error; a no-access 403 (isAnalyticsAccessDenied) is handled by the
 * caller as "not available".
 */
export async function getListingViolationsSummary(
  userId: string,
): Promise<ListingViolationSummary[]> {
  const data = await fetchAuthed<ViolationSummaryResponse>(
    userId,
    `/sell/compliance/v1/listing_violation_summary`,
  );
  const out: ListingViolationSummary[] = [];
  for (const s of data.violationSummaries ?? []) {
    if (!s.complianceType) continue;
    out.push({
      complianceType: s.complianceType,
      listingCount: Number(s.listingCount ?? 0) || 0,
    });
  }
  return out;
}

export interface AspectRecommendation {
  name: string;
  values: string[];
}

export interface ListingViolationDetail {
  listingId: string | null;
  sku: string | null;
  offerId: string | null;
  complianceType: string;
  /** Human-readable reasons eBay returned for this listing. */
  reasons: string[];
  /** correctiveRecommendations.aspectRecommendations, for one-click revise (AC3). */
  aspectRecommendations: AspectRecommendation[];
}

interface ViolationDetailResponse {
  listingViolations?: Array<{
    listingId?: string;
    sku?: string;
    offerId?: string;
    complianceType?: string;
    violations?: Array<{ message?: string; reason?: string }>;
    correctiveRecommendations?: {
      aspectRecommendations?: Array<{ name?: string; values?: string[] }>;
    };
  }>;
  total?: number;
}

/**
 * Per-listing violation detail for one compliance type (e.g. ASPECTS_ADOPTION),
 * including eBay's corrective aspect recommendations so a future one-click revise
 * (US-1422 AC3) can apply them via updateOffer / inventory_item.
 */
export async function getListingViolations(
  userId: string,
  complianceType: string,
  limit = 50,
): Promise<ListingViolationDetail[]> {
  const qs = new URLSearchParams({
    compliance_type: complianceType,
    limit: String(limit),
  });
  const data = await fetchAuthed<ViolationDetailResponse>(
    userId,
    `/sell/compliance/v1/listing_violation?${qs.toString()}`,
  );
  const out: ListingViolationDetail[] = [];
  for (const v of data.listingViolations ?? []) {
    out.push({
      listingId: v.listingId ?? null,
      sku: v.sku ?? null,
      offerId: v.offerId ?? null,
      complianceType: v.complianceType ?? complianceType,
      reasons: (v.violations ?? [])
        .map((r) => r.message ?? r.reason ?? "")
        .filter((s) => s.length > 0),
      aspectRecommendations: (v.correctiveRecommendations?.aspectRecommendations ?? [])
        .filter((a) => a.name)
        .map((a) => ({ name: a.name as string, values: a.values ?? [] })),
    });
  }
  return out;
}

export async function refreshUserToken(
  refreshToken: string
): Promise<EbayUserRefreshResponse> {
  // IMPORTANT: do NOT send `scope` here. Per OAuth 2.0, when scope is omitted
  // the issued access token inherits the scopes the refresh token already
  // grants. Adding a new scope to getScopes() (e.g. commerce.identity.readonly
  // in US-315) without omitting `scope` here breaks every pre-existing
  // connection with `invalid_scope` — eBay refuses to upgrade scopes during
  // refresh. New scopes can only be granted by re-consenting at /oauth/start.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await ebayFetch(`${apiHost()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EbayUserRefreshResponse;
}

// Persists or rotates a user's eBay connection. `accountHandle` is the
// stable handle we derive at the callback (eBay returns it later via
// /commerce/identity/v1/user — for now we store null on first connect).
//
// We can't rely on Postgres' UNIQUE(user_id, marketplace, account_handle)
// for upsert: NULLs are distinct in unique indexes, so a null handle on
// reconnect would always create a new row. Find-or-insert instead.
export async function upsertConnection(args: {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  accountHandle?: string | null;
  externalAccountId?: string | null;
}): Promise<void> {
  // US-352: bind the ciphertext to the owning user_id (AES-GCM AAD) so a token
  // blob can't be replayed onto another tenant's connection row.
  const access = await encryptToken(args.accessToken, { aad: args.userId });
  const refresh = await encryptToken(args.refreshToken, { aad: args.userId });
  const expiresAt = new Date(
    Date.now() + args.accessExpiresInSeconds * 1000
  ).toISOString();
  const handle = args.accountHandle ?? null;

  const lookup = supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", args.userId)
    .eq("marketplace", "ebay");
  const { data: existing, error: lookupErr } = handle === null
    ? await lookup.is("account_handle", null).maybeSingle()
    : await lookup.eq("account_handle", handle).maybeSingle();

  if (lookupErr) {
    throw new Error(`Failed to look up eBay connection: ${lookupErr.message}`);
  }

  // Reset last_synced_at to null on every (re)connect so the next sync's
  // orders pass falls back to the 90-day window. Otherwise reconnecting
  // after a scope upgrade would still miss historical orders because the
  // filter floor is "now".
  const patch: Record<string, unknown> = {
    access_token_encrypted: access,
    refresh_token_encrypted: refresh,
    token_expires_at: expiresAt,
    scopes: getScopes().split(" "),
    is_active: true,
    last_synced_at: null,
    refresh_error: null,
  };
  // US-364: persist eBay's stable user id so account-deletion can match on it.
  // Only write when we actually have one — never clobber a stored id with null
  // (identity lookup is best-effort and may fail on a reconnect).
  if (args.externalAccountId) {
    patch.external_account_id = args.externalAccountId;
  }

  if (existing) {
    const { error } = await supabaseAdmin
      .from("marketplace_connections")
      .update(patch)
      .eq("id", existing.id as string);
    if (error) {
      throw new Error(`Failed to update eBay connection: ${error.message}`);
    }
    return;
  }

  const { error } = await supabaseAdmin
    .from("marketplace_connections")
    .insert({
      user_id: args.userId,
      marketplace: "ebay",
      account_handle: handle,
      ...patch,
    });
  if (error) {
    throw new Error(`Failed to insert eBay connection: ${error.message}`);
  }

  // US-1849: reward the platform-stickiness moment on a NEW connection only
  // (this branch is the first-connect path; reconnects hit the update branch
  // above). Idempotent on marketplace+account so a disconnect/reconnect of the
  // same account never double-awards. Best-effort — never fail the connect.
  await grantMarketplaceConnectedReward(
    args.userId,
    "ebay",
    handle ?? args.externalAccountId,
  );
}

// Returns a valid user access token, refreshing if it expires within 60s.
// Throws if the user has no eBay connection or refresh fails permanently.
export async function getUserAccessToken(userId: string): Promise<string> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select(
      "id, access_token_encrypted, refresh_token_encrypted, token_expires_at, account_handle, external_account_id"
    )
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: when the user has more than one connected eBay account, the one
    // they've selected (is_primary) wins; otherwise fall back to the most
    // recently updated (the historical single-connection behavior).
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load eBay connection: ${error.message}`);
  }
  if (!row) {
    throw new Error("No active eBay connection for this user.");
  }

  return await tokenFromConnectionRow(row as EbayConnectionTokenRow, userId);
}

// US-1507: the marketplace_connections columns tokenFromConnectionRow needs.
type EbayConnectionTokenRow = {
  id: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
  account_handle?: string | null;
  external_account_id?: string | null;
};

// US-1507: resolve a valid access token for a SPECIFIC eBay connection — the one
// that owns a listing — scoped to the caller so a listing can never borrow another
// user's grant. Throws the SAME "No active eBay connection" message getUserAccessToken
// uses, so end/price/revise's isNoEbayConnectionError branch surfaces the friendly
// "reconnect this account" 409 instead of a raw 500 when that connection is gone.
export async function getConnectionAccessToken(
  connectionId: string,
  userId: string,
): Promise<string> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select(
      "id, access_token_encrypted, refresh_token_encrypted, token_expires_at, account_handle, external_account_id"
    )
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load eBay connection: ${error.message}`);
  }
  if (!row) {
    throw new Error("No active eBay connection for this user.");
  }
  return await tokenFromConnectionRow(row as EbayConnectionTokenRow, userId);
}

// Shared token-refresh core (US-1507 extraction): given a connection row, return a
// valid access token, refreshing (and opportunistically backfilling account handle
// / external id) when it expires within 60s. Behavior is byte-for-byte the previous
// getUserAccessToken tail — just callable for a non-primary connection too.
async function tokenFromConnectionRow(
  row: EbayConnectionTokenRow,
  userId: string,
): Promise<string> {
  const expiresAt = row.token_expires_at
    ? new Date(row.token_expires_at).getTime()
    : 0;
  const refreshNeeded = !expiresAt || expiresAt - Date.now() < 60_000;

  // US-352: pass the user_id as AAD. Legacy v1 ciphertexts were written without
  // AAD and decryptToken ignores the option for them, so this is back-compatible.
  if (!refreshNeeded) {
    return await decryptToken(row.access_token_encrypted as string, { aad: userId });
  }

  const refreshToken = await decryptToken(
    row.refresh_token_encrypted as string,
    { aad: userId },
  );
  try {
    const fresh = await refreshUserToken(refreshToken);
    const encryptedAccess = await encryptToken(fresh.access_token, { aad: userId });
    const expiresAtNew = new Date(
      Date.now() + fresh.expires_in * 1000
    ).toISOString();
    // US-315: opportunistically backfill account_handle for connections that
    // pre-date the commerce.identity scope or for which identity lookup
    // previously failed. Non-fatal — keeps the refresh path simple.
    const accountHandlePatch: Record<string, unknown> = {};
    const needsHandle =
      (row as { account_handle: string | null }).account_handle == null;
    const needsExternalId =
      (row as { external_account_id?: string | null }).external_account_id == null;
    if (needsHandle || needsExternalId) {
      const identity = await getUserIdentityFromToken(fresh.access_token);
      if (needsHandle && identity?.username) {
        accountHandlePatch.account_handle = identity.username;
      }
      // US-364: backfill the stable id on rows that pre-date the column.
      if (needsExternalId && identity?.externalAccountId) {
        accountHandlePatch.external_account_id = identity.externalAccountId;
      }
    }
    await supabaseAdmin
      .from("marketplace_connections")
      .update({
        access_token_encrypted: encryptedAccess,
        token_expires_at: expiresAtNew,
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_error: null,
        ...accountHandlePatch,
      })
      .eq("id", row.id);
    return fresh.access_token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permanent = isPermanentEbayAuthFailure(err);
    // US-463: a PERMANENT failure (revoked/expired refresh token) will never
    // recover by retry — deactivate the connection and store a clear reconnect
    // message so the UI prompts re-auth and the refresh cron stops hammering a
    // dead grant. A TRANSIENT failure (5xx/429/network) leaves is_active=true so
    // the next attempt can succeed.
    await supabaseAdmin
      .from("marketplace_connections")
      .update({
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_error: permanent ? EBAY_RECONNECT_MESSAGE : msg.slice(0, 500),
        ...(permanent ? { is_active: false } : {}),
      })
      .eq("id", row.id);
    if (permanent) {
      console.warn(
        `[ebay] permanent refresh failure — deactivated connection ${row.id}: ${msg.slice(0, 200)}`,
      );
    }
    throw err;
  }
}

// ── Taxonomy helpers ────────────────────────────────────────────────

export function getMarketplaceId(): string {
  return readEnv("EBAY_MARKETPLACE_ID") ?? "EBAY_US";
}

export function getCategoryTreeId(): string {
  return readEnv("EBAY_CATEGORY_TREE_ID") ?? "0";
}

/**
 * The currency of the configured marketplace (US-3098).
 *
 * eBay's Browse `price` filter is rejected with a 400 unless `priceCurrency`
 * rides alongside it, and the error names neither field — so a max-price filter
 * without this looks like a broken search rather than a missing parameter.
 *
 * A small map rather than a lookup: these are the marketplaces the product
 * supports, and an unknown one falls back to USD, which is what every other
 * currency default in this file does.
 */
export function getMarketplaceCurrency(): string {
  const byMarketplace: Record<string, string> = {
    EBAY_US: "USD",
    EBAY_CA: "CAD",
    EBAY_GB: "GBP",
    EBAY_AU: "AUD",
    EBAY_DE: "EUR",
    EBAY_FR: "EUR",
    EBAY_IT: "EUR",
    EBAY_ES: "EUR",
    EBAY_IE: "EUR",
  };
  return byMarketplace[getMarketplaceId()] ?? "USD";
}

/**
 * US-2325 AC4: check the CONFIGURED category tree id against eBay's own answer.
 *
 * `getCategoryTreeId()` reads an env var and falls back to "0". Nothing ever
 * asked eBay whether that is still right, and eight call sites depend on it —
 * category suggestion, aspect metadata, the lot. eBay versions its taxonomy per
 * marketplace, so a bump silently points every one of those at a stale tree,
 * and because aspects are cached for 30 days (ASPECT_TTL_MS) the wrong answers
 * stay warm for up to a month before anything looks different.
 *
 * Deliberately REPORTS rather than self-heals. Switching tree ids underneath a
 * running catalogue would invalidate cached aspects and change category
 * suggestions mid-session; which tree to use is an operator decision, and the
 * job here is to make the drift visible instead of silent.
 *
 * `deps` is injectable so this is testable without a live eBay call.
 */
export interface TreeIdReconcile {
  configured: string;
  actual: string | null;
  matches: boolean;
  /** False when eBay could not be asked — never render that as "matches". */
  checked: boolean;
  detail: string;
}

export async function reconcileCategoryTreeId(
  deps: {
    doFetch?: (url: string) => Promise<Response>;
    marketplaceId?: string;
    configured?: string;
  } = {},
): Promise<TreeIdReconcile> {
  const configured = deps.configured ?? getCategoryTreeId();
  const marketplaceId = deps.marketplaceId ?? getMarketplaceId();
  const url = `${apiHost()}/commerce/taxonomy/v1/get_default_category_tree_id` +
    `?marketplace_id=${encodeURIComponent(marketplaceId)}`;

  try {
    const res = deps.doFetch
      ? await deps.doFetch(url)
      : await ebayResilientFetch(url, {
        headers: { Authorization: `Bearer ${await getAppAccessToken()}` },
      }, { label: "Taxonomy get_default_category_tree_id" });
    if (!res.ok) {
      return {
        configured,
        actual: null,
        matches: false,
        checked: false,
        detail: `eBay returned HTTP ${res.status}`,
      };
    }
    const json = await res.json() as { categoryTreeId?: string };
    const actual = typeof json.categoryTreeId === "string"
      ? json.categoryTreeId
      : null;
    if (actual === null) {
      return {
        configured,
        actual: null,
        matches: false,
        checked: false,
        detail: "response carried no categoryTreeId",
      };
    }
    const matches = actual === configured;
    if (!matches) {
      console.error(
        `[ebay-client] CATEGORY TREE DRIFT for ${marketplaceId}: configured ` +
          `${configured}, eBay says ${actual}. Category suggestions and cached ` +
          `aspects are being read from the wrong tree. Set ` +
          `EBAY_CATEGORY_TREE_ID=${actual} and expire ebay_category_aspects.`,
      );
    }
    return {
      configured,
      actual,
      matches,
      checked: true,
      detail: matches
        ? "configured tree id matches eBay"
        : `configured ${configured}, eBay says ${actual}`,
    };
  } catch (err) {
    // Fails CLOSED in the sense that matters: checked:false means "we do not
    // know", which must never be rendered as agreement.
    return {
      configured,
      actual: null,
      matches: false,
      checked: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  categoryTreePath: string; // "Clothing › Men › Suits & Blazers › Blazers"
}

export async function suggestCategories(
  query: string
): Promise<CategorySuggestion[]> {
  const token = await getAppAccessToken();
  const url =
    `${apiHost()}/commerce/taxonomy/v1/category_tree/${getCategoryTreeId()}` +
    `/get_category_suggestions?q=${encodeURIComponent(query)}`;
  const res = await ebayFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      "Accept-Language": "en-US",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay category suggest failed (${res.status}): ${text.slice(0, 300)}`
    );
  }
  const payload = (await res.json()) as {
    categorySuggestions?: Array<{
      category: { categoryId: string; categoryName: string };
      categoryTreeNodeAncestors?: Array<{ categoryName: string }>;
    }>;
  };

  return (payload.categorySuggestions ?? []).map((sugg) => {
    const ancestors = (sugg.categoryTreeNodeAncestors ?? [])
      .map((a) => a.categoryName)
      .reverse(); // eBay returns leaf-first; show root-first.
    const path = [...ancestors, sugg.category.categoryName].join(" › ");
    return {
      categoryId: sugg.category.categoryId,
      categoryName: sugg.category.categoryName,
      categoryTreePath: path,
    };
  });
}

// US-1893: leaf-category guard support.
//
// A category with a cached, NON-EMPTY aspects payload is a proven LEAF: eBay's
// get_item_aspects_for_category only returns aspects for leaf categories, so a
// populated cache row is proof of leaf-ness. This lets the publish leaf-guard
// pass any already-validated category with zero live Taxonomy calls. A row that
// only has a cached category_name (aspects still null) is NOT proof and returns
// false, so the guard falls through to the live probe.
export async function categoryHasCachedLeafAspects(
  categoryId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("ebay_category_aspects")
    .select("aspects")
    .eq("marketplace_id", getMarketplaceId())
    .eq("category_tree_id", getCategoryTreeId())
    .eq("category_id", categoryId)
    .maybeSingle();
  if (error) return false;
  const body = data?.aspects as { aspects?: unknown } | null;
  return Array.isArray(body?.aspects) && body.aspects.length > 0;
}

// Live Taxonomy probe: does this category id resolve to a listable LEAF node?
// Reads `leafCategoryTreeNode` from get_category_subtree (falling back to the
// presence of child nodes). A 400/404 for the id means it isn't in the tree
// (unknown); a transient 5xx / network error returns "unverified" so the guard
// can fail open rather than block a publish on our outage.
export async function fetchCategoryLeafStatus(
  categoryId: string,
): Promise<"leaf" | "non_leaf" | "not_found" | "unverified"> {
  const marketplaceId = getMarketplaceId();
  const treeId = getCategoryTreeId();
  try {
    const token = await getAppAccessToken();
    const url =
      `${apiHost()}/commerce/taxonomy/v1/category_tree/${treeId}` +
      `/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`;
    const res = await ebayFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        "Accept-Language": "en-US",
      },
    });
    // eBay returns 400 (invalid category_id) or 404 for an id not in the tree.
    if (res.status === 400 || res.status === 404) return "not_found";
    if (!res.ok) return "unverified"; // transient (5xx / rate limit) → fail open.
    const payload = (await res.json()) as {
      categorySubtreeNode?: {
        category?: { categoryId?: string };
        leafCategoryTreeNode?: boolean;
        childCategoryTreeNodes?: unknown[];
      };
    };
    const node = payload.categorySubtreeNode;
    if (!node?.category?.categoryId) return "not_found";
    const isLeaf =
      node.leafCategoryTreeNode === true ||
      (node.leafCategoryTreeNode === undefined &&
        (!Array.isArray(node.childCategoryTreeNodes) ||
          node.childCategoryTreeNodes.length === 0));
    return isLeaf ? "leaf" : "non_leaf";
  } catch (err) {
    console.error("[ebay-client] category leaf-status lookup failed:", err);
    return "unverified";
  }
}

// Resolves a category id to its human-readable name + breadcrumb path
// (e.g. "Clothing › Men › Suits & Blazers › Blazers"). Cached in
// ebay_category_aspects.category_name so repeated lookups are free.
//
// NOTE: this only populates the cache. If the category isn't already in the
// cache from a prior aspects fetch, this resolves the full ancestor path live
// (see fetchCategoryBreadcrumb) and stores the WHOLE breadcrumb in
// category_name so the next lookup is free.
export interface CategoryNameInfo {
  id: string;
  name: string;
  path: string; // root → leaf breadcrumb
}

// The leaf segment of a breadcrumb path ("Clothing › Men › … › Jeans" → "Jeans").
function leafOfPath(path: string): string {
  const parts = path.split(" › ");
  return parts[parts.length - 1]!.trim() || path;
}

// Resolve a category id to a FULL breadcrumb path via the Taxonomy API.
//
// eBay has no "ancestors by id" endpoint: get_category_subtree returns only the
// node's own name (no ancestors). So we (1) get the leaf name from the subtree,
// then (2) re-query get_category_suggestions with that leaf name and pick the
// suggestion whose id matches ours — that response carries the ancestor chain
// (categoryTreePath). When the leaf name is ambiguous and no suggestion matches
// our exact id, we fall back to the leaf name alone (still far better than a raw
// numeric id). No caching here — callers cache the result.
async function fetchCategoryBreadcrumb(
  categoryId: string
): Promise<{ name: string; path: string } | null> {
  const marketplaceId = getMarketplaceId();
  const treeId = getCategoryTreeId();
  let leafName: string | null = null;
  try {
    const token = await getAppAccessToken();
    const url =
      `${apiHost()}/commerce/taxonomy/v1/category_tree/${treeId}` +
      `/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`;
    const res = await ebayFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        "Accept-Language": "en-US",
      },
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as {
      categorySubtreeNode?: {
        category?: { categoryId?: string; categoryName?: string };
      };
    };
    leafName = payload.categorySubtreeNode?.category?.categoryName ?? null;
  } catch (err) {
    console.error("[ebay-client] category subtree lookup failed:", err);
    return null;
  }
  if (!leafName) return null;

  // Build the ancestor breadcrumb by matching our id in the suggestions for
  // the leaf name. Best-effort — fall back to the leaf name alone.
  try {
    const suggestions = await suggestCategories(leafName);
    const match = suggestions.find((s) => s.categoryId === categoryId);
    if (match) return { name: match.categoryName, path: match.categoryTreePath };
  } catch (err) {
    console.error("[ebay-client] breadcrumb ancestor lookup failed:", err);
  }
  return { name: leafName, path: leafName };
}

export async function getCategoryName(
  categoryId: string
): Promise<CategoryNameInfo | null> {
  const marketplaceId = getMarketplaceId();
  const treeId = getCategoryTreeId();

  // Read-through cache first — most categories the user touches are
  // already there from the composer's aspects fetch. category_name holds the
  // FULL breadcrumb path once resolved.
  const { data: cached } = await supabaseAdmin
    .from("ebay_category_aspects")
    .select("category_name, aspects")
    .eq("marketplace_id", marketplaceId)
    .eq("category_tree_id", treeId)
    .eq("category_id", categoryId)
    .maybeSingle();

  if (cached?.category_name) {
    const path = cached.category_name as string;
    return { id: categoryId, name: leafOfPath(path), path };
  }

  // Not cached (or only aspects were cached with a null name) — resolve the
  // full breadcrumb live and cache it.
  const bc = await fetchCategoryBreadcrumb(categoryId);
  if (!bc) return null;

  // Cache it for next time. Don't clobber aspects when they're already present.
  await supabaseAdmin.from("ebay_category_aspects").upsert(
    {
      marketplace_id: marketplaceId,
      category_tree_id: treeId,
      category_id: categoryId,
      category_name: bc.path,
      aspects: cached?.aspects ?? {},
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "marketplace_id,category_tree_id,category_id" }
  );

  return { id: categoryId, name: bc.name, path: bc.path };
}

// Aspect cache TTL. This was 30 days on the reasoning that aspects change
// rarely. eBay's standardized-size enforcement (rolling out by site from
// 2026-08-31 through 2026-10-20) is the counter-example: Size and Size Type
// flipped from SUGGESTED to closed lists site by site, and a month-old cached
// mode let a custom value through to a publish that eBay then rejected. Seven
// days bounds how long a flipped aspect can be misread; the publish path also
// refreshes a category on the spot when eBay rejects a custom value
// (lib/ebay-size-enforcement.ts).
const ASPECT_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Drop a category's cached Taxonomy payload so the next read fetches it live.
 * Used when eBay's own answer proves the cache stale (a custom-value rejection
 * for an aspect the cache still calls free text).
 */
export async function invalidateCategoryAspects(categoryId: string): Promise<void> {
  await supabaseAdmin
    .from("ebay_category_aspects")
    .delete()
    .eq("marketplace_id", getMarketplaceId())
    .eq("category_tree_id", getCategoryTreeId())
    .eq("category_id", categoryId);
}

export interface AspectMetadata {
  // Verbatim from eBay's getItemAspectsForCategory. Shape:
  //   { aspects: [{ localizedAspectName, aspectConstraint, aspectValues }, …] }
  aspects: Record<string, unknown>;
  categoryName?: string | null;
  cached: boolean;
}

export async function getCategoryAspects(
  categoryId: string,
  opts: { fresh?: boolean } = {},
): Promise<AspectMetadata> {
  const marketplaceId = getMarketplaceId();
  const treeId = getCategoryTreeId();

  // Read-through cache.
  const { data: cached } = await supabaseAdmin
    .from("ebay_category_aspects")
    .select("aspects, category_name, fetched_at")
    .eq("marketplace_id", marketplaceId)
    .eq("category_tree_id", treeId)
    .eq("category_id", categoryId)
    .maybeSingle();

  if (
    !opts.fresh &&
    cached &&
    Date.now() - new Date(cached.fetched_at as string).getTime() < ASPECT_TTL_MS
  ) {
    // Lazily backfill the breadcrumb if this entry was cached aspects-only
    // (category_name null) — so already-saved categories show the human path
    // instead of a raw id without waiting for the 30-day aspect TTL to lapse.
    let name = (cached.category_name as string | null) ?? null;
    if (!name) {
      const bc = await fetchCategoryBreadcrumb(categoryId).catch(() => null);
      if (bc) {
        name = bc.path;
        await supabaseAdmin
          .from("ebay_category_aspects")
          .update({ category_name: bc.path })
          .eq("marketplace_id", marketplaceId)
          .eq("category_tree_id", treeId)
          .eq("category_id", categoryId);
      }
    }
    return {
      aspects: cached.aspects as Record<string, unknown>,
      categoryName: name,
      cached: true,
    };
  }

  const token = await getAppAccessToken();
  const url =
    `${apiHost()}/commerce/taxonomy/v1/category_tree/${treeId}` +
    `/get_item_aspects_for_category?category_id=${encodeURIComponent(
      categoryId
    )}`;
  const res = await ebayFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      "Accept-Language": "en-US",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay category aspects failed (${res.status}): ${text.slice(0, 300)}`
    );
  }
  const payload = (await res.json()) as Record<string, unknown>;

  // Resolve the full breadcrumb path alongside the aspects so callers (the web
  // picker, iOS specifics editor) can show "Clothing › … › Jeans" instead of a
  // raw id. Best-effort: a failed breadcrumb lookup just leaves the name null,
  // and a previously-cached path is preserved rather than nulled out.
  const breadcrumb = await fetchCategoryBreadcrumb(categoryId).catch(() => null);
  const categoryName =
    breadcrumb?.path ?? ((cached?.category_name as string | null) ?? null);

  // Write-through cache.
  await supabaseAdmin.from("ebay_category_aspects").upsert(
    {
      marketplace_id: marketplaceId,
      category_tree_id: treeId,
      category_id: categoryId,
      category_name: categoryName,
      aspects: payload,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "marketplace_id,category_tree_id,category_id" }
  );

  return { aspects: payload, categoryName, cached: false };
}

// US-566: per-category allowed conditions. Taxonomy
// `get_item_condition_policies` returns the numeric conditionId allow-list for a
// leaf category — some leaves (vintage, designer, collectibles) reject anything
// but a restricted set, so we validate the chosen condition before publishing
// instead of eating a raw eBay 25002/25019. Read-through cached in
// public.ebay_category_condition_policies (same TTL/sharing model as aspects).
export interface ConditionPolicy {
  /** Allowed eBay conditionIds for the category, e.g. ["1000","1500","3000"]. */
  conditionIds: string[];
  cached: boolean;
}

export async function getItemConditionPolicies(
  categoryId: string,
): Promise<ConditionPolicy> {
  const marketplaceId = getMarketplaceId();
  const treeId = getCategoryTreeId();

  const { data: cached } = await supabaseAdmin
    .from("ebay_category_condition_policies")
    .select("condition_ids, fetched_at")
    .eq("marketplace_id", marketplaceId)
    .eq("category_tree_id", treeId)
    .eq("category_id", categoryId)
    .maybeSingle();

  if (
    cached &&
    Date.now() - new Date(cached.fetched_at as string).getTime() < ASPECT_TTL_MS
  ) {
    return {
      conditionIds: (cached.condition_ids as string[] | null) ?? [],
      cached: true,
    };
  }

  const token = await getAppAccessToken();
  // getItemConditionPolicies is a Sell *Metadata* API method, keyed by
  // marketplace id — NOT a Taxonomy/category_tree method. The old
  // /commerce/taxonomy/v1/category_tree/{treeId}/get_item_condition_policies
  // path does not exist and 404s, which silently disabled condition validation
  // and let invalid conditions reach publish (eBay error 25021). The response
  // shape (itemConditionPolicies[].itemConditions[]) parsed below is the
  // Metadata API's, confirming this is the intended endpoint.
  const url =
    `${apiHost()}/sell/metadata/v1/marketplace/${encodeURIComponent(marketplaceId)}` +
    `/get_item_condition_policies?filter=categoryIds:${encodeURIComponent(
      `{${categoryId}}`,
    )}`;
  const res = await ebayFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      "Accept-Language": "en-US",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay condition policies failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const payload = (await res.json()) as {
    itemConditionPolicies?: Array<{
      itemConditions?: Array<{ conditionId?: string | number }>;
    }>;
  };
  const conditionIds = (payload.itemConditionPolicies?.[0]?.itemConditions ?? [])
    .map((c) => (c.conditionId == null ? "" : String(c.conditionId)))
    .filter((id) => id.length > 0);

  await supabaseAdmin.from("ebay_category_condition_policies").upsert(
    {
      marketplace_id: marketplaceId,
      category_tree_id: treeId,
      category_id: categoryId,
      condition_ids: conditionIds,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "marketplace_id,category_tree_id,category_id" },
  );

  return { conditionIds, cached: false };
}

// ── Sell API: business policies + listings (Week 3) ────────────────
//
// Publishing a listing requires three business policies (fulfillment,
// payment, return) and one merchant location to exist on the seller's
// eBay account. We look these up once at publish-time and use the first
// of each. Users with multiple policies can configure defaults later via
// a settings screen.

export interface PolicySet {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey: string;
}

export interface MissingPolicies {
  missing: string[];
  details: Partial<PolicySet> & {
    helpUrl?: string;
  };
}

// Locale that pairs with EBAY_MARKETPLACE_ID. Most callers only care about
// US, but other marketplaces (EBAY_GB → en-GB, EBAY_DE → de-DE) need the
// right BCP-47 tag in BOTH Accept-Language and Content-Language headers.
// eBay error 25709 surfaces when either is missing or invalid.
export function localeForMarketplace(): string {
  const mp = getMarketplaceId();
  switch (mp) {
    case "EBAY_GB":
      return "en-GB";
    case "EBAY_DE":
      return "de-DE";
    case "EBAY_FR":
      return "fr-FR";
    case "EBAY_IT":
      return "it-IT";
    case "EBAY_ES":
      return "es-ES";
    case "EBAY_AU":
      return "en-AU";
    case "EBAY_CA":
      return "en-CA";
    default:
      return "en-US";
  }
}

// US-325: 429/5xx from eBay during a batch shouldn't fail the job — wrap in
// withRetry. A 429 or 5xx means eBay rejected the request before mutating
// state, so retrying is safe even for non-idempotent POSTs.
// US-406: eBay sends `Retry-After` as whole seconds ("120") or an HTTP-date;
// both are honored. The parser itself lives in retry.ts (US-2305) so eBay,
// Google Sheets and Anthropic all read the header the same way.

async function fetchAuthed<T>(
  userId: string,
  path: string,
  init?: RequestInit,
  // US-1507: when set, the request is authed via THIS connection's token (the
  // account that owns the listing) instead of the user's current primary. Callers
  // that lack a listing (or have a legacy row with a null connection id) omit it
  // and keep the primary-connection behavior.
  connectionId?: string,
): Promise<T> {
  // US-499: breaker OUTSIDE retry so a fully-retried-then-failed call counts as
  // one failure; only transient errors trip it (isFailure: isRetryableError).
  return await ebayBreaker().execute(() =>
    withRetry(() => fetchAuthedOnce<T>(userId, path, init, connectionId))
  );
}

async function fetchAuthedOnce<T>(
  userId: string,
  path: string,
  init?: RequestInit,
  connectionId?: string,
): Promise<T> {
  // US-1507: prefer the listing's own connection; fall back to the primary.
  const token = connectionId
    ? await getConnectionAccessToken(connectionId, userId)
    : await getUserAccessToken(userId);
  const locale = localeForMarketplace();
  const res = await countedEbayFetch(`${apiHost()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      "Content-Type": "application/json",
      // Sell API requires both. Accept-Language was the missing one (error 25709).
      "Accept-Language": locale,
      "Content-Language": locale,
      ...(init?.headers ?? {}),
    },
  }, EBAY_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text();
    // Throw an Error with `status` attached so withRetry's isRetryableError
    // matches on the numeric status (not just the message regex).
    const err = new Error(
      `eBay ${init?.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
    ) as Error & {
      status: number;
      ebayErrorIds?: number[];
      ebayErrorMessages?: string[];
      retryAfterMs?: number;
    };
    err.status = res.status;
    // US-406: honor eBay's Retry-After (and the rate-limit window header it
    // sends on 429s) so withRetry waits exactly as long as eBay asked instead
    // of guessing with jittered backoff. Header is seconds (integer) or an
    // HTTP-date; we normalize both to ms.
    const retryAfterMs = parseRetryAfter(
      res.headers.get("retry-after") ??
        res.headers.get("x-ebay-c-rlogid-retry-after"),
    );
    if (retryAfterMs !== null) err.retryAfterMs = retryAfterMs;
    // US-528: parse eBay's structured error array so callers can match on a
    // stable errorId (e.g. 25002 = offer already exists) instead of brittle
    // message regexes that break when eBay rewords or localizes a message.
    try {
      const parsed = JSON.parse(text) as {
        errors?: Array<{ errorId?: number; message?: string; longMessage?: string }>;
      };
      if (Array.isArray(parsed.errors)) {
        err.ebayErrorIds = parsed.errors
          .map((e) => e.errorId)
          .filter((id): id is number => typeof id === "number");
        // Keep eBay's OWN human message (e.g. "The item specific Inseam is
        // missing…") — it's user-facing guidance, unlike the raw HTTP blob in
        // err.message. Overloaded ids (25002) map to a fixed guess without it.
        err.ebayErrorMessages = parsed.errors
          .map((e) => (e.longMessage ?? e.message ?? "").trim())
          .filter((m) => m.length > 0);
      }
    } catch {
      // Non-JSON error body (gateway HTML, etc.) — leave the fields undefined.
    }
    throw err;
  }
  // 204 No Content is valid for publishOffer in some paths.
  const body = await res.text();
  return (body ? JSON.parse(body) : {}) as T;
}

export async function getDefaultPolicies(
  userId: string
): Promise<PolicySet | MissingPolicies> {
  const marketplaceId = getMarketplaceId();
  const missing: string[] = [];
  const details: Partial<PolicySet> = {};

  type PolicyList<K extends string> = {
    [k in K]: Array<Record<string, unknown>>;
  };

  // Run all four lookups in parallel. The Account API is rate-limited but
  // these are tiny.
  const [fulfillment, payment, ret, locs] = await Promise.all([
    fetchAuthed<PolicyList<"fulfillmentPolicies">>(
      userId,
      `/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`
    ).catch((e) => {
      console.error("fulfillment_policy lookup:", e);
      return null;
    }),
    fetchAuthed<PolicyList<"paymentPolicies">>(
      userId,
      `/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`
    ).catch((e) => {
      console.error("payment_policy lookup:", e);
      return null;
    }),
    fetchAuthed<PolicyList<"returnPolicies">>(
      userId,
      `/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`
    ).catch((e) => {
      console.error("return_policy lookup:", e);
      return null;
    }),
    fetchAuthed<{ locations?: Array<{ merchantLocationKey?: string }> }>(
      userId,
      `/sell/inventory/v1/location`
    ).catch((e) => {
      console.error("location lookup:", e);
      return null;
    }),
  ]);

  const ff = (fulfillment?.fulfillmentPolicies?.[0] as
    | { fulfillmentPolicyId?: string }
    | undefined)?.fulfillmentPolicyId;
  const pp = (payment?.paymentPolicies?.[0] as
    | { paymentPolicyId?: string }
    | undefined)?.paymentPolicyId;
  const rp = (ret?.returnPolicies?.[0] as
    | { returnPolicyId?: string }
    | undefined)?.returnPolicyId;
  const loc = locs?.locations?.[0]?.merchantLocationKey;

  if (ff) details.fulfillmentPolicyId = ff;
  else missing.push("fulfillment policy");
  if (pp) details.paymentPolicyId = pp;
  else missing.push("payment policy");
  if (rp) details.returnPolicyId = rp;
  else missing.push("return policy");
  if (loc) details.merchantLocationKey = loc;
  else missing.push("merchant location");

  if (missing.length > 0) {
    return {
      missing,
      details: {
        ...details,
        helpUrl:
          "https://www.ebay.com/help/selling/business-policies/business-policies?id=4212",
      },
    };
  }
  return details as PolicySet;
}

// ── US-314: business_policies cache ────────────────────────────────
//
// Each publish previously called getDefaultPolicies() which round-trips four
// eBay endpoints. For bulk publish that adds seconds and burns rate budget.
// syncBusinessPolicies fetches ALL policies + locations once and persists them
// to business_policies (+ merchant_location_key on the connection); the
// publish path then reads the is_default rows via resolveCachedDefaults.

export type EbayPolicyKind = "fulfillment" | "payment" | "return";

export interface SyncedPolicy {
  policy_id: string;
  policy_type: EbayPolicyKind;
  policy_name: string;
  policy_data: Record<string, unknown>;
  is_default: boolean;
}

export interface SyncedPolicies {
  policies: SyncedPolicy[];
  merchantLocationKey: string | null;
  missing: string[];
}

/**
 * Fetch all business policies + merchant locations from eBay and persist them
 * to `business_policies`, marking the first of each kind as default (only if
 * no existing default for that kind in the workspace). Writes the first
 * merchant location key onto marketplace_connections.merchant_location_key.
 *
 * Tenant-safe: every write is keyed on `userId` (the workspace owner id) so
 * the service-role client cannot leak rows across workspaces.
 */
export async function syncBusinessPolicies(
  userId: string,
): Promise<SyncedPolicies> {
  const marketplaceId = getMarketplaceId();

  type FulfillmentPolicy = {
    fulfillmentPolicyId: string;
    name?: string;
  } & Record<string, unknown>;
  type PaymentPolicy = {
    paymentPolicyId: string;
    name?: string;
  } & Record<string, unknown>;
  type ReturnPolicy = {
    returnPolicyId: string;
    name?: string;
  } & Record<string, unknown>;
  type EbayLocation = {
    merchantLocationKey?: string;
  };

  const [fulfillment, payment, ret, locs] = await Promise.all([
    fetchAuthed<{ fulfillmentPolicies?: FulfillmentPolicy[] }>(
      userId,
      `/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`,
    ).catch((e) => {
      console.error("[ebay-client] fulfillment_policy sync:", e);
      return { fulfillmentPolicies: [] as FulfillmentPolicy[] };
    }),
    fetchAuthed<{ paymentPolicies?: PaymentPolicy[] }>(
      userId,
      `/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`,
    ).catch((e) => {
      console.error("[ebay-client] payment_policy sync:", e);
      return { paymentPolicies: [] as PaymentPolicy[] };
    }),
    fetchAuthed<{ returnPolicies?: ReturnPolicy[] }>(
      userId,
      `/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`,
    ).catch((e) => {
      console.error("[ebay-client] return_policy sync:", e);
      return { returnPolicies: [] as ReturnPolicy[] };
    }),
    fetchAuthed<{ locations?: EbayLocation[] }>(
      userId,
      `/sell/inventory/v1/location`,
    ).catch((e) => {
      console.error("[ebay-client] location sync:", e);
      return { locations: [] as EbayLocation[] };
    }),
  ]);

  const fulfillmentPolicies = (fulfillment?.fulfillmentPolicies ?? []) as FulfillmentPolicy[];
  const paymentPolicies = (payment?.paymentPolicies ?? []) as PaymentPolicy[];
  const returnPolicies = (ret?.returnPolicies ?? []) as ReturnPolicy[];
  const locations = (locs?.locations ?? []).filter(
    (l): l is { merchantLocationKey: string } =>
      typeof l.merchantLocationKey === "string" && l.merchantLocationKey.length > 0,
  );

  const missing: string[] = [];
  if (fulfillmentPolicies.length === 0) missing.push("fulfillment policy");
  if (paymentPolicies.length === 0) missing.push("payment policy");
  if (returnPolicies.length === 0) missing.push("return policy");
  if (locations.length === 0) missing.push("merchant location");

  // Look up existing defaults so we don't clobber a user's manual override.
  const { data: existingDefaults } = await supabaseAdmin
    .from("business_policies")
    .select("policy_type, policy_id")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_default", true);
  const existingDefaultByType = new Map<EbayPolicyKind, string>();
  for (const row of (existingDefaults ?? []) as Array<
    { policy_type: EbayPolicyKind; policy_id: string }
  >) {
    existingDefaultByType.set(row.policy_type, row.policy_id);
  }

  const synced: SyncedPolicy[] = [];

  const push = (
    kind: EbayPolicyKind,
    id: string,
    name: string | undefined,
    data: Record<string, unknown>,
    isFirst: boolean,
  ) => {
    const existingDefault = existingDefaultByType.get(kind);
    const isDefault = existingDefault
      ? existingDefault === id
      : isFirst;
    synced.push({
      policy_id: id,
      policy_type: kind,
      policy_name: name ?? id,
      policy_data: data,
      is_default: isDefault,
    });
  };

  fulfillmentPolicies.forEach((p, i) =>
    push("fulfillment", p.fulfillmentPolicyId, p.name, p, i === 0),
  );
  paymentPolicies.forEach((p, i) =>
    push("payment", p.paymentPolicyId, p.name, p, i === 0),
  );
  returnPolicies.forEach((p, i) =>
    push("return", p.returnPolicyId, p.name, p, i === 0),
  );

  // Upsert each policy row, scoped to the workspace owner. Unique constraint
  // on (user_id, marketplace, policy_id) drives the upsert merge.
  if (synced.length > 0) {
    const now = new Date().toISOString();
    const { error: upErr } = await supabaseAdmin
      .from("business_policies")
      .upsert(
        synced.map((p) => ({
          user_id: userId,
          marketplace: "ebay",
          policy_id: p.policy_id,
          policy_type: p.policy_type,
          policy_name: p.policy_name,
          policy_data: p.policy_data,
          is_default: p.is_default,
          synced_from_ebay_at: now,
        })),
        { onConflict: "user_id,marketplace,policy_id" },
      );
    if (upErr) {
      console.error("[ebay-client] business_policies upsert:", upErr);
    }
  }

  // Persist the merchant location on the connection so resolveCachedDefaults
  // can pick it up without re-hitting eBay every publish.
  const merchantLocationKey = locations[0]?.merchantLocationKey ?? null;
  if (merchantLocationKey) {
    await supabaseAdmin
      .from("marketplace_connections")
      .update({ merchant_location_key: merchantLocationKey })
      .eq("user_id", userId)
      .eq("marketplace", "ebay")
      .eq("is_active", true);
  }

  return { policies: synced, merchantLocationKey, missing };
}

/**
 * Resolve the publish-time policy set from cache, falling back to a live sync
 * if the cache is empty. Returns PolicySet on success, MissingPolicies (with
 * helpUrl) if the seller has none configured. Used by assemblePublishContext.
 */
export async function resolveCachedDefaults(
  userId: string,
): Promise<PolicySet | MissingPolicies> {
  // 1. Try the cache first.
  const cached = await readCachedDefaults(userId);
  if (cached.ok) return cached.policies;

  // 2. Cache miss / partial — refresh from eBay and try again.
  const synced = await syncBusinessPolicies(userId);
  if (synced.missing.length > 0) {
    return {
      missing: synced.missing,
      details: {
        helpUrl:
          "https://www.ebay.com/help/selling/business-policies/business-policies?id=4212",
      },
    };
  }
  const refreshed = await readCachedDefaults(userId);
  if (refreshed.ok) return refreshed.policies;

  // 3. Refresh didn't yield a set — fall back to the legacy live resolver so
  //    publish doesn't fail closed when only the cache is broken.
  return await getDefaultPolicies(userId);
}

async function readCachedDefaults(
  userId: string,
): Promise<
  | { ok: true; policies: PolicySet }
  | { ok: false }
> {
  const { data: defaults } = await supabaseAdmin
    .from("business_policies")
    .select("policy_type, policy_id")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_default", true);
  const byType = new Map<string, string>();
  for (const row of (defaults ?? []) as Array<{ policy_type: string; policy_id: string }>) {
    byType.set(row.policy_type, row.policy_id);
  }

  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("merchant_location_key")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  const fulfillment = byType.get("fulfillment");
  const payment = byType.get("payment");
  const ret = byType.get("return");
  const merchantLocationKey =
    (conn as { merchant_location_key: string | null } | null)?.merchant_location_key ?? null;

  if (fulfillment && payment && ret && merchantLocationKey) {
    return {
      ok: true,
      policies: {
        fulfillmentPolicyId: fulfillment,
        paymentPolicyId: payment,
        returnPolicyId: ret,
        merchantLocationKey,
      },
    };
  }
  return { ok: false };
}

/**
 * Apply a manual default selection. The caller (HTTP route) is responsible for
 * authorizing the user. Each id is upserted as that type's default; existing
 * defaults of the same type are demoted.
 */
export async function setDefaultPolicies(
  userId: string,
  selection: {
    fulfillment_policy_id?: string;
    payment_policy_id?: string;
    return_policy_id?: string;
    merchant_location_key?: string;
  },
): Promise<void> {
  const updates: Array<{ kind: EbayPolicyKind; id: string }> = [];
  if (selection.fulfillment_policy_id) {
    updates.push({ kind: "fulfillment", id: selection.fulfillment_policy_id });
  }
  if (selection.payment_policy_id) {
    updates.push({ kind: "payment", id: selection.payment_policy_id });
  }
  if (selection.return_policy_id) {
    updates.push({ kind: "return", id: selection.return_policy_id });
  }

  for (const u of updates) {
    // Demote the current default for this kind, then promote the chosen one.
    await supabaseAdmin
      .from("business_policies")
      .update({ is_default: false })
      .eq("user_id", userId)
      .eq("marketplace", "ebay")
      .eq("policy_type", u.kind)
      .eq("is_default", true);
    await supabaseAdmin
      .from("business_policies")
      .update({ is_default: true })
      .eq("user_id", userId)
      .eq("marketplace", "ebay")
      .eq("policy_id", u.id)
      .eq("policy_type", u.kind);
  }

  if (selection.merchant_location_key) {
    await supabaseAdmin
      .from("marketplace_connections")
      .update({ merchant_location_key: selection.merchant_location_key })
      .eq("user_id", userId)
      .eq("marketplace", "ebay")
      .eq("is_active", true);
  }
}

// ── Merchant (inventory) location ───────────────────────────────────
//
// Every published offer needs a `merchantLocationKey` pointing at an ENABLED
// inventory location. This is an Inventory-API-only concept — sellers who set
// up fulfillment/payment/return policies in Seller Hub still won't have one,
// which is the most common cause of a "merchant location" publish blocker.
// There is no Seller Hub UI to create one, so FlipDesk creates a default
// location for the seller from a ZIP/address they confirm once.

export interface InventoryLocationInput {
  // Defaults to FLIPDESK-DEFAULT. eBay keys are case-insensitive, ≤36 chars.
  merchantLocationKey?: string;
  name?: string;
  address: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    stateOrProvince?: string;
    postalCode?: string;
    country: string; // ISO 3166-1 alpha-2, e.g. "US"
  };
}

/**
 * Create (or confirm) a merchant inventory location on the seller's eBay
 * account and persist its key on marketplace_connections so publish and
 * resolveCachedDefaults can read it. Idempotent: if the key already exists on
 * eBay (re-run), we verify via GET and treat it as success rather than failing.
 *
 * Tenant-safe: the connection update is keyed on `userId` (workspace owner).
 */
export async function createInventoryLocation(
  userId: string,
  input: InventoryLocationInput,
): Promise<{ merchantLocationKey: string }> {
  const key =
    (input.merchantLocationKey ?? "FLIPDESK-DEFAULT")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 36) || "FLIPDESK-DEFAULT";

  const body = {
    location: { address: input.address },
    name: input.name ?? "FlipDesk Default Location",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
  };

  try {
    // Create returns 204 No Content on success.
    await fetchAuthed<unknown>(
      userId,
      `/sell/inventory/v1/location/${encodeURIComponent(key)}`,
      { method: "POST", body: JSON.stringify(body) },
    );
  } catch (err) {
    // The key may already exist (re-run) — eBay 400s with errorId 25803
    // ("location already exists"). Confirm via GET before surfacing the error.
    const existing = await fetchAuthed<{
      locations?: Array<{ merchantLocationKey?: string }>;
    }>(userId, `/sell/inventory/v1/location`).catch(() => null);
    const present = existing?.locations?.some(
      (l) => l.merchantLocationKey === key,
    );
    if (!present) throw err;
  }

  await supabaseAdmin
    .from("marketplace_connections")
    .update({ merchant_location_key: key })
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true);

  return { merchantLocationKey: key };
}

export interface InventoryItemPayload {
  product: {
    title: string;
    description: string;
    aspects?: Record<string, string[]>;
    imageUrls?: string[];
    brand?: string;
    mpn?: string;
    // US-1475: adopt an eBay Catalog product by EPID — eBay auto-fills the
    // catalog's required item specifics, cutting aspect-compliance violations.
    epid?: string;
  };
  condition: string;
  conditionDescription?: string;
  availability: {
    shipToLocationAvailability: { quantity: number };
  };
}

// eBay hard-rejects any item-specific (aspect) VALUE longer than 65 characters
// at PUBLISH time (errorId 25002: "…value of '…' is too long. Enter a value of
// no more than 65 characters."). The inventory_item PUT itself accepts the long
// value, so the failure only surfaces on publish — by which point the offer has
// already been created, leaving a stuck unpublished offer that makes every retry
// fail "offer already exists". A single free-text aspect (e.g. a full "Garment
// Care" instruction) permanently blocks the listing. Cap every value here, at
// the one chokepoint both publish and revise share, so an over-long value can
// never reach eBay.
export const EBAY_ASPECT_VALUE_MAX_LEN = 65;

// Cap a single aspect value to eBay's 65-char limit, preferring a word boundary
// so we don't truncate mid-word into garbage. Falls back to a hard 65-char cut
// only when the first 65 chars contain no break. Strips a trailing separator
// left by the cut (", " / "- " etc.).
function capAspectValue(value: string): string {
  const v = value.trim();
  if (v.length <= EBAY_ASPECT_VALUE_MAX_LEN) return v;
  const head = v.slice(0, EBAY_ASPECT_VALUE_MAX_LEN);
  const lastSpace = head.lastIndexOf(" ");
  // Only prefer the word boundary when it keeps a reasonable amount of text;
  // otherwise (a very long single token) hard-cut at the limit.
  const cut = lastSpace > EBAY_ASPECT_VALUE_MAX_LEN / 2 ? head.slice(0, lastSpace) : head;
  return cut.replace(/[\s,;/|-]+$/, "").trim();
}

// Sanitize an aspect map for the eBay Inventory API: cap each value to 65 chars,
// drop values that end up empty, and drop keys left with no values. Pure +
// exported for unit tests. Returns undefined when nothing survives so callers
// can omit `aspects` entirely.
export function capAspectValuesForEbay(
  aspects: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!aspects) return undefined;
  const out: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(aspects)) {
    if (!Array.isArray(values)) continue;
    const capped = values
      .map((val) => capAspectValue(String(val ?? "")))
      .filter((val) => val.length > 0);
    if (capped.length > 0) out[name] = capped;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function createOrReplaceInventoryItem(
  userId: string,
  sku: string,
  payload: InventoryItemPayload,
  // US-1507: revise re-PUTs must run under the connection that owns the listing
  // (null → primary), or a multi-store seller's re-PUT lands on the wrong account.
  connectionId?: string,
): Promise<void> {
  // Enforce eBay's 65-char aspect-value limit at this shared chokepoint so an
  // over-long item specific can never survive to the publish call and strand an
  // unpublished offer. Mutating a shallow copy keeps the caller's map untouched.
  const safePayload: InventoryItemPayload = {
    ...payload,
    product: {
      ...payload.product,
      aspects: capAspectValuesForEbay(payload.product.aspects),
    },
  };
  // PUT is idempotent; safe to re-run on retries.
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    { method: "PUT", body: JSON.stringify(safePayload) },
    connectionId,
  );
  // US-2704: AFTER the wire, never before — a snapshot of a write that failed
  // is a record of text that was never live.
  await recordPublication(supabaseAdmin, {
    ownerUserId: userId,
    sku,
    description: safePayload.product.description ?? null,
    aspects: safePayload.product.aspects ?? null,
  });
}

// The item specifics eBay CURRENTLY holds for a SKU, or null when the record
// isn't there (never published, or published under a different SKU).
//
// Needed for a category correction on a live listing: eBay judges an
// inventory_item PUT against the category the listing is in RIGHT NOW, so the
// caller has to know what is already on eBay before it can build a payload both
// the old and the new category accept. See the category-migration block in the
// revise route (flipdesk-ebay.ts).
export async function getInventoryItemAspects(
  userId: string,
  sku: string,
  connectionId?: string,
): Promise<Record<string, string[]> | null> {
  const res = await fetchAuthed<{
    product?: { aspects?: Record<string, unknown> | null } | null;
  }>(
    userId,
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    undefined,
    connectionId,
  );
  const raw = res?.product?.aspects;
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(raw)) {
    const values = (Array.isArray(value) ? value : [value])
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
    if (values.length > 0) out[name] = values;
  }
  return out;
}

// US-321/US-562: Best Offer is set per-offer via listingPolicies.bestOfferTerms.
// autoAcceptPrice/autoDeclinePrice are optional auto-clear thresholds (an offer
// >= autoAcceptPrice auto-accepts; <= autoDeclinePrice auto-declines). eBay
// requires autoDeclinePrice < autoAcceptPrice < listing price — the caller
// (resolveBestOfferThresholds) clamps to those constraints before we send them.
export interface BestOfferTerms {
  bestOfferEnabled: boolean;
  autoAcceptPrice?: { value: string; currency: string };
  autoDeclinePrice?: { value: string; currency: string };
}

// US-568: eBay's offer pricingSummary covers both formats. FIXED_PRICE sends
// `price`; AUCTION sends `auctionStartPrice` (required) plus optional
// `auctionReservePrice` and `price` (the Buy It Now price on an auction).
export interface PricingSummary {
  price?: { value: string; currency: string };
  auctionStartPrice?: { value: string; currency: string };
  auctionReservePrice?: { value: string; currency: string };
}

export interface OfferPayload {
  sku: string;
  marketplaceId: string;
  format: "FIXED_PRICE" | "AUCTION";
  availableQuantity: number;
  categoryId: string;
  listingDescription: string;
  // US-568: required for AUCTION offers (e.g. "DAYS_7"); GTC for FIXED_PRICE.
  listingDuration?: string;
  listingPolicies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
    // Only present when the seller has best-offer enabled on the draft.
    bestOfferTerms?: BestOfferTerms;
  };
  pricingSummary: PricingSummary;
  merchantLocationKey: string;
}

export async function createOffer(
  userId: string,
  payload: OfferPayload
): Promise<{ offerId: string }> {
  return await fetchAuthed<{ offerId: string }>(
    userId,
    `/sell/inventory/v1/offer`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

// eBay returns errorId 25002 when an offer already exists for this SKU +
// marketplace. US-528: match the structured errorId first (stable across
// message rewording/localization); fall back to the legacy message heuristic
// only when the error body wasn't JSON-parseable. A false positive is safe:
// the caller (publishItemForOwner) looks up the SKU's offers and re-throws the
// original error if none is found.
export const OFFER_ALREADY_EXISTS_ERROR_ID = 25002;
export function isOfferAlreadyExistsError(err: unknown): boolean {
  const ids =
    err && typeof err === "object"
      ? (err as { ebayErrorIds?: number[] }).ebayErrorIds
      : undefined;
  if (Array.isArray(ids) && ids.includes(OFFER_ALREADY_EXISTS_ERROR_ID)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg) && /offer/i.test(msg);
}

// eBay answers "this SKU has no offer" with a 404 + errorId 25713 ("This Offer
// is not available.") rather than an empty list. That is a NORMAL state — an
// inventory item that was never offered, or whose offer was withdrawn — so
// treating it as a failure logged one console.error per SKU per sync forever
// and buried the real errors next to it. Absence is not an error.
export const OFFER_NOT_AVAILABLE_ERROR_ID = 25713;
export function isOfferNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; ebayErrorIds?: number[] };
  if (e.status !== 404) return false;
  const ids = e.ebayErrorIds;
  // Only the specific id. A 404 we cannot identify stays an error: it may be a
  // wrong host, a revoked scope or a path typo, and swallowing those would turn
  // a broken sync into a silently empty one.
  return Array.isArray(ids) && ids.includes(OFFER_NOT_AVAILABLE_ERROR_ID);
}

// Returns every offer eBay has for this SKU, in the full RemoteOffer shape.
// (Sell Inventory API's GET /offer endpoint REQUIRES a sku query param —
// there is no documented "list all" endpoint; you walk inventory_item first.)
export async function listOffersForSku(
  userId: string,
  sku: string
): Promise<RemoteOffer[]> {
  type OfferListPayload = {
    offers?: Array<{
      offerId?: string;
      sku?: string;
      marketplaceId?: string;
      format?: string;
      availableQuantity?: number;
      status?: string;
      categoryId?: string;
      listingDescription?: string;
      pricingSummary?: { price?: { value?: string; currency?: string } };
      listing?: {
        listingId?: string;
        listingStatus?: string;
        listingStartDate?: string;
      };
    }>;
  };

  let payload: OfferListPayload;
  try {
    payload = await fetchAuthed<OfferListPayload>(
      userId,
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
    );
  } catch (err) {
    if (isOfferNotFoundError(err)) return [];
    throw err;
  }

  return (payload.offers ?? [])
    .filter((o): o is typeof o & { offerId: string } =>
      typeof o.offerId === "string"
    )
    .map((o) => ({
      offerId: o.offerId,
      sku: o.sku ?? sku,
      marketplaceId: o.marketplaceId ?? null,
      format: o.format ?? null,
      availableQuantity: o.availableQuantity ?? null,
      status: o.status ?? null,
      categoryId: o.categoryId ?? null,
      price: o.pricingSummary?.price
        ? {
            value: String(o.pricingSummary.price.value ?? "0"),
            currency: String(o.pricingSummary.price.currency ?? "USD"),
          }
        : null,
      listingId: o.listing?.listingId ?? null,
      listingStatus: o.listing?.listingStatus ?? null,
      listingStartDate: o.listing?.listingStartDate ?? null,
      listingDescription: o.listingDescription ?? null,
      // title/aspects live on the inventory_item, not the offer — listAllOffers
      // fills them in from the item that produced this offer.
      title: null,
      aspects: null,
    }));
}

// US-528: publish_ is NOT idempotent — a 5xx/timeout can land AFTER eBay has
// already created the live listing, so a blanket retry (the old fetchAuthed
// path) would re-publish and risk a duplicate. Instead we retry deliberately:
// before each retry (and after exhausting attempts) we re-read the offer and,
// if it already carries a live listingId, return that instead of re-publishing.
export async function publishOffer(
  userId: string,
  offerId: string
): Promise<{ listingId: string }> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // A prior attempt may have actually published despite the error it threw.
      const alreadyLive = await getPublishedListingId(userId, offerId);
      if (alreadyLive) return { listingId: alreadyLive };
      const cap = Math.min(8000, 500 * 2 ** (attempt - 2));
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * cap)));
    }
    try {
      const result = await fetchAuthedOnce<{ listingId: string }>(
        userId,
        `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
        { method: "POST" }
      );
      // US-2704: a publish carries no text of its own — it makes live whatever
      // the inventory item and offer already hold. So this records a
      // CONFIRMATION: the text already snapshotted went live at this moment.
      await recordPublication(supabaseAdmin, { ownerUserId: userId, offerId });
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_ATTEMPTS || !isRetryableError(err)) break;
    }
  }
  // Exhausted (or hit a non-retryable error): one final reconciliation — did it
  // publish despite the failures? If so, succeed with that listingId.
  const alreadyLive = await getPublishedListingId(userId, offerId);
  if (alreadyLive) return { listingId: alreadyLive };
  throw lastErr;
}

// ── Bulk operations (US-1046) ───────────────────────────────────────
// eBay's Inventory API exposes bulk variants (max 25 items/call) that cut both
// latency and rate-limit pressure vs. one HTTP call per item. These are thin
// wrappers returning eBay's raw `responses[]` array; the chunking + per-item
// result aggregation + single-call fallback lives in ebay-bulk.ts (pure, tested).

export const EBAY_BULK_MAX = 25;

export interface BulkResponseEntry {
  sku?: string;
  offerId?: string;
  listingId?: string;
  statusCode?: number;
  errors?: Array<{ errorId?: number; message?: string }>;
}

// US-2363 AC4 — DECIDED: the three publish-side bulk helpers
// (bulk_create_or_replace_inventory_item, bulk_create_offer, bulk_publish_offer)
// were DELETED rather than wired. The story asked whether using them would cut
// publish latency. They would, and it still is not the right trade here.
//
// The reason is in the shape of the publish, not in the API. Publishing one item
// is a SEQUENCE — inventory PUT, then offer POST, then publish — and each step
// consumes the previous step's output and writes it to that listing's own row
// (the offer id, then the eBay listing id). Batching means holding 25 items
// mid-sequence and re-attributing every per-entry result back to the right
// listing at three separate points; a partial failure at step 2 leaves 25 rows
// in three different states. The durable publish worker already gives each item
// its own job, its own retries and its own persisted progress, and that is what
// makes a stuck publish diagnosable.
//
// The two bulk helpers that SURVIVE are the honest signal. `bulkUpdatePriceQuantity`
// and `bulkMigrateListing` both act on listings that ALREADY exist, in one call,
// with nothing to thread between steps — which is where bulk earns its latency.
//
// Worth revisiting only if publish stops being a sequence, or if a single seller
// routinely publishes enough items at once that the round trips dominate the
// bounded concurrency the worker deliberately imposes (eBay 429s under burst).

// US-1046 clean surface: update price and/or available quantity for up to 25
// SKUs/offers in one call. Idempotent (re-applying the same values is a no-op),
// so a failed chunk is safe to retry. Request entries come from
// ebay-bulk.ts:buildPriceQtyRequest.
export async function bulkUpdatePriceQuantity(
  userId: string,
  requests: Array<Record<string, unknown>>,
): Promise<BulkResponseEntry[]> {
  const data = await fetchAuthedOnce<{ responses?: BulkResponseEntry[] }>(
    userId,
    `/sell/inventory/v1/bulk_update_price_quantity`,
    { method: "POST", body: JSON.stringify({ requests }) },
  );
  return data.responses ?? [];
}

// US-464: idempotent publish at the FLOW level. publishOffer reconciles WITHIN
// one call (across its internal retries), but publishItemForOwner persists the
// local listings row only AFTER publishOffer returns — so a publish that
// succeeded remotely then crashed (or whose container died) before that write
// leaves an offer published on eBay with no local record. A retry (manual
// re-publish or the publish-due cron) would call publishOffer AGAIN. This
// pre-checks whether the offer is already live and ADOPTS that listingId
// instead of re-publishing, so the retry can't create a duplicate live listing.
// I/O is injected so the crash+retry path is unit-testable without eBay.
export interface PublishOps {
  getPublishedListingId: (userId: string, offerId: string) => Promise<string | null>;
  publishOffer: (userId: string, offerId: string) => Promise<{ listingId: string }>;
}

export async function publishOrAdoptOffer(
  userId: string,
  offerId: string,
  ops: PublishOps = { getPublishedListingId, publishOffer },
): Promise<{ listingId: string; adopted: boolean }> {
  const existing = await ops.getPublishedListingId(userId, offerId);
  if (existing) return { listingId: existing, adopted: true };
  const published = await ops.publishOffer(userId, offerId);
  return { listingId: published.listingId, adopted: false };
}

// A listingId eBay still reports on a withdrawn offer names a listing that is
// DEAD. eBay does not clear offer.listing.listingId when a listing ends — it
// keeps pointing at the ended listing — so "has a listingId" is not the same
// question as "is live", and treating them as one is what let an end-then-
// republish silently do nothing: the adopt branch handed the ended listing's id
// back as a success, the seller saw "your listing is live", and the item sat
// off eBay. Only these statuses mean the listing is genuinely dead.
//
// Anything else — including a MISSING listingStatus — still adopts, which is
// the pre-existing behaviour. That asymmetry is deliberate: adopting a dead
// listing costs a silent no-publish (recoverable, visible), while refusing to
// adopt a live one costs a DUPLICATE live listing (not recoverable, and the
// whole reason US-464 added this check). Unknown statuses take the safe side.
const DEAD_LISTING_STATUSES = new Set([
  "ENDED",
  "INACTIVE",
  "COMPLETED",
  "CANCELLED",
  "CANCELED",
]);

// The listingId of an offer that is live RIGHT NOW, or null. Split out from
// getPublishedListingId so the status rule is unit-testable without eBay.
//
// The OFFER's own status is checked before the listing's, and it is the check
// that closes the hole the comment above describes. eBay answers the "is this
// live" question in two places and only one of them is reliably updated when a
// seller ends the listing on eBay's own site: `offer.status` goes back to
// UNPUBLISHED, while `offer.listing.listingId` keeps naming the dead listing and
// `listing.listingStatus` is frequently absent from that response entirely. So
// the listingStatus rule below — the only rule there used to be — saw a
// listingId, no dead status, and adopted. That is the silent relist: the push
// reported success, wrote the ENDED listing's id and url back onto the row, and
// the seller's "View on eBay" pointed at the listing they had just ended.
//
// An offer that is not PUBLISHED has nothing to adopt, whatever it remembers.
// A MISSING status still falls through to the listing rules (unchanged), so the
// safe-side asymmetry documented above survives for responses that omit it.
export function livePublishedListingId(offer: {
  status?: string | null;
  listing?: { listingId?: string; listingStatus?: string } | null;
}): string | null {
  const listingId = offer?.listing?.listingId;
  if (!listingId) return null;
  const offerStatus = offer?.status;
  if (typeof offerStatus === "string" && offerStatus.trim() &&
      offerStatus.trim().toUpperCase() !== "PUBLISHED") {
    return null;
  }
  const status = offer.listing?.listingStatus;
  if (typeof status === "string" && DEAD_LISTING_STATUSES.has(status.toUpperCase())) {
    return null;
  }
  return listingId;
}

// An offer that is BOUND TO A DEAD LISTING: eBay still records a listingId on it,
// but that listing is not live. This is the state a seller-side end on eBay
// leaves behind, and re-publishing such an offer does not work — eBay answers
// error 25001 ("A system error has occurred") to every attempt, forever. The
// recovery eBay supports is to destroy the offer and create a fresh one, which
// is what publishItemForOwner does when this returns true.
//
// Deliberately NARROW. A brand-new offer that failed to publish for a data
// reason (a missing item specific, a bad category) has no listingId at all and
// is not matched here, so an ordinary rejection never churns the offer id.
export function isOfferBoundToDeadListing(offer: {
  status?: string | null;
  listing?: { listingId?: string; listingStatus?: string } | null;
}): boolean {
  return Boolean(offer?.listing?.listingId) && livePublishedListingId(offer) === null;
}

// Reads the offer and returns its live listingId if eBay has already published
// it. Used by publishOffer + publishOrAdoptOffer to avoid double-publishing on
// a retry. Returns null if the offer is unpublished, its listing has ENDED, or
// the lookup fails (all treated as "not live yet").
export async function getPublishedListingId(
  userId: string,
  offerId: string,
  // US-1507: read through the account the listing belongs to (null → primary).
  connectionId?: string,
): Promise<string | null> {
  try {
    const offer = (await getOffer(userId, offerId, connectionId)) as {
      status?: string | null;
      listing?: { listingId?: string; listingStatus?: string };
    };
    return livePublishedListingId(offer);
  } catch {
    return null;
  }
}

// Reads a single offer's full body. Needed before updateOfferPrice because
// eBay's PUT /offer/{id} replaces the whole body — partial updates aren't
// supported, so we round-trip the current state and patch only the price.
export async function getOffer(
  userId: string,
  offerId: string,
  // US-1507: act via the listing's own connection when known (null → primary).
  connectionId?: string,
): Promise<Record<string, unknown>> {
  return await fetchAuthed<Record<string, unknown>>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    undefined,
    connectionId,
  );
}

export async function updateOfferPrice(
  userId: string,
  offerId: string,
  priceValue: number,
  currency: string = "USD",
  connectionId?: string,
): Promise<void> {
  const current = await getOffer(userId, offerId, connectionId);
  // Read-modify-write: keep every field eBay returned and overwrite the
  // price. If pricingSummary is missing we create it; that should not
  // happen for a previously-published offer but covers brand-new drafts.
  const pricingSummary =
    (current.pricingSummary as Record<string, unknown> | undefined) ?? {};
  pricingSummary.price = {
    value: priceValue.toFixed(2),
    currency,
  };
  current.pricingSummary = pricingSummary;

  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    { method: "PUT", body: JSON.stringify(current) },
    connectionId,
  );
  // US-2704: a price and NOTHING else. The funnel carries the previous
  // snapshot's description forward rather than recording a listing that lost
  // its text, which is what passing an explicit null here would mean.
  await recordPublication(supabaseAdmin, {
    ownerUserId: userId,
    offerId,
    price: priceValue,
  });
}

// Read-modify-write of arbitrary offer fields. eBay's PUT /offer/{id}
// replaces the whole body, so we round-trip the current state and merge
// only the supplied patch. Use this for any offer revision beyond price.
export async function updateOfferFields(
  userId: string,
  offerId: string,
  patch: {
    price?: number;
    currency?: string;
    listingDescription?: string;
    // US-1079: re-assert quantity on the live offer (availableQuantity is the
    // offer field that controls the listed quantity for a single-SKU offer).
    availableQuantity?: number;
    // US-1490: the eBay leaf category lives on the OFFER (not the inventory
    // item), so a post-publish category change must be re-asserted here too — a
    // revise that only re-PUTs the inventory item would leave the live listing
    // in its original category.
    categoryId?: string;
  },
  // US-1507: revise via the listing's own connection when known (null → primary).
  connectionId?: string,
): Promise<void> {
  const current = await getOffer(userId, offerId, connectionId);

  if (patch.price !== undefined) {
    const pricingSummary =
      (current.pricingSummary as Record<string, unknown> | undefined) ?? {};
    pricingSummary.price = {
      value: patch.price.toFixed(2),
      currency: patch.currency ?? "USD",
    };
    current.pricingSummary = pricingSummary;
  }

  if (patch.listingDescription !== undefined) {
    current.listingDescription = patch.listingDescription;
  }

  if (patch.availableQuantity !== undefined) {
    current.availableQuantity = patch.availableQuantity;
  }

  if (patch.categoryId !== undefined && patch.categoryId) {
    current.categoryId = patch.categoryId;
  }

  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    { method: "PUT", body: JSON.stringify(current) },
    connectionId,
  );
  // US-2704: the live offer's description and price are what a buyer read.
  await recordPublication(supabaseAdmin, {
    ownerUserId: userId,
    offerId,
    description: patch.listingDescription,
    price: patch.price,
  });
}

// Brings an EXISTING (unpublished) offer in line with the current draft before
// re-publishing. eBay's PUT /offer/{id} replaces the whole body, so we
// round-trip the current state and overwrite the mutable fields — crucially
// listingPolicies (a stale/invalid shipping policy here is the usual cause of
// publish error 25007), plus price, category, description, quantity and the
// merchant location. Without this, re-selecting a policy never reaches an offer
// that was created earlier with the wrong one.
export async function syncExistingOffer(
  userId: string,
  offerId: string,
  fields: {
    availableQuantity: number;
    categoryId: string;
    listingDescription: string;
    // US-568: present for AUCTION offers so a re-synced auction keeps its term.
    listingDuration?: string;
    listingPolicies: {
      fulfillmentPolicyId: string;
      paymentPolicyId: string;
      returnPolicyId: string;
      bestOfferTerms?: BestOfferTerms;
    };
    pricingSummary: PricingSummary;
    merchantLocationKey: string;
  },
): Promise<void> {
  const current = await getOffer(userId, offerId);
  current.availableQuantity = fields.availableQuantity;
  current.categoryId = fields.categoryId;
  current.listingDescription = fields.listingDescription;
  if (fields.listingDuration !== undefined) {
    current.listingDuration = fields.listingDuration;
  }
  current.listingPolicies = fields.listingPolicies;
  current.pricingSummary = fields.pricingSummary;
  current.merchantLocationKey = fields.merchantLocationKey;
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    { method: "PUT", body: JSON.stringify(current) },
  );
}

// ── Sell Account API: seller programs (US-1979 AC3) ────────────────
//
// The one that matters for us is OUT_OF_STOCK. By default eBay ENDS a
// multi-quantity listing the moment quantity hits 0. For evergreen clothing —
// the same blank tee in eight sizes, restocked continuously — that is the wrong
// behaviour: the listing loses its item id, its watchers, its search standing and
// its sales history, and the seller has to relist from scratch. Opted in, the
// listing stays live at qty 0 (hidden from search until restocked) and keeps all
// of it.
//
// It is deliberately an OPT-IN and stays one: for a single-quantity thrift item —
// most of FlipDesk — the default is CORRECT, and silently opting everyone in would
// leave sold-out one-offs sitting live. So this exposes the control; it never
// decides for the seller.
export type EbaySellerProgram =
  | "OUT_OF_STOCK_CONTROL"
  | "SELLING_POLICY_MANAGEMENT"
  | "PARTNER_MOTORS_DEALER";

export interface EbayProgramStatus {
  programType: string;
}

export async function getOptedInPrograms(
  userId: string,
  connectionId?: string,
): Promise<string[]> {
  const payload = await fetchAuthed<{ programs?: EbayProgramStatus[] }>(
    userId,
    `/sell/account/v1/program/get_opted_in_programs`,
    undefined,
    connectionId,
  );
  return (payload.programs ?? [])
    .map((p) => p.programType)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

export async function optInToProgram(
  userId: string,
  programType: EbaySellerProgram,
  connectionId?: string,
): Promise<void> {
  await fetchAuthed<unknown>(
    userId,
    `/sell/account/v1/program/opt_in`,
    { method: "POST", body: JSON.stringify({ programType }) },
    connectionId,
  );
}

export async function optOutOfProgram(
  userId: string,
  programType: EbaySellerProgram,
  connectionId?: string,
): Promise<void> {
  await fetchAuthed<unknown>(
    userId,
    `/sell/account/v1/program/opt_out`,
    { method: "POST", body: JSON.stringify({ programType }) },
    connectionId,
  );
}

// eBay 409s an opt_in when already opted in (and an opt_out when already out).
// Both mean the seller is ALREADY in the state they asked for, which is success —
// erroring would make the toggle look broken for doing nothing wrong.
export function isAlreadyInProgramStateError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (!/\b(409|400)\b/.test(msg)) return false;
  return /already opted|already enrolled|not opted in|already a member/.test(msg);
}

// US-1978 (AC2): DELETE the offer record itself.
//
// NOT the same thing as withdrawOffer, and the difference is the whole point.
// withdraw ENDS a live listing and KEEPS the offer so a re-publish reuses the same
// offerId. This DESTROYS the offer record — there is no undo, and on a published
// offer eBay would end the live listing as a side effect.
//
// So this is for STALE UNPUBLISHED artifacts only: drafts that were created,
// never published, and now block SKU reuse. Callers MUST establish the offer is
// unpublished first (see the route's guard) — this function deliberately does not
// check, because a read here would be a TOCTOU comfort blanket rather than a real
// guarantee, and hiding the check inside would make callers assume it is safe.
export async function deleteOffer(
  userId: string,
  offerId: string,
  connectionId?: string,
): Promise<void> {
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    { method: "DELETE" },
    connectionId,
  );
}

// US-1968: convert existing Trading-created listings into managed Inventory
// offers. eBay caps this at 5 listings per call (MIGRATE_BATCH_MAX) and answers
// PER LISTING — a batch can be partly successful — so this returns the raw
// payload and lets parseMigrateResponse (pure, tested) normalize it rather than
// throwing on a partial failure and discarding the successes.
//
// The returned sku is eBay's OWN (derived from the listing's Custom Label or
// generated). It MUST be persisted to listings.inventory_sku; see the header of
// lib/ebay-migrate.ts for why flipping origin without it is worse than not
// migrating at all.
export async function bulkMigrateListing(
  userId: string,
  ebayListingIds: string[],
  connectionId?: string,
): Promise<unknown> {
  return await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/bulk_migrate_listing`,
    {
      method: "POST",
      body: JSON.stringify({
        requests: ebayListingIds.map((listingId) => ({ listingId })),
      }),
    },
    connectionId,
  );
}

// US-1978 (AC2): DELETE the inventory item (SKU) record.
//
// Same contract as deleteOffer: destructive, no undo, and eBay refuses (or
// cascades) when the SKU still has offers. Intended for stale unpublished SKUs
// that accumulate from abandoned drafts and then collide when the seller reuses a
// SKU. The caller establishes there are no live offers first.
export async function deleteInventoryItem(
  userId: string,
  sku: string,
  connectionId?: string,
): Promise<void> {
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    { method: "DELETE" },
    connectionId,
  );
}

// A DELETE can legitimately fail because the artifact is already gone — a prior
// cleanup removed it, or eBay expired it. That is the DESIRED end state, so the
// caller reconciles instead of erroring (mirrors isOfferAlreadyEndedError).
export function isAlreadyDeletedError(err: unknown): boolean {
  // A non-Error tells us nothing. "Unknown shape" is not evidence the artifact is
  // gone, and the false-POSITIVE direction is the dangerous one here.
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();

  // Necessary but NOT sufficient — eBay returns 404/400 for plenty of things.
  if (!/\b(404|400)\b/.test(msg)) return false;

  // The message must name the ARTIFACT, not merely say "not found". Without this,
  // "404: route not found" (an API path change, a proxy misroute) reads as "the
  // offer is already gone": the route reports ok and the stale artifact survives
  // forever while the seller believes it was cleaned up. Caught by
  // ebay-cleanup_test.ts, which is exactly why that test exists.
  if (!/\b(offer|inventory[_\s]item|sku)\b/.test(msg)) return false;

  return /not found|does not exist|no longer exists|cannot be found|invalid sku|\bno\s+(offer|inventory[_\s]item)\b/
    .test(msg);
}

// Withdraws a published offer — ends the live eBay listing. The offer
// record itself stays, so a future re-publish reuses the same offerId.
export async function withdrawOffer(
  userId: string,
  offerId: string,
  // US-1507: end the listing via the account that owns it (null → primary).
  connectionId?: string,
): Promise<void> {
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
    { method: "POST" },
    connectionId,
  );
}

// US-1978 (AC1): withdraw (END) a PUBLISHED multi-variation listing by its
// inventory_item_group key — the inverse of publishOfferByInventoryItemGroup.
//
// withdrawOffer CANNOT end a variation listing: eBay models the group as ONE
// listing spanning many per-variant offers, and the local listings row carries
// NO platform_offer_id for a group publish (each variant has its own offer), so
// the single-offer end path has nothing to withdraw and the live multi-variation
// listing was previously un-endable from FlipDesk. The GROUP is the unit eBay
// ends. Same contract as withdrawOffer: the per-variant offers stay (a re-publish
// reuses the group), and an already-ended group reconciles via
// isOfferAlreadyEndedError. Routes through the hardened fetch path (breaker +
// retry) like every other lifecycle verb — a 429/5xx is retried, a 4xx is not.
export async function withdrawByInventoryItemGroup(
  userId: string,
  groupKey: string,
  // US-1507: end via the account that owns the listing (null → primary).
  connectionId?: string,
): Promise<void> {
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/withdraw_by_inventory_item_group`,
    {
      method: "POST",
      body: JSON.stringify({
        inventoryItemGroupKey: groupKey,
        marketplaceId: getMarketplaceId(),
      }),
    },
    connectionId,
  );
}

// A withdrawOffer / end-listing call can legitimately fail because the eBay
// listing is ALREADY not live — the seller ended it on eBay, eBay removed it
// for a policy issue, or a prior end already withdrew it. eBay then refuses the
// withdraw (4xx, "offer not published" / not found), but the END is effectively
// already done, so callers should treat it as success and reconcile locally
// rather than leaving the listing stuck "active".
//
// We deliberately distinguish that from a TRANSIENT failure (rate-limit 429 or
// an eBay 5xx) where the live state is still unknown — there the caller should
// surface a retry instead of marking the listing ended. Any other 4xx on a
// withdraw of a known offerId means eBay won't withdraw it, which only happens
// when the listing is no longer live.
export function isOfferAlreadyEndedError(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  if (!e) return false;
  const status = typeof e.status === "number" ? e.status : 0;
  // Transient / unknown live-state — do NOT treat as already-ended.
  if (status === 429 || status >= 500) return false;
  // US-2641: 401 and 403 are statements about the CALLER, not about the listing.
  // An expired token, a revoked grant, a missing sell.inventory scope, or a
  // withdraw aimed at an offer another connected account owns all answer 4xx
  // while the listing stays live and sellable. Reading those as "already ended"
  // marks the row ended and leaves buyers able to buy — the oversell direction,
  // and the one the seller has no way to notice. Callers surface a real error.
  if (status === 401 || status === 403) return false;
  // Any other 4xx on a withdraw of a known offer = not in a withdraw-able (live)
  // state. Callers on the eBay path VERIFY this against the offer before
  // reconciling (see the ebay adapter's delist), because the inference is only
  // usually right.
  if (status >= 400 && status < 500) return true;
  // Non-HTTP error (no numeric status) — fall back to a message match.
  const msg = (e.message ?? "").toLowerCase();
  // US-1506: DO NOT match "no active …connection". getUserAccessToken throws
  // "No active eBay connection for this user." when the account is disconnected —
  // that is NOT an already-ended offer. Matching it here reconciled a STILL-LIVE
  // listing to ended (oversell risk). isNoEbayConnectionError classifies it and
  // the end handler preempts this check with it.
  return /not published|not found|already ended|cannot be withdrawn|does not exist|not\s+live/.test(
    msg,
  );
}

// US-1506: a disconnected/absent eBay account. getUserAccessToken throws this
// before any offer withdraw is attempted, so the live listing's state is UNKNOWN
// (still sellable on eBay). Callers MUST surface an actionable reconnect error
// and must NOT reconcile the local row to ended.
export function isNoEbayConnectionError(err: unknown): boolean {
  const e = err as { message?: string } | null;
  if (!e) return false;
  return /no active eBay connection/i.test(e.message ?? "");
}

// US-568: multi-variant (size/color) listings. eBay models them as an
// inventory_item_group: each variant is its own inventory_item (SKU) carrying
// the variation aspects, and the group ties them together with the shared
// product content + the varies-by specifications. A single offer per variant
// SKU is created, then publishByInventoryItemGroup mints ONE multi-variation
// listing.
export interface InventoryItemGroupPayload {
  title: string;
  description: string;
  imageUrls?: string[];
  aspects?: Record<string, string[]>;
  variantSKUs: string[];
  // The aspect names buyers pick between (e.g. ["Size", "Color"]).
  variesBy: {
    specifications: Array<{ name: string; values: string[] }>;
    // Aspect whose value changes the photo (usually "Color"). Optional.
    aspectsImageVariesBy?: string[];
  };
}

// PUT is idempotent; safe to re-run on retries.
export async function createOrReplaceInventoryItemGroup(
  userId: string,
  groupKey: string,
  payload: InventoryItemGroupPayload
): Promise<void> {
  await fetchAuthed<unknown>(
    userId,
    `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
    { method: "PUT", body: JSON.stringify(payload) }
  );
}

// Publishes every offer in the group as one multi-variation listing and returns
// the live listingId. Like publishOffer this is NOT idempotent, so callers must
// reconcile on retry (see publishItemGroupOrAdopt).
export async function publishOfferByInventoryItemGroup(
  userId: string,
  groupKey: string,
  marketplaceId: string
): Promise<{ listingId: string }> {
  const result = await fetchAuthedOnce<{ listingId: string }>(
    userId,
    `/sell/inventory/v1/publish_by_inventory_item_group`,
    {
      method: "POST",
      body: JSON.stringify({ inventoryItemGroupKey: groupKey, marketplaceId }),
    }
  );
  // US-2704: same confirmation as publishOffer. A variation listing is
  // addressed by group key rather than offer id, and neither is a listings-row
  // key, so the funnel resolves nothing and skips — the variation publish path
  // records through its own route call, like the single-SKU first publish.
  await recordPublication(supabaseAdmin, { ownerUserId: userId });
  return result;
}

// Reads the group's first published offer to find an already-live listingId,
// so a crash-then-retry adopts the existing multi-variation listing instead of
// double-publishing. Returns null when nothing is live yet (or the lookup
// fails — treated as not-live).
export async function getPublishedListingIdForGroup(
  userId: string,
  variantSKUs: string[]
): Promise<string | null> {
  for (const sku of variantSKUs) {
    try {
      const offers = await listOffersForSku(userId, sku);
      const live = offers.find((o) => o.listingId);
      if (live?.listingId) return live.listingId;
    } catch {
      // try the next variant
    }
  }
  return null;
}

// US-568: idempotent group publish at the flow level (mirrors publishOrAdoptOffer).
export async function publishItemGroupOrAdopt(
  userId: string,
  groupKey: string,
  variantSKUs: string[],
  marketplaceId: string
): Promise<{ listingId: string; adopted: boolean }> {
  const existing = await getPublishedListingIdForGroup(userId, variantSKUs);
  if (existing) return { listingId: existing, adopted: true };
  const published = await publishOfferByInventoryItemGroup(
    userId,
    groupKey,
    marketplaceId
  );
  return { listingId: published.listingId, adopted: false };
}

export interface RemoteOffer {
  offerId: string;
  sku: string | null;
  marketplaceId: string | null;
  format: string | null;
  availableQuantity: number | null;
  status: string | null;
  categoryId: string | null;
  price: { value: string; currency: string } | null;
  listingId: string | null;
  listingStatus: string | null;
  // ISO timestamp eBay first made the listing live (listing.listingStartDate).
  // Sync writes this through to listings.listed_at so the "List Date" column is
  // populated from eBay's own record rather than left blank on sync-discovered
  // listings. Null when eBay doesn't return it (e.g. unpublished offers).
  listingStartDate: string | null;
  // The HTML listing body. Sync writes this through to listings.listing_description
  // so eBay-side edits in Seller Hub don't leave FlipDesk's copy stale.
  listingDescription: string | null;
  // Catalog source-of-truth fields, carried from the offer's inventory_item so
  // the sync can drive inventory_items.title (overwrite) + brand/size/etc.
  // (fill-if-blank). Populated by listAllOffers; no extra eBay call.
  title: string | null;
  aspects: Record<string, string[]> | null;
}

export interface RemoteInventoryItem {
  sku: string;
  title: string | null;
  // eBay item specifics (product.aspects), e.g. { Brand: ["Nike"], Size: ["M"] }.
  aspects: Record<string, string[]> | null;
}

// US-466: pagination safety ceilings (pages). These exist ONLY to stop a
// runaway loop if eBay never returns a short page; they are NOT a silent data
// cap. They're sized well above any realistic catalog/history, and when one IS
// hit while eBay's `total` says more remains, the loop records an explicit
// truncation warning into the caller's sync-run errors (instead of quietly
// returning a partial set as the old fixed `i < 50` loops did).
const INVENTORY_PAGE_CEILING = 500; // 100/page → 50,000 items
const ORDERS_PAGE_CEILING = 200; // 200/page → 40,000 orders
const TRANSACTIONS_PAGE_CEILING = 500; // 200/page → 100,000 transactions

// US-466: uniform truncation message recorded into a sync run's error list when
// a pagination safety ceiling is reached before eBay returned a short page.
function truncationWarning(
  resource: string,
  fetched: number,
  total: number | null,
  ceiling: number,
): string {
  const totalStr = total != null ? ` of ~${total}` : "";
  return (
    `Truncated ${resource}: synced ${fetched}${totalStr} (hit the ${ceiling}-row ` +
    `safety ceiling). Remaining rows were NOT synced — narrow the date window or contact support.`
  );
}

// Lists every inventory_item registered against the seller's account.
// Paginated 100/page; eBay's max for this endpoint. `warnings` (when provided)
// collects a truncation note if the safety ceiling is reached (US-466).
export async function listAllInventoryItems(
  userId: string,
  warnings?: string[],
): Promise<RemoteInventoryItem[]> {
  const all: RemoteInventoryItem[] = [];
  const limit = 100;
  let offset = 0;
  let completed = false;
  let total: number | null = null;
  for (let i = 0; i < INVENTORY_PAGE_CEILING; i++) {
    const payload = await fetchAuthed<{
      inventoryItems?: Array<{
        sku?: string;
        product?: { title?: string; aspects?: Record<string, string[]> };
      }>;
      total?: number;
    }>(
      userId,
      `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`
    );
    if (typeof payload.total === "number") total = payload.total;
    const batch = payload.inventoryItems ?? [];
    for (const it of batch) {
      if (typeof it.sku === "string" && it.sku) {
        all.push({
          sku: it.sku,
          title: it.product?.title ?? null,
          aspects: it.product?.aspects ?? null,
        });
      }
    }
    if (batch.length < limit) {
      completed = true;
      break;
    }
    offset += limit;
  }
  if (!completed) {
    warnings?.push(
      truncationWarning("inventory items", all.length, total, INVENTORY_PAGE_CEILING * limit),
    );
  }
  return all;
}

// US-406: per-sync SKU fan-out ceiling. eBay's getOffers has no bulk variant —
// it's one call per SKU — so a 5,000-item seller is 5,000 calls against the
// Sell Inventory API's documented daily quota. We cap the fan-out per sync; the
// remainder is NOT dropped silently: a partial run is recorded and the next
// incremental sync continues from where this one stopped (inventory_item is
// listed in a stable order, so a later sync re-reads the same prefix cheaply and
// reaches the tail once earlier items settle). Sized well above a typical
// reseller's active catalog; it's a quota guardrail, not a normal-path limit.
const MAX_OFFERS_FANOUT_PER_SYNC = 2_000;

// US-406: concurrency tuned to eBay's documented Sell API limits. The Inventory
// API's per-second cap is comfortably above this, but 5 in flight keeps a large
// sync from spiking toward the daily quota while still finishing in seconds.
const OFFERS_FANOUT_CONCURRENCY = 5;

// Pulls every offer for the connected seller. eBay has no "list all offers"
// endpoint — you must walk inventory_item, then for each SKU fetch offers.
// Bounded concurrency keeps us under the Sell API rate limits without
// dragging too much on accounts with hundreds of items.
/**
 * US-3111: what a catalog pass actually read, so the caller can remember it.
 *
 * `skusRead` is every SKU we spent a call on this pass, INCLUDING the ones eBay
 * had no offer for — that is the whole point. A SKU that returns nothing is an
 * answer worth storing; without it, the two thirds of the catalog that are
 * Seller-Hub listings with no Inventory-API offer get re-asked forever.
 */
export interface AllOffersResult {
  offers: RemoteOffer[];
  skusRead: string[];
}

export async function listAllOffers(
  userId: string,
  warnings?: string[],
  // SKUs read recently enough that this pass can skip them. Empty means read
  // everything, which is the behaviour before US-3111 and the behaviour the
  // caller falls back to whenever it cannot work out the set.
  skipSkus: ReadonlySet<string> = new Set(),
): Promise<AllOffersResult> {
  const allItems = await listAllInventoryItems(userId, warnings);
  if (allItems.length === 0) return { offers: [], skusRead: [] };

  // US-3111: drop the SKUs whose offer we already read inside the recheck
  // window. Filtering BEFORE the ceiling below is deliberate — the per-sync
  // budget should be spent on SKUs we actually need, not burned on ones we
  // asked about an hour ago.
  const dueItems = skipSkus.size > 0
    ? allItems.filter((it) => !skipSkus.has(it.sku))
    : allItems;
  if (dueItems.length === 0) return { offers: [], skusRead: [] };

  // US-406: bound the fan-out. Beyond the ceiling we stop and flag the run
  // partial rather than fire thousands of calls at eBay's quota in one sync.
  const items = dueItems.slice(0, MAX_OFFERS_FANOUT_PER_SYNC);
  if (dueItems.length > items.length) {
    warnings?.push(
      `Partial sync: fetched offers for the first ${items.length} of ` +
        `${dueItems.length} SKUs due a read (the ${MAX_OFFERS_FANOUT_PER_SYNC}-SKU ` +
        `per-sync fan-out ceiling, to stay under eBay's daily call quota). The ` +
        `remaining SKUs will sync on the next run.`,
    );
  }

  // Recorded before the loop so a rate-limit bail-out still stamps the SKUs we
  // got through. Stamping only on a clean finish would mean a throttled sync
  // re-reads everything it already paid for.
  const skusRead: string[] = [];
  const all: RemoteOffer[] = [];
  // US-406: set when a per-SKU call exhausts retries on a 429/quota error. Once
  // eBay is rate-limiting us, continuing the fan-out only deepens the throttle
  // and risks a silently truncated catalog, so we stop and record a rate-limit-
  // specific partial error (distinct from the generic "one SKU failed" log).
  let rateLimited = false;
  for (let i = 0; i < items.length; i += OFFERS_FANOUT_CONCURRENCY) {
    const slice = items.slice(i, i + OFFERS_FANOUT_CONCURRENCY);
    const results = await Promise.all(
      slice.map((it) =>
        listOffersForSku(userId, it.sku)
          // Carry the item's catalog data onto each of its offers so the sync
          // can drive inventory_items.title + specifics without a second fetch.
          .then((offers) =>
            offers.map((o) => ({ ...o, title: it.title, aspects: it.aspects }))
          )
          .catch((err) => {
            // A 429/quota error means eBay is throttling the whole account —
            // not a one-off bad SKU — so flag it and bail out of the fan-out.
            if (isRateLimitError(err)) rateLimited = true;
            // One SKU failing shouldn't kill the whole sync. Log + carry on.
            console.error(
              `[ebay-client] listOffersForSku(${it.sku}) failed:`,
              err instanceof Error ? err.message : String(err)
            );
            return [] as RemoteOffer[];
          })
      )
    );
    for (const offers of results) all.push(...offers);
    // Every SKU in this slice cost a call, whether or not it produced an offer.
    for (const it of slice) skusRead.push(it.sku);
    if (rateLimited) {
      const reached = Math.min(i + OFFERS_FANOUT_CONCURRENCY, items.length);
      warnings?.push(
        `Rate limited by eBay: stopped after ${reached} of ${items.length} SKUs ` +
          `to avoid exhausting the daily call quota. This sync is partial — ` +
          `remaining offers were NOT fetched and will sync on the next run.`,
      );
      break;
    }
  }
  return { offers: all, skusRead };
}

// Best-effort eBay item-URL builder. eBay's documented format is
// https://www.ebay.com/itm/<listingId>; sandbox uses sandbox.ebay.com.
export function ebayListingUrl(listingId: string): string {
  const host = getEbayEnv() === "production"
    ? "https://www.ebay.com"
    : "https://www.sandbox.ebay.com";
  return `${host}/itm/${listingId}`;
}

// ── US-1039: Sell Fulfillment API — upload tracking on ship ────────
//
// Map a free-text carrier (what the user/shipping label gives us) to eBay's
// shippingCarrierCode enum. Unknown carriers fall back to "Other" — eBay still
// records the tracking number, the buyer still gets it, it just isn't a known
// carrier link. Pure + unit-tested.
const EBAY_CARRIER_CODES: Record<string, string> = {
  usps: "USPS",
  "u.s. postal service": "USPS",
  "united states postal service": "USPS",
  "postal service": "USPS",
  ups: "UPS",
  "united parcel service": "UPS",
  fedex: "FedEx",
  "fed ex": "FedEx",
  "federal express": "FedEx",
  dhl: "DHL",
  "dhl express": "DHL",
  "dhl ecommerce": "DHL",
};

export function toEbayCarrierCode(carrier: string | null | undefined): string {
  if (!carrier) return "Other";
  const key = carrier.trim().toLowerCase();
  if (key.length === 0) return "Other";
  return EBAY_CARRIER_CODES[key] ?? "Other";
}

export interface ShippingFulfillmentInput {
  trackingNumber: string;
  /** Free-text carrier; mapped to eBay's enum via toEbayCarrierCode. */
  carrier?: string | null;
  /** Optional line items to mark shipped; omit → all line items on the order. */
  lineItemIds?: string[];
  /** ISO ship date; defaults to now. */
  shippedDate?: string;
}

/**
 * Create a shipping fulfillment on an eBay order — pushes the tracking number +
 * carrier so the buyer sees tracking, the order shows Shipped, and the seller
 * gets late-shipment / Seller Protection credit. POSTs to the Sell Fulfillment
 * API (201 + Location header, empty body). Throws on eBay error so the caller
 * can surface it.
 */
export async function createShippingFulfillment(
  userId: string,
  orderId: string,
  input: ShippingFulfillmentInput,
): Promise<void> {
  const body: Record<string, unknown> = {
    shippedDate: input.shippedDate ?? new Date().toISOString(),
    shippingCarrierCode: toEbayCarrierCode(input.carrier),
    trackingNumber: input.trackingNumber,
  };
  if (input.lineItemIds && input.lineItemIds.length > 0) {
    body.lineItems = input.lineItemIds.map((id) => ({ lineItemId: id }));
  }
  await fetchAuthed<unknown>(
    userId,
    `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

// US-1978 (AC3): order-level refund — a PROACTIVE or PARTIAL refund issued
// OUTSIDE a return case.
//
// This is a different verb from the Post-Order issueReturnRefund we already have.
// That one only exists once a buyer has opened a return and the seller has
// approved it; it refunds the return. There was no way to make a goodwill gesture
// ("the jacket has a mark I missed — here's $10 back, keep it") without forcing
// the buyer to open a return first, which is worse for both sides and drags the
// seller's metrics.
//
// MONEY MOVES HERE, so the shape is deliberately strict:
//   • The caller passes explicit amounts; nothing is inferred or defaulted. A
//     wrong default on a refund is not a bug you can quietly patch later.
//   • refundItems is optional: omit it for an ORDER-level refund, supply it to
//     refund specific line items. eBay treats these differently and we do not
//     paper over that.
//   • fetchAuthed (retrying) is correct here and matters: eBay requires a
//     idempotency-ish reasonForRefund + the call is safe to retry because eBay
//     rejects a duplicate refund on an already-fully-refunded order rather than
//     double-paying. Contrast publishOfferByInventoryItemGroup, which uses
//     fetchAuthedOnce precisely because IT is not idempotent.
export interface RefundAmount {
  /** ISO currency, e.g. "USD". */
  currency: string;
  /** Decimal string as eBay expects, e.g. "10.00". */
  value: string;
}

export interface IssueRefundInput {
  /**
   * eBay's enum. BUYER_CANCEL / SELLER_CANCEL / ITEM_NOT_RECEIVED /
   * ITEM_NOT_AS_DESCRIBED / OTHER_CAUSE. Required by the API — there is no
   * default, and picking one for the caller would misreport why money moved.
   */
  reasonForRefund: string;
  comment?: string;
  /** Omit for an order-level refund; supply to refund specific line items. */
  refundItems?: Array<{
    lineItemId: string;
    refundAmount: RefundAmount;
  }>;
  /** Order-level refund total. Omit when refunding by line item. */
  orderLevelRefundAmount?: RefundAmount;
}

export interface IssueRefundResult {
  refundId?: string;
  refundStatus?: string;
}

export async function issueOrderRefund(
  userId: string,
  orderId: string,
  input: IssueRefundInput,
  // US-1507: refund via the account that owns the order (null → primary).
  connectionId?: string,
): Promise<IssueRefundResult> {
  const body: Record<string, unknown> = { reasonForRefund: input.reasonForRefund };
  if (input.comment) body.comment = input.comment;
  if (input.refundItems && input.refundItems.length > 0) {
    body.refundItems = input.refundItems;
  }
  if (input.orderLevelRefundAmount) {
    body.orderLevelRefundAmount = input.orderLevelRefundAmount;
  }
  return await fetchAuthed<IssueRefundResult>(
    userId,
    `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/issue_refund`,
    { method: "POST", body: JSON.stringify(body) },
    connectionId,
  );
}

// ── Sell Fulfillment API: orders (Week 5) ──────────────────────────
//
// Used by /listings/pull to detect sales that happened on eBay while
// FlipDesk wasn't looking. The Fulfillment API supports a lastmodifieddate
// filter so we only pull what's changed since last_synced_at.

export interface RemoteOrderLineItem {
  lineItemId: string | null;
  sku: string | null;
  legacyItemId: string | null; // eBay listingId
  title: string | null;
  quantity: number;
  itemCost: { value: string; currency: string } | null;
  shippingCost: { value: string; currency: string } | null;
  taxes: { value: string; currency: string } | null;
}

export interface RemoteOrder {
  orderId: string;
  creationDate: string | null;
  lastModifiedDate: string | null;
  orderFulfillmentStatus: string | null;
  orderPaymentStatus: string | null;
  // eBay cancelStatus.cancelState: 'NONE_REQUESTED' | 'CANCEL_REQUESTED' |
  // 'CANCEL_PENDING' | 'CANCELED'. Used to mark a sale cancelled so dashboards
  // stop counting a cancelled/never-shipped order as a real sale.
  cancelState: string | null;
  buyerUsername: string | null;
  totalAmount: { value: string; currency: string } | null;
  shippingTotal: { value: string; currency: string } | null;
  lineItems: RemoteOrderLineItem[];
}

// Pulls orders modified since `sinceISO` (or all recent ones when omitted).
// eBay caps the date range; we don't enforce a ceiling here — the caller
// passes the connection's last_synced_at and falls back to "90 days ago"
// on first sync.
//
// US-2320: returns `complete` alongside the orders. Hitting ORDERS_PAGE_CEILING
// used to only push a warning string into `warnings`, which the caller counted
// as a successful pass and stamped the cursor for — so the orders past the
// ceiling were dropped and then never asked for again. A truncated read is an
// incomplete read, and the caller has to be able to tell.
export interface RecentOrdersResult {
  orders: RemoteOrder[];
  complete: boolean;
}

export async function listRecentOrders(
  userId: string,
  sinceISO?: string | null,
  warnings?: string[],
): Promise<RecentOrdersResult> {
  const all: RemoteOrder[] = [];
  const limit = 200;
  let offset = 0;
  let completed = false;
  let total: number | null = null;
  const filterParts: string[] = [];
  if (sinceISO) {
    // eBay wants ISO 8601 with milliseconds. Trim sub-second precision noise.
    const iso = new Date(sinceISO).toISOString();
    filterParts.push(`lastmodifieddate:[${iso}..]`);
  }
  const filter = filterParts.length > 0
    ? `&filter=${encodeURIComponent(filterParts.join(","))}`
    : "";

  for (let i = 0; i < ORDERS_PAGE_CEILING; i++) {
    const payload = await fetchAuthed<{
      orders?: Array<{
        orderId?: string;
        creationDate?: string;
        lastModifiedDate?: string;
        orderFulfillmentStatus?: string;
        orderPaymentStatus?: string;
        cancelStatus?: { cancelState?: string };
        buyer?: { username?: string };
        pricingSummary?: {
          total?: { value?: string; currency?: string };
          deliveryCost?: { value?: string; currency?: string };
        };
        lineItems?: Array<{
          lineItemId?: string;
          sku?: string;
          legacyItemId?: string;
          title?: string;
          quantity?: number;
          lineItemCost?: { value?: string; currency?: string };
          deliveryCost?: {
            shippingCost?: { value?: string; currency?: string };
          };
          taxes?: Array<{ amount?: { value?: string; currency?: string } }>;
        }>;
      }>;
      total?: number;
    }>(
      userId,
      `/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}${filter}`
    );
    if (typeof payload.total === "number") total = payload.total;

    const batch = payload.orders ?? [];
    for (const o of batch) {
      if (!o.orderId) continue;
      const lineItems: RemoteOrderLineItem[] = (o.lineItems ?? []).map((li) => {
        // Taxes can be an array of per-tax-type entries; sum them.
        const taxesSum = (li.taxes ?? []).reduce(
          (acc, t) => acc + Number(t.amount?.value ?? 0),
          0
        );
        const currency = li.lineItemCost?.currency ?? "USD";
        return {
          lineItemId: li.lineItemId ?? null,
          sku: li.sku ?? null,
          legacyItemId: li.legacyItemId ?? null,
          title: li.title ?? null,
          quantity: li.quantity ?? 1,
          itemCost: li.lineItemCost?.value
            ? {
                value: String(li.lineItemCost.value),
                currency,
              }
            : null,
          shippingCost: li.deliveryCost?.shippingCost?.value
            ? {
                value: String(li.deliveryCost.shippingCost.value),
                currency:
                  li.deliveryCost.shippingCost.currency ?? currency,
              }
            : null,
          taxes: taxesSum > 0
            ? { value: taxesSum.toFixed(2), currency }
            : null,
        };
      });

      all.push({
        orderId: o.orderId,
        creationDate: o.creationDate ?? null,
        lastModifiedDate: o.lastModifiedDate ?? null,
        orderFulfillmentStatus: o.orderFulfillmentStatus ?? null,
        orderPaymentStatus: o.orderPaymentStatus ?? null,
        cancelState: o.cancelStatus?.cancelState ?? null,
        buyerUsername: o.buyer?.username ?? null,
        totalAmount: o.pricingSummary?.total?.value
          ? {
              value: String(o.pricingSummary.total.value),
              currency: o.pricingSummary.total.currency ?? "USD",
            }
          : null,
        shippingTotal: o.pricingSummary?.deliveryCost?.value
          ? {
              value: String(o.pricingSummary.deliveryCost.value),
              currency:
                o.pricingSummary.deliveryCost.currency ?? "USD",
            }
          : null,
        lineItems,
      });
    }
    if (batch.length < limit) {
      completed = true;
      break;
    }
    offset += limit;
  }
  if (!completed) {
    warnings?.push(
      truncationWarning("eBay orders", all.length, total, ORDERS_PAGE_CEILING * limit),
    );
  }
  return { orders: all, complete: completed };
}

// ── Sell Finances API: fees + payouts (Week 5) ─────────────────────
//
// Used by /listings/pull to enrich sales rows with the platform fees +
// payout amount so each row flips from "Pending" to "Cleared" once the
// money has actually moved. Fees come from SALE transactions; payouts
// land via the same orderId once eBay pays out.

export interface RemoteTransaction {
  transactionId: string;
  transactionType: string; // "SALE" | "NON_SALE_CHARGE" | "REFUND" | "PAYOUT" | ...
  transactionDate: string | null;
  orderId: string | null;
  amount: { value: string; currency: string } | null;
  totalFeeAmount: { value: string; currency: string } | null;
  payoutId: string | null;
  bookingEntry: string | null; // "CREDIT" | "DEBIT"
}

// Filters transactions modified since `sinceISO` (or the last 90 days when
// omitted). Paginated 200/page; capped at 100 pages so a runaway query
// can't loop forever. The Finances API is on apiz.ebay.com (NOT api.ebay.com),
// so we sidestep fetchAuthed() and roll the request directly.
//
// 404 from this endpoint is benign — eBay returns it when the seller has
// no transactions in the requested window, or when they aren't enrolled in
// Managed Payments. Treat as empty rather than failing the whole sync.
export async function listRecentTransactions(
  userId: string,
  sinceISO?: string | null,
  warnings?: string[],
): Promise<RemoteTransaction[]> {
  const all: RemoteTransaction[] = [];
  const limit = 200;
  let offset = 0;
  let completed = false;
  let total: number | null = null;
  const filterParts: string[] = [];
  if (sinceISO) {
    const iso = new Date(sinceISO).toISOString();
    filterParts.push(`transactionDate:[${iso}..]`);
  }
  const filter = filterParts.length > 0
    ? `&filter=${encodeURIComponent(filterParts.join(","))}`
    : "";

  const token = await getUserAccessToken(userId);
  const locale = localeForMarketplace();
  const baseHost = apizHost();

  for (let i = 0; i < TRANSACTIONS_PAGE_CEILING; i++) {
    const url =
      `${baseHost}/sell/finances/v1/transaction?limit=${limit}&offset=${offset}${filter}`;
    // US-1966: breaker + retry + Retry-After (parity with the main Sell path).
    const res = await ebayResilientFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        Accept: "application/json",
        "Accept-Language": locale,
      },
    });

    // 404 = "no transactions in window" or "not enrolled in Managed Payments".
    // 204/empty-body 200 are the same semantic — eBay sometimes returns those
    // when the window has zero transactions instead of an empty JSON object.
    // All three are recoverable: stop paginating and return what we have.
    if (res.status === 404 || res.status === 204) {
      completed = true;
      break;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `eBay GET ${url} failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }

    const rawBody = await res.text();
    if (!rawBody.trim()) {
      completed = true;
      break;
    }

    let payload: {
      transactions?: Array<{
        transactionId?: string;
        transactionType?: string;
        transactionDate?: string;
        orderId?: string;
        amount?: { value?: string; currency?: string };
        totalFeeAmount?: { value?: string; currency?: string };
        payoutId?: string;
        bookingEntry?: string;
      }>;
      total?: number;
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.warn(
        `[ebay-client] non-JSON body from Finances API (${res.status}); treating as empty. Body: ${rawBody.slice(0, 200)}`,
      );
      completed = true;
      break;
    }
    if (typeof payload.total === "number") total = payload.total;

    const batch = payload.transactions ?? [];
    for (const t of batch) {
      if (!t.transactionId) continue;
      all.push({
        transactionId: t.transactionId,
        transactionType: t.transactionType ?? "",
        transactionDate: t.transactionDate ?? null,
        orderId: t.orderId ?? null,
        amount: t.amount?.value
          ? {
              value: String(t.amount.value),
              currency: t.amount.currency ?? "USD",
            }
          : null,
        totalFeeAmount: t.totalFeeAmount?.value
          ? {
              value: String(t.totalFeeAmount.value),
              currency: t.totalFeeAmount.currency ?? "USD",
            }
          : null,
        payoutId: t.payoutId ?? null,
        bookingEntry: t.bookingEntry ?? null,
      });
    }
    if (batch.length < limit) {
      completed = true;
      break;
    }
    offset += limit;
  }
  if (!completed) {
    warnings?.push(
      truncationWarning(
        "eBay transactions",
        all.length,
        total,
        TRANSACTIONS_PAGE_CEILING * limit,
      ),
    );
  }
  return all;
}

// ── US-1446: Sell Finances payouts ──────────────────────────────────
//
// A payout is the lump sum eBay deposits to the seller's bank; each settles a
// SET of transactions (which carry payoutId, above). Resellers reconcile against
// the deposit, not individual transactions — so we surface payouts and, later,
// their constituent transactions -> net. Same apiz host + sell.finances grant as
// listRecentTransactions; a 404/204 (no payouts / not on Managed Payments) is
// benign and returns [].

export interface RemotePayout {
  payoutId: string;
  payoutStatus: string; // INITIATED | SUCCEEDED | RETRYABLE_FAILED | ...
  payoutDate: string | null;
  amount: { value: string; currency: string } | null;
  /** # of transactions this payout settled, when eBay reports it. */
  transactionCount: number | null;
}

interface PayoutDto {
  payoutId?: string;
  payoutStatus?: string;
  payoutDate?: string;
  amount?: { value?: string; currency?: string };
  transactionCount?: number;
}

function toRemotePayout(p: PayoutDto): RemotePayout | null {
  if (!p.payoutId) return null;
  return {
    payoutId: p.payoutId,
    payoutStatus: p.payoutStatus ?? "",
    payoutDate: p.payoutDate ?? null,
    amount: p.amount?.value
      ? { value: String(p.amount.value), currency: p.amount.currency ?? "USD" }
      : null,
    transactionCount:
      typeof p.transactionCount === "number" ? p.transactionCount : null,
  };
}

/** Recent payouts (newest first), optionally filtered from `sinceISO`. */
export async function getPayouts(
  userId: string,
  sinceISO?: string | null,
  maxPages = 20,
): Promise<RemotePayout[]> {
  const out: RemotePayout[] = [];
  const limit = 200;
  let offset = 0;
  const filter = sinceISO
    ? `&filter=${encodeURIComponent(`payoutDate:[${new Date(sinceISO).toISOString()}..]`)}`
    : "";
  const token = await getUserAccessToken(userId);
  const locale = localeForMarketplace();
  const baseHost = apizHost();

  for (let i = 0; i < maxPages; i++) {
    const url = `${baseHost}/sell/finances/v1/payout?limit=${limit}&offset=${offset}${filter}`;
    // US-1966: breaker + retry + Retry-After (parity with the main Sell path).
    const res = await ebayResilientFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        Accept: "application/json",
        "Accept-Language": locale,
      },
    });
    if (res.status === 404 || res.status === 204) break;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `eBay GET ${url} failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    const rawBody = await res.text();
    if (!rawBody.trim()) break;
    let payload: { payouts?: PayoutDto[] };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      break;
    }
    const batch = payload.payouts ?? [];
    for (const p of batch) {
      const rp = toRemotePayout(p);
      if (rp) out.push(rp);
    }
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

/** A single payout by id. Returns null on 404 (unknown/settled-away payout). */
export async function getPayout(
  userId: string,
  payoutId: string,
): Promise<RemotePayout | null> {
  const token = await getUserAccessToken(userId);
  const locale = localeForMarketplace();
  const url = `${apizHost()}/sell/finances/v1/payout/${encodeURIComponent(payoutId)}`;
  // US-1966: breaker + retry + Retry-After (parity with the main Sell path).
  const res = await ebayResilientFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      Accept: "application/json",
      "Accept-Language": locale,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay GET ${url} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const rawBody = await res.text();
  if (!rawBody.trim()) return null;
  try {
    return toRemotePayout(JSON.parse(rawBody) as PayoutDto);
  } catch {
    return null;
  }
}

// ── US-1475: Commerce Catalog — EPID product adoption ───────────────
//
// Listing against an eBay catalog product (by EPID) auto-populates the required
// item specifics + reduces aspect-compliance violations (see US-1422). Read via
// the app token (client_credentials, base api_scope) exactly like Taxonomy/Browse
// — NO new user-consent scope. A 204/404 (no match / catalog gap) returns
// empty, so callers degrade to AI-only aspects.

export interface CatalogProductMatch {
  epid: string;
  title: string;
  brand: string | null;
  gtins: string[];
  imageUrl: string | null;
}

interface ProductSummarySearchResponse {
  productSummaries?: Array<{
    epid?: string;
    title?: string;
    brand?: string;
    gtins?: string[];
    image?: { imageUrl?: string };
  }>;
}

/** Search eBay's catalog for candidate products (by GTIN and/or brand+mpn+
 *  keywords). Newest/most-relevant first, capped at `limit`. */
export async function searchCatalogProducts(query: {
  gtin?: string | null;
  brand?: string | null;
  mpn?: string | null;
  keywords?: string | null;
  limit?: number;
}): Promise<CatalogProductMatch[]> {
  const params = new URLSearchParams();
  if (query.gtin && query.gtin.trim()) params.set("gtin", query.gtin.trim());
  const q = [query.brand, query.mpn, query.keywords]
    .filter((s) => s && s.trim())
    .join(" ")
    .trim();
  if (q) params.set("q", q);
  // Nothing to search on → no candidates (don't fire a bare query).
  if (![...params.keys()].length) return [];
  params.set("limit", String(query.limit ?? 5));

  const token = await getAppAccessToken();
  const url =
    `${apiHost()}/commerce/catalog/v1_beta/product_summary/search?${params.toString()}`;
  const res = await ebayFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      "Accept-Language": "en-US",
    },
  });
  if (res.status === 204 || res.status === 404) return [];
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`eBay catalog search failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const data = (await res.json()) as ProductSummarySearchResponse;
  return (data.productSummaries ?? [])
    .filter((p) => p.epid)
    .map((p) => ({
      epid: p.epid as string,
      title: p.title ?? "",
      brand: p.brand ?? null,
      gtins: p.gtins ?? [],
      imageUrl: p.image?.imageUrl ?? null,
    }));
}

export interface CatalogProduct {
  epid: string;
  title: string;
  brand: string | null;
  /** Catalog aspects (name → values) — the authoritative specifics to prefer. */
  aspects: Record<string, string[]>;
}

/** Full catalog product by EPID, incl. its authoritative aspects. Null on 404. */
export async function getCatalogProduct(epid: string): Promise<CatalogProduct | null> {
  const token = await getAppAccessToken();
  const url = `${apiHost()}/commerce/catalog/v1_beta/product/${encodeURIComponent(epid)}`;
  const res = await ebayFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      "Accept-Language": "en-US",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`eBay catalog getProduct failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    epid?: string;
    title?: string;
    brand?: string;
    aspects?: Array<{ localizedName?: string; localizedValues?: string[] }>;
  };
  const aspects: Record<string, string[]> = {};
  for (const a of data.aspects ?? []) {
    if (a.localizedName) aspects[a.localizedName] = a.localizedValues ?? [];
  }
  return {
    epid: data.epid ?? epid,
    title: data.title ?? "",
    brand: data.brand ?? null,
    aspects,
  };
}

// ── Browse API: active comps ────────────────────────────────────────

export interface BrowseComp {
  itemId: string;
  title: string;
  price: number | null;
  currency: string;
  /**
   * Cheapest advertised shipping, in cents. 0 for free shipping.
   *
   * NULL means eBay's summary carried no shipping at all, which is a different
   * fact from free and is treated as one: US-3098 compares such a listing on
   * its asking price rather than inventing a zero.
   */
  shippingCents: number | null;
  imageUrl: string | null;
  itemWebUrl: string | null;
  condition: string | null;
  buyingOptions: string[];
  /**
   * Where eBay itself files this listing (US-2764).
   *
   * Browse returns this on every summary and we dropped it for two years. It is
   * the only category signal in the system that comes from a human who listed
   * the actual garment, rather than from a keyword search over a phrase our own
   * model wrote — see categoryVotes for why that matters.
   *
   * Empty when eBay omitted it; never null, so callers can iterate without a
   * guard at every site.
   */
  categories: BrowseCompCategory[];
  /**
   * The leaf eBay itself resolved for this listing.
   *
   * MEASURED, not inferred (probed against production 2026-08-21): Browse
   * returns `leafCategoryIds` as its own field alongside the ancestor chain, so
   * there is no need to walk `categories` guessing which entry is the leaf.
   * A real response looked like:
   *
   *   leafCategoryIds: ["155226"]
   *   categories: 155226 Hoodies & Sweatshirts, 11450 Clothing Shoes &
   *               Accessories, 15724 Women's Clothing, 185098 Activewear,
   *               260010 Women
   *
   * Almost always one entry. Modelled as an array because that is what eBay
   * sends, not because a second one is expected.
   */
  leafCategoryIds: string[];
}

export interface BrowseCompCategory {
  categoryId: string;
  categoryName: string;
}

export interface BrowseCompsArgs {
  // Optional: Browse accepts a search by `q` alone (no category). Demand-term
  // mining (US-546) searches by brand/query before a leaf category is resolved,
  // so this is optional; the comp-pricing callers always pass it.
  categoryId?: string;
  q?: string;
  brand?: string;
  size?: string;
  // UPC/EAN/ISBN barcode. When present, Browse matches the exact product —
  // used by Scout's barcode buy-decision mode (US-592).
  gtin?: string;
  // US-2245: the brand's own style/product code off the tag (e.g. LW7DVCS,
  // 511-0011). Searched VERBATIM as keywords — buildCompKeywords' de-noising is
  // bypassed for it, because a code is not a title token and losing a character
  // of it turns an exact-product match into nothing. Weaker than `gtin` (no
  // registry behind it) but far stronger than a title, so the comps ladder tries
  // it first. Not a filter: eBay has no style-code field, only free text.
  styleCode?: string;
  // Maps to eBay conditionId. Defaults to "3000" (Used) for pre-owned resale.
  conditionId?: string;
  limit?: number;

  // ── US-3098: the sourcing filters ────────────────────────────────────────
  //
  // Every one of these is OPTIONAL and, when absent, emits nothing. That is not
  // tidiness: `cachedSearchBrowseComps` keys its shared cache on the request,
  // and the comp-pricing callers on the seller's Add flow must keep producing a
  // byte-identical URL or every cached comp read in the system misses at once.
  // `browse-comps-url_test.ts` holds that line.

  /** Upper bound on the ASKING price, in cents. Maps to `filter=price:[..x]`. */
  maxPriceCents?: number;
  /** Subset of FIXED_PRICE, AUCTION, BEST_OFFER. Absent = all three. */
  buyingOptions?: readonly string[];
  /**
   * Several condition ids at once, for a sourcing scan that will take anything
   * from "Used" to "For parts". Wins over `conditionId` when both are given.
   */
  conditionIds?: readonly string[];
  /** `filter=maxDeliveryCost:0` — free shipping only. */
  freeShippingOnly?: boolean;
  /** eBay Browse sort. Omitted = Best Match, which is relevance. */
  sort?: BrowseSort;
}

/**
 * The sorts a sourcing scan can ask for.
 *
 * Named in OUR words, mapped to eBay's below. `bestMatch` is the absence of a
 * sort parameter rather than a value, which is exactly the sort of detail that
 * should not leak into a route handler or a phone.
 */
export type BrowseSort = "bestMatch" | "newlyListed" | "endingSoonest" | "priceAsc";

const BROWSE_SORT_PARAM: Record<BrowseSort, string | null> = {
  bestMatch: null,
  newlyListed: "newlyListed",
  endingSoonest: "endingSoonest",
  // eBay spells ascending price as the bare field name; `-price` is descending.
  priceAsc: "price",
};

export interface BrowseCompsResult {
  items: BrowseComp[];
  total: number;
  stats: {
    count: number;
    currency: string;
    min: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
    max: number | null;
  };
  /**
   * Which categories these listings sit in, most-supported first (US-2764).
   *
   * TIES ARE LEFT AS TIES. Two categories with two votes each come back as two
   * entries with count 2, and the caller has to decide what to do about that.
   * Sorting by count and letting the reader take [0] would answer a question
   * the evidence did not settle, using array order as the tiebreak - which is
   * the same mistake as taking rank 1 from a keyword search and calling it the
   * category.
   */
  categoryVotes: BrowseCompCategoryVote[];
  /**
   * The same tally restricted to the LEAF each listing actually sits in.
   *
   * Two arrays because they answer two questions and merging them would lose
   * the distinction that matters. In a real probe, five Lululemon half-zips
   * voted 5-0 for the ancestor "Women's Clothing" while splitting 3-1-1 across
   * Hoodies & Sweatshirts, Activewear Tops and Sweaters. Only a LEAF can be
   * listed into, so this is the decision-grade list; `categoryVotes` is the
   * context that says how confident the neighbourhood is.
   */
  leafCategoryVotes: BrowseCompCategoryVote[];
}

export interface BrowseCompCategoryVote {
  categoryId: string;
  categoryName: string;
  count: number;
}

/**
 * The slice of a Browse itemSummary we read. Both the keyword search and the
 * image search return the same shape, and until US-2764 both mapped it with
 * their own copy of the same nine lines - which is exactly how `categories`
 * came to be parsed by neither of them. One mapper, so a field added here
 * cannot reach one caller and miss the other.
 */
export interface BrowseItemSummary {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  image?: { imageUrl?: string };
  thumbnailImages?: Array<{ imageUrl?: string }>;
  itemWebUrl?: string;
  condition?: string;
  buyingOptions?: string[];
  categories?: Array<{ categoryId?: string; categoryName?: string }>;
  leafCategoryIds?: string[];
  /**
   * US-3098: what delivery costs, so a sourcing filter can compare on what the
   * buyer actually pays rather than on the asking price alone.
   *
   * eBay omits this entirely on plenty of summaries. That is why the total-price
   * rule treats absent shipping as UNKNOWN rather than free — see
   * `totalPriceCents` in lib/scout-scoring.ts.
   */
  shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }>;
}

/** Cheapest shipping across the advertised options, in cents; null when eBay
 * sent none. Free shipping is a real 0 and must not collapse into the null. */
function cheapestShippingCents(s: BrowseItemSummary): number | null {
  const options = s.shippingOptions ?? [];
  let cheapest: number | null = null;
  for (const option of options) {
    const raw = option?.shippingCost?.value;
    if (raw == null) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    const cents = Math.round(value * 100);
    if (cheapest == null || cents < cheapest) cheapest = cents;
  }
  return cheapest;
}

function toBrowseComp(s: BrowseItemSummary): BrowseComp {
  return {
    itemId: s.itemId ?? "",
    title: s.title ?? "",
    price: s.price?.value ? Number(s.price.value) : null,
    currency: s.price?.currency ?? "USD",
    shippingCents: cheapestShippingCents(s),
    imageUrl: s.image?.imageUrl ?? s.thumbnailImages?.[0]?.imageUrl ?? null,
    itemWebUrl: s.itemWebUrl ?? null,
    condition: s.condition ?? null,
    buyingOptions: s.buyingOptions ?? [],
    categories: (s.categories ?? [])
      .filter((c) => typeof c.categoryId === "string" && c.categoryId !== "")
      .map((c) => ({
        categoryId: c.categoryId!,
        categoryName: c.categoryName ?? "",
      })),
    leafCategoryIds: (s.leafCategoryIds ?? []).filter((id) =>
      typeof id === "string" && id !== ""
    ),
  };
}

/** Price percentiles + the category tally, shared by both comp searches. */
function toBrowseCompsResult(
  summaries: readonly BrowseItemSummary[],
  total: number | undefined,
): BrowseCompsResult {
  const items = summaries.map(toBrowseComp);
  const prices = items
    .map((i) => i.price)
    .filter((p): p is number => p != null && p > 0)
    .sort((a, b) => a - b);
  return {
    items,
    total: total ?? items.length,
    stats: {
      count: prices.length,
      currency: items[0]?.currency ?? "USD",
      min: prices[0] ?? null,
      p25: percentile(prices, 0.25),
      median: percentile(prices, 0.5),
      p75: percentile(prices, 0.75),
      max: prices[prices.length - 1] ?? null,
    },
    categoryVotes: tallyCategoryVotes(items),
    leafCategoryVotes: tallyLeafCategoryVotes(items),
  };
}

/**
 * Tally the categories across a set of comps.
 *
 * A listing sits in exactly one leaf category but Browse reports the ancestor
 * chain too, so each listing contributes ONE vote per distinct category id it
 * names. That is deliberate: the ancestors are real information (five listings
 * agreeing on "Women's Tops" while splitting between two leaves is a useful
 * thing to know) and the caller filters to leaves when it needs one.
 */
export function tallyCategoryVotes(
  items: readonly BrowseComp[],
): BrowseCompCategoryVote[] {
  const byId = new Map<string, BrowseCompCategoryVote>();
  for (const item of items) {
    const seen = new Set<string>();
    for (const cat of item.categories) {
      if (!cat.categoryId || seen.has(cat.categoryId)) continue;
      seen.add(cat.categoryId);
      const existing = byId.get(cat.categoryId);
      if (existing) existing.count += 1;
      else {
        byId.set(cat.categoryId, {
          categoryId: cat.categoryId,
          categoryName: cat.categoryName,
          count: 1,
        });
      }
    }
  }
  // Stable within a tie: insertion order is preserved by Map, so equal counts
  // come back in the order eBay returned them rather than in a random one.
  return [...byId.values()].sort((a, b) => b.count - a.count);
}

/**
 * Tally only the leaf each listing sits in.
 *
 * Names are looked up from the same listing's `categories` chain, since
 * `leafCategoryIds` carries ids alone. A leaf whose name is nowhere in the
 * chain still counts - the id is the part that can be listed into, and an
 * unnamed winner is better than a dropped one.
 */
export function tallyLeafCategoryVotes(
  items: readonly BrowseComp[],
): BrowseCompCategoryVote[] {
  const byId = new Map<string, BrowseCompCategoryVote>();
  for (const item of items) {
    const names = new Map(
      item.categories.map((c) => [c.categoryId, c.categoryName]),
    );
    const seen = new Set<string>();
    for (const id of item.leafCategoryIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const existing = byId.get(id);
      if (existing) {
        existing.count += 1;
        // A later listing may name a leaf an earlier one left blank.
        if (!existing.categoryName) {
          existing.categoryName = names.get(id) ?? "";
        }
      } else {
        byId.set(id, {
          categoryId: id,
          categoryName: names.get(id) ?? "",
          count: 1,
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.count - a.count);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

// ── Comp keyword builder (US-1059) ──────────────────────────────────────────
//
// eBay Browse matches the `q` term against listing TITLE text, so feeding it a
// raw garment title verbatim (full of size/color tokens, marketing fluff, and
// stopwords) is over-specific and routinely returns zero comparable items. We
// instead derive a tight keyword query: BRAND first (the single strongest comp
// signal for clothing — and it must be in `q`, not only the aspect filter, so
// it actually constrains the free-text search), then the meaningful title
// tokens, with stopwords / size tokens / color tokens stripped and casing
// normalized. Pure + exported so it is unit-tested without any eBay I/O.

// US-2691: these four moved to lib/title-tokens.ts. The style-code consensus
// needs the same judgement about what in a title is not the product, and a
// second colour list is a second thing to forget to update. Aliased rather than
// renamed at the ~10 call sites below: the COMP_ names say WHY they are applied
// here (comp matching), which the shared names deliberately do not.
const COMP_STOPWORDS = TITLE_FILLER_TOKENS;
const COMP_COLOR_TOKENS = TITLE_COLOR_TOKENS;
const normalizeCompToken = normalizeTitleToken;
const isCompSizeToken = isSizeToken;

export interface CompKeywordInput {
  q?: string;
  brand?: string;
  size?: string;
}

/**
 * Build a normalized keyword query for an eBay Browse comp search. Brand tokens
 * lead, followed by the de-noised title tokens. Stopwords, color tokens, and
 * size tokens (including the caller's explicit `size` value) are dropped, and
 * tokens are deduped case-insensitively. Never returns "" when the caller gave
 * any text: if every token was stripped it falls back to the raw query (then
 * brand), so the search still runs instead of silently degrading.
 */
export function buildCompKeywords(input: CompKeywordInput): string {
  const brand = (input.brand ?? "").trim();
  const rawQ = (input.q ?? "").trim();

  // The explicit size value's own tokens are stripped from the title too
  // (e.g. size "X-Large" removes a stray "x-large" in the title).
  const sizeValueTokens = new Set<string>(
    (input.size ?? "")
      .split(/\s+/)
      .map(normalizeCompToken)
      .filter(Boolean),
  );

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (tok: string) => {
    if (!tok || seen.has(tok)) return;
    seen.add(tok);
    out.push(tok);
  };

  // Brand first — strongest comp signal. May be multi-word ("Calvin Klein").
  for (const raw of brand.split(/\s+/)) {
    const tok = normalizeCompToken(raw);
    if (tok && !COMP_STOPWORDS.has(tok)) push(tok);
  }

  for (const raw of rawQ.split(/\s+/)) {
    const tok = normalizeCompToken(raw);
    if (!tok) continue;
    if (COMP_STOPWORDS.has(tok)) continue;
    if (COMP_COLOR_TOKENS.has(tok)) continue;
    if (isCompSizeToken(tok)) continue;
    if (sizeValueTokens.has(tok)) continue;
    push(tok);
  }

  const keywords = out.join(" ");
  if (keywords) return keywords;
  // Everything got stripped — keep searching rather than dropping to category.
  if (rawQ) return rawQ.toLowerCase();
  return brand.toLowerCase();
}

export async function searchBrowseComps(
  args: BrowseCompsArgs
): Promise<BrowseCompsResult> {
  const token = await getAppAccessToken();
  const filters: string[] = [];
  // US-3098: `conditionIds` (plural) wins when given; otherwise the single
  // `conditionId`, whose default is the one every existing caller relies on.
  const conditions = args.conditionIds && args.conditionIds.length > 0
    ? args.conditionIds.join("|")
    : (args.conditionId ?? "3000");
  filters.push(`conditionIds:{${conditions}}`);
  const buying = args.buyingOptions && args.buyingOptions.length > 0
    ? args.buyingOptions.join("|")
    : "FIXED_PRICE|AUCTION|BEST_OFFER";
  filters.push(`buyingOptions:{${buying}}`);
  // Appended AFTER the two above so the existing callers' filter string is
  // unchanged character for character.
  if (args.maxPriceCents != null && args.maxPriceCents > 0) {
    // eBay's price filter is in the marketplace currency, not cents, and the
    // range form is `[low..high]`. An open lower bound is `[..high]`.
    filters.push(`price:[..${(args.maxPriceCents / 100).toFixed(2)}]`);
    // eBay REQUIRES priceCurrency alongside any price filter, and returns a
    // 400 naming neither field when it is missing.
    filters.push(`priceCurrency:${getMarketplaceCurrency()}`);
  }
  if (args.freeShippingOnly) filters.push("maxDeliveryCost:0");

  // Aspect filter: only the most reliable item-specifics. Brand alone moves
  // the needle hard for clothing comps. Size is more variable across brands.
  const aspectFilters: string[] = [];
  if (args.brand) aspectFilters.push(`Brand:{${args.brand}}`);
  if (args.size) aspectFilters.push(`Size:{${args.size}}`);

  const params = new URLSearchParams();
  if (args.categoryId) params.set("category_ids", args.categoryId);
  const gtin = args.gtin?.trim();
  if (gtin) {
    // Barcode pins the EXACT product — the strongest possible match. Let it
    // dominate; don't also constrain by free-text keywords (would over-filter
    // the exact-product result set down toward zero). Category/condition/price
    // filters below still apply.
    params.set("gtin", gtin);
  } else if (args.styleCode?.trim()) {
    // US-2245: brand + the code, VERBATIM. buildCompKeywords is deliberately
    // skipped: it lowercases and strips edge punctuation, and isCompSizeToken
    // would eat a code shaped like a size (32x34, w32). Category/condition
    // filters and the Brand aspect below still apply.
    params.set(
      "q",
      [args.brand?.trim(), args.styleCode.trim()].filter(Boolean).join(" "),
    );
  } else {
    // US-1059: de-noised, brand-led keyword query (see buildCompKeywords) rather
    // than the raw title — the raw title is over-specific and returns no comps.
    const keywords = buildCompKeywords({
      q: args.q,
      brand: args.brand,
      size: args.size,
    });
    if (keywords) params.set("q", keywords);
  }
  params.set("filter", filters.join(","));
  // aspect_filter requires a categoryId scope; only emit it when present.
  if (args.categoryId && aspectFilters.length > 0) {
    params.set(
      "aspect_filter",
      `categoryId:${args.categoryId},${aspectFilters.join(",")}`
    );
  }
  params.set("limit", String(Math.min(Math.max(args.limit ?? 12, 1), 50)));
  // US-1059: default to eBay Best Match (relevance), which is what Browse uses
  // when `sort` is OMITTED. The old hardcoded "newlyListed" surfaced the newest
  // — not the most comparable — listings. Leaving sort unset = relevance.
  //
  // US-3098: a sourcing scan may ask for another one. `bestMatch` maps to null
  // and still emits nothing, so the comp callers' URL is untouched.
  const sortParam = args.sort ? BROWSE_SORT_PARAM[args.sort] : null;
  if (sortParam) params.set("sort", sortParam);

  const url = `${apiHost()}/buy/browse/v1/item_summary/search?${params.toString()}`;
  const res = await ebayFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay Browse search failed (${res.status}): ${text.slice(0, 300)}`
    );
  }

  const payload = (await res.json()) as {
    itemSummaries?: BrowseItemSummary[];
    total?: number;
  };

  const summaries = payload.itemSummaries ?? [];
  return toBrowseCompsResult(summaries, payload.total);
}

// ── Brand paging for the style-code discovery crawl (US-2782) ───────────
//
// searchBrowseComps cannot page, and it should not learn to. It sits on the
// seller's Add flow, where every call is one garment's comps and an offset is
// meaningless; giving it a fifth optional argument it never uses would put a
// crawl concern on a hot path.
//
// This one exists to walk a brand's live listings from the top down over many
// nights, so the crawl reaches inventory the first page never shows.

export interface BrowseBrandPageArgs {
  /** eBay's Brand aspect matches DISPLAY spelling, not our normalized key. */
  brand: string;
  /** Required: eBay refuses an aspect_filter with no category scope. */
  categoryId: string;
  offset: number;
  limit: number;
}

export interface BrowseBrandListing {
  itemId: string;
  title: string;
  url: string | null;
}

/**
 * One page of a brand's live clothing listings, oldest-crawled offset first.
 *
 * Returns the summaries only. Item specifics are not in the search response, so
 * the caller pays one more call per listing it wants to inspect — which is why
 * the caller's lookup budget, not this page size, is what bounds a crawl.
 */
export async function searchBrowseByBrand(
  args: BrowseBrandPageArgs,
): Promise<{ listings: BrowseBrandListing[]; total: number }> {
  const token = await getAppAccessToken();

  const params = new URLSearchParams();
  params.set("category_ids", args.categoryId);
  // Brand in `q` as well as the aspect filter: Browse matches `q` against title
  // text, and a brand present in only one of the two routinely under-constrains
  // the result set (the same reasoning buildCompKeywords records).
  params.set("q", args.brand);
  params.set(
    "aspect_filter",
    `categoryId:${args.categoryId},Brand:{${args.brand}}`,
  );
  params.set("limit", String(Math.min(Math.max(args.limit, 1), 200)));
  params.set("offset", String(Math.max(0, Math.floor(args.offset))));
  // Newest first. A crawl wants the listings it has not seen, and relevance
  // ordering re-serves the same popular items to every pass.
  params.set("sort", "newlyListed");

  const url = `${apiHost()}/buy/browse/v1/item_summary/search?${params.toString()}`;
  const res = await ebayFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay Browse brand page failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  const payload = (await res.json()) as {
    itemSummaries?: BrowseItemSummary[];
    total?: number;
  };
  const listings = (payload.itemSummaries ?? [])
    .map((s) => ({
      itemId: s.itemId ?? "",
      title: s.title ?? "",
      url: s.itemWebUrl ?? null,
    }))
    .filter((l) => l.itemId !== "");

  return { listings, total: payload.total ?? listings.length };
}

/**
 * US-2786: one page of a category's live listings with NO brand filter.
 *
 * The brand crawl above cannot answer "which brands do sellers tag with style
 * codes", because it filters by brand and therefore only ever sees the brands
 * we already knew to ask about. This walks the category itself so the prospect
 * pass can read the Brand aspect off listings nobody chose.
 *
 * Newest-first for the same reason the brand crawl is: a survey wants inventory
 * it has not already surveyed, and relevance ordering re-serves the same
 * popular items to every pass.
 */
export async function searchBrowseCategoryPage(args: {
  categoryId: string;
  offset: number;
  limit: number;
}): Promise<{ listings: BrowseBrandListing[]; total: number }> {
  const token = await getAppAccessToken();

  const params = new URLSearchParams();
  params.set("category_ids", args.categoryId);
  params.set("limit", String(Math.min(Math.max(args.limit, 1), 200)));
  params.set("offset", String(Math.max(0, Math.floor(args.offset))));
  params.set("sort", "newlyListed");

  const url = `${apiHost()}/buy/browse/v1/item_summary/search?${params.toString()}`;
  const res = await ebayFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay Browse category page failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  const payload = (await res.json()) as {
    itemSummaries?: BrowseItemSummary[];
    total?: number;
  };
  const listings = (payload.itemSummaries ?? [])
    .map((s) => ({
      itemId: s.itemId ?? "",
      title: s.title ?? "",
      url: s.itemWebUrl ?? null,
    }))
    .filter((l) => l.itemId !== "");

  return { listings, total: payload.total ?? listings.length };
}

// ── Visual comps via Browse search_by_image (US-2756) ───────────────────
//
// Post a photo, get visually similar LIVE listings back. It is the closest
// thing on this API to what a reseller means when they say "just look at it" —
// identity and comps arrive in one call, with no Vision model and no metered AI
// action.
//
// UNPROVEN, AND GATED FOR THAT REASON. Nobody has measured it on thrift
// clothing. eBay's index is dominated by retail inventory, so a current-season
// jacket may match beautifully and a faded 1990s one may match nothing. The
// caller keeps it behind SCOUT_EBAY_IMAGE_SEARCH_ENABLED (default off) until a
// spike says otherwise — see lib/scout-identify.ts.
//
// Returns the SAME BrowseCompsResult shape as searchBrowseComps so the two are
// interchangeable to everything downstream, including the value maths.
export interface BrowseImageCompsArgs {
  /** Raw base64 — no data: prefix. eBay rejects the prefixed form. */
  imageBase64: string;
  categoryId?: string;
  conditionId?: string;
  limit?: number;
}

export async function searchBrowseCompsByImage(
  args: BrowseImageCompsArgs,
): Promise<BrowseCompsResult> {
  const token = await getAppAccessToken();

  const params = new URLSearchParams();
  if (args.categoryId) params.set("category_ids", args.categoryId);
  const filters: string[] = [];
  if (args.conditionId) filters.push(`conditionIds:{${args.conditionId}}`);
  if (filters.length) params.set("filter", filters.join(","));
  params.set("limit", String(Math.min(Math.max(args.limit ?? 12, 1), 50)));

  const url =
    `${apiHost()}/buy/browse/v1/item_summary/search_by_image?${params.toString()}`;
  const res = await ebayFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
    },
    body: JSON.stringify({ image: args.imageBase64 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `eBay Browse image search failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  const payload = (await res.json()) as {
    itemSummaries?: BrowseItemSummary[];
    total?: number;
  };

  const summaries = payload.itemSummaries ?? [];
  return toBrowseCompsResult(summaries, payload.total);
}

// ── Sold/realized comps via eBay Marketplace Insights (US-542) ──────────
//
// Browse returns ACTIVE asking prices, which systematically over-state value.
// Marketplace Insights returns LAST_SOLD prices (realized sales) — the honest
// comp basis. The API requires a granted `buy.marketplace.insights` scope, so
// this is OFF by default and gated behind EBAY_MARKETPLACE_INSIGHTS=true; when
// unavailable (disabled, no scope, error) it returns null so callers fall back
// to the private sales table, then to active Browse comps.

const MARKETPLACE_INSIGHTS_SCOPE =
  "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

export function isMarketplaceInsightsEnabled(): boolean {
  return (Deno.env.get("EBAY_MARKETPLACE_INSIGHTS") ?? "").toLowerCase() ===
    "true";
}

/**
 * Search realized (sold) eBay comps via Marketplace Insights. Returns the same
 * stats shape as searchBrowseComps but over LAST_SOLD prices. Returns null when
 * the feature is disabled or the call fails for any reason (so the caller can
 * fall back gracefully) — never throws.
 */
export async function searchSoldComps(
  args: BrowseCompsArgs,
): Promise<BrowseCompsResult | null> {
  if (!isMarketplaceInsightsEnabled()) return null;
  try {
    const token = await getAppAccessToken(MARKETPLACE_INSIGHTS_SCOPE);
    const filters: string[] = [];
    filters.push(`conditionIds:{${args.conditionId ?? "3000"}}`);

    const aspectFilters: string[] = [];
    if (args.brand) aspectFilters.push(`Brand:{${args.brand}}`);
    if (args.size) aspectFilters.push(`Size:{${args.size}}`);

    const params = new URLSearchParams();
    if (args.categoryId) params.set("category_ids", args.categoryId);
    // US-2245: when the ladder won on the style-code rung, the sold search must
    // ask the same question — the code, not the title it replaced.
    const soldQ = args.styleCode?.trim()
      ? [args.brand?.trim(), args.styleCode.trim()].filter(Boolean).join(" ")
      : args.q?.trim();
    if (soldQ) params.set("q", soldQ);
    params.set("filter", filters.join(","));
    if (args.categoryId && aspectFilters.length > 0) {
      params.set(
        "aspect_filter",
        `categoryId:${args.categoryId},${aspectFilters.join(",")}`,
      );
    }
    params.set("limit", String(Math.min(Math.max(args.limit ?? 25, 1), 100)));

    const url =
      `${apiHost()}/buy/marketplace_insights/v1_beta/item_sales/search?${params.toString()}`;
    const res = await ebayFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[ebay] Marketplace Insights search failed (${res.status}): ${
          text.slice(0, 200)
        }`,
      );
      return null;
    }

    const payload = (await res.json()) as {
      itemSales?: Array<{
        itemId?: string;
        title?: string;
        lastSoldPrice?: { value?: string; currency?: string };
        image?: { imageUrl?: string };
        itemWebUrl?: string;
        condition?: string;
      }>;
      total?: number;
    };

    const sales = payload.itemSales ?? [];
    const items: BrowseComp[] = sales.map((s) => ({
      itemId: s.itemId ?? "",
      title: s.title ?? "",
      price: s.lastSoldPrice?.value ? Number(s.lastSoldPrice.value) : null,
      currency: s.lastSoldPrice?.currency ?? "USD",
      imageUrl: s.image?.imageUrl ?? null,
      itemWebUrl: s.itemWebUrl ?? null,
      condition: s.condition ?? null,
      buyingOptions: [],
      // Marketplace Insights reports no shipping on a completed sale, and the
      // honest value for "this source cannot say" is null, not zero (US-3098).
      shippingCents: null,
      // Marketplace Insights reports no category on a sale, so these stay empty
      // and categoryVotes comes back empty with them. That is the honest
      // answer: "this source cannot say", not "the listings disagreed".
      categories: [],
      leafCategoryIds: [],
    }));

    const prices = items
      .map((i) => i.price)
      .filter((p): p is number => p != null && p > 0)
      .sort((a, b) => a - b);
    const currency = items[0]?.currency ?? "USD";

    return {
      items,
      total: payload.total ?? items.length,
      stats: {
        count: prices.length,
        currency,
        min: prices[0] ?? null,
        p25: percentile(prices, 0.25),
        median: percentile(prices, 0.5),
        p75: percentile(prices, 0.75),
        max: prices[prices.length - 1] ?? null,
      },
      categoryVotes: tallyCategoryVotes(items),
      leafCategoryVotes: tallyLeafCategoryVotes(items),
    };
  } catch (err) {
    console.error(
      "[ebay] searchSoldComps error:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ── App token (client_credentials) ──────────────────────────────────
// Used for Taxonomy + Browse — endpoints that don't need a seller context.

const DEFAULT_APP_SCOPE = "https://api.ebay.com/oauth/api_scope";
// US-571: the app token is shared across the cluster (not minted per replica).
// One cache per scope: Marketplace Insights (US-542) needs an extra scope and
// would otherwise thrash a single slot with the default-scope token. The cache
// key carries the eBay env so a sandbox token is never reused in production.
const appTokenCaches = new Map<string, SharedTokenCache>();

function appTokenCacheFor(scope: string): SharedTokenCache {
  let cache = appTokenCaches.get(scope);
  if (!cache) {
    cache = createSharedTokenCache({
      cacheKey: `ebay-app-token:${getEbayEnv()}:${scope}`,
    });
    appTokenCaches.set(scope, cache);
  }
  return cache;
}

export async function getAppAccessToken(
  scope: string = DEFAULT_APP_SCOPE,
): Promise<string> {
  return await appTokenCacheFor(scope).get(async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope,
    });
    const res = await ebayFetch(`${apiHost()}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`eBay app token request failed (${res.status}): ${text}`);
    }
    const payload = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    return { token: payload.access_token, expiresInMs: payload.expires_in * 1000 };
  });
}

// ── US-673: Negotiation API (seller-initiated offers to buyers) ────────────
//
// The Negotiation REST API lets a seller proactively send a discounted offer to
// buyers who have shown interest (watchers / cart adds) on eligible listings.
// Requires the sell.negotiation OAuth scope. (Incoming buyer best-offers +
// accept/decline/counter live on the Trading API — see ebay-trading.ts.)

export interface EligibleNegotiationItem {
  listingId: string;
  // eBay returns this only on some marketplaces; best-effort.
  title: string | null;
}

/// Lists listings eligible for a seller-initiated offer to interested buyers.
export async function findEligibleNegotiationItems(
  userId: string,
  limit = 50,
): Promise<EligibleNegotiationItem[]> {
  const body = await fetchAuthed<{
    eligibleItems?: Array<{ listingId?: string; title?: string }>;
  }>(
    userId,
    `/sell/negotiation/v1/find_eligible_items?limit=${limit}`,
  );
  return (body.eligibleItems ?? [])
    .filter((it) => typeof it.listingId === "string")
    .map((it) => ({ listingId: it.listingId as string, title: it.title ?? null }));
}

// US-1062: a single eligible listing's display fields, fetched best-effort from
// the Browse API when we have no local row for it (e.g. a listing created
// outside GradeThread). Browse's get_item_by_legacy_id resolves a public eBay
// listing id (the same numeric id find_eligible_items returns) to its title,
// price, image and condition.
export interface BrowseItemLite {
  title: string | null;
  price: number | null;
  currency: string;
  imageUrl: string | null;
  condition: string | null;
}

/**
 * US-2751: one listing's ITEM SPECIFICS.
 *
 * The Browse SEARCH response does not carry them — item_summary omits
 * localizedAspects entirely — so learning from what a seller FILLED IN rather
 * than what they wrote costs a second call per listing. That is the price of
 * not building a database out of marketing text.
 *
 * Returns null rather than throwing: an aspect read that fails costs one
 * listing's evidence, never the sweep's tick.
 */
export async function getBrowseItemAspects(
  itemId: string,
): Promise<{ itemId: string; title: string; aspects: Record<string, string> } | null> {
  try {
    const token = await getAppAccessToken();
    const url = `${apiHost()}/buy/browse/v1/item/${encodeURIComponent(itemId)}`;
    const res = await ebayFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      },
    });
    if (!res.ok) return null;
    const item = (await res.json()) as {
      title?: string;
      localizedAspects?: Array<{ type?: string; name?: string; value?: string }>;
    };
    const aspects: Record<string, string> = {};
    for (const a of item.localizedAspects ?? []) {
      const name = (a.name ?? "").trim();
      const value = (a.value ?? "").trim();
      // First value wins: eBay repeats a name for multi-valued aspects, and a
      // style code is single-valued in every category that offers one.
      if (name && value && !(name in aspects)) aspects[name] = value;
    }
    return { itemId, title: item.title ?? "", aspects };
  } catch (err) {
    console.error("[ebay-client] getBrowseItemAspects failed:", err);
    return null;
  }
}

export async function getBrowseItemByLegacyId(
  legacyItemId: string,
): Promise<BrowseItemLite | null> {
  try {
    const token = await getAppAccessToken();
    const url = `${apiHost()}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${
      encodeURIComponent(legacyItemId)
    }`;
    const res = await ebayFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
      },
    });
    if (!res.ok) return null;
    const s = (await res.json()) as {
      title?: string;
      price?: { value?: string; currency?: string };
      image?: { imageUrl?: string };
      thumbnailImages?: Array<{ imageUrl?: string }>;
      condition?: string;
    };
    return {
      title: s.title ?? null,
      price: s.price?.value ? Number(s.price.value) : null,
      currency: s.price?.currency ?? "USD",
      imageUrl: s.image?.imageUrl ?? s.thumbnailImages?.[0]?.imageUrl ?? null,
      condition: s.condition ?? null,
    };
  } catch (err) {
    console.error("[ebay-client] getBrowseItemByLegacyId failed:", err);
    return null;
  }
}

/// Sends a percentage-or-price offer to interested buyers on the given listings.
/// `offerType` "PERCENTAGE_DISCOUNT" expects priceOrPercent like "10" (10% off);
/// "PRICE" expects an absolute price value.
export async function sendOfferToInterestedBuyers(
  userId: string,
  args: {
    listingIds: string[];
    message?: string;
    discountPercentage?: string;
    durationHours?: number;
  },
  // US-1507: send via the connection that owns these listings (null → primary).
  // The route groups listing ids per connection before calling.
  connectionId?: string,
): Promise<void> {
  const offers = args.listingIds.map((id) => ({
    offeredItems: [{ listingId: id, quantity: 1, discountPercentage: args.discountPercentage }],
  }));
  await fetchAuthed<unknown>(
    userId,
    `/sell/negotiation/v1/send_offer_to_interested_buyers`,
    {
      method: "POST",
      body: JSON.stringify({
        offeredItems: offers.flatMap((o) => o.offeredItems),
        message: args.message,
        offerDuration: args.durationHours
          ? { unit: "DAY", value: Math.max(1, Math.round(args.durationHours / 24)) }
          : { unit: "DAY", value: 2 },
        allowCounterOffer: true,
      }),
    },
    connectionId,
  );
}

// ── US-2977: eBay ids are not reliably strings ──────────────────────────────
//
// Every post-order response type in this codebase declares its id fields as
// `string`, and a TypeScript type is a claim about JSON that nothing checks.
// eBay sends `legacyOrderId` as a NUMBER for at least some inquiries, `??`
// passes it straight through, and the wrong type travels untouched until
// something calls a string method on it. Measured in production 2026-08-31:
//
//   inquiry 5384833027: ev.orderLabel?.trim is not a function
//
// which had failed the marketplace-events sweep every fifteen minutes since
// 2026-08-27 12:15 UTC. `?.` looks like the guard and is not — it answers for
// null and undefined and says nothing about a number.
//
// NOT `String(v)`, and the distinction is the whole point: String(null) is the
// four-character string "null", which renders to a seller as "A buyer says null
// never arrived" and throws nothing to say so. A missing id must stay missing —
// the callers all fall back to "an order" for exactly that case.
//
// Objects are refused rather than stringified for the same reason: an id that
// arrives as `{value: "123"}` would become "[object Object]", and a nesting
// change should surface as a null the normalizer's own tests can catch, not as
// a plausible-looking label in a customer's inbox.
export function ebayId(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "bigint") return String(v);
  return null;
}
