// US-3367: the pure halves of recording a sale. The DB-touching recordSale is
// exercised by the tenant-isolation lane; here the money and the body parser.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  computeNetProfit,
  parseRecordSaleBody,
  planSoldListingUpdate,
} from "../lib/record-sale.ts";

const ITEM = "11111111-1111-1111-1111-111111111111";
const fees = {
  sale_price: 40,
  shipping_collected: 5,
  platform_fees: 4,
  payment_processing_fees: 1.5,
  shipping_cost: 6,
  tax: 0,
  other_costs: 0.5,
};

Deno.test("net profit is price + shipping collected minus every cost and the cost basis", () => {
  assertEquals(computeNetProfit(fees, 10), 40 + 5 - 4 - 1.5 - 6 - 0 - 0.5 - 10);
});

Deno.test("a multi-unit listing decrements; the last unit marks it sold", () => {
  assertEquals(planSoldListingUpdate(3), { quantity: 2 });
  assertEquals(planSoldListingUpdate(1), { listing_status: "sold", is_active: false, quantity: 0 });
  assertEquals(planSoldListingUpdate(null), { listing_status: "sold", is_active: false, quantity: 0 });
  assertEquals(planSoldListingUpdate(0), { listing_status: "sold", is_active: false, quantity: 0 });
});

Deno.test("the body parser rejects a non-positive price and negative costs", () => {
  assertEquals(parseRecordSaleBody({ inventory_item_id: ITEM, sale_price: 0 }).ok, false);
  assertEquals(parseRecordSaleBody({ inventory_item_id: ITEM, sale_price: 10, shipping_cost: -1 }).ok, false);
});

Deno.test("the body parser fills omitted costs with 0 and keeps a null listing id", () => {
  const r = parseRecordSaleBody({ inventory_item_id: ITEM, sale_price: 12.5 });
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.input.listing_id, null);
  assertEquals(r.input.platform_fees, 0);
  assertEquals(r.input.sale_date, null);
  assertEquals(r.input.buyer_username, null);
});

Deno.test("the body parser accepts numeric strings, the way an input field sends them", () => {
  const r = parseRecordSaleBody({ inventory_item_id: ITEM, sale_price: "19.99", tax: "1.20" });
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.input.sale_price, 19.99);
  assertEquals(r.input.tax, 1.2);
});

Deno.test("the body parser rejects a malformed listing id rather than passing it to the DB", () => {
  assertEquals(parseRecordSaleBody({ inventory_item_id: ITEM, sale_price: 1, listing_id: "../x" }).ok, false);
});

Deno.test("the body parser rejects a missing or malformed item id", () => {
  assertEquals(parseRecordSaleBody({ sale_price: 1 }).ok, false);
  assertEquals(parseRecordSaleBody({ inventory_item_id: "nope", sale_price: 1 }).ok, false);
});

Deno.test("the body parser keeps a YYYY-MM-DD date and drops anything else", () => {
  const good = parseRecordSaleBody({ inventory_item_id: ITEM, sale_price: 1, sale_date: "2026-09-11" });
  if (!good.ok) throw new Error(good.error);
  assertEquals(good.input.sale_date, "2026-09-11");
  const bad = parseRecordSaleBody({ inventory_item_id: ITEM, sale_price: 1, sale_date: "yesterday" });
  if (!bad.ok) throw new Error(bad.error);
  assertEquals(bad.input.sale_date, null);
});
