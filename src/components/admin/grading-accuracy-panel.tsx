import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Target, Download, FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";

// US-1564: surfaces the finished-but-unreachable grading analytics endpoints:
//   GET /accuracy, /accuracy/defects, /accuracy/outcomes  → three data tabs
//   GET /shadow/comparison + /shadow/results               → the Shadow tab
//   GET /training-export + POST /model-comparison          → the Tools tab
// Lives on /admin/ai-models next to the monitor/eval/calibration panels — the
// AI-operations hub — so accuracy context sits beside the levers it informs.

interface CategoryAccuracy {
  garment_category: string;
  mean_absolute_error: number;
  agreement_rate: number;
  intentional_misread_rate: number;
  count: number;
}

interface VersionAccuracy {
  version_name: string;
  overall_mean_absolute_error: number;
  overall_agreement_rate: number;
  intentional_misread_rate: number;
  total_reviews: number;
}

interface AccuracySummary {
  versions: VersionAccuracy[];
  global_mean_absolute_error: number;
  global_agreement_rate: number;
  global_intentional_misread_rate: number;
  category_accuracies: CategoryAccuracy[];
  total_reviews: number;
}

interface DefectTypeAccuracy {
  defect_type: string;
  count: number;
  mean_abs_error: number;
  mean_signed_delta: number;
  agreement_rate: number;
}

interface WeightRecommendation {
  defect_type: string;
  direction: "increase" | "decrease";
  mean_signed_delta: number;
  count: number;
  rationale: string;
}

interface DefectReport {
  by_defect_type: DefectTypeAccuracy[];
  by_size_bucket: Array<DefectTypeAccuracy & { size_bucket: string }>;
  recommendations: WeightRecommendation[];
  weights_version: string;
  reviewed_grades: number;
}

interface CategoryOutcome {
  garment_category: string;
  graded_sales: number;
  dispute_count: number;
  dispute_rate: number;
  mean_sold_to_listing_ratio: number | null;
}

interface OutcomeSummary {
  categories: CategoryOutcome[];
  total_graded_sales: number;
  overall_dispute_rate: number;
}

interface ShadowRow {
  id: string;
  submission_id: string;
  shadow_prompt_version_name: string;
  active_overall_score: number | null;
  shadow_overall_score: number | null;
  score_delta: number | null;
  agreement: boolean | null;
  error: string | null;
  created_at: string;
}

