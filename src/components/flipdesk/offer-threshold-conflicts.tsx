import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { edgeFetch } from "@/lib/edge-fetch";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatMoney } from "@/pages/flipdesk/offer-economics";
import {
  useEbayThresholdConflicts,
  type OfferThresholdConflict,
} from "@/hooks/use-ebay";

// US-2944: eBay's auto-accept versus the seller's own rule.
//
// Two systems decide the same offer. eBay's per-listing auto-accept fires the
// instant a bid lands; the FlipDesk rule runs hourly and applies a margin floor
// eBay knows nothing about. eBay wins the race, so a listing whose stored
// auto-accept sits BELOW the rule's number is a live hole: an offer in the gap
// is taken at a price the rule would have refused.
//
// ── BOTH NUMBERS, ALWAYS ────────────────────────────────────────────────────
//
// "There is a conflict" with no figures is a warning a seller cannot act on.
// Each row names what eBay will accept at and what the rule wants, so the
// seller can decide whether the rule or the listing is the one that is wrong.

type Conflict = OfferThresholdConflict;

function money(cents: number | null, currency = "USD"): string {
  return cents == null ? "nothing" : formatMoney(cents, currency);
}

const REASON_NOTE: Record<Conflict["reason"], string> = {
  raised_to_rule: "below your rule's threshold",
  raised_to_margin_floor: "below your cost floor",
  dropped_no_valid_price: "no price satisfies both your rule and eBay's rules",
};

/**
 * OM-13: the listing whose auto-accept moves the furthest, for the confirm.
 */
function biggestConflictChange(conflicts: Conflict[]): Conflict | null {
  let best: Conflict | null = null;
  let bestDelta = -1;
  for (const c of conflicts) {
    const delta = Math.abs((c.rule_auto_accept_cents ?? 0) - (c.stored_auto_accept_cents ?? 0));
    if (delta > bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best;
}

export function OfferThresholdConflicts() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  // OM-04: tenant-keyed, via the shared hook.
  const { data, isError, refetch, isFetching } = useEbayThresholdConflicts();

  const reconcile = useMutation<{ updated: number }, Error, { listingIds: string[] }>({
    mutationFn: async ({ listingIds }) => {
      const res = await edgeFetch(
        "/api/flipdesk/ebay/negotiation/threshold-conflicts/reconcile",
        { method: "POST", body: JSON.stringify({ listing_ids: listingIds }) },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't reconcile the thresholds.");
      return json;
    },
    onSuccess: (res) => {
      toast.success(
        `Updated ${res.updated} listing${res.updated === 1 ? "" : "s"}. The new price goes to eBay on the next publish or revise.`,
      );
      void qc.invalidateQueries({ queryKey: ["ebay_threshold_conflicts"] });
    },
    onError: (err) => toastError(err, "Couldn't reconcile the thresholds."),
  });

  // OM-13: a failed check is not "no conflicts". It used to render nothing,
  // which is exactly what a clean result looks like.
  if (isError && !data) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="status">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        Couldn't check eBay auto-accept against your rule.
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2 disabled:opacity-50"
          disabled={isFetching}
          onClick={() => refetch()}
        >
          {isFetching ? "Checking..." : "Retry"}
        </button>
      </p>
    );
  }

  if (!data?.rule || data.conflicts.length === 0) return null;
  const rule = data.rule;
  const conflicts = data.conflicts;

  // OM-13: this rewrites auto-accept on up to 500 listings, so it asks first
  // with the count and the largest single change.
  async function raiseAll() {
    const biggest = biggestConflictChange(conflicts);
    const n = conflicts.length;
    const ok = await confirm({
      title: `Raise ${n} listing${n === 1 ? "" : "s"}?`,
      description:
        (biggest
          ? `Biggest change: ${money(biggest.stored_auto_accept_cents)} to ${money(
              biggest.rule_auto_accept_cents,
            )}. `
          : "") +
        "This changes the price GradeThread holds for each listing. eBay picks it up the next time each listing is published or revised, not right now.",
      confirmLabel: `Raise ${n} listing${n === 1 ? "" : "s"}`,
    });
    if (!ok) return;
    reconcile.mutate({ listingIds: conflicts.map((c) => c.listing_id) });
  }

  return (
    <div className="space-y-2 rounded-md border border-brand-red/40 bg-brand-red/5 p-3 text-brand-red-text">
      <p className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4" />
        {conflicts.length} listing{conflicts.length === 1 ? "" : "s"} would be
        auto-accepted by eBay below your rule
      </p>
      {/* OM-13: secondary text is tinted from the red foreground rather than
          gray, which read as washed out on the red surface. */}
      <p className="text-xs text-brand-red-text/80">
        Your rule accepts at {rule.accept_at_pct}% of asking and never below cost
        +{rule.margin_floor_pct}%. eBay answers first, so on these listings a buyer
        can get a price your rule would have refused.
      </p>
      <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-brand-red-text/80">
        {conflicts.slice(0, 50).map((c) => (
          <li key={c.listing_id}>
            <span className="font-medium">{c.title || c.listing_id}</span>: eBay accepts
            at {money(c.stored_auto_accept_cents)}, your rule wants{" "}
            {money(c.rule_auto_accept_cents)} ({REASON_NOTE[c.reason]}).
          </li>
        ))}
      </ul>
      {conflicts.length > 50 && (
        <p className="text-xs text-brand-red-text/80">
          Showing 50 of {conflicts.length}. Fixing them fixes all of them.
        </p>
      )}
      <Button size="sm" disabled={reconcile.isPending} onClick={raiseAll}>
        {reconcile.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
        Raise them to match my rule
      </Button>
    </div>
  );
}
