import { useMemo, useState } from "react";
import { Loader2, Send } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChannelPickHead } from "@/components/flipdesk/composer/channel-pick-head";
import { listOnRows } from "@/lib/list-on-channels";
import { useCrossPostChannels } from "@/hooks/use-cross-post-channels";
import { QUEUED_NOTICE } from "@/hooks/use-extension-queue";
import type { CrossPushPlatform } from "@/lib/constants";

// US-3456: select N items, choose the marketplaces, one button.
//
// The rows are the composer's List on rows (listOnRows, US-3450) with no
// per-item state: a batch is many items, and the server applies the
// already-live and already-queued skips per item per channel. eBay is offered
// too, and goes to the publish batch the page already has; the other channels
// go to POST /cross-push-bulk in one request. The dialog reports the plan, the
// caller runs it and toasts the result.

export interface BulkCrossListChoice {
  platforms: CrossPushPlatform[];
  batchLabel: string;
}

export interface BulkCrossListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemCount: number;
  /** eBay is connected, so it can be offered. */
  ebayConnected: boolean;
  running: boolean;
  onConfirm: (choice: BulkCrossListChoice) => void;
}

function defaultLabel(): string {
  const d = new Date();
  return `Cross-list ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function BulkCrossListDialog({
  open,
  onOpenChange,
  itemCount,
  ebayConnected,
  running,
  onConfirm,
}: BulkCrossListDialogProps) {
  const { data: chosenChannels } = useCrossPostChannels();
  const rows = useMemo(() => listOnRows(chosenChannels, {}), [chosenChannels]);
  const [ticked, setTicked] = useState<Set<CrossPushPlatform>>(new Set());
  const [label, setLabel] = useState(defaultLabel);

  const platforms = rows.filter((r) => !r.blocked && ticked.has(r.platform)).map((r) => r.platform);
  const extensionCount = rows.filter((r) => platforms.includes(r.platform) && r.mechanism === "extension").length;
  const jobs = itemCount * platforms.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cross-list {itemCount} item{itemCount === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            Tick the marketplaces. Each item goes to each one; a channel an
            item is already on is left alone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {rows.map((r) => {
            const blocked = r.platform === "ebay" && !ebayConnected
              ? "Connect eBay first"
              : r.blocked;
            return (
              <div key={r.platform} className="rounded-md border p-2.5">
                <ChannelPickHead
                  id={`bulk-list-on-${r.platform}`}
                  label={r.label}
                  mechanism={r.mechanism}
                  blocked={blocked}
                  checked={!blocked && ticked.has(r.platform)}
                  disabled={running}
                  onToggle={() =>
                    setTicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.platform)) next.delete(r.platform);
                      else next.add(r.platform);
                      return next;
                    })}
                />
              </div>
            );
          })}
          <div className="space-y-1 pt-1">
            <Label htmlFor="bulk-cross-list-label">Batch name</Label>
            <Input
              id="bulk-cross-list-label"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              disabled={running}
            />
            <p className="text-xs text-muted-foreground">
              Shown on every queued job so the batch reads as one thing in the extension.
            </p>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="bulk-cross-list-plan">
            {jobs === 0
              ? "Pick at least one marketplace."
              : `${jobs} listing${jobs === 1 ? "" : "s"} across ${platforms.length} marketplace${platforms.length === 1 ? "" : "s"}.` +
                (extensionCount > 0
                  ? ` ${extensionCount} of them queue for your browser, one at a time. ${QUEUED_NOTICE}`
                  : "")}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button
            disabled={running || platforms.length === 0}
            onClick={() => onConfirm({ platforms, batchLabel: label.trim() })}
          >
            {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Cross-list {itemCount}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
