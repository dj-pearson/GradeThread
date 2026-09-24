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
import { Hono } from "hono";
import {
  applyPriceSuggestion,
  flipdeskPricingRoutes,
  pricingEbay,
} from "../routes/flipdesk-pricing.ts";

const db = installFakePostgrest();

// The router mounted the way main.ts mounts it, with the caller stamped the way
// authMiddleware stamps it.
function app(userId: string) {
  const a = new Hono<{ Variables: { userId: string; workspaceOwnerId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  a.route("/api/flipdesk/pricing", flipdeskPricingRoutes);
  return a;
}

async function call(path: string, body?: unknown, userId = OWNER_ID) {
  const res = await app(userId).request(`/api/flipdesk/pricing${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// Comps the stand-in Browse search returns. A median of `median` dollars.
let compMedian = 40;
pricingEbay.searchBrowseComps = (() =>
  Promise.resolve({
    items: [],
    total: 12,
    stats: {
      count: 12,
      currency: "USD",
      min: compMedian * 0.7,
      p25: compMedian * 0.9,
      median: compMedian,
      p75: compMedian * 1.1,
      max: compMedian * 1.3,
    },
  })) as unknown as typeof pricingEbay.searchBrowseComps;

const OWNER = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = OWNER;
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
  reasonCode?: string;
  dismissedAt?: string | null;
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
    platform_category_id: "57988",
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
    reason_code: opts.reasonCode ?? "OVERPRICED",
    dismissed_at: opts.dismissedAt ?? null,
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

// ── P2 ──────────────────────────────────────────────────────────────

Deno.test("P2: a pending nudge on a sold listing leaves the queue, the bulk apply and the next scan", async () => {
  seed({ listingStatus: "sold" });
  // listings!inner(...) in the GET joins through listing_id.
  const list = await call("/suggestions");
  assertEquals(list.status, 200);
  assertEquals((list.body.suggestions as unknown[]).length, 0);

  const bulk = await call("/reprice/apply", { items: [{ listing_id: LISTING, price_cents: 4200 }] });
  assertEquals(bulk.status, 200);
  assertEquals(bulk.body.applied, 0);
  assertEquals(bulk.body.skipped, [{ listing_id: LISTING, reason: "listing_not_active" }]);
  assertEquals(offerPushes.length, 0);
  assertEquals(listingRow().listing_price, 50);

  pricingEbay.isEbayConfigured = () => true;
  const scan = await call("/scan", {});
  assertEquals(scan.status, 200);
  assertEquals(db.tables.repricing_suggestions.length, 0, "the scan sweeps the dead nudge");
});

Deno.test("P2: the sweep never touches another tenant's dead nudge", async () => {
  seed({ listingStatus: "sold" });
  await call("/scan", {}, "99999999-9999-4999-8999-999999999999");
  assertEquals(db.tables.repricing_suggestions.length, 1);
});

Deno.test("P2: a live listing's nudge is still listed", async () => {
  seed();
  const list = await call("/suggestions");
  assertEquals((list.body.suggestions as unknown[]).length, 1);
});

// ── P3 ──────────────────────────────────────────────────────────────
//
// With comps at a $40 median and no grade, the engine positions a $50 listing
// at $38.29 and calls it OVERPRICED. Those are the numbers below.

const DAY = 86_400_000;

Deno.test("P3: a dismissed nudge stays dismissed when the scan sees the same comps", async () => {
  compMedian = 40;
  seed({
    status: "dismissed",
    suggestedCents: 3829,
    dismissedAt: new Date(Date.now() - DAY).toISOString(),
  });
  const scan = await call("/scan", {});
  assertEquals(scan.status, 200);
  assertEquals(db.tables.repricing_suggestions[0].status, "dismissed");
  assertEquals(db.writes("repricing_suggestions").filter((c) => c.method === "POST").length, 0);
});

Deno.test("P3: it comes back when the comps move 10%", async () => {
  compMedian = 44;
  seed({
    status: "dismissed",
    suggestedCents: 3829,
    dismissedAt: new Date(Date.now() - DAY).toISOString(),
  });
  await call("/scan", {});
  compMedian = 40;
  const row = db.tables.repricing_suggestions[0];
  assertEquals(row.status, "pending");
  assertEquals(row.suggested_price_cents, 4211);
});

Deno.test("P3: it comes back once the hold runs out", async () => {
  compMedian = 40;
  seed({
    status: "dismissed",
    suggestedCents: 3829,
    dismissedAt: new Date(Date.now() - 15 * DAY).toISOString(),
  });
  await call("/scan", {});
  assertEquals(db.tables.repricing_suggestions[0].status, "pending");
});

Deno.test("P3: a failed write counts as an error, not as a nudge", async () => {
  compMedian = 40;
  seed();
  db.tables.repricing_suggestions = [];
  db.failNext("repricing_suggestions", "POST");
  const scan = await call("/scan", {});
  assertEquals(scan.body.errors, 1);
  assertEquals(scan.body.actionable, 0);
});

// ── P4 ──────────────────────────────────────────────────────────────

Deno.test("P4: bulk apply reports the price it replaced and logs a bulk_apply row", async () => {
  seed({ listingPrice: 55 });
  const out = await call("/reprice/apply", { items: [{ listing_id: LISTING, price_cents: 4800 }] });
  assertEquals(out.status, 200);
  assertEquals(out.body.applied, 1);
  assertEquals(out.body.applied_rows, [
    { listing_id: LISTING, old_price_cents: 5500, new_price_cents: 4800 },
  ]);
  assertEquals(out.body.not_processed, []);
  assertEquals(listingRow().price_set_by, "seller");
  assertEquals(db.tables.repricing_suggestions[0].status, "applied");
  assertEquals(db.tables.repricing_actions.map((a) => a.reason), ["bulk_apply"]);
});

Deno.test("P4: an Undo does not mark the nudge applied again and logs 'undo'", async () => {
  seed();
  const out = await call("/reprice/apply", {
    items: [{ listing_id: LISTING, price_cents: 5500 }],
    revert: true,
  });
  assertEquals(out.body.applied, 1);
  assertEquals(db.tables.repricing_suggestions[0].status, "pending");
  assertEquals(db.tables.repricing_actions.map((a) => a.reason), ["undo"]);
});

Deno.test("P4: more than 50 ids come back as not_processed", async () => {
  seed();
  const items = Array.from({ length: 53 }, (_, i) => ({
    listing_id: i === 0 ? LISTING : `extra-${i}`,
    price_cents: 4800,
  }));
  const out = await call("/reprice/apply", { items });
  assertEquals(out.body.not_processed, ["extra-50", "extra-51", "extra-52"]);
  assertEquals(out.body.applied, 1);
});

// ── P11 ─────────────────────────────────────────────────────────────

Deno.test("P11: 50 rows make 2 bulk eBay calls, not 50 single ones, and a refused offer stays put", async () => {
  offerPushes = [];
  const bulkCalls: number[] = [];
  const realBulk = pricingEbay.bulkUpdatePriceQuantity;
  pricingEbay.bulkUpdatePriceQuantity = ((_owner: string, requests: Array<Record<string, unknown>>) => {
    bulkCalls.push(requests.length);
    return Promise.resolve(
      requests.map((r) => {
        const offerId = (r.offers as Array<{ offerId: string }>)[0].offerId;
        return offerId === "offer-7"
          ? { offerId, statusCode: 400, errors: [{ message: "Price too low" }] }
          : { offerId, statusCode: 200 };
      }),
    );
  }) as unknown as typeof pricingEbay.bulkUpdatePriceQuantity;
  try {
    const items: Row[] = [];
    const listings: Row[] = [];
    for (let i = 0; i < 50; i++) {
      items.push({ id: `item-${i}`, user_id: OWNER, sku: `SKU-${i}`, acquired_price: null, floor_price: null });
      listings.push({
        id: `listing-${i}`,
        inventory_item_id: `item-${i}`,
        platform: "ebay",
        listing_status: "active",
        listing_price: 50,
        platform_offer_id: `offer-${i}`,
        inventory_sku: null,
      });
    }
    db.reset({ inventory_items: items, listings });
    const out = await call("/reprice/apply", {
      items: listings.map((l) => ({ listing_id: l.id, price_cents: 4500 })),
    });
    assertEquals(bulkCalls, [25, 25]);
    assertEquals(offerPushes.length, 0, "no single-offer calls");
    assertEquals(out.body.applied, 49);
    assertEquals(out.body.errors, [{ listing_id: "listing-7", message: "Price too low" }]);
    const byId = new Map(db.tables.listings.map((l) => [l.id, l.listing_price]));
    assertEquals(byId.get("listing-7"), 50, "the refused row keeps its price");
    assertEquals(byId.get("listing-8"), 45);
  } finally {
    pricingEbay.bulkUpdatePriceQuantity = realBulk;
  }
});
