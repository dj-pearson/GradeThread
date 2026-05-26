import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Search,
  Upload,
  Plus,
  ExternalLink,
  Filter,
  Pencil,
  Check,
  X,
  Loader2,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Sparkles,
} from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
  ITEM_CATEGORIES,
  PERSONAL_STATUSES,
} from "@/lib/constants";
import { InlineCell } from "@/components/flipdesk/inline-cell";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
import { ItemDetailDialog } from "@/components/flipdesk/item-detail-dialog";
import { NextActionBadge } from "@/components/flipdesk/next-action-badge";
import { BulkAiEnrichDialog } from "@/components/flipdesk/bulk-ai-enrich-dialog";
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
import { cn } from "@/lib/utils";
import type { ItemFullRow, ItemStatus, SavedViewRow } from "@/types/database";

type ViewMode = "pipeline" | "personal" | "all";
type Preset = "triage" | "listing" | "sold" | "all";
type SortDir = "asc" | "desc";

type ColumnId =
  | "select"
  | "pencil"
  | "title"
  | "next"
  | "bin"
  | "sku"
  | "brand"
  | "style"
  | "size"
  | "category"
  | "source"
  | "by"
  | "cost"
  | "bought"
  | "listed"
  | "list_price"
  | "link"
  | "sold"
  | "sale_price"
  | "fees"
  | "tax"
  | "ship"
  | "net"
  | "payout"
  | "status"
  | "days"
  | "tracking";

type EditableField =
  | "container"
  | "sku"
  | "title"
  | "brand"
  | "style"
  | "size"
  | "sourced_by"
  | "acquired_price"
  | "item_category"
  | "status";

type Patch = Partial<Record<EditableField, string | number | null>>;

// Fields offered in the bulk-edit field picker.
const BULK_FIELDS: { field: EditableField; label: string }[] = [
  { field: "status", label: "Status" },
  { field: "container", label: "Container / Bin" },
  { field: "brand", label: "Brand" },
  { field: "style", label: "Style" },
  { field: "size", label: "Size" },
  { field: "item_category", label: "Category" },
  { field: "sourced_by", label: "Sourced By" },
];

const PRESETS: Record<Preset, Set<ColumnId>> = {
  triage: new Set<ColumnId>([
    "select",
    "pencil",
    "title",
    "next",
    "bin",
    "sku",
    "brand",
    "style",
    "size",
    "category",
    "source",
    "by",
    "cost",
    "bought",
    "status",
  ]),
  listing: new Set<ColumnId>([
    "select",
    "pencil",
    "title",
    "next",
    "sku",
    "brand",
    "style",
    "size",
    "cost",
    "listed",
    "list_price",
    "link",
    "status",
  ]),
  sold: new Set<ColumnId>([
    "select",
    "pencil",
    "title",
    "sku",
    "sold",
    "sale_price",
    "fees",
    "tax",
    "ship",
    "net",
    "payout",
    "days",
    "tracking",
    "status",
  ]),
  all: new Set<ColumnId>([
    "select",
    "pencil",
    "title",
    "next",
    "bin",
    "sku",
    "brand",
    "style",
    "size",
    "category",
    "source",
    "by",
    "cost",
    "bought",
    "listed",
    "list_price",
    "link",
    "sold",
    "sale_price",
    "fees",
    "tax",
    "ship",
    "net",
    "payout",
    "status",
    "days",
    "tracking",
  ]),
};

const PRESET_LABELS: Record<Preset, string> = {
  triage: "Triage",
  listing: "Listing prep",
  sold: "Sold / P&L",
  all: "All columns",
};

const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;

