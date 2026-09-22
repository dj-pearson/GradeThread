import type {
  DashboardSurface,
  WidgetPersona,
} from "@/lib/dashboard-widgets";

// US-3469: one Overview, two views.
//
// The product had two overviews. /dashboard was the grading board and
// /dashboard/flipdesk was the FlipDesk board, and a seller who does both had
// two pages to check every morning, two Customize buttons, and two mental
// models of where a number lives. This file is the whole of what a "view" is:
// a label, the widget surface it renders, and the sentence under the title.
//
// A VIEW IS NOT A NEW KIND OF BOARD. It selects one of the surfaces the widget
// registry already has, so each view keeps its own saved layout in the same
// dashboard_layouts row it has always used (the table is keyed by user AND
// surface). Nothing is migrated, and no seller loses the arrangement they built
// on either page.

/** The views the single Overview page can show. */
export const OVERVIEW_VIEWS = ["grading", "flipdesk"] as const;
export type OverviewViewId = (typeof OVERVIEW_VIEWS)[number];

/** The query param that names the view. `?view=flipdesk`. */
export const OVERVIEW_VIEW_PARAM = "view";

/** The view a seller sees before they have ever chosen one. */
export const DEFAULT_OVERVIEW_VIEW: OverviewViewId = "grading";

export interface OverviewViewDef {
  id: OverviewViewId;
  /** As the switcher spells it. */
  label: string;
  /** The widget-board surface this view renders. */
  surface: DashboardSurface;
  /** The line under the page title while this view is showing. */
  subtitle: string;
}

export const OVERVIEW_VIEW_DEFS: readonly OverviewViewDef[] = [
  {
    id: "grading",
    label: "Grading",
    surface: "grading",
    subtitle: "Your grades, your plan usage, and what needs you today.",
  },
  {
    id: "flipdesk",
    label: "FlipDesk",
    surface: "flipdesk",
    subtitle: "What's moving, what's stuck, and what's making money.",
  },
];

export function isOverviewViewId(value: unknown): value is OverviewViewId {
  return (
    typeof value === "string" &&
    (OVERVIEW_VIEWS as readonly string[]).includes(value)
  );
}

/** The definition for a view. Total, because the id is narrowed first. */
export function overviewViewDef(id: OverviewViewId): OverviewViewDef {
  return OVERVIEW_VIEW_DEFS.find((v) => v.id === id) ?? OVERVIEW_VIEW_DEFS[0]!;
}

/**
 * The views this account is offered.
 *
 * A buyer has no FlipDesk: DEFAULT_LAYOUTS.flipdesk.buyer is empty and the
 * catalog offers a buyer no `flipdesk.*` widget, so a FlipDesk tab would open a
 * blank board with an Add-widget sheet that has nothing in it. One view means
 * the switcher does not render at all, which is the honest answer.
 */
export function availableOverviewViews(
  persona: WidgetPersona,
): readonly OverviewViewDef[] {
  if (persona === "buyer") {
    return OVERVIEW_VIEW_DEFS.filter((v) => v.id === "grading");
  }
  return OVERVIEW_VIEW_DEFS;
}

/**
 * Which view to show, given the URL, what this seller last used, and who they
 * are.
 *
 * Order matters and is the whole contract: the URL param wins, then the
 * remembered choice, then the shipped default. A link someone was handed has to
 * mean what it says, whatever the person opening it usually looks at.
 *
 * Anything the account is not offered falls through to the first view it IS
 * offered, so a stale `?view=flipdesk` in a buyer's bookmark cannot strand them
 * on an empty board.
 */
export function resolveOverviewView(
  param: string | null | undefined,
  remembered: string | null | undefined,
  persona: WidgetPersona,
): OverviewViewId {
  const offered = availableOverviewViews(persona);
  const allowed = (value: unknown): OverviewViewId | null =>
    isOverviewViewId(value) && offered.some((v) => v.id === value) ? value : null;

  return (
    allowed(param) ??
    allowed(remembered) ??
    allowed(DEFAULT_OVERVIEW_VIEW) ??
    offered[0]!.id
  );
}

// ── the remembered view ─────────────────────────────────────────────────────
//
// Kept in localStorage rather than in a column, deliberately. It is a "where I
// was looking" preference, not account state: it has no server consumer, it
// must not cost a write on every tab click, and getting it wrong costs one
// click. The dashboard_layouts mirror next door (use-dashboard-layout.ts) takes
// the same view of the same kind of value.

const VIEW_KEY_PREFIX = "gt:overview-view:";

/** Per user, so two people sharing a browser do not inherit each other's tab. */
export function overviewViewKey(userId: string | null | undefined): string {
  return `${VIEW_KEY_PREFIX}${userId ?? "anon"}`;
}

export function readOverviewView(key: string): OverviewViewId | null {
  try {
    const raw = localStorage.getItem(key);
    return isOverviewViewId(raw) ? raw : null;
  } catch {
    // Private mode, blocked storage, no window. The default is a working page.
    return null;
  }
}

export function writeOverviewView(key: string, view: OverviewViewId): void {
  try {
    localStorage.setItem(key, view);
  } catch {
    /* Storage is optional; the URL still carries the choice for this visit. */
  }
}
