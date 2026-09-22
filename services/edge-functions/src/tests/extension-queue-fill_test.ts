import { assertEquals } from "@std/assert";
import { parseFillRequest } from "../lib/extension-queue-fill.ts";

// US-3455: what the phone may ask a create-form fill for.

const ITEM = "11111111-2222-4333-8444-555555555555";

Deno.test("fill: accepts an extension platform and an item id", () => {
  const r = parseFillRequest({ inventory_item_id: ITEM, platform: "poshmark" });
  assertEquals(r, { ok: true, itemId: ITEM, platform: "poshmark", payload: {} });
});

Deno.test("fill: refuses eBay and unknown platforms by name", () => {
  for (const platform of ["ebay", "shopify", "etsy", "", 42]) {
    const r = parseFillRequest({ inventory_item_id: ITEM, platform });
    assertEquals(r.ok, false, `platform ${String(platform)} should be refused`);
  }
});

Deno.test("fill: refuses a malformed item id before anything is read", () => {
  const r = parseFillRequest({ inventory_item_id: "not-a-uuid", platform: "mercari" });
  assertEquals(r.ok, false);
  assertEquals(parseFillRequest(null).ok, false);
});

Deno.test("fill: carries a typed price through as the queued path does, and refuses a bad one", () => {
  const good = parseFillRequest({ inventory_item_id: ITEM, platform: "mercari", price: " 45.50 " });
  assertEquals(good, { ok: true, itemId: ITEM, platform: "mercari", payload: { price: "45.50" } });
  const numeric = parseFillRequest({ inventory_item_id: ITEM, platform: "mercari", price: 45 });
  assertEquals(numeric.ok && numeric.payload.price, "45");
  const blank = parseFillRequest({ inventory_item_id: ITEM, platform: "mercari", price: "" });
  assertEquals(blank.ok && blank.payload, {});
  assertEquals(parseFillRequest({ inventory_item_id: ITEM, platform: "mercari", price: "$45" }).ok, false);
});
