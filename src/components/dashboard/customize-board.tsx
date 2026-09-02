import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  EyeOff,
  GripVertical,
  Plus,
  RotateCcw,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { WidgetBoard, type WidgetCell } from "@/components/dashboard/widget-board";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import {
  useDashboardLayout,
  useSaveDashboardLayout,
} from "@/hooks/use-dashboard-layout";
import {
  addWidget,
  addableWidgets,
  catalogGroups,
  hideWidget,
  layoutDiff,
  moveWidget,
  moveWidgetBy,
  resetLayout,
  resizeWidget,
  sameLayout,
} from "@/lib/dashboard-layout";
import type {
  DashboardSurface,
  LayoutEntry,
  WidgetCategory,
  WidgetDef,
  WidgetSize,
} from "@/lib/dashboard-widgets";
import type { OverviewRangeId } from "@/lib/overview-range";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

// US-3074: Customize mode.
//
// The board a seller reads every morning is theirs to arrange, and this is the
// whole editing surface for it: reorder, resize, hide, add, reset. It holds a
// DRAFT layout and nothing else. Every change to that draft goes through a pure
// action in dashboard-layout.ts, so there is no index arithmetic, no span
// arithmetic and no size validation anywhere in this file. Cancel throws the
// draft away; Done writes it once.
//
// Two input paths, because one does not cover the board:
//   - Drag, at >= sm, with dnd-kit's PointerSensor AND KeyboardSensor, so the
//     grip is operable from the keyboard (space to lift, arrows to move).
//   - Move up / move down buttons below sm, where the grid is a single column,
//     the frames are tall, and a drag across a phone screen is a scroll fight.
// Both call the same reducer, so they cannot produce different orders.

/** Size names as a seller reads them, not as the registry spells them. */
const SIZE_LABEL: Record<WidgetSize, string> = {
  sm: "Small",
  md: "Medium",
  lg: "Full width",
};

/** Catalog section headings. `promo` is named for what it is. */
const CATEGORY_LABEL: Record<WidgetCategory, string> = {
  data: "Your numbers",
  action: "Things to do",
  promo: "Share GradeThread",
};

// The drag handle.
//
// useSortable() has to be called on the element that carries the grid span, and
// the grip belongs in the frame's header, which is built by WidgetBoard well
// before the cell wraps it. React context bridges the two: the cell publishes
// its activator props, the grip inside the frame reads them. Context resolves
// by tree POSITION, and the frame does render inside the cell, so this holds.

type SortableResult = ReturnType<typeof useSortable>;

interface DragHandleProps {
  attributes: SortableResult["attributes"];
  listeners: SortableResult["listeners"];
  setActivatorNodeRef: SortableResult["setActivatorNodeRef"];
}

const DragHandleContext = createContext<DragHandleProps | null>(null);

function SortableWidgetCell({ cell }: { cell: WidgetCell }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cell.entry.id });

  return (
    <div
      ref={setNodeRef}
      // dnd-kit's own transition string. No custom easing: an overshoot on a
      // card the size of a dashboard widget reads as the page glitching.
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className={cn(cell.className, "rounded-xl bg-muted/30 p-3")}
    >
      <DragHandleContext.Provider
        value={{ attributes, listeners, setActivatorNodeRef }}
      >
        {cell.children}
      </DragHandleContext.Provider>
    </div>
  );
}

/** A square icon button, so the four frame controls share one hit target size. */
function IconControl({
  icon: Icon,
  label,
  onClick,
  disabled,
  className,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn("h-8 w-8", className)}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </Button>
  );
}

/**
 * The per-frame edit controls.
 *
 * Exported so a render test can assert the labels without driving a drag: every
 * control names its widget, because a screen reader hearing "Hide" four times
 * on one board has been told nothing.
 */
