import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WidgetBoard } from "@/components/dashboard/widget-board";
import { FlipdeskStaleWidget } from "@/components/dashboard/widgets/flipdesk-stale";
import {
  DEFAULT_LAYOUTS,
  defaultLayoutFor,
  widgetById,
  widgetsForSurface,
  widgetWindowPhrase,
  type LayoutEntry,
} from "@/lib/dashboard-widgets";
import { overviewRangeDef } from "@/lib/overview-range";
import type { OverviewMetrics } from "@/hooks/use-flipdesk-overview";

// US-3076: the FlipDesk Overview as a board.
//
// Three claims that nothing else covers. The old page's twelve blocks are
// pinned by src/test/overview-stage-and-range.test.ts, which was rewritten to
// follow the markup into the widget modules; this file is about the board
// itself: what the page renders, what each frame says about the window it is
// showing, and that a nudge a seller waved away stays away.

const registry = widgetsForSurface("flipdesk");
const OVERVIEW = "src/pages/flipdesk/overview.tsx";

function page(): string {
  return readFileSync(resolve(process.cwd(), OVERVIEW), "utf8");
}

describe("the page is a header and a board (US-3076 AC1)", () => {
  it("renders the customizable board and no second header", () => {
    const src = page();
    expect(src).toContain('<CustomizableWidgetBoard');
    expect(src).toContain('surface="flipdesk"');
    // CustomizableWidgetBoard renders PageHeader itself, so the range picker,
    // Import and Add item go through it as `actions` and the Customize button
    // is appended there. A PageHeader here would be two headers on one page.
    expect(src).not.toContain("<PageHeader");
    expect(src).not.toContain('from "@/components/ui/page-header"');
  });

  it("keeps the range picker, Import and Add item as the page's own actions", () => {
    const src = page();
    expect(src).toContain('aria-label="Reporting period"');
    expect(src).toContain("/dashboard/flipdesk/import");
    expect(src).toContain("/dashboard/flipdesk/intake");
    // And does NOT add its own Customize control beside them: the board
    // appends that one itself, and two of them is two ways to edit one board.
    expect(src).not.toMatch(/>\s*Customize\s*</);
    expect(src).not.toContain("Settings2");
  });

  it("draws none of the twelve blocks itself any more", () => {
    const src = page();
    for (const gone of [
      "NorthStarCard",
      "CommunityInsightsWidget",
      "FLIPDESK_PIPELINE",
      "StatCard",
      "StaleNudge",
      "ShowAllToggle",
      "useFlipdeskOverview",
    ]) {
      expect(src, `${gone} is still drawn by the page`).not.toContain(gone);
    }
  });
});

