// US-2173 AC2: the listings mutation handlers, called directly.
//
// This file is the point of the extraction. Every one of these handlers used to
// be a closure inside a 2,600-line component, and the only way to reach one was
// to render the whole page — which meant nobody did, and the behaviour that
// matters here went untested for its entire life.
//
// What matters here is not arithmetic. It is ORDER and HONESTY:
//
//   ORDER — optimistic patch, then the server call, then invalidate, with a
//   rollback on the error path. Skip the rollback and a rejected value keeps
//   reading as saved for the 15-minute staleTime. Skip the invalidate and the
//   optimistic number outlives the server's answer.
//
//   HONESTY — several of these toasts are the only thing standing between a
//   seller and an oversell. "Ended" for a listing that is merely QUEUED to be
//   ended is a lie that costs a double sale; so is a price reported as updated
//   when the marketplace refused it. Those exact wordings are asserted, because
//   they are the behaviour, not decoration.
//
// The dependencies arrive as one object, so each case builds fakes and calls the
// handler. Nothing renders.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── module-boundary fakes ───────────────────────────────────────────────────

interface Op {
  table: string;
  kind: "insert" | "update" | "delete" | "select";
  payload?: unknown;
  eq?: [string, string];
  in?: [string, string[]];
}
const ops: Op[] = [];
/** `${table}:${kind}` -> the error that call should return. */
let failures: Record<string, { message: string }> = {};
/** `${table}` -> rows a select should hand back. */
let selectRows: Record<string, unknown[]> = {};
let rpcPages: unknown[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

function builder(table: string, kind: Op["kind"], payload?: unknown) {
  const op: Op = { table, kind, payload };
  ops.push(op);
  const err = failures[`${table}:${kind}`] ?? null;
  const result = { data: null as unknown, error: err };
  const chain = {
    eq(col: string, val: string) {
      op.eq = [col, val];
      return Object.assign(Promise.resolve(result), chain);
    },
    in(col: string, vals: string[]) {
      op.in = [col, vals];
      return Object.assign(
        Promise.resolve({ data: selectRows[table] ?? [], error: err }),
        chain,
      );
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    maybeSingle() {
      return Promise.resolve({ data: selectRows[table]?.[0] ?? null, error: err });
    },
    then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
  };
  return chain;
}

const supabase = {
  from(table: string) {
    return {
      select: () => builder(table, "select"),
      insert: (payload: unknown) => builder(table, "insert", payload),
      update: (payload: unknown) => builder(table, "update", payload),
      delete: () => builder(table, "delete"),
    };
  },
  rpc: (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (rpcError) return Promise.resolve({ data: null, error: rpcError });
    const page = rpcPages.shift() ?? { total: 0, rows: [] };
    return Promise.resolve({ data: page as unknown, error: null });
  },
};
/** Set to make the next RPC fail; cleared in beforeEach like the rest. */
let rpcError: { message: string } | null = null;
vi.mock("@/lib/supabase", () => ({ supabase: { get from() { return supabase.from; }, get rpc() { return supabase.rpc; } } }));

const toasts: { level: string; msg: string; opts?: unknown }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string, opts?: unknown) => toasts.push({ level: "success", msg, opts }),
    error: (msg: string, opts?: unknown) => toasts.push({ level: "error", msg, opts }),
    warning: (msg: string, opts?: unknown) => toasts.push({ level: "warning", msg, opts }),
  },
}));

const csvDownloads: unknown[][] = [];
vi.mock("@/lib/items-csv", () => ({
  downloadItemsCsv: (rows: unknown[]) => csvDownloads.push(rows),
}));

const { makeListingsActions } = await import("@/pages/flipdesk/listings-actions");
type Deps = Parameters<typeof makeListingsActions>[0];

// ── fixtures ────────────────────────────────────────────────────────────────

type Row = Deps["items"][number];

function item(over: Partial<Row> = {}): Row {
  return {
    id: "i1",
    item_title: "Nike Polo",
    status: "listed",
    listing_id: "L1",
    listing_status: "active",
    tracking: null,
    list_price: 40,
    target_price: 50,
    purchase_price: 10,
    delivered_at: null,
    notes: null,
    ...over,
  } as unknown as Row;
}

