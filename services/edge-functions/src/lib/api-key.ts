// API-key generation, hashing, and scopes (US-356).
//
// One place owns how a key is produced and how it is hashed for storage so the
// issuer (routes/api-keys.ts) and the verifier (middleware/api-key-auth.ts) can
// never drift. Hashing is HMAC-SHA256 with a server-side pepper when
// API_KEY_PEPPER is set (so a leaked DB row of hashes can't be brute-forced
// without the pepper too), falling back to plain SHA-256 when it is not. NOTE:
// introducing or rotating the pepper invalidates existing hashes — keys must be
// re-issued, so set it before going live, not after.

export const API_KEY_SCOPES = ["read", "submit", "webhook_manage"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// Back-compat default: keys created before scopes existed (and callers that
// don't specify) get the full set, so adding scopes never breaks an existing
// integration. The DB column default mirrors this.
export const DEFAULT_API_KEY_SCOPES: ApiKeyScope[] = [
  "read",
  "submit",
  "webhook_manage",
];

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === "string" &&
    (API_KEY_SCOPES as readonly string[]).includes(value);
}

/**
 * Validate + normalize a caller-supplied scopes array. Returns the deduped,
 * known scopes, or null if the input is present but invalid.
 */
export function normalizeScopes(input: unknown): ApiKeyScope[] | null {
  if (input == null) return [...DEFAULT_API_KEY_SCOPES];
  if (!Array.isArray(input) || input.length === 0) return null;
  const out = new Set<ApiKeyScope>();
  for (const item of input) {
    if (!isApiKeyScope(item)) return null;
    out.add(item);
  }
  return [...out];
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash an API key for storage/lookup. HMAC-with-pepper when configured. */
export async function hashApiKey(fullKey: string): Promise<string> {
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
    return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(fullKey)));
  }
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(fullKey)));
}

/** Generate a fresh key: plaintext (shown once), its hash, and its prefix. */
export async function generateApiKey(): Promise<{
  fullKey: string;
  keyHash: string;
  keyPrefix: string;
}> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const fullKey = "gt_sk_" +
    Array.from(randomBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const keyPrefix = fullKey.slice(0, 14); // "gt_sk_" + 8 hex chars
  const keyHash = await hashApiKey(fullKey);
  return { fullKey, keyHash, keyPrefix };
}

/** Shape/length check for the public key format. */
export function isWellFormedApiKey(key: string): boolean {
  return key.startsWith("gt_sk_") && key.length === 70;
}
