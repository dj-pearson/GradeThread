import { BadgeCheck, Gauge, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GradeBandedPrice } from "@/hooks/use-ebay";
import { ValueBasisNote } from "@/components/value/value-basis-note";
import { EbayAttribution } from "@/components/marketplace/ebay-attribution";

// US-594 / US-1477: the sold-comp, grade-banded recommendation. Realized sales
// win; an active-ask fallback is clearly flagged as an estimate. Always surfaces
// the comp set + confidence + sell-through behind the number. Shared by the
// composer's live-comps panel and the prep stage's "Comp & price" step so both
// present the same live pricing instead of prep's old blank manual entry.

function fmt(value: number | null, currency: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

const BASIS_LABEL: Record<GradeBandedPrice["basis"], string> = {
  ebay_sold: "Sold comps",
  private_sales: "Your past sales",
  active_estimated: "Estimate · active asks",
};

const SELL_THROUGH_LABEL: Record<
  GradeBandedPrice["sellThrough"]["label"],
  string
> = {
  fast: "Sells fast",
  moderate: "Moderate demand",
  slow: "Slow mover",
  unknown: "Velocity unknown",
};

export function SoldCompRecommendation({
  recommendation,
  loading,
  onApply,
}: {
  recommendation: GradeBandedPrice | null;
  loading: boolean;
  onApply: (dollars: number, currency: string) => void;
}) {
  if (loading && !recommendation) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking sold comps…
      </div>
    );
  }
  if (
    !recommendation ||
    !recommendation.sufficient ||
    recommendation.recommendedCents == null
  ) {
    return null;
  }

  const {
    recommendedCents,
    lowCents,
    highCents,
    currency,
    basis,
    soldBacked,
    confidence,
    compSet,
    sellThrough,
  } = recommendation;
  const dollars = recommendedCents / 100;
  const confidencePct = Math.round(confidence * 100);

  return (
    <div
      className={cn(
        "rounded-md border p-3",
        soldBacked
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <BadgeCheck className="h-3.5 w-3.5" />
            Recommended price
          </div>
          <div className="text-2xl font-bold text-brand-navy dark:text-foreground">
            {fmt(dollars, currency)}
          </div>
        </div>
        <Badge
          variant="outline"
          className={cn(
            soldBacked
              ? "border-emerald-500 text-emerald-700 dark:text-emerald-400"
              : "border-amber-500 text-amber-700 dark:text-amber-400",
          )}
        >
          {BASIS_LABEL[basis]}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
        <div>
          <div className="uppercase tracking-wide">Range</div>
          <div className="text-sm font-medium text-foreground">
            {fmt(lowCents != null ? lowCents / 100 : null, currency)} –{" "}
            {fmt(highCents != null ? highCents / 100 : null, currency)}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wide">Confidence</div>
          <div className="text-sm font-medium text-foreground">
            {confidencePct}%
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1 uppercase tracking-wide">
            <Gauge className="h-3 w-3" /> Sell-through
          </div>
          <div className="text-sm font-medium text-foreground">
            {SELL_THROUGH_LABEL[sellThrough.label]}
            {sellThrough.label !== "unknown" && sellThrough.daysHigh > 0
              ? ` · ${sellThrough.daysLow}–${sellThrough.daysHigh}d`
              : ""}
          </div>
        </div>
      </div>

      {/* US-2850: the line below already says sold-vs-active. This one says
          whether condition was MEASURED or whether the number is the plain
          middle of a pile of listings, which is a different question. */}
      <ValueBasisNote basis={recommendation.valueBasis} className="mt-3" />

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {soldBacked
            ? `Backed by ${compSet.count} realized ${compSet.count === 1 ? "sale" : "sales"}`
            : `No sold comps yet — based on ${compSet.count} active ${compSet.count === 1 ? "ask" : "asks"} (may run high)`}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onApply(dollars, currency)}
        >
          Use as target price
        </Button>
      </div>

      {/* US-3042: attribution belongs on the surface showing the data. Only
          when the number actually came from eBay — a price built from the
          seller's OWN past sales is their data, and crediting eBay for it would
          be a false statement rather than a cautious one. */}
      {basis !== "private_sales" && (
        <EbayAttribution what="Pricing comparables" className="mt-3" />
      )}
    </div>
  );
}