export function WidgetEditControls({
  def,
  entry,
  isFirst,
  isLast,
  onResize,
  onHide,
  onMove,
}: {
  def: WidgetDef;
  entry: LayoutEntry;
  isFirst: boolean;
  isLast: boolean;
  onResize: (id: string, size: WidgetSize) => void;
  onHide: (id: string) => void;
  onMove: (id: string, delta: number) => void;
}) {
  const handle = useContext(DragHandleContext);

  return (
    <>
      {/* Below sm the grid is one column and drag is a scroll fight, so the
          arrows are the reorder control there and the grip is the one at sm+. */}
      <IconControl
        icon={ArrowUp}
        label={`Move ${def.title} up`}
        disabled={isFirst}
        onClick={() => onMove(def.id, -1)}
        className="sm:hidden"
      />
      <IconControl
        icon={ArrowDown}
        label={`Move ${def.title} down`}
        disabled={isLast}
        onClick={() => onMove(def.id, 1)}
        className="sm:hidden"
      />

      <button
        type="button"
        ref={handle?.setActivatorNodeRef}
        {...(handle?.attributes ?? {})}
        {...(handle?.listeners ?? {})}
        aria-label={`Reorder ${def.title}`}
        title={`Reorder ${def.title}`}
        className="hidden h-8 w-8 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing sm:inline-flex"
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>

      {/* Only the sizes this widget is legible at, as a segmented control
          rather than a select: at two or three options the choices are worth
          showing, every one is a tab stop, and the current size is visible
          without opening anything. A widget with ONE allowed size gets no
          control at all rather than one that cannot change. */}
      {def.sizes.length > 1 ? (
        <div
          role="group"
          aria-label={`Size of ${def.title}`}
          className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
        >
          {def.sizes.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={entry.size === size}
              aria-label={`Set ${def.title} to ${SIZE_LABEL[size].toLowerCase()}`}
              onClick={() => onResize(def.id, size)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                entry.size === size
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {SIZE_LABEL[size]}
            </button>
          ))}
        </div>
      ) : null}

      <IconControl
        icon={EyeOff}
        label={`Hide ${def.title}`}
        onClick={() => onHide(def.id)}
      />
    </>
  );
}

/**
 * The Add-widget catalog.
 *
 * Exported so the persona filter is testable as markup and not only as the
 * function behind it: a buyer must never be shown a `flipdesk.*` widget, and
 * the assertion worth having is about what the sheet renders.
 */
