import { useRef, type KeyboardEvent } from "react";
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
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // One view is not a choice. A buyer account has only the grading board, and
  // a segmented control with a single permanently-pressed segment is furniture.
  if (views.length < 2) return null;

  // The radio-group keyboard contract: one tab stop (the checked radio), and
  // the arrow keys move focus AND selection, wrapping; Home and End jump.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = views.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = index === last ? 0 : index + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = index === 0 ? last : index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    }
    if (next == null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(views[next]!.id);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Overview view"
      className={cn(
        // Full width with two equal 44px segments on a phone; a compact pill
        // from sm up.
        "grid w-full grid-cols-2 items-center gap-0.5 rounded-xl bg-muted/60 p-1 sm:flex sm:w-fit",
        className,
      )}
    >
      {views.map((view, index) => {
        const checked = value === view.id;
        return (
          <button
            key={view.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(view.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "min-h-11 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-0",
              checked
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {view.label}
          </button>
        );
      })}
    </div>
  );
}
