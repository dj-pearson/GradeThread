// US-9109: the listings and sales read layer shared by /api/v1/listings,
// /api/v1/sales and the connector's gradethread_list_listings /
// gradethread_list_sales tools.
//
// Beyond the tenant scope, two things here are easy to get quietly wrong and
// expensive when they are:
//
//   • a "sales" list that includes cancelled and refunded rows reports revenue
//     the seller never received;
//   • a roll-up over the returned PAGE presented as the period total
//     understates it. The payload says which it is, and so does the tool text.

import { assert, assertEquals, assertExists } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  clampListingsLimit,
  decodeListingCursor,
  encodeListingCursor,
  LISTINGS_PAGE_DEFAULT,
  LISTINGS_PAGE_MAX,
  ListingQueryError,
  listListings,
  listSales,
} = await import("../lib/api-listings.ts");

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-08-18T12:00:00.000Z");

interface RecordedCall {
  table: string;
  columns: string;
  filters: Array<{ op: string; column: string; value: unknown; extra?: unknown }>;
  limit: number | null;
}

function recordingDb(rows: unknown[]) {
  const calls: RecordedCall[] = [];

  function builder(table: string, columns: string) {
    const record: RecordedCall = { table, columns, filters: [], limit: null };
    calls.push(record);

    const api: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        record.filters.push({ op: "eq", column, value });
        return api;
      },
      not(column: string, op: unknown, value: unknown) {
        record.filters.push({ op: "not", column, value, extra: op });
        return api;
      },
      gte(column: string, value: unknown) {
        record.filters.push({ op: "gte", column, value });
        return api;
      },
      lte(column: string, value: unknown) {
        record.filters.push({ op: "lte", column, value });
        return api;
      },
      lt(column: string, value: unknown) {
        record.filters.push({ op: "lt", column, value });
        return api;
      },
      order() {
        return api;
      },
      limit(n: number) {
        record.limit = n;
        return api;
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve);
      },
    };
    return api;
  }

  return {
    calls,
    db: {
      from(table: string) {
        return { select: (columns: string) => builder(table, columns) };
      },
    },
  };
}

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    item_title: "Carhartt Detroit Jacket",
    brand: "Carhartt",
    size: "L",
    listing_id: "listing-1",
    listing_platform: "ebay",
    listing_status: "active",
    list_price: 129.99,
    link: "https://ebay.com/itm/1",
    list_date: "2026-08-01T00:00:00.000Z",
    listing_watchers: 4,
    listing_views: 90,
    grade_value: 8.5,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function saleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    item_title: "Levis 501",
    brand: "Levis",
    listing_platform: "ebay",
    sale_status: "completed",
    sale_price: 60,
    fees: 8,
    tax: 0,
    shipping_cost: 9,
    net_profit: 28,
    purchase_price: 15,
    sale_date: "2026-08-10T00:00:00.000Z",
    days_to_sell: 9,
    created_at: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tenant scoping
// ---------------------------------------------------------------------------

Deno.test("listListings scopes on the tenant", async () => {
  const { db, calls } = recordingDb([listingRow()]);
  await listListings(TENANT, {}, db, NOW);
  assertEquals(calls[0].filters.find((f) => f.column === "user_id")?.value, TENANT);
});

Deno.test("listSales scopes on the tenant", async () => {
  const { db, calls } = recordingDb([saleRow()]);
  await listSales(TENANT, {}, db);
  assertEquals(calls[0].filters.find((f) => f.column === "user_id")?.value, TENANT);
});

// ---------------------------------------------------------------------------
// What each list actually contains
// ---------------------------------------------------------------------------

Deno.test("listListings excludes items that have no listing at all", async () => {
  // Without this the 'listings' list is really the inventory list with
  // mostly-null columns, and a seller asking 'what is live' gets everything.
  const { db, calls } = recordingDb([listingRow()]);
  await listListings(TENANT, {}, db, NOW);
  const notNull = calls[0].filters.find((f) => f.column === "listing_id" && f.op === "not");
  assertExists(notNull, "listings must be filtered to rows that have a listing");
});

Deno.test("listSales defaults to COMPLETED sales, because the rest are not revenue", async () => {
  const { db, calls } = recordingDb([saleRow()]);
  await listSales(TENANT, {}, db);
  assertEquals(calls[0].filters.find((f) => f.column === "sale_status" && f.op === "eq")?.value, "completed");
});

Deno.test("listSales honours an explicit status when the seller asks for refunds", async () => {
  const { db, calls } = recordingDb([saleRow({ sale_status: "refunded" })]);
  await listSales(TENANT, { status: "refunded" }, db);
  assertEquals(calls[0].filters.find((f) => f.column === "sale_status" && f.op === "eq")?.value, "refunded");
});

