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
  columnSortForMode,
  priceFieldForTab,
  resolveSortOption,
  resolveSortOptionForMode,
  sortOptionsForMode,
  sortOptionsForTab,
  sortRequestFor,
  type SortableViewMode,
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

// ── The three tabless views (US-3122) ──────────────────────────────────────
//
// Grid, Kanban and Prep had no sort menu at all before this: the grid was
// created_at desc in its query, the board took whatever order the shared cache
// was in, and prep was oldest-first. They share `?sort=` with the table, so the
// same guarantees apply — an id from another menu must land on the default, and
// every column named must be a real one.

const MODES: SortableViewMode[] = ["grid", "kanban", "prep"];

describe("sortOptionsForMode", () => {
  it("every mode has a menu whose first entry is its default", () => {
    for (const mode of MODES) {
      const options = sortOptionsForMode(mode);
      expect(options.length, mode).toBeGreaterThan(3);
      expect(options[0]!.id, mode).toBe("default");
      expect(new Set(options.map((o) => o.id)).size, mode).toBe(options.length);
    }
  });

  it("names only real items_full columns, and never a scored preset", () => {
    const known = new Set<string>(LISTINGS_COLUMN_LIST);
    for (const mode of MODES) {
      for (const o of sortOptionsForMode(mode)) {
        if (o.column) expect(known.has(o.column.field), `${mode}/${o.id}`).toBe(true);
        // The server only computes the presets for the Unlisted tab, and two of
        // these views never reach the server for their order at all.
        expect(o.preset, `${mode}/${o.id}`).toBeUndefined();
      }
    }
  });

  it("offers the sourcer sort in all three", () => {
    for (const mode of MODES) {
      const ids = sortOptionsForMode(mode).map((o) => o.id);
      expect(ids, mode).toContain("sourcer_az");
      expect(ids, mode).toContain("sourcer_za");
    }
  });

  it("grid and kanban reuse the All tab's menu", () => {
    expect(sortOptionsForMode("grid")).toEqual(sortOptionsForTab("all"));
    expect(sortOptionsForMode("kanban")).toEqual(sortOptionsForTab("all"));
  });

  it("prep keeps its oldest-first queue as the default", () => {
    const first = sortOptionsForMode("prep")[0]!;
    expect(first.label).toBe("Oldest first");
    expect(columnSortForMode(first, "prep")).toEqual({
      field: "created_at",
      dir: "asc",
    });
  });
});

describe("columnSortForMode", () => {
  it("a default names its own column, since these views have no server default", () => {
    for (const mode of MODES) {
      const def = resolveSortOptionForMode("default", mode);
      expect(def.column, mode).toBeUndefined();
      expect(columnSortForMode(def, mode).field, mode).toBe("created_at");
    }
    expect(columnSortForMode(resolveSortOptionForMode(null, "grid"), "grid").dir)
      .toBe("desc");
    expect(columnSortForMode(resolveSortOptionForMode(null, "prep"), "prep").dir)
      .toBe("asc");
  });

  it("a chosen option wins over the default", () => {
    const opt = resolveSortOptionForMode("sourcer_az", "kanban");
    expect(columnSortForMode(opt, "kanban")).toEqual({
      field: "sourced_by",
      dir: "asc",
    });
  });
});

describe("resolveSortOptionForMode", () => {
  it("absent, unknown and other-menu values land on that view's default", () => {
    for (const mode of MODES) {
      for (const raw of [null, undefined, "", "zzz", "best_roi", "most_views"]) {
        expect(resolveSortOptionForMode(raw, mode).id, `${mode}/${raw}`).toBe("default");
      }
    }
    // `most_views` is a real option on the Active TAB, so this is the
    // cross-menu case and not just an unknown string.
    expect(sortOptionsForTab("active").some((o) => o.id === "most_views")).toBe(true);
  });
});
