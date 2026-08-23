import { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { edgeFetch } from "@/lib/edge-fetch";
import { GRADE_FACTORS } from "@/lib/constants";
import {
  computeWeightedOverall as sharedWeightedOverall,
  type WeightedFactorScores,
} from "@/lib/weighted-grade";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ClipboardCheck,
  ArrowUpDown,
  Eye,
  Check,
  Pencil,
  Undo2,
  Clock,
  Lock,
  Loader2,
  ImageIcon,
  AlertTriangle,
} from "lucide-react";
import { SearchInput } from "@/components/search-input";
import { toast } from "sonner";
// US-2332: lazy façade — see lib/sentry.ts.
import { captureException } from "@/lib/sentry";

// ─── Types ──────────────────────────────────────────────────────────

// US-2386: FactorScores IS WeightedFactorScores. It used to be a local
// re-declaration of the same five keys, and every call into the shared
// computeWeightedOverall cast across the two — a cast that was harmless only
// while the shapes happened to match, and would have silently swallowed a
// dropped or renamed key the moment they stopped. An alias makes the compiler
// hold what the cast was asking a reader to hold.
type FactorScores = WeightedFactorScores;

interface QueueItem {
  report_id: string;
  submission_id: string;
  title: string | null;
  garment_type: string | null;
  garment_category: string | null;
  user_email: string | null;
  user_name: string | null;
  overall_score: number;
  grade_tier: string;
  confidence_score: number;
  confidence_label: string | null;
  factor_scores: FactorScores;
  ai_summary: string;
  created_at: string;
  waiting_ms: number;
  claimed_by: string | null;
  claimed_by_me: boolean;
  claimed_by_email: string | null;
  claimed_by_name: string | null;
  claimed_at: string | null;
  // Mandatory-review SLA signals from the route.
  overdue?: boolean;
  // US-1558: information-value ranking + reviewer-facing reasons.
  info_value?: number;
  info_reasons?: string[];
}

interface QueueResponse {
  data: QueueItem[];
  count: number;
  queue_age_seconds: number;
}

interface ReviewDetailImage {
  id: string;
  image_type: string;
  storage_path: string;
  display_order: number;
  signed_url: string | null;
}

interface ReviewDetailResponse {
  report: Record<string, unknown> & { tells?: unknown };
  submission: { id: string; title: string; garment_type: string; garment_category: string } | null;
  images: ReviewDetailImage[];
}

type SortField = "info_value" | "waiting_time" | "confidence" | "score";
type SortDir = "asc" | "desc";

const FACTOR_KEYS: (keyof FactorScores)[] = [
  "fabric_condition_score",
  "structural_integrity_score",
  "cosmetic_appearance_score",
  "functional_elements_score",
  "odor_cleanliness_score",
];

const FACTOR_META: Record<keyof FactorScores, { label: string; weight: number }> = {
  fabric_condition_score: GRADE_FACTORS.fabric_condition,
  structural_integrity_score: GRADE_FACTORS.structural_integrity,
  cosmetic_appearance_score: GRADE_FACTORS.cosmetic_appearance,
  functional_elements_score: GRADE_FACTORS.functional_elements,
  odor_cleanliness_score: GRADE_FACTORS.odor_cleanliness,
};

// ─── Helpers ────────────────────────────────────────────────────────

function formatWaitingTime(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

// SLA buckets for the age indicator: > 24h critical, > 4h warning.
function ageTone(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 24) return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300";
  if (hours >= 4) return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300";
  return "bg-muted text-muted-foreground";
}

// US-2034: delegates to the ONE shared implementation. This used to be a
// local copy of the weighted-sum + rounding; disputes.tsx's copy had drifted
// to 0.5 rounding while the server stored 0.1, so an operator saw a number
// the certificate did not get. See src/lib/weighted-grade.ts.
function computeWeightedScore(factors: FactorScores): number {
  return sharedWeightedOverall(factors);
}

// The grading contract: factors are 1.0–10.0 in 0.5 steps. Applied when a score
// box is COMMITTED (blur / submit), never while the reviewer is still typing —
// the server re-applies the same clamp in admin-grading.ts.
function clampFactorScore(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(10, Math.max(1, n)) * 2) / 2;
}

