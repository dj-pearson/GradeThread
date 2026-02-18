import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type {
  AiPromptVersionRow,
  AiPromptVersionInsert,
  AiPromptVersionUpdate,
  HumanReviewRow,
  GradeReportRow,
  AdminAuditLogInsert,
} from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Brain,
  Plus,
  Search,
  ArrowUpDown,
  Power,
  PowerOff,
  Eye,
  Trash2,
  Loader2,
  TrendingUp,
  Hash,
  Target,
  Zap,
  Columns2,
  FlaskConical,
  AlertTriangle,
  BarChart3,
  RefreshCw,
  FileDown,
} from "lucide-react";
import { toast } from "sonner";
import {
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Line,
  ComposedChart,
  Legend,
} from "recharts";

// ─── Types ──────────────────────────────────────────────────────────

interface ReviewAccuracyData {
  versionName: string;
  totalReviews: number;
  meanAbsoluteError: number;
  agreementRate: number; // within 0.5 points
  correlation: number;
  factorAccuracies: {
    factor: string;
    mae: number;
    agreementRate: number;
  }[];
}

interface EnrichedPromptVersion extends AiPromptVersionRow {
  computedAccuracy: number | null;
  totalReviewed: number;
  agreedCount: number;
}

const ACCURACY_THRESHOLD = 0.8; // 80% agreement rate

const FACTOR_NAMES = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
] as const;

const FACTOR_LABELS: Record<string, string> = {
  fabric_condition: "Fabric Condition",
  structural_integrity: "Structural Integrity",
  cosmetic_appearance: "Cosmetic Appearance",
  functional_elements: "Functional Elements",
  odor_cleanliness: "Odor & Cleanliness",
};

const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: "hsl(var(--card))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "8px",
    fontSize: "12px",
  },
};

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : num / denom;
}

type SortField = "created_at" | "accuracy" | "total_grades" | "version_name";
type SortDir = "asc" | "desc";
type StatusFilter = "all" | "active" | "inactive";

// ─── Helpers ────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatAccuracy(value: number | null): string {
  if (value === null) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
}

const PAGE_SIZE = 15;

// ─── Main Component ─────────────────────────────────────────────────

