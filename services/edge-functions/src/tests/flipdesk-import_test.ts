// IMP-03..06: the CSV import worker, its undo and its reclaim, driven end to end
// through the real supabase-js client against the in-memory PostgREST.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import { resetSupabaseAdminForTests } from "../lib/supabase.ts";

Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET", "test-job-secret");

const db = installFakePostgrest();

const {
  flipdeskImportRoutes,
  processImportRun,
  handleImportReclaimCron,
  friendlyRowError,
} = await import("../routes/flipdesk-import.ts");

const OWNER = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

function runRow(payload: unknown[], extra: Row = {}): Row {
  return {
    id: RUN,
    user_id: OWNER,
    origin: "csv",
    status: "pending",
    attempts: 0,
    total_rows: payload.length,
    processed_rows: 0,
    inserted_count: 0,
    updated_count: 0,
    skipped_count: 0,
    failed_count: 0,
    errors: [],
    undone_at: null,
    payload,
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

function theRun(): Row {
  return db.tables.flipdesk_import_runs!.find((r) => r.id === RUN)!;
}

function app() {
  const a = new Hono<{ Variables: { userId: string; workspaceOwnerId?: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", OWNER);
    await next();
  });
  a.route("/", flipdeskImportRoutes);
  return a;
}

// ── IMP-03: no orphan items ─────────────────────────────────────────────────

Deno.test("a failed effect insert leaves no inventory item and reports the row", async () => {
  db.reset({ flipdesk_import_runs: [runRow([{ row: 2, title: "Tee" }])] });
  db.failNext("flipdesk_import_effects", "POST");
  await processImportRun(RUN);
  assertEquals((db.tables.inventory_items ?? []).length, 0);
  const run = theRun();
  assertEquals(run.status, "completed");
  assertEquals(run.inserted_count, 0);
  assertEquals((run.errors as Array<{ row: number }>).map((e) => e.row), [2]);
});

Deno.test("a failed sale insert leaves no orphan item or listing", async () => {
  db.reset({
    flipdesk_import_runs: [runRow([{
      row: 2,
      title: "Tee",
      listing: { listing_price: 20 },
      sale: { sale_price: 20 },
    }])],
  });
  db.failNext("sales", "POST");
  await processImportRun(RUN);
  assertEquals((db.tables.inventory_items ?? []).length, 0);
  assertEquals((db.tables.listings ?? []).length, 0);
  assertEquals(theRun().failed_count, 1);
});

Deno.test("inserted_count matches the inserted effect rows", async () => {
  db.reset({
    flipdesk_import_runs: [runRow([
      { row: 2, title: "A" },
      { row: 3, title: "B" },
      { row: 4, title: "C" },
    ])],
  });
  db.failNext("flipdesk_import_effects", "POST");
  await processImportRun(RUN);
  const effects = (db.tables.flipdesk_import_effects ?? []).filter((e) => e.action === "inserted");
  assertEquals(theRun().inserted_count, effects.length);
  assertEquals(effects.length, 2);
  assertEquals((db.tables.inventory_items ?? []).length, 2);
});

Deno.test("a raw Postgres error is shown to the seller as plain words", () => {
  assertEquals(friendlyRowError({ message: 'date/time field value out of range: "2026-13-45"', code: "22008" }), "The date isn't a real date.");
  assert(!friendlyRowError({ message: "x", code: "23514" }).includes("constraint"));
});

// ── IMP-04: resume, same-SKU fills, fencing ────────────────────────────────

Deno.test("a resumed run keeps the counts from its earlier attempt", async () => {
  const payload = Array.from({ length: 900 }, (_, i) => ({ row: i + 2, title: `T${i}` }));
  const effects = payload.map((p) => ({
    id: crypto.randomUUID(),
    run_id: RUN,
    user_id: OWNER,
    row_number: p.row,
    action: "inserted",
    inventory_item_id: crypto.randomUUID(),
  }));
  db.reset({
    flipdesk_import_runs: [runRow(payload, { attempts: 1 })],
    flipdesk_import_effects: effects,
  });
  await processImportRun(RUN);
  const run = theRun();
  assertEquals(run.status, "completed");
  assertEquals(run.inserted_count, 900);
  assertEquals((db.tables.inventory_items ?? []).length, 0);
});

Deno.test("two rows with the same existing SKU leave the first fill in place", async () => {
  db.reset({
    flipdesk_import_runs: [runRow([
      { row: 2, title: "Tee", sku: "X", brand: "Levi" },
      { row: 3, title: "Tee", sku: "X", brand: "Wrangler" },
    ])],
    inventory_items: [{ id: ITEM, user_id: OWNER, sku: "X", title: "Tee", brand: null }],
  });
  await processImportRun(RUN);
  const item = db.tables.inventory_items!.find((r) => r.id === ITEM)!;
  assertEquals(item.brand, "Levi");
  const run = theRun();
  assertEquals(run.updated_count, 1);
  assertEquals(run.skipped_count, 1);
});

Deno.test("a worker whose attempts number was bumped stops writing", async () => {
  db.reset({
    flipdesk_import_runs: [runRow(
      Array.from({ length: 25 }, (_, i) => ({ row: i + 2, title: `T${i}` })),
    )],
  });
  // Simulate the reclaim handing the run to another worker mid-flight.
  const inner = globalThis.fetch;
  let bumped = false;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!bumped && url.includes("/inventory_items") && (init?.method ?? "GET") === "POST") {
      bumped = true;
      theRun().attempts = 7;
    }
    return inner(input as Request, init);
  }) as typeof fetch;
  // supabase-js captures fetch when the client is built, so rebuild it.
  resetSupabaseAdminForTests();
  try {
    await processImportRun(RUN);
  } finally {
    globalThis.fetch = inner;
    resetSupabaseAdminForTests();
  }
  const run = theRun();
  assertEquals(run.status, "running", "the old worker must not mark the run finished");
  // It stopped at the first heartbeat (row 10) instead of running all 25.
  assert((db.tables.inventory_items ?? []).length <= 10);
});

