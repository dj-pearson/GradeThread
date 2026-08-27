import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2949 + US-2951: did the sale sell more, and can the discounts stack below
// cost?
//
// ── LIFT IS A COMPARISON AND THE COMPARISON IS SHOWN ────────────────────────
//
// "This sale made $840" is not a finding; the items would have sold something
// without it. What is reported is the promotion's window against the equal
// window before it, with BOTH windows on screen. A promotion too new or too
// short to have a comparable window reports no lift rather than a number driven
// by which afternoon it ran.
//
// The comparison basis is stated plainly too: FlipDesk does not store which
// items were in an eBay promotion, so this compares TOTAL sales in the two
// windows. Saying so is the difference between a rough signal and a wrong one.
//
// ── THE STACK CHECK REPORTS, IT DOES NOT REMOVE ─────────────────────────────
//
// Silently pulling an item out of a promotion the seller built is a bigger
// surprise than the discount was. An item with no recorded cost is reported as
// UNCHECKED and never counted as safe.

interface Window {
  fromIso: string;
  toIso: string;
  units: number;
  revenueCents: number;
}

interface Lift {
  during: Window;
  before: Window;
  unitLift: number | null;
  revenueLift: number | null;
}

interface PromotionRow {
  id: string;
  name: string | null;
  promotion_type: string | null;
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  comparison_basis: string;
  lift: Lift | null;
}

interface StackRow {
  listing_id: string;
  title: string | null;
  detail: string;
}

interface StackReport {
  margin_floor_pct: number;
  breaching: StackRow[];
  unchecked: number;
  checked: number;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function liftText(v: number | null): string {
  if (v == null) return "no comparison";
  const pct = (v * 100).toFixed(0);
  return v >= 0 ? `+${pct}%` : `${pct}%`;
}

export function PromotionPerformanceCard() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["ebay_promotion_performance"],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<{ promotions: PromotionRow[] }> => {
      const res = await edgeFetch("/api/flipdesk/ebay/promotions/performance");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't work out how your promotions did.");
      return json as { promotions: PromotionRow[] };
    },
  });

  const { data: stack } = useQuery({
    queryKey: ["ebay_stack_check"],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<StackReport> => {
      const res = await edgeFetch("/api/flipdesk/ebay/promotions/stack-check");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't check your discounts.");
      return json as StackReport;
    },
  });

  const sync = useMutation<{ stored: number }, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/flipdesk/ebay/promotions/sync", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't read your eBay promotions.");
      return json;
    },
    onSuccess: (res) => {
      toast.success(`${res.stored} promotion${res.stored === 1 ? "" : "s"} on record.`);
      void qc.invalidateQueries({ queryKey: ["ebay_promotion_performance"] });
    },
    onError: (err) => toastError(err, "Couldn't read your eBay promotions."),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            Did your sales sell more?
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs font-normal"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            Refresh from eBay
          </Button>
        </CardTitle>
        <CardDescription>
          Each promotion against the same length of time before it started.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The warning first: it is the one that costs money right now. */}
        {stack && stack.breaching.length > 0 && (
          <div className="space-y-1 rounded-md border border-brand-red/40 bg-brand-red/5 p-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4" />
              {stack.breaching.length} listing{stack.breaching.length === 1 ? "" : "s"} can
              sell below your cost floor
            </p>
            <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {stack.breaching.slice(0, 30).map((r) => (
                <li key={r.listing_id}>
                  <span className="font-medium">{r.title || r.listing_id}</span> — {r.detail}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Nothing has been changed. Take the item out of a promotion, raise its
              price, or lower its auto-accept.
            </p>
          </div>
        )}
        {stack && stack.unchecked > 0 && (
          <p className="text-xs text-muted-foreground">
            {stack.unchecked} listing{stack.unchecked === 1 ? "" : "s"} could not be
            checked because there is no purchase price on record. That is not the same
            as safe.
          </p>
        )}

        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !data || data.promotions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No promotions on record yet. Refresh from eBay to pull them in.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 font-normal">Promotion</th>
                  <th className="py-1.5 pr-3 font-normal">Ran</th>
                  <th className="py-1.5 pr-3 font-normal">Sales during</th>
                  <th className="py-1.5 pr-3 font-normal">Same time before</th>
                  <th className="py-1.5 font-normal">Change</th>
                </tr>
              </thead>
              <tbody>
                {data.promotions.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="max-w-[14rem] truncate py-1.5 pr-3">
                      {p.name || p.promotion_type || "Promotion"}
                    </td>
                    <td className="py-1.5 pr-3 text-xs">
                      {day(p.starts_at)} → {day(p.ends_at)}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {p.lift
                        ? `${p.lift.during.units} · ${money(p.lift.during.revenueCents)}`
                        : "—"}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {p.lift
                        ? `${p.lift.before.units} · ${money(p.lift.before.revenueCents)}`
                        : "—"}
                    </td>
                    <td className="py-1.5 tabular-nums">
                      {p.lift ? (
                        liftText(p.lift.revenueLift)
                      ) : (
                        <span className="text-xs text-muted-foreground">too short to compare</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.promotions.length > 0 && (
          <p className="text-xs text-muted-foreground">
            This compares ALL your sales in the two windows, not only the items in the
            promotion — eBay does not tell us which items were in it. Treat it as a
            direction, not a measurement.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
