import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import {
  buildConsentUrl,
  createInventoryLocation,
  createOffer,
  createOrReplaceInventoryItem,
  debugSnapshot,
  ebayListingUrl,
  exchangeCodeForTokens,
  getCategoryAspects,
  getCategoryName,
  getMarketplaceId,
  getUserAccessToken,
  getUserIdentityFromToken,
  isEbayConfigured,
  isOfferAlreadyExistsError,
  listAllOffers,
  listOffersForSku,
  listRecentOrders,
  listRecentTransactions,
  publishOffer,
  resolveCachedDefaults,
  searchBrowseComps,
  setDefaultPolicies,
  suggestCategories,
  syncBusinessPolicies,
  updateOfferFields,
  updateOfferPrice,
  upsertConnection,
  withdrawOffer,
  type PolicySet,
  type RemoteOffer,
  type RemoteOrder,
  type RemoteOrderLineItem,
  type RemoteTransaction,
} from "../lib/ebay-client.ts";
import {
  getAllActiveEbaySelling,
  getItemSpecifics,
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
import { failSafe } from "../lib/http-errors.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { pushSaleCreated, pushTokenExpiring } from "../lib/transactional-push.ts";

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

  // eBay sends `error=access_denied` when the user cancels at the consent
  // screen. Other error codes (e.g. unauthorized_client) signal config bugs
  // — log the description so the operator can see it without having to dig
  // through eBay's redirect URL.
  if (ebayError) {
    console.error(
      `[flipdesk-ebay] consent error: ${ebayError} — ${ebayErrorDesc ?? "(no description)"}`
    );
    const reason = ebayError === "access_denied" ? "cancelled" : ebayError;
    return c.redirect(
      appUrl(
        `/dashboard/flipdesk/marketplaces?ebay=${encodeURIComponent(reason)}`
      )
    );
  }
  if (!code || !state) {
    return c.redirect(appUrl("/dashboard/flipdesk/marketplaces?ebay=cancelled"));
  }

  // Single-use state — read + delete in one round-trip so a replay can't reuse it.
  const { data: stateRow, error: stateErr } = await supabaseAdmin
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .eq("marketplace", "ebay")
    .select("user_id, redirect_to, expires_at")
    .maybeSingle();

  if (stateErr || !stateRow) {
    return c.redirect(
      appUrl("/dashboard/flipdesk/marketplaces?ebay=invalid_state")
    );
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    return c.redirect(
      appUrl("/dashboard/flipdesk/marketplaces?ebay=state_expired")
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    // US-315: capture the seller's eBay username at connect time so webhooks
    // and admin views know which account a listing publishes under. Identity
    // lookup is non-fatal — a 4xx/network blip should not block connect; the
    // refresh path will backfill on the next token rotation.
    const identity = await getUserIdentityFromToken(tokens.access_token);
    await upsertConnection({
      userId: stateRow.user_id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresInSeconds: tokens.expires_in,
      accountHandle: identity?.username ?? null,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] OAuth exchange failed:", err);
    return c.redirect(
      appUrl("/dashboard/flipdesk/marketplaces?ebay=exchange_failed")
    );
  }

  // Defense-in-depth: redirect_to was sanitized at /oauth/start, but re-check
  // here so a legacy/oddly-stored row can't drive an open redirect. (US-274)
  const dest =
    sanitizeRelativePath(stateRow.redirect_to) ??
    "/dashboard/flipdesk/marketplaces?ebay=connected";
  return c.redirect(appUrl(dest));
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
  return c.json({ scanned: userIds.length, refreshed, failed });
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

// ── Still-stubbed handlers (Week 2-3 work) ─────────────────────────

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
  errors: string[];
}

// Insert a `running` row the moment a pull starts and return its id, so a sync
// that HANGS (e.g. eBay API stall mid-pagination) or is killed before it can
// finalize is still visible in the Reconciliation history as a stuck "running"
// run — instead of leaving no trace at all (the old behavior, which made a
// non-completing pull impossible to see from the UI). Returns null on failure;
// callers fall back to a plain insert at the end.
async function startSyncRun(
  userId: string,
  startedAt: string,
): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("flipdesk_sync_runs")
      .insert({
        user_id: userId,
        marketplace: "ebay",
        status: "running",
        started_at: startedAt,
      })
      .select("id")
      .single();
    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    console.error("[flipdesk-ebay] failed to start sync run:", err);
    return null;
  }
}

