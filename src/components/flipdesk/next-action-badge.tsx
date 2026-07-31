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
}: {
  item: ItemListRow;
  className?: string;
}) {
  const action = nextAction(item);
  const Icon = ICONS[action.kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        TONE[action.tone],
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {action.label}
    </span>
  );
}
