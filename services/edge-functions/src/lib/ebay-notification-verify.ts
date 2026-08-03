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
// eBay's account-deletion keys are ECDSA (P-256) with a SHA-1 digest — the
// `algorithm`/`digest` fields of the public_key response say which. Ed25519 and
// RSA are also handled defensively in case eBay rotates the keyset's scheme.
//
// GOTCHA (ECDSA): eBay sends the signature in DER/ASN.1 form (OpenSSL's native
// EC signature encoding), but WebCrypto's verify expects raw r‖s (IEEE P1363).
// We convert DER → raw before verifying — see derToRawEcdsa. Skipping this made
// every genuine notification fail with "signature mismatch" → 401, which made
// eBay retry endlessly and flag the endpoint unhealthy.
//
// Verifying with the wrong scheme (HMAC) rejected every real notification with
// a 401, which made eBay retry endlessly and flag the endpoint as unhealthy.

import { apiHost, getAppAccessToken } from "./ebay-client.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";

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
  verifyAlg: AlgorithmIdentifier | EcdsaParams;
  // ECDSA signatures arrive DER-encoded and must be converted to raw r‖s
  // before WebCrypto can verify them. coordSize is the per-coordinate byte
  // length for the curve (32 for P-256). null for non-ECDSA keys.
  ecdsaCoordSize: number | null;
}

