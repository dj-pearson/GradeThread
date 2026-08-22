import { useId, useState } from "react";
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
import { AlertTriangle, Clock, CreditCard, DollarSign, Layers, Pencil } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

// US-885: edit the DB-driven grading-tier prices + credit-pack prices
// (pricing_config) and per-plan included-grade entitlements (pricing_plans). The
// full plan editor (caps, gate flags, Stripe price IDs) lives at /admin/pricing;
// this surface focuses on the grade economics that were the last hardcoded maps.

interface GradeTierRow {
  id: string;
  label: string;
  price_cents: number;
  tier_key: string | null;
  credit_cost: number | null;
  sla_hours: number | null;
  stripe_price_ref: string;
}

interface CreditPackRow {
  id: string;
  label: string;
  price_cents: number;
  credits: number | null;
  stripe_price_ref: string;
}

interface PricingConfigResponse {
  grade_tiers: GradeTierRow[];
  credit_packs: CreditPackRow[];
}

interface PlanRow {
  key: "free" | "starter" | "pro" | "business";
  name: string;
  included_standard_grades_per_month: number;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Grade-tier edit dialog ──
function EditTierDialog({
  tier,
  onOpenChange,
  onSubmit,
  pending,
}: {
  tier: GradeTierRow | null;
  onOpenChange: (o: boolean) => void;
  onSubmit: (id: string, payload: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [price, setPrice] = useState("");
  const [creditCost, setCreditCost] = useState("");
  const [sla, setSla] = useState("");
  // US-2335: useId rather than a slug of the label — "Price (USD)" also
  // labels a control in EditPackDialog below, and two identical ids would
  // point the first label at the wrong dialog's input.
  const priceId = useId();
  const creditCostId = useId();
  const slaId = useId();
  const [seededFor, setSeededFor] = useState<string | null>(null);

  if (tier && seededFor !== tier.id) {
    setPrice((tier.price_cents / 100).toString());
    setCreditCost((tier.credit_cost ?? 0).toString());
    setSla((tier.sla_hours ?? 0).toString());
    setSeededFor(tier.id);
  }

  const submit = () => {
    if (!tier) return;
    onSubmit(tier.id, {
      price_cents: Math.round(Number(price) * 100),
      credit_cost: Math.trunc(Number(creditCost)),
      sla_hours: Math.trunc(Number(sla)),
    });
  };

  return (
    <Dialog open={tier != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit grading tier — {tier?.label}</DialogTitle>
          <DialogDescription>
            Display price + credit/SLA math for the{" "}
            <span className="font-mono">{tier?.tier_key}</span> tier. Changes apply
            across the fleet within ~30s — no deploy. Requires a super-admin MFA
            step-up.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={priceId}>Price (USD)</Label>
            <Input id={priceId} type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor={creditCostId}>Credit cost</Label>
              <Input id={creditCostId} type="number" value={creditCost} onChange={(e) => setCreditCost(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={slaId}>SLA (hours)</Label>
              <Input id={slaId} type="number" value={sla} onChange={(e) => setSla(e.target.value)} />
            </div>
          </div>
          {tier?.stripe_price_ref && (
            <p className="text-xs text-muted-foreground">
              Stripe price env var:{" "}
              <span className="font-mono">{tier.stripe_price_ref}</span> (read-only —
              Stripe is the source of truth for the charge amount).
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save tier"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Credit-pack edit dialog ──
function EditPackDialog({
  pack,
  onOpenChange,
  onSubmit,
  pending,
}: {
  pack: CreditPackRow | null;
  onOpenChange: (o: boolean) => void;
  onSubmit: (id: string, payload: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [price, setPrice] = useState("");
  const [credits, setCredits] = useState("");
  const creditsId = useId();
  const packPriceId = useId();
  const [seededFor, setSeededFor] = useState<string | null>(null);

  if (pack && seededFor !== pack.id) {
    setPrice((pack.price_cents / 100).toString());
    setCredits((pack.credits ?? 0).toString());
    setSeededFor(pack.id);
  }

  const submit = () => {
    if (!pack) return;
    onSubmit(pack.id, {
      price_cents: Math.round(Number(price) * 100),
      credits: Math.trunc(Number(credits)),
    });
  };

  return (
    <Dialog open={pack != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit credit pack — {pack?.label}</DialogTitle>
          <DialogDescription>
            Display price + credit count. Changes apply across the fleet within
            ~30s. Requires a super-admin MFA step-up.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor={creditsId}>Credits</Label>
            <Input id={creditsId} type="number" value={credits} onChange={(e) => setCredits(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={packPriceId}>Price (USD)</Label>
            <Input id={packPriceId} type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
        </div>
        {pack?.stripe_price_ref && (
          <p className="text-xs text-muted-foreground">
            Stripe price env var:{" "}
            <span className="font-mono">{pack.stripe_price_ref}</span> (read-only).
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save pack"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Included-grades quick editor ──
function EditIncludedDialog({
  plan,
  onOpenChange,
  onSubmit,
  pending,
}: {
  plan: PlanRow | null;
  onOpenChange: (o: boolean) => void;
  onSubmit: (key: string, payload: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [grades, setGrades] = useState("");
  const gradesId = useId();
  const [seededFor, setSeededFor] = useState<string | null>(null);

  if (plan && seededFor !== plan.key) {
    setGrades(plan.included_standard_grades_per_month.toString());
    setSeededFor(plan.key);
  }

  const submit = () => {
    if (!plan) return;
    onSubmit(plan.key, {
      included_standard_grades_per_month: Math.trunc(Number(grades)),
    });
  };

  return (
    <Dialog open={plan != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Included grades — {plan?.name}</DialogTitle>
          <DialogDescription>
            Standard grades included per billing period on the{" "}
            <span className="font-mono">{plan?.key}</span> plan. A change takes
            effect on each user's <strong>next billing-period reset</strong> — it
            never retroactively grants or revokes grades in a period already in
            progress. Requires a super-admin MFA step-up.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={gradesId}>Included Standard grades / period</Label>
          <Input id={gradesId} type="number" value={grades} onChange={(e) => setGrades(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminConfigPricingPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [editTier, setEditTier] = useState<GradeTierRow | null>(null);
  const [editPack, setEditPack] = useState<CreditPackRow | null>(null);
  const [editPlan, setEditPlan] = useState<PlanRow | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const pricing = useQuery({
    queryKey: ["admin-config-pricing"],
    queryFn: async (): Promise<PricingConfigResponse> => {
      const res = await edgeFetch("/api/admin/config/pricing");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load pricing config.");
      return json;
    },
    staleTime: 60_000,
  });

  const plans = useQuery({
    queryKey: ["admin-config-plans"],
    queryFn: async (): Promise<{ plans: PlanRow[] }> => {
      const res = await edgeFetch("/api/admin/config/plans");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load plans.");
      return json;
    },
    staleTime: 60_000,
  });

  // Step-up-aware runner (mirrors AdminPricingPage).
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

  const savePricing = (id: string, payload: Record<string, unknown>, onDone: () => void) =>
    run(
      () =>
        edgeFetch(`/api/admin/config/pricing/${encodeURIComponent(id)}`, {
          method: "PUT",
          json: payload,
          silentGate: true,
        }),
      () => {
        toast.success("Pricing updated");
        onDone();
        qc.invalidateQueries({ queryKey: ["admin-config-pricing"] });
      },
    );

  const savePlanIncluded = (key: string, payload: Record<string, unknown>) =>
    run(
      () =>
        edgeFetch(`/api/admin/config/plans/${key}`, {
          method: "PUT",
          json: payload,
          silentGate: true,
        }),
      () => {
        toast.success("Plan updated");
        setEditPlan(null);
        qc.invalidateQueries({ queryKey: ["admin-config-plans"] });
        qc.invalidateQueries({ queryKey: ["admin-pricing-plans"] });
        qc.invalidateQueries({ queryKey: ["pricing-plans"] });
      },
    );

  const loadError = pricing.error || plans.error;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Grading &amp; Credit Prices"
        subtitle={
          <>
            Grading-tier prices, credit-pack prices, and per-plan included grades.
            {isSuperAdmin
              ? " Edits apply live — no deploy."
              : " Read-only for your role (super-admin required to edit)."}
          </>
        }
      />

      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          These are <strong>display &amp; entitlement values</strong>. Stripe is the
          source of truth for the actual amount charged — editing a price here
          updates what customers see and the included/credit math, <em>not</em> the
          Stripe price object. Keep them in sync with Stripe (the linked env-var
          price IDs are shown per row and are not editable here).
        </span>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="h-4 w-4" />
          {(loadError as Error).message}
        </div>
      )}

      {/* Grading tiers */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Grading tiers
          </CardTitle>
          <CardDescription>
            Per-grade price, the credits one grade consumes, and the turnaround SLA.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {pricing.isLoading ? (
            <div className="p-6"><Skeleton className="h-32 w-full" /></div>
          ) : !pricing.data || pricing.data.grade_tiers.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No grading tiers configured.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Credit cost</TableHead>
                  <TableHead><Clock className="inline h-3.5 w-3.5" /> SLA</TableHead>
                  {isSuperAdmin && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pricing.data.grade_tiers.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.label}</TableCell>
                    <TableCell className="tabular-nums">{dollars(t.price_cents)}</TableCell>
                    <TableCell className="tabular-nums">{t.credit_cost}</TableCell>
                    <TableCell className="tabular-nums">{t.sla_hours}h</TableCell>
                    {isSuperAdmin && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" disabled={working} onClick={() => setEditTier(t)} aria-label={`Edit the ${t.label} grading tier`} title="Edit tier">
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

      {/* Credit packs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Credit packs
          </CardTitle>
          <CardDescription>One-time credit bundles. 1 credit = 1 Standard grade.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {pricing.isLoading ? (
            <div className="p-6"><Skeleton className="h-32 w-full" /></div>
          ) : !pricing.data || pricing.data.credit_packs.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No credit packs configured.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pack</TableHead>
                  <TableHead>Credits</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Per credit</TableHead>
                  {isSuperAdmin && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pricing.data.credit_packs.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.label}</TableCell>
                    <TableCell className="tabular-nums">{p.credits}</TableCell>
                    <TableCell className="tabular-nums">{dollars(p.price_cents)}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {p.credits ? dollars(Math.round(p.price_cents / p.credits)) : "—"}
                    </TableCell>
                    {isSuperAdmin && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" disabled={working} onClick={() => setEditPack(p)} aria-label={`Edit the ${p.label} credit pack`} title="Edit pack">
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

      {/* Plan included grades */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            Included grades per plan
          </CardTitle>
          <CardDescription>
            Standard grades included each billing period. Changes take effect on the
            next period reset, not retroactively. Full plan config (caps, feature
            gates, Stripe IDs) lives under <span className="font-mono">Plans &amp; Pricing</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {plans.isLoading ? (
            <div className="p-6"><Skeleton className="h-32 w-full" /></div>
          ) : !plans.data || plans.data.plans.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No plans configured.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Included grades / period</TableHead>
                  {isSuperAdmin && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.data.plans.map((p) => (
                  <TableRow key={p.key}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{p.key}</div>
                    </TableCell>
                    <TableCell className="tabular-nums">{p.included_standard_grades_per_month}</TableCell>
                    {isSuperAdmin && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" disabled={working} onClick={() => setEditPlan(p)} aria-label={`Edit the grades included with ${p.name}`} title="Edit included grades">
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
        <>
          <EditTierDialog
            tier={editTier}
            onOpenChange={(o) => { if (!o) setEditTier(null); }}
            onSubmit={(id, payload) => savePricing(id, payload, () => setEditTier(null))}
            pending={working}
          />
          <EditPackDialog
            pack={editPack}
            onOpenChange={(o) => { if (!o) setEditPack(null); }}
            onSubmit={(id, payload) => savePricing(id, payload, () => setEditPack(null))}
            pending={working}
          />
          <EditIncludedDialog
            plan={editPlan}
            onOpenChange={(o) => { if (!o) setEditPlan(null); }}
            onSubmit={savePlanIncluded}
            pending={working}
          />
        </>
      )}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => retry?.()}
      />
    </div>
  );
}
