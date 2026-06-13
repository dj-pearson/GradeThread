import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import {
  buildConsentUrl,
  codeChallengeS256,
  exchangeCodeForToken,
  generateCodeVerifier,
  isDepopEnabled,
  refreshExpiringDepopConnections,
  upsertDepopConnection,
} from "../lib/depop-client.ts";

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
    await upsertDepopConnection({
      userId: stateUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresInSeconds: tokens.expires_in,
      scope: tokens.scope ?? "",
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
  if (!isDepopEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

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
