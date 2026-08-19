// US-9122: the security core of the authorization server, as pure logic.
//
// The endpoints and their tables come later. What lives here is the part where
// being wrong is expensive and being right is not obvious: PKCE verification,
// single-use authorization codes, refresh rotation with reuse detection, and
// audience binding. All of it takes an injectable store, so every rule below is
// asserted without a database — which is also why it can be built and reviewed
// before the migration exists.
//
// NOTHING IS STORED IN PLAINTEXT. Codes and tokens are hashed the same way API
// keys are (HMAC-SHA256 with a server-side pepper when API_KEY_PEPPER is set,
// plain SHA-256 otherwise). A leaked table of hashes is not a leaked table of
// credentials.

// ---------------------------------------------------------------------------
// Hashing and generation
// ---------------------------------------------------------------------------

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Hash a code or token for storage. Mirrors lib/api-key.ts deliberately: one
 * hashing story for every credential this service issues, so introducing or
 * rotating the pepper has one documented consequence rather than two.
 */
export async function hashSecret(value: string): Promise<string> {
  const pepper = Deno.env.get("API_KEY_PEPPER");
  const enc = new TextEncoder();
  if (pepper) {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(pepper),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
  }
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

/** 256 bits of randomness, base64url. Long enough that guessing is not a threat. */
export function generateOpaqueToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64UrlEncode(bytes)}`;
}

/**
 * Compare two secrets without leaking WHERE they differ through timing.
 *
 * Overkill for a 256-bit random token and correct anyway: the moment someone
 * adds a shorter or lower-entropy comparison here, the habit is already in
 * place.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/**
 * Does this verifier produce the challenge the authorization request carried?
 *
 * S256 ONLY. `plain` makes PKCE decorative — an attacker who intercepts the
 * authorization request also has the verifier — and OAuth 2.1 removed it. The
 * metadata advertises S256 alone, so accepting plain here would be honouring
 * something we told clients we do not support.
 */
export async function verifyPkce(
  verifier: string,
  challenge: string,
  method: string,
): Promise<boolean> {
  if (method !== "S256") return false;
  // RFC 7636: 43-128 characters from the unreserved set. A short verifier is
  // brute-forceable and the length floor is the only thing preventing one.
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const computed = base64UrlEncode(new Uint8Array(digest));
  return timingSafeEqual(computed, challenge);
}

// ---------------------------------------------------------------------------
// The store contract
// ---------------------------------------------------------------------------

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopes: string[];
  /** RFC 8707: what the resulting token is FOR. */
  resource: string;
  expiresAtMs: number;
  /** Set the moment it is redeemed, so a replay is visible rather than silent. */
  consumedAtMs?: number;
  /**
   * The grant this code produced, recorded AT redemption.
   *
   * It exists so a replay has something to revoke. Without it, detecting the
   * replay would be all we could do - and detecting it while leaving the
   * resulting grant alive is not a defence, because the grant is the thing the
   * attacker wanted.
   */
  grantId?: string;
}

export interface GrantRecord {
  grantId: string;
  clientId: string;
  userId: string;
  scopes: string[];
  resource: string;
  /** Cleared when the grant is revoked; a revoked grant refuses everything. */
  revokedAtMs?: number;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  grantId: string;
  /** Which rotation this is. Only the newest is live. */
  generation: number;
  expiresAtMs: number;
  rotatedAtMs?: number;
}

export interface TokenStore {
  findCode(codeHash: string): Promise<AuthorizationCodeRecord | null>;
  markCodeConsumed(codeHash: string, nowMs: number): Promise<void>;
  findGrant(grantId: string): Promise<GrantRecord | null>;
  revokeGrant(grantId: string, nowMs: number): Promise<void>;
  findRefresh(tokenHash: string): Promise<RefreshTokenRecord | null>;
  rotateRefresh(oldHash: string, next: RefreshTokenRecord, nowMs: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Redeeming an authorization code
// ---------------------------------------------------------------------------

export type CodeFailure =
  | "unknown_code"
  | "code_replayed"
  | "code_expired"
  | "client_mismatch"
  | "redirect_mismatch"
  | "resource_mismatch"
  | "pkce_failed";

export type CodeResult =
  | { ok: true; record: AuthorizationCodeRecord }
  | { ok: false; reason: CodeFailure };

/** OAuth 2.1 puts the ceiling at ten minutes and recommends under a minute. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;

export interface RedeemCodeArgs {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
  store: TokenStore;
  nowMs?: number;
}

/**
 * Exchange an authorization code, or say precisely why not.
 *
 * A REPLAYED CODE REVOKES THE WHOLE GRANT, which is the rule most worth
 * getting right. A code presented twice means either the client is broken or
 * someone else has it, and there is no way to tell which from here — so the
 * safe reading is the second one, and the grant dies. OAuth 2.1 says so, and
 * the alternative (ignore the second attempt) leaves a live grant in an
 * attacker's hands.
 */
export async function redeemAuthorizationCode(args: RedeemCodeArgs): Promise<CodeResult> {
  const nowMs = args.nowMs ?? Date.now();
  const codeHash = await hashSecret(args.code);
  const record = await args.store.findCode(codeHash);

  if (!record) return { ok: false, reason: "unknown_code" };

  if (record.consumedAtMs !== undefined) {
    // Not just a refusal: the grant this code produced is now suspect, so it
    // goes. A replay we merely refuse leaves the attacker holding a live grant.
    if (record.grantId) await args.store.revokeGrant(record.grantId, nowMs);
    return { ok: false, reason: "code_replayed" };
  }

  // Consume BEFORE the remaining checks. A code that fails a later check is
  // still spent, or the failures become an oracle a caller can probe.
  await args.store.markCodeConsumed(codeHash, nowMs);

  if (record.expiresAtMs <= nowMs) return { ok: false, reason: "code_expired" };
  if (record.clientId !== args.clientId) return { ok: false, reason: "client_mismatch" };
  // The redirect_uri must match the one the code was issued for, EXACTLY.
  // This is what stops a code being exchanged from somewhere else entirely.
  if (record.redirectUri !== args.redirectUri) return { ok: false, reason: "redirect_mismatch" };
  // RFC 8707: the token that comes out of this must be for the resource the
  // authorization was for. Without this a token minted for one resource is
  // presentable at another — the confused-deputy case.
  if (record.resource !== args.resource) return { ok: false, reason: "resource_mismatch" };

  const pkceOk = await verifyPkce(
    args.codeVerifier,
    record.codeChallenge,
    record.codeChallengeMethod,
  );
  if (!pkceOk) return { ok: false, reason: "pkce_failed" };

  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Refresh rotation
// ---------------------------------------------------------------------------

export type RefreshFailure =
  | "unknown_token"
  | "token_expired"
  | "grant_revoked"
  | "reuse_detected";

export type RefreshResult =
  | { ok: true; grant: GrantRecord; nextToken: string }
  | { ok: false; reason: RefreshFailure };

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3_600_000;

export interface RotateArgs {
  refreshToken: string;
  store: TokenStore;
  nowMs?: number;
}

/**
 * Rotate a refresh token, detecting reuse.
 *
 * ROTATION WITHOUT REUSE DETECTION IS BOOKKEEPING. Issuing a new token each
 * time only helps if presenting an OLD one is treated as evidence that someone
 * else has a copy. When that happens the entire grant chain is revoked: the
 * legitimate client is logged out and re-authorizes, which is a small cost, and
 * the attacker's copy dies with it, which is the point.
 */
export async function rotateRefreshToken(args: RotateArgs): Promise<RefreshResult> {
  const nowMs = args.nowMs ?? Date.now();
  const tokenHash = await hashSecret(args.refreshToken);
  const record = await args.store.findRefresh(tokenHash);

  if (!record) return { ok: false, reason: "unknown_token" };

  if (record.rotatedAtMs !== undefined) {
    // Someone is presenting a token that was already exchanged. Either the
    // client replayed, or a copy leaked. Indistinguishable from here, so the
    // whole chain goes.
    await args.store.revokeGrant(record.grantId, nowMs);
    return { ok: false, reason: "reuse_detected" };
  }

  if (record.expiresAtMs <= nowMs) return { ok: false, reason: "token_expired" };

  const grant = await args.store.findGrant(record.grantId);
  if (!grant) return { ok: false, reason: "unknown_token" };
  if (grant.revokedAtMs !== undefined) return { ok: false, reason: "grant_revoked" };

  const nextToken = generateOpaqueToken("gtr");
  await args.store.rotateRefresh(
    tokenHash,
    {
      tokenHash: await hashSecret(nextToken),
      grantId: record.grantId,
      generation: record.generation + 1,
      expiresAtMs: nowMs + REFRESH_TOKEN_TTL_MS,
    },
    nowMs,
  );

  return { ok: true, grant, nextToken };
}

// ---------------------------------------------------------------------------
// Audience binding
// ---------------------------------------------------------------------------

/**
 * Was this token issued for US?
 *
 * A resource server MUST validate the audience (RFC 8707 via the MCP
 * authorization spec). Skipping it means a token a seller granted to some other
 * service, which happens to use the same authorization server, is accepted
 * here — the confused deputy, with a real seller's inventory behind it.
 *
 * Compared exactly. Trailing-slash and case normalisation are the kind of
 * leniency that turns an audience check into a prefix check.
 */
export function isAudienceValid(tokenResource: string, expectedResource: string): boolean {
  return tokenResource === expectedResource;
}
