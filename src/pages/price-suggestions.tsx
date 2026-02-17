import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Lightbulb,
  ArrowRight,
  TrendingDown,
  TrendingUp,
  Minus,
  AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useAuthStore } from "@/stores/auth-store";
import { calculateSuggestedPrice } from "@/lib/price-suggestions";
import type {
  InventoryItemRow,
  ListingRow,
  SaleRow,
  GradeReportRow,
} from "@/types/database";

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function PriceSuggestionsPage() {
  const { user } = useAuthStore();
  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [gradeReports, setGradeReports] = useState<GradeReportRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    async function fetchData() {
      setLoading(true);

      const [itemsRes, listingsRes, salesRes, gradesRes] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("*")
          .eq("user_id", user!.id)
          .in("status", ["acquired", "grading", "graded", "listed"]),
        supabase.from("listings").select("*"),
        supabase.from("sales").select("*"),
        supabase.from("grade_reports").select("*"),
      ]);

      setItems((itemsRes.data ?? []) as InventoryItemRow[]);
      setListings((listingsRes.data ?? []) as ListingRow[]);
      setSales((salesRes.data ?? []) as SaleRow[]);
      setGradeReports((gradesRes.data ?? []) as GradeReportRow[]);
      setLoading(false);
    }

    fetchData();
  }, [user]);

  // Build suggestions for each item
  const suggestions = useMemo(() => {
    // Build sales history lookup
    const salesHistory = sales.map((sale) => {
      const saleItem = items.find((i) => i.id === sale.inventory_item_id);
      return saleItem
        ? { item: saleItem, sale, grade: null as number | null }
        : null;
    }).filter((h): h is NonNullable<typeof h> => h !== null);

    // Also include items from ALL user inventory for comparison (items already fetched)
    const allItemsMap = new Map(items.map((i) => [i.id, i]));

    // Build full sales history using all available items
    const fullSalesHistory = sales
      .map((sale) => {
        const saleItem = allItemsMap.get(sale.inventory_item_id);
        return saleItem
          ? { item: saleItem, sale, grade: null as number | null }
          : null;
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);

    const gradeMap = new Map(gradeReports.map((g) => [g.id, g]));
    const listingsByItem = new Map<string, ListingRow[]>();
    for (const listing of listings) {
      const existing = listingsByItem.get(listing.inventory_item_id) ?? [];
      existing.push(listing);
      listingsByItem.set(listing.inventory_item_id, existing);
    }

    return items
      .map((item) => {
        const itemListings = listingsByItem.get(item.id) ?? [];
        const gradeReport = item.grade_report_id
          ? gradeMap.get(item.grade_report_id) ?? null
          : null;
        const grade = gradeReport?.overall_score ?? null;

        const suggestion = calculateSuggestedPrice(
          item,
          grade,
          itemListings,
          fullSalesHistory.length > 0 ? fullSalesHistory : salesHistory
        );

        const activeListings = itemListings.filter((l) => l.is_active);
        const daysListed =
          activeListings.length > 0
            ? Math.max(
                ...activeListings.map((l) => {
                  const d = new Date(l.listed_at);
                  return Math.floor(
                    (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)
                  );
                })
              )
            : 0;

        return {
          item,
          suggestion,
          grade,
          daysListed,
          currentPrice: suggestion.currentPrice,
        };
      })
      .sort((a, b) => {
        // Sort by severity: urgent first, then warning, then info
        const severityOrder = { urgent: 0, warning: 1, info: 2 };
        const aSev = severityOrder[a.suggestion.severity];
        const bSev = severityOrder[b.suggestion.severity];
        if (aSev !== bSev) return aSev - bSev;
        // Then by days listed descending
        return b.daysListed - a.daysListed;
      });
  }, [items, listings, sales, gradeReports]);

  const urgentCount = suggestions.filter(
    (s) => s.suggestion.severity === "urgent"
  ).length;
  const warningCount = suggestions.filter(
    (s) => s.suggestion.severity === "warning"
  ).length;

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-2 h-4 w-96" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Price Suggestions</h1>
        <p className="text-sm text-muted-foreground">
          Pricing recommendations based on grade, brand, category, and time on
          market.
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Items</CardDescription>
            <CardTitle className="text-2xl">{suggestions.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Active inventory with suggestions
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Urgent Actions</CardDescription>
            <CardTitle className="text-2xl text-red-600">
              {urgentCount}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Items listed 60+ days needing attention
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Warnings</CardDescription>
            <CardTitle className="text-2xl text-yellow-600">
              {warningCount}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Items that may benefit from price adjustment
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Suggestions Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4" />
            All Recommendations
          </CardTitle>
          <CardDescription>
            Click any item to view its detail page and adjust pricing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {suggestions.length === 0 ? (
            <div className="py-12 text-center">
              <Lightbulb className="mx-auto h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 text-lg font-medium">
                No active inventory items
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Add items to your inventory to get pricing recommendations.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead className="text-right">Current Price</TableHead>
                    <TableHead className="text-right">
                      Suggested Price
                    </TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead>Days Listed</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suggestions.map(({ item, suggestion, grade, daysListed }) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        {suggestion.severity === "urgent" ? (
                          <AlertTriangle className="h-4 w-4 text-red-500" />
                        ) : suggestion.severity === "warning" ? (
                          <AlertTriangle className="h-4 w-4 text-yellow-500" />
                        ) : (
                          <Minus className="h-4 w-4 text-blue-400" />
                        )}
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="font-medium">{item.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {[item.brand, item.garment_category ? formatLabel(item.garment_category) : null]
                              .filter(Boolean)
                              .join(" · ") || "—"}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        {grade !== null ? (
                          <Badge variant="outline">{grade.toFixed(1)}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            N/A
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(suggestion.currentPrice)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {suggestion.suggestedPrice !== null
                          ? formatCurrency(suggestion.suggestedPrice)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {suggestion.adjustmentPercent !== null ? (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 text-sm font-medium",
                              suggestion.adjustmentPercent > 0
                                ? "text-green-600"
                                : "text-red-600"
                            )}
                          >
                            {suggestion.adjustmentPercent > 0 ? (
                              <TrendingUp className="h-3 w-3" />
                            ) : (
                              <TrendingDown className="h-3 w-3" />
                            )}
                            {suggestion.adjustmentPercent > 0 ? "+" : ""}
                            {suggestion.adjustmentPercent}%
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "text-sm",
                            daysListed > 60
                              ? "font-medium text-red-600"
                              : daysListed > 30
                                ? "font-medium text-yellow-600"
                                : ""
                          )}
                        >
                          {daysListed > 0 ? `${daysListed}d` : "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <p className="max-w-[200px] truncate text-xs text-muted-foreground">
                          {suggestion.action}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/dashboard/inventory/${item.id}`}
                          className="inline-flex items-center text-sm text-brand-navy hover:underline"
                        >
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