const rollbacks: string[] = [];
let invalidations = 0;

function deps(over: Partial<Deps> = {}): Deps {
  const base = {
    qc: {
      invalidateQueries: () => {
        invalidations++;
        return Promise.resolve();
      },
    },
    patchRow: (id: string) => () => rollbacks.push(id),
    items: [item()],
    selected: new Set<string>(),
    setSelected: () => {},
    tab: "active",
    search: "",
    soldFilter: "all",
    filterQuery: { match: "all", rules: [] },
    columnSort: null,
    sortPreset: "listability",
    setExporting: () => {},
    setBusy: () => {},
    setDropProgress: () => {},
    dropCancelled: { current: false },
    bulkDropPct: "10",
    setBulkPublishProgress: () => {},
    setBulkDeleteProgress: () => {},
    setBulkDeleteOpen: () => {},
    setBulkStatusOpen: () => {},
    setBulkStatusValue: () => {},
    ebayConnection: { id: "c1" },
    updatePrice: { mutateAsync: () => Promise.resolve({ pushed: true }) },
    endListingApi: { mutateAsync: () => Promise.resolve({}) },
    bulkPrice: {
      mutateAsync: () =>
        Promise.resolve({ ok: true, total: 0, succeeded: 0, failed: 0, results: [] }),
    },
    bulkEnd: {
      mutateAsync: () =>
        Promise.resolve({ ok: true, total: 0, succeeded: 0, failed: 0, results: [] }),
    },
    deleteItemApi: { mutateAsync: () => Promise.resolve({}) },
    publishApi: { mutateAsync: () => Promise.resolve({}) },
  } as unknown as Deps;
  return { ...base, ...over };
}

const last = () => toasts[toasts.length - 1]!;

beforeEach(() => {
  ops.length = 0;
  toasts.length = 0;
  rollbacks.length = 0;
  csvDownloads.length = 0;
  rpcCalls.length = 0;
  rpcPages = [];
  failures = {};
  selectRows = {};
  invalidations = 0;
  rpcError = null;
});

// ── inline edits: the patch / call / invalidate / rollback order ────────────

