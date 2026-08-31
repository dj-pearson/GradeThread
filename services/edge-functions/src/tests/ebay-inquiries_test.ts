// US-2928: the inquiry normalizer, against BOTH nesting depths.
//
// eBay serves these fields at one depth from search and another from a detail
// read, and the shapes have moved between versions. A normalizer that only
// handled the depth someone happened to capture would produce an inquiry with a
// null item and a null reason — which renders as a row the seller cannot act on
// and reads exactly like an eBay outage.
import { assertEquals, assertFalse, assert } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeInquiry, isInquiryAlreadySettled } = await import("../lib/ebay-inquiries.ts");

Deno.test("normalizeInquiry reads the FLAT search shape", () => {
  const out = normalizeInquiry({
    inquiryId: "q1",
    inquiryStatus: "WAITING_FOR_SELLER_RESPONSE",
    legacyOrderId: "12-3456-7890",
    itemId: "225000111222",
    buyerLoginName: "buyer_one",
    buyerSelectedReason: "ITEM_NOT_RECEIVED",
    respondByDate: "2026-09-01T00:00:00.000Z",
    creationDate: "2026-08-25T00:00:00.000Z",
  });
  assertEquals(out, {
    inquiryId: "q1",
    state: "WAITING_FOR_SELLER_RESPONSE",
    orderId: "12-3456-7890",
    itemId: "225000111222",
    reason: "ITEM_NOT_RECEIVED",
    buyerUsername: "buyer_one",
    respondBy: "2026-09-01T00:00:00.000Z",
    creationDate: "2026-08-25T00:00:00.000Z",
  });
});

Deno.test("normalizeInquiry reads the NESTED detail shape", () => {
  const out = normalizeInquiry({
    inquiryId: "q2",
    status: { state: "INQUIRY_OPEN" },
    orderId: "99-0000-1111",
    detail: {
      item: { itemId: "225999888777" },
      buyerSelectedReason: "ITEM_NOT_RECEIVED",
    },
    sellerResponseDue: { value: "2026-09-05T00:00:00.000Z" },
    creationDate: { value: "2026-08-26T00:00:00.000Z" },
  });
  assertEquals(out.state, "INQUIRY_OPEN");
  assertEquals(out.itemId, "225999888777");
  assertEquals(out.reason, "ITEM_NOT_RECEIVED");
  assertEquals(out.respondBy, "2026-09-05T00:00:00.000Z");
  assertEquals(out.creationDate, "2026-08-26T00:00:00.000Z");
});

Deno.test("normalizeInquiry never throws on an empty payload", () => {
  const out = normalizeInquiry({});
  assertEquals(out.inquiryId, "");
  assertEquals(out.state, null);
  assertEquals(out.respondBy, null);
});

Deno.test("isInquiryAlreadySettled treats a 404 and an already-closed error as settled", () => {
  assert(isInquiryAlreadySettled({ status: 404 }));
  assert(isInquiryAlreadySettled({ status: 400, ebayErrorIds: [32001] }));
  assert(isInquiryAlreadySettled({ status: 400, message: "Inquiry already closed" }));
});

Deno.test("isInquiryAlreadySettled does NOT swallow a real failure", () => {
  // The whole point of the narrow match: a token problem or an eBay outage has
  // to stay an error, or the seller is told the inquiry is handled when it is not.
  assertFalse(isInquiryAlreadySettled({ status: 401, message: "Invalid access token" }));
  assertFalse(isInquiryAlreadySettled({ status: 500, message: "Internal error" }));
  assertFalse(isInquiryAlreadySettled({ status: 400, ebayErrorIds: [99999] }));
  assertFalse(isInquiryAlreadySettled(new Error("network down")));
});

// ── US-2977: a NUMERIC id is still an id ─────────────────────────────────
//
// Measured in production 2026-08-31 on inquiry 5384833027:
//
//   marketplace_events.poll_failed
//   errors: ["inquiry 5384833027: ev.orderLabel?.trim is not a function"]
//
// RawInquiry declares `legacyOrderId?: string` and InquirySummary declares
// `orderId: string | null`, and both are compile-time claims about JSON that
// nothing validated. eBay sent a NUMBER, `??` passed it through untouched, and
// the type system went on believing it had a string all the way to
// buildInquiryOpened's `ev.orderLabel?.trim()` — where `?.` guards null and
// undefined and has nothing to say about the wrong type.
//
// That threw inside the per-item try, which released the claim, so the same
// inquiry was re-polled and re-thrown every fifteen minutes from 2026-08-27
// 12:15 UTC: ~330 consecutive failed sweeps on one un-notified buyer.
//
// Coerce at the normalizer, which this module's own comment already calls "the
// one place that knows about" eBay's shape drift.
Deno.test("normalizeInquiry coerces a NUMERIC legacyOrderId to a string", () => {
  const out = normalizeInquiry({
    inquiryId: "5384833027",
    // Deliberately the wrong type: this is the payload prod actually sent.
    legacyOrderId: 123456789012 as unknown as string,
    itemId: 225000111222 as unknown as string,
  });
  assertEquals(out.orderId, "123456789012");
  assertEquals(out.itemId, "225000111222");
  // The actual crash, reproduced: the consumer calls .trim() on it.
  assertEquals(typeof out.orderId, "string");
  assert(out.orderId!.trim().length > 0, "the value a notification renders must be trimmable");
});

Deno.test("normalizeInquiry leaves a genuinely absent id as null, not \"null\"", () => {
  // The counter-assertion. A coercion written as String(v) turns null into the
  // four-character string "null", which is worse than the crash: it renders to
  // a seller as `A buyer says null never arrived` and nothing throws to say so.
  const out = normalizeInquiry({ inquiryId: "q9" });
  assertEquals(out.orderId, null);
  assertEquals(out.itemId, null);
});
