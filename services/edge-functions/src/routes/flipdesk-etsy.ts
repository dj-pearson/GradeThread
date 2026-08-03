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
  getEtsyConnection,
  isEtsyEnabled,
  refreshExpiringEtsyConnections,
  upsertEtsyConnection,
} from "../lib/etsy-client.ts";
import {
  getEtsyShippingProfiles,
  getEtsyShopIdentity,
  listEtsyReceipts,
} from "../lib/etsy-api.ts";
import { handleEtsyReceiptEvent } from "../lib/etsy-orders.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";

// Etsy Open API v3 endpoints (US-1659). Mounted at /api/flipdesk/etsy.
//
// The ENTIRE module is gated behind isEtsyEnabled() (ETSY_ENABLED + keystring):
// while the app awaits Etsy's commercial-scope approval, every endpoint 503s, so
// there is no fake connect flow. Flip the flag on once Etsy grants access.
//
// Auth split mirrors the eBay/Shopify/Depop modules (main.ts applies the auth +
// workspace middleware to the specific paths; /oauth/callback and /oauth/refresh
// are intentionally NOT in that allowlist):
//   - /oauth/start    → user-authed (initiates from inside the app)
//   - /oauth/callback → public (Etsy redirects the browser here unauthed; the
//                       single-use `state` row identifies the user and carries
//                       the PKCE verifier, and the auth code is useless without
//                       the verifier)
//   - /oauth/refresh  → internal job secret (shared token-refresh cron)
//   - /disconnect     → user-authed via main.ts middleware
//
// SECURITY (US-268): every marketplace_connections query is scoped to the
// workspace owner id; the callback resolves the user from the state row, never
// from a payload field.

type EtsyEnv = {
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

export const flipdeskEtsyRoutes = new Hono<EtsyEnv>();

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
  error: "Etsy is not available yet — app approval is pending.",
};

// ── OAuth: start ───────────────────────────────────────────────────
// Generates a PKCE verifier + state, enforces the marketplace-connection cap,
// persists a single-use state row carrying the verifier, and returns the consent
// URL for the SPA to redirect to.
flipdeskEtsyRoutes.get("/oauth/start", async (c) => {
  if (!isEtsyEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const redirectTo = sanitizeRelativePath(c.req.query("redirect_to"));

  // US-382: enforce the marketplace-connection cap. A reconnect of an existing
  // Etsy shop must NOT count as a new marketplace (it updates the same row).
  const { count: activeEtsy } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("marketplace", "etsy")
    .eq("is_active", true);
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "marketplaces", delta: (activeEtsy ?? 0) > 0 ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const { error } = await supabaseAdmin.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace: "etsy",
    redirect_to: redirectTo,
    code_verifier: codeVerifier,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) {
    console.error("[flipdesk-etsy] failed to persist oauth state:", error);
    return c.json({ error: "Could not start Etsy sign-in." }, 500);
  }

  let consentUrl: string;
  try {
    const challenge = await codeChallengeS256(codeVerifier);
    consentUrl = buildConsentUrl(state, challenge);
  } catch (err) {
    console.error("[flipdesk-etsy] could not build consent URL:", err);
    return c.json({ error: "Etsy is not configured on this server." }, 503);
  }
  return c.json({ consent_url: consentUrl });
});

// ── OAuth: callback (PUBLIC) ───────────────────────────────────────
flipdeskEtsyRoutes.get("/oauth/callback", async (c) => {
  if (!isEtsyEnabled()) return c.json(DISABLED_BODY, 503);

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
      .eq("marketplace", "etsy")
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
    return c.redirect(appUrl(`${base}${sep}etsy=${encodeURIComponent(status)}`));
  };

  if (oauthError) {
    console.warn(`[flipdesk-etsy] OAuth callback returned error=${oauthError}`);
    return finish("cancelled");
  }
  if (!code || !state) return finish("cancelled");
  if (!stateFound || !stateUserId || !codeVerifier) return finish("invalid_state");
  if (stateExpired) return finish("state_expired");

  try {
    const tokens = await exchangeCodeForToken(code, codeVerifier);
    // US-1660: best-effort capture the seller's shop identity so a later order
    // sync can resolve the owner. A failure here must not fail the connect — the
    // token is still good.
    let accountHandle: string | null = null;
    let externalAccountId: string | null = null;
    try {
      const shop = await getEtsyShopIdentity(tokens.access_token);
      accountHandle = shop.shopName;
      externalAccountId = shop.shopId;
    } catch (err) {
      console.warn(
        "[flipdesk-etsy] could not resolve shop identity at connect (continuing):",
        err instanceof Error ? err.message : String(err),
      );
    }
    await upsertEtsyConnection({
      userId: stateUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresInSeconds: tokens.expires_in,
      scope: tokens.scope ?? "",
      accountHandle,
      externalAccountId,
    });
  } catch (err) {
    console.error("[flipdesk-etsy] OAuth exchange failed:", err);
    return finish("exchange_failed");
  }

  return finish("connected");
});

