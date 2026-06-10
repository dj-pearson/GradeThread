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
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";

// US-771: operator queue for per-grade Stripe refunds the pipeline couldn't
// auto-issue (a Stripe error, or a paid_stripe submission with no stored
// PaymentIntent). "Refund now" calls the resolve endpoint, which issues the
// Stripe refund idempotently (same key the pipeline would have used) and closes
// the row. The endpoint requires a fresh MFA step-up (handled by edgeFetch).

interface PendingRefund {
  id: string;
  submission_id: string;
  user_id: string;
  user_email: string | null;
  payment_intent_id: string | null;
  reason: string;
  last_error: string | null;
  created_at: string;
}

export function PendingRefundsCard() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["admin-pending-refunds"],
    queryFn: async (): Promise<PendingRefund[]> => {
      const res = await edgeFetch("/api/admin/pending-refunds");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load pending refunds.");
      return (json.data ?? []) as PendingRefund[];
    },
    staleTime: 30_000,
  });

  const resolve = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/pending-refunds/${id}/resolve`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Refund failed.");
      return json as { ok: true; refund_id: string };
    },
    onSuccess: (data) => {
      toast.success(`Refund issued (${data.refund_id}).`);
      qc.invalidateQueries({ queryKey: ["admin-pending-refunds"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rows = query.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RotateCcw className="h-5 w-5" />
          Pending grade refunds
          {rows.length > 0 && (
            <Badge variant="destructive" className="ml-1">{rows.length}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Per-grade payments where grading produced no result and the automatic
          Stripe refund couldn&apos;t complete. Resolve issues the refund.
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
          <p className="text-sm text-muted-foreground">
            No pending refunds — automatic refunds are clearing.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => {
              const isResolving = resolve.isPending && resolve.variables === r.id;
              return (
                <div
                  key={r.id}
                  className="rounded-md border border-border p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {r.user_email ?? r.user_id}
                        </span>
                        <Badge variant="outline" className="text-xs">{r.reason}</Badge>
                        {!r.payment_intent_id && (
                          <Badge variant="destructive" className="text-xs">
                            no PaymentIntent
                          </Badge>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        submission {r.submission_id}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleString()}
                      </div>
                      {r.last_error && (
                        <div className="text-xs text-red-600">{r.last_error}</div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => resolve.mutate(r.id)}
                      disabled={resolve.isPending || !r.payment_intent_id}
                      title={
                        r.payment_intent_id
                          ? "Issue the Stripe refund"
                          : "No PaymentIntent — find the charge in the user's Billing actions and refund there"
                      }
                    >
                      {isResolving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                      Refund now
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
