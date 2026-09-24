// US-3381 AC4 + AC5. The SKU lookup in the AutoLister's generate step.
//
// The read dropped its error. US-3376 left it alone on the argument that it
// still failed LOUDLY by accident: a null `existing` takes the INSERT branch,
// and the partial unique index on (user_id, sku) rejects the insert. That is
// true, and it is not the same thing as being handled -- what the seller gets
// is a raw unique-constraint string about a SKU they never asked to create, the
// throw aborts the whole attach loop, and every group after this one loses its
// photos while every group before it already has a real item.
//
// THE MOCK RESOLVES AND NEVER REJECTS. That is the property the whole class of
// bug lives on: a PostgrestFilterBuilder hands back { data: null, error } on a
// 400 or an RLS refusal, so a try/catch around it is dead code for every
// failure except a dropped socket.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let skuReadError: unknown = null;
let existingRow: Row | null = null;
let insertError: unknown = null;
let statusUpdateError: unknown = null;
let existingPhotos: Row[] = [];
const statusGuards: string[][] = [];
const calls: string[] = [];
const inserted: Row[][] = [];

function selectChain(table: string) {
  const self: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order", "limit"]) self[k] = () => self;
  self["maybeSingle"] = () => {
    calls.push(`${table}.maybeSingle`);
    // Resolves. Never rejects. This is the whole point.
    return Promise.resolve({
      data: skuReadError ? null : existingRow,
      error: skuReadError,
    });
  };
  self["single"] = () => {
    calls.push(`${table}.single`);
    return Promise.resolve({
      data: insertError ? null : { id: "new-item" },
      error: insertError,
    });
  };
  self["then"] = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({
      data: table === "item_photos" ? existingPhotos : [],
      error: null,
    }).then(onFulfilled);
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => selectChain(table),
      update: () => ({
        eq: () => ({
          in: (_col: string, allowed: string[]) => {
            calls.push(`${table}.update`);
            statusGuards.push(allowed);
            return Promise.resolve({ data: null, error: statusUpdateError });
          },
        }),
      }),
      insert: (rows: Row | Row[]) => {
        calls.push(`${table}.insert`);
        inserted.push(Array.isArray(rows) ? rows : [rows]);
        const res = Promise.resolve({ data: null, error: insertError });
        return Object.assign(res, { select: () => selectChain(table) });
      },
    }),
  },
}));

const warnings: string[] = [];
vi.mock("@/lib/toast-error", () => ({
  toastError: () => ({}),
  toastWarning: (_e: unknown, fallback?: string) => {
    warnings.push(fallback ?? "");
    return {};
  },
}));

const { persistGroupsAsItems } = await import(
  "@/pages/flipdesk/autolister/persist-groups-as-items"
);

const PHOTO = {
  id: "p1",
  url: "https://example.test/p1.jpg",
  storagePath: "u/p1.jpg",
  thumbnailUrl: null,
  thumbnailStoragePath: null,
  width: 800,
  height: 600,
  bytes: 1234,
  capturedAtMs: null,
  phash: "",
};

function run(sku?: string) {
  return persistGroupsAsItems({
    ownerId: "11111111-1111-4111-8111-111111111111",
    targets: [
      { id: "g1", name: "Blue jacket", sku, photoIds: ["p1"], coverId: "p1" },
    ],
    stagedById: new Map([["p1", PHOTO as never]]),
  });
}

beforeEach(() => {
  skuReadError = null;
  existingRow = null;
  insertError = null;
  statusUpdateError = null;
  existingPhotos = [];
  statusGuards.length = 0;
  calls.length = 0;
  inserted.length = 0;
  warnings.length = 0;
});

