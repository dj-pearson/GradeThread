// SRC-1: useSources reads ONE workspace, the active one. It used to have no
// owner filter and key on user.id, so a seller who owns a workspace and is a
// member of another saw both tenants' sources in every picker.
import { beforeEach, describe, expect, it, vi } from "vitest";

const eqCalls: [string, unknown][] = [];
let activeOwner: string | null = "owner-a";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          eqCalls.push([col, v]);
          return chain;
        },
        order: () => Promise.resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: activeOwner }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => opts,
}));

const { useSources } = await import("@/hooks/use-sources");

type Opts = { queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<unknown> };
// Named as a hook for rules-of-hooks; react-query is mocked to return options.
function useOpts(): Opts {
  return useSources() as unknown as Opts;
}

beforeEach(() => {
  eqCalls.length = 0;
  activeOwner = "owner-a";
});

describe("useSources", () => {
  it("filters on the active workspace owner", async () => {
    await useOpts().queryFn();
    expect(eqCalls).toContainEqual(["user_id", "owner-a"]);
  });

  it("keys on the workspace, so a switch never serves the other tenant's cache", () => {
    const a = useOpts().queryKey;
    activeOwner = "owner-b";
    const b = useOpts().queryKey;
    expect(a).toEqual(["sources", "owner-a"]);
    expect(b).toEqual(["sources", "owner-b"]);
  });

  it("is disabled with no workspace", () => {
    activeOwner = null;
    expect(useOpts().enabled).toBe(false);
  });
});
