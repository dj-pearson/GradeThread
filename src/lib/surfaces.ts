import type { FlipdeskGateFlags } from "@/lib/constants";
import type { WorkspaceCapability } from "@/lib/workspace-permissions";

// US-2876. What the product CONTAINS, declared once.
//
// Before this file there were two hand-written answers to that question and
// they disagreed. `navGroups` in sidebar.tsx listed twenty-three web
// destinations; `ToolsHubView.swift` listed sixteen iOS modules. Neither knew
// the other existed, so a new feature had to be remembered twice and was
// usually remembered once -- Listing templates and Prospect are on the phone
// and nowhere on the web, Community Insights is a top-level tool on the phone
// and an Analytics tab on the web.
//
// A surface here is a THING THE PRODUCT DOES, not a URL. That distinction is
// the reason this file works at all:
//
//   * a surface can exist on one client and not the other (`web` or `ios` is
//     null) -- that is a real, visible gap rather than a bug in the registry;
//   * a surface can be reachable on the web without being a nav entry (`nav`
//     is null) -- Community Insights has a route, it is just a tab;
//   * and a URL can exist that is not a surface at all. Those live in
//     CONTEXTUAL_ROUTES below.
//
// src/test/surface-registry.test.ts holds the router, the sidebar and the
// Swift to this list.

/** Where a surface sits in the web sidebar, when it appears there at all. */
export type NavPlacement = {
  /** Group title, or null for the untitled trailing group. */
  group: "Grading" | "FlipDesk" | null;
  /** Subgroup title within `group`. Only FlipDesk uses subgroups. */
  subgroup?: string;
  /** `end` on the NavLink -- true only for the two index routes. */
  end?: boolean;
};

export type Surface = {
  /** Stable id. Never a URL, so a route can move without renaming anything. */
  id: string;
  /** Exactly as the product spells it. */
  label: string;
  /**
   * One plain sentence saying what the destination is FOR (US-2861). Not what
   * the word means -- src/lib/product-terms.ts does that.
   */
  description: string;
  /**
   * Canonical web link, including any `?tab=` / `?view=` that names the
   * surface inside a tabbed host. Null when the web does not have this at all.
   */
  web: string | null;
  /** Sidebar placement, or null when the web reaches it some other way. */
  nav: NavPlacement | null;
  /**
   * The Swift case name in `ToolRoute` or `ToolModule`. Null when iOS does not
   * have this at all.
   */
  ios: string | null;
  /** Workspace capability gate (hides the entry outright). */
  requires?: WorkspaceCapability;
  /** FlipDesk plan gate (US-323): shown locked, never hidden (US-2872). */
  requiresFlipdeskFlag?: keyof FlipdeskGateFlags;
  /** Inverse gate: hide once the plan HAS the flag, to tier two overlapping tools. */
  hiddenWhenFlipdeskFlag?: keyof FlipdeskGateFlags;
};

