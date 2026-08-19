// US-9122: /oauth/token and /oauth/revoke.
//
// Thin over lib/oauth-tokens.ts (the rules) and lib/oauth-store.ts (the reads
// and writes). What lives here is the HTTP contract and nothing else, because
// an endpoint that also reasons about security is an endpoint where the
// reasoning is hard to find.
//
// PUBLIC and unauthenticated, like every token endpoint: the credential IS the
// request body. Gated on MCP_OAUTH_ENABLED so it 404s until the flow is real —
// same reason the discovery documents do (US-9120).
//
// FORM-ENCODED, not JSON. RFC 6749 requires it and Anthropic's connector review
// checks for it specifically. A JSON-only token endpoint fails against a
// conforming client for a reason that looks like a network problem.

import { Hono } from "hono";
import type { Context } from "hono";
import { logEvent } from "../lib/observability.ts";
import { redactError } from "../lib/log-redact.ts";
import { isOAuthEnabled, resourceIdentifier } from "../lib/oauth-metadata.ts";
import { createOAuthStore } from "../lib/oauth-store.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  generateOpaqueToken,
  hashSecret,
  redeemAuthorizationCode,
  REFRESH_TOKEN_TTL_MS,
  rotateRefreshToken,
} from "../lib/oauth-tokens.ts";

export const oauthRoutes = new Hono();

/** One hour. Short enough that a leaked token is a window, not a key. */
export const ACCESS_TOKEN_TTL_MS = 3_600_000;

/**
 * The OAuth error envelope (RFC 6749 §5.2). Deliberately terse: `error` is a
 * fixed code a client branches on, `error_description` is for a human reading a
 * log. Neither ever names a table, a row, or which check failed in a way that
 * would help someone probe.
 */
function oauthError(
  c: Context,
  status: 400 | 401 | 429 | 500,
  error: string,
  description: string,
): Response {
  // No-store is required on token responses and errors alike: an intermediary
  // caching either is caching a credential or a hint about one.
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({ error, error_description: description }, status);
}

function notFound(c: Context): Response {
  return c.json({ error: "Not found" }, 404);
}

