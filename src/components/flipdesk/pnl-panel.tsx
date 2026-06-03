import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { computePnl, detectDiscrepancies } from "@/lib/pnl";
import type { SaleRow } from "@/types/database";

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

// Per-item P&L. Queries the actual sales row (granular fee breakdown that
// the items_full view collapses) and computes margin + discrepancies live.
export function PnlPanel({
  inventoryItemId,
  costBasis,
}: {
  inventoryItemId: string;
  costBasis: number | null;
}) {
  const { data: sale, isLoading } = useQuery({
    queryKey: ["sale_for_item", inventoryItemId],
    queryFn: async (): Promise<SaleRow | null> => {
      const { data, error } = await supabase
        .from("sales")
        .select("*")
        .eq("inventory_item_id", inventoryItemId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as SaleRow | null) ?? null;
    },
  });

  if (isLoading) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        Loading P&amp;L…
      </div>
    );
  }

  if (!sale) {
    return (
      <div className="rounded-md border border-dashed py-4 text-center text-xs text-muted-foreground">
        No sale recorded yet.
      </div>
    );
  }

  const pnl = computePnl(sale, costBasis);
  const discrepancies = detectDiscrepancies(sale);

  const lines: Array<{ label: string; value: number; positive?: boolean }> = [
    { label: "Sold price", value: sale.sale_price ?? 0, positive: true },
    {
      label: "Shipping collected",
      value: sale.shipping_collected ?? 0,
      positive: true,
    },
    { label: "Marketplace fees", value: -(sale.platform_fees ?? 0) },
    {
      label: "Payment processing",
      value: -(sale.payment_processing_fees ?? 0),
    },
    { label: "Shipping cost", value: -(sale.shipping_cost ?? 0) },
    { label: "Grading cost", value: -(sale.grading_cost ?? 0) },
    { label: "Other costs", value: -(sale.other_costs ?? 0) },
    { label: "Tax", value: -(sale.tax ?? 0) },
    { label: "Cost basis", value: -pnl.costBasis },
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {lines.map((l) => (
              <tr key={l.label} className="border-b last:border-0">
                <td className="px-3 py-1.5 text-muted-foreground">
                  {l.label}
                </td>
                <td
                  className={cn(
                    "px-3 py-1.5 text-right font-mono tabular-nums",
                    l.value < 0 && "text-destructive",
                  )}
                >
                  {money(l.value)}
                </td>
              </tr>
            ))}
            <tr className="bg-muted/40">
              <td className="px-3 py-2 font-semibold">Net profit</td>
              <td
                className={cn(
                  "px-3 py-2 text-right font-mono font-bold tabular-nums",
                  pnl.net < 0
                    ? "text-destructive"
                    : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {money(pnl.net)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Margin</span>
        <Badge
          variant={
            pnl.marginPct == null
              ? "outline"
              : pnl.marginPct < 0
                ? "destructive"
                : "secondary"
          }
        >
          {pnl.marginPct == null ? "—" : `${pnl.marginPct.toFixed(1)}%`}
        </Badge>
      </div>

      {discrepancies.length > 0 && (
        <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            Discrepanc{discrepancies.length === 1 ? "y" : "ies"}
          </div>
          {discrepancies.map((d, i) => (
            <div key={i} className="text-xs text-destructive">
              {d}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
