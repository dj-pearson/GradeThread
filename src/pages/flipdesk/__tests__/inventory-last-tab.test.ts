// Where the Inventory table opens when the URL does not say.
//
// The bug this pins: open a draft from the old Drafts tab, press Back to
// items, land on To List. The return link carried no tab, and a bare URL meant To
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
    expect(initialInventoryTab("sold", "active", "archived")).toBe("sold");
  });

  it("a ?status= deep link wins over the remembered tab", () => {
    expect(initialInventoryTab(null, "active", "sold")).toBe("active");
  });

  it("a bare URL opens the remembered tab", () => {
    expect(initialInventoryTab(null, null, "sold")).toBe("sold");
  });

  it("with nothing remembered, Unlisted is the default", () => {
    expect(initialInventoryTab(null, null, null)).toBe("unlisted");
  });

  it("the retired To List and Drafts ids still open the tab that replaced them", () => {
    // Bookmarks and the mobile apps still send these.
    expect(initialInventoryTab("to_list", null, "sold")).toBe("unlisted");
    expect(initialInventoryTab("drafts", null, "sold")).toBe("unlisted");
  });

  it("an unknown ?tab= is ignored rather than rendered as an empty view", () => {
    expect(initialInventoryTab("nope", null, "active")).toBe("active");
    expect(initialInventoryTab("nope", null, null)).toBe("unlisted");
  });
});

describe("read/write", () => {
  it("round-trips a tab through localStorage", () => {
    expect(readLastInventoryTab()).toBeNull();
    writeLastInventoryTab("sold");
    expect(window.localStorage.getItem(INVENTORY_LAST_TAB_KEY)).toBe("sold");
    expect(readLastInventoryTab()).toBe("sold");
  });

  it("a stored value that is not a tab reads as nothing", () => {
    window.localStorage.setItem(INVENTORY_LAST_TAB_KEY, "garbage");
    expect(readLastInventoryTab()).toBeNull();
  });
});