// Finalize a run. When `runId` is present (the normal path) this UPDATES the
// `running` row started by startSyncRun; otherwise it falls back to an INSERT.
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
): Promise<void> {
  const startedAt = new Date().toISOString();
  // Record a `running` row up front so a hung/killed pull is still visible in
  // the Reconciliation history; both finalizers below update it via runId.
  const runId = await startSyncRun(userId, startedAt);
  let offers: RemoteOffer[];
  try {
    offers = await listAllOffers(userId);
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

  // Catalog-backfill bookkeeping. GetItem (legacy specifics) is gated to items
  // still missing a field and capped per run, so first-sync cost tapers to ~0.
  const MAX_SPECIFICS_FETCH_PER_SYNC = 300;
  let catalogUpdated = 0;
  let specificsFetched = 0;
  let specificsCapped = false;

  // Apply an eBay-sourced catalog patch to a matched inventory_item, keeping
  // our in-memory ItemRow in sync so the orders pass below sees fresh values.
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
  const errors: string[] = [];

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
        // Upsert into listings (by inventory_item_id + platform).
        const { data: existing } = await supabaseAdmin
          .from("listings")
          .select("id")
          .eq("inventory_item_id", itemId)
          .eq("platform", "ebay")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const patch: Record<string, unknown> = {
          platform_listing_id: o.listingId,
          platform_offer_id: o.offerId,
          listing_url: ebayListingUrl(o.listingId),
          listing_price: priceNum ?? undefined,
          listing_status: isActive ? "active" : "ended",
          is_active: isActive,
        };
        // Pull description back from eBay so manual Seller Hub edits don't
        // leave FlipDesk's copy stale. Skip empty strings — those usually
        // mean "API didn't return a body", not "user blanked it".
        if (o.listingDescription && o.listingDescription.trim()) {
          patch.listing_description = o.listingDescription;
        }
        if (o.categoryId) {
          patch.platform_category_id = o.categoryId;
        }
        if (existing) {
          await supabaseAdmin
            .from("listings")
            .update(patch)
            .eq("id", (existing as { id: string }).id);
        } else {
          await supabaseAdmin.from("listings").insert({
            inventory_item_id: itemId,
            platform: "ebay",
            listing_price: priceNum ?? 0,
            ...patch,
          });
        }
        // Forward-only status — don't regress sold/shipped items.
        if (isActive) {
          await supabaseAdmin
            .from("inventory_items")
            .update({ status: "listed" })
            .eq("id", itemId)
            .in("status", [
              "sourced",
              "acquired",
              "cataloged",
              "measured",
              "photographed",
              "comped",
              "drafted",
            ]);
        }
        // eBay as source of truth: title overwrite, specifics fill-if-blank.
        // Modern offers carry title + aspects (from listAllOffers) — free.
        const localRow = sku ? itemBySku.get(sku) : undefined;
        if (localRow) {
          await applyCatalogPatch(
            itemId,
            localRow,
            buildCatalogPatch(localRow, {
              title: o.title,
              specifics: flattenAspects(o.aspects),
            }),
          );
        }
        matched += 1;
      } else {
        // Snapshot orphan eBay listings — surfaced on the Reconciliation page.
        await supabaseAdmin
          .from("flipdesk_ebay_listings")
          .upsert(
            {
              user_id: userId,
              ebay_item_id: o.listingId,
              custom_label: sku,
              title: null,
              current_price: priceNum,
              available_quantity: o.availableQuantity,
              listing_url: ebayListingUrl(o.listingId),
              listing_format: o.format,
              raw: {
                offerId: o.offerId,
                listingStatus: o.listingStatus,
                categoryId: o.categoryId,
                price: o.price,
              },
              match_status: "unmatched",
              imported_at: new Date().toISOString(),
            },
            { onConflict: "user_id,ebay_item_id" }
          );
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
          // Same upsert path as the modern flow — but no platform_offer_id
          // because legacy listings don't have a Sell Inventory offer.
          const { data: existing } = await supabaseAdmin
            .from("listings")
            .select("id")
            .eq("inventory_item_id", itemId)
            .eq("platform", "ebay")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const patch: Record<string, unknown> = {
            platform_listing_id: l.ebayItemId,
            listing_url: l.listingUrl ?? ebayListingUrl(l.ebayItemId),
            listing_price: l.currentPrice ?? undefined,
            listing_status: "active",
            is_active: true,
          };
          if (l.title && l.title.trim()) patch.listing_title = l.title;
          if (l.primaryCategoryId) patch.platform_category_id = l.primaryCategoryId;
          if (existing) {
            await supabaseAdmin
              .from("listings")
              .update(patch)
              .eq("id", (existing as { id: string }).id);
          } else {
            await supabaseAdmin.from("listings").insert({
              inventory_item_id: itemId,
              platform: "ebay",
              listing_price: l.currentPrice ?? 0,
              ...patch,
            });
          }
          await supabaseAdmin
            .from("inventory_items")
            .update({ status: "listed" })
            .eq("id", itemId)
            .in("status", [
              "sourced",
              "acquired",
              "cataloged",
              "measured",
              "photographed",
              "comped",
              "drafted",
            ]);
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
          // and let the user link it to a FlipDesk SKU.
          await supabaseAdmin
            .from("flipdesk_ebay_listings")
            .upsert(
              {
                user_id: userId,
                ebay_item_id: l.ebayItemId,
                custom_label: sku,
                title: l.title,
                current_price: l.currentPrice,
                available_quantity: l.quantityAvailable ?? l.quantity,
                listing_url: l.listingUrl,
                listing_format: l.listingType,
                start_date: l.startTime ? l.startTime.slice(0, 10) : null,
                raw: {
                  source: "trading_api",
                  watchCount: l.watchCount,
                  endTime: l.endTime,
                },
                match_status: "unmatched",
                imported_at: new Date().toISOString(),
              },
              { onConflict: "user_id,ebay_item_id" }
            );
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
  try {
    const orders: RemoteOrder[] = await listRecentOrders(userId, sinceISO);
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
            .select("id")
            .eq("inventory_item_id", itemId)
            .eq("platform", "ebay")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const listingId = (lst as { id: string } | null)?.id ?? null;

          const itemCost = li.itemCost ? Number(li.itemCost.value) : 0;
          const shippingCollected = li.shippingCost
            ? Number(li.shippingCost.value)
            : 0;
          const tax = li.taxes ? Number(li.taxes.value) : 0;

          // Dedupe key is (inventory_item_id, platform_order_id). Migration
          // 00032 adds the unique index that makes this safe under retries.
          const { data: existing } = await supabaseAdmin
            .from("sales")
            .select("id")
            .eq("inventory_item_id", itemId)
            .eq("platform_order_id", order.orderId)
            .limit(1)
            .maybeSingle();

          const salePayload = {
            inventory_item_id: itemId,
            listing_id: listingId,
            platform_order_id: order.orderId,
            sale_price: itemCost,
            sale_date: order.creationDate?.slice(0, 10) ?? null,
            sold_at: order.creationDate ?? null,
            buyer_username: order.buyerUsername,
            buyer_id: order.buyerUsername,
            shipping_collected: shippingCollected,
            tax,
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
            void pushSaleCreated(userId);
          }

          // Flip the item to sold. resolveStatus-equivalent: 'sold' is a
          // terminal non-prep status so it dominates anything we'd have
          // bumped to via the offer loop above ('listed').
          await supabaseAdmin
            .from("inventory_items")
            .update({ status: "sold" })
            .eq("id", itemId)
            .not("status", "in", "(shipped,completed,returned)");
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
      sinceISO
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
          "id, inventory_item_id, sale_price, shipping_collected, shipping_cost, grading_cost, other_costs, platform_order_id, inventory_items!inner(user_id, acquired_price)"
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
        // Net profit = revenue - fees - your costs.
        // Revenue: sale_price + shipping_collected (tax flows through to
        //   government, not seller).
        // Fees: platform_fees (already in `fees`).
        // Your costs: cost basis, your shipping cost to send the item,
        //   grading, other.
        const netProfit =
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

  // Fire-and-forget — do NOT await this. Returning 202 before the work starts
  // means the HTTP connection closes immediately, safely below Cloudflare's
  // 100s proxy timeout. The frontend polls last_synced_at to detect completion.
  void doListingsPull(userId, connId, lastSyncedAt, backfill).catch((err) =>
    console.error("[flipdesk-ebay] background sync crashed:", err),
  );

  return c.json({ ok: true, message: "Sync started in background." }, 202);
});

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

// Revises a live listing — title / description / price. Photos and aspects
// flow through implicitly via the inventory_item PUT (which is sourced from
// current local state), so editing a photo via the photo manager and then
// hitting revise will sync the new image set to eBay.
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

  if (!hasTitle && !hasDesc && !hasPrice) {
    return c.json(
      { error: "Provide at least one of: title, description, listing_price" },
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
  await supabaseAdmin
    .from("listings")
    .update(localUpdates)
    .eq("id", listingId);

  // Re-PUT the inventory_item when product fields changed (title / desc).
  // We send full state — photos, aspects, brand — so any drift from the
  // photo manager / category picker also syncs here.
  if (hasTitle || hasDesc) {
    const { data: itemRow } = await supabaseAdmin
      .from("inventory_items")
      .select(
        "id, user_id, title, brand, sku, description, condition_notes, grade_value, grade_label, ebay_aspects"
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
      sku: string | null;
      description: string | null;
      condition_notes: string | null;
      grade_value: number | null;
      grade_label: string | null;
      ebay_aspects: Record<string, string[]> | null;
    };
    const sku =
      item.sku && item.sku.trim()
        ? item.sku.trim()
        : `FD-${item.id.slice(0, 8)}`;

    const { data: photoRows } = await supabaseAdmin
      .from("item_photos")
      .select("storage_path, photo_url, sort_order")
      .eq("inventory_item_id", itemId)
      .order("sort_order", { ascending: true });
    const imageUrls = (
      (photoRows ?? []) as Array<{
        storage_path: string | null;
        photo_url: string | null;
      }>
    )
      .map((p) => {
        if (p.photo_url) return p.photo_url;
        if (p.storage_path) {
          return supabaseAdmin.storage
            .from("item-photos")
            .getPublicUrl(p.storage_path).data.publicUrl;
        }
        return null;
      })
      .filter((u): u is string => !!u);

    const finalTitle = hasTitle ? (nextTitle as string) : (item.title ?? "").trim();
    const finalDesc = hasDesc
      ? (nextDesc as string)
      : (item.description ?? finalTitle).trim() || finalTitle;

    try {
      await createOrReplaceInventoryItem(userId, sku, {
        product: {
          title: finalTitle,
          description: finalDesc,
          aspects: item.ebay_aspects ?? undefined,
          imageUrls,
          brand:
            typeof item.brand === "string" && item.brand.trim()
              ? item.brand.trim()
              : undefined,
        },
        condition: mapEbayCondition(item.grade_value, item.grade_label),
        conditionDescription: item.condition_notes?.trim() || undefined,
        availability: { shipToLocationAvailability: { quantity: 1 } },
      });
    } catch (err) {
      console.error("[flipdesk-ebay] revise inventory_item failed:", err);
      return c.json(
        {
          error: "eBay rejected the revision.",
          detail:
            err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
        502
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
      return c.json(
        {
          error: "eBay rejected the offer revision.",
          detail:
            err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
        502
      );
    }
  }

  return c.json({
    ok: true,
    listing_id: listingId,
    updated: localUpdates,
  });
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
    summary: result.summary,
  });
});

export type PublishItemResult =
  | {
    ok: true;
    listing_id: string;
    listing_url: string;
    offer_id: string;
    sku: string;
  }
  | { ok: false; status: 400 | 404 | 422 | 500 | 502 | 503; body: Record<string, unknown> };

// Publish one owned item to eBay (inventory PUT → offer POST → publish POST).
// Parameterized by ownerId so both the authed /listings/push handler and the
// scheduled publish-due worker (US-322) reuse the identical flow. Returns a
// result union instead of an HTTP response so non-HTTP callers can use it.
export async function publishItemForOwner(
  ownerId: string,
  itemId: string,
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

  // 1. Ensure the SKU is persisted on the item so reconciliation works
  //    (eBay's "Custom label" maps back to this).
  if (sku !== item.sku) {
    await supabaseAdmin
      .from("inventory_items")
      .update({ sku })
      .eq("id", itemId);
  }

  try {
    // 2. Push inventory_item (idempotent PUT). Quantity, aspects, and
    //    condition all come from the publish context, which already resolved
    //    listing-row edits ahead of inventory defaults (US-319/320/321).
    await createOrReplaceInventoryItem(ownerId, sku, {
      product: {
        title: ctx.summary.title,
        description: ctx.summary.description,
        aspects: ctx.summary.aspects,
        imageUrls: photos.map((p) => p.public_url),
        brand:
          typeof item.brand === "string" && item.brand.trim()
            ? item.brand.trim()
            : undefined,
      },
      condition: ctx.summary.condition,
      conditionDescription:
        ctx.summary.conditionDescription || undefined,
      availability: {
        shipToLocationAvailability: { quantity: ctx.summary.quantity },
      },
    });

    // 3. Create or reuse an offer for this SKU.
    let offerId: string;
    try {
      const created = await createOffer(ownerId, {
        sku,
        marketplaceId: getMarketplaceId(),
        format: "FIXED_PRICE",
        availableQuantity: ctx.summary.quantity,
        categoryId: ctx.summary.categoryId,
        listingDescription: ctx.summary.description,
        listingPolicies: {
          fulfillmentPolicyId: policies.fulfillmentPolicyId,
          paymentPolicyId: policies.paymentPolicyId,
          returnPolicyId: policies.returnPolicyId,
          ...(ctx.summary.bestOfferEnabled
            ? { bestOfferTerms: { bestOfferEnabled: true } }
            : {}),
        },
        pricingSummary: {
          price: {
            value: ctx.summary.priceValue,
            currency: ctx.summary.currency,
          },
        },
        merchantLocationKey: policies.merchantLocationKey,
      });
      offerId = created.offerId;
    } catch (err) {
      if (!isOfferAlreadyExistsError(err)) throw err;
      const existing = await listOffersForSku(ownerId, sku);
      const found = existing.find((o) => !!o.offerId);
      if (!found) throw err;
      offerId = found.offerId;
    }

    // 4. Publish.
    const published = await publishOffer(ownerId, offerId);
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
    if (listing?.id) {
      await supabaseAdmin
        .from("listings")
        .update(listingPayload)
        .eq("id", listing.id);
    } else {
      await supabaseAdmin.from("listings").insert(listingPayload);
    }

    await supabaseAdmin
      .from("inventory_items")
      .update({ status: "listed" })
      .eq("id", itemId);

    return {
      ok: true,
      listing_id: listingId,
      listing_url: url,
      offer_id: offerId,
      sku,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] publish failed:", msg);
    // US-321: persist the failure on the draft listing so the queue/UI can
    // surface "last failed: X" on reload, and US-325 retry can target it.
    if (listing?.id) {
      try {
        await supabaseAdmin
          .from("listings")
          .update({
            publish_error: msg.slice(0, 1000),
            publish_failed_at: new Date().toISOString(),
          })
          .eq("id", listing.id);
      } catch (logErr) {
        console.error("[flipdesk-ebay] could not persist publish_error:", logErr);
      }
    }
    return {
      ok: false,
      status: 502,
      body: { ok: false, error: "Publish failed", detail: msg.slice(0, 1000) },
    };
  }
}

flipdeskEbayRoutes.post("/listings/push", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = await readItemId(c);
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

  const result = await publishItemForOwner(userId, itemId);
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({
    ok: true,
    listing_id: result.listing_id,
    listing_url: result.listing_url,
    offer_id: result.offer_id,
    sku: result.sku,
  });
});

// US-528: how long a publish claim is honored before it's considered stale and
// reclaimable. Must exceed the realistic worst-case publish wall-time (eBay
// latency + the bounded publishOffer retries) so a still-running publish is
// never reclaimed, while a crashed one is eventually retried.
const PUBLISH_CLAIM_STALE_MS = 10 * 60_000;

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
    .limit(100);
  if (error) {
    console.error("[flipdesk-ebay] publish-due scan failed:", error);
    return c.json({ error: "Scan failed" }, 500);
  }

  const due = (dueRows ?? []) as { id: string; inventory_item_id: string }[];
  if (due.length === 0) {
    return c.json({ scanned: 0, published: 0, failed: 0, skipped: 0 });
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

  return c.json({ scanned: due.length, published, failed, skipped });
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
      "id, inventory_item_id, platform_offer_id, platform_listing_id, inventory_items!inner(user_id)"
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
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  item_category: string | null;
  status: string;
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
  platform_category_id: string | null;
  item_specifics_override: Record<string, string[]> | null;
  scheduled_publish_at: string | null;
}

interface PublishContextOk {
  ok: true;
  item: PublishItem;
  listing: PublishListing | null;
  photos: PublishPhoto[];
  // null when blockers includes a missing-policy entry. Push must re-check.
  policies: PolicySet | null;
  blockers: string[];
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
  };
}

