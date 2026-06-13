import { useMemo } from "react";
import { TrendingUp, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useItemsFull } from "@/hooks/use-items-full";
import { gradeRoiEstimate } from "@/lib/flipdesk-analytics";

// US-856: proactive "grade this -> +$X" recommendation. At intake / item detail,
// when the seller's OWN sold history for this category has enough graded vs
// ungraded signal, surface the price (and days-to-sell) lift so they decide to
// grade up front instead of discovering ROI retroactively in analytics.
//
// Tenant-scoped by construction: useItemsFull reads items_full, which is
// RLS-scoped to the signed-in user. Renders nothing when the item is already
// graded, when the category has no comparable history, or when either side is
// below MIN_BUCKET_SIZE (no false precision on thin data).

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

interface GradeRoiHintProps {
  category: string | null | undefined;
  /** When set, the item is already graded — the recommendation is suppressed. */
  grade?: number | null;
  /** Optional sale-price hint (target/list/purchase) to pin a price band. */
  priceHint?: number | null;
  /** CTA into the grading flow (scroll to the canvas grade section, or route). */
  onGrade: () => void;
  /** Button label — defaults to "Grade this item". */
  ctaLabel?: string;
  className?: string;
}

export function GradeRoiHint({
  category,
  grade,
  priceHint,
  onGrade,
  ctaLabel = "Grade this item",
  className,
}: GradeRoiHintProps) {
  const { data: items = [] } = useItemsFull();

  const estimate = useMemo(
    () => gradeRoiEstimate(items, { category, priceHint }),
    [items, category, priceHint],
  );

  // Already graded → nothing to recommend.
  if (grade != null) return null;

  // Need a meaningful sample and at least one positive signal to claim a lift.
  if (!estimate || !estimate.meaningful) return null;
  const priceUp = estimate.priceLift != null && estimate.priceLift > 0;
  const fasterDays =
    estimate.daysFaster != null && Math.round(estimate.daysFaster) >= 1;
  if (!priceUp && !fasterDays) return null;

  const sample = estimate.graded.count + estimate.ungraded.count;
  const bandSuffix = estimate.band ? ` (${estimate.band})` : "";

  // Build the natural-language lift clause from whichever signals are positive.
  const parts: string[] = [];
  if (priceUp) {
    parts.push(`sell ~${usd.format(estimate.priceLift as number)} higher`);
  }
  if (fasterDays) {
    const d = Math.round(estimate.daysFaster as number);
    parts.push(`~${d} day${d === 1 ? "" : "s"} faster`);
  }
  const lift = parts.join(" and ");

  return (
    <div
      className={cn(
        "rounded-md border border-brand-navy/30 bg-brand-navy/5 px-4 py-3",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy dark:text-foreground" />
        <div className="space-y-0.5">
          <p className="text-sm text-foreground">
            Graded <span className="font-medium">{estimate.category}</span>
            {bandSuffix} items {lift} in your sales.
          </p>
          <p className="text-[11px] text-muted-foreground">
            Based on {estimate.graded.count} graded vs {estimate.ungraded.count}{" "}
            ungraded sold ({sample} items).
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex justify-end">
        <Button size="sm" onClick={onGrade} className="gap-1.5">
          {ctaLabel}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
