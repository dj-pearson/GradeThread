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
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
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
import { AlertTriangle, DollarSign, Pencil } from "lucide-react";

// Mirrors GATE_FLAG_KEYS in services/edge-functions/src/lib/pricing-config.ts.
const GATE_FLAGS: { key: string; label: string }[] = [
  { key: "bulkActions", label: "Bulk actions" },
  { key: "scheduledActions", label: "Scheduled actions" },
  { key: "compPulls", label: "AI comp pulls" },
  { key: "autoRelist", label: "Auto-relist" },
  { key: "subAccounts", label: "Sub-accounts" },
  { key: "apiAccess", label: "Programmatic API" },
  { key: "reconciliation", label: "Payout reconciliation" },
  { key: "prioritySupport", label: "Priority support" },
  { key: "autolister", label: "AutoLister" },
];

interface AdminPricingPlan {
  key: "free" | "starter" | "pro" | "business";
  name: string;
  sort_order: number;
  price_monthly_cents: number;
  price_yearly_cents: number;
  active_listing_cap: number;
  ai_actions_per_month: number;
  marketplaces_cap: number;
  included_standard_grades_per_month: number;
  team_seat_cap: number;
  features: string[];
  gate_flags: Record<string, boolean>;
  stripe_price_monthly: string;
  stripe_price_yearly: string;
  updated_at: string;
  updated_by: string | null;
}

function dollars(cents: number): string {
  return cents === 0 ? "Free" : `$${(cents / 100).toFixed(2)}`;
}

function capLabel(n: number): string {
  return n === -1 ? "Unlimited" : n.toLocaleString();
}

