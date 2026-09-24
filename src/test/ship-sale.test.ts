// PS-08: the local "mark shipped" write fails loudly when nothing changed, and
// moves the garment to Shipped when it did.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: vi.fn() }));

const { SHIP_WRITE_REFUSED, shipSale } = await import("@/lib/ship-sale");

interface Call {
  table: string;
  patch: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
}

function fakeDb(opts: {
  salesRows: unknown[];
  itemError?: unknown;
  /** What a read-back of the sale finds after a zero-row update. */
  current?: { id: string; shipped_at: string | null } | null;
}) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const db = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            reads.push(table);
            return Promise.resolve({ data: opts.current ?? null, error: null });
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        const call: Call = { table, patch, filters: [] };
        calls.push(call);
        const result = table === "sales"
          ? { data: opts.salesRows, error: null }
          : { data: null, error: opts.itemError ?? null };
        const chain = {
          eq: (col: string, v: unknown) => {
            call.filters.push(["eq", col, v]);
            return chain;
          },
          is: (col: string, v: unknown) => {
            call.filters.push(["is", col, v]);
            return chain;
          },
          select: () => Promise.resolve(result),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
        };
        return chain;
      },
    }),
  };
  return { db: db as never, calls, reads };
}

describe("shipSale (PS-08)", () => {
  let input: { saleId: string; itemId: string; tracking: string; carrier: string | null };
  beforeEach(() => {
    input = { saleId: "sale-1", itemId: "item-1", tracking: "1Z999AA10123456784", carrier: "UPS" };
  });

  it("throws when the sales update changed no row", async () => {
    const f = fakeDb({ salesRows: [], current: { id: "sale-1", shipped_at: null } });
    await expect(shipSale(input, f.db)).rejects.toThrow(SHIP_WRITE_REFUSED);
    // And never moved the item for a sale it did not ship.
    expect(f.calls.map((c) => c.table)).toEqual(["sales"]);
  });

  it("throws when the sale is not visible at all", async () => {
    const f = fakeDb({ salesRows: [], current: null });
    await expect(shipSale(input, f.db)).rejects.toThrow(SHIP_WRITE_REFUSED);
    expect(f.calls.map((c) => c.table)).toEqual(["sales"]);
  });

  it("still moves the item when the sale was already shipped (the dialog's retry)", async () => {
    // The ship-order dialog tells the seller to press again when the item
    // write failed after the sale landed. That press finds shipped_at set.
    const f = fakeDb({ salesRows: [], current: { id: "sale-1", shipped_at: "2026-09-20T10:00:00Z" } });
    await expect(shipSale(input, f.db)).resolves.toEqual({ itemError: null });
    expect(f.reads).toEqual(["sales"]);
    expect(f.calls.map((c) => c.table)).toEqual(["sales", "inventory_items"]);
  });

  it("writes the sale, then the item, on success", async () => {
    const f = fakeDb({ salesRows: [{ id: "sale-1" }] });
    await expect(shipSale(input, f.db)).resolves.toEqual({ itemError: null });
    expect(f.calls.map((c) => c.table)).toEqual(["sales", "inventory_items"]);
    expect(f.calls[0]!.patch.tracking_number).toBe("1Z999AA10123456784");
    expect(f.calls[0]!.patch.carrier).toBe("UPS");
    expect(f.calls[1]!.patch).toEqual({ status: "shipped" });
  });

  it("never restamps a sale that is already shipped", async () => {
    const f = fakeDb({ salesRows: [{ id: "sale-1" }] });
    await shipSale(input, f.db);
    expect(f.calls[0]!.filters).toContainEqual(["is", "shipped_at", null]);
  });

  it("keeps an existing carrier when none was chosen", async () => {
    const f = fakeDb({ salesRows: [{ id: "sale-1" }] });
    await shipSale({ ...input, carrier: null }, f.db);
    expect("carrier" in f.calls[0]!.patch).toBe(false);
  });

  it("reports, rather than throws, an item write that failed after the sale shipped", async () => {
    const f = fakeDb({ salesRows: [{ id: "sale-1" }], itemError: { message: "rls" } });
    await expect(shipSale(input, f.db)).resolves.toEqual({ itemError: { message: "rls" } });
  });
});
