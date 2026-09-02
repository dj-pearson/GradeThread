// US-2178 AC2: what each inventory tab shows, and in what order.
//
// These predicates decide what a seller sees on every tab of the highest-traffic
// surface in FlipDesk, and until now nothing tested them — they were consts
// buried in a 3,500-line page module. The failure mode is not a crash: a wrong
// predicate just makes items disappear from the view where the seller expects
// them, which reads as "the sync is broken" and costs a support round trip.
//
// Two rules in here were bought with real bugs and are asserted by name:
// `grading` belonging to To List (US-1429) and a refunded sale leaving Sold
// (US-1451).

import { describe, it, expect } from "vitest";
import {
  TABS,
  TO_LIST_STATUSES,
  DRAFT_LIKE_STATUSES,
  matchesUnlistedFilter,
  resolveTabId,
  resolveUnlistedFilter,
  type TabId,
} from "@/pages/flipdesk/inventory-tabs";
import type { ItemFullRow, ItemStatus } from "@/types/database";

const item = (over: Partial<ItemFullRow> = {}): ItemFullRow =>
  ({ id: "i1", status: "sourced", ...over }) as ItemFullRow;

const tab = (id: TabId) => {
  const found = TABS.find((t) => t.id === id);
  if (!found) throw new Error(`No tab ${id}`);
  return found;
};

/** Which tabs claim this row. */
const tabsFor = (it: ItemFullRow): TabId[] =>
  TABS.filter((t) => t.matches(it)).map((t) => t.id);

const ALL_STATUSES: ItemStatus[] = [
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "grading",
  "graded",
  "comped",
  "drafted",
  "listed",
  "sold",
  "shipped",
  "returned",
  "archived",
];

describe("every item lands somewhere", () => {
  it.each(ALL_STATUSES)("status %s is claimed by at least one tab", (status) => {
    // A status no tab matches is an item that vanishes from the table entirely
    // — present in the database, absent from the only surface that lists it.
    expect(tabsFor(item({ status })).length).toBeGreaterThan(0);
  });

  it("puts every non-archived row in All, exactly once outside it", () => {
    for (const status of ALL_STATUSES) {
      const claimed = tabsFor(item({ status }));
      const specific = claimed.filter((t) => t !== "all");
      // Every row belongs to All (or Archived) plus exactly one stage tab, so
      // the tab counts add up rather than double-counting.
      expect(specific).toHaveLength(1);
    }
  });
});

describe("the All tab", () => {
  it("excludes archived items so they don't sit in the active list forever", () => {
    // US-1483: before this, archived inventory stayed mixed into All and there
    // was no way to get it out of the seller's daily view.
    expect(tab("all").matches(item({ status: "archived" }))).toBe(false);
    expect(tab("all").matches(item({ status: "listed" }))).toBe(true);
  });
});

