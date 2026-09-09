import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { countFilled, fillLabel } from "@/lib/section-completeness";

export interface SectionFillBadgeProps {
  /** The values the section actually renders, in render order. */
  values: readonly unknown[];
  className?: string;
}

/**
 * US-3202: "6 of 8" on a section header.
 *
 * The denominator comes from `values.length`, never a literal — a hardcoded
 * count is correct on the day it is typed and silently wrong the first time
 * someone adds an input to the card.
 *
 * A complete section goes quiet (muted, no colour). The badge exists to point
 * at unfinished work, and a row of green ticks is decoration that trains the
 * eye to skip the one that matters.
 */
export function SectionFillBadge({ values, className }: SectionFillBadgeProps) {
  const fill = countFilled(values);
  if (fill.total === 0) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 text-[10px] font-medium tabular-nums",
        fill.complete ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      {fillLabel(fill)} filled
    </Badge>
  );
}
