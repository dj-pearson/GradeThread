// US-9122 AC10: accepting an OAuth access token at /mcp.
//
// The API-key path and this one must land in the SAME tenant context, or the
// tools behave differently depending on how the caller signed in — which is the
// worst kind of difference, because it only shows up for one class of user.
//
// ── Four checks, and each one is a different failure ─────────────────────
//
//   1. The token exists (looked up by HASH — the plaintext is never stored).
//   2. It has not expired.
//   3. Its GRANT has not been revoked. This is the one that matters after a
//      seller clicks disconnect: revoking the grant must stop the tokens
//      already issued, or "disconnect" means "disconnect in an hour".
//   4. The grant's resource is OURS (RFC 8707). A token minted for a different
//      resource server must not work here — that is the confused-deputy hole
//      resource indicators exist to close, and accepting a stranger's token
//      because it parses is exactly how it stays open.
//
// Every failure answers the same way to the CALLER. Telling an unknown token
// apart from a revoked one tells someone holding a stolen token which it is.

import { supabaseAdmin } from "./supabase.ts";
import { hashSecret } from "./oauth-tokens.ts";
import { isAudienceValid } from "./oauth-tokens.ts";
import { resourceIdentifier } from "./oauth-metadata.ts";
import { redactError } from "./log-redact.ts";
import { logEvent } from "./observability.ts";

// deno-lint-ignore no-explicit-any
export type AccessDb = any;

export interface OAuthIdentity {
  /** The seller the grant belongs to. The tenant every tool scopes on. */
  userId: string;
  /** The grant id, used as the audit and budget subject in place of a key id. */
  grantId: string;
  clientId: string;
  /** What the SELLER granted, which may be narrower than what the client asked. */
  scopes: string[];
}

export type AccessResolution =
  | { ok: true; identity: OAuthIdentity }
  | { ok: false; reason: "not_oauth" | "invalid" };

/** Our tokens are opaque and prefixed, so a non-match is not our token at all. */
export function looksLikeOAuthAccessToken(token: string): boolean {
  return token.startsWith("gta_");
}

export async function resolveOAuthAccessToken(
  token: string,
  db: AccessDb = supabaseAdmin,
  nowMs: number = Date.now(),
): Promise<AccessResolution> {
  if (!looksLikeOAuthAccessToken(token)) return { ok: false, reason: "not_oauth" };

  let tokenHash: string;
  try {
    tokenHash = await hashSecret(token);
  } catch (err) {
    logEvent("error", "oauth.access_hash_failed", { error: redactError(err) });
    return { ok: false, reason: "invalid" };
  }

  const { data, error } = await db
    .from("oauth_access_tokens")
    .select(
      "token_hash, grant_id, scopes, expires_at, " +
        "oauth_grants!inner(id, owner_user_id, client_id, resource, revoked_at)",
    )
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    logEvent("error", "oauth.access_lookup_failed", { error: redactError(error) });
    return { ok: false, reason: "invalid" };
  }
  if (!data) return { ok: false, reason: "invalid" };

  const row = data as unknown as {
    grant_id: string;
    scopes: string[] | null;
    expires_at: string;
    oauth_grants: {
      id: string;
      owner_user_id: string;
      client_id: string;
      resource: string;
      revoked_at: string | null;
    };
  };

  if (new Date(row.expires_at).getTime() <= nowMs) return { ok: false, reason: "invalid" };

  const grant = row.oauth_grants;
  if (!grant) return { ok: false, reason: "invalid" };
  if (grant.revoked_at) {
    // Logged as a warning rather than swallowed: a revoked grant still being
    // presented is either a client that has not noticed, or a token someone
    // kept. Both are worth being able to see.
    logEvent("warn", "oauth.access_revoked_grant", { clientId: grant.client_id });
    return { ok: false, reason: "invalid" };
  }

  if (!isAudienceValid(grant.resource, resourceIdentifier())) {
    logEvent("warn", "oauth.access_wrong_audience", { clientId: grant.client_id });
    return { ok: false, reason: "invalid" };
  }

  return {
    ok: true,
    identity: {
      userId: grant.owner_user_id,
      grantId: grant.id,
      clientId: grant.client_id,
      // The TOKEN's scopes, not the grant's. A refresh may narrow, and the
      // narrower of the two is the one that was actually issued.
      scopes: row.scopes ?? [],
    },
  };
}
