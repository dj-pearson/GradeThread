import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1858: reward economics — what the tangible rail may cost, whether it is
// paying, what refused a grant, whether the value arrived, and what it bought.
//
// The Milestone Rewards screen decides what a milestone GIVES. This one is the
// budget it gives out of. Three things it is built to make unmissable:
//
//   • the payout switch, at the top, with today's spend beside it. An operator
//     opening this page in an incident wants "is money still leaving?" answered
//     before anything else.
//   • which ceiling is currently binding. A per-account cap narrowed by the
//     margin floor is reported as a MARGIN breach, not a budget one, so nobody
//     raises a cap that was never the constraint.
//   • that reconciliation REPORTS. Nothing here repairs a discrepancy: a grant
//     the credit ledger disagrees with is evidence, and a console that quietly
//     fixed it would destroy the only record of how it happened.
//
// Cosmetic rewards (XP, levels, badges) are deliberately absent. They cost
// nothing marginal, so there is no budget to show.

interface Budget {
  monthlyUsdCap: number;
  perUserMonthlyUsdCap: number;
  perUserLifetimeUsdCap: number;
}

interface Guardrails {
  marginFloorPct: number;
  freeTierMonthlyUsdCap: number;
  perUserDailyGrantCap: number;
  perUserDailyUsdCap: number;
  autoKillOnGlobalBreach: boolean;
  fraudHoldEnabled: boolean;
}

interface Breach {
  id: string;
  scope: string;
  subject_user_id: string | null;
  limit_usd: number;
  spend_usd: number;
  milestone_key: string | null;
  killed: boolean;
  created_at: string;
}

interface Roi {
  window_days: number;
  rewardSpendUsd: number;
  referralSignups: number;
  shareSignups: number;
  attributedSignups: number;
  costPerSignupUsd: number | null;
}

interface EconomicsResponse {
  enabled: boolean;
  budget: Budget;
  guardrails: Guardrails;
  spend: {
    month_start: string;
    month_usd: number;
    month_grants: number;
    month_accounts: number;
    lifetime_usd: number;
  };
  open_breaches: Breach[];
  roi: Roi;
}

interface Finding {
  grantId: string;
  userId: string;
  milestoneKey: string;
  rewardType: string;
  issue: string;
  expected: number | string;
  actual: number | string | null;
}

interface ReconcileResponse {
  window_days: number;
  truncated: boolean;
  stripe_checked: boolean;
  checked: number;
  matched: number;
  findings: Finding[];
}

const SCOPE_LABEL: Record<string, string> = {
  global_monthly: "Platform monthly budget",
  user_monthly: "Per-account monthly budget",
  user_lifetime: "Per-account lifetime budget",
  margin_floor: "Margin floor",
  velocity: "Daily velocity limit",
};

const ISSUE_LABEL: Record<string, string> = {
  missing_credit_ledger: "No credit ledger row",
  credit_amount_mismatch: "Credit amount disagrees",
  missing_coupon: "No Stripe coupon recorded",
  coupon_not_found: "Coupon missing in Stripe",
};

const usd = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });

interface Draft {
  monthly_usd_cap: string;
  per_user_monthly_usd_cap: string;
  per_user_lifetime_usd_cap: string;
  margin_floor_pct: string;
  free_tier_monthly_usd_cap: string;
  per_user_daily_grant_cap: string;
  per_user_daily_usd_cap: string;
  auto_kill_on_global_breach: boolean;
  fraud_hold_enabled: boolean;
}

