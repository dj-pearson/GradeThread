import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import { resolveItemAspects } from "../lib/aspect-registry.ts";
import type { RegistryAspect } from "../lib/aspect-registry.ts";
import {
  type AspectSourceMap,
  mergeSources,
  requiredMissingAspects,
  sourcesFor,
} from "../lib/aspect-provenance.ts";
import {
  type PublishAspectDiagnostic,
  reconcilePublishAspects,
  type ReconcileSpec,
} from "../lib/aspect-reconcile.ts";
import {
  buildConsentUrl,
  createInventoryLocation,
  createOffer,
  createOrReplaceInventoryItem,
  createShippingFulfillment,
  debugSnapshot,
  ebayListingUrl,
  exchangeCodeForTokens,
  getCategoryAspects,
  getCategoryName,
  getItemConditionPolicies,
  getMarketplaceId,
  getTrafficReport,
  getUserAccessToken,
  isAnalyticsAccessDenied,
  getUserIdentityFromToken,
  isEbayConfigured,
  isOfferAlreadyExistsError,
  listAllOffers,
  listOffersForSku,
  listRecentOrders,
  listRecentTransactions,
  publishOrAdoptOffer,
  createOrReplaceInventoryItemGroup,
  publishItemGroupOrAdopt,
  resolveCachedDefaults,
  revokeEbayUserToken,
  searchBrowseComps,
  setDefaultPolicies,
  suggestCategories,
  syncBusinessPolicies,
  syncExistingOffer,
  updateOfferFields,
  updateOfferPrice,
  bulkUpdatePriceQuantity,
  EBAY_BULK_MAX,
  upsertConnection,
  withdrawOffer,
  findEligibleNegotiationItems,
  sendOfferToInterestedBuyers,
  type BestOfferTerms,
  type PricingSummary,
  type PolicySet,
  type RemoteOffer,
  type RemoteOrder,
  type RemoteOrderLineItem,
  type RemoteTransaction,
} from "../lib/ebay-client.ts";
// US-713: the Depop connector shares this token-refresh cron (no separate
// Coolify task). The sweep is a no-op while DEPOP_ENABLED is off.
import { refreshExpiringDepopConnections } from "../lib/depop-client.ts";
import {
  centsToMoneyString,
  resolveBestOfferThresholds,
} from "../lib/best-offer.ts";
import { decryptToken } from "../lib/crypto-aes.ts";
import { finalizePublishedListing } from "../lib/ebay-publish-finalize.ts";
import { autoEndCrossListings } from "../lib/cross-listings.ts";
import {
  recordSourceObservations,
  type SourceObservation,
} from "../lib/sync-conflicts.ts";
import { fetchWithTimeout } from "../lib/circuit-breaker.ts";
import { compositeGradeBadge } from "../lib/grade-badge.ts";
import {
  captureListingAcceptance,
  markListingPromptSold,
} from "../lib/listing-acceptance.ts";
import {
  type ExistingSaleRow,
  normalizeUnitCount,
  pickSaleRowForLine,
} from "../lib/ebay-order-lines.ts";
import {
  checkImageReachability,
  dedupeAndCapImages,
  EBAY_MAX_IMAGES as PREFLIGHT_MAX_IMAGES,
  imageCapBlocker,
  reachabilityBlocker,
  validateConditionForCategory,
} from "../lib/publish-preflight.ts";
import {
  getAllActiveEbaySelling,
  getItemSpecifics,
  getBestOffers,
  respondToBestOffer,
  getMemberMessages,
  replyToMemberMessage,
  leaveFeedback,
  getOrderLegacyLineItems,
  type BestOfferAction,
  type LegacyEbayListing,
} from "../lib/ebay-trading.ts";
import {
  buildCatalogPatch,
  type CatalogPatch,
  FILL_IF_BLANK_FIELDS,
  flattenAspects,
  type LocalCatalog,
} from "../lib/ebay-catalog-merge.ts";
import { parseEbayPayoutsCsv } from "../lib/ebay-payouts-csv.ts";
import { ingestPayoutsForUser } from "../lib/ebay-payout-dedup.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { claimSyncRun, failSyncRun } from "../lib/sync-run-lock.ts";
import { EBAY_PUBLISH_GENERIC_FIX, mapEbayError } from "../lib/ebay-error-map.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog, writeSystemAuditLog } from "../lib/audit-log.ts";
import { getSetting } from "../lib/system-settings.ts";
import { deriveListingOrigin } from "../lib/sync-precedence.ts";
import {
  buildPriceQtyRequest,
  chunk,
  normalizeBulkEntry,
  type PriceQtyUpdate,
} from "../lib/ebay-bulk.ts";
import {
  approveCancellation,
  decideReturn,
  issueReturnRefund,
  outcomeToSaleStatus,
  rejectCancellation,
  searchCancellations,
  searchReturns,
} from "../lib/ebay-postorder.ts";
import {
  acceptPaymentDispute,
  contestPaymentDispute,
  disputeOutcomeToSaleStatus,
  getPaymentDispute,
  searchPaymentDisputes,
} from "../lib/ebay-disputes.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { pushSaleCreated, pushTokenExpiring } from "../lib/transactional-push.ts";
import { notifyUser } from "../lib/notify.ts";
import {
  attachPromotionAtPublish,
  clampMarkdownPct,
  createAdForListing,
  createMarkdownSale,
  endMarkdownSale,
  ensureAdCampaign,
  getAdForListing,
  removeAdForListing,
  resolvePublishAdRate,
  suggestedAdRateForCategory,
  syncPromotedListingsForOwner,
  updateAdRateForListing,
} from "../lib/ebay-marketing.ts";

// eBay integration endpoints. Mounted at /api/flipdesk/ebay.
//
// Auth split:
//   - /oauth/start   → user-authed (initiates from inside the app)
//   - /oauth/callback → public (eBay redirects the browser here unauthed;
//                       state token from the oauth_states table identifies
//                       the user)
//   - /oauth/refresh → internal job secret (scheduled rotation)
//   - everything else → user-authed via main.ts middleware
//
// Required env: EBAY_APP_ID, EBAY_CERT_ID, EBAY_DEV_ID, EBAY_RU_NAME,
//               EBAY_REDIRECT_URI, EBAY_ENV, EDGE_ENCRYPTION_KEY.

type EbayEnv = {
  Variables: {
    userId: string;
    // Workspace owner — marketplace connections, listings, and payouts all
    // live on the workspace owner since they hold the OAuth tokens.
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// ── Diagnostics ────────────────────────────────────────────────────
// GET /oauth/debug — returns a sanitized snapshot of how the edge service
// resolved the eBay env vars. No secrets. Use this to spot sandbox/prod
// mismatches and whitespace problems without grepping Coolify settings.
// When a JWT is present we also include this user's account_handle status
// so US-315 backfill can be verified at a glance.
flipdeskEbayRoutes.get("/oauth/debug", async (c) => {
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as string | undefined;
  return c.json(await debugSnapshot(userId));
});

// ── OAuth: start ───────────────────────────────────────────────────
// Returns { consent_url } for the SPA to window.location to. The state
// token is persisted server-side so the callback can verify+identify.
flipdeskEbayRoutes.get("/oauth/start", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const redirectTo = sanitizeRelativePath(c.req.query("redirect_to"));

  // US-382: enforce the marketplace-connection cap server-side. A reconnect of
  // an existing eBay connection must NOT be blocked (it updates the same row,
  // not a new marketplace), so only count +1 when there's no active eBay
  // connection yet.
  const { count: activeEbay } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true);
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "marketplaces", delta: (activeEbay ?? 0) > 0 ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const state = generateState();
  const { error } = await supabaseAdmin.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace: "ebay",
    redirect_to: redirectTo,
    // Tighten the lifetime to 10 min (overrides the 15-min table default). (US-274)
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) {
    console.error("[flipdesk-ebay] failed to persist oauth state:", error);
    return c.json({ error: "Could not start eBay sign-in." }, 500);
  }

  let consentUrl: string;
  try {
    consentUrl = buildConsentUrl(state);
  } catch (err) {
    console.error("[flipdesk-ebay] could not build consent URL:", err);
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  // Log the (non-secret) host the browser is about to hit — makes
  // sandbox/production mismatches obvious in Coolify logs.
  console.log(
    `[flipdesk-ebay] consent URL built: host=${new URL(consentUrl).host}`
  );
  return c.json({ consent_url: consentUrl });
});

// ── OAuth: callback (PUBLIC) ───────────────────────────────────────
// eBay redirects the browser here. We verify the state token, exchange the
// code for tokens, store them encrypted, then redirect the user back into
// the app (or to /dashboard/flipdesk/marketplaces by default).
flipdeskEbayRoutes.get("/oauth/callback", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const ebayError = c.req.query("error");
  const ebayErrorDesc = c.req.query("error_description");

  // Resolve the bounce-back destination up front. The web flow has no
  // redirect_to and falls back to the dashboard; the iOS app (US-661) passes
  // an https Universal Link under `/app/oauth/ebay` (with its client_state
  // nonce already in the query) so ASWebAuthenticationSession.Callback.https
  // completes the in-app session deterministically. We read + delete the
  // single-use state row here (when present) so a replay can't reuse it, and
  // so EVERY exit path — including errors — bounces back to the SAME claimed
  // destination (otherwise the iOS web-auth session would hang on an
  // unclaimed https URL on cancel/exchange failures).
  let redirectTo: string | null = null;
  let stateUserId: string | null = null;
  let stateFound = false;
  let stateExpired = false;
  if (state) {
    const { data: stateRow } = await supabaseAdmin
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .eq("marketplace", "ebay")
      .select("user_id, redirect_to, expires_at")
      .maybeSingle();
    if (stateRow) {
      stateFound = true;
      // Defense-in-depth: redirect_to was sanitized at /oauth/start, but
      // re-check here so a legacy/oddly-stored row can't drive an open
      // redirect. (US-274)
      redirectTo = sanitizeRelativePath(stateRow.redirect_to);
      stateUserId = stateRow.user_id;
      stateExpired = new Date(stateRow.expires_at).getTime() < Date.now();
    }
  }

  // Append the `?ebay=<status>` discriminator to whichever destination we
  // bounce to, preserving any query the caller already passed (e.g. the iOS
  // client_state nonce) — `&` when a query already exists, `?` otherwise.
  const finish = (status: string) => {
    const base = redirectTo ?? "/dashboard/flipdesk/marketplaces";
    const sep = base.includes("?") ? "&" : "?";
    return c.redirect(appUrl(`${base}${sep}ebay=${encodeURIComponent(status)}`));
  };

  // eBay sends `error=access_denied` when the user cancels at the consent
  // screen. Other error codes (e.g. unauthorized_client) signal config bugs
  // — log the description so the operator can see it without having to dig
  // through eBay's redirect URL.
  if (ebayError) {
    console.error(
      `[flipdesk-ebay] consent error: ${ebayError} — ${ebayErrorDesc ?? "(no description)"}`
    );
    return finish(ebayError === "access_denied" ? "cancelled" : ebayError);
  }
  if (!code || !state) {
    return finish("cancelled");
  }
  if (!stateFound || !stateUserId) {
    return finish("invalid_state");
  }
  if (stateExpired) {
    return finish("state_expired");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    // US-315: capture the seller's eBay username at connect time so webhooks
    // and admin views know which account a listing publishes under. Identity
    // lookup is non-fatal — a 4xx/network blip should not block connect; the
    // refresh path will backfill on the next token rotation.
    const identity = await getUserIdentityFromToken(tokens.access_token);
    await upsertConnection({
      userId: stateUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresInSeconds: tokens.expires_in,
      accountHandle: identity?.username ?? null,
      // US-364: stable id powers verified account-deletion matching.
      externalAccountId: identity?.externalAccountId ?? null,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] OAuth exchange failed:", err);
    return finish("exchange_failed");
  }

  return finish("connected");
});

