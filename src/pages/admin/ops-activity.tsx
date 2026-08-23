import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Activity,
  RefreshCw,
  Loader2,
  CheckCheck,
  Check,
  Send,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

// US-906 — real-time ops activity feed + critical-event alerting.
//
// One operator stream of significant platform events (job failures, AI budget
// kills, fraud signals, billing divergences, maintenance toggles). Filter by
// type/severity/status, acknowledge events, and (super-admin) edit the alert
// channels + send a test event to verify the webhook/email. Config save + test
// are super_admin + a fresh MFA step-up server-side.

type Severity = "info" | "warning" | "critical";
type StatusFilter = "all" | "open" | "acknowledged";

interface OpsEvent {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  source: string | null;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  fanned_out: boolean;
  delivered: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

interface FeedResponse {
  events: OpsEvent[];
  page: number;
  page_size: number;
  total: number;
  critical_unacked: number;
  server_now: string;
}

interface AlertConfig {
  enabled: boolean;
  minSeverity: Severity;
  webhookUrl: string;
  email: string;
  mutedTypes: string[];
}

interface ConfigResponse {
  config: AlertConfig;
  effective: { email: string; webhook_configured: boolean };
  severities: Severity[];
}

interface TestOutcome {
  webhookConfigured: boolean;
  webhookOk: boolean;
  emailConfigured: boolean;
  emailOk: boolean;
}

const SEVERITY_BADGE: Record<Severity, string> = {
  info: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  critical: "bg-brand-red/15 text-brand-red-text",
};

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export function AdminOpsActivityPage() {
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState<Severity | "all">("all");
  // US-2335: ids for the filter row below.
  const severityFilterId = useId();
  const statusFilterId = useId();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState("");

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);
  const [busy, setBusy] = useState(false);

  // Config form state (super-admin).
  const [enabled, setEnabled] = useState<"true" | "false">("true");
  // US-2335: ids for the label/control pairs in this card.
  const fanoutId = useId();
  const minSeverityId = useId();
  const [minSeverity, setMinSeverity] = useState<Severity>("warning");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [email, setEmail] = useState("");
  const [mutedTypes, setMutedTypes] = useState("");
  const [configLoaded, setConfigLoaded] = useState(false);
  const [lastTest, setLastTest] = useState<TestOutcome | null>(null);

