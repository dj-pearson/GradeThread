import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { GARMENT_TYPES, ITEM_STATUSES } from "@/lib/constants";
import type { InventoryItemRow } from "@/types/database";

const PAGE_SIZE = 25;

type SortField = "created_at" | "acquired_price" | "status";
type SortDirection = "asc" | "desc";

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getStatusBadgeClasses(status: string): string {
  switch (status) {
    case "acquired":
      return "border-slate-200 bg-slate-100 text-slate-800";
    case "grading":
      return "border-blue-200 bg-blue-100 text-blue-800";
    case "graded":
      return "border-indigo-200 bg-indigo-100 text-indigo-800";
    case "listed":
      return "border-yellow-200 bg-yellow-100 text-yellow-800";
    case "sold":
      return "border-green-200 bg-green-100 text-green-800";
    case "shipped":
      return "border-cyan-200 bg-cyan-100 text-cyan-800";
    case "completed":
      return "border-emerald-200 bg-emerald-100 text-emerald-800";
    case "returned":
      return "border-red-200 bg-red-100 text-red-800";
    default:
      return "";
  }
}

function formatCurrency(amount: number | null): string {
  if (amount === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function daysInInventory(acquiredDate: string | null): string {
  if (!acquiredDate) return "—";
  const acquired = new Date(acquiredDate);
  const now = new Date();
  const diffMs = now.getTime() - acquired.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
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
  const [garmentTypeFilter, setGarmentTypeFilter] = useState<string>("all");
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  // Fetch distinct brands for filter
  const { data: brandsData } = useQuery({
    queryKey: ["inventory-brands"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("brand");

      if (error) throw error;

      const rows = (data ?? []) as Pick<InventoryItemRow, "brand">[];
      const brands = [
        ...new Set(rows.map((r) => r.brand).filter(Boolean)),
      ] as string[];
      return brands.sort();
    },
    staleTime: 5 * 60 * 1000,
  });

  const brands = brandsData ?? [];

  const { data, isLoading } = useQuery({
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
        .select("*", { count: "exact" });

      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      if (garmentTypeFilter !== "all") {
        query = query.eq("garment_type", garmentTypeFilter);
      }
      if (brandFilter !== "all") {
        query = query.eq("brand", brandFilter);
      }

      // Map sort field to actual column for DB sorting
      const orderColumn =
        sortField === "acquired_price" ? "acquired_price" : "created_at";
      query = query
        .order(orderColumn, { ascending: sortDirection === "asc" })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      const { data: items, error, count } = await query;

      if (error) throw error;

      const itemRows = (items ?? []) as InventoryItemRow[];

      // Client-side sort for status if needed
      if (sortField === "status") {
        const statusOrder = ITEM_STATUSES as readonly string[];
        itemRows.sort((a, b) => {
          const aIdx = statusOrder.indexOf(a.status);
          const bIdx = statusOrder.indexOf(b.status);
          return sortDirection === "asc" ? aIdx - bIdx : bIdx - aIdx;
        });
      }

      return { items: itemRows, totalCount: count ?? 0 };
    },
    staleTime: 5 * 60 * 1000,
  });

  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-muted-foreground">
            Manage your garment inventory and track item lifecycle.
          </p>
        </div>
        <Button onClick={() => navigate("/dashboard/inventory/new")}>
          <Plus className="mr-1 h-4 w-4" />
          Add Item
        </Button>
      </div>

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
                <SelectTrigger>
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
                <SelectTrigger>
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
                <SelectTrigger>
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
          {isLoading ? (
            <LoadingSkeleton />
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Package className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">
                No inventory items yet
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Add your first item to start tracking your inventory.
              </p>
              <Button
                className="mt-4"
                onClick={() => navigate("/dashboard/inventory/new")}
              >
                <Plus className="mr-1 h-4 w-4" />
                Add Your First Item
              </Button>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
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
                      <TableHead>Grade</TableHead>
                      <TableHead>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("acquired_price")}
                        >
                          Acquired Price
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </button>
                      </TableHead>
                      <TableHead>Listed Price</TableHead>
                      <TableHead>
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => toggleSort("created_at")}
                        >
                          Days in Inventory
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </button>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow
                        key={item.id}
                        className="cursor-pointer"
                        onClick={() =>
                          navigate(`/dashboard/inventory/${item.id}`)
                        }
                      >
                        <TableCell className="font-medium">
                          {item.title}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {item.brand ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(getStatusBadgeClasses(item.status))}
                          >
                            {formatLabel(item.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          —
                        </TableCell>
                        <TableCell>
                          {formatCurrency(item.acquired_price)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          —
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {daysInInventory(item.acquired_date)}
                        </TableCell>
                      </TableRow>
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
