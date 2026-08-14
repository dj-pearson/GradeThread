import { Link } from "react-router";
import { cn } from "@/lib/utils";

// US-2520: a batch in flight lived at three unrelated URLs. You generated at
// /autolister, landed on /autolister/queue?batch=…, and the only way to reach
// /autolister/bulk-edit?batch=… was a button that happened to be on the queue —
// with nothing anywhere saying which batch you were looking at or how to get
// back. Same batch, three screens, one nav.

export type BatchStep = "generate" | "queue" | "bulk-edit";

const STEPS: { id: BatchStep; label: string; path: string }[] = [
  { id: "generate", label: "Generate", path: "/dashboard/flipdesk/autolister" },
  { id: "queue", label: "Queue", path: "/dashboard/flipdesk/autolister/queue" },
  {
    id: "bulk-edit",
    label: "Bulk edit",
    path: "/dashboard/flipdesk/autolister/bulk-edit",
  },
];

export function BatchNav({
  batchId,
  current,
  className,
}: {
  /** Null on a fresh Generate session — there is no batch to navigate yet. */
  batchId: string | null;
  current: BatchStep;
  className?: string;
}) {
  if (!batchId) return null;
  return (
    <nav
      aria-label="Batch steps"
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-lg border p-1 text-sm",
        className,
      )}
    >
      {STEPS.map((step) => {
        const active = step.id === current;
        // Every link carries the batch, Generate included. Generate is a fresh
        // staging session and ignores the parameter for its own data — it just
        // keeps the nav on screen, so stepping back to stage more photos does
        // not strand the batch that is already running.
        const to = `${step.path}?batch=${batchId}`;
        return (
          <Link
            key={step.id}
            to={to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {step.label}
          </Link>
        );
      })}
      <span className="ml-auto pr-2 font-mono text-xs text-muted-foreground">
        Batch {batchId.slice(0, 8)}
      </span>
    </nav>
  );
}
