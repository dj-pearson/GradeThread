import { Check, Clock, Mail, UserCheck } from "lucide-react";
import type { GradeTierKey } from "@/lib/constants";
import type { SubmissionStatus } from "@/types/database";
import {
  HUMAN_REVIEW,
  WHAT_YOU_GET,
  WHERE_IT_APPEARS,
  turnaroundCopy,
} from "@/lib/grading-journey";

// US-2870. The panel under the spinner.
//
// Everything it says comes from src/lib/grading-journey.ts, which is also what
// the iOS parity test reads. Nothing is written twice.
//
// It renders WHILE THE GRADE IS IN FLIGHT and disappears when the report
// arrives, because at that point the report answers all of these questions
// better than a list can.

export function WhatHappensNext({
  status,
  tier,
}: {
  status: SubmissionStatus;
  /** From submissions.service_tier. Null only if the column is somehow unset. */
  tier: GradeTierKey | null;
}) {
  const inReview = status === "pending_review";

  return (
    <div className="mt-6 w-full max-w-md space-y-4 border-t pt-6 text-left">
      <div className="flex gap-3">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {turnaroundCopy(tier)}
          {inReview ? ` ${HUMAN_REVIEW.wait}` : ""}
        </p>
      </div>

      {/* The review explanation only where it is the actual state, or it reads
          as a warning about something that is not happening. */}
      {inReview && (
        <div className="flex gap-3">
          <UserCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {HUMAN_REVIEW.what} {HUMAN_REVIEW.cost} {HUMAN_REVIEW.certificate}
          </p>
        </div>
      )}

      <div>
        <p className="text-sm font-medium">What you will get</p>
        <ul className="mt-2 space-y-2">
          {WHAT_YOU_GET.map((item) => (
            <li key={item.title} className="flex gap-3">
              <Check
                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              <span className="text-sm">
                <span className="font-medium">{item.title}.</span>{" "}
                <span className="text-muted-foreground">{item.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-3">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{WHERE_IT_APPEARS}</p>
      </div>
    </div>
  );
}
