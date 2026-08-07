// US-1870: Inventory Equity dashboard card.
//
// Renders the estimated liquidation value of the seller's GRADED inventory —
// the capital on their racks — from the tenant-scoped /api/flipdesk/equity
// endpoint (US-1869). Phase-1 DISPLAY-ONLY (US-1868 scope fence): this is an
// estimate for planning, NOT an appraisal, offer, or borrowing capacity. The
// disclosure copy is the shared EQUITY_ESTIMATE_DISCLOSURE and must stay
// rendered — inventory-equity-scope-fence.test.ts requires it here and on every
// other equity surface.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Coins, Info, Sparkles } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { edgeFetch } from "@/lib/edge-fetch";
import { EQUITY_ESTIMATE_DISCLOSURE } from "@/lib/inventory-equity-disclosure";
import { cn } from "@/lib/utils";

interface EquityBucket {
  cents: number;
  count: number;
}

interface EquityAggregate {
  totalEquityCents: number;
  totalLowCents: number;
  totalHighCents: number;
  valuedCount: number;
  unvaluedCount: number;
  unvaluedByReason: { no_grade: number; no_comps: number };
  byCategory: Record<string, EquityBucket>;
  byBrand: Record<string, EquityBucket>;
  byGradeBand: Record<string, EquityBucket>;
}

interface EquityResponse {
  currency: string;
  personalSellThroughDays: number | null;
  aggregate: EquityAggregate;
}

interface TrendPoint {
  snapshot_date: string;
  total_equity_cents: number;
}
interface TrendResponse {
  currency: string;
  points: TrendPoint[];
}

// Pure SVG sparkline of total equity over time — no chart lib. Scales to the
// series min/max; a flat series still draws a centered line.
function EquitySparkline({ points }: { points: TrendPoint[] }) {
  const w = 240;
  const h = 40;
  const vals = points.map((p) => p.total_equity_cents);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = points.length > 1 ? w / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = h - 4 - ((p.total_equity_cents - min) / span) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-10 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="Inventory equity trend"
    >
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-primary"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const money = (cents: number) => usd.format(Math.round(cents) / 100);

// Top-N buckets of a map, largest first, with each row's bar width as a share
// of the largest bucket.
function topBuckets(map: Record<string, EquityBucket>, n = 5) {
  const rows = Object.entries(map)
    .map(([label, b]) => ({ label, ...b }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, n);
  const max = rows[0]?.cents ?? 1;
  return rows.map((r) => ({ ...r, pct: Math.round((r.cents / max) * 100) }));
}

function Breakdown({
  title,
  map,
}: {
  title: string;
  map: Record<string, EquityBucket>;
}) {
  const rows = topBuckets(map);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="space-y-0.5">
          <div className="flex items-center justify-between text-xs">
            <span className="truncate capitalize">{r.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {money(r.cents)} · {r.count}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${r.pct}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function InventoryEquityCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["flipdesk-equity"],
    queryFn: async (): Promise<EquityResponse | null> => {
      const res = await edgeFetch("/api/flipdesk/equity");
      // 404 = feature disabled (kill-switch) → render nothing, not an error.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to load inventory equity.");
      return (await res.json()) as EquityResponse;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const { data: trend } = useQuery({
    queryKey: ["flipdesk-equity-trend"],
    queryFn: async (): Promise<TrendResponse | null> => {
      const res = await edgeFetch("/api/flipdesk/equity/trend");
      if (!res.ok) return null;
      return (await res.json()) as TrendResponse;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
    // Only worth fetching once the summary loaded and the feature is on.
    enabled: !!data,
  });

  // Feature off, or a transient error — stay quiet rather than shout.
  if (data === null || isError) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="h-4 w-4 text-primary" />
          Inventory Equity
        </CardTitle>
        <CardDescription>
          Estimated liquidation value of your graded inventory.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !data ? (
          <div className="space-y-2" aria-label="Estimating inventory equity">
            <div className="h-8 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-56 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <>
            <div>
              <div className="text-3xl font-semibold tabular-nums">
                {money(data.aggregate.totalEquityCents)}
              </div>
              <div className="text-xs text-muted-foreground">
                Range {money(data.aggregate.totalLowCents)} –{" "}
                {money(data.aggregate.totalHighCents)}
              </div>
            </div>

            {/* US-1870: equity-over-time trend (needs ≥2 nightly snapshots). */}
            {trend && trend.points.length >= 2 && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  Equity over time
                </div>
                <EquitySparkline points={trend.points} />
              </div>
            )}

            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                {data.aggregate.valuedCount} valued
              </span>
              {data.aggregate.unvaluedCount > 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                  {data.aggregate.unvaluedCount} unvalued
                </span>
              )}
            </div>

            {/* Organic grading-volume loop: unvalued stock (mostly ungraded) is
                the CTA into the grading flow. */}
            {data.aggregate.unvaluedByReason.no_grade > 0 && (
              <Link
                to="/dashboard/flipdesk/pipeline"
                className={cn(
                  "flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5",
                  "text-xs font-medium text-primary hover:bg-primary/10",
                )}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Grade {data.aggregate.unvaluedByReason.no_grade} more{" "}
                {data.aggregate.unvaluedByReason.no_grade === 1 ? "item" : "items"} to
                complete your valuation
              </Link>
            )}

            {data.aggregate.valuedCount > 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Breakdown title="By category" map={data.aggregate.byCategory} />
                <Breakdown title="By brand" map={data.aggregate.byBrand} />
                <Breakdown title="By grade" map={data.aggregate.byGradeBand} />
              </div>
            )}

            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              {EQUITY_ESTIMATE_DISCLOSURE}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