export function WidgetCatalog({
  widgets,
  onAdd,
}: {
  widgets: readonly WidgetDef[];
  onAdd: (id: string) => void;
}) {
  const groups = catalogGroups(widgets);

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Every widget for this page is already on your board.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.category} aria-label={CATEGORY_LABEL[group.category]}>
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {CATEGORY_LABEL[group.category]}
          </h3>
          <ul className="space-y-2">
            {group.widgets.map((def) => (
              <li key={def.id}>
                <button
                  type="button"
                  onClick={() => onAdd(def.id)}
                  aria-label={`Add ${def.title} to your board`}
                  className="w-full rounded-xl border px-4 py-3 text-left hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="block text-sm font-medium text-foreground">
                    {def.title}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">
                    {def.blurb}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export interface CustomizableWidgetBoardProps {
  surface: DashboardSurface;
  /** PageHeader props. The Customize action is appended to `actions`. */
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /**
   * The reporting window this board is showing (US-3076). Passed straight to
   * WidgetBoard: the page owns the picker because the picker is one of its
   * header actions, and the board owns what the widgets are told about it.
   */
  range?: OverviewRangeId;
  className?: string;
}

/**
 * A widget board with its Customize affordance and the whole edit surface.
 *
 * The page passes its heading through rather than rendering PageHeader itself,
 * because the Customize control belongs beside the page's own actions and
 * nowhere else: a floating pencil over the grid is a second place to look for
 * the same thing.
 */
export function CustomizableWidgetBoard({
  surface,
  title,
  subtitle,
  actions,
  range,
  className,
}: CustomizableWidgetBoardProps) {
  const saved = useDashboardLayout(surface);
  const save = useSaveDashboardLayout(surface);
  const confirm = useConfirm();

  const [draft, setDraft] = useState<LayoutEntry[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const editing = draft !== null;
  const dirty = editing && !sameLayout(draft, saved.layout);

  const guard = useNavigationGuard(dirty);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const catalog = useMemo(
    () =>
      addableWidgets(
        draft ?? saved.layout,
        saved.registry,
        saved.persona,
        saved.context,
      ),
    [draft, saved.layout, saved.registry, saved.persona, saved.context],
  );

  const startEditing = useCallback(() => {
    setDraft(saved.layout.map((e) => ({ ...e })));
  }, [saved.layout]);

  const stopEditing = useCallback(() => {
    setDraft(null);
    setAddOpen(false);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    setDraft((current) =>
      current ? moveWidget(current, String(active.id), String(over.id)) : current,
    );
  }, []);

  const handleMove = useCallback((id: string, delta: number) => {
    setDraft((current) => (current ? moveWidgetBy(current, id, delta) : current));
  }, []);

  const handleResize = useCallback(
    (id: string, size: WidgetSize) => {
      setDraft((current) =>
        current ? resizeWidget(current, id, size, saved.registry) : current,
      );
    },
    [saved.registry],
  );

  const handleHide = useCallback((id: string) => {
    setDraft((current) => (current ? hideWidget(current, id) : current));
    track("dashboard_widget_hidden", { surface, widget_id: id });
  }, [surface]);

  const handleAdd = useCallback(
    (id: string) => {
      setDraft((current) =>
        current ? addWidget(current, id, saved.registry) : current,
      );
      track("dashboard_widget_added", { surface, widget_id: id });
      setAddOpen(false);
    },
    [saved.registry, surface],
  );

  const handleReset = useCallback(async () => {
    const ok = await confirm({
      title: "Reset this board?",
      description:
        "Every widget goes back to where it started, at the size it shipped with. Nothing is saved until you press Done.",
      confirmLabel: "Reset board",
      cancelLabel: "Keep my layout",
      destructive: true,
    });
    if (!ok) return;
    setDraft(resetLayout(saved.registry, saved.persona, saved.context));
    track("dashboard_layout_reset", { surface });
  }, [confirm, saved.registry, saved.persona, saved.context, surface]);

  const handleDone = useCallback(() => {
    if (!draft) return;
    const counts = layoutDiff(saved.layout, draft);
    save.mutate(draft);
    track("dashboard_layout_saved", {
      surface,
      widget_count: draft.length,
      ...counts,
    });
    stopEditing();
  }, [draft, saved.layout, save, surface, stopEditing]);

  const entries = draft ?? saved.layout;

  const renderAction = editing
    ? (def: WidgetDef, entry: LayoutEntry) => (
        <WidgetEditControls
          def={def}
          entry={entry}
          isFirst={entries[0]?.id === entry.id}
          isLast={entries[entries.length - 1]?.id === entry.id}
          onResize={handleResize}
          onHide={handleHide}
          onMove={handleMove}
        />
      )
    : undefined;

  const board = (
    <WidgetBoard
      surface={surface}
      layout={entries}
      registry={saved.registry}
      range={range}
      renderAction={renderAction}
      renderCell={
        editing ? (cell) => <SortableWidgetCell cell={cell} /> : undefined
      }
      className={className}
    />
  );

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {actions}
            {editing ? null : (
              <Button type="button" variant="outline" onClick={startEditing}>
                <Settings2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Customize
              </Button>
            )}
          </>
        }
      />

      {editing ? (
        <div className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:px-4">
          <p className="text-sm text-muted-foreground">
            Drag to reorder, pick a size, or hide what you do not use.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              Add widget
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleReset()}
            >
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Reset to default
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={stopEditing}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleDone}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {editing ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={entries.map((e) => e.id)}
            strategy={rectSortingStrategy}
          >
            {board}
          </SortableContext>
        </DndContext>
      ) : (
        board
      )}

      <Sheet open={addOpen} onOpenChange={setAddOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Add a widget</SheetTitle>
            <SheetDescription>
              Pick one to put at the bottom of your board. You can move it from
              there.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <WidgetCatalog widgets={catalog} onAdd={handleAdd} />
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={guard.blocked}
        onOpenChange={(open) => {
          if (!open) guard.cancelLeave();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving your layout?</AlertDialogTitle>
            <AlertDialogDescription>
              You have changes to this board that have not been saved. Leaving
              now puts your last saved layout back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={guard.cancelLeave}>
              Stay and finish
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                stopEditing();
                guard.confirmLeave();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
