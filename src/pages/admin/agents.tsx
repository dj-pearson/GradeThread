// US-1590 / AGENTIC-OS Module C — Mission Control.
//
// One admin surface for the agent fleet: registry cards (status, autonomy,
// last run, 7-day spend, pending proposals) with per-agent + global kill
// switches; a run history list with a transcript viewer; and a proposals inbox
// (approve/reject with a decided-history tab). Mirrors the ops-jobs.tsx
// conventions (edgeFetch + useQuery reads, plain async mutations + sonner).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  Bot,
  RefreshCw,
  Loader2,
  Pause,
  Play,
  Inbox,
  ListChecks,
  Check,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  key: string;
  name: string;
  module_letter: string | null;
  status: string;
  autonomy: Record<string, number>;
  config: Record<string, unknown>;
  spend_7d_usd: number;
  pending_proposals: number;
  daily_cap_usd: number;
  last_run: { status: string; started_at: string | null; finished_at: string | null } | null;
}
interface BriefEnvelope {
  model: {
    headline: string;
    allQuiet: boolean;
    fleetEmpty: boolean;
    totalRuns: number;
    totalSpendUsd: number;
    pending: unknown[];
    anomalies: unknown[];
  };
  generated_at: string;
}
interface RunRow {
  id: string;
  agent_id: string;
  trigger: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error: string | null;
}
interface StepRow {
  id: string;
  seq: number;
  step_type: string;
  name: string | null;
  input: unknown;
  output: unknown;
  duration_ms: number | null;
}
interface ProposalRow {
  id: string;
  agent_id: string;
  action_class: string;
  title: string;
  summary: string | null;
  evidence: unknown;
  status: string;
  expires_at: string | null;
  created_at: string;
  decided_by: string | null;
  decide_reason: string | null;
  result: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function relativeAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const suffix = ms < 0 ? "" : " ago";
  const prefix = ms < 0 ? "in " : "";
  if (abs < 60_000) return `${prefix}${Math.round(abs / 1000)}s${suffix}`;
  if (abs < 3_600_000) return `${prefix}${Math.round(abs / 60_000)}m${suffix}`;
  if (abs < 86_400_000) return `${prefix}${Math.round(abs / 3_600_000)}h${suffix}`;
  return `${prefix}${Math.round(abs / 86_400_000)}d${suffix}`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded" || status === "executed" || status === "approved" || status === "enabled") {
    return "default";
  }
  if (status === "failed" || status === "timeout" || status === "rejected") return "destructive";
  if (status === "paused" || status === "expired") return "outline";
  return "secondary";
}

const LEVEL_LABEL = ["L0 observe", "L1 propose", "L2 act", "L3 silent"];

// ── Page ─────────────────────────────────────────────────────────────────────

