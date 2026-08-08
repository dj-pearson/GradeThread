import { EbayCategoryPicker } from "@/components/flipdesk/ebay-category-picker";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { cn } from "@/lib/utils";
import type { ItemFullRow, ListingCategoryCandidate } from "@/types/database";
import type { AspectSourceMap } from "@/lib/aspect-provenance";
import type { ItemAspectSource } from "@/lib/ebay-prefill";
import type { useRecommendedCoverage } from "@/hooks/use-ebay";

type RecommendedCoverage = NonNullable<
  ReturnType<typeof useRecommendedCoverage>["data"]
>;
export interface SpecificsSectionProps {
  item: ItemFullRow;
  aspectCoverage: RecommendedCoverage | null | undefined;
  /** True while either saved source (listing / inventory mirror) is still in flight. */
  loading: boolean;
  /** US-2258: eBay owns platform_category_id, but NOT the specifics in the same editor — so warn rather than lock. */
  isEbayOrigin: boolean;
  savedCategoryId: string | null;
  savedAspects: Record<string, string[]> | null;
  savedSources: AspectSourceMap | null;
  /** US-828: aspects generation reconciliation flagged. */
  needsReviewAspects: string[];
  /** US-2426: the leaves AutoLister scored at generation time (US-2424), so the
   *  picker can offer a one-click switch to a runner-up. Null on any draft that
   *  never went through the scorer. */
  categoryCandidates: ListingCategoryCandidate[] | null;
  initialised: boolean;
  measurements: Record<string, number | string>;
  setMeasurements: (next: Record<string, number | string>) => void;
  measurementUnit: "in" | "cm";
  itemAspectSource: ItemAspectSource | null;
  onCategoryChange: (id: string | null, path?: string | null) => void;
  /** Owned by the page: it also maintains the US-2256 aspect dirty baseline. */
  onAspectsChange: (next: Record<string, string[]> | null) => void;
  /** Seller-intent signal for that same baseline — see the picker's own prop. */
  onUserEdit: () => void;
  onSourcesChange: (next: AspectSourceMap | null) => void;
  onMissingRequiredChange: (next: string[]) => void;
}
// eBay category + item specifics, with the US-1895 recommended-aspect coverage
// meter above it. Mounting is gated until BOTH saved sources have loaded so the
// picker seeds from real values — never from a transient empty map that a save
// would then persist as a wipe (US-557).
export function SpecificsSection({
  item,
  aspectCoverage,
  loading,
  isEbayOrigin,
  savedCategoryId,
  savedAspects,
  savedSources,
  needsReviewAspects,
  categoryCandidates,
  initialised,
  measurements,
  setMeasurements,
  measurementUnit,
  itemAspectSource,
  onCategoryChange,
  onAspectsChange,
  onUserEdit,
  onSourcesChange,
  onMissingRequiredChange,
}: SpecificsSectionProps) {
  return (
    <div id="composer-category">
    {/* US-1895: recommended-aspect coverage (non-blocking). eBay's
        RECOMMENDED specifics ranked by 30-day buyer search volume — filling
        them lifts findability. Required specifics stay a publish blocker. */}
    {aspectCoverage && aspectCoverage.total > 0 && (
      <Card className="mb-4">
        <CardContent className="space-y-2 py-3">
          <div className="flex items-center justify-between text-sm font-medium">
            <span>Recommended specifics</span>
            <span
              className={cn(
                "tabular-nums",
                aspectCoverage.filled >= aspectCoverage.total
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
              )}
            >
              {aspectCoverage.filled}/{aspectCoverage.total}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{
                width: `${Math.round((aspectCoverage.filled / aspectCoverage.total) * 100)}%`,
              }}
            />
          </div>
          {aspectCoverage.missing.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Most-searched still empty:{" "}
              <span className="text-foreground">
                {aspectCoverage.missing.slice(0, 6).join(", ")}
              </span>
              . Fill them in the specifics below (use “Derive from item” to
              autofill what we can).
            </p>
          )}
        </CardContent>
      </Card>
    )}
    {/* US-2258: platform_category_id is eBay-owned on a mirror, but the item
        specifics in the same editor are not — so warn rather than lock, or
        the seller loses the specifics editor along with the category. */}
    {isEbayOrigin && (
      <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
        eBay owns this listing&apos;s category, so a change here is
        overwritten by the next sync — change it on eBay. Item specifics
        below are yours and save normally.
      </p>
    )}
    {loading ? (
      <Card>
        <CardContent className="py-6">
          <LoadingRegion label="Loading eBay item specifics">
            <SkeletonRows rows={4} />
          </LoadingRegion>
        </CardContent>
      </Card>
    ) : (
      <EbayCategoryPicker
        itemId={item.id}
        initialCategoryId={savedCategoryId}
        initialAspects={savedAspects}
        initialAspectSources={savedSources}
        seedQuery={item.item_title ?? ""}
        itemFields={itemAspectSource}
        measurements={initialised ? measurements : undefined}
        onMeasurementsChange={
          initialised ? setMeasurements : undefined
        }
        measurementUnit={measurementUnit}
        onCategoryChange={onCategoryChange}
        onAspectsChange={onAspectsChange}
        onUserEdit={onUserEdit}
        onSourcesChange={onSourcesChange}
        onMissingRequiredChange={onMissingRequiredChange}
        // US-828: highlight the aspect rows generation reconciliation
        // flagged (a value not in eBay's allowed set / an invented aspect).
        needsReviewAspects={needsReviewAspects}
        // US-2426: the runner-up leaves and their required-aspect scores, read
        // straight off the draft — no fresh AI or Taxonomy call.
        categoryCandidates={categoryCandidates}
      />
    )}
    </div>
  );
}