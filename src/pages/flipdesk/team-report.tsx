import { Fragment, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  Hourglass,
  TrendingDown,
  Users,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { TableLoadingSkeleton } from "@/components/ui/skeletons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { downloadCsv } from "@/lib/csv-export";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  AGE_BUCKETS,
  DEFAULT_TARGET_MARGIN,
  EMPTY_DEAD_CAPITAL,
  EMPTY_MISS_REPORT,
  EMPTY_SCORECARD,
  OLDEST_SHOWN,
  fetchDeadCapital,
  fetchMissReport,
  fetchScorecard,
  sortScorecard,
  type DeadCapital,
  type MissReason,
  type MissReport,
  type Scorecard,
  type ScorecardRow,
  type ScorecardSortKey,
} from "@/lib/team-reporting";

// US-3019 -- the sourcing team's scorecard.
//
// One question: whose picking makes money. Every number on it comes from
// public.sale_pnl (00706), which is checked against finances_dashboard to the
// cent, so this page and the P&L cannot disagree about what a sale earned.
//
// The one thing it deliberately does NOT do is attribute operating expenses to
// a person. Rent, mileage and mailers are not anybody's pick, and splitting
// them across sourcers would invent a number. They sit in their own footer row
// so the page still adds up to what the P&L says.

const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;
const pct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`;
const mult = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(2)}x`;
const days = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : `${Math.round(n)}`;

const csvDate = (): string => new Date().toISOString().slice(0, 10);

interface Column {
  key: ScorecardSortKey;
  label: string;
  numeric: boolean;
  render: (r: ScorecardRow) => string;
  /** What the header means, for the people who did not design the report. */
  hint?: string;
}

const COLUMNS: Column[] = [
  { key: "person", label: "Person", numeric: false, render: (r) => r.person },
  {
    key: "itemsBought",
    label: "Bought",
    numeric: true,
    render: (r) => String(r.itemsBought),
    hint: "Items with a purchase date in this period.",
  },
  {
    key: "spend",
    label: "Spend",
    numeric: true,
    render: (r) => usd(r.spend),
    hint: "What they paid for those items.",
  },
  {
    key: "itemsSold",
    label: "Sold",
    numeric: true,
    render: (r) => String(r.itemsSold),
    hint: "Sales completed in this period, whenever the item was bought.",
  },
  { key: "revenue", label: "Revenue", numeric: true, render: (r) => usd(r.revenue) },
  {
    key: "net",
    label: "Net profit",
    numeric: true,
    render: (r) => usd(r.net),
    hint: "After fees, postage, grading and what the item cost.",
  },
  {
    key: "returnMultiple",
    label: "Return",
    numeric: true,
    render: (r) => mult(r.returnMultiple),
    hint: "Revenue divided by spend. Blank when they bought nothing this period.",
  },
  {
    key: "avgDaysToSell",
    label: "Avg days",
    numeric: true,
    render: (r) => days(r.avgDaysToSell),
    hint: "Purchase to sale, averaged over sales that have a purchase date.",
  },
  {
    key: "sellThrough",
    label: "Sell-through",
    numeric: true,
    render: (r) => pct(r.sellThrough),
    hint: "Share of what they bought this period that has sold.",
  },
  {
    key: "unsoldValue",
    label: "Still unsold",
    numeric: true,
    render: (r) => usd(r.unsoldValue),
    hint: "Money sitting in items they bought this period that have not sold.",
  },
];

