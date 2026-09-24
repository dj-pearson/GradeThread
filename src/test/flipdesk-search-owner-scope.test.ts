// S2: search shows the workspace on screen and nothing else.
//
// flipdesk_search (v1) is SECURITY INVOKER with no owner predicate, and the
// RLS SELECT policies admit the caller's own rows OR any workspace they belong
// to (00451). A seller who is also a member of a client's workspace got both
// tenants ranked together, capped, and then filtered, so a small workspace
// could be crowded off the page. The web now calls flipdesk_search_v2 (00835)
// with p_owner_id, which filters before the limit, and the queryFn still reads
// items_full for the hit ids filtered to the active owner as defense in depth.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; ops: [string, unknown[]][] };
const calls: Call[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
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
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
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
  rpcCalls.length = 0;
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
  it("calls flipdesk_search_v2 with the active owner as p_owner_id", async () => {
    await runFlipdeskSearch({
      args: { p_query: "nike", p_scope: "all", p_limit: 51 },
      limit: 50,
      ownerId: "B",
    });
    // v2 filters by owner BEFORE its limit. Without p_owner_id the server
    // answers for the caller's own rows, which is wrong for a member acting
    // in someone else's workspace.
    expect(rpcCalls).toEqual([
      {
        fn: "flipdesk_search_v2",
        args: { p_query: "nike", p_scope: "all", p_limit: 51, p_owner_id: "B" },
      },
    ]);
  });

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

  // The mock returns rows for both owners, which v2 would not. It stands for
  // the case the client's own check exists for: a row the server let through
  // that the owner check drops. The cap is still the RPC's fact.
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
