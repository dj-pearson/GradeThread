// US-349 / US-365: eBay inbound-notification signature verification. The
// account-deletion + event endpoints gate every mutation on verifyEbayHmac, so
// these assertions are the regression guard that a forged/unsigned deletion
// notification can NOT pass verification (and therefore can't deactivate a
// connection — the handler returns 401 before touching the DB).
import { assert, assertEquals } from "@std/assert";
import { constantTimeEqual, verifyEbayHmac } from "../lib/ebay-signature.ts";

const SECRET = "test-verification-token";
const BODY = JSON.stringify({
  metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
  notification: { notificationId: "abc-123", data: { username: "victim_seller" } },
});

async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("verifyEbayHmac: accepts a correctly-signed body (hex)", async () => {
  const sig = await hmacHex(BODY, SECRET);
  assert(await verifyEbayHmac(BODY, sig, SECRET));
});

Deno.test("verifyEbayHmac: accepts the sha256= prefix", async () => {
  const sig = await hmacHex(BODY, SECRET);
  assert(await verifyEbayHmac(BODY, `sha256=${sig}`, SECRET));
});

Deno.test("verifyEbayHmac: rejects a forged signature", async () => {
  assertEquals(await verifyEbayHmac(BODY, "deadbeef".repeat(8), SECRET), false);
});

Deno.test("verifyEbayHmac: rejects an empty/missing signature (unsigned request)", async () => {
  assertEquals(await verifyEbayHmac(BODY, "", SECRET), false);
});

Deno.test("verifyEbayHmac: rejects a valid signature for a DIFFERENT body (tamper)", async () => {
  const sig = await hmacHex(BODY, SECRET);
  const tampered = BODY.replace("victim_seller", "attacker");
  assertEquals(await verifyEbayHmac(tampered, sig, SECRET), false);
});

Deno.test("verifyEbayHmac: rejects a signature made with the wrong secret", async () => {
  const sig = await hmacHex(BODY, "wrong-secret");
  assertEquals(await verifyEbayHmac(BODY, sig, SECRET), false);
});

Deno.test("constantTimeEqual: basic correctness", () => {
  assert(constantTimeEqual("abc", "abc"));
  assertEquals(constantTimeEqual("abc", "abd"), false);
  assertEquals(constantTimeEqual("abc", "abcd"), false);
});