interface PublishContextErr {
  ok: false;
  error: { error: string };
  status: 400 | 404 | 500 | 503;
}

type PublishContext = PublishContextOk | PublishContextErr;

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
      "id, user_id, title, brand, sku, size, description, condition_notes, target_price, grade_value, grade_label, ebay_category_id, ebay_aspects, item_category, status"
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
      "id, listing_title, listing_description, listing_price, ebay_condition, ebay_condition_description, quantity, best_offer_enabled, platform_category_id, item_specifics_override, scheduled_publish_at",
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
  if (categoryId) {
    try {
      const aspectsResp = await getCategoryAspects(categoryId);
      const raw = (aspectsResp.aspects as Record<string, unknown>).aspects;
      const list = Array.isArray(raw)
        ? (raw as Array<{
            localizedAspectName?: string;
            aspectConstraint?: { aspectRequired?: boolean };
          }>)
        : [];
      requiredMissing = list
        .filter((a) => a.aspectConstraint?.aspectRequired)
        .map((a) => a.localizedAspectName ?? "")
        .filter((n) => n && (aspectMap[n]?.length ?? 0) === 0);
      if (requiredMissing.length > 0) {
        blockers.push(
          `Fill required eBay specifics: ${requiredMissing.slice(0, 4).join(", ")}${
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
  }

  // Price priority: explicit listing edits beat inventory defaults so a user
  // who changed the price in the composer or bulk-edit actually publishes that.
  // (list_price isn't a real column on inventory_items — only an alias on the
  // items_full view — so it's not in the fallback chain.)
  const priceNumber = listing?.listing_price ?? item.target_price ?? null;
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

  // Quantity: default 1 for single-item resellers; respect the column when set.
  const quantity = listing?.quantity && listing.quantity > 0 ? listing.quantity : 1;
  const bestOfferEnabled = listing?.best_offer_enabled === true;

  const summary: PublishContextOk["summary"] = {
    title,
    description,
    priceValue: priceNumber ? priceNumber.toFixed(2) : "0.00",
    currency: "USD",
    condition,
    conditionDescription,
    categoryId: categoryId ?? "",
    aspects: aspectMap,
    quantity,
    bestOfferEnabled,
  };

  return {
    ok: true,
    item,
    listing,
    photos: photosWithUrl,
    policies,
    blockers,
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