describe("US-2173: inline edits", () => {
  it("updateTracking does nothing at all when the value is unchanged", async () => {
    const a = makeListingsActions(deps());
    await a.updateTracking(item({ tracking: "1Z" }), "  1Z  ");
    expect(ops).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("updateTracking rolls back and reports when there is no sale to write to", async () => {
    // The optimistic patch already landed. Without the rollback the row keeps a
    // tracking number that was never persisted anywhere.
    selectRows["sales"] = [];
    const a = makeListingsActions(deps());
    await a.updateTracking(item(), "1Z999");
    expect(rollbacks).toEqual(["i1"]);
    expect(last().level).toBe("error");
    expect(last().msg).toContain("No sale record");
  });

  it("updateTracking invalidates on success, so the server's answer wins", async () => {
    selectRows["sales"] = [{ id: "s1" }];
    const a = makeListingsActions(deps());
    await a.updateTracking(item(), "1Z999");
    expect(rollbacks).toEqual([]);
    expect(invalidations).toBe(1);
    expect(last().level).toBe("success");
  });

  it("markDelivered writes the sale AND the item, then invalidates", async () => {
    selectRows["sales"] = [{ id: "s1" }];
    const a = makeListingsActions(deps());
    await a.markDelivered(item());
    const updated = ops.filter((o) => o.kind === "update").map((o) => o.table);
    expect(updated).toEqual(["sales", "inventory_items"]);
    expect(invalidations).toBe(1);
  });

  it("markDelivered rolls back if the item write fails after the sale write", async () => {
    // The half-applied case: the sale is stamped, the status change is not.
    selectRows["sales"] = [{ id: "s1" }];
    failures["inventory_items:update"] = { message: "denied" };
    const a = makeListingsActions(deps());
    await a.markDelivered(item());
    expect(rollbacks).toEqual(["i1"]);
    expect(last().level).toBe("error");
  });

  it("updateListingPrice refuses a non-numeric price without calling anything", async () => {
    let called = 0;
    const a = makeListingsActions(
      deps({
        updatePrice: {
          mutateAsync: () => {
            called++;
            return Promise.resolve({ pushed: true });
          },
        },
      } as Partial<Deps>),
    );
    await a.updateListingPrice(item(), "abc");
    expect(called).toBe(0);
    expect(rollbacks).toEqual([]);
    expect(last().msg).toContain("valid price");
  });

  it("updateListingPrice refuses a negative price", async () => {
    const a = makeListingsActions(deps());
    await a.updateListingPrice(item(), "-5");
    expect(last().level).toBe("error");
  });

  it("updateListingPrice says the marketplace was NOT told when pushed is false", async () => {
    // The distinction that matters: `pushed:false` means the price moved in our
    // table and nowhere a buyer can see. Reporting both the same way is how a
    // seller believes a markdown went live when it did not.
    const a = makeListingsActions(
      deps({
        updatePrice: { mutateAsync: () => Promise.resolve({ pushed: false }) },
      } as Partial<Deps>),
    );
    await a.updateListingPrice(item(), "35");
    expect(last().msg).toBe("Price updated.");
    const pushedRun = makeListingsActions(deps());
    await pushedRun.updateListingPrice(item(), "35");
    expect(last().msg).toBe("Price updated on the marketplace.");
  });

  it("updateListingPrice rolls back when the push fails", async () => {
    const a = makeListingsActions(
      deps({
        updatePrice: { mutateAsync: () => Promise.reject(new Error("409")) },
      } as Partial<Deps>),
    );
    await a.updateListingPrice(item(), "35");
    expect(rollbacks).toEqual(["i1"]);
    expect(last().level).toBe("error");
  });

  it("patchItemColumn rolls back on a server error and keeps the label human", async () => {
    failures["inventory_items:update"] = { message: "nope" };
    const a = makeListingsActions(deps());
    await a.patchItemColumn(item(), "size", "M", { size: "M" } as never, "Size");
    expect(rollbacks).toEqual(["i1"]);
    expect(last().msg).toContain("Couldn't update size");
  });

  it("updateItemMoney rejects a negative value before touching the database", async () => {
    const a = makeListingsActions(deps());
    await a.updateItemMoney(item(), "-1", "target_price", "target_price", "Target");
    expect(ops).toEqual([]);
    expect(last().msg).toContain("valid target");
  });

  it("updateItemMoney clears the field when the input is emptied", async () => {
    const a = makeListingsActions(deps());
    await a.updateItemMoney(item(), "   ", "target_price", "target_price", "Target");
    const upd = ops.find((o) => o.kind === "update");
    expect((upd?.payload as Record<string, unknown>).target_price).toBeNull();
  });

  it("updateItemStatus is a no-op when the status already matches", async () => {
    const a = makeListingsActions(deps());
    await a.updateItemStatus(item({ status: "listed" as never }), "listed" as never);
    expect(ops).toEqual([]);
  });

  it("updateItemStatus warns rather than silently pulling a LIVE listing down", async () => {
    // The oversell rule: demoting to a draft-like status must never quietly
    // change a live marketplace offer. The seller is told to End it instead.
    const a = makeListingsActions(deps());
    await a.updateItemStatus(
      // `link` is what makes it live: an "active" row with no marketplace URL
      // is a local row someone set to active, and that one IS safe to demote.
      // planListingDemote owns that distinction; this asserts the handler
      // honours it.
      item({
        status: "listed" as never,
        listing_status: "active",
        link: "https://www.ebay.com/itm/123",
      }),
      "drafted" as never,
    );
    const warn = toasts.find((t) => t.level === "warning");
    expect(warn?.msg).toContain("still has a live eBay listing");
    // And no write to the listings table happened.
    expect(ops.some((o) => o.table === "listings" && o.kind === "update")).toBe(false);
  });
});

// ── end listing: the wording IS the safety feature ──────────────────────────

describe("US-2173: endListing reports what actually happened", () => {
  it("refuses when there is no listing record", async () => {
    let called = 0;
    const a = makeListingsActions(
      deps({
        endListingApi: {
          mutateAsync: () => {
            called++;
            return Promise.resolve({});
          },
        },
      } as Partial<Deps>),
    );
    await a.endListing(item({ listing_id: null }));
    expect(called).toBe(0);
    expect(last().level).toBe("error");
  });

  it("calls a QUEUED end a warning, not a success", async () => {
    // Poshmark/Mercari/Grailed have no end API — the extension does it later, so
    // the listing is STILL BUYABLE. "Ended" here is the oversell lie in a
    // different costume.
    const a = makeListingsActions(
      deps({
        endListingApi: {
          mutateAsync: () => Promise.resolve({ queued: true, note: "Queued." }),
        },
      } as Partial<Deps>),
    );
    await a.endListing(item());
    expect(last().level).toBe("warning");
  });

  it("leaves an unsupported-platform failure on screen long enough to read", async () => {
    const err = Object.assign(new Error("Depop can't be ended from here."), {
      code: "unsupported_platform",
    });
    const a = makeListingsActions(
      deps({ endListingApi: { mutateAsync: () => Promise.reject(err) } } as Partial<Deps>),
    );
    await a.endListing(item());
    expect(last().level).toBe("error");
    expect((last().opts as { duration: number }).duration).toBeGreaterThanOrEqual(12_000);
  });
});

// ── bulk paths ─────────────────────────────────────────────────────────────

describe("US-2173: bulk actions", () => {
  it("bulkPriceDrop reports nothing to do rather than sending an empty batch", async () => {
    const a = makeListingsActions(
      deps({
        selected: new Set(["i1"]),
        items: [item({ listing_id: null })],
      } as Partial<Deps>),
    );
    await a.bulkPriceDrop();
    expect(last().msg).toContain("None of the selected items have a listing to reprice");
  });

  it("bulkPriceDrop chunks the selection instead of one call per listing", async () => {
    const sent: string[][] = [];
    const many = Array.from({ length: 60 }, (_, i) =>
      item({ id: `i${i}`, listing_id: `L${i}` }),
    );
    const a = makeListingsActions(
      deps({
        items: many,
        selected: new Set(many.map((m) => m.id)),
        bulkPrice: {
          mutateAsync: (v: { listingIds?: string[] }) => {
            if (v.listingIds) sent.push(v.listingIds);
            return Promise.resolve({
              ok: true,
              total: v.listingIds?.length ?? 0,
              succeeded: v.listingIds?.length ?? 0,
              failed: 0,
              results: [],
            });
          },
        },
      } as Partial<Deps>),
    );
    await a.bulkPriceDrop();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.flat()).toHaveLength(60);
    // The old shape was one HTTP call per listing, which tripped the 30/60s
    // limit around the 30th row.
    expect(sent.length).toBeLessThan(10);
  });

  it("bulkPriceDrop stopped mid-batch says the sent chunks ARE already repriced", async () => {
    const cancel = { current: false };
    const many = Array.from({ length: 60 }, (_, i) =>
      item({ id: `i${i}`, listing_id: `L${i}` }),
    );
    const a = makeListingsActions(
      deps({
        items: many,
        selected: new Set(many.map((m) => m.id)),
        dropCancelled: cancel,
        bulkPrice: {
          mutateAsync: (v: { listingIds?: string[] }) => {
            cancel.current = true; // cancel after the first chunk
            return Promise.resolve({
              ok: true,
              total: v.listingIds?.length ?? 0,
              succeeded: v.listingIds?.length ?? 0,
              failed: 0,
              results: [],
            });
          },
        },
      } as Partial<Deps>),
    );
    await a.bulkPriceDrop();
    const warn = toasts.find((t) => t.level === "warning");
    expect(warn?.msg).toContain("already repriced");
  });

  it("bulkPublishToEbay does nothing without a connection", async () => {
    let called = 0;
    const a = makeListingsActions(
      deps({
        selected: new Set(["i1"]),
        ebayConnection: undefined,
        publishApi: {
          mutateAsync: () => {
            called++;
            return Promise.resolve({});
          },
        },
      } as Partial<Deps>),
    );
    await a.bulkPublishToEbay();
    expect(called).toBe(0);
  });

  it("bulkPublishToEbay says publishing cannot be undone", async () => {
    // US-2172 AC4: saying nothing is what sends a seller looking for an Undo
    // button that would have to take a live listing down to work.
    const a = makeListingsActions(deps({ selected: new Set(["i1"]) } as Partial<Deps>));
    await a.bulkPublishToEbay();
    expect((last().opts as { description?: string }).description).toContain(
      "can't be undone",
    );
  });

  it("bulkEndListings counts QUEUED rows apart from ended ones", async () => {
    const a = makeListingsActions(
      deps({
        selected: new Set(["i1"]),
        bulkEnd: {
          mutateAsync: () =>
            Promise.resolve({
              ok: true,
              total: 2,
              succeeded: 2,
              failed: 0,
              results: [
                { listing_id: "L1", ok: true, ended_upstream: true },
                { listing_id: "L2", ok: true, queued: true },
              ],
            }),
        },
      } as Partial<Deps>),
    );
    await a.bulkEndListings();
    expect(last().level).toBe("warning");
    expect(last().msg).toContain("still live until it runs");
    expect(last().msg).toContain("Ended 1");
  });

  it("bulkDeleteItems names the first real reason when some are skipped", async () => {
    const a = makeListingsActions(
      deps({
        selected: new Set(["i1"]),
        deleteItemApi: { mutateAsync: () => Promise.reject(new Error("has a sale")) },
      } as Partial<Deps>),
    );
    await a.bulkDeleteItems();
    expect(last().level).toBe("error");
    expect(last().msg).toContain("has a sale");
  });

  it("bulkSetStatus skips rows already at the target and records undo only for writes", async () => {
    const a = makeListingsActions(
      deps({
        selected: new Set(["i1", "i2"]),
        items: [
          item({ id: "i1", status: "listed" as never }),
          item({ id: "i2", status: "archived" as never }),
        ],
      } as Partial<Deps>),
    );
    await a.bulkSetStatus("archived" as never);
    const writes = ops.filter((o) => o.table === "inventory_items" && o.kind === "update");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.eq?.[1]).toBe("i1");
  });

  it("undoBulkStatus re-reads current state instead of trusting the snapshot", async () => {
    // The seconds between the action and the Undo click are exactly where a sale
    // lands, and restoring `active` over a sold listing re-exposes stock that is
    // gone.
    selectRows["items_full"] = [{ id: "i1", status: "sold", listing_status: "ended" }];
    const a = makeListingsActions(deps());
    await a.undoBulkStatus([
      {
        itemId: "i1",
        title: "Nike Polo",
        appliedStatus: "archived",
        previousStatus: "listed",
      } as never,
    ]);
    expect(ops.some((o) => o.table === "items_full" && o.kind === "select")).toBe(true);
    // Nothing was put back, and the toast says so rather than claiming success.
    expect(ops.some((o) => o.table === "inventory_items" && o.kind === "update")).toBe(
      false,
    );
    expect(last().level).toBe("warning");
  });
});

