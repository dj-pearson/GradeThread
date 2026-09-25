import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Users,
  Plus,
  Pencil,
  Loader2,
  PenLine,
  CreditCard,
  Banknote,
  CheckCircle2,
  RefreshCw,
  MoreHorizontal,
  History,
  Package,
  Search,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
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
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  LoadingRegion,
  SkeletonRows,
  TableLoadingSkeleton,
} from "@/components/ui/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { edgeFetch } from "@/lib/edge-fetch";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  useConsignors,
  useConsignorPayouts,
  type ConsignorWithPnl,
} from "@/hooks/use-consignors";
import { CONSIGNOR_COUNT_KEY } from "@/hooks/use-consignor-count";
import {
  CONSIGNOR_STATUSES,
  CONSIGNOR_STATUS_LABELS,
  CONSIGNOR_PAYOUT_STATUS_LABELS,
  CONSIGNOR_SPLIT_BASIS,
} from "@/lib/constants";
import { consignorBalance, splitExample } from "@/lib/consignor-balance";
import { CONSIGNOR_MONEY_ADMIN_ONLY } from "@/lib/workspace-permissions";
import { useAuthStore } from "@/stores/auth-store";
import type { ConsignorPayoutRow, ConsignorStatus } from "@/types/database";
import { PageHelp } from "@/components/help/page-help";
import { Term } from "@/components/help/term";
import { ConsignorItemsSheet } from "@/components/flipdesk/consignor-items-sheet";

function money(n: number | null | undefined): string {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

// US-1123: signed delta (reconciled actual minus estimate) for the discrepancy hint.
function signedMoney(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
}

// C10: a balance we could not read is shown as unknown, never as $0.00.
function Unknown() {
  return (
    <span aria-label="Unknown" title="Balances couldn't be loaded.">
      -
    </span>
  );
}

interface FormState {
  id: string | null;
  name: string;
  email: string;
  phone: string;
  split_pct: string;
  status: ConsignorStatus;
  notes: string;
  // The saved values, so a PATCH only sends what changed (a member editing
  // notes must not send the split, which is admin-only).
  original?: { split_pct: number; status: ConsignorStatus; signed: boolean };
}

const EMPTY: FormState = {
  id: null,
  name: "",
  email: "",
  phone: "",
  split_pct: "50",
  status: "active",
  notes: "",
};

type StatusFilter = "active" | "inactive" | "all";
type SortKey = "owed" | "gross" | "name";

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "all", label: "All" },
];

function readStatus(v: string | null): StatusFilter {
  return v === "inactive" || v === "all" ? v : "active";
}
function readSort(v: string | null): SortKey {
  return v === "gross" || v === "name" ? v : "owed";
}

function toFormState(c: ConsignorWithPnl): FormState {
  return {
    id: c.id,
    name: c.name,
    email: c.contact_email ?? "",
    phone: c.contact_phone ?? "",
    split_pct: String(c.default_split_pct),
    status: c.status,
    notes: c.notes ?? "",
    original: {
      split_pct: Number(c.default_split_pct),
      status: c.status,
      signed: !!c.intake_signed_at,
    },
  };
}

