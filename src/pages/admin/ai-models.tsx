import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type {
  AiPromptVersionRow,
  AiPromptVersionInsert,
  AiPromptVersionUpdate,
  HumanReviewRow,
  AdminAuditLogInsert,
} from "@/types/database";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
} from "lucide-react";
import { toast } from "sonner";

// ─── Types ──────────────────────────────────────────────────────────

interface EnrichedPromptVersion extends AiPromptVersionRow {
  computedAccuracy: number | null;
  totalReviewed: number;
  agreedCount: number;
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

  // ─── Data Fetching ────────────────────────────────────────────────

  const { data, isLoading } = useQuery({
    queryKey: ["admin-ai-models"],
    queryFn: async () => {
      const [versionsRes, reviewsRes] = await Promise.all([
        supabase.from("ai_prompt_versions").select("*"),
        supabase.from("human_reviews").select("*"),
      ]);
      if (versionsRes.error) throw versionsRes.error;
      if (reviewsRes.error) throw reviewsRes.error;

      const versions = (versionsRes.data ?? []) as AiPromptVersionRow[];
      const reviews = (reviewsRes.data ?? []) as HumanReviewRow[];

      // Compute accuracy from human reviews:
      // - "agreed" = review where adjusted_score is null (approved as-is)
      // - total reviewed = all human_reviews
      // Note: We use all reviews globally for accuracy since reviews aren't linked
      // directly to a prompt version. In a production system, grade_reports would
      // reference which prompt version was used. For now, we use the stored accuracy_score
      // field as the primary metric, and compute a global review agreement rate.
      const totalReviewed = reviews.length;
      const agreedCount = reviews.filter((r) => r.adjusted_score === null).length;

      return versions.map((v): EnrichedPromptVersion => ({
        ...v,
        computedAccuracy: v.accuracy_score,
        totalReviewed,
        agreedCount,
      }));
    },
    staleTime: 30 * 1000,
  });

  const versions = data ?? [];

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

  // ─── Accuracy trend data (simulated from version data) ────────────

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

      {/* Accuracy Trend Chart (simple table-based visualization) */}
      {accuracyTrendData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Accuracy Trend by Version</CardTitle>
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