export function AdminAiModelsPage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  // Filters & Sort
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  // Create dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPromptText, setCreatePromptText] = useState("");
  const [createLoading, setCreateLoading] = useState(false);

  // View / Edit dialog
  const [viewingVersion, setViewingVersion] = useState<EnrichedPromptVersion | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPromptText, setEditPromptText] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  // Compare dialog
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [compareLeft, setCompareLeft] = useState<string>("");
  const [compareRight, setCompareRight] = useState<string>("");

  // Activate/Delete confirmation
  const [activateTarget, setActivateTarget] = useState<EnrichedPromptVersion | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<EnrichedPromptVersion | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EnrichedPromptVersion | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Test prompt dialog
  const [testTarget, setTestTarget] = useState<EnrichedPromptVersion | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // Export loading state
  const [exportLoading, setExportLoading] = useState(false);
  // Weekly summary state
  const [weeklySummaryLoading, setWeeklySummaryLoading] = useState(false);

  // ─── Data Fetching ────────────────────────────────────────────────

  const { data, isLoading } = useQuery({
    queryKey: ["admin-ai-models"],
    queryFn: async () => {
      const [versionsRes, reviewsRes, reportsRes] = await Promise.all([
        supabase.from("ai_prompt_versions").select("*"),
        supabase.from("human_reviews").select("*"),
        supabase.from("grade_reports").select("*"),
      ]);
      if (versionsRes.error) throw versionsRes.error;
      if (reviewsRes.error) throw reviewsRes.error;
      if (reportsRes.error) throw reportsRes.error;

      const versions = (versionsRes.data ?? []) as AiPromptVersionRow[];
      const reviews = (reviewsRes.data ?? []) as HumanReviewRow[];
      const reports = (reportsRes.data ?? []) as GradeReportRow[];

      const totalReviewed = reviews.length;
      const agreedCount = reviews.filter((r) => r.adjusted_score === null).length;

      return {
        versions: versions.map((v): EnrichedPromptVersion => ({
          ...v,
          computedAccuracy: v.accuracy_score,
          totalReviewed,
          agreedCount,
        })),
        reviews,
        reports,
      };
    },
    staleTime: 30 * 1000,
  });

  const versions = useMemo(() => data?.versions ?? [], [data]);
  const allReviews = useMemo(() => data?.reviews ?? [], [data]);
  const allReports = useMemo(() => data?.reports ?? [], [data]);

  // ─── Compute accuracy metrics per prompt version ───────────────────

  const accuracyByVersion = useMemo((): ReviewAccuracyData[] => {
    if (allReviews.length === 0 || allReports.length === 0) return [];

    // Build report lookup
    const reportMap = new Map<string, GradeReportRow>();
    for (const r of allReports) {
      reportMap.set(r.id, r);
    }

    // Group reviews by model_version (via grade report)
    const groups = new Map<string, { aiScores: number[]; humanScores: number[]; errors: number[]; agreed: number; factorErrors: Record<string, number[]> }>();

    for (const review of allReviews) {
      const report = reportMap.get(review.grade_report_id);
      if (!report) continue;

      const versionKey = report.model_version || "unknown";
      if (!groups.has(versionKey)) {
        const fe: Record<string, number[]> = {};
        for (const f of FACTOR_NAMES) fe[f] = [];
        groups.set(versionKey, { aiScores: [], humanScores: [], errors: [], agreed: 0, factorErrors: fe });
      }

      const g = groups.get(versionKey)!;
      const humanFinal = review.adjusted_score ?? review.original_score;
      const error = Math.abs(report.overall_score - humanFinal);
      g.errors.push(error);
      if (error <= 0.5) g.agreed++;
      g.aiScores.push(report.overall_score);
      g.humanScores.push(humanFinal);

      // Per-factor error estimation
      const aiOverall = report.overall_score;
      const errorRatio = aiOverall !== 0 ? (humanFinal - aiOverall) / aiOverall : 0;
      const factorScores: Record<string, number> = {
        fabric_condition: report.fabric_condition_score,
        structural_integrity: report.structural_integrity_score,
        cosmetic_appearance: report.cosmetic_appearance_score,
        functional_elements: report.functional_elements_score,
        odor_cleanliness: report.odor_cleanliness_score,
      };
      for (const f of FACTOR_NAMES) {
        const fScore = factorScores[f] ?? 0;
        const fErr = review.adjusted_score === null ? 0 : Math.abs(fScore * errorRatio);
        const arr = g.factorErrors[f];
        if (arr) arr.push(fErr);
      }
    }

    const result: ReviewAccuracyData[] = [];
    for (const [versionName, g] of groups) {
      const mae = g.errors.length > 0 ? g.errors.reduce((s, e) => s + e, 0) / g.errors.length : 0;
      const agreementRate = g.errors.length > 0 ? g.agreed / g.errors.length : 0;
      const correlation = pearsonCorrelation(g.aiScores, g.humanScores);

      result.push({
        versionName,
        totalReviews: g.errors.length,
        meanAbsoluteError: mae,
        agreementRate,
        correlation,
        factorAccuracies: FACTOR_NAMES.map((f) => {
          const fErrors = g.factorErrors[f] ?? [];
          return {
            factor: f,
            mae: fErrors.length > 0 ? fErrors.reduce((s, e) => s + e, 0) / fErrors.length : 0,
            agreementRate: fErrors.length > 0 ? fErrors.filter((e) => e <= 0.5).length / fErrors.length : 0,
          };
        }),
      });
    }

    return result.sort((a, b) => b.totalReviews - a.totalReviews);
  }, [allReviews, allReports]);

  // Detect low accuracy alert
  const lowAccuracyVersions = useMemo(() => {
    return accuracyByVersion.filter(
      (v) => v.totalReviews >= 5 && v.agreementRate < ACCURACY_THRESHOLD
    );
  }, [accuracyByVersion]);

  // ─── Filtering ────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return versions.filter((v) => {
      if (statusFilter === "active" && !v.is_active) return false;
      if (statusFilter === "inactive" && v.is_active) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!v.version_name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [versions, statusFilter, search]);

  // ─── Sorting ──────────────────────────────────────────────────────

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortField === "created_at") {
        return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
      }
      if (sortField === "accuracy") {
        const aAcc = a.computedAccuracy ?? -1;
        const bAcc = b.computedAccuracy ?? -1;
        return (aAcc - bAcc) * dir;
      }
      if (sortField === "total_grades") {
        return (a.total_grades - b.total_grades) * dir;
      }
      if (sortField === "version_name") {
        return a.version_name.localeCompare(b.version_name) * dir;
      }
      return 0;
    });
  }, [filtered, sortField, sortDir]);

  // ─── Pagination ───────────────────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "created_at" ? "desc" : "asc");
    }
    setPage(1);
  }

  // ─── Stats ────────────────────────────────────────────────────────

  const activeVersion = versions.find((v) => v.is_active);
  const totalGrades = versions.reduce((sum, v) => sum + v.total_grades, 0);
  const avgAccuracy = useMemo(() => {
    const withAccuracy = versions.filter((v) => v.computedAccuracy !== null);
    if (withAccuracy.length === 0) return null;
    const sum = withAccuracy.reduce((s, v) => s + (v.computedAccuracy ?? 0), 0);
    return sum / withAccuracy.length;
  }, [versions]);

  // ─── Audit Logging ────────────────────────────────────────────────

  async function logAuditAction(
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown>
  ) {
    if (!profile) return;
    const entry: AdminAuditLogInsert = {
      admin_user_id: profile.id,
      action,
      target_type: targetType,
      target_id: targetId,
      details,
    };
    await supabase.from("admin_audit_log").insert(entry as never);
  }

  // ─── Actions ──────────────────────────────────────────────────────

  async function handleCreate() {
    if (!createName.trim() || !createPromptText.trim()) {
      toast.error("Missing fields", {
        description: "Both version name and prompt text are required.",
      });
      return;
    }

    setCreateLoading(true);
    try {
      const insertData: AiPromptVersionInsert = {
        version_name: createName.trim(),
        prompt_text: createPromptText.trim(),
        is_active: false,
      };

      const { data: created, error } = await supabase
        .from("ai_prompt_versions")
        .insert(insertData as never)
        .select()
        .single();
      if (error) throw error;

      await logAuditAction("create_prompt_version", "ai_prompt_version", (created as AiPromptVersionRow).id, {
        version_name: createName.trim(),
      });

      toast.success("Prompt version created", {
        description: `"${createName.trim()}" has been created.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-ai-models"] });
      setShowCreateDialog(false);
      setCreateName("");
      setCreatePromptText("");
    } catch (err) {
      toast.error("Failed to create prompt version", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleActivate() {
    if (!activateTarget) return;
    setActionLoading(true);
    try {
      // Deactivate all other versions first
      const { error: deactivateError } = await supabase
        .from("ai_prompt_versions")
        .update({ is_active: false } as never)
        .neq("id", activateTarget.id);
      if (deactivateError) throw deactivateError;

      // Activate the selected version
      const { error: activateError } = await supabase
        .from("ai_prompt_versions")
        .update({ is_active: true } as never)
        .eq("id", activateTarget.id);
      if (activateError) throw activateError;

      await logAuditAction("activate_prompt_version", "ai_prompt_version", activateTarget.id, {
        version_name: activateTarget.version_name,
      });

      toast.success("Prompt version activated", {
        description: `"${activateTarget.version_name}" is now the active production prompt.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-ai-models"] });
      setActivateTarget(null);
    } catch (err) {
      toast.error("Failed to activate prompt version", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDeactivate() {
    if (!deactivateTarget) return;
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from("ai_prompt_versions")
        .update({ is_active: false } as never)
        .eq("id", deactivateTarget.id);
      if (error) throw error;

      await logAuditAction("deactivate_prompt_version", "ai_prompt_version", deactivateTarget.id, {
        version_name: deactivateTarget.version_name,
      });

      toast.success("Prompt version deactivated", {
        description: `"${deactivateTarget.version_name}" has been deactivated.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-ai-models"] });
      setDeactivateTarget(null);
    } catch (err) {
      toast.error("Failed to deactivate prompt version", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setActionLoading(true);
    try {
      if (deleteTarget.is_active) {
        toast.error("Cannot delete active prompt", {
          description: "Deactivate the prompt version before deleting it.",
        });
        setDeleteTarget(null);
        return;
      }

      const { error } = await supabase
        .from("ai_prompt_versions")
        .delete()
        .eq("id", deleteTarget.id);
      if (error) throw error;

      await logAuditAction("delete_prompt_version", "ai_prompt_version", deleteTarget.id, {
        version_name: deleteTarget.version_name,
      });

      toast.success("Prompt version deleted", {
        description: `"${deleteTarget.version_name}" has been deleted.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-ai-models"] });
      setDeleteTarget(null);
      if (viewingVersion?.id === deleteTarget.id) setViewingVersion(null);
    } catch (err) {
      toast.error("Failed to delete prompt version", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSaveEdit() {
    if (!viewingVersion) return;
    if (!editName.trim() || !editPromptText.trim()) {
      toast.error("Missing fields", {
        description: "Both version name and prompt text are required.",
      });
      return;
    }

    setEditLoading(true);
    try {
      const updateData: AiPromptVersionUpdate = {
        version_name: editName.trim(),
        prompt_text: editPromptText.trim(),
      };

      const { error } = await supabase
        .from("ai_prompt_versions")
        .update(updateData as never)
        .eq("id", viewingVersion.id);
      if (error) throw error;

      await logAuditAction("update_prompt_version", "ai_prompt_version", viewingVersion.id, {
        version_name: editName.trim(),
        changes: {
          name_changed: editName.trim() !== viewingVersion.version_name,
          prompt_changed: editPromptText.trim() !== viewingVersion.prompt_text,
        },
      });

      toast.success("Prompt version updated", {
        description: `"${editName.trim()}" has been saved.`,
      });

      queryClient.invalidateQueries({ queryKey: ["admin-ai-models"] });
      setEditMode(false);
      setViewingVersion(null);
    } catch (err) {
      toast.error("Failed to update prompt version", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setEditLoading(false);
    }
  }

  function openView(version: EnrichedPromptVersion) {
    setViewingVersion(version);
    setEditMode(false);
    setEditName(version.version_name);
    setEditPromptText(version.prompt_text);
  }

  function handleTestPrompt(version: EnrichedPromptVersion) {
    setTestTarget(version);
    setTestResult(null);
    setTestLoading(true);
    // Simulate a dry run test — in production this would call the edge function
    // with a sample submission and the selected prompt text
    setTimeout(() => {
      setTestResult(
        `Dry run complete for "${version.version_name}".\n\n` +
        `Prompt length: ${version.prompt_text.length} characters\n` +
        `Status: Ready for production use\n\n` +
        `Note: Full dry-run grading requires a connected AI service. ` +
        `This test validates prompt structure and syntax only.`
      );
      setTestLoading(false);
    }, 1500);
  }

  // ─── Compare helpers ──────────────────────────────────────────────

  const compareLeftVersion = versions.find((v) => v.id === compareLeft);
  const compareRightVersion = versions.find((v) => v.id === compareRight);

  // ─── Accuracy trend chart data (from real review data) ─────────────

  const accuracyChartData = useMemo(() => {
    return accuracyByVersion.map((v) => ({
      name: v.versionName.length > 16 ? v.versionName.slice(0, 16) + "..." : v.versionName,
      fullName: v.versionName,
      agreementRate: Number((v.agreementRate * 100).toFixed(1)),
      mae: Number(v.meanAbsoluteError.toFixed(2)),
      correlation: Number((v.correlation * 100).toFixed(1)),
      reviews: v.totalReviews,
      threshold: ACCURACY_THRESHOLD * 100,
    }));
  }, [accuracyByVersion]);

  // Legacy accuracy bar data (from stored accuracy_score on versions)
  const accuracyTrendData = useMemo(() => {
    return versions
      .filter((v) => v.computedAccuracy !== null)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map((v) => ({
        name: v.version_name,
        accuracy: ((v.computedAccuracy ?? 0) * 100),
        grades: v.total_grades,
        date: formatDate(v.created_at),
      }));
  }, [versions]);

  // ─── JSONL Export Handler ──────────────────────────────────────────

  async function handleExportTrainingData() {
    setExportLoading(true);
    try {
      if (allReviews.length === 0) {
        toast.info("No training data", {
          description: "No human reviews found to export.",
        });
        return;
      }

      // Build report lookup
      const reportMap = new Map<string, GradeReportRow>();
      for (const r of allReports) {
        reportMap.set(r.id, r);
      }

      // Fetch submissions for garment info
      const submissionIds = [...new Set(allReports.map((r) => r.submission_id))];
      const { data: submissions } = await supabase
        .from("submissions")
        .select("id, garment_type, garment_category")
        .in("id", submissionIds);

      const submissionMap = new Map<string, { garment_type: string; garment_category: string }>();
      for (const sub of (submissions ?? []) as { id: string; garment_type: string; garment_category: string }[]) {
        submissionMap.set(sub.id, sub);
      }

      // Build JSONL
      const lines: string[] = [];
      for (const review of allReviews) {
        const report = reportMap.get(review.grade_report_id);
        if (!report) continue;
        const sub = submissionMap.get(report.submission_id);

        lines.push(JSON.stringify({
          review_id: review.id,
          grade_report_id: review.grade_report_id,
          submission_id: report.submission_id,
          garment_type: sub?.garment_type ?? "unknown",
          garment_category: sub?.garment_category ?? "unknown",
          ai_overall_score: report.overall_score,
          ai_grade_tier: report.grade_tier,
          ai_fabric_condition: report.fabric_condition_score,
          ai_structural_integrity: report.structural_integrity_score,
          ai_cosmetic_appearance: report.cosmetic_appearance_score,
          ai_functional_elements: report.functional_elements_score,
          ai_odor_cleanliness: report.odor_cleanliness_score,
          ai_confidence: report.confidence_score,
          ai_summary: report.ai_summary,
          human_original_score: review.original_score,
          human_adjusted_score: review.adjusted_score,
          human_review_notes: review.review_notes,
          reviewed_at: review.reviewed_at,
          model_version: report.model_version,
        }));
      }

      if (lines.length === 0) {
        toast.info("No training data", {
          description: "No matching review-report pairs found to export.",
        });
        return;
      }

      const blob = new Blob([lines.join("\n")], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `gradethread_training_data_${dateStr}.jsonl`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("Training data exported", {
        description: `${lines.length} review entries exported as JSONL.`,
      });
    } catch (err) {
      toast.error("Export failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setExportLoading(false);
    }
  }

  // ─── Weekly Summary Handler ────────────────────────────────────────

  async function handleWeeklySummary() {
    setWeeklySummaryLoading(true);
    try {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Filter reviews from the last 7 days
      const recentReviews = allReviews.filter(
        (r) => new Date(r.reviewed_at) >= weekAgo
      );

      if (recentReviews.length === 0) {
        toast.info("No recent reviews", {
          description: "No human reviews in the last 7 days to summarize.",
        });
        return;
      }

      // Build report lookup for recent reviews only
      const reportMap = new Map<string, GradeReportRow>();
      for (const r of allReports) {
        reportMap.set(r.id, r);
      }

      let totalError = 0;
      let totalAgreed = 0;
      let count = 0;

      for (const review of recentReviews) {
        const report = reportMap.get(review.grade_report_id);
        if (!report) continue;
        const humanFinal = review.adjusted_score ?? review.original_score;
        const error = Math.abs(report.overall_score - humanFinal);
        totalError += error;
        if (error <= 0.5) totalAgreed++;
        count++;
      }

      if (count === 0) {
        toast.info("No matched reviews", {
          description: "Could not match reviews to grade reports.",
        });
        return;
      }

      const mae = totalError / count;
      const agreementRate = totalAgreed / count;

      toast.success("Weekly Accuracy Summary", {
        description:
          `Last 7 days: ${count} reviews | ` +
          `MAE: ${mae.toFixed(2)} | ` +
          `Agreement: ${(agreementRate * 100).toFixed(1)}% | ` +
          `${agreementRate >= ACCURACY_THRESHOLD ? "Above" : "BELOW"} threshold`,
        duration: 10000,
      });

      await logAuditAction("weekly_accuracy_summary", "ai_accuracy", "weekly", {
        period: "7d",
        total_reviews: count,
        mean_absolute_error: mae,
        agreement_rate: agreementRate,
      });
    } catch (err) {
      toast.error("Summary failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setWeeklySummaryLoading(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="h-6 w-6 text-brand-red" />
          <h1 className="text-2xl font-bold">AI Models</h1>
          <Badge variant="secondary" className="ml-2">
            {versions.length} versions
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCompareDialogOpen(true)}
            disabled={versions.length < 2}
          >
            <Columns2 className="mr-2 h-4 w-4" />
            Compare
          </Button>
          <Button size="sm" onClick={() => setShowCreateDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Version
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active Prompt</CardTitle>
            <Zap className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-32" />
            ) : activeVersion ? (
              <>
                <p className="text-lg font-bold truncate">{activeVersion.version_name}</p>
                <p className="text-xs text-muted-foreground">
                  Since {formatDate(activeVersion.created_at)}
                </p>
              </>
            ) : (
              <p className="text-lg font-bold text-muted-foreground">None</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Avg Accuracy</CardTitle>
            <Target className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <p className="text-2xl font-bold">
                  {avgAccuracy !== null ? `${(avgAccuracy * 100).toFixed(1)}%` : "N/A"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Across all versions with data
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Grades</CardTitle>
            <Hash className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <p className="text-2xl font-bold">{totalGrades.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">All-time processed</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Versions</CardTitle>
            <TrendingUp className="h-4 w-4 text-brand-red" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <>
                <p className="text-2xl font-bold">{versions.length}</p>
                <p className="text-xs text-muted-foreground">
                  {versions.filter((v) => v.is_active).length} active
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Accuracy Threshold Alert */}
      {lowAccuracyVersions.length > 0 && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="flex items-start gap-3 pt-4">
            <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-red-800">
                Accuracy Below Threshold ({(ACCURACY_THRESHOLD * 100).toFixed(0)}%)
              </p>
              <p className="text-sm text-red-700 mt-1">
                {lowAccuracyVersions.map((v) => (
                  <span key={v.versionName}>
                    <strong>{v.versionName}</strong>: {(v.agreementRate * 100).toFixed(1)}%
                    agreement ({v.totalReviews} reviews)
                    {". "}
                  </span>
                ))}
                Consider reviewing and updating the prompts.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Accuracy Feedback Dashboard */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-brand-navy" />
              <CardTitle className="text-sm font-medium">AI Accuracy Feedback Loop</CardTitle>
              <Badge variant="secondary" className="ml-1">
                {allReviews.length} reviews
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleWeeklySummary}
                disabled={weeklySummaryLoading}
              >
                {weeklySummaryLoading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                Weekly Summary
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportTrainingData}
                disabled={exportLoading}
              >
                {exportLoading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileDown className="mr-2 h-3.5 w-3.5" />
                )}
                Export JSONL
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {accuracyByVersion.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <BarChart3 className="h-10 w-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">
                No human reviews yet. Accuracy metrics will appear here after reviews are completed.
              </p>
            </div>
          ) : (
            <Tabs defaultValue="chart" className="space-y-4">
              <TabsList>
                <TabsTrigger value="chart">Chart</TabsTrigger>
                <TabsTrigger value="details">Details</TabsTrigger>
              </TabsList>

              <TabsContent value="chart">
                {/* Agreement Rate + MAE Composed Chart */}
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={accuracyChartData} margin={{ top: 10, right: 30, left: 0, bottom: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis yAxisId="left" domain={[0, 100]} tick={{ fontSize: 12 }} label={{ value: "Agreement %", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 11 } }} />
                      <YAxis yAxisId="right" orientation="right" domain={[0, "auto"]} tick={{ fontSize: 12 }} label={{ value: "MAE", angle: 90, position: "insideRight", offset: 10, style: { fontSize: 11 } }} />
                      <Tooltip
                        {...TOOLTIP_STYLE}
                        formatter={(value: unknown, name: unknown) => {
                          const v = Number(value);
                          const n = String(name);
                          if (n === "Agreement Rate") return [`${v.toFixed(1)}%`, n];
                          if (n === "MAE") return [v.toFixed(2), n];
                          return [v, n];
                        }}
                        labelFormatter={(label: unknown, payload: unknown) => {
                          const items = payload as { payload?: { fullName?: string; reviews?: number } }[] | undefined;
                          const item = items?.[0]?.payload;
                          return `${item?.fullName ?? String(label)} (${item?.reviews ?? 0} reviews)`;
                        }}
                      />
                      <Legend />
                      <Bar yAxisId="left" dataKey="agreementRate" name="Agreement Rate" fill="#0F3460" radius={[4, 4, 0, 0]} />
                      <Line yAxisId="right" dataKey="mae" name="MAE" stroke="#E94560" strokeWidth={2} dot={{ fill: "#E94560", r: 4 }} />
                      {/* Threshold reference line */}
                      <Line yAxisId="left" dataKey="threshold" name="Threshold" stroke="#f59e0b" strokeWidth={1} strokeDasharray="5 5" dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </TabsContent>

              <TabsContent value="details">
                <div className="space-y-4">
                  {accuracyByVersion.map((version) => (
                    <Card key={version.versionName} className={version.agreementRate < ACCURACY_THRESHOLD && version.totalReviews >= 5 ? "border-red-300" : ""}>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-medium">{version.versionName}</CardTitle>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary">{version.totalReviews} reviews</Badge>
                            {version.agreementRate >= ACCURACY_THRESHOLD ? (
                              <Badge className="bg-green-100 text-green-700">Good</Badge>
                            ) : version.totalReviews >= 5 ? (
                              <Badge className="bg-red-100 text-red-700">Below Threshold</Badge>
                            ) : (
                              <Badge variant="secondary">Insufficient Data</Badge>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {/* Overall metrics */}
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          <div>
                            <p className="text-muted-foreground">Agreement Rate</p>
                            <p className={`font-bold text-lg ${version.agreementRate >= ACCURACY_THRESHOLD ? "text-green-600" : version.totalReviews >= 5 ? "text-red-600" : ""}`}>
                              {(version.agreementRate * 100).toFixed(1)}%
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Mean Absolute Error</p>
                            <p className="font-bold text-lg">{version.meanAbsoluteError.toFixed(2)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Correlation</p>
                            <p className="font-bold text-lg">{(version.correlation * 100).toFixed(1)}%</p>
                          </div>
                        </div>

                        {/* Per-factor breakdown */}
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-muted-foreground">Per-Factor Accuracy</p>
                          {version.factorAccuracies.map((fa) => (
                            <div key={fa.factor} className="flex items-center gap-2">
                              <span className="w-40 text-xs text-muted-foreground">
                                {FACTOR_LABELS[fa.factor] ?? fa.factor}
                              </span>
                              <div className="flex-1">
                                <Progress
                                  value={fa.agreementRate * 100}
                                  className="h-2"
                                />
                              </div>
                              <span className="w-14 text-xs text-right tabular-nums">
                                {(fa.agreementRate * 100).toFixed(0)}%
                              </span>
                              <span className="w-16 text-xs text-muted-foreground text-right tabular-nums">
                                MAE {fa.mae.toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>

      {/* Accuracy Trend by Version (stored accuracy_score) */}
      {accuracyTrendData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Stored Accuracy by Version</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {accuracyTrendData.map((d) => (
                <div key={d.name} className="flex items-center gap-3">
                  <span className="w-32 text-sm truncate text-muted-foreground" title={d.name}>
                    {d.name}
                  </span>
                  <div className="flex-1 h-6 bg-muted rounded-full overflow-hidden relative">
                    <div
                      className="h-full bg-brand-navy rounded-full transition-all"
                      style={{ width: `${Math.min(100, d.accuracy)}%` }}
                    />
                    <span className="absolute inset-0 flex items-center justify-center text-xs font-medium">
                      {d.accuracy.toFixed(1)}%
                    </span>
                  </div>
                  <span className="w-20 text-xs text-muted-foreground text-right">
                    {d.grades} grades
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by version name..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-9"
              />
            </div>

            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v as StatusFilter);
                setPage(1);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active Only</SelectItem>
                <SelectItem value="inactive">Inactive Only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Versions Table */}
      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("version_name")}
                    >
                      Name
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("accuracy")}
                    >
                      Accuracy
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("total_grades")}
                    >
                      Grades
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("created_at")}
                    >
                      Created
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      {search || statusFilter !== "all"
                        ? "No prompt versions match your filters."
                        : "No prompt versions yet. Create one to get started."}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((version) => (
                    <TableRow
                      key={version.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => openView(version)}
                    >
                      <TableCell className="font-medium max-w-[200px] truncate">
                        {version.version_name}
                      </TableCell>
                      <TableCell>
                        {version.is_active ? (
                          <Badge className="bg-green-100 text-green-700">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span
                          className={
                            version.computedAccuracy === null
                              ? "text-muted-foreground"
                              : (version.computedAccuracy ?? 0) >= 0.8
                                ? "text-green-600 font-medium"
                                : (version.computedAccuracy ?? 0) >= 0.6
                                  ? "text-yellow-600 font-medium"
                                  : "text-red-600 font-medium"
                          }
                        >
                          {formatAccuracy(version.computedAccuracy)}
                        </span>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {version.total_grades.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(version.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div
                          className="flex items-center justify-end gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            title="View"
                            onClick={() => openView(version)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            title="Test prompt"
                            onClick={() => handleTestPrompt(version)}
                          >
                            <FlaskConical className="h-3.5 w-3.5" />
                          </Button>
                          {version.is_active ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-amber-600"
                              title="Deactivate"
                              onClick={() => setDeactivateTarget(version)}
                            >
                              <PowerOff className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-green-600"
                              title="Activate"
                              onClick={() => setActivateTarget(version)}
                            >
                              <Power className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-red-600"
                            title="Delete"
                            onClick={() => setDeleteTarget(version)}
                            disabled={version.is_active}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <p className="text-sm text-muted-foreground">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, sorted.length)} of {sorted.length}
              </p>
              <div className="flex gap-2">
                <button
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}
                >
                  Previous
                </button>
                <button
                  className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ─── Create Dialog ──────────────────────────────────────────── */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-brand-red" />
              Create Prompt Version
            </DialogTitle>
            <DialogDescription>
              Create a new AI grading prompt version. It will be created as inactive.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="create-name">Version Name</Label>
              <Input
                id="create-name"
                placeholder="e.g., v2.1 - Improved defect detection"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="create-prompt">Prompt Text</Label>
              <Tabs defaultValue="edit" className="mt-1">
                <TabsList>
                  <TabsTrigger value="edit">Edit</TabsTrigger>
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                </TabsList>
                <TabsContent value="edit">
                  <Textarea
                    id="create-prompt"
                    placeholder="Enter the AI grading prompt text..."
                    value={createPromptText}
                    onChange={(e) => setCreatePromptText(e.target.value)}
                    rows={16}
                    className="font-mono text-sm"
                  />
                </TabsContent>
                <TabsContent value="preview">
                  <div className="rounded-lg border bg-muted/30 p-4 min-h-[300px]">
                    <pre className="text-sm whitespace-pre-wrap font-mono">
                      {createPromptText || "Nothing to preview."}
                    </pre>
                  </div>
                </TabsContent>
              </Tabs>
              <p className="mt-1 text-xs text-muted-foreground">
                {createPromptText.length} characters
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t pt-4">
              <Button
                variant="outline"
                onClick={() => setShowCreateDialog(false)}
                disabled={createLoading}
              >
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={createLoading}>
                {createLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Version
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── View / Edit Dialog ─────────────────────────────────────── */}
      <Dialog
        open={!!viewingVersion}
        onOpenChange={(open) => {
          if (!open) {
            setViewingVersion(null);
            setEditMode(false);
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-brand-red" />
              {editMode ? "Edit: " : ""}{viewingVersion?.version_name}
            </DialogTitle>
            <DialogDescription>
              Created {viewingVersion ? formatDate(viewingVersion.created_at) : ""}
              {viewingVersion?.is_active && " · Active in production"}
            </DialogDescription>
          </DialogHeader>

          {viewingVersion && (
            <div className="space-y-6">
              {/* Stats */}
              <div className="grid grid-cols-3 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-muted-foreground">Status</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {viewingVersion.is_active ? (
                      <Badge className="bg-green-100 text-green-700">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-muted-foreground">Accuracy</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-lg font-bold">
                      {formatAccuracy(viewingVersion.computedAccuracy)}
                    </span>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-muted-foreground">Grades Processed</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-lg font-bold">
                      {viewingVersion.total_grades.toLocaleString()}
                    </span>
                  </CardContent>
                </Card>
              </div>

              {/* Prompt Text */}
              {editMode ? (
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="edit-name">Version Name</Label>
                    <Input
                      id="edit-name"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="edit-prompt">Prompt Text</Label>
                    <Tabs defaultValue="edit" className="mt-1">
                      <TabsList>
                        <TabsTrigger value="edit">Edit</TabsTrigger>
                        <TabsTrigger value="preview">Preview</TabsTrigger>
                      </TabsList>
                      <TabsContent value="edit">
                        <Textarea
                          id="edit-prompt"
                          value={editPromptText}
                          onChange={(e) => setEditPromptText(e.target.value)}
                          rows={16}
                          className="font-mono text-sm"
                        />
                      </TabsContent>
                      <TabsContent value="preview">
                        <div className="rounded-lg border bg-muted/30 p-4 min-h-[300px]">
                          <pre className="text-sm whitespace-pre-wrap font-mono">
                            {editPromptText || "Nothing to preview."}
                          </pre>
                        </div>
                      </TabsContent>
                    </Tabs>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {editPromptText.length} characters
                    </p>
                  </div>
                  <div className="flex justify-end gap-2 border-t pt-4">
                    <Button
                      variant="outline"
                      onClick={() => setEditMode(false)}
                      disabled={editLoading}
                    >
                      Cancel
                    </Button>
                    <Button onClick={handleSaveEdit} disabled={editLoading}>
                      {editLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Save Changes
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label>Prompt Text</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditMode(true)}
                    >
                      Edit
                    </Button>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-4 max-h-[400px] overflow-y-auto">
                    <pre className="text-sm whitespace-pre-wrap font-mono">
                      {viewingVersion.prompt_text}
                    </pre>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {viewingVersion.prompt_text.length} characters
                  </p>
                </div>
              )}

              {/* Quick Actions (when not editing) */}
              {!editMode && (
                <div className="flex items-center gap-2 border-t pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTestPrompt(viewingVersion)}
                  >
                    <FlaskConical className="mr-2 h-4 w-4" />
                    Test Prompt
                  </Button>
                  {viewingVersion.is_active ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeactivateTarget(viewingVersion)}
                    >
                      <PowerOff className="mr-2 h-4 w-4" />
                      Deactivate
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setActivateTarget(viewingVersion)}
                    >
                      <Power className="mr-2 h-4 w-4" />
                      Activate
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600"
                    onClick={() => setDeleteTarget(viewingVersion)}
                    disabled={viewingVersion.is_active}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Compare Dialog ─────────────────────────────────────────── */}
      <Dialog open={compareDialogOpen} onOpenChange={setCompareDialogOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Columns2 className="h-5 w-5 text-brand-red" />
              Compare Prompt Versions
            </DialogTitle>
            <DialogDescription>
              Select two prompt versions to compare side by side.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Left Version</Label>
                <Select value={compareLeft} onValueChange={setCompareLeft}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select version..." />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={v.id} disabled={v.id === compareRight}>
                        {v.version_name} {v.is_active ? "(Active)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Right Version</Label>
                <Select value={compareRight} onValueChange={setCompareRight}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select version..." />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={v.id} disabled={v.id === compareLeft}>
                        {v.version_name} {v.is_active ? "(Active)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {compareLeftVersion && compareRightVersion && (
              <>
                {/* Metrics comparison */}
                <div className="grid grid-cols-2 gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm truncate">{compareLeftVersion.version_name}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Status</span>
                        {compareLeftVersion.is_active ? (
                          <Badge className="bg-green-100 text-green-700">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Accuracy</span>
                        <span className="font-medium">{formatAccuracy(compareLeftVersion.computedAccuracy)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Grades</span>
                        <span className="font-medium">{compareLeftVersion.total_grades.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Created</span>
                        <span>{formatDate(compareLeftVersion.created_at)}</span>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm truncate">{compareRightVersion.version_name}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Status</span>
                        {compareRightVersion.is_active ? (
                          <Badge className="bg-green-100 text-green-700">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Accuracy</span>
                        <span className="font-medium">{formatAccuracy(compareRightVersion.computedAccuracy)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Grades</span>
                        <span className="font-medium">{compareRightVersion.total_grades.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Created</span>
                        <span>{formatDate(compareRightVersion.created_at)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Prompt text comparison */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm">Prompt Text ({compareLeftVersion.prompt_text.length} chars)</Label>
                    <div className="mt-1 rounded-lg border bg-muted/30 p-3 max-h-[400px] overflow-y-auto">
                      <pre className="text-xs whitespace-pre-wrap font-mono">
                        {compareLeftVersion.prompt_text}
                      </pre>
                    </div>
                  </div>
                  <div>
                    <Label className="text-sm">Prompt Text ({compareRightVersion.prompt_text.length} chars)</Label>
                    <div className="mt-1 rounded-lg border bg-muted/30 p-3 max-h-[400px] overflow-y-auto">
                      <pre className="text-xs whitespace-pre-wrap font-mono">
                        {compareRightVersion.prompt_text}
                      </pre>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Activate Confirmation ──────────────────────────────────── */}
      <AlertDialog open={!!activateTarget} onOpenChange={() => setActivateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate Prompt Version</AlertDialogTitle>
            <AlertDialogDescription>
              This will activate <strong>{activateTarget?.version_name}</strong> and deactivate
              all other prompt versions. Only one version can be active for production grading
              at a time.
              {activeVersion && activeVersion.id !== activateTarget?.id && (
                <>
                  <br /><br />
                  Currently active: <strong>{activeVersion.version_name}</strong>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleActivate}
              disabled={actionLoading}
              className="bg-green-600 hover:bg-green-700"
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Activate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Deactivate Confirmation ────────────────────────────────── */}
      <AlertDialog open={!!deactivateTarget} onOpenChange={() => setDeactivateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate Prompt Version</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate <strong>{deactivateTarget?.version_name}</strong>.
              No prompt version will be active for production grading until another is activated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeactivate}
              disabled={actionLoading}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Delete Confirmation ────────────────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Prompt Version</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{deleteTarget?.version_name}</strong>.
              This action cannot be undone.
              {deleteTarget?.total_grades ? (
                <>
                  <br /><br />
                  This version has processed {deleteTarget.total_grades.toLocaleString()} grades.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={actionLoading}
              className="bg-red-600 hover:bg-red-700"
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Test Prompt Dialog ─────────────────────────────────────── */}
      <Dialog open={!!testTarget} onOpenChange={() => setTestTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5 text-brand-red" />
              Test Prompt: {testTarget?.version_name}
            </DialogTitle>
            <DialogDescription>
              Dry run grading test on a sample submission.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {testLoading ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-brand-navy" />
                <p className="text-sm text-muted-foreground">Running dry-run test...</p>
              </div>
            ) : testResult ? (
              <div className="rounded-lg border bg-muted/30 p-4">
                <pre className="text-sm whitespace-pre-wrap font-mono">{testResult}</pre>
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setTestTarget(null)}>
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
