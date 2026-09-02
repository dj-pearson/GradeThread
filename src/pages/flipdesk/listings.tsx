import { useMemo, useRef, useState, useEffect } from "react";
import { Link, useSearchParams, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Upload,
  FileText,
  Loader2,
  Megaphone,
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
  Tag,
  SlidersHorizontal,
  Archive,
  Trash2,
} from "lucide-react";
import { SearchInput } from "@/components/search-input";
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
import { PendingReviseBanner } from "@/components/flipdesk/pending-revise-banner";
import { useBulkRelist } from "@/hooks/use-relist-extension";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { showExampleAction } from "@/lib/show-example";
import { Button } from "@/components/ui/button";
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
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useUrlParamState, useUrlSearchInput } from "@/hooks/use-url-param-state";
import { useInventorySelection } from "@/stores/inventory-selection";
import { useInventoryStatusCounts } from "@/hooks/use-inventory-status-counts";
import { MarkListedDialog } from "@/components/flipdesk/mark-listed-dialog";
import { PublishToEbayDialog } from "@/components/flipdesk/publish-to-ebay-dialog";
import { RecordSaleDialog } from "@/components/flipdesk/record-sale-dialog";
import { ShipOrderDialog } from "@/components/flipdesk/ship-order-dialog";
import { InventoryViewSwitcher } from "@/components/flipdesk/inventory-view-switcher";
import { BulkAiEnrichDialog } from "@/components/flipdesk/bulk-ai-enrich-dialog";
import { BulkRepriceDialog } from "@/components/flipdesk/bulk-reprice-dialog";
import { BulkPromoteDialog } from "@/components/flipdesk/bulk-promote-dialog";
import { BulkEditDialog } from "@/components/flipdesk/bulk-edit-dialog";
import { PrepareShipmentDialog } from "@/components/flipdesk/prepare-shipment-dialog";
import { FilterBuilder } from "@/components/flipdesk/filter-builder";
import { SaveViewDialog } from "@/components/flipdesk/save-view-dialog";
import { useSavedViews } from "@/hooks/use-saved-views";
import {
  EMPTY_QUERY,
  encodeQuery,
  decodeQuery,
  describeRule,
  type FilterQuery,
} from "@/lib/item-filter";
// US-2174: gate the Active tab's backstop poll on tab visibility (US-576).
import { useDocumentVisible } from "@/hooks/use-document-visible";
// US-2170: the quality chip + its persisted-column mapping, shared with the
// AutoLister drafts cockpit so there is ONE scoring presentation, not two.
import {
  type TabId,
  statusParamToTab,
  // US-2547: the narrowing a folded stage deep-link needs.
  stageFilterStatusFromParam,
  // US-2178: the tab predicates and the two status sets now live in the sibling
  // module so they can be unit-tested without importing this whole page.
  TABS,
  TO_LIST_STATUSES,
} from "@/pages/flipdesk/inventory-tabs";
import { type SoldFilter } from "@/pages/flipdesk/listings-filter";
import {
  resolveSortOption,
  sortOptionsForTab,
  sortRequestFor,
  type ColumnSort,
  type SortOption,
  type SortOptionId,
} from "@/pages/flipdesk/inventory-sort";
import {
  initialInventoryTab,
  readLastInventoryTab,
  writeLastInventoryTab,
} from "@/pages/flipdesk/inventory-last-tab";
import {
  usePageRowDetails,
  type ListingPageResult,
} from "@/pages/flipdesk/listings-page-queries";
import { makeListingsActions } from "@/pages/flipdesk/listings-actions";
import { LISTINGS_COLUMN_LIST } from "@/pages/flipdesk/listings-columns";
import { ListingsTable } from "@/pages/flipdesk/listings-table";
import { fmtMoney } from "@/pages/flipdesk/listings-format";
import {
  useEbayConnection,
  usePublishToEbay,
  useSyncEbayListings,
} from "@/hooks/use-ebay";
// US-2162/US-2163/US-2166: price and end go through the PLATFORM-AGNOSTIC
// lifecycle, not the eBay-namespaced routes. The eBay hooks branched on whether
// an eBay connection existed rather than on the listing's own platform, so every
// non-eBay row fell into a local-only write that left the marketplace untouched.
import {
  useBulkEndListings,
  useBulkReviseListings,
  useBulkListingPrice,
  useEndListing,
  useUpdateListingPrice,
} from "@/hooks/use-listing-lifecycle";
import {
  deleteBlockListingUrl,
  type DeleteItemError,
  useDeleteItem,
} from "@/hooks/use-items-full";
import { scoreListability } from "@/lib/listability";
import {
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ItemFullRow, ItemStatus } from "@/types/database";
import { PageHelp } from "@/components/help/page-help";