export function FlipdeskConsignmentPage() {
  const { can } = useWorkspace();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useConsignors();
  const consignors = useMemo(() => data?.consignors ?? [], [data]);
  const pnlError = data?.pnlError ?? false;
  const [searchParams, setSearchParams] = useSearchParams();

  const [editing, setEditing] = useState<FormState | null>(null);
  const [intakeFor, setIntakeFor] = useState<ConsignorWithPnl | null>(null);
  const [payFor, setPayFor] = useState<ConsignorWithPnl | null>(null);
  const [historyFor, setHistoryFor] = useState<ConsignorWithPnl | null>(null);
  const [itemsFor, setItemsFor] = useState<ConsignorWithPnl | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canManage = can("manage_inventory");
  // C1: splits, status, signatures, Stripe onboarding and payouts are admin-only
  // on the edge, so the controls are too.
  const canManageMoney = can("manage_consignor_money");
  const moneyTitle = canManageMoney ? undefined : CONSIGNOR_MONEY_ADMIN_ONLY;

  // C14: search, filter and sort live in the URL so a reload keeps them.
  const q = searchParams.get("q") ?? "";
  const statusFilter = readStatus(searchParams.get("status"));
  const sortKey = readSort(searchParams.get("sort"));
  const sortDir = searchParams.get("dir") === "asc" ? "asc" : "desc";
  const readyOnly = searchParams.get("ready") === "1";

  const setParam = useCallback(
    (updates: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const balances = useMemo(() => {
    const map = new Map<string, ReturnType<typeof consignorBalance>>();
    for (const c of consignors) map.set(c.id, consignorBalance(c.pnl));
    return map;
  }, [consignors]);
  const balanceOf = (c: ConsignorWithPnl) =>
    balances.get(c.id) ?? { available: 0, pending: 0, overpaid: 0 };

  const totals = useMemo(() => {
    let available = 0;
    let pending = 0;
    let gross = 0;
    let paid = 0;
    let shareDelta = 0;
    let unreconciled = 0;
    let ready = 0;
    let overpaid = 0;
    for (const c of consignors) {
      const b = balances.get(c.id) ?? { available: 0, pending: 0, overpaid: 0 };
      available += b.available;
      pending += b.pending;
      if (b.available > 0) ready++;
      if (b.overpaid > 0) overpaid++;
      gross += Number(c.pnl?.gross_revenue ?? 0);
      paid += Number(c.pnl?.payouts_paid ?? 0);
      shareDelta += Number(c.pnl?.consignor_share_delta ?? 0);
      unreconciled += Number(c.pnl?.items_unreconciled ?? 0);
    }
    return { available, pending, gross, paid, shareDelta, unreconciled, ready, overpaid };
  }, [consignors, balances]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = consignors.filter((c) => {
      if (statusFilter === "active" && c.status !== "active") return false;
      if (statusFilter === "inactive" && c.status === "active") return false;
      if (readyOnly && !((balances.get(c.id)?.available ?? 0) > 0)) return false;
      if (!needle) return true;
      return [c.name, c.contact_email, c.contact_phone]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
    const sign = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      if (sortKey === "name") return sign * a.name.localeCompare(b.name);
      const av = sortKey === "gross"
        ? Number(a.pnl?.gross_revenue ?? 0)
        : balances.get(a.id)?.available ?? 0;
      const bv = sortKey === "gross"
        ? Number(b.pnl?.gross_revenue ?? 0)
        : balances.get(b.id)?.available ?? 0;
      return sign * (av - bv) || a.name.localeCompare(b.name);
    });
    return rows;
  }, [consignors, balances, q, statusFilter, sortKey, sortDir, readyOnly]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setParam({ dir: sortDir === "asc" ? "desc" : "asc" });
    } else {
      setParam({ sort: key === "owed" ? null : key, dir: key === "name" ? "asc" : null });
    }
  }

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["consignors"] });
    void qc.invalidateQueries({ queryKey: ["consignor-payouts"] });
    // C10: the dashboard widget gates on this count.
    void qc.invalidateQueries({ queryKey: [CONSIGNOR_COUNT_KEY] });
  }, [qc]);

  const startConnect = useCallback(async (consignorId: string) => {
    setBusyId(consignorId);
    try {
      const res = await edgeFetch(
        `/api/flipdesk/consignment/consignors/${consignorId}/connect`,
        { method: "POST", json: {} },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) {
        throw new Error(body.error ?? "Couldn't start Stripe setup. Try again in a minute.");
      }
      window.location.href = body.url as string;
    } catch (err) {
      toastError(err, "Stripe setup didn't start");
    } finally {
      setBusyId(null);
    }
  }, []);

  // C3: ask Stripe whether onboarding finished and store the answer.
  const checkStatus = useCallback(
    async (consignorId: string) => {
      setBusyId(consignorId);
      try {
        const res = await edgeFetch(
          `/api/flipdesk/consignment/consignors/${consignorId}/connect/status`,
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Couldn't check Stripe right now.");
        if (body.payouts_enabled) toast.success("Payouts connected.");
        else toast.info("Stripe still needs a few details from them.");
        refresh();
      } catch (err) {
        toastError(err, "Couldn't check Stripe");
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  // C3: Stripe sends the seller back with ?connect=done|refresh&consignor=<id>.
  // Handle it once, then take those two params off the URL.
  const connectHandled = useRef(false);
  useEffect(() => {
    if (connectHandled.current) return;
    const mode = searchParams.get("connect");
    const consignorId = searchParams.get("consignor");
    if (!mode || !consignorId) return;
    connectHandled.current = true;
    setParam({ connect: null, consignor: null });
    if (mode === "done") void checkStatus(consignorId);
    // The onboarding link expired; start a fresh one.
    else if (mode === "refresh" && canManageMoney) void startConnect(consignorId);
  }, [searchParams, setParam, checkStatus, startConnect, canManageMoney]);

  const loaded = !isLoading && !error;

  function kpi(value: number) {
    if (isLoading) return <Skeleton className="h-7 w-24" />;
    if (error || pnlError) return <Unknown />;
    return money(value);
  }

  function nextAction(c: ConsignorWithPnl) {
    const b = balanceOf(c);
    if (!c.intake_signed_at) {
      return (
        <Button
          size="sm"
          variant="outline"
          className="h-11 flex-1"
          onClick={() => setIntakeFor(c)}
          disabled={!canManageMoney}
          title={moneyTitle}
          aria-label={`Record ${c.name}'s signature`}
        >
          <PenLine className="mr-2 h-4 w-4" /> Sign
        </Button>
      );
    }
    if (!c.payouts_enabled) return connectButton(c, "h-11 flex-1");
    if (b.available > 0 && !pnlError) return payButton(c, "h-11 flex-1");
    return null;
  }

  function connectButton(c: ConsignorWithPnl, className: string) {
    const busy = busyId === c.id;
    if (c.stripe_connect_account_id) {
      return (
        <Button
          size="sm"
          variant="outline"
          className={className}
          onClick={() => void checkStatus(c.id)}
          disabled={busy}
          aria-label={`Check ${c.name}'s Stripe status`}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Check status
        </Button>
      );
    }
    return (
      <Button
        size="sm"
        variant="outline"
        className={className}
        onClick={() => void startConnect(c.id)}
        disabled={!canManageMoney || busy}
        title={moneyTitle}
        aria-label={`Connect ${c.name} to Stripe`}
      >
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <CreditCard className="mr-2 h-4 w-4" />
        )}
        Connect
      </Button>
    );
  }

  function payButton(c: ConsignorWithPnl, className: string) {
    const b = balanceOf(c);
    if (pnlError || b.available <= 0) return null;
    return (
      <Button
        size="sm"
        className={className}
        onClick={() => setPayFor(c)}
        disabled={!canManageMoney || c.status !== "active"}
        title={
          moneyTitle ?? (c.status !== "active" ? "Set them back to Active to pay them." : undefined)
        }
        aria-label={`Pay ${c.name} ${money(b.available)}`}
      >
        <Banknote className="mr-2 h-4 w-4" /> Pay {money(b.available)}
      </Button>
    );
  }

  function owedCell(c: ConsignorWithPnl, large = false) {
    if (pnlError) return <Unknown />;
    const b = balanceOf(c);
    const delta = Number(c.pnl?.consignor_share_delta ?? 0);
    return (
      <>
        <span className={large ? "text-2xl font-semibold tabular-nums" : undefined}>
          {money(b.available)}
        </span>
        {b.pending > 0 && (
          <div className="text-xs font-normal text-muted-foreground">
            {money(b.pending)} pending
          </div>
        )}
        {b.overpaid > 0 && (
          <div className="text-xs font-normal text-brand-red-text">
            Overpaid {money(b.overpaid)}
          </div>
        )}
        {Math.abs(delta) >= 0.005 && (
          <div
            className={`text-xs font-normal ${
              delta >= 0 ? "text-success-text" : "text-brand-red-text"
            }`}
            title="Reconciled payout vs. sale-price estimate"
          >
            {signedMoney(delta)} vs est.
          </div>
        )}
      </>
    );
  }

  function signedBadge(c: ConsignorWithPnl) {
    const when = c.intake_signed_at
      ? new Date(c.intake_signed_at).toLocaleDateString()
      : "";
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-success-text"
        title={`Signed ${when}${c.intake_signature_name ? ` by ${c.intake_signature_name}` : ""}`}
      >
        <CheckCircle2 className="h-3.5 w-3.5" /> Signed
      </span>
    );
  }

  function moreMenu(c: ConsignorWithPnl, className: string) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={className}
            aria-label={`More actions for ${c.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setItemsFor(c)}>
            <Package className="mr-2 h-4 w-4" /> Items
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setHistoryFor(c)}>
            <History className="mr-2 h-4 w-4" /> Payout history
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canManage}
            onSelect={() => setEditing(toFormState(c))}
          >
            <Pencil className="mr-2 h-4 w-4" /> Edit
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function sortHeader(key: SortKey, label: string, alignRight = false) {
    const active = sortKey === key;
    const Icon = sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead
        className={alignRight ? "text-right" : undefined}
        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          className="inline-flex items-center gap-1 font-medium hover:text-foreground"
          onClick={() => toggleSort(key)}
        >
          {label}
          {active && <Icon className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </TableHead>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Users}
        title="Consignment"
        subtitle={
          <>
            <Term name="Consignment" /> means selling someone else's garment and
            splitting the money. Manage consignors, splits, agreements and
            payouts here.
          </>
        }
        actions={
          <>
            <PageHelp slug="taking-in-consignment" />
            <Button onClick={() => setEditing({ ...EMPTY })} disabled={!canManage}>
              <Plus className="mr-2 h-4 w-4" />
              New consignor
            </Button>
          </>
        }
      />

      {!canManageMoney && (
        <p className="text-sm text-muted-foreground">{CONSIGNOR_MONEY_ADMIN_ONLY}</p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Gross consigned sales</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{kpi(totals.gross)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Paid to consignors</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{kpi(totals.paid)}</CardTitle>
            {loaded && !pnlError && totals.pending > 0 && (
              <p className="text-xs text-muted-foreground">
                Pending {money(totals.pending)}
              </p>
            )}
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Balance owed</CardDescription>
            <CardTitle className="text-2xl tabular-nums text-brand-red-text">
              {kpi(totals.available)}
            </CardTitle>
            {loaded && !pnlError && (
              <button
                type="button"
                className="self-start text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setParam({ ready: readyOnly ? null : "1" })}
                aria-pressed={readyOnly}
              >
                {consignors.length} consignor{consignors.length === 1 ? "" : "s"},{" "}
                {totals.ready} ready to pay
                {readyOnly ? " (showing only those)" : ""}
              </button>
            )}
          </CardHeader>
        </Card>
      </div>

      {loaded && pnlError && (
        <div role="alert" className="rounded-md border px-4 py-2 text-sm text-brand-red-text">
          Balances couldn't be loaded. Amounts are hidden until they can be read.
        </div>
      )}

      {loaded &&
        !pnlError &&
        (Math.abs(totals.shareDelta) >= 0.005 || totals.unreconciled > 0 || totals.overpaid > 0) && (
          <div className="rounded-md border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            {totals.overpaid > 0 && (
              <span className="text-brand-red-text">
                {totals.overpaid} consignor{totals.overpaid === 1 ? " has" : "s have"} been
                paid more than their share.{" "}
              </span>
            )}
            {(Math.abs(totals.shareDelta) >= 0.005 || totals.unreconciled > 0) && (
              <>
                Shares are computed from reconciled marketplace payouts when available.
                {Math.abs(totals.shareDelta) >= 0.005 && (
                  <>
                    {" "}
                    Reconciled vs. estimated adjustment across all consignors:{" "}
                    <span
                      className={
                        totals.shareDelta >= 0 ? "text-success-text" : "text-brand-red-text"
                      }
                    >
                      {signedMoney(totals.shareDelta)}
                    </span>
                    .
                  </>
                )}
                {totals.unreconciled > 0 && (
                  <>
                    {" "}
                    {totals.unreconciled} sold item{totals.unreconciled === 1 ? "" : "s"} still
                    on estimates.{" "}
                    <Link
                      to="/dashboard/flipdesk/money?view=reconcile&tab=payouts"
                      className="text-foreground underline underline-offset-2"
                    >
                      Reconcile payouts
                    </Link>
                  </>
                )}
              </>
            )}
          </div>
        )}

      <Card>
        <CardHeader className="space-y-3">
          <CardTitle>
            {isLoading ? (
              <Skeleton className="h-6 w-32" />
            ) : error ? (
              "Consignors"
            ) : (
              <>
                {visible.length === consignors.length
                  ? `${consignors.length} consignor${consignors.length === 1 ? "" : "s"}`
                  : `${visible.length} of ${consignors.length} consignors`}
              </>
            )}
          </CardTitle>
          <CardDescription>
            Every item you take in gets its own GradeThread grade, and you set
            how the money is split.
          </CardDescription>
          {loaded && consignors.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative sm:max-w-xs sm:flex-1">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  type="search"
                  value={q}
                  onChange={(e) => setParam({ q: e.target.value })}
                  placeholder="Search name, email or phone"
                  aria-label="Search consignors"
                  className="pl-9"
                />
              </div>
              <div className="flex gap-1" role="group" aria-label="Filter by status">
                {STATUS_FILTERS.map((f) => (
                  <Button
                    key={f.value}
                    size="sm"
                    variant={statusFilter === f.value ? "default" : "outline"}
                    className="h-9"
                    aria-pressed={statusFilter === f.value}
                    onClick={() => setParam({ status: f.value === "active" ? null : f.value })}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <LoadingRegion label="Loading consignors" className="px-4">
              <TableLoadingSkeleton rows={5} columns={5} />
            </LoadingRegion>
          ) : error ? (
            <div className="space-y-3 py-12 text-center text-sm">
              <p className="text-destructive">{(error as Error).message}</p>
              <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Try again
              </Button>
            </div>
          ) : consignors.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No consignors yet"
              description="Add a consignor to run consignment on GradeThread: set their split, record their signature, and pay them out via Stripe Connect."
              action={
                canManage
                  ? {
                      label: "New consignor",
                      onClick: () => setEditing({ ...EMPTY }),
                      icon: Plus,
                    }
                  : undefined
              }
            />
          ) : visible.length === 0 ? (
            <div className="space-y-3 py-12 text-center text-sm text-muted-foreground">
              <p>No consignors match these filters.</p>
              <Button
                variant="outline"
                onClick={() => setParam({ q: null, status: "all", ready: null })}
              >
                Show everyone
              </Button>
            </div>
          ) : (
            <>
              {/* C13: phones get one card per consignor with one clear next action. */}
              <ul className="space-y-3 px-4 md:hidden">
                {visible.map((c) => (
                  <li key={c.id} className="rounded-xl border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{c.name}</p>
                        {c.contact_email && (
                          <p className="truncate text-xs text-muted-foreground">
                            {c.contact_email}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">Owed</p>
                        {owedCell(c, true)}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="outline">{c.default_split_pct}% split</Badge>
                      <Badge variant={c.status === "active" ? "default" : "outline"}>
                        {CONSIGNOR_STATUS_LABELS[c.status]}
                      </Badge>
                      <span className="text-muted-foreground">
                        {c.pnl?.total_items ?? 0} item{(c.pnl?.total_items ?? 0) === 1 ? "" : "s"}
                      </span>
                      {c.intake_signed_at && signedBadge(c)}
                      {c.payouts_enabled && (
                        <span className="inline-flex items-center gap-1 text-success-text">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                        </span>
                      )}
                    </div>
                    <div className="mt-3 flex gap-2">
                      {nextAction(c)}
                      {moreMenu(c, "h-11 w-11 shrink-0")}
                    </div>
                  </li>
                ))}
              </ul>

              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {sortHeader("name", "Name")}
                      <TableHead>Split</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Items</TableHead>
                      {sortHeader("gross", "Gross", true)}
                      {sortHeader("owed", "Owed", true)}
                      <TableHead>Intake</TableHead>
                      <TableHead>Payouts</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">
                          {c.name}
                          {c.contact_email && (
                            <div className="text-xs text-muted-foreground">
                              {c.contact_email}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">{c.default_split_pct}%</TableCell>
                        <TableCell>
                          <Badge variant={c.status === "active" ? "default" : "outline"}>
                            {CONSIGNOR_STATUS_LABELS[c.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.pnl?.total_items ?? 0}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {pnlError ? <Unknown /> : money(c.pnl?.gross_revenue)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {owedCell(c)}
                        </TableCell>
                        <TableCell>
                          {c.intake_signed_at ? (
                            signedBadge(c)
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-9 px-2 text-xs"
                              onClick={() => setIntakeFor(c)}
                              aria-label={`Record ${c.name}'s signature`}
                              disabled={!canManageMoney}
                              title={moneyTitle}
                            >
                              <PenLine className="mr-1 h-3.5 w-3.5" /> Sign
                            </Button>
                          )}
                        </TableCell>
                        <TableCell>
                          {c.payouts_enabled ? (
                            <span className="inline-flex items-center gap-1 text-xs text-success-text">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Connected
                            </span>
                          ) : (
                            connectButton(c, "h-9 px-2 text-xs")
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {payButton(c, "h-9 px-3 text-xs")}
                            {moreMenu(c, "h-9 w-9")}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <ConsignorEditDialog
        state={editing}
        canManageMoney={canManageMoney}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
      <IntakeDialog
        consignor={intakeFor}
        onClose={() => setIntakeFor(null)}
        onSaved={() => {
          setIntakeFor(null);
          refresh();
        }}
      />
      <PayoutDialog
        consignor={payFor}
        onClose={() => setPayFor(null)}
        onSaved={() => {
          setPayFor(null);
          refresh();
        }}
      />
      <PayoutHistoryDialog
        consignor={historyFor}
        canManageMoney={canManageMoney}
        onClose={() => setHistoryFor(null)}
        onChanged={refresh}
      />
      <ConsignorItemsSheet
        consignor={itemsFor}
        canManageMoney={canManageMoney}
        onClose={() => setItemsFor(null)}
        onChanged={refresh}
      />
    </div>
  );
}