// ── IMP-05: undo ─────────────────────────────────────────────────────────────

async function importThenComplete(payload: Row[], seed: Record<string, Row[]> = {}) {
  db.reset({ flipdesk_import_runs: [runRow(payload)], ...seed });
  await processImportRun(RUN);
  assertEquals(theRun().status, "completed");
}

Deno.test("two concurrent undos: one runs, one gets 409", async () => {
  await importThenComplete([{ row: 2, title: "Tee" }]);
  const a = app();
  const [r1, r2] = await Promise.all([
    a.request(`/runs/${RUN}/undo`, { method: "POST" }),
    a.request(`/runs/${RUN}/undo`, { method: "POST" }),
  ]);
  assertEquals([r1.status, r2.status].sort(), [200, 409]);
  assertEquals((db.tables.inventory_items ?? []).length, 0);
});

Deno.test("a column the seller edited after the import survives undo", async () => {
  await importThenComplete(
    [{ row: 2, title: "Tee", sku: "X", brand: "Levi", size: "M" }],
    { inventory_items: [{ id: ITEM, user_id: OWNER, sku: "X", title: "Tee", brand: null, size: null }] },
  );
  const item = db.tables.inventory_items!.find((r) => r.id === ITEM)!;
  assertEquals(item.brand, "Levi");
  item.brand = "Levi's Vintage"; // the seller's own edit
  const res = await app().request(`/runs/${RUN}/undo`, { method: "POST" });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(item.brand, "Levi's Vintage");
  assertEquals(item.size, null, "the untouched import column is still restored");
  assertEquals(body.kept_edited, 1);
});

Deno.test("an item with a sale recorded after the import is kept", async () => {
  await importThenComplete([{ row: 2, title: "Tee" }]);
  const itemId = db.tables.inventory_items![0]!.id as string;
  db.tables.sales = [{ id: crypto.randomUUID(), inventory_item_id: itemId, sale_price: 30 }];
  const res = await app().request(`/runs/${RUN}/undo`, { method: "POST" });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.kept_modified, 1);
  assertEquals(db.tables.inventory_items!.length, 1);
  assertEquals(db.tables.sales!.length, 1);
});