// ── Disconnect ─────────────────────────────────────────────────────
// User-initiated removal of an eBay connection. US-364: before we drop the
// stored tokens we attempt to REVOKE the grant upstream at eBay (where the
// keyset supports it) so the long-lived refresh token isn't left valid after
// the seller disconnects. Revocation is best-effort — we always deactivate +
// null the local tokens regardless of the upstream result.
//
// Tenant-scoped: only the workspace owner's (or the user's own) ebay rows are
// touched — never an id from the request body.
flipdeskEbayRoutes.post("/disconnect", async (c) => {
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { data: rows, error: loadErr } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, refresh_token_encrypted, access_token_encrypted")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true);
  if (loadErr) {
    return c.json({ error: "Could not load eBay connection." }, 500);
  }
  if (!rows || rows.length === 0) {
    // Already disconnected — idempotent success.
    return c.json({ ok: true, revoked: false });
  }

  // Best-effort upstream revoke per connection. Revoking the refresh token
  // invalidates the whole grant; fall back to the access token if that's all
  // we have. Decryption uses the owning user_id as AAD (US-352).
  let revoked = false;
  for (const row of rows) {
    const enc = (row.refresh_token_encrypted ?? row.access_token_encrypted) as
      | string
      | null;
    if (!enc) continue;
    try {
      const token = await decryptToken(enc, { aad: userId });
      const result = await revokeEbayUserToken(
        token,
        row.refresh_token_encrypted ? "refresh_token" : "access_token",
      );
      if (result === "revoked") revoked = true;
    } catch (err) {
      // Never block local deactivation on a decrypt/revoke failure.
      console.warn(
        "[flipdesk-ebay] disconnect revoke failed (continuing):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const { error: deactErr } = await supabaseAdmin
    .from("marketplace_connections")
    .update({
      is_active: false,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      refresh_error: "disconnected",
    })
    .eq("user_id", userId)
    .eq("marketplace", "ebay");
  if (deactErr) {
    return c.json({ error: "Could not disconnect eBay." }, 500);
  }
  return c.json({ ok: true, revoked });
});

// ── OAuth: refresh ─────────────────────────────────────────────────
// Scheduled job entrypoint. Authenticated via FLIPDESK_INTERNAL_JOB_SECRET
// header so the cron worker can hit it without a user Bearer token. Rotates
// any token expiring in the next 24 hours.
flipdeskEbayRoutes.post("/oauth/refresh", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const horizon = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const { data: expiring, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .lt("token_expires_at", horizon);

  if (error) {
    console.error("[flipdesk-ebay] refresh scan failed:", error);
    return c.json({ error: "Refresh scan failed" }, 500);
  }

  const userIds = Array.from(
    new Set(((expiring ?? []) as { user_id: string }[]).map((r) => r.user_id))
  );

  let refreshed = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      // getUserAccessToken refreshes inline when expiry is near.
      await getUserAccessToken(userId);
      refreshed += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[flipdesk-ebay] refresh failed for user ${userId}:`,
        err instanceof Error ? err.message : err
      );
      // US-626: auto-refresh couldn't renew — nudge the user (iOS) to reconnect.
      void pushTokenExpiring(userId);
    }
  }
  // US-713: same cron run also sweeps Depop connections nearing expiry (shared
  // token-refresh worker alongside eBay). No-op while the connector is disabled.
  const depop = await refreshExpiringDepopConnections();
  return c.json({ scanned: userIds.length, refreshed, failed, depop });
});

// ── US-151: listing-performance sync (views / watchers / impressions) ──
//
// POST /api/flipdesk/ebay/sync/performance — internal cron (every 6h via
// US-131 scheduler). Pulls Sell Analytics getTrafficReport per active eBay
// connection and writes engagement metrics onto that seller's active listings.
//
// Sell Analytics is a separate grant; sellers on a pre-scope token get a 403.
// We treat that as "access not granted" (flag the connection, skip) rather than
// a failure so one un-upgraded seller never fails the whole batch. The UI reads
// marketplace_connections.analytics_access_denied to prompt a reconnect.

interface PerfListingRow {
  id: string;
  platform_listing_id: string | null;
  watchers: number;
  views_total: number;
  view_trend_7d: Array<{ date: string; views: number }> | null;
}

/** Pull metrics for one seller and write them onto their active eBay listings.
 *  Returns the per-user outcome for the batch summary. */
async function syncListingPerformanceForUser(
  userId: string,
): Promise<{ updated: number; accessDenied: boolean }> {
  let traffic;
  try {
    traffic = await getTrafficReport(userId);
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) {
      await supabaseAdmin
        .from("marketplace_connections")
        .update({ analytics_access_denied: true })
        .eq("user_id", userId)
        .eq("marketplace", "ebay");
      return { updated: 0, accessDenied: true };
    }
    throw err;
  }

  // Access worked — clear any stale denial flag.
  await supabaseAdmin
    .from("marketplace_connections")
    .update({ analytics_access_denied: false })
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("analytics_access_denied", true);

  const byListingId = new Map(traffic.map((t) => [t.listingId, t]));

  // This seller's active eBay listings (tenant-scoped via inventory_items —
  // listings has no user_id of its own, US-268).
  const { data: listingRows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_listing_id, watchers, views_total, view_trend_7d, inventory_items!inner(user_id)",
    )
    .eq("platform", "ebay")
    .eq("listing_status", "active")
    .eq("inventory_items.user_id", userId)
    .not("platform_listing_id", "is", null);

  const rows = (listingRows ?? []) as unknown as PerfListingRow[];
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  let updated = 0;

  // US-565: per-day time-series rows behind the listings snapshot columns. One
  // row per (listing, today); upsert so a re-run within the day overwrites.
  const metricRows: Array<{
    listing_id: string;
    user_id: string;
    metric_date: string;
    impressions: number;
    views: number;
    watchers: number;
    click_through_rate: number | null;
  }> = [];

  for (const row of rows) {
    const metrics = row.platform_listing_id
      ? byListingId.get(row.platform_listing_id)
      : undefined;

    // watchers_count mirrors the watcher total kept fresh by the listings pull
    // (getTrafficReport doesn't return watchers) so the analytics columns are
    // self-contained. Stamp every active listing; layer traffic on when eBay
    // reported engagement for it.
    const patch: Record<string, unknown> = {
      watchers_count: row.watchers ?? 0,
      last_metrics_synced_at: nowIso,
    };

    if (metrics) {
      // Rolling 7-day sparkline series: one point per day, latest snapshot
      // wins, keep the most recent 7.
      const prev = Array.isArray(row.view_trend_7d) ? row.view_trend_7d : [];
      const trend = prev.filter((p) => p && p.date !== today);
      trend.push({ date: today, views: metrics.views });
      patch.views_total = metrics.views;
      patch.impressions_7d = metrics.impressions;
      patch.click_through_rate = metrics.clickThroughRate;
      patch.view_trend_7d = trend.slice(-7);

      metricRows.push({
        listing_id: row.id,
        user_id: userId,
        metric_date: today,
        impressions: metrics.impressions,
        views: metrics.views,
        watchers: row.watchers ?? 0,
        click_through_rate: metrics.clickThroughRate,
      });
    }

    const { error } = await supabaseAdmin
      .from("listings")
      .update(patch)
      .eq("id", row.id);
    if (!error) updated += 1;
  }

  // Persist the day's time-series rows in one upsert (US-565). Best-effort: a
  // metrics-history write must never fail the snapshot sync above.
  if (metricRows.length > 0) {
    const { error: metricsErr } = await supabaseAdmin
      .from("listing_metrics")
      .upsert(metricRows, { onConflict: "listing_id,metric_date" });
    if (metricsErr) {
      console.error(
        "[flipdesk-ebay] listing_metrics upsert failed:",
        metricsErr.message,
      );
    }
  }

  return { updated, accessDenied: false };
}

flipdeskEbayRoutes.post("/sync/performance", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  const { data: conns, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "ebay")
    .eq("is_active", true);
  if (error) {
    console.error("[flipdesk-ebay] performance scan failed:", error);
    return c.json({ error: "Performance scan failed" }, 500);
  }

  const userIds = Array.from(
    new Set(((conns ?? []) as { user_id: string }[]).map((r) => r.user_id)),
  );

  let updated = 0;
  let accessDenied = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      const r = await syncListingPerformanceForUser(userId);
      updated += r.updated;
      if (r.accessDenied) accessDenied += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[flipdesk-ebay] performance sync failed for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return c.json({ scanned: userIds.length, updated, accessDenied, failed });
});

// ── US-314: business policies + merchant location ────────────────────
//
// GET  /policies          → list cached policies + locations (syncs if empty);
//                           tenant-scoped to the workspace owner.
// PUT  /policies/default  → set the default policy of each kind (and merchant
//                           location key) — written to business_policies and
//                           marketplace_connections respectively.
// POST /policies/sync     → force a fresh pull from eBay (UI "Re-sync" button).

interface BusinessPolicyRow {
  policy_id: string;
  policy_type: "fulfillment" | "payment" | "return";
  policy_name: string;
  is_default: boolean;
  synced_from_ebay_at: string | null;
}

async function listCachedPolicies(userId: string) {
  const { data } = await supabaseAdmin
    .from("business_policies")
    .select("policy_id, policy_type, policy_name, is_default, synced_from_ebay_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .order("policy_type", { ascending: true })
    .order("policy_name", { ascending: true });
  return (data ?? []) as BusinessPolicyRow[];
}

async function loadMerchantLocationKey(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("marketplace_connections")
    .select("merchant_location_key")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: read the selected (primary) connection's ship-from location.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { merchant_location_key: string | null } | null)
    ?.merchant_location_key ?? null;
}

flipdeskEbayRoutes.get("/policies", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    let policies = await listCachedPolicies(ownerId);
    let merchantLocationKey = await loadMerchantLocationKey(ownerId);

    // Empty cache → sync once so the UI has something to render.
    if (policies.length === 0) {
      await syncBusinessPolicies(ownerId);
      policies = await listCachedPolicies(ownerId);
      merchantLocationKey = await loadMerchantLocationKey(ownerId);
    }

    const defaults = {
      fulfillment_policy_id:
        policies.find((p) => p.policy_type === "fulfillment" && p.is_default)?.policy_id ?? null,
      payment_policy_id:
        policies.find((p) => p.policy_type === "payment" && p.is_default)?.policy_id ?? null,
      return_policy_id:
        policies.find((p) => p.policy_type === "return" && p.is_default)?.policy_id ?? null,
      merchant_location_key: merchantLocationKey,
    };
    return c.json({ policies, defaults });
  } catch (err) {
    console.error("[flipdesk-ebay] /policies failed:", err);
    return c.json({ error: "Could not load eBay policies." }, 502);
  }
});

flipdeskEbayRoutes.post("/policies/sync", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const result = await syncBusinessPolicies(ownerId);
    return c.json({
      synced: result.policies.length,
      merchant_location_key: result.merchantLocationKey,
      missing: result.missing,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] /policies/sync failed:", err);
    return c.json({ error: "Could not sync eBay policies." }, 502);
  }
});

flipdeskEbayRoutes.put("/policies/default", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    fulfillment_policy_id?: unknown;
    payment_policy_id?: unknown;
    return_policy_id?: unknown;
    merchant_location_key?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate each id by checking it exists in this workspace's cached
  // policies — prevents writing a stale or foreign id as default. Tenant
  // isolation: ownership is implicit in the user_id-scoped lookup.
  const cached = await listCachedPolicies(ownerId);
  const idsByKind = new Map<string, Set<string>>();
  for (const row of cached) {
    if (!idsByKind.has(row.policy_type)) idsByKind.set(row.policy_type, new Set());
    idsByKind.get(row.policy_type)!.add(row.policy_id);
  }

  const selection: {
    fulfillment_policy_id?: string;
    payment_policy_id?: string;
    return_policy_id?: string;
    merchant_location_key?: string;
  } = {};
  if (typeof body.fulfillment_policy_id === "string") {
    if (!idsByKind.get("fulfillment")?.has(body.fulfillment_policy_id)) {
      return c.json({ error: "Unknown fulfillment policy id" }, 400);
    }
    selection.fulfillment_policy_id = body.fulfillment_policy_id;
  }
  if (typeof body.payment_policy_id === "string") {
    if (!idsByKind.get("payment")?.has(body.payment_policy_id)) {
      return c.json({ error: "Unknown payment policy id" }, 400);
    }
    selection.payment_policy_id = body.payment_policy_id;
  }
  if (typeof body.return_policy_id === "string") {
    if (!idsByKind.get("return")?.has(body.return_policy_id)) {
      return c.json({ error: "Unknown return policy id" }, 400);
    }
    selection.return_policy_id = body.return_policy_id;
  }
  if (typeof body.merchant_location_key === "string" && body.merchant_location_key.trim()) {
    selection.merchant_location_key = body.merchant_location_key.trim();
  }

  await setDefaultPolicies(ownerId, selection);

  const next = await listCachedPolicies(ownerId);
  const nextLocation = await loadMerchantLocationKey(ownerId);
  return c.json({
    policies: next,
    defaults: {
      fulfillment_policy_id:
        next.find((p) => p.policy_type === "fulfillment" && p.is_default)?.policy_id ?? null,
      payment_policy_id:
        next.find((p) => p.policy_type === "payment" && p.is_default)?.policy_id ?? null,
      return_policy_id:
        next.find((p) => p.policy_type === "return" && p.is_default)?.policy_id ?? null,
      merchant_location_key: nextLocation,
    },
  });
});

// POST /policies/location → create a default eBay inventory (merchant)
// location from a ZIP/address the seller confirms once. eBay requires an
// ENABLED location on every offer, and there's no Seller Hub UI to make one,
// so this fills the most common publish blocker ("merchant location").
flipdeskEbayRoutes.post("/policies/location", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  let body: {
    postal_code?: unknown;
    country?: unknown;
    address_line1?: unknown;
    city?: unknown;
    state?: unknown;
    name?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const country =
    typeof body.country === "string" && body.country.trim()
      ? body.country.trim().toUpperCase()
      : "US";
  const postalCode =
    typeof body.postal_code === "string" ? body.postal_code.trim() : "";
  // eBay needs a postal code to calculate shipping; enforce a valid US ZIP
  // when country is US (the only marketplace FlipDesk supports today).
  if (country === "US" && !/^\d{5}(-\d{4})?$/.test(postalCode)) {
    return c.json({ error: "A valid US ZIP code is required." }, 400);
  }

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

  try {
    const result = await createInventoryLocation(ownerId, {
      name: str(body.name),
      address: {
        addressLine1: str(body.address_line1),
        city: str(body.city),
        stateOrProvince: str(body.state),
        postalCode: postalCode || undefined,
        country,
      },
    });
    return c.json({ ok: true, merchant_location_key: result.merchantLocationKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] /policies/location failed:", msg);
    return c.json(
      { error: "Could not create your eBay ship-from location.", detail: msg.slice(0, 300) },
      502,
    );
  }
});

// ── Taxonomy ───────────────────────────────────────────────────────
// These run on the app-level (client_credentials) token — no seller OAuth
// required. Cheap to call, but rate-limited by eBay; the aspects endpoint
// is read-through cached in public.ebay_category_aspects.

flipdeskEbayRoutes.get("/category/suggest", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const q = c.req.query("q")?.trim();
  if (!q) {
    return c.json({ error: "q is required" }, 400);
  }
  try {
    const suggestions = await suggestCategories(q);
    return c.json({ suggestions });
  } catch (err) {
    console.error("[flipdesk-ebay] category suggest failed:", err);
    return c.json({ error: "Category suggest failed" }, 502);
  }
});

flipdeskEbayRoutes.get("/category/:id/aspects", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const categoryId = c.req.param("id");
  if (!categoryId) {
    return c.json({ error: "category id is required" }, 400);
  }
  try {
    const result = await getCategoryAspects(categoryId);
    return c.json(result);
  } catch (err) {
    console.error("[flipdesk-ebay] category aspects failed:", err);
    return c.json({ error: "Category aspects fetch failed" }, 502);
  }
});

// US-824: deterministic, NO-AI aspect refill for a category change. Given an
// item + a (possibly new) eBay category, returns the aspects we can fill from
// the item's columns + US-821 canonical attributes — mapped through the shared
// registry (US-822) and normalized to eBay's allowed values (US-823) — plus the
// new category's valid aspect names so the client can classify keep/drop. The
// client calls this when the seller switches category so still-valid values are
// kept and gaps are refilled WITHOUT an AI pass (mirrors the web composer's
// remapAspectsForCategory). `knownAspects` are passed through as `existing` and
// are NEVER overwritten (user-set / still-valid values win).
//
// Tenant-scoped (US-268): the item is loaded by id AND user_id — an item id in
// the body alone never grants access to another tenant's row.
flipdeskEbayRoutes.post("/category/:id/derive-aspects", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const categoryId = c.req.param("id");
  if (!categoryId) return c.json({ error: "category id is required" }, 400);

  let body: { itemId?: string; knownAspects?: Record<string, string[]> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = (body.itemId ?? "").trim();
  if (!itemId) return c.json({ error: "itemId is required" }, 400);
  const known = body.knownAspects ?? {};

  const { data: item, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, size, description, condition_notes, item_category, color, material, style, attributes",
    )
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (itemErr) return c.json({ error: "Could not load item." }, 500);
  if (!item) return c.json({ error: "Item not found." }, 404);

  try {
    const aspectsResp = await getCategoryAspects(categoryId);
    const raw = (aspectsResp.aspects as Record<string, unknown>).aspects;
    const list = Array.isArray(raw) ? (raw as AspectSpecRaw[]) : [];
    const validAspectNames = list
      .map((a) => (a.localizedAspectName ?? "").trim())
      .filter((n) => n.length > 0);
    const derived = deriveAspectsFromItem(
      item as unknown as PublishItem,
      list,
      known,
    );
    // US-825: tell the client these gap-fills are inventory_derived so its
    // provenance badges and the source map it persists stay accurate.
    const sources = sourcesFor(Object.keys(derived), "inventory_derived");
    return c.json({ categoryId, derived, sources, validAspectNames });
  } catch (err) {
    console.error("[flipdesk-ebay] derive-aspects failed:", err);
    return c.json({ error: "Aspect derivation failed" }, 502);
  }
});

// US-470: 501-stub classification. The eBay module is fully wired (OAuth, sync,
// publish, policies, comps, reconciliation) — the old "Still-stubbed (Week 2-3)"
// header here was stale; the helpers below ARE implemented. The only remaining
// 501s in the FlipDesk surface are DELIBERATE, not missing features:
//   • flipdesk-grading.ts POST /webhook → 501: same-process DB sync is used
//     instead (grading-pipeline.ts); the webhook receiver is reserved for the
//     Phase-2 split when FlipDesk consumes the GradeThread Public API.
//   • flipdesk-images.ts POST /process → 501: thumbnails + EXIF strip happen
//     client-side (PhotoUploader); /remove-bg is replaced by on-device @imgly
//     segmentation (US-535). Both carry explanatory error bodies.
// No accidental 501 hides unfinished reseller functionality.

// ── eBay sync helpers ──────────────────────────────────────────────

// Pulls every offer for the connected seller from the Sell Inventory API.
// Each offer's SKU is matched to inventory_items.sku for THIS user:
//   • match → upsert into `listings` (and forward inventory_items.status to 'listed' when active)
//   • no match → snapshot into `flipdesk_ebay_listings` so the user can see
//     orphaned eBay listings on the Reconciliation page.
// ── Background sync helper ─────────────────────────────────────────
// One row per sync run, written to flipdesk_sync_runs (migration 00073) so the
// Reconciliation page can show a history of what each pull did. Best-effort:
// a logging failure here must never break the sync that already ran.
interface SyncRunStats {
  startedAt: string;
  since: string | null;
  status: "success" | "partial" | "failed";
  total: number;
  matched: number;
  unmatched: number;
  skipped: number;
  legacyMatched: number;
  legacyUnmatched: number;
  legacyDuplicates: number;
  salesNew: number;
  salesUpdated: number;
  salesSkipped: number;
  salesEnriched: number;
  // US-459: cancelled/refunded sale line items handled this run.
  salesReversed: number;
  errors: string[];
}

// Finalize a run. When `runId` is present (the normal path) this UPDATES the
// `running` row claimed by claimSyncRun; otherwise it falls back to an INSERT.
async function recordSyncRun(
  userId: string,
  s: SyncRunStats,
  runId: string | null = null,
): Promise<void> {
  const fields = {
    status: s.status,
    listings_total: s.total,
    listings_matched: s.matched,
    listings_unmatched: s.unmatched,
    listings_skipped: s.skipped,
    legacy_matched: s.legacyMatched,
    legacy_unmatched: s.legacyUnmatched,
    legacy_duplicates: s.legacyDuplicates,
    sales_new: s.salesNew,
    sales_updated: s.salesUpdated,
    sales_skipped: s.salesSkipped,
    sales_enriched: s.salesEnriched,
    sales_reversed: s.salesReversed,
    error_count: s.errors.length,
    errors: s.errors.slice(0, 50),
    since: s.since,
    started_at: s.startedAt,
    finished_at: new Date().toISOString(),
  };
  try {
    if (runId) {
      await supabaseAdmin
        .from("flipdesk_sync_runs")
        .update(fields)
        .eq("id", runId);
    } else {
      await supabaseAdmin
        .from("flipdesk_sync_runs")
        .insert({ user_id: userId, marketplace: "ebay", ...fields });
    }
  } catch (err) {
    console.error("[flipdesk-ebay] failed to record sync run:", err);
  }
}

// Snapshot a sale we pulled from eBay but couldn't match to a FlipDesk
// inventory_item (no SKU match, no eBay item-id match). Without this the sale
// was silently dropped, understating Sold totals and making a "full sales"
// backfill lossy. Upsert is idempotent under retries via the unique
// (user_id, platform_order_id, line_item_id) key.
async function snapshotOrphanSale(
  userId: string,
  order: RemoteOrder,
  li: RemoteOrderLineItem,
): Promise<void> {
  try {
    await supabaseAdmin.from("flipdesk_ebay_orphan_sales").upsert(
      {
        user_id: userId,
        platform_order_id: order.orderId,
        line_item_id: li.lineItemId ?? "",
        ebay_item_id: li.legacyItemId,
        sku: li.sku,
        title: li.title,
        quantity: normalizeUnitCount(li.quantity),
        // li.itemCost is the EXTENDED line total (unit price × quantity); store
        // it as-is — it is already the line revenue, not a per-unit figure.
        sale_price: li.itemCost ? Number(li.itemCost.value) : null,
        shipping_collected: li.shippingCost
          ? Number(li.shippingCost.value)
          : null,
        tax: li.taxes ? Number(li.taxes.value) : null,
        buyer_username: order.buyerUsername,
        sold_at: order.creationDate,
        currency: li.itemCost?.currency ?? "USD",
        raw: { orderPaymentStatus: order.orderPaymentStatus },
        match_status: "unmatched",
        imported_at: new Date().toISOString(),
      },
      { onConflict: "user_id,platform_order_id,line_item_id" },
    );
  } catch (err) {
    console.error("[flipdesk-ebay] failed to snapshot orphan sale:", err);
  }
}

// Extracted from the /listings/pull handler so we can fire it as a
// detached promise and return 202 immediately.  The sync typically takes
// 60-120s (N eBay API calls + Supabase writes) which exceeds Cloudflare's
// 100s proxy timeout.  Returning 202 prevents the 524 → CORS-error cycle
// the browser would otherwise see.
async function doListingsPull(
  userId: string,
  connId: string,
  lastSyncedAt: string | null,
  backfill = false,
  // US-456: the 'running' lock row is claimed by the /listings/pull handler
  // (claimSyncRun) BEFORE this fires, so overlapping pulls are rejected. Both
  // finalizers below update it via runId; the handler's .catch fails it on an
  // unexpected throw. null only on the best-effort path where the claim errored.
  runId: string | null = null,
): Promise<void> {
  const startedAt = new Date().toISOString();
  // US-466: collects truncation warnings from the paginated eBay fetches (and,
  // below, per-item errors). Declared up here so the offers/inventory fetch can
  // record a ceiling hit; a non-empty list flips the run to "partial".
  const errors: string[] = [];
  let offers: RemoteOffer[];
  try {
    offers = await listAllOffers(userId, errors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] listings/pull fetch failed:", msg);
    // Can't surface this to the client (we already returned 202), but
    // log it clearly so it shows up in Coolify's container logs — and record
    // a failed run so the user sees the attempt in the sync history.
    await recordSyncRun(userId, {
      startedAt,
      since: lastSyncedAt,
      status: "failed",
      total: 0,
      matched: 0,
      unmatched: 0,
      skipped: 0,
      legacyMatched: 0,
      legacyUnmatched: 0,
      legacyDuplicates: 0,
      salesNew: 0,
      salesUpdated: 0,
      salesSkipped: 0,
      salesEnriched: 0,
      salesReversed: 0,
      errors: [`fetch offers: ${msg.slice(0, 200)}`],
    }, runId);
    return;
  }

  // Pre-load this user's SKU → inventory_item mapping so we can do the
  // join in memory rather than N+1 queries against Supabase. Catalog fields
  // come along so the sync can make eBay the source of truth (title overwrite,
  // brand/size/color/style/material fill-if-blank) without a per-item read.
  type ItemRow = { id: string; sku: string } & LocalCatalog;
  const { data: itemsBySku } = await supabaseAdmin
    .from("inventory_items")
    .select("id, sku, title, brand, size, color, style, material")
    .eq("user_id", userId)
    .not("sku", "is", null);
  const skuToItemId = new Map<string, string>();
  const itemBySku = new Map<string, ItemRow>();
  for (const r of (itemsBySku ?? []) as ItemRow[]) {
    if (r.sku) {
      skuToItemId.set(r.sku, r.id);
      itemBySku.set(r.sku, r);
    }
  }

  // ── US-405: batched-write accumulators ──────────────────────────────
  // The offers + legacy passes below used to do a per-row SELECT, then an
  // INSERT/UPDATE, then a status flip — thousands of sequential PostgREST
  // round-trips on a large seller. Instead we pre-load existing listings into a
  // map (like the SKU map), accumulate every write in memory, and flush them as
  // a handful of bulk calls before the orders pass. This takes a 1,000-offer
  // sync from minutes to seconds.
  type ExistingListingRow = {
    id: string;
    inventory_item_id: string;
    platform_listing_id: string | null;
    platform_offer_id: string | null;
    listing_url: string | null;
    listing_price: number | null;
    listing_status: string | null;
    listing_title: string | null;
    is_active: boolean | null;
    quantity: number | null;
    listed_at: string | null;
    listing_description: string | null;
    platform_category_id: string | null;
    source_of_truth: Record<string, string> | null;
    // US-1081: provenance signals + drift marker. batch_id/synced_to_ebay_at
    // decide whether this listing is GradeThread-originated (GT is the source of
    // truth → inbound pull must NOT overwrite eBay-owned editable fields; it only
    // records that eBay drifted in platform_fields.sync_drift).
    batch_id: string | null;
    synced_to_ebay_at: string | null;
    platform_fields: Record<string, unknown> | null;
  };
  // Every column the offers/legacy passes may write to `listings`. Building a
  // FULL row for every insert AND edit (seeded from the pre-loaded snapshot,
  // then patched) keeps the upsert array uniform — and supplies all the
  // NOT NULL columns — so a single .upsert() on the primary key handles new
  // rows and updates in one round-trip.
  type ListingWrite = {
    id: string;
    inventory_item_id: string;
    platform: "ebay";
    platform_listing_id: string | null;
    platform_offer_id: string | null;
    listing_url: string | null;
    listing_price: number;
    listing_status: string | null;
    is_active: boolean;
    quantity: number | null;
    listed_at: string;
    listing_description: string | null;
    platform_category_id: string | null;
    listing_title: string | null;
  };
  type OrphanWrite = {
    user_id: string;
    ebay_item_id: string;
    custom_label: string | null;
    title: string | null;
    current_price: number | null;
    available_quantity: number | null;
    listing_url: string | null;
    listing_format: string | null;
    start_date: string | null;
    raw: Record<string, unknown>;
    imported_at: string;
  };

  // Inventory statuses a "now listed on eBay" flip is allowed to advance FROM
  // (forward-only — never regress a sold/shipped item).
  const PREP_STATUSES = [
    "sourced",
    "acquired",
    "cataloged",
    "measured",
    "photographed",
    "comped",
    "drafted",
  ];

  // Pre-load this user's existing eBay listings (most-recent per item) so the
  // loops below join in memory instead of a per-row SELECT. Tenant-scoped via
  // the inner join on inventory_items.user_id (listings has no user_id — US-268).
  const existingListingByItem = new Map<string, ExistingListingRow>();
  {
    const { data: rows } = await supabaseAdmin
      .from("listings")
      .select(
        "id, inventory_item_id, platform_listing_id, platform_offer_id, listing_url, listing_price, listing_status, listing_title, is_active, quantity, listed_at, listing_description, platform_category_id, source_of_truth, batch_id, synced_to_ebay_at, platform_fields, created_at, inventory_items!inner(user_id)",
      )
      .eq("platform", "ebay")
      .eq("inventory_items.user_id", userId)
      .order("created_at", { ascending: false });
    for (const r of (rows ?? []) as unknown as ExistingListingRow[]) {
      // created_at desc → the first row seen for an item is the most recent.
      if (r.inventory_item_id && !existingListingByItem.has(r.inventory_item_id)) {
        existingListingByItem.set(r.inventory_item_id, r);
      }
    }
  }

  // Accumulators flushed in one bulk call each after both listing passes.
  const pendingListing = new Map<string, ListingWrite>();
  const orphanByEbayId = new Map<string, OrphanWrite>();
  // Items eBay reports as ACTIVE → flip to 'listed'. The notify set (modern
  // offers) emits the "listing is live" notification on the real transition;
  // the silent set (legacy listings) flips without notifying, matching the
  // prior behavior where only the modern pass notified.
  const listedNotifyItemIds = new Set<string>();
  const listedSilentItemIds = new Set<string>();

  // Seed (or fetch) the pending write row for an item — from the pre-loaded
  // snapshot when one exists, otherwise a fresh row with a client-generated id
  // so a later pass (and the flush) addresses the same row instead of inserting
  // a duplicate.
  function ensurePendingListing(itemId: string): ListingWrite {
    const cached = pendingListing.get(itemId);
    if (cached) return cached;
    const ex = existingListingByItem.get(itemId);
    const w: ListingWrite = ex
      ? {
          id: ex.id,
          inventory_item_id: itemId,
          platform: "ebay",
          platform_listing_id: ex.platform_listing_id ?? null,
          platform_offer_id: ex.platform_offer_id ?? null,
          listing_url: ex.listing_url ?? null,
          listing_price: ex.listing_price ?? 0,
          listing_status: ex.listing_status ?? null,
          is_active: ex.is_active ?? false,
          quantity: ex.quantity ?? null,
          listed_at: ex.listed_at ?? new Date().toISOString(),
          listing_description: ex.listing_description ?? null,
          platform_category_id: ex.platform_category_id ?? null,
          listing_title: ex.listing_title ?? null,
        }
      : {
          id: crypto.randomUUID(),
          inventory_item_id: itemId,
          platform: "ebay",
          platform_listing_id: null,
          platform_offer_id: null,
          listing_url: null,
          listing_price: 0,
          listing_status: null,
          is_active: false,
          quantity: null,
          listed_at: new Date().toISOString(),
          listing_description: null,
          platform_category_id: null,
          listing_title: null,
        };
    pendingListing.set(itemId, w);
    return w;
  }

  // Copy the defined keys of a (pin-filtered) patch onto a pending write row.
  // `undefined` means "leave the existing value" — exactly the semantics the
  // per-row update/insert relied on.
  function applyListingPatch(
    w: ListingWrite,
    patch: Record<string, unknown>,
  ): void {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (w as Record<string, unknown>)[k] = v;
    }
  }

  // Catalog-backfill bookkeeping. GetItem (legacy specifics) is gated to items
  // still missing a field and capped per run, so first-sync cost tapers to ~0.
  const MAX_SPECIFICS_FETCH_PER_SYNC = 300;
  let catalogUpdated = 0;
  let specificsFetched = 0;
  let specificsCapped = false;

  // Apply an eBay-sourced catalog patch to a matched inventory_item, keeping
  // our in-memory ItemRow in sync so the orders pass below sees fresh values.
  // Kept as a per-row UPDATE (not folded into the bulk upsert): inventory_items
  // has NOT NULL columns we don't carry here (status, etc.), and the INSERT arm
  // of an upsert would either violate them or clobber a live status. Patches are
  // gated (fill-if-blank / title-change) so steady-state syncs issue ~0 of these.
  async function applyCatalogPatch(
    itemId: string,
    row: ItemRow,
    patch: CatalogPatch,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    // Tenant-safe: itemId came from this user's itemBySku map (US-268).
    const { error } = await supabaseAdmin
      .from("inventory_items")
      .update(patch)
      .eq("id", itemId);
    if (error) {
      errors.push(`catalog ${itemId}: ${error.message.slice(0, 120)}`);
      return;
    }
    Object.assign(row, patch);
    catalogUpdated += 1;
  }

  let matched = 0;
  let unmatched = 0;
  let skipped = 0;
  // Tracks every eBay listingId we've already upserted in this pass — used
  // by the legacy Trading API pass below to skip listings already covered
  // by the modern Sell Inventory loop.
  const processedListingIds = new Set<string>();
  // Items whose eBay listing came back ended/inactive this sync. After the
  // orders pass marks genuine sales as 'sold', anything left here that's still
  // 'listed' ended WITHOUT a sale → auto-move it back to Drafts so the seller
  // can edit + relist it (Path A).
  const endedItemIds = new Set<string>();
  // US-148: what eBay said about each matched listing, captured BEFORE the
  // eBay-wins overwrite below, so cross-source conflicts keep FlipDesk's
  // original value. Recorded in one batch after the orders pass (status
  // observations for listings that ended via a genuine sale are dropped —
  // "sold vs ended" isn't a disagreement worth flagging).
  const ebayObservations: (SourceObservation & { itemId?: string })[] = [];
  // Statuses where an eBay-vs-FlipDesk status diff is meaningful; sold /
  // relisted are FlipDesk-richer states eBay can't express.
  const COMPARABLE_STATUSES = new Set(["active", "ended", "draft"]);
  // True when the user already picked a non-eBay winner for this field — the
  // pull must not overwrite it (US-148 source-of-truth persistence).
  const pinnedAgainstEbay = (
    row: ExistingListingRow | null,
    field: string,
  ): boolean => {
    const winner = row?.source_of_truth?.[field];
    return !!winner && winner !== "ebay";
  };

  // US-1081: per-listing platform_fields writes for drift bookkeeping on
  // GradeThread-originated listings (keyed by listing id). Flushed after the
  // loop. Separate from the bulk listing upsert — that upsert never carries
  // platform_fields, so these writes aren't clobbered.
  const driftFieldWrites = new Map<string, Record<string, unknown>>();

  for (const o of offers) {
    try {
      // Drafts (unpublished offers) have no listingId yet — skip in this pass.
      if (!o.listingId) {
        skipped += 1;
        continue;
      }
      const sku = o.sku;
      const itemId = sku ? skuToItemId.get(sku) ?? null : null;
      const priceNum = o.price ? Number(o.price.value) : null;
      const isActive = (o.listingStatus ?? "").toUpperCase() === "ACTIVE";

      if (itemId) {
        // US-405: the existing listing comes from the pre-loaded map, not a
        // per-row SELECT.
        const existing = existingListingByItem.get(itemId) ?? null;

        // US-148: capture eBay-vs-FlipDesk disagreements before the overwrite.
        if (existing) {
          const ebayStatus = isActive ? "active" : "ended";
          if (priceNum != null) {
            ebayObservations.push({
              listingId: existing.id,
              field: "price",
              flipdeskValue: existing.listing_price,
              observedValue: priceNum,
            });
          }
          // Quantity only once FlipDesk has an opinion (column seeded below).
          if (existing.quantity != null && o.availableQuantity != null) {
            ebayObservations.push({
              listingId: existing.id,
              field: "quantity",
              flipdeskValue: existing.quantity,
              observedValue: o.availableQuantity,
            });
          }
          if (
            existing.listing_status &&
            COMPARABLE_STATUSES.has(existing.listing_status)
          ) {
            ebayObservations.push({
              listingId: existing.id,
              field: "listing_status",
              flipdeskValue: existing.listing_status,
              observedValue: ebayStatus,
              itemId,
            });
          }
          if (o.title && o.title.trim()) {
            ebayObservations.push({
              listingId: existing.id,
              field: "title",
              flipdeskValue: existing.listing_title,
              observedValue: o.title,
            });
          }
        }

        const patch: Record<string, unknown> = {
          platform_listing_id: o.listingId,
          platform_offer_id: o.offerId,
          listing_url: ebayListingUrl(o.listingId),
          listing_price: priceNum ?? undefined,
          listing_status: isActive ? "active" : "ended",
          is_active: isActive,
          quantity: o.availableQuantity ?? undefined,
        };
        // US-148: fields the user pinned to FlipDesk/Sheets keep their value.
        if (pinnedAgainstEbay(existing, "price")) delete patch.listing_price;
        if (pinnedAgainstEbay(existing, "quantity")) delete patch.quantity;
        if (pinnedAgainstEbay(existing, "listing_status")) {
          delete patch.listing_status;
          delete patch.is_active;
        }
        // eBay's own listing start date is authoritative — write it through so
        // the "List Date" column is populated even on sync-discovered listings
        // (we never set listed_at on insert below otherwise). Only overwrite
        // when eBay actually returned a date.
        if (o.listingStartDate) {
          patch.listed_at = o.listingStartDate;
        }
        // Pull description back from eBay so manual Seller Hub edits don't
        // leave FlipDesk's copy stale. Skip empty strings — those usually
        // mean "API didn't return a body", not "user blanked it".
        if (o.listingDescription && o.listingDescription.trim()) {
          patch.listing_description = o.listingDescription;
        }
        if (o.categoryId) {
          patch.platform_category_id = o.categoryId;
        }

        // US-1081: provenance-aware inbound merge. For GradeThread-originated
        // listings GradeThread is the source of truth — the inbound pull must
        // NOT overwrite eBay-owned editable fields (price/description/quantity/
        // category). It still mirrors the read-only signals (status/is_active)
        // already in `patch`, and records that eBay has drifted so the editor
        // can offer a non-blocking "Re-push to eBay" re-assert. Origin is
        // derived from the same signals US-1077 backfills from.
        const origin = existing
          ? deriveListingOrigin({
              platform: "ebay",
              platform_listing_id: existing.platform_listing_id,
              batch_id: existing.batch_id,
              synced_to_ebay_at: existing.synced_to_ebay_at,
            })
          : "ebay";
        if (existing && origin === "gradethread") {
          const drifted: string[] = [];
          const ebaySnapshot: Record<string, unknown> = {};
          if (
            o.title &&
            o.title.trim() &&
            existing.listing_title != null &&
            o.title.trim() !== existing.listing_title.trim()
          ) {
            drifted.push("title");
            ebaySnapshot.title = o.title.trim();
          }
          if (
            priceNum != null &&
            existing.listing_price != null &&
            Math.abs(priceNum - existing.listing_price) > 0.005
          ) {
            drifted.push("price");
            ebaySnapshot.price = priceNum;
          }
          if (
            o.listingDescription &&
            o.listingDescription.trim() &&
            existing.listing_description != null &&
            o.listingDescription.trim() !== existing.listing_description.trim()
          ) {
            drifted.push("description");
            ebaySnapshot.description = o.listingDescription.trim();
          }
          // Keep GradeThread's values — never let eBay win on a GT listing.
          delete patch.listing_price;
          delete patch.listing_description;
          delete patch.quantity;
          delete patch.platform_category_id;

          // Record (or clear) the drift marker; informational only — we never
          // pull eBay's drifted value into GradeThread. Skip the write unless the
          // marker actually changes so a steady-state sync stays free.
          const prevPf = (existing.platform_fields ?? {}) as Record<
            string,
            unknown
          >;
          const hadDrift = !!(prevPf as { sync_drift?: unknown }).sync_drift;
          if (drifted.length > 0) {
            driftFieldWrites.set(existing.id, {
              ...prevPf,
              sync_drift: {
                fields: drifted,
                ebay: ebaySnapshot,
                detected_at: new Date().toISOString(),
              },
            });
          } else if (hadDrift) {
            const nextPf = { ...prevPf };
            delete (nextPf as { sync_drift?: unknown }).sync_drift;
            driftFieldWrites.set(existing.id, nextPf);
          }
        }
        // US-405: accumulate the write — flushed as one bulk upsert after both
        // listing passes. ensurePendingListing seeds a full row from the
        // pre-loaded snapshot (or a fresh client-id'd row), then the patch is
        // merged on top.
        applyListingPatch(ensurePendingListing(itemId), patch);
        // Forward-only status — don't regress sold/shipped items. The flip is
        // batched after the loop; the modern pass notifies on the real
        // transition (notify set), the legacy pass flips silently.
        if (isActive) {
          listedNotifyItemIds.add(itemId);
        } else {
          // eBay reports this offer's listing as ended/inactive. Remember it so
          // the post-orders reconciliation can move it back to Drafts if it
          // ended without a sale (Path A — relist of ended listings).
          endedItemIds.add(itemId);
        }
        // eBay as source of truth: title overwrite, specifics fill-if-blank.
        // Modern offers carry title + aspects (from listAllOffers) — free.
        // US-1081: for GradeThread-originated listings GradeThread owns the
        // title, so skip eBay's title overwrite (specifics still fill-if-blank).
        const localRow = sku ? itemBySku.get(sku) : undefined;
        if (localRow) {
          await applyCatalogPatch(
            itemId,
            localRow,
            buildCatalogPatch(localRow, {
              title: origin === "gradethread" ? null : o.title,
              specifics: flattenAspects(o.aspects),
            }),
          );
        }
        matched += 1;
      } else {
        // Snapshot orphan eBay listings — surfaced on the Reconciliation page.
        // US-405: collected into a map and bulk-upserted after the loop. Keyed
        // by ebay_item_id so a duplicate id within the run can't make the bulk
        // upsert "affect a row a second time".
        orphanByEbayId.set(o.listingId, {
          user_id: userId,
          ebay_item_id: o.listingId,
          custom_label: sku ?? null,
          title: null,
          current_price: priceNum,
          available_quantity: o.availableQuantity ?? null,
          listing_url: ebayListingUrl(o.listingId),
          listing_format: o.format ?? null,
          start_date: null,
          raw: {
            offerId: o.offerId,
            listingStatus: o.listingStatus,
            categoryId: o.categoryId,
            price: o.price,
          },
          // US-465 AC2: do NOT write match_status here. Omitting it means a
          // brand-new orphan gets the column default ('unmatched') on INSERT,
          // while an existing row's match_status (and matched_item_id, also
          // omitted) is PRESERVED on conflict — so a manually-linked orphan is
          // never resurrected as unmatched by a later re-sync.
          imported_at: new Date().toISOString(),
        });
        unmatched += 1;
      }
      processedListingIds.add(o.listingId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg.slice(0, 200));
    }
  }

  // ── Legacy listings (Trading API) ───────────────────────────────
  // Pulls every active listing from GetMyeBaySelling — covers items
  // created in Seller Hub or via the legacy ListItem call that never
  // became inventory_items on the new REST surface. We dedupe against
  // listingIds already processed above so an item that exists on both
  // surfaces isn't double-counted.
  let legacyMatched = 0;
  let legacyUnmatched = 0;
  let legacyDuplicates = 0;
  try {
    const legacy: LegacyEbayListing[] = await getAllActiveEbaySelling(userId);
    for (const l of legacy) {
      try {
        if (processedListingIds.has(l.ebayItemId)) {
          legacyDuplicates += 1;
          continue;
        }
        const sku = l.sku;
        const itemId = sku ? skuToItemId.get(sku) ?? null : null;

        if (itemId) {
          // Same write path as the modern flow — but no platform_offer_id
          // because legacy listings don't have a Sell Inventory offer.
          // US-405: existing listing from the pre-loaded map (may already hold
          // an in-memory write from the modern pass for this same item).
          const existing = existingListingByItem.get(itemId) ?? null;

          // US-148: GetMyeBaySelling only returns ACTIVE listings.
          if (existing) {
            const legacyQty = l.quantityAvailable ?? l.quantity;
            if (l.currentPrice != null) {
              ebayObservations.push({
                listingId: existing.id,
                field: "price",
                flipdeskValue: existing.listing_price,
                observedValue: l.currentPrice,
              });
            }
            if (existing.quantity != null && legacyQty != null) {
              ebayObservations.push({
                listingId: existing.id,
                field: "quantity",
                flipdeskValue: existing.quantity,
                observedValue: legacyQty,
              });
            }
            if (
              existing.listing_status &&
              COMPARABLE_STATUSES.has(existing.listing_status)
            ) {
              ebayObservations.push({
                listingId: existing.id,
                field: "listing_status",
                flipdeskValue: existing.listing_status,
                observedValue: "active",
                itemId,
              });
            }
            if (l.title && l.title.trim()) {
              ebayObservations.push({
                listingId: existing.id,
                field: "title",
                flipdeskValue: existing.listing_title,
                observedValue: l.title,
              });
            }
          }

          const patch: Record<string, unknown> = {
            platform_listing_id: l.ebayItemId,
            listing_url: l.listingUrl ?? ebayListingUrl(l.ebayItemId),
            listing_price: l.currentPrice ?? undefined,
            listing_status: "active",
            is_active: true,
            quantity: l.quantityAvailable ?? l.quantity ?? undefined,
          };
          // Trading API gives us ListingDetails.StartTime — write it through to
          // listed_at so the "List Date" column reflects eBay's record.
          if (l.startTime) patch.listed_at = l.startTime;
          if (l.title && l.title.trim()) patch.listing_title = l.title;
          // US-148: respect per-field source-of-truth picks.
          if (pinnedAgainstEbay(existing, "price")) delete patch.listing_price;
          if (pinnedAgainstEbay(existing, "quantity")) delete patch.quantity;
          if (pinnedAgainstEbay(existing, "listing_status")) {
            delete patch.listing_status;
            delete patch.is_active;
          }
          if (pinnedAgainstEbay(existing, "title")) delete patch.listing_title;
          if (l.primaryCategoryId) patch.platform_category_id = l.primaryCategoryId;
          // US-405: accumulate the write (merging onto any row the modern pass
          // already seeded for this item) and the silent status flip.
          applyListingPatch(ensurePendingListing(itemId), patch);
          listedSilentItemIds.add(itemId);
          // eBay as source of truth. Legacy (GetMyeBaySelling) gives us the
          // title for free, but NOT item specifics — fetch those via GetItem
          // ONLY when this item still has a blank target field, and only while
          // under the per-sync cap (so the first backfill is bounded and later
          // syncs cost ~0 calls). Title still syncs even when the cap is hit.
          const localRow = sku ? itemBySku.get(sku) : undefined;
          if (localRow) {
            const needsSpecifics = FILL_IF_BLANK_FIELDS.some(
              (f) => !localRow[f] || !localRow[f]!.trim(),
            );
            let specifics: Record<string, string> = {};
            if (needsSpecifics) {
              if (specificsFetched < MAX_SPECIFICS_FETCH_PER_SYNC) {
                specificsFetched += 1;
                specifics = await getItemSpecifics(userId, l.ebayItemId);
              } else {
                specificsCapped = true;
              }
            }
            await applyCatalogPatch(
              itemId,
              localRow,
              buildCatalogPatch(localRow, { title: l.title, specifics }),
            );
          }
          legacyMatched += 1;
        } else {
          // Orphan: most legacy Seller-Hub listings have no Custom Label.
          // Snapshot with the title so the Reconciliation page can show it
          // and let the user link it to a FlipDesk SKU. US-405: bulk-upserted
          // after the loop (keyed by ebay_item_id).
          orphanByEbayId.set(l.ebayItemId, {
            user_id: userId,
            ebay_item_id: l.ebayItemId,
            custom_label: sku ?? null,
            title: l.title ?? null,
            current_price: l.currentPrice ?? null,
            available_quantity: l.quantityAvailable ?? l.quantity ?? null,
            listing_url: l.listingUrl ?? null,
            listing_format: l.listingType ?? null,
            start_date: l.startTime ? l.startTime.slice(0, 10) : null,
            raw: {
              source: "trading_api",
              watchCount: l.watchCount,
              endTime: l.endTime,
            },
            // US-465 AC2: omit match_status so a manual link survives re-sync
            // (default 'unmatched' applies only to brand-new rows; existing
            // match_status + matched_item_id are preserved on conflict).
            imported_at: new Date().toISOString(),
          });
          legacyUnmatched += 1;
        }
        processedListingIds.add(l.ebayItemId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`legacy ${l.ebayItemId}: ${msg.slice(0, 160)}`);
      }
    }
  } catch (err) {
    // Trading API failure shouldn't fail the whole pull. Common cause:
    // legacy seller account that's been migrated to Sell Inventory only.
    console.error("[flipdesk-ebay] Trading API pass failed:", err);
    errors.push(
      `trading api: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── US-405: flush the batched writes from the offers + legacy passes ─────
  // A handful of bulk calls replaces the thousands of per-row round-trips the
  // loops above used to make. This runs BEFORE the ebayItemIdToItemId rebuild
  // and the orders pass below, both of which read `listings` fresh from the DB.
  if (pendingListing.size > 0) {
    // Every row is a full ListingWrite (all NOT NULL columns present), so a
    // single upsert on the primary key inserts new rows and updates existing
    // ones in one round-trip.
    const { error } = await supabaseAdmin
      .from("listings")
      .upsert(Array.from(pendingListing.values()), { onConflict: "id" });
    if (error) errors.push(`listings upsert: ${error.message.slice(0, 160)}`);
  }
  // US-1081: write the drift markers for GradeThread-originated listings. These
  // touch only `platform_fields` (which the bulk upsert above never carries, so
  // they aren't clobbered) and only fire when a marker changed, so a normal
  // in-agreement sync issues none.
  for (const [listingId, platformFields] of driftFieldWrites) {
    const { error } = await supabaseAdmin
      .from("listings")
      .update({ platform_fields: platformFields } as never)
      .eq("id", listingId);
    if (error) {
      errors.push(`drift marker ${listingId}: ${error.message.slice(0, 120)}`);
    }
  }
  if (orphanByEbayId.size > 0) {
    const { error } = await supabaseAdmin
      .from("flipdesk_ebay_listings")
      .upsert(Array.from(orphanByEbayId.values()), {
        onConflict: "user_id,ebay_item_id",
      });
    if (error) errors.push(`orphan upsert: ${error.message.slice(0, 160)}`);
  }
  // Status flips — one .in('id',[...]) update per transition. The prep-status
  // filter keeps the flip forward-only; .select() returns only the rows that
  // actually advanced, so the "listing is live" notification fires once on the
  // real transition. Run the notify flip FIRST so an item that is active on
  // BOTH the modern and legacy surfaces still notifies (the silent flip then
  // finds it already 'listed' and no-ops).
  if (listedNotifyItemIds.size > 0) {
    const { data: flipped } = await supabaseAdmin
      .from("inventory_items")
      .update({ status: "listed" })
      .eq("user_id", userId)
      .in("id", Array.from(listedNotifyItemIds))
      .in("status", PREP_STATUSES)
      .select("id, title");
    for (const r of (flipped ?? []) as Array<{
      id: string;
      title: string | null;
    }>) {
      // US-737: item went live on a marketplace.
      void notifyUser(userId, {
        type: "listing_live",
        title: "Listing is live",
        message: `${r.title ?? "Your item"} is now listed on eBay.`,
        link: `/dashboard/flipdesk/items/${r.id}`,
      });
    }
  }
  if (listedSilentItemIds.size > 0) {
    await supabaseAdmin
      .from("inventory_items")
      .update({ status: "listed" })
      .eq("user_id", userId)
      .in("id", Array.from(listedSilentItemIds))
      .in("status", PREP_STATUSES);
  }

  // eBay item-id → inventory_item map, built AFTER the listing passes above so
  // it includes any listing rows just upserted this run. Used as a fallback
  // for matching order line items that carry no Custom Label (SKU) — common
  // for legacy Seller-Hub listings. Tenant-scoped via the inner join on
  // inventory_items.user_id (listings has no user_id column of its own —
  // US-268).
  const ebayItemIdToItemId = new Map<string, string>();
  try {
    const { data: ebayListingRows } = await supabaseAdmin
      .from("listings")
      .select("platform_listing_id, inventory_item_id, inventory_items!inner(user_id)")
      .eq("platform", "ebay")
      .eq("inventory_items.user_id", userId)
      .not("platform_listing_id", "is", null);
    for (const r of (ebayListingRows ?? []) as Array<{
      platform_listing_id: string | null;
      inventory_item_id: string | null;
    }>) {
      if (r.platform_listing_id && r.inventory_item_id) {
        ebayItemIdToItemId.set(r.platform_listing_id, r.inventory_item_id);
      }
    }
  } catch (err) {
    console.error("[flipdesk-ebay] failed to build ebay item-id map:", err);
  }

  // ── Orders sync (sold-state detection) ──────────────────────────
  // Pulls orders modified since last_synced_at (or 90 days on first sync;
  // ~24 months on an explicit backfill). Each line item is matched to an
  // inventory_item by SKU, then by eBay item id; unmatched sales are
  // snapshotted (not dropped).
  // Each line item's SKU is matched to inventory_items.sku; matches turn
  // into a sales row + flip inventory_items.status='sold'.
  // Normal syncs are incremental (orders modified since last_synced_at, or a
  // 90-day seed on first connect). A backfill ignores last_synced_at and
  // reaches back to eBay's practical retention limit (~24 months) so sales
  // that predate the FlipDesk connection get imported. This window applies to
  // BOTH the orders sync and the Finances fee/payout enrichment below.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  // eBay's getOrders + getTransactions reject any start date that is 2 years or
  // older (errorId 30830: "Start date must be within '2' years from present
  // date"). A 730-day window sits exactly on that boundary and gets rejected,
  // which threw the whole orders sync — so NO sales were imported even though
  // the listings pull returned 202 and the UI toasted success. Use a ~23-month
  // backfill window to stay comfortably under the cap, and clamp whatever
  // `since` we send (a stale last_synced_at could otherwise trip the same
  // limit). This floor applies to BOTH the orders sync and the Finances
  // enrichment below, since they share sinceISO.
  const ebayLookbackFloor = new Date(Date.now() - 700 * 24 * 60 * 60_000);
  const requestedSince = backfill
    ? ebayLookbackFloor.toISOString()
    : (lastSyncedAt ?? ninetyDaysAgo);
  const sinceISO =
    new Date(requestedSince).getTime() < ebayLookbackFloor.getTime()
      ? ebayLookbackFloor.toISOString()
      : requestedSince;

  let salesNew = 0;
  let salesUpdated = 0;
  let salesSkipped = 0;
  let salesReversed = 0; // US-459: cancelled/refunded line items handled.
  try {
    const orders: RemoteOrder[] = await listRecentOrders(userId, sinceISO, errors);
    for (const order of orders) {
      // Failed-payment orders shouldn't flip an item to sold.
      const paid =
        order.orderPaymentStatus === "PAID" ||
        order.orderPaymentStatus === "PARTIALLY_REFUNDED" ||
        order.orderPaymentStatus === "FULLY_REFUNDED";
      if (!paid) {
        salesSkipped += order.lineItems.length;
        continue;
      }

      // Lifecycle for this order's sale rows. A cancelled order (or a fully
      // refunded one) must NOT count toward revenue/profit/sold totals, so we
      // persist it with a non-'completed' status that every metric excludes.
      const saleStatus: "completed" | "cancelled" | "refunded" =
        order.cancelState === "CANCELED"
          ? "cancelled"
          : order.orderPaymentStatus === "FULLY_REFUNDED"
            ? "refunded"
            : "completed";
      const cancelledAt =
        saleStatus === "completed"
          ? null
          : order.lastModifiedDate ?? order.creationDate ?? null;

      for (const li of order.lineItems) {
        try {
          const sku = li.sku;
          let itemId = sku ? skuToItemId.get(sku) ?? null : null;
          // Fallback: match by eBay item id when there's no Custom Label match
          // (legacy listings often have no SKU on the order line item).
          if (!itemId && li.legacyItemId) {
            itemId = ebayItemIdToItemId.get(li.legacyItemId) ?? null;
          }
          if (!itemId) {
            // Don't silently drop it — snapshot the orphan sale so Sold totals
            // stay complete and the user can link it on Reconciliation.
            await snapshotOrphanSale(userId, order, li);
            salesSkipped += 1;
            continue;
          }
          // Look up the most recent listing row for this item so we can
          // link the sale (sales.listing_id is nullable but useful).
          const { data: lst } = await supabaseAdmin
            .from("listings")
            .select("id, listing_url")
            .eq("inventory_item_id", itemId)
            .eq("platform", "ebay")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const lstRow = lst as { id: string; listing_url: string | null } | null;
          let listingId = lstRow?.id ?? null;
          const existingUrl = lstRow?.listing_url ?? null;

          // li.itemCost is eBay's lineItemCost — the EXTENDED line total (unit
          // price × quantity), NOT a per-unit price (verified vs the Fulfillment
          // API docs). So this IS the line revenue; never multiply by quantity.
          const itemCost = li.itemCost ? Number(li.itemCost.value) : 0;
          const quantity = normalizeUnitCount(li.quantity);
          const shippingCollected = li.shippingCost
            ? Number(li.shippingCost.value)
            : 0;
          const tax = li.taxes ? Number(li.taxes.value) : 0;

          // Backfill the listings row's eBay link from the order's listingId.
          // The active-listing passes above (listAllOffers / GetMyeBaySelling)
          // only return ACTIVE listings, so a listing that already sold/ended
          // never gets a listings row carrying a URL — which is why sold items
          // showed a blank "Link" in the export even though the order tells us
          // the eBay item id. Fill it here. We only WRITE the URL when it's
          // currently blank so we don't clobber the nicer slug URL the Trading
          // API gives active listings; platform_listing_id is always set.
          if (li.legacyItemId) {
            const hasUrl = !!existingUrl && existingUrl.trim() !== "";
            const urlPatch = hasUrl
              ? {}
              : { listing_url: ebayListingUrl(li.legacyItemId) };
            // A completed sale means the listing is no longer live.
            const lifecyclePatch =
              saleStatus === "completed"
                ? { listing_status: "sold", is_active: false }
                : {};
            if (listingId) {
              await supabaseAdmin
                .from("listings")
                .update({
                  platform_listing_id: li.legacyItemId,
                  ...urlPatch,
                  ...lifecyclePatch,
                })
                .eq("id", listingId);
              // US-547: a completed sale is the sell-through signal for the
              // listing_gen prompt that produced this draft.
              if (saleStatus === "completed") {
                await markListingPromptSold(listingId);
              }
            } else {
              // No listings row at all (sold before we ever synced the live
              // listing) — create one so the item carries its eBay link.
              const { data: created } = await supabaseAdmin
                .from("listings")
                .insert({
                  inventory_item_id: itemId,
                  platform: "ebay",
                  platform_listing_id: li.legacyItemId,
                  listing_url: ebayListingUrl(li.legacyItemId),
                  listing_price: itemCost,
                  listing_status:
                    saleStatus === "completed" ? "sold" : "ended",
                  is_active: false,
                })
                .select("id")
                .maybeSingle();
              listingId = (created as { id: string } | null)?.id ?? null;
            }
          }

          // US-149: a completed sale ends this listing's cross-listed
          // siblings (rows sharing draft_id), honoring the per-user
          // flipdesk_settings.auto_end_cross_listings toggle. Best-effort —
          // never fails the sync.
          if (saleStatus === "completed" && listingId) {
            await autoEndCrossListings(userId, listingId);
          }

          // US-468: dedupe key is (inventory_item_id, platform_order_id,
          // line_item_id) — migration 00130 adds line_item_id to the unique
          // index so two line items of the SAME item in one order don't collapse
          // onto one row. Fetch every existing row for this item+order and let
          // pickSaleRowForLine choose the right one (adopting a legacy null-id
          // row once on the first post-migration re-sync).
          const { data: existingRows } = await supabaseAdmin
            .from("sales")
            .select("id, line_item_id")
            .eq("inventory_item_id", itemId)
            .eq("platform_order_id", order.orderId);
          const existing = pickSaleRowForLine(
            (existingRows ?? []) as ExistingSaleRow[],
            li.lineItemId,
          );

          const salePayload = {
            inventory_item_id: itemId,
            listing_id: listingId,
            platform_order_id: order.orderId,
            line_item_id: li.lineItemId ?? "",
            quantity,
            sale_price: itemCost,
            sale_date: order.creationDate?.slice(0, 10) ?? null,
            sold_at: order.creationDate ?? null,
            buyer_username: order.buyerUsername,
            buyer_id: order.buyerUsername,
            shipping_collected: shippingCollected,
            tax,
            status: saleStatus,
            cancelled_at: cancelledAt,
          };

          if (existing) {
            await supabaseAdmin
              .from("sales")
              .update(salePayload)
              .eq("id", (existing as { id: string }).id);
            salesUpdated += 1;
          } else {
            await supabaseAdmin.from("sales").insert(salePayload);
            salesNew += 1;
            // US-626: a brand-new sale → celebrate it on iOS (best-effort).
            // Only for genuine completed sales, never a cancelled/refunded one.
            if (saleStatus === "completed") {
              void pushSaleCreated(userId);
              // US-737: in-app "sold" notification. This branch only runs for a
              // genuinely NEW completed sale (the `existing` dedup guard above),
              // so it fires once per sale, not on every re-sync.
              void notifyUser(userId, {
                type: "sale_recorded",
                title: "Item sold",
                message: `${li.title ?? "An item"} sold for $${itemCost.toFixed(2)}.`,
                link: `/dashboard/flipdesk/items/${itemId}`,
              });
            }
          }

          if (saleStatus === "completed") {
            // Flip the item to sold. resolveStatus-equivalent: 'sold' is a
            // terminal non-prep status so it dominates anything we'd have
            // bumped to via the offer loop above ('listed').
            await supabaseAdmin
              .from("inventory_items")
              .update({ status: "sold" })
              .eq("id", itemId)
              .not("status", "in", "(shipped,completed,returned)");
          } else {
            // Order cancelled/refunded: the item is presumably still the
            // seller's. If a prior sync already flipped it to 'sold', put it
            // back to 'listed' so it re-enters active inventory and stops
            // counting as a completed sale. Don't touch shipped/completed/
            // returned (those represent real fulfillment we shouldn't undo).
            await supabaseAdmin
              .from("inventory_items")
              .update({ status: "listed" })
              .eq("id", itemId)
              .eq("status", "sold");
            // US-459: report how many cancellations/returns this run handled.
            salesReversed += 1;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`order ${order.orderId}: ${msg.slice(0, 160)}`);
        }
      }
    }
  } catch (err) {
    // Orders sync failure shouldn't fail the whole pull — listings sync
    // is the more critical of the two. Log + carry on.
    console.error("[flipdesk-ebay] orders sync failed:", err);
    errors.push(
      `orders sync: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── Finances enrichment (fees + payout) ─────────────────────────
  // For each SALE transaction we find via the Finances API, find the
  // matching sales row by platform_order_id and write through:
  //   platform_fees, payout_amount, payout_reference, net_profit
  // This is what flips the Sold tab badge from "Pending" to "Cleared".
  let salesEnriched = 0;
  try {
    const txns: RemoteTransaction[] = await listRecentTransactions(
      userId,
      sinceISO,
      errors,
    );
    // Build a quick orderId → aggregate map. SALE transactions carry gross
    // + fees; SHIPPING_LABEL transactions carry what the SELLER paid for
    // the eBay shipping label (deducted from the payout). Refunds reduce
    // gross. We sum each per-order so multi-line orders compose cleanly.
    interface OrderAgg {
      gross: number;
      fees: number;
      shippingLabelCost: number;
      payoutId: string | null;
      currency: string;
    }
    const byOrder = new Map<string, OrderAgg>();
    const upsertAgg = (orderId: string): OrderAgg => {
      const existing = byOrder.get(orderId);
      if (existing) return existing;
      const fresh: OrderAgg = {
        gross: 0,
        fees: 0,
        shippingLabelCost: 0,
        payoutId: null,
        currency: "USD",
      };
      byOrder.set(orderId, fresh);
      return fresh;
    };
    for (const t of txns) {
      if (!t.orderId) continue;
      const agg = upsertAgg(t.orderId);
      const amt = t.amount ? Number(t.amount.value) : 0;
      if (t.amount?.currency) agg.currency = t.amount.currency;
      if (t.payoutId && !agg.payoutId) agg.payoutId = t.payoutId;

      switch (t.transactionType) {
        case "SALE":
          agg.gross += amt;
          if (t.totalFeeAmount) {
            agg.fees += Number(t.totalFeeAmount.value);
          }
          break;
        case "SHIPPING_LABEL":
          // Seller-paid label. amount is positive but it's a DEBIT (deducted
          // from the payout). Sum the absolute value either way.
          agg.shippingLabelCost += Math.abs(amt);
          break;
        case "REFUND":
          // Refund issued to buyer — comes out of the seller's payout.
          // Treat as a negative adjustment to gross.
          agg.gross -= Math.abs(amt);
          break;
        // Other types (DISPUTE, CREDIT, NON_SALE_CHARGE) intentionally
        // ignored for now — they're rare and would need per-case handling.
      }
    }

    // Pull every sale this user has with a matching platform_order_id so we
    // can update + compute net_profit (needs cost_basis from inventory_items).
    const orderIds = Array.from(byOrder.keys());
    if (orderIds.length > 0) {
      const { data: salesRows } = await supabaseAdmin
        .from("sales")
        .select(
          "id, inventory_item_id, sale_price, shipping_collected, shipping_cost, grading_cost, other_costs, status, platform_order_id, inventory_items!inner(user_id, acquired_price)"
        )
        .in("platform_order_id", orderIds);

      for (const row of (salesRows ?? []) as unknown as Array<{
        id: string;
        inventory_item_id: string;
        sale_price: number | null;
        shipping_collected: number | null;
        shipping_cost: number | null;
        grading_cost: number | null;
        other_costs: number | null;
        status: string | null;
        platform_order_id: string | null;
        inventory_items: { user_id: string; acquired_price: number | null };
      }>) {
        if (row.inventory_items.user_id !== userId) continue;
        const agg = row.platform_order_id
          ? byOrder.get(row.platform_order_id)
          : null;
        if (!agg) continue;

        const fees = agg.fees;
        // Use eBay's label cost when present, otherwise keep whatever the
        // user manually entered (a USPS direct label, etc.).
        const shippingCost = agg.shippingLabelCost > 0
          ? agg.shippingLabelCost
          : row.shipping_cost ?? 0;
        // Payout = what actually hit the seller's bank: gross - fees - labels.
        // This is the cleared-funds amount, not net profit.
        const payoutAmount = Math.max(
          0,
          agg.gross - fees - agg.shippingLabelCost,
        );

        const salePrice = row.sale_price ?? 0;
        const shippingCollected = row.shipping_collected ?? 0;
        const gradingCost = row.grading_cost ?? 0;
        const otherCosts = row.other_costs ?? 0;
        const costBasis = row.inventory_items.acquired_price ?? 0;
        // US-459: net_profit must REVERSE revenue on a cancelled/refunded sale,
        // not just fee-adjust it. For those, the buyer got their money back and
        // (for a return) the item came back into inventory — so the only thing
        // left on the books is the cash the seller actually ate: the
        // refund-netted gross minus fees minus the shipping label they paid
        // (`agg.gross` already subtracts REFUND transactions). Cost basis is NOT
        // subtracted (the item is retained), and the original sale revenue is
        // NOT counted (it was refunded). This goes negative when the seller ate
        // a label/fee, which is correct.
        const reversed = row.status === "cancelled" || row.status === "refunded";
        const netProfit = reversed
          ? agg.gross - fees - agg.shippingLabelCost
          : // Completed sale: revenue - fees - your costs. Revenue is
            // sale_price + shipping_collected (tax flows to government, not the
            // seller); your costs are cost basis, shipping, grading, other.
            salePrice +
            shippingCollected -
            fees -
            shippingCost -
            gradingCost -
            otherCosts -
            costBasis;

        await supabaseAdmin
          .from("sales")
          .update({
            platform_fees: fees,
            shipping_cost: shippingCost,
            payout_amount: payoutAmount,
            payout_reference: agg.payoutId,
            net_profit: Math.round(netProfit * 100) / 100,
          })
          .eq("id", row.id);
        salesEnriched += 1;
      }
    }
  } catch (err) {
    console.error("[flipdesk-ebay] finances enrichment failed:", err);
    errors.push(
      `finances: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── Ended-without-sale → Drafts (Path A) ────────────────────────────
  // eBay reported these listings as ended/inactive this sync. The orders pass
  // above already flipped genuine sales to 'sold', so anything still in 'listed'
  // here ended without selling (expired, ended on Seller Hub, out of stock with
  // no order, etc.). Move those back to 'drafted' so they surface in the Drafts
  // tab where the seller can edit and relist them, and notify once per item.
  let endedToDraft = 0;
  // US-148: ended listings whose item has a completed sale — their
  // "ended vs active" status observation is a sale, not a conflict.
  const soldEndedItemIds = new Set<string>();
  for (const itemId of endedItemIds) {
    try {
      // Defensive: never regress an item that has a completed sale on record,
      // even if its status drifted (the 'listed'-only guard below already
      // covers the common case).
      const { data: sale } = await supabaseAdmin
        .from("sales")
        .select("id")
        .eq("inventory_item_id", itemId)
        .eq("status", "completed")
        .limit(1)
        .maybeSingle();
      if (sale) {
        soldEndedItemIds.add(itemId);
        continue;
      }

      // Forward-safe: only regress an item that's still sitting in 'listed'.
      // .select() returns the row only when the update actually applied, so the
      // notification fires once on the real transition, not on every re-sync.
      const { data: moved } = await supabaseAdmin
        .from("inventory_items")
        .update({ status: "drafted" })
        .eq("id", itemId)
        .eq("user_id", userId)
        .eq("status", "listed")
        .select("id, title");
      const row = (moved ?? [])[0] as
        | { id: string; title: string | null }
        | undefined;
      if (row) {
        endedToDraft += 1;
        void notifyUser(userId, {
          type: "item_status_change",
          title: "Listing ended",
          message: `${row.title ?? "Your item"} ended on eBay without selling — it's back in Drafts to edit and relist.`,
          link: `/dashboard/flipdesk/items/${itemId}`,
        });
      }
    } catch (err) {
      errors.push(
        `relist-reconcile ${itemId}: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          160,
        ),
      );
    }
  }

  // ── Cross-source conflict detection (US-148) ────────────────────────
  // Runs after the orders pass so status observations for genuinely-sold
  // listings can be dropped instead of flagged.
  let conflictsRecorded = 0;
  let conflictsResolved = 0;
  try {
    const toRecord = ebayObservations.filter(
      (obs) =>
        !(
          obs.field === "listing_status" &&
          obs.itemId &&
          soldEndedItemIds.has(obs.itemId)
        ),
    );
    const res = await recordSourceObservations(userId, "ebay", toRecord);
    conflictsRecorded = res.recorded;
    conflictsResolved = res.resolved;
    errors.push(...res.errors.map((e) => `conflicts: ${e.slice(0, 160)}`));
  } catch (err) {
    errors.push(
      `conflicts: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    );
  }

  // Stamp last_synced_at so the UI can show "Synced 2m ago" + the next
  // /listings/pull picks up where this one left off.
  await supabaseAdmin
    .from("marketplace_connections")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", connId);

  console.log(
    `[flipdesk-ebay] pull complete: matched=${matched} unmatched=${unmatched} ` +
      `skipped=${skipped} legacy_matched=${legacyMatched} ` +
      `legacy_unmatched=${legacyUnmatched} legacy_duplicates=${legacyDuplicates} ` +
      `sales_new=${salesNew} sales_updated=${salesUpdated} ` +
      `sales_skipped=${salesSkipped} sales_enriched=${salesEnriched} ` +
      `catalog_updated=${catalogUpdated} specifics_fetched=${specificsFetched}` +
      `${specificsCapped ? ` (capped at ${MAX_SPECIFICS_FETCH_PER_SYNC}; remaining items backfill next sync)` : ""} ` +
      `ended_to_draft=${endedToDraft} ` +
      `conflicts_recorded=${conflictsRecorded} conflicts_resolved=${conflictsResolved} ` +
      `errors=${errors.length}`,
  );

  // Persist the run so the Reconciliation page can show its stats. Per-phase
  // failures were collected in `errors` without aborting the pull, so a run
  // that finished with any errors is "partial", otherwise "success".
  await recordSyncRun(userId, {
    startedAt,
    since: sinceISO,
    status: errors.length > 0 ? "partial" : "success",
    total: offers.length,
    matched,
    unmatched,
    skipped,
    legacyMatched,
    legacyUnmatched,
    legacyDuplicates,
    salesNew,
    salesUpdated,
    salesSkipped,
    salesEnriched,
    salesReversed,
    errors,
  }, runId);
}

// /listings/pull — validates the connection then fires the heavy sync as a
// detached background task, returning 202 immediately.  The actual work is
// done by doListingsPull() above; the frontend polls last_synced_at to know
// when it is done.
flipdeskEbayRoutes.post("/listings/pull", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Validate that the user has an active connection before firing the job.
  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, last_synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: sync the selected (primary) connection.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) {
    return c.json({ error: "Connect your eBay account first." }, 400);
  }
  const connId = (conn as { id: string; last_synced_at: string | null }).id;
  const lastSyncedAt =
    (conn as { id: string; last_synced_at: string | null }).last_synced_at ?? null;

  // ?full=true forces a one-time historical backfill: the orders + Finances
  // sync reaches back ~24 months instead of the incremental window, so sales
  // that predate the FlipDesk connection get imported.
  const backfill = c.req.query("full") === "true";

  // US-456: claim the in-flight lock BEFORE firing. A concurrent pull for the
  // same tenant is rejected (409) instead of racing writes; a dead run is reaped
  // inside claimSyncRun so a crash can't lock the tenant out permanently.
  const claim = await claimSyncRun(userId, "ebay");
  if (claim.status === "already_running") {
    return c.json(
      { error: "A sync is already running for this account.", alreadyRunning: true },
      409,
    );
  }
  const runId = claim.status === "claimed" ? claim.runId : null;

  // Fire-and-forget — do NOT await this. Returning 202 before the work starts
  // means the HTTP connection closes immediately, safely below Cloudflare's
  // 100s proxy timeout. The frontend polls last_synced_at to detect completion.
  // The .catch finalizes the lock as failed on an unexpected throw (the success
  // /partial and early fetch-failure paths finalize themselves via runId), so
  // the run never stays stuck in 'running'.
  void doListingsPull(userId, connId, lastSyncedAt, backfill, runId).catch(
    async (err) => {
      console.error("[flipdesk-ebay] background sync crashed:", err);
      if (runId) {
        await failSyncRun(runId, err instanceof Error ? err.message : String(err));
      }
    },
  );

  return c.json({ ok: true, message: "Sync started in background." }, 202);
});

// US-471: targeted incremental sync used by the eBay Notification webhook when
// an order/sale/return topic arrives, so sold/returned state updates in
// near-real-time instead of waiting for the next manual or scheduled pull.
// Mirrors the /listings/pull handler (validate connection → claim the in-flight
// lock → fire doListingsPull incrementally) but takes no Context: it's invoked
// from processEbayWebhookEvent after the seller has been resolved from the
// verified payload. Always incremental (never a backfill) and best-effort —
// returns a status string instead of throwing so a webhook ack is never blocked.
export async function triggerEbaySyncForUser(
  userId: string,
): Promise<"started" | "already_running" | "no_connection" | "not_configured"> {
  if (!isEbayConfigured()) return "not_configured";

  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, last_synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) return "no_connection";

  const connId = (conn as { id: string; last_synced_at: string | null }).id;
  const lastSyncedAt =
    (conn as { id: string; last_synced_at: string | null }).last_synced_at ?? null;

  // Reuse the same per-tenant lock the manual pull uses: if a sync is already
  // running (manual, scheduled, or a prior webhook), don't race — the in-flight
  // run will pick up the just-changed order. claimSyncRun reaps dead runs.
  const claim = await claimSyncRun(userId, "ebay");
  if (claim.status === "already_running") return "already_running";
  const runId = claim.status === "claimed" ? claim.runId : null;

  void doListingsPull(userId, connId, lastSyncedAt, false, runId).catch(
    async (err) => {
      console.error("[flipdesk-ebay] webhook-triggered sync crashed:", err);
      if (runId) {
        await failSyncRun(runId, err instanceof Error ? err.message : String(err));
      }
    },
  );
  return "started";
}

// GET /sync-runs — recent sync-run history for the Reconciliation page.
// Tenant-scoped to the workspace owner (the account the sync runs on behalf
// of). Returns the freshest runs first; default 20, capped at 50.
flipdeskEbayRoutes.get("/sync-runs", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit")) || 20, 1),
    50,
  );
  const { data, error } = await supabaseAdmin
    .from("flipdesk_sync_runs")
    .select("*")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) return failSafe(c, 500, "Couldn't load sync runs.", error, "ebay.sync-runs");
  return c.json({ runs: data ?? [] });
});

// ── Returns & cancellations management (US-1043, Post-Order API) ─────
//
// The seller's eBay token only ever sees that seller's own returns/cancels, so
// listing is inherently tenant-scoped to the workspace owner. After an action we
// best-effort update the matching local sale (tenant-scoped by user_id +
// platform_order_id) and always write an audit row. The action calls are
// idempotent at the eBay layer (a second decide on a resolved case is treated as
// success).

// Update the local sale's lifecycle after an eBay outcome (best-effort). Scoped
// to the owner; needs the eBay order id from the request (the UI has it).
async function applyOutcomeToSale(
  ownerId: string,
  orderId: unknown,
  outcome:
    | "return_refunded"
    | "return_declined"
    | "cancel_approved"
    | "cancel_rejected",
): Promise<void> {
  const status = outcomeToSaleStatus(outcome);
  if (!status || typeof orderId !== "string" || !orderId) return;
  const { error } = await supabaseAdmin
    .from("sales")
    .update({ status, cancelled_at: new Date().toISOString() })
    .eq("user_id", ownerId)
    .eq("platform_order_id", orderId);
  if (error) {
    console.error("[ebay.postorder] local sale update failed:", error.message);
  }
}

// A 4xx whose body says the case is already resolved → treat the action as a
// successful no-op (idempotency) rather than surfacing an error to the user.
function isAlreadyResolved(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already (been )?(decided|closed|refunded|approved|rejected|processed)/i
    .test(msg);
}

// GET /returns — open returns for the seller.
flipdeskEbayRoutes.get("/returns", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  try {
    return c.json({ returns: await searchReturns(ownerId, { limit }) });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load eBay returns.", err, "ebay.returns.list");
  }
});

