// PS-05: partial refunds on multi-item orders, with the right reason and the
// sale's own currency.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
  sales: [] as Array<{ sale_price: number | null; currency: string | null }>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (opts: unknown) => opts,
  useQuery: (opts: unknown) => opts,
}));
vi.mock("@/lib/supabase", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    limit: () => Promise.resolve({ data: rows.sales, error: null }),
  };
  return { supabase: { from: () => chain } };
});
vi.mock("@/lib/auth-token", () => ({ getFreshAccessToken: async () => "t" }));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://edge.test" }));

const { orderTotalFromRows, orderTotalLabel, refundReasonFor } = await import(
  "@/lib/refund-amount"
);
const { useEbayIssueOrderRefund, useEbayOrderTotal } = await import("@/hooks/use-ebay");

describe("refundReasonFor", () => {
  it("maps a condition complaint to ITEM_NOT_AS_DESCRIBED", () => {
    expect(refundReasonFor("NOT_AS_DESCRIBED")).toBe("ITEM_NOT_AS_DESCRIBED");
    expect(refundReasonFor("DEFECTIVE_ITEM")).toBe("ITEM_NOT_AS_DESCRIBED");
  });

  it("maps everything else to BUYER_RETURN", () => {
    expect(refundReasonFor("NO_LONGER_NEED_ITEM")).toBe("BUYER_RETURN");
    expect(refundReasonFor("WRONG_SIZE")).toBe("BUYER_RETURN");
    expect(refundReasonFor(null)).toBe("BUYER_RETURN");
  });
});

describe("orderTotalFromRows", () => {
  it("adds every line of a two-item order", () => {
    expect(
      orderTotalFromRows([
        { sale_price: 20.1, currency: "USD" },
        { sale_price: 14.95, currency: "USD" },
      ]),
    ).toEqual({ total: 35.05, currency: "USD", lineCount: 2 });
  });

  it("reads an unreported currency as USD, per 00484", () => {
    expect(orderTotalFromRows([{ sale_price: 10, currency: null }]).currency).toBe("USD");
  });

  it("gives no currency when the lines disagree", () => {
    const t = orderTotalFromRows([
      { sale_price: 10, currency: "GBP" },
      { sale_price: 10, currency: "USD" },
    ]);
    expect(t.currency).toBeNull();
  });

  it("gives no total when a line has no price", () => {
    expect(orderTotalFromRows([{ sale_price: 10, currency: null }, { sale_price: null, currency: null }]).total)
      .toBeNull();
  });

  it("labels the total with its item count", () => {
    expect(orderTotalLabel(35.05, "USD", 2)).toBe("of $35.05 for this order (2 items)");
    expect(orderTotalLabel(10, "GBP", 1)).toBe("of 10.00 GBP for this order");
  });
});

describe("the hooks", () => {
  beforeEach(() => {
    rows.sales = [];
  });

  it("useEbayOrderTotal reads a two-row order without erroring", async () => {
    rows.sales = [
      { sale_price: 20, currency: "USD" },
      { sale_price: 15, currency: "USD" },
    ];
    const q = useEbayOrderTotal("O-1") as unknown as { queryFn: () => Promise<unknown> };
    await expect(q.queryFn()).resolves.toEqual({ total: 35, currency: "USD", lineCount: 2 });
  });

  it("the refund request carries the sale's currency", async () => {
    const bodies: Array<{ amount: { currency: string; value: string }; reason: string }> = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    const m = useEbayIssueOrderRefund() as unknown as {
      mutationFn: (v: Record<string, string>) => Promise<unknown>;
    };
    await m.mutationFn({
      orderId: "O-1",
      reason: "BUYER_RETURN",
      amountValue: "5.00",
      currency: "GBP",
    });
    expect(bodies[0]!.amount).toEqual({ currency: "GBP", value: "5.00" });
    expect(bodies[0]!.reason).toBe("BUYER_RETURN");
    vi.unstubAllGlobals();
  });
});
