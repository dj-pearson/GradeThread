// Row-level safety on the desktop inventory table (INV-4, INV-10).
//
// renderToStaticMarkup is the repo's convention (no @testing-library/react).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";

import { ListingsTable } from "@/pages/flipdesk/listings-table";
import { ItemCardList } from "@/components/flipdesk/item-card-list";
import { LISTINGS_COLUMN_LIST } from "@/pages/flipdesk/listings-columns";
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

describe("INV-10: a listing link is only a link when it is safe", () => {
  it("renders no anchor for a javascript: listing_url", () => {
    const html = render({
      tab: "active",
      isActive: true,
      isAged: false,
      pageRows: [row({ link: "javascript:alert(1)" } as Partial<ItemFullRow>)],
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Open the marketplace listing for");
  });

  it("keeps an https listing link", () => {
    const html = render({
      tab: "active",
      isActive: true,
      isAged: false,
      pageRows: [row({ link: "https://www.ebay.com/itm/1" } as Partial<ItemFullRow>)],
    });
    expect(html).toContain('href="https://www.ebay.com/itm/1"');
  });
});

describe("INV-10: the eBay relist button is for eBay rows", () => {
  const active = { tab: "active", isActive: true, isAged: false, ebayConnection: { id: "c1" } };
  it("shows on an eBay row", () => {
    const html = render(active as Partial<TableProps>);
    expect(html).toContain("as a new listing");
  });
  it("does not show on a Poshmark row", () => {
    const html = render({
      ...active,
      pageRows: [row({ listing_platform: "poshmark" } as Partial<ItemFullRow>)],
    } as Partial<TableProps>);
    expect(html).not.toContain("as a new listing");
  });
});

describe("INV-10: the mobile card", () => {
  const card = (over: Partial<ItemFullRow>) =>
    renderToStaticMarkup(
      <ItemCardList items={[row(over)]} onOpen={() => {}} />,
    );

  it("shows a live listing's price to the cent, labelled Listed", () => {
    const html = card({ list_price: 24.99, target_price: 30, listing_status: "active" } as Partial<ItemFullRow>);
    expect(html).toContain("$24.99");
    expect(html).toMatch(/\$24\.99<\/span>\s*<span[^>]*>Listed/);
  });

  it("shows the asking price, labelled Asking, when not live", () => {
    const html = card({ list_price: null, target_price: 30, listing_status: "draft" } as Partial<ItemFullRow>);
    expect(html).toMatch(/\$30\.00<\/span>\s*<span[^>]*>Asking/);
  });

  it("names an untitled draft by its listing title, not its id", () => {
    const html = card({
      item_title: "Untitled draft",
      listing_title: "Levi's 501 32x30",
    } as Partial<ItemFullRow>);
    expect(html).toContain("Levi&#x27;s 501 32x30");
  });
});

describe("INV-10: every row field the table, cards and format read is projected", () => {
  // A field read off a row but missing from LISTINGS_COLUMN_LIST renders blank
  // or, like garment_category did, silently changes an estimate.
  const NOT_ROW_FIELDS: Record<string, string> = {
    inventory_item_id: "listings-table reads it off extension-queue rows, not item rows",
  };
  const known = new Set<string>(LISTINGS_COLUMN_LIST);
  it.each([
    "src/pages/flipdesk/listings-table.tsx",
    "src/components/flipdesk/item-card-list.tsx",
    "src/pages/flipdesk/listings-format.ts",
  ])("%s", (file) => {
    const src = readFileSync(resolve(process.cwd(), file), "utf8");
    const read = new Set([...src.matchAll(/\b(?:it|row|item)\.([a-z_]+)\b/g)].map((m) => m[1]!));
    const missing = [...read].filter((f) => !known.has(f) && !(f in NOT_ROW_FIELDS));
    expect(missing).toEqual([]);
  });
});
