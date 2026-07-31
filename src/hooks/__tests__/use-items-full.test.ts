// US-2188: items_full is read through a .range() loop, not one unbounded request.
//
// The failure this prevents is SILENT. PostgREST caps a response at its
// db-max-rows and reports it only in the Content-Range header; supabase-js
// returns no error, so the old single-shot `select("*").order(...)` handed back a
// short array and every FlipDesk surface — kanban, prep queue, reconciliation
// matching — was quietly missing the same items with nothing to notice. The rest
// of the app already chunks (bulk-pricing.tsx, grid.tsx); this read did not.
//
// The other half of these tests is that NOTHING ELSE CHANGED. Six routes share
// this one query key and queryFn and sort/group the whole array client-side, so
// the order, the shape and the key all have to stay exactly as they were.
//
// supabase is mocked at the module boundary and useQuery is stubbed to hand back
// its options, so the queryFn runs headless.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface RangeCall {
  start: number;
  end: number;
}

const rangeCalls: RangeCall[] = [];
const orderCalls: { col: string; opts?: { ascending?: boolean } }[] = [];
const selectCalls: string[] = [];
let pages: Record<number, unknown[]> = {};
let rangeError: Error | null = null;

const fromCalls: string[] = [];
const eqCalls: { col: string; val: string }[] = [];
let singleRow: unknown = null;
const from = vi.fn((name: string) => {
  fromCalls.push(name);
  return {
    select: (cols: string) => {
      selectCalls.push(cols);
      return {
        order: (col: string, opts?: { ascending?: boolean }) => {
          orderCalls.push({ col, opts });
          return {
            range: (start: number, end: number) => {
              rangeCalls.push({ start, end });
              if (rangeError) return Promise.resolve({ data: null, error: rangeError });
              return Promise.resolve({ data: pages[start] ?? [], error: null });
            },
          };
        },
        eq: (col: string, val: string) => {
          eqCalls.push({ col, val });
          return {
            maybeSingle: () => {
              if (rangeError) {
                return Promise.resolve({ data: null, error: rangeError });
              }
              return Promise.resolve({ data: singleRow, error: null });
            },
          };
        },
      };
    },
  };
});

// The mock's `from` MUST depend on `this`, because the real one does:
// supabase-js implements it as `return this.rest.from(relation)`. The first
// version of this mock was a `this`-free arrow, so it happily accepted a
// hoisted `const from = supabase.from` — the suite was green while production
// threw "Cannot read properties of undefined (reading 'rest')" on every call,
// emptied every items_full consumer, and turned every item page into
// "Item not found.". Mirroring the real shape is what makes that catchable.
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rest: { from: (n: string) => from(n) },
    from(this: { rest: { from: (n: string) => unknown } }, n: string) {
      return this.rest.from(n);
    },
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: "u1" } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => opts,
  useMutation: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { useItemsFull, useItemsList, useItemFull, itemsFullQueryKey, itemsListQueryKey, itemFullQueryKey } =
  await import("@/hooks/use-items-full");
const { ITEM_LIST_COLUMNS, ITEM_DETAIL_ONLY_COLUMNS } = await import(
  "@/lib/item-list-columns"
);

const PAGE = 1000;
type QueryLike = { queryFn: () => Promise<unknown[]>; queryKey: readonly unknown[] };

