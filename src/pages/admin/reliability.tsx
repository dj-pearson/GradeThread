import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  BarChart3,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { edgeFetch } from "@/lib/edge-fetch";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

// US-334: admin surface for inter-rater reliability studies (blind multi-rater
// rounds). Computes the human-vs-human baseline + Krippendorff's alpha and
// compares the AI's agreement with the human consensus against it.

interface StudyCounts {
  items: number;
  ratings: number;
  reviewers: number;
}
interface Study {
  id: string;
  name: string;
  status: "open" | "closed";
  tolerance: number;
  created_at: string;
  // US-866: when true, this closed study's human-vs-human baseline is shown on
  // the public /transparency report.
  published_to_transparency?: boolean;
  counts?: StudyCounts;
}
// US-488: the queue payload is MINIMIZED server-side — non-identifying garment
// attributes only. No owner identity, no seller free text (title/description).
interface QueueItem {
  id: string;
  garment_type: string | null;
  garment_category: string | null;
  brand: string | null;
}
interface ItemPhoto {
  id: string;
  image_type: string;
  display_order: number;
  signed_url: string | null;
}
interface IrrReport {
  item_count: number;
  pairable_item_count: number;
  rater_count: number;
  human: { agreement_within: number; mae: number; pair_count: number; tolerance: number };
  krippendorff_alpha: number | null;
  ai_vs_human: {
    ai_agreement_within: number;
    ai_mae: number;
    human_agreement_within: number;
    human_mae: number;
    ai_meets_human: boolean;
    item_count: number;
  } | null;
  sufficient_sample: boolean;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function AdminReliabilityPage() {
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [tolerance, setTolerance] = useState("0.5");
  const [creating, setCreating] = useState(false);

  const [selected, setSelected] = useState<Study | null>(null);
  const [report, setReport] = useState<IrrReport | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [addIds, setAddIds] = useState("");
  const [photos, setPhotos] = useState<Record<string, ItemPhoto[]>>({});
  const [photosLoading, setPhotosLoading] = useState<string | null>(null);

  const loadStudies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await edgeFetch("/api/admin/grading/reliability/studies");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setStudies(data.studies ?? []);
    } catch (e) {
      toast.error(`Failed to load studies: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStudies();
  }, [loadStudies]);

  async function createStudy() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await edgeFetch("/api/admin/grading/reliability/studies", {
        method: "POST",
        json: { name: name.trim(), tolerance: Number(tolerance) || 0.5 },
      });
      if (!res.ok) throw new Error(await res.text());
      setName("");
      toast.success("Study created");
      await loadStudies();
    } catch (e) {
      toast.error(`Create failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setCreating(false);
    }
  }