// Map eBay's `digest` field ("SHA1" | "SHA256" | ...) to a WebCrypto hash name.
// eBay's notification keys use SHA-1; default to it when the field is absent.
export function digestToHash(digest: string | undefined): string {
  const d = (digest ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (d === "SHA256") return "SHA-256";
  if (d === "SHA384") return "SHA-384";
  if (d === "SHA512") return "SHA-512";
  return "SHA-1";
}

// Convert a DER-encoded ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) to
// the fixed-length raw r‖s form WebCrypto's verify() requires. Returns null if
// the bytes aren't a well-formed DER ECDSA signature (treated as a reject).
export function derToRawEcdsa(der: Uint8Array, coordSize: number): Uint8Array | null {
  try {
    let o = 0;
    if (der[o++] !== 0x30) return null; // SEQUENCE
    // SEQUENCE length: skip short- or long-form length octets.
    if (der[o] & 0x80) o += (der[o] & 0x7f) + 1;
    else o++;
    const readInt = (): Uint8Array | null => {
      if (der[o++] !== 0x02) return null; // INTEGER
      const len = der[o++];
      let v = der.subarray(o, o + len);
      o += len;
      // Strip the leading 0x00 sign-padding DER uses for high-bit integers.
      while (v.length > 1 && v[0] === 0x00) v = v.subarray(1);
      if (v.length > coordSize) return null;
      const out = new Uint8Array(coordSize);
      out.set(v, coordSize - v.length); // left-pad to fixed width
      return out;
    };
    const r = readInt();
    const s = readInt();
    if (!r || !s) return null;
    const raw = new Uint8Array(coordSize * 2);
    raw.set(r, 0);
    raw.set(s, coordSize);
    return raw;
  } catch {
    return null;
  }
}

// Public keys rotate rarely; cache by kid for the process lifetime.
const keyCache = new Map<string, CachedKey>();

// US-2326 AC4: a NEGATIVE cache, and why it is the load-bearing half.
//
// `kid` comes from the request's own signature header, so an unauthenticated
// caller chooses it. Only SUCCESSES were cached, so every request bearing a kid
// that does not resolve produced a fresh getAppAccessToken + a call to eBay's
// public_key endpoint — bounded by nothing but the 600/60s limiter. That is 600
// unauthenticated outbound eBay calls per minute per replica, burning the app's
// own API quota, on requests that were going to be rejected anyway.
//
// Caching the FAILURE removes the amplification: a bad kid costs one lookup per
// window, not one per request. The TTL is short because a kid can legitimately
// start resolving (eBay publishes a new key) and a long negative cache would
// then reject genuine notifications until the process restarted.
const NEGATIVE_TTL_MS = 5 * 60_000;
const keyMisses = new Map<string, number>();

/** Deadline for the public-key lookup. Short: it sits in a webhook's path. */
const KEY_FETCH_TIMEOUT_MS = 5_000;

/** Exposed for tests — a process-lifetime cache otherwise leaks between cases. */
export function _resetKeyCaches(): void {
  keyCache.clear();
  keyMisses.clear();
}

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

// Fetch eBay's published public-key material for a kid from the Notification
// API. Isolated from the crypto-import below (loadPublicKey) so it can be
// swapped for a fixture in tests — verifyEbayNotification takes this as an
// injectable param, the same pattern as the rate limiter's incrementer.
export type PublicKeyFetcher = (
  kid: string,
) => Promise<EbayPublicKeyResponse | null>;

const fetchPublicKeyMaterial: PublicKeyFetcher = async (kid) => {
  let res: Response;
  try {
    const token = await getAppAccessToken();
    // US-2326 AC4: bounded. This was a bare fetch with no deadline, reached
    // from an unauthenticated webhook, so a slow or hanging eBay pinned a
    // request handler for as long as it liked.
    res = await fetchWithTimeout(
      `${apiHost()}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      KEY_FETCH_TIMEOUT_MS,
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
  return (await res.json()) as EbayPublicKeyResponse;
};

async function loadPublicKey(
  kid: string,
  fetchKey: PublicKeyFetcher,
): Promise<CachedKey | null> {
  // Only the real (network) fetcher uses the process cache; an injected fixture
  // fetcher always re-imports so tests stay independent of cache state.
  const useCache = fetchKey === fetchPublicKeyMaterial;
  if (useCache) {
    const cached = keyCache.get(kid);
    if (cached) return cached;
    // A kid that recently failed to resolve is refused WITHOUT going to eBay.
    const missedAt = keyMisses.get(kid);
    if (missedAt !== undefined && Date.now() - missedAt < NEGATIVE_TTL_MS) {
      return null;
    }
  }

  const pk = await fetchKey(kid);
  if (!pk) {
    if (useCache) keyMisses.set(kid, Date.now());
    return null;
  }
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
    if (alg.includes("ECDSA") || alg.includes("EC_")) {
      // eBay's notification keys are ECDSA on P-256 with a SHA-1 digest.
      const hash = digestToHash(pk.digest);
      const key = await crypto.subtle.importKey(
        "spki",
        der as unknown as ArrayBuffer,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      entry = {
        key,
        verifyAlg: { name: "ECDSA", hash },
        ecdsaCoordSize: 32, // P-256
      };
    } else if (alg.includes("ED25519")) {
      const key = await crypto.subtle.importKey(
        "spki",
        der as unknown as ArrayBuffer,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      entry = { key, verifyAlg: { name: "Ed25519" }, ecdsaCoordSize: null };
    } else if (alg.includes("RSA")) {
      const key = await crypto.subtle.importKey(
        "spki",
        der as unknown as ArrayBuffer,
        // RSA path is defensive (eBay uses ECDSA for notifications); SHA-256
        // is the sensible default when no digest is advertised.
        { name: "RSASSA-PKCS1-v1_5", hash: pk.digest ? digestToHash(pk.digest) : "SHA-256" },
        false,
        ["verify"],
      );
      entry = {
        key,
        verifyAlg: { name: "RSASSA-PKCS1-v1_5" },
        ecdsaCoordSize: null,
      };
    } else {
      console.warn(`[ebay-notify] unsupported key algorithm: ${pk.algorithm}`);
      return null;
    }
    if (useCache) keyCache.set(kid, entry);
    return entry;
  } catch (err) {
    console.warn("[ebay-notify] importKey failed:", err);
    return null;
  }
}

// Verify an inbound eBay Notification-API request. `rawBody` MUST be the exact
// bytes eBay sent (re-serializing JSON would change them and break the check).
// Returns true only on a cryptographically valid eBay signature. `fetchKey` is
// injectable so a fixture test can supply eBay-format key material without the
// network; production callers omit it and use the real Notification-API fetch.
export async function verifyEbayNotification(
  rawBody: string,
  signatureHeader: string,
  fetchKey: PublicKeyFetcher = fetchPublicKeyMaterial,
): Promise<boolean> {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const entry = await loadPublicKey(parsed.kid, fetchKey);
  if (!entry) return false;
  let sig: Uint8Array;
  try {
    sig = base64ToBytes(parsed.signature);
  } catch {
    return false;
  }
  // ECDSA signatures arrive DER-encoded; WebCrypto needs raw r‖s.
  if (entry.ecdsaCoordSize !== null) {
    const raw = derToRawEcdsa(sig, entry.ecdsaCoordSize);
    if (!raw) {
      console.warn("[ebay-notify] malformed DER ECDSA signature");
      return false;
    }
    sig = raw;
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
