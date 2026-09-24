import { cn } from "@/lib/utils";
import { STATUS_TONE_CLASSES, SUBMISSION_STATUS_TONE } from "@/lib/constants";
import { SUBMISSION_STAGE_COPY } from "@/lib/grading-journey";
import { formatLabel } from "@/lib/format-label";
import type { SubmissionStatus } from "@/types/database";

// SUB-13: one badge for a submission's status, on the list and the detail
// page alike. The label is the plain-language stage name from
// SUBMISSION_STAGE_COPY, the tone comes from SUBMISSION_STATUS_TONE, and the
// stage's one-line meaning rides along as a tooltip. The detail page used to
// hand-roll its own map, which had no entry for "disputed".
export function SubmissionStatusBadge({
  status,
  className,
}: {
  status: SubmissionStatus | string;
  className?: string;
}) {
  const stage = SUBMISSION_STAGE_COPY[status as SubmissionStatus];
  const tone = SUBMISSION_STATUS_TONE[status as SubmissionStatus];
  return (
    <span
      title={stage?.meaning}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        tone ? STATUS_TONE_CLASSES[tone] : STATUS_TONE_CLASSES.neutral,
        className,
      )}
    >
      {stage?.label ?? formatLabel(status)}
    </span>
  );
}
