import { useMemo } from "react";
import { CircleCheck, ScanLine } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  inspectionTemplate,
  COVERAGE_GUARANTEE_FLOOR,
  type CoverageResult,
} from "@/lib/coverage";

// Natural-language list: ["a"] → "a"; ["a","b"] → "a and b";
// ["a","b","c"] → "a, b, and c".
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * US-1277: live photo-coverage meter for the submission flow. Renders the
 * percentage of the garment's standard inspection zones documented so far and a
 * specific nudge naming the still-missing zones, so sellers are motivated to
 * submit complete coverage (better grade + wider guarantee scope). All zone
 * scoring comes from the shared engine (`coverage`) — this component only
 * presents its output.
 */
export function CoverageMeter({
  coverage,
  className,
}: {
  coverage: CoverageResult;
  className?: string;
}) {
  // Friendly zone labels come from the same engine template (id → label), so the
  // nudge never invents copy or duplicates the zone catalog.
  const missingLabels = useMemo(() => {
    const labelById = new Map(
      inspectionTemplate(coverage.garment_category).map((z) => [z.id, z.label]),
    );
    return coverage.missing_zones.map((id) => labelById.get(id) ?? id);
  }, [coverage.garment_category, coverage.missing_zones]);

  const pct = coverage.coverage_pct;
  const complete = coverage.missing_zones.length === 0;
  const belowFloor = pct < COVERAGE_GUARANTEE_FLOOR;

  return (
    <div
      className={cn(
        "rounded-lg border p-4",
        complete
          ? "border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-950/20"
          : "border-border bg-muted/40",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {complete ? (
            <CircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <ScanLine className="h-4 w-4 text-brand-navy dark:text-foreground" />
          )}
          Photo coverage
        </p>
        <span
          className={cn(
            "text-sm font-semibold tabular-nums",
            complete
              ? "text-emerald-600 dark:text-emerald-400"
              : belowFloor
                ? "text-amber-600 dark:text-amber-400"
                : "text-foreground",
          )}
        >
          {pct}%
        </span>
      </div>

      <Progress
        value={pct}
        className={cn(
          "mt-3",
          complete && "[&>[data-slot=progress-indicator]]:bg-emerald-500",
        )}
      />

      <p className="mt-2 text-xs text-muted-foreground">
        {coverage.covered_zones.length} of {coverage.applicable_zones.length}{" "}
        inspection zone
        {coverage.applicable_zones.length === 1 ? "" : "s"} documented.
      </p>

      {complete ? (
        <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          Full coverage — every inspection zone is documented. This earns the
          most accurate grade and the widest guarantee.
        </p>
      ) : (
        <p className="mt-2 text-xs text-foreground/90">
          Add {formatList(missingLabels)} to reach 100% coverage — more coverage
          means a more accurate grade and a wider guarantee.
        </p>
      )}
    </div>
  );
}