export function AdminAgentsPage() {
  const visible = useDocumentVisible();
  const [tab, setTab] = useState("agents");

  const agentsQuery = useQuery({
    queryKey: ["admin-agents"],
    queryFn: () => getJson<{ agents: AgentRow[] }>("/api/admin/agents/agents"),
    refetchInterval: visible ? 30_000 : false,
  });
  const pauseQuery = useQuery({
    queryKey: ["admin-agents-global-pause"],
    queryFn: () => getJson<{ paused: boolean }>("/api/admin/agents/global-pause"),
    refetchInterval: visible ? 30_000 : false,
  });
  const briefQuery = useQuery({
    queryKey: ["admin-agents-brief"],
    queryFn: () => getJson<{ brief: BriefEnvelope | null }>("/api/admin/agents/brief"),
    staleTime: 5 * 60_000,
  });
  // US-1607: weekly agent-eval pass rates (from the agent-eval cron).
  const evalQuery = useQuery({
    queryKey: ["admin-agent-evals"],
    queryFn: () =>
      getJson<{
        results:
          | {
            ran_at?: string;
            failed?: number;
            agents?: Array<{ agentKey: string; passed: number; total: number; ok: boolean }>;
          }
          | null;
      }>("/api/admin/agents/agent-evals"),
    staleTime: 5 * 60_000,
  });

  const [busy, setBusy] = useState<string | null>(null);

  async function toggleGlobalPause(next: boolean) {
    setBusy("global");
    try {
      const res = await edgeFetch("/api/admin/agents/global-pause", {
        method: "POST",
        json: { paused: next },
        silentGate: true,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Failed to update");
        return;
      }
      toast.success(next ? "All agents paused" : "Agents resumed");
      void pauseQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy(null);
    }
  }

  async function setAgentPaused(agent: AgentRow, paused: boolean) {
    setBusy(agent.id);
    try {
      const res = await edgeFetch(
        `/api/admin/agents/agents/${agent.id}/${paused ? "pause" : "resume"}`,
        { method: "POST", json: {}, silentGate: true },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Failed to update agent");
        return;
      }
      toast.success(`${agent.key} ${paused ? "paused" : "resumed"}`);
      void agentsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update agent");
    } finally {
      setBusy(null);
    }
  }

  const globallyPaused = pauseQuery.data?.paused ?? false;
  const agents = agentsQuery.data?.agents ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Bot}
        title="Mission Control"
        subtitle="Supervise the agent fleet — status, transcripts, and the proposal inbox."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void agentsQuery.refetch();
              void pauseQuery.refetch();
            }}
            disabled={agentsQuery.isFetching}
          >
            {agentsQuery.isFetching
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        }
      />

      {/* Global kill switch */}
      <Card className={globallyPaused ? "border-destructive" : undefined}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Global pause</CardTitle>
              <CardDescription>
                Halt every agent run and proposal execution instantly.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              {globallyPaused && <Badge variant="destructive">PAUSED</Badge>}
              <Switch
                aria-label="Pause all agents"
                checked={globallyPaused}
                disabled={busy === "global" || pauseQuery.isLoading}
                onCheckedChange={(v) => void toggleGlobalPause(v)}
              />
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Latest Daily Operator Brief (US-1592) */}
      {briefQuery.data?.brief && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Latest operator brief</CardTitle>
              <span className="text-xs text-muted-foreground">{briefQuery.data.brief.generated_at}</span>
            </div>
            <CardDescription>{briefQuery.data.brief.model.headline}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">{briefQuery.data.brief.model.totalRuns} runs</Badge>
            <Badge variant="secondary">${briefQuery.data.brief.model.totalSpendUsd.toFixed(2)}</Badge>
            <Badge variant={briefQuery.data.brief.model.pending.length ? "default" : "outline"}>
              {briefQuery.data.brief.model.pending.length} pending
            </Badge>
            <Badge variant={briefQuery.data.brief.model.anomalies.length ? "destructive" : "outline"}>
              {briefQuery.data.brief.model.anomalies.length} anomalies
            </Badge>
          </CardContent>
        </Card>
      )}

      {/* Agent eval pass rates (US-1607) */}
      {evalQuery.data?.results?.agents && evalQuery.data.results.agents.length > 0 && (
        <Card className={evalQuery.data.results.failed ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Agent evals</CardTitle>
              <span className="text-xs text-muted-foreground">
                {evalQuery.data.results.ran_at ?? ""}
              </span>
            </div>
            <CardDescription>
              Golden-scenario pass rate per agent (weekly). A failing agent is blocked from
              autonomy promotion.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-xs">
            {evalQuery.data.results.agents.map((a) => (
              <Badge key={a.agentKey} variant={a.ok ? "outline" : "destructive"}>
                {a.agentKey} {a.passed}/{a.total}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="agents">
            <ListChecks className="mr-1.5 h-4 w-4" /> Agents
          </TabsTrigger>
          <TabsTrigger value="runs">
            <Bot className="mr-1.5 h-4 w-4" /> Runs
          </TabsTrigger>
          <TabsTrigger value="proposals">
            <Inbox className="mr-1.5 h-4 w-4" /> Proposals
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents" className="mt-4">
          {agentsQuery.isLoading
            ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-48" />)}
              </div>
            )
            : agentsQuery.isError
            ? (
              /* US-2507: a retryable state, not a dead red line. */
              <ErrorState
                className="py-10"
                title="Couldn't load agents"
                description={
                  (agentsQuery.error as Error)?.message ??
                  "The registry is still there — we just couldn't fetch it right now."
                }
                onRetry={() => void agentsQuery.refetch()}
                retrying={agentsQuery.isFetching}
              />
            )
            : agents.length === 0
            ? (
              <EmptyState
                icon={Bot}
                title="No agents registered yet"
                description="Registered agents will appear here once they're configured."
              />
            )
            : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {agents.map((a) => (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    busy={busy === a.id}
                    onToggle={(paused) => void setAgentPaused(a, paused)}
                  />
                ))}
              </div>
            )}
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <RunsTab agents={agents} visible={visible} />
        </TabsContent>

        <TabsContent value="proposals" className="mt-4">
          <ProposalsTab agents={agents} visible={visible} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Agent card ───────────────────────────────────────────────────────────────

function AgentCard(
  { agent, busy, onToggle }: {
    agent: AgentRow;
    busy: boolean;
    onToggle: (paused: boolean) => void;
  },
) {
  const paused = agent.status === "paused";
  const autonomy = Object.entries(agent.autonomy ?? {});
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">{agent.name || agent.key}</CardTitle>
            <CardDescription className="font-mono text-xs">{agent.key}</CardDescription>
          </div>
          <Badge variant={statusVariant(agent.status)}>{agent.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Autonomy</div>
          {autonomy.length === 0
            ? <span className="text-xs text-muted-foreground">L0 (observe) — default</span>
            : (
              <div className="flex flex-wrap gap-1">
                {autonomy.map(([cls, lvl]) => (
                  <Badge key={cls} variant="secondary" className="text-xs">
                    {cls}: {LEVEL_LABEL[Math.max(0, Math.min(3, Number(lvl) || 0))]}
                  </Badge>
                ))}
              </div>
            )}
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div>
            <span className="text-foreground">Last run:</span>{" "}
            {agent.last_run
              ? <>{agent.last_run.status} · {relativeAge(agent.last_run.started_at)}</>
              : "never"}
          </div>
          <div>
            <span className="text-foreground">Spend:</span> ${agent.spend_7d_usd.toFixed(4)} / 7d
            <span className="text-muted-foreground"> · cap ${agent.daily_cap_usd.toFixed(2)}/day</span>
          </div>
          <div>
            <span className="text-foreground">Pending:</span> {agent.pending_proposals} proposal
            {agent.pending_proposals === 1 ? "" : "s"}
          </div>
        </div>
        <Button
          variant={paused ? "default" : "outline"}
          size="sm"
          className="w-full"
          disabled={busy}
          onClick={() => onToggle(!paused)}
        >
          {busy
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : paused
            ? <Play className="h-3.5 w-3.5" />
            : <Pause className="h-3.5 w-3.5" />}
          {paused ? "Resume" : "Pause"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Runs tab ─────────────────────────────────────────────────────────────────

const RUN_STATUSES = ["all", "succeeded", "failed", "timeout", "skipped", "running", "queued"];

function RunsTab({ agents, visible }: { agents: AgentRow[]; visible: boolean }) {
  const [status, setStatus] = useState("all");
  const [openRun, setOpenRun] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["admin-agent-runs"],
    queryFn: () => getJson<{ runs: RunRow[] }>("/api/admin/agents/runs"),
    refetchInterval: visible ? 30_000 : false,
  });

  const keyById = new Map(agents.map((a) => [a.id, a.key]));
  const runs = (runsQuery.data?.runs ?? []).filter((r) => status === "all" || r.status === status);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {RUN_STATUSES.map((s) => (
          <Button
            key={s}
            variant={status === s ? "default" : "outline"}
            size="sm"
            onClick={() => setStatus(s)}
          >
            {s}
          </Button>
        ))}
      </div>
      <Card>
        <CardContent className="p-0">
          {runsQuery.isLoading
            ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            )
            : runsQuery.isError
            ? (
              <p className="p-8 text-center text-sm text-destructive">
                {(runsQuery.error as Error)?.message ?? "Failed to load runs."}
              </p>
            )
            : runs.length === 0
            ? <p className="p-8 text-center text-sm text-muted-foreground">No runs match this view.</p>
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">
                        {keyById.get(r.agent_id) ?? r.agent_id.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {relativeAge(r.started_at)}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {r.tokens_in + r.tokens_out}
                      </TableCell>
                      <TableCell className="text-right text-xs">${r.cost_usd.toFixed(4)}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setOpenRun(r.id)}>
                          aria-label={`Transcript for ${keyById.get(r.agent_id) ?? r.agent_id.slice(0, 8)}`}
                          Transcript
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>
      <TranscriptDialog runId={openRun} onClose={() => setOpenRun(null)} />
    </div>
  );
}

function TranscriptDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["admin-agent-run", runId],
    queryFn: () => getJson<{ run: RunRow; steps: StepRow[] }>(`/api/admin/agents/runs/${runId}`),
    enabled: !!runId,
  });

  return (
    <Dialog open={!!runId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Run transcript</DialogTitle>
          <DialogDescription>
            {q.data?.run
              ? <>Status {q.data.run.status} · ${q.data.run.cost_usd.toFixed(4)} · {q.data.steps.length} steps</>
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {q.isLoading
          ? <Skeleton className="h-40" />
          : q.isError
          ? <p className="text-sm text-destructive">Failed to load transcript.</p>
          : (
            <ol className="space-y-2">
              {(q.data?.steps ?? []).map((s) => (
                <li key={s.id} className="rounded border p-2 text-xs">
                  <div className="mb-1 flex items-center justify-between">
                    <Badge variant="secondary">{s.step_type}</Badge>
                    <span className="text-muted-foreground">
                      #{s.seq} · {s.duration_ms ?? 0}ms {s.name ? `· ${s.name}` : ""}
                    </span>
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
{JSON.stringify(s.output ?? s.input ?? {}, null, 2)}
                  </pre>
                </li>
              ))}
            </ol>
          )}
      </DialogContent>
    </Dialog>
  );
}

// ── Proposals tab ────────────────────────────────────────────────────────────

function ProposalsTab({ agents, visible }: { agents: AgentRow[]; visible: boolean }) {
  const [view, setView] = useState<"pending" | "history">("pending");
  const [rejecting, setRejecting] = useState<ProposalRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const statusFilter = view === "pending" ? "pending" : "";
  const proposalsQuery = useQuery({
    queryKey: ["admin-agent-proposals", view],
    queryFn: () =>
      getJson<{ proposals: ProposalRow[] }>(
        `/api/admin/agents/proposals${statusFilter ? `?status=${statusFilter}` : ""}`,
      ),
    refetchInterval: visible ? 30_000 : false,
  });

  const keyById = new Map(agents.map((a) => [a.id, a.key]));
  const all = proposalsQuery.data?.proposals ?? [];
  const proposals = view === "history" ? all.filter((p) => p.status !== "pending") : all;

  async function approve(p: ProposalRow) {
    setBusy(p.id);
    try {
      const res = await edgeFetch(`/api/admin/agents/proposals/${p.id}/approve`, {
        method: "POST",
        json: {},
        silentGate: true,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Approve failed");
        return;
      }
      toast.success(`Approved — ${(j as { status?: string }).status ?? "done"}`);
      void proposalsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  }

  async function submitReject() {
    if (!rejecting) return;
    if (!reason.trim()) {
      toast.error("A reason is required to reject.");
      return;
    }
    setBusy(rejecting.id);
    try {
      const res = await edgeFetch(`/api/admin/agents/proposals/${rejecting.id}/reject`, {
        method: "POST",
        json: { reason: reason.trim() },
        silentGate: true,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Reject failed");
        return;
      }
      toast.success("Proposal rejected");
      setRejecting(null);
      setReason("");
      void proposalsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        <Button variant={view === "pending" ? "default" : "outline"} size="sm" onClick={() => setView("pending")}>
          Pending
        </Button>
        <Button variant={view === "history" ? "default" : "outline"} size="sm" onClick={() => setView("history")}>
          History
        </Button>
      </div>

      {proposalsQuery.isLoading
        ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        )
        : proposalsQuery.isError
        ? (
          <p className="p-8 text-center text-sm text-destructive">
            {(proposalsQuery.error as Error)?.message ?? "Failed to load proposals."}
          </p>
        )
        : proposals.length === 0
        ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {view === "pending" ? "No proposals awaiting review." : "No decided proposals yet."}
          </p>
        )
        : (
          <div className="space-y-2">
            {proposals.map((p) => (
              <Card key={p.id}>
                <CardContent className="flex items-start justify-between gap-4 py-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                      <Badge variant="outline" className="font-mono text-xs">
                        {keyById.get(p.agent_id) ?? p.agent_id.slice(0, 8)}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">{p.action_class}</Badge>
                    </div>
                    <div className="font-medium">{p.title}</div>
                    {p.summary && <div className="text-sm text-muted-foreground">{p.summary}</div>}
                    <div className="text-xs text-muted-foreground">
                      Filed {relativeAge(p.created_at)}
                      {p.status === "pending" && p.expires_at
                        ? ` · expires ${relativeAge(p.expires_at)}`
                        : ""}
                      {p.decide_reason ? ` · reason: ${p.decide_reason}` : ""}
                    </div>
                  </div>
                  {p.status === "pending" && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        aria-label={`Approve ${p.title}`}
                        size="sm"
                        disabled={busy === p.id}
                        onClick={() => void approve(p)}
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </Button>
                      <Button
                        aria-label={`Reject ${p.title}`}
                        size="sm"
                        variant="outline"
                        disabled={busy === p.id}
                        onClick={() => {
                          setRejecting(p);
                          setReason("");
                        }}
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

      <Dialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject proposal</DialogTitle>
            <DialogDescription>
              {rejecting?.title} — a reason is required and recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Rejection reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being rejected?"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy === rejecting?.id}
              onClick={() => void submitReject()}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
