import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { getStatusBadgeClasses } from "@/lib/constants";
import {
  ATTENTION_QUIET_STATE,
  ATTENTION_STATUSES,
  formatAge,
  formatStatusLabel,
  orderAttentionRows,
  submissionHref,
} from "@/lib/dashboard-grading-queue";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SubmissionRow } from "@/types/database";

// US-3075 AC3: the five things waiting on the seller.
//
// A submission in disputed, needs_photos, failed or pending_review is stalled
// until a person does something, and until this widget existed the only way to
// find one was to open the submissions list and read it. The age is the point of the row: a
// review that has been sitting nine days is a different problem from one filed
// this morning, and the two look identical in a table sorted by date.

/** How many rows fit before the list stops being a glance. */
const MAX_ROWS = 5;

/**
 * How many candidate rows to read. The list is sorted by status priority in
 * the browser (PostgREST cannot order by an enum's meaning), so it reads more
 * than it shows; the exact count comes back separately for "+N more".
 */
const READ_CAP = 200;

type AttentionRow = Pick<
  SubmissionRow,
  "id" | "title" | "status" | "updated_at"
>;

interface AttentionData {
  rows: AttentionRow[];
  total: number;
}

/** Where "+N more" goes: the one status the rest share, or every submission. */
function moreHref(hidden: readonly AttentionRow[]): string {
  const statuses = new Set(hidden.map((r) => r.status));
  const only = statuses.size === 1 ? [...statuses][0] : null;
  return only ? `/dashboard/submissions?status=${only}` : "/dashboard/submissions";
}

export function GradingAttentionWidget() {
  const { data, isLoading, isError } = useQuery<AttentionData>({
    queryKey: ["dashboard-attention"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // RLS scopes `submissions` to the signed-in account; this is the browser
      // client, not the edge service-role one. US-949: superseded retakes are
      // history and never need attention.
      //
      // updated_at, not created_at: the age that matters is how long the row
      // has sat in the status it is in, and the status change is the last
      // write. Oldest first, because the longest stall is the point of the
      // list and a newest-first cap was the first thing to cut it.
      const { data: rows, error, count } = await supabase
        .from("submissions")
        .select("id, title, status, updated_at", { count: "exact" })
        .is("superseded_at", null)
        .in("status", ATTENTION_STATUSES as unknown as string[])
        .order("updated_at", { ascending: true })
        .limit(READ_CAP);

      if (error) throw error;
      const list = (rows ?? []) as unknown as AttentionRow[];
      return { rows: list, total: count ?? list.length };
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-6" role="alert">
        <p className="text-sm text-muted-foreground">
          Could not check what is waiting on you.
        </p>
      </div>
    );
  }

  const ordered = orderAttentionRows(data?.rows ?? []);
  const rows = ordered.slice(0, MAX_ROWS);
  const more = Math.max(0, (data?.total ?? 0) - rows.length);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-6">
        <p className="text-sm text-muted-foreground">{ATTENTION_QUIET_STATE}</p>
      </div>
    );
  }

  return (
    <div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              to={submissionHref(row.id)}
              className="flex items-center justify-between gap-3 rounded-xl border px-3 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {row.title}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Waiting {formatAge(row.updated_at)}
                </span>
              </span>
              <Badge
                variant="outline"
                className={cn("shrink-0", getStatusBadgeClasses(row.status))}
              >
                {formatStatusLabel(row.status)}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <Link
          to={moreHref(ordered.slice(MAX_ROWS))}
          className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
        >
          +{more} more
        </Link>
      ) : null}
    </div>
  );
}
