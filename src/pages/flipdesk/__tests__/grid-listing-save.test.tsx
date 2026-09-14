import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GRID_COLS, aspectColumn, cellLock, validateGridValue, type GridRow } from "../grid-columns";

const mocks = vi.hoisted(() => ({
  fresh: {} as Record<string, unknown>,
  writes: [] as Record<string, unknown>[],
  revise: vi.fn(), bulk: vi.fn(), saved: true,
}));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayReviseListing: () => ({ mutateAsync: mocks.revise }),
  useBulkEditListings: () => ({ mutateAsync: mocks.bulk }),
}));
vi.mock("@/lib/supabase", () => ({ supabase: { from: () => ({
  select: () => {
    const read = { eq: () => read, maybeSingle: async () => ({ data: mocks.fresh, error: null }) };
    return read;
  },
  update: (patch: Record<string, unknown>) => {
    mocks.writes.push(patch);
    const write = { eq: () => write, select: () => write, maybeSingle: async () => ({ data: mocks.saved ? { id: "listing" } : null, error: null }) };
    return write;
  },
}) } }));
import { useSaveGridListing } from "../use-grid-listings";

function row(overrides: Record<string, unknown> = {}): GridRow {
  return { id: "item", item_title: "Jacket", floor_price: 10, listing: { ...mocks.fresh, ...overrides } } as unknown as GridRow;
}
async function save(source: GridRow, changes: Record<string, string>, columns = GRID_COLS) {
  let action!: ReturnType<typeof useSaveGridListing>;
  function Harness() { action = useSaveGridListing(); return null; }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(h(Harness)));
  try { await action(source, changes, columns); } finally { act(() => root.unmount()); }
}
beforeEach(() => {
  mocks.fresh = { id: "listing", inventory_item_id: "item", platform: "ebay", listing_origin: "gradethread", listing_status: "draft", listing_title: "Old title", listing_price: 20, quantity: 1, item_specifics_override: { Fit: ["Regular"], Material: ["Cotton"] }, item_specifics_sources: { Material: "manual" } };
  mocks.writes.length = 0;
  mocks.saved = true;
  mocks.revise.mockReset().mockResolvedValue({ ok: true });
  mocks.bulk.mockReset().mockResolvedValue({ results: [{ listing_id: "listing", status: "ok" }] });
});

describe("grid listing saves", () => {
  it("writes draft snapshots without calling a publishing or revision endpoint", async () => {
    await save(row(), { "listing.listing_title": "New title", "listing.listing_price": "25", "listing.shipping_policy_id": "123" });
    expect(mocks.writes).toEqual([{ listing_title: "New title", listing_price: 25, price_set_by: "seller", shipping_policy_id: "123" }]);
    expect(mocks.revise).not.toHaveBeenCalled();
    expect(mocks.bulk).not.toHaveBeenCalled();
  });
  it("revises a live listing and treats policy refusals as failures", async () => {
    mocks.fresh.listing_status = "active";
    await save(row(), { "listing.listing_title": "New title", "listing.quantity": "2" });
    expect(mocks.revise).toHaveBeenCalledWith({ listingId: "listing", patch: { title: "New title", quantity: 2 } });
    mocks.bulk.mockResolvedValueOnce({ results: [{ listing_id: "listing", status: "blocked", error: "Policy was refused" }] });
    await expect(save(row(), { "listing.shipping_policy_id": "123" })).rejects.toThrow("Saved in GradeThread; eBay still needs an update");
  });
  it("does not report a successful local write as a confirmed eBay revision", async () => {
    mocks.fresh.listing_status = "active";
    mocks.revise.mockRejectedValueOnce(new Error("eBay unavailable"));
    await expect(save(row(), { "listing.listing_price": "25" })).rejects.toThrow("eBay still needs an update");
    expect(mocks.writes).toHaveLength(1);
  });
  it("rechecks origin before writing a listing that became locked", async () => {
    const before = row();
    mocks.fresh.listing_origin = "ebay";
    await expect(save(before, { "listing.listing_title": "New" })).rejects.toThrow("Created on eBay");
    expect(mocks.writes).toHaveLength(0);
  });
  it("refuses to overwrite an edit made since the grid was loaded", async () => {
    const before = row();
    mocks.fresh.listing_title = "Someone else's title";
    await expect(save(before, { "listing.listing_title": "My title" })).rejects.toThrow("changed elsewhere");
    expect(mocks.writes).toHaveLength(0);
  });
  it("allows retrying the same value after an unconfirmed live revision", async () => {
    const before = row();
    mocks.fresh.listing_status = "active";
    mocks.fresh.listing_title = "New title";
    await save(before, { "listing.listing_title": "New title" });
    expect(mocks.revise).toHaveBeenCalledOnce();
  });
  it("merges item specifics without losing other fields or their sources", async () => {
    await save(row(), { "aspect.Fit": "Relaxed; Oversized" }, [...GRID_COLS, aspectColumn("Fit")]);
    expect(mocks.writes[0]).toMatchObject({
      item_specifics_override: { Fit: ["Relaxed", "Oversized"], Material: ["Cotton"] },
      item_specifics_sources: { Fit: "manual", Material: "manual" },
    });
  });
  it("fails a zero-row save rather than claiming the listing was updated", async () => {
    mocks.saved = false;
    await expect(save(row(), { "listing.listing_title": "New title" })).rejects.toThrow("changed while saving");
    expect(mocks.revise).not.toHaveBeenCalled();
  });
});

describe("grid validation", () => {
  it("rejects invalid prices, fractional quantities, long titles and invented conditions", () => {
    for (const [field, value] of [["listing.listing_price", "NaN"], ["listing.listing_price", "0"], ["listing.listing_price", "9"], ["listing.listing_price", "20.001"], ["listing.quantity", "1.5"], ["listing.listing_title", "a".repeat(81)], ["listing.ebay_condition", "Perfect"]] as const) {
      expect(validateGridValue(GRID_COLS.find(col => col.field === field)!, value, row())).toBeTruthy();
    }
  });
  it("keeps local inventory cells editable on imported listings", () => {
    const imported = row({ listing_origin: "ebay" });
    expect(cellLock(imported, GRID_COLS.find(col => col.field === "brand")!)).toBeNull();
    expect(cellLock(imported, GRID_COLS.find(col => col.field === "listing.listing_price")!)).toContain("eBay");
    expect(cellLock({ ...imported, listing: undefined }, GRID_COLS.find(col => col.field === "listing.quantity")!)).toContain("Create a draft");
  });
  it("locks quantities on variation listings", () => {
    const source = row({ variations: { specifications: [], variants: [] } });
    expect(cellLock(source, GRID_COLS.find(col => col.field === "listing.quantity")!)).toContain("variation");
  });
});
