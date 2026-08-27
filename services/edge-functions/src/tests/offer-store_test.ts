// US-2939: the offer record.
//
// Two rules carry it, and both are invisible in the SQL:
//
//   1. `list_price_cents` is a SNAPSHOT. Passing `undefined` leaves whatever is
//      already stored alone, so an offer seen once at a $24 ask keeps that ask
//      after the seller reprices to $298. Every discount-depth figure in the
//      analytics divides by this number.
//   2. `undefined` is dropped and `null` is written, exactly as in
//      post-sale-store. Without it a summary poll erases a `responded_at` the
//      responder wrote thirty seconds earlier.
import { assert, assertEquals, assertFalse } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { incomingOfferToInput, toOfferRow } = await import("../lib/offer-store.ts");

const NOW = "2026-08-27T12:00:00.000Z";

const EBAY_OFFER = {
  bestOfferId: "o1",
  itemId: "225000111222",
  buyerUsername: "buyer_one",
  price: 42.5,
  currency: "USD",
  status: "Active",
  expiresAt: "2026-08-29T12:00:00.000Z",
};

Deno.test("incomingOfferToInput converts money to cents and keeps the expiry", () => {
  const input = incomingOfferToInput(EBAY_OFFER, 6000);
  assertEquals(input.direction, "received");
  assertEquals(input.externalOfferId, "o1");
  assertEquals(input.amountCents, 4250);
  assertEquals(input.listPriceCents, 6000);
  assertEquals(input.expiresAt, "2026-08-29T12:00:00.000Z");
});

Deno.test("an UNKNOWN list price is omitted, not nulled", () => {
  // THE SNAPSHOT RULE. Writing null here would erase a price recorded on an
  // earlier poll the moment the listing goes missing — and the discount depth
  // of every past offer on that item with it.
  const input = incomingOfferToInput(EBAY_OFFER);
  assertFalse("listPriceCents" in input);
  const row = toOfferRow("u1", input, NOW);
  assertFalse("list_price_cents" in row);
});

Deno.test("an EXPLICIT null list price IS written", () => {
  const row = toOfferRow("u1", incomingOfferToInput(EBAY_OFFER, null), NOW);
  assert("list_price_cents" in row);
  assertEquals(row.list_price_cents, null);
});

Deno.test("toOfferRow always writes the key columns", () => {
  const row = toOfferRow("u1", { direction: "counter_sent", externalOfferId: "o9" }, NOW);
  assertEquals(row.user_id, "u1");
  assertEquals(row.platform, "ebay");
  assertEquals(row.external_offer_id, "o9");
  assertEquals(row.direction, "counter_sent");
  assertEquals(row.last_seen_at, NOW);
});

Deno.test("toOfferRow omits every field the caller did not supply", () => {
  const row = toOfferRow("u1", { direction: "received", externalOfferId: "o9" }, NOW);
  for (
    const key of [
      "responded_at",
      "response",
      "response_amount_cents",
      "rule_id",
      "buyer_username",
      "expires_at",
    ]
  ) {
    assertFalse(key in row, `${key} must not be written when unknown`);
  }
});

Deno.test("a price eBay serves as null becomes null cents, not NaN", () => {
  const input = incomingOfferToInput({ ...EBAY_OFFER, price: null });
  assertEquals(input.amountCents, null);
});

Deno.test("the direction distinguishes our counter from the buyer's bid", () => {
  // Collapsed, our own counter would be counted as a bid — the denominator of
  // every conversion figure on the analytics panel.
  const received = toOfferRow("u1", incomingOfferToInput(EBAY_OFFER), NOW);
  const counter = toOfferRow("u1", {
    direction: "counter_sent",
    externalOfferId: "o1",
    amountCents: 5000,
  }, NOW);
  assertEquals(received.direction, "received");
  assertEquals(counter.direction, "counter_sent");
  // Same external id, different direction: the unique index is on the pair, so
  // both rows can exist and neither overwrites the other.
  assertEquals(received.external_offer_id, counter.external_offer_id);
});