// ── OAuth: refresh (internal cron) ─────────────────────────────────
// The shared token-refresh worker hits this alongside eBay/Depop /oauth/refresh.
// No-op while the connector is disabled.
flipdeskEtsyRoutes.post("/oauth/refresh", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const summary = await refreshExpiringEtsyConnections();
  return c.json(summary);
});

// ── Disconnect ─────────────────────────────────────────────────────
// Deactivate + null the stored tokens locally. Tenant-scoped to the owner.
flipdeskEtsyRoutes.post("/disconnect", async (c) => {
  // US-2351 AC3: an impersonating admin must not sever a seller's
  // marketplace link — the disconnect would read as the seller's own.
  const blocked = await refuseWhileImpersonating(c, "Disconnecting a marketplace");
  if (blocked) return blocked;
  if (!isEtsyEnabled()) return c.json(DISABLED_BODY, 503);
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
    .eq("marketplace", "etsy");
  if (error) {
    return c.json({ error: "Could not disconnect Etsy." }, 500);
  }
  return c.json({ ok: true });
});

// ── Receipt (order) sync (manual trigger) ──────────────────────────
// Pulls recent Etsy receipts → sale rows + cross-platform auto-delist (US-564).
// The same ingest a future webhook would run, callable on demand.
flipdeskEtsyRoutes.post("/sync", async (c) => {
  if (!isEtsyEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const conn = await getEtsyConnection(userId);
  if (!conn) return c.json({ error: "Connect your Etsy shop first." }, 400);
  if (!conn.shopId) return c.json({ error: "Your Etsy account has no shop." }, 409);

  try {
    const receipts = await listEtsyReceipts(conn.token, conn.shopId);
    let salesNew = 0;
    let soldFlipped = 0;
    // US-2324: per-record isolation, and per-record errors that SURVIVE.
    //
    // Two defects lived in the old three-line loop. First, handleEtsyReceiptEvent
    // never throws — it collects failures into `res.errors`, and nothing read
    // them, so a receipt that failed to write was indistinguishable from one
    // that succeeded and the response still said ok:true. Second, there was no
    // per-record try/catch, so an unexpected throw at receipt 200 abandoned
    // 201-500; and because this sync has no cursor and always restarts from the
    // beginning, the next run hits the same poison record and dies in the same
    // place, forever.
    //
    // The catch is INSIDE the loop for that reason: one bad record must cost
    // that record, not the tail behind it.
    const failures: string[] = [];
    for (const receipt of receipts) {
      try {
        const res = await handleEtsyReceiptEvent(userId, receipt);
        salesNew += res.salesNew;
        soldFlipped += res.soldFlipped;
        for (const e of res.errors) failures.push(e);
      } catch (err) {
        failures.push(
          `receipt failed: ${err instanceof Error ? err.message : String(err)}`,
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
        .eq("marketplace", "etsy");
    } else {
      console.error(
        `[flipdesk-etsy] receipt sync completed with ${failures.length} failure(s):`,
        failures.slice(0, 10),
      );
    }
    return c.json({
      // `ok` is now a claim about the WHOLE pass, not about reaching the end
      // of it. A caller that only checks ok:true still gets the truth.
      ok: failures.length === 0,
      receipts: receipts.length,
      sales_new: salesNew,
      sold_flipped: soldFlipped,
      failed: failures.length,
      errors: failures.slice(0, 20),
      partial: failures.length > 0,
    });
  } catch (err) {
    console.error("[flipdesk-etsy] receipt sync failed:", err);
    return c.json({ error: "Etsy receipt sync failed." }, 502);
  }
});

// ── Shipping-profile setup helper ──────────────────────────────────
// Etsy requires a shipping_profile_id on every physical listing. Surface the
// seller's profiles so the UI can confirm one exists before publishing.
// Tenant-scoped via the owner's connection token.
flipdeskEtsyRoutes.get("/shipping-profiles", async (c) => {
  if (!isEtsyEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const conn = await getEtsyConnection(userId);
  if (!conn) return c.json({ error: "Connect your Etsy shop first." }, 400);
  if (!conn.shopId) return c.json({ error: "Your Etsy account has no shop." }, 409);

  try {
    const profiles = await getEtsyShippingProfiles(conn.token, conn.shopId);
    return c.json({ profiles });
  } catch (err) {
    console.error("[flipdesk-etsy] shipping-profiles failed:", err);
    return c.json({ error: "Could not load Etsy shipping profiles." }, 502);
  }
});
