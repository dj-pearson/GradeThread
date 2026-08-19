// US-9104: authentication for the MCP endpoint.
//
// Same credential machinery as /api/v1 (one resolver in api-key-auth.ts owns
// key validity, plan tiering and quota), different wire shape. An MCP client
// cannot read /api/v1's bare `{ error: string }` 401, and OAuth 2.1 requires a
// WWW-Authenticate challenge that /api/v1 has never sent — so the mapping from
// "why the credential failed" to "what the caller sees" lives here.
//
// US-268 NOTE: /mcp uses the service-role client and therefore BYPASSES RLS.
// This middleware is what establishes the tenant. Every tool built on top of it
// scopes on `workspaceOwnerId ?? userId`; nothing downstream may take an id
// from tool arguments without an ownership check first.

import { createMiddleware } from "hono/factory";
import {
  type ApiKeyScope,
  isWellFormedApiKey,
} from "../lib/api-key.ts";
import {
  applyApiKeyIdentity,
  extractApiKey,
  extractBearerToken,
  resolveApiKeyIdentity,
} from "./api-key-auth.ts";
import { featureAllowedForUser } from "../lib/plan-gate.ts";
import { JSON_RPC_ERROR, jsonRpcError } from "../lib/mcp-jsonrpc.ts";
import { issuerOrigin, isOAuthEnabled, resourceIdentifier } from "../lib/oauth-metadata.ts";

type McpAuthEnv = {
  Variables: {
    user: { id: string; email?: string; [key: string]: unknown };
    userId: string;
    apiKeyScopes: ApiKeyScope[];
    apiKeyId: string;
    apiKeyPlan: string;
  };
};

/**
 * The canonical resource identifier a token must be audience-bound to
 * (RFC 8707). One definition, in lib/oauth-metadata.ts, because the value in
 * the challenge and the value in the published document disagreeing is a token
 * that validates on one side and not the other.
 */
export function mcpResourceUri(): string {
  return resourceIdentifier();
}

/** Where a client discovers the authorization server (RFC 9728). */
function resourceMetadataUrl(): string {
  return `${issuerOrigin()}/.well-known/oauth-protected-resource`;
}

/**
 * The scopes a caller needs. Emitted in full on every challenge rather than one
 * at a time: the spec asks for it, and trickling them out forces a separate
 * authorization round-trip per scope for what is one operation.
 */
const CHALLENGE_SCOPES = "read submit";

function challenge(params: Record<string, string>): string {
  const rendered = Object.entries(params)
    .map(([key, value]) => `${key}="${value.replace(/"/g, "")}"`)
    .join(", ");
  return `Bearer ${rendered}`;
}

/**
 * The plan gate for the connector.
 *
 * Reads the existing `apiAccess` gate flag, which today is true only on
 * `business`. That is a real product decision and it is US-9101's to make, not
 * this middleware's — so it is ONE call in ONE place. Widening the connector to
 * pro+ is then either a plan-matrix row change (no deploy: getPlanMatrix reads
 * the DB) or a one-line swap to a new flag here.
 *
 * US-9124: called by the TOOL DISPATCHER, not by this middleware. Auth does not
 * know which tool is being called, so gating here refused the whole endpoint —
 * including tools/list, and including the sandbox tools whose entire purpose is
 * to be usable before you pay.
 */
let planCheck: (userId: string) => Promise<boolean> = (userId) =>
  featureAllowedForUser(userId, "apiAccess");

export function connectorPlanAllows(userId: string): Promise<boolean> {
  return planCheck(userId);
}

/**
 * Test seam. The dispatcher tests exercise scope checks, argument validation and
 * tenant resolution, none of which are about billing - without this they all
 * stop at the plan gate and assert nothing about what they were written for.
 */
export function __setConnectorPlanCheckForTest(
  fn: ((userId: string) => Promise<boolean>) | null,
): void {
  planCheck = fn ?? ((userId) => featureAllowedForUser(userId, "apiAccess"));
}

