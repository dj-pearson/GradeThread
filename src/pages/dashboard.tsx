import { useAuth } from "@/hooks/use-auth";
import { PLANS } from "@/lib/constants";
import type { PlanKey } from "@/lib/constants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3, FileText, TrendingUp } from "lucide-react";

export function DashboardPage() {
  const { profile } = useAuth();

  const plan = profile?.plan ?? "free";
  const planConfig = PLANS[plan as PlanKey];
  const gradesUsed = profile?.grades_used_this_month ?? 0;
  const gradesLimit = planConfig.gradesPerMonth === -1 ? "Unlimited" : planConfig.gradesPerMonth;
  const gradesPercent =
    typeof gradesLimit === "number" ? Math.round((gradesUsed / gradesLimit) * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back{profile?.full_name ? `, ${profile.full_name}` : ""}.
        </p>
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
            <CardTitle className="text-sm font-medium">Recent Submissions</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">0</div>
            <CardDescription>No submissions yet</CardDescription>
          </CardContent>
        </Card>
      </div>

      {/* Recent activity placeholder */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Your latest grading submissions will appear here.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-medium">No submissions yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload photos of a garment to get your first AI-powered condition grade.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
