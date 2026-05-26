import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  buildConsentUrl,
  createOffer,
  createOrReplaceInventoryItem,
  debugSnapshot,
  ebayListingUrl,
  exchangeCodeForTokens,
  getCategoryAspects,
  getDefaultPolicies,
  getMarketplaceId,
  getUserAccessToken,
  isEbayConfigured,
  isOfferAlreadyExistsError,
  listAllOffers,
  listOffersForSku,
  listRecentOrders,
  publishOffer,
  searchBrowseComps,
  suggestCategories,
  updateOfferPrice,
  upsertConnection,
  withdrawOffer,
  type PolicySet,
  type RemoteOffer,
  type RemoteOrder,
} from "../lib/ebay-client.ts";
import {
  getAllActiveEbaySelling,
  type LegacyEbayListing,
} from "../lib/ebay-trading.ts";

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

type EbayEnv = { Variables: { userId: string } };

export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// ── Diagnostics ────────────────────────────────────────────────────
// GET /oauth/debug — returns a sanitized snapshot of how the edge service
// resolved the eBay env vars. No secrets. Use this to spot sandbox/prod
// mismatches and whitespace problems without grepping Coolify settings.
flipdeskEbayRoutes.get("/oauth/debug", (c) => {
  return c.json(debugSnapshot());
});

// ── OAuth: start ───────────────────────────────────────────────────
// Returns { consent_url } for the SPA to window.location to. The state
// token is persisted server-side so the callback can verify+identify.
flipdeskEbayRoutes.get("/oauth/start", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("userId");
  const redirectTo = c.req.query("redirect_to") ?? null;

  const state = generateState();
  const { error } = await supabaseAdmin.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace: "ebay",
    redirect_to: redirectTo,
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
    await upsertConnection({
      userId: stateRow.user_id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresInSeconds: tokens.expires_in,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] OAuth exchange failed:", err);
    return c.redirect(
      appUrl("/dashboard/flipdesk/marketplaces?ebay=exchange_failed")
    );
  }

  const dest =
    typeof stateRow.redirect_to === "string" && stateRow.redirect_to
      ? stateRow.redirect_to
      : "/dashboard/flipdesk/marketplaces?ebay=connected";
  return c.redirect(appUrl(dest));
});

