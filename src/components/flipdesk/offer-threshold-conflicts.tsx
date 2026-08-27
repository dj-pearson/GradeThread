import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { edgeFetch } from "@/lib/edge-fetch";

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

interface Conflict {
  listing_id: string;
  title: string | null;
  stored_auto_accept_cents: number | null;
  rule_auto_accept_cents: number | null;
  reason: "raised_to_rule" | "raised_to_margin_floor" | "dropped_no_valid_price";
}

interface ConflictReport {
  rule: { id: string; accept_at_pct: number; margin_floor_pct: number } | null;
  conflicts: Conflict[];
}

function money(cents: number | null): string {
  return cents == null ? "nothing" : `$${(cents / 100).toFixed(2)}`;
}

const REASON_NOTE: Record<Conflict["reason"], string> = {
  raised_to_rule: "below your rule's threshold",
  raised_to_margin_floor: "below your cost floor",
  dropped_no_valid_price: "no price satisfies both your rule and eBay's rules",
};

export function OfferThresholdConflicts() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["ebay_threshold_conflicts"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ConflictReport> => {
      const res = await edgeFetch("/api/flipdesk/ebay/negotiation/threshold-conflicts");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't check your offer thresholds.");
      return json as ConflictReport;
    },
  });

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

  if (!data?.rule || data.conflicts.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-brand-red/40 bg-brand-red/5 p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4" />
        {data.conflicts.length} listing{data.conflicts.length === 1 ? "" : "s"} would be
        auto-accepted by eBay below your rule
      </p>
      <p className="text-xs text-muted-foreground">
        Your rule accepts at {data.rule.accept_at_pct}% of asking and never below cost
        +{data.rule.margin_floor_pct}%. eBay answers first, so on these listings a buyer
        can get a price your rule would have refused.
      </p>
      <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
        {data.conflicts.slice(0, 50).map((c) => (
          <li key={c.listing_id}>
            <span className="font-medium">{c.title || c.listing_id}</span> — eBay accepts
            at {money(c.stored_auto_accept_cents)}, your rule wants{" "}
            {money(c.rule_auto_accept_cents)} ({REASON_NOTE[c.reason]}).
          </li>
        ))}
      </ul>
      {data.conflicts.length > 50 && (
        <p className="text-xs text-muted-foreground">
          Showing 50 of {data.conflicts.length}. Fixing them fixes all of them.
        </p>
      )}
      <Button
        size="sm"
        disabled={reconcile.isPending}
        onClick={() =>
          reconcile.mutate({ listingIds: data.conflicts.map((c) => c.listing_id) })}
      >
        {reconcile.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
        Raise them to match my rule
      </Button>
    </div>
  );
}
