import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ShieldAlert,
  AlertTriangle,
  Loader2,
  LockOpen,
  ExternalLink,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";

// US-841: admin abuse & usage monitoring dashboard for the AI Support Assistant.
//
// Surfaces the four monitoring views the owner asked for, all behind the
// admin-MFA-gated /api/admin/support-monitoring endpoints (the page renders
// inside AdminLayout → AdminMfaGate):
//   • Usage & lockouts — today's per-user message/token/escalation rollups vs.
//     the US-836 per-tier caps, plus currently locked-out users with a manual
//     unlock action (audited server-side).
//   • Abuse events — recent support_abuse_events with type/severity filters and
//     a link to the originating conversation in the support inbox.
//   • Flagged messages — US-829 flagged assistant/user messages for review.
//   • Thresholds — the active US-836 caps for reference.

type FlipdeskPlan = "free" | "starter" | "pro" | "business";

interface Thresholds {
  perMinuteMessageCap: Record<FlipdeskPlan, number>;
  perDayMessageCap: Record<FlipdeskPlan, number>;
  perDayTokenCap: Record<FlipdeskPlan, number>;
  highSeverityLockThreshold: number;
  cooldownLadderMs: number[];
}

interface UsageRow {
  user_id: string;
  email: string | null;
  name: string | null;
  plan: FlipdeskPlan;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  escalations: number;
  per_minute_cap: number;
  message_cap: number;
  token_cap: number;
  locked_until: string | null;
}

interface LockoutRow {
  user_id: string;
  email: string | null;
  name: string | null;
  plan: FlipdeskPlan;
  locked_until: string | null;
  lockout_count: number;
}

interface UsageResponse {
  thresholds: Thresholds;
  usage: UsageRow[];
  lockouts: LockoutRow[];
}

interface AbuseEvent {
  id: string;
  user_id: string;
  conversation_id: string | null;
  type: string;
  severity: "low" | "medium" | "high";
  detail: string | null;
  created_at: string;
  user_email: string | null;
}

interface FlaggedMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  flag_reason: string | null;
  created_at: string;
  user_id: string | null;
  user_email: string | null;
  subject: string | null;
}

interface MetricsResponse {
  windowDays: number;
  truncated: boolean;
  deflection: {
    total: number;
    escalated: number;
    deflected: number;
    deflectionRate: number;
  };
  escalation: {
    byTrigger: Record<string, number>;
    topReasons: Array<{ reason: string; count: number }>;
  };
  topTopics: Array<{ topic: string; count: number }>;
  cost: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    conversationCount: number;
    topConversations: Array<{
      conversation_id: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>;
  };
}

const ABUSE_TYPES = [
  "jailbreak_attempt",
  "prompt_injection",
  "flood",
  "policy_violation",
  "repeated_failure",
  "scope_probe",
] as const;

const SEVERITY_STYLES: Record<AbuseEvent["severity"], string> = {
  high: "bg-brand-red/15 text-brand-red-text",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
};

const PLANS: FlipdeskPlan[] = ["free", "starter", "pro", "business"];

// Compact relative time (e.g. "3m ago", "2h ago", "5d ago").
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Absolute time for a future lockout expiry.
function untilTime(iso: string | null): string {
  if (!iso) return "—";
  const when = new Date(iso);
  if (!Number.isFinite(when.getTime())) return "—";
  return when.toLocaleString();
}

function humanType(type: string): string {
  return type.replace(/_/g, " ");
}

// Format a USD cost with enough precision to be meaningful at low volume.
function usd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  return `$${amount.toFixed(2)}`;
}

// A cell that warns (red) when a usage value is at/over its cap.
function CapCell({ value, cap }: { value: number; cap: number }) {
  const over = cap > 0 && value >= cap;
  return (
    <span className={over ? "font-semibold text-brand-red-text" : ""}>
      {value.toLocaleString()}
      <span className="text-muted-foreground"> / {cap.toLocaleString()}</span>
    </span>
  );
}

