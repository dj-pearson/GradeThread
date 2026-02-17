import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InventoryItemRow, SaleRow, ShipmentRow, ListingRow } from "@/types/database";

interface ProfitTableProps {
  items: InventoryItemRow[];
  sales: SaleRow[];
  shipments: ShipmentRow[];
  listings: ListingRow[];
  periodStart: string | null;
}

interface ProfitRow {
  id: string;
  title: string;
  brand: string;
  category: string;
  acquiredPrice: number;
  gradingCost: number;
  listedPrice: number;
  salePrice: number;
  platformFees: number;
  shippingCost: number;
  netProfit: number;
  profitMargin: number;
  saleDate: string;
}

type SortField = keyof Omit<ProfitRow, "id">;
type SortDirection = "asc" | "desc";
type ProfitFilter = "all" | "profit" | "loss";

const GRADING_COST = 0; // No grading cost column in current DB; placeholder for future

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

export function ProfitTable({
  items,
  sales,
  shipments,
  listings,
  periodStart,
}: ProfitTableProps) {
  const [sortField, setSortField] = useState<SortField>("saleDate");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [profitFilter, setProfitFilter] = useState<ProfitFilter>("all");
  const [brandFilter, setBrandFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Build lookup maps
  const rows = useMemo((): ProfitRow[] => {
    const itemById = new Map<string, InventoryItemRow>();
    for (const item of items) {
      itemById.set(item.id, item);
    }

    const shipmentBySaleId = new Map<string, ShipmentRow>();
    for (const s of shipments) {
      shipmentBySaleId.set(s.sale_id, s);
    }

    // Get the highest listing price for each item
    const listingPriceByItemId = new Map<string, number>();
    for (const listing of listings) {
      const existing = listingPriceByItemId.get(listing.inventory_item_id);
      if (existing === undefined || listing.listing_price > existing) {
        listingPriceByItemId.set(listing.inventory_item_id, listing.listing_price);
      }
    }

    // Filter sales by period
    const filteredSales = periodStart
      ? sales.filter((s) => s.sale_date >= periodStart)
      : sales;

    return filteredSales.map((sale) => {
      const item = itemById.get(sale.inventory_item_id);
      const shipment = shipmentBySaleId.get(sale.id);
      const acquiredPrice = item?.acquired_price ?? 0;
      const gradingCost = GRADING_COST;
      const listedPrice = listingPriceByItemId.get(sale.inventory_item_id) ?? 0;
      const salePrice = sale.sale_price;
      const platformFees = sale.platform_fees;
      const shippingCost = shipment
        ? shipment.shipping_cost + shipment.label_cost
        : 0;
      const totalCosts = acquiredPrice + gradingCost + platformFees + shippingCost;
      const netProfit = salePrice - totalCosts;
      const profitMargin = salePrice > 0 ? (netProfit / salePrice) * 100 : 0;

      return {
        id: sale.id,
        title: item?.title ?? "Unknown Item",
        brand: item?.brand ?? "—",
        category: item?.garment_category ?? "—",
        acquiredPrice,
        gradingCost,
        listedPrice,
        salePrice,
        platformFees,
        shippingCost,
        netProfit,
        profitMargin,
        saleDate: sale.sale_date,
      };
    });
  }, [items, sales, shipments, listings, periodStart]);

  // Unique brands and categories for filter dropdowns
  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.brand !== "—") set.add(r.brand);
    }
    return Array.from(set).sort();
  }, [rows]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.category !== "—") set.add(r.category);
    }
    return Array.from(set).sort();
  }, [rows]);

  // Apply filters
  const filteredRows = useMemo(() => {
    let result = rows;

    if (profitFilter === "profit") {
      result = result.filter((r) => r.netProfit >= 0);
    } else if (profitFilter === "loss") {
      result = result.filter((r) => r.netProfit < 0);
    }

    if (brandFilter !== "all") {
      result = result.filter((r) => r.brand === brandFilter);
    }

    if (categoryFilter !== "all") {
      result = result.filter((r) => r.category === categoryFilter);
    }

    if (dateFrom) {
      result = result.filter((r) => r.saleDate >= dateFrom);
    }

    if (dateTo) {
      const toEnd = dateTo + "T23:59:59.999Z";
      result = result.filter((r) => r.saleDate <= toEnd);
    }

    return result;
  }, [rows, profitFilter, brandFilter, categoryFilter, dateFrom, dateTo]);

  // Sort
  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows];
    sorted.sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortDirection === "asc"
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }
      const aNum = Number(aVal);
      const bNum = Number(bVal);
      return sortDirection === "asc" ? aNum - bNum : bNum - aNum;
    });
    return sorted;
  }, [filteredRows, sortField, sortDirection]);

  // Totals
  const totals = useMemo(() => {
    const t = {
      acquiredPrice: 0,
      gradingCost: 0,
      listedPrice: 0,
      salePrice: 0,
      platformFees: 0,
      shippingCost: 0,
      netProfit: 0,
    };
    for (const r of sortedRows) {
      t.acquiredPrice += r.acquiredPrice;
      t.gradingCost += r.gradingCost;
      t.listedPrice += r.listedPrice;
      t.salePrice += r.salePrice;
      t.platformFees += r.platformFees;
      t.shippingCost += r.shippingCost;
      t.netProfit += r.netProfit;
    }
    return {
      ...t,
      profitMargin: t.salePrice > 0 ? (t.netProfit / t.salePrice) * 100 : 0,
    };
  }, [sortedRows]);

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) {
      return <ArrowUpDown className="ml-1 inline h-3 w-3 text-muted-foreground" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 inline h-3 w-3" />
    );
  }

  const columns: { field: SortField; label: string }[] = [
    { field: "title", label: "Item Title" },
    { field: "brand", label: "Brand" },
    { field: "acquiredPrice", label: "Acquired Price" },
    { field: "gradingCost", label: "Grading Cost" },
    { field: "listedPrice", label: "Listed Price" },
    { field: "salePrice", label: "Sale Price" },
    { field: "platformFees", label: "Platform Fees" },
    { field: "shippingCost", label: "Shipping Cost" },
    { field: "netProfit", label: "Net Profit" },
    { field: "profitMargin", label: "Margin %" },
  ];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Date From</label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 w-36"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Date To</label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 w-36"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Profit</label>
          <Select value={profitFilter} onValueChange={(v) => setProfitFilter(v as ProfitFilter)}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="profit">Profit Only</SelectItem>
              <SelectItem value="loss">Loss Only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Brand</label>
          <Select value={brandFilter} onValueChange={setBrandFilter}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
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
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Category</label>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col.field}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-ml-3 h-8 px-2 text-xs font-medium"
                    onClick={() => handleSort(col.field)}
                  >
                    {col.label}
                    <SortIcon field={col.field} />
                  </Button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No sold items found for the selected filters.
                </TableCell>
              </TableRow>
            ) : (
              sortedRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-[200px] truncate font-medium">
                    {row.title}
                  </TableCell>
                  <TableCell>{row.brand}</TableCell>
                  <TableCell>{formatCurrency(row.acquiredPrice)}</TableCell>
                  <TableCell>{formatCurrency(row.gradingCost)}</TableCell>
                  <TableCell>{formatCurrency(row.listedPrice)}</TableCell>
                  <TableCell>{formatCurrency(row.salePrice)}</TableCell>
                  <TableCell>{formatCurrency(row.platformFees)}</TableCell>
                  <TableCell>{formatCurrency(row.shippingCost)}</TableCell>
                  <TableCell
                    className={cn(
                      "font-medium",
                      row.netProfit >= 0 ? "text-green-600" : "text-red-600"
                    )}
                  >
                    {formatCurrency(row.netProfit)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "font-medium",
                      row.profitMargin >= 0 ? "text-green-600" : "text-red-600"
                    )}
                  >
                    {row.profitMargin.toFixed(1)}%
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          {sortedRows.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell className="font-bold">Totals</TableCell>
                <TableCell />
                <TableCell className="font-bold">{formatCurrency(totals.acquiredPrice)}</TableCell>
                <TableCell className="font-bold">{formatCurrency(totals.gradingCost)}</TableCell>
                <TableCell className="font-bold">{formatCurrency(totals.listedPrice)}</TableCell>
                <TableCell className="font-bold">{formatCurrency(totals.salePrice)}</TableCell>
                <TableCell className="font-bold">{formatCurrency(totals.platformFees)}</TableCell>
                <TableCell className="font-bold">{formatCurrency(totals.shippingCost)}</TableCell>
                <TableCell
                  className={cn(
                    "font-bold",
                    totals.netProfit >= 0 ? "text-green-600" : "text-red-600"
                  )}
                >
                  {formatCurrency(totals.netProfit)}
                </TableCell>
                <TableCell
                  className={cn(
                    "font-bold",
                    totals.profitMargin >= 0 ? "text-green-600" : "text-red-600"
                  )}
                >
                  {totals.profitMargin.toFixed(1)}%
                </TableCell>
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {sortedRows.length} of {rows.length} sold items
      </p>
    </div>
  );
}
