import { useMemo } from "react";
import { Award, Clock, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useItemsFull } from "@/hooks/use-items-full";
import { useAuthStore } from "@/stores/auth-store";
import {
  accountGradingRollup,
  GRADE_FEE_USD,
  itemSaleOutcome,
  MIN_BUCKET_SIZE,
} from "@/lib/flipdesk-analytics";
import type { ItemFullRow } from "@/types/database";

// US-857: close the loop on grading value. When a graded item has SOLD, show
// its grade alongside the realized outcome ("Graded 7.5 → sold in 12 days for
// $42 net"). Below it, an account-level graded-vs-ungraded rollup — gated on
// the users.share_sale_outcomes opt-in and low-n suppressed, so nothing is
// fabricated on thin data.
//
// Tenant-scoped by construction: useItemsFull reads items_full (RLS-scoped to
// the signed-in user) and the per-item line is the seller's own row.

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function days(n: number): string {
  const d = Math.round(n);
  return `${d} day${d === 1 ? "" : "s"}`;
}

function formatSoldDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function GradeOutcomeCard({ item }: { item: ItemFullRow }) {
  const { data: items = [] } = useItemsFull();
  const optedIn = useAuthStore(
    (s) => s.profile?.share_sale_outcomes === true,
  );

  const outcome = useMemo(() => itemSaleOutcome(item), [item]);
  const rollup = useMemo(() => accountGradingRollup(items), [items]);

  const hasSaleData = rollup.graded.count > 0 || rollup.ungraded.count > 0;
  const showRollup = optedIn && hasSaleData;

  if (!outcome && !showRollup) return null;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {outcome && (
          <div className="flex items-start gap-2">
            <Award className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy dark:text-foreground" />
            <div className="space-y-0.5">
              <p className="text-sm text-foreground">
                Graded{" "}
                <span className="font-medium">{outcome.grade}</span>
                {outcome.gradeLabel ? ` (${outcome.gradeLabel})` : ""}
                {" → sold "}
                {outcome.daysToSell != null
                  ? `in ${days(outcome.daysToSell)}`
                  : outcome.soldAt
                    ? `on ${formatSoldDate(outcome.soldAt)}`
                    : ""}
                {outcome.netProfit != null
                  ? ` for ${usd0.format(outcome.netProfit)} net`
                  : ` for ${usd0.format(outcome.salePrice)}`}
                .
              </p>
              <p className="text-[11px] text-muted-foreground">
                Your captured grade-to-outcome for this item.
              </p>
            </div>
          </div>
        )}

        {showRollup &&
          (rollup.meaningful ? (
            <Rollup rollup={rollup} hasDivider={!!outcome} />
          ) : (
            <div
              className={cn(
                "flex items-start gap-2",
                outcome && "border-t pt-4",
              )}
            >
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-[11px] text-muted-foreground">
                Not enough sales yet to compare graded vs ungraded — need at
                least {MIN_BUCKET_SIZE} of each ({rollup.graded.count} graded,{" "}
                {rollup.ungraded.count} ungraded so far).
              </p>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

function Rollup({
  rollup,
  hasDivider,
}: {
  rollup: ReturnType<typeof accountGradingRollup>;
  hasDivider: boolean;
}) {
  const fasterDays =
    rollup.daysFaster != null && Math.round(rollup.daysFaster) >= 1;
  const netUp = rollup.netHigher != null && rollup.netHigher > 0;

  // Only state the signals the data supports — never fabricate a lift.
  const parts: string[] = [];
  if (fasterDays) {
    parts.push(`sell ~${days(rollup.daysFaster as number)} faster`);
  }
  if (netUp) {
    parts.push(`net ~${usd0.format(rollup.netHigher as number)} more`);
  }

  if (parts.length === 0) {
    // Opted in with a meaningful sample, but grading shows no measurable edge.
    return (
      <div className={cn("flex items-start gap-2", hasDivider && "border-t pt-4")}>
        <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-[11px] text-muted-foreground">
          Across {rollup.graded.count} graded and {rollup.ungraded.count}{" "}
          ungraded sales, graded items haven&apos;t shown a measurable price or
          speed edge yet.
        </p>
      </div>
    );
  }

  const lift = parts.join(" and ");

  return (
    <div className={cn("flex items-start gap-2", hasDivider && "border-t pt-4")}>
      <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy dark:text-foreground" />
      <div className="space-y-0.5">
        <p className="text-sm text-foreground">
          Your graded items <span className="font-medium">{lift}</span> on
          average.
          {netUp && rollup.paysForItselfInSales != null
            ? ` At ${usd2.format(GRADE_FEE_USD)} a grade, grading pays for itself in ${rollup.paysForItselfInSales} sale${
                rollup.paysForItselfInSales === 1 ? "" : "s"
              }.`
            : ""}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Based on {rollup.graded.count} graded vs {rollup.ungraded.count}{" "}
          ungraded sales.
        </p>
      </div>
    </div>
  );
}
