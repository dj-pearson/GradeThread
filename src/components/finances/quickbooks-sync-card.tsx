import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Upload } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchQboStatus,
  fetchQboSyncLog,
  runQboSync,
  type SyncCounts,
} from "@/lib/qbo";

// US-2998 — pushing to QuickBooks.
//
// ONE WAY, and the screen says so twice: once in the description and once
// beside the button. Two-way sync is a much larger problem, and a seller who
// believes we do it will edit a figure in QuickBooks and expect it back.
//
// The button drives a LOOP of bounded batches rather than one long request.
// Three years of history in a single call hits Intuit's rate limit and loses
// the run; forty documents at a time with a bookmark cannot.

const KIND_LABEL: Record<string, string> = {
  sales_receipt: "Sale",
  purchase: "Expense",
  deposit: "Payout",
};

const STATUS_LABEL: Record<string, string> = {
  created: "Added",
  updated: "Updated",
  skipped: "No change",
  failed: "Failed",
  blocked: "Waiting on an account",
};

const EMPTY: SyncCounts = {
  created: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  blocked: 0,
  attached: 0,
};

export function QuickBooksSyncCard() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [progress, setProgress] = useState("");

  const { data: status } = useQuery({
    queryKey: ["qbo-status", user?.id],
    enabled: !!user,
    queryFn: fetchQboStatus,
    staleTime: 60 * 1000,
  });

  const connected = status?.connected ?? false;

  const { data: log = [] } = useQuery({
    queryKey: ["qbo-sync-log", user?.id],
    enabled: !!user && connected,
    queryFn: fetchQboSyncLog,
    staleTime: 30 * 1000,
  });

  // Problems first. A log that leads with two hundred successes buries the one
  // line the seller has to act on.
  const problems = useMemo(
    () => log.filter((e) => e.status === "failed" || e.status === "blocked"),
    [log],
  );

  const sync = useMutation({
    mutationFn: async () => {
      const periodStart = `${year}-01-01`;
      const periodEnd = `${year + 1}-01-01`;
      let runId: string | undefined;
      let total: SyncCounts = { ...EMPTY };
      // AC7. Bounded batches with a bookmark, looped here rather than held open
      // on the server. The cap stops a runaway; the server is the authority on
      // when the period is done.
      for (let batch = 0; batch < 200; batch++) {
        const res = await runQboSync({ periodStart, periodEnd, runId });
        runId = res.run_id;
        total = res.counts;
        setProgress(
          `${total.created + total.updated} sent, ${total.skipped} already there`,
        );
        if (res.done) break;
      }
      return total;
    },
    onSuccess: (total) => {
      const sent = total.created + total.updated;
      toast.success(
        `${sent} sent to QuickBooks. ${total.skipped} were already there.` +
          (total.blocked > 0
            ? ` ${total.blocked} are waiting on an account.`
            : ""),
      );
      void qc.invalidateQueries({ queryKey: ["qbo-sync-log"] });
    },
    onError: (err) => toastError(err, "The sync couldn't run."),
    onSettled: () => setProgress(""),
  });

  if (!status?.connected) return null;

  const years = [0, 1, 2, 3].map((n) => thisYear - n);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Send your books to QuickBooks
        </CardTitle>
        <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Sales go over as receipts with the fees, the label and the cost of the
          item on them. Expenses go as purchases with their receipt. Payouts go
          as deposits naming the sales they paid for.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="qbo-sync-year" className="text-xs">
              Year
            </Label>
            <Select
              value={String(year)}
              onValueChange={(v) => setYear(Number(v))}
            >
              <SelectTrigger id="qbo-sync-year" className="h-9 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
            <Upload className="mr-2 h-4 w-4" />
            {sync.isPending ? progress || "Sending" : `Send ${year}`}
          </Button>
          {/* AC8. Beside the button, where a seller about to press it reads it. */}
          <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            GradeThread <ArrowRight className="h-3.5 w-3.5" /> QuickBooks only
          </span>
        </div>

        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Running this twice is safe. Anything already in QuickBooks is updated
          rather than added again, and anything unchanged is left alone.
        </p>

        {problems.length > 0 && (
          <div className="rounded-md bg-amber-500/10 p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400" />
              {problems.length} thing{problems.length === 1 ? "" : "s"} did not
              go
            </p>
            <ul className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-muted-foreground">
              {problems.slice(0, 8).map((p) => (
                <li key={`${p.object_kind}:${p.source_id}`}>
                  <span className="font-medium text-foreground">
                    {KIND_LABEL[p.object_kind] ?? p.object_kind} {p.doc_number}
                  </span>
                  {/* AC6: QuickBooks' own words. "Sync failed" with no object
                      named is not something anyone can act on. */}
                  {p.error_text ? ` — ${p.error_text}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {log.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-[13px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">What</th>
                  <th className="py-1.5 pr-3 font-medium">Reference</th>
                  <th className="py-1.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {log.slice(0, 25).map((e) => (
                  <tr
                    key={`${e.object_kind}:${e.source_id}`}
                    className="border-t"
                  >
                    <td className="py-1.5 pr-3">
                      {KIND_LABEL[e.object_kind] ?? e.object_kind}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[12px]">
                      {e.doc_number}
                    </td>
                    <td className="py-1.5">
                      {STATUS_LABEL[e.status] ?? e.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
