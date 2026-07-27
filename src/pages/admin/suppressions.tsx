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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MailWarning, RefreshCw, Search, Trash2, Loader2 } from "lucide-react";

// US-914: admin view of the email suppression list + manual false-positive
// removal (super_admin + MFA step-up, audited server-side).

interface Suppression {
  email: string;
  reason: "hard_bounce" | "complaint" | "manual" | "unsubscribe_all";
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const REASON_LABEL: Record<Suppression["reason"], string> = {
  hard_bounce: "Hard bounce",
  complaint: "Complaint",
  manual: "Manual",
  unsubscribe_all: "Unsubscribed",
};

const REASON_VARIANT: Record<Suppression["reason"], "destructive" | "secondary" | "outline"> = {
  hard_bounce: "destructive",
  complaint: "destructive",
  manual: "secondary",
  unsubscribe_all: "outline",
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function AdminSuppressionsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const suppressions = useQuery({
    queryKey: ["email-suppressions", search],
    queryFn: async (): Promise<Suppression[]> => {
      const qs = search ? `?q=${encodeURIComponent(search)}` : "";
      const res = await edgeFetch(`/api/admin/suppressions${qs}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load suppressions");
      return (json.suppressions ?? []) as Suppression[];
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

  const remove = useMutation({
    mutationFn: (email: string) =>
      run(() => edgeFetch("/api/admin/suppressions/remove", { method: "POST", json: { email } })),
    onSuccess: (r) => {
      if (r) {
        toast.success("Suppression removed");
        void qc.invalidateQueries({ queryKey: ["email-suppressions"] });
      }
    },
  });

  const rows = suppressions.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <MailWarning className="h-6 w-6 text-brand-red" />
            Email Suppressions
          </h1>
          <p className="text-sm text-muted-foreground">
            Addresses that hard-bounced or filed a spam complaint. Every send path skips these to
            protect sender reputation. Removing a false positive requires re-verifying MFA.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void suppressions.refetch()}
          disabled={suppressions.isFetching}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${suppressions.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Suppressed addresses</CardTitle>
          <CardDescription>Most recent first. Search by email substring.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
          >
            <Input
              aria-label="Search suppressions"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search email…"
              className="max-w-sm"
            />
            <Button type="submit" variant="secondary" size="sm">
              <Search className="mr-2 h-4 w-4" />
              Search
            </Button>
          </form>

          {suppressions.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : suppressions.isError ? (
            <p className="text-sm text-destructive">
              {(suppressions.error as Error)?.message ?? "Failed to load suppressions"}
            </p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No suppressed addresses{search ? " match that search" : ""}.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.email}>
                    <TableCell className="font-medium">{s.email}</TableCell>
                    <TableCell>
                      <Badge variant={REASON_VARIANT[s.reason]}>{REASON_LABEL[s.reason]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{s.source ?? "—"}</TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {s.notes ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {fmtDate(s.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove.mutate(s.email)}
                        disabled={remove.isPending}
                        title="Remove this suppression (false positive)"
                      >
                        {remove.isPending && remove.variables === s.email ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 text-destructive" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}
