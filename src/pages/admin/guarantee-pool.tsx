import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { AlertTriangle, Loader2, PiggyBank, Settings } from "lucide-react";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";

// US-1822: buyer guarantee claims-pool ops dashboard. Read-only — cap/term edits
// live in the system_settings editor (buyer.guarantee_pool / buyer.guarantee_remedy).

interface PeriodStat {
  period: string;
  accruedCents: number;
  drawnCents: number;
  exposureCents: number;
  lossRatio: number | null;
  drawdownCount: number;
}

interface PendingClaim {
  id: string;
  user_id: string;
  purchase_id: string;
  remedy_cents: number;
  grade_delta: number | null;
  decision_reason: string | null;
  fraud_flags: string[];
  fraud_score: number;
  created_at: string;
}

interface PoolData {
  config: {
    period_budget_cents: number;
    per_account_period_cap_cents: number;
    loss_ratio_throttle: number;
    accrual_per_active_sub_cents: number;
  };
  periods: PeriodStat[];
  outcomes: Record<string, number>;
  throttled: boolean;
  pendingClaims: PendingClaim[];
}

const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);

export function AdminGuaranteePoolPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, isFetching, refetch } = useQuery<PoolData>({
    queryKey: ["admin-guarantee-pool"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/guarantee-pool");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load the pool.");
      return json as PoolData;
    },
  });

  const resolve = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "approve" | "reject" | "reject_fraud" }) => {
      const res = await edgeFetch(`/api/admin/guarantee-pool/claims/${id}/resolve`, {
        method: "POST",
        json: { action },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to resolve the claim.");
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-guarantee-pool"] });
      toast.success("Claim resolved.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to resolve the claim."),
  });

  // US-2507: on an error `isLoading` is false and `data` is undefined, so this
  // page used to `return null` — a completely blank screen with no heading, no
  // message and nothing to click. Say what happened instead.
  if (isError) {
    return (
      <ErrorState
        title="Couldn't load the guarantee pool"
        description="The pool and its periods are intact — we just couldn't fetch them right now."
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!data) return null;

  const current = data.periods[0] ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        icon={PiggyBank}
        title="Guarantee Pool"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/ops/settings">
              <Settings className="mr-1 h-4 w-4" /> Adjust caps
            </Link>
          </Button>
        }
      />

      {data.throttled && (
        <div className="flex items-center gap-2 rounded-md border border-brand-red/40 bg-brand-red/10 p-3 text-sm text-brand-red-text">
          <AlertTriangle className="h-4 w-4" />
          Loss ratio has breached the throttle ({pct(data.config.loss_ratio_throttle)}) — auto-payouts are routing to manual review.
        </div>
      )}

      {/* Current-period headline. */}
      {current && (
        <div className="grid gap-4 sm:grid-cols-4">
          <StatCard label={`Exposure (${current.period})`} value={usd(current.exposureCents)} />
          <StatCard label="Accrued" value={usd(current.accruedCents)} />
          <StatCard label="Drawn" value={usd(current.drawnCents)} />
          <StatCard label="Loss ratio" value={pct(current.lossRatio)} />
        </div>
      )}

      {/* US-1821/1823: manual-review queue (auto-downgrades + fraud-flagged). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Manual review ({data.pendingClaims.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {data.pendingClaims.length === 0 ? (
            <p className="text-sm text-muted-foreground">No claims awaiting review.</p>
          ) : (
            <div className="space-y-3">
              {data.pendingClaims.map((cl) => (
                <div key={cl.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                  <div className="min-w-0 space-y-1 text-sm">
                    <p className="font-medium tabular-nums">{usd(cl.remedy_cents)} remedy</p>
                    <p className="text-xs text-muted-foreground">
                      {cl.decision_reason ?? "manual review"}
                      {cl.grade_delta != null ? ` · Δ${cl.grade_delta}` : ""}
                    </p>
                    {cl.fraud_flags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {cl.fraud_flags.map((f) => (
                          <Badge key={f} variant="destructive" className="text-[10px]">{f.replace(/_/g, " ")}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={resolve.isPending}
                      aria-label={`Approve the ${usd(cl.remedy_cents)} claim`}
                      onClick={() => resolve.mutate({ id: cl.id, action: "approve" })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resolve.isPending}
                      aria-label={`Reject the ${usd(cl.remedy_cents)} claim`}
                      onClick={() => resolve.mutate({ id: cl.id, action: "reject" })}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={resolve.isPending}
                      aria-label={`Reject the ${usd(cl.remedy_cents)} claim as fraud`}
                      onClick={() => resolve.mutate({ id: cl.id, action: "reject_fraud" })}
                    >
                      Fraud
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">By period</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Period</th>
                  <th className="py-2 pr-4 font-medium">Accrued</th>
                  <th className="py-2 pr-4 font-medium">Drawn</th>
                  <th className="py-2 pr-4 font-medium">Exposure</th>
                  <th className="py-2 pr-4 font-medium">Loss ratio</th>
                  <th className="py-2 font-medium">Claims</th>
                </tr>
              </thead>
              <tbody>
                {data.periods.map((p) => (
                  <tr key={p.period} className="border-b last:border-0">
                    <td className="py-2 pr-4 tabular-nums">{p.period}</td>
                    <td className="py-2 pr-4 tabular-nums">{usd(p.accruedCents)}</td>
                    <td className="py-2 pr-4 tabular-nums">{usd(p.drawnCents)}</td>
                    <td className="py-2 pr-4 tabular-nums">{usd(p.exposureCents)}</td>
                    <td className="py-2 pr-4 tabular-nums">{pct(p.lossRatio)}</td>
                    <td className="py-2 tabular-nums">{p.drawdownCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Claim outcomes (all-time)</CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(data.outcomes).length === 0 ? (
            <p className="text-sm text-muted-foreground">No claims filed yet.</p>
          ) : (
            <div className="flex flex-wrap gap-4 text-sm">
              {Object.entries(data.outcomes).map(([status, count]) => (
                <div key={status}>
                  <span className="font-semibold tabular-nums">{count}</span>{" "}
                  <span className="text-muted-foreground">{status.replace(/_/g, " ")}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-bold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
