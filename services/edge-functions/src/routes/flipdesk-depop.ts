import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { roleAtLeast } from "../lib/workspace-roles.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import {
  buildConsentUrl,
  codeChallengeS256,
  exchangeCodeForToken,
  generateCodeVerifier,
  getDepopConnection,
  isDepopEnabled,
  refreshExpiringDepopConnections,
  upsertDepopConnection,
} from "../lib/depop-client.ts";
import {
  getDepopShop,
  getSellerAddresses,
  getShippingProviders,
  listDepopOrders,
  markDepopParcelShipped,
} from "../lib/depop-api.ts";
import { handleDepopOrderEvent } from "../lib/depop-orders.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";

// Depop Selling API endpoints (US-713). Mounted at /api/flipdesk/depop.
//
// The ENTIRE module is gated behind isDepopEnabled() (DEPOP_ENABLED + creds):
// while partner access is pending (US-712), every endpoint 503s, so there is no
// fake connect flow. Flip the flag on once Depop grants access + sandbox keys.
//
// Auth split mirrors the eBay/Shopify modules:
//   - /oauth/start    → user-authed (initiates from inside the app)
//   - /oauth/callback → public (Depop redirects the browser here unauthed; the
//                       single-use `state` row identifies the user and carries
//                       the PKCE verifier, and the auth code is useless without
//                       the verifier)
//   - /oauth/refresh  → internal job secret (shared token-refresh cron)
//   - /disconnect     → user-authed via main.ts middleware

type DepopEnv = {
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

export const flipdeskDepopRoutes = new Hono<DepopEnv>();

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

const DISABLED_BODY = {
  error: "Depop is not available yet — partner access is pending.",
};

// ── OAuth: start ───────────────────────────────────────────────────
// Generates a PKCE verifier + state, enforces the marketplace-connection cap,
// persists a single-use state row carrying the verifier, and returns the consent
// URL for the SPA to redirect to.
flipdeskDepopRoutes.get("/oauth/start", async (c) => {
  if (!isDepopEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const redirectTo = sanitizeRelativePath(c.req.query("redirect_to"));

  // US-382: enforce the marketplace-connection cap. A reconnect of an existing
  // Depop shop must NOT count as a new marketplace (it updates the same row).
  const { count: activeDepop } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("marketplace", "depop")
    .eq("is_active", true);
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "marketplaces", delta: (activeDepop ?? 0) > 0 ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const { error } = await supabaseAdmin.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace: "depop",
    redirect_to: redirectTo,
    code_verifier: codeVerifier,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) {
    console.error("[flipdesk-depop] failed to persist oauth state:", error);
    return c.json({ error: "Could not start Depop sign-in." }, 500);
  }

  let consentUrl: string;
  try {
    const challenge = await codeChallengeS256(codeVerifier);
    consentUrl = buildConsentUrl(state, challenge);
  } catch (err) {
    console.error("[flipdesk-depop] could not build consent URL:", err);
    return c.json({ error: "Depop is not configured on this server." }, 503);
  }
  return c.json({ consent_url: consentUrl });
});

// ── OAuth: callback (PUBLIC) ───────────────────────────────────────
flipdeskDepopRoutes.get("/oauth/callback", async (c) => {
  if (!isDepopEnabled()) return c.json(DISABLED_BODY, 503);

  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  // Read + delete the single-use state row up front so a replay can't reuse it,
  // and so every exit path bounces back to the same claimed destination.
  let redirectTo: string | null = null;
  let stateUserId: string | null = null;
  let codeVerifier: string | null = null;
  let stateFound = false;
  let stateExpired = false;
  if (state) {
    const { data: stateRow } = await supabaseAdmin
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .eq("marketplace", "depop")
      .select("user_id, redirect_to, code_verifier, expires_at")
      .maybeSingle();
    if (stateRow) {
      const sr = stateRow as {
        user_id: string;
        redirect_to: string | null;
        code_verifier: string | null;
        expires_at: string;
      };
      stateFound = true;
      redirectTo = sanitizeRelativePath(sr.redirect_to);
      stateUserId = sr.user_id;
      codeVerifier = sr.code_verifier;
      stateExpired = new Date(sr.expires_at).getTime() < Date.now();
    }
  }

  const finish = (status: string) => {
    const base = redirectTo ?? "/dashboard/flipdesk/marketplaces";
    const sep = base.includes("?") ? "&" : "?";
    return c.redirect(appUrl(`${base}${sep}depop=${encodeURIComponent(status)}`));
  };

  if (oauthError) {
    console.warn(`[flipdesk-depop] OAuth callback returned error=${oauthError}`);
    return finish("cancelled");
  }
  if (!code || !state) return finish("cancelled");
  if (!stateFound || !stateUserId || !codeVerifier) return finish("invalid_state");
  if (stateExpired) return finish("state_expired");

  try {
    const tokens = await exchangeCodeForToken(code, codeVerifier);
    // US-714: best-effort capture the seller's shop identity so inbound order
    // webhooks (which carry a seller id, not a token) can resolve the owner. A
    // failure here must not fail the connect — the token is still good.
    let accountHandle: string | null = null;
    let externalAccountId: string | null = null;
    try {
      const shop = await getDepopShop(tokens.access_token);
      accountHandle = shop.username;
      externalAccountId = shop.id;
    } catch (err) {
      console.warn(
        "[flipdesk-depop] could not resolve shop identity at connect (continuing):",
        err instanceof Error ? err.message : String(err),
      );
    }
    await upsertDepopConnection({
      userId: stateUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresInSeconds: tokens.expires_in,
      scope: tokens.scope ?? "",
      accountHandle,
      externalAccountId,
    });
  } catch (err) {
    console.error("[flipdesk-depop] OAuth exchange failed:", err);
    return finish("exchange_failed");
  }

  return finish("connected");
});

// ── OAuth: refresh (internal cron) ─────────────────────────────────
// The shared token-refresh worker hits this alongside eBay's /oauth/refresh
// (US-713 AC#2). No-op while the connector is disabled.
flipdeskDepopRoutes.post("/oauth/refresh", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const summary = await refreshExpiringDepopConnections();
  return c.json(summary);
});

