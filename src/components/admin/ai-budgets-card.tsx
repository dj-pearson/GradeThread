import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { useAuth } from "@/hooks/use-auth";
import { AlertTriangle, Gauge, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";

// US-895: per-feature AI spend budgets (alert/throttle/kill) + breach history +
// one-click re-enable. Reads are admin-level; create/edit/delete/re-enable are
// super_admin + a fresh MFA step-up server-side (mirrors the feature-flags page).

type BudgetPeriod = "day" | "month";
type BudgetAction = "alert" | "throttle" | "kill";

interface BudgetStatus {
  id: string;
  feature: string;
  period: BudgetPeriod;
  limitUsd: number;
  action: BudgetAction;
  enabled: boolean;
  spendUsd: number;
  breached: boolean;
  pct: number;
  updatedAt: string;
}

interface BreachRow {
  id: string;
  budget_id: string | null;
  feature: string;
  period: BudgetPeriod;
  action: BudgetAction;
  limit_usd: number;
  spend_usd: number;
  killed: boolean;
  flag_key: string | null;
  alerted: boolean;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
}

interface BudgetsResponse {
  budgets: BudgetStatus[];
  breaches: BreachRow[];
}

const PERIODS: BudgetPeriod[] = ["day", "month"];
const ACTIONS: BudgetAction[] = ["alert", "throttle", "kill"];

const ACTION_HINT: Record<BudgetAction, string> = {
  alert: "Record a breach + send an ops alert only.",
  throttle: "Alert + mark breached (a soft-throttle hook).",
  kill: "Alert + flip the matching feature kill-switch OFF (hard stop).",
};

const usd = (n: number) =>
  (n ?? 0).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: (n ?? 0) < 1 ? 4 : 2,
  });

function actionBadge(action: BudgetAction) {
  const variant =
    action === "kill" ? "destructive" : action === "throttle" ? "default" : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {action}
    </Badge>
  );
}

