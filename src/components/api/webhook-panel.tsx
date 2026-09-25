// Account webhook settings (extensions-api plan, action 5). The developers page
// said the webhook could be set "in your dashboard", and nothing here did it:
// no URL field, no way to send a test, and no delivery history, so a customer
// could not tell whether their endpoint received anything.
//
// Backed by the session routes /api/keys/webhook* (routes/api-keys.ts), which
// share lib/account-webhook.ts with the public PATCH /api/v1/webhook. The
// signing secret is shown ONCE, when the endpoint is created or the secret is
// rotated; the server never returns it again.
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, RefreshCw, RotateCcw, Send, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { edgeFetch } from "@/lib/edge-fetch";
import { useTenantKey } from "@/hooks/use-tenant-key";

export interface WebhookConfig {
  webhook_url: string | null;
  has_signing_secret: boolean;
  secret_created_at: string | null;
  updated_at: string | null;
}

export interface WebhookDeliveryRow {
  event_id: string;
  event_type: string;
  subject_id?: string | null;
  status: "pending" | "running" | "delivered" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  next_attempt_at?: string | null;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at?: string | null;
  created_at: string;
}

interface WebhookAttempt {
  attempt: number;
  success: boolean;
  status_code: number | null;
  error: string | null;
  response_excerpt: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface WebhookDeliveryDetail extends WebhookDeliveryRow {
  payload: Record<string, unknown>;
  header_names: string[];
  attempts_log: WebhookAttempt[];
}

const STATUS_LABEL: Record<WebhookDeliveryRow["status"], string> = {
  pending: "Retrying",
  running: "Sending",
  delivered: "Delivered",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RESENDABLE = new Set<WebhookDeliveryRow["status"]>(["failed", "cancelled"]);
const IN_FLIGHT = new Set<WebhookDeliveryRow["status"]>(["pending", "running"]);

function statusVariant(status: WebhookDeliveryRow["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "delivered") return "default";
  if (status === "failed") return "destructive";
  if (status === "cancelled") return "outline";
  return "secondary";
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "in 3 min", "in 45 s", "now". */
function fromNow(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  return `in ${Math.round(m / 60)} h`;
}

async function readJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json.data as T;
}

interface TestResult {
  outcome: string;
  status_code: number | null;
  duration_ms: number | null;
}

export function WebhookPanel() {
  const queryClient = useQueryClient();
  const tenantKey = useTenantKey();
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"rotate" | "remove" | null>(null);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  // DEV-10 / US-1933: both keys carry the tenant, so a missed cache clear on a
  // workspace switch can never show another workspace's URL or delivery log.
  const configKey = ["api-webhook", tenantKey] as const;
  const config = useQuery<WebhookConfig>({
    queryKey: ["api-webhook", tenantKey],
    queryFn: () => readJson<WebhookConfig>("/api/keys/webhook"),
    enabled: Boolean(tenantKey),
    staleTime: 60 * 1000,
  });
  const deliveries = useQuery<WebhookDeliveryRow[]>({
    queryKey: ["api-webhook-deliveries", tenantKey],
    queryFn: () => readJson<WebhookDeliveryRow[]>("/api/keys/webhook/deliveries?limit=20"),
    enabled: Boolean(tenantKey) && Boolean(config.data?.webhook_url),
    staleTime: 30 * 1000,
    // A row still retrying changes on its own; poll while one exists.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((d) => IN_FLIGHT.has(d.status)) ? 10_000 : false,
  });
  const detail = useQuery<WebhookDeliveryDetail>({
    queryKey: ["api-webhook-delivery", tenantKey, openEvent],
    queryFn: () => readJson<WebhookDeliveryDetail>(`/api/keys/webhook/deliveries/${openEvent}`),
    enabled: Boolean(tenantKey) && Boolean(openEvent),
  });

  useEffect(() => {
    if (config.data) setUrl(config.data.webhook_url ?? "");
  }, [config.data]);

  // A secret, test result or open delivery belongs to the workspace it came
  // from. On a workspace switch none of them may stay on screen under the
  // other workspace's webhook.
  useEffect(() => {
    setSecret(null);
    setTestResult(null);
    setOpenEvent(null);
    setConfirm(null);
    setUrlError(null);
  }, [tenantKey]);

  const saved = config.data?.webhook_url ?? null;
  const pendingCount = (deliveries.data ?? []).filter((d) => IN_FLIGHT.has(d.status)).length;

  function storeConfig(data: Record<string, unknown> | null | undefined) {
    if (!data) return;
    // DEV-09: the signing secret never goes into the query cache. It lives in
    // component state for exactly as long as it is on screen.
    const rest: Record<string, unknown> = { ...data };
    delete rest.signing_secret;
    if (typeof rest.has_signing_secret === "boolean") {
      queryClient.setQueryData(configKey, rest as unknown as WebhookConfig);
    } else {
      void queryClient.invalidateQueries({ queryKey: ["api-webhook"] });
    }
  }

  async function save(next: string | null) {
    setUrlError(null);
    setSaving(true);
    try {
      const res = await edgeFetch("/api/keys/webhook", { method: "PUT", json: { url: next } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A 400 is about the URL, so it belongs next to the field.
        if (res.status === 400) setUrlError(json.error || "That URL was not accepted");
        else toast.error(json.error || "Couldn't save the webhook");
        return;
      }
      // A secret only comes back when this save created the endpoint. Any
      // other save (a URL change, a removal) hides the one on screen.
      setSecret((json.data?.signing_secret as string | undefined) ?? null);
      setTestResult(null);
      storeConfig(json.data);
      void queryClient.invalidateQueries({ queryKey: ["api-webhook-deliveries"] });
      toast.success(next ? "Webhook saved" : "Webhook removed");
    } catch {
      toast.error("Couldn't save the webhook");
    } finally {
      setSaving(false);
    }
  }

  function submitUrl(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || trimmed === (saved ?? "") || saving) return;
    let parsed: URL | null = null;
    try {
      parsed = new URL(trimmed);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:") {
      setUrlError("Use a full https:// address.");
      return;
    }
    void save(trimmed);
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await edgeFetch("/api/keys/webhook/test", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Couldn't send the test event");
        return;
      }
      const outcome = String(json.data?.outcome ?? "");
      if (outcome === "delivered") {
        toast.success("Test event delivered: your endpoint answered with a 2xx");
      } else {
        toast.error("Your endpoint did not accept the test event. See the delivery log below.");
      }
      // The status code and timing live on the attempt row.
      let attempt: WebhookAttempt | undefined;
      const eventId = json.data?.event_id as string | undefined;
      if (eventId) {
        try {
          const d = await readJson<WebhookDeliveryDetail>(`/api/keys/webhook/deliveries/${eventId}`);
          attempt = d?.attempts_log?.[d.attempts_log.length - 1];
        } catch {
          attempt = undefined;
        }
      }
      setTestResult({
        outcome,
        status_code: attempt?.status_code ?? null,
        duration_ms: attempt?.duration_ms ?? null,
      });
      void queryClient.invalidateQueries({ queryKey: ["api-webhook-deliveries"] });
    } catch {
      toast.error("Couldn't send the test event");
    } finally {
      setTesting(false);
    }
  }

  async function rotate() {
    setRotating(true);
    try {
      const res = await edgeFetch("/api/keys/webhook/secret/rotate", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Couldn't rotate the secret");
        return;
      }
      setSecret(json.data.signing_secret as string);
      void queryClient.invalidateQueries({ queryKey: ["api-webhook"] });
      toast.success("New signing secret created. The old one stops working now.");
    } catch {
      toast.error("Couldn't rotate the secret");
    } finally {
      setRotating(false);
    }
  }

  async function resend(eventId: string) {
    setResending(true);
    try {
      const res = await edgeFetch(`/api/keys/webhook/deliveries/${eventId}/redeliver`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Couldn't resend the delivery");
        return;
      }
      if (json.data?.outcome === "delivered") toast.success("Resent: your endpoint answered with a 2xx");
      else toast.error("Resent, but your endpoint did not accept it. It will be retried.");
      void queryClient.invalidateQueries({ queryKey: ["api-webhook-deliveries"] });
      void queryClient.invalidateQueries({ queryKey: ["api-webhook-delivery"] });
    } catch {
      toast.error("Couldn't resend the delivery");
    } finally {
      setResending(false);
    }
  }

  async function copyText(value: string, flag = true) {
    try {
      await navigator.clipboard.writeText(value);
      if (flag) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.success("Copied");
      }
    } catch {
      toast.error("Failed to copy");
    }
  }

  const trimmed = url.trim();
  const dirty = trimmed !== (saved ?? "");
  const openRow = openEvent ? (deliveries.data ?? []).find((d) => d.event_id === openEvent) ?? null : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Webhook className="h-5 w-5" />
          Webhook
        </CardTitle>
        <CardDescription>
          We POST a signed <code className="rounded bg-muted px-1">grade.completed</code> event to
          this URL when a grade finishes, once per grade for your whole account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {config.isError ? (
          <ErrorState
            title="Couldn't load your webhook"
            description="Your webhook settings didn't load. Nothing has changed."
            onRetry={() => void config.refetch()}
            retrying={config.isFetching}
          />
        ) : config.isLoading || !config.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <form className="space-y-2" onSubmit={submitUrl} noValidate>
              <Label htmlFor="webhook-url">Endpoint URL (https)</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="webhook-url"
                  type="url"
                  placeholder="https://example.com/hooks/gradethread"
                  value={url}
                  maxLength={2000}
                  aria-invalid={urlError ? true : undefined}
                  aria-describedby={urlError ? "webhook-url-error" : undefined}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setUrlError(null);
                  }}
                />
                <Button type="submit" disabled={saving || !dirty || !trimmed}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save
                </Button>
                {saved && (
                  <Button type="button" variant="outline" onClick={() => setConfirm("remove")} disabled={saving}>
                    Remove
                  </Button>
                )}
              </div>
              {urlError && (
                <p id="webhook-url-error" className="text-sm text-destructive">{urlError}</p>
              )}
            </form>