// POST /returns/:returnId/decide — body { decision: approve|decline, comments?, order_id? }
flipdeskEbayRoutes.post("/returns/:returnId/decide", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { decision?: unknown; comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const decision = String(body.decision ?? "").toLowerCase();
  if (decision !== "approve" && decision !== "decline") {
    return c.json({ error: "decision must be 'approve' or 'decline'." }, 400);
  }
  const comments = typeof body.comments === "string" ? body.comments : undefined;
  try {
    await decideReturn(
      ownerId,
      returnId,
      decision === "approve" ? "APPROVE" : "DECLINE",
      comments,
    );
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the return decision.", err, "ebay.returns.decide");
    }
  }
  if (decision === "decline") {
    await applyOutcomeToSale(ownerId, body.order_id, "return_declined");
  }
  await writeAuditLog(c, {
    action: `ebay.return.${decision}`,
    targetType: "ebay_return",
    targetId: returnId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// POST /returns/:returnId/refund — body { comments?, order_id? }
flipdeskEbayRoutes.post("/returns/:returnId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const comments = typeof body.comments === "string" ? body.comments : undefined;
  try {
    await issueReturnRefund(ownerId, returnId, comments);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.returns.refund");
    }
  }
  await applyOutcomeToSale(ownerId, body.order_id, "return_refunded");
  await writeAuditLog(c, {
    action: "ebay.return.refund",
    targetType: "ebay_return",
    targetId: returnId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// GET /cancellations — open cancellation requests for the seller.
flipdeskEbayRoutes.get("/cancellations", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  try {
    return c.json({ cancellations: await searchCancellations(ownerId, { limit }) });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load eBay cancellations.", err, "ebay.cancellations.list");
  }
});

// POST /cancellations/:cancelId/approve — body { order_id? }
flipdeskEbayRoutes.post("/cancellations/:cancelId/approve", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const cancelId = c.req.param("cancelId");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await approveCancellation(ownerId, cancelId);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the cancellation approval.", err, "ebay.cancel.approve");
    }
  }
  await applyOutcomeToSale(ownerId, body.order_id, "cancel_approved");
  await writeAuditLog(c, {
    action: "ebay.cancellation.approve",
    targetType: "ebay_cancellation",
    targetId: cancelId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// POST /cancellations/:cancelId/reject — body { order_id? }
flipdeskEbayRoutes.post("/cancellations/:cancelId/reject", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const cancelId = c.req.param("cancelId");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await rejectCancellation(ownerId, cancelId);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the cancellation rejection.", err, "ebay.cancel.reject");
    }
  }
  await writeAuditLog(c, {
    action: "ebay.cancellation.reject",
    targetType: "ebay_cancellation",
    targetId: cancelId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// ── Leave buyer feedback (US-1047, Trading API) ─────────────────────
// POST /feedback — body { buyer_username, comment?, order_line_item_id? OR
// item_id+transaction_id }. Sellers may only leave POSITIVE feedback for buyers.
// Idempotent: eBay rejects a duplicate, which we report as already_left rather
// than an error. Inherently tenant-scoped (the owner's token can only leave
// feedback on the owner's own transactions).
flipdeskEbayRoutes.post("/feedback", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    buyer_username?: unknown;
    comment?: unknown;
    item_id?: unknown;
    transaction_id?: unknown;
    order_line_item_id?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const bodyOrderId = typeof (body as { order_id?: unknown }).order_id === "string"
    ? ((body as { order_id?: string }).order_id as string)
    : undefined;
  const explicitUser = String(body.buyer_username ?? "").trim();
  const itemId = typeof body.item_id === "string" ? body.item_id : undefined;
  const transactionId = typeof body.transaction_id === "string"
    ? body.transaction_id
    : undefined;
  const orderLineItemId = typeof body.order_line_item_id === "string"
    ? body.order_line_item_id
    : undefined;
  const comment = typeof body.comment === "string" && body.comment.trim()
    ? body.comment.trim()
    : "Great buyer — fast payment, smooth transaction. Thank you!";

  // Build the list of transactions to leave feedback for. Either the caller
  // passed explicit legacy ids, or we resolve them from the order id via the
  // Trading GetOrders bridge (the modern lineItemId we store isn't a legacy id).
  type Target = { itemId?: string; transactionId?: string; orderLineItemId?: string; user: string };
  let targets: Target[] = [];
  if (orderLineItemId && explicitUser) {
    targets = [{ orderLineItemId, user: explicitUser }];
  } else if (itemId && transactionId && explicitUser) {
    targets = [{ itemId, transactionId, user: explicitUser }];
  } else if (bodyOrderId) {
    try {
      const lineItems = await getOrderLegacyLineItems(userId, bodyOrderId);
      targets = lineItems
        .filter((li) => li.buyerUsername || explicitUser)
        .map((li) => ({
          itemId: li.itemId,
          transactionId: li.transactionId,
          user: li.buyerUsername ?? explicitUser,
        }));
    } catch (err) {
      return failSafe(c, 502, "Couldn't resolve the order for feedback.", err, "ebay.feedback.resolve");
    }
    if (targets.length === 0) {
      return c.json({ error: "No completed transactions found for that order." }, 404);
    }
  } else {
    return c.json(
      { error: "Provide order_id, or buyer_username + (order_line_item_id OR item_id + transaction_id)." },
      400,
    );
  }

  try {
    let alreadyLeftAll = true;
    for (const t of targets) {
      const { alreadyLeft } = await leaveFeedback(userId, {
        itemId: t.itemId,
        transactionId: t.transactionId,
        orderLineItemId: t.orderLineItemId,
        targetUser: t.user,
        comment,
      });
      if (!alreadyLeft) alreadyLeftAll = false;
    }
    await writeAuditLog(c, {
      action: "ebay.feedback.leave",
      targetType: "ebay_feedback",
      targetId: bodyOrderId ?? orderLineItemId ?? `${itemId}:${transactionId}`,
      details: { count: targets.length, already_left: alreadyLeftAll },
    });
    return c.json({ ok: true, count: targets.length, already_left: alreadyLeftAll });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the feedback.", err, "ebay.feedback");
  }
});

// US-1047: scheduled auto-leave positive feedback on recently-completed orders.
// Gated by system_settings "feedback.auto_leave" (default off). Idempotent via an
// admin_audit_log marker per order (shared with manual leaves so neither repeats).
flipdeskEbayRoutes.post("/jobs/leave-feedback", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!(await getSetting<boolean>("feedback.auto_leave", false))) {
    return c.json({ skipped: true, reason: "disabled" });
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const lock = await acquireJobLock("leave-feedback", 240);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason });
  }
  try {
    const { data: conns } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "ebay")
      .eq("is_active", true);
    const ownerIds = Array.from(
      new Set(((conns ?? []) as { user_id: string }[]).map((r) => r.user_id)),
    );
    // Leave a 2-day grace (payment settles) and look back 30 days.
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const windowEnd = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const PER_OWNER = 50;
    let left = 0;
    let skipped = 0;
    let errors = 0;

    for (const ownerId of ownerIds) {
      const { data: saleRows } = await supabaseAdmin
        .from("sales")
        .select("platform_order_id")
        .eq("user_id", ownerId)
        .eq("status", "completed")
        .not("platform_order_id", "is", null)
        .gte("sold_at", windowStart)
        .lte("sold_at", windowEnd)
        .limit(PER_OWNER);
      const orderIds = Array.from(
        new Set(
          ((saleRows ?? []) as { platform_order_id: string }[]).map(
            (r) => r.platform_order_id,
          ),
        ),
      );
      for (const orderId of orderIds) {
        // Idempotency: skip if feedback was already left for this order.
        const { data: prior } = await supabaseAdmin
          .from("admin_audit_log")
          .select("id")
          .eq("action", "ebay.feedback.leave")
          .eq("target_id", orderId)
          .limit(1)
          .maybeSingle();
        if (prior) {
          skipped += 1;
          continue;
        }
        try {
          const lineItems = await getOrderLegacyLineItems(ownerId, orderId);
          for (const li of lineItems) {
            if (!li.buyerUsername) continue;
            await leaveFeedback(ownerId, {
              itemId: li.itemId,
              transactionId: li.transactionId,
              targetUser: li.buyerUsername,
              comment: "Great buyer — fast payment, smooth transaction. Thank you!",
            });
          }
          await writeSystemAuditLog({
            action: "ebay.feedback.leave",
            targetType: "ebay_feedback",
            targetId: orderId,
            details: { auto: true, count: lineItems.length },
          });
          left += 1;
        } catch (err) {
          errors += 1;
          console.error(
            "[ebay.jobs.leave-feedback]",
            orderId,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    return c.json({ ok: true, owners: ownerIds.length, left, skipped, errors });
  } finally {
    await lock.release();
  }
});

// ── Payment disputes (US-1049, Fulfillment Payment Disputes API) ────
// Buyer-opened cases / chargebacks escalated to eBay. Seller must accept
// (refund) or contest before respondByDate. Listing is inherently tenant-scoped
// to the owner's token; accept best-effort marks the local sale refunded.

flipdeskEbayRoutes.get("/payment-disputes", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const status = c.req.query("status")?.trim() || undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  try {
    return c.json({
      disputes: await searchPaymentDisputes(ownerId, { status, limit }),
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load eBay payment disputes.", err, "ebay.disputes.list");
  }
});

flipdeskEbayRoutes.get("/payment-disputes/:id", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json({ dispute: await getPaymentDispute(ownerId, c.req.param("id")) });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load the payment dispute.", err, "ebay.disputes.get");
  }
});

flipdeskEbayRoutes.post("/payment-disputes/:id/accept", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const disputeId = c.req.param("id");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await acceptPaymentDispute(ownerId, disputeId);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected accepting the dispute.", err, "ebay.disputes.accept");
  }
  const status = disputeOutcomeToSaleStatus("accepted");
  if (status && typeof body.order_id === "string" && body.order_id) {
    const { error } = await supabaseAdmin
      .from("sales")
      .update({ status, cancelled_at: new Date().toISOString() } as never)
      .eq("user_id", ownerId)
      .eq("platform_order_id", body.order_id);
    if (error) console.error("[ebay.disputes.accept] sale update:", error.message);
  }
  await writeAuditLog(c, {
    action: "ebay.dispute.accept",
    targetType: "ebay_payment_dispute",
    targetId: disputeId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

flipdeskEbayRoutes.post("/payment-disputes/:id/contest", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const disputeId = c.req.param("id");
  let body: { note?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const note = typeof body.note === "string" ? body.note : undefined;
  try {
    await contestPaymentDispute(ownerId, disputeId, note);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected contesting the dispute.", err, "ebay.disputes.contest");
  }
  await writeAuditLog(c, {
    action: "ebay.dispute.contest",
    targetType: "ebay_payment_dispute",
    targetId: disputeId,
    details: { order_id: body.order_id ?? null, has_note: !!note },
  });
  return c.json({ ok: true });
});

// ── Publish flow (Week 3) ──────────────────────────────────────────
//
// /listings/validate runs every pre-flight check WITHOUT touching eBay.
// /listings/push runs the same check, then:
//   1. createOrReplaceInventoryItem  (PUT, idempotent)
//   2. createOffer                   (POST, returns offerId)
//   3. publishOffer                  (POST, returns listingId)
// On success the listings + inventory_items rows are updated to reflect the
// live state. createOffer is idempotent on SKU via listOffersForSku fallback.

// ── Manage live listings (Week 4) ──────────────────────────────────
// Update price (POST .../:id/price body: { price }) and end (DELETE
// .../:id) — both look up platform_offer_id from the local listings row
// and call the Sell API. If the local row has no platform_offer_id (e.g.
// the user manually marked an item "listed" via MarkListedDialog), the
// route returns 409 and the UI falls back to local-only.

flipdeskEbayRoutes.post("/listings/:id/price", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: { price?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return c.json({ error: "price must be a positive number" }, 400);
  }

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);
  if (!row.listing.platform_offer_id) {
    return c.json(
      {
        error:
          "This listing has no eBay offer id. Sync from eBay or republish to enable price updates.",
      },
      409
    );
  }

  try {
    await updateOfferPrice(userId, row.listing.platform_offer_id, price);
  } catch (err) {
    console.error("[flipdesk-ebay] updateOfferPrice failed:", err);
    return c.json(
      {
        error: "eBay rejected the price update.",
        detail:
          err instanceof Error ? err.message.slice(0, 500) : String(err),
      },
      502
    );
  }

  await supabaseAdmin
    .from("listings")
    .update({ listing_price: price })
    .eq("id", listingId);

  return c.json({ ok: true, listing_id: listingId, price });
});

// ── Bulk price / quantity update (US-1046 clean surface) ────────────
// POST /listings/bulk-price-quantity — body { updates: [{ listing_id, price?,
// quantity? }] }. Updates up to 25 offers per eBay call (chunked), tenant-scoped,
// per-item success/failure reported, local listings rows updated for successes.
flipdeskEbayRoutes.post("/listings/bulk-price-quantity", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { updates?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rawUpdates = Array.isArray(body.updates) ? body.updates : [];
  if (rawUpdates.length === 0) return c.json({ error: "updates required" }, 400);
  if (rawUpdates.length > 500) {
    return c.json({ error: "Too many updates (max 500)." }, 400);
  }

  // Normalize + validate. price>0, quantity>=0 integer; at least one present.
  const wanted = new Map<string, { price?: number; quantity?: number }>();
  for (const u of rawUpdates as Array<Record<string, unknown>>) {
    if (!u || typeof u.listing_id !== "string") continue;
    const priceNum = Number(u.price);
    const qtyNum = Number(u.quantity);
    const price = u.price != null && Number.isFinite(priceNum) && priceNum > 0
      ? priceNum
      : undefined;
    const quantity = u.quantity != null && Number.isInteger(qtyNum) && qtyNum >= 0
      ? qtyNum
      : undefined;
    if (price === undefined && quantity === undefined) continue;
    wanted.set(u.listing_id, { price, quantity });
  }
  const listingIds = [...wanted.keys()];
  if (listingIds.length === 0) return c.json({ error: "No valid updates." }, 400);

  // Load owned listings with their SKU + offer id (tenant-scoped, US-268).
  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_offer_id, inventory_items!inner(user_id, sku)",
    )
    .in("id", listingIds)
    .eq("inventory_items.user_id", userId);
  const owned = (rows ?? []) as unknown as Array<{
    id: string;
    platform_offer_id: string | null;
    inventory_items: { user_id: string; sku: string | null };
  }>;

  const results: Array<{ listing_id: string; ok: boolean; error?: string }> = [];
  const items: Array<PriceQtyUpdate & { listingId: string }> = [];
  for (const lid of listingIds) {
    const row = owned.find((r) => r.id === lid);
    const want = wanted.get(lid)!;
    if (!row) {
      results.push({ listing_id: lid, ok: false, error: "Listing not found" });
      continue;
    }
    const offerId = row.platform_offer_id;
    const sku = row.inventory_items.sku;
    if (!offerId || !sku) {
      results.push({ listing_id: lid, ok: false, error: "Listing has no eBay offer/SKU" });
      continue;
    }
    items.push({ listingId: lid, sku, offerId, priceValue: want.price, quantity: want.quantity });
  }

  for (const batch of chunk(items, EBAY_BULK_MAX)) {
    let entries: Array<Record<string, unknown>>;
    try {
      entries = await bulkUpdatePriceQuantity(
        userId,
        batch.map((b) => buildPriceQtyRequest(b)),
      ) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const b of batch) {
        results.push({ listing_id: b.listingId, ok: false, error: msg.slice(0, 200) });
      }
      continue;
    }
    batch.forEach((b, i) => {
      const norm = normalizeBulkEntry({ offerId: b.offerId, ...(entries[i] ?? {}) }, b.offerId);
      results.push(
        norm.ok
          ? { listing_id: b.listingId, ok: true }
          : { listing_id: b.listingId, ok: false, error: norm.error },
      );
    });
  }

  // Persist local rows for the successes.
  const okIds = new Set(results.filter((r) => r.ok).map((r) => r.listing_id));
  for (const b of items) {
    if (!okIds.has(b.listingId)) continue;
    const patch: Record<string, unknown> = {};
    if (b.priceValue != null) patch.listing_price = b.priceValue;
    if (b.quantity != null) patch.quantity = b.quantity;
    if (Object.keys(patch).length > 0) {
      await supabaseAdmin.from("listings").update(patch as never).eq("id", b.listingId);
    }
  }

  await writeAuditLog(c, {
    action: "ebay.bulk_price_quantity",
    targetType: "listings",
    details: { requested: listingIds.length, succeeded: okIds.size },
  });
  return c.json({ ok: true, results, succeeded: okIds.size, total: results.length });
});

// ── Markdown / Sale events (US-1045) ────────────────────────────────
// POST /listings/:id/sale — start an eBay markdown Sale (strike-through price +
// watcher notification) instead of a silent price revise. DELETE ends it and
// restores the original price (markdown is an overlay). The promotion id is
// stored in listings.platform_fields so we can end/reconcile it later.

flipdeskEbayRoutes.post("/listings/:id/sale", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  let body: { percent_off?: unknown; end_date?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const percentOff = Number(body.percent_off);
  if (!Number.isFinite(percentOff) || percentOff <= 0) {
    return c.json({ error: "percent_off must be a positive number" }, 400);
  }
  const endDate = typeof body.end_date === "string" ? body.end_date : undefined;

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);
  if (!row.listing.platform_listing_id) {
    return c.json(
      { error: "This listing has no eBay listing id. Sync or republish first." },
      409,
    );
  }

  let promotionId: string | null;
  try {
    promotionId = await createMarkdownSale(userId, {
      ebayListingId: row.listing.platform_listing_id,
      percentOff,
      endDate,
    });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the Sale event.", err, "ebay.markdown.create");
  }

  const { data: cur } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  const pf = {
    ...(((cur as { platform_fields?: Record<string, unknown> } | null)
      ?.platform_fields) ?? {}),
    markdown_promotion_id: promotionId,
    markdown_pct: clampMarkdownPct(percentOff),
  };
  await supabaseAdmin
    .from("listings")
    .update({ platform_fields: pf } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.markdown.start",
    targetType: "listing",
    targetId: listingId,
    details: { promotion_id: promotionId, percent_off: percentOff },
  });
  return c.json({ ok: true, listing_id: listingId, promotion_id: promotionId });
});

