import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// US-3381 AC2. US-3376 made the queue's three per-batch read hooks throw on a
// refusal instead of caching an empty map as success. That was the right half
// of the fix: the queue still rendered `= {}` for each of them, so a refused
// read painted blank titles, blank thumbnails and an empty review column ONCE
// before TanStack retried, and nothing on screen said the columns were missing
// rather than empty. A retrying blank column still reads as an answer.
//
// This is deliberately NOT <ErrorState>: the batch itself loaded, the rows are
// real and the seller can still publish. Only some COLUMNS are missing, so the
// page says which ones and offers to fetch them again, above a table that
// stays usable.

export interface QueueColumnErrorProps {
  /** Plain names of the columns whose read failed, e.g. "photo thumbnails". */
  columns: string[];
  /** Refetch every failed read. */
  onRetry: () => void;
  /** A refetch is already in flight. */
  retrying?: boolean;
}

export function QueueColumnError({
  columns,
  onRetry,
  retrying = false,
}: QueueColumnErrorProps) {
  if (columns.length === 0) return null;
  const list =
    columns.length === 1
      ? columns[0]
      : `${columns.slice(0, -1).join(", ")} and ${columns[columns.length - 1]}`;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Couldn't load {list}. Those columns are blank because the read failed,
        not because the drafts are empty.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={retrying}
        className="border-destructive/40 bg-transparent hover:bg-destructive/10"
      >
        <RefreshCw className={retrying ? "mr-1.5 h-4 w-4 animate-spin" : "mr-1.5 h-4 w-4"} />
        {retrying ? "Retrying" : "Try again"}
      </Button>
    </div>
  );
}