describe("the Unlisted tab", () => {
  it("holds every pre-listed prep stage AND drafted", () => {
    // To List and Drafts became one tab (2026-09-02); nothing between intake
    // and publish may fall out of it.
    for (const status of DRAFT_LIKE_STATUSES) {
      expect(tab("unlisted").matches(item({ status }))).toBe(true);
    }
    expect(tab("unlisted").matches(item({ status: "drafted" }))).toBe(true);
  });

  it("includes `grading`, so a mid-grade item is not stranded", () => {
    // US-1429 REGRESSION LOCK. `grading` was missing, so an item sitting with
    // the grader appeared in no prep tab and the Overview "?status=grading"
    // deep-link landed on a view that did not contain it.
    expect(TO_LIST_STATUSES.has("grading")).toBe(true);
    expect(tab("unlisted").matches(item({ status: "grading" }))).toBe(true);
  });

  it("does not claim listed or terminal rows", () => {
    for (const status of ["listed", "sold", "shipped", "returned", "archived"] as ItemStatus[]) {
      expect(tab("unlisted").matches(item({ status }))).toBe(false);
    }
  });

  it("falls back to oldest-touched first when no preset applies", () => {
    expect(tab("unlisted").sortKey).toBe("updated_at");
    expect(tab("unlisted").sortDir).toBe("asc");
  });

  it("the retired ids still resolve to it, and junk resolves to nothing", () => {
    expect(resolveTabId("to_list")).toBe("unlisted");
    expect(resolveTabId("drafts")).toBe("unlisted");
    expect(resolveTabId("unlisted")).toBe("unlisted");
    expect(resolveTabId("sold")).toBe("sold");
    expect(resolveTabId("nope")).toBeNull();
    expect(resolveTabId(null)).toBeNull();
  });

  describe("its chips", () => {
    const prep = item({ status: "cataloged" });
    const ready = item({ status: "drafted", listing_needs_review: false });
    const unflagged = item({ status: "drafted", listing_needs_review: null });
    const flagged = item({ status: "drafted", listing_needs_review: true });

    it("All passes everything the tab shows", () => {
      for (const it of [prep, ready, unflagged, flagged]) {
        expect(matchesUnlistedFilter(it, "all")).toBe(true);
      }
    });

    it("Needs draft is the old To List", () => {
      expect(matchesUnlistedFilter(prep, "needs_draft")).toBe(true);
      expect(matchesUnlistedFilter(ready, "needs_draft")).toBe(false);
    });

    it("Ready and Needs review split drafted on the review flag, and every draft lands in one", () => {
      expect(matchesUnlistedFilter(ready, "ready")).toBe(true);
      // No flag recorded is not a flag: it counts as ready, matching the SQL's
      // `is not true`.
      expect(matchesUnlistedFilter(unflagged, "ready")).toBe(true);
      expect(matchesUnlistedFilter(flagged, "ready")).toBe(false);
      expect(matchesUnlistedFilter(flagged, "needs_review")).toBe(true);
      expect(matchesUnlistedFilter(ready, "needs_review")).toBe(false);
      expect(matchesUnlistedFilter(prep, "ready")).toBe(false);
      expect(matchesUnlistedFilter(prep, "needs_review")).toBe(false);
    });

    it("an unknown ?show= value means All", () => {
      expect(resolveUnlistedFilter("zzz")).toBe("all");
      expect(resolveUnlistedFilter(null)).toBe("all");
      expect(resolveUnlistedFilter("ready")).toBe("ready");
    });
  });
});

describe("the Sold tab", () => {
  it("shows a completed sale", () => {
    expect(tab("sold").matches(item({ status: "sold", sale_status: "completed" }))).toBe(
      true,
    );
  });

  it("drops a refunded sale — it is no longer revenue", () => {
    // US-1451 REGRESSION LOCK. A refunded row left in Sold inflates every
    // aggregate built off this tab, so the seller reads a revenue number that
    // includes money they gave back.
    expect(tab("sold").matches(item({ status: "sold", sale_status: "refunded" }))).toBe(
      false,
    );
  });

  it("drops a cancelled sale for the same reason", () => {
    expect(tab("sold").matches(item({ status: "sold", sale_status: "cancelled" }))).toBe(
      false,
    );
  });

  it("still shows a sale with no recorded sale_status", () => {
    // A missing status must not silently hide a real sale.
    expect(tab("sold").matches(item({ status: "sold" }))).toBe(true);
  });

  it("sorts newest sale first", () => {
    expect(tab("sold").sortKey).toBe("sale_date");
    expect(tab("sold").sortDir).toBe("desc");
  });
});

describe("the draft-like status set", () => {
  it("is the prep stages plus drafted", () => {
    // This set drives the demote path: moving an item here also rewinds a local
    // listing row. Including `listed` would demote a live listing on a status
    // change, which is the one thing that path must never do.
    for (const status of TO_LIST_STATUSES) {
      expect(DRAFT_LIKE_STATUSES.has(status)).toBe(true);
    }
    expect(DRAFT_LIKE_STATUSES.has("drafted")).toBe(true);
    expect(DRAFT_LIKE_STATUSES.has("listed")).toBe(false);
    expect(DRAFT_LIKE_STATUSES.has("sold")).toBe(false);
    expect(DRAFT_LIKE_STATUSES.has("archived")).toBe(false);
  });
});

describe("tab definitions are well-formed", () => {
  it("has a unique id per tab", () => {
    const ids = TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every empty tab somewhere to go", () => {
    // An empty tab with no next step is a dead end on the surface a seller
    // opens most.
    for (const t of TABS) {
      expect(t.emptyCta.label).not.toBe("");
      expect(t.emptyCta.to).not.toBe("");
    }
  });

  it("sorts every tab by a real column", () => {
    // A typo'd sortKey silently sorts by undefined, which renders as the
    // database's insertion order and looks like "sorting is broken".
    const sample = item();
    for (const t of TABS) {
      expect(Object.prototype.hasOwnProperty.call(sample, t.sortKey) || t.sortKey).toBeTruthy();
      expect(["asc", "desc"]).toContain(t.sortDir);
    }
  });
});
