import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { FLIPDESK_PIPELINE } from "@/lib/constants";
import {
  statusParamToTab,
  stageFilterStatusFromParam,
  TABS,
  TO_LIST_STATUSES,
} from "@/pages/flipdesk/inventory-tabs";
import {
  OVERVIEW_RANGES,
  DEFAULT_OVERVIEW_RANGE,
  isOverviewRangeId,
  overviewRangeBounds,
  overviewRangeDef,
} from "@/lib/overview-range";
import { computeNorthStar, computeNorthStarFromWeeks } from "@/lib/north-star";
import type { ItemFullRow, ItemStatus } from "@/types/database";

// US-2547. The Overview told the seller "click a stage to filter the items
// view", then handed eight of the nine pre-listed stages to one tab that shows
// all of them — a tile reading "Measured 12" opened a list of every unlisted
// item. The same page derived twelve numbers by looping the whole account in the
// browser, offered no date range at all, and previewed five of N stuck items
// with no way to see the rest.

const OVERVIEW = "src/pages/flipdesk/overview.tsx";
const LISTINGS = "src/pages/flipdesk/listings.tsx";
const MIGRATION = "supabase/migrations/00594_flipdesk_overview_metrics.sql";

// US-3076 moved the Overview's twelve blocks out of one page and into thirteen
// widget modules. Every claim below is about the OVERVIEW, not about a file, so
// the source-reading assertions read the page PLUS every widget the board
// renders on it rather than chasing the markup from one filename to the next.
// The directory is listed at run time, so a widget a later story adds is
// covered without anyone remembering to name it here.
const WIDGET_DIR = "src/components/dashboard/widgets";
const AGING = `${WIDGET_DIR}/flipdesk-aging.tsx`;
const PIPELINE = `${WIDGET_DIR}/flipdesk-pipeline.tsx`;

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** The page and every FlipDesk widget on its board, concatenated. */
function overviewSources(): string {
  const widgets = readdirSync(resolve(process.cwd(), WIDGET_DIR))
    .filter((f) => f.startsWith("flipdesk-") && f.endsWith(".tsx"))
    .sort()
    .map((f) => `${WIDGET_DIR}/${f}`);
  // The widgets are the point of these guards, so an empty glob is a broken
  // guard rather than a clean page: a rename would otherwise turn every
  // "the overview does not do X" assertion into a test of one 80-line file.
  expect(widgets.length, "no flipdesk widgets found to scan").toBeGreaterThanOrEqual(
    11,
  );
  return [OVERVIEW, ...widgets].map(read).join("\n");
}

describe("a stage tile opens that stage (US-2547 AC1, AC2)", () => {
  it("every pipeline stage resolves to a view of exactly that stage", () => {
    // The property, stated once: either the tab the link lands on IS that
    // status, or the link carries a narrowing the destination applies. A stage
    // that satisfies neither is a tile promising a filter nobody can honour.
    const broken: string[] = [];
    for (const step of FLIPDESK_PIPELINE) {
      const tab = statusParamToTab(step.status);
      expect(tab, `no tab for ?status=${step.status}`).not.toBeNull();
      const def = TABS.find((t) => t.id === tab)!;
      const exact = matchesOnly(def.matches, step.status);
      const narrowed = stageFilterStatusFromParam(step.status) === step.status;
      if (!exact && !narrowed) broken.push(`${step.status} -> ${tab}`);
    }
    expect(
      broken,
      "these tiles land on a list wider than the count they showed:\n  " +
        broken.join("\n  "),
    ).toEqual([]);
  });

  it("the narrowing is only for the stages a tab folds together", () => {
    // Every tab other than Unlisted already IS one status; adding a redundant
    // filter rule there would put a chip on screen that removes nothing.
    for (const s of ["listed", "sold", "shipped", "returned", "archived", "all"]) {
      expect(stageFilterStatusFromParam(s), s).toBeNull();
    }
    for (const s of TO_LIST_STATUSES) {
      expect(stageFilterStatusFromParam(s), s).toBe(s);
    }
    // `drafted` shares Unlisted with the prep stages since the To List and
    // Drafts tabs merged, so a Drafted tile needs the narrowing too.
    expect(stageFilterStatusFromParam("drafted")).toBe("drafted");
    expect(stageFilterStatusFromParam(null)).toBeNull();
    expect(stageFilterStatusFromParam("not-a-status")).toBeNull();
  });

  it("the items table seeds the visible filter from ?status=", () => {
    const src = read(LISTINGS);
    expect(src).toContain("stageFilterStatusFromParam");
    // Seeded into filterQuery — the filter the seller can SEE and clear, and
    // the one the server-side RPC already applies. A second hidden predicate
    // would leave the chip count and the rows disagreeing.
    const seed = src.slice(src.indexOf("const [filterQuery, setFilterQuery]"));
    expect(seed.slice(0, 1400)).toContain('field: "status"');
    expect(seed.slice(0, 1400)).toContain('op: "eq"');
  });

  it("the tile copy no longer promises something else", () => {
    expect(read(PIPELINE)).not.toContain("Click a stage to filter the items view");
    expect(overviewSources()).not.toContain(
      "Click a stage to filter the items view",
    );
  });
});

