import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, CircleDashed, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { fetchAllPages } from "@/lib/paged-read";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useItemsList } from "@/hooks/use-items-full";
import { useReconciliationQueue } from "@/hooks/use-payouts";
import { useSyncConflicts } from "@/hooks/use-sync-conflicts";
import { fetchReviewCount } from "@/lib/books-review";
import { detectFeeDiscrepancy, salePlatform } from "@/lib/pnl";
import { isPlanGateError } from "@/lib/plan-gate-error";
import { ymd } from "@/lib/tax-profile";
import type { SaleRow } from "@/types/database";

// Money M14: one place that says whether this month's books are done.
//
// Four counts that already exist elsewhere, each of which can reach zero, and
// a last row that only says "ready to close" when all four LOADED as zero. A
// row that is still loading, failed, or is locked on the plan is never a
// checkmark: this card exists to be trusted, and a green tick on a read that
// never happened is the false all-clear the rest of Money was fixed to stop.

export type RowState =
  | { kind: "loading" }
  | { kind: "locked" }
  | { kind: "error" }
  | { kind: "count"; n: number };

const viewLink = (view: string, extra = "") =>
  `/dashboard/flipdesk/money?view=${view}${extra}`;

function stateOf(q: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
}, count: (d: never) => number): RowState {
  if (q.isError) return isPlanGateError(q.error) ? { kind: "locked" } : { kind: "error" };
  if (q.isLoading || q.data === undefined) return { kind: "loading" };
  return { kind: "count", n: count(q.data as never) };
}

function monthRange(today: Date): { from: string; to: string; label: string } {
  const from = new Date(today.getFullYear(), today.getMonth(), 1);
  const to = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return {
    from: ymd(from),
    to: ymd(to),
    label: from.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
}

function Row({
  label,
  state,
  to,
  what,
}: {
  label: string;
  state: RowState;
  to: string;
  what: string;
}) {
  let status: ReactNode;
  let icon: ReactNode;
  if (state.kind === "loading") {
    icon = <CircleDashed className="h-4 w-4 animate-pulse text-muted-foreground" />;
    status = <span className="text-muted-foreground">Checking</span>;
  } else if (state.kind === "locked") {
    icon = <Lock className="h-4 w-4 text-muted-foreground" />;
    status = <span className="text-muted-foreground">Locked on your plan</span>;
  } else if (state.kind === "error") {
    icon = <CircleDashed className="h-4 w-4 text-amber-700 dark:text-amber-400" />;
    status = <span className="text-amber-800 dark:text-amber-300">Couldn&apos;t check</span>;
  } else if (state.n === 0) {
    icon = <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />;
    status = <span className="text-muted-foreground">None</span>;
  } else {
    icon = <CircleDashed className="h-4 w-4 text-amber-700 dark:text-amber-400" />;
    status = (
      <span className="font-medium tabular-nums">
        {state.n} {what}
      </span>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <span aria-hidden>{icon}</span>
      <span className="min-w-0 flex-1 text-sm">{label}</span>
      <span className="text-sm" data-row-status={state.kind}>
        {status}
      </span>
      {state.kind === "count" && state.n > 0 && (
        <Link
          to={to}
          className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
          aria-label={`Go to ${label}`}
        >
          Open
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </li>
  );
}

export function MonthCloseChecklist({ today }: { today: Date }) {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId: ownerId } = useWorkspace();
  const month = useMemo(() => monthRange(today), [today]);

  const queueQuery = useReconciliationQueue();
  const conflictsQuery = useSyncConflicts();
  const reviewQuery = useQuery({
    queryKey: ["books-review-count", user?.id, month.from, month.to],
    enabled: !!user,
    queryFn: () => fetchReviewCount(month.from, month.to),
    staleTime: 5 * 60 * 1000,
  });

  // This month's completed sales, for the fee check. Scoped to the owner on
  // screen: RLS admits a member to every workspace they belong to.
  const salesQuery = useQuery({
    queryKey: ["month-close-sales", ownerId, month.from, month.to],
    enabled: !!user && !!ownerId,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      fetchAllPages<SaleRow>(async (from, to) => {
        const { data, error } = await supabase
          .from("sales")
          .select("*")
          .eq("user_id", ownerId ?? "")
          .eq("status", "completed")
          .gte("sale_date", month.from)
          .lt("sale_date", month.to)
          .order("sale_date", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to);
        if (error) throw error;
        return (data ?? []) as SaleRow[];
      }),
  });
  const itemsQuery = useItemsList();

  const feeState: RowState = useMemo(() => {
    if (salesQuery.isError || itemsQuery.isError) return { kind: "error" };
    if (!salesQuery.data || !itemsQuery.data) return { kind: "loading" };
    const platformByItem = new Map<string, string | null>();
    for (const it of itemsQuery.data) platformByItem.set(it.id, it.listing_platform ?? null);
    const n = salesQuery.data.filter(
      (s) =>
        detectFeeDiscrepancy(s, salePlatform(s, platformByItem.get(s.inventory_item_id))) !==
        null,
    ).length;
    return { kind: "count", n };
  }, [salesQuery.isError, salesQuery.data, itemsQuery.isError, itemsQuery.data]);

  const rows = [
    {
      label: "Payouts waiting for a match",
      what: "to match",
      state: stateOf(queueQuery, (d: { total: number }) => d.total),
      to: viewLink("reconcile", "&tab=payouts"),
    },
    {
      label: "Sync conflicts between FlipDesk, eBay and Sheets",
      what: "open",
      state: stateOf(conflictsQuery, (d: { total: number }) => d.total),
      to: viewLink("reconcile", "&tab=cross-source"),
    },
    {
      label: "Sales charged more than the marketplace's fees",
      what: "to check",
      state: feeState,
      to: viewLink("reconcile", "&tab=payouts"),
    },
    {
      label: "Things in your books that need a look",
      what: "to review",
      state: stateOf(reviewQuery, (d: number) => d),
      to: viewLink("pnl"),
    },
  ];

  const ready = rows.every((r) => r.state.kind === "count" && r.state.n === 0);
  const blocked = rows.some((r) => r.state.kind === "error" || r.state.kind === "locked");

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-base">Close {month.label}</CardTitle>
        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Four things to clear before the month&apos;s books are done. Each one
          can reach zero.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {rows.map((r) => (
            <Row key={r.label} label={r.label} state={r.state} to={r.to} what={r.what} />
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-sm">
          {ready ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
              <span className="flex-1 font-medium">Ready to close</span>
              <Link
                to={viewLink("tax")}
                className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
              >
                Close the period in Tax &amp; filing
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </>
          ) : (
            <span className="text-muted-foreground">
              {blocked
                ? "Not ready to close: some of these couldn't be checked."
                : "Not ready to close yet."}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