Deno.test("a failed delete leaves the undo retryable", async () => {
  await importThenComplete([{ row: 2, title: "Tee" }]);
  db.failNext("inventory_items", "DELETE");
  const first = await app().request(`/runs/${RUN}/undo`, { method: "POST" });
  assertEquals(first.status, 500);
  assertEquals((await first.json()).failed_items, 1);
  assertEquals(theRun().undone_at, null);
  assertEquals(db.tables.inventory_items!.length, 1);

  const retry = await app().request(`/runs/${RUN}/undo`, { method: "POST" });
  assertEquals(retry.status, 200);
  assertEquals((await retry.json()).deleted_items, 1);
  assertEquals(theRun().status, "undone");
  assertEquals(db.tables.inventory_items!.length, 0);
});

// ── IMP-06: the reclaim picks up a run that never started ──────────────────

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function reclaimApp() {
  const a = new Hono();
  a.post("/reclaim", (c) => handleImportReclaimCron(c));
  return a;
}

Deno.test("reclaim claims a pending run that has sat for 2 minutes", async () => {
  db.reset({
    flipdesk_import_runs: [runRow([{ row: 2, title: "Tee" }], {
      updated_at: new Date(Date.now() - 120_000).toISOString(),
    })],
  });
  const res = await reclaimApp().request("/reclaim", {
    method: "POST",
    headers: { "X-Internal-Job-Secret": "test-job-secret" },
  });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).resumed, 1);
  await waitFor(() => theRun().status === "completed");
  assertEquals(theRun().inserted_count, 1);
});

Deno.test("reclaim leaves a pending run from 10 seconds ago alone", async () => {
  db.reset({
    flipdesk_import_runs: [runRow([{ row: 2, title: "Tee" }], {
      updated_at: new Date(Date.now() - 10_000).toISOString(),
    })],
  });
  const res = await reclaimApp().request("/reclaim", {
    method: "POST",
    headers: { "X-Internal-Job-Secret": "test-job-secret" },
  });
  assertEquals((await res.json()).resumed, 0);
  assertEquals(theRun().status, "pending");
});

// ── IMP-03/04 in the closet worker ──────────────────────────────────────────

const { processClosetImportRun } = await import("../lib/closet-import-run.ts");

function closetRow(n: number): Row {
  return {
    row: n,
    platform: "poshmark",
    platform_listing_id: `pm${n}`,
    listing_url: `https://poshmark.com/listing/pm${n}`,
    title: `Closet ${n}`,
    description: null,
    price: 20,
    size: null,
    brand: null,
    condition: null,
    photo_urls: [],
    detail: false,
  };
}

Deno.test("closet: a failed effect insert rolls back the listing and the item", async () => {
  db.reset({ flipdesk_import_runs: [runRow([closetRow(1)], { origin: "poshmark" })] });
  db.failNext("flipdesk_import_effects", "POST");
  await processClosetImportRun(RUN);
  assertEquals((db.tables.inventory_items ?? []).length, 0);
  assertEquals((db.tables.listings ?? []).length, 0);
  const run = theRun();
  assertEquals(run.inserted_count, 0);
  assertEquals(run.failed_count, 1);
});

Deno.test("closet: a resumed run keeps the counts from its earlier attempt", async () => {
  db.reset({
    flipdesk_import_runs: [runRow([closetRow(1), closetRow(2)], { origin: "poshmark", attempts: 1 })],
    flipdesk_import_effects: [{
      id: crypto.randomUUID(),
      run_id: RUN,
      user_id: OWNER,
      row_number: 1,
      action: "inserted",
      inventory_item_id: crypto.randomUUID(),
    }],
  });
  await processClosetImportRun(RUN);
  const run = theRun();
  assertEquals(run.status, "completed");
  assertEquals(run.inserted_count, 2);
  assertEquals((db.tables.inventory_items ?? []).length, 1);
});
