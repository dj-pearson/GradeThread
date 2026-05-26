import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  buildConsentUrl,
  createOffer,
  createOrReplaceInventoryItem,
  ebayListingUrl,
  exchangeCodeForTokens,
  getCategoryAspects,
  getDefaultPolicies,
  getMarketplaceId,
  getUserAccessToken,
  isEbayConfigured,
  isOfferAlreadyExistsError,
  listOffersForSku,
  publishOffer,
  searchBrowseComps,
  suggestCategories,
  upsertConnection,
  type PolicySet,
} from "../lib/ebay-client.ts";

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

  return c.json({ consent_url: buildConsentUrl(state) });
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

  // eBay sends `error=access_denied` when the user cancels at the consent
  // screen. Treat that as a graceful return to the app.
  if (ebayError || !code || !state) {
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

flipdeskEbayRoutes.post("/listings/pull", (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  return c.json({ error: "Not implemented" }, 501);
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

flipdeskEbayRoutes.delete("/listings/:listingId", (c) => {
  return c.json({ error: "Not implemented" }, 501);
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
