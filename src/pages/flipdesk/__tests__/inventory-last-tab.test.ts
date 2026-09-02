// Where the Inventory table opens when the URL does not say.
//
// The bug this pins: open a draft from the Drafts tab, press Back to items,
// land on To List. The return link carried no tab, and a bare URL meant To
// List unconditionally. Now a bare URL means the tab the seller was last on,
// and only a URL that names a tab (or a stage) overrides that.

import { describe, it, expect, beforeEach } from "vitest";
import {
  INVENTORY_LAST_TAB_KEY,
  initialInventoryTab,
  readLastInventoryTab,
  writeLastInventoryTab,
} from "@/pages/flipdesk/inventory-last-tab";

beforeEach(() => {
  window.localStorage.clear();
});

describe("initialInventoryTab", () => {
  it("an explicit ?tab= wins over everything", () => {
    expect(initialInventoryTab("sold", "drafts", "active")).toBe("sold");
  });

  it("a ?status= deep link wins over the remembered tab", () => {
    expect(initialInventoryTab(null, "drafts", "active")).toBe("drafts");
  });

  it("a bare URL opens the remembered tab", () => {
    expect(initialInventoryTab(null, null, "drafts")).toBe("drafts");
  });

  it("with nothing remembered, To List is still the default", () => {
    expect(initialInventoryTab(null, null, null)).toBe("to_list");
  });

  it("an unknown ?tab= is ignored rather than rendered as an empty view", () => {
    expect(initialInventoryTab("nope", null, "active")).toBe("active");
    expect(initialInventoryTab("nope", null, null)).toBe("to_list");
  });
});

describe("read/write", () => {
  it("round-trips a tab through localStorage", () => {
    expect(readLastInventoryTab()).toBeNull();
    writeLastInventoryTab("drafts");
    expect(window.localStorage.getItem(INVENTORY_LAST_TAB_KEY)).toBe("drafts");
    expect(readLastInventoryTab()).toBe("drafts");
  });

  it("a stored value that is not a tab reads as nothing", () => {
    window.localStorage.setItem(INVENTORY_LAST_TAB_KEY, "garbage");
    expect(readLastInventoryTab()).toBeNull();
  });
});
