// US-1901: the Web Push crypto (RFC 8291 aes128gcm + RFC 8292 VAPID) is
// hand-rolled against Deno Web Crypto, so it is pinned to the published RFC 8291
// Appendix A vector byte-for-byte. If encryptPayload stops reproducing that
// vector, the crypto is broken and no browser would be able to decrypt our
// pushes — this test is the single most important check for the feature.
import { assert, assertEquals } from "@std/assert";
import {
  b64UrlDecode,
  b64UrlEncode,
  encryptPayload,
  importEcdhKeyPair,
  signVapidJwt,
} from "../lib/web-push.ts";

// RFC 8291 Appendix A published example inputs + expected output.
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  expectedBody:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

Deno.test("base64url round-trips (unpadded, url-safe alphabet)", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65));
  assertEquals(b64UrlDecode(b64UrlEncode(bytes)), bytes);
  // Known vector decodes to the right length (65-byte P-256 point).
  assertEquals(b64UrlDecode(RFC8291.asPublic).length, 65);
});

Deno.test("encryptPayload reproduces the RFC 8291 Appendix A vector EXACTLY", async () => {
  const asKeyPair = await importEcdhKeyPair(RFC8291.asPrivate, RFC8291.asPublic);
  const body = await encryptPayload(
    RFC8291.plaintext,
    RFC8291.uaPublic,
    RFC8291.authSecret,
    { salt: b64UrlDecode(RFC8291.salt), asKeyPair },
  );
  const got = b64UrlEncode(body);
  assertEquals(
    got,
    RFC8291.expectedBody,
    "aes128gcm body must match RFC 8291 Appendix A byte-for-byte",
  );
});

Deno.test("signVapidJwt produces an ES256 JWT that verifies with the public key", async () => {
  // A throwaway P-256 keypair (exported to the raw formats the signer expects).
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const rawPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicB64 = b64UrlEncode(rawPublic);
  const privateB64 = jwk.d!; // raw scalar d, base64url

  const jwt = await signVapidJwt(
    "https://push.example.com",
    "mailto:support@gradethread.com",
    publicB64,
    privateB64,
  );

  const [headerB64, payloadB64, sigB64] = jwt.split(".");
  assert(headerB64 && payloadB64 && sigB64, "JWT must have three segments");

  const header = JSON.parse(new TextDecoder().decode(b64UrlDecode(headerB64)));
  assertEquals(header.alg, "ES256");
  assertEquals(header.typ, "JWT");
  const payload = JSON.parse(new TextDecoder().decode(b64UrlDecode(payloadB64)));
  assertEquals(payload.aud, "https://push.example.com");
  assertEquals(payload.sub, "mailto:support@gradethread.com");
  assert(payload.exp > Math.floor(Date.now() / 1000), "exp must be in the future");
  // RFC 8292: exp must be within 24h.
  assert(payload.exp <= Math.floor(Date.now() / 1000) + 24 * 60 * 60);

  const verifyKey = await crypto.subtle.importKey(
    "raw",
    rawPublic,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    b64UrlDecode(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  assert(ok, "VAPID JWT signature must verify against the public key");
});

Deno.test("encryptPayload with a random ephemeral keypair yields a well-formed header", async () => {
  const body = await encryptPayload(
    JSON.stringify({ title: "hi", body: "there" }),
    RFC8291.uaPublic,
    RFC8291.authSecret,
  );
  // salt(16) + rs(4) + idlen(1) + keyid(65) + at least the GCM tag(16).
  assert(body.length > 16 + 4 + 1 + 65 + 16);
  assertEquals(body[16 + 4], 65, "keyid length octet must be 65 (P-256 point)");
  const rs = new DataView(body.buffer).getUint32(16, false);
  assertEquals(rs, 4096, "record size must be 4096");
});
