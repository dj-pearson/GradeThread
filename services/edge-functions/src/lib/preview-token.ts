// Signed preview token for unpublished blog posts.
//
// Format: <post_id>.<expires_unix>.<sig_hex>
//
//   sig = HMAC-SHA256( CONTENT_WEBHOOK_SIGNING_SECRET, `${post_id}:${expires_unix}` )
//
// Lets an admin share a draft URL with a reviewer for ~30 minutes without
// giving the reviewer a dashboard account. Verified on the SSR worker side
// by calling /api/content/public/posts/preview/:token here.

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

function getSecret(): string {
  const s = Deno.env.get("CONTENT_WEBHOOK_SIGNING_SECRET")?.trim();
  if (!s) {
    throw new Error(
      "CONTENT_WEBHOOK_SIGNING_SECRET is not set — required to mint preview tokens",
    );
  }
  return s;
}

async function hmacHex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string compare to thwart timing attacks on token verification.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function mintPreviewToken(
  postId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<{ token: string; expiresAt: string }> {
  const ttl = Math.min(Math.max(ttlSeconds, 60), MAX_TTL_SECONDS);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const sig = await hmacHex(`${postId}:${expires}`);
  return {
    token: `${postId}.${expires}.${sig}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

export interface VerifiedToken {
  postId: string;
  expiresAt: number;
}

export async function verifyPreviewToken(
  token: string,
): Promise<VerifiedToken | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [postId, expiresStr, sig] = parts as [string, string, string];

  const expires = Number(expiresStr);
  if (!Number.isFinite(expires)) return null;
  if (expires * 1000 < Date.now()) return null;

  const expected = await hmacHex(`${postId}:${expires}`);
  if (!timingSafeEqual(expected, sig)) return null;

  return { postId, expiresAt: expires };
}
