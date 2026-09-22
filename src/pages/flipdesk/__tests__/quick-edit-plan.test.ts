// US-3467: the quick-edit panel sends only what changed, each through its own path.
import { describe, it, expect } from "vitest";
import { formFromItem, planQuickEdit } from "@/pages/flipdesk/quick-edit-plan";
import type { ItemFullRow } from "@/types/database";

const item = (over: Partial<ItemFullRow> = {}) =>
  ({
    id: "i1",
    item_title: "Levi's 501 Jeans",
    status: "listed",
    list_price: 40,
    target_price: 45,
    purchase_price: 6,
    location_bin: "A3",
    notes: null,
    listing_id: "L1",
    ...over,
  }) as ItemFullRow;

describe("planQuickEdit", () => {
  it("an untouched form writes nothing", () => {
    const it0 = item();
    const plan = planQuickEdit(it0, formFromItem(it0));
    expect(plan.changed).toBe(false);
    expect(plan.errors).toEqual([]);
    expect(plan.base).toEqual({});
    expect(plan.status).toBeNull();
    // An unchanged listed price must not be re-pushed to the marketplace.
    expect(plan.listPrice).toBeNull();
  });

  it("base columns use the table's names, the cache patch uses the view's", () => {
    const it0 = item();
    const plan = planQuickEdit(it0, {
      ...formFromItem(it0),
      title: "  Levi's 501 Jeans 32x30 ",
      cost: "7.5",
      bin: " B1 ",
      notes: "small stain",
    });
    expect(plan.base).toEqual({
      title: "Levi's 501 Jeans 32x30",
      acquired_price: 7.5,
      location_bin: "B1",
      condition_notes: "small stain",
    });
    expect(plan.view).toEqual({
      item_title: "Levi's 501 Jeans 32x30",
      purchase_price: 7.5,
      location_bin: "B1",
      notes: "small stain",
    });
    expect(plan.changed).toBe(true);
  });

  it("clearing a field writes null", () => {
    const it0 = item();
    const plan = planQuickEdit(it0, { ...formFromItem(it0), bin: "  ", targetPrice: "" });
    expect(plan.base).toEqual({ location_bin: null, target_price: null });
  });

  it("status and listed price go out separately", () => {
    const it0 = item();
    const plan = planQuickEdit(it0, { ...formFromItem(it0), status: "archived", listPrice: "35" });
    expect(plan.base).toEqual({});
    expect(plan.status).toBe("archived");
    expect(plan.listPrice).toBe(35);
  });

  it("no listing means no listed price, whatever the box says", () => {
    const it0 = item({ listing_id: null, list_price: null });
    const plan = planQuickEdit(it0, { ...formFromItem(it0), listPrice: "99" });
    expect(plan.listPrice).toBeNull();
    expect(plan.changed).toBe(false);
  });

  it("bad input blocks the save with a plain reason", () => {
    const it0 = item();
    const plan = planQuickEdit(it0, {
      ...formFromItem(it0),
      title: " ",
      cost: "-1",
      listPrice: "",
    });
    expect(plan.errors).toEqual([
      "Title can't be blank.",
      "Cost must be a number, 0 or more.",
      "Listed price can't be blank.",
    ]);
  });

  it("money rounds to cents so 19.999 is not a change from 20", () => {
    const it0 = item({ list_price: 20 });
    const plan = planQuickEdit(it0, { ...formFromItem(it0), listPrice: "19.999" });
    expect(plan.listPrice).toBeNull();
  });
});
