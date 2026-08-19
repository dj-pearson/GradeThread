// US-9121: the authorization endpoint, and the code it issues.
//
// ── The rule that shapes this whole file ─────────────────────────────────
//
// There are TWO kinds of invalid request and they must be answered
// differently:
//
//   • A bad client_id or a redirect_uri the client did not register is a FATAL
//     error. It is answered on our own page, never by redirecting. Redirecting
//     an error to an unverified URI turns this endpoint into an open redirector
//     and hands the attacker whatever the query string carried.
//   • Everything else — a missing code_challenge, an unsupported response_type,
//     a scope we do not grant — redirects back to the VERIFIED uri with
//     `error=`, because at that point we know where the client lives and the
//     spec says the client is entitled to hear why.
//
// Getting that boundary wrong is the classic authorization-endpoint hole, and
// it is why validate() returns three arms rather than a boolean.
//
// ── Where the seller actually decides ────────────────────────────────────
//
// GET /oauth/authorize does not render anything. It validates, then sends the
// browser to the consent page in the React app, which is where a signed-in
// seller sees who is asking and for what. Approving calls back into
// issueAuthorizationCode, which RE-VALIDATES everything — the consent page is a
// browser page and its parameters are as untrusted as the ones that arrived
// here. Narrowing scopes there is expected (US-9121 AC4); widening them, or
// swapping the redirect, is not, and re-validation is what makes the difference.

import { supabaseAdmin } from "./supabase.ts";
import { resolveClient } from "./oauth-clients.ts";
import {
  isAllowedRedirectUri,
  issuerOrigin,
  OAUTH_SCOPES_SUPPORTED,
  resourceIdentifier,
} from "./oauth-metadata.ts";
import { AUTHORIZATION_CODE_TTL_MS, generateOpaqueToken, hashSecret } from "./oauth-tokens.ts";
import { redactError } from "./log-redact.ts";
import { logEvent } from "./observability.ts";

// deno-lint-ignore no-explicit-any
export type AuthorizeDb = any;

export interface AuthorizeRequest {
  clientId?: string;
  redirectUri?: string;
  responseType?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
  state?: string;
  resource?: string;
}

export interface ValidatedAuthorize {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state: string | null;
  resource: string;
}

export type AuthorizeValidation =
  | { ok: true; request: ValidatedAuthorize }
  /** Cannot redirect: we do not trust where to. Render on our own page. */
  | { ok: false; kind: "fatal"; error: string; description: string }
  /** The client and its uri check out, so the error goes back to it. */
  | {
    ok: false;
    kind: "redirect";
    redirectUri: string;
    state: string | null;
    error: string;
    description: string;
  };

/** OAuth 2.1: S256 only. `plain` is not acceptable and is not accepted. */
const CODE_CHALLENGE_METHOD = "S256";
/** A base64url SHA-256 digest is 43 characters. Anything else is not one. */
const CHALLENGE_LENGTH = 43;

function parseScopes(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/\s+/).filter(Boolean))];
}