describe("the numbers are aggregated server-side (US-2547 AC3)", () => {
  it("the overview does not read the whole item list any more", () => {
    const src = overviewSources();
    expect(src).not.toContain("useItemsList");
    expect(src).not.toContain("use-items-full");
    // US-3076 AC2: and no widget goes around the aggregate to a per-row table
    // for a figure the aggregate already returned.
    expect(src).not.toContain('from("items_full")');
    expect(src).not.toContain('from("inventory_items")');
  });

  it("it asks one RPC for the summary", () => {
    const src = overviewSources();
    expect(src).toContain("useFlipdeskOverview");
    const hook = read("src/hooks/use-flipdesk-overview.ts");
    expect(hook).toContain("flipdesk_overview_metrics");
    // Under the items_full key prefix, so the existing invalidations after a
    // sale / status change / import refresh the overview too.
    expect(hook).toContain('queryKey: ["items_full", "overview_metrics"');
  });

  it("the aggregate is SECURITY INVOKER, so RLS still scopes it", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("security invoker");
    expect(sql).not.toMatch(/security\s+definer/i);
    expect(sql).toContain("revoke all on function public.flipdesk_overview_metrics");
    // US-1108: idempotent + self-recording.
    expect(sql).toContain("create or replace function");
    expect(sql).toContain(
      "insert into public.applied_migrations (version) values ('00594')",
    );
  });

  it("the edge expects at least the schema this story added", () => {
    // Asserted as >=, not ==: pinning the exact value makes every later
    // migration edit this test, and a guard everyone edits is a guard nobody
    // reads.
    const ver = read("services/edge-functions/src/lib/schema-version.ts");
    const found = /EXPECTED_SCHEMA_VERSION = "(\d+)"/.exec(ver)?.[1];
    expect(found).toBeDefined();
    expect(Number(found)).toBeGreaterThanOrEqual(594);
  });
});

