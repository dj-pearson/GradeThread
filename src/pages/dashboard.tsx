import { lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { ScoreBandIcon } from "@/components/grade/score-indicator";
import { supabase } from "@/lib/supabase";
import { fetchInChunks } from "@/lib/supabase-batch";
import { PLANS } from "@/lib/constants";
import type { PlanKey } from "@/lib/constants";
import type { SubmissionRow, GradeReportRow, InventoryItemRow, ListingRow } from "@/types/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3,
  FileText,
  TrendingUp,
  Plus,
  KeyRound,
  Package,
  DollarSign,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ChartSkeleton } from "@/components/ui/skeletons";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";

// Defer the Recharts bundle so the dashboard shell paints before charts load.
const GradeCharts = lazy(() =>
  import("@/components/dashboard/grade-charts").then((m) => ({
    default: m.GradeCharts,
  })),
);
import { ListingSuggestions } from "@/components/analytics/listing-suggestions";
import { FlipdeskPromoCard } from "@/components/flipdesk/flipdesk-promo-card";
import { UsageMeters } from "@/components/billing/usage-meter";

interface RecentSubmission extends SubmissionRow {
  grade_report?: Pick<GradeReportRow, "overall_score" | "grade_tier"> | null;
}

function getStatusBadgeClasses(status: string): string {
  switch (status) {
    case "completed":
      return "border-green-200 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300";
    case "processing":
      return "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300";
    case "pending":
      return "border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300";
    case "failed":
      return "border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300";
    case "disputed":
      return "border-purple-200 bg-purple-100 text-purple-800 dark:border-purple-800 dark:bg-purple-950/50 dark:text-purple-300";
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
  if (score > 7) return "text-green-600 dark:text-green-400";
  if (score >= 5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
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

  const {
    data: submissionData,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
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
      // US-411: the listing-suggestions widget only acts on ACTIVE inventory
      // (it skips sold/shipped/completed/returned) and reads a handful of
      // columns. Push the status filter + a candidate cap to the server and
      // select just the rendered columns so this query stays fast regardless of
      // total inventory size (was select('*') over ALL inventory_items).
      const SUGGESTION_CANDIDATE_CAP = 200;
      // Cheap index-only count (head: no rows transferred) preserves the
      // FlipdeskPromoCard's "do they have ANY inventory yet?" gate, independent
      // of the active-only candidate query below.
      const { count: totalItemCount } = await supabase
        .from("inventory_items")
        .select("id", { count: "exact", head: true });
      const { data: itemsRaw } = await supabase
        .from("inventory_items")
        .select("id, status, title, submission_id")
        .not("status", "in", "(sold,shipped,completed,returned)")
        .order("created_at", { ascending: false })
        .limit(SUGGESTION_CANDIDATE_CAP);
      const items = (itemsRaw ?? []) as unknown as InventoryItemRow[];

      const itemIds = items.map((i) => i.id);
      const allListings = await fetchInChunks<ListingRow>(itemIds, async (chunk) => {
        const { data, error } = await supabase
          .from("listings")
          .select("inventory_item_id, is_active, listed_at, platform")
          .in("inventory_item_id", chunk);
        return { data: data as unknown as ListingRow[] | null, error };
      });

      const submissionIds = items
        .map((i) => i.submission_id)
        .filter((id): id is string => id !== null);
      const allReports = await fetchInChunks<GradeReportRow>(submissionIds, async (chunk) => {
        const { data, error } = await supabase
          .from("grade_reports")
          .select("submission_id, confidence_score")
          .in("submission_id", chunk);
        return { data: data as unknown as GradeReportRow[] | null, error };
      });

      return {
        items,
        listings: allListings,
        gradeReports: allReports,
        totalItemCount: totalItemCount ?? 0,
      };
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

      {/* Quick Actions */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Button
          variant="outline"
          className="h-auto justify-start gap-3 py-3"
          onClick={() => navigate("/dashboard/submissions/new")}
        >
          <Plus className="h-5 w-5 text-primary" />
          <span className="text-left">
            <span className="block text-sm font-medium">New Submission</span>
            <span className="block text-xs text-muted-foreground">
              Grade a garment
            </span>
          </span>
        </Button>
        <Button
          variant="outline"
          className="h-auto justify-start gap-3 py-3"
          onClick={() => navigate("/dashboard/inventory/new")}
        >
          <Package className="h-5 w-5 text-primary" />
          <span className="text-left">
            <span className="block text-sm font-medium">
              Add Inventory Item
            </span>
            <span className="block text-xs text-muted-foreground">
              Track a new item
            </span>
          </span>
        </Button>
        <Button
          variant="outline"
          className="h-auto justify-start gap-3 py-3"
          onClick={() => navigate("/dashboard/finances")}
        >
          <DollarSign className="h-5 w-5 text-primary" />
          <span className="text-left">
            <span className="block text-sm font-medium">View Finances</span>
            <span className="block text-xs text-muted-foreground">
              Profit &amp; analytics
            </span>
          </span>
        </Button>
      </div>

      {/* Plan usage meters (US-214) */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Usage</h2>
        <UsageMeters />
      </div>

      {/* FlipDesk cross-promotion (zero-inventory users only) */}
      <FlipdeskPromoCard itemCount={inventoryData?.totalItemCount} />

      {/* Use-case tailored quick start */}
      {profile?.use_case === "developer" && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-primary/10 p-2">
                <KeyRound className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">Developer quick start</p>
                <p className="text-xs text-muted-foreground">
                  Generate an API key and start grading garments
                  programmatically.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/dashboard/api-keys")}
            >
              Manage API Keys
            </Button>
          </CardContent>
        </Card>
      )}

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
            ) : isError ? (
              <p className="text-sm text-destructive">Failed to load</p>
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
      <Suspense fallback={<ChartSkeleton />}>
        <GradeCharts />
      </Suspense>

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
          {isError ? (
            <ErrorState
              title="Couldn't load recent submissions"
              description="Something went wrong while loading your submissions. This is usually temporary."
              onRetry={() => refetch()}
              retrying={isFetching}
            />
          ) : isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-12 flex-1" />
                </div>
              ))}
            </div>
          ) : recentSubmissions.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No submissions yet"
              description="Upload photos of a garment to get your first AI-powered condition grade."
              action={{
                label: "Submit your first garment",
                onClick: () => navigate("/dashboard/submissions/new"),
                icon: Plus,
              }}
            />
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
                          "inline-flex min-w-[2.5rem] items-center justify-end gap-1 text-sm font-semibold",
                          getScoreColor(sub.grade_report.overall_score)
                        )}
                        title={sub.grade_report.grade_tier}
                      >
                        <ScoreBandIcon
                          score={sub.grade_report.overall_score}
                        />
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
