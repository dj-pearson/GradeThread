import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { PREVIEW_ROWS } from "@/lib/flipdesk-overview-format";

// US-3076: the pieces every FlipDesk Overview widget is built out of.
//
// A widget renders its CONTENT and nothing else. The heading and the window it
// covers come from WidgetFrame, which is why none of these draw a Card or a
// title: a bordered card inside a frame that already has a heading is a card in
// a card, and a tile repeating the heading its frame just showed is the same
// label twice in four inches.

/**
 * One number, linked to the list it came from.
 *
 * The link is the whole tile rather than a "view" affordance in the corner: the
 * number IS the way into the list, and a 3px target beside a 200px card that
 * does nothing is a worse version of the same thing.
 */
export function StatTile({
  icon,
  value,
  sub,
  to,
  label,
}: {
  icon: ReactNode;
  value: string;
  sub: string;
  to: string;
  /** What the link is called for a screen reader, since the heading is outside it. */
  label: string;
}) {
  return (
    <Link
      to={to}
      aria-label={`${label}: ${value}. ${sub}`}
      className="group block rounded-xl border bg-card p-4 transition-colors hover:border-brand-navy focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-2xl font-bold tabular-nums">{value}</span>
        <span className="text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{sub}</span>
        <ArrowRight
          className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
          aria-hidden="true"
        />
      </div>
    </Link>
  );
}

/** The tile's shape while the aggregate is in flight. */
export function StatTileSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion label={`Loading ${label}`}>
      <Skeleton className="h-[92px] w-full rounded-xl" aria-hidden="true" />
    </LoadingRegion>
  );
}

/**
 * What a widget shows when the aggregate could not be read.
 *
 * Named as a failure rather than left to the frame's "nothing to show yet",
 * which is a promise that the number is zero. Retry refetches the one shared
 * query, so pressing it in any frame fixes every frame.
 */
export function MetricsUnavailable({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-5" role="alert">
      <p className="text-sm text-muted-foreground">
        Could not load your numbers just now.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 mt-1"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? "Trying again..." : "Try again"}
      </Button>
    </div>
  );
}

/**
 * The line above a list: what the list is counting, and how many there are.
 *
 * The count sits here rather than in the frame's action slot, which belongs to
 * Customize mode's edit controls and would put a badge and a Hide button in the
 * same three inches.
 */
export function ListIntro({
  note,
  count,
  action,
}: {
  note: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="flex shrink-0 items-center gap-2">
        {count != null ? (
          <Badge variant={count > 0 ? "destructive" : "outline"}>{count}</Badge>
        ) : null}
        {action}
      </div>
    </div>
  );
}

/** A list with nothing in it, said in the words of that list. */
export function EmptyList({ children }: { children: ReactNode }) {
  return (
    <div className="py-6 text-center text-sm text-muted-foreground">{children}</div>
  );
}

/**
 * "Show all" for a list that previews five of N (US-2547).
 *
 * `shown` is what the aggregate actually sent and `total` is what exists, and
 * they differ once an account passes the aggregate's row cap. Saying "show all
 * 50" when 214 items are stuck would be the same broken promise as the pipeline
 * tile that offered a filter it could not apply, so the copy names both numbers
 * and points at the list that can show the rest.
 */
export function ShowAllToggle({
  shown,
  total,
  expanded,
  onToggle,
  noun,
}: {
  shown: number;
  total: number;
  expanded: boolean;
  onToggle: () => void;
  noun: string;
}) {
  if (shown <= PREVIEW_ROWS) return null;
  const capped = total > shown;
  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
      <Button variant="ghost" size="sm" onClick={onToggle}>
        {expanded
          ? "Show fewer"
          : capped
            ? `Show ${shown} of ${total} ${noun}`
            : `Show all ${shown} ${noun}`}
      </Button>
      {capped && expanded && (
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard/flipdesk/items">
            See every item
            <ArrowRight className="ml-1 h-3 w-3" />
          </Link>
        </Button>
      )}
    </div>
  );
}
