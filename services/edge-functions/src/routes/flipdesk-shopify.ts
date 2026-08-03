import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { roleAtLeast } from "../lib/workspace-roles.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { resyncItemListedStatus } from "../lib/active-listings.ts";
import { ingestPaidOrdersSince } from "../lib/shopify-orders.ts";
import {
  buildConsentUrl,
  exchangeCodeForToken,
  getProductStatus,
  getShopifyConnection,
  getShopifyWebhookUrl,
  getShopInfo,
  isShopifyConfigured,
  normalizeShopDomain,
  upsertShopifyConnection,
  verifyOAuthHmac,
} from "../lib/shopify-client.ts";
import { registerShopifyWebhooks } from "../lib/shopify-graphql.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";

// Shopify integration endpoints (US-599). Mounted at /api/flipdesk/shopify.
//
// Auth split mirrors the eBay module:
//   - /oauth/start    → user-authed (initiates from inside the app)
//   - /oauth/callback → public (Shopify redirects the browser here unauthed;
//                       the `state` row identifies the user, and the request is
//                       HMAC-verified with our app secret)
//   - everything else → user-authed via main.ts middleware
//
// Required env: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_REDIRECT_URI,
//               SHOPIFY_SCOPES (optional), EDGE_ENCRYPTION_KEY.

type ShopifyEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

export const flipdeskShopifyRoutes = new Hono<ShopifyEnv>();