export function TeamScorecardCard({
  periodStart,
}: {
  periodStart: string | null;
}) {
  const { workspaceOwnerId } = useWorkspace();
  const [sortKey, setSortKey] = useState<ScorecardSortKey>("net");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data = EMPTY_SCORECARD, isLoading, error, refetch } = useQuery<Scorecard>({
    queryKey: ["team-report", "scorecard", workspaceOwnerId, periodStart],
    enabled: !!workspaceOwnerId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchScorecard(workspaceOwnerId as string, periodStart),
  });

  const rows = useMemo(
    () => sortScorecard(data.rows, sortKey, sortDir),
    [data.rows, sortKey, sortDir],
  );

  function toggleSort(key: ScorecardSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    // A name reads naturally A-Z; a number reads naturally biggest-first.
    setSortDir(key === "person" ? "asc" : "desc");
  }

  function exportCsv() {
    downloadCsv(
      `flipdesk-team-scorecard-${csvDate()}.csv`,
      COLUMNS.map((c) => c.label),
      [
        ...rows.map((r) => [
          r.person,
          r.itemsBought,
          r.spend.toFixed(2),
          r.itemsSold,
          r.revenue.toFixed(2),
          r.net.toFixed(2),
          r.returnMultiple == null ? "" : r.returnMultiple.toFixed(4),
          r.avgDaysToSell == null ? "" : Math.round(r.avgDaysToSell),
          r.sellThrough == null ? "" : r.sellThrough.toFixed(4),
          r.unsoldValue.toFixed(2),
        ]),
        // The two footer rows go into the file too. A CSV whose columns sum to
        // something different from the screen is how a spreadsheet argument
        // starts.
        [
          "All people",
          data.totals.itemsBought,
          data.totals.spend.toFixed(2),
          data.totals.itemsSold,
          data.totals.revenue.toFixed(2),
          data.totals.net.toFixed(2),
          data.totals.returnMultiple == null
            ? ""
            : data.totals.returnMultiple.toFixed(4),
          data.totals.avgDaysToSell == null
            ? ""
            : Math.round(data.totals.avgDaysToSell),
          data.totals.sellThrough == null ? "" : data.totals.sellThrough.toFixed(4),
          data.totals.unsoldValue.toFixed(2),
        ],
        [
          "Unallocated overhead",
          "",
          "",
          "",
          "",
          data.overheadUnavailable ? "" : (-data.overhead).toFixed(2),
          "",
          "",
          "",
          "",
        ],
      ],
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load the team scorecard"
        description={error instanceof Error ? error.message : String(error)}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Sourcer scorecard
            </CardTitle>
            <CardDescription>
              What each person bought, what it earned, and what is still sitting.
              Money comes from the same place as your P&amp;L.
            </CardDescription>
          </div>
          {rows.length > 0 && (
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="mr-2 h-4 w-4" />
              CSV
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <TableLoadingSkeleton rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody to compare yet"
            description="This fills in once items carry a Sourced by name and a purchase date. Set both at intake, or on the Sources page."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS.map((c) => (
                    <TableHead
                      key={c.key}
                      className={cn(c.numeric && "text-right")}
                      title={c.hint}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={cn(
                          "inline-flex items-center gap-1 font-medium hover:underline",
                          c.numeric && "flex-row-reverse",
                        )}
                        aria-label={`Sort by ${c.label}`}
                      >
                        {c.label}
                        {sortKey === c.key &&
                          (sortDir === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          ))}
                      </button>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    {COLUMNS.map((c) => (
                      <TableCell
                        key={c.key}
                        className={cn(
                          c.numeric && "text-right tabular-nums",
                          c.key === "person" && "font-medium",
                          c.key === "net" && r.net < 0 && "text-destructive",
                        )}
                      >
                        {c.render(r)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

                <TableRow className="border-t-2 font-medium">
                  <TableCell>All people</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {data.totals.itemsBought}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {usd(data.totals.spend)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {data.totals.itemsSold}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {usd(data.totals.revenue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {usd(data.totals.net)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {mult(data.totals.returnMultiple)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {days(data.totals.avgDaysToSell)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {pct(data.totals.sellThrough)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {usd(data.totals.unsoldValue)}
                  </TableCell>
                </TableRow>

                {/* Rent, mileage and mailers are not anybody's pick. Splitting
                    them across sourcers would invent a number, so they sit here
                    instead and the page still ties to the P&L. */}
                <TableRow className="text-muted-foreground">
                  <TableCell colSpan={5}>
                    Unallocated overhead
                    <span className="ml-2 text-xs">
                      {data.overheadUnavailable
                        ? "could not be read just now"
                        : "operating expenses, not attributed to a person"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {data.overheadUnavailable ? "—" : usd(-data.overhead)}
                  </TableCell>
                  <TableCell colSpan={4} />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The Team tab.
 *
 * `periodStart` is handed down from the Analytics host, which owns the one
 * date control for the page (US-2548). This view draws no picker of its own.
 */
export function TeamReportPage({
  periodStart,
}: {
  periodStart: string | null;
}) {
  return (
    <div className="space-y-6">
      <TeamScorecardCard periodStart={periodStart} />
      {/* No periodStart: dead capital is a question about right now. Hiding a
          two-year-old item because the picker says "last 30 days" would answer
          the opposite of what was asked. */}
      <DeadCapitalCard />
      <OverpayCard periodStart={periodStart} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// OVERPAY / MISS (US-3021)
// ══════════════════════════════════════════════════════════

/**
 * The target margin, in the URL.
 *
 * Same contract as `?preset=` in analytics.tsx: the whole view is a real URL,
 * so a manager can send "here is the 45% view" to someone rather than telling
 * them which box to type in. The default is omitted from the query string so a
 * plain link is not littered with the value it already has.
 */
function useMarginParam(): [number, (m: number) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = Number(sp.get("margin"));
  const margin =
    Number.isFinite(raw) && raw > 0 && raw < 100
      ? raw / 100
      : DEFAULT_TARGET_MARGIN;

  const setMargin = (pctValue: number) =>
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (pctValue === Math.round(DEFAULT_TARGET_MARGIN * 100))
          next.delete("margin");
        else next.set("margin", String(pctValue));
        return next;
      },
      { replace: true },
    );

  return [margin, setMargin];
}

const REASON_LABEL: Record<MissReason, string> = {
  loss: "Lost money",
  "below-target": "Under target",
};

export function OverpayCard({ periodStart }: { periodStart: string | null }) {
  const { workspaceOwnerId } = useWorkspace();
  const [margin, setMargin] = useMarginParam();
  const marginPct = Math.round(margin * 100);

  const {
    data = EMPTY_MISS_REPORT,
    isLoading,
    error,
    refetch,
  } = useQuery<MissReport>({
    queryKey: ["team-report", "misses", workspaceOwnerId, periodStart, margin],
    enabled: !!workspaceOwnerId,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      fetchMissReport(workspaceOwnerId as string, periodStart, margin),
  });

  function exportCsv() {
    downloadCsv(
      `flipdesk-overpay-${csvDate()}.csv`,
      [
        "Person",
        "Shop",
        "Item",
        "Sale date",
        "Why",
        "Paid",
        "Sold for",
        "Net",
        "Short of target",
      ],
      // `all`, not `worst` -- the card tells the reader the CSV has the rest.
      data.rows.flatMap((r) =>
        r.all.map((w) => [
          r.person,
          w.sourceKey,
          w.title,
          w.saleDate.slice(0, 10),
          REASON_LABEL[w.reason],
          w.paid.toFixed(2),
          w.soldFor.toFixed(2),
          w.net.toFixed(2),
          w.shortfall.toFixed(2),
        ]),
      ),
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load the miss report"
        description={error instanceof Error ? error.message : String(error)}
        onRetry={() => void refetch()}
      />
    );
  }

  const marginControl = (
    <div className="flex items-center gap-2">
      <Label htmlFor="target-margin" className="whitespace-nowrap text-sm">
        Target margin
      </Label>
      <Input
        id="target-margin"
        type="number"
        min={0}
        max={99}
        value={marginPct}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next) && next >= 0 && next < 100) setMargin(next);
        }}
        className="w-20"
      />
      <span className="text-sm text-muted-foreground">%</span>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingDown className="h-4 w-4" />
              Overpaid and under target
            </CardTitle>
            <CardDescription>
              Sales that lost money, or made less than you want, grouped by who
              bought the item and where they bought it.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            {marginControl}
            {data.count > 0 && (
              <Button variant="outline" size="sm" onClick={exportCsv}>
                <Download className="mr-2 h-4 w-4" />
                CSV
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <TableLoadingSkeleton rows={3} columns={4} />
        ) : data.count === 0 ? (
          // "No misses" out of 80 sales is praise; out of 0 sales it is
          // silence. The copy has to tell them apart or the card reads as
          // broken on a quiet month.
          <p className="py-6 text-center text-sm text-muted-foreground">
            {data.salesConsidered === 0
              ? "No completed sales in this period, so there is nothing to judge yet."
              : `Nothing missed target. All ${data.salesConsidered} ${
                  data.salesConsidered === 1 ? "sale" : "sales"
                } in this period cleared ${marginPct}%.`}
          </p>
        ) : (
          <>
            <p className="text-sm">
              <span className="text-2xl font-semibold tabular-nums">
                {usd(data.shortfall)}
              </span>{" "}
              <span className="text-muted-foreground">
                short of target across {data.count}{" "}
                {data.count === 1 ? "sale" : "sales"}, out of{" "}
                {data.salesConsidered} in this period.
              </span>
            </p>

            <div className="space-y-6">
              {data.rows.map((r) => (
                <div key={r.key} className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h4 className="font-medium">
                      {r.person}
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        {r.count} {r.count === 1 ? "miss" : "misses"}
                        {r.lossCount > 0 &&
                          `, ${r.lossCount} at an outright loss`}
                      </span>
                    </h4>
                    <span className="text-sm tabular-nums text-destructive">
                      {usd(r.shortfall)} short
                    </span>
                  </div>

                  {/* Where it happened, worst shop first. This is the half a
                      manager acts on: the coaching is "stop paying that much
                      at this shop", not "do better". */}
                  <p className="text-xs text-muted-foreground">
                    {r.shops
                      .map(
                        (s) =>
                          `${s.sourceKey} (${s.count}, ${usd(s.shortfall)} short)`,
                      )
                      .join(" · ")}
                  </p>

                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item</TableHead>
                          <TableHead>Shop</TableHead>
                          <TableHead>Why</TableHead>
                          <TableHead className="text-right">Paid</TableHead>
                          <TableHead className="text-right">Sold for</TableHead>
                          <TableHead className="text-right">Net</TableHead>
                          <TableHead className="text-right">Short</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {r.worst.map((w) => (
                          <TableRow key={w.saleId}>
                            <TableCell className="font-medium">
                              {w.itemId ? (
                                <Link
                                  to={`/dashboard/flipdesk/items/${w.itemId}`}
                                  className="hover:underline"
                                >
                                  {w.title}
                                </Link>
                              ) : (
                                w.title
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {w.sourceKey}
                            </TableCell>
                            <TableCell>
                              <span
                                className={cn(
                                  "text-xs",
                                  w.reason === "loss"
                                    ? "text-destructive"
                                    : "text-muted-foreground",
                                )}
                              >
                                {REASON_LABEL[w.reason]}
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {usd(w.paid)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {usd(w.soldFor)}
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right tabular-nums",
                                w.net < 0 && "text-destructive",
                              )}
                            >
                              {usd(w.net)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {usd(w.shortfall)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {r.count > r.worst.length && (
                    <p className="text-xs text-muted-foreground">
                      Showing the {r.worst.length} worst of {r.count}. The CSV
                      has the rest.
                    </p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════
// DEAD CAPITAL (US-3020)
// ══════════════════════════════════════════════════════════

export function DeadCapitalCard() {
  const { workspaceOwnerId } = useWorkspace();
  const [openRow, setOpenRow] = useState<string | null>(null);

  const {
    data = EMPTY_DEAD_CAPITAL,
    isLoading,
    error,
    refetch,
  } = useQuery<DeadCapital>({
    queryKey: ["team-report", "dead-capital", workspaceOwnerId],
    enabled: !!workspaceOwnerId,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchDeadCapital(workspaceOwnerId as string),
  });

  function exportCsv() {
    downloadCsv(
      `flipdesk-dead-capital-${csvDate()}.csv`,
      [
        "Person",
        ...AGE_BUCKETS.map((b) => b.label),
        "Total",
        "Items",
        "Over 90 days",
      ],
      [
        ...data.rows.map((r) => [
          r.person,
          ...AGE_BUCKETS.map((b) => r.buckets[b.id].toFixed(2)),
          r.total.toFixed(2),
          r.count,
          r.stale.toFixed(2),
        ]),
        [
          "Everyone",
          ...AGE_BUCKETS.map((b) => data.totals[b.id].toFixed(2)),
          data.grandTotal.toFixed(2),
          data.rows.reduce((n, r) => n + r.count, 0),
          data.staleTotal.toFixed(2),
        ],
      ],
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load dead capital"
        description={error instanceof Error ? error.message : String(error)}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Hourglass className="h-4 w-4" />
              Dead capital by person
            </CardTitle>
            <CardDescription>
              Money sitting in things that have not sold. This one ignores the
              date range above, because what is stuck is stuck.
            </CardDescription>
          </div>
          {data.rows.length > 0 && (
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="mr-2 h-4 w-4" />
              CSV
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <TableLoadingSkeleton rows={4} columns={7} />
        ) : data.rows.length === 0 ? (
          <EmptyState
            icon={Hourglass}
            title="Nothing is sitting"
            description="Every item you have bought has sold, or none of them carry a Sourced by name yet."
          />
        ) : (
          <>
            {/* The one number a manager acts on, said once and said plainly. */}
            <p className="text-sm">
              <span className="text-2xl font-semibold tabular-nums">
                {usd(data.staleTotal)}
              </span>{" "}
              <span className="text-muted-foreground">
                is tied up in items bought more than 90 days ago, out of{" "}
                {usd(data.grandTotal)} unsold in total.
              </span>
            </p>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    {AGE_BUCKETS.map((b) => (
                      <TableHead key={b.id} className="text-right">
                        {b.label}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Over 90 days</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => {
                    const open = openRow === r.key;
                    return (
                      // Fragment, not the shorthand, so the key sits on the
                      // outermost returned element. On the shorthand it cannot,
                      // and React re-keys the whole body on every expand.
                      <Fragment key={r.key}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/30"
                          onClick={() => setOpenRow(open ? null : r.key)}
                        >
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-1.5">
                              <ChevronRight
                                className={cn(
                                  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                                  open && "rotate-90",
                                )}
                              />
                              {r.person}
                              <span className="text-xs font-normal text-muted-foreground">
                                {r.count} item{r.count === 1 ? "" : "s"}
                              </span>
                            </span>
                          </TableCell>
                          {AGE_BUCKETS.map((b) => (
                            <TableCell
                              key={b.id}
                              className="text-right tabular-nums"
                            >
                              {r.counts[b.id] === 0 ? "—" : usd(r.buckets[b.id])}
                            </TableCell>
                          ))}
                          <TableCell className="text-right font-medium tabular-nums">
                            {usd(r.total)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              r.stale > 0 && "text-destructive",
                            )}
                          >
                            {usd(r.stale)}
                          </TableCell>
                        </TableRow>

                        {open && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell colSpan={AGE_BUCKETS.length + 3}>
                              <p className="mb-2 text-xs text-muted-foreground">
                                The {Math.min(OLDEST_SHOWN, r.oldest.length)}{" "}
                                oldest of {r.person}&rsquo;s unsold items
                              </p>
                              <ul className="space-y-1 text-sm">
                                {r.oldest.map((o) => (
                                  <li
                                    key={o.id}
                                    className="flex flex-wrap items-baseline gap-x-3"
                                  >
                                    <Link
                                      to={`/dashboard/flipdesk/items/${o.id}`}
                                      className="font-medium hover:underline"
                                    >
                                      {o.title}
                                    </Link>
                                    <span className="tabular-nums text-muted-foreground">
                                      {usd(o.acquiredPrice)}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {o.acquiredDate
                                        ? `bought ${o.acquiredDate.slice(0, 10)}`
                                        : "no purchase date"}
                                    </span>
                                    <span className="text-xs tabular-nums text-muted-foreground">
                                      {o.days === null
                                        ? "age unknown"
                                        : `${o.days} days held`}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}

                  <TableRow className="border-t-2 font-medium">
                    <TableCell>Everyone</TableCell>
                    {AGE_BUCKETS.map((b) => (
                      <TableCell key={b.id} className="text-right tabular-nums">
                        {usd(data.totals[b.id])}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">
                      {usd(data.grandTotal)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(data.staleTotal)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
