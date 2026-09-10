// US-1838: signed extension token — authenticates the buyer to the extension
// endpoints so entitlements (and thus feature gating + quota) are enforceable
// separately from the anonymous web grade-checker.
//
// Mirrors preview-token.ts: `userId.expires.HMAC-SHA256(secret, userId:expires)`.
// Opaque + stateless (no DB read to verify) + tamper-evident + expiring. The
// buyer app mints one after login (POST /api/buyer/extension-token) and hands it
// to the extension; the extension sends it as `Authorization: Bearer <token>`.

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

/** The TTL a fresh token gets. Exported so the clients can reason about it. */
export const EXTENSION_TOKEN_TTL_SECONDS = DEFAULT_TTL_SECONDS;

/**
 * US-3296: how close to expiry a token may get before it is worth replacing.
 *
 * Seven days, because the extension only gets to act when the browser is awake
 * and a seller can easily be away for a long weekend. A renewal this early is
 * free — the old token stays valid until it lapses, so nothing is racing.
 */
export const EXTENSION_TOKEN_RENEW_WITHIN_SECONDS = 7 * 24 * 60 * 60;

/**
 * US-3296: how long AFTER expiry a correctly signed token may still be traded
 * for a fresh one.
 *
 * This is the whole answer to "the browser was closed through the expiry". A
 * laptop shut for five weeks wakes with a dead token and no way back except a
 * button nobody knows to press, which is exactly the failure this story is
 * about. Thirty days, so the worst case for a leaked token that is never used
 * in time is a 60-day window rather than an unbounded one — the grace is a
 * sliding renewal, not an eternal one, and every renewal re-checks the account
 * (deleted / unverified) before it mints.
 */
export const EXTENSION_TOKEN_RENEW_GRACE_SECONDS = 30 * 24 * 60 * 60;

function secret(): string {
  const s = Deno.env.get("EXTENSION_TOKEN_SECRET")?.trim();
  if (!s) throw new Error("EXTENSION_TOKEN_SECRET is not set");
  return s;
}

