// US-3309: first paint of the AutoLister queue table.
//
// The bug this pins is a LAYOUT bug, and a static render cannot measure pixels.
// What it can prove is the thing that made the pixels wrong: the row used to be
// one flex line where the title was the only flexible child, so every badge the
// page learned about took width from the title. These assertions hold the
// replacement's shape — a real table, a fixed set of columns, the badges inside
// the signals cell rather than as siblings of the title, and the reconcile
// panel absent until a row is opened.
//
// renderToStaticMarkup is the repo's convention (no @testing-library). Both
// breakpoints render into the markup (the table is `hidden md:block`, the cards
// are `md:hidden`), so a text assertion covers both unless it names a cell.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AutolisterJob } from "@/hooks/use-autolister";
import type { ItemMeta } from "@/pages/flipdesk/autolister/use-item-meta";
import type { ListingReview } from "@/pages/flipdesk/autolister/use-listing-review";

// ReconcilePanel runs its own query on expand. It is not what is under test and
// it drags the autolister hook graph in, so it is stubbed down to a marker.
vi.mock("@/components/flipdesk/reconcile-panel", () => ({
  ReconcilePanel: ({ itemId }: { itemId: string }) => (
    <div data-testid="reconcile">reconcile:{itemId}</div>
  ),
}));

const { QueueTable } = await import("@/pages/flipdesk/autolister/queue-table");
const { tierWord, money } = await import(
  "@/pages/flipdesk/autolister/queue-row-format"
);

function job(over: Partial<AutolisterJob> & { id: string }): AutolisterJob {
  return {
    inventory_item_id: `item-${over.id}`,
    listing_id: `listing-${over.id}`,
    status: "success",
    error: null,
    ...over,
  } as AutolisterJob;
}

function meta(over: Partial<ItemMeta> = {}): ItemMeta {
  return {
    title: "Levi's 501",
    qaScore: 92,
    qaIssues: [],
    hasMeasurements: true,
    category: null,
    status: null,
    brand: "Levi's",
    size: "34",
    garment: "jeans",
    measurements: { waist: 17 },
    ...over,
  };
}

function review(over: Partial<ListingReview> = {}): ListingReview {
  return {
    needsReview: false,
    fields: [],
    price: 48.5,
    title: "Levi's 501 Straight Leg Jeans Mens 34x32 Medium Wash",
    ...over,
  };
}

const LONG_TITLE =
  "Vintage Carhartt Duck Canvas Chore Coat Mens Large Brown Blanket Lined";

function paint(jobs: AutolisterJob[], over: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const itemMeta = Object.fromEntries(
    jobs.map((j) => [j.inventory_item_id, meta()]),
  );
  const reviewByListing = Object.fromEntries(
    jobs.filter((j) => j.listing_id).map((j) => [j.listing_id!, review()]),
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <QueueTable
          jobs={jobs}
          isRunning={false}
          ebayConnected
          titleOf={() => LONG_TITLE}
          tierOf={(j) => (j.status === "success" ? "green" : null)}
          itemMeta={itemMeta}
          coverByItem={{}}
          reviewByListing={reviewByListing}
          sizeConflicts={{}}
          preflightByItem={{}}
          publishResults={{}}
          selectedIds={new Set()}
          onToggleSelected={() => {}}
          onToggleSelectAll={() => {}}
          allInViewSelected={false}
          onApplySizeFix={() => {}}
          onEditPhotos={() => {}}
          {...over}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the queue is a table, not one flex line (US-3309)", () => {
  it("renders a table with a named column per thing the row shows", () => {
    const html = paint([job({ id: "a" })]);
    expect(html).toContain("<table");
    for (const header of ["Draft", "Signals", "Price", "State", "Actions"]) {
      expect(html).toContain(`>${header}<`);
    }
  });

  it("does not truncate the title to a single line", () => {
    // The failure this pins: `flex-1 truncate` on the title next to ten
    // shrink-0 badges. The title was the only child that could give up width,
    // so it gave up all of it.
    const html = paint([job({ id: "a" })]);
    expect(html).toContain(LONG_TITLE);
    expect(html).not.toContain("flex-1 truncate");
    expect(html).toContain("line-clamp-2");
  });

  it("keeps the badges inside the signals cell, not beside the title", () => {
    // Two badges on this draft: the photo score and Measured. Both must appear
    // after the Signals cell opens, which is what stops them competing with the
    // title for the same width.
    const html = paint([job({ id: "a" })]);
    const table = html.slice(html.indexOf("<table"));
    const titleAt = table.indexOf(LONG_TITLE);
    const photosAt = table.indexOf("Photos 92");
    const measuredAt = table.indexOf("Measured");
    expect(photosAt).toBeGreaterThan(titleAt);
    expect(measuredAt).toBeGreaterThan(titleAt);
  });

  it("shows the price the queue has always let you sort by", () => {
    // US-554 added a price sort in 2025 and the price itself was never on the
    // row, so the sort reordered by an invisible number.
    const html = paint([job({ id: "a" })]);
    expect(html).toContain("$48.50");
  });

  it("labels the confidence tier instead of only colouring a dot", () => {
    const html = paint([job({ id: "a" })]);
    expect(html).toContain("Ready");
  });

  it("says what state a draft is in, in words", () => {
    const html = paint([
      job({ id: "a", status: "pending" }),
      job({ id: "b", status: "running" }),
      job({ id: "c", status: "failed", error: "Model timed out" }),
    ]);
    expect(html).toContain("Queued");
    expect(html).toContain("Writing");
    expect(html).toContain("Model timed out");
  });

  it("keeps the reconcile panel out of every row until one is opened", () => {
    // It used to render collapsed under EVERY row: a second bordered box per
    // draft for a panel most sellers never open.
    const html = paint([job({ id: "a" }), job({ id: "b" })]);
    expect(html).not.toContain("reconcile:");
    expect(html).toContain("Reconcile against your record");
  });

  it("gives a still-generating row no reconcile chevron and no checkbox", () => {
    // There is nothing to reconcile against a draft that does not exist yet,
    // and nothing to publish either.
    const html = paint([job({ id: "a", status: "running" })]);
    expect(html).not.toContain("Reconcile against your record");
    // The header select-all is still there; it is the PER-ROW checkbox that
    // must be absent.
    expect(html).not.toContain(`Select ${LONG_TITLE}`);
  });

  it("offers select-all on the header checkbox", () => {
    const html = paint([job({ id: "a" })]);
    expect(html).toContain('aria-label="Select all drafts in view"');
  });
});

describe("queue row formatting", () => {
  it("names the tier rather than leaving it a colour", () => {
    expect(tierWord("green")).toBe("Ready");
    expect(tierWord("amber")).toBe("Needs review");
    // Red means generation failed; the State column already says so in detail.
    expect(tierWord("red")).toBeNull();
    expect(tierWord(null)).toBeNull();
  });

  it("shows an unpriced draft as unknown, never as free", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(0)).toBe("$0.00");
    expect(money(48.5)).toBe("$48.50");
  });
});