function draftsFromScores(scores: FactorScores): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FACTOR_KEYS) out[key] = scores[key].toFixed(1);
  return out;
}

// ─── Main Component ─────────────────────────────────────────────────

export function AdminGradingQueuePage() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  // US-2197: pause the 30s queue poll while the tab is backgrounded.
  const visible = useDocumentVisible();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  // US-2505: carried over from /admin/reviews when the two review surfaces were
  // consolidated onto this one. It was the only filter that page had and this
  // one didn't, so the merge would otherwise have cost operators a control.
  const [confidenceFilter, setConfidenceFilter] = useState("all");
  // US-1558: information-value ordering is the default; FIFO (Waiting)
  // stays one click away in the header.
  const [sortField, setSortField] = useState<SortField>("info_value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [selected, setSelected] = useState<QueueItem | null>(null);
  const [detail, setDetail] = useState<ReviewDetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [actionLoading, setActionLoading] = useState(false);
  const [adjustMode, setAdjustMode] = useState(false);
  const [adjustedScores, setAdjustedScores] = useState<FactorScores>({
    fabric_condition_score: 5,
    structural_integrity_score: 5,
    cosmetic_appearance_score: 5,
    functional_elements_score: 5,
    odor_cleanliness_score: 5,
  });
  // What's literally IN each score box, as typed. Kept separate from the numeric
  // scores because clamping on every keystroke makes the field uneditable: clear
  // "7" and the next digit you type ("0" on the way to "0.5", say) is instantly
  // snapped up to the 1.0 floor, and you can never hold an empty or partial
  // value like "" or "8." long enough to finish typing it. Drafts are free-form
  // while focused and normalized on blur.
  const [factorDrafts, setFactorDrafts] = useState<Record<string, string>>({});
  const [intentionalMisread, setIntentionalMisread] = useState(false);
  const [notes, setNotes] = useState("");

  // ─── Data ───────────────────────────────────────────────────────

  const { data, isLoading } = useQuery<QueueResponse>({
    queryKey: ["admin-grading-review-queue"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/grading/review-queue");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load review queue.");
      return json as QueueResponse;
    },
    // The queue is operator-shared; refresh often so claim locks stay fresh.
    staleTime: 15 * 1000,
    refetchInterval: visible ? 30 * 1000 : false,
  });

  const items = useMemo(() => data?.data ?? [], [data]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.garment_category) set.add(i.garment_category);
    return [...set].sort();
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (categoryFilter !== "all" && i.garment_category !== categoryFilter) return false;
      // Same bands /admin/reviews used: high >= 0.85, medium 0.75–0.84, low < 0.75.
      if (confidenceFilter === "high" && i.confidence_score < 0.85) return false;
      if (
        confidenceFilter === "medium" &&
        (i.confidence_score < 0.75 || i.confidence_score >= 0.85)
      ) {
        return false;
      }
      if (confidenceFilter === "low" && i.confidence_score >= 0.75) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = [i.title, i.user_email, i.user_name, i.garment_type]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, categoryFilter, confidenceFilter, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortField === "info_value") {
        // US-1558 SLA guard: overdue items float to the top regardless of
        // score (oldest first among themselves) so ranking never starves an
        // SLA; then information value, waiting time as tiebreak.
        const aOver = a.overdue === true;
        const bOver = b.overdue === true;
        if (aOver !== bOver) return aOver ? -1 : 1;
        if (aOver && bOver) return b.waiting_ms - a.waiting_ms;
        const av = a.info_value ?? 0;
        const bv = b.info_value ?? 0;
        if (av !== bv) return (av - bv) * dir;
        return b.waiting_ms - a.waiting_ms;
      }
      if (sortField === "waiting_time") return (a.waiting_ms - b.waiting_ms) * dir;
      if (sortField === "confidence") return (a.confidence_score - b.confidence_score) * dir;
      if (sortField === "score") return (a.overall_score - b.overall_score) * dir;
      return 0;
    });
  }, [filtered, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["admin-grading-review-queue"] });
  }, [queryClient]);

  // ─── Claim / open ───────────────────────────────────────────────

  async function openDetail(item: QueueItem) {
    // Take (or refresh) the claim before opening so two operators can't both work it.
    setActionLoading(true);
    try {
      const claimRes = await edgeFetch(`/api/admin/grading/review/${item.report_id}/claim`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const claimJson = await claimRes.json().catch(() => ({}));
      if (!claimRes.ok) {
        if (claimJson.code === "ALREADY_CLAIMED") {
          toast.error("Item already claimed", {
            description: `${claimJson.claimed_by_name || claimJson.claimed_by_email || "Another operator"} is reviewing this item.`,
          });
        } else {
          toast.error("Couldn't claim item", { description: claimJson.error || "Try again." });
        }
        refresh();
        return;
      }
    } catch (err) {
      toast.error("Couldn't claim item", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      return;
    } finally {
      setActionLoading(false);
    }

    setSelected(item);
    setDetail(null);
    setAdjustMode(false);
    setIntentionalMisread(false);
    setNotes("");
    setAdjustedScores({ ...item.factor_scores });
    setFactorDrafts(draftsFromScores(item.factor_scores));
    refresh();

    setLoadingDetail(true);
    try {
      const res = await edgeFetch(`/api/admin/grading/review/${item.report_id}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load detail.");
      setDetail(json as ReviewDetailResponse);
    } catch (err) {
      captureException(err, { tags: { area: "admin.grading_review_detail" } });
      toast.error("Failed to load item detail", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoadingDetail(false);
    }
  }

  async function closeDetail(release: boolean) {
    const current = selected;
    setSelected(null);
    setDetail(null);
    if (release && current) {
      // Release the claim so the item returns to the shared queue.
      try {
        await edgeFetch(`/api/admin/grading/review/${current.report_id}/release`, {
          method: "POST",
          body: JSON.stringify({}),
        });
      } catch {
        // Best-effort; the claim TTL frees it regardless.
      }
      refresh();
    }
  }

  const computedOverall = useMemo(() => computeWeightedScore(adjustedScores), [adjustedScores]);

  // Accept the keystroke as typed (including "" and "8."), and only mirror it
  // onto the numeric score when it parses — no clamping here, so the floor can't
  // hijack a digit mid-entry. Anything unparseable just leaves the last good
  // number in place for the weighted-overall readout.
  function updateFactor(key: keyof FactorScores, value: string) {
    // Digits with at most one decimal point; a stray letter is simply ignored.
    if (!/^\d*\.?\d*$/.test(value)) return;
    setFactorDrafts((prev) => ({ ...prev, [key]: value }));
    const num = Number.parseFloat(value);
    if (Number.isFinite(num)) {
      setAdjustedScores((prev) => ({ ...prev, [key]: num }));
    }
  }

  // Commit on blur: snap to the 1.0–10.0 range in 0.5 steps and rewrite the box
  // to match, so what the reviewer sees is exactly what gets submitted. A field
  // left empty or nonsense reverts to the score it had.
  function commitFactor(key: keyof FactorScores) {
    setAdjustedScores((prev) => {
      const typed = Number.parseFloat(factorDrafts[key] ?? "");
      const base = Number.isFinite(typed) ? typed : prev[key];
      const clamped = clampFactorScore(base);
      setFactorDrafts((d) => ({ ...d, [key]: clamped.toFixed(1) }));
      return { ...prev, [key]: clamped };
    });
  }

  // ─── Actions ────────────────────────────────────────────────────

  async function handleApprove() {
    if (!selected) return;
    setActionLoading(true);
    try {
      const res = await edgeFetch(`/api/admin/grading/review/${selected.report_id}/approve`, {
        method: "POST",
        body: JSON.stringify({ notes: notes.trim() || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to approve grade.");
      toast.success("Grade approved", { description: "The AI grade was accepted as-is." });
      await closeDetail(false);
      refresh();
    } catch (err) {
      toast.error("Failed to approve", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAdjust() {
    if (!selected) return;
    if (!notes.trim()) {
      toast.error("Notes required", { description: "Explain the adjustment for the audit trail." });
      return;
    }
    // Submitting straight from a focused box (tap "Save" without blurring first)
    // must still send contract-legal factors, so clamp here rather than trusting
    // the blur to have run.
    const factors = { ...adjustedScores };
    for (const k of FACTOR_KEYS) factors[k] = clampFactorScore(factors[k]);
    const scoreDiff = Math.abs(
      computeWeightedScore(factors) - selected.overall_score,
    );
    if (scoreDiff > 1.5 && profile?.role !== "super_admin") {
      toast.error("Super admin approval required", {
        description: "Grade changes greater than 1.5 points require super_admin approval.",
      });
      return;
    }
    setActionLoading(true);
    try {
      const res = await edgeFetch(`/api/admin/grading/review/${selected.report_id}/adjust`, {
        method: "POST",
        body: JSON.stringify({
          factors,
          notes: notes.trim(),
          intentional_misread: intentionalMisread,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to adjust grade.");
      toast.success("Grade adjusted", {
        description: `Grade set to ${typeof json.overall_score === "number" ? json.overall_score.toFixed(1) : computedOverall.toFixed(1)}${json.resealed ? " (certificate resealed)" : ""}.`,
      });
      await closeDetail(false);
      refresh();
    } catch (err) {
      toast.error("Failed to adjust grade", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSendBack() {
    if (!selected) return;
    if (!notes.trim()) {
      toast.error("Notes required", {
        description: "Tell the seller which photos to retake.",
      });
      return;
    }
    setActionLoading(true);
    try {
      const res = await edgeFetch(`/api/admin/grading/review/${selected.report_id}/send-back`, {
        method: "POST",
        body: JSON.stringify({ notes: notes.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to send back.");
      toast.success("Sent back for better photos", {
        description: "The seller will be asked to retake the flagged photos.",
      });
      await closeDetail(false);
      refresh();
    } catch (err) {
      toast.error("Failed to send back", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionLoading(false);
    }
  }

  // ─── Stats ──────────────────────────────────────────────────────

  const queueAge = data?.queue_age_seconds ?? 0;
  const oldestTone = ageTone(queueAge * 1000);

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        icon={ClipboardCheck}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Grading Review Queue
            {items.length > 0 && (
              <Badge variant="destructive">{items.length} pending</Badge>
            )}
          </span>
        }
        actions={
          items.length > 0 ? (
            <Badge variant="secondary" className={`${oldestTone} px-3 py-1 text-sm`}>
              <Clock className="mr-1 h-3.5 w-3.5" />
              Oldest waiting {formatWaitingTime(queueAge * 1000)}
            </Badge>
          ) : undefined
        }
      />

      <p className="text-sm text-muted-foreground">
        Low-confidence grades (confidence &lt; 0.75) flagged for human review. Claim an item to
        work it — claiming locks it so two operators never grade the same garment.
      </p>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SearchInput
              label="Search grading queue"
              placeholder="Search title, email, type..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger aria-label="Filter by category">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* US-2505: ported from the retired /admin/reviews. */}
            <Select value={confidenceFilter} onValueChange={setConfidenceFilter}>
              <SelectTrigger aria-label="Filter by confidence">
                <SelectValue placeholder="All Confidence" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Confidence</SelectItem>
                <SelectItem value="high">High (&ge; 0.85)</SelectItem>
                <SelectItem value="medium">Medium (0.75–0.84)</SelectItem>
                <SelectItem value="low">Low (&lt; 0.75)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Queue table */}
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
                  <TableHead>Item</TableHead>
                  <TableHead>Seller</TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("info_value")}
                      title="Information value: how much reviewing this item improves the grader (novel category, near review threshold, rare defect combo). Overdue items always float to the top."
                    >
                      Value
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("score")}
                    >
                      Grade
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("confidence")}
                    >
                      Confidence
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggleSort("waiting_time")}
                    >
                      Waiting
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                      No grades are waiting for review. 🎉
                    </TableCell>
                  </TableRow>
                ) : (
                  sorted.map((item) => {
                    const lockedByOther = Boolean(item.claimed_by) && !item.claimed_by_me;
                    return (
                      <TableRow key={item.report_id} className="hover:bg-muted/50">
                        <TableCell className="max-w-[200px]">
                          <p className="font-medium text-sm truncate">{item.title ?? "Untitled"}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {item.garment_type ?? "—"}
                            {item.garment_category ? ` · ${item.garment_category}` : ""}
                          </p>
                        </TableCell>
                        <TableCell className="max-w-[160px] truncate text-sm text-muted-foreground">
                          {item.user_name ?? item.user_email ?? "Unknown"}
                        </TableCell>
                        <TableCell className="max-w-[170px]">
                          {/* US-1558: why this item ranks where it does. */}
                          <span className="font-mono text-xs tabular-nums">
                            {(item.info_value ?? 0).toFixed(2)}
                          </span>
                          {(item.info_reasons ?? []).length > 0 && (
                            <p className="text-xs text-muted-foreground truncate">
                              {(item.info_reasons ?? []).join(" · ")}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="font-bold tabular-nums">
                            {item.overall_score.toFixed(1)}
                          </span>{" "}
                          <Badge variant="secondary" className="text-xs">
                            {item.grade_tier}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className="bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 tabular-nums"
                          >
                            {(item.confidence_score * 100).toFixed(0)}%
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          <Badge variant="secondary" className={ageTone(item.waiting_ms)}>
                            <Clock className="mr-1 h-3 w-3" />
                            {formatWaitingTime(item.waiting_ms)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {lockedByOther ? (
                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Lock className="h-3 w-3" />
                              {item.claimed_by_name || item.claimed_by_email || "In review"}
                            </span>
                          ) : item.claimed_by_me ? (
                            <Badge variant="outline" className="text-xs">
                              You
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Open</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant={lockedByOther ? "ghost" : "outline"}
                            disabled={actionLoading || lockedByOther}
                            onClick={() => openDetail(item)}
                          >
                            <Eye className="mr-1 h-3.5 w-3.5" />
                            {item.claimed_by_me ? "Resume" : "Claim & Review"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Detail / review dialog */}
      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) closeDetail(true); }}>
        <DialogContent className="max-w-4xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-brand-red-text" />
              Review: {selected?.title ?? "Untitled"}
            </DialogTitle>
            <DialogDescription>
              {selected?.garment_type} · {selected?.user_email} · Confidence{" "}
              {selected ? (selected.confidence_score * 100).toFixed(0) : "—"}%
            </DialogDescription>
          </DialogHeader>

          {selected && (
            <div className="space-y-6">
              {/* Grade summary */}
              <div className="grid grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">AI Grade</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-bold">{selected.overall_score.toFixed(1)}</span>
                      <Badge variant="secondary">{selected.grade_tier}</Badge>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Confidence</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-3xl font-bold">
                      {(selected.confidence_score * 100).toFixed(0)}%
                    </span>
                    {selected.confidence_label && (
                      <span className="ml-2 text-sm text-muted-foreground">
                        {selected.confidence_label}
                      </span>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* AI summary */}
              <div>
                <h4 className="text-sm font-medium mb-2">AI Summary</h4>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap rounded-lg border bg-muted/30 p-3">
                  {selected.ai_summary}
                </p>
              </div>

              {/* Photos */}
              <div>
                <h4 className="text-sm font-medium mb-3">Submission Photos</h4>
                {loadingDetail ? (
                  <div className="grid grid-cols-3 gap-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="aspect-square rounded-lg" />
                    ))}
                  </div>
                ) : !detail || detail.images.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No photos available.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    {detail.images.map((img) => (
                      <div key={img.id} className="relative">
                        {img.signed_url ? (
                          <img
                            src={img.signed_url}
                            alt={img.image_type}
                            loading="lazy"
                            decoding="async"
                            className="aspect-square rounded-lg border object-cover"
                          />
                        ) : (
                          <div className="aspect-square rounded-lg border bg-muted flex items-center justify-center">
                            <ImageIcon className="h-8 w-8 text-muted-foreground" />
                          </div>
                        )}
                        <Badge
                          variant="secondary"
                          className="absolute bottom-2 left-2 text-xs capitalize"
                        >
                          {img.image_type}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Adjust toggle */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="adjust-mode"
                  checked={adjustMode}
                  onChange={(e) => setAdjustMode(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor="adjust-mode" className="text-sm">
                  Adjust factor scores
                </Label>
              </div>

              {adjustMode && (
                <div className="rounded-lg border p-4 space-y-3">
                  <h5 className="text-sm font-medium">Adjust Factor Scores</h5>
                  {FACTOR_KEYS.map((key) => {
                    const meta = FACTOR_META[key];
                    const aiScore = selected.factor_scores[key];
                    const adjusted = adjustedScores[key];
                    const diff = adjusted - aiScore;
                    return (
                      <div key={key} className="grid grid-cols-12 items-center gap-3">
                        <div className="col-span-5">
                          <Label className="text-sm">
                            {meta.label} ({(meta.weight * 100).toFixed(0)}%)
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            AI: {aiScore.toFixed(1)}
                          </p>
                        </div>
                        <div className="col-span-4">
                          <Input
                            // type="text" + inputMode="decimal": a number input
                            // hands back "" for anything the browser considers
                            // intermediate, which on mobile keyboards makes a
                            // partially-typed score indistinguishable from a
                            // cleared one. The draft state does the validating.
                            type="text"
                            inputMode="decimal"
                            value={factorDrafts[key] ?? adjusted.toFixed(1)}
                            onChange={(e) => updateFactor(key, e.target.value)}
                            onBlur={() => commitFactor(key)}
                            onFocus={(e) => e.currentTarget.select()}
                            aria-label={`${meta.label} score, 1.0 to 10.0`}
                            className="tabular-nums"
                          />
                        </div>
                        <div className="col-span-3 text-right">
                          {diff !== 0 ? (
                            <span
                              className={`text-sm font-medium ${Math.abs(diff) > 1 ? "text-amber-600 dark:text-amber-400" : "text-blue-600 dark:text-blue-400"}`}
                            >
                              {diff > 0 ? "+" : ""}
                              {diff.toFixed(1)}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  <div className="grid grid-cols-12 items-center gap-3 border-t pt-3">
                    <div className="col-span-5">
                      <Label className="text-sm font-medium">Weighted Overall</Label>
                      <p className="text-xs text-muted-foreground">
                        AI: {selected.overall_score.toFixed(1)}
                      </p>
                    </div>
                    <div className="col-span-4">
                      <span className="text-lg font-bold tabular-nums">
                        {computedOverall.toFixed(1)}
                      </span>
                    </div>
                    <div className="col-span-3 text-right">
                      {Math.abs(computedOverall - selected.overall_score) > 1.5 && (
                        <span className="flex items-center justify-end gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" />
                          &gt;1.5
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="checkbox"
                      id="intentional-misread"
                      checked={intentionalMisread}
                      onChange={(e) => setIntentionalMisread(e.target.checked)}
                      className="h-4 w-4 rounded border-input"
                    />
                    <Label htmlFor="intentional-misread" className="text-sm">
                      AI misread an intentional design feature (e.g. distressed denim) as a defect
                    </Label>
                  </div>
                </div>
              )}

              {/* Notes */}
              <div>
                <Label htmlFor="review-notes" className="text-sm font-medium">
                  Reviewer Notes {adjustMode && <span className="text-brand-red-text">*</span>}
                </Label>
                <Textarea
                  id="review-notes"
                  placeholder={
                    adjustMode
                      ? "Explain the adjustment (required, recorded in the audit trail)..."
                      : "Optional notes..."
                  }
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="mt-1"
                />
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                {adjustMode ? (
                  <Button onClick={handleAdjust} disabled={actionLoading} className="flex-1">
                    {actionLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Pencil className="mr-2 h-4 w-4" />
                    )}
                    Adjust &amp; Reseal Certificate
                  </Button>
                ) : (
                  <Button onClick={handleApprove} disabled={actionLoading} className="flex-1">
                    {actionLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-2 h-4 w-4" />
                    )}
                    Approve AI Grade
                  </Button>
                )}
                <Button variant="outline" onClick={handleSendBack} disabled={actionLoading}>
                  <Undo2 className="mr-2 h-4 w-4" />
                  Send Back for Photos
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* US-1533: garment expectation baselines — view/correct the trusted
          reference briefs the grader is given. An edit is live on the next
          grade (pipeline reads are DB-fresh). */}
      <GarmentBaselinesCard />

      {/* US-1535: the learnings loop — auto-assembled exemplar sets land here
          after the scheduled eval; passing sets activate with one click. */}
      <ExemplarSetsCard />

      {/* US-1557: per-category confidence calibration — shadow-first. */}
      <CalibrationCard />
    </div>
  );
}

// ── US-1557: confidence calibration ─────────────────────────────────────────

interface CalibrationCurveBin {
  lo: number;
  hi: number;
  n: number;
  meanAbsError: number;
  errorRate: number;
}

interface CalibrationCategory {
  threshold: number;
  sample_size: number;
  shipped_error_rate: number | null;
  curve: CalibrationCurveBin[];
}

interface CalibrationResponse {
  calibration: {
    enabled: boolean;
    target_error_rate: number;
    computed_at: string | null;
    categories: Record<string, CalibrationCategory>;
  };
  flat_threshold: number;
}

function CalibrationCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-calibration-thresholds"],
    queryFn: async (): Promise<CalibrationResponse> => {
      const res = await edgeFetch("/api/admin/grading/calibration-thresholds");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as CalibrationResponse;
    },
    staleTime: 60 * 1000,
  });

  const cats = Object.entries(data?.calibration.categories ?? {}).sort(
    (a, b) => a[0].localeCompare(b[0]),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Confidence calibration
          {data && (
            <Badge
              className={
                data.calibration.enabled
                  ? "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
              }
            >
              {data.calibration.enabled ? "Enforcing" : "Shadow mode"}
            </Badge>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Per-category review thresholds derived weekly from human-review
          outcomes (US-1557). In shadow mode the flat threshold
          {data ? ` (${data.flat_threshold})` : ""} still rules and would-route
          deltas are logged. Enable / override via the Settings Registry key{" "}
          <code>grading_confidence_calibration</code>.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <Skeleton className="h-14 w-full" />}
        {data && cats.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No categories calibrated yet — needs ≥50 reviewed grades per
            category. The weekly job fills this in as reviews accumulate.
          </p>
        )}
        {cats.map(([name, cat]) => (
          <div key={name} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium capitalize">{name}</span>
              <Badge variant="outline">
                threshold {cat.threshold.toFixed(2)}
                {data ? ` (flat ${data.flat_threshold})` : ""}
              </Badge>
              <span className="text-xs text-muted-foreground">
                n={cat.sample_size}
                {cat.shipped_error_rate != null
                  ? ` · shipped error ${(cat.shipped_error_rate * 100).toFixed(1)}%`
                  : ""}
              </span>
            </div>
            {cat.curve.length > 0 && (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {cat.curve
                  .map(
                    (b) =>
                      `${b.lo.toFixed(2)}–${b.hi.toFixed(2)}: ${(b.errorRate * 100).toFixed(0)}% err (n=${b.n})`,
                  )
                  .join("  ·  ")}
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── US-1535: exemplar sets (the learnings loop) ─────────────────────────────

interface ExemplarSetListRow {
  id: string;
  version_name: string;
  garment_category: string | null;
  exemplar_count: number;
  approx_tokens: number;
  status: string;
  eval_passed: boolean | null;
  eval_mae: number | null;
  eval_agreement_rate: number | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

function ExemplarSetsCard() {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-exemplar-sets"],
    queryFn: async (): Promise<ExemplarSetListRow[]> => {
      const res = await edgeFetch("/api/admin/grading/exemplars");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { sets: ExemplarSetListRow[] };
      return body.sets;
    },
    staleTime: 30 * 1000,
  });

  const act = async (id: string, action: "activate" | "deactivate") => {
    setBusyId(id);
    try {
      const res = await edgeFetch(
        `/api/admin/grading/exemplars/${id}/${action}`,
        { method: "POST", json: {} },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        action === "activate"
          ? "Exemplar set activated — live on grading"
          : "Exemplar set deactivated",
      );
      queryClient.invalidateQueries({ queryKey: ["admin-exemplar-sets"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setBusyId(null);
    }
  };

  const statusBadge = (row: ExemplarSetListRow) => {
    if (row.is_active) {
      return (
        <Badge className="bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300">
          Active
        </Badge>
      );
    }
    if (row.eval_passed === true) {
      return (
        <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
          Passed eval
        </Badge>
      );
    }
    if (row.eval_passed === false) {
      return (
        <Badge className="bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300">
          Failed eval
        </Badge>
      );
    }
    return <Badge variant="outline">{row.status}</Badge>;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Learned exemplar sets</CardTitle>
        <p className="text-sm text-muted-foreground">
          Auto-assembled weekly from human corrections + approved claims
          (US-1535), eval-gated. Activate a passing set to inject its lessons
          into live grading; failing sets park here with their metrics.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <Skeleton className="h-16 w-full" />}
        {data && data.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No exemplar sets yet — the weekly assembly job creates candidates
            once human corrections accumulate.
          </p>
        )}
        {(data ?? []).map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
          >
            <span className="text-sm font-medium">{row.version_name}</span>
            {row.garment_category && (
              <Badge variant="outline">{row.garment_category}</Badge>
            )}
            {statusBadge(row)}
            <span className="text-xs text-muted-foreground">
              {row.exemplar_count} exemplars · ~{row.approx_tokens} tok
              {row.eval_mae !== null
                ? ` · MAE ${row.eval_mae.toFixed(2)} · agree ${Math.round((row.eval_agreement_rate ?? 0) * 100)}%`
                : ""}
            </span>
            <div className="ml-auto flex gap-2">
              {row.is_active ? (
                <Button
                aria-label={`Deactivate ${row.version_name}`}
                  size="sm"
                  variant="outline"
                  disabled={busyId === row.id}
                  onClick={() => act(row.id, "deactivate")}
                >
                  Deactivate
                </Button>
              ) : row.eval_passed === true ? (
                <Button
                  size="sm"
                  disabled={busyId === row.id}
                  onClick={() => act(row.id, "activate")}
                >
                  {busyId === row.id ? "Activating…" : "Activate"}
                </Button>
              ) : null}
            </div>
            {row.notes && (
              <p className="w-full text-xs text-muted-foreground">{row.notes}</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── US-1533: garment baselines admin ────────────────────────────────────────

interface GarmentBaselineRow {
  id: string;
  brand: string;
  garment_category: string;
  style: string;
  brief: string;
  model: string;
  prompt_version: string;
  updated_at: string;
}

function GarmentBaselinesCard() {
  const queryClient = useQueryClient();
  const [brandFilter, setBrandFilter] = useState("");
  const [editing, setEditing] = useState<GarmentBaselineRow | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-garment-baselines", brandFilter.trim()],
    queryFn: async (): Promise<GarmentBaselineRow[]> => {
      const params = new URLSearchParams({ limit: "50" });
      if (brandFilter.trim()) params.set("brand", brandFilter.trim());
      const res = await edgeFetch(
        `/api/admin/grading/baselines?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { baselines: GarmentBaselineRow[] };
      return body.baselines;
    },
    staleTime: 30 * 1000,
  });

  const saveBrief = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await edgeFetch(
        `/api/admin/grading/baselines/${editing.id}`,
        { method: "PUT", json: { brief: draft.trim() } },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toast.success("Baseline updated — live on the next grade");
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ["admin-garment-baselines"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save baseline");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Garment baselines</CardTitle>
        <p className="text-sm text-muted-foreground">
          Server-generated as-manufactured expectation briefs injected into the
          grading prompts (US-1533). Correct a bad brief here — the fix applies
          to the very next grade.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          aria-label="Filter baselines by brand"
          value={brandFilter}
          onChange={(e) => setBrandFilter(e.target.value)}
          placeholder="Filter by brand…"
          className="h-8 max-w-xs"
        />
        {isLoading && <Skeleton className="h-16 w-full" />}
        {data && data.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No baselines generated yet — they appear as branded items get graded
            with baselines enabled.
          </p>
        )}
        <div className="space-y-2">
          {(data ?? []).map((row) => (
            <div key={row.id} className="rounded-lg border p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium capitalize">
                  {row.brand} · {row.garment_category}
                  {row.style ? ` · ${row.style}` : ""}
                </span>
                <Badge variant="outline">{row.prompt_version}</Badge>
                <Button
                aria-label={`Edit the baseline for ${row.brand} ${row.garment_category}`}
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7"
                  onClick={() => {
                    setEditing(row);
                    setDraft(row.brief);
                  }}
                >
                  Edit
                </Button>
              </div>
              {editing?.id === row.id ? (
                <div className="space-y-2">
                  {/* This edits the as-manufactured expectation BRIEF that is
                      injected into the grading prompt, and the row header above
                      names the brand rather than the field. */}
                  <Textarea
                    aria-label={`Baseline brief for ${row.brand} ${row.garment_category}`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={6}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={saveBrief}
                      disabled={saving || draft.trim() === ""}
                    >
                      {saving ? "Saving…" : "Save"}
                    </Button>
                    <Button
                    aria-label={`Cancel editing ${row.brand} ${row.garment_category}`}
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                  {row.brief}
                </p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
