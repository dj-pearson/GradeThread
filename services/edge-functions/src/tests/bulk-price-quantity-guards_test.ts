// Pricing plan P6: POST /ebay/listings/bulk-price-quantity enforces the floor,
// refuses rows that are not live on eBay, stamps a seller-set price, and
// reports a local write that failed after eBay took the change. Driven through
// applyBulkPriceQuantity against the in-memory PostgREST with a stand-in eBay.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
// The hub first: flipdesk-ebay.ts mounts the per-concern files, and importing
// one of them on its own hits the cycle before the hub has initialised.
import "../routes/flipdesk-ebay.ts";
import { applyBulkPriceQuantity } from "../routes/flipdesk-ebay-listings.ts";

const db = installFakePostgrest();

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM = "22222222-2222-4222-8222-222222222222";
const LISTING = "33333333-3333-4333-8333-333333333333";

let pushes: Array<Array<Record<string, unknown>>> = [];
const push = ((_user: string, requests: Array<Record<string, unknown>>) => {
  pushes.push(requests);
  return Promise.resolve(
    requests.map((r) => ({
      statusCode: 200,
      offerId: ((r.offers as Array<{ offerId: string }>)[0]).offerId,
    })),
  );
}) as unknown as Parameters<typeof applyBulkPriceQuantity>[2];

function seed(listing: Partial<Row> = {}, item: Partial<Row> = {}): void {
  pushes = [];
  db.reset({
    inventory_items: [{ id: ITEM, user_id: A, sku: "SKU-1", floor_price: 20, ...item }],
    listings: [{
      id: LISTING,
      user_id: A,
      inventory_item_id: ITEM,
      platform: "ebay",
      listing_status: "active",
      listing_price: 30,
      listing_origin: "gradethread",
      platform_offer_id: "offer-1",
      platform_listing_id: "v1|1|0",
      inventory_sku: "SKU-1",
      price_set_by: null,
      ...listing,
    }],
  });
}

function price(): unknown {
  return db.tables.listings[0].listing_price;
}

async function run(user: string, updates: Array<Record<string, unknown>>) {
  const out = await applyBulkPriceQuantity(user, updates, push);
  if (!out.ok) throw new Error(out.error);
  return out;
}

Deno.test("P6: a price under the item floor is refused before eBay is called", async () => {
  seed();
  const out = await run(A, [{ listing_id: LISTING, price: 15 }]);
  assertEquals(out.results, [{
    listing_id: LISTING,
    ok: false,
    reason: "floor",
    floor: 20,
    error: "That price goes below this item's floor of $20.00.",
  }]);
  assertEquals(pushes.length, 0);
  assertEquals(price(), 30);
});

Deno.test("P6: a sold listing is refused", async () => {
  seed({ listing_status: "sold" });
  const out = await run(A, [{ listing_id: LISTING, price: 25 }]);
  assertEquals(out.results[0].reason, "not_live");
  assertEquals(pushes.length, 0);
  assertEquals(price(), 30);
});

Deno.test("P6: a success writes the price and stamps it seller-set", async () => {
  seed();
  const out = await run(A, [{ listing_id: LISTING, price: 25 }]);
  assertEquals(out.succeeded, 1);
  assertEquals(pushes.length, 1);
  assertEquals(price(), 25);
  assertEquals(db.tables.listings[0].price_set_by, "seller");
});

Deno.test("P6: a quantity-only change does not claim the price", async () => {
  seed();
  await run(A, [{ listing_id: LISTING, quantity: 0 }]);
  assertEquals(db.tables.listings[0].quantity, 0);
  assertEquals(db.tables.listings[0].price_set_by, null);
});

Deno.test("P6: a stale expected_price is refused", async () => {
  seed();
  const out = await run(A, [{ listing_id: LISTING, price: 25, expected_price: 32 }]);
  assertEquals(out.results[0].reason, "price_changed");
  assertEquals(pushes.length, 0);
});

Deno.test("P6: an eBay-originated listing is refused", async () => {
  seed({ listing_origin: "ebay" });
  const out = await run(A, [{ listing_id: LISTING, price: 25 }]);
  assertEquals(out.results[0].reason, "origin_locked");
  assertEquals(pushes.length, 0);
});

Deno.test("P6: a local write that fails after eBay took it is reported, not counted", async () => {
  seed();
  db.failNext("listings", "PATCH");
  const out = await run(A, [{ listing_id: LISTING, price: 25 }]);
  assertEquals(out.succeeded, 0);
  assertEquals(out.results[0].reason, "local_write");
  assertEquals(
    out.results[0].error,
    "Live on eBay, but our copy did not save. It will correct on the next sync.",
  );
});

Deno.test("P6: B cannot reprice A's listing; A's price is unchanged and eBay is not called", async () => {
  seed();
  const out = await run(B, [{ listing_id: LISTING, price: 25 }]);
  assertEquals(out.results, [{ listing_id: LISTING, ok: false, error: "Listing not found" }]);
  assertEquals(pushes.length, 0);
  assertEquals(price(), 30);
});