interface ShadowComparison {
  version: string;
  days: number;
  total: number;
  errored: number;
  scored: number;
  agreement_rate: number | null;
  mean_abs_delta: number | null;
  mean_delta: number | null;
  delta_histogram: Record<string, number>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  return json as T;
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

export function GradingAccuracyPanel() {
  const [period, setPeriod] = useState("month");
  const windowId = useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4" />
          Grading accuracy & shadow analytics
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Human-review deltas sliced by version, category, and defect type; post-sale outcome
          signals; shadow-prompt comparisons; training-data export (US-1564).
        </p>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="accuracy">
          <TabsList>
            <TabsTrigger value="accuracy">Accuracy</TabsTrigger>
            <TabsTrigger value="defects">Defects</TabsTrigger>
            <TabsTrigger value="outcomes">Outcomes</TabsTrigger>
            <TabsTrigger value="snad">Returns</TabsTrigger>
            <TabsTrigger value="shadow">Shadow</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
          </TabsList>

          <TabsContent value="accuracy" className="space-y-4 pt-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs" htmlFor={windowId}>Window</Label>
              <Select value={period} onValueChange={setPeriod}>
                <SelectTrigger className="h-8 w-28" id={windowId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="week">Week</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                  <SelectItem value="all">All time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <AccuracyTab period={period} />
          </TabsContent>

          <TabsContent value="defects" className="pt-3">
            <DefectsTab period={period} />
          </TabsContent>

          <TabsContent value="outcomes" className="pt-3">
            <OutcomesTab />
          </TabsContent>

          {/* US-2937: grades the market disagreed with. Its own tab rather than
              a row in Outcomes, because these are a REVIEW QUEUE — each one is
              a piece of work for a person, not a number to read. */}
          <TabsContent value="snad" className="pt-3">
            <SnadObservationsTab />
          </TabsContent>

          <TabsContent value="shadow" className="pt-3">
            <ShadowTab />
          </TabsContent>

          <TabsContent value="tools" className="pt-3">
            <ToolsTab />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function AccuracyTab({ period }: { period: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-grading-accuracy", period],
    queryFn: () => getJson<AccuracySummary>(`/api/admin/grading/accuracy?period=${period}`),
    staleTime: 60 * 1000,
  });
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (error || !data) return <p className="text-sm text-destructive">Couldn't load accuracy data.</p>;
  if (data.total_reviews === 0) {
    return <p className="text-sm text-muted-foreground">No human reviews in this window yet — accuracy metrics appear as reviews accumulate.</p>;
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Reviews" value={String(data.total_reviews)} />
        <Stat label="Global MAE" value={data.global_mean_absolute_error.toFixed(2)} hint="mean |AI − human| overall points" />
        <Stat label="Agreement" value={pct(data.global_agreement_rate)} hint="within 0.5 points" />
        <Stat label="Design-misread rate" value={pct(data.global_intentional_misread_rate)} />
      </div>
      {data.versions.length > 0 && (
        <MiniTable
          title="By prompt version"
          head={["Version", "Reviews", "MAE", "Agreement", "Misread"]}
          rows={data.versions.map((v) => [
            v.version_name,
            String(v.total_reviews),
            v.overall_mean_absolute_error.toFixed(2),
            pct(v.overall_agreement_rate),
            pct(v.intentional_misread_rate),
          ])}
        />
      )}
      {data.category_accuracies.length > 0 && (
        <MiniTable
          title="By garment category"
          head={["Category", "Reviews", "MAE", "Agreement", "Misread"]}
          rows={data.category_accuracies.map((cat) => [
            cat.garment_category,
            String(cat.count),
            cat.mean_absolute_error.toFixed(2),
            pct(cat.agreement_rate),
            pct(cat.intentional_misread_rate),
          ])}
        />
      )}
    </div>
  );
}

function DefectsTab({ period }: { period: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-grading-defect-accuracy", period],
    queryFn: () => getJson<DefectReport>(`/api/admin/grading/accuracy/defects?period=${period}`),
    staleTime: 60 * 1000,
  });
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (error || !data) return <p className="text-sm text-destructive">Couldn't load defect accuracy.</p>;
  if (data.reviewed_grades === 0) {
    return <p className="text-sm text-muted-foreground">No reviewed grades with structured defects in this window.</p>;
  }
  return (
    <div className="space-y-4">
      {data.recommendations.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          <p className="font-medium">Weight-table calibration signals (advisory — weights v{data.weights_version}, never auto-applied):</p>
          <ul className="mt-1 list-disc pl-5">
            {data.recommendations.map((r) => (
              <li key={r.defect_type}>
                <span className="font-medium">{r.defect_type}</span>: {r.direction} — {r.rationale}
              </li>
            ))}
          </ul>
        </div>
      )}
      <MiniTable
        title={`By defect type (${data.reviewed_grades} reviewed grades)`}
        head={["Defect", "n", "MAE", "Signed Δ (+ = AI harsh)", "Agreement"]}
        rows={data.by_defect_type.map((d) => [
          d.defect_type,
          String(d.count),
          d.mean_abs_error.toFixed(2),
          (d.mean_signed_delta >= 0 ? "+" : "") + d.mean_signed_delta.toFixed(2),
          pct(d.agreement_rate),
        ])}
      />
      {data.by_size_bucket.length > 0 && (
        <MiniTable
          title="By defect size"
          head={["Size", "n", "MAE", "Signed Δ", "Agreement"]}
          rows={data.by_size_bucket.map((d) => [
            d.size_bucket,
            String(d.count),
            d.mean_abs_error.toFixed(2),
            (d.mean_signed_delta >= 0 ? "+" : "") + d.mean_signed_delta.toFixed(2),
            pct(d.agreement_rate),
          ])}
        />
      )}
    </div>
  );
}

function OutcomesTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-grading-outcomes"],
    queryFn: () => getJson<OutcomeSummary>("/api/admin/grading/accuracy/outcomes"),
    staleTime: 5 * 60 * 1000,
  });
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (error || !data) return <p className="text-sm text-destructive">Couldn't load outcome feedback.</p>;
  if (data.total_graded_sales === 0) {
    return <p className="text-sm text-muted-foreground">No post-sale outcome data yet (opt-in sale + dispute feedback).</p>;
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Graded sales" value={String(data.total_graded_sales)} />
        <Stat label="Overall dispute rate" value={pct(data.overall_dispute_rate)} />
      </div>
      <MiniTable
        title="By category (post-sale)"
        head={["Category", "Sales", "Disputes", "Dispute rate", "Sold/list ratio"]}
        rows={data.categories.map((cat) => [
          cat.garment_category,
          String(cat.graded_sales),
          String(cat.dispute_count),
          pct(cat.dispute_rate),
          cat.mean_sold_to_listing_ratio?.toFixed(2) ?? "—",
        ])}
      />
    </div>
  );
}

function ShadowTab() {
  const [version, setVersion] = useState("");
  const shadowVersionId = useId();

  const { data: recent } = useQuery({
    queryKey: ["admin-grading-shadow-recent"],
    queryFn: () => getJson<{ results: ShadowRow[] }>("/api/admin/grading/shadow/results?limit=200"),
    staleTime: 60 * 1000,
  });
  const versions = useMemo(
    () => [...new Set((recent?.results ?? []).map((r) => r.shadow_prompt_version_name))],
    [recent],
  );

  const { data: comparison, isLoading: comparing } = useQuery({
    queryKey: ["admin-grading-shadow-comparison", version],
    queryFn: () => getJson<ShadowComparison>(`/api/admin/grading/shadow/comparison?version=${encodeURIComponent(version)}`),
    enabled: version.length > 0,
    staleTime: 60 * 1000,
  });

  const divergent = useMemo(
    () =>
      (recent?.results ?? [])
        .filter((r) => r.shadow_prompt_version_name === version)
        .filter((r) => r.error !== null || r.agreement === false)
        .slice(0, 25),
    [recent, version],
  );

  if (versions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No shadow results yet — start a shadow run from a draft prompt version and comparisons appear here.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Label className="text-xs" htmlFor={shadowVersionId}>Shadow version</Label>
        <Select value={version} onValueChange={setVersion}>
          <SelectTrigger className="h-8 w-64" id={shadowVersionId}>
            <SelectValue placeholder="Pick a shadow version…" />
          </SelectTrigger>
          <SelectContent>
            {versions.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {version && (comparing ? <Skeleton className="h-24 w-full" /> : comparison && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Shadow runs" value={`${comparison.scored}/${comparison.total}`} hint={`${comparison.errored} errored · last ${comparison.days}d`} />
            <Stat label="Agreement" value={pct(comparison.agreement_rate)} hint="within 0.5 points of active" />
            <Stat label="Mean |Δ|" value={comparison.mean_abs_delta?.toFixed(2) ?? "—"} />
            <Stat label="Mean Δ" value={comparison.mean_delta == null ? "—" : (comparison.mean_delta >= 0 ? "+" : "") + comparison.mean_delta.toFixed(2)} hint="+ = shadow grades higher" />
          </div>
          {Object.keys(comparison.delta_histogram).length > 0 && (
            <p className="font-mono text-xs text-muted-foreground">
              Δ histogram:{" "}
              {Object.entries(comparison.delta_histogram)
                .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
                .map(([bucket, n]) => `${bucket}:${n}`)
                .join("  ")}
            </p>
          )}
          {divergent.length > 0 && (
            <MiniTable
              title="Divergent / errored rows (eyeball these)"
              head={["Submission", "Active", "Shadow", "Δ", "Error"]}
              rows={divergent.map((r) => [
                r.submission_id.slice(0, 8),
                r.active_overall_score?.toFixed(1) ?? "—",
                r.shadow_overall_score?.toFixed(1) ?? "—",
                r.score_delta == null ? "—" : (r.score_delta >= 0 ? "+" : "") + r.score_delta.toFixed(1),
                r.error ? r.error.slice(0, 60) : "disagrees",
              ])}
            />
          )}
        </>
      ))}
    </div>
  );
}

