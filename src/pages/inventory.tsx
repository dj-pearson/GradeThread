import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Package,
  Plus,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { ClickableRow } from "@/components/clickable-row";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/lib/supabase";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { GARMENT_TYPES, ITEM_STATUSES } from "@/lib/constants";
import type { InventoryItemRow } from "@/types/database";

const PAGE_SIZE = 25;

// US-2204: the grid renders five columns of an inventory row, so the paged
// query fetches exactly those. The rows are typed as the projection, which is
// what makes the narrowing safe — a cell reaching for a column the select
// stopped fetching fails tsc rather than rendering blank. (Sorting by
// created_at still works; ordering does not require selecting the column.)
type InventoryListRow = Pick<
  InventoryItemRow,
  "id" | "title" | "brand" | "status" | "acquired_price"
>;
const INVENTORY_LIST_COLUMNS = "id, title, brand, status, acquired_price";

type SortField = "created_at" | "acquired_price" | "status";
type SortDirection = "asc" | "desc";

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatCurrency(amount: number | null): string {
  if (amount === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

// US-2023: only these two columns are ever read, so the queries project only
// these two columns. Narrow types keep that honest — widening the projection now
// requires widening the type, which is a visible decision rather than a drift.
interface DaysListedListing {
  inventory_item_id: string;
  listed_at: string;
}
interface DaysListedSale {
  inventory_item_id: string;
  sale_date: string;
}

function calcDaysListed(
  itemId: string,
  itemStatus: string,
  listingsByItem: Map<string, DaysListedListing[]>,
  saleByItem: Map<string, DaysListedSale>,
): number | null {
  const listings = listingsByItem.get(itemId);
  if (!listings || listings.length === 0) return null;

  // Earliest listing date
  const first = listings[0];
  if (!first) return null;
  const earliest = listings.reduce((min, l) =>
    l.listed_at < min ? l.listed_at : min, first.listed_at);

  // End date: sale date if sold, otherwise today
  const sale = saleByItem.get(itemId);
  const soldStatuses = new Set(["sold", "shipped", "completed"]);
  const endDate = sale && soldStatuses.has(itemStatus)
    ? new Date(sale.sale_date)
    : new Date();

  const days = Math.floor(
    (endDate.getTime() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24)
  );
  return days >= 0 ? days : 0;
}

function getDaysListedClasses(days: number | null): string {
  if (days === null) return "text-muted-foreground";
  if (days >= 60) return "text-red-600 font-medium dark:text-red-400";
  if (days >= 30) return "text-yellow-600 font-medium dark:text-yellow-400";
  return "text-muted-foreground";
}

function formatDaysListed(days: number | null): string {
  if (days === null) return "—";
  return `${days}d`;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-10 flex-1" />
        </div>
      ))}
    </div>
  );
}