            {secret && (
              <div className="space-y-2 rounded-lg bg-muted p-4">
                {/* DEV-09: the live region announces THAT a secret exists, never the secret. */}
                <p role="status" className="text-sm font-medium">New signing secret created</p>
                <p className="text-sm text-muted-foreground">
                  Copy it now and use it to verify each delivery, for example with the SDK's
                  verifyWebhook. You can't see it again, only replace it.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-background px-2 py-1 text-xs">{secret}</code>
                  <Button variant="outline" size="icon" onClick={() => void copyText(secret)} aria-label="Copy signing secret">
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <Button variant="outline" size="sm" onClick={() => setSecret(null)}>
                  I've saved it
                </Button>
              </div>
            )}

            {saved && (
              <>
                {!config.data?.has_signing_secret && !secret && (
                  <p className="text-sm text-destructive">
                    This webhook was set before signing secrets existed, so its deliveries can't be
                    verified. Rotate the secret to get one.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => void sendTest()} disabled={testing}>
                    {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                    Send test event
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => (config.data?.has_signing_secret ? setConfirm("rotate") : void rotate())}
                    disabled={rotating}
                  >
                    {rotating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    {config.data?.has_signing_secret ? "Rotate signing secret" : "Create signing secret"}
                  </Button>
                </div>

                {testResult && (
                  <p className="text-sm" data-testid="webhook-test-result">
                    {testResult.outcome === "delivered" ? "Test delivered" : "Test not accepted"}
                    {testResult.status_code ? `: HTTP ${testResult.status_code}` : ""}
                    {testResult.duration_ms != null ? ` in ${testResult.duration_ms} ms` : ""}.
                    {(testResult.status_code === 401 || testResult.status_code === 403) && (
                      <span className="block text-muted-foreground">
                        A 401 or 403 usually means your endpoint is checking the signature with a
                        different secret. Make sure it uses the current signing secret.
                      </span>
                    )}
                  </p>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">Recent deliveries</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void deliveries.refetch()}
                      disabled={deliveries.isFetching}
                    >
                      <RefreshCw className={deliveries.isFetching ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"} />
                      Refresh
                    </Button>
                  </div>
                  {deliveries.isError ? (
                    <ErrorState
                      title="Couldn't load deliveries"
                      description="The delivery log didn't load."
                      onRetry={() => void deliveries.refetch()}
                      retrying={deliveries.isFetching}
                    />
                  ) : deliveries.isLoading ? (
                    <Skeleton className="h-16 w-full" />
                  ) : !deliveries.data || deliveries.data.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No deliveries yet. Send a test event to check your endpoint.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>When</TableHead>
                            <TableHead>Event</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Attempts</TableHead>
                            <TableHead>Response</TableHead>
                            <TableHead className="w-[1%]" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {deliveries.data.map((d) => (
                            <TableRow key={d.event_id}>
                              <TableCell className="whitespace-nowrap">{when(d.created_at)}</TableCell>
                              <TableCell>
                                <code className="text-xs">{d.event_type}</code>
                                {d.subject_id && (
                                  <span className="block max-w-[12rem] truncate text-xs text-muted-foreground" title={d.subject_id}>
                                    {d.subject_id}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge variant={statusVariant(d.status)}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
                                {d.status === "pending" && d.next_attempt_at && (
                                  <span className="block text-xs text-muted-foreground">
                                    Next try {fromNow(d.next_attempt_at)}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {d.attempts} of {d.max_attempts}
                              </TableCell>
                              <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground" title={d.last_error ?? undefined}>
                                {d.last_status_code ? `HTTP ${d.last_status_code}` : ""}
                                {d.last_error ? `${d.last_status_code ? " - " : ""}${d.last_error}` : ""}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setOpenEvent(d.event_id)}
                                  aria-label={`Details for the ${d.event_type} delivery from ${when(d.created_at)}`}
                                >
                                  Details
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "rotate" ? "Rotate the signing secret?" : "Remove this webhook?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "rotate"
                ? "The old secret stops working now. Deliveries still retrying will be signed with the new one."
                : `Deletes the signing secret and cancels ${pendingCount} pending ${pendingCount === 1 ? "delivery" : "deliveries"}. Re-adding the URL issues a new secret.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action === "rotate") void rotate();
                if (action === "remove") {
                  setSecret(null);
                  void save(null);
                }
              }}
            >
              {confirm === "rotate" ? "Rotate secret" : "Remove webhook"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* DEV-12: one delivery, every attempt, and a way to send it again. */}
      <Sheet open={openEvent !== null} onOpenChange={(open) => { if (!open) setOpenEvent(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{openRow?.event_type ?? detail.data?.event_type ?? "Delivery"}</SheetTitle>
            <SheetDescription>
              Event <code className="text-xs">{openEvent}</code>
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-5 px-4 pb-6">
            {detail.isError ? (
              <ErrorState
                title="Couldn't load this delivery"
                description="The delivery and its attempts didn't load."
                onRetry={() => void detail.refetch()}
                retrying={detail.isFetching}
                hideSupport
              />
            ) : detail.isLoading || !detail.data ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant(detail.data.status)}>
                    {STATUS_LABEL[detail.data.status] ?? detail.data.status}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {detail.data.attempts} of {detail.data.max_attempts} attempts
                  </span>
                  {RESENDABLE.has(detail.data.status) && (
                    <Button
                      size="sm"
                      className="ml-auto"
                      onClick={() => void resend(detail.data!.event_id)}
                      disabled={resending}
                    >
                      {resending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
                      Resend
                    </Button>
                  )}
                </div>

                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Attempts</h4>
                  {detail.data.attempts_log.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No attempts recorded yet.</p>
                  ) : (
                    <ol className="space-y-2">
                      {detail.data.attempts_log.map((a, i) => (
                        <li key={`${a.created_at}-${i}`} className="rounded-md bg-muted p-3 text-sm">
                          <p className="font-medium">
                            {a.success ? "Delivered" : "Failed"}
                            {a.status_code ? `: HTTP ${a.status_code}` : ": no response"}
                            {a.duration_ms != null ? ` in ${a.duration_ms} ms` : ""}
                          </p>
                          <p className="text-xs text-muted-foreground">{when(a.created_at)}</p>
                          {a.response_excerpt && (
                            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs">
                              {a.response_excerpt}
                            </pre>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium">Payload</h4>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyText(JSON.stringify(detail.data!.payload, null, 2), false)}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy JSON
                    </Button>
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
                    {JSON.stringify(detail.data.payload, null, 2)}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    Headers sent: {detail.data.header_names.join(", ")}
                  </p>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}
