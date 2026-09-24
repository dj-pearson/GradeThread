import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { EbayPayoutsCard } from "@/components/flipdesk/ebay-payouts-card";
import {
  FAILED_PAYOUT_STATE,
  PENDING_PAYOUT_STATES,
  formatPayoutTotals,
  nextPayoutDate,
} from "@/lib/payout-summary";
import { useEbayPayouts, useEbayConnection } from "@/hooks/use-ebay";
import {
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

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

export function FlipdeskPayoutsWidget() {
  const { data: connection, isLoading: connectionLoading } = useEbayConnection();
  const connected = !!connection;
  const { isError, isFetching, refetch, data } = useEbayPayouts(connected);

  if (connectionLoading) return <StatTileSkeleton label="eBay payouts" />;

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
  const pending = payouts.filter((p) => PENDING_PAYOUT_STATES.has(p.payoutStatus));
  const failed = payouts.filter((p) => p.payoutStatus === FAILED_PAYOUT_STATE);
  const due = nextPayoutDate(pending.map((p) => p.payoutDate));

  if (!connected) return <EbayPayoutsCard />;

  return (
    <div className="space-y-3">
      {failed.length > 0 ? (
        <p className="text-sm text-destructive" data-testid="payouts-failed">
          <Link to={PAYOUTS_HREF} className="font-medium underline underline-offset-2">
            {failed.length} payout{failed.length === 1 ? "" : "s"} failed to send,{" "}
            {formatPayoutTotals(failed.map((p) => p.amount))}
          </Link>
          . eBay will retry once your payout details are fixed.
        </p>
      ) : null}
      {pending.length > 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="payouts-pending">
          <span className="font-medium text-foreground tabular-nums">
            {pending.length} payout{pending.length === 1 ? "" : "s"} on the way,{" "}
            {formatPayoutTotals(pending.map((p) => p.amount))} net
          </span>
          {due ? `. Next one dated ${due.toLocaleDateString()}.` : "."}
        </p>
      ) : null}
      <EbayPayoutsCard bare />
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