export const SURFACES = [
  // ── Grading ─────────────────────────────────────────────────────────────
  {
    id: "overview",
    label: "Overview",
    description: "Your grades, your plan usage, and what needs you today.",
    web: "/dashboard",
    nav: { group: "Grading", end: true },
    ios: null,
  },
  {
    id: "snap",
    label: "Snap to Value",
    description: "Photograph a garment and get a free condition and price read.",
    web: "/dashboard/snap",
    nav: { group: "Grading" },
    ios: "snap",
  },
  {
    id: "submissions",
    label: "Submissions",
    description: "Every garment you have sent for grading, and its report.",
    web: "/dashboard/submissions",
    nav: { group: "Grading" },
    ios: "grades",
  },
  {
    // US-1851: level + quarterly season track. Sits with Grading because XP
    // comes from grading acts, not from listing volume.
    id: "rewards",
    label: "Rewards",
    description: "Your level, your season track, and the credit you have earned.",
    web: "/dashboard/rewards",
    nav: { group: "Grading" },
    ios: null,
  },

  // ── FlipDesk / Catalog ──────────────────────────────────────────────────
  {
    id: "flipdesk-overview",
    label: "Overview",
    description: "The day's numbers for buying, listing and selling.",
    web: "/dashboard/flipdesk",
    nav: { group: "FlipDesk", subgroup: "Catalog", end: true },
    ios: null,
  },
  {
    id: "flipdesk-search",
    label: "Search",
    description: "Find any item, listing or sale by anything you remember about it.",
    web: "/dashboard/flipdesk/search",
    nav: { group: "FlipDesk", subgroup: "Catalog" },
    ios: null,
  },
  {
    // One surface. Its in-page tabs switch Table / Grid / Kanban / Prep.
    id: "inventory",
    label: "Inventory",
    description: "Everything you own, as a table, a grid, a board or a prep list.",
    web: "/dashboard/flipdesk/inventory",
    nav: { group: "FlipDesk", subgroup: "Catalog" },
    ios: null,
  },

  // ── FlipDesk / List & sell ──────────────────────────────────────────────
  {
    // US-2161 (second pass): AutoLister hosts Generate + Drafts as ?view=
    // tabs. Drafts was never a separate destination -- it is what AutoLister
    // produces.
    id: "autolister",
    label: "AutoLister",
    description: "Turn a pile of photos into drafted listings in one batch.",
    web: "/dashboard/flipdesk/autolister",
    nav: { group: "FlipDesk", subgroup: "List & sell" },
    ios: "autoLister",
    requiresFlipdeskFlag: "autolister",
  },
  {
    id: "scheduled-drops",
    label: "Scheduled drops",
    description: "Queue listings to publish when buyers are looking.",
    web: "/dashboard/flipdesk/scheduled-drops",
    nav: { group: "FlipDesk", subgroup: "List & sell" },
    ios: "scheduledDrops",
  },
  {
    id: "verified",
    label: "Verified",
    description: "Claim your public seller handle and trust badge.",
    web: "/dashboard/flipdesk/verified",
    nav: { group: "FlipDesk", subgroup: "List & sell" },
    ios: "verified",
  },
  {
    // On iOS only. The web has the template DATA (src/lib/listing-templates.ts,
    // used by the composer) and no screen to manage it from.
    id: "listing-templates",
    label: "Listing templates",
    description: "Reusable description, condition and policy presets for your listings.",
    web: null,
    nav: null,
    ios: "templates",
  },

  // ── FlipDesk / Sourcing ─────────────────────────────────────────────────
  {
    id: "import",
    label: "Import",
    description: "Bring inventory in from a CSV file or a Google Sheet.",
    web: "/dashboard/flipdesk/import",
    nav: { group: "FlipDesk", subgroup: "Sourcing" },
    ios: null,
  },
  {
    // US-2161: ScoutAI + Buy Decision + Sources + Buyer Demand were four
    // entries answering one question. NOT plan-gated at the nav level: two of
    // the four tabs need compPulls and two do not, so gating the whole entry
    // would hide Sources from a seller who is entitled to it.
    id: "sourcing",
    label: "Sourcing",
    description: "What to buy and where from: Scout, buy calls, sources, demand.",
    web: "/dashboard/flipdesk/sourcing",
    nav: { group: "FlipDesk", subgroup: "Sourcing" },
    ios: null,
  },
  {
    id: "scout",
    label: "Scout deals",
    description: "Find underpriced eBay listings worth flipping.",
    web: "/dashboard/flipdesk/sourcing?tab=scout",
    nav: null,
    ios: "scout",
  },
  {
    id: "sources",
    label: "Sources",
    description: "Organize where your inventory comes from.",
    web: "/dashboard/flipdesk/sourcing?tab=sources",
    nav: null,
    ios: "sources",
  },
  {
    // On iOS only. The web has no in-store camera flow -- Snap to Value is the
    // nearest thing and it values one garment rather than comping a buy.
    id: "prospect",
    label: "Prospect an item",
    description: "Photograph an item in a store and get instant comps before you buy it.",
    web: null,
    nav: null,
    ios: "prospect",
  },
  {
    id: "consignment",
    label: "Consignment",
    description: "Your consignors, their items, and their payout splits.",
    web: "/dashboard/flipdesk/consignment",
    nav: { group: "FlipDesk", subgroup: "Sourcing" },
    ios: "consignors",
  },

  // ── FlipDesk / Channels & money ─────────────────────────────────────────
  {
    id: "marketplaces",
    label: "Marketplaces",
    description: "Connect eBay and the other channels you sell on.",
    web: "/dashboard/flipdesk/marketplaces",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
  },
  {
    id: "offers",
    label: "Offers & Messages",
    description: "Buyer offers and messages, with replies drafted for you.",
    web: "/dashboard/flipdesk/offers",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
  },
  {
    id: "post-sale",
    label: "Returns & Disputes",
    description: "Returns, cases and disputes after a sale.",
    web: "/dashboard/flipdesk/post-sale",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
  },
  {
    // US-2161: Repricing + Bulk pricing + Price Suggestions + Automations.
    id: "pricing",
    label: "Pricing",
    description: "Reprice live listings, edit prices in bulk, and run pricing rules.",
    web: "/dashboard/flipdesk/pricing",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
  },
  {
    id: "repricing",
    label: "Repricing",
    description: "Condition-aware price suggestions for listings that are already live.",
    web: "/dashboard/flipdesk/pricing?tab=repricing",
    nav: null,
    ios: "repricing",
  },
  {
    id: "automations",
    label: "Automations",
    description: "Rules that act on their own when a listing sits too long or gets no views.",
    web: "/dashboard/flipdesk/pricing?tab=automations",
    nav: null,
    ios: "automations",
  },
  {
    // US-2161 (second pass): Finances + Expenses + Reconcile answered one
    // question -- where did my money go -- from three nav entries.
    id: "money",
    label: "Money",
    description: "What sold, what it cost, what you are owed, and your real profit.",
    web: "/dashboard/flipdesk/money",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
  },
  {
    id: "reconciliation",
    label: "Reconciliation",
    description: "Match eBay listings you did not create here to items you own.",
    web: "/dashboard/flipdesk/money?view=reconcile",
    nav: null,
    ios: "reconciliation",
  },
  {
    id: "reconcile-intake",
    label: "Reconcile photo dump",
    description: "Send a batch of photos straight to a reconcile session.",
    web: "/dashboard/flipdesk/intake",
    nav: null,
    ios: "reconcileIntake",
  },
  {
    // US-1579: MeasureCard info + PDF download + mailed-card request.
    id: "measure-card",
    label: "MeasureCard",
    description: "The printed card that puts a scale in every measurement photo.",
    web: "/dashboard/flipdesk/measure-card",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
  },

  // ── FlipDesk / Automate & insights ──────────────────────────────────────
  {
    // `end: false` so the entry stays highlighted on every /analytics/* tab.
    id: "analytics",
    label: "Analytics",
    description: "How your listings, grades and returns are doing over time.",
    web: "/dashboard/flipdesk/analytics",
    nav: { group: "FlipDesk", subgroup: "Automate & insights" },
    ios: null,
  },
  {
    id: "community-insights",
    label: "Community Insights",
    description: "Anonymized sourcing and pricing benchmarks from other sellers.",
    web: "/dashboard/flipdesk/analytics/community",
    nav: null,
    ios: "communityInsights",
  },

  // ── Account, developers, help ───────────────────────────────────────────
  {
    // Account, billing, team, API keys and referrals are one hub (US-741)
    // reached from this single entry; its tabs gate billing/API by capability.
    id: "account",
    label: "Account",
    // Worded so `plan` is never a bare comma-delimited token: the
    // frozen-column guard (src/test/legacy-user-plan-readers.test.ts) treats
    // "a, plan, b" as a select list and flags the file.
    description: "Your profile, plan and billing, your team and your referrals.",
    web: "/dashboard/account",
    nav: { group: null },
    ios: null,
  },
  {
    // US-2554: findable. It was a tab inside Account, so the only way to reach
    // the API was to go looking for it under your profile.
    id: "developers",
    label: "Developers",
    description: "API keys and the sandbox for grading from your own app.",
    web: "/dashboard/developers",
    nav: { group: null },
    ios: null,
    requires: "manage_api_keys",
  },
  {
    id: "referrals",
    label: "Referrals",
    description: "Invite other resellers and earn credit when they grade.",
    web: "/dashboard/referrals",
    nav: null,
    ios: "referrals",
  },
  {
    // US-2583: a nav entry rather than only the header's help menu, because
    // the thing people look for when stuck is a place in the sidebar, not an
    // icon they have to remember.
    id: "help",
    label: "Help",
    description: "Guides and answers, without leaving the app.",
    web: "/dashboard/help",
    nav: { group: null },
    ios: null,
  },
] as const satisfies readonly Surface[];

