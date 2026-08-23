import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  Gift,
  Loader2,
  Pause,
  Play,
  Plus,
  Save,
  Send,
  Sparkles,
  Trash2,
  Users,
  XCircle,
  GitBranch,
} from "lucide-react";

// US-945: Visual drip / journey builder. Mirrors the edge drip-graph types
// (services/edge-functions/src/lib/drip-graph.ts) — the SPA can't import edge
// (Deno) code, so the shape is duplicated, same as drip-analytics.tsx mirrors
// the analytics RPC payload.

type DripPhase = "in_trial" | "win_back";
type DripAnchor = "enrollment" | "previous" | "trial_end";

interface DripCondition {
  field: string;
  op: string;
  value?: string | number | boolean | null;
}
interface DripVariant {
  id: string;
  weight: number;
  subject: string;
  html: string;
}
interface DripBranch {
  conditions: DripCondition[];
  targetStepId: string;
}
interface DripStep {
  id: string;
  label: string;
  phase: DripPhase;
  trigger: string;
  anchor: DripAnchor;
  delayHours: number;
  conditions: DripCondition[];
  brief: string;
  incentiveEnabled: boolean;
  branches: DripBranch[];
  next: string | null;
  exit: boolean;
  variants: DripVariant[];
}
// US-942: campaign-level conversion incentive (off by default). Mirrors
// DripIncentive in services/edge-functions/src/lib/drip-graph.ts.
interface DripIncentive {
  enabled: boolean;
  couponId: string;
  promoCode: string;
  maxPercentOff: number;
  expiryHours: number;
}
interface DripGraph {
  entryStepId: string | null;
  steps: DripStep[];
  autotuneEnabled?: boolean;
  incentive?: DripIncentive;
}

// US-944: optimizer payload (mirrors services/edge-functions/src/lib/drip-optimizer.ts).
interface VariantScore {
  variantId: string;
  sent: number;
  openRate: number;
  clickRate: number;
  conversionRate: number;
  unsubRate: number;
  trusted: boolean;
  retired: boolean;
  isWinner: boolean;
  weight: number;
}
interface StepOptimization {
  stepId: string;
  label: string;
  ordinal: number;
  changed: boolean;
  totalSent: number;
  hasEnoughData: boolean;
  winnerId: string | null;
  scores: VariantScore[];
  recommendedWeights: Record<string, number>;
}
interface OptimizerResponse {
  autotuneEnabled: boolean;
  config: { minSample: number; explorationFloor: number; unsubRetireRate: number };
  optimizations: StepOptimization[];
  changedSteps: number;
}
interface CampaignRow {
  campaign: string;
  name: string;
  status: "active" | "paused" | "killed";
  feature_flag_key: string | null;
  graph: DripGraph;
  updated_at: string;
}

interface SimulatedSend {
  stepId: string;
  label: string;
  phase: DripPhase;
  variantId: string;
  scheduledAt: string;
  willSend: boolean;
  reason: string;
}

const ANCHOR_LABEL: Record<DripAnchor, string> = {
  enrollment: "after enrollment",
  previous: "after previous step",
  trial_end: "relative to trial end",
};

function describeDelay(step: DripStep): string {
  const hrs = step.delayHours;
  const abs = Math.abs(hrs);
  const unit = abs % 24 === 0 ? `${abs / 24}d` : `${abs}h`;
  if (hrs === 0) return `immediately ${ANCHOR_LABEL[step.anchor]}`;
  const dir = hrs < 0 ? "before" : "after";
  if (step.anchor === "trial_end") return `${unit} ${dir} trial end`;
  return `${unit} ${ANCHOR_LABEL[step.anchor]}`;
}

