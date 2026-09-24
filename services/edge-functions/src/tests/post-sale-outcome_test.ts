// PS-03 / PS-04: what a post-sale outcome writes, and to which sale.
//
// An item-not-received refund used to go through the return path, which set
// the garment to 'returned' and fed the relist loop an item that was lost in
// the post. And every outcome route trusted the body's order_id. These pin the
// plan per outcome, the writes it actually makes, and the order resolution.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { fakeOutcomeDb } from "./_fake-outcome-db.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isItemNotReceivedCase, outcomeToSaleStatus, outcomeWritePlan } = await import(
  "../lib/ebay-postorder.ts"
);
const { applyOutcomeToSale } = await import("../lib/post-sale-outcome.ts");
const { chooseOrderId, loadStoredCaseRef, resolveCaseOrderId } = await import(
  "../lib/post-sale-store.ts"
);

const OWNER = "owner-1";

function world() {
  return fakeOutcomeDb({
    sales: [
      { id: "sale-1", user_id: OWNER, platform_order_id: "O-1", inventory_item_id: "item-1", listing_id: "lst-1", status: "completed" },
      { id: "sale-2", user_id: OWNER, platform_order_id: "O-2", inventory_item_id: "item-2", listing_id: "lst-2", status: "completed" },
    ],
    inventory_items: [
      { id: "item-1", user_id: OWNER, status: "shipped" },
      { id: "item-2", user_id: OWNER, status: "shipped" },
    ],
    listings: [
      { id: "lst-1", user_id: OWNER, listing_status: "sold" },
      // Same id, another tenant: a write keyed on id alone would touch it.
      { id: "lst-1", user_id: "someone-else", listing_status: "active" },
    ],
  });
}

function deps(db: unknown) {
  const reversed: string[][] = [];
  return {
    reversed,
    deps: {
      db: db as never,
      reversePayouts: (ids: string[]) => {
        reversed.push(ids);
        return Promise.resolve();
      },
    },
  };
}

Deno.test("outcomeToSaleStatus: inr_refunded and dispute_accepted mark the sale refunded", () => {
  assertEquals(outcomeToSaleStatus("inr_refunded"), "refunded");
  assertEquals(outcomeToSaleStatus("dispute_accepted"), "refunded");
  assertEquals(outcomeToSaleStatus("return_refunded"), "refunded");
});

Deno.test("outcomeWritePlan: an INR refund has no inventory or listing write", () => {
  const inr = outcomeWritePlan("inr_refunded");
  assertEquals(inr.saleStatus, "refunded");
  assert(inr.reversePayout);
  assertFalse(inr.restoreItem);
  assertFalse(inr.endListing);

  const ret = outcomeWritePlan("return_refunded");
  assert(ret.restoreItem);
  assert(ret.endListing);

  const dispute = outcomeWritePlan("dispute_accepted");
  assertFalse(dispute.restoreItem);
  assertFalse(dispute.endListing);

  const declined = outcomeWritePlan("return_declined");
  assertEquals(declined.saleStatus, null);
  assertFalse(declined.reversePayout);
});

Deno.test("applyOutcomeToSale(inr_refunded) refunds the sale and leaves the item and listing", async () => {
  const w = world();
  const d = deps(w.db);
  await applyOutcomeToSale(OWNER, "O-1", "inr_refunded", d.deps);
  const tables = w.calls.filter((c) => c.op === "update").map((c) => c.table);
  assertEquals(tables, ["sales"]);
  assertEquals(d.reversed, [["sale-1"]]);
});

Deno.test("applyOutcomeToSale(return_refunded) still restocks the item and ends the listing", async () => {
  const w = world();
  const d = deps(w.db);
  await applyOutcomeToSale(OWNER, "O-1", "return_refunded", d.deps);
  const tables = w.calls.filter((c) => c.op === "update").map((c) => c.table);
  assertEquals(tables, ["sales", "inventory_items", "listings"]);
});

Deno.test("applyOutcomeToSale scopes the listings write to the owner", async () => {
  const w = world();
  const d = deps(w.db);
  await applyOutcomeToSale(OWNER, "O-1", "return_refunded", d.deps);
  const listingWrite = w.calls.find((c) => c.table === "listings" && c.op === "update")!;
  assertEquals(listingWrite.eq.user_id, OWNER);
});

Deno.test("isItemNotReceivedCase: by reason, or by the inquiry it grew out of", () => {
  assert(isItemNotReceivedCase({ reason: "ITEM_NOT_RECEIVED" }));
  assert(isItemNotReceivedCase({ reason: "OTHER", escalatedFromInquiry: true }));
  assertFalse(isItemNotReceivedCase({ reason: "NOT_AS_DESCRIBED" }));
  assertFalse(isItemNotReceivedCase({ reason: null }));
});

Deno.test("chooseOrderId: the stored order wins; the body is used only with no record", () => {
  assertEquals(chooseOrderId("O-1", "O-2"), { orderId: "O-1", source: "stored", mismatch: true });
  assertEquals(chooseOrderId("O-1", "O-1"), { orderId: "O-1", source: "stored", mismatch: false });
  assertEquals(chooseOrderId(null, "O-2"), { orderId: "O-2", source: "client", mismatch: false });
  assertEquals(chooseOrderId(null, undefined), { orderId: null, source: "none", mismatch: false });
  assertEquals(chooseOrderId(null, 42), { orderId: null, source: "none", mismatch: false });
});

Deno.test("resolveCaseOrderId reads the owner's own stored case only", async () => {
  const w = fakeOutcomeDb({
    marketplace_post_sale_cases: [
      { user_id: OWNER, platform: "ebay", case_type: "return", external_id: "R-1", external_order_id: "O-1", reason: null, raw: {} },
      { user_id: "someone-else", platform: "ebay", case_type: "return", external_id: "R-9", external_order_id: "O-9", reason: null, raw: {} },
    ],
  });
  assertEquals(await resolveCaseOrderId(OWNER, "return", "R-1", w.db), "O-1");
  assertEquals(await resolveCaseOrderId(OWNER, "return", "R-9", w.db), null);
  const ref = await loadStoredCaseRef(OWNER, "return", "R-1", w.db);
  assertEquals(ref?.externalOrderId, "O-1");
});
