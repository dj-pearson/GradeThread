import { useMemo } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  if (metrics.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4" />
          Your scorecard
        </CardTitle>
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
