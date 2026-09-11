// US-3363: an extension-confirmed sale must actually leave its listing SOLD.
//
// This drives POST /api/flipdesk/sync/observations end to end -- the seller
// gate, the planner, the dedupe ledger, the listing flip, the sales row -- and
// then reads the listing back. It asserts the ROW, not that an update was
// called, because the bug was that the call happened:
//
//     .update({ listing_status: "sold", sold_at: sale.soldAt })
//
// `public.listings` has no `sold_at`. Measured against the local stack on
// 2026-09-11, PostgREST answers
//     HTTP 400 {"code":"PGRST204","message":"Could not find the 'sold_at'
//     column of 'listings' in the schema cache"}
// and refuses the WHOLE patch, so `listing_status` was not written either. The
// result was never read, so the route returned `status: "ok"` while the sale
// row existed and the listing still showed live. Any test asserting "the
// update was called" would have passed against that, every time.
//
// So the stub below is not a yes-man. Its PATCH handler validates the payload
// against the REAL `listings` column list, parsed from the migrations, and
// answers the same PGRST204 the live stack does. `the stub refuses a column
// listings does not have` proves that, and `the stub really applies a patch`
// proves the green result is not vacuous -- between them, reinstating `sold_at`
// turns this file red rather than leaving it silent.
//
//   deno test --allow-env --allow-read src/tests/sync-sold-listing_test.ts
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { columnsOf } from "./_migration-columns.ts";

const SUPABASE_URL = "http://supabase.test";
Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const OWNER = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const LISTING = "33333333-3333-4333-8333-333333333333";
const LISTING_URL = "https://poshmark.com/listing/us3363-fixture";

type Row = Record<string, unknown>;

let tables: Record<string, Row[]>;
let seenUrls: string[];
let rejected: Array<{ table: string; column: string }>;

function reset() {
  seenUrls = [];
  rejected = [];
  tables = {
    users: [{
      id: OWNER,
      flipdesk_plan: "pro",
      subscription_status: "active",
      trial_ends_at: null,
      past_due_since: null,
      notification_preferences: null,
      notification_quiet_hours: null,
    }],
    inventory_items: [{ id: ITEM, user_id: OWNER, title: "US-3363 fixture tee" }],
    listings: [{
      id: LISTING,
      inventory_item_id: ITEM,
      user_id: OWNER,
      platform: "poshmark",
      listing_url: LISTING_URL,
      listing_title: "US-3363 fixture tee",
      listing_price: 42,
      listing_status: "active",
      // Null on purpose: autoEndCrossListings short-circuits on a listing that
      // is not part of a cross-listing group, which keeps this test about the
      // sold flip.
      draft_id: null,
    }],
    marketplace_sync_observations: [],
    marketplace_sync_state: [],
    marketplace_sync_reviews: [],
    sales: [],
    notifications: [],
    flipdesk_settings: [],
  };
}

/** `id=eq.X` / `id=neq.X` / `id=in.(a,b)` -- the operators this route uses. */
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(key)) continue;
    // An embedded filter (`inventory_items.user_id=eq....`) constrains the JOIN,
    // not this row. Tenancy is asserted from the recorded URL instead.
    if (key.includes(".")) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    const actual = row[key];
    if (op === "eq" && String(actual) !== value) return false;
    if (op === "neq" && String(actual) === value) return false;
    if (op === "in") {
      const list = value.replace(/^\(|\)$/g, "").split(",").map((v) =>
        v.replace(/^"|"$/g, "")
      );
      if (!list.includes(String(actual))) return false;
    }
  }
  return true;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The column check that makes this stub worth having.
 *
 * PostgREST resolves the payload's keys against its schema cache BEFORE it
 * touches a row, and one unknown key refuses the whole statement -- which is
 * why the `listing_status` half of the US-3363 patch never landed either.
 */
function unknownColumn(table: string, payload: Row): string | null {
  const known = columnsOf(table);
  if (known.size === 0) return null; // a view, or a table the parser cannot read
  for (const key of Object.keys(payload)) {
    if (!known.has(key.toLowerCase())) return key;
  }
  return null;
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.toString()
    : input.url;
  if (!url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
    return Promise.resolve(json({ error: "unexpected host" }, 500));
  }
  seenUrls.push(url);

  const parsed = new URL(url);
  const table = parsed.pathname.replace("/rest/v1/", "");
  const params = parsed.searchParams;
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const wantsObject = (headers.get("Accept") ?? "").includes("pgrst.object");
  const method = (init?.method ?? "GET").toUpperCase();
  const rows = tables[table] ?? [];

  if (method === "GET") {
    const hits = rows.filter((r) => matches(r, params));
    if (wantsObject) {
      if (hits.length === 0) {
        return Promise.resolve(
          json({ code: "PGRST116", message: "0 rows", details: null, hint: null }, 406),
        );
      }
      return Promise.resolve(json(hits[0], 200));
    }
    return Promise.resolve(json(hits, 200));
  }

  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  const payloads: Row[] = Array.isArray(body) ? body : body ? [body] : [];
  for (const p of payloads) {
    const bad = unknownColumn(table, p);
    if (bad) {
      rejected.push({ table, column: bad });
      return Promise.resolve(
        json({
          code: "PGRST204",
          details: null,
          hint: null,
          message: `Could not find the '${bad}' column of '${table}' in the schema cache`,
        }, 400),
      );
    }
  }

  if (method === "PATCH") {
    for (const row of rows) {
      if (matches(row, params)) Object.assign(row, payloads[0] ?? {});
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }

  if (method === "POST") {
    for (const p of payloads) rows.push({ ...p });
    tables[table] = rows;
    return Promise.resolve(new Response(null, { status: 201 }));
  }

  return Promise.resolve(new Response(null, { status: 204 }));
}) as typeof fetch;