// Edit dialog — full plan config. Prices entered in dollars, sent as cents.
function EditPlanDialog({
  plan,
  onOpenChange,
  onSubmit,
  pending,
}: {
  plan: AdminPricingPlan | null;
  onOpenChange: (o: boolean) => void;
  onSubmit: (key: string, payload: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  const [priceMonthly, setPriceMonthly] = useState("");
  const [priceYearly, setPriceYearly] = useState("");
  const [listingCap, setListingCap] = useState("");
  const [aiActions, setAiActions] = useState("");
  const [marketplaces, setMarketplaces] = useState("");
  const [grades, setGrades] = useState("");
  const [teamSeats, setTeamSeats] = useState("");
  const [features, setFeatures] = useState("");
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [priceIdMonthly, setPriceIdMonthly] = useState("");
  const [priceIdYearly, setPriceIdYearly] = useState("");
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Re-seed the form each time a different plan is opened.
  if (plan && seededFor !== plan.key) {
    setName(plan.name);
    setPriceMonthly((plan.price_monthly_cents / 100).toString());
    setPriceYearly((plan.price_yearly_cents / 100).toString());
    setListingCap(plan.active_listing_cap.toString());
    setAiActions(plan.ai_actions_per_month.toString());
    setMarketplaces(plan.marketplaces_cap.toString());
    setGrades(plan.included_standard_grades_per_month.toString());
    setTeamSeats(plan.team_seat_cap.toString());
    setFeatures(plan.features.join("\n"));
    setFlags({ ...plan.gate_flags });
    setPriceIdMonthly(plan.stripe_price_monthly);
    setPriceIdYearly(plan.stripe_price_yearly);
    setSeededFor(plan.key);
  }

  const submit = () => {
    if (!plan) return;
    const gate_flags: Record<string, boolean> = {};
    for (const { key } of GATE_FLAGS) gate_flags[key] = flags[key] === true;
    const payload: Record<string, unknown> = {
      name: name.trim(),
      price_monthly_cents: Math.round(Number(priceMonthly) * 100),
      price_yearly_cents: Math.round(Number(priceYearly) * 100),
      active_listing_cap: Math.trunc(Number(listingCap)),
      ai_actions_per_month: Math.trunc(Number(aiActions)),
      marketplaces_cap: Math.trunc(Number(marketplaces)),
      included_standard_grades_per_month: Math.trunc(Number(grades)),
      team_seat_cap: Math.trunc(Number(teamSeats)),
      features: features.split("\n").map((f) => f.trim()).filter(Boolean),
      gate_flags,
      stripe_price_monthly: priceIdMonthly.trim(),
      stripe_price_yearly: priceIdYearly.trim(),
    };
    onSubmit(plan.key, payload);
  };

  return (
    <Dialog open={plan != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit plan — {plan?.name}</DialogTitle>
          <DialogDescription>
            Live pricing &amp; limits for the <span className="font-mono">{plan?.key}</span>{" "}
            tier. Changes take effect across the fleet within ~30s — no deploy. Use
            -1 for unlimited listings / all marketplaces. Requires a super-admin MFA
            step-up.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Display name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Monthly price (USD)</Label>
              <Input type="number" value={priceMonthly} onChange={(e) => setPriceMonthly(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Yearly price (USD)</Label>
              <Input type="number" value={priceYearly} onChange={(e) => setPriceYearly(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Active listing cap</Label>
              <Input type="number" value={listingCap} onChange={(e) => setListingCap(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>AI actions / mo</Label>
              <Input type="number" value={aiActions} onChange={(e) => setAiActions(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Marketplaces cap</Label>
              <Input type="number" value={marketplaces} onChange={(e) => setMarketplaces(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Included grades / mo</Label>
              <Input type="number" value={grades} onChange={(e) => setGrades(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Team seats</Label>
              <Input type="number" value={teamSeats} onChange={(e) => setTeamSeats(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Feature bullets (one per line)</Label>
            <textarea
              className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              value={features}
              onChange={(e) => setFeatures(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Feature gates</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {GATE_FLAGS.map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span className="text-sm">{label}</span>
                  <Switch
                    checked={flags[key] === true}
                    onCheckedChange={(v) => setFlags((f) => ({ ...f, [key]: v }))}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Stripe price ID — monthly</Label>
              <Input
                value={priceIdMonthly}
                onChange={(e) => setPriceIdMonthly(e.target.value)}
                placeholder="(env fallback if empty)"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label>Stripe price ID — yearly</Label>
              <Input
                value={priceIdYearly}
                onChange={(e) => setPriceIdYearly(e.target.value)}
                placeholder="(env fallback if empty)"
                className="font-mono text-xs"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminPricingPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";
  const [editPlan, setEditPlan] = useState<AdminPricingPlan | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-pricing-plans"],
    queryFn: async (): Promise<{ plans: AdminPricingPlan[] }> => {
      const res = await edgeFetch("/api/admin/pricing/plans");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load pricing plans.");
      return json;
    },
    staleTime: 60_000,
  });

  // Step-up-aware runner: on STEP_UP_REQUIRED it stashes the retry + opens the
  // authenticator dialog (mirrors AdminCouponsPage).
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

  const savePlan = (key: string, payload: Record<string, unknown>) =>
    run(
      () =>
        edgeFetch(`/api/admin/pricing/plans/${key}`, {
          method: "PUT",
          json: payload,
          silentGate: true,
        }),
      () => {
        toast.success("Plan updated");
        setEditPlan(null);
        qc.invalidateQueries({ queryKey: ["admin-pricing-plans"] });
        // Refresh the user-facing pricing surfaces too.
        qc.invalidateQueries({ queryKey: ["pricing-plans"] });
      },
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Plans & Pricing"
        subtitle={
          <>
            FlipDesk plan prices, limits, feature gates, and Stripe price IDs.
            {isSuperAdmin
              ? " Edits apply live — no deploy."
              : " Read-only for your role (super-admin required to edit)."}
          </>
        }
      />

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="h-4 w-4" />
          {(error as Error).message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            FlipDesk plans
          </CardTitle>
          <CardDescription>
            Limits enforced by the edge plan-gate; prices used at checkout. Empty
            Stripe price IDs fall back to the environment variables.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-40 w-full" />
            </div>
          ) : !data || data.plans.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No pricing plans configured.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Monthly</TableHead>
                  <TableHead>Yearly</TableHead>
                  <TableHead>Listings</TableHead>
                  <TableHead>AI / mo</TableHead>
                  <TableHead>Grades / mo</TableHead>
                  <TableHead>Seats</TableHead>
                  {isSuperAdmin && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.plans.map((p) => (
                  <TableRow key={p.key}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{p.key}</div>
                    </TableCell>
                    <TableCell className="tabular-nums">{dollars(p.price_monthly_cents)}</TableCell>
                    <TableCell className="tabular-nums">{dollars(p.price_yearly_cents)}</TableCell>
                    <TableCell className="tabular-nums">{capLabel(p.active_listing_cap)}</TableCell>
                    <TableCell className="tabular-nums">{capLabel(p.ai_actions_per_month)}</TableCell>
                    <TableCell className="tabular-nums">{p.included_standard_grades_per_month}</TableCell>
                    <TableCell className="tabular-nums">{p.team_seat_cap}</TableCell>
                    {isSuperAdmin && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={working}
                          onClick={() => setEditPlan(p)}
                          title="Edit plan"
                        >
                          <Pencil className="h-3.5 w-3.5" />
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

      {isSuperAdmin && (
        <EditPlanDialog
          plan={editPlan}
          onOpenChange={(o) => { if (!o) setEditPlan(null); }}
          onSubmit={savePlan}
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