async function hmacHex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function mintExtensionToken(
  userId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<{ token: string; expiresAt: string }> {
  const ttl = Math.min(Math.max(ttlSeconds, 60), MAX_TTL_SECONDS);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const sig = await hmacHex(`${userId}:${expires}`);
  return { token: `${userId}.${expires}.${sig}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export interface VerifiedExtensionToken {
  userId: string;
  expiresAt: number;
}

/**
 * US-3296: what a bearer token IS, not merely whether it passes.
 *
 *   absent  — no token was sent. The install has never been connected.
 *   invalid — wrong shape, wrong signature, or no secret configured.
 *   expired — correctly signed by us, and past its expiry.
 *   valid   — usable now.
 *
 * `expired` is the state that had nowhere to be reported. It collapsed into the
 * same null `verifyExtensionToken` returns for "no token at all", so the server
 * answered with the anonymous entitlements and every downstream surface told a
 * connected, paying seller to connect (or worse, to buy a plan). Expired and
 * never-connected want opposite words: "reconnect" and "connect".
 */
export type ExtensionTokenStatus = "absent" | "invalid" | "expired" | "valid";

export interface ExtensionTokenInspection {
  status: ExtensionTokenStatus;
  /** The account the token names. Set only when the SIGNATURE checked out. */
  userId: string | null;
  /** Unix seconds. Set only when the signature checked out. */
  expiresAt: number | null;
}

const ABSENT: ExtensionTokenInspection = { status: "absent", userId: null, expiresAt: null };
const INVALID: ExtensionTokenInspection = { status: "invalid", userId: null, expiresAt: null };

/**
 * Inspect a bearer token. Never throws — a missing secret reads as `invalid`,
 * which keeps the fail-closed posture the whole extension surface relies on.
 *
 * The userId and expiry are reported ONLY once the HMAC verifies, so nothing
 * downstream can be steered by the unauthenticated first two segments of a
 * token somebody made up.
 */
export async function inspectExtensionToken(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<ExtensionTokenInspection> {
  if (!token) return ABSENT;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return INVALID;
    const [userId, expiresStr, sig] = parts as [string, string, string];
    if (!userId) return INVALID;
    const expires = Number(expiresStr);
    if (!Number.isFinite(expires)) return INVALID;
    const expected = await hmacHex(`${userId}:${expires}`);
    if (!timingSafeEqual(expected, sig)) return INVALID;
    return {
      status: expires * 1000 < nowMs ? "expired" : "valid",
      userId,
      expiresAt: expires,
    };
  } catch {
    return INVALID;
  }
}

/** Verify a bearer token → { userId } or null (bad shape/expired/tampered/no
 *  secret). Fail-CLOSED: any error resolves to null (anonymous), never throws. */
export async function verifyExtensionToken(token: string | null | undefined): Promise<VerifiedExtensionToken | null> {
  const seen = await inspectExtensionToken(token);
  if (seen.status !== "valid" || !seen.userId || seen.expiresAt === null) return null;
  return { userId: seen.userId, expiresAt: seen.expiresAt };
}

/**
 * May this token be traded for a fresh one? (US-3296)
 *
 * Valid always. Expired only inside the grace window — and note what is NOT
 * accepted: `invalid`, which covers a forged signature and a shape we never
 * minted. A renewal is an authentication, so the signature is the whole
 * gate; the grace only relaxes the clock.
 */
export function isRenewableExtensionToken(
  seen: ExtensionTokenInspection,
  nowMs: number = Date.now(),
): boolean {
  if (seen.status === "valid") return true;
  if (seen.status !== "expired" || seen.expiresAt === null) return false;
  return nowMs - seen.expiresAt * 1000 <= EXTENSION_TOKEN_RENEW_GRACE_SECONDS * 1000;
}

/**
 * Is this token close enough to expiry that it should be replaced now? PURE, so
 * both the web handoff and the extension's own tick can ask the same question
 * of the same number.
 */
export function isExtensionTokenNearingExpiry(
  expiresAtSeconds: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (typeof expiresAtSeconds !== "number" || !Number.isFinite(expiresAtSeconds)) return true;
  return expiresAtSeconds * 1000 - nowMs <= EXTENSION_TOKEN_RENEW_WITHIN_SECONDS * 1000;
}

/**
 * What a renewal request should do, decided from the token alone. (US-3296)
 *
 * PURE and separately exported because the interesting cases are all about the
 * clock, and a route handler that needs a live Supabase client to be reachable
 * is a route handler nobody writes the 31-day case against. The route keeps the
 * I/O (the account re-check and the mint); this owns the judgement.
 *
 *   connect   — nothing was sent. Never connected: say "connect".
 *   reconnect — forged, malformed, or expired past the grace window.
 *   renew     — signed by us and inside the window. Mint a fresh one.
 */
export type ExtensionTokenRenewalDecision =
  | { outcome: "connect" }
  | { outcome: "reconnect" }
  | { outcome: "renew"; userId: string };

export function decideExtensionTokenRenewal(
  seen: ExtensionTokenInspection,
  nowMs: number = Date.now(),
): ExtensionTokenRenewalDecision {
  if (seen.status === "absent") return { outcome: "connect" };
  if (!seen.userId || !isRenewableExtensionToken(seen, nowMs)) return { outcome: "reconnect" };
  return { outcome: "renew", userId: seen.userId };
}

/**
 * What to TELL the seller about a connection in this state. (US-3296 AC3)
 *
 * The three words are not interchangeable and the whole story is that they were
 * being treated as one:
 *   ok        — connected and current.
 *   connect   — no token was ever stored here.
 *   reconnect — a token WAS stored and is no longer usable.
 *
 * Note what is missing: "upgrade". Nothing about a token's state is evidence
 * about a plan, and a client that infers one from the other is how a Business
 * seller ends up looking at /pricing.
 */
export type ExtensionConnectionAdvice = "ok" | "connect" | "reconnect";

export function extensionConnectionAdvice(
  status: ExtensionTokenStatus,
): ExtensionConnectionAdvice {
  if (status === "valid") return "ok";
  if (status === "absent") return "connect";
  return "reconnect";
}

/** Pull a bearer token from an Authorization header. */
export function bearerFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}
