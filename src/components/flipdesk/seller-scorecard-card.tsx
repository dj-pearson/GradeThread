import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Download, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { downloadCsv } from "@/lib/csv-export";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import {
  diagnosisLine,
  EMPTY_SCORECARD,
  formatMetricValue,
  isUnranked,
  METRIC_LABEL,
  orderedMetrics,
  pickBiggestGap,
  type Scorecard,
  type ScorecardMetric,
  returnSplitLine,
} from "@/lib/seller-scorecard";

// US-2822: five percentiles and one sentence, at the top of Analytics.
//
// Each metric links to the tab that explains it, so the card is a diagnosis
// rather than another place numbers live.

const TAB_FOR: Record<ScorecardMetric, string> = {
  sell_through: "/dashboard/flipdesk/analytics",
  price_realization: "/dashboard/flipdesk/analytics/price-curve",
  days_to_sell: "/dashboard/flipdesk/analytics",
  return_rate: "/dashboard/flipdesk/analytics/returns",
  grade_yield: "/dashboard/flipdesk/analytics/grading-roi",
};

export function SellerScorecardCard({
  periodStart,
}: {
  periodStart: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const { data = EMPTY_SCORECARD } = useQuery<Scorecard>({
    queryKey: ["items_full", "analytics", "scorecard", user?.id, periodStart],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { fetchSellerScorecard } = await import("@/lib/seller-scorecard");
      return fetchSellerScorecard(periodStart);
    },
  });

  const metrics = useMemo(() => orderedMetrics(data), [data]);
  const worst = useMemo(() => pickBiggestGap(data), [data]);
  const line = useMemo(() => diagnosisLine(data), [data]);

  // US-2829: headers match the on-screen labels exactly (AC6), so a seller
  // mapping the file to their own sheet does not need a decoder.
  //
  // The two columns the CARD shows as one line are split here. On screen a
  // metric reads "42nd percentile" OR "3 of 8 peers" depending on whether it
  // ranked; a spreadsheet needs both facts in their own cells, because
  // "" in Percentile means unranked and that is a different thing from a low
  // one. Cohort sellers travels beside it so the reason is visible.
  function exportCsv() {
    downloadCsv(
      `flipdesk-scorecard-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Metric", "Your value", "Percentile", "Cohort sellers", "Biggest gap"],
      metrics.map((m) => [
        METRIC_LABEL[m.metric],
        formatMetricValue(m.metric, m.ownValue),
        m.ownPercentile ?? "",
        m.cohortSellers,
        worst?.metric === m.metric ? "yes" : "",
      ]),
    );
  }

  if (metrics.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-4 w-4" />
            Your scorecard
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            aria-label="Export your scorecard percentiles as CSV"
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          {line ? (
            <>
              <span className="font-medium">
                {worst ? METRIC_LABEL[worst.metric] : ""} is your weakest number
                {worst?.ownPercentile != null &&
                  ` (${worst.ownPercentile}th percentile)`}
                .
              </span>{" "}
              <span className="text-muted-foreground">{line}</span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {isUnranked(data)
                ? `No metric has ${data.minSellers} comparable sellers behind it yet, so nothing is ranked. Your own numbers are below.`
                : "Nothing to flag this period."}
            </span>
          )}
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {metrics.map((m) => {
            const isWorst = worst?.metric === m.metric;
            return (
              <Link
                key={m.metric}
                to={TAB_FOR[m.metric]}
                className={cn(
                  "rounded-xl p-3 transition-colors",
                  isWorst
                    ? "bg-destructive/10 hover:bg-destructive/15"
                    : "bg-muted/50 hover:bg-muted",
                )}
              >
                <p
                  className={cn(
                    "text-xs",
                    isWorst ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {METRIC_LABEL[m.metric]}
                </p>
                <p className="mt-1 text-xl font-bold">
                  {formatMetricValue(m.metric, m.ownValue)}
                </p>
                <p
                  className={cn(
                    "mt-0.5 text-xs",
                    isWorst ? "text-destructive/80" : "text-muted-foreground",
                  )}
                >
                  {m.ownPercentile != null
                    ? `${m.ownPercentile}th percentile`
                    : `${m.cohortSellers} of ${data.minSellers} peers`}
                </p>
              </Link>
            );
          })}
        </div>

        {/* US-9208: the return rate split by whether the listing carried a grade
            when it sold. This is the number grading is supposed to move, so it
            gets its own two lines; under the floor it says so instead of a
            percentage that two sales could produce. */}
        <div className="rounded-xl bg-muted/50 p-3 text-sm">
          <p className="text-xs text-muted-foreground">Returns, graded vs ungraded</p>
          {[
            returnSplitLine(data.returnSplit.graded, "Graded at sale"),
            returnSplitLine(data.returnSplit.ungraded, "Ungraded"),
          ].map((line) => (
            <p key={line.text} className={cn("mt-1", line.kind === "thin" && "text-muted-foreground")}>
              {line.text}
            </p>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          Percentiles compare one number per seller, not one per item, and a
          seller needs {data.minActivity} items before they count toward a
          ranking. 100 is best on every metric, including the ones where lower is
          better.
        </p>
      </CardContent>
    </Card>
  );
}
