// INV-11: no stale rows under a new tab, and no fake zeros on the tab badges.
import { describe, expect, it } from "vitest";
import { keepRowsAcrossKeys, tabCountsFrom } from "@/pages/flipdesk/listings-tab-counts";

describe("tabCountsFrom", () => {
  it("shows no number on any tab while counts load or after they fail", () => {
    const c = tabCountsFrom(undefined);
    expect(Object.values(c).every((v) => v === null)).toBe(true);
  });

  it("counts from the grouped status totals once they resolve", () => {
    const c = tabCountsFrom({ listed: 4, sold: 2, drafted: 3, cataloged: 1, archived: 5 });
    expect(c.active).toBe(4);
    expect(c.sold).toBe(2);
    expect(c.unlisted).toBe(4);
    expect(c.archived).toBe(5);
    expect(c.all).toBe(10);
    // Aged is not a status, so it never has a number from this count.
    expect(c.aged).toBeNull();
  });

  it("a real empty account is zeros, not unknown", () => {
    expect(tabCountsFrom({}).active).toBe(0);
  });
});

describe("keepRowsAcrossKeys", () => {
  const key = (tab: string, page: number) => ["items_full", "listings", "u1", tab, "", page];
  it("keeps the previous rows for a page change inside the same tab", () => {
    expect(keepRowsAcrossKeys(key("active", 1), key("active", 2))).toBe(true);
  });
  it("never shows another tab's rows as a placeholder", () => {
    expect(keepRowsAcrossKeys(key("active", 1), key("sold", 1))).toBe(false);
  });
  it("has nothing to keep on the first load", () => {
    expect(keepRowsAcrossKeys(undefined, key("active", 1))).toBe(false);
  });
});

describe("the page wires both in", () => {
  it("uses keepRowsAcrossKeys for placeholderData and tabCountsFrom for badges", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/pages/flipdesk/listings.tsx", "utf8");
    expect(src).toContain("keepRowsAcrossKeys(prevQuery?.queryKey, listingsPageKey)");
    expect(src).toContain("tabCountsFrom(statusCounts)");
    // Position 3 of the key must be the tab for keepRowsAcrossKeys to hold.
    const keyDecl = src.slice(src.indexOf("const listingsPageKey = ["));
    expect(keyDecl.slice(0, 80)).toMatch(/\.\.\.listingsItemsKey,\s*tab,/);
    // INV-D1: the prefix is built by listingsItemsKeyFor, keyed on the
    // workspace on screen; its shape is pinned in listings-owner-scope.test.ts.
    expect(src).toContain("const listingsItemsKey = listingsItemsKeyFor(ownerId);");
  });
});
