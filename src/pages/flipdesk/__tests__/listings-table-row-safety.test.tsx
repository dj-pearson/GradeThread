// Row-level safety on the desktop inventory table (INV-4, INV-10).
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

describe("INV-4: row Delete follows the workspace role", () => {
  it("offers Delete to an admin or owner", () => {
    const html = render({ tab: "unlisted", isUnlisted: true, isAged: false });
    expect(html).toContain('aria-label="Delete ');
  });

  it("hides Delete from a role the server would refuse", () => {
    const html = render({ tab: "unlisted", isUnlisted: true, isAged: false, canDelete: false });
    expect(html).not.toContain('aria-label="Delete ');
  });
});
