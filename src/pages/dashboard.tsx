import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { PLANS } from "@/lib/constants";
import type { PlanKey } from "@/lib/constants";
import type { SubmissionRow, GradeReportRow, InventoryItemRow, ListingRow } from "@/types/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, FileText, TrendingUp, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { GradeCharts } from "@/components/dashboard/grade-charts";
import { ListingSuggestions } from "@/components/analytics/listing-suggestions";

interface RecentSubmission extends SubmissionRow {
  grade_report?: Pick<GradeReportRow, "overall_score" | "grade_tier"> | null;
}

function getStatusBadgeClasses(status: string): string {
  switch (status) {
    case "completed":
      return "border-green-200 bg-green-100 text-green-800";
    case "processing":
      return "border-blue-200 bg-blue-100 text-blue-800";
    case "pending":
      return "border-yellow-200 bg-yellow-100 text-yellow-800";
    case "failed":
      return "border-red-200 bg-red-100 text-red-800";
    case "disputed":
      return "border-purple-200 bg-purple-100 text-purple-800";
    default:
      return "";
  }
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getScoreColor(score: number): string {
  if (score > 7) return "text-green-600";
  if (score >= 5) return "text-yellow-600";
  return "text-red-600";
}

export function DashboardPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const plan = profile?.plan ?? "free";
  const planConfig = PLANS[plan as PlanKey];
  const gradesUsed = profile?.grades_used_this_month ?? 0;
  const gradesLimit = planConfig.gradesPerMonth === -1 ? "Unlimited" : planConfig.gradesPerMonth;
  const gradesPercent =
    typeof gradesLimit === "number" ? Math.round((gradesUsed / gradesLimit) * 100) : 0;

  const { data: submissionData, isLoading } = useQuery({
    queryKey: ["dashboard-submissions"],
    queryFn: async () => {
      // Fetch total submission count
      const { count, error: countError } = await supabase
        .from("submissions")
        .select("*", { count: "exact", head: true });

      if (countError) throw countError;

      // Fetch last 5 submissions
      const { data: recent, error: recentError } = await supabase
        .from("submissions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(5);

      if (recentError) throw recentError;

      const recentRows = (recent ?? []) as SubmissionRow[];

      // Fetch grade reports for completed submissions
      const completedIds = recentRows
        .filter((s) => s.status === "completed")
        .map((s) => s.id);

      let gradeMap: Record<string, Pick<GradeReportRow, "overall_score" | "grade_tier">> = {};

      if (completedIds.length > 0) {
        const { data: reports } = await supabase
          .from("grade_reports")
          .select("submission_id, overall_score, grade_tier")
          .in("submission_id", completedIds);

        const reportRows = (reports ?? []) as Array<
          Pick<GradeReportRow, "overall_score" | "grade_tier"> & { submission_id: string }
        >;

        gradeMap = Object.fromEntries(
          reportRows.map((r) => [
            r.submission_id,
            { overall_score: r.overall_score, grade_tier: r.grade_tier },
          ])
        );
      }

      const merged: RecentSubmission[] = recentRows.map((s) => ({
        ...s,
        grade_report: gradeMap[s.id] ?? null,
      }));

      return { totalCount: count ?? 0, recentSubmissions: merged };
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: inventoryData } = useQuery({
    queryKey: ["dashboard-listing-suggestions"],
    queryFn: async () => {
      const { data: itemsRaw } = await supabase
        .from("inventory_items")
        .select("*");
      const items = (itemsRaw ?? []) as InventoryItemRow[];

      const itemIds = items.map((i) => i.id);
      let allListings: ListingRow[] = [];
      if (itemIds.length > 0) {
        const { data: listingsRaw } = await supabase
          .from("listings")
          .select("*")
          .in("inventory_item_id", itemIds);
        allListings = (listingsRaw ?? []) as ListingRow[];
      }

      const submissionIds = items
        .map((i) => i.submission_id)
        .filter((id): id is string => id !== null);
      let allReports: GradeReportRow[] = [];
      if (submissionIds.length > 0) {
        const { data: reportsRaw } = await supabase
          .from("grade_reports")
          .select("*")
          .in("submission_id", submissionIds);
        allReports = (reportsRaw ?? []) as GradeReportRow[];
      }

      return { items, listings: allListings, gradeReports: allReports };
    },
    staleTime: 5 * 60 * 1000,
  });

  const totalCount = submissionData?.totalCount ?? 0;
  const recentSubmissions = submissionData?.recentSubmissions ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">
            Welcome back{profile?.full_name ? `, ${profile.full_name}` : ""}.
          </p>
        </div>
        <Button onClick={() => navigate("/dashboard/submissions/new")}>
          <Plus className="mr-1 h-4 w-4" />
          New Submission
        </Button>
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Grades Used</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {gradesUsed} <span className="text-sm font-normal text-muted-foreground">/ {gradesLimit}</span>
            </div>
            {typeof gradesLimit === "number" && (
              <div className="mt-2 h-2 rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-brand-navy transition-all"
                  style={{ width: `${Math.min(gradesPercent, 100)}%` }}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Current Plan</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold">{planConfig.name}</span>
              <Badge variant="secondary" className="text-xs">
                {planConfig.priceMonthly === 0
                  ? "Free"
                  : planConfig.priceMonthly === null
                    ? "Custom"
                    : `$${planConfig.priceMonthly}/mo`}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Submissions</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold">{totalCount}</div>
                <CardDescription>
                  {totalCount === 0
                    ? "No submissions yet"
                    : `${totalCount} total submission${totalCount !== 1 ? "s" : ""}`}
                </CardDescription>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Analytics charts */}
      <GradeCharts />

      {/* Listing optimization suggestions */}
      {inventoryData && (
        <ListingSuggestions
          items={inventoryData.items}
          listings={inventoryData.listings}
          gradeReports={inventoryData.gradeReports}
          maxItems={5}
        />
      )}

      {/* Recent submissions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Recent Submissions</CardTitle>
              <CardDescription>Your latest grading submissions.</CardDescription>
            </div>
            {recentSubmissions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/dashboard/submissions")}
              >
                View All
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-12 flex-1" />
                </div>
              ))}
            </div>
          ) : recentSubmissions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-medium">No submissions yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Upload photos of a garment to get your first AI-powered condition grade.
              </p>
              <Button
                className="mt-4"
                onClick={() => navigate("/dashboard/submissions/new")}
              >
                <Plus className="mr-1 h-4 w-4" />
                Submit Your First Garment
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {recentSubmissions.map((sub) => (
                <div
                  key={sub.id}
                  className="flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50"
                  onClick={() => navigate(`/dashboard/submissions/${sub.id}`)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{sub.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {new Date(sub.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge
                      variant="outline"
                      className={cn(getStatusBadgeClasses(sub.status))}
                    >
                      {formatLabel(sub.status)}
                    </Badge>
                    {sub.grade_report ? (
                      <span
                        className={cn(
                          "min-w-[2.5rem] text-right text-sm font-semibold",
                          getScoreColor(sub.grade_report.overall_score)
                        )}
                      >
                        {sub.grade_report.overall_score.toFixed(1)}
                      </span>
                    ) : (
                      <span className="min-w-[2.5rem] text-right text-sm text-muted-foreground">
                        —
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