/**
 * The per-tab sort menu, rendered once in the desktop toolbar and once in the
 * mobile Filters sheet. While a column header sort is active the menu shows a
 * placeholder rather than a stale pick, and picking anything hands control
 * back to the menu.
 */
function SortMenu({
  options,
  value,
  headerActive,
  onChange,
  className,
}: {
  options: SortOption[];
  value: SortOptionId;
  headerActive: boolean;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <Select value={headerActive ? "" : value} onValueChange={onChange}>
      <SelectTrigger aria-label="Sort listings by" className={className}>
        <SelectValue placeholder="Sorted by column" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const SOLD_FILTER_LABELS: Record<SoldFilter, string> = {
  all: "All",
  awaiting_payout: "Awaiting payout",
  discrepancy: "Discrepancy",
  d7: "Last 7 days",
  d30: "Last 30 days",
  ytd: "Year to date",
};

// Default eBay handling window for the ship-by countdown when no explicit
// handling time is stored on the listing.

const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
// US-733: below this row count the desktop table renders unchanged; above it,
// rows are virtualized. Kept comfortably above the 50-row min page size so the
// smallest page never virtualizes.
const VIRTUALIZE_ROW_THRESHOLD = 60;

/**
 * What `flipdesk_listing_page` returns (US-2168 AC3, migration 00515).
 *
 * `rows` is one page. The other three are the things this page needs that a
 * page cannot answer for itself, which is exactly why they travel with it:
 * `total` sizes the pager, `soldAgg` covers the whole FILTERED set, and
 * `buyerCounts` covers the whole ACCOUNT.
 */

export function FlipdeskListingsPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // US-1429: an explicit `?tab=` wins; otherwise honor a `?status=` deep-link
  // from Overview/Kanban by mapping it onto the matching tab; else default.
  // A bare URL opens the tab the seller was last on (inventory-last-tab.ts):
  // the sidebar entry and "Back to items" both arrive without a tab, and
  // landing on To List after every draft was the complaint that made it so.
  const [tab, setTab] = useState<TabId>(() =>
    initialInventoryTab(
      searchParams.get("tab"),
      statusParamToTab(searchParams.get("status")),
      readLastInventoryTab(),
    ),
  );
  // US-958: search lives in the URL (`?q=`) so it survives switching between
  // the unified Inventory view modes (table/grid/kanban).
  // `draft` drives the box (instant), `value` drives the query (on a pause).
  // Swapping the two reintroduces the dropped-characters bug — see the hook.
  const {
    value: search,
    draft: searchDraft,
    setDraft: setSearch,
  } = useUrlSearchInput("q", "");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(100);
  const navigate = useNavigate();
  const [detailItem, setDetailItem] = useState<ItemFullRow | null>(null);
  // US-961: mobile per-card quick-edit drawer + the mobile filters sheet.
  const [quickEditItem, setQuickEditItem] = useState<ItemFullRow | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // US-958: the sort lives in the URL (`?sort=`) so it persists across view
  // mode switches. The menu is per tab (inventory-sort.ts); a value the
  // current tab's menu lacks resolves to that tab's default.
  const [sortParam, setSortParam] = useUrlParamState("sort", "default");
  const sortOptions = sortOptionsForTab(tab);
  const sortOption = resolveSortOption(sortParam, tab);
  // A clicked column header overrides the menu until the third click clears
  // it, or a menu pick replaces it. Kept separate from the menu so the seller
  // can take control of one column without losing the stage tab they're in.
  const [headerSort, setHeaderSort] = useState<ColumnSort | null>(null);
  function toggleColumnSort(field: keyof ItemFullRow) {
    setHeaderSort((prev) =>
      prev && prev.field === field
        ? prev.dir === "asc"
          ? { field, dir: "desc" }
          : null // third click clears, revealing the menu's sort again
        : { field, dir: "asc" },
    );
  }
  function pickSort(id: string) {
    setHeaderSort(null);
    setSortParam(id);
  }
  // What the server is asked for: the header wins, then the menu's column,
  // then the tab's own order. `sortPreset` only matters on To List.
  const { preset: sortPreset, columnSort } = sortRequestFor(
    sortOption,
    headerSort,
  );
  const sortedByLabel = headerSort
    ? `${String(headerSort.field).replace(/_/g, " ")} ${headerSort.dir === "asc" ? "ascending" : "descending"}`
    : sortOption.label.toLowerCase();
  const [soldFilter, setSoldFilter] = useState<SoldFilter>("all");
  // US-958: selection lives in a shared store so it carries across a view-mode
  // switch (table ↔ kanban) without being dropped on unmount.
  const selected = useInventorySelection((s) => s.selected);
  const setSelected = useInventorySelection((s) => s.setSelected);
  const [busy, setBusy] = useState(false);
  const [endTarget, setEndTarget] = useState<ItemFullRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ItemFullRow | null>(null);
  const [bulkDropPct, setBulkDropPct] = useState<string>("10");
  // US-2163 (AC5): a markdown across a large selection is a long, expensive,
  // irreversible-feeling operation. `null` means idle; otherwise it reports how
  // far the chunked batch has got so the seller can see it moving and stop it.
  const [dropProgress, setDropProgress] = useState<
    { done: number; total: number } | null
  >(null);
  // A ref, not state: the cancel must be visible to the loop already running,
  // and a state update would not reach the closure mid-flight.
  const dropCancelled = useRef(false);
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
  const updatePrice = useUpdateListingPrice();
  const endListingApi = useEndListing();
  const bulkPrice = useBulkListingPrice();
  const bulkEnd = useBulkEndListings();
  // US-2404: bulk resubmit of the selected live eBay listings.
  const bulkRevise = useBulkReviseListings();
  // US-9203: relist a selection across eBay and the extension channels.
  const bulkRelistMut = useBulkRelist();
  const deleteItemApi = useDeleteItem();
  const publishApi = usePublishToEbay();
  const [bulkPublishProgress, setBulkPublishProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  // US-2404: live counter while a chunked bulk resubmit runs.
  const [bulkReviseProgress, setBulkReviseProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  // Bulk hard-delete of the selected items — a discoverable list-level delete
  // (the per-row trash button lives in the far-right actions column, easy to
  // miss). Confirm dialog + per-item progress, mirroring bulk publish.
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // Advanced filter — composes ON TOP of the stage tabs. Initialised from
  // the URL so saved-view links round-trip cleanly.
  const { data: savedViews = [] } = useSavedViews();
  const [filterQuery, setFilterQuery] = useState<FilterQuery>(() => {
    const f = searchParams.get("filter");
    const decoded = (f && decodeQuery(f)) || null;
    if (decoded) return decoded;
    // US-2547: Overview's pipeline tiles link `?status=<stage>`, and eight of
    // those stages share the To List tab. Seed the advanced filter so the tile's
    // count and the list it opens agree. It goes through the SAME filter the
    // seller can see and clear (the effect below writes it to `?filter=`), not
    // a hidden second predicate — an invisible filter is how a list starts
    // lying about what it contains.
    const stage = stageFilterStatusFromParam(searchParams.get("status"));
    if (stage) {
      return {
        combinator: "and",
        rules: [
          {
            id: Math.random().toString(36).slice(2),
            field: "status",
            op: "eq",
            value: stage,
          },
        ],
      };
    }
    return EMPTY_QUERY;
  });
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [aiEnrichOpen, setAiEnrichOpen] = useState(false);
  // US-962: bulk match-to-comp reprice of the selected active listings.
  const [repriceOpen, setRepriceOpen] = useState(false);
  // US-2948: bulk Promoted Listings, in the bulk bar rather than on a screen of
  // its own — the selection a seller wants to promote is the one they have
  // already made here.
  const [promoteOpen, setPromoteOpen] = useState(false);
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
  // US-2174: a hidden tab must not poll.
  const visible = useDocumentVisible();
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
    // Always written, To List included. A bare URL now means "the remembered
    // tab", so a URL that names the tab is the only one that can be shared or
    // bookmarked and mean the same thing to the next reader.
    next.set("tab", tab);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    writeLastInventoryTab(tab);
    setPage(1);
    if (tabMountedRef.current) setSelected(new Set());
    else tabMountedRef.current = true;
    // US-1489: keyed on `tab` only — the effect writes searchParams (a
    // searchParams dep would loop) and the rest are stable setters/refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // US-2168 added `filterQuery` here. While paging was client-side, landing on
  // an out-of-range page was harmless — `filtered.slice()` returned nothing and
  // `safePage` clamped the pager on the same render. Server-side, the OFFSET is
  // what gets sent, so narrowing the filter from page 6 asks for rows 500-600
  // of a 40-row result and the table renders empty while the pager says page 1.
  //
  // Re-sorting belongs in this list for the same reason, and it matters more
  // now that every header sorts rather than six of them: page 6 of a list
  // sorted by SKU is a different 100 rows than page 6 of the same list sorted
  // by Title, so staying on 6 shows the seller an arbitrary slice of an answer
  // they just asked to see from the top.
  useEffect(() => {
    setPage(1);
  }, [search, pageSize, soldFilter, filterQuery, columnSort, sortPreset]);


  // US-419: keyed under a DISTINCT "listings" suffix — NOT the bare
  // ["items_full", user.id] the shared readers use. Sharing the canonical key
  // would let this page's entry win and serve the other consumers something
  // shaped for this page. The "items_full" PREFIX keeps it covered by the
  // existing invalidateQueries({ queryKey: ["items_full"] }) calls.
  //
  // (US-419's ORIGINAL reason was that this query projected a narrower
  // LISTINGS_COLUMNS subset, so a partial-column entry could starve consumers of
  // photo_count/has_required_photos. US-2168 replaced the projected read with an
  // RPC returning WHOLE rows, so that specific hazard is gone — but the rule it
  // produced is still right for a different reason: this entry now holds a
  // {total, rows, soldAgg, buyerCounts} document rather than an ItemFullRow[],
  // and every shared reader expects an array. The distinct key is what keeps
  // that from becoming their problem.)
  //
  // US-2372: every optimistic write on this page MUST target the entry this
  // page READS. Nine call sites used to spell the bare ["items_full", user.id]
  // by hand — a cache entry this page does not read — so the optimistic patch
  // landed nowhere visible and the rollback wrote this page's rows into the
  // full-row cache. One writer (`patchRow`), one key, is the fix.
  //
  // US-2168 AC3: the key now carries the CRITERIA, because the server does the
  // selecting. Each (tab, search, sold window, filter, sort, page) combination
  // is a different answer and therefore a different cache entry — the same
  // reason the page-scoped detail reads key on pageRowIds. The first three
  // elements are unchanged, so every existing
  // invalidateQueries({ queryKey: ["items_full"] }) still sweeps all of them.
  const listingsItemsKey = ["items_full", "listings", user?.id] as const;
  const listingsPageKey = [
    ...listingsItemsKey,
    tab,
    search,
    soldFilter,
    sortPreset,
    columnSort,
    filterQuery,
    page,
    pageSize,
  ] as const;
  const { data: pageData, isLoading } = useQuery<ListingPageResult>({
    queryKey: listingsPageKey,
    enabled: !!user,
    // A page's worth of rows is cheap to refetch and stale rows here are the
    // expensive kind, so the previous entry stays visible while the next one
    // loads rather than blanking the table on every keystroke or page click.
    placeholderData: (prev) => prev,
    // US-2174 (replaces the US-735 reasoning).
    //
    // The old 15-minute window was justified by "mutations invalidate items_full
    // explicitly, so a longer window only skips redundant refetches". That holds
    // for changes WE make — but a sale on eBay is not a local mutation. Nothing
    // invalidated anything, so a sold listing could show as Active for a quarter
    // of an hour: long enough to reprice or relist something already gone.
    //
    // Three things now keep this fresh, in order of how quickly they act:
    //   1. local mutations invalidate ["items_full"] as before;
    //   2. useRealtimeListingState (dashboard layout) invalidates on a
    //      sale/status notification — near-instant, and the reason the interval
    //      below can stay slow rather than becoming a busy poll;
    //   3. this interval, as the backstop for anything that notifies nobody.
    //
    // The ACTIVE tab is the one where staleness costs money, so only it polls.
    // Everywhere else keeps the long window — a drafted item does not change
    // underneath the seller.
    staleTime: isActive ? 60 * 1000 : 15 * 60 * 1000,
    // Gated on visibility (US-576 pattern): a backgrounded tab stops polling
    // entirely, and refetchOnWindowFocus covers the return.
    refetchInterval: isActive && visible ? 2 * 60 * 1000 : false,
    // US-2168 AC3: ONE PAGE, selected server-side.
    //
    // This used to be the shared fetchItemsPaged loop over LISTINGS_COLUMNS —
    // the whole tenant,
    // paged only so that PostgREST's row cap could not truncate it silently
    // (US-2167). It was still the whole tenant: every row crossed the wire so
    // the browser could filter, sort and slice fifty of them, and the cost grew
    // with the account rather than with the page.
    //
    // flipdesk_listing_page (migration 00515) applies the tab predicate, the
    // search, the Sold window, the advanced filter and the sort in SQL and
    // returns just this page, plus the counts the page cannot derive from a
    // page: `total` for the pager, `soldAgg` over the whole filtered set, and
    // `buyerCounts` across the whole account for the repeat-buyer star.
    //
    // It is SECURITY INVOKER and items_full is security_invoker, so RLS still
    // scopes this to the caller exactly as the direct read did.
    queryFn: async (): Promise<ListingPageResult> => {
      const { data, error } = await supabase.rpc("flipdesk_listing_page", {
        p_tab: tab,
        p_search: search,
        p_sold_filter: soldFilter,
        p_filter: filterQuery,
        p_column_sort: columnSort,
        p_sort_preset: sortPreset,
        // "Year to date" means the VIEWER's year; the database cannot know it.
        p_ytd_start: new Date(new Date().getFullYear(), 0, 1).toISOString(),
        p_limit: pageSize,
        p_offset: (page - 1) * pageSize,
        // The projection stays in ONE place (listings-columns.ts) and is sent
        // to the server rather than restated in SQL, where it would drift the
        // first time a column was added. Without it the RPC returns every
        // items_full column, including the four heavy detail-only ones this
        // table never renders.
        p_columns: LISTINGS_COLUMN_LIST,
      } as never);
      if (error) throw error;
      return (data ?? { total: 0, rows: [] }) as ListingPageResult;
    },
  });

  // The rows this page renders. Named `items` because that is what every
  // handler below has always called them — what CHANGED is that it is now one
  // page rather than the whole account, which is the entire point of US-2168.
  // Anything that needs more than a page (CSV export) says so explicitly.
  const items = useMemo(() => pageData?.rows ?? [], [pageData]);

  /**
   * Patch one row in THIS page's cache entry, returning its rollback.
   *
   * US-2372 is the reason this is a helper and not four hand-written pairs of
   * setQueryData calls. That bug was nine call sites spelling a cache key by
   * hand, four of which named an entry the page did not read — so the
   * optimistic patch landed nowhere visible and the rollback wrote this page's
   * rows into a different query's cache. One writer, one key, no spelling.
   *
   * US-2168 moved the key AND the shape (an ItemFullRow[] became a
   * {total, rows, …} document), which is exactly the kind of change that would
   * have re-scattered that bug across four handlers.
   */
  function patchRow(id: string, patch: Partial<ItemFullRow>): () => void {
    const prev = qc.getQueryData<ListingPageResult>(listingsPageKey);
    qc.setQueryData<ListingPageResult>(listingsPageKey, (old) =>
      old
        ? {
          ...old,
          rows: old.rows.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        }
        : old,
    );
    return () => {
      qc.setQueryData<ListingPageResult>(listingsPageKey, prev);
    };
  }

  // US-404: stage-tab counts come from a server-side grouped count (one row per
  // status) rather than from the loaded rows. US-958: extracted into the shared
  // useInventoryStatusCounts hook so the table tabs and the kanban column badges
  // read from one cached query (keyed under the items_full prefix so the
  // existing items_full invalidations refresh it after status changes) instead
  // of each view recomputing the totals.
  const { data: statusCounts } = useInventoryStatusCounts();

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
    // US-2168: the old fallback counted the LOADED rows while statusCounts was
    // in flight. That was sound when "loaded" meant the whole account; it is
    // actively wrong now that it means one page, because it would badge every
    // tab with a number no larger than the page size — "3" next to a tab
    // holding 137 items. Zeros are the honest placeholder: obviously
    // not-yet-known, rather than confidently wrong for the second it shows.
    return counts;
  }, [statusCounts]);

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  // Only rendered rows need a score, and `items` IS the rendered rows now.
  const scoreById = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) m.set(it.id, scoreListability(it).score);
    return m;
  }, [items]);

  // Count of sales per buyer — drives the repeat-buyer star.
  //
  // US-2168: this asks "has this buyer bought from me BEFORE", which is a
  // question about the whole account, so it cannot be counted from the page.
  // The server answers it for the buyers on this page and the star keeps
  // meaning what it meant; deriving it from `items` now would silently show
  // every buyer as first-time whenever their other orders sat on another page.
  const buyerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const [buyer, n] of Object.entries(pageData?.buyerCounts ?? {})) {
      m.set(buyer, Number(n));
    }
    return m;
  }, [pageData]);

  // US-2168 AC5: the whole selection pipeline now lives in listings-filter.ts
  // as selectListingRows(), a pure function of (items, criteria). It used to be
  // this useMemo, closed over a dozen pieces of component state.
  //
  // The move is what makes AC5 possible at all. AC3 puts search, tab filtering
  // and sort on the server, and AC5 asks for row-count parity "against the
  // current client-side behaviour" — you cannot assert parity against a closure
  // there is no way to call. So the harness has to exist BEFORE the port, and
  // this is it: today's behaviour, callable, pinned by a fixture corpus.
  //
  // Written the other way round, a parity test would assert that the new
  // implementation matches itself.
  // US-2168 AC3: selectListingRows() has moved to the server (migration 00515,
  // `flipdesk_listing_page`). It is still THE specification of what a tab shows
  // — src/test/listing-page-sql-parity.test.ts runs it and the SQL over the same
  // rows read back out of items_full and requires identical ids in identical
  // order — it just no longer runs here, because running it here meant shipping
  // the whole account to the browser to render fifty rows.

  // Aggregate strip for the Sold tab — over the current FILTER, not this page,
  // which is why it comes back from the query rather than being summed here.
  const soldAgg = useMemo(() => {
    if (!isSold || !pageData) return null;
    const a = pageData.soldAgg;
    return {
      count: Number(a?.count ?? 0),
      gross: Number(a?.gross ?? 0),
      net: Number(a?.net ?? 0),
      avgMargin: a?.avgMargin == null ? null : Number(a.avgMargin),
    };
  }, [isSold, pageData]);

  const totalRows = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  // The same hazard from the other direction: `total` can shrink underneath the
  // current page without the criteria changing at all — a background refetch
  // after items are archived elsewhere, say. Clamp rather than show a blank
  // page the seller has no way to interpret.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = items;

  // CSV export is the one thing here that legitimately wants every row of the
  // current filter, so it asks for them explicitly instead of the table quietly
  // holding them all year-round on its behalf. Paged rather than one big
  // request, because `flipdesk_listing_page` caps `p_limit` — and a cap that
  // silently truncated an export would be the same class of bug US-2390 removed
  // from the admin dashboard.
  const [exporting, setExporting] = useState(false);
  // US-2173 AC2: every mutation handler now lives in listings-actions.ts with
  // its dependencies passed in, so each one can be called from a test with
  // fakes instead of a rendered page. The bodies moved verbatim; only their
  // dependency plumbing changed. Built on every render, exactly as the function
  // declarations were re-created on every render before, so handler identity
  // churns the same as it always did.
  const {
    exportCsv,
    bulkCreateDrafts,
    updateTracking,
    markDelivered,
    updateListingPrice,
    updateItemStatus,
    updateItemMoney,
    updateItemNotes,
    endListing,
    bulkPriceDrop,
    bulkRelist,
    bulkPublishToEbay,
    bulkDeleteItems,
    bulkEndListings,
    bulkResubmitToEbay,
    bulkSetStatus,
  } = makeListingsActions({
    qc,
    patchRow,
    items,
    selected,
    setSelected,
    tab,
    search,
    soldFilter,
    filterQuery,
    columnSort,
    sortPreset,
    setExporting,
    setBusy,
    setDropProgress,
    dropCancelled,
    bulkDropPct,
    setBulkPublishProgress,
    setBulkReviseProgress,
    setBulkDeleteProgress,
    setBulkDeleteOpen,
    setBulkStatusOpen,
    setBulkStatusValue,
    ebayConnection,
    updatePrice,
    endListingApi,
    bulkPrice,
    bulkEnd,
    bulkRevise,
    bulkRelistApi: bulkRelistMut,
    deleteItemApi,
    publishApi,
  });


  const pageRowIds = useMemo(() => pageRows.map((r) => r.id), [pageRows]);

  // US-2173: the five page-scoped detail reads and the quality-score read moved
  // to listings-page-queries.ts. They are called HERE, below pageRows, because
  // that is where pageRowIds exists — hooks run in order, so this position is
  // load-bearing, not stylistic. The module comment carries the rest of the
  // US-2168 reasoning.
  const {
    platformsByItem,
    draftMetaByItem,
    publishIssuesByItem,
    coverByItem,
    metricsByItem,
    qualityByListing,
  } = usePageRowDetails({
    userId: user?.id,
    pageRows,
    pageRowIds,
    isDrafts,
    isActive,
  });

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
          <PageHelp slug="the-four-inventory-views" />
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={totalRows === 0 || exporting}
          >
            <Download className="mr-2 h-4 w-4" />
            {exporting ? "Exporting…" : "Export CSV"}
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
              Add item
            </Link>
          </Button>
        </div>
      </div>

      {/* US-717: cross-listing auto-delist queue (extension marketplaces). */}
      <PendingDelistBanner />
      {/* US-9202: edits waiting to reach an extension channel. */}
      <PendingReviseBanner />

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
        <SearchInput
          label="Search listings"
          value={searchDraft}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, brand, SKU…"
          containerClassName="flex-1"
          className="w-full"
        />
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
          <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
              <SheetDescription>
                Narrow the {activeTab.label} list.
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-4">
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Sort</span>
                <SortMenu
                  options={sortOptions}
                  value={sortOption.id}
                  headerActive={headerSort != null}
                  onChange={pickSort}
                  className="w-full"
                />
              </div>
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
                    <SelectTrigger aria-label="Saved views" className="w-full text-xs">
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
        <SearchInput
          label="Search listings"
          value={searchDraft}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, brand, SKU…"
          className="w-64"
        />
        <SortMenu
          options={sortOptions}
          value={sortOption.id}
          headerActive={headerSort != null}
          onChange={pickSort}
          className="w-52"
        />
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
              <SelectTrigger aria-label="Saved views" className="h-9 w-44 text-xs">
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
            {totalRows} item{totalRows === 1 ? "" : "s"}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              in {activeTab.label}
            </span>
          </CardTitle>
          <CardDescription>
            Sorted by {sortedByLabel}.{" "}
            {isToList
              ? "Select rows to bulk-create drafts."
              : isSold
                ? "Select rows to prepare shipments."
                : isDrafts
                  ? ebayConnection
                    ? "Select rows to bulk-publish to eBay."
                    : "Click a row to publish, or connect eBay for bulk-publish."
                  : "Click a row for full details."}
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
              // US-2865: only on the ALL tab. Every other tab here is a
              // status filter, so "No returns" is a statement about one
              // stage, not about an empty account, and a seller with two
              // hundred items does not need an example garment.
              secondaryAction={tab === "all" ? showExampleAction : undefined}
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
              {/* US-2173 AC3: the desktop table is its own component now. The
                  US-733 virtualization decision stays here — the hook must be
                  created on every render, and this component is not mounted on
                  mobile — so its output is passed down rather than computed
                  there. */}
              <ListingsTable
                pageRows={pageRows}
                tab={tab}
                isActive={isActive}
                isDrafts={isDrafts}
                isShipped={isShipped}
                isSold={isSold}
                isToList={isToList}
                selectable={selectable}
                selected={selected}
                allOnPageSelected={allOnPageSelected}
                toggleSelected={toggleSelected}
                toggleSelectAll={toggleSelectAll}
                columnSort={columnSort}
                toggleColumnSort={toggleColumnSort}
                tableScrollRef={tableScrollRef}
                virtualize={virtualize}
                virtualItems={virtualItems}
                rowVirtualizer={rowVirtualizer}
                vPadTop={vPadTop}
                vPadBottom={vPadBottom}
                platformsByItem={platformsByItem}
                draftMetaByItem={draftMetaByItem}
                publishIssuesByItem={publishIssuesByItem}
                coverByItem={coverByItem}
                metricsByItem={metricsByItem}
                qualityByListing={qualityByListing}
                scoreById={scoreById}
                buyerCounts={buyerCounts}
                updateTracking={updateTracking}
                updateListingPrice={updateListingPrice}
                updateItemStatus={updateItemStatus}
                updateItemMoney={updateItemMoney}
                updateItemNotes={updateItemNotes}
                markDelivered={markDelivered}
                setPublishItem={setPublishItem}
                setMarkListedItem={setMarkListedItem}
                setRecordSaleItem={setRecordSaleItem}
                setShipItem={setShipItem}
                setEndTarget={setEndTarget}
                setDeleteTarget={setDeleteTarget}
                ebayConnection={ebayConnection}
                navigate={navigate}
              />

              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Rows per page:</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => setPageSize(Number(v))}
                  >
                    <SelectTrigger aria-label="Rows per page" className="h-7 w-20">
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
                  {totalRows}
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
                  {ebayConnection && (
                    <Button
                      variant="outline"
                      onClick={() => setPromoteOpen(true)}
                      disabled={busy}
                    >
                      <Megaphone className="mr-2 h-4 w-4" />
                      Promote
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
                    <SelectTrigger aria-label="Price drop percentage" className="h-9 w-28">
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
                  {/* US-2163 (AC5): while a chunked markdown runs, the button
                      becomes a live counter and a Stop. */}
                  {dropProgress ? (
                    <>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                        {dropProgress.done} / {dropProgress.total}
                      </span>
                      <Button
                        variant="outline"
                        onClick={() => {
                          dropCancelled.current = true;
                        }}
                      >
                        Stop
                      </Button>
                    </>
                  ) : (
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
                  )}
                  {/* US-9203: relist the selection. eBay now; Poshmark, Mercari
                      and Vinted through the desktop extension, old copy ended
                      once the new one is live. Pro-gated (autoRelist). */}
                  <Button variant="outline" onClick={bulkRelist} disabled={busy}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Relist
                  </Button>
                  {/* US-2404: push the saved edits (specifics, category,
                      condition, photos) of every selected live listing back to
                      eBay — the bulk-bar form of the composer's "Save &
                      resubmit". Active tab only: there is nothing live to
                      resubmit on a draft. */}
                  {ebayConnection ? (
                    <Button
                      variant="outline"
                      onClick={bulkResubmitToEbay}
                      disabled={busy}
                    >
                      {bulkReviseProgress ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      {bulkReviseProgress
                        ? `Resubmitting ${bulkReviseProgress.done}/${bulkReviseProgress.total}…`
                        : `Resubmit ${selected.size} to eBay`}
                    </Button>
                  ) : null}
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
                <>
                  {ebayConnection ? (
                    <Button onClick={bulkPublishToEbay} disabled={busy}>
                      {busy && bulkPublishProgress ? (
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
                  )}
                  <Button
                    variant="destructive"
                    onClick={() => setBulkDeleteOpen(true)}
                    disabled={busy}
                  >
                    {busy && bulkDeleteProgress ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    {bulkDeleteProgress
                      ? `Deleting ${bulkDeleteProgress.done}/${bulkDeleteProgress.total}…`
                      : `Delete ${selected.size}`}
                  </Button>
                </>
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
              <SelectTrigger aria-label="New status for the selected items">
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
        open={!!deleteTarget}
        onOpenChange={(o) => !o && !deleteItemApi.isPending && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this item?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.item_title}" and its photos, drafts, and listing
              records will be permanently deleted. This can't be undone. Use this
              to remove a duplicate — to take a live listing down instead, End it;
              to keep a sold item's records, Archive it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteItemApi.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteItemApi.isPending}
              onClick={async (e) => {
                // Keep the dialog open until the delete resolves so the user sees
                // the spinner / a guard error, then close only on success.
                e.preventDefault();
                if (!deleteTarget) return;
                const target = deleteTarget;
                try {
                  await deleteItemApi.mutateAsync({ itemId: target.id });
                  toast.success(`Deleted "${target.item_title ?? "item"}".`);
                  setDeleteTarget(null);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "Delete failed.";
                  // US-2657: the server now names the listing it refused over.
                  // Give the seller a way to open it — the usual answer is "that
                  // row belongs to the other copy of this item", and no wording
                  // gets them there on its own.
                  const url = deleteBlockListingUrl(err as DeleteItemError);
                  toast.error(msg, {
                    duration: 16_000,
                    ...(url
                      ? {
                          action: {
                            label: "Open the listing",
                            onClick: () => window.open(url, "_blank", "noreferrer"),
                          },
                        }
                      : {}),
                  });
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteItemApi.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirm for the selected drafts. */}
      <AlertDialog
        open={bulkDeleteOpen}
        onOpenChange={(o) => {
          if (!o && !busy) setBulkDeleteOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} item{selected.size === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The selected item{selected.size === 1 ? "" : "s"} and their photos,
              drafts, and listing records will be permanently deleted. This can't
              be undone. Anything with a live listing or a recorded sale is
              skipped automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void bulkDeleteItems();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy && bulkDeleteProgress ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {bulkDeleteProgress
                ? `Deleting ${bulkDeleteProgress.done}/${bulkDeleteProgress.total}…`
                : `Delete ${selected.size}`}
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

      <BulkPromoteDialog
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        listingIds={Array.from(selected)
          .map((id) => items.find((i) => i.id === id)?.listing_id)
          .filter((v): v is string => !!v)}
        selectionValueCents={(() => {
          // Null when ANY selected item has no price: a fee estimate that
          // silently omits the items it could not price reads as complete.
          const rows = Array.from(selected)
            .map((id) => items.find((i) => i.id === id))
            .filter((r): r is NonNullable<typeof r> => !!r);
          if (rows.length === 0 || rows.some((r) => r.list_price == null)) return null;
          return rows.reduce((sum, r) => sum + Math.round(Number(r.list_price) * 100), 0);
        })()}
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
