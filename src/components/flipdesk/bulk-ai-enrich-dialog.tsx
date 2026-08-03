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
  type BulkExtractResponse,
} from "@/hooks/use-ai-extract";
import { useAuth } from "@/hooks/use-auth";
import { FLIPDESK_PLANS, flipdeskPlanForLegacy, type PlanKey } from "@/lib/constants";

interface BulkAiEnrichDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemIds: string[];
  /** Open a single item for per-item review of pending suggestions. */
  onReviewItem: (itemId: string) => void;
  /** Called after a batch completes so the caller can refetch. */
  onDone: () => void;
}

export function BulkAiEnrichDialog({
  open,
  onOpenChange,
  itemIds,
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

  async function run() {
    try {
      const r = await bulk.mutateAsync({ item_ids: itemIds });
      setResult(r);
      onDone();
    } catch {
      /* error toast handled by the hook */
    }
  }

  function close() {
    setResult(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI enrich {itemIds.length} item
            {itemIds.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            {result
              ? "Batch complete."
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
                        `${r.applied.length} field${
                          r.applied.length === 1 ? "" : "s"
                        } applied`}
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
                Enrich {willProcess} item{willProcess === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
