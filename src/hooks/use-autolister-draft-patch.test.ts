// AL-04: the Drafts cache holds a CappedRead ({ rows, truncated, limit }), and
// the inline edit used to map it as an array. That threw AFTER the save had
// landed, so "Save and next" never advanced.
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { fetchCapped } from "@/lib/paged-read";
import { patchAutolisterDraft, type AutolisterDraftRow } from "./use-autolister";

function row(id: string, over: Partial<AutolisterDraftRow> = {}): AutolisterDraftRow {
  return {
    id,
    inventory_item_id: `item-${id}`,
    listing_title: `Title ${id}`,
    listing_price: 20,
    batch_id: "b1",
    created_at: "2026-09-01T00:00:00Z",
    scheduled_publish_at: null,
    price_is_estimated: true,
    price_comp_source: null,
    platform_category_id: null,
    needs_review: null,
    aspect_review: null,
    quality_score: 70,
    quality_blocked: false,
    inventory_items: { title: `Item ${id}`, acquired_price: 5 },
    ...over,
  };
}

describe("patchAutolisterDraft (AL-04)", () => {
  it("patches title, price and cost inside a fetchCapped result", async () => {
    const qc = new QueryClient();
    const read = await fetchCapped(async () => [row("a"), row("b")], 500);
    qc.setQueryData(["autolister_drafts", "u1"], read);

    patchAutolisterDraft(qc, "u1", "a", { listing_title: "New", listing_price: 42 });
    patchAutolisterDraft(qc, "u1", "a", { acquired_price: 9 });

    const after = qc.getQueryData<typeof read>(["autolister_drafts", "u1"])!;
    expect(after.truncated).toBe(false);
    expect(after.limit).toBe(500);
    expect(after.rows[0]).toMatchObject({
      id: "a",
      listing_title: "New",
      listing_price: 42,
      inventory_items: { title: "Item a", acquired_price: 9 },
    });
    // The other row is the same object: nothing else re-renders.
    expect(after.rows[1]).toBe(read.rows[1]);
  });

  it("is a no-op with nothing cached", () => {
    const qc = new QueryClient();
    expect(() =>
      patchAutolisterDraft(qc, "u1", "a", { listing_title: "x" }),
    ).not.toThrow();
    expect(qc.getQueryData(["autolister_drafts", "u1"])).toBeUndefined();
  });
});
