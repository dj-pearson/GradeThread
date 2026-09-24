// INV-12: the Sold window and header sort live in the URL, and the mode
// switcher never carries a page number from one mode into another.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  SORTABLE_HEADER_FIELDS,
  formatHeaderSort,
  nextHeaderSort,
  parseHeaderSort,
  resolveSoldWindow,
} from "@/pages/flipdesk/listings-url-state";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";

describe("?col= header sort", () => {
  it("round-trips a sortable column", () => {
    const s = parseHeaderSort("sale_price:desc");
    expect(s).toEqual({ field: "sale_price", dir: "desc" });
    expect(formatHeaderSort(s)).toBe("sale_price:desc");
  });

  it("ignores a field no header offers, and junk", () => {
    expect(parseHeaderSort("user_id:asc")).toBeNull();
    expect(parseHeaderSort("brand:sideways")).toBeNull();
    expect(parseHeaderSort("")).toBeNull();
  });

  it("cycles asc, desc, off", () => {
    const a = nextHeaderSort(null, "brand");
    const d = nextHeaderSort(a, "brand");
    expect(a?.dir).toBe("asc");
    expect(d?.dir).toBe("desc");
    expect(nextHeaderSort(d, "brand")).toBeNull();
  });

  it("allows exactly the columns the table renders as sortable headers", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/listings-table.tsx"), "utf8");
    const fields = new Set([...src.matchAll(/field="([a-z_]+)"/g)].map((m) => m[1]!));
    expect([...fields].sort()).toEqual([...SORTABLE_HEADER_FIELDS].sort());
  });

  it("the tab change clears ?col= in the same write as the tab", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/listings.tsx"), "utf8");
    expect(src).toMatch(/if \(tabChanged\) next\.delete\("col"\);/);
  });
});

describe("?window= Sold window", () => {
  it("accepts the known windows and falls back to all", () => {
    expect(resolveSoldWindow("d30")).toBe("d30");
    expect(resolveSoldWindow("forever")).toBe("all");
    expect(resolveSoldWindow(null)).toBe("all");
  });
});

describe("InventoryViewSwitcher", () => {
  it("never carries page, size or status into another mode", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={["/dashboard/flipdesk/inventory?tab=active&page=7&size=100&status=listed&q=levi&window=d7"]}
      >
        <InventoryViewSwitcher current="table" />
      </MemoryRouter>,
    );
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
    expect(hrefs).toHaveLength(4);
    for (const href of hrefs) {
      expect(href).not.toMatch(/[?&](page|size|status)=/);
      expect(href).toContain("q=levi");
      expect(href).toContain("tab=active");
    }
  });
});
