// US-1901: hand-rolled Web Push (browser push) using ONLY Deno Web Crypto.
//
// The edge runs Deno + Hono with ESM imports (deno.land/x, esm.sh) — there is no
// `npm:web-push` here — so the Web Push cryptography is implemented directly
// against the two RFCs it is built from:
//
//   • RFC 8291 (Message Encryption for Web Push) — derives the content key from
//     an ECDH shared secret + the subscription's auth secret, then encrypts with
//   • RFC 8188 (aes128gcm content coding) — a single GCM record with a binary
//     header (salt || rs || keyid-length || keyid) prepended.
//   • RFC 8292 (VAPID) — an ES256 JWT identifying the application server, sent in
//     the Authorization header so the push service accepts the POST.
//
// Correctness is pinned by web-push_test.ts, which reproduces the RFC 8291
// Appendix A published vector byte-for-byte. If that test fails, the crypto here
// is wrong — do not "fix" the test.

import { fetchWithTimeout } from "./circuit-breaker.ts";

// ── base64url helpers ───────────────────────────────────────────────

export function b64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

// ── EC key import helpers ───────────────────────────────────────────
//
// A P-256 raw public key is the uncompressed point 0x04 || X(32) || Y(32); the
// raw private key is the 32-byte scalar `d`. Web Crypto imports EC keys as JWK,
// so we reconstruct the JWK coordinates from those raw bytes.

function jwkFromRaw(
  publicRaw: Uint8Array,
  privateD: Uint8Array | null,
): JsonWebKey {
  if (publicRaw.length !== 65 || publicRaw[0] !== 0x04) {
    throw new Error("expected an uncompressed P-256 public point (0x04 || X || Y)");
  }
  const x = b64UrlEncode(publicRaw.slice(1, 33));
  const y = b64UrlEncode(publicRaw.slice(33, 65));
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x, y, ext: true };
  if (privateD) jwk.d = b64UrlEncode(privateD);
  return jwk;
}

export interface EcdhKeyPair {
  privateKey: CryptoKey;
  /** raw uncompressed public point (0x04 || X || Y), 65 bytes */
  publicKeyBytes: Uint8Array;
}

// Import an application-server (as) ECDH keypair from base64url raw private (d)
// + public point. Injected by the test to reproduce the RFC vector; production
// uses a freshly-generated ephemeral pair per message.
export async function importEcdhKeyPair(
  privateKeyB64Url: string,
  publicKeyB64Url: string,
): Promise<EcdhKeyPair> {
  const publicKeyBytes = b64UrlDecode(publicKeyB64Url);
  const jwk = jwkFromRaw(publicKeyBytes, b64UrlDecode(privateKeyB64Url));
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return { privateKey, publicKeyBytes };
}

async function generateEcdhKeyPair(): Promise<EcdhKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return { privateKey: pair.privateKey, publicKeyBytes };
}