export type SurfaceId = (typeof SURFACES)[number]["id"];

/**
 * Authenticated routes that are NOT surfaces.
 *
 * US-1121 kept this list in a prose comment above `navGroups`. Prose cannot
 * fail, so a route added without a nav entry and without a line here was
 * indistinguishable from a route somebody forgot. Each entry says why, and
 * src/test/surface-registry.test.ts fails on a /dashboard route that is in
 * neither list.
 */
export const CONTEXTUAL_ROUTES: readonly { path: string; why: string }[] = [
  { path: "/dashboard/*", why: "The catch-all. Renders the 404, not a surface." },
  {
    path: "/dashboard/example",
    why: "The grade-report example page, linked from marketing copy rather than nav.",
  },
  {
    path: "/dashboard/submissions/new",
    why: "The submit flow itself, entered from the Submissions page and the dashboard CTA.",
  },
  {
    path: "/dashboard/submissions/bulk",
    why: "Reached from the Submissions page's Bulk submit button.",
  },
  {
    path: "/dashboard/measurements",
    why: "US-1777 buyer body profiles, linked from the fit widget on a listing. Not a seller surface.",
  },
  {
    path: "/dashboard/help/glossary",
    why: "A page inside Help, reached from the Help index rather than the nav.",
  },
  {
    path: "/dashboard/settings",
    why: "Folded into the Account hub (US-741); the route stays for deep links and the command palette.",
  },
  { path: "/dashboard/billing", why: "Folded into the Account hub (US-741); the route stays for deep links." },
  { path: "/dashboard/team", why: "Folded into the Account hub (US-741); the route stays for deep links." },
  { path: "/dashboard/api-keys", why: "Account hub tab (US-741); Developers is the nav entry." },
  { path: "/dashboard/support", why: "Account hub tab (US-741); Help is the nav entry." },
  {
    path: "/dashboard/flipdesk/overview",
    why: "Renders the SAME page as /dashboard/flipdesk. An alias, not a redirect -- see the note in surface-registry.test.ts.",
  },
  {
    path: "/dashboard/flipdesk/autolister/queue",
    why: "Batch-scoped (?batch=). A nav link with no batch id is meaningless.",
  },
  {
    path: "/dashboard/flipdesk/autolister/bulk-edit",
    why: "Batch-scoped (?batch=), reached from the AutoLister drafts flow.",
  },
  {
    path: "/dashboard/flipdesk/marketplaces/google",
    why: "A sub-channel reached from the Marketplaces page.",
  },
  {
    path: "/dashboard/flipdesk/analytics/performance",
    why: "One of Analytics' five tabs. Analytics itself is the nav entry.",
  },
  {
    path: "/dashboard/flipdesk/analytics/returns",
    why: "An Analytics tab, reached from Analytics.",
  },
  {
    path: "/dashboard/flipdesk/analytics/price-curve",
    why: "An Analytics tab, reached from Analytics.",
  },
  {
    path: "/dashboard/flipdesk/analytics/grading-roi",
    why: "An Analytics tab, reached from Analytics.",
  },
];

