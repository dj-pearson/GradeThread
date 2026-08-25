import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
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
  ListChecks,
  Award,
} from "lucide-react";
import { SearchInput } from "@/components/search-input";
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
import { bulkBatchKey } from "@/lib/bulk-batch-key";
import { useAuthStore } from "@/stores/auth-store";
import { useItemsList, itemsListQueryKey } from "@/hooks/use-items-full";
import { useUrlSearchInput } from "@/hooks/use-url-param-state";
import { useInventorySelection } from "@/stores/inventory-selection";
import { useInventoryStatusCounts } from "@/hooks/use-inventory-status-counts";
import {
  FLIPDESK_PIPELINE,
  ITEM_CATEGORIES,
  ITEM_STATUS_LABELS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { csvBlob, downloadBlob } from "@/lib/download";
import { validateStatusChange } from "@/lib/pipeline-rules";
import {
  useValidateGradingBulk,
  useSubmitGradingBulk,
  GRADING_TIER_COSTS,
  GRADING_TIER_LABELS,
  type GradingTier,
  type ValidationResult,
} from "@/hooks/use-grading";
import { useListingComplianceFlags } from "@/hooks/use-ebay";
import { useFlipdeskSettings } from "@/stores/flipdesk-settings";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingRegion } from "@/components/ui/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { ItemDetailDialog } from "@/components/flipdesk/item-detail-dialog";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
import { NextActionBadge } from "@/components/flipdesk/next-action-badge";
import { FilterBuilder } from "@/components/flipdesk/filter-builder";
import { SaveViewDialog } from "@/components/flipdesk/save-view-dialog";
import { useSavedViews } from "@/hooks/use-saved-views";
import {
  EMPTY_QUERY,
  evalQuery,
  encodeQuery,
  decodeQuery,
  describeRule,
  type FilterQuery,
} from "@/lib/item-filter";
import type { ItemStatus, ItemCategory } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";
import { HelpLink } from "@/components/help/help-link";

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

// US-1428: 'acquired' is a real early status with no column of its own, so an
// item set to Acquired would silently vanish from the board. Surface it in the
// Sourced column and treat it as sourced when advancing.
function pipelineColumnFor(s: ItemStatus): ItemStatus {
  return s === "acquired" ? "sourced" : s;
}

// The pipeline stage immediately after `s`, or null if `s` is last/off-pipeline.
function nextPipelineStatus(s: ItemStatus): ItemStatus | null {
  const idx = FLIPDESK_PIPELINE.findIndex((p) => p.status === pipelineColumnFor(s));
  if (idx < 0 || idx >= FLIPDESK_PIPELINE.length - 1) return null;
  return FLIPDESK_PIPELINE[idx + 1]?.status ?? null;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}


