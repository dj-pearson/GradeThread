// MP-04: the web's eBay and Shopify connection reads are the ACTIVE workspace's
// primary account.
//
// They keyed on user.id with no owner filter and ordered by updated_at only.
// RLS admits every workspace an admin belongs to, so an admin of two workspaces
// could see one tenant's account while Sync and Disconnect acted on another's,
// and the card could show account B while the edge synced primary account A.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<[string, ...unknown[]]> = [];
let activeOwner: string | null = null;
const fetchBodies: unknown[] = [];

vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return chain;
    };
  }
  chain.maybeSingle = async () => ({ data: null, error: null });
  return { supabase: { from: (t: string) => (calls.push(["from", t]), chain) } };
});
vi.mock("@/stores/auth-store", () => {
  const store = (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "u1" }, activeWorkspaceOwnerId: activeOwner });
  store.getState = () => ({ user: { id: "u1" }, activeWorkspaceOwnerId: activeOwner });
  return { useAuthStore: store };
});
vi.mock("@/lib/auth-token", () => ({ getFreshAccessToken: async () => "jwt" }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => opts,
  useMutation: (opts: unknown) => opts,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { useEbayConnection, useEbayConnectionIssue, useDisconnectEbay } = await import(
  "@/hooks/use-ebay"
);
const { useShopifyConnection } = await import("@/hooks/use-shopify");

type Q = { queryKey: readonly unknown[]; enabled: boolean; queryFn: () => Promise<unknown> };

beforeEach(() => {
  calls.length = 0;
  fetchBodies.length = 0;
  activeOwner = null;
});

function orders(): unknown[] {
  return calls.filter((c) => c[0] === "order").map((c) => c[1]);
}

describe.each([
  ["useEbayConnection", () => useEbayConnection() as unknown as Q],
  ["useEbayConnectionIssue", () => useEbayConnectionIssue() as unknown as Q],
  ["useShopifyConnection", () => useShopifyConnection() as unknown as Q],
])("%s", (_name, useIt) => {
  it("filters on the active workspace owner and reads the primary account first", async () => {
    activeOwner = "owner-b";
    const q = useIt();
    await q.queryFn();
    expect(calls).toContainEqual(["eq", "user_id", "owner-b"]);
    expect(orders()[0]).toBe("is_primary");
    expect(orders()[1]).toBe("updated_at");
  });

  it("switching workspace changes the cache key", () => {
    activeOwner = "owner-a";
    const a = useIt().queryKey;
    activeOwner = "owner-b";
    const b = useIt().queryKey;
    expect(a).not.toEqual(b);
    expect(b).toContain("owner-b");
  });

  it("falls back to the signed-in user's own workspace", () => {
    const q = useIt();
    expect(q.queryKey).toContain("u1");
    expect(q.enabled).toBe(true);
  });
});

describe("useDisconnectEbay", () => {
  it("sends the connection_id of the account on screen", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      fetchBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const m = useDisconnectEbay() as unknown as {
        mutationFn: (v: { connectionId: string }) => Promise<unknown>;
      };
      await m.mutationFn({ connectionId: "conn-7" });
      expect(fetchBodies).toEqual([{ connection_id: "conn-7" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