export const mcpAuthMiddleware = createMiddleware<McpAuthEnv>(async (c, next) => {
  const headerOf = (name: string) => c.req.header(name);
  const rawKey = extractApiKey(headerOf);
  const bearer = extractBearerToken(headerOf);

  // A bearer token that is not one of our API keys is either an OAuth access
  // token (US-9122 resolves those) or a stale credential. Either way the caller
  // needs the discovery pointer, not "missing credential" — they clearly tried.
  if (!rawKey && bearer && !isWellFormedApiKey(bearer)) {
    return unauthorized(c, "invalid_token", "The presented token is not valid for this resource");
  }

  const resolution = await resolveApiKeyIdentity(rawKey);

  if (!resolution.ok) {
    switch (resolution.failure.kind) {
      case "missing":
        return unauthorized(c, null, null);
      case "malformed":
        return unauthorized(c, "invalid_token", "Malformed credential");
      case "unknown":
        return unauthorized(c, "invalid_token", "Unknown credential");
      case "expired":
        return unauthorized(c, "invalid_token", "Credential has expired");
      case "quota_exceeded":
        // Not an auth failure, so not a challenge: re-authorizing would not help.
        // 429 with the reset time is what lets a client back off correctly.
        c.header("Retry-After", String(retryAfterSeconds(resolution.failure.resetsAt)));
        return c.json(
          jsonRpcError(null, {
            code: JSON_RPC_ERROR.INVALID_REQUEST,
            message:
              `Monthly API quota of ${resolution.failure.quota} calls reached; resets ${resolution.failure.resetsAt}`,
            data: { reason: "quota_exceeded", resets_at: resolution.failure.resetsAt },
          }),
          429,
        );
    }
  }

  // The plan gate deliberately does NOT run here — see connectorPlanAllows.
  applyApiKeyIdentity(c, resolution.identity);
  await next();
});

function unauthorized(
  c: { header: (k: string, v: string) => void; json: (b: unknown, s?: number) => Response },
  error: string | null,
  description: string | null,
): Response {
  const params: Record<string, string> = { scope: CHALLENGE_SCOPES };
  // Only point at the discovery document when it is actually served. A
  // resource_metadata URL that 404s sends a client down a dead end instead of
  // to the static-credential path that works.
  if (isOAuthEnabled()) params.resource_metadata = resourceMetadataUrl();
  if (error) params.error = error;
  if (description) params.error_description = description;

  c.header("WWW-Authenticate", challenge(params));
  return c.json(
    jsonRpcError(null, {
      code: JSON_RPC_ERROR.INVALID_REQUEST,
      message: description ?? "Authentication required",
      data: { reason: error ?? "unauthorized", resource_metadata: params.resource_metadata },
    }),
    401,
  );
}

/**
 * An under-scoped but otherwise valid credential is 403 with
 * `error="insufficient_scope"`, never 401 — 401 tells a client to
 * re-authenticate, which will hand back the same insufficient token.
 *
 * Exported for the tool dispatcher (US-9106), which is where a per-tool scope
 * requirement is actually known.
 */
export function insufficientScope(
  c: { header: (k: string, v: string) => void; json: (b: unknown, s?: number) => Response },
  requiredScopes: readonly string[],
): Response {
  c.header(
    "WWW-Authenticate",
    challenge({
      error: "insufficient_scope",
      scope: requiredScopes.join(" "),
      resource_metadata: resourceMetadataUrl(),
      error_description: `This operation requires: ${requiredScopes.join(", ")}`,
    }),
  );
  return c.json(
    jsonRpcError(null, {
      code: JSON_RPC_ERROR.INVALID_REQUEST,
      message: `Insufficient scope; this operation requires: ${requiredScopes.join(", ")}`,
      data: { reason: "insufficient_scope", required_scopes: [...requiredScopes] },
    }),
    403,
  );
}

function retryAfterSeconds(resetsAtIso: string): number {
  const resets = Date.parse(resetsAtIso);
  if (!Number.isFinite(resets)) return 60;
  return Math.max(1, Math.ceil((resets - Date.now()) / 1000));
}