export function FlipdeskPipelinePage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const wipLimits = useFlipdeskSettings((s) => s.wipLimits);
  // US-958: search lives in the URL (`?q=`) so it carries across view-mode
  // switches (shared with the table + grid views).
  // `draft` drives the box (instant), `value` drives the filtering (on a
  // pause). Swapping the two reintroduces the dropped-characters bug.
  const {
    value: search,
    draft: searchDraft,
    setDraft: setSearch,
  } = useUrlSearchInput("q", "");
  const [categoryFilter, setCategoryFilter] = useState<ItemCategory | "all">(
    "all",
  );
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [detailItem, setDetailItem] = useState<ItemListRow | null>(null);
  const [activeDrag, setActiveDrag] = useState<ItemListRow | null>(null);
  // US-1422: persisted eBay Listing-Health flags → a pipeline indicator banner.
  const { data: complianceFlags = [] } = useListingComplianceFlags();
  const complianceFlaggedCount = useMemo(
    () => new Set(complianceFlags.map((f) => f.inventory_item_id)).size,
    [complianceFlags],
  );
  // US-958: selection lives in the shared store so it carries over from the
  // table view (and back) without being dropped on unmount.
  const selectedIds = useInventorySelection((s) => s.selected);
  const setSelectedIds = useInventorySelection((s) => s.setSelected);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResult[] | null>(null);
  // US-1458: photographed items whose "next stage" is grading are routed into
  // the bulk-grade flow instead of a doomed status update. This holds the items
  // the grade dialog operates on (either from batchMoveNext or the toolbar).
  const [gradeItems, setGradeItems] = useState<ItemListRow[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Advanced filter (US-1051) — parity with the listings table. Composes on
  // top of the category/brand/source/search facets above. Initialised from the
  // URL so saved-view links round-trip cleanly between teammates.
  const { data: savedViews = [] } = useSavedViews();
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(() => {
    const f = searchParams.get("filter");
    return (f && decodeQuery(f)) || EMPTY_QUERY;
  });
  const [saveViewOpen, setSaveViewOpen] = useState(false);

  // Load a saved view when ?view=<id> resolves — applies the saved filter and
  // strips the param so a reload doesn't re-apply it.
  useEffect(() => {
    const viewId = searchParams.get("view");
    if (!viewId || savedViews.length === 0) return;
    const v = savedViews.find((sv) => sv.id === viewId);
    if (v) {
      const q = v.query_json as unknown as FilterQuery;
      setFilterQuery(q && Array.isArray(q.rules) ? q : EMPTY_QUERY);
      const next = new URLSearchParams(searchParams);
      next.delete("view");
      setSearchParams(next, { replace: true });
    }
    // US-1489: only the state setters are omitted (stable); re-runs on its real
    // inputs (savedViews, searchParams). No stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViews, searchParams]);

  // Keep ?filter= synced with the builder so the link survives copy-paste.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (filterQuery.rules.length === 0) next.delete("filter");
    else next.set("filter", encodeQuery(filterQuery));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // US-1489: keyed on filterQuery ONLY — this effect writes searchParams, so a
    // searchParams dep would loop; the toString() guard prevents stale churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery]);

  // dnd-kit sensors — pointer with small activation distance so a click
  // (open detail) doesn't accidentally become a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  // Shared items_full read — single source of truth across FlipDesk (US-419).
  const {
    data: items = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useItemsList();

  // US-958: stage population for the column badges comes from the shared
  // status-counts query (same source the table's stage tabs read) rather than
  // being recomputed per view. It reflects the true total in each stage, so the
  // WIP-limit check measures real pressure even when a filter hides cards.
  const { data: statusCounts } = useInventoryStatusCounts();

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
    const map = new Map<ItemStatus, ItemListRow[]>();
    for (const step of FLIPDESK_PIPELINE) map.set(step.status, []);
    for (const it of items) {
      // US-1428: acquired items fold into the Sourced column.
      const col = map.get(pipelineColumnFor(it.status));
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
      // Advanced filter — composes on top of the quick facets + search.
      if (filterQuery.rules.length > 0 && !evalQuery(it, filterQuery)) continue;
      col.push(it);
    }
    return map;
  }, [items, search, categoryFilter, brandFilter, sourceFilter, filterQuery]);

  // Every item currently visible across the kanban columns (i.e. the whole
  // filtered set), flattened — backs the matching count + "select all" action.
  const matchingItems = useMemo(() => {
    const out: ItemListRow[] = [];
    for (const arr of groups.values()) out.push(...arr);
    return out;
  }, [groups]);

  // US-1428: items in off-pipeline statuses (archived / keeping / wearing) have
  // no board column — count them so we can surface an affordance instead of
  // silently stranding them off the Kanban.
  const offPipelineCount = useMemo(
    () =>
      items.filter(
        (i) => !FLIPDESK_PIPELINE.some((p) => p.status === pipelineColumnFor(i.status)),
      ).length,
    [items],
  );

  function selectAllMatching() {
    setSelectedIds(new Set(matchingItems.map((it) => it.id)));
  }

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
    // US-1633: cancel any in-flight ["items_full"] refetch first, or it could
    // land after the optimistic write and clobber it.
    const originalStatus = item.status;
    await qc.cancelQueries({ queryKey: ["items_full"] });
    qc.setQueryData<ItemListRow[]>(itemsListQueryKey(user?.id), (old) =>
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
      // US-1633: roll back ONLY the dragged item (not the whole array snapshot),
      // so a concurrent drag/edit of a DIFFERENT item isn't reverted with it.
      qc.setQueryData<ItemListRow[]>(itemsListQueryKey(user?.id), (old) =>
        (old ?? []).map((i) =>
          i.id === itemId ? { ...i, status: originalStatus } : i,
        ),
      );
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Move failed: ${msg}`);
    }
  }

  // Advance every selected item one stage, validating each. Failures surface
  // in a results dialog rather than a stack of toasts.
  async function batchMoveNext() {
    const selected = items.filter((i) => selectedIds.has(i.id));
    if (selected.length === 0) return;

    // US-1458: the stage after Photographed is grading, which is owned by the
    // grade-submission flow (validateStatusChange always rejects a plain move
    // into it). Peel those items off and route them into the bulk-grade dialog
    // rather than reporting a guaranteed failure for every one.
    const gradingBound = selected.filter(
      (it) => nextPipelineStatus(it.status) === "grading" && it.grade_value == null,
    );
    const toMove = selected.filter((it) => !gradingBound.includes(it));

    if (toMove.length === 0 && gradingBound.length > 0) {
      // Nothing to advance by status — go straight to grading.
      setGradeItems(gradingBound);
      return;
    }

    setBatchRunning(true);
    const results: BatchResult[] = [];
    try {
      for (const it of toMove) {
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
      setBatchResults(results);
      // Hand the grading-bound items to the bulk-grade dialog; leave those
      // selected (the dialog clears selection on submit). Others are done.
      if (gradingBound.length > 0) {
        setGradeItems(gradingBound);
      } else {
        setSelectedIds(new Set());
      }
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
      // Header matches the import's "Link" field (import-mapping.ts) so the
      // eBay URL round-trips out → back in. Sourced from items_full.link
      // (listings.listing_url), which the eBay sync keeps populated.
      "Link",
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
          it.link ?? "",
          it.grade_value,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    downloadBlob(
      csvBlob(lines.join("\r\n")),
      `flipdesk-items-${new Date().toISOString().slice(0, 10)}.csv`,
    );
    toast.success(
      `Exported ${selected.length} item${selected.length === 1 ? "" : "s"}.`,
    );
  }

  return (
    <div className="space-y-4">
      {/* US-1422: pipeline Listing-Health indicator — flags listings eBay has
          marked non-compliant (missing item specifics, etc.). */}
      {complianceFlaggedCount > 0 && (
        <Link
          to="/dashboard/flipdesk/analytics"
          className="flex items-center gap-2 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-800 hover:bg-amber-100 dark:bg-amber-950/20 dark:text-amber-300"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>
            {complianceFlaggedCount} listed item
            {complianceFlaggedCount === 1 ? " has" : "s have"} eBay compliance
            issues — review Listing Health.
          </span>
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
              <LayoutGrid className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
              <HelpLink slug="the-flipdesk-pipeline" label="Help: the FlipDesk pipeline" />
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
              Add item
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Search items"
          value={searchDraft}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, brand, SKU…"
          className="w-64"
        />
        <Select
          value={categoryFilter}
          onValueChange={(v) => setCategoryFilter(v as ItemCategory | "all")}
        >
          <SelectTrigger className="w-40" aria-label="Filter by category">
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
          <SelectTrigger className="w-40" aria-label="Filter by brand">
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
          <SelectTrigger className="w-40" aria-label="Filter by source">
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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <FilterBuilder query={filterQuery} onChange={setFilterQuery} />
          {savedViews.length > 0 && (
            <Select
              value=""
              onValueChange={(id) => {
                const v = savedViews.find((sv) => sv.id === id);
                if (v) {
                  const q = v.query_json as unknown as FilterQuery;
                  setFilterQuery(q && Array.isArray(q.rules) ? q : EMPTY_QUERY);
                }
              }}
            >
              <SelectTrigger className="h-9 w-44 text-xs" aria-label="Saved views">
                <SelectValue placeholder="Saved views" />
              </SelectTrigger>
              <SelectContent>
                {savedViews.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.emoji ? `${v.emoji} ` : ""}
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {filterQuery.rules.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSaveViewOpen(true)}
            >
              Save view
            </Button>
          )}
          {matchingItems.length > 0 && (
            <Button variant="outline" size="sm" onClick={selectAllMatching}>
              <ListChecks className="mr-1.5 h-3.5 w-3.5" />
              Select all matching ({matchingItems.length.toLocaleString()})
            </Button>
          )}
        </div>
      </div>

      {/* Active advanced-filter chips — so the user can see (and clear) what
          the rule builder is narrowing by. */}
      {filterQuery.rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {filterQuery.combinator === "and" ? "All of:" : "Any of:"}
          </span>
          {filterQuery.rules.map((rule) => (
            <span
              key={rule.id}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs"
            >
              {describeRule(rule)}
              <button
                type="button"
                onClick={() =>
                  setFilterQuery({
                    ...filterQuery,
                    rules: filterQuery.rules.filter((r) => r.id !== rule.id),
                  })
                }
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove filter: ${describeRule(rule)}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => setFilterQuery(EMPTY_QUERY)}
            className="text-xs text-brand-red-text hover:underline"
          >
            Clear all
          </button>
        </div>
      )}

      {/* US-1428: off-pipeline (archived / personal) items aren't on the board —
          surface a count + link so they're not invisibly stranded. */}
      {!isLoading && !isError && offPipelineCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {offPipelineCount} off-pipeline item{offPipelineCount === 1 ? "" : "s"}{" "}
          (archived or personal){" "}
          {offPipelineCount === 1 ? "isn't" : "aren't"} shown on the board —{" "}
          <Link
            to="/dashboard/flipdesk/inventory"
            className="font-medium text-brand-red-text hover:underline"
          >
            view in inventory
          </Link>
          .
        </p>
      )}

      {isError ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState
              title="Couldn't load your pipeline"
              description="Something went wrong while loading your inventory. This is usually temporary."
              onRetry={() => refetch()}
              retrying={isFetching}
            />
          </CardContent>
        </Card>
      ) : isLoading ? (
        <LoadingRegion label="Loading pipeline" className="overflow-x-auto pb-4">
          <div
            className="flex gap-3"
            style={{ minWidth: "max-content" }}
            aria-hidden="true"
          >
            {FLIPDESK_PIPELINE.map((step) => (
              <div key={step.status} className="w-64 flex-shrink-0 space-y-2">
                <Skeleton className="h-9 w-full rounded-md" />
                <Skeleton className="h-20 w-full rounded-md" />
                <Skeleton className="h-20 w-full rounded-md" />
              </div>
            ))}
          </div>
        </LoadingRegion>
      ) : items.length === 0 ? (
        // US-1482: with zero items the board is ~13 dashed "Drop here" columns
        // and no guidance — show the same EmptyState + Add/Import CTAs the
        // table/grid views use. Per-column "Drop here" stays for the has-items
        // case (a column that's simply empty).
        <EmptyState
          icon={LayoutGrid}
          title="No inventory yet"
          description="Add your first item and it'll flow through the pipeline from Sourced to Sold. You can also import inventory in bulk."
          action={{ label: "Add item", to: "/dashboard/flipdesk/intake", icon: Plus }}
          secondaryAction={{ label: "Import", to: "/dashboard/flipdesk/import", icon: Upload }}
        />
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
                    count={
                      // US-1428: the Sourced column also holds acquired items,
                      // so fold the acquired count into its badge.
                      step.status === "sourced"
                        ? (statusCounts?.["sourced"] ?? colItems.length) +
                          (statusCounts?.["acquired"] ?? 0)
                        : statusCounts?.[step.status] ?? colItems.length
                    }
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
          {/* US-1458: bulk-grade the ungraded selection in one submission,
              rather than one-at-a-time from each item's detail panel. */}
          <Button
            size="sm"
            variant="outline"
            disabled={batchRunning}
            onClick={() => {
              const eligible = items.filter(
                (i) => selectedIds.has(i.id) && i.grade_value == null,
              );
              if (eligible.length === 0) {
                toast.info("Selected items are already graded.");
                return;
              }
              setGradeItems(eligible);
            }}
          >
            <Award className="mr-1.5 h-3.5 w-3.5" />
            Submit for grading
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
      <SaveViewDialog
        open={saveViewOpen}
        onOpenChange={setSaveViewOpen}
        query={filterQuery}
      />
      <PipelineLimitsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <BatchResultsDialog
        results={batchResults}
        onClose={() => setBatchResults(null)}
      />
      <BulkGradeDialog
        items={gradeItems}
        onClose={() => setGradeItems(null)}
        onSubmitted={(results) => {
          setGradeItems(null);
          setSelectedIds(new Set());
          setBatchResults(results);
        }}
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
  item: ItemListRow;
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
        role="presentation"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${item.item_title}`}
          className={cn(
            "h-3.5 w-3.5 cursor-pointer accent-brand-navy transition-opacity",
            !selected && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        />
      </div>
      <div
        {...listeners}
        {...attributes}
        role="button"
        tabIndex={0}
        aria-label={`Open ${item.item_title}`}
        onClick={onClick}
        onKeyDown={(e) => {
          // Enter opens the item; other keys (Space) fall through to the
          // dnd-kit keyboard sensor so drag-to-reorder still works.
          if (e.key === "Enter") {
            e.preventDefault();
            onClick();
          } else {
            listeners?.onKeyDown?.(e);
          }
        }}
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
  item: ItemListRow;
  dragging?: boolean;
}) {
  const price =
    fmtMoney(item.target_price) ??
    fmtMoney(item.list_price) ??
    fmtMoney(item.purchase_price);
  const age = daysSince(item.updated_at);
  const aging = age != null && age >= 14;
  // US-2336: the status accent used to be a 4px coloured left border. It said
  // nothing the card did not already say — every card sits inside a LABELLED
  // per-status column, so the tab restated its own container. (The one column
  // holding two statuses, Sourced + acquired, gave them the SAME colour, so it
  // did not disambiguate there either.) Removing it drops the most
  // recognizable AI-default tell without losing a single bit of information.
  return (
    <div
      className={cn(
        "rounded-md border bg-card p-2.5 text-left transition-shadow",
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
          {/* US-1897: the Listing Quality Score (0–100), on the board where the
              work happens. Band-coloured so a weak listing reads at a glance; the
              full factor breakdown lives on the item page and the drafts list.
              Only listed/scored rows carry it (items_full.quality_score, 00506). */}
          {item.quality_score != null && (
            <Badge
              variant="outline"
              title="Listing Quality Score — 0–100 across every ranking lever"
              className={cn(
                "px-1.5 py-0 text-[10px] tabular-nums",
                item.quality_score >= 80
                  ? "border-emerald-300 text-emerald-700 dark:text-emerald-300"
                  : item.quality_score >= 60
                    ? "border-amber-300 text-amber-700 dark:text-amber-300"
                    : "border-muted-foreground/30 text-muted-foreground",
              )}
            >
              Q{item.quality_score}
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
              <Label
                htmlFor={`wip-limit-${step.status}`}
                className="text-sm font-normal"
              >
                {step.label}
              </Label>
              <Input
                id={`wip-limit-${step.status}`}
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
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
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

// US-1458: submit a batch of ungraded items for grading in a single round-trip.
// Validates the selection at the chosen tier (per-item ready/blocked + total
// cost) before letting the user confirm the spend, then reports per-item
// outcomes through the shared BatchResultsDialog.
const GRADE_TIER_OPTIONS: GradingTier[] = ["standard", "premium", "express"];

function BulkGradeDialog({
  items,
  onClose,
  onSubmitted,
}: {
  items: ItemListRow[] | null;
  onClose: () => void;
  onSubmitted: (results: BatchResult[]) => void;
}) {
  const [tier, setTier] = useState<GradingTier>("standard");
  const validate = useValidateGradingBulk();
  const submit = useSubmitGradingBulk();
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  const itemIds = useMemo(() => (items ?? []).map((i) => i.id), [items]);

  // US-2564: one charge token per SELECTION, not per attempt.
  //
  // Grading is billed per garment, and a failed submit is the thing a seller
  // retries hardest — so the token has to survive the retry that a fresh mint
  // would defeat. Deriving it from the item set and tier (rather than useState)
  // makes it stable across re-renders, across as many presses of Submit as the
  // user makes, and across closing and reopening the sheet; it changes the
  // moment they pick different items or a different tier, which is exactly when
  // a NEW set of charges is correct.
  const batchKey = useMemo(() => bulkBatchKey(itemIds, tier), [itemIds, tier]);

  const titleById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const i of items ?? []) m.set(i.id, i.item_title);
    return m;
  }, [items]);

  // Re-validate whenever the dialog opens or the tier changes.
  useEffect(() => {
    if (itemIds.length === 0) {
      setValidation(null);
      return;
    }
    let cancelled = false;
    validate
      .mutateAsync({ inventoryItemIds: itemIds, tier })
      .then((res) => {
        if (!cancelled) setValidation(res);
      })
      .catch(() => {
        if (!cancelled) setValidation(null);
      });
    return () => {
      cancelled = true;
    };
    // itemIds is derived from `items`; re-run on tier or item-set change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIds, tier]);

  const readyCount = validation?.items.filter((i) => i.ready).length ?? 0;
  const blockedCount = (validation?.items.length ?? 0) - readyCount;
  const totalCost = validation?.total_cost ?? null;
  const limitExceeded = validation?.limit_exceeded ?? false;

  async function doSubmit() {
    try {
      const res = await submit.mutateAsync({
        inventoryItemIds: itemIds,
        tier,
        batchKey: batchKey ?? undefined,
      });
      const results: BatchResult[] = res.results.map((r) =>
        r.ok
          ? {
              title: titleById.get(r.inventory_item_id) ?? "Item",
              ok: true,
              detail: `Submitted — ${tier} tier`,
            }
          : {
              title: titleById.get(r.inventory_item_id) ?? "Item",
              ok: false,
              detail: r.error,
            },
      );
      if (res.submitted > 0) {
        toast.success(
          `Submitted ${res.submitted} item${res.submitted === 1 ? "" : "s"} for grading.`,
        );
      }
      if (res.failed > 0 && res.submitted === 0) {
        toast.error("No items could be submitted — see details.");
      }
      onSubmitted(results);
    } catch (err) {
      const e = err as Error;
      toast.error(e.message);
    }
  }

  return (
    <Dialog
      open={items != null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Submit for grading</DialogTitle>
          <DialogDescription>
            {itemIds.length} item{itemIds.length === 1 ? "" : "s"} selected.
            Choose a grading tier and confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={tier} onValueChange={(v) => setTier(v as GradingTier)}>
            <SelectTrigger className="h-9 text-sm" aria-label="Grading tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GRADE_TIER_OPTIONS.map((t) => (
                <SelectItem key={t} value={t}>
                  {GRADING_TIER_LABELS[t]} — ${GRADING_TIER_COSTS[t].toFixed(2)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {validate.isPending ? (
            <p className="text-sm text-muted-foreground">Checking readiness…</p>
          ) : validation ? (
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                {readyCount} ready to grade
              </div>
              {blockedCount > 0 && (
                <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <AlertCircle className="h-4 w-4" />
                  {blockedCount} not ready (will be skipped)
                </div>
              )}
              {totalCost != null && (
                <div className="pt-1 text-muted-foreground">
                  Estimated cost:{" "}
                  <span className="font-medium text-foreground">
                    ${totalCost.toFixed(2)}
                  </span>
                </div>
              )}
              {limitExceeded && (
                <div className="pt-1 text-destructive">
                  This exceeds your monthly grading limit.
                </div>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submit.isPending}>
            Cancel
          </Button>
          <Button
            onClick={doSubmit}
            disabled={
              submit.isPending ||
              validate.isPending ||
              readyCount === 0 ||
              limitExceeded
            }
            className="bg-brand-navy"
          >
            {submit.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Award className="mr-2 h-4 w-4" />
            )}
            Submit {readyCount > 0 ? `${readyCount} ` : ""}for grading
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
