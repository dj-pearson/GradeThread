// The sort menu on every Inventory tab.
//
// Two things are worth pinning. Every column an option names must be a real
// `items_full` column, because the server validates the field and raises 22023
// on an unknown one (migration 00515): an option that compiles and then throws
// on click is the failure this file exists to catch. And a `?sort=` value from
// one tab must resolve to the DEFAULT on a tab whose menu lacks it, never to a
// neighbouring option, so a link copied from To List cannot quietly reorder
// Sold.

import { describe, it, expect } from "vitest";
import { TABS, type TabId } from "@/pages/flipdesk/inventory-tabs";
import { LISTINGS_COLUMN_LIST } from "@/pages/flipdesk/listings-columns";
import {
  priceFieldForTab,
  resolveSortOption,
  sortOptionsForTab,
  sortRequestFor,
} from "@/pages/flipdesk/inventory-sort";

const ALL_TABS = TABS.map((t) => t.id);

describe("sortOptionsForTab", () => {
  it("every tab has a menu whose first entry is its default", () => {
    for (const tab of ALL_TABS) {
      const options = sortOptionsForTab(tab);
      expect(options.length, tab).toBeGreaterThan(3);
      expect(options[0]!.id, tab).toBe("default");
      expect(options[0]!.column, tab).toBeUndefined();
    }
  });

  it("ids are unique within a tab", () => {
    for (const tab of ALL_TABS) {
      const ids = sortOptionsForTab(tab).map((o) => o.id);
      expect(new Set(ids).size, tab).toBe(ids.length);
    }
  });

  it("every column sort names a real items_full column the page already reads", () => {
    const known = new Set<string>(LISTINGS_COLUMN_LIST);
    for (const tab of ALL_TABS) {
      for (const o of sortOptionsForTab(tab)) {
        if (o.column) expect(known.has(o.column.field), `${tab}/${o.id}`).toBe(true);
      }
    }
  });

  it("the scored presets exist only on Unlisted, where the server computes them", () => {
    for (const tab of ALL_TABS) {
      const presets = sortOptionsForTab(tab).filter((o) => o.preset);
      if (tab === "unlisted") {
        expect(presets.map((o) => o.preset)).toEqual([
          "listability",
          "best_roi",
          "highest_comp",
        ]);
      } else {
        expect(presets, tab).toEqual([]);
      }
    }
  });

  it("every tab can sort by who sourced the item, both ways (US-3122)", () => {
    for (const tab of ALL_TABS) {
      const options = sortOptionsForTab(tab);
      const az = options.find((o) => o.id === "sourcer_az");
      const za = options.find((o) => o.id === "sourcer_za");
      expect(az?.column, tab).toEqual({ field: "sourced_by", dir: "asc" });
      expect(za?.column, tab).toEqual({ field: "sourced_by", dir: "desc" });
      // A column sort, never a preset: the server only scores presets on
      // Unlisted, so a preset here would silently do nothing on five tabs.
      expect(az?.preset, tab).toBeUndefined();
      expect(za?.preset, tab).toBeUndefined();
    }
  });

  it("price means the column that tab actually has a value in", () => {
    expect(priceFieldForTab("unlisted")).toBe("target_price");
    expect(priceFieldForTab("active")).toBe("list_price");
    expect(priceFieldForTab("sold")).toBe("sale_price");
    expect(priceFieldForTab("shipped")).toBe("sale_price");
    const sold = sortOptionsForTab("sold").find((o) => o.id === "price_high");
    expect(sold?.column).toEqual({ field: "sale_price", dir: "desc" });
  });
});

describe("resolveSortOption", () => {
  it("absent, unknown and hostile values land on the default", () => {
    for (const raw of [null, undefined, "", "zzz", "'; drop table", "DEFAULT"]) {
      expect(resolveSortOption(raw, "active").id).toBe("default");
    }
  });

  it("an id from another tab's menu resolves to the default, not a neighbour", () => {
    expect(resolveSortOption("best_roi", "sold").id).toBe("default");
    expect(resolveSortOption("most_views", "unlisted").id).toBe("default");
    expect(resolveSortOption("profit_high", "unlisted").id).toBe("default");
  });

  it("the four pre-existing To List values still mean what the old menu meant on Unlisted", () => {
    // `?sort=listability` was the old default and is not an id any more.
    expect(resolveSortOption("listability", "unlisted").preset).toBe("listability");
    expect(resolveSortOption("oldest", "unlisted").column).toEqual({
      field: "created_at",
      dir: "asc",
    });
    expect(resolveSortOption("best_roi", "unlisted").preset).toBe("best_roi");
    expect(resolveSortOption("highest_comp", "unlisted").preset).toBe("highest_comp");
  });
});

describe("sortRequestFor", () => {
  it("a clicked header beats the menu", () => {
    const opt = resolveSortOption("price_high", "active");
    const header = { field: "brand" as const, dir: "asc" as const };
    expect(sortRequestFor(opt, header).columnSort).toEqual(header);
  });

  it("a column option becomes p_column_sort and a preset becomes p_sort_preset", () => {
    const column = resolveSortOption("most_views", "active");
    expect(sortRequestFor(column, null)).toEqual({
      preset: "listability",
      columnSort: { field: "listing_views", dir: "desc" },
    });
    const preset = resolveSortOption("best_roi", "unlisted");
    expect(sortRequestFor(preset, null)).toEqual({
      preset: "best_roi",
      columnSort: null,
    });
  });

  it("the sourcer sort reaches the server as a column sort on sourced_by", () => {
    const opt = resolveSortOption("sourcer_az", "sold");
    expect(sortRequestFor(opt, null)).toEqual({
      preset: "listability",
      columnSort: { field: "sourced_by", dir: "asc" },
    });
  });

  it("a tab default sends no column, so the server keeps that tab's own order", () => {
    for (const tab of ALL_TABS as TabId[]) {
      const req = sortRequestFor(resolveSortOption("default", tab), null);
      expect(req.columnSort, tab).toBeNull();
    }
  });
});
