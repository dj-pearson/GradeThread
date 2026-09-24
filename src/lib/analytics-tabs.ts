// A9: the Analytics tab set, written once.
//
// The tab paths used to be spelled out in four places (the active-tab ternary,
// the navigate ternary, RANGE_TABS and the scorecard's link table), and a new
// tab had to be added to all four. Everything below is derived from this list.
// The routes themselves stay explicit in src/routes/index.tsx, and
// src/test/analytics-tabs.test.ts fails if one of these paths is not there.

export type AnalyticsTabId =
  | "sell-through"
  | "grading-roi"
  | "price-curve"
  | "returns"
  | "performance"
  | "community"
  | "team";

export interface AnalyticsTab {
  id: AnalyticsTabId;
  label: string;
  /** Used below the sm breakpoint so the strip fits a phone. */
  shortLabel: string;
  path: string;
  /** Reads the shared ?preset= date range, so the page shows the control. */
  usesRange: boolean;
}

const BASE = "/dashboard/flipdesk/analytics";

export const ANALYTICS_TABS: readonly AnalyticsTab[] = [
  { id: "sell-through", label: "Sell-through", shortLabel: "Sell-through", path: BASE, usesRange: true },
  { id: "grading-roi", label: "Grading ROI", shortLabel: "ROI", path: `${BASE}/grading-roi`, usesRange: true },
  { id: "price-curve", label: "Price curve", shortLabel: "Price", path: `${BASE}/price-curve`, usesRange: true },
  { id: "returns", label: "Return reduction", shortLabel: "Returns", path: `${BASE}/returns`, usesRange: true },
  { id: "performance", label: "Listing performance", shortLabel: "Listings", path: `${BASE}/performance`, usesRange: false },
  { id: "community", label: "Community", shortLabel: "Community", path: `${BASE}/community`, usesRange: true },
  // US-3019: the Team tab windows on the same preset as everything else.
  { id: "team", label: "Team", shortLabel: "Team", path: `${BASE}/team`, usesRange: true },
];

const DEFAULT_TAB = ANALYTICS_TABS[0]!;

export const RANGE_TABS: ReadonlySet<AnalyticsTabId> = new Set(
  ANALYTICS_TABS.filter((t) => t.usesRange).map((t) => t.id),
);

/** The tab a pathname shows. Anything unrecognised is the first tab. */
export function tabFromPath(pathname: string): AnalyticsTabId {
  const clean = pathname.replace(/\/+$/, "");
  return ANALYTICS_TABS.find((t) => t.path === clean)?.id ?? DEFAULT_TAB.id;
}

/** Where a tab lives, keeping the query string (range, grouping, filters). */
export function tabHref(id: AnalyticsTabId, search = ""): string {
  const tab = ANALYTICS_TABS.find((t) => t.id === id) ?? DEFAULT_TAB;
  return tab.path + search;
}

export function tabPath(id: AnalyticsTabId): string {
  return tabHref(id);
}
