import { useEffect, useState } from "react";
import { Link2, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1099: relist detection (Garment Passport, Layer 3).
//
// When a seller drafts a listing whose PHOTOS visually match a garment we've
// already graded (a very common reseller pattern — re-using the original
// photos), we SUGGEST continuing the existing passport chain rather than
// starting a fresh history. This is suggestion-only: we never auto-link. The
// seller reviews the matched passport and, if it's the same garment, continues
// the chain via the claim handoff (US-1094). A probable match is exactly that —
// probable — so the copy stays tentative and the chain stays opt-in.

interface RelistCandidate {
  garmentId: string;
  slug: string | null;
  similarity: number;
  matchedPhotos: number;
  confidence: "probable";
  score: number;
}

interface RelistSuggestionCardProps {
  /** The inventory item being listed (its photos are hashed + matched). */
  itemId: string;
}

export function RelistSuggestionCard({ itemId }: RelistSuggestionCardProps) {
  const [candidates, setCandidates] = useState<RelistCandidate[] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    // Detection is best-effort + background — a failure simply renders nothing.
    edgeFetch("/api/passport/garments/detect-relist", {
      method: "POST",
      json: { item_id: itemId },
      silentGate: true,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { candidates?: RelistCandidate[] } | null) => {
        if (active && data?.candidates) setCandidates(data.candidates);
      })
      .catch(() => {
        /* best-effort — no suggestion on error */
      });
    return () => {
      active = false;
    };
  }, [itemId]);

  if (dismissed || !candidates || candidates.length === 0) return null;

  const top = candidates[0];
  if (!top) return null;

  return (
    <Card className="border-brand-navy/30 bg-brand-navy/5">
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start">
        <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-navy" />
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <p className="font-medium text-foreground">
              Link to an existing Garment Passport?
            </p>
            <Badge variant="outline" className="font-normal">
              Probable match
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            These photos look like a garment you've already graded
            {candidates.length > 1 ? ` (${candidates.length} possible matches)` : ""}. If
            it's the same item, continue its passport chain instead of starting a new
            history — buyers see the full condition &amp; ownership timeline. We never
            link automatically; review and confirm it's the same garment first.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {top.slug && (
              <Button asChild variant="outline" size="sm">
                <a
                  href={`/passport/${top.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View its passport
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {Math.round(top.similarity * 100)}% photo similarity ·{" "}
              {top.matchedPhotos} matched photo
              {top.matchedPhotos === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label="Dismiss relist suggestion"
          onClick={() => setDismissed(true)}
        >
          <X className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