describe("the shipped board (US-3076 AC4)", () => {
  it("registers all thirteen widgets", () => {
    expect(registry.map((w) => w.id)).toEqual([
      "flipdesk.north-star",
      "flipdesk.stat-items",
      "flipdesk.stat-listed",
      "flipdesk.stat-sold",
      "flipdesk.stat-net",
      "flipdesk.stat-time-saved",
      "flipdesk.stat-review-median",
      "flipdesk.pipeline",
      "flipdesk.aging",
      "flipdesk.stale",
      "flipdesk.top-brands",
      "flipdesk.recent-sales",
      "flipdesk.community-insights",
    ]);
  });

  it("allows exactly the sizes the story fixes", () => {
    const expected: Record<string, { sizes: string[]; def: string }> = {
      "flipdesk.north-star": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.stat-items": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.stat-listed": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.stat-sold": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.stat-net": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.stat-time-saved": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.stat-review-median": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.pipeline": { sizes: ["md", "lg"], def: "lg" },
      "flipdesk.aging": { sizes: ["md", "lg"], def: "md" },
      "flipdesk.stale": { sizes: ["md", "lg"], def: "md" },
      "flipdesk.top-brands": { sizes: ["md", "lg"], def: "md" },
      "flipdesk.recent-sales": { sizes: ["md", "lg"], def: "md" },
      "flipdesk.community-insights": { sizes: ["md", "lg"], def: "md" },
    };
    for (const [id, want] of Object.entries(expected)) {
      const def = widgetById(id, registry)!;
      expect(def.sizes, id).toEqual(want.sizes);
      expect(def.defaultSize, id).toBe(want.def);
    }
  });

  it("opens in the order the story fixes, at the shipped sizes", () => {
    expect(defaultLayoutFor("flipdesk", "seller")).toEqual([
      { id: "flipdesk.north-star", size: "sm" },
      { id: "flipdesk.stat-items", size: "sm" },
      { id: "flipdesk.stat-listed", size: "sm" },
      { id: "flipdesk.stat-sold", size: "sm" },
      { id: "flipdesk.stat-net", size: "sm" },
      { id: "flipdesk.stat-time-saved", size: "sm" },
      { id: "flipdesk.stat-review-median", size: "sm" },
      { id: "flipdesk.pipeline", size: "lg" },
      { id: "flipdesk.aging", size: "md" },
      { id: "flipdesk.stale", size: "md" },
      { id: "flipdesk.top-brands", size: "md" },
      { id: "flipdesk.recent-sales", size: "md" },
      { id: "flipdesk.community-insights", size: "md" },
    ]);
  });

  it("gives consignment and developer the same board and a buyer none", () => {
    expect(DEFAULT_LAYOUTS.flipdesk.consignment).toEqual(
      DEFAULT_LAYOUTS.flipdesk.seller,
    );
    expect(DEFAULT_LAYOUTS.flipdesk.developer).toEqual(
      DEFAULT_LAYOUTS.flipdesk.seller,
    );
    // A buyer has no FlipDesk, and the catalog is not allowed to offer one
    // either (src/test/dashboard-layout-edit.test.ts holds that shut).
    expect(DEFAULT_LAYOUTS.flipdesk.buyer).toEqual([]);
    for (const def of registry) expect(def.personas).not.toContain("buyer");
  });
});

/** The window each frame declares, by widget id. */
function frameWindows(html: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const chunk of html.split('data-widget-id="').slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const match =
      /<\/h3>(?:<p class="text-xs text-muted-foreground">([^<]*)<\/p>)?/.exec(chunk);
    out[id] = match?.[1];
  }
  return out;
}

