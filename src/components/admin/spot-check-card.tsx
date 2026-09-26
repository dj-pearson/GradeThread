import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ReviewPhotos } from "@/components/admin/review-photos";
import { GRADE_FACTORS } from "@/lib/constants";
import { edgeFetch } from "@/lib/edge-fetch";

// US-3524: blind spot checks. A small share of auto-approved grades is sampled
// for a human to score from the photos alone. The list never carries the AI's
// grade; it is shown only after the blind score is saved, so the number the
// reviewer gives is not anchored to the one the AI gave.

interface SpotCheckImage {
  id: string;
  image_type: string;
  signed_url: string | null;
}

export interface SpotCheckItem {
  report_id: string;
  requested_at: string;
  submission: {
    title?: string | null;
    brand?: string | null;
    garment_type?: string | null;
    garment_category?: string | null;
  } | null;
  images: SpotCheckImage[];
}

export interface SpotCheckReveal {
  blind_overall: number;
  blind_tier: string;
  ai_overall: number;
  ai_tier: string;
  difference: number;
}

const FACTOR_KEYS = [
  "fabric_condition_score",
  "structural_integrity_score",
  "cosmetic_appearance_score",
  "functional_elements_score",
  "odor_cleanliness_score",
] as const;
type FactorKey = (typeof FACTOR_KEYS)[number];

const FACTOR_LABELS: Record<FactorKey, string> = {
  fabric_condition_score: GRADE_FACTORS.fabric_condition.label,
  structural_integrity_score: GRADE_FACTORS.structural_integrity.label,
  cosmetic_appearance_score: GRADE_FACTORS.cosmetic_appearance.label,
  functional_elements_score: GRADE_FACTORS.functional_elements.label,
  odor_cleanliness_score: GRADE_FACTORS.odor_cleanliness.label,
};

const EMPTY: Record<FactorKey, string> = {
  fabric_condition_score: "",
  structural_integrity_score: "",
  cosmetic_appearance_score: "",
  functional_elements_score: "",
  odor_cleanliness_score: "",
};

const QUERY_KEY = ["admin-grading-spot-checks"];

/** A factor score is 1.0 to 10.0 in half steps. */
function validFactor(v: string): boolean {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n >= 1 && n <= 10 && Math.round(n * 2) === n * 2;
}

export function SpotCheckCard() {
  const queryClient = useQueryClient();
  const [scores, setScores] = useState<Record<FactorKey, string>>(EMPTY);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<SpotCheckReveal | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/grading/spot-checks");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't load spot checks");
      return (json.data ?? []) as SpotCheckItem[];
    },
  });

  const items = data ?? [];
  const current = items[0];
  const ready = FACTOR_KEYS.every((k) => validFactor(scores[k]));

  async function submit() {
    if (!current || !ready) return;
    setBusy(true);
    try {
      const factors = Object.fromEntries(FACTOR_KEYS.map((k) => [k, Number(scores[k])]));
      const res = await edgeFetch(`/api/admin/grading/spot-checks/${current.report_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factors, notes }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't save the spot check");
      setReveal(json as SpotCheckReveal);
      setScores(EMPTY);
      setNotes("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the spot check");
    } finally {
      setBusy(false);
    }
  }

  function next() {
    setReveal(null);
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <EyeOff className="h-4 w-4" />
          Blind spot checks
          <Badge variant="secondary">{items.length}</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Grades the AI approved on its own. Score from the photos; the AI's grade shows after you save.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : reveal ? (
          <div className="space-y-3" data-testid="spot-check-reveal">
            <p className="text-sm">
              You gave <strong>{reveal.blind_overall.toFixed(1)}</strong> ({reveal.blind_tier}). The AI gave{" "}
              <strong>{reveal.ai_overall.toFixed(1)}</strong> ({reveal.ai_tier}).
            </p>
            <p className="text-sm text-muted-foreground">
              {Math.abs(reveal.difference) >= 1
                ? `A ${Math.abs(reveal.difference).toFixed(1)} point gap. Consider a regrade from the review tools.`
                : `Within ${Math.abs(reveal.difference).toFixed(1)} of each other.`}
            </p>
            <Button onClick={next}>Next</Button>
          </div>
        ) : !current ? (
          <p className="text-sm text-muted-foreground">No spot checks waiting.</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm font-medium">
              {[current.submission?.brand, current.submission?.title].filter(Boolean).join(" ") || "Untitled"}
              <span className="ml-2 text-muted-foreground">
                {[current.submission?.garment_type, current.submission?.garment_category].filter(Boolean).join(" / ")}
              </span>
            </p>
            <ReviewPhotos images={current.images} />
            <div className="grid gap-3 sm:grid-cols-5">
              {FACTOR_KEYS.map((k) => (
                <div key={k} className="space-y-1">
                  <Label htmlFor={`spot-${k}`}>{FACTOR_LABELS[k]}</Label>
                  <Input
                    id={`spot-${k}`}
                    inputMode="decimal"
                    placeholder="1-10"
                    value={scores[k]}
                    onChange={(e) => setScores((s) => ({ ...s, [k]: e.target.value }))}
                    aria-invalid={scores[k] !== "" && !validFactor(scores[k])}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <Label htmlFor="spot-notes">Notes (optional)</Label>
              <Textarea id="spot-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
            <Button onClick={submit} disabled={!ready || busy}>
              {busy ? "Saving..." : "Save blind score"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