  const pageSize = 25;
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize), status });
  if (severity !== "all") params.set("severity", severity);
  if (typeFilter.trim()) params.set("type", typeFilter.trim());

  const feed = useQuery({
    queryKey: ["ops-events", page, severity, status, typeFilter],
    queryFn: () => getJson<FeedResponse>(`/api/admin/ops/events?${params.toString()}`),
    refetchInterval: 30 * 1000,
  });

  useQuery({
    queryKey: ["ops-events-config"],
    queryFn: async () => {
      const data = await getJson<ConfigResponse>("/api/admin/ops/events/config");
      // Hydrate the form once on first load (don't clobber in-progress edits).
      if (!configLoaded) {
        setEnabled(data.config.enabled ? "true" : "false");
        setMinSeverity(data.config.minSeverity);
        setWebhookUrl(data.config.webhookUrl);
        setEmail(data.config.email);
        setMutedTypes(data.config.mutedTypes.join(", "));
        setConfigLoaded(true);
      }
      return data;
    },
    enabled: isSuperAdmin,
  });

  function handleStepUp(retryFn: () => void) {
    setRetry(() => retryFn);
    setStepUpOpen(true);
  }

  async function mutate(
    path: string,
    method: "POST" | "PUT",
    json: unknown,
    okMsg: string,
    onDone?: (body: unknown) => void,
  ) {
    setBusy(true);
    try {
      const res = await edgeFetch(path, { method, json, silentGate: true });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && (j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        handleStepUp(() => void mutate(path, method, json, okMsg, onDone));
        return;
      }
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Request failed");
        return;
      }
      toast.success(okMsg);
      onDone?.(j);
      void feed.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function acknowledge(ev: OpsEvent) {
    void mutate(`/api/admin/ops/events/${ev.id}/acknowledge`, "POST", undefined, "Event acknowledged");
  }

  function acknowledgeAll() {
    void mutate("/api/admin/ops/events/acknowledge-all", "POST", undefined, "Critical events cleared");
  }

  function saveConfig() {
    const muted = mutedTypes
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    void mutate(
      "/api/admin/ops/events/config",
      "PUT",
      {
        enabled: enabled === "true",
        min_severity: minSeverity,
        webhook_url: webhookUrl.trim(),
        email: email.trim(),
        muted_types: muted,
      },
      "Alert config saved",
    );
  }

  function sendTest() {
    void mutate(
      "/api/admin/ops/events/test",
      "POST",
      {},
      "Test event sent",
      (body) => setLastTest((body as { outcome?: TestOutcome })?.outcome ?? null),
    );
  }

  const events = feed.data?.events ?? [];
  const total = feed.data?.total ?? 0;
  const criticalUnacked = feed.data?.critical_unacked ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity Feed"
        subtitle="Live stream of significant platform events. Critical events route to the configured alert channels."
        icon={Activity}
        actions={
          <Button variant="outline" size="sm" onClick={() => void feed.refetch()} disabled={feed.isFetching}>
            {feed.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        }
      />

      {/* Unacknowledged critical banner. */}
      {criticalUnacked > 0 && (
        <Card className="border-brand-red/40">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-5 w-5 text-brand-red-text" />
              <span>
                <strong>{criticalUnacked}</strong> unacknowledged critical event
                {criticalUnacked === 1 ? "" : "s"}.
              </span>
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={acknowledgeAll}>
              <CheckCheck className="h-3.5 w-3.5" /> Acknowledge all
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Alert channel config — super-admin only. */}
      {isSuperAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Alert channels &amp; routing</CardTitle>
            <CardDescription>
              Events at or above the minimum severity (and not muted) fan out to these channels.
              Saving and sending a test require a fresh second factor.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={fanoutId}>Fan-out</Label>
                <Select value={enabled} onValueChange={(v) => setEnabled(v as "true" | "false")}>
                  <SelectTrigger id={fanoutId}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Enabled</SelectItem>
                    <SelectItem value="false">Disabled (feed-only)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={minSeverityId}>Minimum severity to alert</Label>
                <Select value={minSeverity} onValueChange={(v) => setMinSeverity(v as Severity)}>
                  <SelectTrigger id={minSeverityId}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">info</SelectItem>
                    <SelectItem value="warning">warning</SelectItem>
                    <SelectItem value="critical">critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="oa-webhook-url-slackpagerdutygeneric">Webhook URL (Slack/PagerDuty/generic)</Label>
                <Input id="oa-webhook-url-slackpagerdutygeneric"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/…  (blank = MONITOR_ALERT_WEBHOOK)"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oa-alert-email">Alert email</Label>
                <Input id="oa-alert-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ops@…  (blank = MONITOR_ALERT_EMAIL / SMTP_ADMIN_EMAIL)"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oa-muted-types-commaseparated">Muted types (comma-separated)</Label>
              <Input id="oa-muted-types-commaseparated"
                value={mutedTypes}
                onChange={(e) => setMutedTypes(e.target.value)}
                placeholder="job.failed, maintenance.updated"
              />
              <p className="text-xs text-muted-foreground">
                Muted types are still recorded to the feed but never fan out.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={saveConfig} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Save config
              </Button>
              <Button variant="outline" onClick={sendTest} disabled={busy}>
                <Send className="h-4 w-4" /> Send test event
              </Button>
              {lastTest && (
                <span className="text-xs text-muted-foreground">
                  Test —{" "}
                  webhook: {lastTest.webhookConfigured ? (lastTest.webhookOk ? "✅ delivered" : "❌ failed") : "not configured"};{" "}
                  email: {lastTest.emailConfigured ? (lastTest.emailOk ? "✅ delivered" : "❌ failed") : "not configured"}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={severityFilterId}>Severity</Label>
          <Select value={severity} onValueChange={(v) => { setSeverity(v as Severity | "all"); setPage(1); }}>
            <SelectTrigger className="w-36" id={severityFilterId}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="info">info</SelectItem>
              <SelectItem value="warning">warning</SelectItem>
              <SelectItem value="critical">critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={statusFilterId}>Status</Label>
          <Select value={status} onValueChange={(v) => { setStatus(v as StatusFilter); setPage(1); }}>
            <SelectTrigger className="w-40" id={statusFilterId}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="open">Unacknowledged</SelectItem>
              <SelectItem value="acknowledged">Acknowledged</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="oa-type-contains" className="text-xs">Type contains</Label>
          <Input id="oa-type-contains"
            className="w-48"
            value={typeFilter}
            onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
            placeholder="e.g. job.failed"
          />
        </div>
      </div>

      {/* Feed. */}
      {feed.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : feed.isError ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-destructive">
            {(feed.error as Error)?.message ?? "Failed to load the activity feed."}
          </CardContent>
        </Card>
      ) : events.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No events match these filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {events.map((ev) => (
            <Card key={ev.id} className={ev.severity === "critical" && !ev.acknowledged_at ? "border-brand-red/40" : undefined}>
              <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[ev.severity]}`}>
                      {ev.severity}
                    </span>
                    <Badge variant="outline" className="font-mono text-[11px]">{ev.type}</Badge>
                    {ev.source && <span className="text-xs text-muted-foreground">{ev.source}</span>}
                    {ev.fanned_out && (
                      <span className="text-xs text-muted-foreground">
                        {ev.delivered ? "· alerted" : "· alert failed"}
                      </span>
                    )}
                    {ev.acknowledged_at && (
                      <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Acknowledged
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium">{ev.title}</p>
                  {Object.keys(ev.payload ?? {}).length > 0 && (
                    <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-[11px] text-muted-foreground">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  )}
                  <p className="text-xs text-muted-foreground">{new Date(ev.created_at).toLocaleString()}</p>
                </div>
                {!ev.acknowledged_at && (
                  <div className="flex shrink-0">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => acknowledge(ev)}>
                    aria-label={`Acknowledge ${ev.title}`}
                      <Check className="h-3.5 w-3.5" /> Acknowledge
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {/* Pagination. */}
          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-muted-foreground">
              {total} event{total === 1 ? "" : "s"} · page {page} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || feed.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages || feed.isFetching} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}
