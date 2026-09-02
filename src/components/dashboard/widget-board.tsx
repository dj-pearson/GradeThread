import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { cn } from "@/lib/utils";
import { useDashboardLayout } from "@/hooks/use-dashboard-layout";
import {
  widgetById,
  type DashboardSurface,
  type LayoutEntry,
  type WidgetDef,
  type WidgetProps,
  type WidgetSize,
} from "@/lib/dashboard-widgets";

// US-3073: the one component both overviews render their layout with.
//
// The board owns three things a page used to hand-roll per card: the grid and
// its spans, the failure boundary around each widget, and the code split.
// `load` is a dynamic import, so a widget a seller hid is never downloaded:
// the GradeCharts deferral in dashboard.tsx, applied to every widget instead of
// to one.
//
// A widget that renders nothing (RewardsWidget and ImpactTile both self-hide)
// gets the frame's quiet state rather than a zero-height gap, so the board
// never grows a hole a seller reads as a bug.

/**
 * Column spans of the 4-column grid. Written out rather than interpolated
 * because Tailwind only ships the classes it can see in the source.
 */
const COL_SPAN: Record<WidgetSize, string> = {
  sm: "sm:col-span-1 lg:col-span-1",
  md: "sm:col-span-2 lg:col-span-2",
  lg: "sm:col-span-2 lg:col-span-4",
};

// One lazy component per widget id, for the life of the tab. Calling lazy()
// inside render would build a new component type every pass and remount the
// widget (losing its state and refetching) on every board re-render.
const lazyComponents = new Map<string, ComponentType<WidgetProps>>();

function lazyWidget(def: WidgetDef): ComponentType<WidgetProps> {
  const cached = lazyComponents.get(def.id);
  if (cached) return cached;
  const Component = lazy(def.load);
  lazyComponents.set(def.id, Component);
  return Component;
}

function WidgetSkeleton({ title }: { title: string }) {
  return (
    <LoadingRegion label={`Loading ${title}`}>
      <Skeleton className="h-24 w-full" />
    </LoadingRegion>
  );
}

/**
 * True while the wrapper holds no rendered output. Watched rather than
 * measured once: a widget that returns null only after its query resolves
 * empties the wrapper long after mount.
 */
function useIsEmpty(ref: RefObject<HTMLDivElement | null>): boolean {
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () =>
      setEmpty(el.childElementCount === 0 && (el.textContent ?? "").trim() === "");
    check();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [ref]);

  return empty;
}

export function WidgetFrame({
  def,
  size,
  action,
  children,
  className,
}: {
  def: WidgetDef;
  size: WidgetSize;
  /** Optional controls beside the title (US-3074 puts the edit controls here). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const isEmpty = useIsEmpty(contentRef);

  return (
    <section
      aria-label={def.title}
      data-widget-id={def.id}
      data-widget-size={size}
      className={cn("min-w-0", className)}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{def.title}</h3>
        {action ? <div className="flex items-center gap-1">{action}</div> : null}
      </div>

      <div ref={contentRef}>{children}</div>

      {isEmpty ? (
        <div className="rounded-xl border border-dashed px-4 py-6">
          <p className="text-sm text-muted-foreground">{def.blurb}</p>
          <p className="mt-1 text-sm text-muted-foreground">Nothing to show yet.</p>
        </div>
      ) : null}
    </section>
  );
}

function WidgetErrorState({ title }: { title: string }) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-6">
      <p className="text-sm text-muted-foreground">
        {title} could not load. The rest of your board is unaffected.
      </p>
    </div>
  );
}

export function WidgetBoard({
  surface,
  layout,
  registry,
  renderAction,
  className,
}: {
  surface: DashboardSurface;
  /** Override the saved layout (edit mode, and render tests). */
  layout?: readonly LayoutEntry[];
  /** Override the registry, for tests and for a filtered catalog. */
  registry?: readonly WidgetDef[];
  /** Controls for each frame's header slot. */
  renderAction?: (def: WidgetDef, entry: LayoutEntry) => ReactNode;
  className?: string;
}) {
  const saved = useDashboardLayout(surface);
  const entries = layout ?? saved.layout;
  const defs = registry ?? saved.registry;

  if (entries.length === 0) return null;

  return (
    <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {entries.map((entry) => {
        const def = widgetById(entry.id, defs);
        // normalize() drops unknown ids, so this only fires when a caller
        // passes a layout it never normalized. Skipping beats crashing.
        if (!def) return null;
        const Widget = lazyWidget(def);
        return (
          <div key={entry.id} className={COL_SPAN[entry.size]}>
            <WidgetFrame def={def} size={entry.size} action={renderAction?.(def, entry)}>
              <ErrorBoundary
                resetKey={entry.id}
                fallback={<WidgetErrorState title={def.title} />}
              >
                <Suspense fallback={<WidgetSkeleton title={def.title} />}>
                  <Widget size={entry.size} surface={surface} />
                </Suspense>
              </ErrorBoundary>
            </WidgetFrame>
          </div>
        );
      })}
    </div>
  );
}
