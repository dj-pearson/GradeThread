import type { ComponentType } from "react";
import type { UserUseCase } from "@/types/database";

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
}

/** Props every widget component accepts. Widgets that need neither ignore both. */
export interface WidgetProps {
  /** The size the seller picked, so a widget can render compactly at `sm`. */
  size: WidgetSize;
  surface: DashboardSurface;
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

// The layout a seller sees before they ever customize. Per surface, per
// persona, in reading order: own data first, anything promotional last.
// The empty surfaces are filled by US-3076 and US-3077.
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
      { id: "grading.activation", size: "lg" },
      { id: "grading.quick-actions", size: "lg" },
      { id: "grading.rewards", size: "lg" },
      { id: "grading.flipdesk-promo", size: "lg" },
      { id: "grading.discover", size: "lg" },
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
      { id: "grading.activation", size: "lg" },
      { id: "grading.quick-actions", size: "lg" },
      { id: "grading.rewards", size: "lg" },
      { id: "grading.flipdesk-promo", size: "lg" },
      { id: "grading.discover", size: "lg" },
      { id: "grading.invite", size: "md" },
      { id: "grading.impact", size: "md" },
    ],
    developer: [
      { id: "grading.usage", size: "lg" },
      { id: "grading.queue", size: "lg" },
      { id: "grading.attention", size: "lg" },
      { id: "grading.recent-submissions", size: "lg" },
      { id: "grading.quick-actions", size: "lg" },
      { id: "grading.passports", size: "md" },
    ],
    buyer: [
      { id: "grading.quick-actions", size: "lg" },
      { id: "grading.discover", size: "lg" },
      { id: "grading.invite", size: "md" },
    ],
  },
  flipdesk: { seller: [], buyer: [], consignment: [], developer: [] },
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

/** Narrow an arbitrary value to a persona. */
export function isWidgetPersona(value: unknown): value is WidgetPersona {
  return (
    typeof value === "string" && (WIDGET_PERSONAS as readonly string[]).includes(value)
  );
}
