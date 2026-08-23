import {
  ArrowRight,
  CircleSlash,
  Copy,
  Loader2,
  RefreshCw,
  Rocket,
  Ruler,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { NextAction } from "@/lib/workflow";
import type { ItemFullRow } from "@/types/database";

export interface WorkflowActionsCardProps {
  item: ItemFullRow;
  action: NextAction;
  /** Drives the pinned CTA. */
  onRunNextAction: () => void;
  /** US-2264: how many enrichable fields are still blank. 0 hides the AI offer. */
  missingCount: number;
  /** False when there is nothing for the AI to read (no photos, no text). */
  canComplete: boolean;
  completing: boolean;
  onCompleteWithAi: () => void;
  /**
   * US-2817: re-read the photos from scratch and offer a fresh identification,
   * including for fields that are already filled. Separate from
   * `onCompleteWithAi`, which only ever proposes values for gaps — so on an
   * item catalogued months ago by a weaker model there was nothing to click.
   */
  onReidentify: () => void;
  /** When the AI last wrote to this item; null if it never has. */
  aiEnrichedAt: string | null;
  /** US-1088: only offered while the size is genuinely unknown. */
  sizeMissing: boolean;
  sizeEstimating: boolean;
  onEstimateSize: () => void;
  onDuplicate: () => void;
  onMarkListed: () => void;
  onRelist: () => void;
  /** Withdraw the live eBay listing and drop the item back to Drafts. */
  onEndListing: () => void;
  showMarkListed: boolean;
  showRelist: boolean;
  /** True only while there is a live eBay listing to end. */
  showEndListing: boolean;
  endingListing: boolean;
  busy: boolean;
}

// "3 months ago" — enough for the seller to judge whether the identifier has
// moved on since. Deliberately coarse: the exact minute is noise here.
function relativeDay(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "earlier";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? "about a month ago" : `about ${months} months ago`;
}

const TONE: Record<NextAction["tone"], string> = {
  todo: "border-primary/30 bg-primary/5",
  ready: "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10",
  done: "border-muted bg-muted/30",
  muted: "border-muted bg-muted/20",
};

// US-2264: the workflow actions that only ever existed on ItemCanvas — a
// component no route has rendered since the composer replaced it, so these were
// shipped to nobody.
//
// The pinned CTA answers "what do I do next with this item", which a form full
// of fields cannot: it reads the completed work (nextAction in src/lib/workflow.ts)
// and either scrolls to the section that is blocking or performs the step.
// "Complete with AI" and Size AI fill gaps from the photos rather than making the
// seller type what the garment already shows.
export function WorkflowActionsCard({
  item,
  action,
  onRunNextAction,
  missingCount,
  canComplete,
  completing,
  onCompleteWithAi,
  onReidentify,
  aiEnrichedAt,
  sizeMissing,
  sizeEstimating,
  onEstimateSize,
  onDuplicate,
  onMarkListed,
  onRelist,
  onEndListing,
  showMarkListed,
  showRelist,
  showEndListing,
  endingListing,
  busy,
}: WorkflowActionsCardProps) {
  const hasOverflow = showMarkListed || showRelist || showEndListing;
  // One menu, rendered in both branches. It used to exist only alongside a
  // "next action", so an item with nothing left to do fell through to a bare
  // Duplicate button and lost every other action — including, once End moved
  // here, the only in-editor way to withdraw a live listing.
  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy}>
          More
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy className="mr-2 h-4 w-4" />
          Duplicate this item
        </DropdownMenuItem>
        {showMarkListed && (
          <DropdownMenuItem onClick={onMarkListed}>
            <Rocket className="mr-2 h-4 w-4" />
            Mark as listed elsewhere
          </DropdownMenuItem>
        )}
        {showRelist && (
          <DropdownMenuItem onClick={onRelist}>
            <Rocket className="mr-2 h-4 w-4" />
            Relist this item
          </DropdownMenuItem>
        )}
        {showEndListing && (
          <DropdownMenuItem
            onClick={onEndListing}
            disabled={endingListing}
            className="text-destructive focus:text-destructive"
          >
            {endingListing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CircleSlash className="mr-2 h-4 w-4" />
            )}
            End listing on eBay
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <div className="space-y-2">
      {action.kind !== "none" && (
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3",
            TONE[action.tone],
          )}
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold">Next: {action.label}</p>
            <p className="text-xs text-muted-foreground">
              Based on what's already done for this item.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {action.tone !== "done" && (
              <Button size="sm" onClick={onRunNextAction} disabled={busy}>
                {action.label}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
            {overflowMenu}
          </div>
        </div>
      )}

      {/* Nothing to do next, but still worth offering the item-level actions. */}
      {action.kind === "none" && hasOverflow && (
        <div className="flex justify-end">{overflowMenu}</div>
      )}

      {missingCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary" />
            {missingCount} field{missingCount === 1 ? "" : "s"} missing — let AI
            fill the gaps from your photos.
          </p>
          <div className="flex items-center gap-2">
            {/* Partly filled and partly wrong is a real state, so the re-run
                stays reachable here rather than only once nothing is missing. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onReidentify}
              disabled={!canComplete || completing}
              title="Ignore what's already filled in and read the photos from scratch."
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Re-run all
            </Button>
            <Button
              size="sm"
              onClick={onCompleteWithAi}
              disabled={!canComplete || completing}
              title={
                canComplete
                  ? undefined
                  : "Add photos or a description first so the AI has something to read."
              }
            >
              {completing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              Complete with AI
            </Button>
          </div>
        </div>
      )}

      {/* US-2817: the gap-fill offer above disappears the moment every field is
          full, which is exactly the state an old draft is in — cataloged by a
          weaker identifier, complete, and wrong. This re-reads the photos and
          proposes replacements for what is already there. Nothing is saved
          until the seller accepts it in the review panel. */}
      {missingCount === 0 && canComplete && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4" />
            {aiEnrichedAt
              ? `AI last read this item ${relativeDay(aiEnrichedAt)}.`
              : "Details are filled in."}{" "}
            Check the photos again for a better identification?
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onReidentify}
            disabled={completing}
            title="Reads the photos from scratch and shows you what it would change. Nothing is saved until you accept it."
          >
            {completing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Re-run AI
          </Button>
        </div>
      )}

      {/* US-1088: a cut-off or missing size label is common on thrifted stock, and
          the flat-lay photos already carry the answer. Offered only while the size
          is unknown, so it disappears the moment it's filled. */}
      {sizeMissing && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Ruler className="h-4 w-4" />
            No size on this item{item.brand ? ` — ${item.brand} sizing` : ""}.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onEstimateSize}
            disabled={sizeEstimating}
          >
            {sizeEstimating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Estimate size from photos
          </Button>
        </div>
      )}
    </div>
  );
}
