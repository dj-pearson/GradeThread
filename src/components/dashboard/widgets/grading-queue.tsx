import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { SUBMISSION_STATUSES } from "@/lib/constants";
import {
  formatStatusLabel,
  submissionsStatusHref,
  tallySubmissionStatuses,
  type QueueCounts,
} from "@/lib/dashboard-grading-queue";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// US-3075 AC2: where every submission stands, in one read.
//
// This is the widget the story exists for. The old dashboard's only number
// about grading was a lifetime total, so a seller with four submissions stuck
// in pending_review and one that failed saw the same "27" as a seller with
// nothing outstanding. Six tiles and a total say the same thing in the space
// the one card used, and every tile is a link into the list already filtered.
//
// The Total Submissions card folded in here rather than staying beside it: two
// components counting the same rows is two numbers free to disagree, and the
// grouped read already has the total.

interface QueueData {
  counts: QueueCounts;
  /** The server's exact count, which is the total tile. */
  total: number;
}

export function GradingQueueWidget() {
  const { data, isLoading, isError } = useQuery<QueueData>({
    queryKey: ["dashboard-submission-queue"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // ONE request. `count: "exact"` rides the same query as the rows, so the
      // total and the per-status tiles are the same read of the same snapshot
      // and cannot disagree. RLS scopes `submissions` to the signed-in account;
      // there is no user_id filter here because there is no service-role client
      // in the browser to bypass it.
      //
      // US-949: superseded retakes are history, not queue.
      const { data: rows, count, error } = await supabase
        .from("submissions")
        .select("status", { count: "exact" })
        .is("superseded_at", null);

      if (error) throw error;

      const statuses = (rows ?? []) as unknown as { status: string | null }[];
      return {
        counts: tallySubmissionStatuses(statuses),
        total: count ?? statuses.length,
      };
    },
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-6" role="alert">
        <p className="text-sm text-muted-foreground">
          Could not count your submissions just now.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <QueueTile
        label="All submissions"
        value={data.total}
        to="/dashboard/submissions"
        emphasis
      />
      {SUBMISSION_STATUSES.map((status) => (
        <QueueTile
          key={status}
          label={formatStatusLabel(status)}
          value={data.counts[status]}
          to={submissionsStatusHref(status)}
        />
      ))}
    </div>
  );
}

/**
 * One count.
 *
 * A link, not a button with a navigate() in it: the seller can open a status in
 * a new tab, and the destination is visible in the status bar before they
 * click. A zero is still a link, because "none failed" is worth being able to
 * confirm and a tile that changes into plain text is a target that moves.
 */
function QueueTile({
  label,
  value,
  to,
  emphasis,
}: {
  label: string;
  value: number;
  to: string;
  emphasis?: boolean;
}) {
  return (
    <Link
      to={to}
      aria-label={`${value} ${label}`}
      className={cn(
        "rounded-xl border px-3 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        emphasis && "bg-muted/40",
      )}
    >
      <span
        className={cn(
          "block text-2xl font-bold tabular-nums",
          value === 0 && "text-muted-foreground",
        )}
      >
        {value}
      </span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{label}</span>
    </Link>
  );
}