function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function appUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const origin = Deno.env.get("FLIPDESK_APP_ORIGIN") ??
    Deno.env.get("GRADETHREAD_APP_ORIGIN") ??
    "https://gradethread.com";
  return `${origin.replace(/\/$/, "")}${
    pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`
  }`;
}

// ── OAuth: start ───────────────────────────────────────────────────
// The user supplies their *.myshopify.com store handle. We validate it,
// enforce the marketplace-connection cap, persist a single-use state row, and
// return { consent_url } for the SPA to redirect to.
flipdeskShopifyRoutes.get("/oauth/start", async (c) => {
  if (!isShopifyConfigured()) {
    return c.json({ error: "Shopify is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const shop = normalizeShopDomain(c.req.query("shop"));
  if (!shop) {
    return c.json(
      { error: "Enter your Shopify store domain, e.g. my-store.myshopify.com." },
      400,
    );
  }
  const redirectTo = sanitizeRelativePath(c.req.query("redirect_to"));

  // US-382: enforce the marketplace-connection cap. A reconnect of an existing
  // Shopify store must NOT count as a new marketplace (it updates the same row).
  const { count: activeShopify } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("marketplace", "shopify")
    .eq("is_active", true);
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "marketplaces", delta: (activeShopify ?? 0) > 0 ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const state = generateState();
  // Stash the chosen shop in redirect_to-adjacent state by reusing the state
  // row's marketplace; the shop itself is re-derived from (and HMAC-verified in)
  // the callback query, so it doesn't need persisting.
  const { error } = await supabaseAdmin.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace: "shopify",
    redirect_to: redirectTo,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) {
    console.error("[flipdesk-shopify] failed to persist oauth state:", error);
    return c.json({ error: "Could not start Shopify sign-in." }, 500);
  }

  let consentUrl: string;
  try {
    consentUrl = buildConsentUrl(shop, state);
  } catch (err) {
    console.error("[flipdesk-shopify] could not build consent URL:", err);
    return c.json({ error: "Shopify is not configured on this server." }, 503);
  }
  console.log(`[flipdesk-shopify] consent URL built: host=${shop}`);
  return c.json({ consent_url: consentUrl });
});

// ── OAuth: callback (PUBLIC) ───────────────────────────────────────
flipdeskShopifyRoutes.get("/oauth/callback", async (c) => {
  if (!isShopifyConfigured()) {
    return c.json({ error: "Shopify is not configured on this server." }, 503);
  }

  const url = new URL(c.req.url);
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  const code = query.code;
  const state = query.state;
  const shop = normalizeShopDomain(query.shop);

  // Read + delete the single-use state row up front so a replay can't reuse it,
  // and so every exit path bounces back to the same claimed destination.
  let redirectTo: string | null = null;
  let stateUserId: string | null = null;
  let stateFound = false;
  let stateExpired = false;
  if (state) {
    const { data: stateRow } = await supabaseAdmin
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .eq("marketplace", "shopify")
      .select("user_id, redirect_to, expires_at")
      .maybeSingle();
    if (stateRow) {
      stateFound = true;
      redirectTo = sanitizeRelativePath(stateRow.redirect_to);
      stateUserId = stateRow.user_id;
      stateExpired = new Date(stateRow.expires_at).getTime() < Date.now();
    }
  }

  const finish = (status: string) => {
    const base = redirectTo ?? "/dashboard/flipdesk/marketplaces";
    const sep = base.includes("?") ? "&" : "?";
    return c.redirect(appUrl(`${base}${sep}shopify=${encodeURIComponent(status)}`));
  };

  // Verify Shopify's HMAC over the query BEFORE trusting shop/code — this is
  // what authenticates the request as genuinely from Shopify.
  if (!(await verifyOAuthHmac(query))) {
    console.error("[flipdesk-shopify] OAuth callback HMAC verification failed");
    return finish("invalid_signature");
  }
  if (!code || !state || !shop) {
    return finish("cancelled");
  }
  if (!stateFound || !stateUserId) {
    return finish("invalid_state");
  }
  if (stateExpired) {
    return finish("state_expired");
  }

  try {
    const tokens = await exchangeCodeForToken(shop, code);
    const info = await getShopInfo(shop, tokens.access_token);
    await upsertShopifyConnection({
      userId: stateUserId,
      shop,
      accessToken: tokens.access_token,
      scope: tokens.scope,
      externalAccountId: info?.id ?? null,
    });
    // US-711: subscribe the order/inventory/product webhooks so sales flow back
    // without polling. Best-effort — a registration hiccup must not fail the
    // connect (the manual /listings/pull still reconciles), and Shopify dedupes
    // a re-registration on reconnect.
    try {
      const { registered, errors: regErrors } = await registerShopifyWebhooks(
        shop,
        tokens.access_token,
        getShopifyWebhookUrl(),
      );
      console.log(
        `[flipdesk-shopify] webhooks registered for ${shop}: [${registered.join(", ")}]` +
          (regErrors.length ? ` errors=[${regErrors.join(" | ")}]` : ""),
      );
    } catch (regErr) {
      console.error(
        "[flipdesk-shopify] webhook registration failed (continuing):",
        regErr instanceof Error ? regErr.message : String(regErr),
      );
    }
  } catch (err) {
    console.error("[flipdesk-shopify] OAuth exchange failed:", err);
    return finish("exchange_failed");
  }

  return finish("connected");
});

// ── Disconnect ─────────────────────────────────────────────────────
// Shopify offline tokens are revoked by uninstalling the app from the store;
// there's no token-revocation endpoint, so we deactivate + null the stored
// token locally. Tenant-scoped to the workspace owner.
flipdeskShopifyRoutes.post("/disconnect", async (c) => {
  // US-2351 AC3: an impersonating admin must not sever a seller's
  // marketplace link — the disconnect would read as the seller's own.
  const blocked = await refuseWhileImpersonating(c, "Disconnecting a marketplace");
  if (blocked) return blocked;
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  // US-1616 / C3: marketplace disconnect is a workspace-wide teardown — admin only.
  if (!roleAtLeast(c.get("workspaceRole") ?? "owner", "admin")) {
    return c.json({ error: "This action requires admin access or higher" }, 403);
  }

  const { error } = await supabaseAdmin
    .from("marketplace_connections")
    .update({
      is_active: false,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      refresh_error: "disconnected",
    })
    .eq("user_id", userId)
    .eq("marketplace", "shopify");
  if (error) {
    return c.json({ error: "Could not disconnect Shopify." }, 500);
  }
  return c.json({ ok: true });
});

// ── Sync (pull) ────────────────────────────────────────────────────
// One button does the round-trip, mirroring eBay's /listings/pull:
//   1. Status-refresh every active Shopify listing (delete-on-Shopify /
//      archived → mark ended locally).
//   2. Ingest PAID orders → mark matching listings sold, create the sale row,
//      auto-end cross-listing siblings, and write a payout_imports row so the
//      (marketplace-agnostic) Reconciliation queue can match it.
const STATUS_REFRESH_CAP = 200;

flipdeskShopifyRoutes.post("/listings/pull", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const conn = await getShopifyConnection(userId);
  if (!conn) {
    return c.json({ error: "Connect your Shopify store first." }, 400);
  }

  let listingsSynced = 0;
  let ended = 0;
  let salesNew = 0;
  let payoutsNew = 0;
  const errors: string[] = [];

  // 1 ── status refresh of active Shopify listings ──────────────────
  const { data: activeRows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_listing_id, inventory_item_id, inventory_items!inner(user_id)",
    )
    .eq("platform", "shopify")
    .eq("is_active", true)
    .eq("inventory_items.user_id", userId)
    .not("platform_listing_id", "is", null)
    .limit(STATUS_REFRESH_CAP);
  for (
    const row of (activeRows ?? []) as unknown as Array<{
      id: string;
      platform_listing_id: string | null;
      inventory_item_id: string | null;
    }>
  ) {
    if (!row.platform_listing_id) continue;
    try {
      const status = await getProductStatus(
        conn.shop,
        conn.token,
        row.platform_listing_id,
      );
      listingsSynced++;
      // Deleted on Shopify ("gone") or no longer "active" (archived/draft) →
      // mark the local row ended. A null status (transient read failure) or a
      // genuinely active product is left untouched.
      const goneOrInactive = status === "gone" ||
        (status !== null && status.status != null && status.status !== "active");
      if (goneOrInactive) {
        await supabaseAdmin
          .from("listings")
          .update({ listing_status: "ended", is_active: false })
          .eq("id", row.id);
        // US-2179: release the item's activeListings slot once nothing is live.
        // This sync only ever ended the listing row, so an item whose Shopify
        // listing disappeared stayed 'listed' indefinitely — permanently holding
        // a cap slot the seller no longer had a listing for.
        await resyncItemListedStatus(row.inventory_item_id, userId);
        ended++;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // 2 ── order ingest (reconciliation feed) ─────────────────────────
  const { data: connRow } = await supabaseAdmin
    .from("marketplace_connections")
    .select("last_synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "shopify")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastSynced =
    (connRow as { last_synced_at: string | null } | null)?.last_synced_at ??
      null;
  // Default to a 90-day backfill on the first sync.
  const sinceIso = lastSynced ??
    new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();

  // US-711: the per-order sale-capture logic lives in the shared ingest so this
  // pull and the live orders webhook can't drift. US-1427: `ingest.ok` is false
  // only on a FATAL fetch/ingest failure — used below to gate the watermark.
  const ingest = await ingestPaidOrdersSince(
    userId,
    conn.shop,
    conn.token,
    sinceIso,
  );
  salesNew += ingest.salesNew;
  payoutsNew += ingest.payoutsNew;
  errors.push(...ingest.errors);

  // US-1427: stamp the sync time so the next pull only fetches new orders —
  // but ONLY when the order fetch+ingest completed without a fatal error.
  // Advancing last_synced_at past orders we never ingested (e.g. a transient
  // Shopify outage) would permanently skip every paid order in this window on
  // the next pull, so on failure we leave the prior watermark in place.
  if (ingest.ok) {
    await supabaseAdmin
      .from("marketplace_connections")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("marketplace", "shopify");
  }

  return c.json({
    ok: ingest.ok,
    listings_synced: listingsSynced,
    ended,
    sales_new: salesNew,
    payouts_new: payoutsNew,
    errors,
  });
});
