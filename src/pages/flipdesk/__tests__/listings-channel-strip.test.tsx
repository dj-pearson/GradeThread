// US-3451: the channel strip on the listings table.
//
// A render test, for the same reason as listings-table-aged-columns: the
// column, the query and the derivation can each exist and the row can still
// show the wrong thing. renderToStaticMarkup is the repo's convention.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ChannelStrip } from "@/components/flipdesk/channel-strip";
import type { PlatformChip } from "@/pages/flipdesk/listings-page-queries";
import type { ExtensionQueueItem } from "@/hooks/use-extension-queue";

const chip = (over: Partial<PlatformChip>): PlatformChip => ({
  id: "l1",
  platform: "ebay",
  status: "active",
  origin: "gradethread",
  listing_url: null,
  delist_requested_at: null,
  listed_unconfirmed: false,
  updated_at: "2026-09-20T00:00:00Z",
  ...over,
});

const job = (over: Partial<ExtensionQueueItem>): ExtensionQueueItem => ({
  id: "q1",
  kind: "list",
  platform: "poshmark",
  inventory_item_id: "i1",
  listing_id: null,
  payload: {},
  status: "queued",
  attempts: 0,
  source: "web",
  claimed_at: null,
  completed_at: null,
  result: null,
  expires_at: "2026-09-30T00:00:00Z",
  created_at: "2026-09-21T00:00:00Z",
  ...over,
});

function render(chips: PlatformChip[], queueItems: ExtensionQueueItem[] = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChannelStrip itemId="i1" chips={chips} queueItems={queueItems} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChannelStrip (US-3451)", () => {
  it("renders one dot per channel with the state as its accessible label", () => {
    const html = render(
      [
        chip({ id: "l1", platform: "ebay", status: "active", listing_url: "https://www.ebay.com/itm/1" }),
        chip({ id: "l2", platform: "mercari", status: "ended" }),
      ],
      [job({ platform: "poshmark" })],
    );
    expect(html).toContain('aria-label="eBay: live. View on eBay."');
    expect(html).toContain('aria-label="Poshmark: queued for your desktop. Cancel the queued Poshmark listing."');
    expect(html).toContain('aria-label="Mercari: ended"');
    // Three dots, no more: the item has three channels.
    expect(html.match(/aria-hidden="true"/g)?.length).toBe(3);
  });

  it("offers the link on a row with a URL, End on a live row without one, and no verb on ended or sold", () => {
    const html = render([
      chip({ id: "l1", platform: "ebay", status: "active", listing_url: "https://www.ebay.com/itm/1" }),
      chip({ id: "l2", platform: "poshmark", status: "active" }),
      chip({ id: "l3", platform: "mercari", status: "sold" }),
    ]);
    expect(html).toContain('href="https://www.ebay.com/itm/1"');
    expect(html).toContain("End the Poshmark listing");
    expect(html).toContain('aria-label="Mercari: sold here"');
    expect(html).not.toContain("End the Mercari listing");
    expect(html.match(/<button/g)?.length).toBe(1);
  });

  it("reads an ended row with a delist stamp as still ending, the state a seller most needs", () => {
    const html = render([
      chip({ id: "l2", platform: "poshmark", status: "ended", delist_requested_at: "2026-09-21T01:00:00Z" }),
    ]);
    expect(html).toContain("Poshmark: ending from your browser");
  });

  it("renders nothing for an item with no channel rows and no jobs", () => {
    expect(render([])).toBe("");
  });

  it("makes no request of its own (AC2): the dots come from the page's rows and the queue", () => {
    const src = readFileSync("src/components/flipdesk/channel-strip.tsx", "utf8");
    expect(src).not.toContain("supabase");
    expect(src).not.toContain("edgeFetch");
    expect(src).not.toContain("useQuery(");
    // The table hands it the page-scoped chips and the one queue read.
    const table = readFileSync("src/pages/flipdesk/listings-table.tsx", "utf8");
    expect(table).toContain("useExtensionQueue(isUnlisted || isActive)");
    expect(table).toContain("chips={platformsByItem?.get(it.id) ?? []}");
    // The four columns the derivation needs ride the existing chip request.
    const queries = readFileSync("src/pages/flipdesk/listings-page-queries.ts", "utf8");
    expect(queries).toContain("listed_unconfirmed:platform_fields->>listed_unconfirmed");
    expect(queries).toContain('"draft", "active", "sold", "ended"');
  });

  it("hides the column below md so the phone layout does not grow (AC4)", () => {
    const table = readFileSync("src/pages/flipdesk/listings-table.tsx", "utf8");
    expect(table).toContain('<TableHead className="hidden w-36 md:table-cell">Channels</TableHead>');
    expect(table).toContain('<TableCell className="hidden md:table-cell" onClick={(e) => e.stopPropagation()}>');
  });
});
