import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket, ArrowUpCircle, Undo2, Loader2, FlaskConical } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import type { AiPromptVersionRow } from "@/types/database";
import { toast } from "sonner";

// US-896: staged prompt rollout / canary manager. Routes a configurable % of
// live composite-grading traffic to an eval-passed challenger, bucketed by a
// stable per-submission hash, and shows canary-vs-active accuracy/confidence/
// dispute signals before promoting to 100% (the activate path) or rolling back.

interface VersionMetrics {
  version_name: string;
  grades: number;
  mean_score: number | null;
  mean_confidence: number | null;
  human_review_rate: number | null;
  early_dispute_rate: number | null;
  dispute_count: number;
}

interface CanaryMetricsResponse {
  prompt: {
    id: string;
    version_name: string;
    stage: string;
    rollout_percentage: number;
    rollout_started_at: string | null;
  };
  active_version_name: string;
  window_days: number;
  measurable: boolean;
  canary: VersionMetrics;
  active: VersionMetrics;
  score_delta: number | null;
}

function fmtPct(x: number | null): string {
  return x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`;
}
function fmtNum(x: number | null, digits = 2): string {
  return x === null || x === undefined ? "—" : x.toFixed(digits);
}

export function GradingCanaryPanel() {
  const queryClient = useQueryClient();
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [pct, setPct] = useState(10);
  const [busy, setBusy] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  // The action to replay after a successful MFA step-up.
  const pendingAction = useRef<(() => Promise<void>) | null>(null);

  // Composite-stage prompt versions (only composite canaries are live-measurable
  // — grade_reports.prompt_version is the composite version a grade shipped under).
  const { data: versions, isLoading } = useQuery({
    queryKey: ["admin-grading-canary-versions"],
    queryFn: async (): Promise<AiPromptVersionRow[]> => {
      const { data, error } = await supabase
        .from("ai_prompt_versions")
        .select("*")
        .eq("stage", "composite")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as AiPromptVersionRow[];
    },
    staleTime: 30 * 1000,
  });

  const activeVersion = useMemo(
    () => (versions ?? []).find((v) => v.is_active) ?? null,
    [versions],
  );
  const currentCanary = useMemo(
    () => (versions ?? []).find((v) => v.is_canary && v.rollout_percentage > 0) ?? null,
    [versions],
  );
  // Eligible to start a canary: eval-passed, not active, not already the canary.
  const candidates = useMemo(
    () =>
      (versions ?? []).filter(
        (v) => v.eval_passed === true && !v.is_active && !v.is_canary,
      ),
    [versions],
  );

  // Live canary-vs-active metrics (only when a canary is running).
  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ["admin-grading-canary-metrics", currentCanary?.id],
    enabled: Boolean(currentCanary),
    queryFn: async (): Promise<CanaryMetricsResponse> => {
      const res = await edgeFetch(
        `/api/admin/grading/prompts/${currentCanary!.id}/canary?days=14`,
        { silentGate: true },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as CanaryMetricsResponse;
    },
    staleTime: 30 * 1000,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["admin-grading-canary-versions"] });
    queryClient.invalidateQueries({ queryKey: ["admin-grading-canary-metrics"] });
    queryClient.invalidateQueries({ queryKey: ["admin-ai-models"] });
  }

  // Run a step-up-aware mutation; on STEP_UP_REQUIRED stash + open the dialog.
  async function runGuarded(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  async function setCanaryPercentage(id: string, percentage: number, label: string) {
    const action = async () => {
      const res = await edgeFetch(`/api/admin/grading/prompts/${id}/canary`, {
        method: "PATCH",
        json: { rollout_percentage: percentage },
        silentGate: true,
      });
      if (res.status === 403) {
        const d = await res.json().catch(() => ({}));
        if (d?.code === "STEP_UP_REQUIRED") {
          pendingAction.current = action;
          setStepUpOpen(true);
          return;
        }
        throw new Error(d?.error ?? "Forbidden");
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error ?? `HTTP ${res.status}`);
      }
      toast.success(label);
      refresh();
    };
    await runGuarded(action);
  }

  async function promote(id: string, name: string) {
    const action = async () => {
      const res = await edgeFetch(`/api/admin/grading/prompts/${id}/activate`, {
        method: "POST",
        silentGate: true,
      });
      if (res.status === 403) {
        const d = await res.json().catch(() => ({}));
        if (d?.code === "STEP_UP_REQUIRED") {
          pendingAction.current = action;
          setStepUpOpen(true);
          return;
        }
        throw new Error(d?.error ?? "Forbidden");
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error ?? `HTTP ${res.status}`);
      }
      toast.success(`"${name}" promoted to 100% — it's now the active prompt.`);
      refresh();
    };
    await runGuarded(action);
  }

  function handleStartCanary() {
    if (!selectedCandidateId) return;
    const cand = candidates.find((v) => v.id === selectedCandidateId);
    void setCanaryPercentage(
      selectedCandidateId,
      pct,
      `Canary started at ${pct}%${cand ? ` for "${cand.version_name}"` : ""}.`,
    ).then(() => setSelectedCandidateId(""));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Rocket className="h-4 w-4 text-brand-navy dark:text-foreground" />
          Staged Rollout (Canary)
        </CardTitle>
        <CardDescription>
          Promote a new composite grading prompt to a percentage of live traffic
          and watch its accuracy, confidence and dispute signals against the active
          prompt before going 100%. Bucketed by a stable per-submission hash; the
          grading kill-switch gates canary traffic too.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <>
            {/* Active champion */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border p-3 text-sm">
              <div>
                <span className="text-muted-foreground">Active prompt:</span>{" "}
                <span className="font-semibold">
                  {activeVersion ? activeVersion.version_name : "code default"}
                </span>
              </div>
              <div className="text-muted-foreground">
                serving {currentCanary ? 100 - currentCanary.rollout_percentage : 100}% of traffic
              </div>
            </div>

            {/* Current canary + metrics, or start a new one */}
            {currentCanary ? (
              <div className="space-y-4 rounded-lg border border-brand-navy/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <FlaskConical className="h-4 w-4 text-brand-red-text" />
                    <span className="font-semibold">{currentCanary.version_name}</span>
                    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                      Canary · {currentCanary.rollout_percentage}%
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void setCanaryPercentage(
                          currentCanary.id,
                          0,
                          `Rolled back "${currentCanary.version_name}" — 100% back on the active prompt.`,
                        )
                      }
                    >
                      <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                      Roll back
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void promote(currentCanary.id, currentCanary.version_name)}
                    >
                      <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
                      Promote to 100%
                    </Button>
                  </div>
                </div>

                {/* Adjust slider */}
                <div className="flex items-center gap-3">
                  <span className="w-28 text-xs text-muted-foreground">Traffic share</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={currentCanary.rollout_percentage}
                    disabled={busy}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      void setCanaryPercentage(
                        currentCanary.id,
                        next,
                        next === 0
                          ? `Rolled back "${currentCanary.version_name}".`
                          : `Canary set to ${next}%.`,
                      );
                    }}
                    className="flex-1 accent-brand-navy"
                  />
                  <span className="w-12 text-right text-sm font-semibold tabular-nums">
                    {currentCanary.rollout_percentage}%
                  </span>
                </div>

                {/* Live metrics */}
                {metricsLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : metrics ? (
                  <>
                    {!metrics.measurable && (
                      <p className="text-xs text-muted-foreground">
                        Live metrics are attributed by composite version.
                      </p>
                    )}
                    <div className="overflow-x-auto rounded-lg border">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">
                              Last {metrics.window_days}d
                            </th>
                            <th className="px-3 py-2 text-right font-semibold">
                              Active
                              <div className="font-normal text-[10px] text-muted-foreground truncate max-w-[120px] ml-auto">
                                {metrics.active.version_name}
                              </div>
                            </th>
                            <th className="px-3 py-2 text-right font-semibold">
                              Canary
                              <div className="font-normal text-[10px] text-muted-foreground truncate max-w-[120px] ml-auto">
                                {metrics.canary.version_name}
                              </div>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-t">
                            <td className="px-3 py-2 text-muted-foreground">Grades</td>
                            <td className="px-3 py-2 text-right tabular-nums">{metrics.active.grades}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{metrics.canary.grades}</td>
                          </tr>
                          <tr className="border-t">
                            <td className="px-3 py-2 text-muted-foreground">Mean score</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtNum(metrics.active.mean_score, 1)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {fmtNum(metrics.canary.mean_score, 1)}
                              {metrics.score_delta !== null && (
                                <span
                                  className={
                                    "ml-1 " +
                                    (Math.abs(metrics.score_delta) >= 0.3
                                      ? "text-brand-red-text font-semibold"
                                      : "text-muted-foreground")
                                  }
                                >
                                  ({metrics.score_delta >= 0 ? "+" : ""}
                                  {metrics.score_delta.toFixed(2)})
                                </span>
                              )}
                            </td>
                          </tr>
                          <tr className="border-t">
                            <td className="px-3 py-2 text-muted-foreground">Mean confidence</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtNum(metrics.active.mean_confidence)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtNum(metrics.canary.mean_confidence)}</td>
                          </tr>
                          <tr className="border-t">
                            <td className="px-3 py-2 text-muted-foreground">Human-review rate</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtPct(metrics.active.human_review_rate)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtPct(metrics.canary.human_review_rate)}</td>
                          </tr>
                          <tr className="border-t">
                            <td className="px-3 py-2 text-muted-foreground">Early dispute rate</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtPct(metrics.active.early_dispute_rate)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtPct(metrics.canary.early_dispute_rate)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    {metrics.canary.grades === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No canary grades in the window yet — metrics fill in as live
                        traffic flows to the canary.
                      </p>
                    )}
                  </>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-sm text-muted-foreground">
                  No canary running. Start one from an eval-passed composite prompt
                  to send it a slice of live traffic.
                </p>
                {candidates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No eligible candidates. Create a composite prompt and pass the
                    eval gate first.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[220px] flex-1">
                      <Select value={selectedCandidateId} onValueChange={setSelectedCandidateId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a candidate prompt…" />
                        </SelectTrigger>
                        <SelectContent>
                          {candidates.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {v.version_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={5}
                        max={100}
                        step={5}
                        value={pct}
                        onChange={(e) => setPct(Number(e.target.value))}
                        className="w-32 accent-brand-navy"
                      />
                      <span className="w-10 text-right text-sm font-semibold tabular-nums">{pct}%</span>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy || !selectedCandidateId}
                      onClick={handleStartCanary}
                    >
                      {busy ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Rocket className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Start canary
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* Step-up re-auth before any canary routing change, then replay the action. */}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const action = pendingAction.current;
          pendingAction.current = null;
          if (action) void runGuarded(action);
        }}
      />
    </Card>
  );
}
