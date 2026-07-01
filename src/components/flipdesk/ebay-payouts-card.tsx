import { useState } from "react";
import { Banknote, ChevronDown, ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  useEbayConnection,
  useEbayPayouts,
  useEbayPayoutSales,
} from "@/hooks/use-ebay";

// US-1446: eBay payouts pulled live from the Finances API — the lump-sum bank
// deposits resellers actually reconcile against (vs the manual CSV import
// below). Self-gates on an active eBay connection.

function money(a: { value: string; currency: string } | null): string {
  if (!a) return "—";
  const n = Number(a.value);
  if (!Number.isFinite(n)) return "—";
  return `${a.currency === "USD" ? "$" : ""}${n.toFixed(2)}${a.currency === "USD" ? "" : " " + a.currency}`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "SUCCEEDED") return "default";
  if (status.includes("FAILED") || status === "REVERSED") return "destructive";
  return "secondary";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleDateString();
}

// US-1446 AC2: expanded payout → its constituent sales → net.
function PayoutSales({ payoutId }: { payoutId: string }) {
  const { data, isLoading } = useEbayPayoutSales(payoutId);
  if (isLoading) {
    return <p className="py-1 text-xs text-muted-foreground">Loading sales…</p>;
  }
  if (!data || data.sales.length === 0) {
    return (
      <p className="py-1 text-xs text-muted-foreground">
        No matched sales for this payout yet (sync sales to link them).
      </p>
    );
  }
  return (
    <div className="rounded-md bg-muted/40 p-2 text-xs">
      <div className="mb-1 flex justify-between font-medium">
        <span>
          {data.sales.length} sale{data.sales.length === 1 ? "" : "s"} settled
        </span>
        <span className="tabular-nums">Net ${data.net.toFixed(2)}</span>
      </div>
    </div>
  );
}

export function EbayPayoutsCard() {
  const { data: connection } = useEbayConnection();
  const connected = !!connection;
  const { data, isLoading } = useEbayPayouts(connected);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!connected) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Banknote className="h-5 w-5" />
          eBay payouts
        </CardTitle>
        <CardDescription>
          Bank deposits from eBay Managed Payments (last 90 days), pulled live —
          reconcile against the payout that actually hit your bank.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading payouts…</p>
        ) : data?.access === false ? (
          <p className="text-sm text-muted-foreground">
            Reconnect eBay to pull payouts automatically. You can still import a
            CSV below.
          </p>
        ) : (data?.payouts?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No payouts in the last 90 days.
          </p>
        ) : (
          <ul className="divide-y">
            {data?.payouts?.map((p) => {
              const isOpen = expanded === p.payoutId;
              return (
                <li key={p.payoutId} className="py-2 text-sm">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : p.payoutId)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                    aria-expanded={isOpen}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <div className="font-medium tabular-nums">
                          {money(p.amount)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {fmtDate(p.payoutDate)}
                          {p.transactionCount != null
                            ? ` · ${p.transactionCount} transaction${p.transactionCount === 1 ? "" : "s"}`
                            : ""}
                        </div>
                      </div>
                    </div>
                    <Badge variant={statusVariant(p.payoutStatus)}>
                      {p.payoutStatus.toLowerCase().replace(/_/g, " ")}
                    </Badge>
                  </button>
                  {isOpen && (
                    <div className="mt-2 pl-6">
                      <PayoutSales payoutId={p.payoutId} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
