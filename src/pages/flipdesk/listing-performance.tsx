import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Eye,
  ExternalLink,
  Info,
  Lightbulb,
  RefreshCw,
  Repeat,
} from "lucide-react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingRegion, TableLoadingSkeleton } from "@/components/ui/skeletons";
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
import { useEbayConnection } from "@/hooks/use-ebay";
import { usePerformanceSuggestions } from "@/hooks/use-repricing";
import { cn } from "@/lib/utils";
import { CHART_PALETTE } from "@/lib/constants";

const DAY_MS = 24 * 60 * 60 * 1000;

interface PerfRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_url: string | null;
  listing_price: number;
  listed_at: string;
  views_total: number;
  watchers_count: number;
  impressions_7d: number;
  click_through_rate: number | null;
  last_metrics_synced_at: string | null;
  view_trend_7d: Array<{ date: string; views: number }> | null;
}

type SortKey =
  | "title"
  | "views_total"
  | "watchers_count"
  | "impressions_7d"
  | "click_through_rate"
  | "days_listed";

// US-1899: the stale-listing playbook works a 45-day zero-click window; keep the
// shorter 7/14/30 options too so a seller can tighten it.
const NO_VIEW_WINDOWS = [7, 14, 30, 45, 60] as const;

function daysListed(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / DAY_MS);
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "never";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function FlipdeskListingPerformancePage() {
  const user = useAuthStore((s) => s.user);
  const { data: connection } = useEbayConnection();
  const { data: suggestions = [] } = usePerformanceSuggestions();
  const confirm = useConfirm();
  const navigate = useNavigate();

  // US-1899: Sell Similar is a MANUAL last resort for 90+-day zero-engagement
  // listings — never auto. Gate it behind an explicit, destructive-styled
  // confirmation that spells out the cost (relisting resets the accumulated eBay
  // performance history), then hand off to the item page for the manual relist.
  async function handleSellSimilar(inventoryItemId: string) {
    const ok = await confirm({
      title: "Sell Similar is a last resort",
      description:
        "This listing has gone 90+ days with no views, watchers or clicks. " +
        "Sell Similar ends it and creates a NEW listing, which resets the " +
        "eBay performance history it has built. Try revising the title, photos " +
        "and price first. Open the item to relist manually?",
      confirmLabel: "Open item to relist",
      cancelLabel: "Keep revising",
      destructive: true,
    });
    if (ok) navigate(`/dashboard/flipdesk/items/${inventoryItemId}`);
  }

  const [sortKey, setSortKey] = useState<SortKey>("views_total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // null = chip off; otherwise the N-day no-views window.
  const [noViewDays, setNoViewDays] = useState<number | null>(null);

  const { data: listings = [], isLoading } = useQuery({
    queryKey: ["listing_performance", user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<PerfRow[]> => {
      const { data, error } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, listing_url, listing_price, listed_at, views_total, watchers_count, impressions_7d, click_through_rate, last_metrics_synced_at, view_trend_7d",
        )
        .eq("platform", "ebay")
        .eq("listing_status", "active")
        .order("views_total", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as PerfRow[];
    },
  });

  // Titles fall back to the inventory item when listing_title is blank.
  const itemIds = useMemo(
    () => Array.from(new Set(listings.map((l) => l.inventory_item_id))),
    [listings],
  );
  // Key on the id CONTENTS, not the count: when the set changes but its length
  // stays equal (one listing sells, another is added), a length-only key would
  // serve the previous id→title map and titles would resolve to the wrong item.
  const itemIdsKey = useMemo(() => [...itemIds].sort().join(","), [itemIds]);
  const { data: titles = {} } = useQuery<Record<string, string>>({
    queryKey: ["listing_performance_titles", user?.id, itemIdsKey],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      // Chunk the id list: a single `.in("id", [...])` with hundreds of UUIDs
      // builds a request URL that overflows the server's URL length limit
      // (observed ERR_FAILED on large catalogs). 100 ids/request keeps every
      // URL well under the cap.
      const map: Record<string, string> = {};
      const CHUNK = 100;
      for (let i = 0; i < itemIds.length; i += CHUNK) {
        const slice = itemIds.slice(i, i + CHUNK);
        const { data } = await supabase
          .from("inventory_items")
          .select("id, title")
          .in("id", slice);
        for (const r of (data ?? []) as Array<{ id: string; title: string }>) {
          map[r.id] = r.title;
        }
      }
      return map;
    },
  });

  const rows = useMemo(() => {
    const decorated = listings.map((l) => ({
      ...l,
      title: l.listing_title || titles[l.inventory_item_id] || "Untitled item",
      days: daysListed(l.listed_at),
    }));

    const filtered = noViewDays
      ? decorated.filter((r) => r.views_total === 0 && r.days >= noViewDays)
      : decorated;

    const sorted = [...filtered].sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case "title":
          av = a.title.toLowerCase();
          bv = b.title.toLowerCase();
          break;
        case "days_listed":
          av = a.days;
          bv = b.days;
          break;
        case "click_through_rate":
          av = a.click_through_rate ?? -1;
          bv = b.click_through_rate ?? -1;
          break;
        default:
          av = a[sortKey];
          bv = b[sortKey];
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [listings, titles, noViewDays, sortKey, sortDir]);

  const lastSynced = useMemo(() => {
    let latest: number | null = null;
    for (const l of listings) {
      if (!l.last_metrics_synced_at) continue;
      const t = new Date(l.last_metrics_synced_at).getTime();
      if (!isNaN(t) && (latest === null || t > latest)) latest = t;
    }
    return latest ? new Date(latest).toISOString() : null;
  }, [listings]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Text sorts read better ascending; metrics default to highest-first.
      setSortDir(key === "title" ? "asc" : "desc");
    }
  }

  const accessDenied = connection?.analytics_access_denied === true;

  // One-time toast when eBay hasn't granted Sell Analytics access, so the cue
  // isn't missed if the user scrolls past the banner.
  const warnedRef = useRef(false);
  useEffect(() => {
    if (accessDenied && !warnedRef.current) {
      warnedRef.current = true;
      toast.warning("eBay Sell Analytics access isn't granted", {
        description:
          "Reconnect your eBay account to pull views, impressions and click-through.",
      });
    }
  }, [accessDenied]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Listing Performance"
        subtitle="Views, watchers and impressions per active eBay listing. Spot duds before they age out."
        actions={
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5" />
            Synced {relativeTime(lastSynced)} · auto every 6h
          </div>
        }
      />

      {accessDenied && (
        <Card className="border-brand-red/40 bg-brand-red/5">
          <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm">
            <Info className="h-4 w-4 shrink-0 text-brand-red-text" />
            <span className="flex-1">
              eBay hasn't granted Sell Analytics access for your account, so
              views, impressions and click-through can't be pulled. Reconnect
              your eBay account to enable performance metrics.
            </span>
            <Button asChild size="sm" variant="outline">
              <Link to="/dashboard/flipdesk/marketplaces">Reconnect eBay</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {suggestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-brand-red-text" />
              Suggestions
              <Badge variant="outline">{suggestions.length}</Badge>
            </CardTitle>
            <CardDescription>
              Performance-driven nudges from views, watchers and click-through.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {suggestions.map((s) => (
              <div
                key={s.listing_id}
                className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
              >
                <Badge
                  variant={s.suggests_price_drop ? "destructive" : "secondary"}
                  className="shrink-0"
                >
                  {s.title_text}
                </Badge>
                <Link
                  to={`/dashboard/flipdesk/items/${s.inventory_item_id}`}
                  className="font-medium hover:underline"
                >
                  {s.title}
                </Link>
                <span className="w-full text-muted-foreground sm:w-auto sm:flex-1">
                  {s.message}
                </span>
                {s.sell_similar_eligible && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => handleSellSimilar(s.inventory_item_id)}
                  >
                    <Repeat className="mr-1 h-3.5 w-3.5" />
                    Sell Similar
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Active listings
                <Badge variant="outline">{rows.length}</Badge>
              </CardTitle>
              <CardDescription>
                Click a column header to sort.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                No views in:
              </span>
              {NO_VIEW_WINDOWS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() =>
                    setNoViewDays((cur) => (cur === n ? null : n))
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    noViewDays === n
                      ? "border-brand-navy bg-brand-navy text-white"
                      : "hover:border-brand-navy hover:bg-muted/40",
                  )}
                >
                  {n} days
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingRegion label="Loading listing performance">
              <TableLoadingSkeleton rows={6} columns={5} />
            </LoadingRegion>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {noViewDays
                ? `No active listings with zero views in ${noViewDays}+ days. Nice.`
                : "No active eBay listings yet. Publish a listing to start tracking performance."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead
                      label="Listing"
                      col="title"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <TableHead className="w-[120px]">7-day trend</TableHead>
                    <SortHead
                      label="Views"
                      col="views_total"
                      numeric
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHead
                      label="Watchers"
                      col="watchers_count"
                      numeric
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHead
                      label="Impr. (7d)"
                      col="impressions_7d"
                      numeric
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHead
                      label="CTR"
                      col="click_through_rate"
                      numeric
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHead
                      label="Listed"
                      col="days_listed"
                      numeric
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const stale = r.views_total === 0 && r.days >= 14;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="max-w-[280px]">
                          <Link
                            to={`/dashboard/flipdesk/items/${r.inventory_item_id}`}
                            className="block truncate font-medium hover:underline"
                          >
                            {r.title}
                          </Link>
                          {r.listing_url && (
                            <a
                              href={r.listing_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                            >
                              View on eBay
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </TableCell>
                        <TableCell>
                          <Sparkline trend={r.view_trend_7d} />
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {stale ? (
                            <Badge variant="destructive">0</Badge>
                          ) : (
                            num(r.views_total)
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {num(r.watchers_count)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {num(r.impressions_7d)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {pct(r.click_through_rate)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {r.days}d
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SortHead({
  label,
  col,
  numeric,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  numeric?: boolean;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <TableHead className={numeric ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          numeric && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

// A 100×32 inline-SVG sparkline. This is a single simple polyline, so rather
// than pull the entire Recharts library (~346KB) into the listing-performance
// route just for a table-row trend, we draw it by hand (US-408 AC: "consider a
// lighter lib for simple bar/line").
function Sparkline({
  trend,
}: {
  trend: Array<{ date: string; views: number }> | null;
}) {
  const data = Array.isArray(trend) ? trend : [];
  if (data.length < 2) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  // Rising trend reads positive (navy), flat/falling stays muted.
  const rising = data[data.length - 1]!.views >= data[0]!.views;

  const W = 100;
  const H = 32;
  const PAD = 3; // keep the 2px stroke off the top/bottom edges
  const views = data.map((d) => d.views);
  const min = Math.min(...views);
  const max = Math.max(...views);
  const span = max - min || 1; // flat series → centered line
  const stepX = W / (data.length - 1);
  const points = data
    .map((d, i) => {
      const x = i * stepX;
      // Invert: higher views sit nearer the top (smaller y).
      const y = PAD + (1 - (d.views - min) / span) * (H - PAD * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <div className="h-8 w-[100px]">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        role="img"
        aria-label="7-day view trend"
      >
        <polyline
          points={points}
          fill="none"
          stroke={rising ? CHART_PALETTE.navy : CHART_PALETTE.slate}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
