// S2: search shows the workspace on screen and nothing else.
//
// flipdesk_search is SECURITY INVOKER with no owner predicate, and the RLS
// SELECT policies admit the caller's own rows OR any workspace they belong to
// (00451). A seller who is also a member of a client's workspace got both
// tenants' items, listings and buyer names in one list. Until a v2 RPC takes a
// checked owner id, the queryFn reads items_full for the hit ids filtered to
// the active owner and drops every hit whose item is not in that answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; ops: [string, unknown[]][] };
const calls: Call[] = [];
let rpcRows: unknown[] = [];
let itemRows: { id: string; user_id: string }[] = [];

function chain(table: string) {
  const call: Call = { table, ops: [] };
  calls.push(call);
  const self: Record<string, unknown> = {};
  for (const k of ["select", "in", "eq", "order", "limit", "or", "abortSignal"]) {
    self[k] = (...a: unknown[]) => {
      call.ops.push([k, a]);
      return self;
    };
  }
  self["then"] = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
    const eqUser = call.ops.find(([k, a]) => k === "eq" && a[0] === "user_id");
    const ids = (call.ops.find(([k]) => k === "in")?.[1][1] ?? []) as string[];
    const data =
      table === "items_full"
        ? itemRows.filter(
            (r) => ids.includes(r.id) && (!eqUser || r.user_id === eqUser[1][1]),
          )
        : [];
    return Promise.resolve({ data, error: null }).then(ok, bad);
  };
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => {
      const p = Promise.resolve({ data: rpcRows, error: null });
      return Object.assign(p, { abortSignal: () => p });
    },
  },
}));

const { runFlipdeskSearch } = await import("@/lib/flipdesk-search-fetch");

function hit(type: string, id: string, item: string) {
  return {
    result_type: type,
    result_id: id,
    inventory_item_id: item,
    title: `t-${id}`,
    snippet: "",
    rank: 1,
  };
}

beforeEach(() => {
  calls.length = 0;
  itemRows = [
    { id: "itemA1", user_id: "A" },
    { id: "itemA2", user_id: "A" },
    { id: "itemB1", user_id: "B" },
  ];
  rpcRows = [
    hit("item", "itemA1", "itemA1"),
    hit("item", "itemB1", "itemB1"),
    hit("sale", "saleB", "itemB1"),
    hit("listing", "listA", "itemA2"),
  ];
});

describe("runFlipdeskSearch owner scope", () => {
  it("keeps only the active owner's hits", async () => {
    const r = await runFlipdeskSearch({
      args: { p_query: "nike", p_scope: "all", p_limit: 51 },
      limit: 50,
      ownerId: "A",
    });
    expect(r.hits.map((h) => h.result_id)).toEqual(["itemA1", "listA"]);
    expect([...r.items.keys()].sort()).toEqual(["itemA1", "itemA2"]);
  });

  it("asks items_full for this owner only", async () => {
    await runFlipdeskSearch({
      args: { p_query: "nike", p_scope: "all", p_limit: 51 },
      limit: 50,
      ownerId: "A",
    });
    const read = calls.find((c) => c.table === "items_full");
    expect(read, "no items_full read").toBeTruthy();
    expect(read!.ops).toContainEqual(["eq", ["user_id", "A"]]);
  });

  it("switching workspace flips the answer", async () => {
    const r = await runFlipdeskSearch({
      args: { p_query: "nike", p_scope: "all", p_limit: 51 },
      limit: 50,
      ownerId: "B",
    });
    expect(r.hits.map((h) => h.result_id)).toEqual(["itemB1", "saleB"]);
  });

  it("counts the cap from the RPC's rows, not the filtered ones", async () => {
    const r = await runFlipdeskSearch({
      args: { p_query: "nike", p_scope: "all", p_limit: 4 },
      limit: 3,
      ownerId: "B",
    });
    // Four raw rows for a limit of three: capped, even though B keeps two.
    expect(r.capped).toBe(true);
    expect(r.hits).toHaveLength(2);
  });
});
