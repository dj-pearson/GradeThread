import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Rocket,
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
import {
  usePublishToEbay,
  useValidatePublish,
  type PublishSummary,
} from "@/hooks/use-ebay";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
}

export function PublishToEbayDialog({ open, onOpenChange, itemId }: Props) {
  const validate = useValidatePublish();
  const publish = usePublishToEbay();
  const [result, setResult] = useState<{
    listingUrl: string;
    listingId: string;
  } | null>(null);

  // Run validation each time the dialog opens. Resets the result so a second
  // open after a successful publish starts fresh.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    validate.mutate({ itemId });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId]);

  const summary: PublishSummary | undefined = validate.data?.summary;
  const blockers = validate.data?.blockers ?? [];
  const canPublish = !!validate.data?.ok && blockers.length === 0;
  const isPublishing = publish.isPending;

  async function handlePublish() {
    try {
      const res = await publish.mutateAsync({ itemId });
      if (res.listing_url && res.listing_id) {
        setResult({
          listingUrl: res.listing_url,
          listingId: res.listing_id,
        });
        toast.success("Listing is live on eBay.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Single multiline toast — eBay error messages can be long.
      toast.error(msg.split("\n")[0] ?? "Publish failed.", {
        description: msg.split("\n").slice(1).join(" • ") || undefined,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5" />
            Publish to eBay
          </DialogTitle>
          <DialogDescription>
            Live listing on{" "}
            <Badge variant="secondary" className="font-normal">
              eBay
            </Badge>{" "}
            using your connected seller account.
          </DialogDescription>
        </DialogHeader>

        {/* Already published */}
        {result && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">
              <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-600" />
              <div>
                <div className="font-medium text-emerald-900 dark:text-emerald-200">
                  Your listing is live.
                </div>
                <div className="mt-1 text-xs text-emerald-800/80 dark:text-emerald-200/80">
                  eBay item #{result.listingId}
                </div>
              </div>
            </div>
            <Button asChild className="w-full">
              <a
                href={result.listingUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on eBay
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </div>
        )}

        {/* Validating */}
        {!result && validate.isPending && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking listing requirements…
          </div>
        )}

        {/* Blockers */}
        {!result && !validate.isPending && blockers.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Fix these before publishing
            </div>
            <ul className="space-y-1 rounded-md border bg-amber-50 p-3 text-xs dark:bg-amber-950/30">
              {blockers.map((b) => (
                <li key={b} className="text-amber-900 dark:text-amber-200">
                  • {b}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Ready to publish */}
        {!result && !validate.isPending && canPublish && summary && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
            <Row label="Title" value={summary.title} truncate />
            <Row
              label="Price"
              value={`${summary.priceValue} ${summary.currency}`}
            />
            <Row label="Condition" value={summary.condition} />
            {summary.conditionDescription && (
              <Row
                label="Notes"
                value={summary.conditionDescription}
                truncate
              />
            )}
          </div>
        )}

        {/* Validation network error (separate from blockers) */}
        {!result && validate.isError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {(validate.error as Error).message}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPublishing}
          >
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              onClick={handlePublish}
              disabled={!canPublish || isPublishing}
            >
              {isPublishing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Publishing…
                </>
              ) : (
                <>
                  <Rocket className="mr-2 h-4 w-4" />
                  Publish to eBay
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  truncate,
}: {
  label: string;
  value: string;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={
          truncate
            ? "max-w-[60%] truncate text-right font-medium"
            : "text-right font-medium"
        }
      >
        {value}
      </div>
    </div>
  );
}