export function InventoryPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Press "n" to add a new inventory item.
  useKeyboardShortcuts([
    { key: "n", handler: () => navigate("/dashboard/inventory/new") },
  ]);
  const [garmentTypeFilter, setGarmentTypeFilter] = useState<string>("all");
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  // Fetch distinct brands for filter
  const { data: brandsData } = useQuery({
    queryKey: ["inventory-brands"],
    queryFn: async () => {
      // US-2023 AC2: an RPC, not a select over the whole table. This dropdown
      // used to pull `brand` for EVERY inventory row in the tenant just to
      // produce ~200 distinct strings. PostgREST cannot express DISTINCT, and
      // the client-side workarounds (a LIMIT, or sampling) would silently DROP
      // brands from the filter — a correctness regression traded for a perf
      // win — so the aggregate belongs in the database. The function is
      // SECURITY INVOKER and takes no user_id, so RLS scopes it to the caller.
      const { data, error } = await supabase.rpc("inventory_distinct_brands");

      if (error) throw error;

      // The RPC already returns distinct, non-blank, sorted brands — the Set
      // and sort that used to live here were compensating for the client-side
      // scan and are now the database's job.
      const rows = (data ?? []) as Array<{ brand: string | null }>;
      return rows.map((r) => r.brand).filter((b): b is string => !!b);
    },
    staleTime: 5 * 60 * 1000,
  });

  const brands = brandsData ?? [];

  const {
    data,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: [
      "inventory",
      page,
      statusFilter,
      garmentTypeFilter,
      brandFilter,
      sortField,
      sortDirection,
    ],
    queryFn: async () => {
      let query = supabase
        .from("inventory_items")
        .select(INVENTORY_LIST_COLUMNS, { count: "exact" });

      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      if (garmentTypeFilter !== "all") {
        query = query.eq("garment_type", garmentTypeFilter);
      }
      if (brandFilter !== "all") {
        query = query.eq("brand", brandFilter);
      }

      // US-1651: sort server-side across ALL rows, not just the current page.
      // `status` is a real column and the item_status ENUM is defined in the
      // ITEM_STATUSES lifecycle order (Postgres orders an enum by its declared
      // sort order), so `.order("status")` yields the same lifecycle ordering the
      // old client-side ITEM_STATUSES.indexOf() sort did — but globally. Ordering
      // by a column is bedrock PostgREST (no local↔prod divergence).
      const orderColumn =
        sortField === "acquired_price"
          ? "acquired_price"
          : sortField === "status"
          ? "status"
          : "created_at";
      query = query
        .order(orderColumn, { ascending: sortDirection === "asc" })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      const { data: items, error, count } = await query;

      if (error) throw error;

      const itemRows = (items ?? []) as InventoryListRow[];

      return { items: itemRows, totalCount: count ?? 0 };
    },
    staleTime: 5 * 60 * 1000,
  });

  // US-2023: memoized because `pageItemIds` below derives from it and feeds a
  // queryKey. `data?.items ?? []` produces a NEW array identity every render, so
  // without this the derived memo recomputes constantly. TanStack hashes keys
  // structurally, so this was not causing refetch churn — but a stable identity
  // is what makes that guarantee obvious instead of incidental.
  const items = useMemo(() => data?.items ?? [], [data]);
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // US-2023: hydrate days-listed for the VISIBLE PAGE ONLY.
  //
  // This used to be `listings.select("*")` + `sales.select("*")` with no bound —
  // the tenant's ENTIRE commercial history, both wide tables, pulled into the
  // browser to decorate ~50 rows. A seller with 5,000 listings and 3,000 sales
  // downloaded 8,000 wide rows on the entry path to the app, and it grew forever
  // because `sales` is append-only. The grid beside it was already correctly
  // paginated, which is what made the cost invisible.
  //
  // Scoped by .in(page ids) and projected to the TWO columns calcDaysListed
  // actually reads. Both supporting indexes already exist
  // (idx_listings_inventory_item_id, idx_sales_inventory_item_id).
  const pageItemIds = useMemo(() => items.map((i) => i.id), [items]);
  const { data: daysListedData } = useQuery({
    // The ids are the cache key: paging re-fetches, revisiting a page is a hit.
    queryKey: ["inventory-days-listed", pageItemIds],
    enabled: pageItemIds.length > 0,
    queryFn: async () => {
      const [listingsRes, salesRes] = await Promise.all([
        supabase
          .from("listings")
          .select("inventory_item_id, listed_at")
          .in("inventory_item_id", pageItemIds),
        supabase
          .from("sales")
          .select("inventory_item_id, sale_date")
          .in("inventory_item_id", pageItemIds),
      ]);
      if (listingsRes.error) throw listingsRes.error;
      if (salesRes.error) throw salesRes.error;
      return {
        listings: (listingsRes.data ?? []) as DaysListedListing[],
        sales: (salesRes.data ?? []) as DaysListedSale[],
      };
    },
    staleTime: 5 * 60 * 1000,
  });

  const { listingsByItem, saleByItem } = useMemo(() => {
    const byItem = new Map<string, DaysListedListing[]>();
    const sale = new Map<string, DaysListedSale>();
    for (const l of daysListedData?.listings ?? []) {
      const arr = byItem.get(l.inventory_item_id) ?? [];
      arr.push(l);
      byItem.set(l.inventory_item_id, arr);
    }
    for (const sl of daysListedData?.sales ?? []) {
      sale.set(sl.inventory_item_id, sl);
    }
    return { listingsByItem: byItem, saleByItem: sale };
  }, [daysListedData]);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
    setPage(0);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        subtitle="Manage your garment inventory and track item lifecycle."
        actions={
          <Button onClick={() => navigate("/dashboard/inventory/new")}>
            <Plus className="mr-1 h-4 w-4" />
            Add Item
          </Button>
        }
      />

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            <Search className="mr-1.5 inline-block h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <div className="w-44">
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label="Status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {ITEM_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {formatLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-44">
              <Select
                value={garmentTypeFilter}
                onValueChange={(v) => {
                  setGarmentTypeFilter(v);
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label="Garment type">
                  <SelectValue placeholder="Garment Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {GARMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {formatLabel(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-44">
              <Select
                value={brandFilter}
                onValueChange={(v) => {
                  setBrandFilter(v);
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label="Brand">
                  <SelectValue placeholder="Brand" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Brands</SelectItem>
                  {brands.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">All Items</CardTitle>
            {totalCount > 0 && (
              <CardDescription>
                {totalCount} item{totalCount !== 1 ? "s" : ""}
              </CardDescription>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            isLoading={isLoading}
            isError={isError}
            isEmpty={items.length === 0}
            onRetry={() => refetch()}
            isRetrying={isFetching}
            loading={<LoadingSkeleton />}
            errorProps={{
              title: "Couldn't load inventory",
              description:
                "Something went wrong while loading your inventory. This is usually temporary.",
            }}
            empty={
              statusFilter !== "all" ||
              garmentTypeFilter !== "all" ||
              brandFilter !== "all" ? (
                <EmptyState
                  icon={Package}
                  title="No matching items"
                  description="No inventory items match the current filters."
                  secondaryAction={{
                    label: "Clear filters",
                    onClick: () => {
                      setStatusFilter("all");
                      setGarmentTypeFilter("all");
                      setBrandFilter("all");
                    },
                  }}
                />
              ) : (
                <EmptyState
                  icon={Package}
                  title="No inventory items yet"
                  description="Add your first item to start tracking your inventory."
                  action={{
                    label: "Add your first item",
                    to: "/dashboard/inventory/new",
                    icon: Plus,
                  }}
                />
              )
            }
          >
            <>
              {/* Mobile: card list instead of the horizontal-scroll table. */}
              <ul className="divide-y md:hidden">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/dashboard/inventory/${item.id}`)
                      }
                      className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {item.title}
                        </div>
                        {item.brand && (
                          <div className="truncate text-xs text-muted-foreground">
                            {item.brand}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <StatusBadge status={item.status} />
                        <span className="font-mono text-sm tabular-nums">
                          {formatCurrency(item.acquired_price)}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Brand</TableHead>
                      <TableHead>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("status")}
                        >
                          Status
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </button>
                      </TableHead>
                      <TableHead>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("acquired_price")}
                        >
                          Acquired Price
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </button>
                      </TableHead>
                      <TableHead>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("created_at")}
                        >
                          Days Listed
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <ClickableRow
                        key={item.id}
                        className="hover:bg-muted/50"
                        onActivate={() =>
                          navigate(`/dashboard/inventory/${item.id}`)
                        }
                        activateLabel={`View ${item.title}`}
                      >
                        <TableCell className="font-medium">
                          {item.title}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {item.brand ?? "—"}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={item.status} />
                        </TableCell>
                        <TableCell>
                          {formatCurrency(item.acquired_price)}
                        </TableCell>
                        <TableCell className={getDaysListedClasses(
                          calcDaysListed(item.id, item.status, listingsByItem, saleByItem)
                        )}>
                          {formatDaysListed(
                            calcDaysListed(item.id, item.status, listingsByItem, saleByItem)
                          )}
                        </TableCell>
                      </ClickableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-4">
                  <p className="text-sm text-muted-foreground">
                    Page {page + 1} of {totalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 0}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages - 1}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          </QueryBoundary>
        </CardContent>
      </Card>
    </div>
  );
}