export async function validateAuthorizeRequest(
  req: AuthorizeRequest,
  db: AuthorizeDb = supabaseAdmin,
): Promise<AuthorizeValidation> {
  if (!req.clientId) {
    return { ok: false, kind: "fatal", error: "invalid_request", description: "client_id is required" };
  }

  const resolved = await resolveClient(req.clientId, db);
  if (!resolved.ok) {
    // Deliberately does not distinguish unknown from unreachable to the
    // BROWSER; the reason is logged. A page that says which tells someone
    // probing client ids whether they guessed a real one.
    logEvent("warn", "oauth.authorize_unknown_client", { reason: resolved.failure.reason });
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_client",
      description: "We do not recognise the application making this request.",
    };
  }
  const client = resolved.client;

  // No redirect_uri: fall back to the client's single registered one, which is
  // what the spec allows and what most clients rely on. With more than one
  // there is nothing to guess, and guessing is the hole.
  const redirectUri = req.redirectUri ??
    (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri) {
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_request",
      description: "redirect_uri is required for this application.",
    };
  }
  if (!isAllowedRedirectUri(redirectUri, client.redirectUris)) {
    // FATAL, not a redirect. This is the open-redirector line.
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_request",
      description: "That redirect address is not registered for this application.",
    };
  }

  const state = req.state ?? null;
  const fail = (error: string, description: string): AuthorizeValidation => ({
    ok: false,
    kind: "redirect",
    redirectUri,
    state,
    error,
    description,
  });

  if (req.responseType !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  }
  if (req.codeChallengeMethod !== CODE_CHALLENGE_METHOD) {
    return fail(
      "invalid_request",
      "code_challenge_method must be S256. The plain method is not accepted.",
    );
  }
  if (!req.codeChallenge || req.codeChallenge.length !== CHALLENGE_LENGTH) {
    return fail("invalid_request", "A valid S256 code_challenge is required.");
  }

  const requested = parseScopes(req.scope);
  if (requested.length === 0) {
    return fail("invalid_scope", "At least one scope is required.");
  }
  const unknown = requested.filter(
    (s) => !(OAUTH_SCOPES_SUPPORTED as readonly string[]).includes(s),
  );
  if (unknown.length > 0) {
    return fail("invalid_scope", `Unknown scope(s): ${unknown.join(", ")}`);
  }

  // RFC 8707. A token minted for something else must not work here, so the
  // resource is pinned onto the grant now rather than assumed at token time.
  const resource = req.resource ?? resourceIdentifier();
  if (resource !== resourceIdentifier()) {
    return fail("invalid_target", "That resource is not served by this authorization server.");
  }

  return {
    ok: true,
    request: {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge: req.codeChallenge,
      scopes: requested,
      state,
      resource,
    },
  };
}

/**
 * Build the redirect a client gets back, with RFC 9207 `iss` on every one.
 *
 * `iss` goes on errors too: a client is entitled to confirm which authorization
 * server answered, and only sending it on success is how a mixed-up-provider
 * attack survives.
 */
export function authorizeRedirect(
  redirectUri: string,
  params: Record<string, string | null>,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("iss", issuerOrigin());
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export interface IssueCodeArgs {
  ownerUserId: string;
  request: ValidatedAuthorize;
  /** What the SELLER agreed to, which may be narrower than what was asked. */
  grantedScopes: string[];
  nowMs?: number;
  db?: AuthorizeDb;
}

export type IssueCodeResult =
  | { ok: true; redirectTo: string }
  | { ok: false; error: string; description: string };

export async function issueAuthorizationCode(
  args: IssueCodeArgs,
): Promise<IssueCodeResult> {
  const db = args.db ?? supabaseAdmin;
  const nowMs = args.nowMs ?? Date.now();
  const { request } = args;

  // The seller may narrow, never widen. A consent page that could add a scope
  // would be a consent page that could grant itself one.
  const granted = args.grantedScopes.filter((s) => request.scopes.includes(s));
  if (granted.length === 0) {
    return {
      ok: false,
      error: "invalid_scope",
      description: "No scopes were granted.",
    };
  }

  const code = generateOpaqueToken("gtac");
  const codeHash = await hashSecret(code);

  const { error } = await db.from("oauth_authorization_codes").insert({
    code_hash: codeHash,
    owner_user_id: args.ownerUserId,
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: CODE_CHALLENGE_METHOD,
    scopes: granted,
    resource: request.resource,
    // AC5: 60 seconds, per OAuth 2.1. The code travels through a browser
    // redirect and is exchanged immediately; a longer window is only useful to
    // someone who captured it.
    expires_at: new Date(nowMs + AUTHORIZATION_CODE_TTL_MS).toISOString(),
  });
  if (error) {
    logEvent("error", "oauth.authorize_code_insert_failed", { error: redactError(error) });
    return {
      ok: false,
      error: "server_error",
      description: "Could not complete the connection. Try again.",
    };
  }

  logEvent("info", "oauth.authorization_granted", {
    clientId: request.clientId,
    scopes: granted.join(" "),
  });

  return {
    ok: true,
    redirectTo: authorizeRedirect(request.redirectUri, {
      code,
      state: request.state,
    }),
  };
}
