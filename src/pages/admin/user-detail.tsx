import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type {
  UserRow,
  SubmissionRow,
  GradeReportRow,
  AdminAuditLogInsert,
  UserPlan,
  UserRole,
} from "@/types/database";
import { PLANS } from "@/lib/constants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ArrowLeft,
  User,
  Mail,
  Calendar,
  Shield,
  CreditCard,
  FileText,
  BarChart3,
  Ban,
  CheckCircle,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  processing: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  disputed: "bg-orange-100 text-orange-700",
};

const PLAN_COLORS: Record<string, string> = {
  free: "bg-gray-100 text-gray-700",
  starter: "bg-green-100 text-green-700",
  professional: "bg-blue-100 text-blue-700",
  enterprise: "bg-amber-100 text-amber-700",
};

const ROLE_COLORS: Record<string, string> = {
  user: "bg-gray-100 text-gray-700",
  reviewer: "bg-blue-100 text-blue-700",
  admin: "bg-purple-100 text-purple-700",
  super_admin: "bg-red-100 text-red-700",
};

function formatRole(role: string): string {
  if (role === "super_admin") return "Super Admin";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface UserDetailData {
  user: UserRow;
  submissions: SubmissionRow[];
  gradeReports: GradeReportRow[];
}

async function createAuditLog(entry: AdminAuditLogInsert) {
  const { error } = await supabase
    .from("admin_audit_log")
    .insert(entry as never);
  if (error) {
    console.error("Failed to create audit log:", error);
  }
}

export function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile: adminProfile } = useAuth();

  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<UserPlan | null>(null);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [pendingRole, setPendingRole] = useState<UserRole | null>(null);
  const [suspendDialogOpen, setSuspendDialogOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-user-detail", id],
    queryFn: async () => {
      if (!id) throw new Error("Missing user ID");

      const [userRes, subsRes, reportsRes] = await Promise.all([
        supabase.from("users").select("*").eq("id", id).single(),
        supabase
          .from("submissions")
          .select("*")
          .eq("user_id", id)
          .order("created_at", { ascending: false }),
        supabase.from("grade_reports").select("*"),
      ]);

      if (userRes.error) throw userRes.error;
      if (subsRes.error) throw subsRes.error;
      if (reportsRes.error) throw reportsRes.error;

      const user = userRes.data as UserRow;
      const submissions = (subsRes.data ?? []) as SubmissionRow[];
      const allReports = (reportsRes.data ?? []) as GradeReportRow[];

      // Filter reports for this user's submissions
      const submissionIds = new Set(submissions.map((s) => s.id));
      const gradeReports = allReports.filter((r) =>
        submissionIds.has(r.submission_id)
      );

      return { user, submissions, gradeReports } as UserDetailData;
    },
    staleTime: 30 * 1000,
  });

  const targetUser = data?.user;
  const submissions = data?.submissions ?? [];
  const gradeReports = data?.gradeReports ?? [];

  // Build a map of submission_id -> grade report for display
  const reportsBySubmission = new Map<string, GradeReportRow>();
  for (const r of gradeReports) {
    reportsBySubmission.set(r.submission_id, r);
  }

  // Usage stats
  const totalSubmissions = submissions.length;
  const completedSubmissions = submissions.filter(
    (s) => s.status === "completed"
  ).length;
  const averageGrade =
    gradeReports.length > 0
      ? Math.round(
          (gradeReports.reduce((sum, r) => sum + r.overall_score, 0) /
            gradeReports.length) *
            10
        ) / 10
      : 0;

  // Determine if user is "suspended" (role set to 'user' by admin is not suspension;
  // We'll treat plan === 'free' with stripe_customer_id as potentially suspended,
  // but the simplest approach: we'll add a visual "suspended" concept.
  // For now, we'll consider "suspended" as a conceptual action that sets plan to 'free'
  // and adds audit log. Real suspension would need a DB column, but we can
  // work within existing schema by treating plan downgrade + audit log as suspension.)

  async function handlePlanChange() {
    if (!targetUser || !pendingPlan || !adminProfile) return;
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from("users")
        .update({ plan: pendingPlan } as never)
        .eq("id", targetUser.id);
      if (error) throw error;

      await createAuditLog({
        admin_user_id: adminProfile.id,
        action: "change_plan",
        target_type: "user",
        target_id: targetUser.id,
        details: {
          previous_plan: targetUser.plan,
          new_plan: pendingPlan,
        },
      });

      toast.success(`Plan changed to ${PLANS[pendingPlan]?.name ?? pendingPlan}`);
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (err) {
      toast.error("Failed to change plan");
      console.error(err);
    } finally {
      setActionLoading(false);
      setPlanDialogOpen(false);
      setPendingPlan(null);
    }
  }

  async function handleRoleChange() {
    if (!targetUser || !pendingRole || !adminProfile) return;
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from("users")
        .update({ role: pendingRole } as never)
        .eq("id", targetUser.id);
      if (error) throw error;

      await createAuditLog({
        admin_user_id: adminProfile.id,
        action: "change_role",
        target_type: "user",
        target_id: targetUser.id,
        details: {
          previous_role: targetUser.role,
          new_role: pendingRole,
        },
      });

      toast.success(`Role changed to ${formatRole(pendingRole)}`);
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (err) {
      toast.error("Failed to change role");
      console.error(err);
    } finally {
      setActionLoading(false);
      setRoleDialogOpen(false);
      setPendingRole(null);
    }
  }

  async function handleSuspendToggle() {
    if (!targetUser || !adminProfile) return;
    setActionLoading(true);

    // Toggle: if user plan is "free" and they have a stripe_customer_id
    // (were on a paid plan), we treat "unsuspend" as restoring starter.
    // Otherwise "suspend" means downgrade to free.
    // More practically: "suspend" sets plan to free, "unsuspend" restores starter.
    const isSuspending = targetUser.plan !== "free";
    const newPlan: UserPlan = isSuspending ? "free" : "starter";

    try {
      const { error } = await supabase
        .from("users")
        .update({ plan: newPlan } as never)
        .eq("id", targetUser.id);
      if (error) throw error;

      await createAuditLog({
        admin_user_id: adminProfile.id,
        action: isSuspending ? "suspend_user" : "unsuspend_user",
        target_type: "user",
        target_id: targetUser.id,
        details: {
          previous_plan: targetUser.plan,
          new_plan: newPlan,
        },
      });

      toast.success(
        isSuspending ? "User suspended (plan set to Free)" : "User unsuspended (plan set to Starter)"
      );
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (err) {
      toast.error(isSuspending ? "Failed to suspend user" : "Failed to unsuspend user");
      console.error(err);
    } finally {
      setActionLoading(false);
      setSuspendDialogOpen(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-64" />
          <Skeleton className="col-span-2 h-64" />
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (!targetUser) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-lg text-muted-foreground">User not found</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate("/admin/users")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Users
        </Button>
      </div>
    );
  }

  const initials = targetUser.full_name
    ? targetUser.full_name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
    : targetUser.email[0]?.toUpperCase() ?? "?";

  const isSuspended = targetUser.plan === "free" && targetUser.stripe_customer_id !== null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/admin/users")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">User Details</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Profile Info Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                <AvatarImage src={targetUser.avatar_url ?? undefined} />
                <AvatarFallback className="bg-brand-navy text-white text-lg">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-lg font-semibold">
                  {targetUser.full_name || "No name set"}
                </p>
                <p className="text-sm text-muted-foreground">{targetUser.email}</p>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-sm">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">ID:</span>
                <span className="font-mono text-xs">{targetUser.id.slice(0, 8)}...</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Email:</span>
                <span>{targetUser.email}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <CreditCard className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Plan:</span>
                <Badge variant="secondary" className={PLAN_COLORS[targetUser.plan] ?? ""}>
                  {PLANS[targetUser.plan]?.name ?? targetUser.plan}
                </Badge>
                {isSuspended && (
                  <Badge variant="destructive" className="ml-1">Suspended</Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Role:</span>
                <Badge variant="secondary" className={ROLE_COLORS[targetUser.role] ?? ""}>
                  {formatRole(targetUser.role)}
                </Badge>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Joined:</span>
                <span>{formatDate(targetUser.created_at)}</span>
              </div>
              {targetUser.stripe_customer_id && (
                <div className="flex items-center gap-2 text-sm">
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Stripe:</span>
                  <span className="font-mono text-xs">
                    {targetUser.stripe_customer_id.slice(0, 14)}...
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Usage Stats + Admin Actions */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Usage Stats & Admin Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Stats Grid */}
            <div className="grid gap-4 sm:grid-cols-4">
              <div className="rounded-lg border p-3 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground">
                  <FileText className="h-4 w-4" />
                </div>
                <p className="mt-1 text-2xl font-bold">{totalSubmissions}</p>
                <p className="text-xs text-muted-foreground">Total Submissions</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground">
                  <CheckCircle className="h-4 w-4" />
                </div>
                <p className="mt-1 text-2xl font-bold">{completedSubmissions}</p>
                <p className="text-xs text-muted-foreground">Completed</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground">
                  <BarChart3 className="h-4 w-4" />
                </div>
                <p className="mt-1 text-2xl font-bold">
                  {averageGrade ? averageGrade.toFixed(1) : "—"}
                </p>
                <p className="text-xs text-muted-foreground">Avg Grade</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground">
                  <CreditCard className="h-4 w-4" />
                </div>
                <p className="mt-1 text-2xl font-bold">
                  {targetUser.grades_used_this_month}
                </p>
                <p className="text-xs text-muted-foreground">Grades This Month</p>
              </div>
            </div>

            {/* Admin Actions */}
            <div className="space-y-4 rounded-lg border p-4">
              <h3 className="text-sm font-semibold">Admin Actions</h3>

              <div className="grid gap-4 sm:grid-cols-3">
                {/* Change Plan */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Change Plan
                  </label>
                  <Select
                    value={targetUser.plan}
                    onValueChange={(v) => {
                      if (v !== targetUser.plan) {
                        setPendingPlan(v as UserPlan);
                        setPlanDialogOpen(true);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="free">Free</SelectItem>
                      <SelectItem value="starter">Starter</SelectItem>
                      <SelectItem value="professional">Professional</SelectItem>
                      <SelectItem value="enterprise">Enterprise</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Change Role */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Change Role
                  </label>
                  <Select
                    value={targetUser.role}
                    onValueChange={(v) => {
                      if (v !== targetUser.role) {
                        setPendingRole(v as UserRole);
                        setRoleDialogOpen(true);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="reviewer">Reviewer</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="super_admin">Super Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Suspend / Unsuspend */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    Account Status
                  </label>
                  <Button
                    variant={targetUser.plan === "free" ? "default" : "destructive"}
                    className="w-full"
                    onClick={() => setSuspendDialogOpen(true)}
                  >
                    {targetUser.plan === "free" ? (
                      <>
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Unsuspend
                      </>
                    ) : (
                      <>
                        <Ban className="mr-2 h-4 w-4" />
                        Suspend
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Subscription History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Subscription Info</CardTitle>
          <CardDescription>Current plan and billing details</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Current Plan</p>
              <p className="mt-1 text-lg font-semibold">
                {PLANS[targetUser.plan]?.name ?? targetUser.plan}
              </p>
              {PLANS[targetUser.plan]?.priceMonthly !== null &&
                PLANS[targetUser.plan]?.priceMonthly !== undefined && (
                  <p className="text-sm text-muted-foreground">
                    ${PLANS[targetUser.plan].priceMonthly}/mo
                  </p>
                )}
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Grade Limit</p>
              <p className="mt-1 text-lg font-semibold">
                {PLANS[targetUser.plan]?.gradesPerMonth === -1
                  ? "Unlimited"
                  : `${PLANS[targetUser.plan]?.gradesPerMonth}/mo`}
              </p>
              <p className="text-sm text-muted-foreground">
                {targetUser.grades_used_this_month} used this month
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Grade Reset</p>
              <p className="mt-1 text-lg font-semibold">
                {formatDate(targetUser.grade_reset_at)}
              </p>
              <p className="text-sm text-muted-foreground">Next counter reset</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Submission History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Submission History</CardTitle>
          <CardDescription>{totalSubmissions} submission{totalSubmissions !== 1 ? "s" : ""} total</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                    No submissions yet
                  </TableCell>
                </TableRow>
              ) : (
                submissions.slice(0, 20).map((sub) => {
                  const report = reportsBySubmission.get(sub.id);
                  return (
                    <TableRow key={sub.id}>
                      <TableCell className="font-medium">{sub.title}</TableCell>
                      <TableCell className="capitalize text-muted-foreground">
                        {sub.garment_type}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={STATUS_COLORS[sub.status] ?? ""}
                        >
                          {sub.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {report ? (
                          <span className={`font-semibold ${
                            report.overall_score >= 7
                              ? "text-green-600"
                              : report.overall_score >= 5
                                ? "text-yellow-600"
                                : "text-red-600"
                          }`}>
                            {report.overall_score.toFixed(1)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(sub.created_at)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {submissions.length > 20 && (
            <div className="border-t px-4 py-3 text-center text-sm text-muted-foreground">
              Showing 20 of {submissions.length} submissions
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialogs */}

      {/* Plan Change Dialog */}
      <AlertDialog open={planDialogOpen} onOpenChange={setPlanDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change User Plan</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to change{" "}
              <strong>{targetUser.full_name || targetUser.email}</strong>'s plan
              from <strong>{PLANS[targetUser.plan]?.name}</strong> to{" "}
              <strong>{pendingPlan ? (PLANS[pendingPlan]?.name ?? pendingPlan) : ""}</strong>?
              This will take effect immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handlePlanChange} disabled={actionLoading}>
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm Change
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Role Change Dialog */}
      <AlertDialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change User Role</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to change{" "}
              <strong>{targetUser.full_name || targetUser.email}</strong>'s role
              from <strong>{formatRole(targetUser.role)}</strong> to{" "}
              <strong>{pendingRole ? formatRole(pendingRole) : ""}</strong>?
              {pendingRole === "admin" || pendingRole === "super_admin"
                ? " This will grant administrative access to the platform."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRoleChange} disabled={actionLoading}>
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm Change
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Suspend/Unsuspend Dialog */}
      <AlertDialog open={suspendDialogOpen} onOpenChange={setSuspendDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {targetUser.plan === "free" ? "Unsuspend User" : "Suspend User"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {targetUser.plan === "free" ? (
                <>
                  This will restore{" "}
                  <strong>{targetUser.full_name || targetUser.email}</strong>'s
                  account to the <strong>Starter</strong> plan.
                </>
              ) : (
                <>
                  This will downgrade{" "}
                  <strong>{targetUser.full_name || targetUser.email}</strong>'s
                  account to the <strong>Free</strong> plan, effectively suspending
                  their paid features. This action can be reversed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSuspendToggle} disabled={actionLoading}>
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {targetUser.plan === "free" ? "Unsuspend" : "Suspend"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
