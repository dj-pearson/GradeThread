import { useState } from "react";
import {
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  useBulkExtract,
  type BulkExtractMode,
  type BulkExtractResponse,
} from "@/hooks/use-ai-extract";
import { useAuth } from "@/hooks/use-auth";
import { FLIPDESK_PLANS, flipdeskPlanForLegacy, type PlanKey } from "@/lib/constants";

interface BulkAiEnrichDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemIds: string[];
  /**
   * US-2817: "gap_fill" (default) only fills blanks. "reidentify" re-reads the
   * photos on items the AI has already done and lets a confident new answer
   * replace the old AI one — for stock that was catalogued before the
   * identifier improved. Values the seller typed are never overwritten either
   * way.
   */
  mode?: BulkExtractMode;
  /** Open a single item for per-item review of pending suggestions. */
  onReviewItem: (itemId: string) => void;
  /** Called after a batch completes so the caller can refetch. */
  onDone: () => void;
}

export function BulkAiEnrichDialog({
  open,
  onOpenChange,
  itemIds,
  mode = "gap_fill",
  onReviewItem,
  onDone,
}: BulkAiEnrichDialogProps) {
  const { profile } = useAuth();
  const bulk = useBulkExtract();
  const [result, setResult] = useState<BulkExtractResponse | null>(null);

  // US-2365: prefer flipdesk_plan, which is the current column; fall back to
  // translating the legacy one for a profile that predates the backfill. The
  // same shape settings.tsx already used — this was the only caller still
  // reading the legacy value unconditionally.
  const flipdeskPlan = profile?.flipdesk_plan ??
    flipdeskPlanForLegacy((profile?.plan ?? "free") as PlanKey);
  const limit = profile?.ai_action_limit ??
    FLIPDESK_PLANS[flipdeskPlan].aiActionsPerMonth;
  const used = profile?.ai_actions_used_this_month ?? 0;
  const unlimited = limit < 0;
  const remaining = unlimited ? Infinity : Math.max(0, limit - used);
  const willProcess = unlimited
    ? itemIds.length
    : Math.min(itemIds.length, remaining);
  const willSkip = itemIds.length - willProcess;

  const reidentify = mode === "reidentify";
  // Off by default and reset on every open: this is the one control here that
  // can overwrite something the seller typed, so it must never be sticky.
  const [overwriteUntracked, setOverwriteUntracked] = useState(false);

  async function run() {
    try {
      const r = await bulk.mutateAsync({
        item_ids: itemIds,
        mode,
        overwrite_untracked: reidentify && overwriteUntracked,
      });
      setResult(r);
      onDone();
    } catch {
      /* error toast handled by the hook */
    }
  }

  function close() {
    setResult(null);
    setOverwriteUntracked(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {reidentify ? "Re-run AI on" : "AI enrich"} {itemIds.length} item
            {itemIds.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            {result
              ? "Batch complete."
              : reidentify
                ? "AI reads the photos again from scratch and updates what it got wrong before. Anything you typed yourself is kept — those come back for review instead."
                : "AI will fill missing fields. High-confidence values are applied automatically; uncertain ones are left for you to review."}
          </DialogDescription>
        </DialogHeader>

        {/* Pre-flight estimate */}
        {!result && (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Selected items</span>
              <span className="font-medium">{itemIds.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                AI actions this consumes
              </span>
              <span className="font-medium">{willProcess}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Actions remaining this month
              </span>
              <span className="font-medium">
                {unlimited ? "Unlimited" : remaining}
              </span>
            </div>
            {reidentify && (
              // Without this, a run over drafts made before GradeThread started
              // recording where each value came from will report a lot and
              // change almost nothing — every value on them looks typed by
              // hand. Off by default, because only the seller knows which ones
              // actually were.
              <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                  checked={overwriteUntracked}
                  onChange={(e) => setOverwriteUntracked(e.target.checked)}
                />
                <span>
                  <span className="font-medium">
                    Also update older items where we did not record who filled
                    the field in
                  </span>
                  <span className="block text-muted-foreground">
                    Turn this on for drafts from before this feature existed.
                    Anything you typed on those could be replaced.
                  </span>
                </span>
              </label>
            )}
            {willSkip > 0 && (
              <p className="flex items-center gap-1.5 rounded-md bg-amber-100 p-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {willSkip} item{willSkip === 1 ? "" : "s"} will be skipped —
                they exceed your monthly AI allowance.
              </p>
            )}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-md border p-2">
                <div className="text-lg font-bold text-green-600 dark:text-green-400">
                  {result.summary.enriched}
                </div>
                <div className="text-xs text-muted-foreground">Enriched</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-lg font-bold text-amber-600 dark:text-amber-400">
                  {result.summary.needs_review}
                </div>
                <div className="text-xs text-muted-foreground">
                  Needs review
                </div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-lg font-bold text-red-600 dark:text-red-400">
                  {result.summary.failed}
                </div>
                <div className="text-xs text-muted-foreground">Failed</div>
              </div>
            </div>
            {reidentify && (
              // The question a re-run has to answer is "did anything actually
              // change?" — an enriched count alone reads the same whether the
              // AI corrected forty items or agreed with all of them.
              <p className="text-xs text-muted-foreground">
                {(result.summary.replaced ?? 0) > 0
                  ? `${result.summary.replaced} field${
                      result.summary.replaced === 1 ? "" : "s"
                    } updated from the earlier AI answer.`
                  : result.overwrite_untracked
                    ? "Nothing changed — the new pass agreed with what was there."
                    : "Nothing was overwritten. On older drafts, tick the box about fields we did not record and run it again."}
              </p>
            )}
            {result.summary.skipped > 0 && (
              <p className="text-xs text-muted-foreground">
                {result.summary.skipped} item
                {result.summary.skipped === 1 ? "" : "s"} skipped (monthly
                allowance).
              </p>
            )}
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {result.results.map((r) => (
                <div
                  key={r.item_id}
                  className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    {r.status === "enriched" && (
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                    )}
                    {r.status === "needs_review" && (
                      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    )}
                    {r.status === "failed" && (
                      <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                    )}
                    <span className="text-muted-foreground">
                      {r.status === "enriched" &&
                        (r.applied.length === 0
                          ? "No change"
                          : `${r.applied.length} field${
                              r.applied.length === 1 ? "" : "s"
                            } applied${
                              (r.replaced?.length ?? 0) > 0
                                ? ` (${r.replaced?.length} corrected)`
                                : ""
                            }`)}
                      {r.status === "needs_review" &&
                        `${r.pending.length} field${
                          r.pending.length === 1 ? "" : "s"
                        } to review`}
                      {r.status === "failed" && (r.reason ?? "Failed")}
                    </span>
                  </span>
                  {r.status === "needs_review" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      onClick={() => {
                        onReviewItem(r.item_id);
                        close();
                      }}
                    >
                      Review
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={close}
                disabled={bulk.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={run}
                disabled={bulk.isPending || willProcess === 0}
              >
                {bulk.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {reidentify ? "Re-run on" : "Enrich"} {willProcess} item
                {willProcess === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