flipdeskEbayRoutes.delete("/listings/:id/sale", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);

  const { data: cur } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  const pf = ((cur as { platform_fields?: Record<string, unknown> } | null)
    ?.platform_fields) ?? {};
  const promotionId = typeof pf.markdown_promotion_id === "string"
    ? pf.markdown_promotion_id
    : null;
  if (!promotionId) {
    return c.json({ error: "No active Sale on this listing." }, 409);
  }

  try {
    await endMarkdownSale(userId, promotionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A 404 (already ended/deleted) is fine — fall through to clear local state.
    if (!/\(404\)|not found/i.test(msg)) {
      return failSafe(c, 502, "eBay rejected ending the Sale.", err, "ebay.markdown.end");
    }
  }

  delete pf.markdown_promotion_id;
  delete pf.markdown_pct;
  await supabaseAdmin
    .from("listings")
    .update({ platform_fields: pf } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.markdown.end",
    targetType: "listing",
    targetId: listingId,
    details: { promotion_id: promotionId },
  });
  return c.json({ ok: true, listing_id: listingId });
});

// ── Promoted Listings management (US-1044) ──────────────────────────
// GET status, POST to opt-in/set the ad rate, DELETE to opt out. The publish
// path already auto-attaches an ad; these give the seller explicit control.

