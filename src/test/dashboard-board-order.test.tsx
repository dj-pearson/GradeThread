import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WidgetBoard } from "@/components/dashboard/widget-board";
import { normalize } from "@/lib/dashboard-layout";
import {
  defaultLayoutFor,
  widgetById,
  widgetsForSurface,
  type LayoutEntry,
} from "@/lib/dashboard-widgets";

// US-3075 AC6: the order a seller reads, asserted on what renders.
//
// DEFAULT_LAYOUTS is a list of ids and the own-data-first test already checks
// their order as data. This is the other half: that the board turns that list
// into frames in that order, with the titles a person sees. An id ordering that
// is right and a board that renders it wrong is the same bug to the seller.
//
// Widgets are React.lazy, so under renderToStaticMarkup each one suspends and
// its Suspense fallback renders instead. That is exactly what this test wants:
// the frame headings come from WidgetFrame, outside the boundary, so the order
// is asserted without loading thirteen widgets and their queries.

const registry = widgetsForSurface("grading");

function render(layout: readonly LayoutEntry[]): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WidgetBoard surface="grading" layout={layout} registry={registry} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The frame headings in the order they appear in the markup. */
function frameTitles(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]+)" data-widget-id=/g)].map(
    (m) => m[1]!,
  );
}

describe("the widget board renders the seller default in order", () => {
  it("puts the seller's own numbers above everything that sells them something", () => {
    const layout = defaultLayoutFor("grading", "seller");
    const expected = layout.map((entry) => widgetById(entry.id, registry)!.title);

    expect(frameTitles(render(layout))).toEqual(expected);
  });

  it("reads top to bottom as queue, attention, then the promotions", () => {
    // Spelled out rather than derived, so a reordering of DEFAULT_LAYOUTS has
    // to be a deliberate edit to this list too.
    expect(frameTitles(render(defaultLayoutFor("grading", "seller")))).toEqual([
      "Plan usage",
      "Grading queue",
      "Needs your attention",
      "Grade trends",
      "Recent submissions",
      "Listing suggestions",
      // US-3075 follow-up: restored to the defaults. AC1 registers this widget
      // and AC4's lists omit it, and following AC4 literally would have dropped
      // the Current Plan card off every existing seller's dashboard silently.
      // It sits LAST among the data widgets so the queue still opens the board.
      "Current plan",
      "Getting started",
      "Quick actions",
      "Rewards",
      "Try FlipDesk",
      "Discover GradeThread",
      "Invite a friend",
      "Circularity impact",
    ]);
  });

  it("renders the developer board without the widgets that persona is not offered", () => {
    expect(frameTitles(render(defaultLayoutFor("grading", "developer")))).toEqual([
      "Plan usage",
      "Grading queue",
      "Needs your attention",
      "Recent submissions",
      "Quick actions",
      "Garment passports",
    ]);
  });

  it("renders the buyer board as three frames", () => {
    expect(frameTitles(render(defaultLayoutFor("grading", "buyer")))).toEqual([
      "Quick actions",
      "Discover GradeThread",
      "Invite a friend",
    ]);
  });

  it("drops the FlipDesk promo from a board once the account has inventory", () => {
    // US-3075 AC5. Removed by normalize, not rendered quiet: a promotion for a
    // product you already use is finished, not empty.
    const withInventory = normalize(null, registry, "seller", {
      hasInventory: true,
    });
    expect(withInventory.map((e) => e.id)).not.toContain("grading.flipdesk-promo");
    expect(frameTitles(render(withInventory))).not.toContain("Try FlipDesk");

    // And it is still there for the seller who has none, including while the
    // count is still in flight.
    for (const context of [{}, { hasInventory: false }]) {
      const ids = normalize(null, registry, "seller", context).map((e) => e.id);
      expect(ids).toContain("grading.flipdesk-promo");
    }
  });
});
