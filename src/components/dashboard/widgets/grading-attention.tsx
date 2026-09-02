import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { getStatusBadgeClasses } from "@/lib/constants";
import {
  ATTENTION_QUIET_STATE,
  ATTENTION_STATUSES,
  formatAge,
  formatStatusLabel,
  submissionHref,
} from "@/lib/dashboard-grading-queue";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SubmissionRow } from "@/types/database";

// US-3075 AC3: the five things waiting on the seller.
//
// A submission in pending_review, failed or disputed is stalled until a person
// does something, and until this widget existed the only way to find one was to
// open the submissions list and read it. The age is the point of the row: a
// review that has been sitting nine days is a different problem from one filed
// this morning, and the two look identical in a table sorted by date.

/** How many rows fit before the list stops being a glance. */
const MAX_ROWS = 5;

type AttentionRow = Pick<
  SubmissionRow,
  "id" | "title" | "status" | "created_at"
>;

export function GradingAttentionWidget() {
  const { data, isLoading, isError } = useQuery<AttentionRow[]>({
    queryKey: ["dashboard-attention"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // RLS scopes `submissions` to the signed-in account; this is the browser
      // client, not the edge service-role one. US-949: superseded retakes are
      // history and never need attention.
      const { data: rows, error } = await supabase
        .from("submissions")
        .select("id, title, status, created_at")
        .is("superseded_at", null)
        .in("status", ATTENTION_STATUSES as unknown as string[])
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS);

      if (error) throw error;
      return (rows ?? []) as unknown as AttentionRow[];
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

  const rows = data ?? [];

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-6">
        <p className="text-sm text-muted-foreground">{ATTENTION_QUIET_STATE}</p>
      </div>
    );
  }

  return (
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
                Waiting {formatAge(row.created_at)}
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
  );
}
