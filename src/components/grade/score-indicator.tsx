import { AlertTriangle, CheckCircle2, MinusCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// US-454 (WCAG 1.4.1): condition grades must never rely on color alone. Grade
// numerals are color-coded by quality band (green / amber / red); on their own
// the band is invisible to color-blind users. `ScoreIndicator` pairs each
// numeral with a distinctly-shaped icon (check circle / minus circle / warning
// triangle) plus an sr-only band label, so the tier reads without color.

type ScoreBand = "high" | "mid" | "low";

function scoreBand(score: number): ScoreBand {
  if (score > 7) return "high";
  if (score >= 5) return "mid";
  return "low";
}

const BAND_META: Record<ScoreBand, { Icon: LucideIcon; label: string }> = {
  high: { Icon: CheckCircle2, label: "Strong condition" },
  mid: { Icon: MinusCircle, label: "Moderate condition" },
  low: { Icon: AlertTriangle, label: "Low condition" },
};

// The shape-only indicator: a band icon (aria-hidden) plus an sr-only label.
// Size tracks the surrounding font via `1em` so it lines up with the numeral.
export function ScoreBandIcon({
  score,
  className,
  withLabel = true,
}: {
  score: number;
  className?: string;
  withLabel?: boolean;
}) {
  const { Icon, label } = BAND_META[scoreBand(score)];
  return (
    <>
      <Icon
        aria-hidden="true"
        className={cn("inline h-[1em] w-[1em] flex-shrink-0", className)}
      />
      {withLabel && <span className="sr-only">{label}</span>}
    </>
  );
}
