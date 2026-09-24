// eBay routes: OAuth connect, callback, disconnect and token refresh.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { roleAtLeast } from "../lib/workspace-roles.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import {
  buildConsentUrl,
  debugSnapshot,
  exchangeCodeForTokens,
  getUserAccessToken,
  getUserIdentityFromToken,
  isEbayConfigured,
  revokeEbayUserToken,
  upsertConnection,
} from "../lib/ebay-client.ts";
// US-713: the Depop connector shares this token-refresh cron (no separate
// Coolify task). The sweep is a no-op while DEPOP_ENABLED is off.
import { refreshExpiringDepopConnections } from "../lib/depop-client.ts";
import { refreshExpiringEtsyConnections } from "../lib/etsy-client.ts";
import { refreshExpiringWhatnotConnections } from "../lib/whatnot-client.ts";
import { decryptToken } from "../lib/crypto-aes.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { pushTokenExpiring } from "../lib/transactional-push.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";
import { refuseMarketplaceChange } from "../lib/marketplace-admin-guard.ts";
import { EBAY_CONNECTION_SCAN_CAP, type EbayEnv } from "./flipdesk-ebay-shared.ts";
import { triggerEbaySyncForUser } from "./flipdesk-ebay-sync.ts";

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
  // MP-01: a GET skips blockViewerWrites, so without this a viewer could attach
  // their own eBay account to the owner's tenant.
  const refused = await refuseMarketplaceChange(c, c.get("workspaceRole"), "Connecting a marketplace");
  if (refused) return refused;
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
    // MP-12: every other code (invalid_scope, server_error, ...) is one status
    // the app knows how to word. Passing eBay's raw code through sent the
    // seller back to the page with no message at all.
    return finish(ebayError === "access_denied" ? "cancelled" : "provider_error");
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

  // US-3458: the seller's listings arrive on their own. Until this line the
  // connect stored tokens and stopped, and the first pull waited for a Sync
  // click nobody was told to make (or for the order backstop to reach the
  // account). Detached and best-effort: the connection is saved and the
  // redirect is the same whether or not the pull starts, and the lock in
  // triggerEbaySyncForUser refuses a duplicate if one is already running.
  void triggerEbaySyncForUser(stateUserId, "full")
    .then((status) => {
      console.log(`[flipdesk-ebay] first pull after connect: ${status}`);
    })
    .catch((err) => {
      console.error("[flipdesk-ebay] first pull after connect failed to start:", err);
    });

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
  // US-2351 AC3: an impersonating admin must not sever a seller's
  // marketplace link — the disconnect would read as the seller's own.
  const blocked = await refuseWhileImpersonating(c, "Disconnecting a marketplace");
  if (blocked) return blocked;
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  // US-1616 / C3: disconnecting the marketplace is an integration teardown that
  // affects the whole workspace — require admin, not a read-only viewer.
  if (!roleAtLeast(c.get("workspaceRole") ?? "owner", "admin")) {
    return c.json({ error: "This action requires admin access or higher" }, 403);
  }

  // US-1507: a specific connection to disconnect. iOS (multi-account) sends this
  // so it disconnects only the tapped account; when absent, disconnect ALL the
  // user's active eBay connections (the historical single-account behavior). Both
  // paths stay tenant-scoped by user_id.
  let connectionId: string | undefined;
  try {
    const body = (await c.req.json()) as { connection_id?: unknown } | null;
    if (body && typeof body.connection_id === "string" && body.connection_id) {
      connectionId = body.connection_id;
    }
  } catch {
    // No/invalid body → disconnect all (backward compatible).
  }

  let loadQuery = supabaseAdmin
    .from("marketplace_connections")
    .select("id, refresh_token_encrypted, access_token_encrypted")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true);
  if (connectionId) loadQuery = loadQuery.eq("id", connectionId);
  const { data: rows, error: loadErr } = await loadQuery;
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

  let deactQuery = supabaseAdmin
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
  // US-1507: scope the deactivation to the requested connection when given.
  if (connectionId) deactQuery = deactQuery.eq("id", connectionId);
  const { error: deactErr } = await deactQuery;
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
    .lt("token_expires_at", horizon)
    // US-2387: bounded, and ordered by URGENCY — same shape as the depop, etsy
    // and whatnot refresh scans. The cap only drops connections expiring LATEST,
    // which the next tick picks up; an unordered cap would let a soon-expiring
    // token fall through an arbitrary subset repeatedly, and an expired eBay
    // token is a seller's listings going stale.
    .order("token_expires_at", { ascending: true })
    .limit(EBAY_CONNECTION_SCAN_CAP);

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
  // US-1659: and Etsy connections (access tokens expire hourly). No-op while off.
  const etsy = await refreshExpiringEtsyConnections();
  // US-1661: and Whatnot connections. No-op while the connector is disabled.
  const whatnot = await refreshExpiringWhatnotConnections();
  return c.json({ scanned: userIds.length, refreshed, failed, depop, etsy, whatnot });
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
