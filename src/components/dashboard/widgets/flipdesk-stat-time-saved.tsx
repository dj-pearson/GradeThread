import { ArrowRight, Clock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useTimeSaved } from "@/hooks/use-time-saved";
import { formatMinutes, TIME_SAVED_LABELS } from "@/lib/time-saved";
import { StatTileSkeleton } from "@/components/dashboard/widgets/flipdesk-shared";

// US-9207, on the board (US-3076): hours FlipDesk saved this month.
//
// The number is the seller's own; the breakdown on click names each task and
// how many times FlipDesk did it. A task the seller skipped is not in the list,
// because the server never counted it.
//
// This is the one tile that is not a link, so it does not use StatTile: the
// breakdown is a dialog, and a Link that opens a dialog is a destination in the
// status bar that the click does not go to. Zero is shown as zero rather than
// hidden, because a seller who has not used the automations yet should be able
// to see what the number is for.

export function FlipdeskStatTimeSavedWidget() {
  const { data: timeSaved, isLoading } = useTimeSaved();

  if (isLoading) return <StatTileSkeleton label="time saved" />;
  // No error branch: this is an edge read, not part of the overview aggregate,
  // and the frame's quiet state says the right thing when it cannot answer.
  if (!timeSaved) return null;

  const { totalMinutes, lines, month } = timeSaved;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="group w-full rounded-xl border bg-card p-4 text-left transition-colors hover:border-brand-navy focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={`You saved ${formatMinutes(totalMinutes)} this month. Show the breakdown.`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-2xl font-bold tabular-nums">
              {formatMinutes(totalMinutes)}
            </span>
            <Clock className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {totalMinutes > 0
                ? "on work FlipDesk did for you"
                : "nothing automated yet"}
            </span>
            <ArrowRight
              className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
              aria-hidden="true"
            />
          </div>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            You saved {formatMinutes(totalMinutes)} in {month}
          </DialogTitle>
          <DialogDescription>
            Only work FlipDesk actually did is counted. Anything you skipped or
            did by hand is not here.
          </DialogDescription>
        </DialogHeader>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No automated tasks ran this month. Edit a photo, read measurements
            from a photo, write a listing with AI, price from comps or cross-list
            an item and it shows up here.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {lines.map((l) => (
              <li key={l.task} className="flex items-center justify-between gap-3">
                <span>
                  {TIME_SAVED_LABELS[l.task]}
                  <span className="text-muted-foreground"> x{l.count}</span>
                </span>
                <span className="tabular-nums">{formatMinutes(l.minutes)}</span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
