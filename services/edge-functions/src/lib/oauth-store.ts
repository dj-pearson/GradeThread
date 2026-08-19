// US-9122: the TokenStore, backed by the 00620 tables.
//
// lib/oauth-tokens.ts owns every RULE (PKCE, single use, rotation, reuse
// detection, audience). This owns only the reads and writes those rules need.
// The split is what let the rules be built and reviewed before the migration
// existed, and it is what keeps this file boring — which is the right thing for
// the layer that touches an authorization server's tables.
//
// Everything here goes through the service-role client and therefore BYPASSES
// RLS, which is fine because these tables are deny-all by design: there is no
// tenant policy to lean on, and no query below takes a tenant from a caller.
// The ids it works from are hashes of secrets the caller already presented.

import { supabaseAdmin } from "./supabase.ts";
import { redactError } from "./log-redact.ts";
import type {
  AuthorizationCodeRecord,
  GrantRecord,
  RefreshTokenRecord,
  TokenStore,
} from "./oauth-tokens.ts";

// deno-lint-ignore no-explicit-any
export type OAuthDb = any;

function toMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = toMs(value);
  return parsed === 0 ? undefined : parsed;
}

function toCode(row: Record<string, unknown>): AuthorizationCodeRecord {
  return {
    codeHash: String(row.code_hash),
    clientId: String(row.client_id),
    userId: String(row.owner_user_id),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    codeChallengeMethod: String(row.code_challenge_method ?? "S256"),
    scopes: (row.scopes as string[] | null) ?? [],
    resource: String(row.resource),
    expiresAtMs: toMs(row.expires_at),
    consumedAtMs: optionalMs(row.consumed_at),
    grantId: (row.grant_id as string | null) ?? undefined,
  };
}

function toGrant(row: Record<string, unknown>): GrantRecord {
  return {
    grantId: String(row.id),
    clientId: String(row.client_id),
    userId: String(row.owner_user_id),
    scopes: (row.scopes as string[] | null) ?? [],
    resource: String(row.resource),
    revokedAtMs: optionalMs(row.revoked_at),
  };
}

function toRefresh(row: Record<string, unknown>): RefreshTokenRecord {
  return {
    tokenHash: String(row.token_hash),
    grantId: String(row.grant_id),
    generation: Number(row.generation ?? 1),
    expiresAtMs: toMs(row.expires_at),
    rotatedAtMs: optionalMs(row.rotated_at),
  };
}

/**
 * Build a store over a database handle.
 *
 * `reason` is threaded through revokeGrant so a revoked grant records WHY. An
 * investigation needs to tell a seller's own disconnect apart from a refresh
 * token that turned up twice, and after the fact there is no way to reconstruct
 * which it was.
 */
export function createOAuthStore(
  db: OAuthDb = supabaseAdmin,
  revokeReason: () => string = () => "unspecified",
): TokenStore {
  return {
    async findCode(codeHash: string): Promise<AuthorizationCodeRecord | null> {
      const { data, error } = await db
        .from("oauth_authorization_codes")
        .select("*")
        .eq("code_hash", codeHash)
        .maybeSingle();
      if (error || !data) return null;
      return toCode(data as Record<string, unknown>);
    },

    async markCodeConsumed(codeHash: string, nowMs: number): Promise<void> {
      // Conditional on consumed_at still being NULL, so two requests racing the
      // same code cannot both believe they were first. The replay branch in
      // redeemAuthorizationCode reads the row again and sees the winner's mark.
      const { error } = await db
        .from("oauth_authorization_codes")
        .update({ consumed_at: new Date(nowMs).toISOString() })
        .eq("code_hash", codeHash)
        .is("consumed_at", null);
      if (error) {
        console.error("[oauth-store] markCodeConsumed:", redactError(error));
        // Rethrown deliberately: if we cannot record that a code was used, we
        // cannot detect its replay either, and continuing would hand out a
        // token we can no longer reason about.
        throw new Error("could not consume authorization code");
      }
    },

    async findGrant(grantId: string): Promise<GrantRecord | null> {
      const { data, error } = await db
        .from("oauth_grants")
        .select("*")
        .eq("id", grantId)
        .maybeSingle();
      if (error || !data) return null;
      return toGrant(data as Record<string, unknown>);
    },

    async revokeGrant(grantId: string, nowMs: number): Promise<void> {
      const { error } = await db
        .from("oauth_grants")
        .update({
          revoked_at: new Date(nowMs).toISOString(),
          revoked_reason: revokeReason(),
          updated_at: new Date(nowMs).toISOString(),
        })
        .eq("id", grantId);
      if (error) {
        // A failed revocation is the one failure here that must be loud: it
        // leaves a grant alive that we decided should not be.
        console.error("[oauth-store] revokeGrant FAILED:", redactError(error));
        throw new Error("could not revoke grant");
      }
    },

    async findRefresh(tokenHash: string): Promise<RefreshTokenRecord | null> {
      const { data, error } = await db
        .from("oauth_refresh_tokens")
        .select("*")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error || !data) return null;
      return toRefresh(data as Record<string, unknown>);
    },

    async rotateRefresh(
      oldHash: string,
      next: RefreshTokenRecord,
      nowMs: number,
    ): Promise<void> {
      // MARK THE OLD ONE FIRST, and conditionally.
      //
      // Order matters: if the insert went first and the mark then failed, the
      // old token would still be live alongside the new one, and two live
      // tokens in a rotating scheme is the exact state rotation exists to
      // prevent. Marking first means the worst case is a grant with no usable
      // refresh token, which costs the seller a re-authorization rather than
      // costing them the grant's security.
      const { error: markError } = await db
        .from("oauth_refresh_tokens")
        .update({ rotated_at: new Date(nowMs).toISOString() })
        .eq("token_hash", oldHash)
        .is("rotated_at", null);
      if (markError) {
        console.error("[oauth-store] rotateRefresh mark:", redactError(markError));
        throw new Error("could not rotate refresh token");
      }

      const { error: insertError } = await db
        .from("oauth_refresh_tokens")
        .insert({
          token_hash: next.tokenHash,
          grant_id: next.grantId,
          generation: next.generation,
          expires_at: new Date(next.expiresAtMs).toISOString(),
        });
      if (insertError) {
        console.error("[oauth-store] rotateRefresh insert:", redactError(insertError));
        throw new Error("could not rotate refresh token");
      }
    },
  };
}
