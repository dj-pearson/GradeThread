// eBay inbound-notification signature verification (US-349 / US-365).
//
// Extracted from flipdesk-webhooks.ts so the verification logic can be unit-
// tested without importing the route module (which pulls in the service-role
// Supabase client and would require DB env at import time). Both the /ebay
// event receiver and the /ebay/account-deletion endpoint MUST run an inbound
// request through verifyEbayHmac BEFORE any side effect.

/** Constant-time string compare (avoids leaking equality via timing). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verify an HMAC-SHA256 signature over the RAW request body using the eBay
 * verification token as the shared secret. Accepts hex or base64 encodings and
 * tolerates a leading `sha256=` prefix. Comparison is constant-time.
 */
export async function verifyEbayHmac(
  body: string,
  presented: string,
  secret: string,
): Promise<boolean> {
  if (!presented || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expectedHex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  const cleaned = presented.replace(/^sha256=/i, "").trim();
  return (
    constantTimeEqual(cleaned.toLowerCase(), expectedHex.toLowerCase()) ||
    constantTimeEqual(cleaned, expectedB64)
  );
}
