import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/ledger-math";
import { ymd } from "@/lib/tax-profile";
import {
  ensureLedgerBuilt,
  fetchLedgerReconciliation,
  invalidateLedgerQueries,
  rebuildMyLedger,
} from "@/lib/ledger";

// money.md action 6 -- the ledger against the sales dashboard, shown.
//
// ledger_reconciliation (00685) compares the ledger's sale net with
// finances_dashboard's for the same period. agrees:false means the LEDGER is
// the one that is wrong, so the fix a seller can reach is a rebuild. Until
// this component, nothing in the app called it.
//
// NOT SHOWN TO A WORKSPACE MEMBER. finances_dashboard reads sales through RLS,
// which lets a member see every workspace owner's sales, while ledger_entries
// is strictly the caller's own. For anyone who belongs to another seller's
// workspace the two can never agree, and a rebuild cannot fix it, so the check
// would be a permanent false alarm.
//
// IT HAS NO END DATE. ledger_reconciliation(p_period_start) compares from the
// start of the period through today, whatever the page is showing. On a range
// that is still open that is the same thing; on a custom range that ended in
// the past it is not, and the old copy ("Since <start>") let a seller read a
// gap in last week's sales as a gap in the quarter on screen. The copy now
// says "through today", and on a closed past range says outright that the
// check reaches past the period shown. Adding an end date is a migration.

function longDate(ymd: string): string {
  const date = new Date(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(5, 7)) - 1,
    Number(ymd.slice(8, 10)),
  );
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function LedgerDriftBanner({
  periodStart,
  periodEnd,
}: {
  periodStart: string;
  /** Exclusive end of the period on screen (YYYY-MM-DD), for the copy only. */
  periodEnd?: string;
}) {
  const user = useAuthStore((s) => s.user);
  const workspaces = useAuthStore((s) => s.workspaces);
  const qc = useQueryClient();
  const [rebuilding, setRebuilding] = useState(false);

  const memberElsewhere = (workspaces ?? []).some(
    (w) => w.ownerId !== user?.id,
  );

  const { data } = useQuery({
    queryKey: ["ledger-reconciliation", user?.id, periodStart],
    enabled: !!user && !memberElsewhere,
    queryFn: async () => {
      // Same shared check the statement runs first, so the comparison is made
      // against a ledger that has already caught up with any edits it can see.
      await ensureLedgerBuilt();
      return fetchLedgerReconciliation(periodStart);
    },
    staleTime: 5 * 60 * 1000,
  });

  // A failed read shows nothing: this is a warning about the figures, and the
  // figures themselves have their own error states.
  if (!data || data.agrees) return null;

  // Exclusive end: a period ending today or earlier has no day left in it
  // from today on, so the check covers dates the page is not showing.
  const endsBeforeToday = periodEnd != null && periodEnd <= ymd(new Date());

  async function rebuild() {
    setRebuilding(true);
    try {
      const n = await rebuildMyLedger();
      await invalidateLedgerQueries(qc);
      toast.success(`Books rebuilt. ${n} entries.`);
    } catch (err) {
      toastError(err, "Couldn't rebuild your books.");
    } finally {
      setRebuilding(false);
    }
  }

  return (
    <Card role="status" className="border-amber-500/50 py-0">
      <CardContent className="flex flex-wrap items-start gap-3 py-4">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold">Your books are out of date</p>
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            From {longDate(periodStart)} through today, your sales add up to{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatCents(data.dashboard_net_cents)}
            </span>{" "}
            profit, but your books show{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatCents(data.ledger_sale_net_cents)}
            </span>
            .{" "}
            {endsBeforeToday && (
              <>
                This check always runs through today, so it covers sales after
                the period on screen, and the gap may be in those.{" "}
              </>
            )}
            The figures on this page come from your books. Rebuild them to
            catch up. If this is still here after a rebuild, tell support.
          </p>
        </div>
        <Button size="sm" onClick={rebuild} disabled={rebuilding}>
          <RefreshCw className={cn("mr-2 h-4 w-4", rebuilding && "animate-spin")} />
          {rebuilding ? "Rebuilding" : "Rebuild my books"}
        </Button>
      </CardContent>
    </Card>
  );
}
