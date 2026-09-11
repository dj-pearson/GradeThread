import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, ImageOff } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { edgeFetch } from "@/lib/edge-fetch";
import { GARMENT_CATEGORIES, GRADE_FACTORS, type GradeFactorKey } from "@/lib/constants";

// US-3334: the reference gallery. An admin awards a photo from a finalized
// grade as the example of a grade level ("this is what a 7 looks like" for
// jeans), per category and optionally per factor. The server decides which
// photos qualify (staff-owned, or the owner opted into model refinement) and
// asks for step-up on award and revoke; this card only shows what it says.

interface ReferenceAward {
  id: string;
  submission_image_id: string;
  grade_report_id: string | null;
  garment_category: string;
  factor: GradeFactorKey | null;
  awarded_score: number;
  note: string | null;
  created_at: string;
  image_type: string | null;
  url: string | null;
  still_eligible: boolean;
}

interface Candidates {
  refusal: string | null;
  garment_category: string | null;
  overall_score: number | null;
  photos: Array<{ id: string; image_type: string; url: string | null }>;
}

const ALL = "all";
const WHOLE = "whole";
const QUERY_KEY = ["admin-grading-reference-gallery"];

function factorLabel(factor: GradeFactorKey | null): string {
  return factor ? GRADE_FACTORS[factor].label : "Whole grade";
}

async function readJson<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  return json as T;
}

