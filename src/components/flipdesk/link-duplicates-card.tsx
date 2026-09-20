import { useState } from "react";
import { Link2, Loader2, Scissors, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toastError } from "@/lib/toast-error";
import {
  type LinkScanSummary,
  scanSummarySentence,
  useLinkReviews,
  useLinkScan,
  useResolveLinkReview,
} from "@/hooks/use-cross-channel-link";

// US-3197 AC1/AC8: the seller-facing half of cross-channel linking.
//
// One jacket listed on eBay and on Poshmark, imported from both, is two items
// with nothing joining them. This finds those pairs.
//
// THE QUEUE IS THE FEATURE, not the button. The decision layers refuse far
// more than they accept, because a wrong link merges two garments — so most
// of the value is in the questions, and a question nobody answers leaves the
// closet half-joined. The review list is therefore rendered whether or not a
// scan has just run, and the scan's summary always says the review count out
// loud even when it joined nothing.

function scoreLabel(score: number): string {
  // A percentage, not the raw 0..1. "0.74" invites a seller to reason about a
  // threshold they were never told; "74% alike" is a confidence they can feel.
  return `${Math.round(score * 100)}% alike`;
}

/**
 * What names this row out loud (US-2450).
 *
 * The review row carries no title -- it names two listing ids -- so the
 * identity a person can actually tell apart is the score plus the strongest
 * reason the server gave.
 */
function rowName(r: { score: number; reasons: string[] }): string {
  const first = r.reasons[0]?.replace(/\.$/, "");
  return first ? `${scoreLabel(r.score)}, ${first}` : scoreLabel(r.score);
}

export function LinkDuplicatesCard() {
  const reviews = useLinkReviews();
  const scan = useLinkScan();
  const resolve = useResolveLinkReview();
  const [summary, setSummary] = useState<LinkScanSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pending = reviews.data ?? [];

  const runScan = () => {
    scan.mutate(undefined, {
      onSuccess: (s) => {
        setSummary(s);
        toast.success(scanSummarySentence(s));
      },
      onError: (err) => toastError(err, "Could not look for matching listings."),
    });
  };

  const answer = (id: string, decision: "confirm" | "split") => {
    setBusyId(id);
    resolve.mutate({ id, decision }, {
      onSuccess: () => {
        toast.success(
          decision === "confirm"
            ? "Joined. They are one item now."
            : "Kept apart. We will not ask about this pair again.",
        );
      },
      onError: (err) => toastError(err, "Could not save that."),
      onSettled: () => setBusyId(null),
    });
  };

  return (
    <div>
      {/* US-3032: h3 and a div — a part of the surrounding section. */}
      <h3 className="mb-3 text-sm font-semibold text-foreground">
        One garment on two channels
      </h3>

      <Card className="p-4">
        <p className="text-xs text-muted-foreground">
          If you listed the same item on more than one marketplace, this joins
          those listings onto one item so a sale ends the others. Nothing is
          joined without asking unless the match is beyond doubt.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={runScan} disabled={scan.isPending}>
            {scan.isPending
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Link2 className="mr-1.5 h-4 w-4" />}
            {scan.isPending ? "Looking…" : "Find matching listings"}
          </Button>
          {summary && (
            <span className="text-xs text-muted-foreground">
              {scanSummarySentence(summary)}
            </span>
          )}
        </div>

        {pending.length > 0 && (
          <div className="mt-4">
            <p className="text-sm font-medium">
              {pending.length} {pending.length === 1 ? "match needs" : "matches need"}{" "}
              your call
            </p>
            <ul className="mt-2 space-y-2">
              {pending.map((r) => (
                <li key={r.id} className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-foreground">
                    {scoreLabel(r.score)}
                  </p>
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {/* The server's words, shown as written: they name the
                        fields that agreed, which is what a person checks. */}
                    {r.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                  </ul>
                  {/* US-2450: every row's two buttons read "Same item" and
                      "Different items", so by visible text alone a screen
                      reader announces the same pair of words all the way down
                      the list with nothing to say which match is which. The
                      label carries the row's own identity — its score and the
                      first reason, which is the strongest field agreement the
                      server found. */}
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={`Same item: ${rowName(r)}`}
                      disabled={busyId === r.id}
                      onClick={() => answer(r.id, "confirm")}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" />
                      Same item
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Different items: ${rowName(r)}`}
                      disabled={busyId === r.id}
                      onClick={() => answer(r.id, "split")}
                    >
                      <Scissors className="mr-1 h-3.5 w-3.5" />
                      Different items
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Said out loud rather than left blank: an empty queue and a queue
            that has never been built look identical on screen. */}
        {pending.length === 0 && !reviews.isLoading && (
          <p className="mt-3 text-xs text-muted-foreground">
            {summary
              ? "Nothing waiting on you."
              : "Nothing waiting on you. Run a check if you have imported from more than one channel."}
          </p>
        )}
      </Card>
    </div>
  );
}
