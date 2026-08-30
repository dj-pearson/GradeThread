import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { CheckCircle2, ClipboardCheck, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCents } from "@/lib/ledger-math";
import {
  dismissIssue,
  fetchDismissals,
  fetchReviewQueue,
  impactExplanation,
  impactLabel,
  issueCopy,
  totalImpact,
  undismissIssue,
  type ReviewIssue,
} from "@/lib/books-review";

// US-2992 — books health.
//
// One row per issue, ordered by what it costs to leave alone rather than by how
// easy it is to fix. Every row says what it costs in real terms and links to
// the exact record, not to the section it lives in: "go and look in Expenses"
// is how a queue stops being worked through.

/** Where a fix actually happens. AC1: the record, never the section. */
function fixHref(issue: ReviewIssue): string {
  switch (issue.fix_kind) {
    case "item":
      return `/dashboard/flipdesk/item/${issue.subject_id}`;
    case "expense":
      return `/dashboard/flipdesk/money?view=expenses`;
    case "sale":
      return `/dashboard/flipdesk/money?view=reconcile&tab=payouts`;
    case "payout":
      return `/dashboard/flipdesk/money?view=reconcile&tab=payouts`;
    case "snapshot":
      return `/dashboard/flipdesk/money?view=pnl`;
  }
}

export function BooksReviewCard({
  from,
  to,
  periodLabel,
}: {
  from: string;
  to: string;
  periodLabel: string;
}) {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [dismissing, setDismissing] = useState<ReviewIssue | null>(null);
  const [reason, setReason] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);

  const { data: issues = [], isLoading } = useQuery({
    queryKey: ["books-review", user?.id, from, to],
    enabled: !!user,
    queryFn: () => fetchReviewQueue(from, to),
  });

  const { data: dismissed = [] } = useQuery({
    queryKey: ["books-review-dismissed", user?.id],
    enabled: !!user && showDismissed,
    queryFn: fetchDismissals,
  });

  const totals = totalImpact(issues);

  async function confirmDismiss() {
    if (!user || !dismissing) return;
    if (reason.trim() === "") {
      toast.error("Say why, so this is a record rather than a hide.");
      return;
    }
    try {
      await dismissIssue(
        user.id,
        dismissing.kind,
        dismissing.subject_id,
        reason.trim(),
      );
      await qc.invalidateQueries({ queryKey: ["books-review"] });
      await qc.invalidateQueries({ queryKey: ["books-review-count"] });
      setDismissing(null);
      setReason("");
      toast.success("Set aside. You can bring it back any time.");
    } catch (err) {
      toastError(err, "Couldn't set that aside.");
    }
  }

  async function bringBack(kind: string, subjectId: string) {
    try {
      await undismissIssue(kind as ReviewIssue["kind"], subjectId);
      await qc.invalidateQueries({ queryKey: ["books-review"] });
      await qc.invalidateQueries({ queryKey: ["books-review-dismissed"] });
      await qc.invalidateQueries({ queryKey: ["books-review-count"] });
      toast.success("Back on the list.");
    } catch (err) {
      toastError(err, "Couldn't bring it back.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Needs a look</CardTitle>
        <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Things that quietly change your numbers. Worth clearing before an
          accountant finds them, or before you file on them.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : issues.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            Nothing to sort out for {periodLabel}.
          </p>
        ) : (
          <>
            {/* Exact and estimated are reported SEPARATELY. Adding a guess to a
                set of measured figures and printing one total would make the
                whole thing look measured. */}
            <p className="text-[13px] text-muted-foreground">
              {issues.length} thing{issues.length === 1 ? "" : "s"} to look at
              {totals.exactCents > 0 && (
                <>
                  {" "}
                  &middot; {formatCents(totals.exactCents)} we can put a number on
                </>
              )}
              {totals.estimatedCents > 0 && (
                <> &middot; about {formatCents(totals.estimatedCents)} more, estimated</>
              )}
              {totals.unknownCount > 0 && (
                <>
                  {" "}
                  &middot; {totals.unknownCount} we cannot price
                </>
              )}
            </p>

            <ul className="space-y-3">
              {issues.map((issue) => {
                const copy = issueCopy(issue.kind);
                const explanation = impactExplanation(issue);
                return (
                  <li
                    key={`${issue.kind}:${issue.subject_id}`}
                    className={cn(
                      "rounded-md border p-3",
                      issue.severity === 1 && "border-amber-500/40",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{copy.heading}</p>
                        <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
                          {issue.title} &middot; {issue.happened_on}
                        </p>
                      </div>
                      <span className="whitespace-nowrap text-sm font-medium tabular-nums">
                        {impactLabel(issue)}
                      </span>
                    </div>

                    <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
                      {copy.consequence}
                    </p>
                    {explanation && (
                      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted-foreground">
                        {explanation}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" asChild>
                        <Link to={fixHref(issue)}>{copy.action}</Link>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDismissing(issue);
                          setReason("");
                        }}
                      >
                        Not a problem
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div className="pt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowDismissed((v) => !v)}
          >
            <ClipboardCheck className="mr-2 h-4 w-4" />
            {showDismissed ? "Hide" : "Show"} what you set aside
          </Button>
          {showDismissed && (
            <ul className="mt-2 space-y-1.5">
              {dismissed.length === 0 ? (
                <li className="text-[13px] text-muted-foreground">
                  Nothing set aside.
                </li>
              ) : (
                dismissed.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center gap-x-2 text-[13px]"
                  >
                    <span className="text-muted-foreground">
                      {new Date(d.dismissed_at).toLocaleDateString()}
                    </span>
                    <span>{d.reason}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => bringBack(d.issue_kind, d.subject_id)}
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      Bring back
                    </Button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      </CardContent>

      {/* AC4. A reason is REQUIRED, because a dismissal without one is
          indistinguishable from hiding the row -- and the next person to read
          these books cannot tell "resolved" from "ignored". */}
      <Dialog open={!!dismissing} onOpenChange={(o) => !o && setDismissing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set this aside</DialogTitle>
            <DialogDescription>
              {dismissing && issueCopy(dismissing.kind).heading}. Say why, and we
              will stop asking.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="dismiss-reason">Why is this fine?</Label>
            <Input
              id="dismiss-reason"
              placeholder="It was a gift, so it cost me nothing"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              We keep this with the date. If your books are ever questioned, the
              reason is the answer.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissing(null)}>
              Cancel
            </Button>
            <Button onClick={confirmDismiss} disabled={reason.trim() === ""}>
              Set aside
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
