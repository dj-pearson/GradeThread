import { arrayMove } from "@dnd-kit/sortable";
import {
  DEFAULT_PERSONA,
  LAYOUT_VERSION,
  WIDGET_CATEGORIES,
  defaultLayoutFor,
  isWidgetSize,
  type DashboardSurface,
  type LayoutContext,
  type LayoutDocument,
  type LayoutEntry,
  type WidgetCategory,
  type WidgetDef,
  type WidgetPersona,
  type WidgetSize,
} from "@/lib/dashboard-widgets";

// US-3073: the pure half of the widget board.
//
// Everything that decides WHAT is on a board lives here, with no React and no
// Supabase, so every branch is a plain unit test. The hook and the component
// only move the result around.
//
// A stored layout is data the browser wrote months ago against a registry that
// has since changed: widgets get retired, sizes get restricted, a document
// written by a newer client can arrive in an older one. normalize() is the
// single place that reconciles the two, and it never throws: a layout it
// cannot make sense of resolves to the persona default, which is always a
// working board.

/** The document as it is stored in dashboard_layouts.layout. */
export function layoutDocument(widgets: readonly LayoutEntry[]): LayoutDocument {
  return { version: LAYOUT_VERSION, widgets: widgets.map((w) => ({ ...w })) };
}

/** The surface a registry describes. Registries are per-surface by construction. */
function surfaceOf(registry: readonly WidgetDef[]): DashboardSurface | null {
  return registry[0]?.surface ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reconcile a stored layout with the current registry.
 *
 * - unknown widget ids are dropped (retired widget, or another surface's)
 * - a widget whose `omitWhen` answers true for this account is dropped
 * - a size the widget does not allow is clamped to its defaultSize
 * - a repeated id keeps the FIRST occurrence and drops the rest
 * - a missing, malformed or unknown-version document returns the persona default
 *
 * An empty widget list in a well-formed current-version document is honored as
 * an empty board: hiding everything is a choice a seller can make, and turning
 * it back into the default would make Hide look broken.
 *
 * `context` defaults to empty, and an empty context omits NOTHING, so every
 * existing caller keeps the board it had. US-3075 AC5 is the only user of it:
 * the FlipDesk promo leaves the board once the account has inventory.
 */
export function normalize(
  stored: unknown,
  registry: readonly WidgetDef[],
  persona: WidgetPersona,
  context: LayoutContext = {},
): LayoutEntry[] {
  const surface = surfaceOf(registry);
  const fallback = (): LayoutEntry[] =>
    surface
      ? normalizeEntries(defaultLayoutFor(surface, persona), registry, context)
      : [];

  if (!isRecord(stored)) return fallback();
  if (stored.version !== LAYOUT_VERSION) return fallback();
  if (!Array.isArray(stored.widgets)) return fallback();

  return normalizeEntries(stored.widgets, registry, context);
}

/** The per-entry rules, shared by the stored document and the shipped default. */
function normalizeEntries(
  entries: readonly unknown[],
  registry: readonly WidgetDef[],
  context: LayoutContext,
): LayoutEntry[] {
  const out: LayoutEntry[] = [];
  const seen = new Set<string>();

  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const id = raw.id;
    if (typeof id !== "string" || seen.has(id)) continue;

    const def = registry.find((w) => w.id === id);
    if (!def) continue;
    if (def.omitWhen?.(context)) continue;

    const size = isWidgetSize(raw.size) && def.sizes.includes(raw.size)
      ? raw.size
      : def.defaultSize;

    seen.add(id);
    out.push({ id, size });
  }

  return out;
}

/** The persona to normalize against, given whatever the profile carries. */
export function personaOf(useCase: string | null | undefined): WidgetPersona {
  return useCase === "buyer" ||
    useCase === "consignment" ||
    useCase === "developer" ||
    useCase === "seller"
    ? useCase
    : DEFAULT_PERSONA;
}

// US-3074: the edit actions.
//
// Customize mode is a draft layout plus the handful of things a seller can do
// to it, and every one of them lives here as a pure function over a
// LayoutEntry[]. The component holds the draft and calls these; it never
// computes an index, a span or a size itself. That is what makes "resizing to a
// size the widget does not allow is a no-op" a one-line test rather than a
// click-through.
//
// Every action returns a NEW array and returns the input's contents unchanged
// when it cannot apply, so a caller can ask sameLayout() whether anything
// happened without depending on object identity.

/** Index of an id in a layout, or -1. */
function indexOf(entries: readonly LayoutEntry[], id: string): number {
  return entries.findIndex((e) => e.id === id);
}

/** A defensive copy, so no action can hand back a reference into its input. */
function copyOf(entries: readonly LayoutEntry[]): LayoutEntry[] {
  return entries.map((e) => ({ ...e }));
}

/**
 * Drag drop: put `activeId` where `overId` currently sits.
 *
 * Uses dnd-kit's own arrayMove rather than a second implementation of it, so
 * the reducer and the drag preview can never disagree about where an item
 * lands. Unknown ids, or a drop on itself, are a no-op.
 */
export function moveWidget(
  entries: readonly LayoutEntry[],
  activeId: string,
  overId: string,
): LayoutEntry[] {
  const from = indexOf(entries, activeId);
  const to = indexOf(entries, overId);
  const copy = copyOf(entries);
  if (from < 0 || to < 0 || from === to) return copy;
  return arrayMove(copy, from, to);
}

/**
 * The narrow-screen path: move one widget up (-1) or down (+1).
 *
 * Below the sm breakpoint there is no drag, so these buttons are the ONLY way
 * to reorder, which is why moving off either end is a no-op rather than a wrap:
 * a wrap at the top would send the widget to the bottom of a board the seller
 * cannot see all of, and read as the button doing nothing.
 */
export function moveWidgetBy(
  entries: readonly LayoutEntry[],
  id: string,
  delta: number,
): LayoutEntry[] {
  const from = indexOf(entries, id);
  const copy = copyOf(entries);
  if (from < 0) return copy;
  const to = from + delta;
  if (to < 0 || to >= copy.length) return copy;
  return arrayMove(copy, from, to);
}

/**
 * Set one widget's size.
 *
 * A size the widget does not declare is a NO-OP, not a clamp. normalize()
 * clamps, because it reconciles a document written against a registry that has
 * since changed and must always produce a working board. This is a live edit
 * against the CURRENT registry, where the only way to ask for a disallowed size
 * is a bug: substituting defaultSize would show a size the seller did not pick
 * and read as the control being broken.
 */
export function resizeWidget(
  entries: readonly LayoutEntry[],
  id: string,
  size: WidgetSize,
  registry: readonly WidgetDef[],
): LayoutEntry[] {
  const copy = copyOf(entries);
  const def = registry.find((w) => w.id === id);
  if (!def || !def.sizes.includes(size)) return copy;
  const at = indexOf(copy, id);
  if (at < 0) return copy;
  copy[at] = { id, size };
  return copy;
}

/** Take a widget off the board. Hiding the last one leaves an empty board. */
export function hideWidget(
  entries: readonly LayoutEntry[],
  id: string,
): LayoutEntry[] {
  return copyOf(entries.filter((e) => e.id !== id));
}

/**
 * Append a widget from the catalog at its defaultSize.
 *
 * Appended, never inserted: the seller picked it out of a sheet and has to be
 * able to find it afterwards, and the bottom of the board is the one place they
 * can predict. An id already on the board, or absent from the registry, is a
 * no-op.
 */
export function addWidget(
  entries: readonly LayoutEntry[],
  id: string,
  registry: readonly WidgetDef[],
): LayoutEntry[] {
  const copy = copyOf(entries);
  const def = registry.find((w) => w.id === id);
  if (!def || indexOf(copy, id) >= 0) return copy;
  copy.push({ id: def.id, size: def.defaultSize });
  return copy;
}

/**
 * Back to the shipped layout for this persona.
 *
 * Deliberately expressed as normalize() of nothing, so Reset and a
 * never-customized account can never drift apart.
 */
export function resetLayout(
  registry: readonly WidgetDef[],
  persona: WidgetPersona,
  context: LayoutContext = {},
): LayoutEntry[] {
  return normalize(null, registry, persona, context);
}

/**
 * The Add-widget catalog: registry widgets for this surface that are not on the
 * board and that this persona is offered.
 *
 * The persona filter is the load-bearing half. A buyer account has no FlipDesk
 * surface at all, so offering it a `flipdesk.*` widget would put a card on the
 * board that queries data the account cannot read and renders an error frame
 * forever. Registry order is kept, so the catalog reads the way the defaults do.
 */
export function addableWidgets(
  entries: readonly LayoutEntry[],
  registry: readonly WidgetDef[],
  persona: WidgetPersona,
  context: LayoutContext = {},
): WidgetDef[] {
  const onBoard = new Set(entries.map((e) => e.id));
  // omitWhen applies here too: normalize() taking the FlipDesk promo off the
  // board while the catalog offers it straight back is a loop with a button on
  // it.
  return registry.filter(
    (w) =>
      !onBoard.has(w.id) && w.personas.includes(persona) && !w.omitWhen?.(context),
  );
}

/** One catalog section. */
export interface WidgetCatalogGroup {
  category: WidgetCategory;
  widgets: WidgetDef[];
}

/** Group the catalog for the sheet, in WIDGET_CATEGORIES order, no empty sections. */
export function catalogGroups(widgets: readonly WidgetDef[]): WidgetCatalogGroup[] {
  return WIDGET_CATEGORIES.map((category) => ({
    category,
    widgets: widgets.filter((w) => w.category === category),
  })).filter((group) => group.widgets.length > 0);
}

/** True when two layouts hold the same ids, in the same order, at the same sizes. */
export function sameLayout(
  a: readonly LayoutEntry[],
  b: readonly LayoutEntry[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i];
    return !!other && other.id === entry.id && other.size === entry.size;
  });
}

