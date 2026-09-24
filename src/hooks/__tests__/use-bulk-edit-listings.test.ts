// INV-5: bulk edit chunks to the route's 100-listing cap and merges results.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
}));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/auth-token", () => ({ getFreshAccessToken: async () => "t" }));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://edge.test" }));

const { useBulkEditListings } = await import("@/hooks/use-ebay");

type Hook = {
  mutationFn: (v: { listingIds: string[]; edit: Record<string, unknown> }) => Promise<{
    total: number;
    results: unknown[];
    summary: { ok: number };
  }>;
};

const bodies: Array<{ listing_ids: string[] }> = [];
beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { listing_ids: string[] };
    bodies.push(body);
    const n = body.listing_ids.length;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          total: n,
          summary: { ok: n, blocked: 0, error: 0 },
          results: body.listing_ids.map((id) => ({ listing_id: id, status: "ok" })),
        }),
        { status: 200 },
      ),
    );
  });
});

describe("useBulkEditListings", () => {
  it("sends 250 listing ids as three POSTs of at most 100 and one merged result", async () => {
    const hook = useBulkEditListings() as unknown as Hook;
    const ids = Array.from({ length: 250 }, (_, i) => `l${i}`);
    const res = await hook.mutationFn({ listingIds: ids, edit: { brand: "Levi's" } });
    expect(bodies.map((b) => b.listing_ids.length)).toEqual([100, 100, 50]);
    expect(res.total).toBe(250);
    expect(res.summary.ok).toBe(250);
    expect(res.results).toHaveLength(250);
  });
});
