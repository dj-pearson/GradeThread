// US-2679: the Listing Quality Score, at the top of the surface that can fix it.
//
// The score already rendered in the listings table, on the item page and in the
// pipeline. All three are places a seller LOOKS at a listing; none of them is
// where they EDIT one. So the number arrived after the work was finished, which
// is the least useful moment for a ranked list of what to do next.
//
// Nothing here recomputes anything. The score, its components and the ordering
// of topFixes all come from the server (services/edge-functions/src/lib/
// listing-quality-score.ts) — a client that re-derived the weights would drift
// from the number the same product sorts by everywhere else.

import { ArrowRight, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { anchorForFixSurface } from "@/lib/publish-blockers";
import { scoreBand, type ListingQualityScore } from "@/components/flipdesk/quality-score-chip";
import { cn } from "@/lib/utils";

/** How many fixes to show. AC1 says three; more is a to-do list, not a nudge. */
const TOP_FIX_COUNT = 3;

const BAND_TEXT: Record<ReturnType<typeof scoreBand>, string> = {
  blocked: "text-destructive",
  good: "text-emerald-700 dark:text-emerald-400",
  fair: "text-amber-700 dark:text-amber-400",
  poor: "text-destructive",
};

export function QualityCard({
  score,
  onFocusSurface,
}: {
  /** Null while loading, or for an item with no resolved eBay category. */
  score: ListingQualityScore | null | undefined;
  /** Scroll to and focus the element behind a fix. */
  onFocusSurface: (anchorId: string) => void;
}) {
  // AC4. No score is the normal state for an item that has no eBay category
  // yet, and it is not an error — there is genuinely nothing to say. Rendering
  // an empty shell or a "could not load" would both be worse than silence: one
  // takes the space the title card should have, the other reports a failure
  // that did not happen.
  if (!score) return null;

  const band = scoreBand(score.score, score.blocked);
  const fixes = score.topFixes.slice(0, TOP_FIX_COUNT);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-baseline gap-3">
          <span className={cn("text-3xl font-bold tabular-nums", BAND_TEXT[band])}>
            {score.score}
          </span>
          <div className="text-sm">
            <p className="font-medium">Listing quality</p>
            <p className="text-muted-foreground">
              {score.weightCounted < 100
                ? `Scored on what we could read (${score.weightCounted} of 100 points' worth).`
                : "Scored on everything eBay ranks on."}
            </p>
          </div>
        </div>

        {/* AC3. A blocker is not a bigger version of a fix, it is a different
            kind of thing: the listing cannot go live at all. Given its own
            block, its own icon and destructive text so a seller triaging
            quickly cannot read it as one more nice-to-have. */}
        {score.blocked && score.blockingReasons.length > 0 && (
          <div className="space-y-1 rounded-lg bg-destructive/10 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive">
              <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />
              This listing cannot publish yet
            </p>
            <ul className="space-y-1 text-xs text-destructive">
              {score.blockingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {fixes.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Worth the most, in order
            </p>
            <ul className="space-y-1">
              {fixes.map((fix) => {
                const anchorId = anchorForFixSurface(fix.fixSurface);
                return (
                  <li key={fix.key} className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      {fix.label}
                      <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                        +{fix.pointsAvailable}
                      </span>
                    </span>
                    {/* A fix with nowhere to go in this editor (business
                        policies live in eBay Seller Hub) is still listed, and
                        is simply not a button. A button that scrolls nowhere
                        teaches the seller to stop trusting the others. */}
                    {anchorId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2"
                        onClick={() => onFocusSurface(anchorId)}
                        aria-label={`Fix: ${fix.label}`}
                      >
                        Fix
                        <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