// The route module builds its supabase client from the env and closes over the
// fetch reference, so both had to be in place above this line.
const { flipdeskSyncRoutes } = await import("../routes/flipdesk-sync.ts");

const app = new Hono<{ Variables: { userId: string; workspaceOwnerId: string } }>();
app.use("*", async (c, next) => {
  c.set("userId", OWNER);
  c.set("workspaceOwnerId", OWNER);
  await next();
});
app.route("/", flipdeskSyncRoutes);

/** One Sold row whose URL is the listing's, which is a definitive match. */
function soldBatch() {
  return {
    platform: "poshmark",
    observedAt: "2026-09-11T10:00:00.000Z",
    signedIn: true,
    sold: [{
      listingUrl: LISTING_URL,
      title: "US-3363 fixture tee",
      soldPriceCents: 4200,
      soldAt: "2026-09-10T00:00:00.000Z",
      orderRef: "ORDER-3363",
      thumbAssetId: null,
    }],
    closet: { listingUrls: [], pagesRead: 1, reachedEnd: false },
  };
}

async function postObservations(batch: unknown): Promise<Response> {
  return await app.request("/observations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
}

Deno.test("US-3363: a confirmed sale leaves the listing SOLD", async () => {
  reset();
  const res = await postObservations(soldBatch());
  assertEquals(res.status, 200);
  const body = await res.json();

  assertEquals(body.status, "ok");
  assertEquals(body.confirmed, 1);
  // The row, not the call. This is the assertion the bug defeated.
  assertEquals(
    tables.listings[0]!.listing_status,
    "sold",
    `the listing is still ${tables.listings[0]!.listing_status}. Rejected ` +
      `writes: ${JSON.stringify(rejected)}`,
  );
  assertEquals(rejected, [], "PostgREST refused a write during a clean sale");

  // And the route SAYS what it did, because an unread result is how this sat
  // in production for a month.
  assertEquals(body.markedSold, 1);
  assertEquals(body.markSoldFailed, 0);
});

Deno.test("US-3363: the sale itself is booked, and it owns the sold date", async () => {
  reset();
  await postObservations(soldBatch());

  assertEquals(tables.sales.length, 1);
  const sale = tables.sales[0]!;
  assertEquals(sale.inventory_item_id, ITEM);
  assertEquals(sale.listing_id, LISTING);
  assertEquals(sale.sale_price, 42);
  assertEquals(sale.sale_date, "2026-09-10");
  // WHEN it sold lives here and only here. items_full reads sale_date,
  // sold_at_raw and days_to_sell off this row.
  assertEquals(sale.sold_at, "2026-09-10T00:00:00.000Z");

  // The listing carries the STATUS and no date at all.
  assertEquals(Object.hasOwn(tables.listings[0]!, "sold_at"), false);

  // The ledger is what stops a second poll booking it twice.
  assertEquals(tables.marketplace_sync_observations.length, 1);
  assertEquals(
    tables.marketplace_sync_observations[0]!.dedupe_key,
    "poshmark:ref:ORDER-3363",
  );
});

Deno.test("US-3363: a second poll of the same Sold page changes nothing", async () => {
  reset();
  await postObservations(soldBatch());
  // The ledger read is what suppresses it, so replay the stored key.
  const res = await postObservations(soldBatch());
  const body = await res.json();

  assertEquals(body.confirmed, 0);
  assertEquals(body.markedSold, 0);
  assertEquals(tables.sales.length, 1, "the sale was booked twice");
  assertEquals(tables.listings[0]!.listing_status, "sold");
});

Deno.test("US-3363: the listings read is scoped to the owner (US-268)", async () => {
  reset();
  await postObservations(soldBatch());
  const listingReads = seenUrls.filter((u) =>
    u.includes("/rest/v1/listings?") && u.includes("select=")
  );
  assert(listingReads.length > 0, "the route never read listings");
  assert(
    listingReads[0]!.includes(`inventory_items.user_id=eq.${OWNER}`),
    `the tenant filter is gone from ${listingReads[0]}`,
  );
});

// -- controls on the stub ----------------------------------------------------

Deno.test("US-3363: the stub refuses a column listings does not have", async () => {
  reset();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/listings?id=eq.${LISTING}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listing_status: "sold", sold_at: "2026-09-10T00:00:00.000Z" }),
  });
  assertEquals(res.status, 400);
  const err = await res.json();
  assertEquals(err.code, "PGRST204");
  assertEquals(
    err.message,
    "Could not find the 'sold_at' column of 'listings' in the schema cache",
  );
  // And the refusal took the rest of the statement with it, which is the whole
  // reason the listing never flipped.
  assertEquals(tables.listings[0]!.listing_status, "active");
});

Deno.test("US-3363: the stub really applies a patch (so green is not vacuous)", async () => {
  reset();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/listings?id=eq.${LISTING}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listing_status: "sold" }),
  });
  assertEquals(res.status, 204);
  assertEquals(tables.listings[0]!.listing_status, "sold");
});