export function ReferenceGalleryCard() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [category, setCategory] = useState<string>(ALL);
  const [factorFilter, setFactorFilter] = useState<string>(ALL);

  const [reportId, setReportId] = useState("");
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [pickedImage, setPickedImage] = useState<string | null>(null);
  const [score, setScore] = useState("");
  const [awardFactor, setAwardFactor] = useState<string>(WHOLE);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: [...QUERY_KEY, category, factorFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (category !== ALL) params.set("category", category);
      if (factorFilter !== ALL) params.set("factor", factorFilter);
      const res = await edgeFetch(`/api/admin/grading/reference-photos?${params}`);
      return (await readJson<{ awards: ReferenceAward[] }>(res)).awards;
    },
    // Signed URLs last 15 minutes; refetch well inside that.
    staleTime: 5 * 60 * 1000,
  });

  const awards = data ?? [];

  async function loadCandidates() {
    const id = reportId.trim();
    if (!id) return;
    setLoadingCandidates(true);
    setCandidates(null);
    setPickedImage(null);
    try {
      const res = await edgeFetch(
        `/api/admin/grading/reference-photos/candidates/${encodeURIComponent(id)}`,
      );
      const result = await readJson<Candidates>(res);
      setCandidates(result);
      if (result.overall_score !== null) setScore(String(result.overall_score));
    } catch (err) {
      toast.error("Couldn't load that grade", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function award() {
    if (!pickedImage) return;
    setBusy(true);
    try {
      const res = await edgeFetch("/api/admin/grading/reference-photos", {
        method: "POST",
        body: JSON.stringify({
          submission_image_id: pickedImage,
          awarded_score: Number(score),
          factor: awardFactor === WHOLE ? null : awardFactor,
          note: note.trim() || null,
        }),
      });
      const json = await readJson<{ awarded_score: number }>(res);
      toast.success(`Awarded as a ${json.awarded_score.toFixed(1)}`);
      setPickedImage(null);
      setNote("");
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    } catch (err) {
      toast.error("Couldn't award", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(a: ReferenceAward) {
    const ok = await confirm({
      title: "Stop using this reference?",
      description:
        "The photo leaves the gallery and will not be shown to the grader. The record of the award is kept.",
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    try {
      await readJson(
        await edgeFetch(`/api/admin/grading/reference-photos/${a.id}/revoke`, { method: "POST" }),
      );
      toast.success("Reference revoked");
    } catch (err) {
      toast.error("Couldn't revoke", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }
  }

  const scoreValue = Number(score);
  const scoreValid = score.trim() !== "" && Number.isFinite(scoreValue) && scoreValue >= 1 &&
    scoreValue <= 10;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <Award className="h-4 w-4" />
          Reference gallery
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Photos that show what a grade level looks like. Only photos from finalized grades
          qualify, and only when the owner is staff or opted into model refinement.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3" aria-labelledby="reference-award-heading">
          <h3 id="reference-award-heading" className="text-sm font-medium">Award a photo</h3>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[16rem] flex-1 space-y-1">
              <Label htmlFor="reference-report-id">Grade report id</Label>
              <Input
                id="reference-report-id"
                value={reportId}
                onChange={(e) => setReportId(e.target.value)}
                placeholder="From the review queue or a submission"
              />
            </div>
            <Button
              variant="outline"
              onClick={loadCandidates}
              disabled={loadingCandidates || reportId.trim() === ""}
            >
              {loadingCandidates ? "Loading..." : "Load photos"}
            </Button>
          </div>

          {candidates?.refusal && (
            <p className="text-sm text-destructive">{candidates.refusal}</p>
          )}
          {candidates && !candidates.refusal && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {candidates.garment_category ?? "Unknown category"}
                {candidates.overall_score !== null &&
                  `, graded ${candidates.overall_score.toFixed(1)}`}. Pick one photo.
              </p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
                {candidates.photos.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPickedImage(p.id)}
                    aria-pressed={pickedImage === p.id}
                    aria-label={`Pick the ${p.image_type} photo`}
                    className={`overflow-hidden rounded-md ring-offset-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      pickedImage === p.id ? "ring-2 ring-primary" : ""
                    }`}
                  >
                    {p.url
                      ? <img src={p.url} alt="" className="aspect-square w-full object-cover" />
                      : (
                        <span className="flex aspect-square w-full items-center justify-center bg-muted">
                          <ImageOff className="h-5 w-5 text-muted-foreground" />
                        </span>
                      )}
                    <span className="block truncate px-1 py-0.5 text-xs">{p.image_type}</span>
                  </button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="reference-score">Awarded value</Label>
                  <Input
                    id="reference-score"
                    type="number"
                    min={1}
                    max={10}
                    step={awardFactor === WHOLE ? 0.1 : 0.5}
                    value={score}
                    onChange={(e) => setScore(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reference-factor">Shows</Label>
                  <Select value={awardFactor} onValueChange={setAwardFactor}>
                    <SelectTrigger id="reference-factor">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={WHOLE}>Whole grade</SelectItem>
                      {(Object.keys(GRADE_FACTORS) as GradeFactorKey[]).map((k) => (
                        <SelectItem key={k} value={k}>{GRADE_FACTORS[k].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 sm:col-span-3">
                  <Label htmlFor="reference-note">Why this photo (optional)</Label>
                  <Textarea
                    id="reference-note"
                    value={note}
                    maxLength={500}
                    rows={2}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </div>
              <Button onClick={award} disabled={busy || !pickedImage || !scoreValid}>
                Award photo
              </Button>
            </div>
          )}
        </section>

        <section className="space-y-3" aria-labelledby="reference-browse-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="reference-browse-heading" className="text-sm font-medium">Awarded photos</h3>
            <div className="flex flex-wrap gap-2">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="w-40" aria-label="Filter by category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All categories</SelectItem>
                  {GARMENT_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={factorFilter} onValueChange={setFactorFilter}>
                <SelectTrigger className="w-48" aria-label="Filter by factor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any factor</SelectItem>
                  {(Object.keys(GRADE_FACTORS) as GradeFactorKey[]).map((k) => (
                    <SelectItem key={k} value={k}>{GRADE_FACTORS[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : error ? (
            <p className="text-sm text-destructive">Couldn't load the gallery.</p>
          ) : awards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No awarded photos yet. Load a finalized grade above and award one.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {awards.map((a) => (
                <li key={a.id} className="space-y-1">
                  {a.url
                    ? (
                      <img
                        src={a.url}
                        alt={`${a.garment_category}, ${factorLabel(a.factor)}, ${a.awarded_score.toFixed(1)}`}
                        className="aspect-square w-full rounded-md object-cover"
                      />
                    )
                    : (
                      <span className="flex aspect-square w-full items-center justify-center rounded-md bg-muted">
                        <ImageOff className="h-5 w-5 text-muted-foreground" />
                      </span>
                    )}
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-semibold tabular-nums">
                      {a.awarded_score.toFixed(1)}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => revoke(a)}>Revoke</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {a.garment_category}, {factorLabel(a.factor)}
                  </p>
                  {!a.still_eligible && (
                    <Badge variant="destructive">Consent withdrawn</Badge>
                  )}
                  {a.note && <p className="line-clamp-2 text-xs">{a.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
