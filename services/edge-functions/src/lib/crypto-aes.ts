// AES-256-GCM symmetric encryption for stored OAuth tokens (US-352).
//
// Stored formats:
//   v2:<keyId>:<base64-iv>:<base64-ciphertext-with-tag>   (current)
//   v1:<base64-iv>:<base64-ciphertext-with-tag>            (legacy, decrypt-only)
//
// v2 adds two hardening properties over v1:
//   1. AAD binding — the owning user_id is passed as AES-GCM additionalData, so
//      a ciphertext copied onto a DIFFERENT tenant's row fails to decrypt (the
//      tag covers the AAD). v1 had no such binding.
//   2. Key id — the ciphertext records WHICH key encrypted it, enabling
//      key rotation without a flag day: a new active key encrypts new rows while
//      retired keys still decrypt old rows. See "Key rotation" below.
//
// Keys come from env (secrets manager only — never committed):
//   EDGE_ENCRYPTION_KEY      base64 of 32 random bytes (the ACTIVE key)
//   EDGE_ENCRYPTION_KEY_ID   short label for the active key, default "k1"
//   EDGE_ENCRYPTION_KEYS_OLD optional, comma-separated `id:base64key` pairs of
//                            retired keys kept ONLY to decrypt not-yet-rotated
//                            rows during a rotation window.
//
// Key rotation procedure:
//   1. Generate a new key (`openssl rand -base64 32`).
//   2. Move the current key into EDGE_ENCRYPTION_KEYS_OLD as `<oldId>:<oldB64>`,
//      set EDGE_ENCRYPTION_KEY=<newB64> and EDGE_ENCRYPTION_KEY_ID=<newId>.
//   3. Deploy. New writes use the new key; old rows still decrypt via the OLD
//      set. The eBay refresh path re-encrypts access tokens with the active key
//      on every refresh, so rows migrate naturally; run a one-off
//      decrypt→encrypt backfill to rotate the rest immediately.
//   4. Once no row references the old id, remove it from EDGE_ENCRYPTION_KEYS_OLD.

const VERSION_V1 = "v1"; // legacy, no key id, no AAD
const VERSION_V2 = "v2"; // current: keyed + AAD-bound
const IV_BYTES = 12; // 96-bit IV is the AES-GCM spec'd length.
const DEFAULT_KEY_ID = "k1";

interface EncryptOptions {
  /**
   * Additional authenticated data bound into the GCM tag (NOT encrypted, but
   * tamper-evident). Pass the owning user_id so a ciphertext can't be replayed
   * onto another tenant's row. Required for new (v2) writes in practice.
   */
  aad?: string;
}

// id → imported CryptoKey, lazily built and cached.
const keyCache = new Map<string, CryptoKey>();
// id → raw base64, parsed once from env.
let keyRegistry: Map<string, string> | null = null;
let activeKeyId: string | null = null;

function parseRegistry(): { registry: Map<string, string>; active: string } {
  if (keyRegistry && activeKeyId) {
    return { registry: keyRegistry, active: activeKeyId };
  }
  const registry = new Map<string, string>();

  const active = (Deno.env.get("EDGE_ENCRYPTION_KEY_ID") ?? DEFAULT_KEY_ID).trim();
  const activeRaw = Deno.env.get("EDGE_ENCRYPTION_KEY");
  if (!activeRaw) {
    throw new Error(
      "EDGE_ENCRYPTION_KEY is not set. Generate with `openssl rand -base64 32`.",
    );
  }
  registry.set(active, activeRaw.trim());

  // Retired keys kept for decryption during rotation.
  const old = Deno.env.get("EDGE_ENCRYPTION_KEYS_OLD");
  if (old) {
    for (const pair of old.split(",")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) {
        throw new Error(
          "EDGE_ENCRYPTION_KEYS_OLD entries must be `id:base64key`.",
        );
      }
      const id = trimmed.slice(0, idx).trim();
      const b64 = trimmed.slice(idx + 1).trim();
      if (!registry.has(id)) registry.set(id, b64);
    }
  }

  keyRegistry = registry;
  activeKeyId = active;
  return { registry, active };
}

async function getKey(id: string): Promise<CryptoKey> {
  const cached = keyCache.get(id);
  if (cached) return cached;
  const { registry } = parseRegistry();
  const raw = registry.get(id);
  if (!raw) {
    throw new Error(`No encryption key registered for key id "${id}".`);
  }
  const keyBytes = base64Decode(raw);
  if (keyBytes.byteLength !== 32) {
    throw new Error(
      `Encryption key "${id}" must decode to exactly 32 bytes (got ${keyBytes.byteLength}).`,
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  keyCache.set(id, key);
  return key;
}

function aadBytes(aad?: string): Uint8Array | undefined {
  return aad ? new TextEncoder().encode(aad) : undefined;
}

export async function encryptToken(
  plaintext: string,
  opts: EncryptOptions = {},
): Promise<string> {
  const { active } = parseRegistry();
  const key = await getKey(active);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aad = aadBytes(opts.aad);
  const params: AesGcmParams = aad
    ? { name: "AES-GCM", iv, additionalData: aad }
    : { name: "AES-GCM", iv };
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(params, key, new TextEncoder().encode(plaintext)),
  );
  return `${VERSION_V2}:${active}:${base64Encode(iv)}:${base64Encode(ciphertext)}`;
}

export async function decryptToken(
  payload: string,
  opts: EncryptOptions = {},
): Promise<string> {
  const parts = payload.split(":");

  // v2:<keyId>:<iv>:<ct> — keyed + AAD-bound.
  if (parts[0] === VERSION_V2) {
    if (parts.length !== 4) {
      throw new Error("Unrecognized encrypted token format (v2).");
    }
    const keyId = parts[1]!;
    const iv = base64Decode(parts[2]!);
    const ciphertext = base64Decode(parts[3]!);
    const key = await getKey(keyId);
    const aad = aadBytes(opts.aad);
    const params: AesGcmParams = aad
      ? { name: "AES-GCM", iv, additionalData: aad }
      : { name: "AES-GCM", iv };
    const plaintext = await crypto.subtle.decrypt(params, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  }

  // v1:<iv>:<ct> — legacy, primary key, no AAD. Decrypt-only for old rows.
  if (parts[0] === VERSION_V1) {
    if (parts.length !== 3) {
      throw new Error("Unrecognized encrypted token format (v1).");
    }
    const iv = base64Decode(parts[1]!);
    const ciphertext = base64Decode(parts[2]!);
    const { active } = parseRegistry();
    const key = await getKey(active);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  }

  throw new Error("Unrecognized encrypted token format.");
}

// Test seam: clear the cached key registry so a test can swap env vars.
export function _resetKeyCacheForTest(): void {
  keyCache.clear();
  keyRegistry = null;
  activeKeyId = null;
}

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64Decode(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