// ---------------------------------------------------------------------------
// Money and derived numbers
// ---------------------------------------------------------------------------

Deno.test("every money field crosses as integer cents", async () => {
  const { db } = recordingDb([saleRow()]);
  const page = await listSales(TENANT, {}, db);
  const sale = page.items[0];
  assertEquals(sale.sale_price_cents, 6000);
  assertEquals(sale.fees_cents, 800);
  assertEquals(sale.shipping_cost_cents, 900);
  assertEquals(sale.net_profit_cents, 2800);
  assertEquals(sale.purchase_price_cents, 1500);
});

Deno.test("days_live is whole days from the list date, and null when there is no date", async () => {
  const { db } = recordingDb([
    listingRow({ list_date: "2026-08-01T00:00:00.000Z" }),
  ]);
  const page = await listListings(TENANT, {}, db, NOW);
  assertEquals(page.items[0].days_live, 17);

  const noDate = recordingDb([listingRow({ list_date: null })]);
  const page2 = await listListings(TENANT, {}, noDate.db, NOW);
  // Null, not 0: "listed today" and "we do not know" are different answers.
  assertEquals(page2.items[0].days_live, null);
});

Deno.test("min_days_live becomes a list_date cutoff, not a client-side filter", async () => {
  const { db, calls } = recordingDb([listingRow()]);
  await listListings(TENANT, { minDaysLive: 30 }, db, NOW);
  const cutoff = calls[0].filters.find((f) => f.column === "list_date" && f.op === "lte");
  assertExists(cutoff);
  // 30 days before NOW.
  assertEquals(cutoff.value, new Date(NOW - 30 * 86_400_000).toISOString());
});

Deno.test("price filters are converted from cents back to the column's units", async () => {
  const { db, calls } = recordingDb([listingRow()]);
  await listListings(TENANT, { minPriceCents: 5000, maxPriceCents: 20000 }, db, NOW);
  assertEquals(calls[0].filters.find((f) => f.column === "list_price" && f.op === "gte")?.value, 50);
  assertEquals(
    calls[0].filters.find((f) => f.column === "list_price" && f.op === "lte")?.value,
    200,
  );
});

// ---------------------------------------------------------------------------
// The roll-up
// ---------------------------------------------------------------------------

Deno.test("the sales roll-up sums the returned rows and says so when it is page-only", async () => {
  const rows = Array.from({ length: 26 }, (_, i) => saleRow({ id: `sale-${i}` }));
  const { db } = recordingDb(rows);
  const page = await listSales(TENANT, { limit: 25 }, db);

  assertEquals(page.items.length, 25);
  assertEquals(page.totals.count, 25);
  assertEquals(page.totals.gross_cents, 25 * 6000);
  assertEquals(page.totals.net_profit_cents, 25 * 2800);
  // A model reporting this as the period total would understate the seller's
  // revenue, so the flag is part of the payload rather than implied.
  assertEquals(page.totals.page_only, true);
  assertExists(page.next_cursor);
});

Deno.test("a roll-up covering every matching row is not flagged page-only", async () => {
  const { db } = recordingDb([saleRow(), saleRow({ id: "sale-2" })]);
  const page = await listSales(TENANT, { limit: 25 }, db);
  assertEquals(page.totals.page_only, false);
  assertEquals(page.next_cursor, null);
});

Deno.test("a missing money field contributes nothing to the roll-up rather than NaN", async () => {
  const { db } = recordingDb([saleRow({ net_profit: null, sale_price: null })]);
  const page = await listSales(TENANT, {}, db);
  assertEquals(page.totals.gross_cents, 0);
  assertEquals(page.totals.net_profit_cents, 0);
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

Deno.test("clampListingsLimit defaults and bounds the page size", () => {
  assertEquals(clampListingsLimit(undefined), LISTINGS_PAGE_DEFAULT);
  assertEquals(clampListingsLimit(10), 10);
  assertEquals(clampListingsLimit(9999), LISTINGS_PAGE_MAX);
});

Deno.test("a listing cursor round-trips and a corrupt one is refused", async () => {
  const cursor = encodeListingCursor("2026-08-01T00:00:00.000Z", "abc");
  assertEquals(decodeListingCursor(cursor), {
    createdAt: "2026-08-01T00:00:00.000Z",
    id: "abc",
  });
  assertEquals(decodeListingCursor("nonsense!!"), null);

  const { db } = recordingDb([]);
  let thrown: unknown;
  try {
    await listListings(TENANT, { cursor: "nonsense!!" }, db, NOW);
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof ListingQueryError);
});

Deno.test("both lists ask for one extra row rather than issuing a second count query", async () => {
  const { db, calls } = recordingDb([listingRow()]);
  await listListings(TENANT, { limit: 25 }, db, NOW);
  assertEquals(calls[0].limit, 26);
});
