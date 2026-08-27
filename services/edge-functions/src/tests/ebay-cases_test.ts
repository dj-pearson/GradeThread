// US-2929: the case normalizer.
//
// One trap here that the inquiry normalizer does not have: eBay serves `caseId`
// as a bare string on some shapes and as `{ caseId }` on others. Read only the
// string form and the object-shaped ones normalize to an empty id, which the
// `.filter(x => x.caseId)` in searchCases then drops — so half a seller's cases
// vanish with no error anywhere.
import { assert, assertEquals, assertFalse } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeCase, isCaseAlreadySettled } = await import("../lib/ebay-cases.ts");

Deno.test("normalizeCase reads the FLAT shape", () => {
  const out = normalizeCase({
    caseId: "5000123456",
    caseStatus: "CS_OPEN",
    legacyOrderId: "12-3456-7890",
    itemId: "225000111222",
    buyerLoginName: "buyer_one",
    reason: "ITEM_NOT_AS_DESCRIBED",
    respondByDate: "2026-09-01T00:00:00.000Z",
    creationDate: "2026-08-25T00:00:00.000Z",
    returnId: "5100999",
    claimAmount: { value: "42.55", currency: "USD" },
  });
  assertEquals(out.caseId, "5000123456");
  assertEquals(out.state, "CS_OPEN");
  assertEquals(out.escalatedFrom, "5100999");
  assertEquals(out.amountCents, 4255);
  assertEquals(out.currency, "USD");
});

Deno.test("normalizeCase unwraps an OBJECT caseId", () => {
  // The one that silently drops cases if it is missed.
  const out = normalizeCase({
    caseId: { caseId: "5000999888" },
    status: { state: "WAITING_FOR_SELLER_RESPONSE" },
    detail: { item: { itemId: "225777" }, reason: "SNAD", inquiryId: "q7" },
    sellerResponseDue: { value: "2026-09-09T00:00:00.000Z" },
  });
  assertEquals(out.caseId, "5000999888");
  assertEquals(out.state, "WAITING_FOR_SELLER_RESPONSE");
  assertEquals(out.itemId, "225777");
  assertEquals(out.reason, "SNAD");
  assertEquals(out.escalatedFrom, "q7");
  assertEquals(out.respondBy, "2026-09-09T00:00:00.000Z");
});

Deno.test("normalizeCase never throws on an empty payload", () => {
  const out = normalizeCase({});
  assertEquals(out.caseId, "");
  assertEquals(out.amountCents, null);
  assertEquals(out.escalatedFrom, null);
});

Deno.test("normalizeCase gives a null amount rather than NaN on unparseable money", () => {
  assertEquals(normalizeCase({ claimAmount: { value: "n/a" } }).amountCents, null);
});

Deno.test("isCaseAlreadySettled is narrow: a real failure stays a failure", () => {
  assert(isCaseAlreadySettled({ status: 404 }));
  assert(isCaseAlreadySettled({ status: 400, ebayErrorIds: [32002] }));
  assert(isCaseAlreadySettled({ status: 400, message: "Case already appealed" }));
  // A case wrongly reported as handled costs the seller a defect for not
  // responding, which is why this side of the test matters more than the other.
  assertFalse(isCaseAlreadySettled({ status: 401, message: "Invalid access token" }));
  assertFalse(isCaseAlreadySettled({ status: 503, message: "Service unavailable" }));
  assertFalse(isCaseAlreadySettled({ status: 400, ebayErrorIds: [12345] }));
});
