// INV-D1: the Inventory table, its tab counts, select-all and the CSV export
// all read ONE workspace, the one on screen.
//
// flipdesk_listing_page and inventory_status_counts are SECURITY INVOKER, and
// RLS admits every workspace the caller belongs to. So a seller who owned items
// and was also a member elsewhere saw both mixed together. Migration 00833 adds
// p_owner_id to both functions; these cases pin that the client SENDS it, and
// that the cache keys name the workspace so a switch never serves the other
// workspace's rows from cache. The SQL half is proved against a real Postgres
// by scripts/check-inventory-owner-scope.mjs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const rpcCalls: { fn: string; args: unknown }[] = [];
let activeOwner: string | null = null;

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: { sold: 1 }, error: null });
    },
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "u1" }, activeWorkspaceOwnerId: activeOwner }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => opts,
}));

const { listingPageArgs, listingsItemsKeyFor } = await import(
  "@/pages/flipdesk/listings-page-queries"
);
const {
  useInventoryStatusCounts,
  inventoryStatusCountsKey,
  inventoryStatusCountsArgs,
} = await import("@/hooks/use-inventory-status-counts");

const CRITERIA = {
  tab: "all" as const,
  search: "",
  soldFilter: "all" as const,
  unlistedFilter: "all" as const,
  filterQuery: { combinator: "and", rules: [] } as never,
  columnSort: null,
  sortPreset: "listability" as const,
  agedThresholdDays: 60,
};

type CountsQuery = {
  queryKey: readonly unknown[];
  enabled: boolean;
  queryFn: () => Promise<Record<string, number>>;
};
// Named as a hook so react-hooks/rules-of-hooks accepts the call; react-query
// is mocked, so this returns the options object.
function useCountsOptions(): CountsQuery {
  return useInventoryStatusCounts() as unknown as CountsQuery;
}

beforeEach(() => {
  rpcCalls.length = 0;
  activeOwner = null;
});

describe("listingPageArgs sends the workspace on screen", () => {
  it("passes ownerId as p_owner_id", () => {
    expect(listingPageArgs({ ...CRITERIA, ownerId: "owner-b" }).p_owner_id).toBe("owner-b");
  });
  it("sends null, not an empty string, before the user has loaded", () => {
    // An empty string is not a uuid and would fail the call; null makes the
    // server fall back to the caller's own rows.
    expect(listingPageArgs({ ...CRITERIA, ownerId: "" }).p_owner_id).toBeNull();
  });
});

describe("the listings cache key names the workspace", () => {
  it("is items_full > listings > owner, so invalidating items_full still sweeps it", () => {
    expect(listingsItemsKeyFor("owner-b")).toEqual(["items_full", "listings", "owner-b"]);
  });
  it("differs between two workspaces", () => {
    expect(listingsItemsKeyFor("owner-a")).not.toEqual(listingsItemsKeyFor("owner-b"));
  });
});

describe("inventory_status_counts reads the workspace on screen", () => {
  it("keys and calls with the active workspace owner, not the signed-in user", async () => {
    activeOwner = "owner-b";
    const q = useCountsOptions();
    expect(q.queryKey).toEqual(["items_full", "status_counts", "owner-b"]);
    expect(q.enabled).toBe(true);
    await q.queryFn();
    expect(rpcCalls).toEqual([
      { fn: "inventory_status_counts", args: { p_owner_id: "owner-b" } },
    ]);
  });
  it("falls back to the user's own workspace when none is active", async () => {
    const q = useCountsOptions();
    expect(q.queryKey).toEqual(["items_full", "status_counts", "u1"]);
    await q.queryFn();
    expect(rpcCalls[0]?.args).toEqual({ p_owner_id: "u1" });
  });
  it("builds its key and args from one owner id", () => {
    expect(inventoryStatusCountsKey("x")).toEqual(["items_full", "status_counts", "x"]);
    expect(inventoryStatusCountsArgs(undefined)).toEqual({ p_owner_id: null });
  });
});

describe("both flipdesk_listing_page call sites pass the owner", () => {
  // The builder only helps if every caller hands it the owner. A call site that
  // left it out would type-check only if ownerId were optional, which it is
  // not; this pins the call sites anyway so a refactor cannot route around it.
  for (const file of [
    "src/pages/flipdesk/listings.tsx",
    "src/pages/flipdesk/listings-actions.ts",
  ]) {
    it(file, () => {
      const src = readFileSync(file, "utf8");
      const calls = src.split("...listingPageArgs({").slice(1);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.slice(0, call.indexOf("})"))).toMatch(/\bownerId,/);
      }
    });
  }
  it("the page's cache key is built from the owner", () => {
    const src = readFileSync("src/pages/flipdesk/listings.tsx", "utf8");
    expect(src).toContain("const listingsItemsKey = listingsItemsKeyFor(ownerId);");
  });
});
