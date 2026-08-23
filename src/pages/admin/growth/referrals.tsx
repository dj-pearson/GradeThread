import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { edgeFetch } from "@/lib/edge-fetch";
import { CHART_PALETTE } from "@/lib/constants";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { PageHeader } from "@/components/ui/page-header";
import { useAuth } from "@/hooks/use-auth";
import {
  Gift,
  Users,
  CheckCircle2,
  Clock,
  Zap,
  TrendingUp,
  Ticket,
  Trash2,
} from "lucide-react";

interface ReferralOverview {
  funnel: { codes: number; total: number; pending: number; qualified: number; granted: number };
  rewards: { referrer_credits: number; referred_credits: number };
  top_referrers: { user_id: string; email: string; total: number; granted: number }[];
  queue: {
    id: string;
    code: string;
    reward_status: string;
    created_at: string;
    referrer_email: string;
    referred_email: string;
  }[];
}

interface CohortStats {
  users: number;
  activated: number;
  activation_rate: number;
  paying: number;
  paying_rate: number;
  revenue_cents: number;
  ltv_cents: number;
}

interface ReferralAnalytics {
  window_days: number;
  series: { date: string; clicks: number; signups: number; qualified: number; granted: number }[];
  totals: { clicks: number; signups: number; qualified: number; granted: number };
  conversion: { click_to_signup: number; signup_to_qualified: number; qualified_to_granted: number };
  k_factor: number;
  referrers: number;
  // The referral_analytics() RPC emits null cohorts for an empty window.
  cohorts: { referred: CohortStats | null; direct: CohortStats | null };
}

interface CampaignCode {
  id: string;
  code: string;
  name: string;
  description: string | null;
  bonus_referred_credits: number;
  is_active: boolean;
  starts_at: string;
  ends_at: string | null;
  max_redemptions: number | null;
  redemption_count: number;
  created_at: string;
}

