// US-9120: the two documents an MCP client reads before it can log a seller in.
//
// A client that gets a 401 from /mcp follows the WWW-Authenticate header to the
// PROTECTED RESOURCE document (RFC 9728), which names the authorization server;
// it then reads that server's own metadata (RFC 8414) to find the authorize and
// token endpoints. Neither document is optional: an MCP server MUST publish the
// first, and MCP clients MUST use it for discovery.
//
// BOTH ARE PUBLIC AND UNAUTHENTICATED, by design. They contain no secrets — a
// list of endpoint URLs and supported parameters — and requiring a credential to
// discover how to get a credential is a loop.
//
// ── The correction that matters most here ───────────────────────────────────
//
// Dynamic Client Registration (RFC 7591) is DEPRECATED in the MCP authorization
// spec, retained only for authorization servers that cannot do better. The
// replacement is OAuth Client ID Metadata Documents: the client's `client_id` IS
// an https URL, and the authorization server fetches the client's metadata from
// it and validates the redirect_uris it declares. Servers and clients SHOULD
// support that.
//
// The original plan for this story made DCR the primary path. It is the
// fallback.

/** Scopes a client may request. Mirrors API_KEY_SCOPES; see lib/api-key.ts. */
export const OAUTH_SCOPES_SUPPORTED = ["read", "submit", "webhook_manage"] as const;

/**
 * The minimal set for basic functionality, per the spec's scope-minimisation
 * guidance. Anything beyond it is requested incrementally through the
 * insufficient_scope challenge, not asked for up front.
 *
 * `offline_access` is deliberately ABSENT: refresh tokens are not a resource
 * requirement, and the spec says a protected resource should not advertise it.
 */
export const OAUTH_SCOPES_MINIMAL = ["read"] as const;

/**
 * Is the OAuth flow actually SERVED?
 *
 * The discovery documents below are complete and tested, but publishing them
 * before /oauth/authorize and /oauth/token exist would make the connector
 * broken in a NEW way: a client reads the metadata, starts an authorization
 * flow, and 404s. Today the same client sees no discovery, falls back to a
 * static credential, and works.
 *
 * So this defaults OFF and flips on in the same change that lands the
 * endpoints (US-9122). Advertising a capability we do not have is worse than
 * not having it, because it takes the working path away too.
 */
export function isOAuthEnabled(): boolean {
  const raw = (Deno.env.get("MCP_OAUTH_ENABLED") ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

export function issuerOrigin(): string {
  const raw = Deno.env.get("MCP_PUBLIC_BASE_URL") ?? "https://functions.gradethread.com";
  return raw.replace(/\/+$/, "");
}

/**
 * The canonical resource identifier tokens are audience-bound to (RFC 8707).
 *
 * No trailing slash and no fragment: the spec calls both out, and a mismatch
 * here is a token that validates on one side and not the other.
 */
export function resourceIdentifier(): string {
  return `${issuerOrigin()}/mcp`;
}

/** Where the seller is sent to sign in and approve. Lives on the web app. */
export function consentOrigin(): string {
  const raw = Deno.env.get("APP_PUBLIC_BASE_URL") ?? "https://gradethread.com";
  return raw.replace(/\/+$/, "");
}

/** RFC 9728. Served at /.well-known/oauth-protected-resource. */
export function protectedResourceMetadata(): Record<string, unknown> {
  const origin = issuerOrigin();
  return {
    resource: resourceIdentifier(),
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_SCOPES_MINIMAL],
    bearer_methods_supported: ["header"],
    resource_documentation: `${consentOrigin()}/developers`,
  };
}

/** RFC 8414. Served at /.well-known/oauth-authorization-server. */
export function authorizationServerMetadata(): Record<string, unknown> {
  const origin = issuerOrigin();
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 ONLY. `plain` is not acceptable under OAuth 2.1, and Anthropic's
    // connector review checks for S256 support specifically.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // RFC 9207. Advertised because we emit it, including on error responses —
    // a client is entitled to reject a response whose issuer it cannot confirm.
    authorization_response_iss_parameter_supported: true,
    // Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document).
    // The replacement for dynamic registration, which the MCP authorization spec
    // now deprecates.
    client_id_metadata_document_supported: true,
    service_documentation: `${consentOrigin()}/developers`,
  };
}

// ---------------------------------------------------------------------------
// Redirect URI validation
// ---------------------------------------------------------------------------

/** Where the hosted Claude surfaces come back to. */
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

/**
 * Is this a redirect URI we will send a seller's authorization code to?
 *
 * EXACT MATCH, https only, no fragment — with exactly one exemption: loopback.
 *
 * The loopback exemption is not a nicety. Claude Code redirects to
 * http://localhost:<port> with a port it picks at run time, so exact-string
 * matching rejects it every single time and the connector simply cannot be
 * added from a terminal. OAuth 2.1 permits loopback with a variable port for
 * exactly this reason, and the exemption is scoped to loopback hosts only:
 * every other host is compared whole.
 */
export function isAllowedRedirectUri(uri: string, registered: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  // A fragment in a redirect_uri is not permitted, and is a classic way to
  // smuggle a second destination past a prefix check.
  if (parsed.hash) return false;

  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" || parsed.hostname === "::1";

  if (!isLoopback && parsed.protocol !== "https:") return false;
  if (isLoopback && parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  for (const candidate of registered) {
    let reg: URL;
    try {
      reg = new URL(candidate);
    } catch {
      continue;
    }

    if (isLoopback) {
      const regLoopback = reg.hostname === "localhost" || reg.hostname === "127.0.0.1" ||
        reg.hostname === "[::1]" || reg.hostname === "::1";
      // Port-agnostic, and ONLY the port. The path still has to match, or a
      // registered http://localhost/cb would accept http://localhost/anything.
      if (regLoopback && reg.pathname === parsed.pathname) return true;
      continue;
    }

    if (candidate === uri) return true;
  }

  return false;
}

/**
 * Validate a client's declared redirect URIs at registration time.
 *
 * Rejecting here as well as at authorize is the point: a wildcard accepted at
 * registration is a wildcard someone has to notice later.
 */
export function invalidRedirectUris(uris: readonly string[]): string[] {
  const bad: string[] = [];
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      bad.push(uri);
      continue;
    }
    if (parsed.hash) {
      bad.push(uri);
      continue;
    }
    if (uri.includes("*")) {
      bad.push(uri);
      continue;
    }
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" || parsed.hostname === "::1";
    if (!isLoopback && parsed.protocol !== "https:") bad.push(uri);
  }
  return bad;
}
