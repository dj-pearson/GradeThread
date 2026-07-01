// Standard Webhooks (standardwebhooks.com) verification — the signing scheme
// GoTrue uses for its "send email" auth hook. Symmetric HMAC-SHA256 over
// `${id}.${timestamp}.${body}`, base64-encoded, compared against the
// `webhook-signature` header (a space-separated list of `v1,<sig>` entries).
//
// Pure + dependency-free (Web Crypto only) so it's unit-tested independently of
// the route.

const encoder = new TextEncoder();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

// A GOTRUE_HOOK_SEND_EMAIL_SECRETS value is a `|`-separated list of secrets,
// each formatted `v1,whsec_<base64key>` (the `v1,` version prefix and `whsec_`
// symmetric marker are both optional / stripped). Returns the raw HMAC key
// bytes for each configured secret so rotation (two live secrets) works.
export function parseWebhookSecrets(raw: string | undefined | null): Uint8Array[] {
  if (!raw) return [];
  return raw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // Strip an optional version prefix ("v1,").
      let key = s.includes(",") ? s.slice(s.indexOf(",") + 1) : s;
      // Strip the "whsec_" symmetric-secret marker.
      if (key.startsWith("whsec_")) key = key.slice("whsec_".length);
      try {
        return base64ToBytes(key);
      } catch {
        // Not base64 — fall back to the literal UTF-8 bytes (defensive).
        return encoder.encode(key);
      }
    });
}

async function sign(keyBytes: Uint8Array, signedContent: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    // Copy into a fresh ArrayBuffer-backed view (the union of decode branches
    // widens to ArrayBufferLike, which the strict lib rejects as BufferSource).
    "raw",
    new Uint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedContent));
  return bytesToBase64(new Uint8Array(sig));
}

// Constant-time string compare (equal lengths); false on any length mismatch.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

// GoTrue emits `webhook-*`; the Svix reference impl uses `svix-*`. Accept both.
export function readWebhookHeaders(h: Headers): WebhookHeaders {
  return {
    id: h.get("webhook-id") ?? h.get("svix-id"),
    timestamp: h.get("webhook-timestamp") ?? h.get("svix-timestamp"),
    signature: h.get("webhook-signature") ?? h.get("svix-signature"),
  };
}

const DEFAULT_TOLERANCE_SEC = 300;

// Verify a Standard Webhooks signature. `nowSec` is injectable for tests.
export async function verifyStandardWebhook(opts: {
  body: string;
  headers: WebhookHeaders;
  secrets: Uint8Array[];
  nowSec?: number;
  toleranceSec?: number;
}): Promise<boolean> {
  const { body, headers, secrets } = opts;
  if (!secrets.length) return false;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tol = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  // Reject stale/future timestamps to blunt replay.
  if (Math.abs(now - ts) > tol) return false;

  const signedContent = `${headers.id}.${headers.timestamp}.${body}`;
  // The header carries a space-separated list of `v1,<sig>` entries.
  const provided = headers.signature
    .split(" ")
    .map((p) => {
      const idx = p.indexOf(",");
      return idx >= 0 ? p.slice(idx + 1) : p;
    })
    .filter(Boolean);

  for (const keyBytes of secrets) {
    const expected = await sign(keyBytes, signedContent);
    for (const sig of provided) {
      if (timingSafeEqual(sig, expected)) return true;
    }
  }
  return false;
}
