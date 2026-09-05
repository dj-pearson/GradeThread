import type { ComponentType } from "react";
import type { UserUseCase } from "@/types/database";
import { overviewRangeDef, type OverviewRangeId } from "@/lib/overview-range";

// US-3073: the widget registry both overviews render from.
//
// One entry per widget, one board component, one layout document. A page never
// places a card itself: it renders <WidgetBoard surface="..."> and the board
// reads this registry. `load` is a dynamic import so React.lazy only downloads
// the widgets a seller actually has on their board.
//
// Adding a widget = adding an entry here plus its component. Nothing else in
// the board, the layout normalizer or the persistence layer needs to change.

/** The three boards. A layout row is keyed by (user, surface). */
export const DASHBOARD_SURFACES = ["grading", "flipdesk", "ios-home"] as const;
export type DashboardSurface = (typeof DASHBOARD_SURFACES)[number];

/**
 * Widget widths, as columns of the board's 4-column grid at the lg breakpoint:
 * sm = 1, md = 2, lg = 4 (full width). Below lg the grid collapses to 2 and
 * then 1 column, so a size is a maximum, never a minimum.
 */
export const WIDGET_SIZES = ["sm", "md", "lg"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Columns of the 4-column grid each size occupies. */
export const WIDGET_SIZE_COLUMNS: Record<WidgetSize, 1 | 2 | 4> = {
  sm: 1,
  md: 2,
  lg: 4,
};

/**
 * How the Add-widget catalog groups the registry (US-3074 AC3).
 * `data` = the seller's own numbers, `action` = something to do next,
 * `promo` = anything selling GradeThread rather than reporting on it.
 */
export const WIDGET_CATEGORIES = ["data", "action", "promo"] as const;
export type WidgetCategory = (typeof WIDGET_CATEGORIES)[number];

/** The personas a widget can be offered to. Same set as users.use_case. */
export type WidgetPersona = UserUseCase;
export const WIDGET_PERSONAS: readonly WidgetPersona[] = [
  "seller",
  "buyer",
  "consignment",
  "developer",
];

/** Persona used when the account never chose one. */
export const DEFAULT_PERSONA: WidgetPersona = "seller";

/**
 * What the layout normalizer knows about the account (US-3075 AC5).
 *
 * Deliberately tiny, and deliberately optional-everything: a field that is
 * `undefined` means "not answered yet", and no widget may be dropped on an
 * unanswered question. A count still in flight must not remove a card and then
 * put it back a second later.
 */
export interface LayoutContext {
  /** True once the account has at least one inventory_items row. */
  hasInventory?: boolean;
  /**
   * True once the account has at least one consignors row (US-3078 AC6).
   *
   * False is what removes the consignor-payout widget, so an account that does
   * not run consignment never has to read a card about it; undefined leaves it
   * alone, which is what a count still in flight and a count that failed both
   * mean.
   */
  hasConsignors?: boolean;
}

/** Props every widget component accepts. Widgets that need none ignore them all. */
export interface WidgetProps {
  /** The size the seller picked, so a widget can render compactly at `sm`. */
  size: WidgetSize;
  surface: DashboardSurface;
  /**
   * The reporting window the board is showing, on a surface that has a picker
   * (US-3076: FlipDesk, from `?range=`). Undefined on a board without one.
   *
   * Given to EVERY widget on a ranged board, not only the `rangeAware` ones.
   * `rangeAware` answers "do this widget's numbers follow the picker", which is
   * what the frame's subtitle is built from; a widget whose numbers do not can
   * still need to know the window CHANGED, because the aging and stale lists
   * fold their "show all" back up when the seller moves the picker.
   */
  range?: OverviewRangeId;
}

export interface WidgetDef {
  /** Stable id, `<surface>.<name>`. Persisted in the layout document forever. */
  id: string;
  surface: DashboardSurface;
  /** Frame heading. */
  title: string;
  /** One line for the catalog and for the frame's quiet state. */
  blurb: string;
  category: WidgetCategory;
  /** Sizes this widget is legible at. Must contain defaultSize. */
  sizes: readonly WidgetSize[];
  defaultSize: WidgetSize;
  /**
   * True when the widget's numbers follow the FlipDesk date-range picker. Only
   * the flipdesk surface has one, so a rangeAware widget lives there
   * (src/test/dashboard-widget-registry.test.ts pins that).
   */
  rangeAware: boolean;
  /**
   * The window this widget's numbers cover when they do NOT follow the picker.
   * Read only when `rangeAware` is false; defaults to "right now".
   *
   * US-3076 AC3 names four widgets that show "right now" and treats every other
   * FlipDesk widget as range-aware. Three of them are neither: "Time saved" is
   * always this calendar month, "Photos to Approve" is a median over every item
   * ever reviewed, and the community insights are a twelve-month benchmark.
   * Labelling any of the three with the picker's phrase would print "in the
   * last 7 days" over a number that is nothing of the sort, which is the defect
   * src/lib/overview-range.ts was written to prevent. So they are not
   * range-aware, and this field is how they say what they actually cover
   * instead of being made to lie one of two ways.
   */
  windowPhrase?: string;
  /** Personas offered this widget in the catalog. */
  personas: readonly WidgetPersona[];
  /** TanStack Query key roots the widget reads, so a refresh can invalidate them. */
  queryKeys: readonly string[];
  /** Dynamic import for React.lazy. Keeps off-board widgets out of the bundle. */
  load: () => Promise<{ default: ComponentType<WidgetProps> }>;
  /**
   * True when this widget should not be on the board at all for this account.
   *
   * REMOVED, not rendered quiet. A widget that has stopped applying and still
   * occupies a frame teaches the seller that frames can be meaningless, and the
   * quiet state ("nothing to show yet") is a promise that something will show
   * up later. The FlipDesk promo for someone already running FlipDesk is not
   * empty, it is finished.
   */
  omitWhen?: (context: LayoutContext) => boolean;
}

/** One entry of a saved layout. */
export interface LayoutEntry {
  id: string;
  size: WidgetSize;
}

/** The jsonb document stored in dashboard_layouts.layout. */
export interface LayoutDocument {
  version: number;
  widgets: LayoutEntry[];
}

/** Bump only for a shape change the normalizer cannot migrate in place. */
export const LAYOUT_VERSION = 1;

const ALL_PERSONAS = WIDGET_PERSONAS;

/**
 * The personas FlipDesk is for. Buyer is absent on purpose: a buyer account has
 * no FlipDesk surface, so a `flipdesk.*` widget on its board would query rows it
 * cannot read and render an error frame forever.
 */
const FLIPDESK_PERSONAS: readonly WidgetPersona[] = [
  "seller",
  "consignment",
  "developer",
];

// The registry. US-3075 fills the grading surface; US-3076 (flipdesk) and
// US-3077 (ios-home) add the rest of each surface's set.
//
// Order here is the catalog's order, and the catalog reads best when a seller's
// own numbers come before the things that sell them something, so the grading
// block runs data, then action, then promo.
export const DASHBOARD_WIDGETS: readonly WidgetDef[] = [
  {
    id: "grading.usage",
    surface: "grading",
    title: "Plan usage",
    blurb: "Listings, AI actions and grades used against your plan this month.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ["seller", "consignment", "developer"],
    queryKeys: ["billing-summary"],
    load: () =>
      import("@/components/billing/usage-meter").then((m) => ({
        default: m.UsageMeters as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.queue",
    surface: "grading",
    title: "Grading queue",
    blurb: "Where every submission stands right now, one count per status.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ["seller", "consignment", "developer"],
    queryKeys: ["dashboard-submission-queue"],
    load: () =>
      import("@/components/dashboard/widgets/grading-queue").then((m) => ({
        default: m.GradingQueueWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.attention",
    surface: "grading",
    title: "Needs your attention",
    blurb: "Submissions in review, failed or disputed, newest first.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ["seller", "consignment", "developer"],
    queryKeys: ["dashboard-attention"],
    load: () =>
      import("@/components/dashboard/widgets/grading-attention").then((m) => ({
        default: m.GradingAttentionWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.plan",
    surface: "grading",
    title: "Current plan",
    blurb: "The plan you are on and what it costs.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: false,
    personas: ["seller", "consignment", "developer"],
    queryKeys: [],
    load: () =>
      import("@/components/dashboard/widgets/grading-plan").then((m) => ({
        default: m.GradingPlanWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.charts",
    surface: "grading",
    title: "Grade trends",
    blurb: "How your grades are distributed and where the average is heading.",
    category: "data",
    sizes: ["lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ["seller", "consignment"],
    queryKeys: ["dashboard-charts"],
    load: () =>
      import("@/components/dashboard/grade-charts").then((m) => ({
        default: m.GradeCharts as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.recent-submissions",
    surface: "grading",
    title: "Recent submissions",
    blurb: "Your latest five submissions and the grades they came back with.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ["seller", "consignment", "developer"],
    queryKeys: ["dashboard-recent-submissions"],
    load: () =>
      import("@/components/dashboard/widgets/grading-recent-submissions").then(
        (m) => ({
          default: m.GradingRecentSubmissionsWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "grading.listing-suggestions",
    surface: "grading",
    title: "Listing suggestions",
    blurb: "Graded inventory that is worth putting up next.",
    category: "data",
    sizes: ["lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ["seller", "consignment"],
    queryKeys: ["dashboard-listing-suggestions"],
    load: () =>
      import("@/components/dashboard/widgets/grading-listing-suggestions").then(
        (m) => ({
          default: m.GradingListingSuggestionsWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "grading.activation",
    surface: "grading",
    title: "Getting started",
    blurb: "The steps left before your first grade is live.",
    category: "action",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ALL_PERSONAS,
    queryKeys: ["activation-checklist"],
    load: () =>
      import("@/components/onboarding/activation-checklist").then((m) => ({
        default: m.ActivationChecklist as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.quick-actions",
    surface: "grading",
    title: "Quick actions",
    blurb: "The three things you do most, one click away.",
    category: "action",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ALL_PERSONAS,
    queryKeys: [],
    load: () =>
      import("@/components/dashboard/widgets/grading-quick-actions").then((m) => ({
        default: m.GradingQuickActionsWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.rewards",
    surface: "grading",
    title: "Rewards",
    blurb: "Your level, season, badges and how far the next real reward is.",
    category: "promo",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ["seller", "consignment", "buyer"],
    queryKeys: ["rewards-summary"],
    load: () =>
      import("@/components/rewards/rewards-widget").then((m) => ({
        default: m.RewardsWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.flipdesk-promo",
    surface: "grading",
    title: "Try FlipDesk",
    blurb: "Run sourcing, listing and payouts beside your grades.",
    category: "promo",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ["seller", "consignment"],
    queryKeys: ["inventory-item-count"],
    load: () =>
      import("@/components/dashboard/widgets/grading-flipdesk-promo").then((m) => ({
        default: m.GradingFlipdeskPromoWidget as ComponentType<WidgetProps>,
      })),
    // US-3075 AC5: gone for good once there is any inventory.
    omitWhen: (context) => context.hasInventory === true,
  },
  {
    id: "grading.discover",
    surface: "grading",
    title: "Discover GradeThread",
    blurb: "Passports, the Verified Seller profile and the Buyer Guarantee.",
    category: "promo",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ALL_PERSONAS,
    queryKeys: ["dashboard-passports"],
    load: () =>
      import("@/components/dashboard/widgets/grading-discover").then((m) => ({
        default: m.GradingDiscoverWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    // US-3116: the iOS app and both browser extensions, on the board. Nothing
    // on the seller's dashboard linked to any of the three, so the only people
    // who found them were the ones already deep in the cross-listing UI.
    id: "grading.get-apps",
    surface: "grading",
    title: "Get GradeThread everywhere",
    blurb: "The iPhone app and the Chrome and Firefox extensions.",
    category: "promo",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: ALL_PERSONAS,
    // Three static links. Nothing to invalidate, so nothing to declare.
    queryKeys: [],
    load: () =>
      import("@/components/dashboard/widgets/grading-get-apps").then((m) => ({
        default: m.GradingGetAppsWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.invite",
    surface: "grading",
    title: "Invite a friend",
    blurb: "Your referral link and how many people have used it.",
    category: "promo",
    sizes: ["sm", "md"],
    defaultSize: "md",
    rangeAware: false,
    personas: ALL_PERSONAS,
    queryKeys: ["referrals-me"],
    load: () =>
      import("@/components/referral/invite-friend-card").then((m) => ({
        default: m.InviteFriendCard as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.impact",
    surface: "grading",
    title: "Circularity impact",
    blurb: "What reselling your graded items kept out of landfill.",
    category: "promo",
    sizes: ["sm", "md"],
    defaultSize: "md",
    rangeAware: false,
    personas: ["seller", "consignment", "buyer"],
    queryKeys: ["impact-garment-counts", "impact-summary"],
    load: () =>
      import("@/components/impact/impact-tile").then((m) => ({
        default: m.ImpactTile as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "grading.passports",
    surface: "grading",
    title: "Garment passports",
    blurb: "The public provenance passports your grades have created.",
    category: "promo",
    sizes: ["sm", "md"],
    defaultSize: "md",
    rangeAware: false,
    personas: ["seller", "consignment", "developer"],
    queryKeys: ["dashboard-passports"],
    load: () =>
      import("@/components/dashboard/widgets/grading-passports").then((m) => ({
        default: m.GradingPassportsWidget as ComponentType<WidgetProps>,
      })),
  },

  // US-3076: the FlipDesk Overview.
  //
  // Thirteen frames that were thirteen fixed blocks in one 800-line page. Every
  // number below comes from ONE call to useFlipdeskOverview(range), deduped by
  // its TanStack key across all of them: the widgets are separate modules, the
  // read is not, and no widget here may go near items_full to re-derive a
  // figure the aggregate already returned (US-2547, pinned by
  // src/test/overview-stage-and-range.test.ts).
  //
  // No `buyer` anywhere in this block. A buyer account has no FlipDesk surface,
  // so offering it one of these would put a card on the board that queries rows
  // the account cannot read; src/test/dashboard-layout-edit.test.ts asserts the
  // shipped registry never offers a buyer a `flipdesk.*` widget.
  {
    id: "flipdesk.north-star",
    surface: "flipdesk",
    title: "North Star",
    blurb: "Items listed this week against your goal, and the streak behind it.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-north-star").then((m) => ({
        default: m.FlipdeskNorthStarWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.stat-items",
    surface: "flipdesk",
    title: "Total items",
    blurb: "Everything you own right now, and what it is worth.",
    category: "data",
    // Not range-aware: a lifetime count and a live inventory value do not move
    // when the picker does, so "right now" is the only true label for it.
    rangeAware: false,
    sizes: ["sm", "md"],
    defaultSize: "sm",
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-stat-items").then((m) => ({
        default: m.FlipdeskStatItemsWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.stat-listed",
    surface: "flipdesk",
    title: "Listed",
    blurb: "Items you moved to listed in the window you picked.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: true,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-stat-listed").then((m) => ({
        default: m.FlipdeskStatListedWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.stat-sold",
    surface: "flipdesk",
    title: "Sold",
    blurb: "Items sold in the window you picked, and what they grossed.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: true,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-stat-sold").then((m) => ({
        default: m.FlipdeskStatSoldWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.stat-net",
    surface: "flipdesk",
    title: "Net profit",
    blurb: "What you kept after fees and cost of goods, in the window you picked.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: true,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-stat-net").then((m) => ({
        default: m.FlipdeskStatNetWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.stat-time-saved",
    surface: "flipdesk",
    title: "Time saved",
    blurb: "Hours FlipDesk saved you this month, task by task.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    // US-9207 counts a calendar month, not the picker's window.
    rangeAware: false,
    windowPhrase: "this month",
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["time_saved"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-stat-time-saved").then(
        (m) => ({
          default: m.FlipdeskStatTimeSavedWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "flipdesk.stat-review-median",
    surface: "flipdesk",
    title: "Photos to Approve",
    blurb: "How long an item takes you from first photo to Approve, at the median.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    // US-9204 is a median over every item that has been through review.
    rangeAware: false,
    windowPhrase: "across every item you have reviewed",
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["review_approve_median"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-stat-review-median").then(
        (m) => ({
          default: m.FlipdeskStatReviewMedianWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "flipdesk.pipeline",
    surface: "flipdesk",
    title: "Pipeline",
    blurb: "Where every item stands, one count per stage. Open a stage to see them.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-pipeline").then((m) => ({
        default: m.FlipdeskPipelineWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.aging",
    surface: "flipdesk",
    title: "Aging items",
    blurb: "Items stuck in the same stage for more than two weeks.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-aging").then((m) => ({
        default: m.FlipdeskAgingWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.stale",
    surface: "flipdesk",
    title: "Stale listings",
    blurb: "Listings live for two weeks with nobody watching, and what to do next.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full", "repricing-suggestions"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-stale").then((m) => ({
        default: m.FlipdeskStaleWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.top-brands",
    surface: "flipdesk",
    title: "Top brands by profit",
    blurb: "Which labels actually made you money in the window you picked.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    rangeAware: true,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-top-brands").then((m) => ({
        default: m.FlipdeskTopBrandsWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.recent-sales",
    surface: "flipdesk",
    title: "Recent sales",
    blurb: "The last six items that sold, with what each one netted.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    rangeAware: true,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["items_full"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-recent-sales").then((m) => ({
        default: m.FlipdeskRecentSalesWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.community-insights",
    surface: "flipdesk",
    title: "Community insights",
    blurb: "What other sellers are sourcing and pricing well, anonymized.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    // US-1064 benchmarks the last twelve months of community sales, which is
    // its own window and not the seller's picker.
    rangeAware: false,
    windowPhrase: "across the last 12 months of community sales",
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["community-benchmarks"],
    load: () =>
      import("@/components/flipdesk/community-insights-widget").then((m) => ({
        default: m.CommunityInsightsWidget as ComponentType<WidgetProps>,
      })),
  },

  // ── The work with a clock on it (US-3077) ─────────────────────────────────
  //
  // Everything above reports; these eight say what to DO, which is why they are
  // `category: "action"` and shelve together in the Add-widget catalog.
  //
  // Only the first ships on the default board. The other seven are real work
  // for the sellers who have that work and dead frames for the sellers who do
  // not: an account with no cross-listing extension, no Sheets sync and no
  // automation rules would open the overview to five permanent zeroes, and a
  // board that is mostly zeroes teaches the seller to stop reading it. The
  // catalog is where they belong until the seller says otherwise.
  //
  // None follows the range picker. Every one of them is a live queue, so
  // "in the last 30 days" over an open-offer count would be a plain lie; the
  // two with a genuine fixed window name it themselves.
  {
    id: "flipdesk.needs-you",
    surface: "flipdesk",
    title: "Needs you",
    blurb: "Everything eBay is waiting on, soonest deadline first.",
    category: "action",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: [
      "ebay_returns",
      "ebay_cancellations",
      "ebay_inquiries",
      "ebay_cases",
      "ebay_payment_disputes",
      "ebay_best_offers",
    ],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-needs-you").then((m) => ({
        default: m.FlipdeskNeedsYouWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.offers",
    surface: "flipdesk",
    title: "Open offers",
    blurb: "Best Offers waiting on your answer, and how long the soonest has.",
    category: "action",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["ebay_best_offers"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-offers").then((m) => ({
        default: m.FlipdeskOffersWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.extension-queue",
    surface: "flipdesk",
    title: "Extension queue",
    blurb: "Listings, delists and edits waiting for your desktop browser to run them.",
    category: "action",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: [
      "extension_queue",
      "pending_delists",
      "pending_revises",
      "extension_setup",
    ],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-extension-queue").then(
        (m) => ({
          default: m.FlipdeskExtensionQueueWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "flipdesk.sync-conflicts",
    surface: "flipdesk",
    title: "Sync conflicts",
    blurb: "Where FlipDesk, eBay and your sheet disagree about the same listing.",
    category: "action",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["sync_conflicts"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-sync-conflicts").then(
        (m) => ({
          default: m.FlipdeskSyncConflictsWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "flipdesk.autolister-drafts",
    surface: "flipdesk",
    title: "Drafts to review",
    blurb: "AutoLister drafts written and priced, waiting on your read-through.",
    category: "action",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["autolister_drafts", "billing-summary"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-autolister-drafts").then(
        (m) => ({
          default:
            m.FlipdeskAutolisterDraftsWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "flipdesk.scheduled-drops",
    surface: "flipdesk",
    title: "Scheduled drops",
    blurb: "Drafts queued to publish soon, and which one goes first.",
    category: "action",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    // The only widget on this board that looks FORWARD. The picker's phrase
    // would print "in the last 30 days" over a list of future publishes.
    rangeAware: false,
    windowPhrase: "in the next 7 days",
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["scheduled_drops"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-scheduled-drops").then(
        (m) => ({
          default: m.FlipdeskScheduledDropsWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "flipdesk.automations",
    surface: "flipdesk",
    title: "Automations",
    blurb: "Rules running on their own, and what they did this week.",
    category: "action",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    // The rule count is live; the activity behind it is a fixed week, which is
    // the window that answers "is this still working" whatever the picker says.
    rangeAware: false,
    windowPhrase: "in the last 7 days",
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["automation_rules", "automation_rule_actions"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-automations").then((m) => ({
        default: m.FlipdeskAutomationsWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.repricing",
    surface: "flipdesk",
    title: "Repricing nudges",
    blurb: "Listings the comps say are mispriced, waiting on your call.",
    category: "action",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["repricing_suggestions"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-repricing").then((m) => ({
        default: m.FlipdeskRepricingWidget as ComponentType<WidgetProps>,
      })),
  },

  // The money and the account health (US-3078)
  //
  // Six cards that already existed on four different pages: Money, Analytics,
  // Marketplaces, Scout and Consignment. Every entry below LOADS THE EXISTING
  // COMPONENT and the source page keeps rendering it. Nothing here is a second
  // copy of a card, which is the point of the story rather than a detail of it:
  // two payout lists, or two equity figures, disagree eventually, and the
  // seller finds out by reading two numbers for the same thing.
  //
  // CATALOG-ONLY. None of the six is on the default board. The board already
  // opens with fourteen widgets, and six more would push the queue past a
  // laptop screen to answer a question most sellers ask weekly, not daily.
  // They are in the Add-widget sheet for the sellers who want them there.
  {
    id: "flipdesk.payouts",
    surface: "flipdesk",
    title: "eBay payouts",
    blurb: "Bank deposits from eBay, what is still on the way and when it lands.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    // The Finances feed is a fixed 90-day window, not the picker's.
    rangeAware: false,
    windowPhrase: "in the last 90 days",
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["ebay_payouts", "ebay_connection"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-payouts").then((m) => ({
        default: m.FlipdeskPayoutsWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.ad-spend",
    surface: "flipdesk",
    title: "What advertising cost",
    blurb: "Promoted Listings fees against the sales they came out of.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    // AC2: the one widget in this block that takes the board's window.
    rangeAware: true,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["ebay_ad_spend"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-ad-spend").then((m) => ({
        default: m.FlipdeskAdSpendWidget as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.equity",
    surface: "flipdesk",
    title: "Inventory equity",
    blurb: "Estimated liquidation value of your graded inventory, and its trend.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    // A live valuation of what is on the racks: "right now" is the true label.
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["flipdesk-equity", "flipdesk-equity-trend"],
    // Loaded straight, with no wrapper module, the way grading.charts and
    // flipdesk.community-insights are. The card needs nothing adapting, and a
    // wrapper that only forwards would be a SECOND file named for equity:
    // src/test/inventory-equity-scope-fence.test.ts requires the estimate
    // disclosure verbatim on every one of those, so the wrapper would either
    // print the sentence twice in one frame or make the fence a formality.
    load: () =>
      import("@/components/flipdesk/inventory-equity-card").then((m) => ({
        default: m.InventoryEquityCard as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.forecast",
    surface: "flipdesk",
    title: "Resale forecast",
    blurb: "Price, days to sell and 12-month value for a brand, from your own sales.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "lg",
    // It looks FORWARD a year off a history the seller does not pick a window
    // for, so the picker's phrase would be wrong about both ends.
    rangeAware: false,
    windowPhrase: "12 months ahead, from your own sales",
    personas: FLIPDESK_PERSONAS,
    // Nothing to invalidate: the forecast is a mutation the seller fires by
    // pressing Forecast, not a query a board refresh could re-run.
    queryKeys: [],
    // AC4's "no seed brand" is what loading the card straight gives: the board
    // passes size, surface and range, never a brand, so the field opens empty
    // and waits. Scout still passes the brand it was searching.
    load: () =>
      import("@/components/flipdesk/forecast-card").then((m) => ({
        default: m.ForecastCard as ComponentType<WidgetProps>,
      })),
  },
  {
    id: "flipdesk.marketplace-health",
    surface: "flipdesk",
    title: "Marketplace health",
    blurb: "Which platforms are connected, and where eBay says your account stands.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    // Connection status and a current standing are both snapshots.
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: [
      "ebay_connection",
      "ebay_connection_issue",
      "ebay_account_health",
      "shopify_connection",
      "google_connection",
    ],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-marketplace-health").then(
        (m) => ({
          default:
            m.FlipdeskMarketplaceHealthWidget as ComponentType<WidgetProps>,
        }),
      ),
  },
  {
    id: "flipdesk.consignor-payouts",
    surface: "flipdesk",
    title: "Consignors owed",
    blurb: "Consignors with a payout still due, and what it adds up to.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "sm",
    // An open balance, not a window.
    rangeAware: false,
    personas: FLIPDESK_PERSONAS,
    queryKeys: ["consignor-payouts"],
    load: () =>
      import("@/components/dashboard/widgets/flipdesk-consignor-payouts").then(
        (m) => ({
          default:
            m.FlipdeskConsignorPayoutsWidget as ComponentType<WidgetProps>,
        }),
      ),
    // AC6: an account that runs no consignment never sees this in the catalog.
    // Absent, not quiet -- "0 consignors owed" forever is a card about someone
    // else's business, and the frame's "nothing to show yet" is a promise that
    // something will show up.
    //
    // `=== false` and not `!hasConsignors`: undefined means the count has not
    // answered (or failed), and a widget must never blink out of the catalog
    // and back in while a query is in flight.
    omitWhen: (context) => context.hasConsignors === false,
  },
];

/**
 * The widgets that sell something rather than report something (US-3075 AC4).
 *
 * Named explicitly, not derived from `category`, because the two axes answer
 * different questions. `category` groups the Add-widget catalog, where "Things
 * to do" is its own useful shelf; this list answers "may it sit above the
 * seller's own numbers", and for the activation checklist and the quick actions
 * the answer is no even though neither is a promotion in the catalog's sense.
 *
 * The invariant it exists for: in every shipped default, every id in here sits
 * below every `category: "data"` widget. A returning seller sees their queue,
 * not a card asking them to invite a friend.
 */
export const PROMOTIONAL_WIDGET_IDS: readonly string[] = [
  "grading.activation",
  "grading.quick-actions",
  "grading.rewards",
  "grading.flipdesk-promo",
  "grading.discover",
  "grading.get-apps",
  "grading.invite",
  "grading.impact",
];

/** Every widget registered for one surface, in registry order. */
export function widgetsForSurface(surface: DashboardSurface): readonly WidgetDef[] {
  return DASHBOARD_WIDGETS.filter((w) => w.surface === surface);
}

/** One widget by id, or undefined when the id is unknown (a retired widget). */
export function widgetById(
  id: string,
  registry: readonly WidgetDef[] = DASHBOARD_WIDGETS,
): WidgetDef | undefined {
  return registry.find((w) => w.id === id);
}

/**
 * The FlipDesk board every persona that has FlipDesk starts with (US-3076 AC4).
 *
 * One list, shared by three personas rather than copied three times: nothing in
 * it is persona-specific, and three copies of the same thirteen ids is three
 * places for the next widget to be added to two of.
 */
const FLIPDESK_DEFAULT_LAYOUT: readonly LayoutEntry[] = [
  // US-3077: the ranked eBay queue opens the board, above the weekly goal.
  //
  // The story it belongs to is "I open the overview and know what to do first
  // instead of touring six pages", and a widget the seller has to discover in
  // the catalog cannot do that. It is also the only one of the eight action
  // widgets that is never a dead frame: an account with nothing waiting reads
  // "Nothing waiting on you", which is a real answer, where an extension-queue
  // tile on an account with no extension is a permanent zero.
  { id: "flipdesk.needs-you", size: "lg" },
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
];

// The layout a seller sees before they ever customize. Per surface, per
// persona, in reading order: own data first, anything promotional last.
// The ios-home surface is filled by US-3077.
export const DEFAULT_LAYOUTS: Record<
  DashboardSurface,
  Record<WidgetPersona, readonly LayoutEntry[]>
> = {
  grading: {
    seller: [
      { id: "grading.usage", size: "lg" },
      { id: "grading.queue", size: "lg" },
      { id: "grading.attention", size: "lg" },
      { id: "grading.charts", size: "lg" },
      { id: "grading.recent-submissions", size: "lg" },
      { id: "grading.listing-suggestions", size: "lg" },
      // US-3075 follow-up: AC1 registers grading.plan and AC4's persona lists
      // omit it, which is an inconsistency in the story rather than a decision.
      // Followed literally it deletes the Current Plan card from every existing
      // seller's dashboard with no migration and no announcement, so it is
      // restored -- but LAST among the data widgets, not beside usage. Putting it
      // second pushed the queue down and broke "opens the board with the queue",
      // which is the whole point of the story. Here it stays visible, the queue
      // still opens the board, and the promotional-widgets-last invariant holds
      // because plan is data. Developer keeps AC4's list: no billing surface.
      { id: "grading.plan", size: "sm" },
      { id: "grading.activation", size: "lg" },
      { id: "grading.quick-actions", size: "lg" },
      { id: "grading.rewards", size: "lg" },
      { id: "grading.flipdesk-promo", size: "lg" },
      { id: "grading.discover", size: "lg" },
      // US-3116: below Discover, above the invite tile. Promotional, so it sits
      // under every data widget (src/test/dashboard-own-data-first.test.ts).
      { id: "grading.get-apps", size: "lg" },
      { id: "grading.invite", size: "md" },
      { id: "grading.impact", size: "md" },
    ],
    consignment: [
      { id: "grading.usage", size: "lg" },
      { id: "grading.queue", size: "lg" },
      { id: "grading.attention", size: "lg" },
      { id: "grading.charts", size: "lg" },
      { id: "grading.recent-submissions", size: "lg" },
      { id: "grading.listing-suggestions", size: "lg" },
      // US-3075 follow-up: AC1 registers grading.plan and AC4's persona lists
      // omit it, which is an inconsistency in the story rather than a decision.
      // Followed literally it deletes the Current Plan card from every existing
      // seller's dashboard with no migration and no announcement, so it is
      // restored -- but LAST among the data widgets, not beside usage. Putting it
      // second pushed the queue down and broke "opens the board with the queue",
      // which is the whole point of the story. Here it stays visible, the queue
      // still opens the board, and the promotional-widgets-last invariant holds
      // because plan is data. Developer keeps AC4's list: no billing surface.
      { id: "grading.plan", size: "sm" },
      { id: "grading.activation", size: "lg" },
      { id: "grading.quick-actions", size: "lg" },
      { id: "grading.rewards", size: "lg" },
      { id: "grading.flipdesk-promo", size: "lg" },
      { id: "grading.discover", size: "lg" },
      // US-3116: below Discover, above the invite tile. Promotional, so it sits
      // under every data widget (src/test/dashboard-own-data-first.test.ts).
      { id: "grading.get-apps", size: "lg" },
      { id: "grading.invite", size: "md" },
      { id: "grading.impact", size: "md" },
    ],
    developer: [
      { id: "grading.usage", size: "lg" },
      { id: "grading.queue", size: "lg" },
      { id: "grading.attention", size: "lg" },
      { id: "grading.recent-submissions", size: "lg" },
      { id: "grading.quick-actions", size: "lg" },
      { id: "grading.get-apps", size: "lg" },
      { id: "grading.passports", size: "md" },
    ],
    buyer: [
      { id: "grading.quick-actions", size: "lg" },
      { id: "grading.discover", size: "lg" },
      { id: "grading.get-apps", size: "lg" },
      { id: "grading.invite", size: "md" },
    ],
  },
  flipdesk: {
    // US-3076 AC4, in the order the story fixes: the weekly goal, then the seven
    // numbers, then the pipeline, then the four lists, then the community.
    // Nothing on this surface is promotional, so the own-data-first invariant
    // (src/test/dashboard-own-data-first.test.ts) has nothing to push down.
    seller: FLIPDESK_DEFAULT_LAYOUT,
    consignment: FLIPDESK_DEFAULT_LAYOUT,
    developer: FLIPDESK_DEFAULT_LAYOUT,
    // A buyer has no FlipDesk. An empty board is the honest answer, and the
    // catalog offers this persona nothing here either.
    buyer: [],
  },
  "ios-home": { seller: [], buyer: [], consignment: [], developer: [] },
};

/** The shipped layout for a surface and persona. Never mutated; copy to edit. */
export function defaultLayoutFor(
  surface: DashboardSurface,
  persona: WidgetPersona,
): LayoutEntry[] {
  const bySurface = DEFAULT_LAYOUTS[surface];
  const entries = bySurface?.[persona] ?? bySurface?.[DEFAULT_PERSONA] ?? [];
  return entries.map((e) => ({ ...e }));
}

/** Narrow an arbitrary string to a surface, for a URL or a stored value. */
export function isDashboardSurface(value: unknown): value is DashboardSurface {
  return (
    typeof value === "string" &&
    (DASHBOARD_SURFACES as readonly string[]).includes(value)
  );
}

/** Narrow an arbitrary value to a widget size. */
export function isWidgetSize(value: unknown): value is WidgetSize {
  return (
    typeof value === "string" && (WIDGET_SIZES as readonly string[]).includes(value)
  );
}

/** What a widget's frame says when its numbers do not follow a range picker. */
export const DEFAULT_WINDOW_PHRASE = "right now";

/**
 * The window a widget's frame declares under its title (US-3076 AC3).
 *
 * `null` on a board with no range picker, where every frame is unqualified and
 * a subtitle would be noise; the grading dashboard is unchanged by this.
 */
export function widgetWindowPhrase(
  def: WidgetDef,
  range: OverviewRangeId | undefined,
): string | null {
  if (!range) return null;
  if (def.rangeAware) return overviewRangeDef(range).phrase;
  return def.windowPhrase ?? DEFAULT_WINDOW_PHRASE;
}

/** Narrow an arbitrary value to a persona. */
export function isWidgetPersona(value: unknown): value is WidgetPersona {
  return (
    typeof value === "string" && (WIDGET_PERSONAS as readonly string[]).includes(value)
  );
}