async function formBody(c: Context): Promise<Record<string, string>> {
  const raw = await c.req.text();
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

// ---------------------------------------------------------------------------
// POST /oauth/token
// ---------------------------------------------------------------------------

oauthRoutes.post("/token", async (c) => {
  if (!isOAuthEnabled()) return notFound(c);

  const body = await formBody(c);
  const grantType = body.grant_type ?? "";
  const clientId = body.client_id ?? "";
  // RFC 8707. A client MUST send it; a token minted without knowing what it is
  // for is a token that can be presented anywhere.
  const resource = body.resource ?? "";

  if (!clientId) {
    return oauthError(c, 400, "invalid_request", "client_id is required");
  }
  if (resource !== resourceIdentifier()) {
    return oauthError(
      c,
      400,
      "invalid_target",
      "resource must name this MCP server exactly",
    );
  }

  try {
    if (grantType === "authorization_code") {
      return await handleAuthorizationCode(c, body, clientId, resource);
    }
    if (grantType === "refresh_token") {
      return await handleRefresh(c, body, clientId, resource);
    }
    return oauthError(
      c,
      400,
      "unsupported_grant_type",
      "supported grant types are authorization_code and refresh_token",
    );
  } catch (err) {
    logEvent("error", "oauth.token_failed", { grantType, error: redactError(err) });
    return oauthError(c, 500, "server_error", "could not issue a token");
  }
});

async function handleAuthorizationCode(
  c: Context,
  body: Record<string, string>,
  clientId: string,
  resource: string,
): Promise<Response> {
  const code = body.code ?? "";
  const redirectUri = body.redirect_uri ?? "";
  const codeVerifier = body.code_verifier ?? "";

  if (!code || !redirectUri || !codeVerifier) {
    return oauthError(
      c,
      400,
      "invalid_request",
      "code, redirect_uri and code_verifier are required",
    );
  }

  // The reason is recorded on the grant when a replay revokes it, so an
  // investigation can tell this apart from a seller's own disconnect.
  const store = createOAuthStore(supabaseAdmin, () => "code_replayed");
  const result = await redeemAuthorizationCode({
    code,
    clientId,
    redirectUri,
    codeVerifier,
    resource,
    store,
  });

  if (!result.ok) {
    // EVERY failure is invalid_grant with the SAME description. The reasons are
    // genuinely different (replayed, expired, wrong redirect, PKCE), and saying
    // which turns the endpoint into an oracle a caller probes one parameter at
    // a time. The real reason goes to the log.
    logEvent("warn", "oauth.code_rejected", { reason: result.reason, clientId });
    return oauthError(
      c,
      400,
      "invalid_grant",
      "the authorization code is not valid; start the authorization flow again",
    );
  }

  const record = result.record;

  const { data: grantRow, error: grantError } = await supabaseAdmin
    .from("oauth_grants")
    .insert({
      owner_user_id: record.userId,
      client_id: record.clientId,
      scopes: record.scopes,
      resource: record.resource,
    })
    .select("id")
    .single();
  if (grantError || !grantRow) {
    logEvent("error", "oauth.grant_insert_failed", { error: redactError(grantError) });
    return oauthError(c, 500, "server_error", "could not issue a token");
  }
  const grantId = (grantRow as { id: string }).id;

  // Record which grant this code produced, so a replay has something to revoke.
  // Best-effort: failing here loses the revocation target, not the grant, and
  // the code is already consumed so the replay is still refused.
  const { error: linkError } = await supabaseAdmin
    .from("oauth_authorization_codes")
    .update({ grant_id: grantId })
    .eq("code_hash", record.codeHash);
  if (linkError) {
    logEvent("error", "oauth.code_grant_link_failed", { error: redactError(linkError) });
  }

  return await issueTokens(c, grantId, record.scopes);
}

async function handleRefresh(
  c: Context,
  body: Record<string, string>,
  clientId: string,
  resource: string,
): Promise<Response> {
  const refreshToken = body.refresh_token ?? "";
  if (!refreshToken) {
    return oauthError(c, 400, "invalid_request", "refresh_token is required");
  }

  const store = createOAuthStore(supabaseAdmin, () => "reuse_detected");
  const result = await rotateRefreshToken({ refreshToken, store });

  if (!result.ok) {
    logEvent("warn", "oauth.refresh_rejected", { reason: result.reason, clientId });
    return oauthError(
      c,
      400,
      "invalid_grant",
      "the refresh token is not valid; authorize again",
    );
  }

  // The grant is the authority, not the request. A refresh token presented with
  // a different client_id or resource than its grant was issued for does not
  // get to change either.
  if (result.grant.clientId !== clientId) {
    logEvent("warn", "oauth.refresh_client_mismatch", { clientId });
    return oauthError(c, 400, "invalid_grant", "the refresh token is not valid for this client");
  }
  if (result.grant.resource !== resource) {
    return oauthError(c, 400, "invalid_target", "the refresh token is not for this resource");
  }

  return await issueTokens(c, result.grant.grantId, result.grant.scopes, result.nextToken);
}

/**
 * Mint an access token, and a refresh token when one is not already being
 * carried forward from a rotation.
 */
async function issueTokens(
  c: Context,
  grantId: string,
  scopes: string[],
  existingRefresh?: string,
): Promise<Response> {
  const nowMs = Date.now();
  const accessToken = generateOpaqueToken("gta");

  const { error } = await supabaseAdmin.from("oauth_access_tokens").insert({
    token_hash: await hashSecret(accessToken),
    grant_id: grantId,
    scopes,
    expires_at: new Date(nowMs + ACCESS_TOKEN_TTL_MS).toISOString(),
  });
  if (error) {
    logEvent("error", "oauth.access_insert_failed", { error: redactError(error) });
    return oauthError(c, 500, "server_error", "could not issue a token");
  }

  let refreshToken = existingRefresh;
  if (!refreshToken) {
    refreshToken = generateOpaqueToken("gtr");
    const { error: refreshError } = await supabaseAdmin.from("oauth_refresh_tokens").insert({
      token_hash: await hashSecret(refreshToken),
      grant_id: grantId,
      generation: 1,
      expires_at: new Date(nowMs + REFRESH_TOKEN_TTL_MS).toISOString(),
    });
    if (refreshError) {
      logEvent("error", "oauth.refresh_insert_failed", { error: redactError(refreshError) });
      return oauthError(c, 500, "server_error", "could not issue a token");
    }
  }

  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });
}

// ---------------------------------------------------------------------------
// POST /oauth/revoke (RFC 7009)
// ---------------------------------------------------------------------------

oauthRoutes.post("/revoke", async (c) => {
  if (!isOAuthEnabled()) return notFound(c);

  const body = await formBody(c);
  const token = body.token ?? "";

  // RFC 7009 is explicit: the endpoint returns 200 whether or not the token
  // existed. Reporting "unknown token" would confirm which tokens are real to
  // anyone willing to ask, and a client's cleanup should not fail because it
  // revoked something twice.
  if (!token) {
    c.header("Cache-Control", "no-store");
    return c.body(null, 200);
  }

  try {
    const tokenHash = await hashSecret(token);

    // Look in both places: a client may send either, and token_type_hint is a
    // hint rather than a promise.
    const { data: refreshRow } = await supabaseAdmin
      .from("oauth_refresh_tokens")
      .select("grant_id")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    const { data: accessRow } = refreshRow ? { data: null } : await supabaseAdmin
      .from("oauth_access_tokens")
      .select("grant_id")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    const grantId = (refreshRow as { grant_id: string } | null)?.grant_id ??
      (accessRow as { grant_id: string } | null)?.grant_id;

    if (grantId) {
      // Revoking ONE token revokes the whole grant, which is more than RFC 7009
      // requires and is what a seller means by "disconnect this". Revoking a
      // single access token while its refresh token keeps minting new ones is a
      // revocation that does not revoke.
      await createOAuthStore(supabaseAdmin, () => "user").revokeGrant(grantId, Date.now());
      logEvent("info", "oauth.grant_revoked", { reason: "user" });
    }
  } catch (err) {
    // Still 200. A failure here must not tell a caller anything, and the client
    // has no useful action either way.
    logEvent("error", "oauth.revoke_failed", { error: redactError(err) });
  }

  c.header("Cache-Control", "no-store");
  return c.body(null, 200);
});
