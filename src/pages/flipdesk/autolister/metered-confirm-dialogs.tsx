import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// US-2520: lifted out of autolister.tsx, which was one 3,750-line component
// holding 83 pieces of state. These three dialogs are the cleanest seam in it —
// each is a confirm step that reads a handful of values and calls one function,
// and none of them touches the drag-and-drop grid the rest of the page is built
// around.
//
// They share a job: nothing here spends an AI action without first saying how
// many it will spend, and how many the seller has left (US-1546 / US-1903 /
// US-1904). Keeping them together is what makes that rule checkable.

export interface VerifyConfirmState<W> {
  windows: W[];
  windowCount: number;
  totalGroups: number;
}

export interface ProposeConfirmState {
  windows: string[][];
  windowCount: number;
  photoCount: number;
}

/** Would this many actions overdraw the seller's monthly allowance? */
function overBudget(count: number | undefined, remaining: number | null): boolean {
  return remaining != null && count != null && count > remaining;
}

function remainingClause(remaining: number | null): string {
  return remaining != null ? ` of your ${remaining} remaining` : "";
}

export function GenerateConfirmDialog({
  open,
  onOpenChange,
  listableCount,
  stagedCount,
  ungroupedCount,
  aiActionsRemaining,
  groupWarnings,
  onWarningClick,
  ackUngrouped,
  onAckUngroupedChange,
  partial = null,
  maxItems = Infinity,
  protectedSkus = [],
  attachProtected = false,
  onAttachProtectedChange,
  onGenerate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listableCount: number;
  stagedCount: number;
  ungroupedCount: number;
  aiActionsRemaining: number | null;
  groupWarnings: { key: string; groupId: string; label: string }[];
  onWarningClick: (groupId: string) => void;
  ackUngrouped: boolean;
  onAckUngroupedChange: (next: boolean) => void;
  /**
   * US-2621: set when this Generate covers only some of the session's items,
   * and says what is being left behind. Non-null also means the run does not
   * end the session, so the counts above describe the chosen items alone.
   */
  partial?: { remainingGroups: number; remainingPhotos: number } | null;
  /**
   * AL-07: the most this run can send, min(the edge's 300 cap, AI actions
   * left). Over it, the full Generate is disabled and "Generate the first N"
   * is offered instead of a batch the server will refuse.
   */
  maxItems?: number;
  /** AL-07: SKU matches on items already listed, sold, shipped or archived. */
  protectedSkus?: { groupId: string; name: string; sku: string; status: string }[];
  attachProtected?: boolean;
  onAttachProtectedChange?: (next: boolean) => void;
  /** No argument: everything in scope. A number: only the first N items. */
  onGenerate: (firstN?: number) => void;
}) {
  const plural = listableCount === 1 ? "" : "s";
  const tooMany = listableCount > maxItems;
  const firstN = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Generate {listableCount} listing{plural}?
          </DialogTitle>
          <DialogDescription>
            {stagedCount} photo{stagedCount === 1 ? "" : "s"} staged · ~
            {listableCount} AI action{plural}
            {remainingClause(aiActionsRemaining)}
            {overBudget(listableCount, aiActionsRemaining)
              ? " — this batch won't fit; trim it or upgrade."
              : ""}
          </DialogDescription>
        </DialogHeader>

        {groupWarnings.length > 0 && (
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
              {groupWarnings.length} thing
              {groupWarnings.length === 1 ? "" : "s"} worth a look first:
            </p>
            {groupWarnings.map((w) => (
              <button
                key={w.key}
                type="button"
                onClick={() => onWarningClick(w.groupId)}
                className="block w-full truncate text-left text-xs text-amber-800 underline-offset-2 hover:underline dark:text-amber-200"
              >
                • {w.label}
              </button>
            ))}
          </div>
        )}

        {partial && (
          <p className="rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground">
            Only the item{plural} you picked go now.{" "}
            {partial.remainingGroups > 0 && (
              <>
                {partial.remainingGroups} other item
                {partial.remainingGroups === 1 ? "" : "s"}
              </>
            )}
            {partial.remainingGroups > 0 && partial.remainingPhotos > 0 && " and "}
            {partial.remainingPhotos > 0 && (
              <>
                {partial.remainingPhotos} ungrouped photo
                {partial.remainingPhotos === 1 ? "" : "s"}
              </>
            )}
            {partial.remainingGroups > 0 || partial.remainingPhotos > 0
              ? " stay here, ready when you are."
              : ""}
          </p>
        )}

        {protectedSkus.length > 0 && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
            <input
              type="checkbox"
              checked={attachProtected}
              onChange={(e) => onAttachProtectedChange?.(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
            />
            <span>
              <span className="font-medium">
                {protectedSkus.length} SKU{protectedSkus.length === 1 ? " matches an item" : "s match items"} you already moved on:
              </span>{" "}
              {protectedSkus.map((m) => `${m.name} (${m.sku}, ${m.status})`).join(", ")}.
              {" "}They are skipped unless you tick this. Their status won't change either way.
            </span>
          </label>
        )}

        {tooMany && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
            {firstN > 0
              ? `This run can send at most ${firstN} item${firstN === 1 ? "" : "s"}. Send the first ${firstN} now; the rest stay here.`
              : "No AI actions are left this month. Trim the batch or upgrade."}
          </p>
        )}

        {ungroupedCount > 0 && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm">
            <input
              type="checkbox"
              checked={ackUngrouped}
              onChange={(e) => onAckUngroupedChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
            />
            <span>
              <span className="font-medium">
                {ungroupedCount} photo{ungroupedCount === 1 ? "" : "s"} will NOT
                be listed
              </span>{" "}
              — they're still ungrouped. Generate anyway; they stay staged here.
            </span>
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep editing
          </Button>
          {tooMany && firstN > 0 && (
            <Button onClick={() => onGenerate(firstN)}>
              <Sparkles className="mr-2 h-4 w-4" />
              Generate the first {firstN}
            </Button>
          )}
          <Button
            onClick={() => onGenerate()}
            disabled={tooMany || (ungroupedCount > 0 && !ackUngrouped)}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Generate {listableCount} listing{plural}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VerifyConfirmDialog<W>({
  confirm,
  onCancel,
  aiActionsRemaining,
  onConfirm,
}: {
  confirm: VerifyConfirmState<W> | null;
  onCancel: () => void;
  aiActionsRemaining: number | null;
  onConfirm: (windows: W[]) => void;
}) {
  return (
    <Dialog open={!!confirm} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Verify all {confirm?.totalGroups} groups?</DialogTitle>
          <DialogDescription>
            This session is too large for one AI check, so it runs in{" "}
            {confirm?.windowCount} batches — {confirm?.windowCount} AI action
            {confirm?.windowCount === 1 ? "" : "s"}
            {remainingClause(aiActionsRemaining)}. You can stop between batches;
            suggestions appear as you go.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={overBudget(confirm?.windowCount, aiActionsRemaining)}
            onClick={() => {
              if (confirm) onConfirm(confirm.windows);
            }}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Verify all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProposeConfirmDialog({
  confirm,
  onCancel,
  aiActionsRemaining,
  onConfirm,
}: {
  confirm: ProposeConfirmState | null;
  onCancel: () => void;
  aiActionsRemaining: number | null;
  onConfirm: (windows: string[][]) => void;
}) {
  return (
    <Dialog open={!!confirm} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>AI-group {confirm?.photoCount} photos?</DialogTitle>
          <DialogDescription>
            Too many photos for one AI pass, so it runs in{" "}
            {confirm?.windowCount} batches — {confirm?.windowCount} AI action
            {confirm?.windowCount === 1 ? "" : "s"}
            {remainingClause(aiActionsRemaining)}. You can stop between batches;
            confident items are created (undoable), unsure ones show up to
            review.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={overBudget(confirm?.windowCount, aiActionsRemaining)}
            onClick={() => {
              if (confirm) onConfirm(confirm.windows);
            }}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Group them
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
