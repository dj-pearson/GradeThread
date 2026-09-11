import { useGradeRanges } from "@/hooks/use-grade-ranges";
import { gradeRangeFor, type GradeRanges } from "@/lib/grade-range";

// US-3339: "Likely 7.3 to 7.9" under a grade, only when the grader's regrade
// spread has been measured for this category. Otherwise nothing.

export function GradeRangeNote({
  score,
  category,
}: {
  score: number;
  category: string | null | undefined;
}) {
  const { data } = useGradeRanges();
  return <GradeRangeNoteView score={score} category={category} ranges={data ?? null} />;
}

export function GradeRangeNoteView({
  score,
  category,
  ranges,
}: {
  score: number;
  category: string | null | undefined;
  ranges: GradeRanges | null;
}) {
  const range = gradeRangeFor(score, category, ranges);
  if (!range) return null;
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">
        Likely {range.low.toFixed(1)} to {range.high.toFixed(1)}
      </span>
      <span className="block text-xs">
        How far a regrade of the same photos can move, measured on {range.samples} regraded{" "}
        {(category ?? "").replace(/[-_]/g, " ")} items.
      </span>
    </p>
  );
}