describe("the seller can pick a window (US-2547 AC4)", () => {
  it("offers more than this week", () => {
    expect(OVERVIEW_RANGES.length).toBeGreaterThanOrEqual(4);
    expect(OVERVIEW_RANGES.map((r) => r.id)).toContain("d30");
    expect(isOverviewRangeId(DEFAULT_OVERVIEW_RANGE)).toBe(true);
    expect(isOverviewRangeId("nonsense")).toBe(false);
    expect(isOverviewRangeId(null)).toBe(false);
  });

  it("bounds are computed from an injected now, in local time", () => {
    const now = new Date(2026, 7, 14, 10, 30); // 2026-08-14 local
    expect(overviewRangeBounds("all", now).from).toBeNull();
    expect(overviewRangeBounds("ytd", now).from).toBe(
      new Date(2026, 0, 1).toISOString(),
    );
    const d30 = overviewRangeBounds("d30", now);
    expect(new Date(d30.to).getTime() - new Date(d30.from!).getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    // The upper bound is now, not the end of today: a window running into the
    // future reads as a gap in the data.
    expect(d30.to).toBe(now.toISOString());
  });

  it("every card can say which window it is showing", () => {
    for (const r of OVERVIEW_RANGES) {
      expect(overviewRangeDef(r.id).phrase.length).toBeGreaterThan(0);
    }
    const src = overviewSources();
    // The hardcoded weekly copy is gone; the phrase comes from the range.
    expect(src).not.toContain("Listed this week");
    expect(src).not.toContain("Sold this week");
    expect(src).not.toContain("Net profit (7d)");
    expect(src).toContain("rangeDef.phrase");
    // The URL param is still the source of truth, and it is still read on the
    // PAGE: the board is handed the range and hands it down, so no widget goes
    // back to the URL and none of them can disagree about the window.
    expect(read(OVERVIEW)).toContain('useUrlParamState(\n    "range"');
  });
});

describe("the short lists can be opened (US-2547 AC5)", () => {
  it("both cards offer show-all rather than five of N", () => {
    const src = overviewSources();
    expect(src).toContain("ShowAllToggle");
    // Exactly two USES: the aging list and the stale list. The component now
    // lives in flipdesk-shared.tsx, so this counts the JSX, not the definition.
    expect((src.match(/<ShowAllToggle/g) ?? []).length).toBe(2);
    // And it says when it is showing a capped slice rather than everything.
    expect(src).toContain("capped");
  });

  it("an aging row links to its item, the same as a stale row", () => {
    const src = read(AGING);
    const aging = src.slice(src.indexOf("function AgingRow("));
    expect(aging).toContain("/dashboard/flipdesk/items/${row.id}");
  });
});

describe("the North Star survives the page dropping the full read", () => {
  it("week buckets give the same answer as one date per item", () => {
    const now = new Date(2026, 7, 12); // a Wednesday
    const dates = [
      new Date(2026, 7, 11).toISOString(), // this week
      new Date(2026, 7, 11).toISOString(),
      new Date(2026, 7, 4).toISOString(), // last week
      new Date(2026, 6, 28).toISOString(), // the week before
      null,
    ];
    const fromItems = computeNorthStar(dates, { now });
    const fromWeeks = computeNorthStarFromWeeks(
      [
        { week: "2026-08-10", count: 2 },
        { week: "2026-08-03", count: 1 },
        { week: "2026-07-27", count: 1 },
      ],
      { now, lifetimeListed: 4 },
    );
    expect(fromWeeks.listedThisWeek).toBe(fromItems.listedThisWeek);
    expect(fromWeeks.streakWeeks).toBe(fromItems.streakWeeks);
    expect(fromWeeks.lifetimeListed).toBe(fromItems.lifetimeListed);
  });

  it("a capped bucket list never walks the lifetime count backwards", () => {
    // The aggregate returns at most two years of weeks. Summing them would make
    // an old account's milestone shrink, so the total travels separately.
    const stats = computeNorthStarFromWeeks([{ week: "2026-08-10", count: 3 }], {
      now: new Date(2026, 7, 12),
      lifetimeListed: 900,
    });
    expect(stats.lifetimeListed).toBe(900);
  });
});

/** True when a tab's predicate accepts this status and no other. */
function matchesOnly(
  matches: (it: ItemFullRow) => boolean,
  status: string,
): boolean {
  const row = (s: string) =>
    ({ status: s, sale_status: "completed" }) as unknown as ItemFullRow;
  if (!matches(row(status))) return false;
  const all: ItemStatus[] = [
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
  return all.every((s) => s === status || !matches(row(s)));
}
