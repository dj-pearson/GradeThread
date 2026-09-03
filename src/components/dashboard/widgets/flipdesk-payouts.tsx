import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { EbayPayoutsCard } from "@/components/flipdesk/ebay-payouts-card";
import { useEbayPayouts, useEbayConnection } from "@/hooks/use-ebay";
import { WidgetLoadError } from "@/components/dashboard/widgets/flipdesk-shared";

// US-3078 AC1: the eBay payouts card, on the board.
//
// The card itself is NOT reimplemented here. It is imported and rendered, and
// the Money page goes on rendering the same component: two copies of a payout
// list is two places for "pending" to come to mean different things, and the
// seller would find out by seeing two numbers.
//
// What this module adds is the one line the card does not have and a board
// wants: how much money is still on its way, above the list of individual
// deposits. That is a summary of the same read (useEbayPayouts, one TanStack
// key, deduped with the card's own call), not a second version of the rows.

/** Where a payout is reconciled against what actually hit the bank (AC1). */
const PAYOUTS_HREF = "/dashboard/flipdesk/money?view=reconcile&tab=ebay";

/** Payout states that mean the money has not landed yet. */
const PENDING_STATES = new Set(["INITIATED", "RETRYABLE_FAILED", "PROCESSING"]);

function net(amount: { value: string; currency: string } | null): number {
  const n = Number(amount?.value);
  return Number.isFinite(n) ? n : 0;
}

/** The soonest dated payout in a list, or null when none carries a date. */
function nextDate(dates: readonly (string | null)[]): Date | null {
  const times = dates
    .map((d) => (d ? new Date(d).getTime() : Number.NaN))
    .filter((t) => Number.isFinite(t));
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

export function FlipdeskPayoutsWidget() {
  const { data: connection } = useEbayConnection();
  const connected = !!connection;
  const { isError, isFetching, refetch, data } = useEbayPayouts(connected);

  if (isError) {
    return (
      <WidgetLoadError
        what="your eBay payouts"
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  const payouts = data?.payouts ?? [];
  const pending = payouts.filter((p) => PENDING_STATES.has(p.payoutStatus));
  const pendingNet = pending.reduce((sum, p) => sum + net(p.amount), 0);
  const due = nextDate(pending.map((p) => p.payoutDate));

  // Not connected: the card renders nothing and so does this, which lets the
  // frame say "nothing to show yet" once instead of showing a heading over a
  // link to a page about deposits the account cannot receive.
  if (!connected) return <EbayPayoutsCard />;

  return (
    <div className="space-y-3">
      {pending.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {pending.length} payout{pending.length === 1 ? "" : "s"} on the way,
            ${pendingNet.toFixed(2)} net
          </span>
          {due ? `. Next one dated ${due.toLocaleDateString()}.` : "."}
        </p>
      ) : null}
      <EbayPayoutsCard />
      <Link
        to={PAYOUTS_HREF}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        Reconcile these against your bank
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    </div>
  );
}
