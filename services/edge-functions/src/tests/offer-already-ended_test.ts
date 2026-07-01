import { assertEquals } from "@std/assert";

// ebay-client.ts imports the service-role supabase client at load, so set dummy
// env BEFORE the dynamic import (same pattern as publish-idempotency_test).
//   deno test --allow-env src/tests/offer-already-ended_test.ts
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isOfferAlreadyEndedError, isNoEbayConnectionError } = await import(
  "../lib/ebay-client.ts"
);

// The end-listing / relist withdraw must treat an ALREADY-not-live offer as
// success (so a policy-removed or seller-ended listing reconciles locally
// instead of getting stuck "active"), while a TRANSIENT failure must NOT be
// swallowed (the seller should retry rather than have us mark it ended blind).

function ebayErr(status: number, message = "boom"): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

Deno.test("404 / not-found offer → already ended", () => {
  assertEquals(isOfferAlreadyEndedError(ebayErr(404)), true);
});

Deno.test("400 bad-request on a known offer (not withdraw-able) → already ended", () => {
  assertEquals(isOfferAlreadyEndedError(ebayErr(400)), true);
});

Deno.test("409 conflict → already ended (not live)", () => {
  assertEquals(isOfferAlreadyEndedError(ebayErr(409)), true);
});

Deno.test("429 rate-limit → NOT already ended (transient, retry)", () => {
  assertEquals(isOfferAlreadyEndedError(ebayErr(429)), false);
});

Deno.test("500/503 eBay outage → NOT already ended (transient, retry)", () => {
  assertEquals(isOfferAlreadyEndedError(ebayErr(500)), false);
  assertEquals(isOfferAlreadyEndedError(ebayErr(503)), false);
});

Deno.test("non-HTTP error matches on message", () => {
  assertEquals(
    isOfferAlreadyEndedError(new Error("The offer is not published")),
    true,
  );
  assertEquals(
    isOfferAlreadyEndedError(new Error("listing not found")),
    true,
  );
});

Deno.test("non-HTTP unknown error → NOT already ended", () => {
  assertEquals(isOfferAlreadyEndedError(new Error("network blip")), false);
  assertEquals(isOfferAlreadyEndedError(null), false);
  assertEquals(isOfferAlreadyEndedError(undefined), false);
});

// US-1506: a disconnected eBay account throws "No active eBay connection…"
// BEFORE any withdraw runs, so the listing is still LIVE. It must NOT be
// classified as already-ended (that reconciled a live listing to ended =
// oversell risk); it's a dedicated connection error the end handler preempts.

Deno.test("no-connection error is NOT already-ended (was matched by /no active/)", () => {
  const e = new Error("No active eBay connection for this user.");
  assertEquals(isOfferAlreadyEndedError(e), false);
});

Deno.test("isNoEbayConnectionError classifies the disconnected-account error", () => {
  assertEquals(
    isNoEbayConnectionError(new Error("No active eBay connection for this user.")),
    true,
  );
  // case-insensitive, and does NOT fire on a genuinely-ended offer
  assertEquals(
    isNoEbayConnectionError(new Error("no active EBAY connection")),
    true,
  );
  assertEquals(isNoEbayConnectionError(new Error("offer not found")), false);
  assertEquals(isNoEbayConnectionError(null), false);
});
