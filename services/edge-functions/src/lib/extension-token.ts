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

/** Verify a bearer token → { userId } or null (bad shape/expired/tampered/no
 *  secret). Fail-CLOSED: any error resolves to null (anonymous), never throws. */
export async function verifyExtensionToken(token: string | null | undefined): Promise<VerifiedExtensionToken | null> {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [userId, expiresStr, sig] = parts as [string, string, string];
    if (!userId) return null;
    const expires = Number(expiresStr);
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return null;
    const expected = await hmacHex(`${userId}:${expires}`);
    if (!timingSafeEqual(expected, sig)) return null;
    return { userId, expiresAt: expires };
  } catch {
    return null;
  }
}

/** Pull a bearer token from an Authorization header. */
export function bearerFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}
