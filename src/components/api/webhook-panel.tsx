// Account webhook settings (extensions-api plan, action 5). The developers page
// said the webhook could be set "in your dashboard", and nothing here did it:
// no URL field, no way to send a test, and no delivery history, so a customer
// could not tell whether their endpoint received anything.
//
// Backed by the session routes /api/keys/webhook* (routes/api-keys.ts), which
// share lib/account-webhook.ts with the public PATCH /api/v1/webhook. The
// signing secret is shown ONCE, when the endpoint is created or the secret is
// rotated; the server never returns it again.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, RefreshCw, Send, Webhook } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { edgeFetch } from "@/lib/edge-fetch";

export interface WebhookConfig {
  webhook_url: string | null;
  has_signing_secret: boolean;
  secret_created_at: string | null;
  updated_at: string | null;
}

export interface WebhookDeliveryRow {
  event_id: string;
  event_type: string;
  status: "pending" | "running" | "delivered" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<WebhookDeliveryRow["status"], string> = {
  pending: "Retrying",
  running: "Sending",
  delivered: "Delivered",
  failed: "Failed",
  cancelled: "Cancelled",
};

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

async function readJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json.data as T;
}

export function WebhookPanel() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const config = useQuery<WebhookConfig>({
    queryKey: ["api-webhook"],
    queryFn: () => readJson<WebhookConfig>("/api/keys/webhook"),
    staleTime: 60 * 1000,
  });
  const deliveries = useQuery<WebhookDeliveryRow[]>({
    queryKey: ["api-webhook-deliveries"],
    queryFn: () => readJson<WebhookDeliveryRow[]>("/api/keys/webhook/deliveries?limit=20"),
    enabled: Boolean(config.data?.webhook_url),
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    if (config.data) setUrl(config.data.webhook_url ?? "");
  }, [config.data]);

  const saved = config.data?.webhook_url ?? null;

  async function save(next: string | null) {
    setSaving(true);
    try {
      const res = await edgeFetch("/api/keys/webhook", { method: "PUT", json: { url: next } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Couldn't save the webhook");
        return;
      }
      if (json.data?.signing_secret) setSecret(json.data.signing_secret as string);
      queryClient.setQueryData(["api-webhook"], json.data);
      queryClient.invalidateQueries({ queryKey: ["api-webhook-deliveries"] });
      toast.success(next ? "Webhook saved" : "Webhook removed");
    } catch {
      toast.error("Couldn't save the webhook");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      const res = await edgeFetch("/api/keys/webhook/test", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Couldn't send the test event");
        return;
      }
      if (json.data?.outcome === "delivered") {
        toast.success("Test event delivered: your endpoint answered with a 2xx");
      } else {
        toast.error("Your endpoint did not accept the test event. See the delivery log below.");
      }
      queryClient.invalidateQueries({ queryKey: ["api-webhook-deliveries"] });
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
      queryClient.invalidateQueries({ queryKey: ["api-webhook"] });
      toast.success("New signing secret created. The old one stops working now.");
    } catch {
      toast.error("Couldn't rotate the secret");
    } finally {
      setRotating(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }

  const trimmed = url.trim();
  const dirty = trimmed !== (saved ?? "");

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
        ) : config.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="webhook-url">Endpoint URL (https)</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="webhook-url"
                  type="url"
                  placeholder="https://example.com/hooks/gradethread"
                  value={url}
                  maxLength={2000}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <Button onClick={() => void save(trimmed || null)} disabled={saving || !dirty || !trimmed}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save
                </Button>
                {saved && (
                  <Button variant="outline" onClick={() => void save(null)} disabled={saving}>
                    Remove
                  </Button>
                )}
              </div>
            </div>

            {secret && (
              <div className="space-y-2 rounded-lg bg-muted p-4" role="status">
                <p className="text-sm font-medium">Signing secret (shown once)</p>
                <p className="text-sm text-muted-foreground">
                  Copy it now and use it to verify each delivery, for example with the SDK's
                  verifyWebhook. You can't see it again, only replace it.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-background px-2 py-1 text-xs">{secret}</code>
                  <Button variant="outline" size="icon" onClick={() => void copySecret()} aria-label="Copy signing secret">
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
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
                  <Button variant="outline" onClick={() => void rotate()} disabled={rotating}>
                    {rotating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    {config.data?.has_signing_secret ? "Rotate signing secret" : "Create signing secret"}
                  </Button>
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Recent deliveries</h3>
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
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {deliveries.data.map((d) => (
                            <TableRow key={d.event_id}>
                              <TableCell className="whitespace-nowrap">{when(d.created_at)}</TableCell>
                              <TableCell>
                                <code className="text-xs">{d.event_type}</code>
                              </TableCell>
                              <TableCell>
                                <Badge variant={statusVariant(d.status)}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
                              </TableCell>
                              <TableCell>
                                {d.attempts} of {d.max_attempts}
                              </TableCell>
                              <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground" title={d.last_error ?? undefined}>
                                {d.last_status_code ? `HTTP ${d.last_status_code}` : ""}
                                {d.last_error ? `${d.last_status_code ? " - " : ""}${d.last_error}` : ""}
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
    </Card>
  );
}