export function AdminDripBuilderPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [campaign] = useState("trial_conversion");
  const [draft, setDraft] = useState<DripGraph | null>(null);
  const [dirty, setDirty] = useState(false);

  // Step-up handling (mirrors AdminFeatureFlagsPage.run).
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const detail = useQuery({
    queryKey: ["admin-drip-campaign", campaign],
    queryFn: async (): Promise<{ campaign: CampaignRow; nextTick: string }> => {
      const res = await edgeFetch(`/api/admin/drip/campaigns/${campaign}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load campaign.");
      return json;
    },
    staleTime: 30_000,
  });

  const enrollments = useQuery({
    queryKey: ["admin-drip-enrollments", campaign],
    queryFn: async () => {
      const res = await edgeFetch(`/api/admin/drip/campaigns/${campaign}/enrollments`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load enrollments.");
      return json as {
        activeEnrollments: number;
        byStep: Record<string, number>;
        recentExits: Array<{
          user_id: string;
          exited_at: string;
          exit_reason: string | null;
          converted_at: string | null;
        }>;
      };
    },
    staleTime: 20_000,
  });

  const optimizer = useQuery({
    queryKey: ["admin-drip-optimizer", campaign],
    queryFn: async (): Promise<OptimizerResponse> => {
      const res = await edgeFetch(`/api/admin/drip/campaigns/${campaign}/optimizer`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load optimizer.");
      return json as OptimizerResponse;
    },
    staleTime: 30_000,
  });

  function applyOptimizer(opts: { autotuneEnabled?: boolean; applyWeights?: boolean }) {
    run(
      () =>
        edgeFetch(`/api/admin/drip/campaigns/${campaign}/optimizer/apply`, {
          method: "POST",
          json: opts,
          silentGate: true,
        }),
      () => {
        toast.success(
          opts.applyWeights === false
            ? "Autotune setting updated."
            : "Optimizer applied — weights re-tuned toward winners.",
        );
        setDirty(false);
        qc.invalidateQueries({ queryKey: ["admin-drip-campaign", campaign] });
        qc.invalidateQueries({ queryKey: ["admin-drip-optimizer", campaign] });
      },
    );
  }

  // Seed the editable draft once the campaign loads (and not while dirty).
  useEffect(() => {
    if (detail.data && !dirty) {
      setDraft(structuredClone(detail.data.campaign.graph));
    }
  }, [detail.data, dirty]);

  const status = detail.data?.campaign.status;

  async function run(doFetch: () => Promise<Response>, onOk: (json: unknown) => void) {
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
        if ((j as { code?: string })?.code === "GRAPH_INVALID") {
          setValidationErrors((j as { errors?: string[] }).errors ?? []);
          toast.error("Graph is invalid — fix the listed problems.");
          return;
        }
        toast.error((j as { error?: string }).error ?? "Request failed");
        return;
      }
      onOk(j);
    } finally {
      setWorking(false);
    }
  }

  // US-942: edit the campaign-level incentive config. Persisted by saveGraph
  // (PUT graph) like any other graph change — super-admin + step-up + audited.
  function patchIncentive(patch: Partial<DripIncentive>) {
    setDirty(true);
    setDraft((g) => {
      if (!g) return g;
      const current: DripIncentive = g.incentive ?? {
        enabled: false,
        couponId: "",
        promoCode: "",
        maxPercentOff: 25,
        expiryHours: 168,
      };
      return { ...g, incentive: { ...current, ...patch } };
    });
  }

  function patchStep(stepId: string, patch: Partial<DripStep>) {
    setDirty(true);
    setDraft((g) =>
      g
        ? { ...g, steps: g.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) }
        : g,
    );
  }

  function patchVariant(stepId: string, variantId: string, patch: Partial<DripVariant>) {
    setDirty(true);
    setDraft((g) =>
      g
        ? {
            ...g,
            steps: g.steps.map((s) =>
              s.id === stepId
                ? {
                    ...s,
                    variants: s.variants.map((v) =>
                      v.id === variantId ? { ...v, ...patch } : v,
                    ),
                  }
                : s,
            ),
          }
        : g,
    );
  }

  function addVariant(stepId: string) {
    setDirty(true);
    setDraft((g) =>
      g
        ? {
            ...g,
            steps: g.steps.map((s) => {
              if (s.id !== stepId) return s;
              const next = String.fromCharCode(65 + s.variants.length); // A, B, C…
              return {
                ...s,
                variants: [
                  ...s.variants,
                  { id: next, weight: 0, subject: "", html: "<p></p>" },
                ],
              };
            }),
          }
        : g,
    );
  }

  function removeVariant(stepId: string, variantId: string) {
    setDirty(true);
    setDraft((g) =>
      g
        ? {
            ...g,
            steps: g.steps.map((s) =>
              s.id === stepId && s.variants.length > 1
                ? { ...s, variants: s.variants.filter((v) => v.id !== variantId) }
                : s,
            ),
          }
        : g,
    );
  }

  function saveGraph() {
    if (!draft) return;
    setValidationErrors([]);
    run(
      () =>
        edgeFetch(`/api/admin/drip/campaigns/${campaign}/graph`, {
          method: "PUT",
          json: { graph: draft },
          silentGate: true,
        }),
      () => {
        toast.success("Drip graph saved.");
        setDirty(false);
        qc.invalidateQueries({ queryKey: ["admin-drip-campaign", campaign] });
      },
    );
  }

  function changeStatus(action: "pause" | "resume" | "kill") {
    run(
      () =>
        edgeFetch(`/api/admin/drip/campaigns/${campaign}/status`, {
          method: "POST",
          json: { action },
          silentGate: true,
        }),
      () => {
        toast.success(`Campaign ${action === "resume" ? "resumed" : action === "pause" ? "paused" : "killed"}.`);
        qc.invalidateQueries({ queryKey: ["admin-drip-campaign", campaign] });
      },
    );
  }

  if (detail.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (detail.error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
        <AlertTriangle className="h-4 w-4" />
        {(detail.error as Error).message}
      </div>
    );
  }

  const c = detail.data!.campaign;

  return (
    <div className="space-y-6">
      <PageHeader
        title={c.name}
        subtitle={
          <>
            Visual drip / journey builder — steps, triggers, delays, branches,
            per-step copy &amp; variants, with preview, test-send, and a
            pause/kill switch.
          </>
        }
        actions={
          <>
            <StatusBadge status={c.status} />
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" /> next tick{" "}
              {new Date(detail.data!.nextTick).toLocaleString()}
            </span>
          </>
        }
      />

      {/* Campaign controls — destructive, super-admin + step-up gated server-side. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Campaign controls</CardTitle>
          <CardDescription>
            Pause holds all sends; kill hard-stops the engine and flips the
            linked feature flag off. {isSuperAdmin
              ? "Changes need a fresh authenticator confirmation."
              : "Status changes require super-admin."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!isSuperAdmin || working || status === "active"}
            onClick={() => changeStatus("resume")}
          >
            <Play className="h-4 w-4" /> Resume
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!isSuperAdmin || working || status !== "active"}
            onClick={() => changeStatus("pause")}
          >
            <Pause className="h-4 w-4" /> Pause
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!isSuperAdmin || working || status === "killed"}
            onClick={async () => {
              const ok = await confirm({
                title: "Kill this campaign?",
                description:
                  "This stops ALL sends and disables the linked feature flag.",
                confirmLabel: "Kill campaign",
                destructive: true,
              });
              if (ok) changeStatus("kill");
            }}
          >
            <XCircle className="h-4 w-4" /> Kill
          </Button>
        </CardContent>
      </Card>

      {validationErrors.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" /> Graph validation failed
          </div>
          <ul className="list-inside list-disc space-y-0.5">
            {validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <LiveEnrollments
        campaign={campaign}
        steps={draft?.steps ?? c.graph.steps}
        data={enrollments.data}
        loading={enrollments.isLoading}
      />

      <Simulator campaign={campaign} />

      <OptimizerPanel
        data={optimizer.data}
        loading={optimizer.isLoading}
        error={optimizer.error as Error | null}
        isSuperAdmin={isSuperAdmin}
        working={working}
        onApply={applyOptimizer}
      />

      <IncentivePanel
        incentive={draft?.incentive}
        disabled={!isSuperAdmin}
        onPatch={patchIncentive}
      />

      {/* Step graph */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Journey ({draft?.steps.length ?? 0} steps)
          </h2>
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
            <Button
              size="sm"
              disabled={!isSuperAdmin || working || !dirty}
              onClick={saveGraph}
            >
              {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save graph
            </Button>
          </div>
        </div>

        {(draft?.steps ?? []).map((step) => (
          <StepCard
            key={step.id}
            step={step}
            isEntry={draft?.entryStepId === step.id}
            campaign={campaign}
            incentive={draft?.incentive}
            disabled={!isSuperAdmin}
            onPatch={(patch) => patchStep(step.id, patch)}
            onPatchVariant={(vid, patch) => patchVariant(step.id, vid, patch)}
            onAddVariant={() => addVariant(step.id)}
            onRemoveVariant={(vid) => removeVariant(step.id, vid)}
          />
        ))}
      </div>

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const r = retry;
          setRetry(null);
          if (r) r();
        }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: CampaignRow["status"] }) {
  if (status === "active") {
    return <Badge className="bg-green-600 hover:bg-green-600">Active</Badge>;
  }
  if (status === "paused") {
    return <Badge variant="secondary">Paused</Badge>;
  }
  return <Badge variant="destructive">Killed</Badge>;
}

function StepCard({
  step,
  isEntry,
  campaign,
  incentive,
  disabled,
  onPatch,
  onPatchVariant,
  onAddVariant,
  onRemoveVariant,
}: {
  step: DripStep;
  isEntry: boolean;
  campaign: string;
  incentive?: DripIncentive;
  disabled: boolean;
  onPatch: (patch: Partial<DripStep>) => void;
  onPatchVariant: (variantId: string, patch: Partial<DripVariant>) => void;
  onAddVariant: () => void;
  onRemoveVariant: (variantId: string) => void;
}) {
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [busyVariant, setBusyVariant] = useState<string | null>(null);

  async function doPreview(variantId: string) {
    setPreviewing(true);
    try {
      const res = await edgeFetch(`/api/admin/drip/campaigns/${campaign}/preview`, {
        method: "POST",
        json: { step, variantId, incentive },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Preview failed");
        return;
      }
      setPreview(json);
    } finally {
      setPreviewing(false);
    }
  }

  async function doTestSend(variantId: string) {
    if (!testTo.trim()) {
      toast.error("Enter a recipient email first.");
      return;
    }
    setBusyVariant(variantId);
    try {
      const res = await edgeFetch(`/api/admin/drip/campaigns/${campaign}/test-send`, {
        method: "POST",
        json: { step, variantId, to: testTo.trim(), incentive },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Test send failed");
        return;
      }
      toast.success(`Test sent to ${testTo.trim()}`);
    } finally {
      setBusyVariant(null);
    }
  }

  async function doRegenerate(variantId: string) {
    setBusyVariant(variantId);
    try {
      const res = await edgeFetch(`/api/admin/drip/campaigns/${campaign}/regenerate`, {
        method: "POST",
        json: { brief: step.brief, incentiveEnabled: step.incentiveEnabled },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Copy generation failed");
        return;
      }
      onPatchVariant(variantId, { subject: json.subject, html: json.html });
      toast.success("Copy regenerated — review and save.");
    } finally {
      setBusyVariant(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {isEntry && <Badge variant="outline">entry</Badge>}
            {step.label}
            {step.exit && <Badge variant="secondary">exit</Badge>}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={step.phase === "in_trial" ? "default" : "secondary"}>
              {step.phase === "in_trial" ? "in trial" : "win-back"}
            </Badge>
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span><strong>trigger:</strong> {step.trigger}</span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" /> {describeDelay(step)}
          </span>
          {step.conditions.length > 0 && (
            <span>
              <strong>if:</strong>{" "}
              {step.conditions.map((c) => `${c.field} ${c.op}${c.value !== undefined ? ` ${c.value}` : ""}`).join(", ")}
            </span>
          )}
          {step.branches.length > 0 && (
            <span className="flex items-center gap-1">
              <GitBranch className="h-3.5 w-3.5" />
              {step.branches.map((b) => `→ ${b.targetStepId}`).join(", ")}
            </span>
          )}
          <span><strong>then:</strong> {step.exit ? "exit" : `→ ${step.next ?? "exit"}`}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <Label htmlFor="d-brief-drives-ai-copy" className="text-xs">Brief (drives AI copy)</Label>
            <Textarea id="d-brief-drives-ai-copy"
              value={step.brief}
              disabled={disabled}
              rows={2}
              onChange={(e) => onPatch({ brief: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={step.incentiveEnabled}
              disabled={disabled}
              onCheckedChange={(v) => onPatch({ incentiveEnabled: v })}
              id={`incentive-${step.id}`}
            />
            <Label htmlFor={`incentive-${step.id}`} className="text-xs">
              Incentive
            </Label>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Label htmlFor="d-delay-hours-from-anchor" className="text-xs">Delay (hours from anchor)</Label>
          <Input id="d-delay-hours-from-anchor"
            type="number"
            className="h-8 w-28"
            disabled={disabled}
            value={step.delayHours}
            onChange={(e) => onPatch({ delayHours: Number(e.target.value) })}
          />
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Variants ({step.variants.length})</span>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={onAddVariant}>
              <Plus className="h-4 w-4" /> Add variant
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="Test recipient email"
              placeholder="test recipient email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              className="h-8 max-w-xs"
            />
          </div>

          {step.variants.map((v) => (
            <div key={v.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Badge variant="outline">variant {v.id}</Badge>
                <div className="flex items-center gap-2">
                  <Label htmlFor="d-weight" className="text-xs">weight</Label>
                  <Input id="d-weight"
                    type="number"
                    className="h-7 w-20"
                    disabled={disabled}
                    value={v.weight}
                    onChange={(e) => onPatchVariant(v.id, { weight: Number(e.target.value) })}
                  />
                  {step.variants.length > 1 && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Remove variant ${v.id}`}
                      disabled={disabled}
                      onClick={() => onRemoveVariant(v.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              <div>
                <Label htmlFor="d-subject" className="text-xs">Subject</Label>
                <Input id="d-subject"
                  value={v.subject}
                  disabled={disabled}
                  onChange={(e) => onPatchVariant(v.id, { subject: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="d-html-body" className="text-xs">HTML body</Label>
                <Textarea id="d-html-body"
                  value={v.html}
                  disabled={disabled}
                  rows={4}
                  className="font-mono text-xs"
                  onChange={(e) => onPatchVariant(v.id, { html: e.target.value })}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={previewing} onClick={() => doPreview(v.id)}>
                  <Eye className="h-4 w-4" /> Preview
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyVariant === v.id}
                  onClick={() => doTestSend(v.id)}
                >
                  {busyVariant === v.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Test send
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || busyVariant === v.id}
                  onClick={() => doRegenerate(v.id)}
                >
                  <Sparkles className="h-4 w-4" /> Regenerate
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview?.subject}</DialogTitle>
            <DialogDescription>Rendered preview (sample personalization).</DialogDescription>
          </DialogHeader>
          <iframe
            title="email-preview"
            className="h-96 w-full rounded border bg-white"
            srcDoc={preview?.html ?? ""}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function LiveEnrollments({
  campaign,
  steps,
  data,
  loading,
}: {
  campaign: string;
  steps: DripStep[];
  data?: {
    activeEnrollments: number;
    byStep: Record<string, number>;
    recentExits: Array<{
      user_id: string;
      exited_at: string;
      exit_reason: string | null;
      converted_at: string | null;
    }>;
  };
  loading: boolean;
}) {
  const [drillUser, setDrillUser] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" /> Live enrollments
        </CardTitle>
        <CardDescription>
          Current active enrollments by step and recent exits. Click a user to
          drill into their journey + send history.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="text-sm">
              <strong>{data?.activeEnrollments ?? 0}</strong> active enrollments
            </div>
            <div className="flex flex-wrap gap-2">
              {steps.map((s, i) => (
                <div key={s.id} className="rounded-md border px-3 py-1.5 text-sm">
                  <span className="text-muted-foreground">{i + 1}. {s.label}</span>{" "}
                  <strong>{data?.byStep?.[String(i + 1)] ?? 0}</strong>
                </div>
              ))}
              <div className="rounded-md border px-3 py-1.5 text-sm">
                <span className="text-muted-foreground">enrolled, not yet sent</span>{" "}
                <strong>{data?.byStep?.["0"] ?? 0}</strong>
              </div>
            </div>

            <div>
              <div className="mb-1 text-sm font-medium">Recent exits</div>
              {(data?.recentExits ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No exits yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {data!.recentExits.map((e) => (
                    <li key={`${e.user_id}-${e.exited_at}`} className="flex items-center gap-2">
                      {e.converted_at ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <button
                        className="font-mono text-xs underline-offset-2 hover:underline"
                        onClick={() => setDrillUser(e.user_id)}
                      >
                        {e.user_id.slice(0, 8)}…
                      </button>
                      <span className="text-muted-foreground">
                        {e.exit_reason ?? "exited"} · {new Date(e.exited_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>

      <UserJourneyDialog
        campaign={campaign}
        userId={drillUser}
        onClose={() => setDrillUser(null)}
      />
    </Card>
  );
}

function UserJourneyDialog({
  campaign,
  userId,
  onClose,
}: {
  campaign: string;
  userId: string | null;
  onClose: () => void;
}) {
  const journey = useQuery({
    enabled: !!userId,
    queryKey: ["admin-drip-user", campaign, userId],
    queryFn: async () => {
      const res = await edgeFetch(`/api/admin/drip/campaigns/${campaign}/users/${userId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load journey.");
      return json as {
        enrollment: Record<string, unknown> | null;
        sends: Array<{
          step: number;
          phase: string;
          variant: string | null;
          sent_at: string | null;
          opened_at: string | null;
          clicked_at: string | null;
          unsubscribed: boolean;
        }>;
      };
    },
  });

  return (
    <Dialog open={!!userId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{userId}</DialogTitle>
          <DialogDescription>Journey + send history.</DialogDescription>
        </DialogHeader>
        {journey.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : journey.data?.enrollment == null ? (
          <p className="text-sm text-muted-foreground">No enrollment found.</p>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              exit: {(journey.data.enrollment.exit_reason as string) ?? "active"}
            </div>
            <ul className="space-y-1 text-sm">
              {journey.data.sends.map((s, i) => (
                <li key={i} className="flex items-center gap-2 rounded border px-2 py-1">
                  <Badge variant="outline">step {s.step}</Badge>
                  <span className="text-muted-foreground">{s.phase}</span>
                  {s.variant && <Badge variant="secondary">{s.variant}</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {s.opened_at ? "opened" : s.sent_at ? "sent" : "—"}
                    {s.clicked_at ? " · clicked" : ""}
                    {s.unsubscribed ? " · unsub" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// US-944: per-step A/B performance + recommended self-tuned weights, with an
// autotune toggle and a one-click "apply". Conversion is the optimized goal;
// weights shift toward the winner with an exploration floor, and high-unsub
// arms are retired (weight → 0).
function OptimizerPanel({
  data,
  loading,
  error,
  isSuperAdmin,
  working,
  onApply,
}: {
  data?: OptimizerResponse;
  loading: boolean;
  error: Error | null;
  isSuperAdmin: boolean;
  working: boolean;
  onApply: (opts: { autotuneEnabled?: boolean; applyWeights?: boolean }) => void;
}) {
  const tunable = (data?.optimizations ?? []).filter((o) => o.scores.length > 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" /> Conversion optimizer (A/B self-tuning)
        </CardTitle>
        <CardDescription>
          Per-step variant performance from the send + attribution ledger.
          Weights self-tune toward the highest-<strong>converting</strong> arm
          (clicks as a secondary signal), keep an exploration floor for losers,
          and retire high-unsubscribe arms. Below{" "}
          {data ? data.config.minSample : "the"} sends/arm it keeps testing
          evenly (no spurious winners). All data-driven, but visible and
          overridable below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
            <AlertTriangle className="h-4 w-4" /> {error.message}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="autotune"
                  checked={data?.autotuneEnabled ?? false}
                  disabled={!isSuperAdmin || working}
                  onCheckedChange={(v) =>
                    onApply({ autotuneEnabled: v, applyWeights: false })
                  }
                />
                <Label htmlFor="autotune" className="text-sm">
                  Autonomous self-tuning{" "}
                  <span className="text-xs text-muted-foreground">
                    (engine re-tunes weights automatically)
                  </span>
                </Label>
              </div>
              <Button
                size="sm"
                disabled={!isSuperAdmin || working || (data?.changedSteps ?? 0) === 0}
                onClick={() => onApply({ applyWeights: true })}
              >
                {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Apply recommendations
                {data && data.changedSteps > 0 ? ` (${data.changedSteps})` : ""}
              </Button>
            </div>

            {tunable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No multi-variant steps to optimize — add a second variant to a
                step to start A/B testing.
              </p>
            ) : (
              <div className="space-y-4">
                {tunable.map((o) => (
                  <div key={o.stepId} className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span>{o.ordinal}. {o.label}</span>
                      {o.hasEnoughData ? (
                        <Badge className="bg-green-600 hover:bg-green-600">
                          winner {o.winnerId}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">gathering data</Badge>
                      )}
                      {o.changed && (
                        <span className="text-xs text-amber-600">re-tune available</span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {o.totalSent} sends
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-muted-foreground">
                          <tr className="border-b text-left">
                            <th className="py-1 pr-3">variant</th>
                            <th className="py-1 pr-3">sent</th>
                            <th className="py-1 pr-3">conv</th>
                            <th className="py-1 pr-3">click</th>
                            <th className="py-1 pr-3">unsub</th>
                            <th className="py-1 pr-3">rec. weight</th>
                          </tr>
                        </thead>
                        <tbody>
                          {o.scores.map((s) => {
                            return (
                              <tr key={s.variantId} className="border-b last:border-0">
                                <td className="py-1 pr-3">
                                  <span className="flex items-center gap-1">
                                    {s.variantId}
                                    {s.isWinner && (
                                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                                    )}
                                    {s.retired && (
                                      <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                                        retired
                                      </Badge>
                                    )}
                                  </span>
                                </td>
                                <td className="py-1 pr-3">{s.sent}</td>
                                <td className="py-1 pr-3 font-medium">{pct(s.conversionRate)}</td>
                                <td className="py-1 pr-3">{pct(s.clickRate)}</td>
                                <td className={cn("py-1 pr-3", s.retired && "text-red-600")}>
                                  {pct(s.unsubRate)}
                                </td>
                                <td className="py-1 pr-3">
                                  <span className={cn(s.retired ? "text-red-600" : "font-medium")}>
                                    {s.weight}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// US-942: campaign-level conversion incentive config. References an EXISTING
// Stripe coupon / promo code (the admin coupons system) — no discount is
// hardcoded here. Off by default. When on, the engine surfaces a time-boxed,
// pre-applied offer ONLY on eligible win-back steps (whose own "Incentive"
// toggle is set). Edits save with the journey's "Save graph" button
// (super-admin + step-up + audited).
function IncentivePanel({
  incentive,
  disabled,
  onPatch,
}: {
  incentive?: DripIncentive;
  disabled: boolean;
  onPatch: (patch: Partial<DripIncentive>) => void;
}) {
  const coupons = useQuery({
    queryKey: ["admin-coupons"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/coupons");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load coupons.");
      return json as {
        coupons: Array<{ id: string; name: string | null; percent_off: number | null; valid: boolean }>;
        promotion_codes: Array<{ id: string; code: string; coupon_id: string; active: boolean }>;
      };
    },
    staleTime: 60_000,
  });

  const enabled = incentive?.enabled ?? false;
  const promoCodes = coupons.data?.promotion_codes ?? [];
  const couponById = new Map((coupons.data?.coupons ?? []).map((c) => [c.id, c]));

  // Selecting a promotion code wires BOTH the user-facing code (shown in the
  // email) and the coupon id (pre-applied at checkout) in one move.
  function selectPromo(code: string) {
    const pc = promoCodes.find((p) => p.code === code);
    if (!pc) return;
    onPatch({ promoCode: pc.code, couponId: pc.coupon_id });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="h-4 w-4" /> Conversion incentive (win-back)
        </CardTitle>
        <CardDescription>
          Optional, off by default. References an existing Stripe coupon + promo
          code (manage them under{" "}
          <span className="font-medium">Coupons &amp; Promo Codes</span>). When on,
          eligible win-back steps (with their own “Incentive” toggle set) surface a
          time-boxed, pre-applied offer — one-click conversion, tracked for ROI.
          Never shown in-trial or to already-paid users. Save with “Save graph”.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 rounded-md border p-3">
          <Switch
            id="incentive-enabled"
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(v) => onPatch({ enabled: v })}
          />
          <Label htmlFor="incentive-enabled" className="text-sm">
            Incentive enabled{" "}
            <span className="text-xs text-muted-foreground">
              (off reverts win-back emails to the value-only variant)
            </span>
          </Label>
        </div>

        {coupons.error && (
          <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
            <AlertTriangle className="h-4 w-4" /> {(coupons.error as Error).message}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="drip-promo-code">Promotion code</Label>
            <Select
              value={incentive?.promoCode || ""}
              disabled={disabled || coupons.isLoading}
              onValueChange={selectPromo}
            >
              <SelectTrigger id="drip-promo-code">
                <SelectValue placeholder={coupons.isLoading ? "Loading…" : "Select a promo code"} />
              </SelectTrigger>
              <SelectContent>
                {promoCodes.filter((p) => p.active).length === 0 ? (
                  <SelectItem value="__none" disabled>
                    No active promo codes
                  </SelectItem>
                ) : (
                  promoCodes
                    .filter((p) => p.active)
                    .map((p) => {
                      const coupon = couponById.get(p.coupon_id);
                      const valueLabel = coupon?.percent_off != null
                        ? ` · ${coupon.percent_off}% off`
                        : "";
                      return (
                        <SelectItem key={p.id} value={p.code}>
                          {p.code}{valueLabel}
                        </SelectItem>
                      );
                    })
                )}
              </SelectContent>
            </Select>
            {incentive?.couponId && (
              <p className="font-mono text-[11px] text-muted-foreground">
                coupon: {incentive.couponId}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="d-max-discount-guardrail" className="text-xs">Max discount guardrail (%)</Label>
            <Input id="d-max-discount-guardrail"
              type="number"
              min={1}
              max={100}
              disabled={disabled}
              value={incentive?.maxPercentOff ?? 25}
              onChange={(e) => onPatch({ maxPercentOff: Number(e.target.value) })}
            />
            <p className="text-[11px] text-muted-foreground">
              A coupon discounting more than this is refused server-side (never sent).
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="d-offer-window-hours" className="text-xs">Offer window (hours)</Label>
            <Input id="d-offer-window-hours"
              type="number"
              min={1}
              disabled={disabled}
              value={incentive?.expiryHours ?? 168}
              onChange={(e) => onPatch({ expiryHours: Number(e.target.value) })}
            />
            <p className="text-[11px] text-muted-foreground">
              Time-box from when the offer is shown (e.g. 168 = 7 days).
            </p>
          </div>
        </div>

        {enabled && !incentive?.couponId && (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" /> Select a promotion code before saving — an enabled
            incentive needs a coupon.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Simulator({ campaign }: { campaign: string }) {
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | {
        user: { email: string | null; firstName: string | null; converted: boolean; trialDaysRemaining: number };
        nextTick: string;
        result: { campaignWouldEnroll: boolean; exitReason: string | null; sends: SimulatedSend[] };
      }
    | null
  >(null);

  async function simulate() {
    if (!userId.trim()) {
      toast.error("Enter a user id.");
      return;
    }
    setBusy(true);
    try {
      const res = await edgeFetch(`/api/admin/drip/campaigns/${campaign}/simulate`, {
        method: "POST",
        json: { userId: userId.trim() },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Simulation failed");
        setResult(null);
        return;
      }
      setResult(json);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Simulate for a user (dry run)</CardTitle>
        <CardDescription>
          Runs the evaluator against a chosen account WITHOUT sending — projects
          which steps would fire, when, and which variant.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Input
            aria-label="User id to simulate"
            placeholder="user id (UUID)"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="max-w-md font-mono text-sm"
          />
          <Button size="sm" disabled={busy} onClick={simulate}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Simulate
          </Button>
        </div>
        {result && (
          <div className="space-y-2 text-sm">
            <div className="text-muted-foreground">
              {result.user.email ?? "user"} · {result.user.converted ? "converted" : "not converted"} ·{" "}
              {result.user.trialDaysRemaining}d trial left
            </div>
            {!result.result.campaignWouldEnroll ? (
              <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                Would not enroll: {result.result.exitReason}
              </div>
            ) : (
              <ul className="space-y-1">
                {result.result.sends.map((s, i) => (
                  <li key={i} className="flex items-center gap-2 rounded border px-2 py-1">
                    <Badge variant={s.willSend ? "default" : "secondary"}>{s.willSend ? "send" : "skip"}</Badge>
                    <span>{s.label}</span>
                    <Badge variant="outline">{s.variantId}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {new Date(s.scheduledAt).toLocaleString()} · {s.reason}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {result.result.exitReason && result.result.campaignWouldEnroll && (
              <div className="text-xs text-muted-foreground">Ends: {result.result.exitReason}</div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
