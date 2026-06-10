import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { edgeFetch } from "@/lib/edge-fetch";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, MailWarning } from "lucide-react";

// US-772: operator queue for permanently-dropped webhook events. A non-transient
// handler bug returns 200 to Stripe (a retry can't fix a bug) and dead-letters
// the event here. Each row carries a redacted payload + the error so an operator
// can diagnose, fix + redeploy, replay the event from the Stripe dashboard, then
// mark it resolved. "Mark resolved" is an acknowledgement (no money moves).

interface DeadLetter {
  id: string;
  provider: string;
  event_id: string;
  event_type: string | null;
  error_message: string | null;
  payload: unknown;
  created_at: string;
}

export function WebhookDeadLettersCard() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin-webhook-dead-letters"],
    queryFn: async (): Promise<DeadLetter[]> => {
      const res = await edgeFetch("/api/admin/webhook-dead-letters");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load dead letters.");
      return (json.data ?? []) as DeadLetter[];
    },
    staleTime: 30_000,
  });

  const resolve = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/webhook-dead-letters/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Resolve failed.");
      return json as { ok: true };
    },
    onSuccess: () => {
      toast.success("Dead letter marked resolved.");
      qc.invalidateQueries({ queryKey: ["admin-webhook-dead-letters"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rows = query.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailWarning className="h-5 w-5" />
          Dropped webhook events
          {rows.length > 0 && (
            <Badge variant="destructive" className="ml-1">{rows.length}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Webhook events whose handler hit a non-transient bug and were dropped
          (returned 200 so Stripe stops retrying). Fix the handler, redeploy,
          resend the event from the Stripe dashboard using the event id below,
          then mark resolved.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : query.error ? (
          <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4" />
            {(query.error as Error).message}
          </div>
        ) : rows.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            No dropped webhook events.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => {
              const isResolving = resolve.isPending && resolve.variables === r.id;
              const isOpen = expanded === r.id;
              return (
                <div
                  key={r.id}
                  className="rounded-md border border-border p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-xs uppercase">
                          {r.provider}
                        </Badge>
                        <span className="font-medium">{r.event_type ?? "unknown"}</span>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {r.event_id}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()}
                      </div>
                      {r.error_message && (
                        <div className="break-words text-xs text-red-600">
                          {r.error_message}
                        </div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolve.mutate(r.id)}
                      disabled={resolve.isPending}
                    >
                      {isResolving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                      Mark resolved
                    </Button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDown
                      className={`h-3 w-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                    {isOpen ? "Hide" : "Show"} redacted payload
                  </button>
                  {isOpen && (
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] leading-snug">
                      {JSON.stringify(r.payload, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
