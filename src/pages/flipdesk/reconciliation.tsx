import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Scale, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { detectDiscrepancies } from "@/lib/pnl";
import type { SaleRow, ItemFullRow } from "@/types/database";

const STEPS = [
  {
    title: "Ingest payout rows",
    body: "Two ingestion paths: live eBay webhooks via the edge service and CSV upload from the eBay seller dashboard. Both land in payout_imports.",
  },
  {
    title: "Auto-match to sales",
    body: "The reconciliation-matcher edge function matches payout rows to listings by listing ID and timestamp window. Matched rows update the linked sale row with per-fee breakdowns.",
  },
  {
    title: "Manual review queue",
    body: "Anything unmatched stays in a review queue with a side-by-side compare UI. Matches are an explicit user action — never silent.",
  },
];

export function FlipdeskReconciliationPage() {
  const user = useAuthStore((s) => s.user);

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ["sales_all", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<SaleRow[]> => {
      const { data, error } = await supabase
        .from("sales")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as SaleRow[];
    },
  });

  // Cached items_full gives us titles without another round-trip.
  const { data: items = [] } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ItemFullRow[]> => {
      const { data, error } = await (
        supabase.from as unknown as (
          name: "items_full",
        ) => {
          select: (cols: string) => {
            order: (
              col: string,
              opts?: { ascending?: boolean },
            ) => Promise<{ data: ItemFullRow[] | null; error: Error | null }>;
          };
        }
      )("items_full")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) m.set(it.id, it.item_title);
    return m;
  }, [items]);

  const flagged = useMemo(
    () =>
      sales
        .map((s) => ({ sale: s, issues: detectDiscrepancies(s) }))
        .filter((r) => r.issues.length > 0),
    [sales],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <Scale className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Close the loop between marketplace payouts and per-item profit.
          </p>
        </div>
      </div>

      {/* Discrepancies */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Fee &amp; shipping discrepancies
              </CardTitle>
              <CardDescription>
                Sales where marketplace fees exceed 15% of the sale price, or
                shipping cost runs more than $2 over what the buyer paid.
              </CardDescription>
            </div>
            <Badge variant={flagged.length > 0 ? "destructive" : "outline"}>
              {flagged.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Loading sales…
            </div>
          ) : flagged.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              No discrepancies. Fees and shipping look clean.
            </div>
          ) : (
            <ul className="space-y-2">
              {flagged.map(({ sale, issues }) => (
                <li
                  key={sale.id}
                  className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">
                      {titleById.get(sale.inventory_item_id) ?? "Item"}
                    </div>
                    <div className="font-mono text-xs tabular-nums text-muted-foreground">
                      Sold ${(sale.sale_price ?? 0).toFixed(2)}
                    </div>
                  </div>
                  {issues.map((d, i) => (
                    <div
                      key={i}
                      className="mt-1 text-xs text-destructive"
                    >
                      • {d}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How reconciliation works</CardTitle>
          <CardDescription>
            The flow runs in the consolidated edge service. Imports never
            auto-apply without a recorded match.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-xs font-bold text-white">
                  {i + 1}
                </div>
                <div>
                  <div className="font-semibold">{step.title}</div>
                  <div className="text-sm text-muted-foreground">
                    {step.body}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
