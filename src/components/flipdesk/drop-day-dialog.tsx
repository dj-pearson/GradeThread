import { useState } from "react";
import { Link } from "react-router";
import { CalendarClock, ExternalLink, Loader2, Megaphone, X } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCancelDrop,
  useRescheduleDrop,
  useShiftDrops,
} from "@/hooks/use-scheduled-drops";
import { isoToZonedInput, zonedInputToIso } from "@/lib/scheduling";

// US-2522: everything the calendar could not do. One day's drops, each
// reschedulable and cancellable in place, plus a shift that moves the whole day
// and keeps the gaps between them.

export interface DayDrop {
  id: string;
  inventory_item_id: string;
  scheduled_publish_at: string;
  listing_price: number | null;
  title: string;
  promoted: boolean;
}

/** Offered shifts, in minutes. A day slips by an hour far more often than by five. */
const SHIFTS = [
  { label: "−1 day", minutes: -1440 },
  { label: "−1 hour", minutes: -60 },
  { label: "+1 hour", minutes: 60 },
  { label: "+1 day", minutes: 1440 },
];

export function DropDayDialog({
  open,
  onOpenChange,
  dayLabel,
  drops,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dayLabel: string;
  drops: DayDrop[];
  timeZone: string;
}) {
  const reschedule = useRescheduleDrop();
  const cancel = useCancelDrop();
  const shift = useShiftDrops();
  const [editing, setEditing] = useState<string | null>(null);
  const [draftAt, setDraftAt] = useState("");

  async function saveTime(drop: DayDrop) {
    const iso = zonedInputToIso(draftAt, timeZone);
    if (!iso) {
      toast.error("That is not a valid date and time.");
      return;
    }
    try {
      await reschedule.mutateAsync({ id: drop.id, at: iso });
      setEditing(null);
      toast.success(`${drop.title} moved.`);
    } catch (err) {
      toastError(err, "Could not reschedule.");
    }
  }

  async function shiftAll(minutes: number) {
    try {
      await shift.mutateAsync({ drops, minutes });
      toast.success(
        `${drops.length} drop${drops.length === 1 ? "" : "s"} shifted.`,
      );
    } catch (err) {
      toastError(err, "Could not shift the day.");
    }
  }

  const busy = reschedule.isPending || cancel.isPending || shift.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dayLabel}</DialogTitle>
          <DialogDescription>
            {drops.length} drop{drops.length === 1 ? "" : "s"} scheduled ·{" "}
            {timeZone}
          </DialogDescription>
        </DialogHeader>

        {drops.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            <span className="text-sm font-medium">Shift the whole day</span>
            {SHIFTS.map((s) => (
              <Button
                key={s.minutes}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void shiftAll(s.minutes)}
              >
                {s.label}
              </Button>
            ))}
            <span className="w-full text-xs text-muted-foreground">
              Each drop moves by the same amount, so the gaps between them stay
              as you set them.
            </span>
          </div>
        )}

        <div className="space-y-2">
          {drops.map((d) => (
            <div key={d.id} className="rounded-md border p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="flex items-center gap-1.5 font-medium">
                    {d.promoted && (
                      <Megaphone className="h-3.5 w-3.5 shrink-0 text-brand-red-text" />
                    )}
                    <span className="truncate">{d.title}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Intl.DateTimeFormat("en-US", {
                      timeZone,
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(d.scheduled_publish_at))}
                    {d.listing_price != null && ` · $${d.listing_price.toFixed(2)}`}
                  </span>
                </div>
                <Link
                  to={`/dashboard/flipdesk/items/${d.inventory_item_id}/draft`}
                  className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  Open draft
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>

              {editing === d.id ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    type="datetime-local"
                    value={draftAt}
                    onChange={(e) => setDraftAt(e.target.value)}
                    className="h-8 w-auto text-xs"
                    aria-label={`New date and time for ${d.title}`}
                  />
                  <Button size="sm" disabled={busy} onClick={() => void saveTime(d)}>
                    {reschedule.isPending ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(null)}
                    aria-label={`Cancel editing ${d.title}`}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={`Reschedule ${d.title}`}
                    onClick={() => {
                      setEditing(d.id);
                      setDraftAt(isoToZonedInput(d.scheduled_publish_at, timeZone));
                    }}
                  >
                    <CalendarClock className="mr-1 h-3.5 w-3.5" />
                    Reschedule
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Unschedule ${d.title}`}
                    onClick={async () => {
                      try {
                        await cancel.mutateAsync({ id: d.id });
                        toast.success(`${d.title} unscheduled.`, {
                          description: "The draft is untouched — schedule it again any time.",
                        });
                      } catch (err) {
                        toastError(err, "Could not unschedule.");
                      }
                    }}
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    Unschedule
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
