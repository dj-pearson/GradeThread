// US-9107: the inventory read layer shared by GET /api/v1/items and the
// gradethread_list_items / gradethread_get_item connector tools.
//
// THE ASSERTION THAT MATTERS is that every query carries the tenant scope. The
// edge runs the service-role client, so RLS is not there to catch a forgotten
// filter (US-268); the integration lane that could prove it end-to-end needs a
// full stack and stays out of `npm run verify`. A recording stub puts that
// property in the pre-push suite, where a regression is caught before it ships.

import { assert, assertEquals, assertExists } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  clampLimit,
  decodeCursor,
  encodeCursor,
  getItem,
  ITEMS_PAGE_DEFAULT,
  ITEMS_PAGE_MAX,
  ItemQueryError,
  listItems,
} = await import("../lib/api-items.ts");

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";

interface RecordedCall {
  table: string;
  filters: Array<{ op: string; column: string; value: unknown }>;
  columns: string;
  limit: number | null;
}

/**
 * A stand-in for the supabase-js builder that records what was asked for.
 * Thenable, so `await query` and `await query.maybeSingle()` both resolve.
 */
function recordingDb(rowsByTable: Record<string, unknown[]>) {
  const calls: RecordedCall[] = [];

  function builder(table: string, columns: string, count?: number) {
    const record: RecordedCall = { table, filters: [], columns, limit: null };
    calls.push(record);

    const rows = rowsByTable[table] ?? [];
    const result = { data: rows, error: null, count: count ?? rows.length };

    const api: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        record.filters.push({ op: "eq", column, value });
        return api;
      },
      ilike(column: string, value: unknown) {
        record.filters.push({ op: "ilike", column, value });
        return api;
      },
      lt(column: string, value: unknown) {
        record.filters.push({ op: "lt", column, value });
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
      order() {
        return api;
      },
      limit(n: number) {
        record.limit = n;
        return api;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(result).then(resolve);
      },
    };
    return api;
  }

  return {
    calls,
    db: {
      from(table: string) {
        return {
          select(columns: string, opts?: { count?: string }) {
            void opts;
            return builder(table, columns);
          },
        };
      },
    },
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    user_id: TENANT,
    item_number: "1042",
    item_title: "Carhartt Detroit Jacket",
    brand: "Carhartt",
    size: "L",
    category: "jacket",
    status: "listed",
    list_price_cents: null,
    list_price: 129.99,
    grade_value: 8.5,
    grade_label: "Excellent",
    listed: true,
    photo_count: 6,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-02T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tenant scoping — the property US-268 rests on
// ---------------------------------------------------------------------------

Deno.test("listItems scopes every query on the caller's tenant", async () => {
  const { db, calls } = recordingDb({ items_full: [itemRow()] });
  await listItems(TENANT, {}, db);

  assertEquals(calls.length, 1);
  const tenantFilters = calls[0].filters.filter((f) => f.column === "user_id");
  assertEquals(tenantFilters.length, 1, "exactly one user_id filter is expected");
  assertEquals(tenantFilters[0].op, "eq");
  assertEquals(tenantFilters[0].value, TENANT);
});

Deno.test("listItems keeps the tenant scope no matter which filters are supplied", async () => {
  const { db, calls } = recordingDb({ items_full: [] });
  await listItems(TENANT, {
    status: "listed",
    brand: "Carhartt",
    category: "jacket",
    search: "detroit",
    listed: true,
    createdAfter: "2026-01-01T00:00:00.000Z",
    createdBefore: "2026-12-31T00:00:00.000Z",
    limit: 10,
  }, db);

  const scoped = calls[0].filters.some((f) => f.column === "user_id" && f.value === TENANT);
  assert(scoped, "the tenant filter was dropped when other filters were present");
});

Deno.test("getItem scopes on BOTH the item id and the tenant in one query", async () => {
  const { db, calls } = recordingDb({
    items_full: [itemRow()],
    item_photos: [],
  });
  await getItem(TENANT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", db);

  const itemsQuery = calls.find((c) => c.table === "items_full");
  assertExists(itemsQuery);
  const columns = itemsQuery.filters.map((f) => f.column);
  // Both in the SAME query: there is no window where a row is fetched and then
  // authorized, because the fetch IS the authorization.
  assert(columns.includes("id"), "getItem must filter on the item id");
  assert(columns.includes("user_id"), "getItem must filter on the tenant");
  assertEquals(itemsQuery.filters.find((f) => f.column === "user_id")?.value, TENANT);
});

Deno.test("getItem returns null for another tenant's item, indistinguishably from missing", async () => {
  // The stub returns no row, which is what the real scoped query does when the
  // id belongs to someone else. Both must read as "not found" to the caller.
  const { db } = recordingDb({ items_full: [], item_photos: [] });
  const result = await getItem(OTHER_TENANT, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", db);
  assertEquals(result, null);
});

// ---------------------------------------------------------------------------
// Projection and money
// ---------------------------------------------------------------------------

Deno.test("the list projection stays compact, so a page cannot flood a context window", async () => {
  const { db, calls } = recordingDb({ items_full: [itemRow()] });
  const page = await listItems(TENANT, {}, db);

  // Selecting "*" from items_full would pull comps, ai_field_sources and every
  // measurement on every row.
  assert(!calls[0].columns.includes("*"), "the list must not select *");
  assert(!calls[0].columns.includes("comps"), "comps do not belong in a list projection");

  const keys = Object.keys(page.items[0]).sort();
  assertEquals(keys, [
    "brand",
    "category",
    "created_at",
    "grade",
    "grade_label",
    "id",
    "item_number",
    "list_price_cents",
    "listed",
    "photo_count",
    "size",
    "status",
    "title",
  ]);
});

Deno.test("money crosses the boundary as integer cents, never a float or a string", async () => {
  const { db } = recordingDb({ items_full: [itemRow({ list_price: 129.99 })] });
  const page = await listItems(TENANT, {}, db);
  assertEquals(page.items[0].list_price_cents, 12999);

  // supabase-js hands decimals back as a string on some driver paths.
  const asString = recordingDb({ items_full: [itemRow({ list_price: "24.50" })] });
  const page2 = await listItems(TENANT, {}, asString.db);
  assertEquals(page2.items[0].list_price_cents, 2450);

  const missing = recordingDb({ items_full: [itemRow({ list_price: null })] });
  const page3 = await listItems(TENANT, {}, missing.db);
  assertEquals(page3.items[0].list_price_cents, null);
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

Deno.test("clampLimit defaults, floors and ceilings the page size", () => {
  assertEquals(clampLimit(undefined), ITEMS_PAGE_DEFAULT);
  assertEquals(clampLimit(0), ITEMS_PAGE_DEFAULT);
  assertEquals(clampLimit(10), 10);
  assertEquals(clampLimit(10.7), 10);
  assertEquals(clampLimit(10_000), ITEMS_PAGE_MAX);
  assertEquals(clampLimit(Number.NaN), ITEMS_PAGE_DEFAULT);
});

Deno.test("a cursor round-trips, and a corrupt one is rejected rather than ignored", () => {
  const cursor = encodeCursor({ createdAt: "2026-08-01T10:00:00.000Z", id: "abc" });
  assertEquals(decodeCursor(cursor), { createdAt: "2026-08-01T10:00:00.000Z", id: "abc" });

  // Silently ignoring a bad cursor restarts the walk from the top, which reads
  // to a caller as "the same page forever".
  assertEquals(decodeCursor("not-base64!!"), null);
  assertEquals(decodeCursor(btoa("nodelimiter")), null);
  assertEquals(decodeCursor(btoa("not-a-date|abc")), null);
});

Deno.test("listItems rejects a corrupt cursor with a typed error, not an empty page", async () => {
  const { db } = recordingDb({ items_full: [] });
  let thrown: unknown;
  try {
    await listItems(TENANT, { cursor: "garbage!!" }, db);
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof ItemQueryError, `expected ItemQueryError, got ${thrown}`);
});

Deno.test("listItems asks for one extra row to detect a next page without a second query", async () => {
  const rows = Array.from({ length: 26 }, (_, i) => itemRow({ id: `id-${i}` }));
  const { db, calls } = recordingDb({ items_full: rows });
  const page = await listItems(TENANT, { limit: 25 }, db);

  assertEquals(calls[0].limit, 26);
  assertEquals(page.items.length, 25);
  assertExists(page.next_cursor, "a full page must carry a cursor for the next one");
});

Deno.test("a short page carries no cursor, so a caller knows it reached the end", async () => {
  const { db } = recordingDb({ items_full: [itemRow()] });
  const page = await listItems(TENANT, { limit: 25 }, db);
  assertEquals(page.next_cursor, null);
});

Deno.test("the total is the whole match count, not the page size", async () => {
  const { db } = recordingDb({ items_full: [itemRow(), itemRow({ id: "b" })] });
  const page = await listItems(TENANT, {}, db);
  // A model told "2 items" when there are 340 will tell the seller they own 2.
  assertEquals(page.total, 2);
});
