import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  normalizeCancellation,
  normalizeReturn,
  outcomeToSaleStatus,
} from "../lib/ebay-postorder.ts";

Deno.test("normalizeReturn flattens nested return shape", () => {
  const r = normalizeReturn({
    returnId: "5000123",
    status: { state: "RETURN_REQUESTED" },
    detail: {
      buyerSelectedReturnReason: "DEFECTIVE_ITEM",
      item: { itemId: "11001" },
    },
    creationInfo: { creationDate: { value: "2026-06-10T00:00:00Z" } },
  });
  assertEquals(r.returnId, "5000123");
  assertEquals(r.state, "RETURN_REQUESTED");
  assertEquals(r.reason, "DEFECTIVE_ITEM");
  assertEquals(r.itemId, "11001");
  assertEquals(r.creationDate, "2026-06-10T00:00:00Z");
});

Deno.test("normalizeReturn tolerates missing fields", () => {
  const r = normalizeReturn({});
  assertEquals(r.returnId, "");
  assertEquals(r.state, null);
  assertEquals(r.reason, null);
  assertEquals(r.itemId, null);
});

Deno.test("normalizeCancellation flattens cancellation shape", () => {
  const ca = normalizeCancellation({
    cancelId: "9000777",
    cancelStatus: { state: "CANCEL_REQUESTED" },
    legacyOrderId: "12-09999-88888",
    cancelReason: "BUYER_CANCEL_OR_ADDRESS_ISSUE",
    requestorType: "BUYER",
    cancelRequestDate: { value: "2026-06-11T00:00:00Z" },
  });
  assertEquals(ca.cancelId, "9000777");
  assertEquals(ca.state, "CANCEL_REQUESTED");
  assertEquals(ca.orderId, "12-09999-88888");
  assertEquals(ca.requestorType, "BUYER");
});

Deno.test("outcomeToSaleStatus maps refund/cancel to terminal, leaves declines null", () => {
  assertEquals(outcomeToSaleStatus("return_refunded"), "refunded");
  assertEquals(outcomeToSaleStatus("cancel_approved"), "cancelled");
  assertEquals(outcomeToSaleStatus("return_declined"), null);
  assertEquals(outcomeToSaleStatus("cancel_rejected"), null);
});