function Stat({ icon: Icon, label, value, hint }: { icon: typeof Gift; label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function GrowthReferralsPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);
  const [working, setWorking] = useState(false);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["growth-referrals"],
    queryFn: async (): Promise<ReferralOverview> => {
      const res = await edgeFetch("/api/admin/growth/referrals");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load referrals");
      return json;
    },
    refetchInterval: 30_000,
  });

  const { data: analytics } = useQuery({
    queryKey: ["growth-referral-analytics"],
    queryFn: async (): Promise<ReferralAnalytics> => {
      const res = await edgeFetch("/api/admin/growth/referrals/analytics?days=30");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load referral analytics");
      return json;
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const { data: campaign } = useQuery({
    queryKey: ["growth-campaign-codes"],
    queryFn: async (): Promise<{ codes: CampaignCode[] }> => {
      const res = await edgeFetch("/api/admin/growth/campaign-codes");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load campaign codes");
      return json;
    },
    staleTime: 30_000,
  });

  async function grant(id: string) {
    setWorking(true);
    try {
      const res = await edgeFetch(`/api/admin/growth/referrals/${id}/grant`, {
        method: "POST",
        json: {},
        silentGate: true,
      });
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if (j?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => grant(id));
          setStepUpOpen(true);
          return;
        }
        toast.error(j?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j.error ?? "Grant failed");
        return;
      }
      toast.success("Reward granted to both parties");
      qc.invalidateQueries({ queryKey: ["growth-referrals"] });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Referrals"
        subtitle="Organic acquisition loop. Rewards are paid as grade credits to both parties on approval."
        icon={Gift}
      />

      {/* US-2507: isError first. An errored query leaves `data` undefined, so
          `isLoading || !data` would otherwise render the skeleton forever. */}
      {isError ? (
        <ErrorState
          title="Couldn't load the referral funnel"
          description="The funnel is still being tracked — we just couldn't fetch it right now."
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat icon={Users} label="Referral codes" value={data.funnel.codes} />
            <Stat icon={Gift} label="Total referred" value={data.funnel.total} />
            <Stat icon={Clock} label="Pending" value={data.funnel.pending} />
            <Stat icon={Clock} label="Qualified" value={data.funnel.qualified} />
            <Stat icon={CheckCircle2} label="Granted" value={data.funnel.granted} />
          </div>

          {/* US-1071: virality analytics — funnel over time, conversion %, K-factor. */}
          {analytics && (
            <>
              <div>
                <h2 className="mb-3 text-base font-semibold text-foreground">
                  Virality — last {analytics.window_days} days
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    icon={Zap}
                    label="K-factor"
                    value={analytics.k_factor.toFixed(2)}
                    hint={`${analytics.referrers} referrers · >1 self-sustains`}
                  />
                  <Stat
                    icon={TrendingUp}
                    label="Click → signup"
                    value={`${analytics.conversion.click_to_signup}%`}
                    hint={`${analytics.totals.clicks} clicks · ${analytics.totals.signups} signups`}
                  />
                  <Stat
                    icon={TrendingUp}
                    label="Signup → qualified"
                    value={`${analytics.conversion.signup_to_qualified}%`}
                    hint={`${analytics.totals.qualified} qualified`}
                  />
                  <Stat
                    icon={TrendingUp}
                    label="Qualified → granted"
                    value={`${analytics.conversion.qualified_to_granted}%`}
                    hint={`${analytics.totals.granted} granted`}
                  />
                </div>
              </div>

              {analytics.series.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Referral funnel over time</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <AreaChart data={analytics.series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis
                          dataKey="date"
                          tickFormatter={(d: string) => d.slice(5)}
                          fontSize={11}
                          stroke="currentColor"
                          className="text-muted-foreground"
                        />
                        <YAxis allowDecimals={false} fontSize={11} stroke="currentColor" className="text-muted-foreground" />
                        <Tooltip />
                        <Legend />
                        <Area type="monotone" dataKey="clicks" name="Clicks" stroke={CHART_PALETTE.slate} fill={CHART_PALETTE.slate} fillOpacity={0.15} strokeWidth={2} />
                        <Area type="monotone" dataKey="signups" name="Signups" stroke={CHART_PALETTE.navy} fill={CHART_PALETTE.navy} fillOpacity={0.15} strokeWidth={2} />
                        <Area type="monotone" dataKey="qualified" name="Qualified" stroke={CHART_PALETTE.amber} fill={CHART_PALETTE.amber} fillOpacity={0.15} strokeWidth={2} />
                        <Area type="monotone" dataKey="granted" name="Granted" stroke={CHART_PALETTE.red} fill={CHART_PALETTE.red} fillOpacity={0.15} strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}

              {/* Referred-cohort retention/LTV vs direct. The RPC returns null
                  cohorts when there's no data for the window, so guard before
                  dereferencing (US-1071). */}
              {analytics.cohorts?.referred && analytics.cohorts?.direct && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Referred vs direct cohort</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Metric</TableHead>
                        <TableHead className="text-right">Referred</TableHead>
                        <TableHead className="text-right">Direct</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <CohortRow label="Users" referred={analytics.cohorts.referred.users} direct={analytics.cohorts.direct.users} />
                      <CohortRow
                        label="Activated (≥1 grade)"
                        referred={`${analytics.cohorts.referred.activated} (${analytics.cohorts.referred.activation_rate}%)`}
                        direct={`${analytics.cohorts.direct.activated} (${analytics.cohorts.direct.activation_rate}%)`}
                      />
                      <CohortRow
                        label="Paying"
                        referred={`${analytics.cohorts.referred.paying} (${analytics.cohorts.referred.paying_rate}%)`}
                        direct={`${analytics.cohorts.direct.paying} (${analytics.cohorts.direct.paying_rate}%)`}
                      />
                      <CohortRow
                        label="LTV / user"
                        referred={money(analytics.cohorts.referred.ltv_cents)}
                        direct={money(analytics.cohorts.direct.ltv_cents)}
                      />
                    </TableBody>
                  </Table>
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    LTV is gross credit-pack revenue (directional) — subscriptions, refunds, and exact Stripe charges aren't reflected.
                  </p>
                </CardContent>
              </Card>
              )}
            </>
          )}

          {/* US-1071: campaign / promo codes. */}
          <CampaignCodesCard codes={campaign?.codes ?? []} canEdit={isSuperAdmin} />

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Top referrers</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.top_referrers.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No referrals yet.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead className="text-right">Referred</TableHead>
                        <TableHead className="text-right">Granted</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.top_referrers.map((r) => (
                        <TableRow key={r.user_id}>
                          <TableCell className="text-sm">{r.email}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.granted}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Reward queue
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    +{data.rewards.referrer_credits}/+{data.rewards.referred_credits} credits
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.queue.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Nothing awaiting a grant.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Referrer → Referred</TableHead>
                        <TableHead>Status</TableHead>
                        {isSuperAdmin && <TableHead className="text-right">Action</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.queue.map((q) => (
                        <TableRow key={q.id}>
                          <TableCell className="text-xs">
                            <div>{q.referrer_email}</div>
                            <div className="text-muted-foreground">→ {q.referred_email}</div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">{q.reward_status}</Badge>
                          </TableCell>
                          {isSuperAdmin && (
                            <TableCell className="text-right">
                              <Button size="sm" disabled={working} onClick={() => grant(q.id)}>
                              aria-label={`Grant the reward for ${q.referrer_email}`}
                                Grant
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}

function CohortRow({ label, referred, direct }: { label: string; referred: string | number; direct: string | number }) {
  return (
    <TableRow>
      <TableCell className="text-sm font-medium">{label}</TableCell>
      <TableCell className="text-right tabular-nums">{referred}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{direct}</TableCell>
    </TableRow>
  );
}

function CampaignCodesCard({ codes, canEdit }: { codes: CampaignCode[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", description: "", bonus: "3", max: "" });

  const refresh = () => qc.invalidateQueries({ queryKey: ["growth-campaign-codes"] });

  async function create() {
    const code = form.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,32}$/.test(code)) {
      toast.error("Code must be 3–32 letters/numbers.");
      return;
    }
    if (!form.name.trim()) {
      toast.error("Name is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await edgeFetch("/api/admin/growth/campaign-codes", {
        method: "POST",
        json: {
          code,
          name: form.name.trim(),
          description: form.description.trim() || null,
          bonus_referred_credits: Number(form.bonus) || 0,
          max_redemptions: form.max.trim() ? Number(form.max) : null,
        },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Couldn't create the code.");
        return;
      }
      toast.success("Campaign code created.");
      setForm({ code: "", name: "", description: "", bonus: "3", max: "" });
      setOpen(false);
      refresh();
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(c: CampaignCode) {
    const res = await edgeFetch(`/api/admin/growth/campaign-codes/${c.id}`, {
      method: "PATCH",
      json: { is_active: !c.is_active },
      silentGate: true,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? "Couldn't update the code.");
      return;
    }
    refresh();
  }

  async function remove(c: CampaignCode) {
    const res = await edgeFetch(`/api/admin/growth/campaign-codes/${c.id}`, {
      method: "DELETE",
      silentGate: true,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(json.error ?? "Couldn't delete the code.");
      return;
    }
    toast.success("Campaign code deleted.");
    refresh();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Ticket className="h-5 w-5 text-brand-red-text" /> Campaign codes
        </CardTitle>
        {canEdit && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">New code</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New campaign code</DialogTitle>
                <DialogDescription>
                  A named promo code new users redeem for bonus grade credits. Granted immediately on
                  redemption (one per user).
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cc-code">Code</Label>
                  <Input
                    id="cc-code"
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    placeholder="e.g. THRIFT10"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cc-name">Name</Label>
                  <Input
                    id="cc-name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. TikTok launch"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cc-desc">Description (optional)</Label>
                  <Textarea
                    id="cc-desc"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={2}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="cc-bonus">Bonus credits</Label>
                    <Input
                      id="cc-bonus"
                      type="number"
                      min={0}
                      value={form.bonus}
                      onChange={(e) => setForm({ ...form, bonus: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cc-max">Max redemptions</Label>
                    <Input
                      id="cc-max"
                      type="number"
                      min={1}
                      value={form.max}
                      onChange={(e) => setForm({ ...form, max: e.target.value })}
                      placeholder="∞"
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={create} disabled={saving}>
                  {saving ? "Creating…" : "Create code"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {codes.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No campaign codes yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Bonus</TableHead>
                <TableHead className="text-right">Redemptions</TableHead>
                <TableHead>Status</TableHead>
                {canEdit && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-sm font-semibold">{c.code}</TableCell>
                  <TableCell className="text-sm">{c.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.bonus_referred_credits}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.redemption_count}
                    {c.max_redemptions != null && <span className="text-muted-foreground">/{c.max_redemptions}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.is_active ? "default" : "secondary"}>
                      {c.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => toggleActive(c)}>
                          {c.is_active ? "Deactivate" : "Activate"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(c)}>
                          <Trash2 className="h-4 w-4 text-brand-red-text" />
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
  );
}
