import { cn } from "@/lib/utils";
import type { OverviewViewDef, OverviewViewId } from "@/lib/overview-view";

// US-3469: the control that picks which half of the Overview you are reading.
//
// A segmented control rather than a dropdown: there are two options, both are
// worth naming on screen, and the one you are on should be visible without
// opening anything. It is NOT react-router <NavLink>s -- the two views are one
// route with one `?view=` param, so a link would be a navigation where a
// setState is the truth.
//
// Rendered as a real radio group rather than as tabs. There is no tabpanel:
// the board below is the same component with a different surface, and
// announcing a tabpanel that never exists is worse than announcing nothing.

export function OverviewViewSwitcher({
  views,
  value,
  onChange,
  className,
}: {
  views: readonly OverviewViewDef[];
  value: OverviewViewId;
  onChange: (next: OverviewViewId) => void;
  className?: string;
}) {
  // One view is not a choice. A buyer account has only the grading board, and
  // a segmented control with a single permanently-pressed segment is furniture.
  if (views.length < 2) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Overview view"
      className={cn(
        "flex w-fit items-center gap-0.5 rounded-xl bg-muted/60 p-1",
        className,
      )}
    >
      {views.map((view) => (
        <button
          key={view.id}
          type="button"
          role="radio"
          aria-checked={value === view.id}
          onClick={() => onChange(view.id)}
          className={cn(
            "rounded-lg px-4 py-1.5 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            value === view.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}