/** What one Done press changed, for dashboard_layout_saved. */
export interface LayoutChangeCounts {
  moved: number;
  resized: number;
  hidden: number;
  added: number;
}

/**
 * Count the edits between two layouts.
 *
 * `moved` is measured over the ids PRESENT IN BOTH, in their relative order.
 * Counting absolute index changes would report every widget below an added or
 * hidden one as moved, which would make the number useless for the only
 * question it is asked: does anyone actually reorder their board.
 */
export function layoutDiff(
  before: readonly LayoutEntry[],
  after: readonly LayoutEntry[],
): LayoutChangeCounts {
  const beforeById = new Map(before.map((e) => [e.id, e]));
  const afterById = new Map(after.map((e) => [e.id, e]));

  const added = after.filter((e) => !beforeById.has(e.id)).length;
  const hidden = before.filter((e) => !afterById.has(e.id)).length;
  const resized = after.filter((e) => {
    const was = beforeById.get(e.id);
    return !!was && was.size !== e.size;
  }).length;

  const commonBefore = before.filter((e) => afterById.has(e.id)).map((e) => e.id);
  const commonAfter = after.filter((e) => beforeById.has(e.id)).map((e) => e.id);
  const moved = commonAfter.filter((id, i) => commonBefore[i] !== id).length;

  return { moved, resized, hidden, added };
}