// HKDF (extract + expand in one) via Web Crypto: returns `length` bytes.
async function hkdf(
  ikm: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ── RFC 8291 + RFC 8188 payload encryption ──────────────────────────

const RECORD_SIZE = 4096;

export interface EncryptOptions {
  /** 16-byte record salt; generated when omitted (must be random per message). */
  salt?: Uint8Array<ArrayBuffer>;
  /** Application-server ECDH keypair; a fresh ephemeral pair is used when omitted. */
  asKeyPair?: EcdhKeyPair;
}

// Encrypt `payload` for a subscription's ua (user agent) public key + auth
// secret, producing the full aes128gcm request body (header || ciphertext).
export async function encryptPayload(
  payload: Uint8Array | string,
  uaPublicKeyB64Url: string,
  authSecretB64Url: string,
  opts: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = typeof payload === "string" ? utf8(payload) : payload;
  const uaPublic = b64UrlDecode(uaPublicKeyB64Url);
  const authSecret = b64UrlDecode(authSecretB64Url);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asKeyPair = opts.asKeyPair ?? (await generateEcdhKeyPair());

  // ECDH: shared secret between the application server (as) private key and the
  // user agent (ua) public key.
  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublicKey },
      asKeyPair.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.4 — combine the ECDH secret with the auth secret to get the IKM.
  //   IKM = HKDF(salt=auth_secret, IKM=ecdh_secret,
  //             info="WebPush: info" || 0x00 || ua_public || as_public, L=32)
  const keyInfo = concat(
    utf8("WebPush: info"),
    new Uint8Array([0]),
    uaPublic,
    asKeyPair.publicKeyBytes,
  );
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  // RFC 8188 §2.2 — derive the content encryption key + nonce from the record
  // salt and the IKM.
  const cek = await hkdf(
    ikm,
    salt,
    concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    ikm,
    salt,
    concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );

  // Single record: plaintext followed by the 0x02 last-record padding delimiter
  // (RFC 8188 §2.1), then AES-128-GCM (Web Crypto appends the 16-byte tag).
  const padded = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      padded,
    ),
  );

  // RFC 8188 §2.1 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid.
  // For Web Push the keyid is the as_public key (65 bytes).
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  const header = concat(
    salt,
    rs,
    new Uint8Array([asKeyPair.publicKeyBytes.length]),
    asKeyPair.publicKeyBytes,
  );

  return concat(header, ciphertext);
}

// ── RFC 8292 VAPID JWT (ES256) ──────────────────────────────────────

async function importVapidSigningKey(
  publicKeyB64Url: string,
  privateKeyB64Url: string,
): Promise<CryptoKey> {
  const jwk = jwkFromRaw(
    b64UrlDecode(publicKeyB64Url),
    b64UrlDecode(privateKeyB64Url),
  );
  return await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

// Sign a VAPID JWT for `audience` (the push service origin). `subject` is a
// mailto:/https: contact. exp is capped well under the 24h RFC 8292 ceiling.
export async function signVapidJwt(
  audience: string,
  subject: string,
  publicKeyB64Url: string,
  privateKeyB64Url: string,
  expSeconds = 12 * 60 * 60,
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + expSeconds, sub: subject };

  const signingInput =
    b64UrlEncode(utf8(JSON.stringify(header))) +
    "." +
    b64UrlEncode(utf8(JSON.stringify(payload)));

  const key = await importVapidSigningKey(publicKeyB64Url, privateKeyB64Url);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      utf8(signingInput),
    ),
  );
  // Web Crypto already returns the raw r||s (64-byte) ES256 signature.
  return signingInput + "." + b64UrlEncode(sig);
}

// ── sendWebPush ─────────────────────────────────────────────────────

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

// Resolve the VAPID keypair + contact from env. Returns null (rather than
// throwing) when any piece is missing, so callers can no-op cleanly on a
// deploy that hasn't provisioned the keys yet — email/in-app stay the fallback.
export function getVapidConfig(): VapidConfig | null {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY")?.trim();
  const subject = Deno.env.get("VAPID_SUBJECT")?.trim() ||
    "mailto:support@gradethread.com";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

export interface WebPushResult {
  status: number;
  /** 404/410 → the subscription is dead and the caller should prune it. */
  gone: boolean;
}

// Encrypt + POST a JSON payload to a subscription endpoint. Never throws for a
// non-2xx status — returns the status so the caller can prune (gone) or count a
// failure. A network/timeout error DOES throw (caller decides).
export async function sendWebPush(
  subscription: PushSubscriptionKeys,
  payload: unknown,
  vapid: VapidConfig,
): Promise<WebPushResult> {
  const body = await encryptPayload(
    JSON.stringify(payload),
    subscription.p256dh,
    subscription.auth,
  );

  const audience = new URL(subscription.endpoint).origin;
  const jwt = await signVapidJwt(
    audience,
    vapid.subject,
    vapid.publicKey,
    vapid.privateKey,
  );

  const res = await fetchWithTimeout(
    subscription.endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "2419200",
        Urgency: "normal",
      },
      body,
    },
    10_000,
  );
  // Drain the body so the connection can be reused / closed promptly.
  await res.body?.cancel();

  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}