function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "";
  return `$${n.toFixed(2)}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

const STATUS_BADGE_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  sold: "default",
  shipped: "default",
  completed: "default",
  listed: "default",
  drafted: "secondary",
  photographed: "secondary",
  measured: "secondary",
  cataloged: "secondary",
  sourced: "secondary",
  acquired: "secondary",
  grading: "secondary",
  graded: "secondary",
  comped: "secondary",
  returned: "destructive",
  archived: "outline",
  keeping: "outline",
  wearing: "outline",
};

interface ColumnSpec {
  id: ColumnId;
  header: ReactNode;
  headerClassName?: string;
  cellClassName?: string;
  align?: "left" | "right";
  stickyLeft?: string;
  /** When present, header is clickable to sort by this key. */
  sortKey?: keyof ItemFullRow;
  render: (it: ItemFullRow) => ReactNode;
}

function escapeCsvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(rows: ItemFullRow[]): void {
  const headers = [
    "Container",
    "Item #",
    "Item Title",
    "Item Description",
    "Brand",
    "Style",
    "Size",
    "Notes",
    "Category",
    "Source",
    "Sourced By",
    "Purchase Date",
    "Purchase Price",
    "List Date",
    "Link",
    "List Price",
    "Sale Date",
    "Sale Price",
    "Fees",
    "Tax",
    "Shipping Cost",
    "Net Profit",
    "Payout",
    "Status",
    "Days to Sell",
    "Tracking",
  ];
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.container,
        r.item_number,
        r.item_title,
        r.item_description,
        r.brand,
        r.style,
        r.size,
        r.notes,
        r.category,
        r.source_name,
        r.sourced_by,
        r.purchase_date?.slice(0, 10),
        r.purchase_price,
        r.list_date?.slice(0, 10),
        r.link,
        r.list_price,
        r.sale_date?.slice(0, 10),
        r.sale_price,
        r.fees,
        r.tax,
        r.shipping_cost,
        r.net_profit,
        r.payout,
        r.status,
        r.days_to_sell,
        r.tracking,
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().slice(0, 10);
  a.download = `flipdesk-items-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function FlipdeskItemsPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  // Pre-fill from ?status= URL param so dashboard widgets can drill in.
  const initialStatusParam = searchParams.get("status");
  const initialStatus: ItemStatus | "all" =
    initialStatusParam &&
    (ITEM_STATUSES as readonly string[]).includes(initialStatusParam)
      ? (initialStatusParam as ItemStatus)
      : "all";
  const [statusFilter, setStatusFilter] = useState<ItemStatus | "all">(
    initialStatus,
  );
  const initialView = searchParams.get("view");
  const [view, setView] = useState<ViewMode>(
    initialView === "personal" || initialView === "all"
      ? initialView
      : "pipeline",
  );
  // Keep ?status= in sync when filter changes (so URLs are sharable).
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (statusFilter === "all") next.delete("status");
    else next.set("status", statusFilter);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);
  const [preset, setPreset] = useState<Preset>("triage");
  const [detailItem, setDetailItem] = useState<ItemFullRow | null>(null);
  const [aiEnrichOpen, setAiEnrichOpen] = useState(false);
  const [pending, setPending] = useState<Map<string, Patch>>(new Map());
  const [saving, setSaving] = useState(false);

  // Advanced filter — initialised from ?filter= or a saved view via ?view=.
  const { data: savedViews = [] } = useSavedViews();
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(() => {
    const f = searchParams.get("filter");
    return (f && decodeQuery(f)) || EMPTY_QUERY;
  });
  const [saveViewOpen, setSaveViewOpen] = useState(false);

  // Load a saved view when ?view=<id> resolves.
  useEffect(() => {
    const viewId = searchParams.get("view");
    if (!viewId || savedViews.length === 0) return;
    const v = savedViews.find((sv: SavedViewRow) => sv.id === viewId);
    if (v) {
      const q = decodeQuery(encodeQuery(v.query_json as unknown as FilterQuery));
      setFilterQuery(q ?? (v.query_json as unknown as FilterQuery));
      const next = new URLSearchParams(searchParams);
      next.delete("view");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViews, searchParams]);

  // Keep ?filter= in the URL in sync with the builder.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (filterQuery.rules.length === 0) next.delete("filter");
    else next.set("filter", encodeQuery(filterQuery));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery]);

  // Sorting
  const [sortField, setSortField] = useState<keyof ItemFullRow | null>(
    "created_at",
  );
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(100);

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkField, setBulkField] = useState<EditableField>("status");
  const [bulkValue, setBulkValue] = useState<string>("");

  // Reset page when filters change.
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, view, pageSize]);

  // Reset selection when filters or view changes.
  useEffect(() => {
    setSelected(new Set());
  }, [search, statusFilter, view]);

  const { data: items, isLoading, error } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error: qErr } = await (
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
        .order("created_at", { ascending: false });
      if (qErr) throw qErr;
      return data ?? [];
    },
  });

  // Open the detail dialog when arrived via ?focus=<id> (command palette).
  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (!focusId || !items || detailItem) return;
    const target = items.find((i) => i.id === focusId);
    if (target) {
      setDetailItem(target);
      const next = new URLSearchParams(searchParams);
      next.delete("focus");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, searchParams]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const personalSet = new Set<string>(PERSONAL_STATUSES);
    return items.filter((it) => {
      if (view === "pipeline" && personalSet.has(it.status)) return false;
      if (view === "personal" && !personalSet.has(it.status)) return false;
      if (statusFilter !== "all" && it.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = [
          it.item_title,
          it.brand,
          it.style,
          it.item_number,
          it.container,
          it.source_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (!evalQuery(it, filterQuery)) return false;
      return true;
    });
  }, [items, view, statusFilter, search, filterQuery]);

  const sorted = useMemo(() => {
    if (!sortField) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      // Natural sort: "SKU 2" sorts before "SKU 10", not after. Required for
      // numeric SKUs and item numbers that mix digits + text.
      return (
        String(av).localeCompare(String(bv), undefined, {
          numeric: true,
          sensitivity: "base",
        }) * dir
      );
    });
  }, [filtered, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = sorted.slice(pageStart, pageStart + pageSize);

  function toggleSort(field: keyof ItemFullRow) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function stage(
    id: string,
    field: EditableField,
    value: string | number | null,
  ) {
    setPending((prev) => {
      const next = new Map(prev);
      const existing: Patch = next.get(id) ?? {};
      next.set(id, { ...existing, [field]: value });
      return next;
    });
  }

  function isPending(id: string, field: EditableField): boolean {
    return pending.get(id)?.[field] !== undefined;
  }

  function displayValue<T extends string | number | null>(
    id: string,
    field: EditableField,
    fallback: T,
  ): T | string | number | null {
    const p = pending.get(id);
    if (p && field in p) return p[field] ?? null;
    return fallback;
  }

  function discardAll() {
    setPending(new Map());
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const pageRowIds = useMemo(() => pageRows.map((r) => r.id), [pageRows]);
  const allOnPageSelected =
    pageRowIds.length > 0 && pageRowIds.every((id) => selected.has(id));

  function toggleSelectAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const id of pageRowIds) next.delete(id);
      } else {
        for (const id of pageRowIds) next.add(id);
      }
      return next;
    });
  }

  function applyBulkField() {
    if (selected.size === 0 || bulkValue.trim() === "") return;
    const value: string | number =
      bulkField === "acquired_price" ? Number(bulkValue) : bulkValue.trim();
    setPending((prev) => {
      const next = new Map(prev);
      for (const id of selected) {
        const existing: Patch = next.get(id) ?? {};
        next.set(id, { ...existing, [bulkField]: value });
      }
      return next;
    });
    const label =
      BULK_FIELDS.find((f) => f.field === bulkField)?.label ?? bulkField;
    toast.info(
      `Staged ${label} on ${selected.size} item${selected.size === 1 ? "" : "s"}. Confirm at bottom.`,
    );
    setBulkValue("");
  }

  async function confirmAll() {
    if (pending.size === 0) return;
    setSaving(true);
    const errors: { id: string; message: string }[] = [];
    await Promise.all(
      Array.from(pending.entries()).map(async ([id, patch]) => {
        try {
          const cleaned: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(patch)) {
            cleaned[k] = typeof v === "string" && v.trim() === "" ? null : v;
          }
          const { error: uErr } = await supabase
            .from("inventory_items")
            .update(cleaned as never)
            .eq("id", id);
          if (uErr) throw uErr;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ id, message: msg });
        }
      }),
    );
    setSaving(false);
    if (errors.length === 0) {
      setPending(new Map());
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(
        `Saved ${pending.size} item${pending.size === 1 ? "" : "s"}.`,
      );
    } else {
      const failedIds = new Set(errors.map((e) => e.id));
      setPending((prev) => {
        const next = new Map<string, Patch>();
        for (const [id, patch] of prev) {
          if (failedIds.has(id)) next.set(id, patch);
        }
        return next;
      });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.warning(
        `Saved ${pending.size - errors.length}, ${errors.length} failed. First error: ${errors[0]?.message}`,
        { duration: 12_000 },
      );
    }
  }

  const pendingCount = useMemo(() => {
    let n = 0;
    for (const p of pending.values()) n += Object.keys(p).length;
    return n;
  }, [pending]);

  function SortIndicator({ field }: { field: keyof ItemFullRow }) {
    if (sortField !== field) {
      return (
        <ChevronsUpDown className="ml-1 inline h-3 w-3 opacity-30" />
      );
    }
    return sortDir === "asc" ? (
      <ChevronUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ChevronDown className="ml-1 inline h-3 w-3" />
    );
  }

  function sortableHeader(label: string, field: keyof ItemFullRow) {
    return (
      <button
        type="button"
        onClick={() => toggleSort(field)}
        className="inline-flex items-center hover:text-foreground"
      >
        {label}
        <SortIndicator field={field} />
      </button>
    );
  }

  const columns: ColumnSpec[] = [
    {
      id: "select",
      header: (
        <input
          type="checkbox"
          checked={allOnPageSelected}
          onChange={toggleSelectAllOnPage}
          className="h-3.5 w-3.5 cursor-pointer"
          aria-label="Select all on page"
        />
      ),
      headerClassName: "w-8 px-2",
      cellClassName: "px-2 w-8",
      stickyLeft: "0",
      render: (it) => (
        <input
          type="checkbox"
          checked={selected.has(it.id)}
          onChange={() => toggleSelected(it.id)}
          className="h-3.5 w-3.5 cursor-pointer"
          aria-label="Select row"
        />
      ),
    },
    {
      id: "pencil",
      header: null,
      headerClassName: "w-10 px-2",
      cellClassName: "px-2 w-10",
      stickyLeft: "2rem", // w-8 of checkbox
      render: (it) => (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setDetailItem(it)}
          aria-label="Open full editor"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      ),
    },
    {
      id: "title",
      header: sortableHeader("Title", "item_title"),
      headerClassName: "min-w-[220px] w-[220px]",
      cellClassName: "max-w-[220px] truncate font-medium",
      stickyLeft: "4.5rem", // w-8 + w-10
      sortKey: "item_title",
      render: (it) => (
        <InlineCell
          value={displayValue(it.id, "title", it.item_title)}
          pending={isPending(it.id, "title")}
          onChange={(v) => stage(it.id, "title", v || it.item_title)}
          className="truncate"
        />
      ),
    },
    {
      id: "next",
      header: "Next",
      headerClassName: "w-32",
      render: (it) => <NextActionBadge item={it} />,
    },
    {
      id: "bin",
      header: sortableHeader("Bin", "container"),
      headerClassName: "w-16",
      cellClassName: "font-mono text-[10px]",
      sortKey: "container",
      render: (it) => (
        <InlineCell
          value={displayValue(it.id, "container", it.container)}
          pending={isPending(it.id, "container")}
          onChange={(v) => stage(it.id, "container", v)}
        />
      ),
    },
    {
      id: "sku",
      header: sortableHeader("SKU", "item_number"),
      headerClassName: "w-20",
      cellClassName: "font-mono text-[10px]",
      sortKey: "item_number",
      render: (it) => (
        <InlineCell
          value={displayValue(it.id, "sku", it.item_number)}
          pending={isPending(it.id, "sku")}
          onChange={(v) => stage(it.id, "sku", v)}
        />
      ),
    },
    {
      id: "brand",
      header: sortableHeader("Brand", "brand"),
      headerClassName: "w-24",
      cellClassName: "max-w-[100px] truncate",
      sortKey: "brand",
      render: (it) => (
        <InlineCell
          value={displayValue(it.id, "brand", it.brand)}
          pending={isPending(it.id, "brand")}
          onChange={(v) => stage(it.id, "brand", v)}
          className="truncate"
        />
      ),
    },
    {
      id: "style",
      header: sortableHeader("Style", "style"),
      headerClassName: "w-24",
      cellClassName: "max-w-[100px] truncate",
      sortKey: "style",
      render: (it) => (
        <InlineCell
          value={displayValue(it.id, "style", it.style)}
          pending={isPending(it.id, "style")}
          onChange={(v) => stage(it.id, "style", v)}
          className="truncate"
        />
      ),
    },
    {
      id: "size",
      header: sortableHeader("Size", "size"),
      headerClassName: "w-14",
      cellClassName: "max-w-[60px] truncate",
      sortKey: "size",
      render: (it) => (
        <InlineCell
          value={displayValue(it.id, "size", it.size)}
          pending={isPending(it.id, "size")}
          onChange={(v) => stage(it.id, "size", v)}
          className="truncate"
        />
      ),
    },
    {
      id: "category",
      header: sortableHeader("Category", "category"),
      headerClassName: "w-20",
      cellClassName: "text-[10px]",
      sortKey: "category",
      render: (it) => it.category ?? "",
    },
    {
      id: "source",
      header: sortableHeader("Source", "source_name"),
      headerClassName: "w-24",
      cellClassName: "max-w-[100px] truncate",
      sortKey: "source_name",
      render: (it) => it.source_name ?? "",
    },
    {
      id: "by",
      header: sortableHeader("By", "sourced_by"),
      headerClassName: "w-20",
      cellClassName: "max-w-[80px] truncate",
      sortKey: "sourced_by",
      render: (it) => (
        <InlineCell
          value={displayValue(it.id, "sourced_by", it.sourced_by)}
          pending={isPending(it.id, "sourced_by")}
          onChange={(v) => stage(it.id, "sourced_by", v)}
          className="truncate"
        />
      ),
    },
    {
      id: "cost",
      header: (
        <div className="text-right">
          {sortableHeader("Cost", "purchase_price")}
        </div>
      ),
      headerClassName: "w-16",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "purchase_price",
      render: (it) => (
        <InlineCell
          value={displayValue(it.id, "acquired_price", it.purchase_price)}
          pending={isPending(it.id, "acquired_price")}
          type="number"
          align="right"
          onChange={(v) =>
            stage(it.id, "acquired_price", v === "" ? null : Number(v))
          }
        />
      ),
    },
    {
      id: "bought",
      header: sortableHeader("Bought", "purchase_date"),
      headerClassName: "w-20",
      cellClassName: "text-[10px]",
      sortKey: "purchase_date",
      render: (it) => fmtDate(it.purchase_date),
    },
    {
      id: "listed",
      header: sortableHeader("Listed", "list_date"),
      headerClassName: "w-20",
      cellClassName: "text-[10px]",
      sortKey: "list_date",
      render: (it) => fmtDate(it.list_date),
    },
    {
      id: "list_price",
      header: (
        <div className="text-right">
          {sortableHeader("List $", "list_price")}
        </div>
      ),
      headerClassName: "w-16",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "list_price",
      render: (it) => fmtMoney(it.list_price),
    },
    {
      id: "link",
      header: "Link",
      headerClassName: "w-8",
      render: (it) =>
        it.link ? (
          <a
            href={it.link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex text-brand-red"
            aria-label="Open listing"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null,
    },
    {
      id: "sold",
      header: sortableHeader("Sold", "sale_date"),
      headerClassName: "w-20",
      cellClassName: "text-[10px]",
      sortKey: "sale_date",
      render: (it) => fmtDate(it.sale_date),
    },
    {
      id: "sale_price",
      header: (
        <div className="text-right">
          {sortableHeader("Sale $", "sale_price")}
        </div>
      ),
      headerClassName: "w-16",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "sale_price",
      render: (it) => fmtMoney(it.sale_price),
    },
    {
      id: "fees",
      header: (
        <div className="text-right">{sortableHeader("Fees", "fees")}</div>
      ),
      headerClassName: "w-14",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "fees",
      render: (it) => fmtMoney(it.fees),
    },
    {
      id: "tax",
      header: (
        <div className="text-right">{sortableHeader("Tax", "tax")}</div>
      ),
      headerClassName: "w-14",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "tax",
      render: (it) => fmtMoney(it.tax),
    },
    {
      id: "ship",
      header: (
        <div className="text-right">
          {sortableHeader("Ship", "shipping_cost")}
        </div>
      ),
      headerClassName: "w-14",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "shipping_cost",
      render: (it) => fmtMoney(it.shipping_cost),
    },
    {
      id: "net",
      header: (
        <div className="text-right">{sortableHeader("Net", "net_profit")}</div>
      ),
      headerClassName: "w-16",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "net_profit",
      render: (it) => fmtMoney(it.net_profit),
    },
    {
      id: "payout",
      header: (
        <div className="text-right">{sortableHeader("Payout", "payout")}</div>
      ),
      headerClassName: "w-16",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "payout",
      render: (it) => fmtMoney(it.payout),
    },
    {
      id: "status",
      header: sortableHeader("Status", "status"),
      headerClassName: "w-28",
      sortKey: "status",
      render: (it) => (
        <Select
          value={
            displayValue(it.id, "status", it.status) as ItemStatus | string
          }
          onValueChange={(v) => stage(it.id, "status", v)}
        >
          <SelectTrigger
            className={cn(
              "h-7 border-0 bg-transparent px-2 text-xs hover:bg-muted/60",
              isPending(it.id, "status") && "ring-1 ring-amber-400/60",
            )}
          >
            <Badge
              variant={
                STATUS_BADGE_VARIANT[
                  String(displayValue(it.id, "status", it.status))
                ] ?? "secondary"
              }
              className="text-[10px]"
            >
              {
                ITEM_STATUS_LABELS[
                  String(displayValue(it.id, "status", it.status)) as ItemStatus
                ]
              }
            </Badge>
          </SelectTrigger>
          <SelectContent>
            {ITEM_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {ITEM_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: "days",
      header: (
        <div className="text-right">{sortableHeader("Days", "days_to_sell")}</div>
      ),
      headerClassName: "w-10",
      cellClassName: "text-right tabular-nums",
      align: "right",
      sortKey: "days_to_sell",
      render: (it) => it.days_to_sell ?? "",
    },
    {
      id: "tracking",
      header: "Tracking",
      headerClassName: "w-24",
      cellClassName: "max-w-[120px] truncate font-mono text-[10px]",
      render: (it) => it.tracking ?? "",
    },
  ];

  const visibleColumns = columns.filter((c) => PRESETS[preset].has(c.id));

  function stickyBgClasses(): string {
    // Background that matches both default and row-hover. We apply both
    // classes; the group-hover variant takes precedence on row hover.
    return "bg-card group-hover:bg-muted/30";
  }

  return (
    <div className="space-y-6 pb-24">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
            <p className="text-sm text-muted-foreground">
              Power-user editor. Click a cell to edit; changes stage in amber
              until you <strong>Confirm</strong> at the bottom of the screen.
            </p>
          </div>
          <InventoryViewSwitcher current="table" />
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => downloadCsv(sorted)}
            disabled={sorted.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button variant="outline" asChild>
            <Link to="/dashboard/flipdesk/import">
              <Upload className="mr-2 h-4 w-4" />
              Import
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/dashboard/flipdesk/intake?mode=snap">
              <Sparkles className="mr-2 h-4 w-4" />
              Snap &amp; Catalog
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
        {(["pipeline", "personal", "all"] as const).map((v) => (
          <Button
            key={v}
            variant={view === v ? "default" : "outline"}
            size="sm"
            onClick={() => setView(v)}
          >
            {v === "pipeline"
              ? "Selling"
              : v === "personal"
                ? "Keeping / Wearing"
                : "All"}
          </Button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
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
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as ItemStatus | "all")}
          >
            <SelectTrigger className="w-44">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {ITEM_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {ITEM_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Columns:
        </span>
        {(["triage", "listing", "sold", "all"] as const).map((p) => (
          <Button
            key={p}
            variant={preset === p ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPreset(p)}
          >
            {PRESET_LABELS[p]}
          </Button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <FilterBuilder query={filterQuery} onChange={setFilterQuery} />
          {savedViews.length > 0 && (
            <Select
              value=""
              onValueChange={(id) => {
                const v = savedViews.find((sv) => sv.id === id);
                if (v) {
                  const q = v.query_json as unknown as FilterQuery;
                  setFilterQuery(
                    q && Array.isArray(q.rules) ? q : EMPTY_QUERY,
                  );
                }
              }}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
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
        </div>
      </div>

      {/* Active filter chips */}
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
                aria-label="Remove filter"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => setFilterQuery(EMPTY_QUERY)}
            className="text-xs text-brand-red hover:underline"
          >
            Clear all
          </button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {sorted.length} item{sorted.length === 1 ? "" : "s"}
            {selected.size > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({selected.size} selected)
              </span>
            )}
          </CardTitle>
          <CardDescription>
            Title stays pinned on the left. Click a column header to sort.
            Click a cell to edit.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading items…
            </div>
          ) : error ? (
            <div className="space-y-2 py-12 text-center">
              <div className="text-sm font-medium text-destructive">
                Failed to load items
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                {error instanceof Error ? error.message : String(error)}
              </div>
            </div>
          ) : pageRows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No items yet.{" "}
              <Link
                to="/dashboard/flipdesk/import"
                className="font-medium text-brand-red underline"
              >
                Import from spreadsheet
              </Link>
              {" "}or{" "}
              <Link
                to="/dashboard/flipdesk/intake"
                className="font-medium text-brand-red underline"
              >
                add one manually
              </Link>
              .
            </div>
          ) : (
            <>
              <div className="relative overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      {visibleColumns.map((c) => (
                        <TableHead
                          key={c.id}
                          className={cn(
                            c.headerClassName,
                            c.align === "right" && "text-right",
                            c.stickyLeft != null &&
                              "sticky z-20 bg-card shadow-[1px_0_0_rgba(0,0,0,0.04)]",
                          )}
                          style={
                            c.stickyLeft != null
                              ? { left: c.stickyLeft }
                              : undefined
                          }
                        >
                          {c.header}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((it) => {
                      const rowHasPending = pending.has(it.id);
                      const isSel = selected.has(it.id);
                      return (
                        <TableRow
                          key={it.id}
                          className={cn(
                            "group",
                            rowHasPending && "border-l-2 border-l-amber-400",
                            isSel && "bg-brand-navy/5",
                          )}
                        >
                          {visibleColumns.map((c) => (
                            <TableCell
                              key={c.id}
                              className={cn(
                                c.cellClassName,
                                c.stickyLeft != null && [
                                  "sticky z-10",
                                  stickyBgClasses(),
                                  "shadow-[1px_0_0_rgba(0,0,0,0.04)]",
                                  isSel && "!bg-brand-navy/5",
                                ],
                              )}
                              style={
                                c.stickyLeft != null
                                  ? { left: c.stickyLeft }
                                  : undefined
                              }
                            >
                              {c.render(it)}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination footer */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Rows per page:</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => setPageSize(Number(v))}
                  >
                    <SelectTrigger className="h-7 w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="text-muted-foreground">
                  {pageStart + 1}–{pageStart + pageRows.length} of {sorted.length}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Prev
                  </Button>
                  <span className="px-2">
                    Page {safePage} of {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Bulk action bar — separate from pending bar, sits above it */}
      {selected.size > 0 && (
        <div
          className={cn(
            "fixed inset-x-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80",
            pending.size > 0 ? "bottom-[68px]" : "bottom-0",
          )}
        >
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="text-sm">
              <span className="font-semibold text-brand-navy">
                {selected.size} selected
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Set</span>
              <Select
                value={bulkField}
                onValueChange={(v) => {
                  setBulkField(v as EditableField);
                  setBulkValue("");
                }}
              >
                <SelectTrigger className="h-9 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BULK_FIELDS.map((f) => (
                    <SelectItem key={f.field} value={f.field}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">to</span>
              {bulkField === "status" ? (
                <Select value={bulkValue} onValueChange={setBulkValue}>
                  <SelectTrigger className="h-9 w-40">
                    <SelectValue placeholder="status…" />
                  </SelectTrigger>
                  <SelectContent>
                    {ITEM_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {ITEM_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : bulkField === "item_category" ? (
                <Select value={bulkValue} onValueChange={setBulkValue}>
                  <SelectTrigger className="h-9 w-40">
                    <SelectValue placeholder="category…" />
                  </SelectTrigger>
                  <SelectContent>
                    {ITEM_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={bulkValue}
                  onChange={(e) => setBulkValue(e.target.value)}
                  placeholder="value…"
                  className="h-9 w-40"
                />
              )}
              <Button
                onClick={applyBulkField}
                disabled={bulkValue.trim() === ""}
              >
                Stage
              </Button>
              <Button
                variant="outline"
                onClick={() => setAiEnrichOpen(true)}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                AI enrich ({selected.size})
              </Button>
              <Button
                variant="outline"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </div>
          </div>
        </div>
      )}

      {pending.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="text-sm">
              <span className="font-semibold text-amber-700 dark:text-amber-400">
                {pendingCount} pending change{pendingCount === 1 ? "" : "s"}
              </span>{" "}
              <span className="text-muted-foreground">
                across {pending.size} item{pending.size === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={discardAll}
                disabled={saving}
              >
                <X className="mr-2 h-4 w-4" />
                Discard
              </Button>
              <Button onClick={confirmAll} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-2 h-4 w-4" />
                )}
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}

      <ItemDetailDialog item={detailItem} onClose={() => setDetailItem(null)} />

      <BulkAiEnrichDialog
        open={aiEnrichOpen}
        onOpenChange={setAiEnrichOpen}
        itemIds={[...selected]}
        onReviewItem={(itemId) => {
          const target = items?.find((it) => it.id === itemId) ?? null;
          if (target) setDetailItem(target);
        }}
        onDone={() => {
          void qc.invalidateQueries({ queryKey: ["items_full"] });
        }}
      />

      <SaveViewDialog
        open={saveViewOpen}
        onOpenChange={setSaveViewOpen}
        query={filterQuery}
      />
    </div>
  );
}
