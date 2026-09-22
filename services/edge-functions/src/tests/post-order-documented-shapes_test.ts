// US-3466: the Post-Order readers against eBay's DOCUMENTED search shapes.
//
// Every earlier fixture for these three normalizers was a shape somebody
// guessed, and the normalizers read exactly the guesses. Against the real
// payloads that meant: every inquiry state null (eBay calls it
// `inquiryStatusEnum`), every cancellation state null (`cancelState` is a
// top-level string), and a return closed out by the seller still filed as open
// because only `state` was read and `status` is the one that says CLOSED. On
// the page all three look like open work with a deadline.
//
// The shapes below are copied from the field lists on developer.ebay.com
// (post-order v2 inquiry/search, return/search, cancellation/search), read
// 2026-09-22.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  normalizeCancellation,
  normalizeReturn,
  returnState,
} from "../lib/ebay-postorder.ts";
import { normalizeInquiry } from "../lib/ebay-inquiries.ts";
import { isClosedCase } from "../lib/post-sale-state.ts";

Deno.test("US-3466: inquiry state comes from inquiryStatusEnum", () => {
  const closed = normalizeInquiry({
    buyer: "buyer_one",
    creationDate: { value: "2026-08-12T03:02:45.000Z" },
    inquiryId: 5384833027,
    inquiryStatusEnum: "CLOSED",
    itemId: 227393291770,
  });
  assertEquals(closed.state, "CLOSED");
  assertEquals(closed.inquiryId, "5384833027");
  assertEquals(closed.itemId, "227393291770");
  assertEquals(closed.buyerUsername, "buyer_one");
  assertEquals(isClosedCase(closed.state), true);

  const open = normalizeInquiry({
    inquiryId: 1,
    inquiryStatusEnum: "WAITING_SELLER_RESPONSE",
    respondByDate: { value: "2026-09-25T00:00:00.000Z" },
  });
  assertEquals(open.state, "WAITING_SELLER_RESPONSE");
  assertEquals(open.respondBy, "2026-09-25T00:00:00.000Z");
  assertEquals(isClosedCase(open.state), false);
});

Deno.test("US-3466: every closed inquiry status reads as closed", () => {
  for (const s of ["CLOSED", "CLOSED_WITH_ESCALATION", "CS_CLOSED"]) {
    assertEquals(isClosedCase(normalizeInquiry({ inquiryId: 1, inquiryStatusEnum: s }).state), true, s);
  }
});

Deno.test("US-3466: a return whose status is CLOSED is closed, whatever state says", () => {
  const r = normalizeReturn({
    returnId: "5328866521",
    orderId: "22-15098-13189",
    state: "ITEM_DELIVERED",
    status: "CLOSED",
    creationInfo: {
      creationDate: { value: "2026-09-10T15:06:58.000Z" },
      item: { itemId: "110000000009", returnQuantity: 1 } as { itemId: string },
      reason: "NO_LONGER_NEED_ITEM",
    },
    sellerAvailableOptions: [],
  });
  assertEquals(r.state, "CLOSED");
  assertEquals(isClosedCase(r.state), true);
  assertEquals(r.itemId, "110000000009");
  assertEquals(r.reason, "NO_LONGER_NEED_ITEM");
  assertEquals(r.sellerActions, []);
});

Deno.test("US-3466: an open return keeps its state, its deadline and eBay's action list", () => {
  const r = normalizeReturn({
    returnId: "5",
    state: "RETURN_REQUESTED",
    status: "RETURN_REQUESTED",
    sellerAvailableOptions: [
      { actionType: "SELLER_APPROVE_REQUEST" },
      { actionType: "SELLER_DECLINE_REQUEST" },
      { actionType: "SELLER_SEND_MESSAGE" },
    ],
    sellerResponseDue: {
      activityDue: "SELLER_APPROVE_REQUEST",
      respondByDate: { value: "2026-09-26T20:18:17.000Z" },
    } as { respondByDate: { value: string } },
  });
  assertEquals(r.state, "RETURN_REQUESTED");
  assertEquals(r.respondBy, "2026-09-26T20:18:17.000Z");
  assertEquals(r.sellerActions, [
    "SELLER_APPROVE_REQUEST",
    "SELLER_DECLINE_REQUEST",
    "SELLER_SEND_MESSAGE",
  ]);
});

Deno.test("US-3466: no action list from eBay is unknown (null), not empty", () => {
  assertEquals(normalizeReturn({ returnId: "5", state: "ITEM_SHIPPED" }).sellerActions, null);
});

Deno.test("US-3466: returnState prefers whichever field says finished", () => {
  assertEquals(returnState("ITEM_DELIVERED", "CLOSED"), "CLOSED");
  assertEquals(returnState("CLOSED", "ITEM_DELIVERED"), "CLOSED");
  assertEquals(returnState("ITEM_SHIPPED", "ITEM_SHIPPED"), "ITEM_SHIPPED");
  assertEquals(returnState(null, "ESCALATED"), "ESCALATED");
  assertEquals(returnState(null, null), null);
});

Deno.test("US-3466: cancellation state comes from the top-level cancelState", () => {
  const c = normalizeCancellation({
    cancelId: "5450206676",
    cancelState: "CLOSED",
    cancelStatus: "CANCEL_CLOSED_WITH_REFUND",
    legacyOrderId: "24-15030-03612",
    cancelReason: "OUT_OF_STOCK_OR_CANNOT_FULFILL",
    requestorRole: "SELLER",
    cancelRequestDate: { value: "2026-08-16T19:48:26.000Z" },
  });
  assertEquals(c.state, "CLOSED");
  assertEquals(isClosedCase(c.state), true);
  assertEquals(c.requestorType, "SELLER");

  const pending = normalizeCancellation({ cancelId: "1", cancelState: "APPROVAL_PENDING" });
  assertEquals(pending.state, "APPROVAL_PENDING");
  assertEquals(isClosedCase(pending.state), false);
});