  const openStudy = useCallback(async (study: Study) => {
    setSelected(study);
    setReport(null);
    setQueue([]);
    setScores({});
    setPhotos({});
    try {
      const [reportRes, queueRes] = await Promise.all([
        edgeFetch(`/api/admin/grading/reliability/studies/${study.id}/report`),
        edgeFetch(`/api/admin/grading/reliability/studies/${study.id}/queue`),
      ]);
      if (reportRes.ok) setReport((await reportRes.json()).report);
      if (queueRes.ok) setQueue((await queueRes.json()).queue ?? []);
    } catch (e) {
      toast.error(`Failed to open study: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  async function addSubmissions() {
    if (!selected) return;
    const ids = addIds
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    try {
      const res = await edgeFetch(
        `/api/admin/grading/reliability/studies/${selected.id}/items`,
        { method: "POST", json: { submission_ids: ids } },
      );
      if (!res.ok) throw new Error(await res.text());
      setAddIds("");
      toast.success(`Added ${(await res.json()).added} submission(s)`);
      await openStudy(selected);
      await loadStudies();
    } catch (e) {
      toast.error(`Add failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Each open is a server round-trip on purpose: photo access is granted
  // per-item and audit-logged per view (US-488).
  async function togglePhotos(submissionId: string) {
    if (!selected) return;
    if (photos[submissionId]) {
      setPhotos((p) => {
        const next = { ...p };
        delete next[submissionId];
        return next;
      });
      return;
    }
    setPhotosLoading(submissionId);
    try {
      const res = await edgeFetch(
        `/api/admin/grading/reliability/studies/${selected.id}/items/${submissionId}/photos`,
      );
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPhotos((p) => ({ ...p, [submissionId]: data.images ?? [] }));
    } catch (e) {
      toast.error(`Failed to load photos: ${e instanceof Error ? e.message : e}`);
    } finally {
      setPhotosLoading(null);
    }
  }

  async function submitRating(submissionId: string) {
    if (!selected) return;
    const raw = scores[submissionId];
    const overall = Number(raw);
    if (!Number.isFinite(overall) || overall < 1 || overall > 10) {
      toast.error("Enter a score 1.0–10.0");
      return;
    }
    try {
      const res = await edgeFetch(
        `/api/admin/grading/reliability/studies/${selected.id}/ratings`,
        { method: "POST", json: { submission_id: submissionId, overall_score: overall } },
      );
      if (!res.ok) throw new Error(await res.text());
      toast.success("Rating saved (blind)");
      await openStudy(selected);
      await loadStudies();
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function closeStudy() {
    if (!selected) return;
    try {
      const res = await edgeFetch(
        `/api/admin/grading/reliability/studies/${selected.id}/close`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await res.text());
      toast.success("Study closed");
      await loadStudies();
      setSelected({ ...selected, status: "closed" });
    } catch (e) {
      toast.error(`Close failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // US-866: publish/unpublish this closed study's human baseline to the public
  // transparency report.
  async function togglePublish() {
    if (!selected) return;
    const next = !selected.published_to_transparency;
    try {
      const res = await edgeFetch(
        `/api/admin/grading/reliability/studies/${selected.id}/publish`,
        { method: "POST", json: { published: next } },
      );
      if (!res.ok) throw new Error(await res.text());
      toast.success(next ? "Published to transparency" : "Unpublished");
      await loadStudies();
      setSelected({ ...selected, published_to_transparency: next });
    } catch (e) {
      toast.error(`Publish failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Inter-rater reliability"
        subtitle="Run blind multi-rater studies to measure the human-vs-human grading baseline, then compare the AI against it. Reviewers never see the AI grade or one another's scores."
        icon={BarChart3}
      />

      {/* Create */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New study</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <Label htmlFor="study-name">Name</Label>
            <Input
              id="study-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q2 expert calibration"
            />
          </div>
          <div className="w-32">
            <Label htmlFor="study-tol">Tolerance</Label>
            <Input
              id="study-tol"
              value={tolerance}
              onChange={(e) => setTolerance(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <Button onClick={createStudy} disabled={creating || !name.trim()}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create
          </Button>
        </CardContent>
      </Card>

      {/* Studies list */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? (
          <div className="col-span-full flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : studies.length === 0 ? (
          <p className="col-span-full text-sm text-muted-foreground">No studies yet.</p>
        ) : (
          studies.map((s) => (
            <Card
              key={s.id}
              role="button"
              tabIndex={0}
              aria-label={`Open study ${s.name}`}
              className={`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                selected?.id === s.id ? "border-primary" : "cursor-pointer"
              }`}
              onClick={() => openStudy(s)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                openStudy(s);
              }}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{s.name}</CardTitle>
                  <Badge variant={s.status === "open" ? "default" : "secondary"}>
                    {s.status}
                  </Badge>
                </div>
                <CardDescription>
                  ±{s.tolerance} • {s.counts?.items ?? 0} items • {s.counts?.reviewers ?? 0}{" "}
                  reviewers • {s.counts?.ratings ?? 0} ratings
                </CardDescription>
              </CardHeader>
            </Card>
          ))
        )}
      </div>

      {/* Selected study */}
      {selected && (
        <Card className="border-primary/40">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-lg">
                {selected.name}
                {selected.published_to_transparency && (
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300">
                    <ShieldCheck className="mr-1 h-3 w-3" /> Public
                  </Badge>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                {selected.status === "open" ? (
                  <Button variant="outline" size="sm" onClick={closeStudy}>
                    <Lock className="h-4 w-4" /> Close study
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={togglePublish}>
                    <ShieldCheck className="h-4 w-4" />
                    {selected.published_to_transparency
                      ? "Unpublish"
                      : "Publish to transparency"}
                  </Button>
                )}
              </div>
            </div>
            {selected.status === "closed" && !report?.sufficient_sample && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Sample is below the citable bar — the public page will keep its
                "baseline pending" state even if published.
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Report */}
            {report && (
              <div className="rounded-lg border bg-muted/30 p-4">
                <h3 className="mb-3 flex items-center gap-2 font-medium">
                  <ShieldCheck className="h-4 w-4" /> Reliability report
                </h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Metric label="Human agreement (within ±tol)" value={pct(report.human.agreement_within)} />
                  <Metric label="Human MAE" value={report.human.mae.toFixed(2)} />
                  <Metric
                    label="Krippendorff α"
                    value={report.krippendorff_alpha === null ? "—" : report.krippendorff_alpha.toFixed(3)}
                  />
                  <Metric label="Pairable items" value={`${report.pairable_item_count}/${report.item_count}`} />
                  <Metric label="Max raters/item" value={String(report.rater_count)} />
                  <Metric
                    label="Citable sample"
                    value={report.sufficient_sample ? "Yes" : "Not yet"}
                  />
                </div>

                {report.ai_vs_human && (
                  <div className="mt-4 rounded-md border bg-background p-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                      AI vs human consensus
                      {report.ai_vs_human.ai_meets_human ? (
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300">
                          <CheckCircle2 className="mr-1 h-3 w-3" /> AI meets/beats experts
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Below human baseline</Badge>
                      )}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Metric
                        label="AI agreement"
                        value={pct(report.ai_vs_human.ai_agreement_within)}
                        sub={`vs human ${pct(report.ai_vs_human.human_agreement_within)}`}
                      />
                      <Metric
                        label="AI MAE vs consensus"
                        value={report.ai_vs_human.ai_mae.toFixed(2)}
                        sub={`human-human ${report.ai_vs_human.human_mae.toFixed(2)}`}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Add submissions */}
            {selected.status === "open" && (
              <div>
                <Label htmlFor="add-ids">Add submissions (IDs, space/comma separated)</Label>
                <Textarea
                  id="add-ids"
                  value={addIds}
                  onChange={(e) => setAddIds(e.target.value)}
                  rows={2}
                  placeholder="uuid1 uuid2 …"
                />
                <Button className="mt-2" size="sm" onClick={addSubmissions} disabled={!addIds.trim()}>
                  Add to study
                </Button>
              </div>
            )}

            {/* My blind rating queue */}
            <div>
              <h3 className="mb-2 font-medium">
                My rating queue
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({queue.length} to grade — you won't see the AI grade)
                </span>
              </h3>
              <p className="mb-2 text-xs text-muted-foreground">
                QA access to customer photos is minimized (no owner identity,
                no seller text) and every photo view is audit-logged.
              </p>
              {queue.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing left for you to rate in this study.
                </p>
              ) : (
                <div className="space-y-2">
                  {queue.map((q) => {
                    const itemPhotos = photos[q.id];
                    return (
                    <div key={q.id} className="rounded-md border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {q.brand || q.garment_category || "Garment"}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {[q.brand, q.garment_type, q.garment_category]
                              .filter(Boolean)
                              .join(" • ") || q.id}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => togglePhotos(q.id)}
                            disabled={photosLoading === q.id}
                          >
                            {photosLoading === q.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <ImageIcon className="h-4 w-4" />
                            )}
                            {itemPhotos ? "Hide photos" : "View photos"}
                          </Button>
                          {selected.status === "open" && (
                            <>
                              <Input
                                className="w-24"
                                inputMode="decimal"
                                aria-label={`Blind grade 1 to 10 for ${q.brand || q.garment_category || "garment"}`}
                                placeholder="1–10"
                                value={scores[q.id] ?? ""}
                                onChange={(e) =>
                                  setScores((p) => ({ ...p, [q.id]: e.target.value }))
                                }
                              />
                              <Button size="sm" onClick={() => submitRating(q.id)}>
                              aria-label={`Save the grade for ${q.brand || q.garment_category || "garment"}`}
                                Save
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      {itemPhotos && (
                        itemPhotos.length === 0 ? (
                          <p className="mt-3 text-xs text-muted-foreground">
                            No photos on this submission.
                          </p>
                        ) : (
                          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {itemPhotos.map((p) =>
                              p.signed_url ? (
                                <figure key={p.id}>
                                  <img
                                    src={p.signed_url}
                                    alt={`${p.image_type} photo`}
                                    loading="lazy"
                                    decoding="async"
                                    className="aspect-square w-full rounded-md border object-cover"
                                  />
                                  <figcaption className="mt-1 text-center text-xs text-muted-foreground">
                                    {p.image_type}
                                  </figcaption>
                                </figure>
                              ) : null
                            )}
                          </div>
                        )
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