interface PromoListingRow {
  platform_listing_id: string | null;
  platform_category_id: string | null;
  promo_opt_out: boolean | null;
  promo_rate_pct: number | null;
  promo_ad_id: string | null;
  promo_status: string | null;
  platform_fields: { markdown_promotion_id?: unknown; markdown_pct?: unknown } | null;
}

async function loadPromoRow(
  listingId: string,
  userId: string,
): Promise<PromoListingRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "platform_listing_id, platform_category_id, promo_opt_out, promo_rate_pct, promo_ad_id, promo_status, platform_fields, inventory_items!inner(user_id)",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as PromoListingRow & {
    inventory_items: { user_id: string };
  };
  if (row.inventory_items.user_id !== userId) return null;
  return row;
}

flipdeskEbayRoutes.get("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);
  const saleActive = typeof row.platform_fields?.markdown_promotion_id === "string";
  return c.json({
    opt_out: row.promo_opt_out ?? false,
    rate_pct: row.promo_rate_pct,
    ad_id: row.promo_ad_id,
    status: row.promo_status,
    suggested_rate_pct: suggestedAdRateForCategory(row.platform_category_id),
    sale_active: saleActive,
    sale_pct: typeof row.platform_fields?.markdown_pct === "number"
      ? row.platform_fields.markdown_pct
      : null,
  });
});

flipdeskEbayRoutes.post("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  let body: { rate_pct?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rate = Number(body.rate_pct);
  if (!Number.isFinite(rate) || rate <= 0) {
    return c.json({ error: "rate_pct must be a positive number" }, 400);
  }
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);
  if (!row.platform_listing_id) {
    return c.json(
      { error: "This listing has no eBay listing id. Sync or republish first." },
      409,
    );
  }

  let appliedRate = rate;
  let adId = row.promo_ad_id;
  try {
    const campaignId = await ensureAdCampaign(userId);
    const existing = await getAdForListing(userId, campaignId, row.platform_listing_id);
    if (existing?.adId) {
      appliedRate = await updateAdRateForListing(
        userId,
        campaignId,
        row.platform_listing_id,
        rate,
      );
      adId = existing.adId;
    } else {
      const created = await createAdForListing(
        userId,
        campaignId,
        row.platform_listing_id,
        rate,
      );
      adId = created?.adId ?? null;
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the promotion update.", err, "ebay.promotion.set");
  }

  await supabaseAdmin
    .from("listings")
    .update({
      promo_opt_out: false,
      promo_rate_pct: appliedRate,
      promo_ad_id: adId,
      promo_status: "active",
    } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.promotion.set",
    targetType: "listing",
    targetId: listingId,
    details: { rate_pct: appliedRate, ad_id: adId },
  });
  return c.json({ ok: true, rate_pct: appliedRate, ad_id: adId });
});

flipdeskEbayRoutes.delete("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);

  if (row.platform_listing_id) {
    try {
      const campaignId = await ensureAdCampaign(userId);
      await removeAdForListing(userId, campaignId, row.platform_listing_id);
    } catch (err) {
      return failSafe(c, 502, "eBay rejected removing the promotion.", err, "ebay.promotion.remove");
    }
  }

  await supabaseAdmin
    .from("listings")
    .update({
      promo_opt_out: true,
      promo_ad_id: null,
      promo_status: null,
    } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.promotion.remove",
    targetType: "listing",
    targetId: listingId,
  });
  return c.json({ ok: true });
});

// Revises a live listing — title / description / price / photo order. Photos
// and aspects flow through the inventory_item PUT (which is sourced from
// current local state), so editing a photo via the photo manager and then
// hitting revise with `photos: true` syncs the new image set + order to eBay.
//
// IMPORTANT (US-310/eBay): listings created through the Sell Inventory API
// CANNOT be edited on eBay's own site ("Inventory-based listing management is
// not currently supported by this tool"). This endpoint is the supported way
// to push edits back — including a photo reorder with no other change.
flipdeskEbayRoutes.post("/listings/:id/revise", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: {
    title?: unknown;
    description?: unknown;
    listing_price?: unknown;
    photos?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const nextTitle =
    typeof body.title === "string" ? body.title.trim() : undefined;
  const nextDesc =
    typeof body.description === "string" ? body.description.trim() : undefined;
  const nextPrice =
    body.listing_price !== undefined && body.listing_price !== null
      ? Number(body.listing_price)
      : undefined;

  const hasTitle = nextTitle !== undefined;
  const hasDesc = nextDesc !== undefined;
  const hasPrice = nextPrice !== undefined;
  // `photos: true` forces the inventory_item re-PUT so the current photo set
  // and sort order reach eBay even when no text field changed.
  const syncPhotos = body.photos === true;

  if (!hasTitle && !hasDesc && !hasPrice && !syncPhotos) {
    return c.json(
      {
        error:
          "Provide at least one of: title, description, listing_price, photos",
      },
      400
    );
  }
  if (hasTitle && !nextTitle) {
    return c.json({ error: "title cannot be empty" }, 400);
  }
  if (
    hasPrice &&
    (!Number.isFinite(nextPrice) || (nextPrice as number) <= 0)
  ) {
    return c.json({ error: "listing_price must be a positive number" }, 400);
  }

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);
  if (!row.listing.platform_offer_id) {
    return c.json(
      {
        error:
          "This listing has no eBay offer id. Sync from eBay or republish to enable edits.",
      },
      409
    );
  }
  const offerId = row.listing.platform_offer_id;
  const itemId = row.listing.inventory_item_id;

  // Update local state first so the inventory_item PUT below reads the
  // canonical (post-edit) values. Any eBay error rolls back via the
  // user re-syncing; we keep local as the source of truth.
  const localUpdates: Record<string, unknown> = {};
  if (hasTitle) localUpdates.listing_title = nextTitle;
  if (hasDesc) localUpdates.listing_description = nextDesc;
  if (hasPrice) localUpdates.listing_price = nextPrice;
  // A photos-only revise has nothing to write locally — skip the no-op update
  // (an empty PATCH would error on PostgREST).
  if (Object.keys(localUpdates).length > 0) {
    await supabaseAdmin.from("listings").update(localUpdates).eq("id", listingId);
  }

  // Re-PUT the inventory_item when product fields changed (title / desc) OR a
  // photo sync was requested. We send full state — photos, aspects, brand — so
  // any drift from the photo manager / category picker also syncs here.
  if (hasTitle || hasDesc || syncPhotos) {
    const { data: itemRow } = await supabaseAdmin
      .from("inventory_items")
      .select(
        "id, user_id, title, brand, size, sku, description, condition_notes, grade_value, grade_label, ebay_aspects"
      )
      .eq("id", itemId)
      .maybeSingle();
    if (!itemRow || (itemRow as { user_id: string }).user_id !== userId) {
      return c.json({ error: "Item not found" }, 404);
    }
    const item = itemRow as {
      id: string;
      user_id: string;
      title: string | null;
      brand: string | null;
      size: string | null;
      sku: string | null;
      description: string | null;
      condition_notes: string | null;
      grade_value: number | null;
      grade_label: string | null;
      ebay_aspects: Record<string, string[]> | null;
    };

    // US-1088: keep the eBay "Size" item specific in sync with the item's size
    // field. The Size field is the source of truth, so mirror it into the aspect
    // on every revise — eBay shows size from item specifics, not the title — so
    // a Size AI fill (or any size edit) reaches buyers when pushed.
    const aspects: Record<string, string[]> = { ...(item.ebay_aspects ?? {}) };
    if (item.size && item.size.trim()) {
      aspects.Size = [item.size.trim()];
    }
    const sku =
      item.sku && item.sku.trim()
        ? item.sku.trim()
        : `FD-${item.id.slice(0, 8)}`;

    const { data: photoRows } = await supabaseAdmin
      .from("item_photos")
      .select("storage_path, photo_url, sort_order")
      .eq("inventory_item_id", itemId)
      .order("sort_order", { ascending: true });
    const imageUrls = toEbayImageUrls(
      (
        (photoRows ?? []) as Array<{
          storage_path: string | null;
          photo_url: string | null;
        }>
      ).map((p) => {
        if (p.photo_url) return p.photo_url;
        if (p.storage_path) {
          return supabaseAdmin.storage
            .from("item-photos")
            .getPublicUrl(p.storage_path).data.publicUrl;
        }
        return null;
      })
    );

    // When the caller didn't override title/desc (e.g. a photos-only sync),
    // fall back to the values that were actually PUBLISHED (the listing row),
    // then the inventory_items mirror — never let a photo reorder silently
    // revert the live title/description.
    const finalTitle = hasTitle
      ? (nextTitle as string)
      : (row.listing.listing_title ?? item.title ?? "").trim();
    const finalDesc = hasDesc
      ? (nextDesc as string)
      : (
          row.listing.listing_description ??
          item.description ??
          finalTitle
        ).trim() || finalTitle;

    try {
      await createOrReplaceInventoryItem(userId, sku, {
        product: {
          title: finalTitle,
          description: finalDesc,
          aspects: Object.keys(aspects).length > 0 ? aspects : undefined,
          imageUrls,
          // Mirror the publish path (US: error 25002 <BrandMPN>): eBay requires a
          // Brand+MPN product identifier on every inventory_item PUT, so the
          // revise re-PUT must send the SAME defaults publish does — otherwise a
          // title/description/photo edit drops the MPN and eBay 400s the revision.
          brand:
            typeof item.brand === "string" && item.brand.trim()
              ? item.brand.trim()
              : "Unbranded",
          mpn: "Does Not Apply",
        },
        condition: mapEbayCondition(item.grade_value, item.grade_label),
        conditionDescription: item.condition_notes?.trim() || undefined,
        availability: { shipToLocationAvailability: { quantity: 1 } },
      });
    } catch (err) {
      console.error("[flipdesk-ebay] revise inventory_item failed:", err);
      // 422 (not 502): an eBay business-rule rejection is a data problem, not a
      // gateway failure. A 5xx gets intercepted by the Traefik/Coolify error page
      // (which strips CORS headers — see main.ts), so the browser sees a bare
      // "CORS blocked" instead of this detail. 422 passes through with the body.
      return c.json(
        {
          error: "eBay rejected the revision.",
          detail:
            err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
        422
      );
    }
  }

  // Offer side handles price + listing description (offer.listingDescription
  // overrides product.description on the live listing). Batched into one PUT.
  if (hasPrice || hasDesc) {
    try {
      await updateOfferFields(userId, offerId, {
        price: hasPrice ? (nextPrice as number) : undefined,
        listingDescription: hasDesc ? (nextDesc as string) : undefined,
      });
    } catch (err) {
      console.error("[flipdesk-ebay] revise offer failed:", err);
      // 422 (not 502): see the inventory_item branch above — an eBay rejection is
      // a data problem; a 5xx loses its CORS headers to the proxy error page.
      return c.json(
        {
          error: "eBay rejected the offer revision.",
          detail:
            err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
        422
      );
    }
  }

  // US-1081: a revise re-asserts GradeThread's values onto eBay, so any recorded
  // eBay-drift marker is now resolved — clear it so the "eBay differs" indicator
  // disappears without waiting for the next inbound sync.
  {
    const { data: cur } = await supabaseAdmin
      .from("listings")
      .select("platform_fields")
      .eq("id", listingId)
      .maybeSingle();
    const pf = ((cur as { platform_fields?: Record<string, unknown> } | null)
      ?.platform_fields) ?? {};
    if ((pf as { sync_drift?: unknown }).sync_drift) {
      delete (pf as { sync_drift?: unknown }).sync_drift;
      await supabaseAdmin
        .from("listings")
        .update({ platform_fields: pf } as never)
        .eq("id", listingId);
    }
  }

  return c.json({
    ok: true,
    listing_id: listingId,
    updated: localUpdates,
    photos_synced: syncPhotos || hasTitle || hasDesc,
  });
});

// US-1039: mark an eBay sale shipped + push the tracking number/carrier to eBay
// (Sell Fulfillment API). Without this, FlipDesk only recorded shipping locally
// — eBay never got the tracking, so the buyer saw none and the seller lost
// late-shipment / Seller Protection credit. Tenant-scoped: the sale is loaded
// THROUGH inventory_items.user_id, never by a raw id. Idempotent on a re-click
// with the same tracking (skips the eBay call).
flipdeskEbayRoutes.post("/orders/:saleId/ship", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const saleId = c.req.param("saleId");

  let body: { tracking_number?: unknown; carrier?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const trackingNumber =
    typeof body.tracking_number === "string" ? body.tracking_number.trim() : "";
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : null;
  if (!trackingNumber) {
    return c.json({ error: "tracking_number is required" }, 400);
  }

  // Tenant-scoped load (US-268): the sale must belong to the owner.
  const { data: saleRow } = await supabaseAdmin
    .from("sales")
    .select(
      "id, platform_order_id, shipped_at, tracking_number, inventory_items!inner(user_id)",
    )
    .eq("id", saleId)
    .eq("inventory_items.user_id", userId)
    .maybeSingle();
  const sale = saleRow as
    | {
      id: string;
      platform_order_id: string | null;
      shipped_at: string | null;
      tracking_number: string | null;
    }
    | null;
  if (!sale) return c.json({ error: "Sale not found." }, 404);
  if (!sale.platform_order_id) {
    return c.json(
      { error: "This sale has no eBay order id to mark shipped." },
      409,
    );
  }

  // Idempotent: an already-shipped sale with the same tracking just re-asserts
  // local state (eBay would reject a duplicate fulfillment).
  const alreadyShipped =
    sale.shipped_at != null && sale.tracking_number === trackingNumber;
  if (!alreadyShipped) {
    try {
      await createShippingFulfillment(userId, sale.platform_order_id, {
        trackingNumber,
        carrier,
      });
    } catch (err) {
      console.error("[flipdesk-ebay] createShippingFulfillment failed:", err);
      return c.json(
        {
          error: "eBay rejected the tracking upload.",
          detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
        502,
      );
    }
  }

  const { error: updErr } = await supabaseAdmin
    .from("sales")
    .update({
      shipped_at: sale.shipped_at ?? new Date().toISOString(),
      tracking_number: trackingNumber,
    })
    .eq("id", sale.id);
  if (updErr) {
    console.error("[flipdesk-ebay] sale ship write-back failed:", updErr.message);
  }
  return c.json({ ok: true, pushed_to_ebay: !alreadyShipped });
});

// Compares the current eBay category against what the Taxonomy API would
// suggest for the listing's title today. Lets the user spot listings that
// are filed under a suboptimal category (which hurts search visibility).
//
// Returns the current category (id + name + breadcrumb) and the top 5
// suggestions. `match` is true iff the top suggestion equals the current.
flipdeskEbayRoutes.get("/listings/:id/category-check", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  // Load the listing + its title (from the joined inventory_item or the
  // listing's own listing_title). Ownership check via the item user_id.
  const { data: row } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_category_id, platform_listing_id, listing_title, inventory_items!inner(user_id, title, brand, style)"
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!row) return c.json({ error: "Listing not found" }, 404);
  const r = row as unknown as {
    id: string;
    platform_category_id: string | null;
    platform_listing_id: string | null;
    listing_title: string | null;
    inventory_items: {
      user_id: string;
      title: string | null;
      brand: string | null;
      style: string | null;
    };
  };
  if (r.inventory_items.user_id !== userId) {
    return c.json({ error: "Listing not found" }, 404);
  }

  // Title we'll feed into the Taxonomy query — use whatever's most
  // representative: the listing's actual title beats the item title.
  const queryParts = [r.listing_title ?? r.inventory_items.title]
    .filter((s): s is string => !!s && s.trim() !== "");
  if (queryParts.length === 0) {
    return c.json(
      { error: "Listing has no title — can't suggest a category." },
      400
    );
  }
  const query = queryParts[0]!;

  // Run current-category lookup + suggestions in parallel — independent calls.
  const [currentInfo, suggestions] = await Promise.all([
    r.platform_category_id
      ? getCategoryName(r.platform_category_id).catch(() => null)
      : Promise.resolve(null),
    suggestCategories(query).catch((err) => {
      console.error("[flipdesk-ebay] suggestCategories failed:", err);
      return [] as Awaited<ReturnType<typeof suggestCategories>>;
    }),
  ]);

  const top = suggestions[0] ?? null;
  const match =
    !!r.platform_category_id && !!top && top.categoryId === r.platform_category_id;

  return c.json({
    listing_id: listingId,
    current: r.platform_category_id
      ? {
          id: r.platform_category_id,
          name: currentInfo?.name ?? null,
          path: currentInfo?.path ?? null,
        }
      : null,
    suggested: suggestions.slice(0, 5).map((s) => ({
      id: s.categoryId,
      name: s.categoryName,
      path: s.categoryTreePath,
    })),
    match,
    query_used: query,
  });
});

flipdeskEbayRoutes.delete("/listings/:id", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);
  if (!row.listing.platform_offer_id) {
    return c.json(
      {
        error:
          "This listing has no eBay offer id. Sync from eBay to enable remote end.",
      },
      409
    );
  }

  try {
    await withdrawOffer(userId, row.listing.platform_offer_id);
  } catch (err) {
    console.error("[flipdesk-ebay] withdrawOffer failed:", err);
    return c.json(
      {
        error: "eBay rejected the end-listing call.",
        detail:
          err instanceof Error ? err.message.slice(0, 500) : String(err),
      },
      502
    );
  }

  await supabaseAdmin
    .from("listings")
    .update({ listing_status: "ended", is_active: false })
    .eq("id", listingId);
  // Move the item back to drafted so the user can relist if they want.
  await supabaseAdmin
    .from("inventory_items")
    .update({ status: "drafted" })
    .eq("id", row.listing.inventory_item_id);

  return c.json({ ok: true, listing_id: listingId });
});

flipdeskEbayRoutes.post("/listings/validate", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = await readItemId(c);
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);
  const result = await assemblePublishContext(userId, itemId);
  if (!result.ok) return c.json(result.error, result.status);
  return c.json({
    ok: result.blockers.length === 0,
    blockers: result.blockers,
    // US-828: aspects that won't be sent for value-validation reasons, so the
    // composer can warn "X was not sent" before the seller publishes.
    aspectDiagnostics: result.aspectDiagnostics,
    summary: result.summary,
  });
});

// US-561: lightweight category → suggested Promoted Listings ad rate. The
// composer surfaces this as the default ad rate so "promote by default" stays
// transparent — the seller accepts, adjusts, or opts out before publish. Pure
// (no eBay round-trip), so it's cheap to call on every category change.
flipdeskEbayRoutes.get("/marketing/ad-rate-suggestion", (c) => {
  const categoryId = c.req.query("category_id") ?? null;
  return c.json({
    category_id: categoryId,
    suggested_rate_pct: suggestedAdRateForCategory(categoryId),
  });
});

// US-561: refresh the live Promoted Listings ad status + bid for the
// workspace's promoted listings (user-triggered "Refresh" on the promotions
// surface). Tenant-scoped to the workspace owner inside the lib helper.
flipdeskEbayRoutes.post("/marketing/promoted/sync", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const result = await syncPromotedListingsForOwner(userId);
  return c.json({ ok: true, ...result });
});

// eBay allows at most 24 pictures per listing (Inventory API product.imageUrls).
// Sending more returns error 25601 ("The size for ImageLinks cannot exceed …").
// Photos arrive sorted by sort_order, so capping keeps the cover + best shots.
// De-dup/cap logic lives in lib/publish-preflight.ts (US-473) so it's shared
// with the pre-flight blocker check and unit-tested in isolation.
function toEbayImageUrls(urls: Array<string | null | undefined>): string[] {
  return dedupeAndCapImages(urls).urls;
}

// US-473: HEAD-probe an image URL for the pre-publish reachability check. Short
// deadline; a thrown error (network/timeout) propagates so checkImageReachability
// can treat it as "reachable" (best-effort). Some CDNs reject HEAD with 405 —
// that's not a 404/410/403, so it's correctly treated as reachable.
async function headProbe(url: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetchWithTimeout(url, { method: "HEAD" }, 5_000);
  return { ok: res.ok, status: res.status };
}

export type PublishItemResult =
  | {
    ok: true;
    listing_id: string;
    listing_url: string;
    offer_id: string;
    sku: string;
    // US-783: the listing is live on eBay but the local DB sync didn't land;
    // a reconcile marker was recorded for the pull-sync. The caller reports
    // success, not a publish failure.
    sync_pending?: boolean;
  }
  | { ok: false; status: 400 | 404 | 422 | 500 | 502 | 503; body: Record<string, unknown> };

