import { assertEquals } from "@std/assert";
import {
  buildPriceQtyRequest,
  bulkPublishWithFallback,
  chunk,
  normalizeBulkEntry,
} from "../lib/ebay-bulk.ts";

Deno.test("buildPriceQtyRequest sets price + quantity on offer and SKU availability", () => {
  const r = buildPriceQtyRequest({ sku: "GT-1", offerId: "off-1", priceValue: 24.5, quantity: 3 });
  assertEquals(r.sku, "GT-1");
  assertEquals(r.shipToLocationAvailability, { quantity: 3 });
  assertEquals(r.offers, [{ offerId: "off-1", availableQuantity: 3, price: { value: "24.50", currency: "USD" } }]);
});

Deno.test("buildPriceQtyRequest omits unspecified fields", () => {
  const priceOnly = buildPriceQtyRequest({ sku: "S", offerId: "o", priceValue: 10 });
  assertEquals(priceOnly.shipToLocationAvailability, undefined);
  assertEquals(priceOnly.offers, [{ offerId: "o", price: { value: "10.00", currency: "USD" } }]);
  const qtyOnly = buildPriceQtyRequest({ sku: "S", offerId: "o", quantity: 0 });
  assertEquals(qtyOnly.shipToLocationAvailability, { quantity: 0 });
  assertEquals(qtyOnly.offers, [{ offerId: "o", availableQuantity: 0 }]);
});

Deno.test("chunk splits into <=size groups", () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunk([], 25), []);
});

Deno.test("normalizeBulkEntry classifies success and failure", () => {
  assertEquals(
    normalizeBulkEntry({ offerId: "o1", statusCode: 200, listingId: "L1" }),
    { key: "o1", ok: true, listingId: "L1" },
  );
  const bad = normalizeBulkEntry({
    offerId: "o2",
    statusCode: 400,
    errors: [{ message: "bad aspect" }, { message: "missing price" }],
  });
  assertEquals(bad.ok, false);
  assertEquals(bad.key, "o2");
  assertEquals(bad.error, "bad aspect; missing price");
});

Deno.test("bulkPublishWithFallback batches and maps per-item results", async () => {
  const calls: string[][] = [];
  const res = await bulkPublishWithFallback(["a", "b", "c"], {
    batchSize: 2,
    publishBatch: (ids) => {
      calls.push(ids);
      return Promise.resolve(
        ids.map((offerId) => ({ offerId, statusCode: 200, listingId: `L-${offerId}` })),
      );
    },
    publishOne: () => Promise.reject(new Error("should not be called")),
  });
  assertEquals(calls, [["a", "b"], ["c"]]); // chunked at 2
  assertEquals(res.length, 3);
  assertEquals(res.every((r) => r.ok), true);
  assertEquals(res[0].listingId, "L-a");
});

Deno.test("bulkPublishWithFallback falls back to single-item on batch throw", async () => {
  const singled: string[] = [];
  const res = await bulkPublishWithFallback(["x", "y"], {
    batchSize: 25,
    publishBatch: () => Promise.reject(new Error("429 rate limit")),
    publishOne: (offerId) => {
      singled.push(offerId);
      if (offerId === "y") return Promise.reject(new Error("invalid offer"));
      return Promise.resolve(`L-${offerId}`);
    },
  });
  assertEquals(singled, ["x", "y"]); // both retried individually
  assertEquals(res[0], { key: "x", ok: true, listingId: "L-x" });
  assertEquals(res[1].ok, false);
  assertEquals(res[1].error, "invalid offer");
});
