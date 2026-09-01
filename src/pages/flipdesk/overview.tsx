import { useCallback, useState } from "react";
import { Link } from "react-router";
import { useRepricingSuggestions } from "@/hooks/use-repricing";
import { ErrorState } from "@/components/ui/error-state";
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
  ShieldCheck,
  TrendingDown,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ITEM_STATUS_LABELS,
  FLIPDESK_PIPELINE,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { NorthStarCard } from "@/components/flipdesk/north-star-card";
import { CommunityInsightsWidget } from "@/components/flipdesk/community-insights-widget";
import { useUrlParamState } from "@/hooks/use-url-param-state";
import {
  DEFAULT_OVERVIEW_RANGE,
  isOverviewRangeId,
  overviewRangeDef,
  OVERVIEW_RANGES,
} from "@/lib/overview-range";
import {
  useFlipdeskOverview,
  OVERVIEW_AGING_DAYS,
  type OverviewAgingRow,
  type OverviewStaleRow,
} from "@/hooks/use-flipdesk-overview";
import type { ItemStatus } from "@/types/database";
import { useReviewApproveMedian } from "@/hooks/use-review-flow";
import { useTimeSaved } from "@/hooks/use-time-saved";
import { formatMinutes, TIME_SAVED_LABELS } from "@/lib/time-saved";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatDuration } from "@/lib/review-flow";

// How many rows each list card shows before "show all" (US-2547). The aggregate
// returns up to OVERVIEW_LIST_LIMIT, so "all" means "all it sent" — the copy
// says so when the account has more than that.
const PREVIEW_ROWS = 5;

function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function fmtMoneyShort(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "$0";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

// US-859: dismissed stale-listing nudges, persisted per browser so a seller who
// has already acted on (or ignored) a nudge isn't shown it again. Keyed by item
// id; kept tiny and resilient to storage being unavailable (private mode).
const STALE_NUDGE_DISMISS_KEY = "gt:flipdesk:stale-nudge-dismissed";

function readDismissedNudges(): Set<string> {
  try {
    const raw = localStorage.getItem(STALE_NUDGE_DISMISS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function useDismissedStaleNudges() {
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissedNudges);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem(
          STALE_NUDGE_DISMISS_KEY,
          JSON.stringify([...next]),
        );
      } catch {
        // Best-effort; still hidden for this session.
      }
      return next;
    });
  }, []);

  return { dismissed, dismiss };
}

