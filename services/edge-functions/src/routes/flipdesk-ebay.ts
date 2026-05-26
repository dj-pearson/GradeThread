import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  buildConsentUrl,
  exchangeCodeForTokens,
  getCategoryAspects,
  getUserAccessToken,
  isEbayConfigured,
  suggestCategories,
  upsertConnection,
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

flipdeskEbayRoutes.post("/listings/push", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

flipdeskEbayRoutes.post("/listings/validate", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

flipdeskEbayRoutes.delete("/listings/:listingId", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

flipdeskEbayRoutes.post("/payouts/import-csv", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

flipdeskEbayRoutes.get("/comps", (c) => {
  return c.json({ error: "Not implemented" }, 501);
});

// ── Helpers ─────────────────────────────────────────────────────────

// Random URL-safe state token for CSRF + replay protection.
function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
