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
import { useWorkspace } from "@/hooks/use-workspace";
import { roleNeededNote } from "@/lib/workspace-permissions";
import {
  assertFutureDrop,
  isoToZonedInput,
  dropNeedsAttention,
  MIN_DROP_LEAD_MS,
  formatInZone,
  formatTimeInZone,
  shiftInZone,
  zoneCalendarDate,
  zonedInputToIsoDetailed,
  type DropHealth,
  type DropShift,
} from "@/lib/scheduling";
import { DropHealthTag } from "@/components/flipdesk/drop-health-tag";

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
  /** SD-4: what the publish cron has done with this drop. */
  health: DropHealth;
  /** One line explaining a non-scheduled state, or null. */
  healthNote: string | null;
}

/**
 * Offered shifts. A day slips by an hour far more often than by five. Days
 * move on the wall clock (SD-6); hours move as absolute time.
 */
const SHIFTS: { key: string; label: string; shift: DropShift }[] = [
  { key: "-1d", label: "Back 1 day", shift: { days: -1 } },
  { key: "-1h", label: "Back 1 hour", shift: { minutes: -60 } },
  { key: "+1h", label: "+1 hour", shift: { minutes: 60 } },
  { key: "+1d", label: "+1 day", shift: { days: 1 } },
];

/** "2:30 AM" from a typed "YYYY-MM-DDTHH:mm", read as-is (no zone math). */
function formatTypedTime(local: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(local);
  if (!m) return local;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

export function DropDayDialog({
  open,
  onOpenChange,
  dayLabel,
  drops,
  timeZone,
  onDayChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dayLabel: string;
  drops: DayDrop[];
  timeZone: string;
  /** SD-10: show another day (month 1-based), after a day shift or on request. */
  onDayChange?: (year: number, month: number, day: number) => void;
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
  // SD-5: the listings UPDATE policy needs the owner or a listing manager. A
  // viewer or member clicking these got a write RLS quietly dropped.
  const { can } = useWorkspace();
  const canEdit = can("manage_inventory");

  async function saveTime(drop: DayDrop) {
    const parsed = zonedInputToIsoDetailed(draftAt, timeZone);
    if (!parsed) {
      setTimeError("That is not a valid date and time.");
      return;
    }
    const iso = parsed.iso;
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
      if (parsed.adjusted === "gap") {
        // SD-7: the clocks skip this hour; say where the drop really went.
        toast.info(
          `${formatTypedTime(draftAt)} does not exist on this day in ${timeZone}; set to ${formatTimeInZone(iso, timeZone)}.`,
        );
      } else {
        const from = zoneCalendarDate(new Date(drop.scheduled_publish_at), timeZone);
        const to = zoneCalendarDate(new Date(iso), timeZone);
        const sameDay =
          from.year === to.year && from.month === to.month && from.day === to.day;
        if (sameDay || !onDayChange) {
          toast.success(`${drop.title} moved.`);
        } else {
          // SD-10: the drop left this day; say where it went and offer to follow.
          toast.success(`${drop.title} moved to ${formatInZone(iso, timeZone)}.`, {
            action: {
              label: "Go to day",
              onClick: () => onDayChange(to.year, to.month, to.day),
            },
          });
        }
      }
    } catch (err) {
      toastError(err, "Could not reschedule.");
    }
  }

  /**
   * SD-11: Undo for a shift moves back ONLY the rows that really moved, by the
   * same amount, from where they are now.
   */
  function undoShiftAction(targets: DayDrop[], movedIds: string[], by: DropShift) {
    const moved = targets
      .filter((t) => movedIds.includes(t.id))
      .map((t) => ({
        id: t.id,
        scheduled_publish_at: shiftInZone(t.scheduled_publish_at, timeZone, by),
      }));
    const back: DropShift = {};
    if (by.days) back.days = -by.days;
    if (by.minutes) back.minutes = -by.minutes;
    return {
      label: "Undo",
      onClick: () => {
        shift
          .mutateAsync({ drops: moved, shift: back, timeZone })
          .then((r) => {
            if (r.moved < moved.length) {
              toast.warning(`Moved ${r.moved} of ${moved.length} back.`);
            }
          })
          .catch((err: unknown) => toastError(err, "Could not undo the shift."));
      },
    };
  }

  async function unschedule(d: DayDrop) {
    const previous = d.scheduled_publish_at;
    try {
      await cancel.mutateAsync({ id: d.id });
      // SD-11: the old time is otherwise lost. It can only be put back while
      // it is still ahead of the cron; a past time would publish at once.
      if (assertFutureDrop(previous).ok) {
        toast.success(`${d.title} unscheduled.`, {
          description: "The draft is untouched. Schedule it again any time.",
          action: {
            label: "Undo",
            onClick: () => {
              reschedule
                .mutateAsync({ id: d.id, at: previous })
                .catch((err: unknown) => toastError(err, "Could not put the drop back."));
            },
          },
        });
      } else {
        toast.success(`${d.title} unscheduled.`, {
          description:
            "Its old time has passed, so there is no undo. The draft is untouched.",
        });
      }
    } catch (err) {
      toastError(err, "Could not unschedule.");
    }
  }

  /** SD-2: which of this day's drops a shift would push into the past. */
  function shiftPlan(by: DropShift) {
    const future = drops.filter(
      (d) => assertFutureDrop(shiftInZone(d.scheduled_publish_at, timeZone, by), now).ok,
    );
    return { future, past: drops.length - future.length };
  }

  async function shiftAll(by: DropShift) {
    const plan = shiftPlan(by);
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
      const r = await shift.mutateAsync({ drops: targets, shift: by, timeZone });
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
        toast.success(`${r.moved} drop${r.moved === 1 ? "" : "s"} shifted.`, {
          action: undoShiftAction(targets, r.movedIds, by),
        });
      }
      // SD-10: a whole-day shift empties this day, so follow the drops.
      const first = targets.find((t) => r.movedIds.includes(t.id));
      if (by.days && first && onDayChange) {
        const to = zoneCalendarDate(
          new Date(shiftInZone(first.scheduled_publish_at, timeZone, by)),
          timeZone,
        );
        onDayChange(to.year, to.month, to.day);
      }
    } catch (err) {
      toastError(err, "Could not shift the day.");
    }
  }

  const busy = reschedule.isPending || cancel.isPending || shift.isPending;
  const locked = busy || !canEdit;
  // SD-11: which row a single write is working on, so only that row spins and
  // locks. A shift touches every row, so it still locks them all.
  const pendingId =
    (reschedule.isPending && reschedule.variables?.id) ||
    (cancel.isPending && cancel.variables?.id) ||
    null;
  const rowLocked = (id: string) => !canEdit || shift.isPending || pendingId === id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85dvh] max-w-lg overflow-y-auto"
        onEscapeKeyDown={(e) => {
          // SD-11: Escape inside the time editor closes the editor, not the day.
          if (editing) {
            e.preventDefault();
            setEditing(null);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{dayLabel}</DialogTitle>
          <DialogDescription>
            {drops.length} drop{drops.length === 1 ? "" : "s"} scheduled ·{" "}
            {timeZone}
          </DialogDescription>
        </DialogHeader>

        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            {roleNeededNote("manage_inventory", "change drops")}
          </p>
        )}

        {drops.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            <span className="text-sm font-medium">Shift the whole day</span>
            {SHIFTS.map((s) => {
              const plan = shiftPlan(s.shift);
              return (
                <Button
                  key={s.key}
                  size="sm"
                  variant="outline"
                  // Every drop would land in the past: nothing to offer.
                  disabled={locked || plan.future.length === 0}
                  title={
                    plan.future.length === 0
                      ? "Every drop would land in the past."
                      : undefined
                  }
                  onClick={() => void shiftAll(s.shift)}
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
                    <DropHealthTag health={d.health} className="text-xs" />
                    {d.promoted && (
                      <Megaphone className="h-3.5 w-3.5 shrink-0 text-brand-red-text" />
                    )}
                    <span className="truncate">{d.title}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatTimeInZone(d.scheduled_publish_at, timeZone)}
                    {d.listing_price != null && ` · $${d.listing_price.toFixed(2)}`}
                  </span>
                  {d.healthNote && (
                    <p
                      className={
                        dropNeedsAttention(d.health)
                          ? "text-xs text-brand-red-text"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {d.healthNote}
                    </p>
                  )}
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
                <form
                  // Our own check explains a refused time; the browser's
                  // min-bubble would block the submit without saying why here.
                  noValidate
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    // SD-11: Enter in the time input saves.
                    e.preventDefault();
                    void saveTime(d);
                  }}
                >
                  <Input
                    type="datetime-local"
                    value={draftAt}
                    // The editor opens on a click; the input is where the
                    // seller is going next.
                    autoFocus
                    min={isoToZonedInput(
                      new Date(now + MIN_DROP_LEAD_MS).toISOString(),
                      timeZone,
                    )}
                    onChange={(e) => {
                      setDraftAt(e.target.value);
                      setTimeError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    className="h-8 w-auto text-xs"
                    aria-label={`New date and time for ${d.title}`}
                  />
                  <Button type="submit" size="sm" disabled={rowLocked(d.id)}>
                    {pendingId === d.id ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pendingId === d.id}
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
                </form>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rowLocked(d.id)}
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
                    disabled={rowLocked(d.id)}
                    aria-label={`Unschedule ${d.title}`}
                    onClick={() => void unschedule(d)}
                  >
                    {pendingId === d.id && cancel.isPending ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="mr-1 h-3.5 w-3.5" />
                    )}
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
