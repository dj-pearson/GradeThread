// US-512: Stripe webhook HANDLER contract tests (the /stripe endpoint itself).
//
// The per-branch billing MATH is already pinned elsewhere — plan mapping
// (subscription-mapping_test), duplicate-delivery idempotency for money events
// (webhook-idempotency_test), refund ledger + balance_after (credit-refund_test
// / ledger-consistency_test), per-grade dedupe (per-grade-idempotency_test).
// What had NO test was the handler's request contract: config gating, signature
// verification (signed fixtures via Stripe's own header signer), and the
// money-safety fail-closed behavior. That's what this file covers.
//
// webhooks.ts imports the service-role supabase client at module init, so set
// dummy env BEFORE the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { webhookRoutes } = await import("../routes/webhooks.ts");

const TEST_SECRET = "whsec_testsecret_for_unit_tests_only";

// Build a Stripe-style signature header (t=<ts>,v1=<hmac>) the same way Stripe's
// own generateTestHeaderString does — HMAC-SHA256 over `${ts}.${payload}`. We
// compute it with crypto.subtle because Stripe's sync signer can't run under
// Deno's async-only SubtleCrypto. A CURRENT timestamp keeps it inside
// constructEventAsync's default 300s tolerance.
async function signStripe(payload: string, secret: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${ts},v1=${hex}`;
}

function setStripeEnv() {
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_dummy");
  Deno.env.set("STRIPE_WEBHOOK_SECRET", TEST_SECRET);
}

function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return webhookRoutes.request("/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

Deno.test("503 when Stripe env is not configured", async () => {
  Deno.env.delete("STRIPE_SECRET_KEY");
  Deno.env.delete("STRIPE_WEBHOOK_SECRET");
  const res = await post(JSON.stringify({ id: "evt_1", type: "x" }));
  assertEquals(res.status, 503);
});

Deno.test("400 when the stripe-signature header is missing", async () => {
  setStripeEnv();
  const res = await post(JSON.stringify({ id: "evt_1", type: "x" }));
  assertEquals(res.status, 400);
});

Deno.test("400 when the signature is invalid (verification fails)", async () => {
  setStripeEnv();
  const res = await post(JSON.stringify({ id: "evt_1", type: "x" }), {
    "stripe-signature": "t=123,v1=deadbeef",
  });
  assertEquals(res.status, 400);
  const json = await res.json();
  assert(/signature/i.test(json.error));
});

Deno.test("a VALIDLY-signed event passes verification (NOT 400) and fails CLOSED without a DB", async () => {
  setStripeEnv();
  const payload = JSON.stringify({
    id: "evt_signed_1",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_1", status: "active" } },
  });
  const signature = await signStripe(payload, TEST_SECRET);
  const res = await post(payload, { "stripe-signature": signature });
  // The signature was accepted (not a 400). With no reachable DB the idempotency
  // claim can't be written, so the handler FAILS CLOSED with 500 (so Stripe
  // re-delivers) — never a silent 200. This pins the money-safety contract.
  assert(res.status !== 400, `expected signature to be accepted, got ${res.status}`);
  assertEquals(res.status, 500);
});

Deno.test("signed events are distinguishable from forged ones", async () => {
  setStripeEnv();
  const payload = JSON.stringify({ id: "evt_2", type: "ping", data: { object: {} } });
  // A signature for a DIFFERENT payload must be rejected (tamper detection).
  const goodSigForOther = await signStripe(
    JSON.stringify({ id: "evt_other", type: "ping" }),
    TEST_SECRET,
  );
  const res = await post(payload, { "stripe-signature": goodSigForOther });
  assertEquals(res.status, 400);
});
