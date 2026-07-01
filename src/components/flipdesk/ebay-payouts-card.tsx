import { Banknote } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEbayConnection, useEbayPayouts } from "@/hooks/use-ebay";

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

export function EbayPayoutsCard() {
  const { data: connection } = useEbayConnection();
  const connected = !!connection;
  const { data, isLoading } = useEbayPayouts(connected);

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
            {data?.payouts?.map((p) => (
              <li
                key={p.payoutId}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
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
                <Badge variant={statusVariant(p.payoutStatus)}>
                  {p.payoutStatus.toLowerCase().replace(/_/g, " ")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