/** Every surface the web sidebar renders, in sidebar order. */
export function navSurfaces(): readonly Surface[] {
  return SURFACES.filter((s) => s.nav !== null);
}

/** Surfaces in one group (and subgroup), in declaration order. */
export function surfacesIn(group: NavPlacement["group"], subgroup?: string): readonly Surface[] {
  return SURFACES.filter(
    (s) => s.nav !== null && s.nav.group === group && (s.nav as NavPlacement).subgroup === subgroup,
  );
}

/** Surfaces one client has and the other does not. Used by the parity guard. */
export function clientGaps(): { webOnly: readonly Surface[]; iosOnly: readonly Surface[] } {
  return {
    webOnly: SURFACES.filter((s) => s.web !== null && s.ios === null),
    iosOnly: SURFACES.filter((s) => s.ios !== null && s.web === null),
  };
}

/** The route path a surface lives at, with any `?tab=` / `?view=` removed. */
export function routePathOf(surface: Surface): string | null {
  return surface.web === null ? null : surface.web.split("?")[0]!;
}

/**
 * The web sidebar's own structure: titles, the sentence under each title, and
 * the order subgroups render in.
 *
 * Here rather than in sidebar.tsx because a group title is a thing the user
 * has to understand too (US-2861), and because the FlipDesk subgroup order is
 * product information -- Catalog before List & sell before Sourcing is the
 * order the work happens in -- not a rendering detail.
 */
export const NAV_GROUPS: readonly {
  group: NavPlacement["group"];
  title?: string;
  description?: string;
  subgroups?: readonly { title: string; description: string }[];
}[] = [
  {
    group: "Grading",
    title: "Grading",
    description: "Send garments for a condition grade and read the reports.",
  },
  {
    group: "FlipDesk",
    title: "FlipDesk",
    description: "Everything from sourcing an item to reconciling the payout.",
    // Split into labeled, independently-collapsible subgroups (US-609) so the
    // section's ~20 destinations stay manageable.
    subgroups: [
      { title: "Catalog", description: "What you own, and where to find it." },
      { title: "List & sell", description: "Turn items into listings and get them live." },
      { title: "Sourcing", description: "What to buy, and where it comes from." },
      { title: "Channels & money", description: "Where you sell, and what you make." },
      { title: "Automate & insights", description: "Rules that run for you, and how it is all going." },
    ],
  },
  // The trailing group renders no header, so it carries no description to hang
  // one on.
  { group: null },
];

/**
 * The same list, widened.
 *
 * `SURFACES` is `as const` so `SurfaceId` is a real union and a typo in an id
 * is a compile error. That same narrowness makes it awkward to filter over --
 * every entry has its own literal type -- so consumers that want to iterate
 * read this instead. The two are the same array.
 */
export const ALL_SURFACES: readonly Surface[] = SURFACES;
