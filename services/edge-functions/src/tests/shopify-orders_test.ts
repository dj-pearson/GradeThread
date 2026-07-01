// US-711: pure helpers of the shared Shopify order-ingest — webhook order
// parsing and the cancel/refund → sale-status mapping. The DB-touching
// ingest/apply paths are covered by the tenant-isolation suite; here we lock the
// payload mapping and the terminal-status decision (the AC5 semantics).

// shopify-orders.ts → shopify-client.ts imports the service-role client at module
// init, so set dummy env BEFORE the dynamic import (mirrors shopify-client_test).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { parseShopifyWebhookOrder, refundStatusForOrder, ingestPaidOrdersSince } =
  await import("../lib/shopify-orders.ts");

import type { ShopifyOrder } from "../lib/shopify-client.ts";
import type { ShopifyOrderIngestResult } from "../lib/shopify-orders.ts";

const emptyIngest: ShopifyOrderIngestResult = {
  salesNew: 0,
  payoutsNew: 0,
  soldFlipped: 0,
  statusUpdated: 0,
  errors: [],
};

Deno.test("parseShopifyWebhookOrder maps the webhook order resource", () => {
  const order = parseShopifyWebhookOrder({
    id: 5511330001,
    name: "#1042",
    financial_status: "paid",
    total_price: "59.99",
    processed_at: "2026-06-13T10:00:00Z",
    cancelled_at: null,
    line_items: [
      { product_id: 880011, quantity: 1, price: "59.99" },
      { product_id: null, quantity: 2, price: "0.00" },
    ],
  });
  assert(order);
  assertEquals(order!.id, "5511330001");
  assertEquals(order!.name, "#1042");
  assertEquals(order!.financialStatus, "paid");
  assertEquals(order!.processedAt, "2026-06-13T10:00:00Z");
  assertEquals(order!.cancelledAt, null);
  assertEquals(order!.lineItems.length, 2);
  assertEquals(order!.lineItems[0]!.productId, "880011");
  assertEquals(order!.lineItems[0]!.price, 59.99);
  // A line item with no product_id is preserved but carries a null productId.
  assertEquals(order!.lineItems[1]!.productId, null);
});

Deno.test("parseShopifyWebhookOrder returns null without an order id", () => {
  assertEquals(parseShopifyWebhookOrder(null), null);
  assertEquals(parseShopifyWebhookOrder({}), null);
  assertEquals(parseShopifyWebhookOrder({ name: "#1" }), null);
});

// US-1427: the /listings/pull watermark (last_synced_at) must advance ONLY when
// the paid-order fetch+ingest completed without a fatal error. ingestPaidOrdersSince
// returns `ok`, which the handler uses to gate the stamp — so these lock the gate.
Deno.test("ingestPaidOrdersSince returns ok:false when listPaidOrders throws (watermark stays put)", async () => {
  let ingestCalls = 0;
  const res = await ingestPaidOrdersSince("user-1", "shop", "token", "2026-01-01T00:00:00Z", {
    listPaidOrders: () => {
      throw new Error("shopify 503 Service Unavailable");
    },
    ingestShopifyOrder: () => {
      ingestCalls++;
      return Promise.resolve(emptyIngest);
    },
  });
  assertEquals(res.ok, false);
  assertEquals(ingestCalls, 0);
  assert(res.errors.some((e) => e.includes("503")));
});

Deno.test("ingestPaidOrdersSince returns ok:true and totals on a clean fetch+ingest", async () => {
  const order: ShopifyOrder = {
    id: "9001",
    name: "#9001",
    financialStatus: "paid",
    totalPrice: 42,
    processedAt: "2026-06-14T00:00:00Z",
    cancelledAt: null,
    lineItems: [],
  };
  const res = await ingestPaidOrdersSince("user-1", "shop", "token", "2026-01-01T00:00:00Z", {
    listPaidOrders: () => Promise.resolve([order, order]),
    ingestShopifyOrder: () =>
      Promise.resolve({ ...emptyIngest, salesNew: 1, payoutsNew: 1 }),
  });
  assertEquals(res.ok, true);
  assertEquals(res.salesNew, 2);
  assertEquals(res.payoutsNew, 2);
  assertEquals(res.errors, []);
});

Deno.test("refundStatusForOrder maps cancel/refund to terminal status (AC5)", () => {
  // cancelled_at wins.
  assertEquals(
    refundStatusForOrder({
      id: "1",
      name: "#1",
      financialStatus: "paid",
      totalPrice: 10,
      processedAt: null,
      cancelledAt: "2026-06-13T12:00:00Z",
      lineItems: [],
    }),
    "cancelled",
  );
  // Fully refunded / voided → refunded.
  assertEquals(
    refundStatusForOrder({
      id: "2",
      name: "#2",
      financialStatus: "refunded",
      totalPrice: 10,
      processedAt: null,
      cancelledAt: null,
      lineItems: [],
    }),
    "refunded",
  );
  assertEquals(
    refundStatusForOrder({
      id: "3",
      name: "#3",
      financialStatus: "voided",
      totalPrice: 10,
      processedAt: null,
      cancelledAt: null,
      lineItems: [],
    }),
    "refunded",
  );
  // A live paid order (or a partial refund — still a real sale) → null.
  assertEquals(
    refundStatusForOrder({
      id: "4",
      name: "#4",
      financialStatus: "paid",
      totalPrice: 10,
      processedAt: null,
      cancelledAt: null,
      lineItems: [],
    }),
    null,
  );
  assertEquals(
    refundStatusForOrder({
      id: "5",
      name: "#5",
      financialStatus: "partially_refunded",
      totalPrice: 10,
      processedAt: null,
      cancelledAt: null,
      lineItems: [],
    }),
    null,
  );
});
