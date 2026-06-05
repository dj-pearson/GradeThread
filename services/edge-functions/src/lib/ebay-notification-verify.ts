// eBay Notification API inbound-signature verification (Marketplace Account
// Deletion + other Notification-API events).
//
// IMPORTANT: eBay does NOT HMAC these notifications with your verification
// token (that token is only for the GET challenge handshake). eBay signs the
// notification with ITS OWN private key. To verify, you:
//   1. base64-decode the `x-ebay-signature` header → JSON { kid, signature, ... }
//   2. fetch eBay's public key for that `kid` from the Notification API
//      (GET /commerce/notification/v1/public_key/{kid}, app-token auth)
//   3. verify `signature` (base64) over the RAW request body using that key.
// eBay's account-deletion keys are Ed25519 (RSA also handled defensively).
//
// Verifying with the wrong scheme (HMAC) rejected every real notification with
// a 401, which made eBay retry endlessly and flag the endpoint as unhealthy.

import { apiHost, getAppAccessToken } from "./ebay-client.ts";

interface XEbaySignature {
  kid: string;
  signature: string; // base64
  alg?: string;
}

interface EbayPublicKeyResponse {
  algorithm?: string; // "ED25519" | "RSA" | "ECDSA"
  digest?: string; // e.g. "SHA1"
  key: string; // base64 SPKI (DER), may or may not carry PEM armor
}

interface CachedKey {
  key: CryptoKey;
  verifyAlg: AlgorithmIdentifier;
}

// Public keys rotate rarely; cache by kid for the process lifetime.
const keyCache = new Map<string, CachedKey>();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The `x-ebay-signature` header is base64-encoded JSON. Returns null if it
// isn't (e.g. a spoofed/legacy request), which the caller treats as a reject.
export function parseSignatureHeader(header: string): XEbaySignature | null {
  if (!header) return null;
  try {
    const json = new TextDecoder().decode(base64ToBytes(header));
    const obj = JSON.parse(json) as Partial<XEbaySignature>;
    if (typeof obj.kid === "string" && typeof obj.signature === "string") {
      return { kid: obj.kid, signature: obj.signature, alg: obj.alg };
    }
  } catch {
    // not base64-JSON → not a genuine eBay Notification-API signature
  }
  return null;
}

// eBay returns the SPKI key as base64 (sometimes with PEM armor). Strip armor +
// whitespace and decode to raw DER bytes for WebCrypto importKey("spki").
function keyToDer(key: string): Uint8Array {
  const b64 = key
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(b64);
}

async function loadPublicKey(kid: string): Promise<CachedKey | null> {
  const cached = keyCache.get(kid);
  if (cached) return cached;

  let res: Response;
  try {
    const token = await getAppAccessToken();
    res = await fetch(
      `${apiHost()}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    console.warn("[ebay-notify] public_key fetch threw:", err);
    return null;
  }
  if (!res.ok) {
    console.warn(
      `[ebay-notify] public_key fetch failed kid=${kid} status=${res.status}`,
    );
    return null;
  }

  const pk = (await res.json()) as EbayPublicKeyResponse;
  const alg = (pk.algorithm ?? "").toUpperCase();
  let der: Uint8Array;
  try {
    der = keyToDer(pk.key);
  } catch (err) {
    console.warn("[ebay-notify] could not decode public key:", err);
    return null;
  }

  try {
    let entry: CachedKey;
    if (alg.includes("ED25519")) {
      const key = await crypto.subtle.importKey(
        "spki",
        der as unknown as ArrayBuffer,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      entry = { key, verifyAlg: { name: "Ed25519" } };
    } else if (alg.includes("RSA")) {
      const key = await crypto.subtle.importKey(
        "spki",
        der as unknown as ArrayBuffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      entry = { key, verifyAlg: { name: "RSASSA-PKCS1-v1_5" } };
    } else {
      console.warn(`[ebay-notify] unsupported key algorithm: ${pk.algorithm}`);
      return null;
    }
    keyCache.set(kid, entry);
    return entry;
  } catch (err) {
    console.warn("[ebay-notify] importKey failed:", err);
    return null;
  }
}

// Verify an inbound eBay Notification-API request. `rawBody` MUST be the exact
// bytes eBay sent (re-serializing JSON would change them and break the check).
// Returns true only on a cryptographically valid eBay signature.
export async function verifyEbayNotification(
  rawBody: string,
  signatureHeader: string,
): Promise<boolean> {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const entry = await loadPublicKey(parsed.kid);
  if (!entry) return false;
  let sig: Uint8Array;
  try {
    sig = base64ToBytes(parsed.signature);
  } catch {
    return false;
  }
  const data = new TextEncoder().encode(rawBody);
  try {
    return await crypto.subtle.verify(
      entry.verifyAlg,
      entry.key,
      sig as unknown as ArrayBuffer,
      data as unknown as ArrayBuffer,
    );
  } catch (err) {
    console.warn("[ebay-notify] verify threw:", err);
    return false;
  }
}
