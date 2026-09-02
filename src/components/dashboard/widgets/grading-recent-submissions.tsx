import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getScoreColor, getStatusBadgeClasses } from "@/lib/constants";
import { formatStatusLabel } from "@/lib/dashboard-grading-queue";
import { ScoreBandIcon } from "@/components/grade/score-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { showExampleAction } from "@/lib/show-example";
import { cn } from "@/lib/utils";
import type { GradeReportRow, SubmissionRow } from "@/types/database";

// US-3075 AC1: the Recent Submissions card, as a widget.
//
// US-2204: this list renders four columns. Typing the rows as the projection
// (not SubmissionRow) makes a dropped column a tsc error instead of a blank
// cell.

type RecentSubmissionRow = Pick<
  SubmissionRow,
  "id" | "title" | "status" | "created_at"
>;
const RECENT_SUBMISSION_COLUMNS = "id, title, status, created_at";

interface RecentSubmission extends RecentSubmissionRow {
  grade_report?: Pick<GradeReportRow, "overall_score" | "grade_tier"> | null;
}

export function GradingRecentSubmissionsWidget() {
  const navigate = useNavigate();

  const { data, isLoading, isError, isFetching, refetch } = useQuery<
    RecentSubmission[]
  >({
    queryKey: ["dashboard-recent-submissions"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // RLS scopes both tables to the signed-in account. US-949: superseded
      // retakes are history, not recent activity.
      const { data: recent, error: recentError } = await supabase
        .from("submissions")
        .select(RECENT_SUBMISSION_COLUMNS)
        .is("superseded_at", null)
        .order("created_at", { ascending: false })
        .limit(5);
      if (recentError) throw recentError;

      const recentRows = (recent ?? []) as RecentSubmissionRow[];
      const completedIds = recentRows
        .filter((s) => s.status === "completed")
        .map((s) => s.id);

      let gradeMap: Record<
        string,
        Pick<GradeReportRow, "overall_score" | "grade_tier">
      > = {};

      if (completedIds.length > 0) {
        const { data: reports } = await supabase
          .from("grade_reports")
          .select("submission_id, overall_score, grade_tier")
          .in("submission_id", completedIds)
          .is("superseded_at", null); // US-479: active report per submission

        const reportRows = (reports ?? []) as Array<
          Pick<GradeReportRow, "overall_score" | "grade_tier"> & {
            submission_id: string;
          }
        >;

        gradeMap = Object.fromEntries(
          reportRows.map((r) => [
            r.submission_id,
            { overall_score: r.overall_score, grade_tier: r.grade_tier },
          ]),
        );
      }

      return recentRows.map((s) => ({ ...s, grade_report: gradeMap[s.id] ?? null }));
    },
  });

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load recent submissions"
        description="Something went wrong while loading your submissions. This is usually temporary."
        onRetry={() => refetch()}
        retrying={isFetching}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  const submissions = data ?? [];

  if (submissions.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No submissions yet"
        description="Upload photos of a garment to get your first AI-powered condition grade."
        action={{
          label: "Submit your first garment",
          onClick: () => navigate("/dashboard/submissions/new"),
          icon: Plus,
        }}
        // US-2865: for the seller who is not ready to press the primary button
        // yet. One worked garment, read end to end.
        secondaryAction={showExampleAction}
      />
    );
  }

  return (
    <div className="space-y-2">
      {submissions.map((sub) => (
        <button
          key={sub.id}
          type="button"
          className="flex w-full cursor-pointer items-center justify-between rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
          onClick={() => navigate(`/dashboard/submissions/${sub.id}`)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{sub.title}</span>
            <span className="block text-sm text-muted-foreground">
              {new Date(sub.created_at).toLocaleDateString()}
            </span>
          </span>
          <span className="flex items-center gap-3">
            <Badge variant="outline" className={cn(getStatusBadgeClasses(sub.status))}>
              {formatStatusLabel(sub.status)}
            </Badge>
            {sub.grade_report ? (
              <span
                className={cn(
                  "inline-flex min-w-[2.5rem] items-center justify-end gap-1 text-sm font-semibold",
                  getScoreColor(sub.grade_report.overall_score),
                )}
                title={sub.grade_report.grade_tier}
              >
                <ScoreBandIcon score={sub.grade_report.overall_score} />
                {sub.grade_report.overall_score.toFixed(1)}
              </span>
            ) : (
              <span className="min-w-[2.5rem] text-right text-sm text-muted-foreground">
                -
              </span>
            )}
          </span>
        </button>
      ))}

      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate("/dashboard/submissions")}
      >
        View all
      </Button>
    </div>
  );
}
