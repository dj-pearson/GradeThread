import { ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useBuyerTrustScore } from "@/hooks/use-buyer-trust-score";
import {
  levelBadgeClass,
  nextReputationLevel,
  perkHighlights,
  reputationLevelMeta,
} from "@/lib/reputation-perks";

// US-1817: the buyer's Trust Score at a glance — named level + badge, score,
// progress to the next level, and the perks this level unlocks. Reads the
// derived score (US-1816); everything else resolves from the shared perk matrix
// so what's shown here can't drift from what features actually grant.

export function TrustLevelCard() {
  const { score, level, isLoading } = useBuyerTrustScore();
  if (isLoading) return null;

  const meta = reputationLevelMeta(level);
  const next = nextReputationLevel(score, level);
  const perks = perkHighlights(level);

  // Progress within the current band toward the next threshold.
  const progressPct = next
    ? Math.min(100, Math.round(((score - meta.minScore) / (next.level.minScore - meta.minScore)) * 100))
    : 100;

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h3 className="font-semibold">Your Trust Score</h3>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium",
            levelBadgeClass(level),
          )}
        >
          {meta.name}
        </span>
      </div>

      <div className="flex items-end gap-2">
        <span className="text-3xl font-bold tabular-nums">{score}</span>
        <span className="pb-1 text-xs text-muted-foreground">
          {next ? `${next.pointsAway} to ${next.level.name}` : "Top level reached"}
        </span>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
      </div>

      {perks.length > 0 ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {perks.map((p) => (
            <li key={p} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {p}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Confirm arrival condition on your graded purchases to start earning reputation and unlock perks.
        </p>
      )}
    </Card>
  );
}
