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

// The registry. US-3075 (grading), US-3076 (flipdesk) and US-3077 (ios-home)
// add the rest of each surface's set; these four are the widgets the board
// itself is proven against.
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
    id: "grading.impact",
    surface: "grading",
    title: "Circularity impact",
    blurb: "What reselling your graded items kept out of landfill.",
    category: "data",
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
      { id: "grading.charts", size: "lg" },
      { id: "grading.impact", size: "md" },
      { id: "grading.invite", size: "md" },
    ],
    consignment: [
      { id: "grading.usage", size: "lg" },
      { id: "grading.charts", size: "lg" },
      { id: "grading.impact", size: "md" },
      { id: "grading.invite", size: "md" },
    ],
    developer: [
      { id: "grading.usage", size: "lg" },
      { id: "grading.invite", size: "md" },
    ],
    buyer: [
      { id: "grading.impact", size: "md" },
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
