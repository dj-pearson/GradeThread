// US-1474: eBay Feed API (LMS order report) unit tests. Cover the pure parser,
// the threshold/flag gates, the gzip decode, and the create→poll→download
// orchestration via injected deps (no network, no DB, no live eBay).

import { assertEquals } from "@std/assert";

// ebay-feed transitively imports the service-role Supabase client at load, which
// throws when these are unset — set dummies, then dynamic-import.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const feed = await import("../lib/ebay-feed.ts");

function clearFeedEnv() {
  Deno.env.delete("EBAY_FEED_SYNC");
  Deno.env.delete("EBAY_FEED_SYNC_MIN_CATALOG");
}

const SAMPLE_ORDER_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<OrderReport xmlns="urn:ebay:apis:eBLBaseComponents">
  <Order>
    <OrderID>12-34567-89012</OrderID>
    <OrderStatus>Completed</OrderStatus>
    <CreatedTime>2026-06-01T10:00:00.000Z</CreatedTime>
    <CheckoutStatus><Status>Complete</Status></CheckoutStatus>
    <BuyerUserID>happybuyer</BuyerUserID>
    <Total currencyID="USD">32.50</Total>
    <ShippingServiceSelected><ShippingServiceCost currencyID="USD">5.00</ShippingServiceCost></ShippingServiceSelected>
    <TransactionArray>
      <Transaction>
        <TransactionID>1001</TransactionID>
        <Item><ItemID>1122334455</ItemID><SKU>SKU-A</SKU><Title>Vintage Tee</Title></Item>
        <QuantityPurchased>1</QuantityPurchased>
        <TransactionPrice currencyID="USD">25.00</TransactionPrice>
        <Taxes><TotalTaxAmount currencyID="USD">2.50</TotalTaxAmount></Taxes>
        <ShippedTime>2026-06-02T12:00:00.000Z</ShippedTime>
      </Transaction>
    </TransactionArray>
  </Order>
  <Order>
    <OrderID>99-99999-99999</OrderID>
    <OrderStatus>Cancelled</OrderStatus>
    <CreatedTime>2026-06-03T08:00:00.000Z</CreatedTime>
    <CheckoutStatus><Status>Incomplete</Status></CheckoutStatus>
    <BuyerUserID>cancelguy</BuyerUserID>
    <Total currencyID="USD">10.00</Total>
    <TransactionArray>
      <Transaction>
        <TransactionID>2002</TransactionID>
        <Item><ItemID>5566778899</ItemID><Title>No SKU Item</Title></Item>
        <QuantityPurchased>2</QuantityPurchased>
        <TransactionPrice currencyID="USD">5.00</TransactionPrice>
      </Transaction>
    </TransactionArray>
  </Order>
