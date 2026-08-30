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
   * The Swift case name in `ToolRoute` or `ToolModule`.
   *
   * US-2879 CORRECTION: this is the TOOLS HUB route, and null therefore means
   * "not a row in the Tools hub" -- NOT "iOS does not have this". US-2876's
   * comment said the latter and it was wrong about eleven surfaces. Offers &
   * Messages is the proof: iOS has a 666-line NegotiationInboxView reachable
   * from three places, and this field says null. Read `iosElsewhere` before
   * concluding anything is missing.
   */
  ios: string | null;
  /**
   * When `ios` is null but iOS HAS this surface somewhere else: the Swift file
   * that owns it, relative to the repo root.
   *
   * The guard checks the file exists, so this cannot rot into a claim about a
   * screen somebody deleted.
   */
  iosElsewhere?: string;
  /**
   * Why this surface lives on ONE client only.
   *
   * Required whenever a surface is genuinely single-client -- `web: null`, or
   * `ios: null` with no `iosElsewhere`. Both directions, on purpose: US-2879
   * asked for web-only reasons and US-2878 had already established the same
   * need pointing the other way, and two fields would have drifted.
   *
   * A missing reason is the failure this closes. A gap with no reason is
   * indistinguishable from a gap nobody noticed, so the next person either
   * builds something that was deliberately not built, or leaves something
   * unbuilt that was simply forgotten.
   */
  onlyReason?: string;
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
    iosElsewhere: "ios/GradeThread/Dashboard/DashboardView.swift",
  },
  {
    // US-2878: "you already own" is load-bearing. Snap to Value, Scout and
    // Prospect are three comp-adjacent tools with three invented names, and the
    // line that separates them is DO YOU OWN IT YET -- Snap is for what you
    // have, Prospect for what you are considering, Scout for finding things to
    // consider. Each of the three descriptions has to carry that or the names
    // are all a new seller has to go on.
    id: "snap",
    label: "Snap to Value",
    description: "Photograph a garment you already own and get a condition and price read.",
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
    onlyReason:
      "Web only, deliberately (US-2879). Level, season track and earned " +
      "credit are a thing you check now and then, not a thing you do -- a " +
      "screen for reading a number you already earned somewhere else. The " +
      "web links out of the Tools hub instead of iOS growing a second " +
      "copy.",
  },

  // ── FlipDesk / Catalog ──────────────────────────────────────────────────
  {
    id: "flipdesk-overview",
    label: "Overview",
    description: "The day's numbers for buying, listing and selling.",
    web: "/dashboard/flipdesk",
    nav: { group: "FlipDesk", subgroup: "Catalog", end: true },
    ios: null,
    iosElsewhere: "ios/GradeThread/Dashboard/DashboardView.swift",
  },
  {
    id: "flipdesk-search",
    label: "Search",
    description: "Find any item, listing or sale by anything you remember about it.",
    web: "/dashboard/flipdesk/search",
    nav: { group: "FlipDesk", subgroup: "Catalog" },
    ios: null,
    iosElsewhere: "ios/GradeThread/Inventory/GlobalSearchView.swift",
  },
  {
    // One surface. Its in-page tabs switch Table / Grid / Kanban / Prep.
    id: "inventory",
    label: "Inventory",
    description: "Everything you own, as a table, a grid, a board or a prep list.",
    web: "/dashboard/flipdesk/inventory",
    nav: { group: "FlipDesk", subgroup: "Catalog" },
    ios: null,
    iosElsewhere: "ios/GradeThread/Inventory/InventoryListView.swift",
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
    // US-2877 gave this a web page. It was iOS-only for two years: the table,
    // the CRUD API and the phone editor all shipped with US-674, and the web
    // could apply a preset from the AutoLister grid without ever being able to
    // write one.
    id: "listing-templates",
    label: "Listing templates",
    description: "Reusable description, condition and policy presets for your listings.",
    web: "/dashboard/flipdesk/templates",
    nav: { group: "FlipDesk", subgroup: "List & sell" },
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
    iosElsewhere: "ios/GradeThread/Import/CSVImportView.swift",
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
    iosElsewhere: "ios/GradeThread/Scout/ScoutView.swift",
  },
  {
    id: "scout",
    label: "Scout deals",
    description: "Search eBay for listings priced under what they are worth, to buy and flip.",
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
    // On iOS only, DELIBERATELY -- see
    // vault/60-decisions/adr-prospect-stays-phone-only.md. Not a gap waiting to
    // be closed: the whole value is being in a shop holding something you have
    // not bought. A desk is never in that situation. The endpoint
    // (/api/flipdesk/scout/prospect) exists either way, so reversing the call
    // is a page rather than a feature.
    id: "prospect",
    label: "Prospect an item",
    description: "Photograph an item in a shop before you buy it, and get a buy or skip call.",
    web: null,
    nav: null,
    ios: "prospect",
    onlyReason:
      "iOS only, deliberately -- see " +
      "vault/60-decisions/adr-prospect-stays-phone-only.md (US-2878). The " +
      "value is standing in a shop holding something you have not bought, " +
      "and a desk is never in that situation.",
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
    iosElsewhere: "ios/GradeThread/Marketplaces/MarketplacesView.swift",
  },
  {
    id: "offers",
    label: "Offers & Messages",
    description: "Buyer offers and messages, with replies drafted for you.",
    web: "/dashboard/flipdesk/offers",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
    iosElsewhere: "ios/GradeThread/Marketplaces/Negotiation/NegotiationInboxView.swift",
  },
  {
    id: "post-sale",
    label: "Returns & Disputes",
    description: "Returns, cases and disputes after a sale.",
    web: "/dashboard/flipdesk/post-sale",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
    iosElsewhere: "ios/GradeThread/Marketplaces/PostSale/PostSaleView.swift",
  },
  {
    // US-2161: Repricing + Bulk pricing + Price Suggestions + Automations.
    id: "pricing",
    label: "Pricing",
    description: "Reprice live listings, edit prices in bulk, and run pricing rules.",
    web: "/dashboard/flipdesk/pricing",
    nav: { group: "FlipDesk", subgroup: "Channels & money" },
    ios: null,
    iosElsewhere: "ios/GradeThread/Pricing/RepricingView.swift",
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
    iosElsewhere: "ios/GradeThread/Money/MoneyView.swift",
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
    onlyReason:
      "Web only, deliberately (US-2879). It is a printable PDF, " +
      "instructions for shooting with it, and a postal address form for a " +
      "card we mail once. Every one of those is worse on a phone, and the " +
      "address form is a once-ever action.",
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
    iosElsewhere: "ios/GradeThread/Analytics/AnalyticsView.swift",
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
    iosElsewhere: "ios/GradeThread/ContentView.swift",
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
    onlyReason:
      "Web only, deliberately (US-2879). API keys and a sandbox are for " +
      "while you are writing code, which is not a phone activity. And an " +
      "API key on a phone screen is a secret held up in public.",
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
    iosElsewhere: "ios/GradeThread/Help/HelpSheet.swift",
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
    path: "/dashboard/flipdesk/settings/blocks",
    why:
      "US-2961 description snippets, reached from the Description card in the " +
      "item editor, which is where a seller is standing when they want one.",
  },
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
  {
    path: "/dashboard/flipdesk/analytics/team",
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

// US-2879 DELETED `clientGaps()`. It filtered on `s.ios === null` and therefore
// counted every surface that is not a Tools-hub row as a gap -- fourteen of
// them, all of which iOS has. It had no callers, which is the only reason it
// never reported those fourteen to anybody. `singleClientSurfaces()` and
// `onlyOn()` at the bottom of this file are the honest version; they read
// `iosElsewhere` before calling anything missing.

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

/**
 * Surfaces that genuinely exist on one client only.
 *
 * "Genuinely" is doing work here. `ios: null` alone does NOT mean iOS lacks a
 * surface -- it means the surface is not a row in the Tools hub. Eleven
 * surfaces sit outside that hub and were read as missing until US-2879
 * measured them, so this reads `iosElsewhere` too.
 */
export function singleClientSurfaces(): readonly Surface[] {
  return ALL_SURFACES.filter(
    (s) => s.web === null || (s.ios === null && !s.iosElsewhere),
  );
}

/** Which client a single-client surface is on. Null when it is on both. */
export function onlyOn(s: Surface): "web" | "ios" | null {
  if (s.web === null && s.ios !== null) return "ios";
  if (s.ios === null && !s.iosElsewhere && s.web !== null) return "web";
  return null;
}
