import { useState } from "react";
import { Banknote, ChevronDown, ChevronRight, Download } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEbayConnection, useEbayPayouts } from "@/hooks/use-ebay";
import { usePayoutBreakdown } from "@/hooks/use-payout-breakdown";
import { payoutBreakdownCsv } from "@/lib/payout-breakdown";

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

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// US-3413: the payout BREAKDOWN, replacing US-1446's one-line summary.
//
// The old panel said "12 sales settled, net $326.62" and stopped, which answers
// a question nobody asks: the seller already knows what the bank paid, because
// the bank told them. What they cannot see anywhere else is which items were in
// the deposit and who sourced each one.
//
// Money comes from sale_pnl through lib/payout-breakdown.ts and is not
// recomputed here. Per-sourcer is first because that is the question this
// report exists for; the item table under it is the evidence.
function PayoutBreakdownPanel({ payoutId }: { payoutId: string }) {
  const { data, isLoading, error } = usePayoutBreakdown(payoutId);

  if (isLoading) {
    return <p className="py-1 text-xs text-muted-foreground">Loading breakdown…</p>;
  }
  if (error) {
    return (
      <p className="py-1 text-xs text-muted-foreground">
        Could not load the items for this payout.
      </p>
    );
  }
  if (!data || data.items.length === 0) {
    // Said plainly rather than shown as an empty table. A deposit with no
    // linked items is the normal state for a few days after it settles: the
    // nightly ebay-payout-link pass is what attaches them.
    return (
      <p className="py-1 text-xs text-muted-foreground">
        No items linked to this payout yet. The nightly payout-link pass
        attaches them once eBay reports which sales it settled.
      </p>
    );
  }

  const onExport = () => {
    const blob = new Blob([payoutBreakdownCsv(data)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payout-${payoutId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const itemWord = data.totals.items === 1 ? "item" : "items";

  return (
    <div className="space-y-3 rounded-md bg-muted/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {data.totals.items} {itemWord} settled · net {usd(data.totals.net)}
        </span>
        <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={onExport}>
          <Download className="h-3.5 w-3.5" />
          CSV
        </Button>
      </div>

      {/* Per person. Rendered even when there is only one, so a solo seller
          sees the same shape as a shop and nothing reads as conditional. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] border-collapse">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-medium">Sourced by</th>
              <th className="py-1 pr-3 text-right font-medium">Items</th>
              <th className="py-1 pr-3 text-right font-medium">Revenue</th>
              <th className="py-1 pr-3 text-right font-medium">Fees</th>
              <th className="py-1 pr-3 text-right font-medium">Cost</th>
              <th className="py-1 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {data.bySourcer.map((r) => (
              <tr key={r.key} className="border-t border-border/60">
                <td className="py-1 pr-3 font-medium">{r.person}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{r.items}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{usd(r.revenue)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{usd(r.fees)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{usd(r.costBasis)}</td>
                <td className="py-1 text-right font-medium tabular-nums">
                  {usd(r.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details>
        <summary className="cursor-pointer text-muted-foreground">
          Show the {data.totals.items} {itemWord}
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[30rem] border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Item</th>
                <th className="py-1 pr-3 font-medium">Sourced by</th>
                <th className="py-1 pr-3 text-right font-medium">Revenue</th>
                <th className="py-1 pr-3 text-right font-medium">Fees</th>
                <th className="py-1 pr-3 text-right font-medium">Cost</th>
                <th className="py-1 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.saleId} className="border-t border-border/60">
                  <td className="py-1 pr-3">
                    <div className="max-w-[18rem] truncate">{it.title}</div>
                    {it.sku && <div className="text-muted-foreground">{it.sku}</div>}
                  </td>
                  <td className="py-1 pr-3">{it.sourcer}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {usd(it.revenue)}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">{usd(it.fees)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {usd(it.costBasis)}
                  </td>
                  <td className="py-1 text-right tabular-nums">{usd(it.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* Two numbers, shown as two numbers. Net is profit on the COMPLETED
          sales in this deposit; the deposit also settles refunds, shipping
          labels and adjustments, which are not sales and are not in sale_pnl.
          Making them agree in code would be inventing a reconciliation nobody
          has done. */}
      {data.headerAmount != null && (
        <p className="text-muted-foreground">
          eBay deposited {usd(data.headerAmount)}. Net above is profit on the
          completed sales it settled, so the two differ by refunds, shipping
          labels and adjustments.
        </p>
      )}
    </div>
  );
}

export function EbayPayoutsCard({
  bare = false,
}: {
  /**
   * The list only, with no Card or header. For the dashboard board, whose
   * WidgetFrame already draws the title.
   */
  bare?: boolean;
} = {}) {
  const { data: connection } = useEbayConnection();
  const connected = !!connection;
  const { data, isLoading } = useEbayPayouts(connected);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!connected) return null;

  const list = (
    isLoading ? (
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
                  <PayoutBreakdownPanel payoutId={p.payoutId} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    )
  );

  if (bare) return <div>{list}</div>;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Banknote className="h-5 w-5" />
          eBay payouts
        </CardTitle>
        <CardDescription>
          Bank deposits from eBay Managed Payments (last 90 days), pulled live —
          open one to see the items it settled and what each sourcer earned.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {list}
      </CardContent>
    </Card>
  );
}