</OrderReport>`;

Deno.test("parseOrderReport maps a completed order + line item", () => {
  const orders = feed.parseOrderReport(SAMPLE_ORDER_REPORT);
  assertEquals(orders.length, 2);
  const o = orders[0];
  assertEquals(o.orderId, "12-34567-89012");
  assertEquals(o.creationDate, "2026-06-01T10:00:00.000Z");
  assertEquals(o.lastModifiedDate, "2026-06-01T10:00:00.000Z");
  assertEquals(o.buyerUsername, "happybuyer");
  assertEquals(o.cancelState, "NONE_REQUESTED");
  assertEquals(o.orderPaymentStatus, "PAID");
  assertEquals(o.orderFulfillmentStatus, "FULFILLED");
  assertEquals(o.totalAmount, { value: "32.50", currency: "USD" });
  assertEquals(o.shippingTotal, { value: "5.00", currency: "USD" });
  assertEquals(o.lineItems.length, 1);
  const li = o.lineItems[0];
  assertEquals(li.lineItemId, "1001"); // Trading TransactionID (documented)
  assertEquals(li.sku, "SKU-A");
  assertEquals(li.legacyItemId, "1122334455");
  assertEquals(li.title, "Vintage Tee");
  assertEquals(li.quantity, 1);
  assertEquals(li.itemCost, { value: "25.00", currency: "USD" });
  assertEquals(li.taxes, { value: "2.50", currency: "USD" });
});

Deno.test("parseOrderReport flags a cancelled/unpaid order", () => {
  const o = feed.parseOrderReport(SAMPLE_ORDER_REPORT)[1];
  assertEquals(o.orderId, "99-99999-99999");
  assertEquals(o.cancelState, "CANCELED");
  assertEquals(o.orderPaymentStatus, null); // checkout not complete
  assertEquals(o.orderFulfillmentStatus, null); // never shipped
  assertEquals(o.lineItems[0].sku, null); // missing SKU tolerated
  assertEquals(o.lineItems[0].quantity, 2);
});

Deno.test("parseOrderReport returns [] for empty/malformed input", () => {
  assertEquals(feed.parseOrderReport(""), []);
  assertEquals(feed.parseOrderReport("not xml <<<"), []);
  assertEquals(feed.parseOrderReport("<OrderReport></OrderReport>"), []);
});

Deno.test("catalogAboveFeedThreshold uses the default 1000 floor", () => {
  clearFeedEnv();
  assertEquals(feed.catalogAboveFeedThreshold(999), false);
  assertEquals(feed.catalogAboveFeedThreshold(1000), true);
  assertEquals(feed.catalogAboveFeedThreshold(5000), true);
});

Deno.test("catalogAboveFeedThreshold honors the env override", () => {
  clearFeedEnv();
  Deno.env.set("EBAY_FEED_SYNC_MIN_CATALOG", "50");
  assertEquals(feed.catalogAboveFeedThreshold(49), false);
  assertEquals(feed.catalogAboveFeedThreshold(50), true);
  clearFeedEnv();
});

Deno.test("feedSyncEnabled is off by default, on for on/true/1", () => {
  clearFeedEnv();
  assertEquals(feed.feedSyncEnabled(), false);
  for (const v of ["on", "true", "1", "ON", "True"]) {
    Deno.env.set("EBAY_FEED_SYNC", v);
    assertEquals(feed.feedSyncEnabled(), true);
  }
  Deno.env.set("EBAY_FEED_SYNC", "off");
  assertEquals(feed.feedSyncEnabled(), false);
  clearFeedEnv();
});

Deno.test("shouldUseFeedForOrders requires BOTH flag and threshold", () => {
  clearFeedEnv();
  // flag off → never, even for a huge catalog
  assertEquals(feed.shouldUseFeedForOrders(100_000), false);
  Deno.env.set("EBAY_FEED_SYNC", "on");
  assertEquals(feed.shouldUseFeedForOrders(999), false); // below threshold
  assertEquals(feed.shouldUseFeedForOrders(1000), true);
  clearFeedEnv();
});

Deno.test("gunzipResponseText decodes a gzipped body", async () => {
  const text = "<OrderReport>gzip round trip</OrderReport>";
  const gz = new Response(text).body!.pipeThrough(new CompressionStream("gzip"));
  const res = new Response(gz);
  assertEquals(await feed.gunzipResponseText(res), text);
});

Deno.test("runOrderReport: create → poll → download → parse (DI)", async () => {
  const calls: string[] = [];
  let polls = 0;
  const orders = await feed.runOrderReport("user-1", "2026-05-01T00:00:00.000Z", {
    createTask: (_u, _s, _n) => {
      calls.push("create");
      return Promise.resolve("task-123");
    },
    getTask: (_u, taskId) => {
      polls++;
      calls.push(`poll:${polls}`);
      // First poll IN_PROCESS, then COMPLETED.
      return Promise.resolve({
        taskId,
        status: polls < 2 ? "IN_PROCESS" : "COMPLETED",
      });
    },
    download: (_u, _t) => {
      calls.push("download");
      return Promise.resolve(SAMPLE_ORDER_REPORT);
    },
    sleep: () => Promise.resolve(),
    now: () => 1_800_000_000_000,
  });
  assertEquals(calls, ["create", "poll:1", "poll:2", "download"]);
  assertEquals(orders.length, 2);
  assertEquals(orders[0].orderId, "12-34567-89012");
});

Deno.test("runOrderReport throws when the task fails (caller falls back)", async () => {
  let threw = false;
  try {
    await feed.runOrderReport("user-1", null, {
      createTask: () => Promise.resolve("task-x"),
      getTask: (_u, taskId) => Promise.resolve({ taskId, status: "FAILED" }),
      download: () => Promise.resolve(""),
      sleep: () => Promise.resolve(),
      now: () => 1_800_000_000_000,
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