describe("the SKU lookup that used to drop its error", () => {
  it("rejects with the refusal instead of guessing the SKU is free", async () => {
    skuReadError = { code: "42501", message: "permission denied for table inventory_items" };
    await expect(run("SKU-1")).rejects.toMatchObject({ code: "42501" });
    // And it stopped BEFORE writing. The accidental route got here, tried the
    // insert, and only then failed -- on a different error, about a different
    // thing, after the previous groups had already been committed.
    expect(calls).toEqual(["inventory_items.maybeSingle"]);
    expect(inserted).toEqual([]);
  });

  it("binds to the existing item when the SKU is really taken", async () => {
    existingRow = { id: "existing-item" };
    const ids = await run("SKU-1");
    expect(ids).toEqual(["existing-item"]);
    expect(calls).toContain("inventory_items.update");
    // The photos attach to the item that already exists, not a second one.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]![0]!.inventory_item_id).toBe("existing-item");
  });

  it("creates a fresh item when the SKU is free", async () => {
    existingRow = null;
    const ids = await run("SKU-1");
    expect(ids).toEqual(["new-item"]);
    expect(calls).toContain("inventory_items.insert");
  });

  it("skips the lookup entirely when no SKU was given", async () => {
    const ids = await run(undefined);
    expect(ids).toEqual(["new-item"]);
    expect(calls).not.toContain("inventory_items.maybeSingle");
  });

  it("warns but carries on when only the status advance is refused (US-3376)", async () => {
    existingRow = { id: "existing-item" };
    statusUpdateError = { code: "42501", message: "permission denied" };
    const ids = await run("SKU-1");
    // The photos still attach: a stranded pipeline status is worth a warning,
    // not the loss of the upload.
    expect(ids).toEqual(["existing-item"]);
    expect(warnings).toEqual([
      "Photos attached, but the item didn't move to Photographed.",
    ]);
  });

  it("stays quiet on the happy path", async () => {
    existingRow = { id: "existing-item" };
    await run("SKU-1");
    expect(warnings).toEqual([]);
  });
});

// AL-07: binding a SKU must never drag a listed or sold item backwards, a
// retry must reuse the item a refused batch created, and photos added to an
// item that already has some go after them instead of colliding at 0..n.
describe("safe SKU binding and retries (AL-07)", () => {
  it("only advances a SKU-bound item that is still in intake", async () => {
    existingRow = { id: "existing-item", status: "measured" };
    await run("SKU-1");
    expect(statusGuards).toEqual([["sourced", "cataloged", "measured"]]);
  });

  it("skips a sold match unless the seller confirmed it, and never touches its status", async () => {
    existingRow = { id: "sold-item", status: "sold" };
    expect(await run("SKU-1")).toEqual([]);
    expect(calls).not.toContain("inventory_items.update");
    expect(inserted).toEqual([]);

    const ids = await persistGroupsAsItems({
      ownerId: "11111111-1111-4111-8111-111111111111",
      targets: [{ id: "g1", name: "Jacket", sku: "SKU-1", photoIds: ["p1"], coverId: "p1" }],
      stagedById: new Map([["p1", PHOTO as never]]),
      allowProtectedGroupIds: new Set(["g1"]),
    });
    expect(ids).toEqual(["sold-item"]);
    // The update is status-guarded, so a sold row is left alone by the DB too.
    expect(statusGuards[statusGuards.length - 1]).not.toContain("sold");
  });

  it("offsets sort_order past an existing item's photos and skips paths it already has", async () => {
    existingRow = { id: "existing-item", status: "cataloged" };
    existingPhotos = [
      { storage_path: "u/old.jpg", sort_order: 0 },
      { storage_path: "u/old2.jpg", sort_order: 3 },
    ];
    await run("SKU-1");
    expect(inserted[inserted.length - 1]![0]).toMatchObject({ storage_path: "u/p1.jpg", sort_order: 4 });

    inserted.length = 0;
    existingPhotos = [{ storage_path: "u/p1.jpg", sort_order: 0 }];
    await run("SKU-1");
    expect(inserted).toEqual([]);
  });

  it("a retry reuses the item the refused batch created and inserts no new item", async () => {
    existingRow = { id: "made-last-time" };
    const ready: string[] = [];
    const ids = await persistGroupsAsItems({
      ownerId: "11111111-1111-4111-8111-111111111111",
      targets: [{ id: "g1", name: "Jacket", itemId: "made-last-time", photoIds: ["p1"], coverId: "p1" }],
      stagedById: new Map([["p1", PHOTO as never]]),
      onItemReady: (_g, id) => ready.push(id),
    });
    expect(ids).toEqual(["made-last-time"]);
    expect(ready).toEqual(["made-last-time"]);
    expect(calls).not.toContain("inventory_items.insert");
  });
});
