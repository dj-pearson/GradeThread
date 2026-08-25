import { useEffect, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  Loader2,
  ArrowRight,
  Tag,
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
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { toastWarning } from "@/lib/toast-error";
import {
  useBulkRepricePreview,
  useBulkRepriceApply,
  type BulkRepricePreviewRow,
} from "@/hooks/use-repricing";
import { cn } from "@/lib/utils";

interface BulkRepriceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listingIds: string[];
  /** Called after a successful apply so the caller can clear its selection. */
  onApplied: () => void;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const SKIP_LABEL: Record<string, string> = {
  no_comps: "No comps",
  below_margin_floor: "Below floor",
};

export function BulkRepriceDialog({
  open,
  onOpenChange,
  listingIds,
  onApplied,
}: BulkRepriceDialogProps) {
  const preview = useBulkRepricePreview();
  const apply = useBulkRepriceApply();
  const [rows, setRows] = useState<BulkRepricePreviewRow[]>([]);
  const [capped, setCapped] = useState(false);

  // Run the dry-run preview each time the dialog opens for the current
  // selection. Keyed off the joined ids so re-opening a changed selection
  // recomputes.
  const key = listingIds.join(",");
  useEffect(() => {
    if (!open || listingIds.length === 0) return;
    setRows([]);
    preview
      .mutateAsync(listingIds)
      .then((r) => {
        setRows(r.items);
        setCapped(r.capped);
      })
      .catch(() => {
        /* error toast handled by the hook */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  const appliable = rows.filter((r) => r.skip === null && r.delta_cents !== 0);
  const skippedRows = rows.filter((r) => r.skip !== null);
  const unchanged = rows.filter((r) => r.skip === null && r.delta_cents === 0);

  function close() {
    onOpenChange(false);
  }

  async function runApply() {
    if (appliable.length === 0) return;
    try {
      const result = await apply.mutateAsync(
        appliable.map((r) => ({
          listing_id: r.listing_id,
          price_cents: r.suggested_price_cents,
        })),
      );
      const skipNote =
        result.skipped.length > 0
          ? ` (${result.skipped.length} skipped)`
          : "";
      if (result.errors.length === 0) {
        toast.success(
          `Repriced ${result.applied} listing${result.applied === 1 ? "" : "s"}` +
            `${result.ebay_synced > 0 ? `, ${result.ebay_synced} pushed to eBay` : ""}${skipNote}.`,
        );
      } else {
        toastWarning(
          result.errors[0],
          `Repriced ${result.applied}, ${result.errors.length} failed.`,
          { duration: 12_000 },
        );
      }
      onApplied();
      close();
    } catch {
      /* error toast handled by the hook */
    }
  }

  const busy = preview.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            Reprice to comp
          </DialogTitle>
          <DialogDescription>
            Each selected listing is repriced to its condition-matched comp.
            Items with too few comps, or that would fall below your margin floor,
            are skipped.
          </DialogDescription>
        </DialogHeader>

        {busy ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Pricing {listingIds.length} listing
            {listingIds.length === 1 ? "" : "s"} against comps…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Nothing to reprice.
          </div>
        ) : (
          <div className="max-h-[55dvh] space-y-1 overflow-y-auto pr-1">
            {capped && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                Only the first {rows.length} listings were priced — narrow the
                selection to reprice the rest.
              </p>
            )}
            {[...appliable, ...unchanged, ...skippedRows].map((r) => {
              const up = r.delta_cents > 0;
              const isSkipped = r.skip !== null;
              const noChange = !isSkipped && r.delta_cents === 0;
              return (
                <div
                  key={r.listing_id}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
                    isSkipped && "opacity-60",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {r.title}
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-2 tabular-nums">
                    <span className="text-muted-foreground">
                      {money(r.current_price_cents)}
                    </span>
                    {!isSkipped && !noChange && (
                      <>
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 font-semibold",
                            up
                              ? "text-green-600 dark:text-green-400"
                              : "text-amber-600 dark:text-amber-400",
                          )}
                        >
                          {up ? (
                            <TrendingUp className="h-3.5 w-3.5" />
                          ) : (
                            <TrendingDown className="h-3.5 w-3.5" />
                          )}
                          {money(r.suggested_price_cents)}
                        </span>
                      </>
                    )}
                    {isSkipped ? (
                      <Badge variant="outline" className="text-[10px]">
                        {SKIP_LABEL[r.skip as string] ?? "Skipped"}
                      </Badge>
                    ) : noChange ? (
                      <Badge variant="outline" className="text-[10px]">
                        No change
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {r.comp_count} comps
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={apply.isPending}>
            Cancel
          </Button>
          <Button
            onClick={runApply}
            disabled={busy || apply.isPending || appliable.length === 0}
          >
            {apply.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Tag className="mr-2 h-4 w-4" />
            )}
            {appliable.length === 0
              ? "Nothing to apply"
              : `Reprice ${appliable.length} listing${appliable.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