// ── Disconnect ─────────────────────────────────────────────────────
// Deactivate + null the stored tokens locally. Tenant-scoped to the owner.
flipdeskDepopRoutes.post("/disconnect", async (c) => {
  // US-2351 AC3: an impersonating admin must not sever a seller's
  // marketplace link — the disconnect would read as the seller's own.
  const blocked = await refuseWhileImpersonating(c, "Disconnecting a marketplace");
  if (blocked) return blocked;
  if (!isDepopEnabled()) return c.json(DISABLED_BODY, 503);
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
    .eq("marketplace", "depop");
  if (error) {
    return c.json({ error: "Could not disconnect Depop." }, 500);
  }
  return c.json({ ok: true });
});

// ── Order sync (manual trigger) ────────────────────────────────────
// Pulls recent Depop orders → sale rows + cross-platform auto-delist (US-564).
// The same ingest the webhook runs, callable on demand (reconciliation refresh).
flipdeskDepopRoutes.post("/sync", async (c) => {
  if (!isDepopEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const conn = await getDepopConnection(userId);
  if (!conn) return c.json({ error: "Connect your Depop shop first." }, 400);

  try {
    const orders = await listDepopOrders(conn.token);
    let salesNew = 0;
    let soldFlipped = 0;
    // US-2324: per-record isolation, and per-record errors that SURVIVE.
    //
    // Two defects lived in the old three-line loop. First, handleDepopOrderEvent
    // never throws — it collects failures into `res.errors`, and nothing read
    // them, so a order that failed to write was indistinguishable from one
    // that succeeded and the response still said ok:true. Second, there was no
    // per-record try/catch, so an unexpected throw at order 200 abandoned
    // 201-500; and because this sync has no cursor and always restarts from the
    // beginning, the next run hits the same poison record and dies in the same
    // place, forever.
    //
    // The catch is INSIDE the loop for that reason: one bad record must cost
    // that record, not the tail behind it.
    const failures: string[] = [];
    for (const order of orders) {
      try {
        const res = await handleDepopOrderEvent(userId, order);
        salesNew += res.salesNew;
        soldFlipped += res.soldFlipped;
        for (const e of res.errors) failures.push(e);
      } catch (err) {
        failures.push(
          `order failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // The watermark only advances on a CLEAN pass. Stamping it after partial
    // failures is what turns "some records did not land" into "they never
    // will" — the shape US-2320 removed from the eBay orders sync.
    if (failures.length === 0) {
      await supabaseAdmin
        .from("marketplace_connections")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("marketplace", "depop");
    } else {
      console.error(
        `[flipdesk-depop] order sync completed with ${failures.length} failure(s):`,
        failures.slice(0, 10),
      );
    }
    return c.json({
      // `ok` is now a claim about the WHOLE pass, not about reaching the end
      // of it. A caller that only checks ok:true still gets the truth.
      ok: failures.length === 0,
      orders: orders.length,
      sales_new: salesNew,
      sold_flipped: soldFlipped,
      failed: failures.length,
      errors: failures.slice(0, 20),
      partial: failures.length > 0,
    });
  } catch (err) {
    console.error("[flipdesk-depop] order sync failed:", err);
    return c.json({ error: "Depop order sync failed." }, 502);
  }
});

// ── Fulfillment setup helpers ──────────────────────────────────────
// Seller addresses + their shipping providers, used when wiring mark-as-shipped
// (Depop requires a provider for some parcels). Tenant-scoped via the owner's
// connection token.
flipdeskDepopRoutes.get("/seller-addresses", async (c) => {
  if (!isDepopEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const conn = await getDepopConnection(userId);
  if (!conn) return c.json({ error: "Connect your Depop shop first." }, 400);

  try {
    const addresses = await getSellerAddresses(conn.token);
    const withProviders = await Promise.all(
      addresses.map(async (a) => ({
        ...a,
        providers: await getShippingProviders(conn.token, a.id).catch(() => []),
      })),
    );
    return c.json({ addresses: withProviders });
  } catch (err) {
    console.error("[flipdesk-depop] seller-addresses failed:", err);
    return c.json({ error: "Could not load Depop shipping setup." }, 502);
  }
});

// ── Mark a sale shipped (US-714 AC2) ───────────────────────────────
// POST /orders/:saleId/ship — resolves the Depop purchase_id + parcel_id stashed
// on the sale (platform_order_ref, migration 00176), calls Depop's
// mark-as-shipped, then records shipped_at + tracking locally. Tenant-scoped: the
// sale is loaded THROUGH inventory_items.user_id, never by a raw id.
flipdeskDepopRoutes.post("/orders/:saleId/ship", async (c) => {
  if (!isDepopEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const saleId = c.req.param("saleId");

  let body: { tracking_number?: unknown; shipping_provider_id?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const trackingNumber = typeof body.tracking_number === "string" ? body.tracking_number : null;
  const shippingProviderId =
    typeof body.shipping_provider_id === "string" ? body.shipping_provider_id : null;

  // Tenant-scoped load (US-268): the sale must belong to the owner.
  const { data: saleRow } = await supabaseAdmin
    .from("sales")
    .select("id, platform_order_ref, inventory_items!inner(user_id)")
    .eq("id", saleId)
    .eq("inventory_items.user_id", userId)
    .maybeSingle();
  const sale = saleRow as
    | {
      id: string;
      platform_order_ref:
        | { platform?: string; purchase_id?: string; parcel_id?: string | null }
        | null;
    }
    | null;
  if (!sale) return c.json({ error: "Sale not found." }, 404);

  const ref = sale.platform_order_ref;
  if (!ref || ref.platform !== "depop" || !ref.purchase_id) {
    return c.json({ error: "This sale has no Depop order to mark shipped." }, 409);
  }
  if (!ref.parcel_id) {
    return c.json(
      { error: "Depop hasn't issued a parcel for this order yet — try again once it has." },
      409,
    );
  }

  const conn = await getDepopConnection(userId);
  if (!conn) return c.json({ error: "Depop is not connected." }, 400);

  try {
    await markDepopParcelShipped(conn.token, ref.purchase_id, ref.parcel_id, {
      trackingNumber,
      shippingProviderId,
    });
  } catch (err) {
    console.error("[flipdesk-depop] mark-as-shipped failed:", err);
    return c.json({ error: "Depop mark-as-shipped failed." }, 502);
  }

  // The sale stays 'completed' (the sales.status CHECK allows only
  // completed/cancelled/refunded/pending); "shipped" is recorded via shipped_at.
  const { error: updErr } = await supabaseAdmin
    .from("sales")
    .update({
      shipped_at: new Date().toISOString(),
      ...(trackingNumber ? { tracking_number: trackingNumber } : {}),
    })
    .eq("id", sale.id);
  if (updErr) {
    console.error("[flipdesk-depop] sale ship write-back failed:", updErr.message);
  }
  return c.json({ ok: true });
});
