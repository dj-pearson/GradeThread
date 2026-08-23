// US-1897 (AC2): the Listing Quality Score chip + breakdown.
//
// One 0–100 number per listing, and — the part that makes it useful rather than
// merely judgemental — the breakdown that names which fix earns the most points
// and where to go and make it.
//
// The score is computed server-side (services/edge-functions/src/lib/
// listing-quality-score.ts) and arrives on the /listings/validate response.
// NOTHING is recomputed here: the weights live in one place, and a client that
// re-derived them would drift from the number the server persists for sorting.

import { cn } from "@/lib/utils";

export type QualityComponentStatus = "ok" | "warn" | "fix" | "unknown";

export interface QualityComponent {
  key: string;
  label: string;
  weight: number;
  earned: number;
  status: QualityComponentStatus;
  detail: string;
  fixSurface: string;
  blocking?: boolean;
}

export interface ListingQualityScore {
  score: number;
  components: QualityComponent[];
  weightCounted: number;
  topFixes: { key: string; label: string; pointsAvailable: number; fixSurface: string }[];
  blocked: boolean;
  blockingReasons: string[];
}

/**
 * Colour band for the chip.
 *
 * `blocked` is its OWN band, not just "low". A blocked listing cannot go live at
 * all, and the server caps it at 40 so it sorts with the wreckage — showing it
 * in the same amber as a merely-weak listing would undo that on screen, which is
 * the exact confusion the cap exists to prevent.
 */
export function scoreBand(score: number, blocked: boolean): "blocked" | "good" | "fair" | "poor" {
  if (blocked) return "blocked";
  if (score >= 85) return "good";
  if (score >= 60) return "fair";
  return "poor";
}

const BAND_CLASS: Record<ReturnType<typeof scoreBand>, string> = {
  // Red, and it reads "Can't list" rather than a number — a blocked listing's
  // score is not the actionable fact about it.
  blocked: "bg-destructive/10 text-destructive border-destructive/30",
  good: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400",
  fair: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400",
  poor: "bg-orange-500/10 text-orange-700 border-orange-500/30 dark:text-orange-400",
};

const STATUS_DOT: Record<QualityComponentStatus, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  fix: "bg-destructive",
  // Grey, and deliberately not scored: an unreadable signal is excluded from the
  // maths server-side, so it must not look like a failure here either.
  unknown: "bg-muted-foreground/40",
};

/**
 * The chip needs only what is PERSISTED on the listing row (00476): the
 * sortable scalar and the blocked flag. The breakdown is recomputed on demand
 * and arrives with the full object, so a list surface can render chips from a
 * cheap column read without pulling a preflight per row.
 */
export type QualityScoreSummary = Pick<ListingQualityScore, "score" | "blocked"> & {
  blockingReasons?: string[];
};

export function QualityScoreChip({
  score,
  className,
}: {
  score: QualityScoreSummary | null | undefined;
  className?: string;
}) {
  // Never scored is not zero. A listing that has not been through preflight
  // shows an em dash, never a confident 0 that would sort it with the worst.
  if (!score) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
          "bg-muted/40 text-muted-foreground border-border",
          className,
        )}
        title="Not scored yet — run a publish check"
      >
        —
      </span>
    );
  }

  const band = scoreBand(score.score, score.blocked);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        BAND_CLASS[band],
        className,
      )}
      title={
        score.blocked
          ? `Can't be listed: ${score.blockingReasons?.[0] ?? "a publish blocker must be fixed"}`
          : `Listing quality ${score.score}/100`
      }
    >
      {score.blocked ? "Can't list" : score.score}
    </span>
  );
}

/**
 * The breakdown. Each row names the component, what it cost, and the surface
 * that fixes it (AC2: "each component links to its fix surface").
 *
 * `onFix` is optional so this renders standalone in tests and in read-only
 * contexts; when absent the surface is still NAMED, because telling a seller
 * what is wrong without telling them where to fix it is the failure mode this
 * whole story exists to remove.
 */
export function QualityScoreBreakdown({
  score,
  onFix,
  className,
}: {
  score: ListingQualityScore;
  onFix?: (fixSurface: string) => void;
  className?: string;
}) {
  // Destructured rather than indexed inline: noUncheckedIndexedAccess types
  // topFixes[0] as possibly-undefined, and an empty topFixes IS the normal state
  // for a perfect listing.
  const topFix = score.topFixes[0];
  return (
    <div className={cn("space-y-2", className)}>
      {score.blocked && (
        <p className="text-xs font-medium text-destructive">
          This listing can&rsquo;t go live yet: {score.blockingReasons[0]}
        </p>
      )}
      <ul className="space-y-1.5">
        {score.components.map((c) => (
          <li key={c.key} className="flex items-start gap-2 text-xs">
            <span
              aria-hidden="true"
              className={cn("mt-1 size-1.5 shrink-0 rounded-full", STATUS_DOT[c.status])}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{c.label}</span>{" "}
              <span className="text-muted-foreground">
                {c.status === "unknown"
                  ? "not checked"
                  : `${Math.round(c.earned)}/${c.weight}`}
              </span>
              <span className="block text-muted-foreground">{c.detail}</span>
            </span>
            {onFix && c.status !== "ok" && c.status !== "unknown" && (
              <button
                type="button"
                onClick={() => onFix(c.fixSurface)}
                aria-label={`Fix: ${c.label}`}
                className="shrink-0 text-primary underline-offset-2 hover:underline"
              >
                Fix
              </button>
            )}
          </li>
        ))}
      </ul>
      {topFix && (
        <p className="text-xs text-muted-foreground">
          Biggest win: <span className="font-medium">{topFix.label}</span> (+
          {topFix.pointsAvailable} pts)
        </p>
      )}
      {score.weightCounted < 100 && (
        // Honesty about partial information — the seller should know the number
        // was scaled over what we could actually read, not silently penalised.
        <p className="text-[11px] text-muted-foreground">
          Scored on {score.weightCounted} of 100 points; the rest couldn&rsquo;t be checked.
        </p>
      )}
    </div>
  );
}
