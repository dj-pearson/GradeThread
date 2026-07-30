import { ArrowRight, Copy, Loader2, Rocket, Ruler, Sparkles } from "lucide-react";
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
  /** US-1088: only offered while the size is genuinely unknown. */
  sizeMissing: boolean;
  sizeEstimating: boolean;
  onEstimateSize: () => void;
  onDuplicate: () => void;
  onMarkListed: () => void;
  onRelist: () => void;
  showMarkListed: boolean;
  showRelist: boolean;
  busy: boolean;
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
  sizeMissing,
  sizeEstimating,
  onEstimateSize,
  onDuplicate,
  onMarkListed,
  onRelist,
  showMarkListed,
  showRelist,
  busy,
}: WorkflowActionsCardProps) {
  const hasOverflow = showMarkListed || showRelist;
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
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {/* Nothing to do next, but still worth offering the item-level actions. */}
      {action.kind === "none" && hasOverflow && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onDuplicate} disabled={busy}>
            <Copy className="mr-2 h-4 w-4" />
            Duplicate this item
          </Button>
        </div>
      )}

      {missingCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary" />
            {missingCount} field{missingCount === 1 ? "" : "s"} missing — let AI
            fill the gaps from your photos.
          </p>
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