// Publish one owned item to eBay (inventory PUT → offer POST → publish POST).
// Parameterized by ownerId so both the authed /listings/push handler and the
// scheduled publish-due worker (US-322) reuse the identical flow. Returns a
// result union instead of an HTTP response so non-HTTP callers can use it.
export async function publishItemForOwner(
  ownerId: string,
  itemId: string,
  opts: { relist?: boolean } = {},
): Promise<PublishItemResult> {
  const ctx = await assemblePublishContext(ownerId, itemId);
  if (!ctx.ok) return { ok: false, status: ctx.status, body: ctx.error };
  if (ctx.blockers.length > 0 || !ctx.policies) {
    return {
      ok: false,
      status: 422,
      body: {
        ok: false,
        blockers: ctx.blockers.length > 0
          ? ctx.blockers
          : ["eBay business policies are not configured."],
      },
    };
  }

  const { item, listing, photos, policies, sku } = ctx;

  // Grade-badge + certificate-link promotion (00145). Runs ONLY on the real
  // publish path — not the frequently-hit /listings/validate, which also calls
  // assemblePublishContext — so the (expensive) compositing happens once per
  // publish. Mutates photos[0].public_url (badged hero) and the description
  // (cert link) in place before the reachability probe + eBay payload below.
  ctx.summary.description = await applyGradeBadgePromotion(
    ownerId,
    item,
    listing,
    photos,
    ctx.summary.description,
  );

  // US-766: attach the QR-bearing Digital Slab as the lead or a supplementary
  // listing image when the seller opted in (per-listing slab_image_mode or the
  // global default). Mutates `photos` in place — AFTER the badge burn so the
  // grade badge lands on the real hero, not the slab — so the slab reaches both
  // the single-SKU and variation publish paths and the reachability probe below.
  await applySlabImagePromotion(ownerId, item, listing, photos);

  // US-473: pre-publish image reachability. eBay fetches imageUrls server-side
  // at publish; an unreachable URL fails the whole publish with an opaque error
  // (and our proxy can surface a 502). HEAD-probe the URLs first and turn a
  // definitive 404/410/403 into a fixable blocker. Best-effort — transient
  // errors/timeouts are treated as reachable so a flaky CDN moment never blocks
  // a legitimate publish. Kept out of assemblePublishContext (called on every
  // composer load) so it only costs the actual publish path.
  const reach = await checkImageReachability(
    photos.map((p) => p.public_url),
    headProbe,
  );
  const reachBlocker = reachabilityBlocker(reach);
  if (reachBlocker) {
    return { ok: false, status: 422, body: { ok: false, blockers: [reachBlocker] } };
  }

  // Relist (end-old-then-relist): when the caller asks to relist and this item
  // still has a LIVE eBay listing, withdraw it first so the publish below mints
  // a brand-new listing id instead of publishOrAdoptOffer (US-464) adopting the
  // still-live one. eBay only allows one live offer per SKU, so we end the old
  // listing rather than create a duplicate. Best-effort: an already-ended offer
  // throws here, which is fine — we just want it not-live before re-publishing.
  if (opts.relist) {
    const { data: liveRow } = await supabaseAdmin
      .from("listings")
      .select("platform_offer_id, is_active, listing_status")
      .eq("inventory_item_id", itemId)
      .eq("platform", "ebay")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const live = liveRow as
      | { platform_offer_id: string | null; is_active: boolean | null; listing_status: string | null }
      | null;
    const stillLive =
      !!live?.platform_offer_id &&
      (live.is_active === true || live.listing_status === "active");
    if (stillLive && live?.platform_offer_id) {
      try {
        await withdrawOffer(ownerId, live.platform_offer_id);
      } catch (err) {
        // Already ended / not found → proceed. A real failure (still genuinely
        // live) would surface on publish as an adopt instead of a fresh listing.
        console.warn(
          "[flipdesk-ebay] relist: withdrawOffer before re-publish failed (continuing):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // 1. Ensure the SKU is persisted on the item so reconciliation works
  //    (eBay's "Custom label" maps back to this).
  if (sku !== item.sku) {
    await supabaseAdmin
      .from("inventory_items")
      .update({ sku })
      .eq("id", itemId);
  }

  try {
    // US-568: multi-variant listings take a separate publish path — each variant
    // is its own inventory_item (SKU) grouped into an inventory_item_group, then
    // published as ONE multi-variation listing. Returns early; the single-SKU
    // flow below never runs for variation listings.
    if (ctx.summary.variations) {
      return await publishVariationListing({
        ownerId,
        itemId,
        baseSku: sku,
        ctx,
        item,
        listing,
        photos,
        policies,
        variations: ctx.summary.variations,
      });
    }

    // 2. Push inventory_item (idempotent PUT). Quantity, aspects, and
    //    condition all come from the publish context, which already resolved
    //    listing-row edits ahead of inventory defaults (US-319/320/321).
    await createOrReplaceInventoryItem(ownerId, sku, {
      product: {
        title: ctx.summary.title,
        description: ctx.summary.description,
        aspects: ctx.summary.aspects,
        imageUrls: toEbayImageUrls(photos.map((p) => p.public_url)),
        // eBay requires a Brand+MPN product identifier (error 25002
        // <BrandMPN>). Default Brand to "Unbranded" and MPN to "Does Not
        // Apply" — the standard values for used items without a manufacturer
        // part number — so the offer publishes instead of being rejected.
        brand:
          typeof item.brand === "string" && item.brand.trim()
            ? item.brand.trim()
            : "Unbranded",
        mpn: "Does Not Apply",
      },
      condition: ctx.summary.condition,
      conditionDescription:
        ctx.summary.conditionDescription || undefined,
      availability: {
        shipToLocationAvailability: { quantity: ctx.summary.quantity },
      },
    });

    // US-562: build the shared bestOfferTerms once so the create and re-sync
    // paths send identical auto-accept/decline thresholds. Omitted entirely
    // when Best Offer is off. US-568: eBay does not allow Best Offer on auction
    // offers, so it's suppressed unless the format is FIXED_PRICE.
    const bestOfferTerms: BestOfferTerms | undefined = ctx.summary
      .bestOfferEnabled && ctx.summary.format === "FIXED_PRICE"
      ? {
          bestOfferEnabled: true,
          ...(ctx.summary.bestOfferAutoAccept
            ? {
                autoAcceptPrice: {
                  value: ctx.summary.bestOfferAutoAccept,
                  currency: ctx.summary.currency,
                },
              }
            : {}),
          ...(ctx.summary.bestOfferAutoDecline
            ? {
                autoDeclinePrice: {
                  value: ctx.summary.bestOfferAutoDecline,
                  currency: ctx.summary.currency,
                },
              }
            : {}),
        }
      : undefined;

    // US-568: build the pricingSummary for the resolved format. FIXED_PRICE
    // sends `price`; AUCTION sends `auctionStartPrice` (+ optional reserve and a
    // Buy It Now `price`). listingDuration is GTC for fixed-price, DAYS_n for
    // auctions (resolved in assemblePublishContext).
    const pricingSummary: PricingSummary =
      ctx.summary.format === "AUCTION"
        ? {
            auctionStartPrice: {
              value: ctx.summary.auctionStartPrice ?? ctx.summary.priceValue,
              currency: ctx.summary.currency,
            },
            ...(ctx.summary.auctionReservePrice
              ? {
                  auctionReservePrice: {
                    value: ctx.summary.auctionReservePrice,
                    currency: ctx.summary.currency,
                  },
                }
              : {}),
            ...(ctx.summary.auctionBuyItNowPrice
              ? {
                  price: {
                    value: ctx.summary.auctionBuyItNowPrice,
                    currency: ctx.summary.currency,
                  },
                }
              : {}),
          }
        : {
            price: {
              value: ctx.summary.priceValue,
              currency: ctx.summary.currency,
            },
          };
    const listingDuration = ctx.summary.auctionDuration;

    // 3. Create or reuse an offer for this SKU.
    let offerId: string;
    try {
      const created = await createOffer(ownerId, {
        sku,
        marketplaceId: getMarketplaceId(),
        format: ctx.summary.format,
        availableQuantity: ctx.summary.quantity,
        categoryId: ctx.summary.categoryId,
        listingDescription: ctx.summary.description,
        listingDuration,
        listingPolicies: {
          fulfillmentPolicyId: policies.fulfillmentPolicyId,
          paymentPolicyId: policies.paymentPolicyId,
          returnPolicyId: policies.returnPolicyId,
          ...(bestOfferTerms ? { bestOfferTerms } : {}),
        },
        pricingSummary,
        merchantLocationKey: policies.merchantLocationKey,
      });
      offerId = created.offerId;
    } catch (err) {
      if (!isOfferAlreadyExistsError(err)) throw err;
      const existing = await listOffersForSku(ownerId, sku);
      const found = existing.find((o) => !!o.offerId);
      if (!found) throw err;
      offerId = found.offerId;
      // The existing offer was created on an earlier attempt and may carry a
      // stale shipping policy / price / category (eBay 25007 keeps firing on
      // publish until the offer itself is corrected). Push the current draft +
      // selected policies onto it before publishing.
      await syncExistingOffer(ownerId, offerId, {
        availableQuantity: ctx.summary.quantity,
        categoryId: ctx.summary.categoryId,
        listingDescription: ctx.summary.description,
        listingDuration,
        listingPolicies: {
          fulfillmentPolicyId: policies.fulfillmentPolicyId,
          paymentPolicyId: policies.paymentPolicyId,
          returnPolicyId: policies.returnPolicyId,
          ...(bestOfferTerms ? { bestOfferTerms } : {}),
        },
        pricingSummary,
        merchantLocationKey: policies.merchantLocationKey,
      });
    }

    // 4. Publish — or ADOPT an already-published listing (US-464). If a prior
    //    attempt published this offer remotely but crashed before persisting
    //    the local listings row (step 5), publishOrAdoptOffer returns that live
    //    listingId instead of re-publishing, so a retry can't create a duplicate
    //    live listing.
    const published = await publishOrAdoptOffer(ownerId, offerId);
    const listingId = published.listingId;
    const url = ebayListingUrl(listingId);

    // 5. Persist the live state. Upsert the listings row so a re-publish
    //    of the same item points at the new eBay listingId. synced_to_ebay_at
    //    marks the draft as live (clears any prior publish failure).
    const listingPayload = {
      inventory_item_id: itemId,
      platform: "ebay" as const,
      platform_listing_id: listingId,
      platform_offer_id: offerId,
      platform_category_id: ctx.summary.categoryId,
      listing_url: url,
      listing_price: Number(ctx.summary.priceValue),
      listing_title: ctx.summary.title,
      listing_description: ctx.summary.description,
      listing_status: "active" as const,
      is_active: true,
      listed_at: new Date().toISOString(),
      synced_to_ebay_at: new Date().toISOString(),
      publish_error: null,
      publish_failed_at: null,
    };

    // US-783: the listing is LIVE on eBay now. A failure on the local writes
    // below is NOT a publish failure — retry, then fall back to a reconcile
    // marker (the pull-sync adopts the orphan by SKU) and return success with
    // sync_pending. NEVER surface a publish error for an eBay-side success.
    const { syncPending } = await finalizePublishedListing({
      persist: async () => {
        if (listing?.id) {
          const { error } = await supabaseAdmin
            .from("listings")
            .update(listingPayload)
            .eq("id", listing.id);
          if (error) throw new Error(`listings update: ${error.message}`);
        } else {
          const { error } = await supabaseAdmin.from("listings").insert(listingPayload);
          if (error) throw new Error(`listings insert: ${error.message}`);
        }
        const { error: itemErr } = await supabaseAdmin
          .from("inventory_items")
          .update({ status: "listed" })
          .eq("id", itemId);
        if (itemErr) throw new Error(`inventory_items update: ${itemErr.message}`);
      },
      recordReconcile: async () => {
        // Snapshot the orphaned-but-live listing into the same table the pull-
        // sync + Reconciliation page use, so it's adopted on the next sync.
        await supabaseAdmin
          .from("flipdesk_ebay_listings")
          .upsert(
            {
              user_id: ownerId,
              ebay_item_id: listingId,
              custom_label: sku,
              title: ctx.summary.title,
              current_price: Number(ctx.summary.priceValue),
              listing_url: url,
              raw: { offerId, source: "publish_orphan", inventory_item_id: itemId },
              match_status: "unmatched",
              imported_at: new Date().toISOString(),
            },
            { onConflict: "user_id,ebay_item_id" },
          );
        console.error(
          `[flipdesk-ebay] publish ${listingId} is LIVE but local write failed — ` +
            `recorded reconcile marker; pull-sync will adopt it`,
        );
      },
    });

    // US-561: attach an eBay Promoted Listings ad at the resolved rate (the
    // seller's accepted/adjusted rate, or the category suggestion) unless they
    // opted out. BEST-EFFORT — the listing is already live, so a Marketing API
    // failure records promo_status='failed' on the row but never fails publish.
    if (ctx.summary.promotedAdRate != null && ctx.summary.promotedAdRate > 0) {
      await attachPromotionAtPublish({
        userId: ownerId,
        listingRowId: listing?.id ?? null,
        ebayListingId: listingId,
        ratePct: ctx.summary.promotedAdRate,
      });
    }

    // US-547: capture the seller-acceptance signal — diff the AI's generated
    // snapshot against the now-published (post-edit) values, attributed to the
    // listing_gen prompt version. Non-fatal; no-op for non-AI drafts.
    if (listing?.id) {
      await captureListingAcceptance(listing.id);
    }

    return {
      ok: true,
      listing_id: listingId,
      listing_url: url,
      offer_id: offerId,
      sku,
      sync_pending: syncPending,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // US-567: keep the raw eBay detail SERVER-SIDE (logs only) and surface a
    // short, actionable message mapped from eBay's structured error IDs.
    console.error("[flipdesk-ebay] publish failed:", msg);
    const ebayErrorIds = (err as { ebayErrorIds?: number[] }).ebayErrorIds;
    const fix = mapEbayError(ebayErrorIds);
    const userMessage = fix?.message ?? EBAY_PUBLISH_GENERIC_FIX;
    // US-321: persist the failure on the draft listing so the queue/UI can
    // surface "last failed: X" on reload, and US-325 retry can target it. Store
    // the user-facing message (not the raw eBay blob).
    if (listing?.id) {
      try {
        await supabaseAdmin
          .from("listings")
          .update({
            publish_error: userMessage.slice(0, 1000),
            publish_failed_at: new Date().toISOString(),
          })
          .eq("id", listing.id);
      } catch (logErr) {
        console.error("[flipdesk-ebay] could not persist publish_error:", logErr);
      }
    }
    return {
      // 422, NOT 5xx: a publish rejection (eBay 400, policy gap, etc.) is a
      // business failure, not a gateway error. Traefik/Coolify intercepts
      // gateway-class 5xx (502/503/504) with its own error page that strips
      // CORS headers, so the browser shows an opaque CORS error instead of the
      // real eBay message. 422 stays inside the app's CORS-handled path so the
      // dialog can surface `detail` to the seller.
      ok: false,
      status: 422,
      body: {
        ok: false,
        error: "Publish failed",
        // US-567: actionable mapped message (raw eBay detail stays in logs).
        detail: userMessage,
        ...(fix?.field ? { fix_field: fix.field } : {}),
        ...(ebayErrorIds && ebayErrorIds.length > 0
          ? { ebay_error_ids: ebayErrorIds }
          : {}),
      },
    };
  }
}

// US-568: publish a multi-variant (size/color) listing. Each variant becomes
// its own inventory_item (SKU) carrying the variation aspects; they're tied
// together by an inventory_item_group and published as ONE listing via
// publish_by_inventory_item_group. Mirrors publishItemForOwner's persistence so
// the local listings/inventory rows end up identical to a single-SKU publish.
async function publishVariationListing(args: {
  ownerId: string;
  itemId: string;
  baseSku: string;
  ctx: PublishContextOk;
  item: PublishItem;
  listing: PublishListing | null;
  photos: PublishPhoto[];
  policies: PolicySet;
  variations: ListingVariations;
}): Promise<PublishItemResult> {
  const { ownerId, itemId, baseSku, ctx, item, listing, photos, policies, variations } =
    args;
  const imageUrls = toEbayImageUrls(photos.map((p) => p.public_url));
  const brand =
    typeof item.brand === "string" && item.brand.trim()
      ? item.brand.trim()
      : "Unbranded";

  // Build the varies-by specification → value-set map from the variant matrix.
  const specValues = new Map<string, Set<string>>();
  for (const spec of variations.specifications) specValues.set(spec, new Set());
  for (const v of variations.variants) {
    for (const spec of variations.specifications) {
      const val = v.aspects[spec];
      if (val) specValues.get(spec)!.add(val);
    }
  }

  // 1. Create each variant inventory item. Its aspects = the shared aspects plus
  //    this variant's variation values (eBay needs the varies-by aspect present
  //    on every member item). availability = the per-variant quantity.
  const variantSkus: string[] = [];
  for (const variant of variations.variants) {
    const vSku = variantSku(baseSku, variant);
    variantSkus.push(vSku);
    const aspects: Record<string, string[]> = { ...ctx.summary.aspects };
    for (const [name, value] of Object.entries(variant.aspects)) {
      aspects[name] = [value];
    }
    await createOrReplaceInventoryItem(ownerId, vSku, {
      product: {
        title: ctx.summary.title,
        description: ctx.summary.description,
        aspects,
        imageUrls,
        brand,
        mpn: "Does Not Apply",
      },
      condition: ctx.summary.condition,
      conditionDescription: ctx.summary.conditionDescription || undefined,
      availability: {
        shipToLocationAvailability: { quantity: variant.quantity },
      },
    });
  }

  // 2. Group the variants. variesBy declares the buyer-selectable specs; we let
  //    the photo vary by "Color" when it's one of the specs.
  const specifications = variations.specifications.map((name) => ({
    name,
    values: [...(specValues.get(name) ?? [])],
  }));
  const colorSpec = variations.specifications.find((s) => /colou?r/i.test(s));
  await createOrReplaceInventoryItemGroup(ownerId, baseSku, {
    title: ctx.summary.title,
    description: ctx.summary.description,
    imageUrls,
    aspects: ctx.summary.aspects,
    variantSKUs: variantSkus,
    variesBy: {
      specifications,
      ...(colorSpec ? { aspectsImageVariesBy: [colorSpec] } : {}),
    },
  });

  // US-568: Best Offer terms are valid for variation (fixed-price) listings.
  const bestOfferTerms: BestOfferTerms | undefined = ctx.summary.bestOfferEnabled
    ? {
        bestOfferEnabled: true,
        ...(ctx.summary.bestOfferAutoAccept
          ? {
              autoAcceptPrice: {
                value: ctx.summary.bestOfferAutoAccept,
                currency: ctx.summary.currency,
              },
            }
          : {}),
        ...(ctx.summary.bestOfferAutoDecline
          ? {
              autoDeclinePrice: {
                value: ctx.summary.bestOfferAutoDecline,
                currency: ctx.summary.currency,
              },
            }
          : {}),
      }
    : undefined;

  // 3. One offer per variant SKU (price = per-variant override, else the base
  //    price). Reuse an existing offer on retry (offer-already-exists → sync).
  for (const variant of variations.variants) {
    const vSku = variantSku(baseSku, variant);
    const value =
      variant.price_cents != null
        ? centsToMoneyString(variant.price_cents)
        : ctx.summary.priceValue;
    const offerFields = {
      availableQuantity: variant.quantity,
      categoryId: ctx.summary.categoryId,
      listingDescription: ctx.summary.description,
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId: policies.paymentPolicyId,
        returnPolicyId: policies.returnPolicyId,
        ...(bestOfferTerms ? { bestOfferTerms } : {}),
      },
      pricingSummary: { price: { value, currency: ctx.summary.currency } },
      merchantLocationKey: policies.merchantLocationKey,
    };
    try {
      await createOffer(ownerId, {
        sku: vSku,
        marketplaceId: getMarketplaceId(),
        format: "FIXED_PRICE",
        ...offerFields,
      });
    } catch (err) {
      if (!isOfferAlreadyExistsError(err)) throw err;
      const existing = await listOffersForSku(ownerId, vSku);
      const found = existing.find((o) => !!o.offerId);
      if (!found) throw err;
      await syncExistingOffer(ownerId, found.offerId, offerFields);
    }
  }

  // 4. Publish the whole group as one multi-variation listing (adopt on retry).
  const published = await publishItemGroupOrAdopt(
    ownerId,
    baseSku,
    variantSkus,
    getMarketplaceId(),
  );
  const listingId = published.listingId;
  const url = ebayListingUrl(listingId);

  // 5. Persist. Quantity is the total across variants; price is the base price.
  const totalQuantity = variations.variants.reduce(
    (sum, v) => sum + v.quantity,
    0,
  );
  const listingPayload = {
    inventory_item_id: itemId,
    platform: "ebay" as const,
    platform_listing_id: listingId,
    platform_category_id: ctx.summary.categoryId,
    listing_url: url,
    listing_price: Number(ctx.summary.priceValue),
    listing_title: ctx.summary.title,
    listing_description: ctx.summary.description,
    listing_status: "active" as const,
    is_active: true,
    quantity: totalQuantity,
    listed_at: new Date().toISOString(),
    synced_to_ebay_at: new Date().toISOString(),
    publish_error: null,
    publish_failed_at: null,
  };

  const { syncPending } = await finalizePublishedListing({
    persist: async () => {
      if (listing?.id) {
        const { error } = await supabaseAdmin
          .from("listings")
          .update(listingPayload)
          .eq("id", listing.id);
        if (error) throw new Error(`listings update: ${error.message}`);
      } else {
        const { error } = await supabaseAdmin.from("listings").insert(listingPayload);
        if (error) throw new Error(`listings insert: ${error.message}`);
      }
      const { error: itemErr } = await supabaseAdmin
        .from("inventory_items")
        .update({ status: "listed" })
        .eq("id", itemId);
      if (itemErr) throw new Error(`inventory_items update: ${itemErr.message}`);
    },
    recordReconcile: async () => {
      await supabaseAdmin.from("flipdesk_ebay_listings").upsert(
        {
          user_id: ownerId,
          ebay_item_id: listingId,
          custom_label: baseSku,
          title: ctx.summary.title,
          current_price: Number(ctx.summary.priceValue),
          listing_url: url,
          raw: {
            source: "publish_orphan_variation",
            inventory_item_id: itemId,
            group_key: baseSku,
          },
          match_status: "unmatched",
          imported_at: new Date().toISOString(),
        },
        { onConflict: "user_id,ebay_item_id" },
      );
      console.error(
        `[flipdesk-ebay] variation publish ${listingId} is LIVE but local write ` +
          `failed — recorded reconcile marker; pull-sync will adopt it`,
      );
    },
  });

  if (ctx.summary.promotedAdRate != null && ctx.summary.promotedAdRate > 0) {
    await attachPromotionAtPublish({
      userId: ownerId,
      listingRowId: listing?.id ?? null,
      ebayListingId: listingId,
      ratePct: ctx.summary.promotedAdRate,
    });
  }

  if (listing?.id) await captureListingAcceptance(listing.id);

  return {
    ok: true,
    listing_id: listingId,
    listing_url: url,
    offer_id: variantSkus[0] ?? baseSku,
    sku: baseSku,
    sync_pending: syncPending,
  };
}

flipdeskEbayRoutes.post("/listings/push", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { itemId, relist } = await readPushBody(c);
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);

  // US-382: enforce the active-listing cap server-side (was UI-only). Skip the
  // +1 when this exact item is ALREADY listed — a re-publish/revise of a live
  // listing must not be blocked or counted twice (the cap counts items in
  // status 'listed', which already includes it).
  const { data: existing } = await supabaseAdmin
    .from("inventory_items")
    .select("status")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  const alreadyListed = (existing as { status?: string } | null)?.status === "listed";
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "activeListings", delta: alreadyListed ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const result = await publishItemForOwner(userId, itemId, { relist });
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({
    ok: true,
    listing_id: result.listing_id,
    listing_url: result.listing_url,
    offer_id: result.offer_id,
    sku: result.sku,
    // US-783: true → the listing is live on eBay but the local sync is pending;
    // the UI should say "live, syncing shortly" rather than treat it as failed.
    sync_pending: result.sync_pending ?? false,
  });
});

// US-560: quantity-aware relist of a sold-out evergreen item. One call
// replenishes the listing quantity, reuses the existing eBay offer for the SKU,
// and republishes — so a seller never has to rebuild a listing from scratch.
//   • Replenish: bumps listings.quantity to the requested value (default 1,
//     floored at 1) so assemblePublishContext resolves availableQuantity > 0.
//   • Reuse the offer: publishItemForOwner({ relist: true }) ends a still-live
//     offer then re-publishes the SAME SKU offer via syncExistingOffer +
//     publishOrAdoptOffer (no duplicate offer).
//   • Never live at 0: the publish context floors quantity at 1, and we floor
//     the replenish target at 1, so a previously-sold item can't go live empty.
//   • Idempotent: publishOrAdoptOffer adopts an already-live listing and the
//     quantity write is a fixed set, so a retry converges to the same state.
flipdeskEbayRoutes.post("/listings/:id/relist", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: { quantity?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  // Respect an explicit replenish quantity; otherwise default to 1. Floor at 1
  // (non-positive / non-integer requests clamp up) so a republished
  // previously-sold item never goes live at quantity 0.
  const requested = Number(body.quantity);
  const replenishQty =
    Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);
  if (!row.listing.inventory_item_id) {
    return c.json(
      { error: "This listing is not linked to an inventory item; cannot relist." },
      409,
    );
  }
  const itemId = row.listing.inventory_item_id;

  // Enforce the active-listing cap (mirrors /listings/push). A sold-out item is
  // no longer in 'listed' status, so relisting re-occupies a slot (+1); skip the
  // increment when this exact item is somehow still counted as listed.
  const { data: existing } = await supabaseAdmin
    .from("inventory_items")
    .select("status")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  const alreadyListed = (existing as { status?: string } | null)?.status === "listed";
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "activeListings", delta: alreadyListed ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  // Replenish the quantity on the draft listing row BEFORE publishing so the
  // publish context resolves the new availableQuantity for both the inventory
  // PUT and the (reused) offer. Idempotent — a fixed set, safe under retry.
  const { error: qtyErr } = await supabaseAdmin
    .from("listings")
    .update({ quantity: replenishQty })
    .eq("id", listingId);
  if (qtyErr) {
    console.error("[flipdesk-ebay] relist: quantity replenish failed:", qtyErr);
    return c.json({ error: "Could not replenish listing quantity." }, 500);
  }

  const result = await publishItemForOwner(userId, itemId, { relist: true });
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({
    ok: true,
    listing_id: result.listing_id,
    listing_url: result.listing_url,
    offer_id: result.offer_id,
    sku: result.sku,
    quantity: replenishQty,
    sync_pending: result.sync_pending ?? false,
  });
});

// US-528: how long a publish claim is honored before it's considered stale and
// reclaimable. Must exceed the realistic worst-case publish wall-time (eBay
// latency + the bounded publishOffer retries) so a still-running publish is
// never reclaimed, while a crashed one is eventually retried.
const PUBLISH_CLAIM_STALE_MS = 10 * 60_000;

// US-407: a publish-due tick claims a SMALL, bounded batch — not the whole
// backlog — so the run reliably finishes inside the 240s job-lock lease (each
// publish makes several sequential eBay calls; 100 of them serially would blow
// past the lease, the lock would expire mid-run, and the next tick would
// overlap). Bounding the batch keeps each invocation idempotent and short; the
// cron (every 5 min) drains any larger backlog over successive ticks. Sized so
// the worst case (PUBLISH_BATCH_LIMIT × worst-case publish wall-time) stays
// comfortably under the lease. Overridable for ops tuning.
const PUBLISH_BATCH_DEFAULT = 15;
export function publishBatchLimit(): number {
  const n = Number(Deno.env.get("PUBLISH_DUE_BATCH_LIMIT"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : PUBLISH_BATCH_DEFAULT;
}

// Scheduled publishing worker (US-322). Job-secret gated (no user token) like
// /oauth/refresh — a cron hits this periodically. Publishes every draft whose
// scheduled_publish_at is due and that isn't already live, AS the listing's
// owner. Not under authMiddleware (path is /jobs/*, not /listings/*).
// US-528: each due draft is atomically CLAIMED before publishing so an
// overlapping cron tick (e.g. when a publish runs longer than the cron
// interval) can't double-publish it.
flipdeskEbayRoutes.post("/jobs/publish-due", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // US-503: coarse overlap guard so a slow 5-min tick can't race the next one.
  // (Per-row publish_claimed_at claim-lock below — US-528 — is the resource-
  // level idempotency; this just stops a wasteful overlapping scan.) 4-min lease
  // < the 5-min cadence so a crashed run frees the lock before the next tick.
  const lock = await acquireJobLock("publish-due", 240);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason, scanned: 0, published: 0 });
  }
  try {
  const now = new Date().toISOString();
  // US-528: a claim older than this is "stale" and reclaimable — covers a
  // publish whose container crashed/redeployed mid-run so the draft isn't
  // stranded. Must comfortably exceed the worst-case publish wall-time.
  const staleBefore = new Date(Date.now() - PUBLISH_CLAIM_STALE_MS).toISOString();
  // US-407: bound the scan to a small batch so the tick finishes within the
  // lock lease; the cron drains any larger backlog over successive ticks. We
  // fetch one extra row to cheaply detect whether more work remains.
  const batchLimit = publishBatchLimit();
  // Due = scheduled at/before now, not yet synced live, still a draft, and not
  // currently claimed by an in-flight tick. The lte filter already excludes
  // NULL scheduled_publish_at rows.
  const { data: dueRows, error } = await supabaseAdmin
    .from("listings")
    .select("id, inventory_item_id")
    .lte("scheduled_publish_at", now)
    .is("synced_to_ebay_at", null)
    .eq("listing_status", "draft")
    .or(`publish_claimed_at.is.null,publish_claimed_at.lt.${staleBefore}`)
    .order("scheduled_publish_at", { ascending: true })
    .limit(batchLimit + 1);
  if (error) {
    console.error("[flipdesk-ebay] publish-due scan failed:", error);
    return c.json({ error: "Scan failed" }, 500);
  }

  const allDue = (dueRows ?? []) as { id: string; inventory_item_id: string }[];
  // US-407: we asked for batchLimit+1; a full extra row means the backlog
  // exceeds one tick. Process only batchLimit this invocation; the next cron
  // tick picks up the rest. `more` lets ops/monitoring see the backlog draining.
  const more = allDue.length > batchLimit;
  const due = allDue.slice(0, batchLimit);
  if (due.length === 0) {
    return c.json({ scanned: 0, published: 0, failed: 0, skipped: 0, more: false });
  }

  // Resolve each item's owner (the publish must run as them).
  const itemIds = Array.from(new Set(due.map((d) => d.inventory_item_id)));
  const { data: itemRows } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id")
    .in("id", itemIds);
  const ownerByItem = new Map(
    ((itemRows ?? []) as { id: string; user_id: string }[]).map((r) => [r.id, r.user_id]),
  );

  let published = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of due) {
    const owner = ownerByItem.get(row.inventory_item_id);
    if (!owner) {
      failed += 1;
      continue;
    }

    // US-528: atomically claim the draft before publishing so a concurrent (or
    // next-tick) cron run can't publish the same row while this publish is
    // still in flight. Only the tick that wins this conditional update — which
    // re-checks the same eligibility predicate under a row lock — proceeds; the
    // claim flips publish_claimed_at to a FRESH timestamp (not the scan-time
    // `now`, which can be many minutes old on a long batch), so the claim is
    // honored for the full stale window from the moment it is taken.
    const claimedAt = new Date().toISOString();
    const { data: claimed } = await supabaseAdmin
      .from("listings")
      .update({ publish_claimed_at: claimedAt })
      .eq("id", row.id)
      .eq("listing_status", "draft")
      .is("synced_to_ebay_at", null)
      .or(`publish_claimed_at.is.null,publish_claimed_at.lt.${staleBefore}`)
      .select("id")
      .maybeSingle();
    if (!claimed) {
      skipped += 1;
      continue;
    }

    try {
      const result = await publishItemForOwner(owner, row.inventory_item_id);
      if (result.ok) {
        published += 1;
      } else {
        failed += 1;
        const b = result.body;
        const msg = (b.detail ?? b.error ??
          (Array.isArray(b.blockers) ? (b.blockers as string[]).join("; ") : "Publish failed")) as string;
        await supabaseAdmin
          .from("listings")
          .update({ publish_error: msg.slice(0, 1000), publish_failed_at: now })
          .eq("id", row.id);
      }
    } catch (err) {
      failed += 1;
      await supabaseAdmin
        .from("listings")
        .update({
          publish_error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          publish_failed_at: now,
        })
        .eq("id", row.id);
    }
  }

  return c.json({ scanned: due.length, published, failed, skipped, more });
  } finally {
    await lock.release();
  }
});

