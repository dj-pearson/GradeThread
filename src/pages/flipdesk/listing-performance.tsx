import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Eye,
  ExternalLink,
  Info,
  Lightbulb,
  Loader2,
  RefreshCw,
  Repeat,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { edgeFetch } from "@/lib/edge-fetch";
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

// US-2826: photo count / quality score / grade against first-14-day traffic.
const ListingQualityLiftSection = lazy(() =>
  import("@/components/flipdesk/listing-quality-lift-section").then((m) => ({
    default: m.ListingQualityLiftSection,
  })),
);

const DAY_MS = 24 * 60 * 60 * 1000;

// Rows per page. Sent to the RPC as p_limit, so the server returns exactly
// what is rendered rather than a set the client then slices.
const PAGE_SIZE = 50;

interface PerfRow {
  id: string;
  inventory_item_id: string;
  // `title` not `listing_title`: the RPC resolves the inventory-item
  // fallback BEFORE it filters, which is what makes search match what is
  // actually displayed.
  title: string;
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

/**
 * US-2161: `embedded` renders this inside the Analytics tab set, which already
 * has its own PageHeader. It drops the redundant title and subtitle ONLY — the
 * header's action controls are preserved and re-rendered above the content,
 * because hiding a working control to tidy up the nav would be a feature
 * regression wearing a tidy-up's clothes.
 */
export function FlipdeskListingPerformancePage(
  { embedded = false }: { embedded?: boolean } = {},
) {
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

  const qc = useQueryClient();
  const [sortKey, setSortKey] = useState<SortKey>("views_total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // null = chip off; otherwise the N-day no-views window.
  const [noViewDays, setNoViewDays] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  // US-2233 AC3: ONE page, searched and sorted in the database (migration 00560).
  //
  // This used to be fetchAllPages over every active eBay listing, plus a second
  // chunked query to resolve titles, plus a client-side filter/sort/slice. That
  // was bounded (US-2169) but it still pulled a whole catalog into the browser
  // to render fifty rows, and its SEARCH WAS WRONG: it matched listing_title
  // only, so every listing whose displayed title came from the inventory item
  // was invisible to search. The RPC resolves the title before it filters, so
  // search now covers what the seller can actually see.
  //
  // The query key carries every input. Without search/sort/filter/page in it,
  // TanStack would serve the first page's cache for the second page — the
  // classic server-paging cache bug, and one that looks like "paging is broken"
  // rather than "the key is wrong".
  const { data: pageData, isLoading } = useQuery({
    queryKey: [
      "listing_performance",
      user?.id,
      search.trim(),
      noViewDays,
      sortKey,
      sortDir,
      page,
    ],
    enabled: !!user,
    staleTime: 60_000,
    // Keeps the previous page on screen while the next one loads, instead of
    // flashing the empty state between pages.
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<{ rows: PerfRow[]; total: number }> => {
      const { data, error } = await supabase.rpc(
        "flipdesk_listing_performance_page",
        {
          p_search: search.trim() || null,
          p_no_view_days: noViewDays ?? 0,
          // `days_listed` is a derived column the database does not have; it is
          // listed_at with the direction INVERTED, because more days listed
          // means an OLDER timestamp. Getting this backwards would silently
          // reverse the one sort a seller uses to find stale stock.
          p_sort: sortKey === "days_listed" ? "listed_at" : sortKey,
          p_desc: sortKey === "days_listed"
            ? sortDir === "asc"
            : sortDir === "desc",
          p_limit: PAGE_SIZE,
          p_offset: page * PAGE_SIZE,
        } as never,
      );
      if (error) throw error;
      const rows = (data ?? []) as Array<PerfRow & { total_count: number }>;
      return {
        rows,
        // total_count rides on every row, so an empty page legitimately means
        // zero matches — not "unknown", which would make pageCount collapse to
        // 1 and hide the pager on a page the seller navigated to directly.
        total: Number(rows[0]?.total_count ?? 0),
      };
    },
  });

  // The chunked titles query that used to live here is GONE (US-2233): the RPC
  // resolves the fallback title in SQL. It existed because a single .in("id",
  // [...]) with hundreds of UUIDs overflowed the request URL, so it fetched in
  // chunks of 100 — meaning a 900-listing catalog cost nine extra round trips
  // on every load. Doing the LEFT JOIN in the query removes all of them, and it
  // is also what makes search correct: the client could only search the titles
  // it had, and it had the wrong ones for any listing borrowing its item title.

  // US-2233: on-demand "Sync now" — refresh THIS seller's metrics instead of
  // waiting up to 6h for the cron. Server route is tenant-scoped to the caller.
  const syncNow = useMutation({
    mutationFn: async (): Promise<{ updated: number; accessDenied: boolean }> => {
      const res = await edgeFetch("/api/flipdesk/ebay/sync/performance/me", {
        method: "POST",
        json: {},
      });
      const json = (await res.json().catch(() => ({}))) as {
        updated?: number;
        accessDenied?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      return { updated: json.updated ?? 0, accessDenied: json.accessDenied ?? false };
    },
    onSuccess: async (r) => {
      if (r.accessDenied) {
        toast.warning("eBay Sell Analytics access isn't granted", {
          description: "Reconnect your eBay account to pull performance metrics.",
        });
      } else {
        toast.success(`Synced ${r.updated} listing${r.updated === 1 ? "" : "s"}.`);
      }
      await qc.invalidateQueries({ queryKey: ["listing_performance"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  // Rows arrive already searched, filtered, sorted and paged. The client-side
  // decorate/filter/sort/slice that used to live here is gone: keeping a copy of
  // that logic alongside the SQL would be two implementations of one contract,
  // and they would disagree the first time either changed.
  const pageRows = useMemo(
    () =>
      (pageData?.rows ?? []).map((l) => ({
        ...l,
        // The RPC returns the resolved title in `title`; the fallback chain that
        // used to run here moved into the query (that is what fixed search).
        title: l.title || "Untitled item",
        days: daysListed(l.listed_at),
      })),
    [pageData],
  );

  const total = pageData?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamped rather than trusted: a seller on page 9 who then types a search that
  // matches three listings must not be left staring at an empty page 9.
  const safePage = Math.min(page, pageCount - 1);

  // Any change to what is being asked for resets to the first page. Without
  // this, narrowing a search while deep in the pager shows a blank table and
  // reads as "search found nothing".
  useEffect(() => {
    setPage(0);
  }, [search, noViewDays, sortKey, sortDir]);

  // US-2233: the KPI tiles and "last synced" span EVERY active listing, not the
  // page on screen — which is exactly why the page used to have to load them
  // all. One aggregate query replaces that. Its key deliberately excludes
  // search/sort/page: these figures are about the whole catalog and must not
  // change when the seller narrows the table.
  const { data: summary } = useQuery({
    queryKey: ["listing_performance_summary", user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "flipdesk_listing_performance_summary" as never,
      );
      if (error) throw error;
      const r = (Array.isArray(data) ? data[0] : data) as
        | {
          total_listings: number;
          total_views: number;
          avg_ctr: number | null;
          stale_count: number;
          last_synced_at: string | null;
        }
        | undefined;
      return r ?? null;
    },
  });

  const kpis = useMemo(() => {
    const listingCount = Number(summary?.total_listings ?? 0);
    return {
      totalViews: Number(summary?.total_views ?? 0),
      // avg() skips NULL rates in SQL, matching the old client rule: a listing
      // eBay has never reported a CTR for must not be averaged in as a zero.
      avgCtr: summary?.avg_ctr == null ? null : Number(summary.avg_ctr),
      stalePct: listingCount > 0 ? Number(summary?.stale_count ?? 0) / listingCount : 0,
    };
  }, [summary]);

  const lastSynced = summary?.last_synced_at ?? null;


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
      {/* US-2161: the actions are defined once and rendered either inside the
          PageHeader (standalone) or on their own row (embedded in Analytics,
          which already has a header). Never dropped. */}
      {(() => {
        const actions = (
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              Synced {relativeTime(lastSynced)} · auto every 6h
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => syncNow.mutate()}
              disabled={syncNow.isPending}
            >
              {syncNow.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
              )}
              Sync now
            </Button>
          </div>
        );
        return embedded ? (
          <div className="flex justify-end">{actions}</div>
        ) : (
          <PageHeader
            title="Listing Performance"
            subtitle="Views, watchers and impressions per active eBay listing. Spot duds before they age out."
            actions={actions}
          />
        );
      })()}

      {/* US-2826: the same listing_metrics history this page shows per listing,
          read against how each listing was built. */}
      <Suspense fallback={null}>
        <ListingQualityLiftSection periodStart={null} />
      </Suspense>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total views
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{num(kpis.totalViews)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg CTR
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pct(kpis.avgCtr)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Stale (0 views, 14d+)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pct(kpis.stalePct)}</div>
          </CardContent>
        </Card>
      </div>

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
                    aria-label={`Sell an item similar to ${s.title}`}
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
                <Badge variant="outline">{total}</Badge>
              </CardTitle>
              <CardDescription>
                Click a column header to sort.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                aria-label="Search active listings by title"
                placeholder="Search title…"
                className="h-8 w-44"
              />
              <span className="text-xs text-muted-foreground">
                No views in:
              </span>
              {NO_VIEW_WINDOWS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    setNoViewDays((cur) => (cur === n ? null : n));
                    setPage(0);
                  }}
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
          ) : pageRows.length === 0 ? (
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
                  {pageRows.map((r) => {
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
              {pageCount > 1 && (
                <div className="flex items-center justify-between pt-3 text-sm">
                  <span className="text-muted-foreground">
                    {safePage * PAGE_SIZE + 1}–
                    {Math.min(total, safePage * PAGE_SIZE + PAGE_SIZE)} of{" "}
                    {total}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage === 0}
                      onClick={() => setPage(safePage - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setPage(safePage + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}

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
