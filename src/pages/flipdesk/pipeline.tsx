import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  LayoutGrid,
  Filter,
  Search,
  Plus,
  Upload,
  Tag,
  Clock,
  ChevronRight,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  FLIPDESK_PIPELINE,
  ITEM_CATEGORIES,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { validateStatusChange } from "@/lib/pipeline-rules";
import { ItemDetailDialog } from "@/components/flipdesk/item-detail-dialog";
import type { ItemFullRow, ItemStatus, ItemCategory } from "@/types/database";

const COLUMN_CAP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function fmtMoney(n: number | null | undefined): string | null {
  if (n == null || isNaN(n)) return null;
  return `$${n.toFixed(2)}`;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

const STATUS_ACCENT: Partial<Record<ItemStatus, string>> = {
  sourced: "border-l-slate-400",
  acquired: "border-l-slate-400",
  cataloged: "border-l-sky-400",
  measured: "border-l-sky-500",
  photographed: "border-l-indigo-500",
  grading: "border-l-violet-500",
  graded: "border-l-violet-600",
  comped: "border-l-amber-500",
  drafted: "border-l-orange-500",
  listed: "border-l-emerald-500",
  sold: "border-l-emerald-600",
  shipped: "border-l-emerald-700",
  completed: "border-l-zinc-500",
  returned: "border-l-rose-500",
};

export function FlipdeskPipelinePage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ItemCategory | "all">(
    "all",
  );
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [detailItem, setDetailItem] = useState<ItemFullRow | null>(null);
  const [activeDrag, setActiveDrag] = useState<ItemFullRow | null>(null);

  // dnd-kit sensors — pointer with small activation distance so a click
  // (open detail) doesn't accidentally become a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ItemFullRow[]> => {
      const { data, error } = await (
        supabase.from as unknown as (
          name: "items_full",
        ) => {
          select: (cols: string) => {
            order: (
              col: string,
              opts?: { ascending?: boolean },
            ) => Promise<{ data: ItemFullRow[] | null; error: Error | null }>;
          };
        }
      )("items_full")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.brand) set.add(it.brand);
    return Array.from(set).sort();
  }, [items]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.source_name) set.add(it.source_name);
    return Array.from(set).sort();
  }, [items]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<ItemStatus, ItemFullRow[]>();
    for (const step of FLIPDESK_PIPELINE) map.set(step.status, []);
    for (const it of items) {
      const col = map.get(it.status);
      if (!col) continue;
      if (
        categoryFilter !== "all" &&
        (it.category ?? "other") !== categoryFilter
      ) {
        continue;
      }
      if (brandFilter !== "all" && it.brand !== brandFilter) continue;
      if (sourceFilter !== "all" && it.source_name !== sourceFilter) continue;
      if (q) {
        const hay = [it.item_title, it.brand, it.style, it.item_number]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) continue;
      }
      col.push(it);
    }
    return map;
  }, [items, search, categoryFilter, brandFilter, sourceFilter]);

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    const item = items.find((i) => i.id === id) ?? null;
    setActiveDrag(item);
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveDrag(null);
    if (!e.over) return;
    const itemId = String(e.active.id);
    const targetStatus = String(e.over.id) as ItemStatus;
    const item = items.find((i) => i.id === itemId);
    if (!item || item.status === targetStatus) return;

    // Pre-flight validation. Block move if rule fails.
    const reason = validateStatusChange(item, targetStatus);
    if (reason) {
      toast.error(reason);
      return;
    }

    // Optimistic update: write the new status into the cache, then save.
    const prevItems = items;
    qc.setQueryData<ItemFullRow[]>(["items_full", user?.id], (old) =>
      (old ?? []).map((i) =>
        i.id === itemId ? { ...i, status: targetStatus } : i,
      ),
    );

    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({ status: targetStatus } as never)
        .eq("id", itemId);
      if (error) throw error;
      toast.success(
        `Moved to ${FLIPDESK_PIPELINE.find((s) => s.status === targetStatus)?.label ?? targetStatus}.`,
      );
      // Light invalidation so timestamps refresh on next paint.
      await qc.invalidateQueries({ queryKey: ["items_full"] });
    } catch (err) {
      // Rollback on failure.
      qc.setQueryData(["items_full", user?.id], prevItems);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Move failed: ${msg}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
            <LayoutGrid className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Pipeline</h1>
            <p className="text-sm text-muted-foreground">
              Drag a card between columns to advance its status. Click for
              full details.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/dashboard/flipdesk/import">
              <Upload className="mr-2 h-4 w-4" />
              Import
            </Link>
          </Button>
          <Button asChild>
            <Link to="/dashboard/flipdesk/intake">
              <Plus className="mr-2 h-4 w-4" />
              New item
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, brand, SKU…"
            className="w-64 pl-9"
          />
        </div>
        <Select
          value={categoryFilter}
          onValueChange={(v) => setCategoryFilter(v as ItemCategory | "all")}
        >
          <SelectTrigger className="w-40">
            <Filter className="mr-2 h-4 w-4" />
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {ITEM_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={brandFilter} onValueChange={setBrandFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Brand" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All brands</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {sources.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Loading pipeline…
          </CardContent>
        </Card>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          <div className="overflow-x-auto pb-4">
            <div className="flex gap-3" style={{ minWidth: "max-content" }}>
              {FLIPDESK_PIPELINE.map((step) => {
                const colItems = groups.get(step.status) ?? [];
                const overCap = colItems.length > COLUMN_CAP;
                const visible = overCap
                  ? colItems.slice(0, COLUMN_CAP)
                  : colItems;
                return (
                  <DroppableColumn
                    key={step.status}
                    status={step.status}
                    label={step.label}
                    nextAction={step.nextAction}
                    count={colItems.length}
                  >
                    {colItems.length === 0 ? (
                      <div className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">
                        Drop here
                      </div>
                    ) : (
                      <>
                        {visible.map((it) => (
                          <DraggableItemCard
                            key={it.id}
                            item={it}
                            onClick={() => setDetailItem(it)}
                          />
                        ))}
                        {overCap && (
                          <Link
                            to={`/dashboard/flipdesk/items?status=${step.status}`}
                            className="flex items-center justify-center rounded-md border border-dashed py-2 text-xs text-muted-foreground hover:bg-muted/40"
                          >
                            +{colItems.length - COLUMN_CAP} more
                            <ChevronRight className="ml-1 h-3 w-3" />
                          </Link>
                        )}
                      </>
                    )}
                  </DroppableColumn>
                );
              })}
            </div>
          </div>
          <DragOverlay>
            {activeDrag ? (
              <ItemCardVisual item={activeDrag} dragging />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      <ItemDetailDialog item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}

function DroppableColumn({
  status,
  label,
  nextAction,
  count,
  children,
}: {
  status: ItemStatus;
  label: string;
  nextAction: string;
  count: number;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  return (
    <div className="w-[260px] flex-shrink-0">
      <Card
        ref={setNodeRef}
        className={cn(
          "flex h-full flex-col transition-colors",
          isOver && "border-brand-navy bg-brand-navy/5 ring-2 ring-brand-navy",
        )}
      >
        <CardHeader className="space-y-1 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">{label}</CardTitle>
            <Badge variant="outline" className="font-mono text-xs">
              {count}
            </Badge>
          </div>
          <CardDescription className="text-[10px]">
            Next: {nextAction}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex-1 space-y-2 px-3 pb-3">
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

function DraggableItemCard({
  item,
  onClick,
}: {
  item: ItemFullRow;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      className={cn(
        "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-30",
      )}
    >
      <ItemCardVisual item={item} />
    </div>
  );
}

// Pure visual — used by both DraggableItemCard and DragOverlay.
function ItemCardVisual({
  item,
  dragging = false,
}: {
  item: ItemFullRow;
  dragging?: boolean;
}) {
  const price =
    fmtMoney(item.target_price) ??
    fmtMoney(item.list_price) ??
    fmtMoney(item.purchase_price);
  const age = daysSince(item.updated_at);
  const aging = age != null && age >= 14;
  const accent = STATUS_ACCENT[item.status] ?? "border-l-slate-300";

  return (
    <div
      className={cn(
        "rounded-md border border-l-4 bg-card p-2.5 text-left transition-shadow",
        accent,
        dragging && "shadow-lg ring-2 ring-brand-navy",
      )}
    >
      <div className="line-clamp-2 text-xs font-medium leading-tight">
        {item.item_title}
      </div>
      <div className="mt-1 line-clamp-1 text-[10px] text-muted-foreground">
        {[item.brand, item.style, item.size].filter(Boolean).join(" · ") ||
          "—"}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
        <div className="flex items-center gap-1.5">
          {price && (
            <span className="inline-flex items-center gap-0.5 font-mono tabular-nums">
              <Tag className="h-2.5 w-2.5" />
              {price}
            </span>
          )}
          {item.grade_value != null && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {Number(item.grade_value).toFixed(1)}
            </Badge>
          )}
        </div>
        {age != null && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5",
              aging
                ? "font-medium text-destructive"
                : "text-muted-foreground/70",
            )}
          >
            <Clock className="h-2.5 w-2.5" />
            {age}d
          </span>
        )}
      </div>
    </div>
  );
}
