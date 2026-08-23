import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Check, X, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";

// US-329: review queue for auto-promoted candidate golden eval cases. Reuses the
// existing admin eval-case endpoints (candidates are simply is_active=false).

interface EvalCase {
  id: string;
  label: string;
  garment_category: string;
  expected_score: number;
  expected_tier: string;
  tags: string[] | null;
  notes: string | null;
  is_active: boolean;
  source: string | null;
  created_at: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
}

interface BatchPromoteResult {
  scanned: number;
  high_signal: number;
  promoted: number;
  already_present: number;
  skipped: number;
}

export function GradingEvalCandidatesPanel() {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [growing, setGrowing] = useState(false);
  // US-2037: approving or rejecting a golden case now requires an MFA step-up,
  // matching prompt activation/canary. Hold the action so it can be replayed
  // once the dialog verifies, instead of making the operator click twice.
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const pendingAction = useRef<(() => Promise<void>) | null>(null);

  async function growFromCorrections() {
    setGrowing(true);
    try {
      const headers = await authHeaders();
      const res = await fetch(
        `${edgeApiUrl()}/api/admin/grading/eval/cases/promote-batch`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || `Failed (${res.status})`);
      }
      const r = (await res.json()) as BatchPromoteResult;
      toast.success(
        r.promoted > 0
          ? `${r.promoted} new candidate${r.promoted === 1 ? "" : "s"} added`
          : "No new high-signal corrections found",
        {
          description:
            `Scanned ${r.scanned} review${r.scanned === 1 ? "" : "s"}, ` +
            `${r.high_signal} high-signal · ${r.already_present} already present.`,
        },
      );
      queryClient.invalidateQueries({ queryKey: ["admin-eval-candidates"] });
    } catch (err) {
      toast.error("Could not grow the golden set", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setGrowing(false);
    }
  }

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin-eval-candidates"],
    queryFn: async (): Promise<EvalCase[]> => {
      const res = await fetch(`${edgeApiUrl()}/api/admin/grading/eval/cases`, {
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error(`Eval cases unavailable (${res.status})`);
      const body = (await res.json()) as { cases?: EvalCase[] };
      return body.cases ?? [];
    },
    staleTime: 30 * 1000,
  });

  const candidates = (data ?? []).filter((c) => !c.is_active);

  async function act(caseId: string, action: "approve" | "reject") {
    const run = async () => {
      const headers = await authHeaders();
      const res =
        action === "approve"
          ? await fetch(`${edgeApiUrl()}/api/admin/grading/eval/cases/${caseId}`, {
              method: "PATCH",
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify({ is_active: true }),
            })
          : await fetch(`${edgeApiUrl()}/api/admin/grading/eval/cases/${caseId}`, {
              method: "DELETE",
              headers,
            });
      if (res.status === 403) {
        const b = await res.json().catch(() => ({}));
        if (b?.code === "STEP_UP_REQUIRED") {
          pendingAction.current = run;
          setStepUpOpen(true);
          return;
        }
        throw new Error(b?.error || "Forbidden");
      }
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || `Failed (${res.status})`);
      }
      toast.success(action === "approve" ? "Eval case approved" : "Candidate rejected", {
        description:
          action === "approve"
            ? "It now counts toward the eval gate."
            : "The candidate case was retired — it stays on record for audit.",
      });
      queryClient.invalidateQueries({ queryKey: ["admin-eval-candidates"] });
    };

    setBusyId(caseId);
    try {
      await run();
    } catch (err) {
      toast.error("Action failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <FlaskConical className="h-4 w-4 text-brand-navy dark:text-foreground" />
            Candidate eval cases
            {candidates.length > 0 && (
              <Badge variant="secondary">{candidates.length} pending</Badge>
            )}
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={growing}
            onClick={growFromCorrections}
            className="flex-shrink-0"
          >
            <Sparkles className="mr-1 h-4 w-4" />
            {growing ? "Scanning…" : "Grow from corrections"}
          </Button>
        </div>
        <CardDescription>
          Grades a reviewer corrected (or a dispute adjusted) are auto-promoted
          here. Approve to add them to the golden set the eval gate scores
          against. “Grow from corrections” sweeps recent high-signal corrections
          for new candidates.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Candidate data is temporarily unavailable.
          </p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending candidates. Corrections from the review queue and disputes
            will appear here for approval.
          </p>
        ) : (
          <ul className="space-y-3">
            {candidates.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{c.label || "Untitled"}</span>
                    <Badge variant="outline" className="text-xs">
                      Expected {c.expected_score.toFixed(1)} · {c.expected_tier}
                    </Badge>
                    {(c.tags ?? []).slice(0, 4).map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  {c.notes && (
                    <p className="mt-1 text-xs text-muted-foreground">{c.notes}</p>
                  )}
                </div>
                <div className="flex flex-shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === c.id}
                    onClick={() => act(c.id, "approve")}
                    aria-label={`Approve ${c.label || "the untitled candidate"}`}
                  >
                    <Check className="mr-1 h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === c.id}
                    onClick={() => act(c.id, "reject")}
                    aria-label={`Reject ${c.label || "the untitled candidate"}`}
                  >
                    <X className="mr-1 h-4 w-4" />
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* US-2037: step-up re-auth before mutating the golden set, then replay
          the action. Editing what the eval gate measures is as consequential as
          activating a prompt, and is now gated the same way. */}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          const action = pendingAction.current;
          pendingAction.current = null;
          if (action) {
            void action().catch((err: unknown) => {
              toast.error("Action failed", {
                description: err instanceof Error ? err.message : "Unknown error",
              });
            });
          }
        }}
      />
    </Card>
  );
}