// ── OAuth: refresh ─────────────────────────────────────────────────
// Scheduled job entrypoint. Authenticated via FLIPDESK_INTERNAL_JOB_SECRET
// header so the cron worker can hit it without a user Bearer token. Rotates
// any token expiring in the next 24 hours.
flipdeskEbayRoutes.post("/oauth/refresh", async (c) => {
  const expected = Deno.env.get("FLIPDESK_INTERNAL_JOB_SECRET");
  const provided = c.req.header("X-Internal-Job-Secret");
  if (!expected || !provided || provided !== expected) {
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
    }
  }
  return c.json({ scanned: userIds.length, refreshed, failed });
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
flipdeskEbayRoutes.post("/listings/pull", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("userId");

  // Make sure there's an active connection — getUserAccessToken otherwise
  // returns a confusing "no active connection" error. We also capture
  // last_synced_at NOW so the orders sync can use it as the lower bound.
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
  const lastSyncedAt =
    (conn as { last_synced_at: string | null }).last_synced_at ?? null;

  let offers: RemoteOffer[];
  try {
    offers = await listAllOffers(userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] listings/pull fetch failed:", msg);
    // Pass the eBay error detail through to the client. Sandbox needs this
    // for debugging — typical failures are missing-scope (reconnect) and
    // sandbox-seller-not-onboarded errors that name themselves clearly.
    return c.json(
      {
        error: "Could not load offers from eBay.",
        detail: msg.slice(0, 800),
      },
      502
    );
  }

  // Pre-load this user's SKU → inventory_item mapping so we can do the
  // join in memory rather than N+1 queries against Supabase.
  const { data: itemsBySku } = await supabaseAdmin
    .from("inventory_items")
    .select("id, sku")
    .eq("user_id", userId)
    .not("sku", "is", null);
  const skuToItemId = new Map<string, string>();
  for (const r of (itemsBySku ?? []) as Array<{ id: string; sku: string }>) {
    if (r.sku) skuToItemId.set(r.sku, r.id);
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

  // ── Orders sync (sold-state detection) ──────────────────────────
  // Pulls orders modified since last_synced_at (or 90 days on first sync).
  // Each line item's SKU is matched to inventory_items.sku; matches turn
  // into a sales row + flip inventory_items.status='sold'.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  const sinceISO = lastSyncedAt ?? ninetyDaysAgo;

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
          const itemId = sku ? skuToItemId.get(sku) ?? null : null;
          if (!itemId) {
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

  // Stamp last_synced_at so the UI can show "Synced 2m ago" + the next
  // /listings/pull picks up where this one left off.
  await supabaseAdmin
    .from("marketplace_connections")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", (conn as { id: string }).id);

  return c.json({
    ok: true,
    total: offers.length,
    matched,
    unmatched,
    skipped,
    legacy_matched: legacyMatched,
    legacy_unmatched: legacyUnmatched,
    legacy_duplicates: legacyDuplicates,
    sales_new: salesNew,
    sales_updated: salesUpdated,
    sales_skipped: salesSkipped,
    since: sinceISO,
    errors,
  });
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
  const userId = c.get("userId");
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

flipdeskEbayRoutes.delete("/listings/:id", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("userId");
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
  const userId = c.get("userId");
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

flipdeskEbayRoutes.post("/listings/push", async (c) => {
  const userId = c.get("userId");
  const itemId = await readItemId(c);
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);

  const ctx = await assemblePublishContext(userId, itemId);
  if (!ctx.ok) return c.json(ctx.error, ctx.status);
  if (ctx.blockers.length > 0 || !ctx.policies) {
    return c.json(
      {
        ok: false,
        blockers: ctx.blockers.length > 0
          ? ctx.blockers
          : ["eBay business policies are not configured."],
      },
      422
    );
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
    // 2. Push inventory_item (idempotent PUT).
    await createOrReplaceInventoryItem(userId, sku, {
      product: {
        title: ctx.summary.title,
        description: ctx.summary.description,
        aspects:
          (item.ebay_aspects as Record<string, string[]> | null) ?? undefined,
        imageUrls: photos.map((p) => p.public_url),
        brand:
          typeof item.brand === "string" && item.brand.trim()
            ? item.brand.trim()
            : undefined,
      },
      condition: ctx.summary.condition,
      conditionDescription:
        ctx.summary.conditionDescription || undefined,
      availability: { shipToLocationAvailability: { quantity: 1 } },
    });

    // 3. Create or reuse an offer for this SKU.
    let offerId: string;
    try {
      const created = await createOffer(userId, {
        sku,
        marketplaceId: getMarketplaceId(),
        format: "FIXED_PRICE",
        availableQuantity: 1,
        categoryId: item.ebay_category_id as string,
        listingDescription: ctx.summary.description,
        listingPolicies: {
          fulfillmentPolicyId: policies.fulfillmentPolicyId,
          paymentPolicyId: policies.paymentPolicyId,
          returnPolicyId: policies.returnPolicyId,
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
      const existing = await listOffersForSku(userId, sku);
      const found = existing.find((o) => !!o.offerId);
      if (!found) throw err;
      offerId = found.offerId;
    }

    // 4. Publish.
    const published = await publishOffer(userId, offerId);
    const listingId = published.listingId;
    const url = ebayListingUrl(listingId);

    // 5. Persist the live state. Upsert the listings row so a re-publish
    //    of the same item points at the new eBay listingId.
    const listingPayload = {
      inventory_item_id: itemId,
      platform: "ebay" as const,
      platform_listing_id: listingId,
      platform_offer_id: offerId,
      listing_url: url,
      listing_price: Number(ctx.summary.priceValue),
      listing_title: ctx.summary.title,
      listing_description: ctx.summary.description,
      listing_status: "active" as const,
      is_active: true,
      listed_at: new Date().toISOString(),
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

    return c.json({
      ok: true,
      listing_id: listingId,
      listing_url: url,
      offer_id: offerId,
      sku,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] publish failed:", msg);
    return c.json(
      { ok: false, error: "Publish failed", detail: msg.slice(0, 1000) },
      502
    );
  }
});

flipdeskEbayRoutes.post("/payouts/import-csv", (c) => {
  return c.json({ error: "Not implemented" }, 501);
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
  const row = data as ListingRowForManage & {
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
  list_price: number | null;
  grade_value: number | null;
  grade_label: string | null;
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  status: string;
}

interface PublishListing {
  id: string;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
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
  };
}

interface PublishContextErr {
  ok: false;
  error: { error: string };
  status: 400 | 404 | 503;
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

  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, sku, size, description, condition_notes, target_price, list_price, grade_value, grade_label, ebay_category_id, ebay_aspects, status"
    )
    .eq("id", itemId)
    .maybeSingle();
  if (!itemRow || (itemRow as PublishItem).user_id !== userId) {
    return { ok: false, error: { error: "Item not found" }, status: 404 };
  }
  const item = itemRow as PublishItem;

  // Most recent eBay-platform listing draft for this item (if any).
  const { data: listingRow } = await supabaseAdmin
    .from("listings")
    .select("id, listing_title, listing_description, listing_price")
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
  if (!item.ebay_category_id) blockers.push("Pick an eBay category.");
  const aspectMap = (item.ebay_aspects as Record<string, string[]> | null) ?? {};
  let requiredMissing: string[] = [];
  if (item.ebay_category_id) {
    try {
      const aspectsResp = await getCategoryAspects(item.ebay_category_id);
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

  const priceNumber = item.target_price ?? item.list_price ?? listing?.listing_price ?? null;
  if (!priceNumber || priceNumber <= 0) {
    blockers.push("Set a target price.");
  }

  const title = (listing?.listing_title ?? item.title ?? "").trim();
  if (!title) blockers.push("Set a title.");

  // Look up policies last — only blocks if everything else is ready, but
  // surface the missing prereqs as part of `blockers` either way.
  let policies: PolicySet | null = null;
  try {
    const policyResult = await getDefaultPolicies(userId);
    if ("missing" in policyResult) {
      blockers.push(
        `Configure eBay business policies on your seller account: ${policyResult.missing.join(", ")}.`
      );
    } else {
      policies = policyResult;
    }
  } catch (err) {
    console.error("[flipdesk-ebay] policy lookup:", err);
    blockers.push("Could not load your eBay business policies. Try again.");
  }

  const description = (listing?.listing_description ?? item.description ?? title).trim() ||
    title;
  const sku = item.sku && item.sku.trim() ? item.sku.trim() : `FD-${item.id.slice(0, 8)}`;
  const condition = mapEbayCondition(item.grade_value, item.grade_label);
  const conditionDescription = item.condition_notes?.trim() ?? "";

  const summary: PublishContextOk["summary"] = {
    title,
    description,
    priceValue: priceNumber ? priceNumber.toFixed(2) : "0.00",
    currency: "USD",
    condition,
    conditionDescription,
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
