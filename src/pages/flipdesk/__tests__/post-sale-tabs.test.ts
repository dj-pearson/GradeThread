import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_SALE_TAB,
  POST_SALE_TABS,
  postSaleTabCounts,
  resolvePostSaleTabId,
  tabForKind,
} from "@/pages/flipdesk/post-sale-tabs";
import type { NeedsYouItem, NeedsYouKind } from "@/pages/flipdesk/needs-you";

const item = (kind: NeedsYouKind, id: string): NeedsYouItem => ({
  kind,
  id,
  subject: "A jacket",
  deadline: null,
  amountCents: null,
  action: "Respond",
});

describe("post-sale tabs (US-3208)", () => {
  it("Ship is the default, because it is the clock eBay scores you on", () => {
    // A late shipment is a defect on the account. A slow return is a slow
    // return. If one tab has to open first, it is this one.
    expect(DEFAULT_POST_SALE_TAB).toBe("ship");
    expect(POST_SALE_TABS[0]!.id).toBe("ship");
  });

  it("every queue this page shows has exactly one tab", () => {
    // The failure this pins: a kind owned by two tabs would be double-counted
    // in the badges, and a kind owned by none would be work with no way in.
    const owners = (kind: NeedsYouKind) =>
      POST_SALE_TABS.filter((t) => t.kinds.includes(kind));
    for (const kind of [
      "shipment",
      "dispute",
      "case",
      "inquiry",
      "return",
      "cancellation",
    ] as const) {
      expect(owners(kind).length, kind).toBe(1);
    }
  });

  it("offers belong to another page and are deliberately unowned", () => {
    // Routing them here would put a number on a tab that cannot show them.
    expect(tabForKind("offer")).toBeNull();
  });

  it("cases and item-not-received share one tab", () => {
    // eBay files them separately; a seller does not think of them as two jobs,
    // and split apart they were two cards that were each usually empty.
    expect(tabForKind("case")).toBe("cases");
    expect(tabForKind("inquiry")).toBe("cases");
  });

  it("counts each tab off the same list the tab opens", () => {
    const counts = postSaleTabCounts([
      item("shipment", "s1"),
      item("shipment", "s2"),
      item("case", "c1"),
      item("inquiry", "i1"),
      item("return", "r1"),
      // Not this page's work: it must not land in a default bucket.
      item("offer", "o1"),
    ]);
    expect(counts.ship).toBe(2);
    expect(counts.cases).toBe(2);
    expect(counts.returns).toBe(1);
    expect(counts.disputes).toBe(0);
    expect(counts.cancellations).toBe(0);
    // Insights is a chart of what already happened. "Waiting on you" is not a
    // question it answers, so it counts nothing rather than counting zero
    // things and showing a badge.
    expect(counts.insights).toBe(0);
    expect(POST_SALE_TABS.find((t) => t.id === "insights")!.kinds).toEqual([]);
  });

  it("an empty list is six zeros, not a missing key", () => {
    // The badge code indexes every tab, so a missing key would render
    // "undefined" rather than nothing.
    const counts = postSaleTabCounts([]);
    for (const t of POST_SALE_TABS) expect(counts[t.id]).toBe(0);
  });

  it("resolves a tab id, and rejects one that names nothing", () => {
    expect(resolvePostSaleTabId("returns")).toBe("returns");
    expect(resolvePostSaleTabId("insights")).toBe("insights");
    expect(resolvePostSaleTabId("nonsense")).toBeNull();
    expect(resolvePostSaleTabId(null)).toBeNull();
    expect(resolvePostSaleTabId("")).toBeNull();
  });

  it("an old card anchor still lands on the work", () => {
    // The stacked page gave each card a DOM id and linked to it with a hash, so
    // "#payment-disputes" is a URL somebody may have bookmarked. It has to open
    // the tab that now holds that card rather than a page that scrolls nowhere.
    expect(resolvePostSaleTabId("#payment-disputes")).toBe("disputes");
    expect(resolvePostSaleTabId("payment-disputes")).toBe("disputes");
    expect(resolvePostSaleTabId("#cancellations")).toBe("cancellations");
    expect(resolvePostSaleTabId("ship-queue")).toBe("ship");
    expect(resolvePostSaleTabId("return-analytics")).toBe("insights");
  });

  it("stays small enough to be a tab bar", () => {
    // The whole point was that seven stacked sections do not fit on a screen.
    // Six tabs wrap to two rows on a phone; ten would be the same problem in a
    // different shape, so the next one added is a decision, not a drift.
    expect(POST_SALE_TABS.length).toBeLessThanOrEqual(6);
    expect(new Set(POST_SALE_TABS.map((t) => t.id)).size).toBe(
      POST_SALE_TABS.length,
    );
  });
});