export function FlipdeskOverviewPage() {
  // US-2547: the reporting window lives in the URL so a seller can bookmark
  // "last 30 days" and hand the link to a partner.
  const [rangeParam, setRangeParam] = useUrlParamState(
    "range",
    DEFAULT_OVERVIEW_RANGE,
  );
  const range = isOverviewRangeId(rangeParam)
    ? rangeParam
    : DEFAULT_OVERVIEW_RANGE;
  const rangeDef = overviewRangeDef(range);

  // US-2547: every figure below is aggregated in SQL. This page used to read
  // every items_full row the account owned and loop it in the browser.
  const {
    data: metrics,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useFlipdeskOverview(range);

  // US-859: dismissible "grade to boost trust" / "reprice or relist" nudges on
  // stale listings. Reuse the existing repricing suggestions where available so
  // the graded-item nudge can show a concrete recommendation. Failure here is
  // non-fatal — the nudge falls back to a generic reprice/relist prompt.
  const { dismissed: dismissedNudges, dismiss: dismissNudge } =
    useDismissedStaleNudges();
  const { data: repriceSuggestions = [] } = useRepricingSuggestions();
  const repriceByItem = new Map<string, string>();
  for (const s of repriceSuggestions) {
    if (s.reason_code === "OK") continue;
    if (!repriceByItem.has(s.inventory_item_id)) {
      repriceByItem.set(s.inventory_item_id, s.message);
    }
  }

  // US-9204: the seller's median seconds from first photo to Approve. Shown
  // only once an item has gone through the review screen; a dash for a number
  // nobody has produced yet would read as a broken stat.
  const { data: reviewMedian } = useReviewApproveMedian();
  // US-9207: hours FlipDesk saved this month, summed by the server from the
  // rows each automated task left behind. Zero is shown as zero: a seller who
  // has not used the automations yet should see what the number is for.
  const { data: timeSaved } = useTimeSaved();

  const agingRows = metrics?.agingItems ?? [];
  const staleRows = metrics?.staleListings ?? [];
  const [showAllAging, setShowAllAging] = useState(false);
  const [showAllStale, setShowAllStale] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        subtitle="What's moving, what's stuck, and what's making money."
        actions={
          <>
            <Select
              value={range}
              onValueChange={(v) => {
                setRangeParam(v);
                setShowAllAging(false);
                setShowAllStale(false);
              }}
            >
              <SelectTrigger className="w-[150px]" aria-label="Reporting period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OVERVIEW_RANGES.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          </>
        }
      />

      {isError ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState
              title="Couldn't load your overview"
              description="Something went wrong while loading your FlipDesk data. This is usually temporary."
              onRetry={() => refetch()}
              retrying={isFetching}
            />
          </CardContent>
        </Card>
      ) : (
        <>
      {/* North Star (US-597): weekly items-listed goal + streak. The PRD North
          Star is Items-Listed-Per-Week — surface + gamify it front and center. */}
      <div className="max-w-md">
        <NorthStarCard
          weeks={metrics?.listWeeks ?? []}
          lifetimeListed={metrics?.lifetimeListed}
        />
      </div>

      {/* Top metrics */}
      {isLoading ? (
        <LoadingRegion label="Loading your numbers">
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            aria-hidden="true"
          >
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[104px] w-full rounded-lg" />
            ))}
          </div>
        </LoadingRegion>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<Package className="h-5 w-5" />}
            label="Total items"
            value={(metrics?.total ?? 0).toLocaleString()}
            sub={fmtMoney(metrics?.inventoryValue) + " inventory value, now"}
            to="/dashboard/flipdesk/items?status=all"
          />
          <StatCard
            icon={<TrendingUp className="h-5 w-5" />}
            label="Listed"
            value={(metrics?.listedInRange ?? 0).toLocaleString()}
            sub={`items moved to listed ${rangeDef.phrase}`}
            to="/dashboard/flipdesk/items?status=listed"
          />
          <StatCard
            icon={<Tag className="h-5 w-5" />}
            label="Sold"
            value={(metrics?.soldInRange ?? 0).toLocaleString()}
            sub={`${fmtMoney(metrics?.grossInRange)} gross ${rangeDef.phrase}`}
            to="/dashboard/flipdesk/items?status=sold"
          />
          <StatCard
            icon={<DollarSign className="h-5 w-5" />}
            label="Net profit"
            value={fmtMoney(metrics?.netInRange)}
            sub={
              (metrics?.soldInRange ?? 0) > 0
                ? `${fmtMoneyShort((metrics?.netInRange ?? 0) / (metrics?.soldInRange ?? 1))} avg / item`
                : `no sales ${rangeDef.phrase}`
            }
            to="/dashboard/flipdesk/items?tab=sold"
          />
          {timeSaved ? (
            <TimeSavedTile
              totalMinutes={timeSaved.totalMinutes}
              lines={timeSaved.lines}
              month={timeSaved.month}
            />
          ) : null}
          {reviewMedian?.median != null ? (
            <StatCard
              icon={<Clock className="h-5 w-5" />}
              label="Photos to Approve"
              value={formatDuration(reviewMedian.median)}
              sub={`median over ${reviewMedian.count} reviewed item${reviewMedian.count === 1 ? "" : "s"}`}
              to="/dashboard/flipdesk/intake"
            />
          ) : null}
        </div>
      )}

      {/* Pipeline status grid */}
      <Card>
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <CardDescription>
            Click a stage to see the items in it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingRegion label="Loading pipeline">
              <div
                className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
                aria-hidden="true"
              >
                {FLIPDESK_PIPELINE.map((step) => (
                  <Skeleton key={step.status} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            </LoadingRegion>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {FLIPDESK_PIPELINE.map((step) => {
                const count = metrics?.byStatus?.[step.status] ?? 0;
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

      {/* Community recommendations (US-1064): sourcing + pricing suggestions
          derived from anonymized community benchmarks. Self-hides when there's
          no signal or on error. */}
      <CommunityInsightsWidget />

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
                  Stuck in the same status &gt; {OVERVIEW_AGING_DAYS} days, right now
                </CardDescription>
              </div>
              <Badge
                variant={
                  (metrics?.agingCount ?? 0) > 0 ? "destructive" : "outline"
                }
              >
                {metrics?.agingCount ?? 0}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {agingRows.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Nothing stuck. Pipeline is flowing.
              </div>
            ) : (
              <>
                <ul className="space-y-2 text-sm">
                  {(showAllAging
                    ? agingRows
                    : agingRows.slice(0, PREVIEW_ROWS)
                  ).map((row) => (
                    <AgingRow key={row.id} row={row} />
                  ))}
                </ul>
                <ShowAllToggle
                  shown={agingRows.length}
                  total={metrics?.agingCount ?? agingRows.length}
                  expanded={showAllAging}
                  onToggle={() => setShowAllAging((v) => !v)}
                  noun="aging items"
                />
              </>
            )}
          </CardContent>
        </Card>

        {/* Top brands by profit */}
        <Card>
          <CardHeader>
            <CardTitle>Top brands by profit</CardTitle>
            <CardDescription>
              Net profit per brand on items sold {rangeDef.phrase}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(metrics?.topBrands ?? []).length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No sold items with brand + net profit {rangeDef.phrase}.
              </div>
            ) : (
              <ul className="space-y-2 text-sm">
                {(metrics?.topBrands ?? []).map((b) => (
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
                Active &gt; {OVERVIEW_AGING_DAYS} days with zero watchers, right now
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  (metrics?.staleCount ?? 0) > 0 ? "destructive" : "outline"
                }
              >
                {metrics?.staleCount ?? 0}
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
          {staleRows.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No stale listings. Everything's getting eyes.
            </div>
          ) : (
            <>
              <ul className="space-y-2 text-sm">
                {(showAllStale ? staleRows : staleRows.slice(0, PREVIEW_ROWS)).map(
                  (row) => (
                    <li
                      key={row.id}
                      className="space-y-2 rounded-md border p-2 hover:bg-muted/40"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <Link
                            to={`/dashboard/flipdesk/items/${row.id}`}
                            className="block truncate font-medium hover:underline"
                          >
                            {row.item_title}
                          </Link>
                          <div className="text-xs text-muted-foreground">
                            {fmtMoney(row.list_price)}
                            {row.brand ? ` · ${row.brand}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-destructive">
                          <Clock className="h-3 w-3" />
                          {row.days}d listed
                        </div>
                      </div>
                      {!dismissedNudges.has(row.id) && (
                        <StaleNudge
                          row={row}
                          repriceMessage={repriceByItem.get(row.id) ?? null}
                          onDismiss={() => dismissNudge(row.id)}
                        />
                      )}
                    </li>
                  ),
                )}
              </ul>
              <ShowAllToggle
                shown={staleRows.length}
                total={metrics?.staleCount ?? staleRows.length}
                expanded={showAllStale}
                onToggle={() => setShowAllStale((v) => !v)}
                noun="stale listings"
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* Recent sales */}
      <Card>
        <CardHeader>
          <CardTitle>Recent sales</CardTitle>
          <CardDescription>Last 6 items sold {rangeDef.phrase}</CardDescription>
        </CardHeader>
        <CardContent>
          {(metrics?.recentSales ?? []).length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No sales {rangeDef.phrase}.
            </div>
          ) : (
            <ul className="divide-y">
              {(metrics?.recentSales ?? []).map((it) => (
                <li
                  key={it.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/dashboard/flipdesk/items/${it.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {it.item_title}
                    </Link>
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
        </>
      )}
    </div>
  );
}

/**
 * "Show all" for a card that previews five of N (US-2547).
 *
 * `shown` is what the aggregate actually sent and `total` is what exists, and
 * they differ once an account passes the aggregate's row cap. Saying "show all
 * 50" when 214 items are stuck would be the same broken promise as the pipeline
 * tile that offered a filter it could not apply, so the copy names both numbers
 * and points at the list that can show the rest.
 */
function ShowAllToggle({
  shown,
  total,
  expanded,
  onToggle,
  noun,
}: {
  shown: number;
  total: number;
  expanded: boolean;
  onToggle: () => void;
  noun: string;
}) {
  if (shown <= PREVIEW_ROWS) return null;
  const capped = total > shown;
  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
      <Button variant="ghost" size="sm" onClick={onToggle}>
        {expanded
          ? "Show fewer"
          : capped
            ? `Show ${shown} of ${total} ${noun}`
            : `Show all ${shown} ${noun}`}
      </Button>
      {capped && expanded && (
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard/flipdesk/items">
            See every item
            <ArrowRight className="ml-1 h-3 w-3" />
          </Link>
        </Button>
      )}
    </div>
  );
}

// An aging row links to its item, the same as a stale row does. They were the
// same shape of row with only one of them clickable, so the fix for a stuck
// item was one click away on one card and a search away on the other.
function AgingRow({ row }: { row: OverviewAgingRow }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border p-2 hover:bg-muted/40">
      <div className="min-w-0 flex-1">
        <Link
          to={`/dashboard/flipdesk/items/${row.id}`}
          className="block truncate font-medium hover:underline"
        >
          {row.item_title}
        </Link>
        <div className="text-xs text-muted-foreground">
          {ITEM_STATUS_LABELS[row.status as ItemStatus] ?? row.status}
          {row.brand ? ` · ${row.brand}` : ""}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-destructive">
        <AlertCircle className="h-3 w-3" />
        {row.days}d
      </div>
    </li>
  );
}

// US-9207: the time-saved tile. The number is the seller's own; the breakdown
// on click names each task and how many times FlipDesk did it. A task the
// seller skipped is not in the list, because the server never counted it.
function TimeSavedTile({
  totalMinutes,
  lines,
  month,
}: {
  totalMinutes: number;
  lines: { task: keyof typeof TIME_SAVED_LABELS; count: number; minutes: number }[];
  month: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="group rounded-lg border bg-card p-4 text-left transition-colors hover:border-brand-navy"
          aria-label={`You saved ${formatMinutes(totalMinutes)} this month. Show the breakdown.`}
        >
          <div className="flex items-center justify-between text-muted-foreground">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Clock className="h-5 w-5" />
              Time saved
            </div>
            <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums">{formatMinutes(totalMinutes)}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {totalMinutes > 0 ? "this month, on work FlipDesk did for you" : "nothing automated yet this month"}
          </div>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>You saved {formatMinutes(totalMinutes)} in {month}</DialogTitle>
          <DialogDescription>
            Only work FlipDesk actually did is counted. Anything you skipped or did by hand is not here.
          </DialogDescription>
        </DialogHeader>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No automated tasks ran this month. Edit a photo, read measurements from a photo, write a listing with AI, price from comps or cross-list an item and it shows up here.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {lines.map((l) => (
              <li key={l.task} className="flex items-center justify-between gap-3">
                <span>
                  {TIME_SAVED_LABELS[l.task]}
                  <span className="text-muted-foreground"> x{l.count}</span>
                </span>
                <span className="tabular-nums">{formatMinutes(l.minutes)}</span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
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
        <div className="flex items-center gap-2 text-xs font-medium">
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

// US-859: the actionable nudge on a stale listing. Ungraded items get a "grade
// to boost trust" prompt into that item's grading flow; already-graded items
// get a reprice/relist prompt (preferring a concrete repricing suggestion when
// one exists). Dismissible via the X — persisted per browser by the caller.
function StaleNudge({
  row,
  repriceMessage,
  onDismiss,
}: {
  row: OverviewStaleRow;
  repriceMessage: string | null;
  onDismiss: () => void;
}) {
  const isGraded = row.grade_value != null;

  const icon = isGraded ? (
    <TrendingDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-navy dark:text-foreground" />
  ) : (
    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-navy dark:text-foreground" />
  );

  const text = isGraded
    ? (repriceMessage ??
      "No watchers in 2+ weeks — drop the price or relist to get fresh eyes.")
    : "Grade this item to add a verified condition badge + certificate — graded listings earn more buyer trust.";

  const cta = isGraded
    ? { label: "Reprice", to: "/dashboard/flipdesk/pricing?tab=repricing" }
    : {
        label: "Grade it",
        to: `/dashboard/flipdesk/items/${row.id}#canvas-grading`,
      };

  return (
    <div className="flex items-start gap-2 rounded-md border border-brand-navy/30 bg-brand-navy/5 px-2.5 py-2">
      {icon}
      <p className="flex-1 text-xs text-foreground">{text}</p>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" asChild>
          <Link to={cta.to}>
            {cta.label}
            <ArrowRight className="h-3 w-3" />
          </Link>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground"
          onClick={onDismiss}
          aria-label="Dismiss nudge"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
