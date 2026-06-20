import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Newspaper,
  Pause,
  Play,
  Power,
  ShieldCheck,
  ShieldOff,
  CalendarClock,
  Plus,
  Eye,
  Send,
  TestTube,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Sparkles,
  Ban,
  Star,
  Clock,
} from "lucide-react";

// ── Types (mirror the /api/admin/newsletter console payloads) ────────────────

type NewsletterStatus =
  | "draft"
  | "ready_for_qa"
  | "approved"
  | "awaiting_review"
  | "sending"
  | "sent"
  | "blocked";

interface NewsletterSection {
  heading?: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

interface QaCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}
interface QaReport {
  passed?: boolean;
  checks?: QaCheck[];
}

interface NewsletterIssue {
  id: string;
  title: string;
  subject: string;
  preheader: string | null;
  sections: NewsletterSection[];
  status: NewsletterStatus;
  audience: string;
  scheduled_for: string | null;
  qa_results: QaReport;
  recipients_total: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  block_reason: string | null;
  approved_at: string | null;
  send_started_at: string | null;
  sent_at: string | null;
  created_at: string;
}

interface ProgramState {
  paused: boolean;
  requireApproval: boolean;
  killSwitchEnabled: boolean;
  nextScheduledRun: string | null;
}

interface IssueDetail {
  issue: NewsletterIssue;
  recipients: Array<{
    id: string;
    email: string;
    status: string;
    skip_reason: string | null;
    sent_at: string | null;
  }>;
  progress: {
    total: number;
    sent: number;
    skipped: number;
    failed: number;
    pending: number;
    sending: boolean;
    skipReasons: Record<string, number>;
  };
}

// ── Self-tuning (US-928) ─────────────────────────────────────────────────────

interface DimScore {
  key: string;
  sent: number;
  openRate: number;
  clickRate: number;
  unsubRate: number;
  trusted: boolean;
  paused: boolean;
  isWinner: boolean;
  weight: number;
}

interface TuningRecommendations {
  computedAt?: string;
  topicWinner?: string | null;
  pausedTopics?: string[];
  topics?: DimScore[];
  subjectStyles?: DimScore[];
  subjectWinner?: string | null;
  sendHour?: { bestHour: number | null };
  topicSent?: number;
}

interface TuningState {
  enabled: boolean;
  config: { minSample: number; explorationFloor: number; unsubCeiling: number };
  topicWeights: Record<string, number>;
  subjectStyleWeights: Record<string, number>;
  sendHourStats: { bestHour?: number | null };
  recommendations: TuningRecommendations;
  catalog: {
    topics: Array<{ id: string; pillar: string; angle: string; label: string }>;
    subjectStyles: Array<{ id: string; label: string }>;
  };
}

const STATUS_LABEL: Record<NewsletterStatus, string> = {
  draft: "Draft",
  ready_for_qa: "Ready for QA",
  approved: "Approved",
  awaiting_review: "Awaiting Review",
  sending: "Sending",
  sent: "Sent",
  blocked: "Blocked",
};

