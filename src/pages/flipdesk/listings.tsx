import { useMemo, useState, useEffect, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  ExternalLink,
  Plus,
  Upload,
  Clock,
  AlertCircle,
  FileText,
  Loader2,
  Truck,
  Star,
  XCircle,
  TrendingDown,
  RefreshCw,
  Download,
  Sparkles,
  Rocket,
  RotateCcw,
  X,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import { ItemDetailDialog } from "@/components/flipdesk/item-detail-dialog";
import { InlineCell } from "@/components/flipdesk/inline-cell";
import { MarkListedDialog } from "@/components/flipdesk/mark-listed-dialog";
import { PublishToEbayDialog } from "@/components/flipdesk/publish-to-ebay-dialog";
import { ReviseListingDialog } from "@/components/flipdesk/revise-listing-dialog";
import { RecordSaleDialog } from "@/components/flipdesk/record-sale-dialog";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
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
import { downloadItemsCsv } from "@/lib/items-csv";
import {
  useEbayConnection,
  useEbayEndListing,
  useEbayUpdateListingPrice,
  usePublishToEbay,
  useSyncEbayListings,
} from "@/hooks/use-ebay";
import { scoreListability, maxCompPrice } from "@/lib/listability";
import { cn } from "@/lib/utils";
import type {
  ItemFullRow,
  ItemStatus,
  ListingInsert,
} from "@/types/database";

type TabId =
  | "all"
  | "to_list"
  | "drafts"
  | "active"
  | "sold"
  | "shipped"
  | "returned";

type SortPreset = "listability" | "oldest" | "best_roi" | "highest_comp";
type SoldFilter = "all" | "awaiting_payout" | "discrepancy" | "d7" | "d30" | "ytd";

const SORT_PRESET_LABELS: Record<SortPreset, string> = {
  listability: "Listability score",
  oldest: "Oldest first",
  best_roi: "Best ROI",
  highest_comp: "Highest comp",
};

const SOLD_FILTER_LABELS: Record<SoldFilter, string> = {
  all: "All",
  awaiting_payout: "Awaiting payout",
  discrepancy: "Discrepancy",
  d7: "Last 7 days",
  d30: "Last 30 days",
  ytd: "Year to date",
};

// Every "pre-listed" prep stage shows up in To List so nothing gets
// stranded mid-pipeline. The Drafts tab covers `drafted`; Active covers
// `listed`; everything else terminal (sold, shipped, returned, archived)
// has its own tab.
const TO_LIST_STATUSES: ReadonlySet<ItemStatus> = new Set([
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "graded",
  "comped",
]);

// Default eBay handling window for the ship-by countdown when no explicit
// handling time is stored on the listing.
const DEFAULT_HANDLING_DAYS = 3;

interface TabDef {
  id: TabId;
  label: string;
  matches: (it: ItemFullRow) => boolean;
  sortKey: keyof ItemFullRow;
  sortDir: "asc" | "desc";
  emptyCta: { label: string; to: string };
}

const TABS: TabDef[] = [
  {
    id: "all",
    label: "All",
    matches: () => true,
    sortKey: "created_at",
    sortDir: "desc",
    emptyCta: { label: "Add an item", to: "/dashboard/flipdesk/intake" },
  },
  {
    id: "to_list",
    label: "To List",
    matches: (it) => TO_LIST_STATUSES.has(it.status),
    sortKey: "updated_at",
    sortDir: "asc",
    emptyCta: { label: "Add an item", to: "/dashboard/flipdesk/intake" },
  },
  {
    id: "drafts",
    label: "Drafts",
    matches: (it) => it.status === "drafted",
    sortKey: "updated_at",
    sortDir: "asc",
    emptyCta: { label: "View To-List queue", to: "?tab=to_list" },
  },
  {
    id: "active",
    label: "Active",
    matches: (it) => it.status === "listed",
    sortKey: "list_date",
    sortDir: "desc",
    emptyCta: { label: "View drafts", to: "?tab=drafts" },
  },
  {
    id: "sold",
    label: "Sold",
    matches: (it) => it.status === "sold",
    sortKey: "sale_date",
    sortDir: "desc",
    emptyCta: { label: "View active listings", to: "?tab=active" },
  },
  {
    id: "shipped",
    label: "Shipped",
    matches: (it) => it.status === "shipped",
    sortKey: "sale_date",
    sortDir: "desc",
    emptyCta: { label: "View sold items", to: "?tab=sold" },
  },
  {
    id: "returned",
    label: "Returned",
    matches: (it) => it.status === "returned",
    sortKey: "updated_at",
    sortDir: "desc",
    emptyCta: { label: "View completed", to: "?tab=all" },
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "";
  return `$${n.toFixed(2)}`;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
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

function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 45) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

type PayoutState = "cleared" | "pending" | "discrepancy";

// Without US-125 reconciliation, payout state is inferred: a recorded payout
// amount = cleared; abnormally high fees (>20% of sale) = discrepancy.
function payoutState(it: ItemFullRow): PayoutState {
  if (it.payout != null && it.payout > 0) {
    if (
      it.sale_price != null &&
      it.sale_price > 0 &&
      it.fees != null &&
      it.fees > it.sale_price * 0.2
    ) {
      return "discrepancy";
    }
    return "cleared";
  }
  return "pending";
}

function marginPct(it: ItemFullRow): number | null {
  if (it.sale_price == null || it.sale_price <= 0) return null;
  if (it.net_profit == null) return null;
  return (it.net_profit / it.sale_price) * 100;
}

interface ShipBy {
  label: string;
  tone: "red" | "amber" | "green" | "none";
}

function shipByInfo(it: ItemFullRow): ShipBy {
  const sold = it.sold_at_raw ?? it.sale_date;
  const t = sold ? new Date(sold).getTime() : null;
  if (t == null || isNaN(t)) return { label: "", tone: "none" };
  const dueBy = t + DEFAULT_HANDLING_DAYS * DAY_MS;
  const msLeft = dueBy - Date.now();
  if (msLeft < 0) {
    return {
      label: `${Math.ceil(-msLeft / DAY_MS)}d overdue`,
      tone: "red",
    };
  }
  const hoursLeft = msLeft / HOUR_MS;
  if (hoursLeft < 24) return { label: `${Math.round(hoursLeft)}h left`, tone: "red" };
  if (hoursLeft < 48)
    return { label: `${Math.round(hoursLeft)}h left`, tone: "amber" };
  return { label: `${Math.round(hoursLeft / 24)}d left`, tone: "green" };
}

export function FlipdeskListingsPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get("tab") as TabId) ?? "to_list";
  const [tab, setTab] = useState<TabId>(
    TABS.some((t) => t.id === initialTab) ? initialTab : "to_list",
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(100);
  const [detailItem, setDetailItem] = useState<ItemFullRow | null>(null);
  const [sortPreset, setSortPreset] = useState<SortPreset>("listability");
  // When set, overrides the tab's default sort. Lets the user click a
  // column header — currently SKU, can extend to others — to take control
  // without losing the stage tab they're in.
  const [columnSort, setColumnSort] = useState<{
    field: keyof ItemFullRow;
    dir: "asc" | "desc";
  } | null>(null);
  function toggleColumnSort(field: keyof ItemFullRow) {
    setColumnSort((prev) =>
      prev && prev.field === field
        ? prev.dir === "asc"
          ? { field, dir: "desc" }
          : null // third click clears, revealing the tab's default sort again
        : { field, dir: "asc" },
    );
  }
  const [soldFilter, setSoldFilter] = useState<SoldFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [endTarget, setEndTarget] = useState<ItemFullRow | null>(null);
  const [bulkDropPct, setBulkDropPct] = useState<string>("10");
  const [markListedItem, setMarkListedItem] = useState<ItemFullRow | null>(
    null,
  );
  const [publishItem, setPublishItem] = useState<ItemFullRow | null>(null);
  const [reviseItem, setReviseItem] = useState<ItemFullRow | null>(null);
  const [recordSaleItem, setRecordSaleItem] = useState<ItemFullRow | null>(
    null,
  );
  const { data: ebayConnection } = useEbayConnection();
  const syncEbay = useSyncEbayListings();
  const updatePrice = useEbayUpdateListingPrice();
  const endListingApi = useEbayEndListing();
  const publishApi = usePublishToEbay();
  const [bulkPublishProgress, setBulkPublishProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // Advanced filter — composes ON TOP of the stage tabs. Initialised from
  // the URL so saved-view links round-trip cleanly.
  const { data: savedViews = [] } = useSavedViews();
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(() => {
    const f = searchParams.get("filter");
    return (f && decodeQuery(f)) || EMPTY_QUERY;
  });
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [aiEnrichOpen, setAiEnrichOpen] = useState(false);

  // Load a saved view when ?view=<id> resolves — applies the saved filter
  // and strips the param so a reload doesn't re-apply.
  useEffect(() => {
    const viewId = searchParams.get("view");
    if (!viewId || savedViews.length === 0) return;
    const v = savedViews.find((sv) => sv.id === viewId);
    if (v) {
      const q = v.query_json as unknown as FilterQuery;
      setFilterQuery(
        q && Array.isArray(q.rules) ? q : EMPTY_QUERY,
      );
      const next = new URLSearchParams(searchParams);
      next.delete("view");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViews, searchParams]);

  // Keep ?filter= in the URL synced with the builder so the link survives
  // copy-paste between teammates.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (filterQuery.rules.length === 0) next.delete("filter");
    else next.set("filter", encodeQuery(filterQuery));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery]);

  const isToList = tab === "to_list";
  const isSold = tab === "sold";
  const isActive = tab === "active";
  const isDrafts = tab === "drafts";
  const selectable = isToList || isSold || isActive || isDrafts;

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (tab === "to_list") next.delete("tab");
    else next.set("tab", tab);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    setPage(1);
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    setPage(1);
  }, [search, pageSize, soldFilter]);

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
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const tabCounts = useMemo(() => {
    const counts: Record<TabId, number> = {
      all: 0,
      to_list: 0,
      drafts: 0,
      active: 0,
      sold: 0,
      shipped: 0,
      returned: 0,
    };
    for (const it of items) {
      for (const t of TABS) if (t.matches(it)) counts[t.id]++;
    }
    return counts;
  }, [items]);

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  const scoreById = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) m.set(it.id, scoreListability(it).score);
    return m;
  }, [items]);

  // Count of sales per buyer — drives the repeat-buyer star.
  const buyerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      if (it.buyer_id) m.set(it.buyer_id, (m.get(it.buyer_id) ?? 0) + 1);
    }
    return m;
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
    const rows = items.filter((it) => {
      if (!activeTab.matches(it)) return false;
      if (q) {
        const hay = [
          it.item_title,
          it.brand,
          it.style,
          it.item_number,
          it.container,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (isSold && soldFilter !== "all") {
        const soldT = it.sale_date ? new Date(it.sale_date).getTime() : null;
        if (soldFilter === "awaiting_payout" && payoutState(it) !== "pending")
          return false;
        if (soldFilter === "discrepancy" && payoutState(it) !== "discrepancy")
          return false;
        if (
          soldFilter === "d7" &&
          (soldT == null || soldT < Date.now() - 7 * DAY_MS)
        )
          return false;
        if (
          soldFilter === "d30" &&
          (soldT == null || soldT < Date.now() - 30 * DAY_MS)
        )
          return false;
        if (soldFilter === "ytd" && (soldT == null || soldT < yearStart))
          return false;
      }
      // Advanced filter — composes on top of stage tab + search + sold-tab filter.
      if (filterQuery.rules.length > 0 && !evalQuery(it, filterQuery)) {
        return false;
      }
      return true;
    });

    // Column override wins over every default sort — including the To
    // List preset — so the user always gets the column they clicked.
    if (columnSort) {
      const { field, dir: cdir } = columnSort;
      const sign = cdir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === "number" && typeof bv === "number") {
          return (av - bv) * sign;
        }
        return (
          String(av).localeCompare(String(bv), undefined, {
            numeric: true,
            sensitivity: "base",
          }) * sign
        );
      });
      return rows;
    }

    if (isToList) {
      rows.sort((a, b) => {
        switch (sortPreset) {
          case "listability":
            return (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0);
          case "oldest": {
            const at = a.created_at ? new Date(a.created_at).getTime() : 0;
            const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
            return at - bt;
          }
          case "best_roi": {
            const roi = (it: ItemFullRow) => {
              const price = it.target_price ?? it.list_price;
              const cost = it.purchase_price ?? 0;
              if (price == null || price <= 0) return -1;
              return (price - cost) / price;
            };
            return roi(b) - roi(a);
          }
          case "highest_comp":
            return maxCompPrice(b) - maxCompPrice(a);
        }
      });
      return rows;
    }

    const dir = activeTab.sortDir === "asc" ? 1 : -1;
    const key = activeTab.sortKey;
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      // Natural sort so "10" follows "9", not "1".
      return (
        String(av).localeCompare(String(bv), undefined, {
          numeric: true,
          sensitivity: "base",
        }) * dir
      );
    });
    return rows;
  }, [items, activeTab, search, isToList, isSold, soldFilter, sortPreset, scoreById, filterQuery, columnSort]);

  // Aggregate strip for the Sold tab — over the current filter.
  const soldAgg = useMemo(() => {
    if (!isSold) return null;
    let gross = 0;
    let net = 0;
    let marginSum = 0;
    let marginN = 0;
    for (const it of filtered) {
      gross += it.sale_price ?? 0;
      net += it.net_profit ?? 0;
      const m = marginPct(it);
      if (m != null) {
        marginSum += m;
        marginN += 1;
      }
    }
    return {
      count: filtered.length,
      gross,
      net,
      avgMargin: marginN > 0 ? marginSum / marginN : null,
    };
  }, [isSold, filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = filtered.slice(pageStart, pageStart + pageSize);

  const pageRowIds = useMemo(() => pageRows.map((r) => r.id), [pageRows]);
  const allOnPageSelected =
    pageRowIds.length > 0 && pageRowIds.every((id) => selected.has(id));

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) for (const id of pageRowIds) next.delete(id);
      else for (const id of pageRowIds) next.add(id);
      return next;
    });
  }

  async function bulkCreateDrafts() {
    if (selected.size === 0) return;
    setBusy(true);
    const errors: { message: string }[] = [];
    let created = 0;
    for (const id of selected) {
      const it = items.find((i) => i.id === id);
      if (!it) continue;
      try {
        const listing: ListingInsert = {
          inventory_item_id: it.id,
          platform: "ebay",
          listing_status: "draft",
          listing_price: it.target_price ?? it.list_price ?? 0,
          listing_title: it.item_title,
          listing_description: it.item_description ?? null,
          is_active: false,
        };
        const { error: lErr } = await supabase
          .from("listings")
          .insert(listing as never);
        if (lErr) throw lErr;
        const { error: uErr } = await supabase
          .from("inventory_items")
          .update({ status: "drafted" } as never)
          .eq("id", it.id);
        if (uErr) throw uErr;
        created++;
      } catch (err) {
        errors.push({
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setBusy(false);
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      toast.success(`Created ${created} draft${created === 1 ? "" : "s"}.`);
    } else {
      toast.warning(
        `Created ${created}, ${errors.length} failed. First: ${errors[0]?.message}`,
        { duration: 12_000 },
      );
    }
  }

  async function bulkMarkShipped() {
    if (selected.size === 0) return;
    setBusy(true);
    const errors: { message: string }[] = [];
    let done = 0;
    for (const id of selected) {
      try {
        const { error } = await supabase
          .from("inventory_items")
          .update({ status: "shipped" } as never)
          .eq("id", id);
        if (error) throw error;
        done++;
      } catch (err) {
        errors.push({
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setBusy(false);
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      toast.success(`Marked ${done} shipped.`);
    } else {
      toast.warning(
        `Marked ${done} shipped, ${errors.length} failed. First: ${errors[0]?.message}`,
        { duration: 12_000 },
      );
    }
  }

  // Inline price edit on the Active tab. Calls eBay's Sell API when the
  // listing has a platform_offer_id, then writes through to local state.
  // Falls back to local-only when no eBay connection or no offer_id is
  // available (e.g. listings manually marked via MarkListedDialog).
  async function updateListingPrice(it: ItemFullRow, raw: string) {
    if (!it.listing_id) {
      toast.error("No listing record for this item.");
      return;
    }
    const next = Number(raw);
    if (!Number.isFinite(next) || next < 0) {
      toast.error("Enter a valid price.");
      return;
    }
    const prev = items;
    qc.setQueryData<ItemFullRow[]>(["items_full", user?.id], (old) =>
      (old ?? []).map((i) =>
        i.id === it.id ? { ...i, list_price: next } : i,
      ),
    );
    try {
      if (ebayConnection) {
        try {
          await updatePrice.mutateAsync({
            listingId: it.listing_id,
            price: next,
          });
          // Server already wrote-through to listings.listing_price.
          return;
        } catch (err) {
          const e = err as Error & { status?: number };
          // 409 = no platform_offer_id → fall through to local-only update.
          if (e.status !== 409) throw e;
        }
      }
      const { error } = await supabase
        .from("listings")
        .update({ listing_price: next } as never)
        .eq("id", it.listing_id);
      if (error) throw error;
    } catch (err) {
      qc.setQueryData(["items_full", user?.id], prev);
      toast.error(
        `Price update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function endListing(it: ItemFullRow) {
    if (!it.listing_id) {
      toast.error("No listing record for this item.");
      return;
    }
    try {
      if (ebayConnection) {
        try {
          await endListingApi.mutateAsync({ listingId: it.listing_id });
          await qc.invalidateQueries({ queryKey: ["items_full"] });
          toast.success("Listing ended on eBay.");
          return;
        } catch (err) {
          const e = err as Error & { status?: number };
          if (e.status !== 409) throw e;
          // 409 → fall through to local-only end.
        }
      }
      const { error: lErr } = await supabase
        .from("listings")
        .update({ listing_status: "ended", is_active: false } as never)
        .eq("id", it.listing_id);
      if (lErr) throw lErr;
      // Move the item back to drafted so it can be relisted.
      const { error: iErr } = await supabase
        .from("inventory_items")
        .update({ status: "drafted" } as never)
        .eq("id", it.id);
      if (iErr) throw iErr;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Listing ended locally.");
    } catch (err) {
      toast.error(
        `End failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function bulkPriceDrop() {
    if (selected.size === 0) return;
    const pct = Number(bulkDropPct);
    if (!Number.isFinite(pct) || pct <= 0) return;
    setBusy(true);
    const errors: { message: string }[] = [];
    let done = 0;
    let remoteSkipped = 0;
    for (const id of selected) {
      const it = items.find((i) => i.id === id);
      if (!it || !it.listing_id || it.list_price == null) continue;
      const next = Number((it.list_price * (1 - pct / 100)).toFixed(2));
      try {
        let usedEbay = false;
        if (ebayConnection) {
          try {
            await updatePrice.mutateAsync({
              listingId: it.listing_id,
              price: next,
            });
            usedEbay = true;
          } catch (err) {
            const e = err as Error & { status?: number };
            if (e.status === 409) remoteSkipped += 1;
            else throw e;
          }
        }
        if (!usedEbay) {
          const { error } = await supabase
            .from("listings")
            .update({ listing_price: next } as never)
            .eq("id", it.listing_id);
          if (error) throw error;
        }
        done++;
      } catch (err) {
        errors.push({
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setBusy(false);
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      const localNote = remoteSkipped > 0
        ? ` (${remoteSkipped} updated locally only)`
        : "";
      toast.success(
        `Dropped price ${pct}% on ${done} listing${done === 1 ? "" : "s"}${localNote}.`,
      );
    } else {
      toast.warning(
        `Dropped ${done}, ${errors.length} failed. First: ${errors[0]?.message}`,
        { duration: 12_000 },
      );
    }
  }

  // Sequential publish so we don't hammer eBay's rate limits and so
  // partial failures surface in a deterministic order. Each publish hits
  // the validate-then-push pipeline server-side, so blockers come back as
  // structured errors (the same the dialog surfaces single-item).
  async function bulkPublishToEbay() {
    if (selected.size === 0 || !ebayConnection) return;
    const ids = Array.from(selected);
    setBusy(true);
    setBulkPublishProgress({ done: 0, total: ids.length });
    const errors: { title: string; message: string }[] = [];
    let published = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const it = items.find((x) => x.id === id);
      if (!it) {
        setBulkPublishProgress({ done: i + 1, total: ids.length });
        continue;
      }
      try {
        await publishApi.mutateAsync({ itemId: id });
        published++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ title: it.item_title, message: msg.split("\n")[0] ?? msg });
      }
      setBulkPublishProgress({ done: i + 1, total: ids.length });
    }
    setBusy(false);
    setBulkPublishProgress(null);
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      toast.success(
        `Published ${published} listing${published === 1 ? "" : "s"} to eBay.`,
      );
    } else if (published === 0) {
      toast.error(
        `Publish failed for all ${errors.length}. First: ${errors[0]?.title} — ${errors[0]?.message}`,
        { duration: 14_000 },
      );
    } else {
      toast.warning(
        `Published ${published}, ${errors.length} failed. First: ${errors[0]?.title} — ${errors[0]?.message}`,
        { duration: 14_000 },
      );
    }
  }

  async function bulkEndListings() {
    if (selected.size === 0) return;
    setBusy(true);
    const errors: { message: string }[] = [];
    let done = 0;
    let remoteSkipped = 0;
    for (const id of selected) {
      const it = items.find((i) => i.id === id);
      if (!it || !it.listing_id) continue;
      try {
        let usedEbay = false;
        if (ebayConnection) {
          try {
            await endListingApi.mutateAsync({ listingId: it.listing_id });
            usedEbay = true;
          } catch (err) {
            const e = err as Error & { status?: number };
            if (e.status === 409) remoteSkipped += 1;
            else throw e;
          }
        }
        if (!usedEbay) {
          const { error: lErr } = await supabase
            .from("listings")
            .update({ listing_status: "ended", is_active: false } as never)
            .eq("id", it.listing_id);
          if (lErr) throw lErr;
          const { error: iErr } = await supabase
            .from("inventory_items")
            .update({ status: "drafted" } as never)
            .eq("id", it.id);
          if (iErr) throw iErr;
        }
        done++;
      } catch (err) {
        errors.push({
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setBusy(false);
    setSelected(new Set());
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      const localNote = remoteSkipped > 0
        ? ` (${remoteSkipped} ended locally only)`
        : "";
      toast.success(
        `Ended ${done} listing${done === 1 ? "" : "s"}${localNote}.`,
      );
    } else {
      toast.warning(
        `Ended ${done}, ${errors.length} failed. First: ${errors[0]?.message}`,
        { duration: 12_000 },
      );
    }
  }

  return (
    <div className={cn("space-y-6", selectable && selected.size > 0 && "pb-24")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
            <p className="text-sm text-muted-foreground">
              Triage surface — focus on items by their selling stage.
            </p>
          </div>
          <InventoryViewSwitcher current="table" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => downloadItemsCsv(filtered)}
            disabled={filtered.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          {ebayConnection && (
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const r = await syncEbay.mutateAsync({ full: false });
                  // Background-sync path — server returned 202, counts will
                  // land in container logs instead of this response. Show a
                  // running-in-background toast and bail.
                  if (r.started) {
                    toast.success(
                      "Sync started — listings + sales will refresh in a minute.",
                    );
                    return;
                  }
                  const matched = r.matched ?? 0;
                  const legacyMatched = r.legacy_matched ?? 0;
                  const salesNew = r.sales_new ?? 0;
                  const salesUpdated = r.sales_updated ?? 0;
                  const unmatched = r.unmatched ?? 0;
                  const legacyUnmatched = r.legacy_unmatched ?? 0;
                  const totalMatched = matched + legacyMatched;
                  const legacyLine = legacyMatched > 0
                    ? ` (${legacyMatched} legacy)`
                    : "";
                  const salesLine = salesNew + salesUpdated > 0
                    ? ` • ${salesNew} new sale${salesNew === 1 ? "" : "s"}${salesUpdated > 0 ? `, ${salesUpdated} updated` : ""}`
                    : "";
                  const totalUnmatched = unmatched + legacyUnmatched;
                  // Compose toast description: orphans first, then any
                  // partial-failure errors (the orders pass may 403 silently
                  // when the OAuth token is missing the sell.fulfillment
                  // scope — the user needs to see that, not "0 new sales").
                  const lines: string[] = [];
                  if (totalUnmatched > 0) {
                    lines.push(
                      `${totalUnmatched} orphan eBay listing${totalUnmatched === 1 ? "" : "s"} — open Reconciliation to link them.`,
                    );
                  }
                  if (r.errors && r.errors.length > 0) {
                    lines.push(
                      `Partial failure: ${r.errors[0]}` +
                        (r.errors.length > 1
                          ? ` (+${r.errors.length - 1} more)`
                          : ""),
                    );
                  }
                  const description = lines.length > 0
                    ? lines.join(" · ")
                    : undefined;
                  if (r.errors && r.errors.length > 0) {
                    toast.warning(
                      `Synced ${totalMatched} listing${totalMatched === 1 ? "" : "s"}${legacyLine}${salesLine}, with errors.`,
                      { description, duration: 14000 },
                    );
                  } else {
                    toast.success(
                      `Synced ${totalMatched} listing${totalMatched === 1 ? "" : "s"}${legacyLine}${salesLine}.`,
                      { description, duration: 8000 },
                    );
                  }
                } catch {
                  /* surfaced by the hook */
                }
              }}
              disabled={syncEbay.isPending}
            >
              {syncEbay.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Sync from eBay
            </Button>
          )}
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

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList className="flex flex-wrap">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="gap-2">
              {t.label}
              <Badge
                variant={tab === t.id ? "default" : "secondary"}
                className="px-1.5 py-0 text-[10px] tabular-nums"
              >
                {tabCounts[t.id].toLocaleString()}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Sold-tab aggregate strip */}
      {isSold && soldAgg && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <AggCard label="Sold" value={soldAgg.count.toLocaleString()} />
          <AggCard label="Gross" value={fmtMoney(soldAgg.gross) || "$0.00"} />
          <AggCard
            label="Net profit"
            value={fmtMoney(soldAgg.net) || "$0.00"}
            tone={soldAgg.net < 0 ? "bad" : "good"}
          />
          <AggCard
            label="Avg margin"
            value={
              soldAgg.avgMargin == null
                ? "—"
                : `${soldAgg.avgMargin.toFixed(1)}%`
            }
          />
        </div>
      )}

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
        {isToList && (
          <Select
            value={sortPreset}
            onValueChange={(v) => setSortPreset(v as SortPreset)}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_PRESET_LABELS) as SortPreset[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {SORT_PRESET_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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
              <SelectTrigger className="h-9 w-44 text-xs">
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

      {/* Active filter chips — show what the advanced filter is doing
          so the user can spot stale conditions when stage tab + filter
          combine to show nothing. */}
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

      {/* Sold-tab filter chips */}
      {isSold && (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SOLD_FILTER_LABELS) as SoldFilter[]).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={soldFilter === f ? "default" : "outline"}
              onClick={() => setSoldFilter(f)}
            >
              {SOLD_FILTER_LABELS[f]}
            </Button>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {filtered.length} item{filtered.length === 1 ? "" : "s"}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              in {activeTab.label}
            </span>
          </CardTitle>
          <CardDescription>
            {isToList
              ? "Sorted by " +
                SORT_PRESET_LABELS[sortPreset].toLowerCase() +
                ". Select rows to bulk-create drafts."
              : isSold
                ? "Most recent sale first. Select rows to bulk mark shipped."
                : isDrafts
                  ? ebayConnection
                    ? "Oldest first. Select rows to bulk-publish to eBay."
                    : "Oldest first. Click a row to publish, or connect eBay for bulk-publish."
                  : activeTab.sortDir === "asc"
                    ? "Oldest first. Click a row for full details."
                    : "Most recent first. Click a row for full details."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading items…
            </div>
          ) : pageRows.length === 0 ? (
            <div className="space-y-3 py-12 text-center text-sm text-muted-foreground">
              <div>
                {tab === "to_list"
                  ? "Nothing ready to list."
                  : tab === "drafts"
                    ? "No drafts."
                    : tab === "active"
                      ? "No active listings."
                      : tab === "sold"
                        ? "No sold items match this filter."
                        : tab === "shipped"
                          ? "Nothing shipped."
                          : tab === "returned"
                            ? "No returns."
                            : "No items."}
              </div>
              {activeTab.emptyCta.to.startsWith("?") ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const url = new URL(
                      activeTab.emptyCta.to,
                      window.location.href,
                    );
                    const t = url.searchParams.get("tab") as TabId | null;
                    if (t) setTab(t);
                  }}
                >
                  {activeTab.emptyCta.label}
                </Button>
              ) : (
                <Button variant="outline" size="sm" asChild>
                  <Link to={activeTab.emptyCta.to}>
                    {activeTab.emptyCta.label}
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      {selectable && (
                        <TableHead className="w-8 px-2">
                          <input
                            type="checkbox"
                            checked={allOnPageSelected}
                            onChange={toggleSelectAll}
                            className="h-3.5 w-3.5 cursor-pointer"
                            aria-label="Select all on page"
                          />
                        </TableHead>
                      )}
                      <TableHead className="w-10" />
                      <TableHead className="min-w-[220px]">Title</TableHead>
                      <TableHead className="w-24">
                        <button
                          type="button"
                          onClick={() => toggleColumnSort("item_number")}
                          className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                        >
                          SKU
                          {columnSort?.field === "item_number" ? (
                            columnSort.dir === "asc" ? (
                              <ChevronUp className="h-3 w-3" />
                            ) : (
                              <ChevronDown className="h-3 w-3" />
                            )
                          ) : (
                            <ChevronsUpDown className="h-3 w-3 opacity-50" />
                          )}
                        </button>
                      </TableHead>
                      <TableHead className="w-32">Brand · Size</TableHead>
                      {isSold ? (
                        <>
                          <TableHead className="w-20 text-right">
                            Sold $
                          </TableHead>
                          <TableHead className="w-20 text-right">Net</TableHead>
                          <TableHead className="w-16 text-right">
                            Margin
                          </TableHead>
                          <TableHead className="w-24">Payout</TableHead>
                          <TableHead className="w-24">Ship by</TableHead>
                          <TableHead className="w-10">Buyer</TableHead>
                        </>
                      ) : isToList ? (
                        <>
                          <TableHead className="w-20 text-right">
                            Cost
                          </TableHead>
                          <TableHead className="w-20 text-right">
                            Target / List
                          </TableHead>
                          <TableHead className="w-20 text-right">
                            Score
                          </TableHead>
                        </>
                      ) : isActive ? (
                        <>
                          <TableHead className="w-24 text-right">
                            <SortHeader
                              field="list_price"
                              align="right"
                              columnSort={columnSort}
                              onToggle={toggleColumnSort}
                            >
                              Price
                            </SortHeader>
                          </TableHead>
                          <TableHead className="w-16 text-right">
                            <SortHeader
                              field="listing_views"
                              align="right"
                              columnSort={columnSort}
                              onToggle={toggleColumnSort}
                            >
                              Views
                            </SortHeader>
                          </TableHead>
                          <TableHead className="w-16 text-right">
                            <SortHeader
                              field="listing_watchers"
                              align="right"
                              columnSort={columnSort}
                              onToggle={toggleColumnSort}
                            >
                              Watchers
                            </SortHeader>
                          </TableHead>
                          <TableHead className="w-20 text-right">
                            <SortHeader
                              field="list_date"
                              align="right"
                              columnSort={columnSort}
                              onToggle={toggleColumnSort}
                            >
                              Days listed
                            </SortHeader>
                          </TableHead>
                        </>
                      ) : (
                        <>
                          <TableHead className="w-20 text-right">
                            Cost
                          </TableHead>
                          <TableHead className="w-20 text-right">
                            Target / List
                          </TableHead>
                          <TableHead className="w-20 text-right">
                            Sale
                          </TableHead>
                          <TableHead className="w-20 text-right">Net</TableHead>
                        </>
                      )}
                      <TableHead className="w-24">Status</TableHead>
                      {!isSold && !isActive && (
                        <TableHead className="w-16 text-right">Age</TableHead>
                      )}
                      {isActive && (
                        <TableHead className="w-32 text-right">
                          Actions
                        </TableHead>
                      )}
                      {tab === "drafts" && (
                        <TableHead className="w-32 text-right" />
                      )}
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((it) => {
                      const age = daysSince(it.updated_at);
                      const aging = age != null && age >= 14;
                      const score = scoreById.get(it.id) ?? 0;
                      const isSel = selected.has(it.id);
                      const pay = payoutState(it);
                      const ship = shipByInfo(it);
                      const m = marginPct(it);
                      const repeat =
                        it.buyer_id != null &&
                        (buyerCounts.get(it.buyer_id) ?? 0) > 1;
                      return (
                        <TableRow
                          key={it.id}
                          className={cn(
                            "cursor-pointer hover:bg-muted/30",
                            isSel && "bg-brand-navy/5",
                          )}
                          onClick={() => setDetailItem(it)}
                        >
                          {selectable && (
                            <TableCell
                              className="px-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={isSel}
                                onChange={() => toggleSelected(it.id)}
                                className="h-3.5 w-3.5 cursor-pointer"
                                aria-label="Select row"
                              />
                            </TableCell>
                          )}
                          <TableCell
                            className="px-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => setDetailItem(it)}
                              aria-label="Open full editor"
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                          </TableCell>
                          <TableCell className="max-w-[280px] truncate font-medium">
                            {it.item_title}
                          </TableCell>
                          <TableCell className="max-w-[120px] truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                            {it.item_number ?? ""}
                          </TableCell>
                          <TableCell className="max-w-[140px] truncate text-muted-foreground">
                            {[it.brand, it.size].filter(Boolean).join(" · ")}
                          </TableCell>
                          {isSold ? (
                            <>
                              <TableCell className="text-right tabular-nums">
                                {fmtMoney(it.sale_price)}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "text-right tabular-nums",
                                  it.net_profit != null &&
                                    it.net_profit < 0 &&
                                    "text-destructive",
                                )}
                              >
                                {fmtMoney(it.net_profit)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {m == null ? "" : `${m.toFixed(0)}%`}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={
                                    pay === "cleared"
                                      ? "default"
                                      : pay === "discrepancy"
                                        ? "destructive"
                                        : "secondary"
                                  }
                                  className="text-[10px]"
                                >
                                  {pay}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {ship.tone !== "none" && (
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1 text-[10px] font-medium",
                                      ship.tone === "red" &&
                                        "text-destructive",
                                      ship.tone === "amber" &&
                                        "text-amber-600 dark:text-amber-400",
                                      ship.tone === "green" &&
                                        "text-emerald-600 dark:text-emerald-400",
                                    )}
                                  >
                                    <Truck className="h-3 w-3" />
                                    {ship.label}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {repeat && (
                                  <span
                                    title="Repeat buyer"
                                    className="text-amber-500"
                                  >
                                    <Star className="h-3.5 w-3.5 fill-current" />
                                  </span>
                                )}
                              </TableCell>
                            </>
                          ) : isToList ? (
                            <>
                              <TableCell className="text-right tabular-nums">
                                {fmtMoney(it.purchase_price)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {fmtMoney(it.target_price ?? it.list_price)}
                              </TableCell>
                              <TableCell className="text-right">
                                <span
                                  className={cn(
                                    "font-mono font-semibold tabular-nums",
                                    scoreColor(score),
                                  )}
                                >
                                  {score}
                                </span>
                              </TableCell>
                            </>
                          ) : isActive ? (
                            <>
                              <TableCell
                                className="text-right tabular-nums"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <InlineCell
                                  value={it.list_price}
                                  type="number"
                                  align="right"
                                  onChange={(v) => updateListingPrice(it, v)}
                                />
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {it.listing_views ?? "—"}
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {it.listing_watchers ?? "—"}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {daysSince(it.list_date) ?? "—"}
                              </TableCell>
                            </>
                          ) : (
                            <>
                              <TableCell className="text-right tabular-nums">
                                {fmtMoney(it.purchase_price)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {fmtMoney(it.target_price ?? it.list_price)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {fmtMoney(it.sale_price)}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "text-right tabular-nums",
                                  it.net_profit != null &&
                                    it.net_profit < 0 &&
                                    "text-destructive",
                                )}
                              >
                                {fmtMoney(it.net_profit)}
                              </TableCell>
                            </>
                          )}
                          <TableCell>
                            <Badge
                              variant={
                                STATUS_BADGE_VARIANT[it.status] ?? "secondary"
                              }
                              className="text-[10px]"
                            >
                              {ITEM_STATUS_LABELS[it.status]}
                            </Badge>
                          </TableCell>
                          {!isSold && !isActive && (
                            <TableCell className="text-right">
                              {age != null && (
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1 tabular-nums",
                                    aging
                                      ? "font-medium text-destructive"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {aging ? (
                                    <AlertCircle className="h-3 w-3" />
                                  ) : (
                                    <Clock className="h-3 w-3" />
                                  )}
                                  {age}d
                                </span>
                              )}
                            </TableCell>
                          )}
                          {isActive && (
                            <TableCell
                              className="text-right"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="flex items-center justify-end gap-1">
                                {ebayConnection && it.listing_id && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    onClick={() => setReviseItem(it)}
                                    aria-label="Edit listing on eBay"
                                    title="Edit title/description/price on eBay"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[10px]"
                                  onClick={() => setRecordSaleItem(it)}
                                >
                                  Sold
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-destructive"
                                  onClick={() => setEndTarget(it)}
                                  aria-label="End listing early"
                                  title="End listing early"
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          )}
                          {tab === "drafts" && (
                            <TableCell
                              className="text-right"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="flex items-center justify-end gap-1">
                                {(() => {
                                  const isRelist = it.listing_status === "ended";
                                  if (ebayConnection) {
                                    return (
                                      <>
                                        <Button
                                          size="sm"
                                          className="h-6 px-2 text-[10px]"
                                          onClick={() => setPublishItem(it)}
                                          title={
                                            isRelist
                                              ? "Republish to eBay (same SKU, new listing)"
                                              : undefined
                                          }
                                        >
                                          {isRelist ? (
                                            <RotateCcw className="mr-1 h-3 w-3" />
                                          ) : (
                                            <Rocket className="mr-1 h-3 w-3" />
                                          )}
                                          {isRelist ? "Relist" : "Publish"}
                                        </Button>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-6 px-2 text-[10px]"
                                          onClick={() => setMarkListedItem(it)}
                                          title="Skip eBay API — just record that it's live"
                                        >
                                          Mark
                                        </Button>
                                      </>
                                    );
                                  }
                                  return (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-6 px-2 text-[10px]"
                                      onClick={() => setMarkListedItem(it)}
                                    >
                                      {isRelist ? "Relist" : "List it"}
                                    </Button>
                                  );
                                })()}
                              </div>
                            </TableCell>
                          )}
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            {it.link && (
                              <a
                                href={it.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex text-brand-red"
                                aria-label="Open listing"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

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
                  {pageStart + 1}–{pageStart + pageRows.length} of{" "}
                  {filtered.length}
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

      {selectable && selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="text-sm font-semibold text-brand-navy">
              {selected.size} selected
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setSelected(new Set())}
                disabled={busy}
              >
                Clear
              </Button>
              {isToList ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setAiEnrichOpen(true)}
                    disabled={busy}
                  >
                    <Sparkles className="mr-2 h-4 w-4" />
                    AI enrich
                  </Button>
                  <Button onClick={bulkCreateDrafts} disabled={busy}>
                    {busy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <FileText className="mr-2 h-4 w-4" />
                    )}
                    Create {selected.size} draft
                    {selected.size === 1 ? "" : "s"}
                  </Button>
                </>
              ) : isActive ? (
                <>
                  <Select value={bulkDropPct} onValueChange={setBulkDropPct}>
                    <SelectTrigger className="h-9 w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["5", "10", "15", "20", "25"].map((p) => (
                        <SelectItem key={p} value={p}>
                          −{p}%
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    onClick={bulkPriceDrop}
                    disabled={busy}
                  >
                    {busy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <TrendingDown className="mr-2 h-4 w-4" />
                    )}
                    Drop price
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={bulkEndListings}
                    disabled={busy}
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    End {selected.size}
                  </Button>
                </>
              ) : isDrafts ? (
                ebayConnection ? (
                  <Button onClick={bulkPublishToEbay} disabled={busy}>
                    {busy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Rocket className="mr-2 h-4 w-4" />
                    )}
                    {bulkPublishProgress
                      ? `Publishing ${bulkPublishProgress.done}/${bulkPublishProgress.total}…`
                      : `Publish ${selected.size} to eBay`}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Connect eBay to bulk-publish
                  </span>
                )
              ) : (
                <Button onClick={bulkMarkShipped} disabled={busy}>
                  {busy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Truck className="mr-2 h-4 w-4" />
                  )}
                  Mark {selected.size} shipped
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        open={!!endTarget}
        onOpenChange={(o) => !o && setEndTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this listing early?</AlertDialogTitle>
            <AlertDialogDescription>
              "{endTarget?.item_title}" will be withdrawn from eBay (when
              connected) and moved back to Drafts so you can relist it.
              Listings without an eBay offer id end locally only.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (endTarget) void endListing(endTarget);
                setEndTarget(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              End listing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ItemDetailDialog item={detailItem} onClose={() => setDetailItem(null)} />

      <MarkListedDialog
        item={markListedItem}
        onClose={() => setMarkListedItem(null)}
      />

      {publishItem && (
        <PublishToEbayDialog
          open={!!publishItem}
          onOpenChange={(o) => !o && setPublishItem(null)}
          itemId={publishItem.id}
        />
      )}

      <ReviseListingDialog
        item={reviseItem}
        onClose={() => setReviseItem(null)}
      />
      <RecordSaleDialog
        item={recordSaleItem}
        onClose={() => setRecordSaleItem(null)}
      />

      <SaveViewDialog
        open={saveViewOpen}
        onOpenChange={setSaveViewOpen}
        query={filterQuery}
      />

      <BulkAiEnrichDialog
        open={aiEnrichOpen}
        onOpenChange={setAiEnrichOpen}
        itemIds={Array.from(selected)}
        onReviewItem={(itemId) => {
          const it = items.find((i) => i.id === itemId);
          if (it) setDetailItem(it);
          setAiEnrichOpen(false);
        }}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ["items_full"] });
          setSelected(new Set());
        }}
      />
    </div>
  );
}

function SortHeader({
  field,
  children,
  align = "left",
  columnSort,
  onToggle,
}: {
  field: keyof ItemFullRow;
  children: ReactNode;
  align?: "left" | "right";
  columnSort: { field: keyof ItemFullRow; dir: "asc" | "desc" } | null;
  onToggle: (field: keyof ItemFullRow) => void;
}) {
  const isActive = columnSort?.field === field;
  return (
    <button
      type="button"
      onClick={() => onToggle(field)}
      className={cn(
        "inline-flex items-center gap-1 font-medium hover:text-foreground",
        align === "right" && "ml-auto",
      )}
    >
      {children}
      {isActive ? (
        columnSort!.dir === "asc" ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-50" />
      )}
    </button>
  );
}

function AggCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-xl font-bold tabular-nums",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {value}
      </div>
    </div>
  );
}
