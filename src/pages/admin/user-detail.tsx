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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Eye,
  MessageSquare,
  Send,
} from "lucide-react";
import { startImpersonation } from "@/lib/impersonation";
import { toast } from "sonner";
import * as Sentry from "@sentry/react";
import { BillingActionsCard } from "@/components/admin/billing-actions-card";
import { CreditLedgerCard } from "@/components/admin/credit-ledger-card";
import { UserRateLimitsCard } from "@/components/admin/user-rate-limits-card";
import { UserTimelineCard } from "@/components/admin/user-timeline-card";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
  processing: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  completed: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  disputed: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
};

const PLAN_COLORS: Record<string, string> = {
  free: "bg-muted text-muted-foreground",
  starter: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  professional: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  enterprise: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
};

const ROLE_COLORS: Record<string, string> = {
  user: "bg-muted text-muted-foreground",
  reviewer: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  admin: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
  super_admin: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
};

// US-582: transactional message starting points. Mirrors the seed templates in
// services/edge-functions/src/routes/admin-messages.ts — the admin can edit any
// field before sending, and the server only ever sends the subject/body it gets.
const MESSAGE_TEMPLATES: { id: string; label: string; subject: string; body: string }[] = [
  {
    id: "support_followup",
    label: "Support follow-up",
    subject: "Following up on your GradeThread support request",
    body:
      "Thanks for reaching out to GradeThread support.\n\n" +
      "[Write your response here.]\n\n" +
      "If there's anything else we can help with, just reply to this email.",
  },
  {
    id: "payment_reminder",
    label: "Payment / billing notice",
    subject: "Action needed on your GradeThread account",
    body:
      "We noticed an issue with the most recent payment on your account.\n\n" +
      "[Describe the billing issue and the action needed.]\n\n" +
      "You can update your billing details from the Billing page in your dashboard.",
  },
  {
    id: "account_notice",
    label: "Account notice",
    subject: "An update about your GradeThread account",
    body:
      "We're reaching out with an important update about your account.\n\n" +
      "[Write the account notice here.]",
  },
];

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
    // US-785: the admin action itself already completed — surface the audit-log
    // failure (a compliance gap) to the admin + Sentry rather than swallowing it.
    if (import.meta.env.DEV) console.error("Failed to create audit log:", error);
    Sentry.captureException(error, { tags: { area: "admin.audit_log_write" } });
    toast.warning("Action completed, but the audit-log entry failed to write.");
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
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [suspendStepUpOpen, setSuspendStepUpOpen] = useState(false);
  const [impersonateDialogOpen, setImpersonateDialogOpen] = useState(false);
  const [impersonating, setImpersonating] = useState(false);
  const [impersonateStepUpOpen, setImpersonateStepUpOpen] = useState(false);
  const [messageDialogOpen, setMessageDialogOpen] = useState(false);
  const [msgTemplate, setMsgTemplate] = useState<string>("free");
  const [msgSubject, setMsgSubject] = useState("");
  const [msgBody, setMsgBody] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);

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
      if (import.meta.env.DEV) console.error(err);
    } finally {
      setActionLoading(false);
      setPlanDialogOpen(false);
      setPendingPlan(null);
    }
  }

  // US-270: role changes run server-side (POST /api/admin/users/:id/role) where
  // they're gated by a fresh MFA step-up + audited — not a client-side supabase
  // update. On STEP_UP_REQUIRED we open the authenticator dialog and retry.
  async function handleRoleChange() {
    if (!targetUser || !pendingRole) return;
    setActionLoading(true);
    try {
      const res = await edgeFetch(
        `/api/admin/users/${targetUser.id}/role`,
        { method: "POST", json: { role: pendingRole }, silentGate: true },
      );
      if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        if (data?.code === "STEP_UP_REQUIRED") {
          setStepUpOpen(true); // dialog's onVerified retries
          return;
        }
        throw new Error(data?.error ?? "Forbidden");
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Role changed to ${formatRole(pendingRole)}`);
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setRoleDialogOpen(false);
      setPendingRole(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change role");
      if (import.meta.env.DEV) console.error(err);
    } finally {
      setActionLoading(false);
    }
  }

  // US-588: suspension is now ONE thing — the `users.suspended` flag, the same
  // mechanism the moderation "Ban user" action sets and that every grading /
  // referral surface enforces server-side. (The old behaviour here merely
  // downgraded the plan to free, which blocked nothing.) Runs through the
  // audited, step-up-gated edge endpoint; on STEP_UP_REQUIRED we open the
  // authenticator dialog and retry.
  async function handleSuspendToggle() {
    if (!targetUser) return;
    const isSuspending = !targetUser.suspended;
    setActionLoading(true);
    try {
      const res = await edgeFetch(
        `/api/admin/users/${targetUser.id}/suspend`,
        {
          method: "POST",
          json: { suspended: isSuspending },
          silentGate: true,
        },
      );
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        if (body?.code === "STEP_UP_REQUIRED") {
          setSuspendStepUpOpen(true); // dialog's onVerified retries
          return;
        }
        throw new Error(body?.error ?? "Forbidden");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast.success(isSuspending ? "User suspended" : "User reinstated");
      queryClient.invalidateQueries({ queryKey: ["admin-user-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setSuspendDialogOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : isSuspending
            ? "Failed to suspend user"
            : "Failed to reinstate user",
      );
      if (import.meta.env.DEV) console.error(err);
    } finally {
      setActionLoading(false);
    }
  }

  // US-581: super-admin "view as". Mints a session as the target user (gated by
  // a fresh MFA step-up on the server) and swaps the browser into it, then hard-
  // navigates to the target's dashboard. The persistent banner + Exit live in
  // the dashboard layout.
  async function handleImpersonate() {
    if (!targetUser) return;
    setImpersonating(true);
    try {
      const result = await startImpersonation(targetUser.id);
      if (result.ok) {
        setImpersonateDialogOpen(false);
        window.location.assign("/dashboard");
        return;
      }
      if (result.stepUpRequired) {
        setImpersonateStepUpOpen(true); // dialog's onVerified retries
        return;
      }
      toast.error(result.error || "Failed to start impersonation");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start impersonation");
    } finally {
      setImpersonating(false);
    }
  }

  // US-582: prefill compose fields from a canned template (or clear for free-form).
  function applyTemplate(templateId: string) {
    setMsgTemplate(templateId);
    const tpl = MESSAGE_TEMPLATES.find((t) => t.id === templateId);
    if (tpl) {
      setMsgSubject(tpl.subject);
      setMsgBody(tpl.body);
    } else {
      setMsgSubject("");
      setMsgBody("");
    }
  }

  // US-582: send a transactional support/account email to this user. Goes through
  // the admin-gated, rate-limited, audited edge endpoint; the user also gets an
  // in-app copy. Not for marketing — this is account/support comms only.
  async function handleSendMessage() {
    if (!targetUser) return;
    if (!msgSubject.trim() || !msgBody.trim()) {
      toast.error("Subject and message are both required.");
      return;
    }
    setSendingMessage(true);
    try {
      const res = await edgeFetch(`/api/admin/messages/${targetUser.id}`, {
        method: "POST",
        json: {
          subject: msgSubject.trim(),
          body: msgBody.trim(),
          templateId: msgTemplate === "free" ? null : msgTemplate,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        toast.error(data?.error || "Failed to send message");
        return;
      }
      toast.success(
        data?.delivered === false
          ? "Message recorded — delivery queued for retry."
          : "Message sent.",
      );
      setMessageDialogOpen(false);
      setMsgTemplate("free");
      setMsgSubject("");
      setMsgBody("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send message");
      if (import.meta.env.DEV) console.error(err);
    } finally {
      setSendingMessage(false);
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

  const isSuspended = targetUser.suspended;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/admin/users")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">User Details</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMessageDialogOpen(true)}
          >
            <MessageSquare className="mr-2 h-4 w-4" />
            Message
          </Button>
          {adminProfile?.role === "super_admin" &&
            targetUser.role !== "admin" &&
            targetUser.role !== "super_admin" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImpersonateDialogOpen(true)}
              >
                <Eye className="mr-2 h-4 w-4" />
                View as user
              </Button>
            )}
        </div>
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
                    variant={isSuspended ? "default" : "destructive"}
                    className="w-full"
                    onClick={() => setSuspendDialogOpen(true)}
                  >
                    {isSuspended ? (
                      <>
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Reinstate
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

      {/* Billing actions (US-221) */}
      <BillingActionsCard
        userId={targetUser.id}
        currentTrialEndsAt={targetUser.trial_ends_at}
      />

      {/* Credits & ledger (US-892) — inspect ledger, manual adjust, pack refund. */}
      <CreditLedgerCard userId={targetUser.id} />

      {/* Rate-limit administration (US-890) — counters + temporary overrides. */}
      <UserRateLimitsCard userId={targetUser.id} />

      {/* User 360 activity timeline (US-902) — one chronological cross-domain feed. */}
      <UserTimelineCard userId={targetUser.id} />

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
                              ? "text-green-600 dark:text-green-400"
                              : report.overall_score >= 5
                                ? "text-yellow-600 dark:text-yellow-400"
                                : "text-red-600 dark:text-red-400"
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
            <AlertDialogTitle>Change user plan</AlertDialogTitle>
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
              Change plan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Role Change Dialog */}
      <AlertDialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change user role</AlertDialogTitle>
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
              Change role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Suspend/Reinstate Dialog (US-588) */}
      <AlertDialog open={suspendDialogOpen} onOpenChange={setSuspendDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isSuspended ? "Reinstate user" : "Suspend user"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isSuspended ? (
                <>
                  This will lift the suspension on{" "}
                  <strong>{targetUser.full_name || targetUser.email}</strong>'s
                  account, restoring their ability to create submissions and use
                  the platform.
                </>
              ) : (
                <>
                  This will suspend{" "}
                  <strong>{targetUser.full_name || targetUser.email}</strong>'s
                  account. They will be blocked server-side from creating new
                  submissions, grading, and redeeming referrals across all
                  surfaces. Their plan is unchanged. This action can be reversed.
                  You may be asked to confirm your authenticator first.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSuspendToggle} disabled={actionLoading}>
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSuspended ? "Reinstate" : "Suspend"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* US-588: step-up re-auth for suspend/reinstate, then retry. */}
      <MfaStepUpDialog
        open={suspendStepUpOpen}
        onOpenChange={setSuspendStepUpOpen}
        onVerified={() => {
          void handleSuspendToggle();
        }}
      />

      {/* US-270: step-up re-auth for the role change, then retry. */}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          void handleRoleChange();
        }}
      />

      {/* US-581: confirm "view as", then start impersonation. */}
      <AlertDialog open={impersonateDialogOpen} onOpenChange={setImpersonateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>View as this user?</AlertDialogTitle>
            <AlertDialogDescription>
              You'll be signed into{" "}
              <strong>{targetUser.full_name || targetUser.email}</strong>'s
              account and see GradeThread exactly as they do. A banner will stay
              visible the whole time, and any action you take affects their
              account. This is logged. You may be asked to confirm your
              authenticator first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={impersonating}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleImpersonate} disabled={impersonating}>
              {impersonating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              View as user
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* US-581: step-up re-auth for impersonation, then retry. */}
      <MfaStepUpDialog
        open={impersonateStepUpOpen}
        onOpenChange={setImpersonateStepUpOpen}
        onVerified={() => {
          void handleImpersonate();
        }}
      />

      {/* US-582: compose & send a transactional support/account email. */}
      <Dialog open={messageDialogOpen} onOpenChange={setMessageDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Message {targetUser.full_name || targetUser.email}</DialogTitle>
            <DialogDescription>
              Sends a transactional email to <strong>{targetUser.email}</strong> and
              records an in-app copy. For account &amp; support comms only — not
              marketing. This action is logged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="msg-template">Template</Label>
              <Select value={msgTemplate} onValueChange={applyTemplate}>
                <SelectTrigger id="msg-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">Free-form</SelectItem>
                  {MESSAGE_TEMPLATES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="msg-subject">Subject</Label>
              <Input
                id="msg-subject"
                value={msgSubject}
                maxLength={200}
                placeholder="Subject line"
                onChange={(e) => setMsgSubject(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="msg-body">Message</Label>
              <Textarea
                id="msg-body"
                value={msgBody}
                maxLength={5000}
                rows={8}
                placeholder="Write your message…"
                onChange={(e) => setMsgBody(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {msgBody.length}/5000 — blank lines start new paragraphs.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setMessageDialogOpen(false)}
              disabled={sendingMessage}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSendMessage}
              disabled={sendingMessage || !msgSubject.trim() || !msgBody.trim()}
            >
              {sendingMessage ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Send message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
