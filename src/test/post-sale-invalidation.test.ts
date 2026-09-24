// PS-07: a post-sale money action refreshes the ship queue too.
//
// Approving a cancellation cancels the sale on the edge, and the card used to
// invalidate only its own list, so the cancelled order stayed in the Ship tab
// inviting the seller to post it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({ keys: [] as unknown[][] }));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      spy.keys.push([...opts.queryKey]);
      return Promise.resolve();
    },
  }),
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
  keepPreviousData: undefined,
}));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/auth-token", () => ({ getFreshAccessToken: async () => "t" }));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://edge.test" }));
vi.mock("@/hooks/use-tenant-key", () => ({ useTenantKey: () => "tenant-1" }));

const hooks = await import("@/hooks/use-ebay");

type Mutation = {
  mutationFn: (v: Record<string, unknown>) => Promise<unknown>;
  onSuccess?: () => unknown;
};

async function succeed(m: unknown, vars: Record<string, unknown>) {
  const hook = m as Mutation;
  await hook.mutationFn(vars);
  await hook.onSuccess?.();
}

beforeEach(() => {
  spy.keys = [];
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
});

const has = (key: string) => spy.keys.some((k) => k[0] === key);

describe("post-sale mutations invalidate the ship queue (PS-07)", () => {
  it("approving a cancellation invalidates ship_queue and ebay_cancellations", async () => {
    await succeed(hooks.useEbayDecideCancellation(), { cancelId: "c1", action: "approve" });
    expect(has("ship_queue")).toBe(true);
    expect(has("ebay_cancellations")).toBe(true);
    expect(has("inventory")).toBe(true);
    expect(has("sales_all")).toBe(true);
    // The inventory table's key: the approved cancellation restocks the item.
    expect(has("items_full")).toBe(true);
  });

  const cases: Array<[string, () => unknown, Record<string, unknown>]> = [
    ["useEbayRefundReturn", () => hooks.useEbayRefundReturn(), { returnId: "r1" }],
    ["useEbayDecideReturn", () => hooks.useEbayDecideReturn(), { returnId: "r1", decision: "approve" }],
    ["useEbayIssueOrderRefund", () => hooks.useEbayIssueOrderRefund(), {
      orderId: "o1",
      reason: "BUYER_RETURN",
      amountValue: "1.00",
      currency: "USD",
    }],
    ["useEbayResolveDispute", () => hooks.useEbayResolveDispute(), { disputeId: "d1", action: "accept" }],
    ["useEbayInquiryAction", () => hooks.useEbayInquiryAction(), { inquiryId: "i1", action: "refund" }],
    ["useEbayCaseAction", () => hooks.useEbayCaseAction(), { caseId: "k1", action: "refund" }],
  ];
  for (const [name, make, vars] of cases) {
    it(`${name} invalidates the ship queue and the case lists`, async () => {
      await succeed(make(), vars);
      expect(has("ship_queue")).toBe(true);
      expect(has("ebay_returns")).toBe(true);
      expect(has("ebay_cases")).toBe(true);
      expect(has("ebay_order_total")).toBe(true);
    });
  }
});

describe("list hooks keep the edge's source (PS-12)", () => {
  it("useEbayReturns reads items and source from the response", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ returns: [{ returnId: "r1" }], source: "cache_stale" }), {
          status: 200,
        }),
      ));
    const q = hooks.useEbayReturns() as unknown as { queryFn: () => Promise<unknown> };
    await expect(q.queryFn()).resolves.toEqual({
      items: [{ returnId: "r1" }],
      source: "cache_stale",
    });
  });
});
