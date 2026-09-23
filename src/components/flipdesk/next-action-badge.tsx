import {
  Ruler,
  Camera,
  Tag,
  FileText,
  Rocket,
  Truck,
  PackageCheck,
  CircleCheck,
  RotateCcw,
  Clock,
  Award,
  Hourglass,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { nextAction, type NextActionKind } from "@/lib/workflow";
import type { ItemListRow } from "@/lib/item-list-columns";

const ICONS: Record<NextActionKind, typeof Ruler> = {
  measure: Ruler,
  photograph: Camera,
  grade: Award,
  grading: Hourglass,
  review_grade: Sparkles,
  comp: Tag,
  draft: FileText,
  list: Rocket,
  sell: Clock,
  ship: Truck,
  complete: PackageCheck,
  relist: RotateCcw,
  done: CircleCheck,
  none: Clock,
};

const TONE: Record<string, string> = {
  todo: "border-amber-400/50 bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  ready:
    "border-emerald-400/50 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  done: "border-muted bg-muted text-muted-foreground",
  muted: "border-transparent bg-transparent text-muted-foreground",
};

export function NextActionBadge({
  item,
  className,
  onActivate,
  label,
}: {
  item: ItemListRow;
  className?: string;
  /**
   * INV-14: when set, the badge is a button that takes the seller to the step.
   * Receives the action kind so the caller can route it.
   */
  onActivate?: (kind: NextActionKind) => void;
  /** Accessible name for the button form; names the row. */
  label?: string;
}) {
  const action = nextAction(item);
  const Icon = ICONS[action.kind];
  const cls = cn(
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
    TONE[action.tone],
    className,
  );
  if (onActivate) {
    return (
      <button
        type="button"
        className={cn(cls, "hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        onClick={(e) => {
          e.stopPropagation();
          onActivate(action.kind);
        }}
        aria-label={label ? `${action.label}: ${label}` : action.label}
      >
        <Icon className="h-3 w-3" />
        {action.label}
      </button>
    );
  }
  return (
    <span className={cls}>
      <Icon className="h-3 w-3" />
      {action.label}
    </span>
  );
}
