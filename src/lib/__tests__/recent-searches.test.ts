// F7: recent searches keep their tab and count, and can be forgotten.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcRows: unknown[] | null = [];
const deletes: { table: string; ops: [string, unknown[]][] }[] = [];
let deleteError: unknown = null;

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: rpcRows, error: null });
    },
    from: (table: string) => {
      const call = { table, ops: [] as [string, unknown[]][] };
      deletes.push(call);
      const self: Record<string, unknown> = {};
      for (const k of ["delete", "eq"]) {
        self[k] = (...a: unknown[]) => {
          call.ops.push([k, a]);
          return self;
        };
      }
      self["then"] = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: deleteError }).then(ok);
      return self;
    },
  },
}));
vi.mock("@/lib/sentry", () => ({ captureException: () => {} }));

const { fetchRecentSearches, recordSearch, removeRecentSearch, clearRecentSearches } =
  await import("@/lib/recent-searches");
const { formatRecentAge, formatRecentCount } = await import("@/lib/flipdesk-search");

beforeEach(() => {
  rpcCalls.length = 0;
  deletes.length = 0;
  rpcRows = [];
  deleteError = null;
});

describe("fetchRecentSearches keeps what the row knows", () => {
  it("maps scope, result count and time, and normalizes an unknown scope", async () => {
    rpcRows = [
      { query: "jane doe", scope: "sales", result_count: 3, updated_at: "2026-09-20T10:00:00Z" },
      { query: "levis", scope: "bogus", result_count: null, updated_at: "2026-09-19T10:00:00Z" },
    ];
    await expect(fetchRecentSearches(5)).resolves.toEqual([
      { query: "jane doe", scope: "sales", resultCount: 3, updatedAt: "2026-09-20T10:00:00Z" },
      { query: "levis", scope: "all", resultCount: null, updatedAt: "2026-09-19T10:00:00Z" },
    ]);
    expect(rpcCalls[0]).toEqual({ fn: "recent_searches", args: { p_limit: 5 } });
  });
});

describe("recordSearch sends the tab and the count", () => {
  it("passes p_scope and p_result_count", async () => {
    await recordSearch("  jane doe ", { scope: "sales", resultCount: 51 });
    expect(rpcCalls).toEqual([
      {
        fn: "record_search",
        args: { p_query: "jane doe", p_scope: "sales", p_result_count: 51 },
      },
    ]);
  });

  it("defaults to all with no count", async () => {
    await recordSearch("levis");
    expect(rpcCalls[0]!.args).toEqual({ p_query: "levis", p_scope: "all", p_result_count: null });
  });
});

describe("forgetting terms", () => {
  it("removes one term by its normalized key, for this user", async () => {
    await removeRecentSearch("u1", "  Jane Doe ");
    expect(deletes).toEqual([
      {
        table: "search_history",
        ops: [
          ["delete", []],
          ["eq", ["user_id", "u1"]],
          ["eq", ["query_normalized", "jane doe"]],
        ],
      },
    ]);
  });

  it("clears every term for this user, never without a filter", async () => {
    await clearRecentSearches("u1");
    expect(deletes[0]!.ops).toEqual([
      ["delete", []],
      ["eq", ["user_id", "u1"]],
    ]);
  });

  it("throws a RESOLVED refusal so the page can roll back", async () => {
    deleteError = { code: "42501", message: "permission denied" };
    await expect(removeRecentSearch("u1", "x y")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("display helpers", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  it("ages a timestamp", () => {
    expect(formatRecentAge("2026-09-24T11:59:40Z", now)).toBe("just now");
    expect(formatRecentAge("2026-09-24T11:30:00Z", now)).toBe("30m ago");
    expect(formatRecentAge("2026-09-24T07:00:00Z", now)).toBe("5h ago");
    expect(formatRecentAge("2026-09-21T12:00:00Z", now)).toBe("3d ago");
    expect(formatRecentAge("not a date", now)).toBe("");
  });

  it("reads a capped count as 50+", () => {
    expect(formatRecentCount(null)).toBeNull();
    expect(formatRecentCount(1)).toBe("1 result");
    expect(formatRecentCount(12)).toBe("12 results");
    expect(formatRecentCount(51)).toBe("50+ results");
    // After Show 200: an uncapped count is exact, a capped one is 200+.
    expect(formatRecentCount(120)).toBe("120 results");
    expect(formatRecentCount(201)).toBe("200+ results");
  });
});
