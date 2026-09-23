// INV-1: the Grid's page read carries the workspace owner.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ eq: [] as [string, string][], or: [] as string[] }));

vi.mock("@/lib/supabase", () => {
  const builder = {
    eq: (col: string, val: string) => { calls.eq.push([col, val]); return builder; },
    or: (f: string) => { calls.or.push(f); return builder; },
    order: () => builder,
    range: async () => ({ data: [{ id: "i1" }], error: null, count: 1 }),
  };
  return {
    supabase: {
      rest: { from: () => ({ select: () => builder }) },
      from(this: { rest: { from: (n: string) => unknown } }, n: string) {
        return this.rest.from(n);
      },
    },
  };
});

import { fetchGridPage } from "../grid-page-query";

beforeEach(() => {
  calls.eq.length = 0;
  calls.or.length = 0;
});

describe("fetchGridPage", () => {
  it("sends user_id=eq.<active owner>, not the member's own id", async () => {
    const got = await fetchGridPage({
      ownerId: "owner-b",
      page: 1,
      search: "",
      sort: { field: "created_at", dir: "desc" },
    });
    expect(calls.eq).toEqual([["user_id", "owner-b"]]);
    expect(got.total).toBe(1);
  });

  it("keeps the owner scope when a search is added", async () => {
    await fetchGridPage({
      ownerId: "owner-b",
      page: 2,
      search: "levi",
      sort: { field: "brand", dir: "asc" },
    });
    expect(calls.eq).toEqual([["user_id", "owner-b"]]);
    expect(calls.or[0]).toContain("levi");
  });
});