function StatusBadge({ status }: { status: NewsletterStatus }) {
  const tone: Record<NewsletterStatus, string> = {
    draft: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    ready_for_qa: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    awaiting_review: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
    approved: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
    sending: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
    sent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
    blocked: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export function AdminNewsletterConsolePage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  // ── Program state ──────────────────────────────────────────────────────────
  const program = useQuery({
    queryKey: ["newsletter-program"],
    queryFn: async (): Promise<ProgramState> => {
      const res = await edgeFetch("/api/admin/newsletter/program");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load program state");
      return json as ProgramState;
    },
    staleTime: 15_000,
  });

  const issues = useQuery({
    queryKey: ["newsletter-issues"],
    queryFn: async (): Promise<NewsletterIssue[]> => {
      const res = await edgeFetch("/api/admin/newsletter/issues");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load issues");
      return (json.issues ?? []) as NewsletterIssue[];
    },
    staleTime: 15_000,
  });

  // Step-up-aware runner: retries the same call after a fresh MFA verify.
  async function run(doFetch: () => Promise<Response>): Promise<unknown | null> {
    const res = await doFetch();
    if (res.status === 403) {
      const j = await res.json().catch(() => ({}));
      if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        setRetry(() => () => void run(doFetch));
        setStepUpOpen(true);
        return null;
      }
      toast.error((j as { error?: string })?.error ?? "Forbidden");
      return null;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error((j as { error?: string })?.error ?? "Action failed");
      return null;
    }
    return j;
  }

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: ["newsletter-program"] });
    void qc.invalidateQueries({ queryKey: ["newsletter-issues"] });
    if (selectedId) void qc.invalidateQueries({ queryKey: ["newsletter-issue", selectedId] });
  }

  // ── Program control mutations ────────────────────────────────────────────────
  const patchProgram = useMutation({
    mutationFn: (body: Partial<ProgramState> & { killSwitch?: boolean }) =>
      run(() => edgeFetch("/api/admin/newsletter/program", { method: "PATCH", json: body })),
    onSuccess: (r) => {
      if (r) {
        toast.success("Program updated");
        invalidateAll();
      }
    },
  });

  const buildNext = useMutation({
    mutationFn: () =>
      run(() => edgeFetch("/api/admin/newsletter/issues/build-next", { method: "POST", json: {} })),
    onSuccess: (r) => {
      if (r && typeof r === "object" && "issue" in r) {
        toast.success("Draft issue created");
        invalidateAll();
        setSelectedId((r as { issue: NewsletterIssue }).issue.id);
      }
    },
  });

  const p = program.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Newspaper className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">Newsletter Console</h1>
            <p className="text-sm text-muted-foreground">
              Oversee the autonomous program — preview, approve, send, and pause or
              kill the whole thing.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void program.refetch();
            void issues.refetch();
          }}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {/* Program controls + safety brakes */}
      <Card className={p && (p.paused || !p.killSwitchEnabled) ? "border-red-300 dark:border-red-800" : ""}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Program Controls</CardTitle>
          <CardDescription>
            Master toggles for the autonomous newsletter. The kill-switch halts all
            sends instantly platform-wide.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {program.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : p ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                {/* Kill-switch */}
                <div className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {p.killSwitchEnabled ? (
                      <Power className="h-4 w-4 text-green-600" />
                    ) : (
                      <Power className="h-4 w-4 text-red-600" />
                    )}
                    Program {p.killSwitchEnabled ? "Active" : "Halted"}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Platform-wide kill-switch (feature flag).
                  </p>
                  <Button
                    size="sm"
                    variant={p.killSwitchEnabled ? "destructive" : "default"}
                    className="mt-2"
                    disabled={patchProgram.isPending}
                    onClick={() => patchProgram.mutate({ killSwitch: !p.killSwitchEnabled })}
                  >
                    {p.killSwitchEnabled ? "Kill program" : "Re-enable"}
                  </Button>
                </div>

                {/* Pause */}
                <div className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {p.paused ? (
                      <Pause className="h-4 w-4 text-amber-600" />
                    ) : (
                      <Play className="h-4 w-4 text-green-600" />
                    )}
                    Sending {p.paused ? "Paused" : "Running"}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Soft brake — keeps the program on but defers sends.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={patchProgram.isPending}
                    onClick={() => patchProgram.mutate({ paused: !p.paused })}
                  >
                    {p.paused ? "Resume sends" : "Pause sends"}
                  </Button>
                </div>

                {/* Require approval */}
                <div className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {p.requireApproval ? (
                      <ShieldCheck className="h-4 w-4 text-green-600" />
                    ) : (
                      <ShieldOff className="h-4 w-4 text-amber-600" />
                    )}
                    Human approval {p.requireApproval ? "Required" : "Off"}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    When on, every issue needs a human before it can send.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={patchProgram.isPending}
                    onClick={() => patchProgram.mutate({ requireApproval: !p.requireApproval })}
                  >
                    {p.requireApproval ? "Allow auto-approve" : "Require approval"}
                  </Button>
                </div>
              </div>

              <Separator />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CalendarClock className="h-4 w-4" />
                  Next scheduled run:{" "}
                  <strong className="text-foreground">{fmtDate(p.nextScheduledRun)}</strong>
                </div>
                <Button
                  size="sm"
                  disabled={buildNext.isPending}
                  onClick={() => buildNext.mutate()}
                >
                  {buildNext.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Build next issue now
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-red-600">Failed to load program state.</p>
          )}
        </CardContent>
      </Card>

      {/* Issues table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Issues</CardTitle>
          <CardDescription>Click an issue to preview, approve, or send it.</CardDescription>
        </CardHeader>
        <CardContent>
          {issues.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (issues.data ?? []).length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No issues yet. Use “Build next issue now” to scaffold a draft.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Issue</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">QA</th>
                    <th className="py-2 pr-3 font-medium">Audience</th>
                    <th className="py-2 pr-3 font-medium">Schedule</th>
                    <th className="py-2 font-medium">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {(issues.data ?? []).map((i) => (
                    <tr
                      key={i.id}
                      className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                      onClick={() => setSelectedId(i.id)}
                    >
                      <td className="py-2 pr-3">
                        <div className="font-medium">{i.title || "Untitled"}</div>
                        <div className="text-xs text-muted-foreground">
                          {i.subject || "(no subject)"}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <StatusBadge status={i.status} />
                      </td>
                      <td className="py-2 pr-3">
                        {i.qa_results?.passed === true ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : i.qa_results?.passed === false ? (
                          <AlertTriangle className="h-4 w-4 text-amber-500" />
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs">{i.audience}</td>
                      <td className="py-2 pr-3 text-xs">{fmtDate(i.scheduled_for)}</td>
                      <td className="py-2 text-xs tabular-nums">
                        {i.status === "sent" || i.status === "sending"
                          ? `${i.sent_count}/${i.recipients_total} sent`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <TuningPanel run={run} />

      <IssueDrawer
        issueId={selectedId}
        onClose={() => setSelectedId(null)}
        run={run}
        onChanged={invalidateAll}
      />

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => retry?.()}
      />
    </div>
  );
}

// ── Self-tuning transparency panel (US-928) ────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function TuningPanel({
  run,
}: {
  run: (doFetch: () => Promise<Response>) => Promise<unknown | null>;
}) {
  const qc = useQueryClient();

  const tuning = useQuery({
    queryKey: ["newsletter-tuning"],
    queryFn: async (): Promise<TuningState> => {
      const res = await edgeFetch("/api/admin/newsletter/tuning");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load tuning state");
      return json as TuningState;
    },
    staleTime: 30_000,
  });

  const recompute = useMutation({
    mutationFn: () =>
      run(() => edgeFetch("/api/admin/newsletter/tuning/recompute", { method: "POST", json: {} })),
    onSuccess: (r) => {
      if (r) {
        toast.success("Self-tuning recomputed from engagement");
        void qc.invalidateQueries({ queryKey: ["newsletter-tuning"] });
      }
    },
  });

  const t = tuning.data;
  const labelFor = (id: string) =>
    t?.catalog.topics.find((x) => x.id === id)?.label ?? id;

  // Topics sorted by current weight (desc) for the at-a-glance view.
  const topicRows = t
    ? t.catalog.topics
        .map((topic) => ({
          id: topic.id,
          label: topic.label,
          weight: t.topicWeights[topic.id] ?? 0,
          score: t.recommendations.topics?.find((s) => s.key === topic.id),
        }))
        .sort((a, b) => b.weight - a.weight)
    : [];

  const rec = t?.recommendations;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-red-text" />
            <CardTitle className="text-base">Self-tuning</CardTitle>
            {t && (
              <Badge variant={t.enabled ? "default" : "outline"}>
                {t.enabled ? "On" : "Frozen"}
              </Badge>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={recompute.isPending}
            onClick={() => recompute.mutate()}
          >
            {recompute.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            Recompute now
          </Button>
        </div>
        <CardDescription>
          Topic, subject-style, and send-time selection are biased toward what
          engages — learned from open / click / unsubscribe signals. Override the
          weights from the system settings registry.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {tuning.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !t ? (
          <p className="text-sm text-red-600">Failed to load tuning state.</p>
        ) : (
          <>
            {/* Summary line */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                Best send hour:{" "}
                <strong className="text-foreground">
                  {typeof t.sendHourStats?.bestHour === "number"
                    ? `${String(t.sendHourStats.bestHour).padStart(2, "0")}:00 UTC`
                    : "—"}
                </strong>
              </span>
              <span>
                Winning style:{" "}
                <strong className="text-foreground">
                  {rec?.subjectWinner
                    ? t.catalog.subjectStyles.find((s) => s.id === rec.subjectWinner)?.label ??
                      rec.subjectWinner
                    : "—"}
                </strong>
              </span>
              <span>
                Sampled sends:{" "}
                <strong className="text-foreground">{rec?.topicSent ?? 0}</strong>
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {rec?.computedAt ? `Updated ${fmtDate(rec.computedAt)}` : "Not yet computed"}
              </span>
            </div>

            {/* Topic weights table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Topic</th>
                    <th className="py-2 pr-3 font-medium">Weight</th>
                    <th className="py-2 pr-3 font-medium">Sent</th>
                    <th className="py-2 pr-3 font-medium">Open</th>
                    <th className="py-2 pr-3 font-medium">CTR</th>
                    <th className="py-2 font-medium">Unsub</th>
                  </tr>
                </thead>
                <tbody>
                  {topicRows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-3">
                        <span className="inline-flex items-center gap-1.5">
                          {row.score?.isWinner && (
                            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
                          )}
                          {row.score?.paused && <Ban className="h-3.5 w-3.5 text-red-500" />}
                          {row.label}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full ${row.score?.paused ? "bg-red-400" : "bg-brand-red"}`}
                              style={{ width: `${row.weight}%` }}
                            />
                          </div>
                          <span className="tabular-nums">{row.weight}</span>
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">
                        {row.score?.sent ?? 0}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">
                        {row.score ? pct(row.score.openRate) : "—"}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">
                        {row.score ? pct(row.score.clickRate) : "—"}
                      </td>
                      <td className="py-1.5 tabular-nums text-muted-foreground">
                        {row.score ? pct(row.score.unsubRate) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(rec?.pausedTopics?.length ?? 0) > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-red-600">
                <Ban className="h-3.5 w-3.5" />
                Paused (high unsubscribe rate):{" "}
                {rec!.pausedTopics!.map(labelFor).join(", ")}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Per-issue drill-in drawer ──────────────────────────────────────────────────

function IssueDrawer({
  issueId,
  onClose,
  run,
  onChanged,
}: {
  issueId: string | null;
  onClose: () => void;
  run: (doFetch: () => Promise<Response>) => Promise<unknown | null>;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  // Local editable buffer.
  const [subject, setSubject] = useState("");
  const [title, setTitle] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [sectionsJson, setSectionsJson] = useState("");

  const detail = useQuery({
    queryKey: ["newsletter-issue", issueId],
    enabled: !!issueId,
    queryFn: async (): Promise<IssueDetail> => {
      const res = await edgeFetch(`/api/admin/newsletter/issues/${issueId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load issue");
      const d = json as IssueDetail;
      setSubject(d.issue.subject);
      setTitle(d.issue.title);
      setScheduledFor(d.issue.scheduled_for ? d.issue.scheduled_for.slice(0, 16) : "");
      setSectionsJson(JSON.stringify(d.issue.sections, null, 2));
      return d;
    },
  });

  const issue = detail.data?.issue;
  const progress = detail.data?.progress;
  const editable =
    issue &&
    ["draft", "ready_for_qa", "awaiting_review", "approved"].includes(issue.status);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["newsletter-issue", issueId] });
    onChanged();
  }

  async function save() {
    let sections: NewsletterSection[];
    try {
      sections = JSON.parse(sectionsJson);
      if (!Array.isArray(sections)) throw new Error("Sections must be an array");
    } catch (e) {
      toast.error(`Invalid sections JSON: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const r = await run(() =>
      edgeFetch(`/api/admin/newsletter/issues/${issueId}`, {
        method: "PATCH",
        json: {
          title,
          subject,
          sections,
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        },
      }),
    );
    if (r) {
      toast.success("Saved");
      refresh();
    }
  }

  async function preview() {
    const r = await run(() =>
      edgeFetch(`/api/admin/newsletter/issues/${issueId}/preview`, { method: "POST", json: {} }),
    );
    if (r && typeof r === "object" && "html" in r) {
      setPreviewHtml((r as { html: string }).html);
    }
  }

  async function testSend() {
    if (!testEmail.trim()) {
      toast.error("Enter a test recipient email");
      return;
    }
    const r = await run(() =>
      edgeFetch(`/api/admin/newsletter/issues/${issueId}/test-send`, {
        method: "POST",
        json: { email: testEmail.trim() },
      }),
    );
    if (r) toast.success(`Test sent to ${testEmail.trim()}`);
  }

  async function transition(to: NewsletterStatus, reason?: string) {
    const r = await run(() =>
      edgeFetch(`/api/admin/newsletter/issues/${issueId}/transition`, {
        method: "POST",
        json: { to, reason },
      }),
    );
    if (r) {
      toast.success(`Moved to ${STATUS_LABEL[to]}`);
      refresh();
    } else {
      // surface a QA failure body if present
    }
  }

  async function sendNow() {
    const r = await run(() =>
      edgeFetch(`/api/admin/newsletter/issues/${issueId}/send`, { method: "POST", json: {} }),
    );
    if (r && typeof r === "object" && "summary" in r) {
      const s = (r as { summary: { sent: number; skipped: number; failed: number } }).summary;
      toast.success(`Sent: ${s.sent}, skipped: ${s.skipped}, failed: ${s.failed}`);
      refresh();
    }
  }

  return (
    <>
      <Sheet open={!!issueId} onOpenChange={(o) => !o && onClose()}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {issue ? <StatusBadge status={issue.status} /> : null}
              {issue?.title || "Issue"}
            </SheetTitle>
          </SheetHeader>

          {detail.isLoading || !issue ? (
            <div className="mt-6 space-y-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <div className="mt-4 space-y-5">
              {/* QA results */}
              {issue.qa_results?.checks && issue.qa_results.checks.length > 0 && (
                <div className="rounded-lg border border-border p-3 text-sm">
                  <div className="mb-2 font-medium">QA checks</div>
                  <ul className="space-y-1">
                    {issue.qa_results.checks.map((ch) => (
                      <li key={ch.id} className="flex items-center gap-2">
                        {ch.passed ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-red-500" />
                        )}
                        <span className={ch.passed ? "" : "text-red-600"}>{ch.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Editable fields */}
              <div className="space-y-3">
                <div>
                  <Label htmlFor="nl-title">Internal title</Label>
                  <Input
                    id="nl-title"
                    value={title}
                    disabled={!editable}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="nl-subject">Subject line</Label>
                  <Input
                    id="nl-subject"
                    value={subject}
                    disabled={!editable}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="nl-schedule">Scheduled for</Label>
                  <Input
                    id="nl-schedule"
                    type="datetime-local"
                    value={scheduledFor}
                    disabled={!editable}
                    onChange={(e) => setScheduledFor(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="nl-sections">Sections (JSON)</Label>
                  <Textarea
                    id="nl-sections"
                    rows={8}
                    className="font-mono text-xs"
                    value={sectionsJson}
                    disabled={!editable}
                    onChange={(e) => setSectionsJson(e.target.value)}
                  />
                </div>
                {editable && (
                  <Button size="sm" onClick={save}>
                    Save edits
                  </Button>
                )}
              </div>

              <Separator />

              {/* Preview + test send */}
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={preview}>
                    <Eye className="mr-1.5 h-3.5 w-3.5" /> Preview
                  </Button>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Label htmlFor="nl-test">Test send to</Label>
                    <Input
                      id="nl-test"
                      type="email"
                      placeholder="you@gradethread.com"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                    />
                  </div>
                  <Button size="sm" variant="outline" onClick={testSend}>
                    <TestTube className="mr-1.5 h-3.5 w-3.5" /> Send test
                  </Button>
                </div>
              </div>

              <Separator />

              {/* Lifecycle actions */}
              <div className="space-y-2">
                <div className="text-sm font-medium">Lifecycle</div>
                <div className="flex flex-wrap gap-2">
                  {issue.status === "draft" && (
                    <Button size="sm" variant="outline" onClick={() => transition("ready_for_qa")}>
                      Run QA → Ready
                    </Button>
                  )}
                  {issue.status === "ready_for_qa" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => transition("awaiting_review")}
                      >
                        Submit for review
                      </Button>
                      <Button size="sm" onClick={() => transition("approved")}>
                        <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Approve
                      </Button>
                    </>
                  )}
                  {issue.status === "awaiting_review" && (
                    <Button size="sm" onClick={() => transition("approved")}>
                      <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Approve
                    </Button>
                  )}
                  {(issue.status === "awaiting_review" ||
                    issue.status === "ready_for_qa" ||
                    issue.status === "approved" ||
                    issue.status === "draft") && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() =>
                        transition("blocked", rejectReason.trim() || undefined)
                      }
                    >
                      <XCircle className="mr-1.5 h-3.5 w-3.5" /> Block / Reject
                    </Button>
                  )}
                  {issue.status === "blocked" && (
                    <Button size="sm" variant="outline" onClick={() => transition("draft")}>
                      Reopen as draft
                    </Button>
                  )}
                  {issue.status === "approved" && (
                    <Button size="sm" onClick={sendNow}>
                      <Send className="mr-1.5 h-3.5 w-3.5" /> Send now
                    </Button>
                  )}
                </div>
                {(issue.status === "awaiting_review" ||
                  issue.status === "approved" ||
                  issue.status === "draft" ||
                  issue.status === "ready_for_qa") && (
                  <Input
                    placeholder="Reason (for block / reject)"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    className="mt-1"
                  />
                )}
                {issue.block_reason && (
                  <p className="text-xs text-red-600">Blocked: {issue.block_reason}</p>
                )}
              </div>

              {/* Send progress + recipients drill-in */}
              {progress && (issue.status === "sending" || issue.status === "sent") && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <div className="text-sm font-medium">
                      Send progress {progress.sending ? "(live)" : ""}
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-center text-xs">
                      <div className="rounded border border-border p-2">
                        <div className="text-base font-bold">{progress.total}</div>
                        <div className="text-muted-foreground">Resolved</div>
                      </div>
                      <div className="rounded border border-border p-2">
                        <div className="text-base font-bold text-green-600">{progress.sent}</div>
                        <div className="text-muted-foreground">Sent</div>
                      </div>
                      <div className="rounded border border-border p-2">
                        <div className="text-base font-bold text-amber-600">{progress.skipped}</div>
                        <div className="text-muted-foreground">Skipped</div>
                      </div>
                      <div className="rounded border border-border p-2">
                        <div className="text-base font-bold text-red-600">{progress.failed}</div>
                        <div className="text-muted-foreground">Failed</div>
                      </div>
                    </div>
                    {Object.keys(progress.skipReasons).length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        Skip reasons:{" "}
                        {Object.entries(progress.skipReasons)
                          .map(([reason, n]) => `${reason} (${n})`)
                          .join(", ")}
                      </div>
                    )}
                    {detail.data && detail.data.recipients.length > 0 && (
                      <div className="max-h-48 overflow-y-auto rounded border border-border">
                        <table className="w-full text-xs">
                          <tbody>
                            {detail.data.recipients.slice(0, 100).map((r) => (
                              <tr key={r.id} className="border-b last:border-0">
                                <td className="px-2 py-1">{r.email}</td>
                                <td className="px-2 py-1">
                                  <Badge variant="outline">{r.status}</Badge>
                                </td>
                                <td className="px-2 py-1 text-muted-foreground">
                                  {r.skip_reason ?? ""}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* HTML preview modal */}
      <Dialog open={!!previewHtml} onOpenChange={(o) => !o && setPreviewHtml(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Rendered preview</DialogTitle>
          </DialogHeader>
          {previewHtml && (
            <iframe
              title="Newsletter preview"
              srcDoc={previewHtml}
              className="h-[70vh] w-full rounded border border-border"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