export function AdminMonitoringPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  const usageQuery = useQuery({
    queryKey: ["admin-monitoring", "usage"],
    queryFn: async (): Promise<UsageResponse> => {
      const res = await edgeFetch("/api/admin/support-monitoring/usage");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load usage");
      return json as UsageResponse;
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });

  const abuseQuery = useQuery({
    queryKey: ["admin-monitoring", "abuse", typeFilter, severityFilter],
    queryFn: async (): Promise<AbuseEvent[]> => {
      const params = new URLSearchParams();
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (severityFilter !== "all") params.set("severity", severityFilter);
      const qs = params.toString();
      const res = await edgeFetch(
        `/api/admin/support-monitoring/abuse-events${qs ? `?${qs}` : ""}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load abuse events");
      return (json.events ?? []) as AbuseEvent[];
    },
    staleTime: 30 * 1000,
  });

  const flaggedQuery = useQuery({
    queryKey: ["admin-monitoring", "flagged"],
    queryFn: async (): Promise<FlaggedMessage[]> => {
      const res = await edgeFetch(
        "/api/admin/support-monitoring/flagged-messages",
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load flagged messages");
      return (json.messages ?? []) as FlaggedMessage[];
    },
    staleTime: 30 * 1000,
  });

  const metricsQuery = useQuery({
    queryKey: ["admin-monitoring", "metrics"],
    queryFn: async (): Promise<MetricsResponse> => {
      const res = await edgeFetch("/api/admin/support-monitoring/metrics");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load metrics");
      return json as MetricsResponse;
    },
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const unlockMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await edgeFetch("/api/admin/support-monitoring/unlock", {
        method: "POST",
        json: { userId },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to unlock user");
      return json;
    },
    onSuccess: () => {
      toast.success("User unlocked.");
      queryClient.invalidateQueries({ queryKey: ["admin-monitoring", "usage"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to unlock user");
    },
  });

  const thresholds = usageQuery.data?.thresholds;
  const usage = usageQuery.data?.usage ?? [];
  const lockouts = usageQuery.data?.lockouts ?? [];
  const abuseEvents = abuseQuery.data ?? [];
  const flagged = flaggedQuery.data ?? [];
  const metrics = metricsQuery.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assistant monitoring"
        subtitle="Abuse signals, per-user usage, lockouts and flagged messages for the AI support assistant."
        icon={ShieldAlert}
      />

      {/* Active thresholds (US-836) for reference. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active limits (per plan)</CardTitle>
        </CardHeader>
        <CardContent>
          {/* US-2507: isError first — `!thresholds` is also true on a failed
              load, so without this the skeleton would never resolve. */}
          {usageQuery.isError
            ? (
              <ErrorState
                className="py-6"
                title="Couldn't load the active limits"
                description="They're still enforced — we just couldn't fetch them right now."
                onRetry={() => void usageQuery.refetch()}
                retrying={usageQuery.isFetching}
              />
            )
            : usageQuery.isLoading || !thresholds
            ? <Skeleton className="h-24 w-full" />
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Msgs / min</TableHead>
                    <TableHead className="text-right">Msgs / day</TableHead>
                    <TableHead className="text-right">Tokens / day</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {PLANS.map((plan) => (
                    <TableRow key={plan}>
                      <TableCell className="capitalize font-medium">
                        {plan}
                      </TableCell>
                      <TableCell className="text-right">
                        {thresholds.perMinuteMessageCap[plan]}
                      </TableCell>
                      <TableCell className="text-right">
                        {thresholds.perDayMessageCap[plan]}
                      </TableCell>
                      <TableCell className="text-right">
                        {thresholds.perDayTokenCap[plan].toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          {thresholds && (
            <p className="mt-3 text-xs text-muted-foreground">
              Lockout triggers after {thresholds.highSeverityLockThreshold}{" "}
              high-severity abuse events within an hour; cooldown escalates with
              each repeat offense.
            </p>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="metrics">
        <TabsList>
          <TabsTrigger value="metrics">Metrics &amp; cost</TabsTrigger>
          <TabsTrigger value="usage">Usage &amp; lockouts</TabsTrigger>
          <TabsTrigger value="abuse">Abuse events</TabsTrigger>
          <TabsTrigger value="flagged">Flagged messages</TabsTrigger>
        </TabsList>

        {/* ── Metrics & cost (US-842) ──────────────────────────────────────── */}
        <TabsContent value="metrics" className="space-y-6">
          {metricsQuery.isLoading
            ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            )
            : metricsQuery.isError || !metrics
            ? (
              <div className="flex items-center gap-2 p-6 text-sm text-brand-red-text">
                <AlertTriangle className="h-4 w-4" />
                {(metricsQuery.error as Error)?.message ?? "Failed to load metrics."}
              </div>
            )
            : (
              <>
                <p className="text-sm text-muted-foreground">
                  Trailing {metrics.windowDays} days.{" "}
                  {metrics.truncated &&
                    "Showing a capped sample — totals are a lower bound."}
                </p>

                {/* Headline tiles. */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Deflection rate
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-3xl font-bold">
                        {Math.round(metrics.deflection.deflectionRate * 100)}%
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {metrics.deflection.deflected} of {metrics.deflection.total}{" "}
                        bot-resolved
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Escalated to human
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-3xl font-bold">
                        {metrics.deflection.escalated}
                      </div>
                      <p className="text-xs text-muted-foreground">conversations</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Estimated cost
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-3xl font-bold">
                        {usd(metrics.cost.totalCostUsd)}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {metrics.cost.conversationCount} conversations
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Tokens (in / out)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">
                        {metrics.cost.totalInputTokens.toLocaleString()} /{" "}
                        {metrics.cost.totalOutputTokens.toLocaleString()}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        ~{usd(
                          metrics.cost.conversationCount > 0
                            ? metrics.cost.totalCostUsd /
                              metrics.cost.conversationCount
                            : 0,
                        )} / conversation
                      </p>
                    </CardContent>
                  </Card>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  {/* Escalation breakdown. */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Escalation reasons</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(metrics.escalation.byTrigger).length === 0
                          ? (
                            <span className="text-sm text-muted-foreground">
                              No escalations in this window.
                            </span>
                          )
                          : Object.entries(metrics.escalation.byTrigger).map((
                            [trigger, count],
                          ) => (
                            <Badge key={trigger} variant="secondary">
                              {humanType(trigger)}: {count}
                            </Badge>
                          ))}
                      </div>
                      {metrics.escalation.topReasons.length > 0 && (
                        <ul className="space-y-1 text-sm">
                          {metrics.escalation.topReasons.map((r) => (
                            <li
                              key={r.reason}
                              className="flex items-center justify-between gap-2"
                            >
                              <span className="truncate text-muted-foreground">
                                {r.reason}
                              </span>
                              <span className="font-medium">{r.count}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>

                  {/* Top topics (tool usage). */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Top topics</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {metrics.topTopics.length === 0
                        ? (
                          <p className="text-sm text-muted-foreground">
                            No tool activity in this window.
                          </p>
                        )
                        : (
                          <ul className="space-y-1 text-sm">
                            {metrics.topTopics.map((t) => (
                              <li
                                key={t.topic}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="text-muted-foreground">
                                  {t.topic}
                                </span>
                                <span className="font-medium">{t.count}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                    </CardContent>
                  </Card>
                </div>

                {/* Highest-cost conversations. */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Highest-cost conversations
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {metrics.cost.topConversations.length === 0
                      ? (
                        <p className="p-8 text-center text-sm text-muted-foreground">
                          No assistant turns in this window.
                        </p>
                      )
                      : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Conversation</TableHead>
                              <TableHead className="text-right">Tokens</TableHead>
                              <TableHead className="text-right">Est. cost</TableHead>
                              <TableHead className="text-right">Open</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {metrics.cost.topConversations.map((row) => (
                              <TableRow key={row.conversation_id}>
                                <TableCell className="font-mono text-xs">
                                  {row.conversation_id.slice(0, 8)}
                                </TableCell>
                                <TableCell className="text-right text-sm">
                                  {(row.input_tokens + row.output_tokens)
                                    .toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right text-sm font-medium">
                                  {usd(row.cost_usd)}
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button
                                  aria-label={`Open conversation ${row.conversation_id.slice(0, 8)}`}
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      navigate(
                                        `/admin/support/${row.conversation_id}`,
                                      )}
                                  >
                                    Open
                                    <ExternalLink className="ml-1 h-3 w-3" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                  </CardContent>
                </Card>
              </>
            )}
        </TabsContent>

        {/* ── Usage & lockouts ─────────────────────────────────────────────── */}
        <TabsContent value="usage" className="space-y-6">
          {lockouts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-brand-red-text">
                  <AlertTriangle className="h-4 w-4" />
                  Currently locked out ({lockouts.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Locked until</TableHead>
                      <TableHead className="text-right">Lockouts</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lockouts.map((row) => (
                      <TableRow key={row.user_id}>
                        <TableCell className="text-sm">
                          {row.email ?? row.user_id.slice(0, 8)}
                        </TableCell>
                        <TableCell className="capitalize">{row.plan}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          {untilTime(row.locked_until)}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.lockout_count}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={unlockMutation.isPending}
                            onClick={() => unlockMutation.mutate(row.user_id)}
                          >
                            {unlockMutation.isPending &&
                                unlockMutation.variables === row.user_id
                              ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                              : <LockOpen className="mr-1 h-4 w-4" />}
                            Unlock
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Today's usage by user</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {usageQuery.isLoading
                ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                )
                : usageQuery.isError
                ? (
                  <div className="flex items-center gap-2 p-6 text-sm text-brand-red-text">
                    <AlertTriangle className="h-4 w-4" />
                    {(usageQuery.error as Error)?.message ?? "Failed to load."}
                  </div>
                )
                : usage.length === 0
                ? (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    No assistant usage recorded today.
                  </p>
                )
                : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Plan</TableHead>
                        <TableHead className="text-right">Messages</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Escalations</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {usage.map((row) => (
                        <TableRow key={row.user_id}>
                          <TableCell className="text-sm">
                            {row.email ?? row.user_id.slice(0, 8)}
                          </TableCell>
                          <TableCell className="capitalize">{row.plan}</TableCell>
                          <TableCell className="text-right">
                            <CapCell value={row.messages} cap={row.message_cap} />
                          </TableCell>
                          <TableCell className="text-right">
                            <CapCell
                              value={row.total_tokens}
                              cap={row.token_cap}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            {row.escalations}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Abuse events ─────────────────────────────────────────────────── */}
        <TabsContent value="abuse" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger aria-label="Filter abuse events by type" className="w-52">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {ABUSE_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="capitalize">
                    {humanType(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={severityFilter} onValueChange={setSeverityFilter}>
              <SelectTrigger aria-label="Filter abuse events by severity" className="w-40">
                <SelectValue placeholder="All severities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All severities</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card>
            <CardContent className="p-0">
              {abuseQuery.isLoading
                ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                )
                : abuseQuery.isError
                ? (
                  <div className="flex items-center gap-2 p-6 text-sm text-brand-red-text">
                    <AlertTriangle className="h-4 w-4" />
                    {(abuseQuery.error as Error)?.message ?? "Failed to load."}
                  </div>
                )
                : abuseEvents.length === 0
                ? (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    No abuse events for this filter.
                  </p>
                )
                : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Severity</TableHead>
                        <TableHead>User</TableHead>
                        <TableHead>Detail</TableHead>
                        <TableHead>When</TableHead>
                        <TableHead className="text-right">Conversation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {abuseEvents.map((ev) => (
                        <TableRow key={ev.id}>
                          <TableCell className="capitalize font-medium">
                            {humanType(ev.type)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="secondary"
                              className={SEVERITY_STYLES[ev.severity]}
                            >
                              {ev.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">
                            {ev.user_email ?? ev.user_id.slice(0, 8)}
                          </TableCell>
                          <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                            {ev.detail ?? "—"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {relativeTime(ev.created_at)}
                          </TableCell>
                          <TableCell className="text-right">
                            {ev.conversation_id
                              ? (
                                <Button
                                aria-label={`Open conversation ${ev.conversation_id}`}
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    navigate(
                                      `/admin/support/${ev.conversation_id}`,
                                    )}
                                >
                                  Open
                                  <ExternalLink className="ml-1 h-3 w-3" />
                                </Button>
                              )
                              : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Flagged messages ─────────────────────────────────────────────── */}
        <TabsContent value="flagged">
          <Card>
            <CardContent className="p-0">
              {flaggedQuery.isLoading
                ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                )
                : flaggedQuery.isError
                ? (
                  <div className="flex items-center gap-2 p-6 text-sm text-brand-red-text">
                    <AlertTriangle className="h-4 w-4" />
                    {(flaggedQuery.error as Error)?.message ?? "Failed to load."}
                  </div>
                )
                : flagged.length === 0
                ? (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    No flagged messages.
                  </p>
                )
                : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Message</TableHead>
                        <TableHead>When</TableHead>
                        <TableHead className="text-right">Conversation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {flagged.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="text-sm">
                            {m.user_email ??
                              (m.user_id ? m.user_id.slice(0, 8) : "—")}
                          </TableCell>
                          <TableCell className="text-sm text-brand-red-text">
                            {m.flag_reason ?? "flagged"}
                          </TableCell>
                          <TableCell className="max-w-md truncate text-sm text-muted-foreground">
                            {m.content}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {relativeTime(m.created_at)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                navigate(`/admin/support/${m.conversation_id}`)}
                            >
                              Open
                              <ExternalLink className="ml-1 h-3 w-3" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
