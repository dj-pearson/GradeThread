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

interface RangeCall {
  start: number;
  end: number;
}

const rangeCalls: RangeCall[] = [];
const orderCalls: { col: string; opts?: { ascending?: boolean } }[] = [];
const selectCalls: string[] = [];
let pages: Record<number, unknown[]> = {};
let rangeError: Error | null = null;

const from = vi.fn((_name: string) => ({
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
    };
  },
}));

vi.mock("@/lib/supabase", () => ({ supabase: { from: (n: string) => from(n) } }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: "u1" } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => opts,
  useMutation: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { useItemsFull, itemsFullQueryKey } = await import("@/hooks/use-items-full");

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

beforeEach(() => {
  rangeCalls.length = 0;
  orderCalls.length = 0;
  selectCalls.length = 0;
  pages = {};
  rangeError = null;
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

describe("nothing else about the shared query changed", () => {
  it("still reads items_full newest-first", async () => {
    pages[0] = rows("a", 1);
    await useItemsFullOptions().queryFn();
    expect(from).toHaveBeenCalledWith("items_full");
    expect(orderCalls[0]).toEqual({ col: "created_at", opts: { ascending: false } });
  });

  it("still returns fully materialized rows", async () => {
    // Six consumers group/filter/sort the whole array client-side. Projecting
    // columns is the rest of US-2188 and needs the app driven, because a shared
    // key with divergent queryFns hands every route the first mounter's data.
    pages[0] = rows("a", 1);
    await useItemsFullOptions().queryFn();
    expect(selectCalls[0]).toBe("*");
  });

  it("keeps the query key every consumer and mutation invalidates on", () => {
    expect(itemsFullQueryKey("u1")).toEqual(["items_full", "u1"]);
    expect((useItemsFull() as unknown as QueryLike).queryKey).toEqual(["items_full", "u1"]);
  });
});