// US-561: scheduled refresh of Promoted Listings ad status + bid. Walks every
// owner that has at least one live ad and syncs their promoted listings from the
// Marketing API, so the seller's post-publish "Promoted" surface reflects the
// current eBay adStatus. Job-secret gated (path is /jobs/*, not /listings/*).
flipdeskEbayRoutes.post("/jobs/promoted-sync", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("promoted-sync", 240);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason, owners: 0 });
  }
  try {
    // Distinct owners with at least one live ad. The partial index
    // idx_listings_promo_active keeps this scan cheap.
    const { data: rows, error } = await supabaseAdmin
      .from("listings")
      .select("user_id")
      .eq("platform", "ebay")
      .not("promo_ad_id", "is", null)
      .limit(5000);
    if (error) {
      console.error("[flipdesk-ebay] promoted-sync owner scan failed:", error);
      return c.json({ error: "Scan failed" }, 500);
    }
    const owners = Array.from(
      new Set(((rows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
    );
    let scanned = 0;
    let updated = 0;
    for (const owner of owners) {
      try {
        const res = await syncPromotedListingsForOwner(owner);
        scanned += res.scanned;
        updated += res.updated;
      } catch (err) {
        console.warn(
          `[flipdesk-ebay] promoted-sync for owner ${owner} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return c.json({ owners: owners.length, scanned, updated });
  } finally {
    await lock.release();
  }
});

// Imports an eBay Seller Hub "Payouts" CSV into payout_imports. Server-side
// parse so we can validate, dedupe, and reuse the parser for future webhook
// ingestion. Idempotent — repeated uploads of the same export skip rows that
// already match (payout_id + amount + date) for this user.
//
// Body: { csv: string }  Response: { imported, skipped, duplicates }
flipdeskEbayRoutes.post("/payouts/import-csv", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { csv?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.csv !== "string" || body.csv.trim().length === 0) {
    return c.json({ error: "csv (string) is required" }, 400);
  }
  // Soft cap — eBay payouts exports rarely exceed a few hundred KB.
  if (body.csv.length > 5 * 1024 * 1024) {
    return c.json({ error: "CSV exceeds 5MB limit" }, 413);
  }

  const { headerFound, payouts, skipped } = parseEbayPayoutsCsv(body.csv);
  if (!headerFound) {
    return c.json(
      {
        error:
          "Could not find a payouts table in this CSV. Export the report from Seller Hub → Payments → Payouts → Download.",
      },
      400,
    );
  }
  if (payouts.length === 0) {
    return c.json({ imported: 0, skipped, duplicates: 0 });
  }

  try {
    const { inserted, duplicates } = await ingestPayoutsForUser(
      userId,
      payouts,
      "csv_upload",
    );
    return c.json({ imported: inserted, skipped, duplicates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] payouts import failed:", msg);
    return c.json({ error: "Failed to write payouts.", detail: msg }, 502);
  }
});

// Live active-listing comps for the composer's pricing panel. Uses the
// Browse API + app token (no seller OAuth needed). Sold-price comps via
// Marketplace Insights API land in a follow-up once eBay approves the
// app — this endpoint covers the active comps until then.
flipdeskEbayRoutes.get("/comps", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const categoryId = c.req.query("category_id")?.trim();
  if (!categoryId) {
    return c.json({ error: "category_id is required" }, 400);
  }
  const q = c.req.query("q") ?? undefined;
  const brand = c.req.query("brand") ?? undefined;
  const size = c.req.query("size") ?? undefined;
  const conditionId = c.req.query("condition_id") ?? undefined;
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  try {
    const result = await searchBrowseComps({
      categoryId,
      q,
      brand,
      size,
      conditionId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return c.json(result);
  } catch (err) {
    console.error("[flipdesk-ebay] comps search failed:", err);
    return c.json({ error: "Comps search failed" }, 502);
  }
});

// ── US-673: Best offers + send-offer + buyer messages ───────────────
//
// All of these operate against the caller's OWN eBay account: the token is
// resolved from the workspace owner's connection (getUserAccessToken), so a
// caller can only ever read/respond to offers + messages on their own listings.
// No cross-tenant id is accepted from the body for reads, and respond/reply act
// against the caller's eBay account — there is no way to target another tenant.

// GET /negotiation/offers — incoming best offers across the seller's listings.
flipdeskEbayRoutes.get("/negotiation/offers", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const offers = await getBestOffers(userId);
    return c.json({ offers });
  } catch (err) {
    console.error("[flipdesk-ebay] getBestOffers failed:", err);
    return c.json({ error: "Couldn't load best offers from eBay." }, 502);
  }
});

// POST /negotiation/offers/:bestOfferId/respond — accept / decline / counter.
// Body: { item_id, action, counter_price?, counter_quantity?, message? }
flipdeskEbayRoutes.post("/negotiation/offers/:bestOfferId/respond", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const bestOfferId = c.req.param("bestOfferId");
  let body: {
    item_id?: unknown;
    action?: unknown;
    counter_price?: unknown;
    counter_quantity?: unknown;
    message?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const action = body.action as BestOfferAction;
  if (!itemId) return c.json({ error: "item_id is required" }, 400);
  if (action !== "Accept" && action !== "Decline" && action !== "Counter") {
    return c.json({ error: "action must be Accept, Decline, or Counter" }, 400);
  }
  let counterPrice: number | undefined;
  if (action === "Counter") {
    counterPrice = Number(body.counter_price);
    if (!Number.isFinite(counterPrice) || (counterPrice ?? 0) <= 0) {
      return c.json({ error: "counter_price must be a positive number" }, 400);
    }
  }
  try {
    await respondToBestOffer(userId, {
      itemId,
      bestOfferId,
      action,
      counterPrice,
      counterQuantity: Number.isFinite(Number(body.counter_quantity))
        ? Number(body.counter_quantity)
        : undefined,
      sellerMessage: typeof body.message === "string" ? body.message : undefined,
    });
    return c.json({ ok: true, best_offer_id: bestOfferId, action });
  } catch (err) {
    console.error("[flipdesk-ebay] respondToBestOffer failed:", err);
    return c.json({ error: "eBay rejected the best-offer response.", detail: String(err) }, 502);
  }
});

// GET /negotiation/eligible — listings eligible for a send-offer-to-buyers.
flipdeskEbayRoutes.get("/negotiation/eligible", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const items = await findEligibleNegotiationItems(userId);
    return c.json({ items });
  } catch (err) {
    console.error("[flipdesk-ebay] findEligibleNegotiationItems failed:", err);
    return c.json({ error: "Couldn't load eligible listings from eBay." }, 502);
  }
});

// POST /negotiation/send-offer — send a discount offer to interested buyers.
// Body: { listing_ids: string[], discount_percentage?: string, message? }
flipdeskEbayRoutes.post("/negotiation/send-offer", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { listing_ids?: unknown; discount_percentage?: unknown; message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const listingIds = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === "string")
    : [];
  if (listingIds.length === 0) {
    return c.json({ error: "listing_ids must be a non-empty array" }, 400);
  }
  try {
    await sendOfferToInterestedBuyers(userId, {
      listingIds,
      discountPercentage:
        typeof body.discount_percentage === "string" ? body.discount_percentage : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
    });
    return c.json({ ok: true, count: listingIds.length });
  } catch (err) {
    console.error("[flipdesk-ebay] sendOfferToInterestedBuyers failed:", err);
    return c.json({ error: "eBay rejected the offer.", detail: String(err) }, 502);
  }
});

// GET /messages — buyer member-message inbox (last 30 days).
flipdeskEbayRoutes.get("/messages", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const messages = await getMemberMessages(userId);
    return c.json({ messages });
  } catch (err) {
    console.error("[flipdesk-ebay] getMemberMessages failed:", err);
    return c.json({ error: "Couldn't load messages from eBay." }, 502);
  }
});

// POST /messages/:messageId/reply — reply to a buyer message.
// Body: { item_id, recipient_id, body }
flipdeskEbayRoutes.post("/messages/:messageId/reply", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const messageId = c.req.param("messageId");
  let body: { item_id?: unknown; recipient_id?: unknown; body?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const recipientId = typeof body.recipient_id === "string" ? body.recipient_id : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!itemId || !recipientId || !text) {
    return c.json({ error: "item_id, recipient_id, and body are required" }, 400);
  }
  try {
    await replyToMemberMessage(userId, {
      itemId,
      parentMessageId: messageId,
      recipientId,
      body: text,
    });
    return c.json({ ok: true, message_id: messageId });
  } catch (err) {
    console.error("[flipdesk-ebay] replyToMemberMessage failed:", err);
    return c.json({ error: "eBay rejected the reply.", detail: String(err) }, 502);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

// Random URL-safe state token for CSRF + replay protection.
function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}


// ── Manage helpers ─────────────────────────────────────────────────

interface ListingRowForManage {
  id: string;
  inventory_item_id: string;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  // The values that were actually published. A photos-only revise re-PUTs the
  // inventory_item, so we need the live title/description as the basis to
  // avoid silently reverting them to the inventory_items mirror.
  listing_title: string | null;
  listing_description: string | null;
}

type LoadListingResult =
  | { ok: true; listing: ListingRowForManage }
  | { ok: false; error: { error: string }; status: 404 | 403 };

// Loads a local listings row by id and verifies the user owns the parent
// inventory_item (the listings table doesn't have a user_id column).
async function loadListingOwned(
  listingId: string,
  userId: string
): Promise<LoadListingResult> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform_offer_id, platform_listing_id, listing_title, listing_description, inventory_items!inner(user_id)"
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!data) {
    return { ok: false, error: { error: "Listing not found" }, status: 404 };
  }
  const row = data as unknown as ListingRowForManage & {
    inventory_items: { user_id: string };
  };
  if (row.inventory_items.user_id !== userId) {
    return { ok: false, error: { error: "Listing not found" }, status: 404 };
  }
  return {
    ok: true,
    listing: {
      id: row.id,
      inventory_item_id: row.inventory_item_id,
      platform_offer_id: row.platform_offer_id,
      platform_listing_id: row.platform_listing_id,
      listing_title: row.listing_title,
      listing_description: row.listing_description,
    },
  };
}

// ── Publish-flow helpers ───────────────────────────────────────────

async function readItemId(
  c: Context<EbayEnv>
): Promise<string | null> {
  try {
    const body = (await c.req.json()) as { inventory_item_id?: unknown };
    return typeof body.inventory_item_id === "string"
      ? body.inventory_item_id
      : null;
  } catch {
    return null;
  }
}

// Push body reader that also surfaces the optional `relist` flag. The body can
// only be consumed once, so callers that need both fields use this instead of
// readItemId().
async function readPushBody(
  c: Context<EbayEnv>
): Promise<{ itemId: string | null; relist: boolean }> {
  try {
    const body = (await c.req.json()) as {
      inventory_item_id?: unknown;
      relist?: unknown;
    };
    return {
      itemId:
        typeof body.inventory_item_id === "string"
          ? body.inventory_item_id
          : null,
      relist: body.relist === true,
    };
  } catch {
    return { itemId: null, relist: false };
  }
}

interface PublishPhoto {
  id: string;
  public_url: string;
  sort_order: number;
}

interface PublishItem {
  id: string;
  user_id: string;
  title: string | null;
  brand: string | null;
  sku: string | null;
  size: string | null;
  description: string | null;
  condition_notes: string | null;
  target_price: number | null;
  grade_value: number | null;
  grade_label: string | null;
  // Public certificate URL, populated when a FlipDesk item is graded
  // (grading-pipeline.ts). Drives the grade-badge + cert-link promotion.
  certificate_url: string | null;
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  // US-825: per-aspect provenance parallel to ebay_aspects.
  ebay_aspect_sources: AspectSourceMap | null;
  item_category: string | null;
  color: string | null;
  material: string | null;
  style: string | null;
  // US-821 canonical attributes (jsonb). US-822 maps these onto eBay aspects.
  attributes: Record<string, string | string[]> | null;
  status: string;
}

// US-568: multi-variant matrix persisted in listings.variations (migration
// 00160). Mirrors src/types/database.ts ListingVariation(s).
interface ListingVariation {
  aspects: Record<string, string>;
  quantity: number;
  price_cents?: number | null;
  sku_suffix?: string | null;
}
interface ListingVariations {
  specifications: string[];
  variants: ListingVariation[];
}

// US-568: defensively coerce the persisted JSON into a usable variation matrix.
// Returns null when there is nothing publishable (no specs, fewer than 2
// variants, or every variant out of stock) so the publish path stays on the
// single-SKU flow. Drops malformed variants rather than failing the publish.
export function normalizeVariations(
  raw: ListingVariations | null | undefined,
): ListingVariations | null {
  if (!raw || typeof raw !== "object") return null;
  const specs = Array.isArray(raw.specifications)
    ? raw.specifications
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim())
    : [];
  if (specs.length === 0) return null;
  const variants = Array.isArray(raw.variants)
    ? raw.variants
      .map((v): ListingVariation | null => {
        if (!v || typeof v !== "object" || !v.aspects) return null;
        const aspects: Record<string, string> = {};
        for (const spec of specs) {
          const val = v.aspects[spec];
          if (typeof val === "string" && val.trim() !== "") {
            aspects[spec] = val.trim();
          }
        }
        // Every varies-by spec must have a value for this combination.
        if (Object.keys(aspects).length !== specs.length) return null;
        const quantity =
          typeof v.quantity === "number" && v.quantity > 0
            ? Math.floor(v.quantity)
            : 0;
        return {
          aspects,
          quantity,
          price_cents:
            typeof v.price_cents === "number" && v.price_cents > 0
              ? v.price_cents
              : null,
          sku_suffix:
            typeof v.sku_suffix === "string" && v.sku_suffix.trim() !== ""
              ? v.sku_suffix.trim()
              : null,
        };
      })
      .filter((v): v is ListingVariation => v !== null && v.quantity > 0)
    : [];
  // A "variation" listing needs at least two purchasable combinations.
  if (variants.length < 2) return null;
  return { specifications: specs, variants };
}

// US-568: derive a stable, eBay-safe SKU for one variant from the base SKU. Uses
// the explicit suffix when present, else a slug of the variation values.
export function variantSku(baseSku: string, variant: ListingVariation): string {
  const suffix =
    variant.sku_suffix ??
    Object.values(variant.aspects)
      .join("-")
      .replace(/[^a-zA-Z0-9-]+/g, "")
      .toUpperCase();
  return `${baseSku}-${suffix || "V"}`.slice(0, 50);
}

interface PublishListing {
  id: string;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  // US-319/320/321: edits made in the composer/bulk editor must reach eBay.
  // These mirror the columns added in 00052_autolister_schema.sql.
  ebay_condition: string | null;
  ebay_condition_description: string | null;
  quantity: number | null;
  best_offer_enabled: boolean | null;
  // US-562: per-listing best-offer auto-clear thresholds (cents). Null falls
  // back to the comp-derived default (p75 → accept, p25 → decline).
  best_offer_auto_accept_cents: number | null;
  best_offer_auto_decline_cents: number | null;
  // US-542 comp range used to derive best-offer thresholds when no override.
  price_range_low_cents: number | null;
  price_range_high_cents: number | null;
  platform_category_id: string | null;
  item_specifics_override: Record<string, string[]> | null;
  // US-825: per-aspect provenance parallel to item_specifics_override.
  item_specifics_sources: AspectSourceMap | null;
  scheduled_publish_at: string | null;
  // Per-listing opt-in for the grade-badge + cert-link promotion (00027).
  badge_enabled: boolean | null;
  // US-766: per-listing Digital-Slab image mode (00180). 'off' | 'hero' |
  // 'extra' — include the QR-bearing slab as the lead or a supplementary
  // listing image. null/'off' falls back to the user's global default.
  slab_image_mode: string | null;
  // US-555: per-listing eBay business-policy overrides (bulk-assigned in the
  // AutoLister grid). When set they win over the account-level defaults at
  // publish; null falls back to the seller's default policy set. Column names
  // mirror listings.{shipping,payment,return}_policy_id (00052).
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  // US-561: Promoted Listings — promo_rate_pct is the seller's accepted/adjusted
  // ad rate (null → use the category suggestion); promo_opt_out turns promotion
  // off for this listing entirely.
  promo_rate_pct: number | null;
  promo_opt_out: boolean | null;
  // US-568: format + auction terms + variation matrix (migration 00160).
  listing_format: string | null;
  auction_start_price_cents: number | null;
  auction_reserve_price_cents: number | null;
  auction_buy_it_now_price_cents: number | null;
  auction_duration: string | null;
  variations: ListingVariations | null;
}

interface PublishContextOk {
  ok: true;
  item: PublishItem;
  listing: PublishListing | null;
  photos: PublishPhoto[];
  // null when blockers includes a missing-policy entry. Push must re-check.
  policies: PolicySet | null;
  blockers: string[];
  // US-828: aspect values omitted from the eBay payload for value-validation
  // reasons, so the client can surface "X was not sent" (empty = nothing dropped).
  aspectDiagnostics: PublishAspectDiagnostic[];
  sku: string;
  summary: {
    title: string;
    description: string;
    priceValue: string; // eBay wants string-typed money
    currency: string;
    condition: string;
    conditionDescription: string;
    categoryId: string;
    aspects: Record<string, string[]>;
    quantity: number;
    bestOfferEnabled: boolean;
    // US-562: best-offer auto-clear thresholds as eBay money strings, already
    // clamped to eBay's constraints (decline < accept < price). Null when no
    // valid threshold applies — Best Offer is still enabled, just unbounded.
    bestOfferAutoAccept: string | null;
    bestOfferAutoDecline: string | null;
    // US-561: effective Promoted Listings ad rate (%) to attach at publish, or
    // null when the seller opted out. Defaults to the category suggestion.
    promotedAdRate: number | null;
    // US-568: listing format + auction terms (money as eBay strings) + the
    // variation matrix. format is "FIXED_PRICE" (default) or "AUCTION"; the
    // auction* values are only meaningful for AUCTION. variations is null for a
    // single-SKU listing.
    format: "FIXED_PRICE" | "AUCTION";
    auctionStartPrice: string | null;
    auctionReservePrice: string | null;
    auctionBuyItNowPrice: string | null;
    auctionDuration: string;
    variations: ListingVariations | null;
  };
}

interface PublishContextErr {
  ok: false;
  error: { error: string };
  status: 400 | 404 | 500 | 503;
}

type PublishContext = PublishContextOk | PublishContextErr;

// eBay getCategoryAspects raw aspect shape (subset we read).
interface AspectSpecRaw {
  localizedAspectName?: string;
  aspectConstraint?: {
    aspectRequired?: boolean;
    aspectMode?: string;
    itemToAspectCardinality?: string; // "SINGLE" | "MULTI"
  };
  aspectValues?: Array<{ localizedValue?: string }>;
}

// Map an item's canonical fields (legacy columns + US-821 attributes) onto a
// category's aspects so we can fill required specifics without an AI pass.
// US-822: this is now a thin adapter over the single-source ASPECT_REGISTRY —
// it normalizes eBay's raw aspect shape into the registry's RegistryAspect and
// delegates the field→aspect mapping + SELECTION_ONLY validation to
// resolveItemAspects. Returns only aspects NOT already in `existing`; user-set
// values are never overwritten.
function deriveAspectsFromItem(
  item: PublishItem,
  aspectList: AspectSpecRaw[],
  existing: Record<string, string[]>,
): Record<string, string[]> {
  const aspects: RegistryAspect[] = aspectList.map((a) => ({
    name: a.localizedAspectName ?? "",
    mode: a.aspectConstraint?.aspectMode,
    multi: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
    allowedValues: (a.aspectValues ?? [])
      .map((v) => v.localizedValue ?? "")
      .filter((v) => v.length > 0),
  }));
  return resolveItemAspects(item, aspects, existing);
}

// Per-user GLOBAL default for the grade-badge + cert-link promotion (00145).
// Absent settings row ⇒ false.
async function autoGradeBadgeDefault(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("flipdesk_settings")
    .select("auto_grade_badge")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { auto_grade_badge: boolean } | null)?.auto_grade_badge === true;
}

// Phrasing kept in sync with the client template (src/lib/listing-templates.ts
// gradeBlock) so a template-built description and a forced append read alike.
const CERT_LINK_PREFIX = "View the full condition certificate:";

// A storage object is an already-badged derivative if it lives under a /badge/
// folder (this function) or carries the legacy composer "badged_" filename.
function isBadgedUrl(url: string): boolean {
  return url.includes("/badge/") || url.includes("badged_");
}

// Renders (or reuses a cached) badged copy of the hero photo in the public
// item-photos bucket and returns its public URL. The path is deterministic in
// (item, hero photo, grade) so relists/re-publishes reuse the same object
// instead of re-compositing. Returns null on any failure so the caller falls
// back to the original hero — a badge problem must never block a publish.
async function ensureBadgedHero(
  userId: string,
  item: PublishItem,
  hero: PublishPhoto,
): Promise<string | null> {
  const grade = item.grade_value;
  if (grade == null) return null;

  const bucket = supabaseAdmin.storage.from("item-photos");
  const safeGrade = grade.toFixed(1).replace(".", "_");
  const path = `${userId}/${item.id}/badge/${hero.id}_${safeGrade}.jpg`;
  const badgedUrl = bucket.getPublicUrl(path).data.publicUrl;

  // Cache hit: a prior publish already rendered this exact badge.
  const head = await fetchWithTimeout(badgedUrl, { method: "HEAD" }, 5_000)
    .catch(() => null);
  if (head?.ok) return badgedUrl;

  const res = await fetchWithTimeout(hero.public_url, {}, 15_000);
  if (!res.ok) {
    console.warn(`[flipdesk-ebay] grade-badge: hero fetch ${res.status}`);
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const badged = await compositeGradeBadge(bytes, grade, item.grade_label);

  const { error } = await bucket.upload(path, badged, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) {
    console.error("[flipdesk-ebay] grade-badge upload:", error.message);
    return null;
  }
  return badgedUrl;
}

// When the grade-badge promotion is active for this publish, (1) burn the badge
// onto the hero photo (mutates photos[0].public_url) and (2) force the cert link
// into the description. Effective toggle = per-listing badge_enabled OR the
// user's global default. Gated on a graded item that has a certificate URL.
// Returns the (possibly updated) description.
async function applyGradeBadgePromotion(
  userId: string,
  item: PublishItem,
  listing: PublishListing | null,
  photos: PublishPhoto[],
  description: string,
): Promise<string> {
  const enabled =
    listing?.badge_enabled === true || (await autoGradeBadgeDefault(userId));
  if (!enabled || item.grade_value == null || !item.certificate_url) {
    return description;
  }

  // (1) Always append the certificate link if it isn't already in the copy.
  let next = description;
  if (!next.includes(item.certificate_url)) {
    const line = `${CERT_LINK_PREFIX} ${item.certificate_url}`;
    next = next.trim() ? `${next.trim()}\n\n${line}` : line;
  }

  // (2) Burn the hero (first by sort_order). Skip an already-badged image.
  const hero = photos[0];
  if (hero?.public_url && !isBadgedUrl(hero.public_url)) {
    try {
      const badged = await ensureBadgedHero(userId, item, hero);
      if (badged) hero.public_url = badged;
    } catch (err) {
      console.error(
        "[flipdesk-ebay] grade-badge burn failed (non-blocking):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return next;
}

// US-766: Digital-Slab listing image. The slab is the QR-bearing "graded photo"
// rendered at /slab/cert/:id (functions/slab/cert/[id].ts, US-763) from the
// PUBLIC certificate — so reusing it here costs no extra compositing and never
// touches private data. We request ?format=square because eBay galleries are
// square. Returns null when the item has no public certificate (slab would
// 404 to the transparent fallback).
function slabImageUrlForItem(item: PublishItem): string | null {
  const cert = item.certificate_url?.trim();
  if (!cert) return null;
  // certificate_url is "<site>/cert/<id>" (indexnow.ts certificateUrl). The
  // slab lives at the sibling "<site>/slab/cert/<id>". Rewrite the first
  // "/cert/" segment so we never hard-code the site origin here.
  if (!cert.includes("/cert/")) return null;
  const base = cert.replace("/cert/", "/slab/cert/");
  return `${base}${base.includes("?") ? "&" : "?"}format=square`;
}

// A storage/render URL is the slab if it lives under the /slab/cert/ path —
// used to avoid attaching it twice across relists/re-publishes.
function isSlabUrl(url: string): boolean {
  return url.includes("/slab/cert/");
}

// Per-user GLOBAL default for attaching the Digital Slab as a supplementary
// listing image (00180). Absent settings row ⇒ false.
async function autoSlabImageDefault(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("flipdesk_settings")
    .select("auto_slab_image")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { auto_slab_image: boolean } | null)?.auto_slab_image === true;
}

// US-766: when slab attachment is active, inject the slab image into `photos`
// (in place, so it flows to BOTH the single-SKU and variation publish paths)
// as the lead ('hero', index 0) or a supplementary ('extra', appended) picture.
// Effective mode = per-listing slab_image_mode when 'hero'/'extra'; otherwise
// the global default contributes 'extra'. Gated on a graded item with a public
// certificate. Best-effort: any miss leaves the original photos untouched —
// the slab must never block a publish. Runs AFTER the grade-badge burn so the
// badge lands on the real hero, not the slab.
async function applySlabImagePromotion(
  userId: string,
  item: PublishItem,
  listing: PublishListing | null,
  photos: PublishPhoto[],
): Promise<void> {
  const listingMode = listing?.slab_image_mode;
  let mode: "off" | "hero" | "extra" =
    listingMode === "hero" || listingMode === "extra" ? listingMode : "off";
  if (mode === "off" && (await autoSlabImageDefault(userId))) {
    mode = "extra";
  }
  if (mode === "off" || item.grade_value == null) return;

  const slabUrl = slabImageUrlForItem(item);
  if (!slabUrl) return;

  // Idempotent across relists: never attach the slab twice.
  if (photos.some((p) => p.public_url && isSlabUrl(p.public_url))) return;

  const slabPhoto: PublishPhoto = {
    id: `slab-${item.id}`,
    public_url: slabUrl,
    // Sort below the real photos for 'extra'; ahead of them for 'hero'.
    sort_order: mode === "hero" ? -1 : Number.MAX_SAFE_INTEGER,
  };
  if (mode === "hero") {
    photos.unshift(slabPhoto);
  } else {
    photos.push(slabPhoto);
  }
}

async function assemblePublishContext(
  userId: string,
  itemId: string
): Promise<PublishContext> {
  if (!isEbayConfigured()) {
    return {
      ok: false,
      error: { error: "eBay is not configured on this server." },
      status: 503,
    };
  }

  // Verify connection up front so getDefaultPolicies + push share a fail-fast.
  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: publish through the selected (primary) connection.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) {
    return {
      ok: false,
      error: { error: "Connect your eBay account first." },
      status: 400,
    };
  }

  // NOTE: list_price is NOT a real column on inventory_items — it only exists
  // as a derived alias inside the items_full view (l.listing_price AS list_price).
  // Including it here triggers PostgreSQL 42703 (undefined column) and PostgREST
  // returns data:null, which the caller used to mis-report as "Item not found".
  // The publish-time price priority is now listing.listing_price → target_price.
  const { data: itemRow, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, sku, size, description, condition_notes, target_price, grade_value, grade_label, certificate_url, ebay_category_id, ebay_aspects, ebay_aspect_sources, item_category, color, material, style, attributes, status"
    )
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr) {
    // PostgREST silently returns data: null when the SELECT column list is
    // invalid (missing column, etc.) — without this log we'd mis-diagnose
    // the failure as "row not found". The most common cause is a column
    // referenced in the select that hasn't been migrated yet.
    console.error(
      `[flipdesk-ebay] publish lookup: inventory_items query errored for ${itemId} ` +
        `— code=${itemErr.code} message=${itemErr.message} details=${itemErr.details ?? ""} hint=${itemErr.hint ?? ""}`,
    );
    return { ok: false, error: { error: "Item lookup failed" }, status: 500 };
  }
  if (!itemRow) {
    console.warn(
      `[flipdesk-ebay] publish lookup: inventory_items row ${itemId} does not exist (caller userId=${userId})`,
    );
    return { ok: false, error: { error: "Item not found" }, status: 404 };
  }
  if ((itemRow as PublishItem).user_id !== userId) {
    console.warn(
      `[flipdesk-ebay] publish lookup: ownership mismatch for item ${itemId} ` +
        `— row user_id=${(itemRow as PublishItem).user_id}, caller userId=${userId}`,
    );
    return { ok: false, error: { error: "Item not found" }, status: 404 };
  }
  const item = itemRow as PublishItem;

  // Most recent eBay-platform listing draft for this item (if any).
  // Pull the AutoLister-edited columns too — composer/bulk-edit writes here
  // and these must reach eBay at publish (US-319/320/321).
  const { data: listingRow } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, listing_description, listing_price, ebay_condition, ebay_condition_description, quantity, best_offer_enabled, best_offer_auto_accept_cents, best_offer_auto_decline_cents, price_range_low_cents, price_range_high_cents, platform_category_id, item_specifics_override, item_specifics_sources, scheduled_publish_at, badge_enabled, slab_image_mode, shipping_policy_id, payment_policy_id, return_policy_id, promo_rate_pct, promo_opt_out, listing_format, auction_start_price_cents, auction_reserve_price_cents, auction_buy_it_now_price_cents, auction_duration, variations",
    )
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const listing = (listingRow as PublishListing | null) ?? null;

  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("id, storage_path, photo_url, sort_order")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });

  const photos: PublishPhoto[] = ((photoRows ?? []) as Array<{
    id: string;
    storage_path: string | null;
    photo_url: string | null;
    sort_order: number;
  }>).map((p) => {
    // Prefer the stored public URL if present (it's set at upload time);
    // fall back to computing one from the storage_path.
    let url = p.photo_url ?? null;
    if (!url && p.storage_path) {
      url = supabaseAdmin.storage
        .from("item-photos")
        .getPublicUrl(p.storage_path).data.publicUrl;
    }
    return {
      id: p.id,
      public_url: url ?? "",
      sort_order: p.sort_order,
    };
  });

  const blockers: string[] = [];
  // Category resolution: listing-row override wins (AutoLister writes here);
  // fall back to inventory_items for legacy / single-item composer flows.
  let categoryId = listing?.platform_category_id ?? item.ebay_category_id ?? null;
  // Auto-resolve a real eBay leaf category when the item never got one. Items
  // created via the single-item composer / manual catalog skip AutoLister's
  // suggestCategories step (ai-listing.ts), so categoryId is null even though
  // the item has a brand/title. Our internal item_category enum is NOT an eBay
  // category, so we resolve against the Taxonomy API from the strongest free
  // text we have and persist the result so this lookup only runs once.
  if (!categoryId) {
    const query = [item.brand, item.title, item.item_category]
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0)
      .join(" ")
      .trim();
    if (query) {
      try {
        const suggestions = await suggestCategories(query);
        if (suggestions.length > 0) {
          categoryId = suggestions[0]!.categoryId;
          // Persist so subsequent publishes (and the composer) reuse it.
          // Prefer the listing row when one exists; always mirror onto the
          // item so legacy/no-listing flows pick it up too.
          if (listing?.id) {
            await supabaseAdmin
              .from("listings")
              .update({ platform_category_id: categoryId })
              .eq("id", listing.id);
          }
          await supabaseAdmin
            .from("inventory_items")
            .update({ ebay_category_id: categoryId })
            .eq("id", itemId);
        }
      } catch (err) {
        console.error("[flipdesk-ebay] publish category auto-resolve:", err);
      }
    }
  }
  if (!categoryId) blockers.push("Pick an eBay category.");
  // Aspect map: prefer item_specifics_override (the AutoLister-edited copy);
  // fall back to the inventory mirror. The inventory mirror feeds legacy flows.
  const aspectMap: Record<string, string[]> =
    listing?.item_specifics_override ??
    (item.ebay_aspects as Record<string, string[]> | null) ??
    {};
  let requiredMissing: string[] = [];
  // US-828: aspects the publish path declined to send for VALUE-validation
  // reasons (a SELECTION_ONLY value not in eBay's allowed set, even after the
  // US-823 normalizer). Surfaced in the publish/validate response so the client
  // can say "X was not sent" instead of the value vanishing silently.
  let aspectDiagnostics: PublishAspectDiagnostic[] = [];
  // The map actually sent to eBay — `aspectMap` minus value-validation omissions
  // (with near-misses normalized). Kept separate from the PERSISTED aspectMap so
  // the draft retains the seller's flagged values for them to fix (US-828 keeps
  // unmatched values visible rather than dropping them at generation).
  let sanitizedAspects: Record<string, string[]> = aspectMap;
  if (categoryId) {
    try {
      const aspectsResp = await getCategoryAspects(categoryId);
      const raw = (aspectsResp.aspects as Record<string, unknown>).aspects;
      const list = Array.isArray(raw) ? (raw as AspectSpecRaw[]) : [];

      // Auto-fill specifics from the item's structured columns so manually
      // cataloged items (which never ran AutoLister's AI aspect pass) don't
      // block publish on Brand/Size/Color/etc. that we already know. Only
      // fills aspects not already present; SELECTION_ONLY aspects are filled
      // only when the column value matches one of eBay's allowed values.
      const derived = deriveAspectsFromItem(item, list, aspectMap);
      if (Object.keys(derived).length > 0) {
        Object.assign(aspectMap, derived);
        // US-825: record provenance for what we just auto-filled
        // (inventory_derived), merged onto whatever sources already existed so
        // an AI- or user-attributed aspect is never downgraded.
        const priorSources =
          (listing?.id
            ? listing.item_specifics_sources
            : item.ebay_aspect_sources) ?? {};
        const sources = mergeSources(
          priorSources,
          sourcesFor(Object.keys(derived), "inventory_derived"),
          aspectMap,
        );
        // Persist so the offer payload AND the composer's specifics editor
        // reflect what we filled. item_specifics_override is the listing-level
        // canonical copy; mirror to the item when there's no listing row yet.
        if (listing?.id) {
          await supabaseAdmin
            .from("listings")
            .update({
              item_specifics_override: aspectMap,
              item_specifics_sources: sources,
            })
            .eq("id", listing.id);
        } else {
          await supabaseAdmin
            .from("inventory_items")
            .update({ ebay_aspects: aspectMap, ebay_aspect_sources: sources })
            .eq("id", itemId);
        }
      }

      // US-828: validate aspect VALUES against the category spec before the
      // offer build. SELECTION_ONLY near-misses are normalized (US-823) so they
      // publish; values eBay still won't accept are OMITTED from the outgoing
      // payload and recorded as diagnostics. Unknown aspect names + free-text
      // pass through unchanged, so this only ever omits for value-validation
      // reasons. The PERSISTED aspectMap is untouched — the draft keeps the
      // flagged value for the seller to fix.
      const reconcileSpecs: ReconcileSpec[] = list
        .map((a) => ({
          name: a.localizedAspectName ?? "",
          mode: a.aspectConstraint?.aspectMode ?? "FREE_TEXT",
          allowedValues: (a.aspectValues ?? [])
            .map((v) => v.localizedValue ?? "")
            .filter((v) => v.length > 0),
        }))
        .filter((s) => s.name.length > 0);
      const reconciled = reconcilePublishAspects(aspectMap, reconcileSpecs);
      sanitizedAspects = reconciled.aspects;
      aspectDiagnostics = reconciled.omitted;
      if (aspectDiagnostics.length > 0) {
        console.warn(
          `[flipdesk-ebay] omitted ${aspectDiagnostics.length} aspect value(s) for ` +
            `item ${itemId} (category ${categoryId}) — not in eBay's allowed set: ` +
            JSON.stringify(aspectDiagnostics),
        );
      }

      // US-825: the SAME required-aspect rule the client pre-publish checklist
      // uses (requiredMissingAspects) — blocker and checklist can't disagree.
      // Run on the sanitized map so a required aspect whose only value was
      // invalid (and thus omitted) correctly surfaces as a fixable blocker.
      requiredMissing = requiredMissingAspects(list, sanitizedAspects);
      if (requiredMissing.length > 0) {
        // Diagnostic: log WHY each missing aspect couldn't be auto-filled —
        // its mode, a sample of eBay's allowed values, and the item text we
        // tried to infer from. Lets us close the gap without guessing.
        const diag = requiredMissing.map((name) => {
          const spec = list.find((a) => a.localizedAspectName === name);
          const allowed = (spec?.aspectValues ?? [])
            .map((v) => v.localizedValue ?? "")
            .filter((v) => v.length > 0);
          return {
            name,
            mode: spec?.aspectConstraint?.aspectMode ?? "?",
            allowedSample: allowed.slice(0, 12),
            allowedCount: allowed.length,
          };
        });
        console.warn(
          `[flipdesk-ebay] required specifics unfilled for item ${itemId} ` +
            `(category ${categoryId}): ${JSON.stringify(diag)} ` +
            `| item title=${JSON.stringify(item.title)} style=${JSON.stringify(item.style)} ` +
            `item_category=${JSON.stringify(item.item_category)}`,
        );
        blockers.push(
          `Fill required eBay specifics in the composer: ${requiredMissing.slice(0, 4).join(", ")}${
            requiredMissing.length > 4 ? "…" : ""
          }`
        );
      }
    } catch (err) {
      console.error("[flipdesk-ebay] aspect fetch for validate:", err);
      blockers.push("Could not load eBay specifics for this category. Try again.");
    }
  }

  const photosWithUrl = photos.filter((p) => !!p.public_url);
  if (photosWithUrl.length === 0) {
    blockers.push("Add at least one photo.");
  } else {
    // US-473/US-566: enforce eBay's 24-image cap as a fixable pre-flight blocker
    // (with de-dup + sort_order preserved) so an over-cap set surfaces here
    // instead of a raw eBay 25601 mid-publish. Duplicates are silently de-duped;
    // only a genuine over-cap (after de-dup) blocks so the seller consciously
    // picks which shots to keep rather than losing a defect photo silently.
    const capResult = dedupeAndCapImages(
      photosWithUrl.map((p) => p.public_url),
      PREFLIGHT_MAX_IMAGES,
    );
    const capBlocker = imageCapBlocker(capResult, PREFLIGHT_MAX_IMAGES);
    if (capBlocker) blockers.push(capBlocker);
  }

  // Price priority: explicit listing edits beat inventory defaults so a user
  // who changed the price in the composer or bulk-edit actually publishes that.
  // A listing_price of 0 means "never priced" (bulk draft-create and old
  // composer saves wrote 0 when the price box was empty) — it must FALL
  // THROUGH to the item's target price instead of blocking publish on an item
  // the user already priced. (list_price isn't a real column on
  // inventory_items — only an alias on the items_full view — so it's not in
  // the fallback chain.)
  const priceNumber =
    (listing?.listing_price != null && listing.listing_price > 0
      ? listing.listing_price
      : null) ??
    (item.target_price != null && item.target_price > 0
      ? item.target_price
      : null);
  if (!priceNumber || priceNumber <= 0) {
    blockers.push("Set a target price.");
  }

  const title = (listing?.listing_title ?? item.title ?? "").trim();
  if (!title) blockers.push("Set a title.");

  // Look up policies last — only blocks if everything else is ready, but
  // surface the missing prereqs as part of `blockers` either way.
  // US-314: read from the cached business_policies table first; only refresh
  // from eBay when the cache is empty or partial.
  let policies: PolicySet | null = null;
  try {
    const policyResult = await resolveCachedDefaults(userId);
    if ("missing" in policyResult) {
      // Split the two failure modes: business policies are configured in eBay
      // Seller Hub, but a merchant (inventory) location can ONLY be created
      // from FlipDesk (eBay has no Seller Hub UI for it). Pointing both at the
      // business-policies help page is the wrong fix for a missing location.
      const missingPolicies = policyResult.missing.filter(
        (m) => m !== "merchant location",
      );
      if (missingPolicies.length > 0) {
        const help = policyResult.details?.helpUrl
          ? ` (set them up at ${policyResult.details.helpUrl})`
          : "";
        blockers.push(
          `Configure eBay business policies on your seller account: ${missingPolicies.join(", ")}.${help}`,
        );
      }
      if (policyResult.missing.includes("merchant location")) {
        blockers.push(
          "Set your eBay ship-from location: open FlipDesk → Marketplaces → eBay and add it (one-time).",
        );
      }
    } else {
      policies = policyResult;
      // US-555: a per-listing policy override (bulk-assigned in the AutoLister
      // grid) wins over the account default. Each id is left to fall back when
      // null, so a partial override (e.g. only return policy) still publishes
      // with the account defaults for the rest.
      if (listing) {
        policies = {
          ...policies,
          fulfillmentPolicyId:
            listing.shipping_policy_id ?? policies.fulfillmentPolicyId,
          paymentPolicyId:
            listing.payment_policy_id ?? policies.paymentPolicyId,
          returnPolicyId: listing.return_policy_id ?? policies.returnPolicyId,
        };
      }
    }
  } catch (err) {
    // Token-refresh / scope errors land here. Surface a hint so the seller
    // knows reconnecting eBay (re-consenting at /oauth/start) is the fix.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] policy lookup:", err);
    if (/invalid_scope|token refresh failed/i.test(msg)) {
      blockers.push(
        "Your eBay connection needs to be refreshed. Disconnect and reconnect eBay on the Marketplaces page to grant the latest permissions.",
      );
    } else {
      blockers.push("Could not load your eBay business policies. Try again.");
    }
  }

  const description = (listing?.listing_description ?? item.description ?? title).trim() ||
    title;
  const sku = item.sku && item.sku.trim() ? item.sku.trim() : `FD-${item.id.slice(0, 8)}`;
  // Condition: explicit editor value wins; only fall back to grade-derived
  // mapping when the user/AI hasn't set one.
  const condition = (listing?.ebay_condition && listing.ebay_condition.trim())
    ? listing.ebay_condition.trim()
    : mapEbayCondition(item.grade_value, item.grade_label);
  const conditionDescription =
    (listing?.ebay_condition_description ?? item.condition_notes ?? "").trim();

  // US-566: validate the resolved condition against the leaf category's allowed
  // conditions (Taxonomy get_item_condition_policies, cached). Best-effort: a
  // policy-fetch failure or an unrestricted category never blocks publish — we
  // only block when eBay definitively says this category rejects the condition,
  // turning a raw 25002/25019 into a fixable "change the condition" blocker.
  if (categoryId) {
    try {
      const { conditionIds } = await getItemConditionPolicies(categoryId);
      const condBlocker = validateConditionForCategory(condition, conditionIds);
      if (condBlocker) blockers.push(condBlocker);
    } catch (err) {
      console.warn(
        "[flipdesk-ebay] condition-policy validate (non-blocking):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Quantity: default 1 for single-item resellers; respect the column when set.
  const quantity = listing?.quantity && listing.quantity > 0 ? listing.quantity : 1;
  const bestOfferEnabled = listing?.best_offer_enabled === true;

  // US-562: derive best-offer auto-accept/decline thresholds from the comp
  // range (p25 floor → decline, p75 → accept), letting any per-item override
  // win. Only computed when Best Offer is on; the helper clamps to eBay's
  // constraints (decline < accept < price) and nulls anything invalid.
  let bestOfferAutoAccept: string | null = null;
  let bestOfferAutoDecline: string | null = null;
  if (bestOfferEnabled) {
    const priceCents = priceNumber ? Math.round(priceNumber * 100) : 0;
    const thresholds = resolveBestOfferThresholds({
      priceCents,
      p25Cents: listing?.price_range_low_cents ?? null,
      p75Cents: listing?.price_range_high_cents ?? null,
      acceptOverrideCents: listing?.best_offer_auto_accept_cents ?? null,
      declineOverrideCents: listing?.best_offer_auto_decline_cents ?? null,
    });
    bestOfferAutoAccept =
      thresholds.autoAcceptCents != null
        ? centsToMoneyString(thresholds.autoAcceptCents)
        : null;
    bestOfferAutoDecline =
      thresholds.autoDeclineCents != null
        ? centsToMoneyString(thresholds.autoDeclineCents)
        : null;
  }

  // US-568: resolve the listing format + auction terms. Auction prices are
  // stored in cents; convert to eBay money strings. A draft marked 'auction'
  // without a start price falls back to the listing price as the starting bid.
  const format: "FIXED_PRICE" | "AUCTION" =
    listing?.listing_format === "auction" ? "AUCTION" : "FIXED_PRICE";
  const centsToStr = (c: number | null | undefined): string | null =>
    typeof c === "number" && c > 0 ? centsToMoneyString(c) : null;
  const auctionStartPrice =
    format === "AUCTION"
      ? (centsToStr(listing?.auction_start_price_cents) ??
        (priceNumber ? priceNumber.toFixed(2) : null))
      : null;
  const auctionReservePrice =
    format === "AUCTION"
      ? centsToStr(listing?.auction_reserve_price_cents)
      : null;
  const auctionBuyItNowPrice =
    format === "AUCTION"
      ? centsToStr(listing?.auction_buy_it_now_price_cents)
      : null;
  const auctionDuration =
    format === "AUCTION"
      ? (listing?.auction_duration?.trim() || "DAYS_7")
      : "GTC";
  // US-568: variation matrix — keep only non-empty, well-formed entries.
  const variations = normalizeVariations(listing?.variations ?? null);

  const summary: PublishContextOk["summary"] = {
    title,
    description,
    priceValue: priceNumber ? priceNumber.toFixed(2) : "0.00",
    currency: "USD",
    condition,
    conditionDescription,
    categoryId: categoryId ?? "",
    // US-828: send the value-validated map (near-misses normalized, invalid
    // SELECTION_ONLY values omitted), not the raw persisted aspectMap.
    aspects: sanitizedAspects,
    quantity,
    bestOfferEnabled,
    bestOfferAutoAccept,
    bestOfferAutoDecline,
    format,
    auctionStartPrice,
    auctionReservePrice,
    auctionBuyItNowPrice,
    auctionDuration,
    variations,
    // US-561: resolve the ad rate to attach — opt-out wins, then the seller's
    // chosen rate, else the category suggestion. The composer surfaces the same
    // suggestion so "promote by default" stays transparent + adjustable.
    promotedAdRate: resolvePublishAdRate({
      optOut: listing?.promo_opt_out,
      chosenRatePct: listing?.promo_rate_pct,
      categoryId,
    }),
  };

  return {
    ok: true,
    item,
    listing,
    photos: photosWithUrl,
    policies,
    blockers,
    aspectDiagnostics,
    sku,
    summary,
  };
}

// Maps GradeThread's 1-10 grade to an eBay clothing condition string. eBay's
// `condition` enum field on inventory_item PUT accepts these symbolic names;
// note that not every leaf category accepts every value — categories with
// stricter taxonomies (vintage, designer) may reject anything but NEW vs
// USED_EXCELLENT. We default to USED_EXCELLENT for missing grades.
function mapEbayCondition(
  grade: number | null,
  label: string | null
): string {
  const isNwt = (label ?? "").toUpperCase().includes("NWT");
  if (grade != null) {
    if (grade >= 9.75 || isNwt) return "NEW";
    if (grade >= 9.0) return "LIKE_NEW";
    if (grade >= 7.5) return "USED_EXCELLENT";
    if (grade >= 6.0) return "USED_VERY_GOOD";
    if (grade >= 4.5) return "USED_GOOD";
    return "USED_ACCEPTABLE";
  }
  return isNwt ? "NEW" : "USED_EXCELLENT";
}

// Resolves an in-app path against the configured frontend origin. Used for
// the post-callback redirect so a sandbox deploy doesn't bounce users to
// production. Falls back to a relative path if no origin is configured.
function appUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const origin =
    Deno.env.get("FLIPDESK_APP_ORIGIN") ??
    Deno.env.get("GRADETHREAD_APP_ORIGIN") ??
    "https://gradethread.com";
  return `${origin.replace(/\/$/, "")}${
    pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`
  }`;
}
