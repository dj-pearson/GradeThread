import { useMemo } from "react";
import { TrendingUp, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ValueBasisNote } from "@/components/value/value-basis-note";
import {
  curveMedianAtGrade,
  formatCurveCents,
  matchConditionIndexEntry,
  useConditionIndexCurve,
  useConditionIndexHub,
} from "@/hooks/use-condition-index";

// US-848: grade-anchored value hint sourced from the public Condition Index
// curve. Shown in the listing composer and on item detail when an item matches
// a curated Index entry (by brand + category). Deep-links to the public
// /condition-index/<slug> authority page. Renders nothing when there's no
// matching curve — no errors, no fabricated value.

interface ConditionIndexValueHintProps {
  brand: string | null | undefined;
  category: string | null | undefined;
  title: string | null | undefined;
  grade: number | null | undefined;
  className?: string;
}

export function ConditionIndexValueHint({
  brand,
  category,
  title,
  grade,
  className,
}: ConditionIndexValueHintProps) {
  const { data: hub } = useConditionIndexHub();

  const match = useMemo(
    () => (hub ? matchConditionIndexEntry(hub, { brand, category, title }) : null),
    [hub, brand, category, title],
  );

  const { data: curve } = useConditionIndexCurve(match?.slug);

  const point = useMemo(
    () => (curve ? curveMedianAtGrade(curve.points, grade) : null),
    [curve, grade],
  );

  // Need a brand-matched curve, a real grade, and a real median to say anything.
  if (!match || !curve || grade == null || !point || point.medianCents == null) {
    return null;
  }

  const median = formatCurveCents(point.medianCents, curve.currency);

  return (
    <a
      href={`/condition-index/${curve.slug}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group block rounded-md border border-brand-navy/30 bg-brand-navy/5 px-3 py-2 text-xs transition-colors hover:bg-brand-navy/10",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 shrink-0 text-brand-navy dark:text-foreground" />
        <span className="text-foreground">
          Your grade {grade.toFixed(1)} maps to{" "}
          <span className="font-semibold tabular-nums">~{median}</span> median for{" "}
          <span className="font-medium">{curve.label}</span>.
        </span>
      </div>
      {/* US-2850: the hint quotes a median next to the seller's own grade, which
          is exactly where the two get confused. One line saying what the median
          is keeps them apart. */}
      <ValueBasisNote basis={curve.disclosure} variant="short" className="mt-1 pl-6 text-[11px]" />
      <div className="mt-0.5 flex items-center gap-1 pl-6 text-[11px] text-muted-foreground group-hover:text-foreground">
        See the {curve.label} Condition Index
        <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
      </div>
    </a>
  );
}
