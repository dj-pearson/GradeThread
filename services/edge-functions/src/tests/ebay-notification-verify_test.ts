// Regression guard for eBay Notification-API ECDSA verification.
//
// eBay signs account-deletion notifications with ECDSA (P-256) keys and a
// SHA-1 digest, and sends the signature DER-encoded. WebCrypto's verify()
// needs raw r‖s, so derToRawEcdsa must convert correctly — otherwise every
// genuine notification fails with "signature mismatch" → 401 and eBay retries
// endlessly (the regression these tests exist to catch).
import { assert, assertEquals } from "@std/assert";

// ebay-notification-verify.ts transitively imports the service-role supabase
// client (via ebay-client.ts), which throws at module init without env — set
// dummy creds BEFORE the dynamic import (mirrors admin-mfa_test).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { derToRawEcdsa, digestToHash, verifyEbayNotification } = await import(
  "../lib/ebay-notification-verify.ts"
);

// Encode a raw r‖s signature as DER (the form eBay/OpenSSL emit) so we can feed
// it through derToRawEcdsa and confirm the round-trip still verifies.
function rawToDer(raw: Uint8Array, coordSize: number): Uint8Array {
  const enc = (b: Uint8Array): Uint8Array => {
    let v = b;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) {
      const p = new Uint8Array(v.length + 1);
      p.set(v, 1);
      v = p;
    }
    return v;
  };
  const r = enc(raw.subarray(0, coordSize));
  const s = enc(raw.subarray(coordSize));
  const body = new Uint8Array(2 + r.length + 2 + s.length);
  let i = 0;
  body[i++] = 0x02;
  body[i++] = r.length;
  body.set(r, i);
  i += r.length;
  body[i++] = 0x02;
  body[i++] = s.length;
  body.set(s, i);
  const out = new Uint8Array(2 + body.length);
  out[0] = 0x30;
  out[1] = body.length;
  out.set(body, 2);
  return out;
}

Deno.test("derToRawEcdsa: DER round-trip verifies under WebCrypto (many sigs, incl. zero-pad)", async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const data = new TextEncoder().encode(
    JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" } }),
  );
  // Many iterations exercise the high-bit / leading-zero padding branches.
  for (let i = 0; i < 100; i++) {
    const rawSig = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-1" }, kp.privateKey, data),
    );
    const der = rawToDer(rawSig, 32);
    const back = derToRawEcdsa(der, 32);
    assert(back, "converter returned null for a valid DER signature");
    assertEquals(back!.length, 64);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-1" },
      kp.publicKey,
      back as unknown as ArrayBuffer,
      data as unknown as ArrayBuffer,
    );
    assert(ok, "WebCrypto rejected a correctly converted signature");
  }
});

Deno.test("derToRawEcdsa: rejects non-DER / malformed input", () => {
  assertEquals(derToRawEcdsa(new Uint8Array([0x01, 0x02, 0x03]), 32), null);
  assertEquals(derToRawEcdsa(new Uint8Array(0), 32), null);
  // SEQUENCE but the first element isn't an INTEGER.
  assertEquals(derToRawEcdsa(new Uint8Array([0x30, 0x03, 0x04, 0x01, 0x00]), 32), null);
});

Deno.test("digestToHash: maps eBay digest field to WebCrypto hash names", () => {
  assertEquals(digestToHash("SHA1"), "SHA-1");
  assertEquals(digestToHash("SHA-1"), "SHA-1");
  assertEquals(digestToHash("SHA256"), "SHA-256");
  assertEquals(digestToHash("sha512"), "SHA-512");
  // eBay's notification keys use SHA-1; default to it when unspecified.
  assertEquals(digestToHash(undefined), "SHA-1");
  assertEquals(digestToHash(""), "SHA-1");
});

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

// End-to-end fixture (US-365). Builds an eBay-FORMAT notification signature —
// ECDSA P-256 / SHA-1, DER-encoded, in a base64-JSON `x-ebay-signature` header
// — signed by a test key standing in for eBay's notification key, and verifies
// it through the full verifyEbayNotification path (header parse → key import →
// DER→raw → WebCrypto verify) with the public key injected as a fixture. This
// is the scheme eBay actually uses; a genuine eBay sample would verify the same
// way once its public key is fetched. Negatives prove tamper/forgery rejection.
Deno.test("verifyEbayNotification: accepts a genuine eBay-format signature, rejects tampering/forgery", async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const spkiB64 = bytesToB64(
    new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)),
  );

  const body = JSON.stringify({
    metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
    notification: { notificationId: "fixture-1", data: { username: "seller_x" } },
  });
  const rawSig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-1" },
      kp.privateKey,
      new TextEncoder().encode(body),
    ),
  );
  const sigB64 = bytesToB64(rawToDer(rawSig, 32));
  const header = (kid: string) =>
    btoa(JSON.stringify({ kid, signature: sigB64, alg: "ECDSA" }));

  // Fixture key fetcher: returns the test public key in eBay's response shape.
  const fetchKey = (_kid: string) =>
    Promise.resolve({ algorithm: "ECDSA", digest: "SHA1", key: spkiB64 });

  // 1. A correctly-signed body verifies.
  assert(
    await verifyEbayNotification(body, header("kid-ok"), fetchKey),
    "a valid eBay-format ECDSA signature must verify",
  );

  // 2. Tampered body (same signature) is rejected.
  assertEquals(
    await verifyEbayNotification(body + " ", header("kid-tamper"), fetchKey),
    false,
  );

  // 3. Forgery: a signature made with a DIFFERENT key, presented against the
  //    fixture's published key, is rejected.
  const other = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const forgedSig = bytesToB64(rawToDer(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-1" },
        other.privateKey,
        new TextEncoder().encode(body),
      ),
    ),
    32,
  ));
  const forgedHeader = btoa(
    JSON.stringify({ kid: "kid-forge", signature: forgedSig, alg: "ECDSA" }),
  );
  assertEquals(
    await verifyEbayNotification(body, forgedHeader, fetchKey),
    false,
  );

  // 4. A non-base64-JSON header (legacy HMAC hex/base64 string) is rejected —
  //    the leniency US-365 removed can't sneak a forged event past us.
  assertEquals(
    await verifyEbayNotification(body, "deadbeef".repeat(8), fetchKey),
    false,
  );
  assertEquals(await verifyEbayNotification(body, "", fetchKey), false);

  // 5. Key material unavailable (fetch returns null) → reject, never accept.
  assertEquals(
    await verifyEbayNotification(body, header("kid-nokey"), () =>
      Promise.resolve(null)),
    false,
  );
});
