import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download, Users } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  EMPTY_SCORECARD,
  fetchScorecard,
  sortScorecard,
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
    </div>
  );
}
