// AES-256-GCM symmetric encryption for stored OAuth tokens.
//
// Stored format: `v1:<base64-iv>:<base64-ciphertext-with-tag>`.
// The "v1" prefix lets us rotate algorithms later without breaking old rows.
//
// Key is read from EDGE_ENCRYPTION_KEY, which must be a base64-encoded
// 32-byte value (generate with `openssl rand -base64 32`).

const VERSION = "v1";
const IV_BYTES = 12; // 96-bit IV is the AES-GCM spec'd length.

let cachedKey: CryptoKey | null = null;

async function loadKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const raw = Deno.env.get("EDGE_ENCRYPTION_KEY");
  if (!raw) {
    throw new Error(
      "EDGE_ENCRYPTION_KEY is not set. Generate with `openssl rand -base64 32`."
    );
  }
  const keyBytes = base64Decode(raw);
  if (keyBytes.byteLength !== 32) {
    throw new Error(
      `EDGE_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${keyBytes.byteLength}).`
    );
  }
  cachedKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  return cachedKey;
}

export async function encryptToken(plaintext: string): Promise<string> {
  const key = await loadKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext)
    )
  );
  return `${VERSION}:${base64Encode(iv)}:${base64Encode(ciphertext)}`;
}

export async function decryptToken(payload: string): Promise<string> {
  const parts = payload.split(":");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new Error("Unrecognized encrypted token format.");
  }
  const iv = base64Decode(parts[1]!);
  const ciphertext = base64Decode(parts[2]!);
  const key = await loadKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
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
