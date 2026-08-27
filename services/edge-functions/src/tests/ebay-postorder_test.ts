import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  extractReturnShipment,
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


// ── US-2931: the buyer's return shipment ────────────────────────────
//
// The distinction the whole feature rests on: NO SHIPMENT is a real answer (the
// buyer has not posted it), and it has to be distinguishable from a failed read.
// extractReturnShipment returns null for the former and the route renders that
// as "buyer has not shipped yet"; only a throw is an error.

Deno.test("extractReturnShipment reads the flat buyerShipmentTracking object", () => {
  const out = extractReturnShipment({
    buyerShipmentTracking: {
      shippingCarrierName: "USPS",
      trackingNumber: "9400111899223197428490",
      status: "IN_TRANSIT",
      shippedDate: "2026-08-20T00:00:00.000Z",
    },
  });
  assertEquals(out?.carrier, "USPS");
  assertEquals(out?.trackingNumber, "9400111899223197428490");
  assertEquals(out?.labelStatus, "IN_TRANSIT");
  assertEquals(out?.shippedAt, "2026-08-20T00:00:00.000Z");
  assertEquals(out?.deliveredAt, null);
});

Deno.test("extractReturnShipment takes the LAST entry of a list", () => {
  // A return re-shipped after a failed first attempt carries both, and the
  // current one is the later. Taking the first would show the seller tracking
  // for a parcel that never moved.
  const out = extractReturnShipment({
    buyerShipmentTracking: [
      { shippingCarrierName: "USPS", trackingNumber: "OLD", status: "CANCELLED" },
      { shippingCarrierName: "UPS", trackingNumber: "NEW", status: "IN_TRANSIT" },
    ],
  });
  assertEquals(out?.trackingNumber, "NEW");
  assertEquals(out?.carrier, "UPS");
});

Deno.test("extractReturnShipment reads the NESTED detail shape", () => {
  const out = extractReturnShipment({
    detail: {
      returnShipmentInfo: {
        carrierUsed: "FedEx",
        trackingNumber: "7712345678",
        shipmentStatus: "DELIVERED",
        deliveredDate: { value: "2026-08-24T00:00:00.000Z" },
      },
    },
  });
  assertEquals(out?.carrier, "FedEx");
  assertEquals(out?.deliveredAt, "2026-08-24T00:00:00.000Z");
});

Deno.test("extractReturnShipment returns null when the buyer has not shipped", () => {
  assertEquals(extractReturnShipment({}), null);
  // An entry present but empty is the same answer — a shipment record with
  // neither a carrier nor a tracking number tells the seller nothing.
  assertEquals(extractReturnShipment({ buyerShipmentTracking: { status: "PENDING" } }), null);
  assertEquals(extractReturnShipment({ buyerShipmentTracking: [] }), null);
});
