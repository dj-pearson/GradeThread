// US-2161: tab identity + ?tab= resolution for the two consolidated FlipDesk
// hosts (Pricing and Sourcing). Kept in its own module — the same reason
// inventory-tabs.ts exists — so a unit test can import the mapping without
// dragging four lazily-loaded page modules into the graph.
//
// The resolvers are total: any unknown, absent or hostile ?tab= value lands on
// the first tab rather than an empty shell. A bad query string arriving from an
// old bookmark, a truncated share link or a typo should look like the page, not
// like a bug.

export const PRICING_TABS = [
  "repricing",
  "bulk",
  "suggestions",
  "automations",
] as const;
export type PricingTab = (typeof PRICING_TABS)[number];

export function resolvePricingTab(raw: string | null | undefined): PricingTab {
  return PRICING_TABS.includes(raw as PricingTab)
    ? (raw as PricingTab)
    : "repricing";
}

// US-1864 added "stores" — the free personal Thrift Radar layer. It sits beside
// Sources rather than inside it because Sources is where you MAINTAIN the list
// and this is where you READ what the list earned you.
// US-1865 added "radar" — the shared map. It sits next to "stores" because the
// two are one surface split by who the data belongs to: Radar is everyone's
// scans (Pro+, k-floored), My stores is yours alone (free, works at n=1). Both
// draw from the same personal history, which is why neither absorbed the other.
export const SOURCING_TABS = [
  "scout",
  "buy",
  "radar",
  "stores",
  "sources",
  "demand",
] as const;
export type SourcingTab = (typeof SOURCING_TABS)[number];

export function resolveSourcingTab(
  raw: string | null | undefined,
): SourcingTab {
  return SOURCING_TABS.includes(raw as SourcingTab)
    ? (raw as SourcingTab)
    : "scout";
}

/**
 * Where each retired path now lives.
 *
 * This is the contract the router's Navigate entries implement, expressed once
 * so a test can assert every old path still resolves. A consolidation that
 * silently 404s a bookmarked URL is worse than the crowded nav it replaced.
 */
export const RETIRED_NAV_REDIRECTS: Readonly<Record<string, string>> = {
  "/dashboard/flipdesk/repricing": "/dashboard/flipdesk/pricing?tab=repricing",
  "/dashboard/flipdesk/bulk-pricing": "/dashboard/flipdesk/pricing?tab=bulk",
  "/dashboard/analytics/suggestions":
    "/dashboard/flipdesk/pricing?tab=suggestions",
  "/dashboard/flipdesk/automations":
    "/dashboard/flipdesk/pricing?tab=automations",
  "/dashboard/flipdesk/scout": "/dashboard/flipdesk/sourcing?tab=scout",
  "/dashboard/flipdesk/scout/buy": "/dashboard/flipdesk/sourcing?tab=buy",
  "/dashboard/flipdesk/sources": "/dashboard/flipdesk/sourcing?tab=sources",
  "/dashboard/flipdesk/demand": "/dashboard/flipdesk/sourcing?tab=demand",
  // Analytics keeps PATH-based tabs, because it already had them.
  "/dashboard/flipdesk/community": "/dashboard/flipdesk/analytics/community",
};

// US-2161 (second pass, 2026-08-02): the owner approved two further merges on
// the same rule the first three used — surfaces answering ONE question become
// one destination. That takes the FlipDesk group from 19 entries to 16.
//
//   Money      = Finances + Expenses + Reconcile. One question: where did my
//                money go.
//   AutoLister = the generator + its Drafts output. Drafts is not a separate
//                destination, it is what AutoLister produces.
//
// BOTH USE `?view=`, NOT `?tab=`, and that is not a style choice. Reconcile
// already owns `?tab=` for its own four inner tabs (photos / ebay / payouts /
// cross-source, US-963), and nesting a host on the same parameter would have
// meant either renaming those values — breaking every bookmark and every
// in-app link that carries one — or silently fighting over the same key. A
// distinct outer parameter lets `/money?view=reconcile&tab=payouts` resolve
// both levels independently, and it follows the precedent Inventory already
// set with `?mode=` (US-958).

