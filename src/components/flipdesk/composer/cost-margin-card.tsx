import { ConditionIndexValueHint } from "@/components/flipdesk/condition-index-value-hint";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ItemFullRow } from "@/types/database";
import type { estimateListingProfit } from "@/lib/listing-profit";
import type { useSellThroughForecast } from "@/hooks/use-forecast";

type ProfitEstimate = ReturnType<typeof estimateListingProfit>;
type SellThroughForecast = ReturnType<
  typeof useSellThroughForecast
>["forecast"];
export interface CostMarginCardProps {
  item: ItemFullRow;
  cost: string;
  setCost: (next: string) => void;
  /** The cost being EDITED, so margin moves as you type. */
  effectiveCost: number | null;
  parsedPreviewPrice: number;
  profitEstimate: ProfitEstimate;
  /** US-623: condition-aware, at this price. */
  sellThroughForecast: SellThroughForecast | null;
}
// What you paid, and what this price leaves you. Split out of "Condition &
// price" (US-2254), where the cost input and its three read-outs were all nested
// INSIDE the purchase-price label group.
export function CostMarginCard({
  item,
  cost,
  setCost,
  effectiveCost,
  parsedPreviewPrice,
  profitEstimate,
  sellThroughForecast,
}: CostMarginCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost &amp; margin</CardTitle>
        <CardDescription>
          What you paid, and what this price leaves you. Saved to the item
          with everything else on this page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="purchase-cost">Purchase price (what you paid)</Label>
        <div className="flex items-center gap-2">
          <Input
            id="purchase-cost"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="0.00"
            className="max-w-[10rem]"
          />
          <span className="text-xs text-muted-foreground">
            Saves with the draft · drives margin + ROI
          </span>
        </div>
        {/* US-553: live profit/margin so pricing is a margin decision. */}
        {parsedPreviewPrice > 0 && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Est. net profit</span>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  profitEstimate.net < 0
                    ? "text-destructive"
                    : profitEstimate.marginPct < 20
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                ${profitEstimate.net.toFixed(2)} ·{" "}
                {profitEstimate.marginPct.toFixed(0)}% margin
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>eBay fees ~${profitEstimate.fees.toFixed(2)}</span>
              <span>Cost ${(effectiveCost ?? 0).toFixed(2)}</span>
              {(item.shipping_cost ?? 0) > 0 && (
                <span>Shipping ${(item.shipping_cost ?? 0).toFixed(2)}</span>
              )}
            </div>
            {effectiveCost == null && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                Enter the purchase price above to see true margin — this
                is the ceiling until you do.
              </p>
            )}
          </div>
        )}
        {/* US-623: condition-aware sell-through forecast at this price. */}
        {sellThroughForecast && sellThroughForecast.label !== "unknown" && parsedPreviewPrice > 0 && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Est. sell-through</span>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  sellThroughForecast.label === "fast"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : sellThroughForecast.label === "moderate"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground",
                )}
              >
                ~{Math.round(sellThroughForecast.sellThroughPct * 100)}% in{" "}
                {sellThroughForecast.daysLow}–{sellThroughForecast.daysHigh} days
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Estimate from {sellThroughForecast.sampleSize} condition-matched comps — a lower price sells faster.
            </p>
          </div>
        )}
        {/* US-848: grade-anchored value from the public Condition Index. */}
        <ConditionIndexValueHint
          brand={item.brand}
          category={item.category}
          title={item.item_title}
          grade={item.grade_value}
        />
      </CardContent>
    </Card>
  );
}