// ── Create / edit dialog ──
function BudgetEditorDialog({
  budget,
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  budget: BudgetStatus | null; // null = create
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (payload: Record<string, unknown>, id: string | null) => void;
  pending: boolean;
}) {
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [feature, setFeature] = useState("");
  const [period, setPeriod] = useState<BudgetPeriod>("day");
  const [action, setAction] = useState<BudgetAction>("alert");
  const [limit, setLimit] = useState("");
  const [enabled, setEnabled] = useState(true);

  // Seed once per opened budget (or reset for create).
  const seedKey = budget?.id ?? "__new__";
  if (open && seededFor !== seedKey) {
    setFeature(budget?.feature ?? "");
    setPeriod(budget?.period ?? "day");
    setAction(budget?.action ?? "alert");
    setLimit(budget ? String(budget.limitUsd) : "");
    setEnabled(budget?.enabled ?? true);
    setSeededFor(seedKey);
  }

  const limitNum = Number(limit);
  const limitValid = Number.isFinite(limitNum) && limitNum >= 0;
  const featureValid = feature.trim().length > 0;

  const submit = () => {
    if (!featureValid || !limitValid) return;
    onSave(
      {
        feature: feature.trim(),
        period,
        action,
        limitUsd: limitNum,
        enabled,
      },
      budget?.id ?? null,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setSeededFor(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4" />
            {budget ? "Edit budget" : "New AI spend budget"}
          </DialogTitle>
          <DialogDescription>
            Cap a feature's Claude spend per period. On breach the guardrail alerts
            and, for <strong>kill</strong>, flips that feature's switch off.
            Requires a super-admin MFA step-up.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="budget-feature">Feature</Label>
            <Input
              id="budget-feature"
              value={feature}
              onChange={(e) => setFeature(e.target.value)}
              placeholder="grading, autolister, content, reconcile…"
              disabled={!!budget}
            />
            <p className="text-xs text-muted-foreground">
              The AI feature slug as it appears in AI Spend (by feature).
            </p>
          </div>

          <div className="space-y-2">
            <Label>Period</Label>
            <div className="flex gap-2">
              {PERIODS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={period === p ? "default" : "outline"}
                  className="capitalize"
                  onClick={() => setPeriod(p)}
                >
                  {p === "day" ? "Daily" : "Monthly"}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="budget-limit">Limit (USD)</Label>
            <Input
              id="budget-limit"
              type="number"
              min={0}
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="50.00"
            />
            {!limitValid && limit !== "" && (
              <p className="text-xs text-red-600 dark:text-red-400">
                Enter a non-negative dollar amount.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Action on breach</Label>
            <div className="flex gap-2">
              {ACTIONS.map((a) => (
                <Button
                  key={a}
                  type="button"
                  size="sm"
                  variant={action === a ? "default" : "outline"}
                  className="capitalize"
                  onClick={() => setAction(a)}
                >
                  {a}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{ACTION_HINT[action]}</p>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Enabled</div>
              <p className="text-xs text-muted-foreground">
                Off = the budget is not evaluated.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant={enabled ? "default" : "outline"}
              onClick={() => setEnabled((v) => !v)}
            >
              {enabled ? "On" : "Off"}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !featureValid || !limitValid}>
            {pending ? "Saving…" : budget ? "Save changes" : "Create budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AiBudgetsCard() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<BudgetStatus | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-ai-budgets"],
    queryFn: async (): Promise<BudgetsResponse> => {
      const res = await edgeFetch("/api/admin/ai-budgets");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load budgets.");
      return json;
    },
    staleTime: 30_000,
  });

  // Step-up-aware runner (mirrors the feature-flags page).
  async function run(doFetch: () => Promise<Response>, onOk: () => void) {
    setWorking(true);
    try {
      const res = await doFetch();
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => run(doFetch, onOk));
          setStepUpOpen(true);
          return;
        }
        toast.error((j as { error?: string })?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string }).error ?? "Save failed");
        return;
      }
      onOk();
    } finally {
      setWorking(false);
    }
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-ai-budgets"] });

  const saveBudget = (payload: Record<string, unknown>, id: string | null) =>
    run(
      () =>
        edgeFetch(id ? `/api/admin/ai-budgets/${id}` : "/api/admin/ai-budgets", {
          method: id ? "PUT" : "POST",
          json: payload,
          silentGate: true,
        }),
      () => {
        toast.success(id ? "Budget updated" : "Budget created");
        setEditorOpen(false);
        setEditing(null);
        invalidate();
      },
    );

  const deleteBudget = (b: BudgetStatus) => {
    if (!confirm(`Delete the ${b.period} budget for "${b.feature}"?`)) return;
    run(
      () =>
        edgeFetch(`/api/admin/ai-budgets/${b.id}`, {
          method: "DELETE",
          silentGate: true,
        }),
      () => {
        toast.success("Budget deleted");
        invalidate();
      },
    );
  };

  const resolveBreach = (br: BreachRow) =>
    run(
      () =>
        edgeFetch(`/api/admin/ai-budgets/breaches/${br.id}/resolve`, {
          method: "POST",
          silentGate: true,
        }),
      () => {
        toast.success(
          br.killed ? `Re-enabled "${br.flag_key ?? br.feature}"` : "Breach resolved",
        );
        invalidate();
      },
    );

  const openBreaches = (data?.breaches ?? []).filter((b) => b.status === "open");

  return (
    <div className="space-y-6">
      {/* Open breaches banner */}
      {openBreaches.length > 0 && (
        <Card className="border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
              <ShieldAlert className="h-4 w-4" />
              {openBreaches.length} active budget breach
              {openBreaches.length > 1 ? "es" : ""}
            </CardTitle>
            <CardDescription className="text-red-700/80 dark:text-red-300/80">
              A feature exceeded its AI spend budget.
              {isSuperAdmin
                ? " Investigate, then re-enable below."
                : " A super-admin can re-enable it."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {openBreaches.map((br) => (
              <div
                key={br.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-background/60 px-3 py-2 text-sm dark:border-red-900"
              >
                <div>
                  <span className="font-medium">{br.feature}</span>{" "}
                  <span className="text-muted-foreground">({br.period})</span> —{" "}
                  {usd(br.spend_usd)} of {usd(br.limit_usd)}
                  {br.killed && (
                    <Badge variant="destructive" className="ml-2">
                      killed: {br.flag_key}
                    </Badge>
                  )}
                  {!br.alerted && (
                    <Badge variant="outline" className="ml-2">
                      alert undelivered
                    </Badge>
                  )}
                </div>
                {isSuperAdmin && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working}
                    onClick={() => resolveBreach(br)}
                  >
                    {br.killed ? "Re-enable feature" : "Resolve"}
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Budgets table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Gauge className="h-4 w-4" /> Budget guardrails
              </CardTitle>
              <CardDescription>
                Per-feature daily/monthly spend caps. On breach: alert and, for
                kill, auto-disable the feature.
              </CardDescription>
            </div>
            {isSuperAdmin && (
              <Button
                size="sm"
                disabled={working}
                onClick={() => {
                  setEditing(null);
                  setEditorOpen(true);
                }}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> New budget
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isError ? (
            <p className="flex items-center gap-2 p-4 text-sm text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" /> Failed to load budgets.
            </p>
          ) : isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (data?.budgets.length ?? 0) === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No budgets configured.{" "}
              {isSuperAdmin && "Add one to guard against runaway AI spend."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Spend / Limit</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Status</TableHead>
                  {isSuperAdmin && <TableHead className="text-right">Edit</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.budgets.map((b) => (
                  <TableRow key={b.id} className={b.breached ? "bg-red-50/60 dark:bg-red-950/20" : ""}>
                    <TableCell className="font-medium">{b.feature}</TableCell>
                    <TableCell className="capitalize">{b.period}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {usd(b.spendUsd)} / {usd(b.limitUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span
                        className={
                          b.pct >= 100
                            ? "font-semibold text-red-600 dark:text-red-400"
                            : b.pct >= 80
                              ? "text-amber-600 dark:text-amber-400"
                              : ""
                        }
                      >
                        {b.pct.toFixed(0)}%
                      </span>
                    </TableCell>
                    <TableCell>{actionBadge(b.action)}</TableCell>
                    <TableCell>
                      {!b.enabled ? (
                        <Badge variant="outline">Disabled</Badge>
                      ) : b.breached ? (
                        <Badge variant="destructive">Breached</Badge>
                      ) : (
                        <Badge variant="secondary">OK</Badge>
                      )}
                    </TableCell>
                    {isSuperAdmin && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working}
                            onClick={() => {
                              setEditing(b);
                              setEditorOpen(true);
                            }}
                            title="Edit budget"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working}
                            onClick={() => deleteBudget(b)}
                            title="Delete budget"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isSuperAdmin && (
        <BudgetEditorDialog
          budget={editing}
          open={editorOpen}
          onOpenChange={(o) => {
            setEditorOpen(o);
            if (!o) setEditing(null);
          }}
          onSave={saveBudget}
          pending={working}
        />
      )}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => retry?.()}
      />
    </div>
  );
}