/** n placeholder rows, tagged so ordering across pages is assertable. */
function rows(tag: string, n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}` }));
}

// Named as a hook so react-hooks/rules-of-hooks accepts the call. react-query is
// mocked, so useItemsFull() is a plain function returning its options object.
function useItemsFullOptions(): QueryLike {
  return useItemsFull() as unknown as QueryLike;
}

function useItemsListOptions(): QueryLike {
  return useItemsList() as unknown as QueryLike;
}

function useItemFullOptions(id: string | undefined): {
  queryFn: () => Promise<unknown>;
  queryKey: readonly unknown[];
  enabled: boolean;
} {
  return useItemFull(id) as unknown as {
    queryFn: () => Promise<unknown>;
    queryKey: readonly unknown[];
    enabled: boolean;
  };
}

beforeEach(() => {
  rangeCalls.length = 0;
  orderCalls.length = 0;
  selectCalls.length = 0;
  fromCalls.length = 0;
  eqCalls.length = 0;
  pages = {};
  rangeError = null;
  singleRow = null;
});

describe("the read is bounded", () => {
  it("asks for a range at all — the whole point", () => {
    pages[0] = rows("a", 3);
    return useItemsFullOptions().queryFn().then(() => {
      expect(rangeCalls.length).toBeGreaterThan(0);
      expect(rangeCalls[0]).toEqual({ start: 0, end: PAGE - 1 });
    });
  });

  it("keeps paging past the cap and returns every row", async () => {
    // A seller over db-max-rows is exactly who used to lose items silently.
    pages[0] = rows("p1", PAGE);
    pages[PAGE] = rows("p2", PAGE);
    pages[PAGE * 2] = rows("p3", 7);

    const all = (await useItemsFullOptions().queryFn()) as { id: string }[];
    expect(all).toHaveLength(PAGE * 2 + 7);
    expect(rangeCalls).toEqual([
      { start: 0, end: PAGE - 1 },
      { start: PAGE, end: PAGE * 2 - 1 },
      { start: PAGE * 2, end: PAGE * 3 - 1 },
    ]);
  });

  it("preserves page order, so the canonical newest-first array is intact", async () => {
    pages[0] = rows("p1", PAGE);
    pages[PAGE] = rows("p2", 2);
    const all = (await useItemsFullOptions().queryFn()) as { id: string }[];
    expect(all[0]?.id).toBe("p1-0");
    expect(all[PAGE]?.id).toBe("p2-0");
    expect(all[PAGE + 1]?.id).toBe("p2-1");
  });

  it("stops on a short page instead of looping forever", async () => {
    pages[0] = rows("only", 4);
    await useItemsFullOptions().queryFn();
    expect(rangeCalls).toHaveLength(1);
  });

  it("pays one empty request rather than guessing on an exact multiple", async () => {
    // Guessing that a full page is the last page is the same silent truncation
    // this loop exists to remove, so the extra round trip is deliberate.
    pages[0] = rows("p1", PAGE);
    pages[PAGE] = [];
    const all = await useItemsFullOptions().queryFn();
    expect(all).toHaveLength(PAGE);
    expect(rangeCalls).toHaveLength(2);
  });

  it("throws rather than returning a partial array", async () => {
    // A swallowed error here is indistinguishable from a small inventory.
    pages[0] = rows("p1", PAGE);
    rangeError = new Error("pg down");
    await expect(useItemsFullOptions().queryFn()).rejects.toThrow("pg down");
  });
});

describe("the client method stays attached to the client", () => {
  it("calls from() with its `this`, so supabase-js can reach this.rest", async () => {
    // The whole read is one call away from throwing before it hits the network.
    // React Query swallows that into an errored query, every consumer falls back
    // to its `= []` default, and the app looks like an empty inventory instead of
    // a broken one — which is exactly how it shipped.
    pages[0] = rows("a", 2);
    await expect(useItemsFullOptions().queryFn()).resolves.toHaveLength(2);
  });
});

describe("nothing else about the shared query changed", () => {
  it("still reads items_full newest-first", async () => {
    pages[0] = rows("a", 1);
    await useItemsFullOptions().queryFn();
    expect(fromCalls).toEqual(["items_full"]);
    expect(orderCalls[0]).toEqual({ col: "created_at", opts: { ascending: false } });
  });

  it("still returns fully materialized rows", async () => {
    // This is the DETAIL-shaped read now: the surfaces that need `comps`,
    // `item_description`, `notes` or `ai_field_sources` keep the whole row.
    // Everything that only lists items reads useItemsList instead.
    pages[0] = rows("a", 1);
    await useItemsFullOptions().queryFn();
    expect(selectCalls[0]).toBe("*");
  });

  it("keeps the query key every consumer and mutation invalidates on", () => {
    expect(itemsFullQueryKey("u1")).toEqual(["items_full", "u1"]);
    expect((useItemsFull() as unknown as QueryLike).queryKey).toEqual(["items_full", "u1"]);
  });
});


// ── US-2188: the projected list read ────────────────────────────────────────
//
// The win is bytes, and the risk is a dropped column rendering blank. The type
// side of that is handled by ItemListRow being a Pick<ItemFullRow, …> — a
// consumer reading a column the select stopped fetching fails tsc. What tsc
// CANNOT see is a column added to items_full later: it would be absent from
// both lists and silently never fetched by anything. That is what the
// coverage test below pins.

/** Every field name declared on `interface ItemFullRow` in the types file. */
function itemFullRowKeys(): string[] {
  const src = readFileSync(
    resolve(process.cwd(), "src/types/database.ts"),
    "utf8",
  );
  const start = src.indexOf("export interface ItemFullRow {");
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  return Array.from(body.matchAll(/^\s{2}(\w+)(\??):/gm), (m) => m[1] as string);
}

describe("the list read is projected", () => {
  it("selects the explicit column list, never *", async () => {
    pages[0] = rows("a", 1);
    await useItemsListOptions().queryFn();
    expect(selectCalls[0]).not.toBe("*");
    expect(selectCalls[0]).toBe(ITEM_LIST_COLUMNS.join(","));
  });

  it("leaves out exactly the heavy detail-only columns", () => {
    for (const col of ITEM_DETAIL_ONLY_COLUMNS) {
      expect(ITEM_LIST_COLUMNS as readonly string[]).not.toContain(col);
    }
  });

  it("keeps `measurements` — the kanban's own prereq rule reads it", () => {
    // validateStatusChange blocks a move into Measured on an empty
    // measurements map. Dropping the column would turn that rule off silently.
    expect(ITEM_LIST_COLUMNS as readonly string[]).toContain("measurements");
  });

  it("covers every ItemFullRow column between the two lists", () => {
    // A column added to items_full and to the type, but to neither list, is
    // fetched by nothing and renders blank wherever it is read.
    const declared = itemFullRowKeys().sort();
    const covered = [
      ...ITEM_LIST_COLUMNS,
      ...ITEM_DETAIL_ONLY_COLUMNS,
    ].sort();
    expect(covered).toEqual(declared);
  });

  it("pages and orders exactly like the full read", async () => {
    pages[0] = rows("p1", PAGE);
    pages[PAGE] = rows("p2", 3);
    const all = (await useItemsListOptions().queryFn()) as { id: string }[];
    expect(all).toHaveLength(PAGE + 3);
    expect(fromCalls).toEqual(["items_full", "items_full"]);
    expect(orderCalls[0]).toEqual({
      col: "created_at",
      opts: { ascending: false },
    });
  });

  it("throws rather than returning a partial array", async () => {
    pages[0] = rows("p1", PAGE);
    rangeError = new Error("pg down");
    await expect(useItemsListOptions().queryFn()).rejects.toThrow("pg down");
  });

  it("uses its own key, still under the invalidated items_full prefix", () => {
    expect(itemsListQueryKey("u1")).toEqual(["items_full", "list", "u1"]);
    // Distinct from the full read: same key + divergent queryFn is the
    // first-mounter-wins foot-gun this hook exists to avoid.
    expect(itemsListQueryKey("u1")).not.toEqual(itemsFullQueryKey("u1"));
    expect(itemsListQueryKey("u1")[0]).toBe("items_full");
  });
});

describe("the detail read fetches one row", () => {
  it("filters by id and takes a single row", async () => {
    singleRow = { id: "i1" };
    const got = await useItemFullOptions("i1").queryFn();
    expect(got).toEqual({ id: "i1" });
    expect(selectCalls[0]).toBe("*");
    expect(eqCalls).toEqual([{ col: "id", val: "i1" }]);
    expect(rangeCalls).toHaveLength(0);
  });

  it("returns null for a missing row rather than throwing", async () => {
    singleRow = null;
    await expect(useItemFullOptions("nope").queryFn()).resolves.toBeNull();
  });

  it("throws on a failed read, so callers can tell it from not-found", async () => {
    rangeError = new Error("pg down");
    await expect(useItemFullOptions("i1").queryFn()).rejects.toThrow("pg down");
  });

  it("stays disabled without an id", () => {
    expect(useItemFullOptions(undefined).enabled).toBe(false);
    expect(useItemFullOptions("i1").enabled).toBe(true);
  });

  it("keys per item, under the invalidated items_full prefix", () => {
    expect(itemFullQueryKey("u1", "i1")).toEqual([
      "items_full",
      "detail",
      "u1",
      "i1",
    ]);
  });
});