function ConsignorEditDialog({
  state,
  canManageMoney,
  onClose,
  onSaved,
}: {
  state: FormState | null;
  canManageMoney: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<FormState | null>(state);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(state);
    setNameError(null);
  }, [state]);
  if (!draft || !state) return null;

  const splitNum = Number(draft.split_pct);
  const splitChanged = !!draft.original && splitNum !== draft.original.split_pct;

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setNameError("Name is required.");
      return;
    }
    if (!Number.isFinite(splitNum) || splitNum < 0 || splitNum > 100) {
      toast.error("Split must be between 0 and 100.");
      return;
    }
    setSaving(true);
    setNameError(null);
    try {
      const payload: Record<string, unknown> = {
        name,
        contact_email: draft.email.trim() || null,
        contact_phone: draft.phone.trim() || null,
        notes: draft.notes.trim() || null,
      };
      // C1: only send the money terms when they change, so a member can
      // still save a note without hitting the admin floor.
      if (!draft.id) {
        if (canManageMoney) payload.default_split_pct = splitNum;
      } else if (draft.original) {
        if (splitNum !== draft.original.split_pct) payload.default_split_pct = splitNum;
        if (draft.status !== draft.original.status) payload.status = draft.status;
      }
      const res = draft.id
        ? await edgeFetch(`/api/flipdesk/consignment/consignors/${draft.id}`, {
            method: "PATCH",
            json: payload,
          })
        : await edgeFetch(`/api/flipdesk/consignment/consignors`, {
            method: "POST",
            json: payload,
          });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setNameError(body.error ?? "You already have a consignor with that name.");
        return;
      }
      if (!res.ok) throw new Error(body.error ?? "Save failed");
      if (body.resign_required) {
        toast.warning(`Split changed. ${name} needs to sign the agreement again.`);
      } else {
        toast.success(draft.id ? "Consignor updated." : "Consignor created.");
      }
      onSaved();
    } catch (err) {
      toastError(err, "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void save(e)} noValidate>
          <DialogHeader>
            <DialogTitle>{state.id ? "Edit consignor" : "New consignor"}</DialogTitle>
            <DialogDescription>The split is {CONSIGNOR_SPLIT_BASIS}.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1">
              <Label htmlFor="c-name">Name *</Label>
              <Input
                id="c-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Jane Doe"
                autoComplete="name"
                maxLength={120}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? "c-name-error" : undefined}
                autoFocus
              />
              {nameError && (
                <p id="c-name-error" className="text-xs text-brand-red-text">
                  {nameError}
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="c-email">Email</Label>
                <Input
                  id="c-email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  placeholder="jane@example.com"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="c-phone">Phone</Label>
                <Input
                  id="c-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={32}
                  value={draft.phone}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                  placeholder="(555) 555-5555"
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="c-split-consignors-share">Split % (consignor's share)</Label>
                <Input
                  id="c-split-consignors-share"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.5}
                  value={draft.split_pct}
                  disabled={!canManageMoney}
                  title={canManageMoney ? undefined : CONSIGNOR_MONEY_ADMIN_ONLY}
                  onChange={(e) => setDraft({ ...draft, split_pct: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{splitExample(splitNum)}</p>
                {splitChanged && draft.original?.signed && (
                  <p className="text-xs text-brand-red-text">
                    Changing the split cancels the signed agreement. They'll need
                    to sign again.
                  </p>
                )}
              </div>
              {state.id && (
                <div className="space-y-1">
                  <Label htmlFor="c-status">Status</Label>
                  <Select
                    value={draft.status}
                    disabled={!canManageMoney}
                    onValueChange={(v) => setDraft({ ...draft, status: v as ConsignorStatus })}
                  >
                    <SelectTrigger id="c-status" title={canManageMoney ? undefined : CONSIGNOR_MONEY_ADMIN_ONLY}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONSIGNOR_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {CONSIGNOR_STATUS_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            {!canManageMoney && (
              <p className="text-xs text-muted-foreground">{CONSIGNOR_MONEY_ADMIN_ONLY}</p>
            )}
            <div className="space-y-1">
              <Label htmlFor="c-notes">Notes</Label>
              <Textarea
                id="c-notes"
                value={draft.notes}
                maxLength={2000}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                rows={3}
                placeholder="Terms, contact preferences, etc."
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !draft.name.trim()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {state.id ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IntakeDialog({
  consignor,
  onClose,
  onSaved,
}: {
  consignor: ConsignorWithPnl | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  // C12: the agreement names the seller's business, not GradeThread. Only
  // the signed-in account's own profile is known here, so a member acting in
  // someone else's workspace gets the neutral "the seller".
  const business = useAuthStore((s) =>
    !s.activeWorkspaceOwnerId || s.activeWorkspaceOwnerId === s.user?.id
      ? s.profile?.business_name?.trim() || null
      : null,
  );

  useEffect(() => {
    // C12: never pre-fill the signer's name. The consignor types it.
    setName("");
    setAgreed(false);
  }, [consignor]);

  if (!consignor) return null;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!consignor) return;
    if (!name.trim() || !agreed) {
      toast.error("Type the signature name and accept the agreement.");
      return;
    }
    setSaving(true);
    try {
      const res = await edgeFetch(
        `/api/flipdesk/consignment/consignors/${consignor.id}/intake`,
        { method: "POST", json: { signature_name: name.trim(), agreement_version: "v1" } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not record signature");
      }
      toast.success("Signature recorded.");
      onSaved();
    } catch (err) {
      toastError(err, "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!consignor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Consignment intake agreement</DialogTitle>
            <DialogDescription>
              Hand the device to the consignor to type their own name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              By signing, {consignor.name} authorizes {business ?? "the seller"} to
              list, grade, sell, and ship the consigned items, and agrees that the
              split is {consignor.default_split_pct}%, {CONSIGNOR_SPLIT_BASIS}, paid
              out via the connected payout method after a sale clears.
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-signature-type-full-name">Signature (type full name) *</Label>
              <Input
                id="c-signature-type-full-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full legal name"
                autoComplete="off"
                maxLength={120}
              />
            </div>
            <label
              htmlFor="c-intake-agree"
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              <Checkbox
                id="c-intake-agree"
                checked={agreed}
                onCheckedChange={(v) => setAgreed(v === true)}
              />
              I agree to the consignment terms above.
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim() || !agreed}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record in-person signature
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayoutDialog({
  consignor,
  onClose,
  onSaved,
}: {
  consignor: ConsignorWithPnl | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [paidOutside, setPaidOutside] = useState(false);
  const [saving, setSaving] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);

  const balance = consignorBalance(consignor?.pnl);

  useEffect(() => {
    // C9: pre-fill what is safe to pay now, net of payouts already in flight.
    const b = consignorBalance(consignor?.pnl);
    setAmount(b.available > 0 ? b.available.toFixed(2) : "0.00");
    setNote("");
    setPaidOutside(false);
    setCapError(null);
  }, [consignor]);

  if (!consignor) return null;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!consignor) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Enter a positive amount.");
      return;
    }
    setSaving(true);
    setCapError(null);
    try {
      const res = await edgeFetch(`/api/flipdesk/consignment/payouts`, {
        method: "POST",
        json: { consignor_id: consignor.id, amount: amount.trim(), note: note.trim() || undefined },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setCapError(body.error ?? "That is more than you owe them.");
        return;
      }
      if (!res.ok) throw new Error(body.error ?? "Payout failed");
      const shown = money(amt);
      if (body.transferred) {
        if (body.ledger_updated === false) {
          toast.warning(
            `Sent ${shown} to ${consignor.name} through Stripe, but the record didn't update. It may show as pending until it's fixed.`,
          );
        } else {
          toast.success(`Sent ${shown} to ${consignor.name} through Stripe.`);
        }
      } else if (paidOutside && body.payout?.id) {
        // C7: the seller already paid in cash or by check; close it out now.
        const mark = await edgeFetch(`/api/flipdesk/consignment/payouts/${body.payout.id}`, {
          method: "PATCH",
          json: { action: "mark_paid" },
        });
        if (mark.ok) {
          toast.success(`Recorded ${shown} paid to ${consignor.name} in cash or by check.`);
        } else {
          toast.warning(
            `Recorded ${shown} as pending. Open History and mark it paid.`,
          );
        }
      } else {
        toast.success(
          `Recorded ${shown} as pending. Mark it paid in History once you've paid them.`,
        );
      }
      onSaved();
    } catch (err) {
      toastError(err, "Payout failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!consignor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>Pay {consignor.name}</DialogTitle>
            <DialogDescription>
              Owed {money(balance.available)}
              {balance.pending > 0 ? `, ${money(balance.pending)} already in flight` : ""}.{" "}
              {consignor.payouts_enabled
                ? "A Stripe transfer will be sent to their connected account."
                : "They aren't connected to Stripe, so this is recorded, not sent."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1">
              <Label htmlFor="c-amount-usd">Amount (USD) *</Label>
              <Input
                id="c-amount-usd"
                type="number"
                inputMode="decimal"
                min={0}
                step={0.01}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={!!capError}
                aria-describedby={capError ? "c-amount-error" : undefined}
              />
              {capError && (
                <p id="c-amount-error" className="text-xs text-brand-red-text">
                  {capError}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="c-note">Note</Label>
              <Input
                id="c-note"
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. March payout"
              />
            </div>
            {!consignor.payouts_enabled && (
              <label
                htmlFor="c-paid-outside"
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <Checkbox
                  id="c-paid-outside"
                  checked={paidOutside}
                  onCheckedChange={(v) => setPaidOutside(v === true)}
                />
                Already paid them in cash or by check?
              </label>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !amount || Number(amount) <= 0}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {consignor.payouts_enabled
                ? "Send payout"
                : paidOutside
                  ? "Record as paid"
                  : "Record payout"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayoutHistoryDialog({
  consignor,
  canManageMoney,
  onClose,
  onChanged,
}: {
  consignor: ConsignorWithPnl | null;
  canManageMoney: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  // C11: fetch only while the dialog is open.
  const {
    data: payouts = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useConsignorPayouts(consignor?.id, { enabled: !!consignor });
  const [busy, setBusy] = useState<string | null>(null);

  async function settle(p: ConsignorPayoutRow, action: "mark_paid" | "cancel") {
    setBusy(p.id);
    try {
      const res = await edgeFetch(`/api/flipdesk/consignment/payouts/${p.id}`, {
        method: "PATCH",
        json: { action },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't update that payout.");
      toast.success(action === "mark_paid" ? "Marked paid." : "Payout canceled.");
      onChanged();
    } catch (err) {
      toastError(err, "Couldn't update that payout");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={!!consignor} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Payout history for {consignor?.name}</DialogTitle>
          <DialogDescription>
            Every payout recorded for this consignor, newest first.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <LoadingRegion label="Loading payouts">
            <SkeletonRows rows={3} />
          </LoadingRegion>
        ) : error ? (
          <div className="space-y-3 py-8 text-center text-sm">
            <p className="text-destructive">{(error as Error).message}</p>
            <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Try again
            </Button>
          </div>
        ) : payouts.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No payouts yet.
          </div>
        ) : (
          <div className="max-h-[60dvh] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Source</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.map((p) => {
                  const settleable =
                    canManageMoney &&
                    p.source !== "auto" &&
                    (p.status === "pending" || p.status === "failed");
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="align-top text-sm">
                        {new Date(p.created_at).toLocaleDateString()}
                        {p.paid_at && (
                          <div className="text-xs text-muted-foreground">
                            Paid {new Date(p.paid_at).toLocaleDateString()}
                          </div>
                        )}
                        {p.note && (
                          <div className="max-w-56 text-xs text-muted-foreground">{p.note}</div>
                        )}
                        {p.status === "failed" && p.error && (
                          <div className="max-w-56 text-xs text-brand-red-text">{p.error}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right align-top tabular-nums">
                        {money(p.amount)}
                      </TableCell>
                      <TableCell className="align-top">
                        {/* US-2022: a clawback-pending row is real money the seller
                            is out until someone recovers it, so it reads as
                            destructive rather than as just another status. */}
                        <Badge
                          variant={
                            p.status === "clawback_pending"
                              ? "destructive"
                              : p.status === "paid"
                                ? "default"
                                : "outline"
                          }
                        >
                          {CONSIGNOR_PAYOUT_STATUS_LABELS[p.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden align-top text-xs text-muted-foreground sm:table-cell">
                        {p.source === "auto" ? "Auto, for a sale" : "Manual"}
                      </TableCell>
                      <TableCell className="align-top">
                        {settleable && (
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-9"
                              disabled={busy === p.id}
                              onClick={() => void settle(p, "mark_paid")}
                              aria-label={`Mark the ${money(p.amount)} payout from ${new Date(p.created_at).toLocaleDateString()} paid`}
                            >
                              Mark paid
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-9"
                              disabled={busy === p.id}
                              onClick={() => void settle(p, "cancel")}
                              aria-label={`Cancel the ${money(p.amount)} payout from ${new Date(p.created_at).toLocaleDateString()}`}
                            >
                              Cancel
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
