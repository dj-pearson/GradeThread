import { useMemo, useRef, useState, useEffect, type ReactNode } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  AlertTriangle,
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
  Tag,
  SlidersHorizontal,
  CheckCircle2,
  Archive,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TableLoadingSkeleton } from "@/components/ui/skeletons";
import { ItemCardList } from "@/components/flipdesk/item-card-list";
import { ItemQuickEditSheet } from "@/components/flipdesk/item-quick-edit-sheet";
import { PendingDelistBanner } from "@/components/flipdesk/pending-delist-banner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/ui/empty-state";
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
import { ItemDetailDialog } from "@/components/flipdesk/item-detail-dialog";
import { InlineCell } from "@/components/flipdesk/inline-cell";
import { InlineStatusSelect } from "@/components/flipdesk/inline-status-select";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useUrlParamState } from "@/hooks/use-url-param-state";
import { useInventorySelection } from "@/stores/inventory-selection";
import { useInventoryStatusCounts } from "@/hooks/use-inventory-status-counts";
import { MarkListedDialog } from "@/components/flipdesk/mark-listed-dialog";
import { PublishToEbayDialog } from "@/components/flipdesk/publish-to-ebay-dialog";
import { RecordSaleDialog } from "@/components/flipdesk/record-sale-dialog";
import { ShipOrderDialog } from "@/components/flipdesk/ship-order-dialog";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
import { BulkAiEnrichDialog } from "@/components/flipdesk/bulk-ai-enrich-dialog";
import { BulkRepriceDialog } from "@/components/flipdesk/bulk-reprice-dialog";
import { BulkEditDialog } from "@/components/flipdesk/bulk-edit-dialog";
import { PrepareShipmentDialog } from "@/components/flipdesk/prepare-shipment-dialog";
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
import { type TabId, statusParamToTab } from "@/pages/flipdesk/inventory-tabs";
import {
  useEbayConnection,
  useEbayEndListing,
  useEbayUpdateListingPrice,
  usePublishToEbay,
  useSyncEbayListings,
} from "@/hooks/use-ebay";
import { scoreListability, maxCompPrice } from "@/lib/listability";
import {
  MARKETPLACE_LABELS,
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { itemPhotoThumb } from "@/lib/images";
import type {
  ItemFullRow,
  ItemStatus,
  ListingInsert,
  ListingPlatform,
} from "@/types/database";

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
  // US-1429: `grading` (mid-grade) is a pre-listed prep stage too — include it
  // so an item being graded isn't stranded out of To List (and so an Overview
  // "?status=grading" deep-link lands on a tab that actually shows it).
  "grading",
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
    // US-1483: exclude archived items so archived inventory isn't permanently
    // mixed into the active list — they have their own Archived tab.
    matches: (it) => it.status !== "archived",
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
    // US-1451: a refunded/cancelled sale is no longer revenue — exclude it from
    // the Sold view + its aggregates even if the item's status restore lagged
    // (the edge return/cancel flow moves the item to 'returned' too).
    matches: (it) =>
      it.status === "sold" &&
      it.sale_status !== "refunded" &&
      it.sale_status !== "cancelled",
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
  {
    // US-1483: dedicated home for archived items (previously only visible mixed
    // into All). Personal keeping/wearing items still live in All.
    id: "archived",
    label: "Archived",
    matches: (it) => it.status === "archived",
    sortKey: "updated_at",
    sortDir: "desc",
    emptyCta: { label: "View all items", to: "?tab=all" },
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
// US-733: below this row count the desktop table renders unchanged; above it,
// rows are virtualized. Kept comfortably above the 50-row min page size so the
// smallest page never virtualizes.
const VIRTUALIZE_ROW_THRESHOLD = 60;

// US-404: explicit projection instead of `select("*")` on the wide items_full
// view. We drop the columns this triage surface never reads in bulk — the two
// per-row photo correlated-subqueries (photo_count, has_required_photos) and
// the AI-provenance fields (ai_field_sources, ai_enriched_at) — which lets
// Postgres prune those subqueries from the plan. The detail canvas lazy-loads
// those four for the single open item (see item-canvas.tsx). comps/measurements
// stay: listability scoring + the editor need them across the loaded set.
const LISTINGS_COLUMNS = [
  "id",
  "user_id",
  "item_number",
  "container",
  "item_title",
  "item_description",
  "brand",
  "style",
  "size",
  "notes",
  "comps",
  "category",
  "source_name",
  "source_id",
  "sourced_by",
  "purchase_date",
  "purchase_price",
  "listed",
  "list_date",
  "link",
  "list_price",
  "sale_date",
  "sale_price",
  "fees",
  "tax",
  "shipping_cost",
  "net_profit",
  "payout",
  "status",
  "days_to_sell",
  "tracking",
  "target_price",
  "grade_value",
  "grade_label",
  "certificate_url",
  "measurements",
  "location_bin",
  // US-1051: color + marketplace drive the advanced filter's new facets.
  "color",
  "listing_platform",
  "created_at",
  "updated_at",
  "buyer_id",
  "sold_at_raw",
  "payout_reference",
  "listing_status",
  "listing_id",
  "listing_watchers",
  "listing_views",
  "sale_status",
  "sale_cancelled_at",
  // US-960: Shipped-tab fulfillment (carrier + shipped/delivered timestamps).
  "carrier",
  "shipped_at",
  "delivered_at",
  // US-1569 (00349): draft-review fields for the Drafts tab.
  "listing_needs_review",
  "listing_reviewed_at",
  "listing_title",
].join(",");

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


function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 45) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

// One chip in the Platforms column (US-149) — a listings row this item has
// on a marketplace, cross-listing siblings included.
interface PlatformChip {
  id: string;
  platform: ListingPlatform;
  status: string;
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
  // US-1429: an explicit `?tab=` wins; otherwise honor a `?status=` deep-link
  // from Overview/Kanban by mapping it onto the matching tab; else default.
  const tabParam = searchParams.get("tab") as TabId | null;
  const initialTab: TabId =
    tabParam && TABS.some((t) => t.id === tabParam)
      ? tabParam
      : statusParamToTab(searchParams.get("status")) ?? "to_list";
  const [tab, setTab] = useState<TabId>(initialTab);
  // US-958: search lives in the URL (`?q=`) so it survives switching between
  // the unified Inventory view modes (table/grid/kanban).
  const [search, setSearch] = useUrlParamState("q", "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(100);
  const navigate = useNavigate();
  const [detailItem, setDetailItem] = useState<ItemFullRow | null>(null);
  // US-961: mobile per-card quick-edit drawer + the mobile filters sheet.
  const [quickEditItem, setQuickEditItem] = useState<ItemFullRow | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // US-958: sort preset lives in the URL (`?sort=`) so it persists across view
  // mode switches. Guard against a hand-edited/unknown value.
  const [sortParam, setSortParam] = useUrlParamState("sort", "listability");
  const sortPreset: SortPreset =
    sortParam in SORT_PRESET_LABELS
      ? (sortParam as SortPreset)
      : "listability";
  const setSortPreset = (v: SortPreset) => setSortParam(v);
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
  // US-958: selection lives in a shared store so it carries across a view-mode
  // switch (table ↔ kanban) without being dropped on unmount.
  const selected = useInventorySelection((s) => s.selected);
  const setSelected = useInventorySelection((s) => s.setSelected);
  const [busy, setBusy] = useState(false);
  const [endTarget, setEndTarget] = useState<ItemFullRow | null>(null);
  const [bulkDropPct, setBulkDropPct] = useState<string>("10");
  const [markListedItem, setMarkListedItem] = useState<ItemFullRow | null>(
    null,
  );
  const [publishItem, setPublishItem] = useState<ItemFullRow | null>(null);
  const [shipItem, setShipItem] = useState<ItemFullRow | null>(null);
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
  // US-962: bulk match-to-comp reprice of the selected active listings.
  const [repriceOpen, setRepriceOpen] = useState(false);
  // US-1292: bulk-edit shared fields (price/condition/policy) across selected
  // live listings via marketplace adapters.
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  // US-960: bulk "Prepare shipment" — fill carrier + tracking across the
  // selected sold items and advance them to shipped.
  const [prepareShipOpen, setPrepareShipOpen] = useState(false);
  // US-1459: bulk "Set status…" — set an arbitrary status (incl. Archive) across
  // the selected items, on any tab. Allows backward + off-pipeline transitions;
  // the dialog's Apply is the confirm, with an extra caution for archive.
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [bulkStatusValue, setBulkStatusValue] = useState<ItemStatus | "">("");

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
    // US-1489: only the state setters are omitted (stable); the effect re-runs
    // on its real inputs (savedViews, searchParams). No stale closure.
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
    // US-1489: intentionally keyed on filterQuery ONLY — this effect WRITES
    // searchParams, so including it would loop. The write is guarded by the
    // toString() compare, so a stale searchParams snapshot can't cause churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery]);

  const isToList = tab === "to_list";
  const isSold = tab === "sold";
  const isActive = tab === "active";
  const isDrafts = tab === "drafts";
  const isShipped = tab === "shipped";
  const selectable = isToList || isSold || isActive || isDrafts;

  // Power-user shortcut: 'a' toggles select-all on the current page (only on
  // tabs that support selection). Plain 'a' (no Ctrl/Cmd) so it never collides
  // with the browser's select-all; the hook ignores it while typing in a field.
  useKeyboardShortcuts([
    {
      key: "a",
      handler: () => {
        if (selectable) toggleSelectAll();
      },
    },
  ]);

  // US-958: the selection store now survives this component unmounting (a view
  // mode switch), so clearing it on every mount would wipe a selection carried
  // over from the kanban. Skip the clear on the first run; only clear when the
  // tab genuinely changes.
  const tabMountedRef = useRef(false);
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (tab === "to_list") next.delete("tab");
    else next.set("tab", tab);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    setPage(1);
    if (tabMountedRef.current) setSelected(new Set());
    else tabMountedRef.current = true;
    // US-1489: keyed on `tab` only — the effect writes searchParams (a
    // searchParams dep would loop) and the rest are stable setters/refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    setPage(1);
  }, [search, pageSize, soldFilter]);

  // US-419: keyed under a DISTINCT "listings" suffix — NOT the bare
  // ["items_full", user.id] the full-row consumers (pipeline/overview/prep/etc.,
  // now the shared useItemsFull hook) use. This query projects a narrower
  // LISTINGS_COLUMNS subset, so sharing the canonical key would let a
  // partial-column cache entry win and starve those consumers of fields like
  // photo_count/has_required_photos. The "items_full" prefix keeps it covered by
  // the existing invalidateQueries({ queryKey: ["items_full"] }) calls.
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["items_full", "listings", user?.id],
    enabled: !!user,
    // 15-min freshness — mutations invalidate items_full explicitly, so a
    // longer window only skips redundant passive refetches (US-735).
    staleTime: 15 * 60 * 1000,
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
        .select(LISTINGS_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // US-404: stage-tab counts come from a server-side grouped count (one row per
  // status) rather than from the loaded rows. US-958: extracted into the shared
  // useInventoryStatusCounts hook so the table tabs and the kanban column badges
  // read from one cached query (keyed under the items_full prefix so the
  // existing items_full invalidations refresh it after status changes) instead
  // of each view recomputing the totals.
  const { data: statusCounts } = useInventoryStatusCounts();

  // US-149: which marketplaces each item is listed on (draft/active/sold rows
  // across the cross-listing group) — drives the Platforms column chips.
  const { data: platformsByItem } = useQuery({
    queryKey: ["item_listing_platforms", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, PlatformChip[]>> => {
      const { data, error } = await supabase
        .from("listings")
        .select("id, inventory_item_id, platform, listing_status")
        .in("listing_status", ["draft", "active", "sold"]);
      if (error) throw error;
      const map = new Map<string, PlatformChip[]>();
      for (const row of (data ?? []) as Array<{
        id: string;
        inventory_item_id: string;
        platform: ListingPlatform;
        listing_status: string;
      }>) {
        const arr = map.get(row.inventory_item_id) ?? [];
        arr.push({
          id: row.id,
          platform: row.platform,
          status: row.listing_status,
        });
        map.set(row.inventory_item_id, arr);
      }
      return map;
    },
  });

  // Per-item "needs attention" reason for eBay listings the sync (or an end)
  // moved back to Drafts because eBay no longer shows them active — ended, sold
  // out, or removed for a policy issue. The edge stores the reason in
  // listings.publish_error; we surface it as a warning on the Drafts row so the
  // seller knows why it reappeared and can review + relist. Lightweight direct
  // read (RLS-scoped) rather than widening the items_full view.
  const { data: publishIssuesByItem } = useQuery({
    queryKey: ["items_full", "listings", "publish_issues", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, string>> => {
      const { data, error } = await supabase
        .from("listings")
        .select("inventory_item_id, publish_error")
        .eq("platform", "ebay")
        .not("publish_error", "is", null);
      if (error) throw error;
      const map = new Map<string, string>();
      for (const row of (data ?? []) as Array<{
        inventory_item_id: string | null;
        publish_error: string | null;
      }>) {
        if (row.inventory_item_id && row.publish_error) {
          map.set(row.inventory_item_id, row.publish_error);
        }
      }
      return map;
    },
  });

  // Cover photo per item for the row thumbnail (parity with iOS, which shows the
  // main photo in the inventory grid). The cover = the LOWEST sort_order photo
  // per item (same rule as iOS SyncEngine.primaryPhotos); the URL prefers the
  // generated thumbnail via itemPhotoThumb(). RLS on item_photos is owner-scoped
  // through inventory_items, so one unfiltered read returns only this user's
  // photos — no giant id-list needed. Ordered ascending, first row per item wins.
  const { data: coverByItem } = useQuery({
    queryKey: ["items_full", "listings", "covers", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<
      Map<string, { thumbnail_url: string | null; photo_url: string | null }>
    > => {
      const { data, error } = await supabase
        .from("item_photos")
        .select("inventory_item_id, thumbnail_url, photo_url, sort_order")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      const map = new Map<
        string,
        { thumbnail_url: string | null; photo_url: string | null }
      >();
      for (const row of (data ?? []) as Array<{
        inventory_item_id: string | null;
        thumbnail_url: string | null;
        photo_url: string | null;
      }>) {
        // First (lowest sort_order) row per item is the cover.
        if (row.inventory_item_id && !map.has(row.inventory_item_id)) {
          map.set(row.inventory_item_id, {
            thumbnail_url: row.thumbnail_url,
            photo_url: row.photo_url,
          });
        }
      }
      return map;
    },
  });

  // US-151: per-item analytics metrics (impressions / CTR) for the Active tab.
  // Views/watchers already come through items_full; impressions + CTR live only
  // on the new listings columns, so pull them in a lightweight map rather than
  // widening the items_full view.
  const { data: metricsByItem } = useQuery({
    queryKey: ["item_listing_metrics", user?.id],
    enabled: !!user && isActive,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Map<string, { impressions: number; ctr: number | null }>> => {
      const { data, error } = await supabase
        .from("listings")
        .select("inventory_item_id, impressions_7d, click_through_rate")
        .eq("platform", "ebay")
        .eq("listing_status", "active");
      if (error) throw error;
      const map = new Map<string, { impressions: number; ctr: number | null }>();
      for (const row of (data ?? []) as Array<{
        inventory_item_id: string;
        impressions_7d: number | null;
        click_through_rate: number | null;
      }>) {
        map.set(row.inventory_item_id, {
          impressions: row.impressions_7d ?? 0,
          ctr: row.click_through_rate,
        });
      }
      return map;
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
      archived: 0,
    };
    // Prefer the server-side grouped count (decoupled from the loaded rows);
    // fall back to counting the loaded set if the RPC hasn't resolved yet.
    if (statusCounts && Object.keys(statusCounts).length > 0) {
      let all = 0;
      for (const [st, n] of Object.entries(statusCounts)) {
        // US-1483: archived items are excluded from the All tab.
        if ((st as ItemStatus) !== "archived") all += n;
        if (TO_LIST_STATUSES.has(st as ItemStatus)) counts.to_list += n;
      }
      counts.all = all;
      counts.drafts = statusCounts.drafted ?? 0;
      counts.active = statusCounts.listed ?? 0;
      counts.sold = statusCounts.sold ?? 0;
      counts.shipped = statusCounts.shipped ?? 0;
      counts.returned = statusCounts.returned ?? 0;
      counts.archived = statusCounts.archived ?? 0;
      return counts;
    }
    for (const it of items) {
      for (const t of TABS) if (t.matches(it)) counts[t.id]++;
    }
    return counts;
  }, [items, statusCounts]);

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

  // US-733: virtualize the (desktop) listings table only once a page renders
  // more rows than the threshold. At or below it, the table renders exactly as
  // before (no scroll container, no spacer rows) so the common case is
  // byte-identical and carries zero regression risk; large pages (up to the
  // 200-row page-size cap) mount only the visible rows + overscan, keeping the
  // primary inventory surface smooth. Uses the table spacer-row technique so
  // the real <table> markup — sticky header, sortable columns, select-all —
  // is preserved. The hook is always created (Rules of Hooks); getVirtualItems
  // is only consumed when virtualizing.
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const virtualize = pageRows.length > VIRTUALIZE_ROW_THRESHOLD;
  const rowVirtualizer = useVirtualizer({
    count: pageRows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 40,
    overscan: 8,
  });
  const virtualItems = virtualize ? rowVirtualizer.getVirtualItems() : [];
  const vPadTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const vPadBottom =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() -
        (virtualItems[virtualItems.length - 1]?.end ?? 0)
      : 0;

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
          // US-1077: bulk-created draft is GradeThread-originated.
          listing_origin: "gradethread",
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

  // US-960: look up the item's most-recent sale id so the Shipped tab can write
  // fulfillment fields (tracking / delivered_at) to the right sale row. RLS on
  // `sales` scopes both the read and the write to the owner.
  async function latestSaleId(itemId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from("sales")
      .select("id")
      .eq("inventory_item_id", itemId)
      .order("sale_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  }

  // US-960: edit/add the tracking number on a shipped item straight from the
  // Shipped tab. Optimistic local write-through, then persists to the sale.
  async function updateTracking(it: ItemFullRow, raw: string) {
    const next = raw.trim();
    if ((it.tracking ?? "") === next) return;
    const prev = items;
    qc.setQueryData<ItemFullRow[]>(["items_full", user?.id], (old) =>
      (old ?? []).map((i) =>
        i.id === it.id ? { ...i, tracking: next || null } : i,
      ),
    );
    try {
      const saleId = await latestSaleId(it.id);
      if (!saleId) throw new Error("No sale record for this item.");
      const { error } = await supabase
        .from("sales")
        .update({ tracking_number: next || null } as never)
        .eq("id", saleId);
      if (error) throw error;
      toast.success("Tracking updated.");
    } catch (err) {
      qc.setQueryData(["items_full", user?.id], prev);
      toast.error(
        `Couldn't update tracking: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // US-960: one-click "Mark delivered" on the Shipped tab — stamps the sale's
  // delivered_at and moves the item to `completed` (terminal). Optimistic.
  async function markDelivered(it: ItemFullRow) {
    const now = new Date().toISOString();
    const prev = items;
    qc.setQueryData<ItemFullRow[]>(["items_full", user?.id], (old) =>
      (old ?? []).map((i) =>
        i.id === it.id ? { ...i, delivered_at: now, status: "completed" } : i,
      ),
    );
    try {
      const saleId = await latestSaleId(it.id);
      if (saleId) {
        const { error } = await supabase
          .from("sales")
          .update({ delivered_at: now } as never)
          .eq("id", saleId);
        if (error) throw error;
      }
      const { error: iErr } = await supabase
        .from("inventory_items")
        .update({ status: "completed" } as never)
        .eq("id", it.id);
      if (iErr) throw iErr;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Marked delivered.");
    } catch (err) {
      qc.setQueryData(["items_full", user?.id], prev);
      toast.error(
        `Couldn't mark delivered: ${
          err instanceof Error ? err.message : String(err)
        }`,
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
          toast.success("Price updated on eBay.");
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
      toast.success("Price updated.");
    } catch (err) {
      qc.setQueryData(["items_full", user?.id], prev);
      toast.error(
        `Price update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Generic inline edit of a single base inventory_items column, mirrored
  // optimistically into the items_full cache under its view alias and rolled
  // back on a server error (US-959). Writes hit the RLS-enforced client, so
  // they're tenant-scoped without an explicit user_id filter (same as every
  // other write on this page). NOT for list_price — that path syncs to eBay
  // via updateListingPrice.
  async function patchItemColumn(
    it: ItemFullRow,
    column: string,
    value: string | number | null,
    viewPatch: Partial<ItemFullRow>,
    label: string,
  ) {
    const prev = items;
    qc.setQueryData<ItemFullRow[]>(["items_full", user?.id], (old) =>
      (old ?? []).map((i) => (i.id === it.id ? { ...i, ...viewPatch } : i)),
    );
    try {
      const { error } = await supabase
        .from("inventory_items")
        .update({ [column]: value } as never)
        .eq("id", it.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(`${label} updated.`);
    } catch (err) {
      qc.setQueryData(["items_full", user?.id], prev);
      toast.error(
        `Couldn't update ${label.toLowerCase()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Inline status change. Honors the explicit pick (forward or back, incl.
  // side-track statuses) — same direct write the mobile quick-edit sheet uses.
  async function updateItemStatus(it: ItemFullRow, next: ItemStatus) {
    if (next === it.status) return;
    await patchItemColumn(it, "status", next, { status: next }, "Status");
  }

  // Inline numeric edit (cost → acquired_price, target → target_price). Empty
  // clears the field; otherwise must be a finite, non-negative number.
  async function updateItemMoney(
    it: ItemFullRow,
    raw: string,
    column: "acquired_price" | "target_price",
    viewKey: "purchase_price" | "target_price",
    label: string,
  ) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      toast.error(`Enter a valid ${label.toLowerCase()}.`);
      return;
    }
    await patchItemColumn(it, column, value, { [viewKey]: value }, label);
  }

  // Inline notes edit (condition_notes on the base table, aliased as `notes`).
  async function updateItemNotes(it: ItemFullRow, raw: string) {
    const trimmed = raw.trim();
    const value = trimmed === "" ? null : trimmed;
    await patchItemColumn(it, "condition_notes", value, { notes: value }, "Notes");
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

  // US-1459: apply an arbitrary status to every selected item. Backward and
  // off-pipeline (archive / keeping / wearing) transitions are allowed — this is
  // the deliberate cleanup path. 'grading' is intentionally not offered (it's
  // owned by the submission+charge flow, same rule the board enforces).
  async function bulkSetStatus(next: ItemStatus) {
    if (selected.size === 0) return;
    setBusy(true);
    const errors: { message: string }[] = [];
    let done = 0;
    for (const id of selected) {
      const it = items.find((i) => i.id === id);
      if (!it || it.status === next) continue;
      const { error } = await supabase
        .from("inventory_items")
        .update({ status: next } as never)
        .eq("id", it.id);
      if (error) errors.push({ message: error.message });
      else done++;
    }
    setBusy(false);
    setSelected(new Set());
    setBulkStatusOpen(false);
    setBulkStatusValue("");
    await qc.invalidateQueries({ queryKey: ["items_full"] });
    if (errors.length === 0) {
      toast.success(
        `Set ${done} item${done === 1 ? "" : "s"} to ${ITEM_STATUS_LABELS[next]}.`,
      );
    } else {
      toast.warning(
        `Updated ${done}, ${errors.length} failed. First: ${errors[0]?.message}`,
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

      {/* US-717: cross-listing auto-delist queue (extension marketplaces). */}
      <PendingDelistBanner />

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

      {/* Mobile: a compact full-width search + a Filters sheet. The desktop
          toolbar below is hidden under md. Search + advanced-filter + saved-view
          state are shared, so the sheet round-trips with the URL filter and the
          desktop surface (US-958 unified state). */}
      <div className="flex items-center gap-2 md:hidden">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, brand, SKU…"
            className="w-full pl-9"
          />
        </div>
        <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
          <SheetTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="relative shrink-0"
              aria-label="Filters"
            >
              <SlidersHorizontal className="h-4 w-4" />
              {filterQuery.rules.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-red px-1 text-[10px] font-semibold text-white">
                  {filterQuery.rules.length}
                </span>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
              <SheetDescription>
                Narrow the {activeTab.label} list.
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-4">
              {isToList && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Sort</span>
                  <Select
                    value={sortPreset}
                    onValueChange={(v) => setSortPreset(v as SortPreset)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SORT_PRESET_LABELS) as SortPreset[]).map(
                        (p) => (
                          <SelectItem key={p} value={p}>
                            {SORT_PRESET_LABELS[p]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Advanced filter</span>
                <div>
                  <FilterBuilder query={filterQuery} onChange={setFilterQuery} />
                </div>
              </div>
              {savedViews.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Saved views</span>
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
                    <SelectTrigger className="w-full text-xs">
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
                </div>
              )}
              {filterQuery.rules.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setSaveViewOpen(true)}
                >
                  Save view
                </Button>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <div className="hidden flex-wrap items-center gap-2 md:flex">
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
            className="text-xs text-brand-red-text hover:underline"
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
                ? "Most recent sale first. Select rows to prepare shipments."
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
            <TableLoadingSkeleton rows={10} columns={7} />
          ) : pageRows.length === 0 ? (
            <EmptyState
              icon={
                tab === "to_list"
                  ? Sparkles
                  : tab === "drafts"
                    ? FileText
                    : tab === "active"
                      ? Star
                      : tab === "sold"
                        ? TrendingDown
                        : tab === "shipped"
                          ? Truck
                          : tab === "returned"
                            ? RotateCcw
                            : Rocket
              }
              title={
                tab === "to_list"
                  ? "Nothing ready to list"
                  : tab === "drafts"
                    ? "No drafts yet"
                    : tab === "active"
                      ? "No active listings"
                      : tab === "sold"
                        ? "No sold items match this filter"
                        : tab === "shipped"
                          ? "Nothing shipped yet"
                          : tab === "returned"
                            ? "No returns"
                            : "No items yet"
              }
              description={
                tab === "to_list"
                  ? "Graded items ready to sell will land here. Add an item to get started."
                  : tab === "drafts"
                    ? "Drafts you've started but not yet published will appear here."
                    : tab === "active"
                      ? "Listings live on a marketplace will show here once you publish."
                      : tab === "sold"
                        ? "Sold items will appear here as orders come in."
                        : tab === "shipped"
                          ? "Items you've marked shipped will be tracked here."
                          : tab === "returned"
                            ? "Returned orders will be tracked here."
                            : "Add an item to start building your listing pipeline."
              }
              action={
                activeTab.emptyCta.to.startsWith("?")
                  ? {
                      label: activeTab.emptyCta.label,
                      onClick: () => {
                        const url = new URL(
                          activeTab.emptyCta.to,
                          window.location.href,
                        );
                        const t = url.searchParams.get(
                          "tab",
                        ) as TabId | null;
                        if (t) setTab(t);
                      },
                    }
                  : {
                      label: activeTab.emptyCta.label,
                      to: activeTab.emptyCta.to,
                    }
              }
            />
          ) : (
            <>
              {/* Mobile: card list (the wide table is unusable on a phone). */}
              <div className="md:hidden">
                {selectable && (
                  <label className="flex cursor-pointer items-center gap-2 border-b px-4 py-2">
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 cursor-pointer"
                      aria-label="Select all on page"
                    />
                    <span className="text-xs text-muted-foreground">
                      {selected.size > 0
                        ? `${selected.size} selected`
                        : "Select all on page"}
                    </span>
                  </label>
                )}
                <ItemCardList
                  items={pageRows}
                  onOpen={setDetailItem}
                  selectable={selectable}
                  selectedIds={selected}
                  onToggleSelect={toggleSelected}
                  onQuickEdit={setQuickEditItem}
                />
              </div>
              <div
                ref={tableScrollRef}
                className={cn(
                  "hidden overflow-x-auto md:block",
                  virtualize && "max-h-[70vh] overflow-y-auto",
                )}
              >
                <Table className="text-xs">
                  <TableHeader
                    className={cn(
                      virtualize &&
                        "sticky top-0 z-10 [&_th]:bg-background",
                    )}
                  >
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
                      <TableHead className="w-12 px-1" />
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
                          <TableHead className="w-16 text-right">Impr.</TableHead>
                          <TableHead className="w-16 text-right">CTR</TableHead>
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
                      ) : isShipped ? (
                        <>
                          <TableHead className="w-20 text-right">Net</TableHead>
                          <TableHead className="w-20">Carrier</TableHead>
                          <TableHead className="min-w-[150px]">
                            Tracking
                          </TableHead>
                          <TableHead className="w-36">Delivery</TableHead>
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
                      <TableHead className="min-w-[140px]">Notes</TableHead>
                      {(isDrafts || isActive) && (
                        <TableHead className="w-28">Platforms</TableHead>
                      )}
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
                    {virtualize && vPadTop > 0 && (
                      <tr aria-hidden="true" style={{ height: vPadTop }}>
                        <td />
                      </tr>
                    )}
                    {(virtualize
                      ? virtualItems.map((vi) => ({
                          it: pageRows[vi.index],
                          measureRef: rowVirtualizer.measureElement,
                          vIndex: vi.index,
                        }))
                      : pageRows.map((it) => ({
                          it,
                          measureRef: undefined,
                          vIndex: undefined,
                        }))
                    ).map(({ it, measureRef, vIndex }) => {
                      if (!it) return null;
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
                          ref={measureRef}
                          data-index={vIndex}
                          className={cn(
                            "cursor-pointer hover:bg-muted/30",
                            isSel && "bg-brand-navy/5",
                          )}
                          onClick={() =>
                            tab === "drafts" && it.listing_id
                              ? navigate(`/dashboard/flipdesk/items/${it.id}/draft`)
                              : setDetailItem(it)
                          }
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
                              onClick={() =>
                                tab === "drafts" && it.listing_id
                                  ? navigate(
                                      `/dashboard/flipdesk/items/${it.id}/draft`,
                                    )
                                  : setDetailItem(it)
                              }
                              aria-label="Open full editor"
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                          </TableCell>
                          <TableCell className="px-1">
                            {(() => {
                              const cover = coverByItem?.get(it.id);
                              return cover && itemPhotoThumb(cover) ? (
                                <img
                                  src={itemPhotoThumb(cover)}
                                  alt=""
                                  loading="lazy"
                                  className="h-10 w-10 shrink-0 rounded object-cover ring-1 ring-border"
                                />
                              ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                                  <FileText className="h-4 w-4" />
                                </div>
                              );
                            })()}
                          </TableCell>
                          <TableCell className="max-w-[280px] font-medium">
                            <div className="flex items-center gap-1.5">
                              {/* US-1569: a placeholder item title falls back
                                  to the draft's generated listing title. */}
                              <span className="truncate">
                                {/^item\s+\d+$/i.test(it.item_title ?? "") ||
                                /^untitled/i.test(it.item_title ?? "") ||
                                !(it.item_title ?? "").trim()
                                  ? (it.listing_title ?? it.item_title)
                                  : it.item_title}
                              </span>
                              {tab === "drafts" && it.listing_needs_review && (
                                <Badge
                                  variant="outline"
                                  className="shrink-0 border-amber-400 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-300"
                                  title="The AI flagged fields to double-check before publishing"
                                >
                                  Needs review
                                </Badge>
                              )}
                              {it.grade_value != null && (
                                <Badge
                                  variant="secondary"
                                  className="shrink-0 px-1.5 py-0 text-[10px]"
                                  title={
                                    it.grade_label
                                      ? `Graded ${it.grade_label}`
                                      : "GradeThread grade"
                                  }
                                >
                                  {Number(it.grade_value).toFixed(1)}
                                </Badge>
                              )}
                            </div>
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
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <div className="flex items-center gap-2">
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
                                  {ship.tone !== "green" && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-6 px-2 text-[10px]"
                                      onClick={() => setShipItem(it)}
                                      title="Mark shipped + push tracking to eBay"
                                    >
                                      Mark shipped
                                    </Button>
                                  )}
                                </div>
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
                              <TableCell
                                className="text-right tabular-nums"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <InlineCell
                                  value={it.purchase_price}
                                  type="number"
                                  align="right"
                                  onChange={(v) =>
                                    updateItemMoney(
                                      it,
                                      v,
                                      "acquired_price",
                                      "purchase_price",
                                      "Cost",
                                    )
                                  }
                                />
                              </TableCell>
                              <TableCell
                                className="text-right tabular-nums"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <InlineCell
                                  value={it.target_price}
                                  type="number"
                                  align="right"
                                  onChange={(v) =>
                                    updateItemMoney(
                                      it,
                                      v,
                                      "target_price",
                                      "target_price",
                                      "Target",
                                    )
                                  }
                                />
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
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {metricsByItem?.get(it.id)?.impressions?.toLocaleString() ?? "—"}
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {(() => {
                                  const ctr = metricsByItem?.get(it.id)?.ctr;
                                  return ctr == null ? "—" : `${(ctr * 100).toFixed(1)}%`;
                                })()}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {daysSince(it.list_date) ?? "—"}
                              </TableCell>
                            </>
                          ) : isShipped ? (
                            <>
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
                              <TableCell className="text-muted-foreground">
                                {it.carrier ?? "—"}
                              </TableCell>
                              <TableCell
                                className="font-mono text-[11px]"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <InlineCell
                                  value={it.tracking}
                                  type="text"
                                  placeholder="Add tracking"
                                  onChange={(v) => updateTracking(it, v)}
                                />
                              </TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                {it.delivered_at ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                    <CheckCircle2 className="h-3 w-3" />
                                    Delivered{" "}
                                    {new Date(
                                      it.delivered_at,
                                    ).toLocaleDateString()}
                                  </span>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={() => markDelivered(it)}
                                    title="Mark this order delivered"
                                  >
                                    Mark delivered
                                  </Button>
                                )}
                              </TableCell>
                            </>
                          ) : (
                            <>
                              <TableCell
                                className="text-right tabular-nums"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <InlineCell
                                  value={it.purchase_price}
                                  type="number"
                                  align="right"
                                  onChange={(v) =>
                                    updateItemMoney(
                                      it,
                                      v,
                                      "acquired_price",
                                      "purchase_price",
                                      "Cost",
                                    )
                                  }
                                />
                              </TableCell>
                              <TableCell
                                className="text-right tabular-nums"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <InlineCell
                                  value={it.target_price}
                                  type="number"
                                  align="right"
                                  onChange={(v) =>
                                    updateItemMoney(
                                      it,
                                      v,
                                      "target_price",
                                      "target_price",
                                      "Target",
                                    )
                                  }
                                />
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
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <InlineStatusSelect
                              value={it.status}
                              onChange={(next) => updateItemStatus(it, next)}
                            />
                          </TableCell>
                          <TableCell
                            className="text-muted-foreground"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <InlineCell
                              value={it.notes}
                              type="text"
                              placeholder="Add notes"
                              onChange={(v) => updateItemNotes(it, v)}
                            />
                          </TableCell>
                          {(isDrafts || isActive) && (
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {(platformsByItem?.get(it.id) ?? []).map(
                                  (l) => (
                                    <span
                                      key={l.id}
                                      title={`${MARKETPLACE_LABELS[l.platform]} — ${l.status}`}
                                      className={cn(
                                        "rounded border px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                                        l.status === "active"
                                          ? "border-emerald-400/60 text-emerald-600 dark:text-emerald-400"
                                          : l.status === "sold"
                                            ? "border-brand-navy/40 text-brand-navy dark:text-foreground"
                                            : "text-muted-foreground",
                                      )}
                                    >
                                      {MARKETPLACE_LABELS[l.platform]}
                                    </span>
                                  ),
                                )}
                              </div>
                            </TableCell>
                          )}
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
                                {ebayConnection && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    onClick={() => setPublishItem(it)}
                                    aria-label="Relist as a new listing"
                                    title="End this listing and relist as a new one"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
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
                                  const issue = publishIssuesByItem?.get(it.id);
                                  return issue ? (
                                    <span
                                      title={issue}
                                      className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                                    >
                                      <AlertTriangle className="h-3 w-3" />
                                      eBay inactive — review &amp; relist
                                    </span>
                                  ) : null;
                                })()}
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
                                className="inline-flex text-brand-red-text"
                                aria-label="Open listing"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {virtualize && vPadBottom > 0 && (
                      <tr aria-hidden="true" style={{ height: vPadBottom }}>
                        <td />
                      </tr>
                    )}
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
            <div className="text-sm font-semibold text-brand-navy dark:text-foreground">
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
              {/* US-1459: universal bulk status setter — available on every tab
                  so terminal/dead items can be archived or re-staged in bulk. */}
              <Button
                variant="outline"
                onClick={() => {
                  setBulkStatusValue("");
                  setBulkStatusOpen(true);
                }}
                disabled={busy}
              >
                <Archive className="mr-2 h-4 w-4" />
                Set status…
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
                  {ebayConnection && (
                    <Button
                      variant="outline"
                      onClick={() => setRepriceOpen(true)}
                      disabled={busy}
                    >
                      <Tag className="mr-2 h-4 w-4" />
                      Reprice to comp
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => setBulkEditOpen(true)}
                    disabled={busy}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Bulk edit
                  </Button>
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
                <Button
                  onClick={() => setPrepareShipOpen(true)}
                  disabled={busy}
                >
                  <Truck className="mr-2 h-4 w-4" />
                  Prepare shipment
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* US-1459: bulk "Set status…" picker. The Apply button is the confirm;
          an extra caution shows when Archive (a destructive/off-pipeline move)
          is chosen. */}
      <AlertDialog
        open={bulkStatusOpen}
        onOpenChange={(o) => {
          if (!o) {
            setBulkStatusOpen(false);
            setBulkStatusValue("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Set status for {selected.size} item
              {selected.size === 1 ? "" : "s"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Move the selected items to any status. Backward and off-pipeline
              (archive / personal) moves are allowed — this bypasses the normal
              pipeline order, so double-check the choice.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Select
              value={bulkStatusValue}
              onValueChange={(v) => setBulkStatusValue(v as ItemStatus)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a status…" />
              </SelectTrigger>
              <SelectContent>
                {ITEM_STATUSES.filter((s) => s !== "grading").map((s) => (
                  <SelectItem key={s} value={s}>
                    {ITEM_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {bulkStatusValue === "archived" && (
              <p className="mt-2 text-xs text-muted-foreground">
                Archived items leave the active pipeline and the default views —
                find them again in the Archived tab.
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !bulkStatusValue}
              onClick={(e) => {
                // Keep the dialog open until the writes finish; bulkSetStatus
                // closes it on completion.
                e.preventDefault();
                if (bulkStatusValue) void bulkSetStatus(bulkStatusValue);
              }}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      <ItemQuickEditSheet
        item={quickEditItem}
        onClose={() => setQuickEditItem(null)}
      />

      <MarkListedDialog
        item={markListedItem}
        onClose={() => setMarkListedItem(null)}
      />

      {publishItem && (
        <PublishToEbayDialog
          open={!!publishItem}
          onOpenChange={(o) => !o && setPublishItem(null)}
          itemId={publishItem.id}
          // Relist when the item was previously listed: an ended draft, or a
          // still-live listing being replaced. A never-listed draft publishes
          // normally.
          relist={
            publishItem.listing_status === "ended" ||
            publishItem.listing_status === "active"
          }
          listingActive={publishItem.listing_status === "active"}
        />
      )}

      <RecordSaleDialog
        item={recordSaleItem}
        onClose={() => setRecordSaleItem(null)}
      />
      <ShipOrderDialog item={shipItem} onClose={() => setShipItem(null)} />

      <SaveViewDialog
        open={saveViewOpen}
        onOpenChange={setSaveViewOpen}
        query={filterQuery}
      />

      <BulkRepriceDialog
        open={repriceOpen}
        onOpenChange={setRepriceOpen}
        listingIds={Array.from(selected)
          .map((id) => items.find((i) => i.id === id)?.listing_id)
          .filter((v): v is string => !!v)}
        onApplied={() => {
          setSelected(new Set());
          void qc.invalidateQueries({ queryKey: ["items_full"] });
        }}
      />

      <BulkEditDialog
        open={bulkEditOpen}
        onOpenChange={setBulkEditOpen}
        listingIds={Array.from(selected)
          .map((id) => items.find((i) => i.id === id)?.listing_id)
          .filter((v): v is string => !!v)}
        onApplied={() => {
          setSelected(new Set());
          void qc.invalidateQueries({ queryKey: ["items_full"] });
        }}
      />

      <PrepareShipmentDialog
        open={prepareShipOpen}
        onOpenChange={setPrepareShipOpen}
        items={Array.from(selected)
          .map((id) => items.find((i) => i.id === id))
          .filter((v): v is ItemFullRow => !!v)}
        onApplied={() => setSelected(new Set())}
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