function ToolsTab() {
  const [exporting, setExporting] = useState(false);
  const [consentOnly, setConsentOnly] = useState(true);

  const [compareOpen, setCompareOpen] = useState(false);
  const [modelA, setModelA] = useState("");
  const [modelB, setModelB] = useState("");
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<Record<string, unknown> | null>(null);

  // The default/empty prompt version to run the comparison under.
  const { data: prompts } = useQuery({
    queryKey: ["admin-grading-prompts-for-comparison"],
    queryFn: () => getJson<{ prompts: Array<{ id: string; version_name: string; is_active: boolean }> }>("/api/admin/grading/prompts"),
    staleTime: 5 * 60 * 1000,
  });
  const [promptVersionId, setPromptVersionId] = useState("");
  const promptVersionSelectId = useId();

  async function downloadExport() {
    setExporting(true);
    try {
      const res = await edgeFetch(`/api/admin/grading/training-export?consent_only=${consentOnly}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `grading-training-export-${new Date().toISOString().slice(0, 10)}.ndjson`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Training export downloaded (NDJSON).");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  async function runComparison() {
    setComparing(true);
    setCompareResult(null);
    try {
      const res = await edgeFetch("/api/admin/grading/model-comparison", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt_version_id: promptVersionId,
          model_a: modelA.trim(),
          model_b: modelB.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
      setCompareResult(json as Record<string, unknown>);
      toast.success("Model comparison complete.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Comparison failed.");
    } finally {
      setComparing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4">
        <p className="flex items-center gap-2 font-medium">
          <Download className="h-4 w-4" />
          Training-data export
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          NDJSON of human-reviewed grades (AI output + corrected ground truth + image storage refs)
          for offline analysis and exemplar curation. Reviewer notes are redacted; the export is audited.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={consentOnly}
              onChange={(e) => setConsentOnly(e.target.checked)}
            />
            Consented rows only (uncheck = full internal export, audited)
          </label>
          <Button size="sm" onClick={() => void downloadExport()} disabled={exporting}>
            {exporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Download NDJSON
          </Button>
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <p className="flex items-center gap-2 font-medium">
          <FlaskConical className="h-4 w-4" />
          Model comparison (eval gate)
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Grades every active golden case under two models and compares grade error.{" "}
          <span className="font-medium text-foreground">Expensive</span> — two real vision calls per
          golden case; run when qualifying a model upgrade, not casually.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={promptVersionSelectId}>Prompt version (usually the active default)</Label>
            <Select value={promptVersionId} onValueChange={setPromptVersionId}>
              <SelectTrigger className="h-9" id={promptVersionSelectId}>
                <SelectValue placeholder="Pick…" />
              </SelectTrigger>
              <SelectContent>
                {(prompts?.prompts ?? []).map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.version_name}{v.is_active ? " (active)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="model-a">Model A</Label>
            <Input id="model-a" className="h-9" placeholder="e.g. claude-sonnet-5" value={modelA} onChange={(e) => setModelA(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="model-b">Model B</Label>
            <Input id="model-b" className="h-9" placeholder="e.g. claude-opus-4-8" value={modelB} onChange={(e) => setModelB(e.target.value)} />
          </div>
        </div>
        <Button
          size="sm"
          className="mt-3"
          variant="outline"
          disabled={!promptVersionId || !modelA.trim() || !modelB.trim() || comparing}
          onClick={() => setCompareOpen(true)}
        >
          Run comparison…
        </Button>
        {compareResult && (
          <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(compareResult, null, 2)}
          </pre>
        )}
      </div>

      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run model comparison?</DialogTitle>
            <DialogDescription>
              This grades every active golden case TWICE through the real vision model
              ({modelA.trim()} vs {modelB.trim()}) — real API spend, several minutes. Continue?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCompareOpen(false)} disabled={comparing}>Cancel</Button>
            <Button
              onClick={() => {
                setCompareOpen(false);
                void runComparison();
              }}
              disabled={comparing}
            >
              {comparing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Run (spends API budget)
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {comparing && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Grading golden cases under both models — leave this tab open…
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function MiniTable({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  return (
    <div className="rounded-lg border">
      <div className="border-b px-3 py-2 text-sm font-medium">{title}</div>
      <div className="max-h-72 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {head.map((h) => <TableHead key={h} className="text-xs">{h}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {r.map((cell, j) => (
                  <TableCell key={j} className={`py-1.5 text-sm ${j === 0 ? "font-medium" : "tabular-nums"}`}>
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── US-2937: SNAD observations ──────────────────────────────────────
//
// A human review says the model was 0.5 off. These rows say a buyer paid, held
// the garment, and said the condition was not what we published — the market
// disagreeing with the grade.
//
// A SIGNAL, NOT A VERDICT, and the copy says so. Buyers file "not as described"
// for wrong sizes, for screen colour, and because it is the reason that gets
// free return postage. None of these rows reaches a public accuracy figure
// until a person has been through it, which is what this tab is for.

interface SnadObservation {
  id: string;
  grade_report_id: string;
  inventory_item_id: string | null;
  observed_at: string;
  overall_score: number | null;
  grade_tier: string | null;
  confidence_score: number | null;
  needs_human_review: boolean | null;
  already_reviewed: boolean;
}

function SnadObservationsTab() {
  const [unreviewedOnly, setUnreviewedOnly] = useState(true);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-grading-snad-observations"],
    queryFn: () =>
      getJson<{ total: number; observations: SnadObservation[] }>(
        "/api/admin/grading/accuracy/snad-observations?limit=200",
      ),
    staleTime: 60 * 1000,
  });
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (error || !data) {
    return <p className="text-sm text-destructive">Couldn't load return observations.</p>;
  }
  const rows = unreviewedOnly
    ? data.observations.filter((o) => !o.already_reviewed)
    : data.observations;
  if (data.total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No not-as-described returns on graded items yet.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        A buyer returned one of these as not as described. That is a signal about
        the grade, not a ruling on it — buyers pick this reason for wrong sizes
        and for free return postage too. Nothing here reaches a published figure
        until you have been through it.
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setUnreviewedOnly((v) => !v)}
      >
        {unreviewedOnly
          ? `Show all (${data.observations.length})`
          : `Show unreviewed only (${data.observations.filter((o) => !o.already_reviewed).length})`}
      </Button>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Every one of these has already been reviewed.
        </p>
      ) : (
        <MiniTable
          title={`${rows.length} observation${rows.length === 1 ? "" : "s"}`}
          head={["Grade", "Tier", "Confidence", "Flagged at grading", "Reviewed", "Seen"]}
          rows={rows.map((o) => [
            o.overall_score == null ? "—" : o.overall_score.toFixed(1),
            o.grade_tier ?? "—",
            o.confidence_score == null ? "—" : o.confidence_score.toFixed(2),
            o.needs_human_review ? "yes" : "no",
            o.already_reviewed ? "yes" : "no",
            o.observed_at.slice(0, 10),
          ])}
        />
      )}
    </div>
  );
}
