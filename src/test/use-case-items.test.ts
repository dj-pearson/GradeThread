// PS-14: the case-item lookup carries the Ship tab's tracking, so the
// item-not-received dialog can start from it.
import { describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ salesSelect: "" }));

vi.mock("@tanstack/react-query", () => ({ useQuery: (opts: unknown) => opts }));
vi.mock("@/lib/supabase", () => {
  const rows: Record<string, unknown[]> = {
    sales: [{
      inventory_item_id: "item-1",
      sale_price: 40,
      platform_order_id: "O-1",
      tracking_number: "1Z999AA10123456784",
      carrier: "UPS",
      shipped_at: "2026-09-20T15:00:00.000Z",
    }],
    inventory_items: [{ id: "item-1", title: "Wool coat", acquired_price: 12 }],
    item_photos: [],
    listings: [],
  };
  return {
    supabase: {
      from: (table: string) => {
        const chain = {
          select: (cols: string) => {
            if (table === "sales") reads.salesSelect = cols;
            return chain;
          },
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: rows[table], error: null }).then(resolve),
        };
        return chain;
      },
    },
  };
});

const { useCaseItems } = await import("@/hooks/use-case-items");

describe("useCaseItems (PS-14)", () => {
  it("returns the sale's tracking, carrier and ship date", async () => {
    const q = useCaseItems([{ orderId: "O-1", itemId: null }]) as unknown as {
      queryFn: () => Promise<Map<string, Record<string, unknown>>>;
    };
    const map = await q.queryFn();
    expect(reads.salesSelect).toContain("tracking_number");
    expect(map.get("O-1")).toMatchObject({
      title: "Wool coat",
      trackingNumber: "1Z999AA10123456784",
      carrier: "UPS",
      shippedAt: "2026-09-20T15:00:00.000Z",
    });
  });
});
