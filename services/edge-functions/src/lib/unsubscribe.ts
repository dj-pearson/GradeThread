// No-login email unsubscribe tokens (US-516 / CAN-SPAM).
//
// Commercial email must offer an unsubscribe that works WITHOUT logging in. We
// put a signed token in the footer link; the public /unsubscribe endpoint
// verifies it and flips the recipient's marketing (product_updates) preference.
// The token is an HMAC over the user id so it can't be forged to unsubscribe
// someone else, and carries no secret itself.
//
// Signing key: UNSUBSCRIBE_SECRET if set, else the service-role key (always
// present, secret, server-only). Either way the token is opaque + unforgeable.

const SITE_URL = "https://gradethread.com";

function signingKey(): string {
  return (
    Deno.env.get("UNSUBSCRIBE_SECRET")?.trim() ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    Deno.env.get("SUPABASE_SERVICE_KEY")?.trim() ||
    "dev-unsubscribe-key"
  );
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(userId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`unsub:${userId}`));
  return toHex(mac);
}

export async function unsubscribeToken(userId: string): Promise<string> {
  return await hmac(userId);
}

// Constant-time compare so a wrong token can't be probed byte-by-byte.
export async function verifyUnsubscribeToken(userId: string, token: string): Promise<boolean> {
  const expected = await hmac(userId);
  if (typeof token !== "string" || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

// The footer link. Points at the edge unsubscribe endpoint so it works with no
// session and no SPA round-trip.
export async function marketingUnsubscribeUrl(userId: string): Promise<string> {
  const token = await unsubscribeToken(userId);
  const base = Deno.env.get("FUNCTIONS_URL")?.trim() || "https://functions.gradethread.com";
  return `${base}/api/notifications/unsubscribe?u=${encodeURIComponent(userId)}&t=${token}`;
}

export { SITE_URL };