function toDraft(d: EconomicsResponse): Draft {
  return {
    monthly_usd_cap: String(d.budget.monthlyUsdCap),
    per_user_monthly_usd_cap: String(d.budget.perUserMonthlyUsdCap),
    per_user_lifetime_usd_cap: String(d.budget.perUserLifetimeUsdCap),
    // Stored as a fraction, edited as a percentage — 0.4 is not a number anyone
    // types when they mean "forty percent".
    margin_floor_pct: String(Math.round(d.guardrails.marginFloorPct * 100)),
    free_tier_monthly_usd_cap: String(d.guardrails.freeTierMonthlyUsdCap),
    per_user_daily_grant_cap: String(d.guardrails.perUserDailyGrantCap),
    per_user_daily_usd_cap: String(d.guardrails.perUserDailyUsdCap),
    auto_kill_on_global_breach: d.guardrails.autoKillOnGlobalBreach,
    fraud_hold_enabled: d.guardrails.fraudHoldEnabled,
  };
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-muted/40 p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function GrowthRewardEconomicsPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery<EconomicsResponse>({
    queryKey: ["admin-reward-economics"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/rewards/economics");
      if (!res.ok) throw new Error("Failed to load reward economics");
      return res.json();
    },
  });

  const reconcile = useQuery<ReconcileResponse>({
    queryKey: ["admin-reward-reconciliation"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/rewards/economics/reconciliation?days=30");
      if (!res.ok) throw new Error("Failed to reconcile reward grants");
      return res.json();
    },
  });

  // Seed the form once the server's numbers land, and never clobber an edit in
  // progress on a background refetch.
  useEffect(() => {
    if (data && !draft) setDraft(toDraft(data));
  }, [data, draft]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      const res = await edgeFetch("/api/admin/rewards/economics", {
        method: "PATCH",
        json: {
          monthly_usd_cap: Number(draft.monthly_usd_cap),
          per_user_monthly_usd_cap: Number(draft.per_user_monthly_usd_cap),
          per_user_lifetime_usd_cap: Number(draft.per_user_lifetime_usd_cap),
          margin_floor_pct: Number(draft.margin_floor_pct) / 100,
          free_tier_monthly_usd_cap: Number(draft.free_tier_monthly_usd_cap),
          per_user_daily_grant_cap: Number(draft.per_user_daily_grant_cap),
          per_user_daily_usd_cap: Number(draft.per_user_daily_usd_cap),
          auto_kill_on_global_breach: draft.auto_kill_on_global_breach,
          fraud_hold_enabled: draft.fraud_hold_enabled,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Save failed");
      return json;
    },
    onSuccess: () => {
      toast.success("Reward budget saved");
      qc.invalidateQueries({ queryKey: ["admin-reward-economics"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const togglePayouts = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await edgeFetch("/api/admin/rewards/economics/kill-switch", {
        method: "POST",
        json: { enabled },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't change the payout switch");
      return json;
    },
    onSuccess: (json: { enabled: boolean }) => {
      toast.success(json.enabled ? "Payouts resumed" : "Payouts paused");
      qc.invalidateQueries({ queryKey: ["admin-reward-economics"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resolveBreach = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/rewards/economics/breaches/${id}/resolve`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't resolve the breach");
      return json;
    },
    onSuccess: () => {
      toast.success("Breach resolved");
      qc.invalidateQueries({ queryKey: ["admin-reward-economics"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // US-2507: an errored query leaves data undefined, so without this branch the
  // page below rendered its loading skeleton FOREVER — the same defect US-1631
  // fixed on seller billing.
  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reward economics" subtitle="Budget, guardrails and payout ROI." />
        <ErrorState
          title="Couldn't load reward economics"
          description="The budget and guardrails are still set — we just couldn't fetch them right now."
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      </div>
    );
  }

  if (isLoading || !data || !draft) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reward economics" subtitle="Budget, guardrails and payout ROI." />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const pctOfBudget = data.budget.monthlyUsdCap > 0
    ? Math.round((data.spend.month_usd / data.budget.monthlyUsdCap) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reward economics"
        subtitle="What tangible rewards may cost, what stopped a payout, and what the spend bought."
      />

      {/* The switch first: in an incident the question is whether money is still
          leaving, and it should not need scrolling for. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex items-start gap-3">
            {data.enabled
              ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
              : <ShieldCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />}
            <div>
              <p className="font-semibold">
                {data.enabled ? "Payouts are running" : "Payouts are paused"}
              </p>
              <p className="text-sm text-muted-foreground">
                {data.enabled
                  ? "Milestones grant credits and discounts as people cross them."
                  : "XP, levels and badges keep accruing. Nothing of real value is granted."}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="payout-switch" className="text-sm">Tangible payouts</Label>
            <Switch
              id="payout-switch"
              checked={data.enabled}
              disabled={togglePayouts.isPending}
              onCheckedChange={(v) => togglePayouts.mutate(v)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Spent this month"
          value={usd(data.spend.month_usd)}
          hint={`${pctOfBudget}% of ${usd(data.budget.monthlyUsdCap)}`}
        />
        <StatTile
          label="Grants this month"
          value={String(data.spend.month_grants)}
          hint={`${data.spend.month_accounts} account${data.spend.month_accounts === 1 ? "" : "s"}`}
        />
        <StatTile label="Spent all time" value={usd(data.spend.lifetime_usd)} />
        <StatTile
          label="Cost per signup"
          value={data.roi.costPerSignupUsd === null ? "—" : usd(data.roi.costPerSignupUsd)}
          hint={`${data.roi.attributedSignups} signups in ${data.roi.window_days} days`}
        />
      </div>

      {/* ROI. The two components are shown beside the total because a signup off
          a shared find is often ALSO a referral signup — the sum is the
          optimistic bound, and hiding that would overstate the return. */}
      <Card>
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="font-semibold">Return on reward spend</h2>
            <p className="text-sm text-muted-foreground">
              Last {data.roi.window_days} days. Referral and share signups overlap, so the
              total is the most generous reading.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Reward spend" value={usd(data.roi.rewardSpendUsd)} />
            <StatTile label="Referral signups" value={String(data.roi.referralSignups)} />
            <StatTile label="Signups from shared finds" value={String(data.roi.shareSignups)} />
          </div>
        </CardContent>
      </Card>

      {/* Budget + guardrails */}
      <Card>
        <CardContent className="space-y-5 p-6">
          <div>
            <h2 className="font-semibold">Budget and guardrails</h2>
            <p className="text-sm text-muted-foreground">
              Caps are in what a grant costs us to honour, not list price. The guardrails
              only ever narrow these numbers.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="cap-platform">Platform monthly cap (USD)</Label>
              <Input
                id="cap-platform"
                type="number"
                min={0}
                step="1"
                value={draft.monthly_usd_cap}
                onChange={(e) => set("monthly_usd_cap", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cap-user-month">Per account, monthly (USD)</Label>
              <Input
                id="cap-user-month"
                type="number"
                min={0}
                step="1"
                value={draft.per_user_monthly_usd_cap}
                onChange={(e) => set("per_user_monthly_usd_cap", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cap-user-life">Per account, lifetime (USD)</Label>
              <Input
                id="cap-user-life"
                type="number"
                min={0}
                step="1"
                value={draft.per_user_lifetime_usd_cap}
                onChange={(e) => set("per_user_lifetime_usd_cap", e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="margin-floor">Margin floor (%)</Label>
              <Input
                id="margin-floor"
                type="number"
                min={0}
                max={95}
                step="1"
                value={draft.margin_floor_pct}
                onChange={(e) => set("margin_floor_pct", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Share of a subscriber's revenue that must survive their AI cost and rewards.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="free-allowance">Free-tier allowance (USD/mo)</Label>
              <Input
                id="free-allowance"
                type="number"
                min={0}
                step="1"
                value={draft.free_tier_monthly_usd_cap}
                onChange={(e) => set("free_tier_monthly_usd_cap", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                An account with no revenue has no margin to protect, so this is an
                acquisition cost instead.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="daily-grants">Grants per account per day</Label>
              <Input
                id="daily-grants"
                type="number"
                min={0}
                step="1"
                value={draft.per_user_daily_grant_cap}
                onChange={(e) => set("per_user_daily_grant_cap", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">0 turns the limit off.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="daily-usd">Spend per account per day (USD)</Label>
              <Input
                id="daily-usd"
                type="number"
                min={0}
                step="1"
                value={draft.per_user_daily_usd_cap}
                onChange={(e) => set("per_user_daily_usd_cap", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">0 turns the limit off.</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-start justify-between gap-4 rounded-xl bg-muted/40 p-4">
              <div>
                <p className="font-medium">Pause payouts on a platform breach</p>
                <p className="text-sm text-muted-foreground">
                  Switch the whole rail off the first time the monthly cap refuses a grant.
                </p>
              </div>
              <Switch
                id="auto-kill"
                aria-label="Pause payouts on a platform breach"
                checked={draft.auto_kill_on_global_breach}
                onCheckedChange={(v) => set("auto_kill_on_global_breach", v)}
              />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-xl bg-muted/40 p-4">
              <div>
                <p className="font-medium">Hold payouts for accounts under review</p>
                <p className="text-sm text-muted-foreground">
                  No tangible reward while an open high or critical abuse signal stands.
                </p>
              </div>
              <Switch
                id="fraud-hold"
                aria-label="Hold payouts for accounts under review"
                checked={draft.fraud_hold_enabled}
                onCheckedChange={(v) => set("fraud_hold_enabled", v)}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDraft(toDraft(data))}>Reset</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Open breaches */}
      <Card>
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="font-semibold">Open breaches</h2>
            <p className="text-sm text-muted-foreground">
              One row per ceiling that refused a grant. Nothing re-alerts while a breach
              stays open, so resolve it once you have acted.
            </p>
          </div>
          {data.open_breaches.length === 0
            ? (
              <EmptyState
                icon={CheckCircle2}
                title="Nothing is being refused"
                description="No reward ceiling has stopped a payout."
              />
            )
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ceiling</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Spend / limit</TableHead>
                    <TableHead>Milestone</TableHead>
                    <TableHead>Raised</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.open_breaches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-medium">
                        {SCOPE_LABEL[b.scope] ?? b.scope}
                        {b.killed && (
                          <Badge variant="destructive" className="ml-2">Payouts paused</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {b.subject_user_id ?? "Platform-wide"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(Number(b.spend_usd))} / {usd(Number(b.limit_usd))}
                      </TableCell>
                      <TableCell className="text-xs">{b.milestone_key ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(b.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                        aria-label={`Resolve the breach for ${b.subject_user_id ?? "the platform"}`}
                          size="sm"
                          variant="outline"
                          disabled={resolveBreach.isPending}
                          onClick={() => resolveBreach.mutate(b.id)}
                        >
                          Resolve
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      {/* Reconciliation */}
      <Card>
        <CardContent className="space-y-4 p-6">
          <div>
            <h2 className="font-semibold">Payout reconciliation</h2>
            <p className="text-sm text-muted-foreground">
              Last 30 days of delivered grants, checked against the grade-credit ledger and
              Stripe. This reports only — a discrepancy is evidence, not something to
              silently repair.
            </p>
          </div>
          {reconcile.isLoading && <Skeleton className="h-24 w-full" />}
          {reconcile.data && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <StatTile label="Grants checked" value={String(reconcile.data.checked)} />
                <StatTile label="Reconciled" value={String(reconcile.data.matched)} />
                <StatTile
                  label="Discrepancies"
                  value={String(reconcile.data.findings.length)}
                  hint={reconcile.data.stripe_checked
                    ? "Stripe coupons verified"
                    : "Stripe not checked this run"}
                />
              </div>
              {reconcile.data.findings.length === 0
                ? (
                  <EmptyState
                    icon={CheckCircle2}
                    title="Every payout landed"
                    description="Each delivered grant has the credit row or coupon it promised."
                  />
                )
                : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Problem</TableHead>
                        <TableHead>Milestone</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right">Expected</TableHead>
                        <TableHead className="text-right">Found</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reconcile.data.findings.map((f) => (
                        <TableRow key={`${f.grantId}-${f.issue}`}>
                          <TableCell className="font-medium">
                            <span className="inline-flex items-center gap-2">
                              <AlertTriangle className="h-4 w-4 text-amber-600" />
                              {ISSUE_LABEL[f.issue] ?? f.issue}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs">{f.milestoneKey}</TableCell>
                          <TableCell className="font-mono text-xs">{f.userId}</TableCell>
                          <TableCell className="text-right text-xs">{String(f.expected)}</TableCell>
                          <TableCell className="text-right text-xs">
                            {f.actual === null ? "—" : String(f.actual)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              {reconcile.data.truncated && (
                <p className="text-xs text-muted-foreground">
                  Only the most recent {reconcile.data.checked} grants were checked.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
