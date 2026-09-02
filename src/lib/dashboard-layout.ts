import {
  DEFAULT_PERSONA,
  LAYOUT_VERSION,
  defaultLayoutFor,
  isWidgetSize,
  type DashboardSurface,
  type LayoutDocument,
  type LayoutEntry,
  type WidgetDef,
  type WidgetPersona,
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
 * - a size the widget does not allow is clamped to its defaultSize
 * - a repeated id keeps the FIRST occurrence and drops the rest
 * - a missing, malformed or unknown-version document returns the persona default
 *
 * An empty widget list in a well-formed current-version document is honored as
 * an empty board: hiding everything is a choice a seller can make, and turning
 * it back into the default would make Hide look broken.
 */
export function normalize(
  stored: unknown,
  registry: readonly WidgetDef[],
  persona: WidgetPersona,
): LayoutEntry[] {
  const surface = surfaceOf(registry);
  const fallback = (): LayoutEntry[] =>
    surface ? normalizeEntries(defaultLayoutFor(surface, persona), registry) : [];

  if (!isRecord(stored)) return fallback();
  if (stored.version !== LAYOUT_VERSION) return fallback();
  if (!Array.isArray(stored.widgets)) return fallback();

  return normalizeEntries(stored.widgets, registry);
}

/** The per-entry rules, shared by the stored document and the shipped default. */
function normalizeEntries(
  entries: readonly unknown[],
  registry: readonly WidgetDef[],
): LayoutEntry[] {
  const out: LayoutEntry[] = [];
  const seen = new Set<string>();

  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const id = raw.id;
    if (typeof id !== "string" || seen.has(id)) continue;

    const def = registry.find((w) => w.id === id);
    if (!def) continue;

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