// ── the CSV export ─────────────────────────────────────────────────────────

describe("US-2173: exportCsv", () => {
  it("keeps paging until a page comes back EMPTY, not merely short", async () => {
    // The rule from paged-read.ts. A cap that returns short pages would end the
    // export early and hand the seller a file that looks complete.
    rpcPages = [
      { total: 3, rows: [{ id: "a" }, { id: "b" }] },
      { total: 3, rows: [{ id: "c" }] },
    ];
    const a = makeListingsActions(deps());
    await a.exportCsv();
    expect(rpcCalls).toHaveLength(2);
    expect(csvDownloads[0]).toHaveLength(3);
  });

  it("exports the whole result set, not the page on screen", async () => {
    // The export replays the page criteria against the server; a page-limited
    // export would silently ship 50 rows of a 900-row account.
    rpcPages = [{ total: 1, rows: [{ id: "a" }] }];
    const a = makeListingsActions(deps({ tab: "sold", search: "nike" } as Partial<Deps>));
    await a.exportCsv();
    expect(rpcCalls[0]?.fn).toBe("flipdesk_listing_page");
    expect(rpcCalls[0]?.args.p_tab).toBe("sold");
    expect(rpcCalls[0]?.args.p_search).toBe("nike");
    expect(rpcCalls[0]?.args.p_limit).toBe(500);
  });

  it("reports a failed export instead of downloading an empty file", async () => {
    rpcError = { message: "boom" };
    const a = makeListingsActions(deps());
    await a.exportCsv();
    expect(csvDownloads).toHaveLength(0);
    expect(last().level).toBe("error");
  });
});
