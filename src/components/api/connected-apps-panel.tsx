// US-9122 AC9: connected applications, on the page a seller already goes to
// when they think about access.
//
// A seller can only disconnect something they can SEE, and this is the surface
// where they look. It sits beside API keys rather than on a page of its own,
// because "what can reach my account" is one question and answering it in two
// places means one of them gets forgotten.
//
// Disconnecting revokes the GRANT, which stops the access tokens already
// issued — lib/oauth-access.ts checks revoked_at on every request. That is why
// the copy can say "immediately" without hedging.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plug, Unplug } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { edgeFetch } from "@/lib/edge-fetch";

interface Connection {
  id: string;
  client_id: string;
  client_name: string | null;
  scopes: string[];
  connected_at: string;
}

/** What each scope lets the connected app do, in a seller's words. */
const SCOPE_LABEL: Record<string, string> = {
  read: "Read your inventory and grades",
  submit: "Grade, list and reprice",
  webhook_manage: "Manage webhooks",
};

/** The HOST of the client id, which is the part a seller can verify. */
function displayHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

export function ConnectedAppsPanel() {
  const queryClient = useQueryClient();
  // DEV-04: one id per in-flight disconnect. A single shared id re-enabled the
  // first button as soon as a second disconnect started.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<Connection | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["oauth-connections"],
    queryFn: async (): Promise<Connection[]> => {
      const res = await edgeFetch("/api/oauth/connections");
      if (!res.ok) throw new Error("Could not load connected applications.");
      const body = (await res.json()) as { connections?: Connection[] };
      return body.connections ?? [];
    },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/oauth/connections/${id}/revoke`, { method: "POST" });
      if (!res.ok) throw new Error("Could not disconnect that application.");
    },
    onMutate: (id: string) => {
      setPending((prev) => new Set(prev).add(id));
    },
    onSuccess: () => {
      toast.success("Disconnected. It can no longer reach your account.");
      void queryClient.invalidateQueries({ queryKey: ["oauth-connections"] });
    },
    onError: (err: Error) => toastError(err),
    onSettled: (_data, _err, id) => {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
  });

  // Nothing connected, known for certain: say nothing. An empty panel on a
  // page about API keys is a question a seller did not ask. A FAILED read is
  // not that: "nothing is connected" is the one answer a security list must
  // never give by accident.
  if (!isLoading && !isError && (data?.length ?? 0) === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-5 text-primary" aria-hidden />
          Connected applications
        </CardTitle>
        <CardDescription>
          Apps you have allowed to act on your GradeThread account. Disconnecting one stops
          it immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isError ? (
          <ErrorState
            title="We could not load your connected apps"
            description="Apps you connected before still have whatever access you gave them."
            onRetry={() => void refetch()}
            retrying={isFetching}
            hideSupport
          />
        ) : isLoading
          ? <Skeleton className="h-20 w-full" />
          : data!.map((connection) => (
            <div
              key={connection.id}
              className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1.5">
                <p className="font-medium">
                  {displayHost(connection.client_id)}
                  {connection.client_name ? (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      says it is {connection.client_name}
                    </span>
                  ) : null}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {connection.scopes.map((scope) => (
                    <Badge key={scope} variant="secondary">
                      {SCOPE_LABEL[scope] ?? scope}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Connected {new Date(connection.connected_at).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pending.has(connection.id)}
                onClick={() => setConfirming(connection)}
              >
                {pending.has(connection.id)
                  ? <Loader2 className="size-4 animate-spin" aria-hidden />
                  : <Unplug className="size-4" aria-hidden />}
                Disconnect
              </Button>
            </div>
          ))}
      </CardContent>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {confirming ? displayHost(confirming.client_id) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              It stops working right away and you will need to connect it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirming) revoke.mutate(confirming.id);
                setConfirming(null);
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