// US-2982 added "tax". It sits at the end because it is the least-visited and
// most-consequential: a seller opens it once, answers five questions, and every
// other view in Money starts reading the right twelve months.
// US-2985 added "pnl". It sits SECOND, right after the dashboard: Finances
// answers "how am I trending" with tiles and charts, and this answers "what
// were my numbers" in the row order a preparer reads down. The two belong
// beside each other, and the statement is the one a seller has to hand to
// somebody else.
// US-2999 rebuilt the row into a DECIDED structure rather than five more tabs.
// The epic added a P&L, a review queue, a tax section, a mileage log, a home
// office, a packet and a QuickBooks connection; bolting each one on as it
// landed is how a hub ends up with eleven peers and no order.
//
// Three groups, and the order is the order a seller uses them:
//
//   Overview   - the four questions, answered on arrival. Default.
//   Day to day - the surfaces you touch weekly.
//   Tax        - the surfaces you touch in March, plus the two that quietly
//                accumulate all year (mileage, the home office).
//
// "overview" is the default now, not "finances". A seller arriving at Money
// wants the answer, not the chart that implies it. Every retired path still
// carries an explicit ?view=, so no bookmark changes meaning.
export const MONEY_VIEWS = [
  "overview",
  "finances",
  "expenses",
  "reconcile",
  "pnl",
  "deductions",
  "tax",
] as const;
export type MoneyView = (typeof MONEY_VIEWS)[number];

export interface MoneyViewGroup {
  /** null on the first group: "Overview" as a heading over one tab is noise. */
  label: string | null;
  views: readonly MoneyView[];
}

/**
 * The structure, declared once so the strip, the mobile picker and the test can
 * all read the same thing.
 *
 * A view missing from here would render nowhere while still resolving from a
 * URL, which is the failure mode this shape exists to make testable: the test
 * asserts the groups cover MONEY_VIEWS exactly, with no gaps and no repeats.
 */
export const MONEY_VIEW_GROUPS: readonly MoneyViewGroup[] = [
  { label: null, views: ["overview"] },
  { label: "Day to day", views: ["finances", "expenses", "reconcile"] },
  { label: "Tax", views: ["pnl", "deductions", "tax"] },
];

/** What each view is called on screen. One place, so the two strips agree. */
export const MONEY_VIEW_LABELS: Readonly<Record<MoneyView, string>> = {
  overview: "Overview",
  finances: "Trends",
  expenses: "Expenses",
  reconcile: "Reconcile",
  pnl: "P&L",
  deductions: "Deductions",
  tax: "Tax & filing",
};

export function resolveMoneyView(raw: string | null | undefined): MoneyView {
  return MONEY_VIEWS.includes(raw as MoneyView) ? (raw as MoneyView) : "overview";
}

export const AUTOLISTER_VIEWS = ["generate", "drafts"] as const;
export type AutolisterView = (typeof AUTOLISTER_VIEWS)[number];

export function resolveAutolisterView(
  raw: string | null | undefined,
): AutolisterView {
  return AUTOLISTER_VIEWS.includes(raw as AutolisterView)
    ? (raw as AutolisterView)
    : "generate";
}

/**
 * The `?view=` half of the retired-path contract.
 *
 * Kept separate from {@link RETIRED_NAV_REDIRECTS} because the router
 * implements it with a different helper — these carry a `view` parameter and
 * must preserve any `tab` already on the incoming URL, which is the whole
 * reason `?view=` exists. `/reconcile?tab=payouts` has to land on
 * `/money?view=reconcile&tab=payouts` with the inner tab intact.
 */
export const RETIRED_VIEW_REDIRECTS: Readonly<Record<string, string>> = {
  "/dashboard/finances": "/dashboard/flipdesk/money?view=finances",
  "/dashboard/flipdesk/expenses": "/dashboard/flipdesk/money?view=expenses",
  "/dashboard/flipdesk/reconcile": "/dashboard/flipdesk/money?view=reconcile",
  "/dashboard/flipdesk/autolister/drafts":
    "/dashboard/flipdesk/autolister?view=drafts",
};
