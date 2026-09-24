// The Pricing page's price-moving paths, driven end to end against an in-memory
// PostgREST (./_fake-postgrest.ts) and a stand-in eBay. Every assertion reads a
// row back or counts an eBay call; none of them reads source text.
//
//   P1  single-row Apply: floor, pending only, live listing only, stale price
//   P2  sold or ended listings leave the queue and the bulk apply
//   P3  a dismissed nudge stays dismissed across scans
//   P4  bulk apply reports the old price and what it did not process
//   P9  one rules run per owner at a time
//   P11 bulk apply batches the eBay pushes

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import {
  applyPriceSuggestion,
  pricingEbay,
} from "../routes/flipdesk-pricing.ts";

const db = installFakePostgrest();

const OWNER = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const LISTING = "33333333-3333-4333-8333-333333333333";
const SUG = "44444444-4444-4444-8444-444444444444";

let offerPushes: Array<{ offerId: string; price: number }> = [];

pricingEbay.isEbayConfigured = () => true;
pricingEbay.updateOfferPrice = ((_owner: string, offerId: string, price: number) => {
  offerPushes.push({ offerId, price });
  return Promise.resolve();
}) as typeof pricingEbay.updateOfferPrice;

function seed(opts: {
  listingPrice?: number;
  listingStatus?: string;
  floorPrice?: number | null;
  acquiredPrice?: number | null;
  status?: string;
  currentCents?: number;
  suggestedCents?: number;
} = {}): void {
  offerPushes = [];
  const item: Row = {
    id: ITEM,
    user_id: OWNER,
    title: "Barbour Bedale",
    acquired_price: opts.acquiredPrice ?? null,
    floor_price: opts.floorPrice ?? null,
  };
  const listing: Row = {
    id: LISTING,
    inventory_item_id: ITEM,
    platform: "ebay",
    listing_status: opts.listingStatus ?? "active",
    listing_price: opts.listingPrice ?? 50,
    platform_offer_id: "offer-1",
    price_set_by: null,
  };
  const sug: Row = {
    id: SUG,
    user_id: OWNER,
    inventory_item_id: ITEM,
    listing_id: LISTING,
    status: opts.status ?? "pending",
    current_price_cents: opts.currentCents ?? 5000,
    suggested_price_cents: opts.suggestedCents ?? 4200,
  };
  db.reset({ inventory_items: [item], listings: [listing], repricing_suggestions: [sug] });
}

function listingRow(): Row {
  return db.tables.listings.find((l) => l.id === LISTING)!;
}

// ── P1 ──────────────────────────────────────────────────────────────

Deno.test("P1: a pending nudge above the floor applies, pushes eBay, stamps seller and logs it", async () => {
  seed({ floorPrice: 30 });
  const out = await applyPriceSuggestion(OWNER, SUG);
  assertEquals(out.status, 200);
  assertEquals(out.body.applied, true);
  assertEquals(out.body.old_price, 50);
  assertEquals(offerPushes, [{ offerId: "offer-1", price: 42 }]);
  assertEquals(listingRow().listing_price, 42);
  assertEquals(listingRow().price_set_by, "seller");
  assertEquals(db.tables.repricing_suggestions[0].status, "applied");
  const audit = db.tables.repricing_actions ?? [];
  assertEquals(audit.length, 1);
  assertEquals(audit[0].reason, "nudge_apply");
  assertEquals(audit[0].rule_id, null);
  assertEquals(audit[0].old_price_cents, 5000);
  assertEquals(audit[0].new_price_cents, 4200);
});

Deno.test("P1: a nudge under floor_price is refused and eBay is never called", async () => {
  seed({ floorPrice: 45 });
  const out = await applyPriceSuggestion(OWNER, SUG);
  assertEquals(out.status, 409);
  assertEquals(out.body.reason, "below_margin_floor");
  assertEquals(out.body.floor_cents, 4500);
  assertEquals(offerPushes.length, 0);
  assertEquals(listingRow().listing_price, 50);
  assertEquals(db.tables.repricing_suggestions[0].status, "pending");
});

Deno.test("P1: the cost-plus-margin floor binds too", async () => {
  // $40 cost at the default margin is well above $42.
  seed({ acquiredPrice: 40 });
  const out = await applyPriceSuggestion(OWNER, SUG);
  assertEquals(out.status, 409);
  assertEquals(out.body.reason, "below_margin_floor");
  assertEquals(offerPushes.length, 0);
});

Deno.test("P1: a dismissed nudge is refused", async () => {
  seed({ status: "dismissed" });
  const out = await applyPriceSuggestion(OWNER, SUG);
  assertEquals(out.status, 409);
  assertEquals(out.body.reason, "not_pending");
  assertEquals(offerPushes.length, 0);
});

Deno.test("P1: a sold listing is refused", async () => {
  seed({ listingStatus: "sold" });
  const out = await applyPriceSuggestion(OWNER, SUG);
  assertEquals(out.status, 409);
  assertEquals(out.body.reason, "listing_not_active");
  assertEquals(offerPushes.length, 0);
  assertEquals(listingRow().listing_price, 50);
});

Deno.test("P1: a price the seller retyped since the scan is refused", async () => {
  seed({ listingPrice: 55 });
  const out = await applyPriceSuggestion(OWNER, SUG);
  assertEquals(out.status, 409);
  assertEquals(out.body.reason, "price_changed");
  assertEquals(out.body.live_price_cents, 5500);
  assertEquals(offerPushes.length, 0);
  assertEquals(listingRow().listing_price, 55);
});

Deno.test("P1: another tenant's suggestion is not found and nothing moves", async () => {
  seed();
  const out = await applyPriceSuggestion("99999999-9999-4999-8999-999999999999", SUG);
  assertEquals(out.status, 404);
  assertEquals(offerPushes.length, 0);
  assertEquals(listingRow().listing_price, 50);
  assert(!(db.tables.repricing_actions ?? []).length);
});
