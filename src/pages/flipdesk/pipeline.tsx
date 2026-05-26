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
  Settings2,
  ArrowRight,
  Download,
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
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
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  FLIPDESK_PIPELINE,
  ITEM_CATEGORIES,
  ITEM_STATUS_LABELS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { validateStatusChange } from "@/lib/pipeline-rules";
import { useFlipdeskSettings } from "@/stores/flipdesk-settings";
import { ItemDetailDialog } from "@/components/flipdesk/item-detail-dialog";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
import { NextActionBadge } from "@/components/flipdesk/next-action-badge";
import type { ItemFullRow, ItemStatus, ItemCategory } from "@/types/database";

const COLUMN_CAP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

type BatchResult = { title: string; ok: boolean; detail: string };

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

// The pipeline stage immediately after `s`, or null if `s` is last/off-pipeline.
function nextPipelineStatus(s: ItemStatus): ItemStatus | null {
  const idx = FLIPDESK_PIPELINE.findIndex((p) => p.status === s);
  if (idx < 0 || idx >= FLIPDESK_PIPELINE.length - 1) return null;
  return FLIPDESK_PIPELINE[idx + 1]?.status ?? null;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  const wipLimits = useFlipdeskSettings((s) => s.wipLimits);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ItemCategory | "all">(
    "all",
  );
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [detailItem, setDetailItem] = useState<ItemFullRow | null>(null);
  const [activeDrag, setActiveDrag] = useState<ItemFullRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResult[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  // Advance every selected item one stage, validating each. Failures surface
  // in a results dialog rather than a stack of toasts.
  async function batchMoveNext() {
    const selected = items.filter((i) => selectedIds.has(i.id));
    if (selected.length === 0) return;
    setBatchRunning(true);
    const results: BatchResult[] = [];
    try {
      for (const it of selected) {
        const next = nextPipelineStatus(it.status);
        if (!next) {
          results.push({
            title: it.item_title,
            ok: false,
            detail: `No next stage after ${ITEM_STATUS_LABELS[it.status]}`,
          });
          continue;
        }
        const reason = validateStatusChange(it, next);
        if (reason) {
          results.push({ title: it.item_title, ok: false, detail: reason });
          continue;
        }
        const { error } = await supabase
          .from("inventory_items")
          .update({ status: next } as never)
          .eq("id", it.id);
        if (error) {
          results.push({
            title: it.item_title,
            ok: false,
            detail: error.message,
          });
        } else {
          results.push({
            title: it.item_title,
            ok: true,
            detail: `→ ${ITEM_STATUS_LABELS[next]}`,
          });
        }
      }
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      setSelectedIds(new Set());
      setBatchResults(results);
    } finally {
      setBatchRunning(false);
    }
  }

  function exportSelectedCsv() {
    const selected = items.filter((i) => selectedIds.has(i.id));
    if (selected.length === 0) return;
    const headers = [
      "SKU",
      "Title",
      "Brand",
      "Style",
      "Size",
      "Category",
      "Status",
      "Source",
      "Purchase price",
      "Target price",
      "List price",
      "Grade",
    ];
    const lines = [headers.join(",")];
    for (const it of selected) {
      lines.push(
        [
          it.item_number,
          it.item_title,
          it.brand,
          it.style,
          it.size,
          it.category,
          ITEM_STATUS_LABELS[it.status],
          it.source_name,
          it.purchase_price,
          it.target_price,
          it.list_price,
          it.grade_value,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flipdesk-items-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(
      `Exported ${selected.length} item${selected.length === 1 ? "" : "s"}.`,
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
              <LayoutGrid className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
              <p className="text-sm text-muted-foreground">
                Drag a card to advance its status, or select cards for a batch
                move. Click a card for full details.
              </p>
            </div>
          </div>
          <InventoryViewSwitcher current="kanban" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="mr-2 h-4 w-4" />
            Limits
          </Button>
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
                    limit={wipLimits[step.status]}
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
                            selected={selectedIds.has(it.id)}
                            onToggleSelect={() => toggleSelect(it.id)}
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

      {/* Batch action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-card p-2 shadow-lg">
          <span className="px-2 text-sm font-medium">
            {selectedIds.size} selected
          </span>
          <Button size="sm" onClick={batchMoveNext} disabled={batchRunning}>
            {batchRunning ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
            )}
            Move to next status
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={exportSelectedCsv}
            disabled={batchRunning}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelectedIds(new Set())}
            disabled={batchRunning}
            aria-label="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <ItemDetailDialog item={detailItem} onClose={() => setDetailItem(null)} />
      <PipelineLimitsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <BatchResultsDialog
        results={batchResults}
        onClose={() => setBatchResults(null)}
      />
    </div>
  );
}

function DroppableColumn({
  status,
  label,
  nextAction,
  count,
  limit,
  children,
}: {
  status: ItemStatus;
  label: string;
  nextAction: string;
  count: number;
  limit: number | undefined;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const overLimit = limit != null && count > limit;
  return (
    <div className="group w-[260px] flex-shrink-0">
      <Card
        ref={setNodeRef}
        className={cn(
          "flex h-full flex-col transition-colors",
          isOver && "border-brand-navy bg-brand-navy/5 ring-2 ring-brand-navy",
          overLimit && !isOver && "border-destructive/50",
        )}
      >
        <CardHeader className="space-y-1 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">{label}</CardTitle>
            <Badge
              variant={overLimit ? "destructive" : "outline"}
              className="font-mono text-xs"
            >
              {count}
              {limit != null ? `/${limit}` : ""}
            </Badge>
          </div>
          <CardDescription className="text-[10px]">
            {overLimit ? (
              <span className="font-medium text-destructive">
                Over WIP limit — bottleneck
              </span>
            ) : (
              <>Next: {nextAction}</>
            )}
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
  selected,
  onToggleSelect,
  onClick,
}: {
  item: ItemFullRow;
  selected: boolean;
  onToggleSelect: () => void;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
  });
  return (
    <div ref={setNodeRef} className={cn("relative", isDragging && "opacity-30")}>
      {/* Selection checkbox — pointer events kept off the drag handle. */}
      <div
        className="absolute left-1.5 top-1.5 z-10"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${item.item_title}`}
          className={cn(
            "h-3.5 w-3.5 cursor-pointer accent-brand-navy transition-opacity",
            !selected && "opacity-0 group-hover:opacity-100",
          )}
        />
      </div>
      <div
        {...listeners}
        {...attributes}
        onClick={onClick}
        className={cn(
          "cursor-grab rounded-md active:cursor-grabbing",
          selected && "ring-2 ring-brand-navy",
        )}
      >
        <ItemCardVisual item={item} />
      </div>
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
        "rounded-md border border-l-4 bg-card p-2.5 pl-6 text-left transition-shadow",
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
      <div className="mt-1.5">
        <NextActionBadge item={item} />
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
            title={aging ? `${age} days in this status` : undefined}
          >
            <Clock className="h-2.5 w-2.5" />
            {age}d
          </span>
        )}
      </div>
    </div>
  );
}

function PipelineLimitsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const wipLimits = useFlipdeskSettings((s) => s.wipLimits);
  const setWipLimit = useFlipdeskSettings((s) => s.setWipLimit);
  const clearWipLimits = useFlipdeskSettings((s) => s.clearWipLimits);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pipeline WIP limits</DialogTitle>
          <DialogDescription>
            Cap how many items should sit in a stage. A column turns red when it
            goes over — your cue that work is piling up. Leave blank for no
            limit. Saved on this device.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {FLIPDESK_PIPELINE.map((step) => (
            <div
              key={step.status}
              className="flex items-center justify-between gap-3"
            >
              <Label className="text-sm font-normal">{step.label}</Label>
              <Input
                type="number"
                min={1}
                className="w-24"
                value={wipLimits[step.status] ?? ""}
                onChange={(e) =>
                  setWipLimit(
                    step.status,
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
                placeholder="—"
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={clearWipLimits}>
            Clear all
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchResultsDialog({
  results,
  onClose,
}: {
  results: BatchResult[] | null;
  onClose: () => void;
}) {
  const okCount = results?.filter((r) => r.ok).length ?? 0;
  const failCount = (results?.length ?? 0) - okCount;

  return (
    <Dialog
      open={results != null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Batch move results</DialogTitle>
          <DialogDescription>
            {okCount} moved, {failCount} skipped.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
          {(results ?? []).map((r, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded-md border p-2 text-sm"
            >
              {r.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              )}
              <div className="min-w-0">
                <div className="truncate font-medium">{r.title}</div>
                <div
                  className={cn(
                    "text-xs",
                    r.ok ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  {r.detail}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
