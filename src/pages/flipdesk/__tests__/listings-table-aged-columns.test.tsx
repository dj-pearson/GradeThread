// US-3195 AC2: the Aged tab renders the five figures the story promises.
//
// WHY A RENDER TEST AND NOT A SOURCE SCAN. The Aged tab existed, the server
// filter existed, the threshold existed — and the tab showed Cost / Target /
// Sale / Net, because the column block that carries days-listed, views and
// watchers was gated on `isActive` and `isActive` is `tab === "active"`. Every
// piece was in the tree and the screen still answered the wrong question. Only
// rendering the thing catches that.
//
// renderToStaticMarkup is the repo's convention (no @testing-library/react).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";

import { ListingsTable } from "@/pages/flipdesk/listings-table";
import type { ItemFullRow } from "@/types/database";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const row = (over: Partial<ItemFullRow> = {}): ItemFullRow =>
  ({
    id: "i1",
    user_id: "u1",
    item_title: "Nike Windbreaker",
    item_number: "SKU-1",
    brand: "Nike",
    size: "M",
    status: "listed",
    list_date: daysAgo(137),
    updated_at: daysAgo(2),
    created_at: daysAgo(200),
    list_price: 48,
    purchase_price: 12.5,
    floor_price: 30,
    listing_views: 411,
    listing_watchers: 7,
    listing_id: "L1",
    listing_status: "active",
    listing_platform: "ebay",
    comps: [],
    ...over,
  }) as unknown as ItemFullRow;

type TableProps = Parameters<typeof ListingsTable>[0];

function props(over: Partial<TableProps> = {}): TableProps {
  const noop = () => {};
  const async0 = () => Promise.resolve();
  return {
    pageRows: [row()],
    tab: "aged",
    isActive: false,
    isShipped: false,
    isSold: false,
    isUnlisted: false,
    isAged: true,
    selectable: true,
    selected: new Set<string>(),
    allOnPageSelected: false,
    toggleSelected: noop,
    toggleSelectAll: noop,
    columnSort: null,
    toggleColumnSort: noop,
    tableScrollRef: createRef<HTMLDivElement>(),
    virtualize: false,
    virtualItems: [],
    // Only reached while `virtualize` is true, which it is not here.
    rowVirtualizer: { measureElement: noop } as unknown as TableProps["rowVirtualizer"],
    vPadTop: 0,
    vPadBottom: 0,
    platformsByItem: new Map(),
    draftMetaByItem: new Map(),
    publishIssuesByItem: new Map(),
    coverByItem: new Map(),
    metricsByItem: new Map(),
    qualityByListing: new Map(),
    scoreById: new Map(),
    buyerCounts: new Map(),
    updateTracking: async0,
    updateListingPrice: async0,
    updateItemStatus: async0,
    updateItemMoney: async0,
    updateItemNotes: async0,
    markDelivered: async0,
    setPublishItem: noop,
    setMarkListedItem: noop,
    setRecordSaleItem: noop,
    setShipItem: noop,
    setEndTarget: noop,
    setDeleteTarget: noop,
    ebayConnection: null,
    navigate: noop as unknown as TableProps["navigate"],
    ...over,
  } as TableProps;
}

function render(over: Partial<TableProps> = {}): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ListingsTable {...props(over)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("US-3195 AC2: the Aged tab's columns", () => {
  it("names all six aged headers", () => {
    const html = render();
    for (const header of [
      "Days listed",
      "Views",
      "Watchers",
      "Cost",
      "Price",
      "Floor",
    ]) {
      expect(html, header).toContain(header);
    }
  });

  it("shows the numbers, not just the headings", () => {
    const html = render();
    expect(html).toContain("137"); // days listed
    expect(html).toContain("411"); // views
    expect(html).toContain("7"); // watchers
    expect(html).toContain("12.50"); // cost basis
    expect(html).toContain("48"); // current price
    expect(html).toContain("30.00"); // floor price
  });

  it("says a floor is unset rather than printing it as zero", () => {
    // A missing floor is the absence of a floor, not a floor of $0.00 — the
    // same rule the bulk markdown applies when it decides whether to refuse.
    const html = render({ pageRows: [row({ floor_price: null })] });
    expect(html).not.toContain("$0.00");
  });

  it("does NOT show the sold-tab money columns it used to fall through to", () => {
    // The generic branch this tab used to land on renders Target / List, Sale
    // and Net — four columns about a sale that has not happened.
    const html = render();
    expect(html).not.toContain("Target / List");
    expect(html).not.toContain(">Sale<");
  });

  it("renders exactly as many cells as it renders headers", () => {
    // The header and the body are two separate conditional chains over the same
    // flags. Every tab on this table adds its columns to both by hand, so the
    // failure this catches is a row shifted one column left for the whole tab.
    for (const [name, over] of [
      ["aged", {}],
      ["active", { tab: "active", isActive: true, isAged: false }],
      ["unlisted", { tab: "unlisted", isUnlisted: true, isAged: false }],
      ["sold", { tab: "sold", isSold: true, isAged: false }],
      ["all", { tab: "all", isAged: false, selectable: false }],
    ] as const) {
      const html = render(over as Partial<TableProps>);
      const heads = (html.match(/<th[ >]/g) ?? []).length;
      const cells = (html.match(/<td[ >]/g) ?? []).length;
      expect(cells, `${name}: ${heads} headers vs ${cells} cells`).toBe(heads);
    }
  });

  it("leaves the Active tab exactly as it was", () => {
    // The cheap fix here was to widen `isActive`. This is what would have
    // caught it: Active keeps Impressions and CTR, which Aged does not carry.
    const active = render({
      tab: "active",
      isActive: true,
      isAged: false,
    });
    expect(active).toContain("Impr.");
    expect(active).toContain("CTR");
    expect(active).not.toContain("Floor");
    // And the Aged tab does not grow them.
    const aged = render();
    expect(aged).not.toContain("Impr.");
    expect(aged).not.toContain("CTR");
  });
});
