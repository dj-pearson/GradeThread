import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import {
  ledgerLabel,
  type BillingLedgerEntry,
} from "@/hooks/use-billing-summary";

function dateTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface ActivityHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── ActivityHistoryDialog (US-211) ──────────────────────────────
//
// Full grade-credit transaction history, fetched on demand from
// GET /api/payments/ledger (the billing-summary only carries the last 5).
export function ActivityHistoryDialog({
  open,
  onOpenChange,
}: ActivityHistoryDialogProps) {
  const userId = useAuthStore((s) => s.user?.id);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["credit_ledger", userId],
    enabled: open && !!userId,
    staleTime: 30_000,
    queryFn: async (): Promise<BillingLedgerEntry[]> => {
      const res = await edgeFetch("/api/payments/ledger?limit=100");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load activity.");
      return (json.entries ?? []) as BillingLedgerEntry[];
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Credit activity</DialogTitle>
          <DialogDescription>
            Every grade-credit change on your account — purchases, included
            grades, debits, and refunds.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Couldn't load your activity. Please try again.
          </p>
        ) : !data || data.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No credit activity yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {ledgerLabel(entry.reason)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {dateTimeLabel(entry.created_at)}
                    {entry.notes ? ` · ${entry.notes}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-baseline gap-3">
                  <span
                    className={
                      entry.delta > 0
                        ? "tabular-nums font-semibold text-emerald-700"
                        : entry.delta < 0
                          ? "tabular-nums font-semibold text-red-700"
                          : "tabular-nums text-muted-foreground"
                    }
                  >
                    {entry.delta > 0 ? "+" : ""}
                    {entry.delta}
                  </span>
                  <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                    bal {entry.balance_after}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
