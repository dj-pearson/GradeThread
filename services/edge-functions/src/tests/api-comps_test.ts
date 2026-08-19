// US-9110: the comp surface the connector may expose.
//
// The property this file exists to protect is the REDISTRIBUTION BOUNDARY: only
// an aggregate leaves compsForItem. No listing titles, no seller names, no
// URLs, no per-listing rows. Serving third-party listing data through a
// connector is the fastest way to lose the eBay keyset the rest of FlipDesk
// depends on, and the same line is what parks the buyer story (US-9128).
//
// The second property is that "not enough data" stays "not enough data".
// sold-comps.ts returns null below its minimum sample precisely so a price
// cannot be quoted off two sales; this layer must not invent a fallback.

import { assert, assertEquals, assertExists } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { compBasisForItem, compsForItem, CompsUnavailableError } = await import(
  "../lib/api-comps.ts"
);

const TENANT = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface RecordedCall {
  table: string;
  filters: Array<{ column: string; value: unknown }>;
}

function recordingDb(row: Record<string, unknown> | null) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    db: {
      from(table: string) {
        const record: RecordedCall = { table, filters: [] };
        calls.push(record);
        const api: Record<string, unknown> = {
          select: () => api,
          eq(column: string, value: unknown) {
            record.filters.push({ column, value });
            return api;
          },
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        };
        return api;
      },
    },
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    title: "Carhartt Detroit Jacket",
    brand: "Carhartt",
    size: "L",
    ebay_category_id: "57988",
    ...overrides,
  };
}

/** A stand-in for getRealizedComps that records what it was asked. */
function stubComps(
  result: {
    source: "ebay_sold" | "private_sales";
    count: number;
    currency: string;
    lowCents: number | null;
    medianCents: number | null;
    highCents: number | null;
    confidence: number;
  } | null,
) {
  const seen: Array<Record<string, unknown>> = [];
  const fn = (args: Record<string, unknown>) => {
    seen.push(args);
    return Promise.resolve(result);
  };
  return { seen, fn: fn as unknown as typeof import("../lib/sold-comps.ts").getRealizedComps };
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

Deno.test("compBasisForItem reads the item scoped to the tenant", async () => {
  const { db, calls } = recordingDb(itemRow());
  await compBasisForItem(TENANT, ITEM_ID, db);
  assertEquals(calls[0].table, "inventory_items");
  assertEquals(calls[0].filters.find((f) => f.column === "user_id")?.value, TENANT);
  assertEquals(calls[0].filters.find((f) => f.column === "id")?.value, ITEM_ID);
});

Deno.test("another tenant's item reads as absent, so comps cannot be pulled for it", async () => {
  const { db } = recordingDb(null);
  assertEquals(await compBasisForItem(TENANT, ITEM_ID, db), null);
});

Deno.test("the comp lookup is scoped to the tenant for the private-sales fallback too", async () => {
  const { db } = recordingDb(itemRow());
  const comps = stubComps(null);
  await compsForItem(TENANT, ITEM_ID, db, comps.fn);
  // ownerId is what scopes the seller's own sales as a comp set (US-268).
  assertEquals(comps.seen[0].ownerId, TENANT);
});

// ---------------------------------------------------------------------------
// The redistribution boundary
// ---------------------------------------------------------------------------

Deno.test("only aggregate fields leave compsForItem", async () => {
  const { db } = recordingDb(itemRow());
  const comps = stubComps({
    source: "ebay_sold",
    count: 14,
    currency: "USD",
    lowCents: 4500,
    medianCents: 6200,
    highCents: 8100,
    confidence: 0.9,
  });
  const result = await compsForItem(TENANT, ITEM_ID, db, comps.fn);
  assertExists(result?.comps);

  // Pinned exactly. A new field added here is a deliberate decision about what
  // GradeThread republishes, not something that arrives by accident.
  assertEquals(Object.keys(result.comps).sort(), [
    "caveat",
    "confidence",
    "currency",
    "high_cents",
    "low_cents",
    "median_cents",
    "sample_size",
    "source",
  ]);

  // And nothing listing-shaped anywhere in the payload.
  const serialized = JSON.stringify(result);
  for (const forbidden of ["itemId", "listingId", "seller", "url", "http", "title\":\"eBay"]) {
    assert(
      !serialized.includes(forbidden),
      `comp payload leaked a listing-level field: ${forbidden}`,
    );
  }
});

Deno.test("the sample size travels with the band, in the text a model reads", async () => {
  const { db } = recordingDb(itemRow());
  const comps = stubComps({
    source: "ebay_sold",
    count: 4,
    currency: "USD",
    lowCents: 4000,
    medianCents: 5000,
    highCents: 6000,
    confidence: 0.57,
  });
  const result = await compsForItem(TENANT, ITEM_ID, db, comps.fn);
  assertEquals(result?.comps?.sample_size, 4);
  // A median off four sales is not a price, and the caveat has to say so.
  assert(result?.comps?.caveat.includes("4"));
  assert(result?.comps?.caveat.toLowerCase().includes("small sample"));
});

Deno.test("a healthy sample gets a plain caveat rather than a warning", async () => {
  const { db } = recordingDb(itemRow());
  const comps = stubComps({
    source: "ebay_sold",
    count: 22,
    currency: "USD",
    lowCents: 4000,
    medianCents: 5000,
    highCents: 6000,
    confidence: 0.95,
  });
  const result = await compsForItem(TENANT, ITEM_ID, db, comps.fn);
  assert(!result?.comps?.caveat.toLowerCase().includes("small sample"));
  assert(result?.comps?.caveat.includes("22"));
});

Deno.test("the private-sales source is described as the seller's own sales, not as market data", async () => {
  const { db } = recordingDb(itemRow());
  const comps = stubComps({
    source: "private_sales",
    count: 8,
    currency: "USD",
    lowCents: 3000,
    medianCents: 3500,
    highCents: 4000,
    confidence: 0.79,
  });
  const result = await compsForItem(TENANT, ITEM_ID, db, comps.fn);
  assert(result?.comps?.caveat.includes("own sales"));
});

// ---------------------------------------------------------------------------
// Not enough data stays not enough data
// ---------------------------------------------------------------------------

Deno.test("no realized data returns null comps rather than an invented band", async () => {
  const { db } = recordingDb(itemRow());
  const comps = stubComps(null);
  const result = await compsForItem(TENANT, ITEM_ID, db, comps.fn);
  assertExists(result);
  assertEquals(result.comps, null);
  // The item is still identified, so the caller can say WHICH item has no data.
  assertEquals(result.basis.title, "Carhartt Detroit Jacket");
});

Deno.test("an item with no eBay category fails with an actionable message, not a silent empty", async () => {
  const { db } = recordingDb(itemRow({ ebay_category_id: null }));
  let thrown: unknown;
  try {
    await compBasisForItem(TENANT, ITEM_ID, db);
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof CompsUnavailableError, `expected CompsUnavailableError, got ${thrown}`);
  // The message tells the seller what to do rather than what went wrong.
  assert((thrown as Error).message.includes("Catalog or draft the item first"));
});
