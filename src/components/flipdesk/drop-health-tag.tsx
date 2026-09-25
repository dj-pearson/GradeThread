import { AlertTriangle, Ban, Loader2, RotateCw } from "lucide-react";
import { DROP_HEALTH_LABEL, type DropHealth } from "@/lib/scheduling";
import { cn } from "@/lib/utils";

// SD-4: a drop's publish state as an icon plus a word, so it never rests on
// color alone. A plain scheduled drop renders nothing.

const ICONS = {
  publishing: Loader2,
  retrying: RotateCw,
  overdue: AlertTriangle,
  blocked: Ban,
} as const;

export function DropHealthTag({
  health,
  className,
}: {
  health: DropHealth;
  className?: string;
}) {
  if (health === "scheduled") return null;
  const Icon = ICONS[health];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 font-semibold",
        health === "publishing" ? "text-brand-navy dark:text-blue-300" : "text-brand-red-text",
        className,
      )}
    >
      <Icon
        className={cn("h-3 w-3", health === "publishing" && "animate-spin")}
        aria-hidden="true"
      />
      {DROP_HEALTH_LABEL[health]}
    </span>
  );
}
