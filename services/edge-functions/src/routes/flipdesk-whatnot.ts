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
  isWhatnotEnabled,
  refreshExpiringWhatnotConnections,
  upsertWhatnotConnection,
} from "../lib/whatnot-client.ts";
import { getWhatnotShop } from "../lib/whatnot-api.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";

// Whatnot partner API endpoints (US-1661). Mounted at /api/flipdesk/whatnot.
//
// The ENTIRE module is gated behind isWhatnotEnabled() (WHATNOT_ENABLED + creds):
// while partner access is pending, every endpoint 503s, so there is no fake
// connect flow. Flip the flag on once Whatnot grants access.
//
// Auth split mirrors the eBay/Shopify/Depop/Etsy modules (main.ts applies the
// auth + workspace middleware to the specific paths; /oauth/callback and
// /oauth/refresh are intentionally NOT in that allowlist):
//   - /oauth/start    → user-authed
//   - /oauth/callback → public (Whatnot redirects the browser here unauthed; the
//                       single-use `state` row identifies the user + carries the
//                       PKCE verifier)
//   - /oauth/refresh  → internal job secret (shared token-refresh cron)
//   - /disconnect     → user-authed via main.ts middleware
//
// SECURITY (US-268): every marketplace_connections query is scoped to the
// workspace owner id; the callback resolves the user from the state row, never
// from a payload field.

type WhatnotEnv = {
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

export const flipdeskWhatnotRoutes = new Hono<WhatnotEnv>();

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
  error: "Whatnot is not available yet — partner access is pending.",
};

// ── OAuth: start ───────────────────────────────────────────────────
flipdeskWhatnotRoutes.get("/oauth/start", async (c) => {
  if (!isWhatnotEnabled()) return c.json(DISABLED_BODY, 503);
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const redirectTo = sanitizeRelativePath(c.req.query("redirect_to"));

  // US-382: enforce the marketplace-connection cap. A reconnect of an existing
  // Whatnot shop must NOT count as a new marketplace (it updates the same row).
  const { count: activeWhatnot } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("marketplace", "whatnot")
    .eq("is_active", true);
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "marketplaces", delta: (activeWhatnot ?? 0) > 0 ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const { error } = await supabaseAdmin.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace: "whatnot",
    redirect_to: redirectTo,
    code_verifier: codeVerifier,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) {
    console.error("[flipdesk-whatnot] failed to persist oauth state:", error);
    return c.json({ error: "Could not start Whatnot sign-in." }, 500);
  }

  let consentUrl: string;
  try {
    const challenge = await codeChallengeS256(codeVerifier);
    consentUrl = buildConsentUrl(state, challenge);
  } catch (err) {
    console.error("[flipdesk-whatnot] could not build consent URL:", err);
    return c.json({ error: "Whatnot is not configured on this server." }, 503);
  }
  return c.json({ consent_url: consentUrl });
});

// ── OAuth: callback (PUBLIC) ───────────────────────────────────────
flipdeskWhatnotRoutes.get("/oauth/callback", async (c) => {
  if (!isWhatnotEnabled()) return c.json(DISABLED_BODY, 503);

  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

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
      .eq("marketplace", "whatnot")
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
    return c.redirect(appUrl(`${base}${sep}whatnot=${encodeURIComponent(status)}`));
  };

  if (oauthError) {
    console.warn(`[flipdesk-whatnot] OAuth callback returned error=${oauthError}`);
    return finish("cancelled");
  }
  if (!code || !state) return finish("cancelled");
  if (!stateFound || !stateUserId || !codeVerifier) return finish("invalid_state");
  if (stateExpired) return finish("state_expired");

  try {
    const tokens = await exchangeCodeForToken(code, codeVerifier);
    let accountHandle: string | null = null;
    let externalAccountId: string | null = null;
    try {
      const shop = await getWhatnotShop(tokens.access_token);
      accountHandle = shop.username;
      externalAccountId = shop.id;
    } catch (err) {
      console.warn(
        "[flipdesk-whatnot] could not resolve shop identity at connect (continuing):",
        err instanceof Error ? err.message : String(err),
      );
    }
    await upsertWhatnotConnection({
      userId: stateUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresInSeconds: tokens.expires_in,
      scope: tokens.scope ?? "",
      accountHandle,
      externalAccountId,
    });
  } catch (err) {
    console.error("[flipdesk-whatnot] OAuth exchange failed:", err);
    return finish("exchange_failed");
  }

  return finish("connected");
});

// ── OAuth: refresh (internal cron) ─────────────────────────────────
flipdeskWhatnotRoutes.post("/oauth/refresh", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const summary = await refreshExpiringWhatnotConnections();
  return c.json(summary);
});

// ── Disconnect ─────────────────────────────────────────────────────
flipdeskWhatnotRoutes.post("/disconnect", async (c) => {
  // US-2351 AC3: an impersonating admin must not sever a seller's
  // marketplace link — the disconnect would read as the seller's own.
  //
  // This was MISSING while the five sibling modules all had it, and the reason
  // it survived is worth more than the fix. impersonation-bounds_test.ts
  // enumerates the guarded sites rather than asserting a blanket middleware,
  // and its own comment argues enumeration is safer because a middleware "would
  // silently permit anything it did not know about". The enumerated list then
  // silently permitted Whatnot, which landed after the list was written. A list
  // has the same blind spot it was chosen to avoid; what closes it is deriving
  // the expected set from the routes, which the test now does.
  const blocked = await refuseWhileImpersonating(c, "Disconnecting a marketplace");
  if (blocked) return blocked;
  if (!isWhatnotEnabled()) return c.json(DISABLED_BODY, 503);
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
    .eq("marketplace", "whatnot");
  if (error) {
    return c.json({ error: "Could not disconnect Whatnot." }, 500);
  }
  return c.json({ ok: true });
});
