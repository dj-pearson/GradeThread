import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Package,
  DollarSign,
  TrendingUp,
  Clock,
  AlertCircle,
  ArrowRight,
  Tag,
  Plus,
  Upload,
  Eye,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  ITEM_STATUS_LABELS,
  FLIPDESK_PIPELINE,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ItemFullRow, ItemStatus } from "@/types/database";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const AGING_THRESHOLD_DAYS = 14;

// Statuses still "in progress" — used to count aging items and inventory value.
const ACTIVE_STATUSES = new Set<ItemStatus>([
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "grading",
  "graded",
  "comped",
  "drafted",
  "listed",
]);

function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function fmtMoneyShort(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "$0";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

export function FlipdeskOverviewPage() {
  const user = useAuthStore((s) => s.user);

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

  const stats = useMemo(() => {
    const now = Date.now();
    const weekAgo = now - WEEK_MS;

    const byStatus = new Map<ItemStatus, number>();
    let listedThisWeek = 0;
    let soldThisWeek = 0;
    let soldRevenueThisWeek = 0;
    let netProfitThisWeek = 0;
    let inventoryValue = 0;
    const agingItems: Array<{ item: ItemFullRow; days: number }> = [];
    // US-151: active listings that have been live > 14 days with zero watchers —
    // strong "dud" signal worth a price drop or relist.
    const staleListings: Array<{ item: ItemFullRow; days: number }> = [];
    const brandProfit = new Map<string, { profit: number; sold: number }>();

    for (const it of items) {
      byStatus.set(it.status, (byStatus.get(it.status) ?? 0) + 1);

      const listedAt = it.list_date ? new Date(it.list_date).getTime() : null;
      if (listedAt && listedAt >= weekAgo) listedThisWeek++;

      if (
        it.listing_status === "active" &&
        listedAt != null &&
        (it.listing_watchers ?? 0) === 0
      ) {
        const listedDays = Math.floor((now - listedAt) / DAY_MS);
        if (listedDays >= AGING_THRESHOLD_DAYS) {
          staleListings.push({ item: it, days: listedDays });
        }
      }

      // Only COMPLETED sales count — a cancelled/refunded order was never a
      // real sale (00111 adds items_full.sale_status).
      const soldAt = it.sale_date ? new Date(it.sale_date).getTime() : null;
      const isCompletedSale = it.sale_status === "completed";
      if (soldAt && soldAt >= weekAgo && isCompletedSale) {
        soldThisWeek++;
        soldRevenueThisWeek += it.sale_price ?? 0;
        netProfitThisWeek += it.net_profit ?? 0;
      }

      // Inventory value = MARKET value (matches eBay): active listing price,
      // falling back to target_price when not yet listed — NOT cost basis.
      if (ACTIVE_STATUSES.has(it.status)) {
        inventoryValue += it.list_price ?? it.target_price ?? 0;
      }

      const updatedDays = daysSince(it.updated_at);
      if (
        ACTIVE_STATUSES.has(it.status) &&
        updatedDays != null &&
        updatedDays >= AGING_THRESHOLD_DAYS
      ) {
        agingItems.push({ item: it, days: updatedDays });
      }

      if (it.brand && it.net_profit != null && soldAt && isCompletedSale) {
        const key = it.brand;
        const existing = brandProfit.get(key) ?? { profit: 0, sold: 0 };
        brandProfit.set(key, {
          profit: existing.profit + it.net_profit,
          sold: existing.sold + 1,
        });
      }
    }

    agingItems.sort((a, b) => b.days - a.days);
    staleListings.sort((a, b) => b.days - a.days);

    const topBrands = [...brandProfit.entries()]
      .map(([brand, v]) => ({ brand, ...v }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5);

    const recentSales = items
      .filter((it) => it.sale_date)
      .sort((a, b) => {
        const at = a.sale_date ? new Date(a.sale_date).getTime() : 0;
        const bt = b.sale_date ? new Date(b.sale_date).getTime() : 0;
        return bt - at;
      })
      .slice(0, 6);

    return {
      total: items.length,
      byStatus,
      listedThisWeek,
      soldThisWeek,
      soldRevenueThisWeek,
      netProfitThisWeek,
      inventoryValue,
      agingItems: agingItems.slice(0, 5),
      agingCount: agingItems.length,
      staleListings: staleListings.slice(0, 5),
      staleCount: staleListings.length,
      topBrands,
      recentSales,
    };
  }, [items]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            What's moving, what's stuck, and what's making money.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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

      {/* Top metrics */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Package className="h-5 w-5" />}
          label="Total items"
          value={stats.total.toLocaleString()}
          sub={fmtMoney(stats.inventoryValue) + " inventory value"}
          to="/dashboard/flipdesk/items?view=all"
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="Listed this week"
          value={stats.listedThisWeek.toLocaleString()}
          sub="items moved to listed in last 7d"
          to="/dashboard/flipdesk/items?status=listed"
        />
        <StatCard
          icon={<Tag className="h-5 w-5" />}
          label="Sold this week"
          value={stats.soldThisWeek.toLocaleString()}
          sub={fmtMoney(stats.soldRevenueThisWeek) + " gross"}
          to="/dashboard/flipdesk/items?status=sold"
        />
        <StatCard
          icon={<DollarSign className="h-5 w-5" />}
          label="Net profit (7d)"
          value={fmtMoney(stats.netProfitThisWeek)}
          sub={
            stats.soldThisWeek > 0
              ? `${fmtMoneyShort(stats.netProfitThisWeek / stats.soldThisWeek)} avg / item`
              : "no sales this week"
          }
          to="/dashboard/flipdesk/items?status=completed"
        />
      </div>

      {/* Pipeline status grid */}
      <Card>
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>
            Click a stage to filter the items view.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {FLIPDESK_PIPELINE.map((step) => {
                const count = stats.byStatus.get(step.status) ?? 0;
                return (
                  <Link
                    key={step.status}
                    to={`/dashboard/flipdesk/items?status=${step.status}`}
                    className="group rounded-lg border bg-card p-3 transition-colors hover:border-brand-navy hover:bg-muted/40"
                  >
                    <div className="text-xs text-muted-foreground">
                      {step.label}
                    </div>
                    <div className="mt-1 flex items-baseline justify-between">
                      <div
                        className={cn(
                          "text-2xl font-bold tabular-nums",
                          count === 0 && "text-muted-foreground/50",
                        )}
                      >
                        {count.toLocaleString()}
                      </div>
                      <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Aging items */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Aging items
                </CardTitle>
                <CardDescription>
                  Stuck in the same status &gt; {AGING_THRESHOLD_DAYS} days
                </CardDescription>
              </div>
              <Badge variant={stats.agingCount > 0 ? "destructive" : "outline"}>
                {stats.agingCount}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {stats.agingItems.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Nothing stuck. Pipeline is flowing.
              </div>
            ) : (
              <ul className="space-y-2 text-sm">
                {stats.agingItems.map(({ item, days }) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded-md border p-2 hover:bg-muted/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {item.item_title}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {ITEM_STATUS_LABELS[item.status]}
                        {item.brand ? ` · ${item.brand}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-destructive">
                      <AlertCircle className="h-3 w-3" />
                      {days}d
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Top brands by profit */}
        <Card>
          <CardHeader>
            <CardTitle>Top brands by profit</CardTitle>
            <CardDescription>
              All-time net profit per brand on sold items
            </CardDescription>
          </CardHeader>
          <CardContent>
            {stats.topBrands.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No sold items with brand + net profit yet.
              </div>
            ) : (
              <ul className="space-y-2 text-sm">
                {stats.topBrands.map((b) => (
                  <li
                    key={b.brand}
                    className="flex items-center justify-between rounded-md border p-2 hover:bg-muted/40"
                  >
                    <div>
                      <div className="font-medium">{b.brand}</div>
                      <div className="text-xs text-muted-foreground">
                        {b.sold} sold
                      </div>
                    </div>
                    <div className="font-mono tabular-nums">
                      {fmtMoney(b.profit)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stale listings (US-151): live > 14d with zero watchers */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Stale listings
              </CardTitle>
              <CardDescription>
                Active &gt; {AGING_THRESHOLD_DAYS} days with zero watchers
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={stats.staleCount > 0 ? "destructive" : "outline"}>
                {stats.staleCount}
              </Badge>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/dashboard/flipdesk/analytics/performance">
                  Performance
                  <ArrowRight className="ml-1 h-3 w-3" />
                </Link>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {stats.staleListings.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No stale listings. Everything's getting eyes.
            </div>
          ) : (
            <ul className="space-y-2 text-sm">
              {stats.staleListings.map(({ item, days }) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-2 hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/dashboard/flipdesk/items/${item.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {item.item_title}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {fmtMoney(item.list_price)}
                      {item.brand ? ` · ${item.brand}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <Clock className="h-3 w-3" />
                    {days}d listed
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Recent sales */}
      <Card>
        <CardHeader>
          <CardTitle>Recent sales</CardTitle>
          <CardDescription>Last 6 items sold</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.recentSales.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No sales yet.
            </div>
          ) : (
            <ul className="divide-y">
              {stats.recentSales.map((it) => (
                <li
                  key={it.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{it.item_title}</div>
                    <div className="text-xs text-muted-foreground">
                      {it.sale_date?.slice(0, 10)}
                      {it.brand ? ` · ${it.brand}` : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm tabular-nums">
                      {fmtMoney(it.sale_price)}
                    </div>
                    {it.net_profit != null && (
                      <div className="font-mono text-xs tabular-nums text-muted-foreground">
                        net {fmtMoney(it.net_profit)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  to,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group rounded-lg border bg-card p-4 transition-colors hover:border-brand-navy"
    >
      <div className="flex items-center justify-between text-muted-foreground">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide">
          {icon}
          {label}
        </div>
        <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </Link>
  );
}
