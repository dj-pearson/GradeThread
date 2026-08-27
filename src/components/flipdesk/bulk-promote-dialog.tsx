import { useState } from "react";
import { Loader2, Megaphone } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { useMutation } from "@tanstack/react-query";
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
import { edgeFetch } from "@/lib/edge-fetch";

// US-2948: change a hundred ad rates in one call instead of a hundred.
//
// ── PER-LISTING RESULTS, NEVER ONE AGGREGATE OK ─────────────────────────────
//
// eBay's bulk endpoints answer 200 while rejecting part of the batch. This
// dialog reports the failures with eBay's own words for each, because a seller
// who is told "done" over forty silently-unpromoted listings has no way to find
// them again.
//
// The fee estimate is shown BEFORE the send. A rate change across a selection
// is a change to what every future sale in it costs, and a number after the
// fact is a number the seller cannot decline.

interface BulkResult {
  listingId: string;
  ok: boolean;
  error: string | null;
}

export function BulkPromoteDialog({
  open,
  onOpenChange,
  listingIds,
  /** The sum of the selected listing prices, in cents. Null when unknown. */
  selectionValueCents,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * LOCAL listing ids, not eBay's. The route resolves them through rows the
   * seller owns, so an id they do not own resolves to nothing — a stronger
   * boundary than trusting an identifier readable off any public listing page.
   */
  listingIds: string[];
  selectionValueCents: number | null;
}) {
  const [rate, setRate] = useState("5");
  const [failures, setFailures] = useState<BulkResult[]>([]);

  const pct = Number(rate);
  const valid = Number.isFinite(pct) && pct > 0 && pct <= 100;
  // Worst case at the CURRENT prices: what this rate costs if everything sells.
  const feeEstimateCents = valid && selectionValueCents != null
    ? Math.round(selectionValueCents * (pct / 100))
    : null;

  const run = useMutation<
    { succeeded: number; failed: number; results: BulkResult[] },
    Error,
    { mode: "create" | "update" }
  >({
    mutationFn: async ({ mode }) => {
      const res = await edgeFetch("/api/flipdesk/ebay/marketing/ads/bulk", {
        method: "POST",
        body: JSON.stringify({
          listing_ids: listingIds,
          bid_percentage: pct,
          mode,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.detail || json.error || "eBay rejected the change.");
      return json;
    },
    onSuccess: (res) => {
      setFailures(res.results.filter((r) => !r.ok));
      if (res.failed === 0) {
        toast.success(`${res.succeeded} listing${res.succeeded === 1 ? "" : "s"} promoted at ${pct}%.`);
        onOpenChange(false);
      } else {
        // Not a success toast. eBay took some and refused others, and saying
        // "done" over that is the lie this whole dialog is shaped to avoid.
        toast.warning(
          `${res.succeeded} promoted, ${res.failed} refused by eBay. The refusals are listed below.`,
        );
      }
    },
    onError: (err) => toastError(err, "eBay rejected the change."),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Promote {listingIds.length} listing
            {listingIds.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Promoted Listings charges this percentage of the sale price, and only
            when the item sells through the ad.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="bulk-ad-rate">Ad rate</Label>
            <Input
              id="bulk-ad-rate"
              type="number"
              min={1}
              max={100}
              step="0.1"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className="h-8 w-24"
            />
            %
          </div>
          <p className="text-sm text-muted-foreground">
            {feeEstimateCents == null
              ? "Some of these have no price on record, so we can't total the fee."
              : `If all of these sell, that is about $${(feeEstimateCents / 100).toFixed(2)} in ad fees at today's prices.`}
          </p>

          {failures.length > 0 && (
            <div className="space-y-1 rounded-md border border-brand-red/40 bg-brand-red/5 p-2">
              <p className="text-sm font-medium">eBay refused {failures.length}:</p>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                {failures.map((f) => (
                  <li key={f.listingId}>
                    <span className="font-medium">{f.listingId}</span> — {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* Two verbs, because they are two different eBay calls: one adds the
              listing to the campaign, one changes the rate on an ad already in
              it. Guessing which the seller meant would silently do nothing on
              half a mixed selection. */}
          <Button
            variant="outline"
            disabled={!valid || run.isPending}
            onClick={() => run.mutate({ mode: "update" })}
          >
            {run.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Change the rate
          </Button>
          <Button
            disabled={!valid || run.isPending}
            onClick={() => run.mutate({ mode: "create" })}
          >
            {run.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Megaphone className="mr-1 h-4 w-4" />
            )}
            Start promoting
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
