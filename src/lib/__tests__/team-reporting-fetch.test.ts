import { beforeEach, describe, expect, it, vi } from "vitest";

// US-3120. `team-reporting.test.ts` covers the arithmetic; every `fetch*` in
// that module was untested, and they are where the arithmetic gets its inputs.
//
// ⚠ THE POINT IS THE CHAIN, NOT THE MATHS. These functions are a filter chain
// and a shape cast, and both fail silently: a `.eq` dropped from a query returns
// ANOTHER TENANT'S rows rather than an error, and a column renamed under the
// cast reads as undefined and turns into "Untitled item". The mock records what
// was actually asked for so a missing filter fails here rather than shipping.
//
// The chain is also the shape that has bitten this repo before: `supabase.from`
// must stay bound to its client, so the mock is a real object with a `from`
// method rather than a bare function.

interface Call {
  table: string;
  ops: Array<[string, ...unknown[]]>;
}

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  results: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const call: Call = { table, ops: [] };
    h.calls.push(call);
    const result = () => h.results[table] ?? { data: [], error: null };
    const c: Record<string, unknown> = {
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR),
    };
    for (const op of ["select", "eq", "in", "not", "gte", "lte", "order", "limit"]) {
      c[op] = (...args: unknown[]) => {
        call.ops.push([op, ...args]);
        return c;
      };
    }
    return c;
  };
  return { supabase: { from: (table: string) => chain(table) } };
});

const { fetchDeadCapital, fetchItemTitles, fetchRoster, fetchSoldItemIds } =
  await import("@/lib/team-reporting");

const opsFor = (table: string) =>
  h.calls.filter((c) => c.table === table).flatMap((c) => c.ops);

beforeEach(() => {
  h.calls.length = 0;
  h.results = {};
});

describe("fetchItemTitles", () => {
  it("asks for nothing when there are no ids", async () => {
    // Not just an optimisation: `.in("id", [])` is a query that can behave
    // differently per PostgREST version, and the answer is knowable without it.
    const out = await fetchItemTitles("owner-1", []);
    expect(out.size).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it("scopes to the owner AND to the ids asked for", async () => {
    h.results.inventory_items = {
      data: [{ id: "a", title: "Wool coat" }],
      error: null,
    };
    await fetchItemTitles("owner-1", ["a", "b"]);
    const ops = opsFor("inventory_items");
    expect(ops).toContainEqual(["eq", "user_id", "owner-1"]);
    expect(ops).toContainEqual(["in", "id", ["a", "b"]]);
  });

  it("gives a blank or missing title a name rather than an empty string", async () => {
    h.results.inventory_items = {
      data: [
        { id: "a", title: "  Wool coat  " },
        { id: "b", title: "   " },
        { id: "c", title: null },
      ],
      error: null,
    };
    const out = await fetchItemTitles("owner-1", ["a", "b", "c"]);
    expect(out.get("a")).toBe("Wool coat");
    expect(out.get("b")).toBe("Untitled item");
    expect(out.get("c")).toBe("Untitled item");
  });

  it("throws rather than returning an empty map on a failed read", async () => {
    // An empty map here reads downstream as "these items have no titles",
    // which is a report that looks finished and is missing rows.
    h.results.inventory_items = { data: null, error: { message: "nope" } };
    await expect(fetchItemTitles("owner-1", ["a"])).rejects.toBeTruthy();
  });
});

describe("fetchSoldItemIds", () => {
  it("counts only this owner's COMPLETED sales", async () => {
    h.results.sales = {
      data: [{ inventory_item_id: "a" }, { inventory_item_id: "b" }],
      error: null,
    };
    const out = await fetchSoldItemIds("owner-1");
    expect([...out].sort()).toEqual(["a", "b"]);
    const ops = opsFor("sales");
    expect(ops).toContainEqual(["eq", "user_id", "owner-1"]);
    expect(ops).toContainEqual(["eq", "status", "completed"]);
  });

  it("drops a sale with no item rather than adding a null id", async () => {
    h.results.sales = {
      data: [{ inventory_item_id: null }, { inventory_item_id: "a" }],
      error: null,
    };
    expect([...(await fetchSoldItemIds("owner-1"))]).toEqual(["a"]);
  });

  it("throws on a failed read", async () => {
    h.results.sales = { data: null, error: { message: "nope" } };
    await expect(fetchSoldItemIds("owner-1")).rejects.toBeTruthy();
  });
});

describe("fetchDeadCapital", () => {
  it("excludes an item that has already sold, even when its status has not caught up", async () => {
    // The status filter and the sales table disagree during the window between
    // a sale being recorded and the item being marked sold. Counting that item
    // as dead capital reports money as stuck that has already come back.
    h.results.inventory_items = {
      data: [
        { id: "a", title: "Coat", sourced_by: "Sam", acquired_price: 10, acquired_date: "2026-01-01", status: "listed" },
        { id: "b", title: "Boots", sourced_by: "Sam", acquired_price: 20, acquired_date: "2026-01-01", status: "listed" },
      ],
      error: null,
    };
    h.results.sales = { data: [{ inventory_item_id: "b" }], error: null };

    const out = await fetchDeadCapital("owner-1", new Date("2026-06-01T00:00:00Z"));
    const ids = out.rows.flatMap((r) => r.oldest.map((o) => o.id));
    expect(ids).toContain("a");
    expect(ids).not.toContain("b");
    // And the money follows: only the unsold item's cost is stuck.
    expect(out.grandTotal).toBe(10);
  });

  it("asks the database to exclude sold and archived, and scopes to the owner", async () => {
    h.results.inventory_items = { data: [], error: null };
    await fetchDeadCapital("owner-1", new Date("2026-06-01T00:00:00Z"));
    const ops = opsFor("inventory_items");
    expect(ops).toContainEqual(["eq", "user_id", "owner-1"]);
    expect(ops).toContainEqual(["not", "status", "in", "(sold,archived)"]);
  });
});

describe("fetchRoster", () => {
  it("always includes the owner, not only the workspace members", async () => {
    // A solo seller has no workspace_members rows at all, so a roster built
    // from that table alone is empty and every report keyed on it is blank.
    h.results.workspace_members = { data: [], error: null };
    h.results.users = {
      data: [{ id: "owner-1", full_name: "Dana Reed", email: "dana@example.com" }],
      error: null,
    };
    const roster = await fetchRoster("owner-1");
    expect(roster.some((r) => r.name === "Dana Reed")).toBe(true);
    expect(opsFor("users")).toContainEqual(["in", "id", ["owner-1"]]);
  });

  it("falls back to the email's local part when there is no name", async () => {
    h.results.workspace_members = { data: [{ member_id: "m-1" }], error: null };
    h.results.users = {
      data: [
        { id: "owner-1", full_name: "  ", email: "dana@example.com" },
        { id: "m-1", full_name: null, email: "sam@example.com" },
      ],
      error: null,
    };
    const names = (await fetchRoster("owner-1")).map((r) => r.name).sort();
    expect(names).toContain("dana");
    expect(names).toContain("sam");
  });
});
