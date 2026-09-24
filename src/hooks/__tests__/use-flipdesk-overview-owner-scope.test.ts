// Migration 00834: the FlipDesk Overview on /dashboard reads ONE workspace, the
// one on screen.
//
// flipdesk_overview_metrics is SECURITY INVOKER, and RLS admits every
// workspace the caller belongs to, so a seller who owned items and was also a
// member elsewhere saw both blended together. These cases pin that the hook
// SENDS the active workspace owner and that the cache key names it, so a
// workspace switch never serves the other workspace's numbers from cache. The
// SQL half is proved against a real Postgres by
// scripts/check-overview-owner-scope.mjs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let activeOwner: string | null = null;

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: { total: 1 }, error: null });
    },
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: "u1" }, activeWorkspaceOwnerId: activeOwner }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => opts,
  keepPreviousData: "keepPreviousData",
}));

const { useFlipdeskOverview, overviewOwnerArg } = await import(
  "@/hooks/use-flipdesk-overview"
);

type OverviewQuery = {
  queryKey: readonly unknown[];
  enabled: boolean;
  queryFn: () => Promise<unknown>;
};
// Named as a hook so react-hooks/rules-of-hooks accepts the call; react-query
// is mocked, so this returns the options object.
function useOverviewOptions(): OverviewQuery {
  return useFlipdeskOverview("d30") as unknown as OverviewQuery;
}

beforeEach(() => {
  rpcCalls.length = 0;
  activeOwner = null;
});

describe("flipdesk_overview_metrics reads the workspace on screen", () => {
  it("keys and calls with the active workspace owner, not the signed-in user", async () => {
    activeOwner = "owner-b";
    const q = useOverviewOptions();
    expect(q.queryKey).toEqual(["items_full", "overview_metrics", "owner-b", "d30"]);
    expect(q.enabled).toBe(true);
    await q.queryFn();
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("flipdesk_overview_metrics");
    expect(rpcCalls[0]?.args.p_owner_id).toBe("owner-b");
  });

  it("falls back to the user's own workspace when none is active", async () => {
    const q = useOverviewOptions();
    expect(q.queryKey).toEqual(["items_full", "overview_metrics", "u1", "d30"]);
    await q.queryFn();
    expect(rpcCalls[0]?.args.p_owner_id).toBe("u1");
  });

  it("two workspaces are two cache entries", () => {
    activeOwner = "owner-a";
    const a = useOverviewOptions().queryKey;
    activeOwner = "owner-b";
    const b = useOverviewOptions().queryKey;
    expect(a).not.toEqual(b);
  });

  it("sends null, not an empty string, before the owner is known", () => {
    // An empty string is not a uuid and would fail the call; null makes the
    // server fall back to the caller's own rows.
    expect(overviewOwnerArg(undefined)).toEqual({ p_owner_id: null });
    expect(overviewOwnerArg("")).toEqual({ p_owner_id: null });
  });
});
