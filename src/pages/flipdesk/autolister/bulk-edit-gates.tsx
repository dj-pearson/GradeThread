import { Link } from "react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { ErrorState } from "@/components/ui/error-state";

// The three things the bulk-edit grid can show INSTEAD of a grid: no batch in
// the URL, the drafts still loading, and the read having failed.
//
// Extracted here (US-3250) rather than growing autolister-bulk-edit.tsx past
// its shrink-only line ceiling. The ceiling's own failure message says to move
// a piece into this directory rather than raise the number, and three early
// returns that share nothing with the grid are the obvious piece.

export function NoBatchSpecified() {
  return (
    <div className="py-12 text-center text-sm text-muted-foreground">
      No batch specified.{" "}
      <Link to="/dashboard/flipdesk/autolister" className="text-primary underline">
        Start a new batch
      </Link>
      .
    </div>
  );
}

export function DraftsLoading() {
  return (
    <LoadingRegion label="Loading drafts" className="space-y-4 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </LoadingRegion>
  );
}

/**
 * A failed drafts read.
 *
 * This used to be a bare centred red line carrying error.message, with no way
 * out: the seller has navigated in from a batch, so the only recovery was a
 * page reload. The wording says the drafts are safe because the obvious fear on
 * a bulk grid that will not load is that the batch itself is gone.
 */
export function DraftsFailed({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <ErrorState
      title="Couldn't load this batch's drafts"
      description="Your drafts are safe; this is a loading problem. Nothing has been published or changed."
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}
