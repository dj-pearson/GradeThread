// US-1869 / US-268: tenant-scoping guard for the Inventory Equity route.
//
// The route is a plain GET with NO id/path input — it reads ONLY the caller's
// own tenant (workspaceOwnerId), so the classic "foreign id → 404" case doesn't
// apply. Instead this statically proves the posture that matters here: every
// read of a multi-tenant table is scoped by user_id, and the tenant is resolved
// from workspaceOwnerId (never from the request body). Deterministic + runnable
// without a live stack.
//
// A3 adds behavioural cases below, driven through a stub client handed to
// computeEquityForOwner / equityResponse: a failed read must surface as a 500
// rather than a $0 total, the GET body carries no per-item rows, and the
// listings read is chunked to the current items.
import "./_env.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  computeEquityForOwner,
  equityResponse,
  IN_CHUNK,
} from "../routes/flipdesk-equity.ts";

const src = Deno.readTextFileSync(
  new URL("../routes/flipdesk-equity.ts", import.meta.url),
);

const MULTI_TENANT_TABLES = [
  "inventory_items",
  "sales",
  "listings",
  "inventory_equity_snapshots",
];

Deno.test("every multi-tenant read is user_id-scoped", () => {
  for (const table of MULTI_TENANT_TABLES) {
    const re = new RegExp(
      `\\.from\\("${table}"\\)[\\s\\S]{0,600}?\\.eq\\("user_id",\\s*owner\\)`,
    );
    // Each .from("<table>") occurrence must be followed (within its query
    // chain) by .eq("user_id", owner).
    const occurrences = src.split(`.from("${table}")`).length - 1;
    assert(occurrences > 0, `expected the route to read ${table}`);
    // Every occurrence pairs with a user_id scope.
    const scoped = src.match(new RegExp(re, "g"))?.length ?? 0;
    assert(
      scoped >= occurrences,
      `${table}: ${occurrences} read(s) but only ${scoped} scoped by user_id — a multi-tenant read may leak across tenants`,
    );
  }
});

Deno.test("tenant is resolved from workspaceOwnerId, not the request body", () => {
  assert(
    src.includes('c.get("workspaceOwnerId") ?? c.get("userId")'),
    "owner must come from workspaceOwnerId/userId context",
  );
  // No id is read off the request body/query and fed into a tenant query.
  assert(
    !/c\.req\.(param|query)\(/.test(src),
    "the equity route must not take an id/param from the request",
  );
});

// ─── A3: behaviour through a stub client ────────────────────────────────────

type Result = { data: unknown; error: { message: string } | null };
interface Call {
  table: string;
  eq: Array<[string, unknown]>;
  inIds: string[] | null;
}

// A chainable, thenable stand-in for the PostgREST builder. Each table answers
// with whatever `answer(table, call)` returns.
function stubDb(answer: (table: string, call: Call) => Result) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, eq: [], inIds: null };
      calls.push(call);
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.order = self;
      b.limit = self;
      b.not = self;
      b.eq = (col: string, v: unknown) => {
        call.eq.push([col, v]);
        return b;
      };
      b.in = (_col: string, ids: string[]) => {
        call.inIds = ids;
        return b;
      };
      b.then = (res: (r: Result) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(answer(table, call)).then(res, rej);
      return b;
    },
  };
  // deno-lint-ignore no-explicit-any
  return { db: db as any, calls };
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const item = (id: string) => ({
  id,
  title: "Jacket",
  brand: "Carhartt",
  item_category: "outerwear",
  garment_category: null,
  grade_value: 8.5,
  comp_set: [{ price: 40 }, { price: 50 }, { price: 60 }],
  created_at: "2026-01-01T00:00:00Z",
});

Deno.test("A3: a failed inventory read is a 500, not a $0 total", async () => {
  const { db } = stubDb((table) =>
    table === "inventory_items"
      ? { data: null, error: { message: "canceling statement due to statement timeout" } }
      : { data: [], error: null }
  );
  await assertRejects(() => computeEquityForOwner(OWNER, db));
  const res = await equityResponse(OWNER, db);
  assertEquals(res.status, 500);
  assert(!("aggregate" in res.body), "a failed read must not carry a total");
});

Deno.test("A3: a failed listings or sales read also fails the whole answer", async () => {
  for (const broken of ["listings", "sales"]) {
    const { db } = stubDb((table) =>
      table === broken
        ? { data: null, error: { message: "boom" } }
        : table === "sales"
        ? { data: [{ inventory_item_id: "i1", sale_date: "2026-02-01", sold_at: null }], error: null }
        : table === "inventory_items"
        ? { data: [item("i1")], error: null }
        : { data: [], error: null }
    );
    assertEquals((await equityResponse(OWNER, db)).status, 500, broken);
  }
});

Deno.test("A3: the GET body has no per-item rows", async () => {
  const { db } = stubDb((table) =>
    table === "inventory_items"
      ? { data: [item("i1")], error: null }
      : { data: [], error: null }
  );
  const res = await equityResponse(OWNER, db);
  assertEquals(res.status, 200);
  assert(!("items" in res.body), "items must not be sent to the client");
  assert("aggregate" in res.body);
});

Deno.test("A3: listings are read for current items only, in owner-scoped chunks", async () => {
  const ids = Array.from({ length: IN_CHUNK * 2 + 51 }, (_, i) => `item-${i}`);
  const { db, calls } = stubDb((table) =>
    table === "inventory_items"
      ? { data: ids.map(item), error: null }
      : { data: [], error: null }
  );
  await computeEquityForOwner(OWNER, db);
  const listingReads = calls.filter((c) => c.table === "listings");
  assertEquals(listingReads.length, 3);
  for (const c of listingReads) {
    assert(c.inIds && c.inIds.length <= IN_CHUNK, "each .in() is bounded");
    assert(
      c.eq.some(([col, v]) => col === "user_id" && v === OWNER),
      "the owner scope stays on every chunk",
    );
  }
  assertEquals(listingReads.flatMap((c) => c.inIds ?? []).sort(), [...ids].sort());
});

Deno.test("A3: the nightly snapshot writes nothing when the compute throws", () => {
  const job = Deno.readTextFileSync(
    new URL("../routes/jobs-equity-snapshot.ts", import.meta.url),
  );
  // The upsert sits AFTER the compute inside one try, so a thrown compute skips
  // it. A catch that fell through to a zero upsert would put a $0 point back.
  const compute = job.indexOf("await computeEquityForOwner(owner)");
  const upsert = job.indexOf(".upsert(", compute);
  const catchAt = job.indexOf("} catch (err)", compute);
  assert(compute > 0 && upsert > compute && catchAt > upsert);
  assert(!/catch \(err\)[\s\S]{0,300}\.upsert\(/.test(job));
});
