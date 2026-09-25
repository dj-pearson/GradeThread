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
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  assertFutureDrop,
  isoToZonedInput,
  MIN_DROP_LEAD_MS,
  zonedInputToIso,
} from "@/lib/scheduling";

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
  { label: "Back 1 day", minutes: -1440 },
  { label: "Back 1 hour", minutes: -60 },
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
  // SD-2: why the typed time was refused, shown under the input.
  const [timeError, setTimeError] = useState<string | null>(null);
  const confirm = useConfirm();
  const now = Date.now();

  async function saveTime(drop: DayDrop) {
    const iso = zonedInputToIso(draftAt, timeZone);
    if (!iso) {
      setTimeError("That is not a valid date and time.");
      return;
    }
    // The cron publishes anything at or before now within five minutes, so a
    // past time here is a publish-now the seller did not ask for.
    const check = assertFutureDrop(iso);
    if (!check.ok) {
      setTimeError(check.reason);
      return;
    }
    setTimeError(null);
    try {
      await reschedule.mutateAsync({ id: drop.id, at: iso });
      setEditing(null);
      toast.success(`${drop.title} moved.`);
    } catch (err) {
      toastError(err, "Could not reschedule.");
    }
  }

  /** SD-2: which of this day's drops a shift would push into the past. */
  function shiftPlan(minutes: number) {
    const future = drops.filter(
      (d) =>
        assertFutureDrop(
          new Date(Date.parse(d.scheduled_publish_at) + minutes * 60_000).toISOString(),
          now,
        ).ok,
    );
    return { future, past: drops.length - future.length };
  }

  async function shiftAll(minutes: number) {
    const plan = shiftPlan(minutes);
    if (plan.future.length === 0) return;
    if (plan.past > 0) {
      const ok = await confirm({
        title: "Some drops would land in the past",
        description: `${plan.past} of ${drops.length} drops would land in the past, and the next cron run would publish them. Skip those and shift the rest?`,
        confirmLabel: `Shift ${plan.future.length}`,
      });
      if (!ok) return;
    }
    const targets = plan.future;
    try {
      const r = await shift.mutateAsync({ drops: targets, minutes });
      const missed = r.unchanged + r.failed;
      if (r.moved === 0) {
        toast.error(
          "No drops moved. They already went live, or you cannot edit them.",
        );
      } else if (missed > 0) {
        toast.warning(
          `Shifted ${r.moved} of ${targets.length}. ${missed} already went live or could not be edited.`,
        );
      } else {
        toast.success(`${r.moved} drop${r.moved === 1 ? "" : "s"} shifted.`);
      }
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
            {SHIFTS.map((s) => {
              const plan = shiftPlan(s.minutes);
              return (
                <Button
                  key={s.minutes}
                  size="sm"
                  variant="outline"
                  // Every drop would land in the past: nothing to offer.
                  disabled={busy || plan.future.length === 0}
                  title={
                    plan.future.length === 0
                      ? "Every drop would land in the past."
                      : undefined
                  }
                  onClick={() => void shiftAll(s.minutes)}
                >
                  {s.label}
                </Button>
              );
            })}
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
                    min={isoToZonedInput(
                      new Date(now + MIN_DROP_LEAD_MS).toISOString(),
                      timeZone,
                    )}
                    onChange={(e) => {
                      setDraftAt(e.target.value);
                      setTimeError(null);
                    }}
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
                  {timeError && (
                    <p role="alert" className="w-full text-xs text-destructive">
                      {timeError}
                    </p>
                  )}
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
                      setTimeError(null);
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
                          description: "The draft is untouched. Schedule it again any time.",
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
