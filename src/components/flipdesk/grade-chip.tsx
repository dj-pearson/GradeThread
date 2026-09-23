import { BadgeCheck } from "lucide-react";
import { tierBandForScore } from "@/lib/constants";
import { safeHref } from "@/lib/safe-url";
import { cn } from "@/lib/utils";

// INV-14: the GradeThread grade as a first-class chip on an inventory row.
//
// It used to be a gray "8.5" with a tooltip. The grade is what no crosslister
// has, so the row says which tier it is (tinted by tier, from the published
// scale in constants.ts) and, when a certificate exists, links to it with a
// seal so a seller can hand a buyer the proof in one click.

type TierName = ReturnType<typeof tierBandForScore>["tier"];

/** Tint per published tier. Text is tinted from the surface hue, not gray. */
const TIER_TONE: Record<TierName, string> = {
  NWT: "border-emerald-500/40 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  NWOT: "border-emerald-500/40 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  Excellent: "border-teal-500/40 bg-teal-50 text-teal-800 dark:bg-teal-950/40 dark:text-teal-300",
  "Very Good": "border-sky-500/40 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  Good: "border-slate-400/50 bg-slate-50 text-slate-800 dark:bg-slate-900/60 dark:text-slate-200",
  Fair: "border-amber-500/40 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  Poor: "border-rose-500/40 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
};

/** The tier name for a grade, from the published scale. */
function gradeTierName(grade: number): TierName {
  return tierBandForScore(grade).tier;
}

export function GradeChip({
  grade,
  certificateUrl,
  className,
}: {
  grade: number;
  certificateUrl?: string | null;
  className?: string;
}) {
  const tier = gradeTierName(grade);
  const href = safeHref(certificateUrl);
  const text = `${grade.toFixed(1)} ${tier}`;
  const chipClass = cn(
    "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0 text-[11px] font-medium tabular-nums",
    TIER_TONE[tier],
    className,
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cn(chipClass, "hover:underline")}
        title={`Graded ${tier}. Open the certificate.`}
        aria-label={`Grade ${text}, open the certificate`}
      >
        <BadgeCheck className="h-3 w-3" aria-hidden="true" />
        {text}
      </a>
    );
  }
  return (
    <span className={chipClass} title={`Graded ${tier}`}>
      {text}
    </span>
  );
}