function renderBoard(layout: readonly LayoutEntry[], range?: "d7" | "d30"): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WidgetBoard
          surface="flipdesk"
          layout={layout}
          registry={registry}
          range={range}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("every frame says which window it is showing (US-3076 AC3)", () => {
  it("gives a range-aware widget the picker's phrase", () => {
    const windows = frameWindows(renderBoard(defaultLayoutFor("flipdesk", "seller"), "d30"));
    const phrase = overviewRangeDef("d30").phrase;
    expect(phrase).toBe("in the last 30 days");
    for (const id of [
      "flipdesk.stat-listed",
      "flipdesk.stat-sold",
      "flipdesk.stat-net",
      "flipdesk.top-brands",
      "flipdesk.recent-sales",
    ]) {
      expect(windows[id], id).toBe(phrase);
      expect(widgetById(id, registry)!.rangeAware, id).toBe(true);
    }
  });

  it("says 'right now' on the four that are snapshots", () => {
    const windows = frameWindows(renderBoard(defaultLayoutFor("flipdesk", "seller"), "d30"));
    for (const id of [
      "flipdesk.pipeline",
      "flipdesk.aging",
      "flipdesk.stale",
      "flipdesk.north-star",
    ]) {
      expect(windows[id], id).toBe("right now");
    }
  });

  // The story's parenthetical names four snapshots and treats every other tile
  // as range-aware. Three of them are neither. "Time saved" is a calendar
  // month, "Photos to Approve" is a median over everything ever reviewed, and
  // the community benchmark is twelve months of other people's sales, so
  // stamping the picker's phrase on any of the three prints "in the last 30
  // days" over a number that is nothing of the sort. Each says what it actually
  // covers instead, which is the point AC3 is making.
  it("lets a fixed-window widget name its own window rather than lie either way", () => {
    const windows = frameWindows(renderBoard(defaultLayoutFor("flipdesk", "seller"), "d30"));
    expect(windows["flipdesk.stat-time-saved"]).toBe("this month");
    expect(windows["flipdesk.stat-review-median"]).toBe(
      "across every item you have reviewed",
    );
    expect(windows["flipdesk.community-insights"]).toBe(
      "across the last 12 months of community sales",
    );
    // Total items is a live count and a live valuation: "right now" is true.
    expect(windows["flipdesk.stat-items"]).toBe("right now");
  });

  it("says nothing at all on a board with no picker", () => {
    // The grading dashboard has no range, so every frame there covers the same
    // thing and thirteen lines saying so would be noise.
    for (const def of widgetsForSurface("grading")) {
      expect(widgetWindowPhrase(def, undefined), def.id).toBeNull();
    }
    const html = renderToStaticMarkup(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <WidgetBoard
            surface="grading"
            layout={defaultLayoutFor("grading", "seller")}
            registry={widgetsForSurface("grading")}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(Object.values(frameWindows(html)).every((w) => w === undefined)).toBe(true);
  });
});

// AC5: the stale nudge, driven for real.
//
// renderToStaticMarkup cannot press a button, and the claim here is about what
// survives a remount, so this one mounts into jsdom. No @testing-library in
// this repo, so it is createRoot + act directly, which is all the test needs.

const NUDGE_TEXT = "Grade this item to add a verified condition badge";

const STALE_METRICS: OverviewMetrics = {
  total: 2,
  byStatus: {},
  inventoryValue: 0,
  listedInRange: 0,
  soldInRange: 0,
  grossInRange: 0,
  netInRange: 0,
  agingCount: 0,
  agingItems: [],
  staleCount: 2,
  staleListings: [
    {
      id: "item-1",
      item_title: "Patagonia Better Sweater",
      brand: "Patagonia",
      list_price: 60,
      grade_value: null,
      days: 21,
    },
    {
      id: "item-2",
      item_title: "Arc'teryx Atom LT",
      brand: "Arc'teryx",
      list_price: 140,
      grade_value: null,
      days: 30,
    },
  ],
  topBrands: [],
  recentSales: [],
  listWeeks: [],
  lifetimeListed: 0,
};

/** A client with both of the stale widget's reads already answered. */
function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The same key useFlipdeskOverview builds: no signed-in user in a unit test,
  // so the user id slot is undefined.
  client.setQueryData(["items_full", "overview_metrics", undefined, "d7"], STALE_METRICS);
  client.setQueryData(["repricing_suggestions"], []);
  return client;
}

describe("a dismissed stale nudge stays dismissed (US-3076 AC5)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
  });

  function mount(): void {
    root = createRoot(container);
    const client = seededClient();
    act(() => {
      root!.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <FlipdeskStaleWidget size="md" surface="flipdesk" range="d7" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  }

  function unmount(): void {
    if (!root) return;
    act(() => root!.unmount());
    root = null;
  }

  function nudgeCount(): number {
    return container.querySelectorAll('[aria-label="Dismiss nudge"]').length;
  }

  it("hides only the nudge that was dismissed, and remembers after a remount", () => {
    mount();

    // Both stale listings are ungraded, so both carry the grade-it nudge.
    expect(container.textContent).toContain("Patagonia Better Sweater");
    expect(container.textContent).toContain(NUDGE_TEXT);
    expect(nudgeCount()).toBe(2);

    const first = container.querySelector('[aria-label="Dismiss nudge"]')!;
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // One gone, one left: dismissal is per item, not per widget.
    expect(nudgeCount()).toBe(1);
    // And the row itself is still there. Dismissing the advice is not
    // dismissing the listing it was about.
    expect(container.textContent).toContain("Patagonia Better Sweater");

    // Persisted under the key it has always used, so a seller who dismissed
    // one before this story moved the markup does not get it back.
    expect(
      JSON.parse(localStorage.getItem("gt:flipdesk:stale-nudge-dismissed") ?? "[]"),
    ).toEqual(["item-1"]);

    unmount();
    mount();

    expect(container.textContent).toContain("Patagonia Better Sweater");
    expect(nudgeCount()).toBe(1);
  });
});
