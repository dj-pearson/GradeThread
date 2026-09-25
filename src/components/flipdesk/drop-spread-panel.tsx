import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useSpreadDrops } from "@/hooks/use-scheduled-drops";
import {
  assertFutureDrop,
  formatInZone,
  formatTimeInZone,
  isoToZonedInput,
  MIN_DROP_LEAD_MS,
  orderForSpread,
  SPREAD_INTERVALS,
  SPREAD_ORDER_LABEL,
  spreadTimes,
  zonedInputToIso,
  type SpreadOrder,
} from "@/lib/scheduling";
import type { DayDrop } from "@/components/flipdesk/drop-day-dialog";

// SD-14: stagger a stack of drops across time slots in one step. A seller with
// twenty drops at 7:00 used to have a uniform shift and nothing else. Each row
// gets its own instant through the same per-row path as a shift (future-only,
// zero-row writes counted), previewed inline before anything is written.

/** Where a spread starts when the seller has not picked: the earliest selected
 *  drop, or the next five-minute mark past the cron's window. */
function defaultStart(drops: DayDrop[], suggested: string | undefined, now: number): string {
  if (suggested && assertFutureDrop(suggested, now).ok) return suggested;
  const earliest = drops
    .map((d) => d.scheduled_publish_at)
    .filter((iso) => assertFutureDrop(iso, now).ok)
    .sort()[0];
  if (earliest) return earliest;
  const step = 5 * 60_000;
  return new Date(Math.ceil((now + MIN_DROP_LEAD_MS + step) / step) * step).toISOString();
}

export function DropSpreadPanel({
  drops,
  timeZone,
  disabled,
  suggestedStart,
}: {
  drops: DayDrop[];
  timeZone: string;
  disabled: boolean;
  /** SD-15: a start instant from the seller's own best hours, if any. */
  suggestedStart?: { iso: string; label: string } | null;
}) {
  const spread = useSpreadDrops();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startAt, setStartAt] = useState("");
  const [interval, setIntervalMinutes] = useState<number>(15);
  const [order, setOrder] = useState<SpreadOrder>("current");
  const now = Date.now();

  function openPanel() {
    setSelected(new Set(drops.map((d) => d.id)));
    setStartAt(isoToZonedInput(defaultStart(drops, suggestedStart?.iso, now), timeZone));
    setOpen(true);
  }

  const startIso = zonedInputToIso(startAt, timeZone);
  const startCheck = startIso ? assertFutureDrop(startIso, now) : null;
  const plan = useMemo(() => {
    const picked = orderForSpread(
      drops.filter((d) => selected.has(d.id)),
      order,
    );
    const times = startIso ? spreadTimes(picked.length, startIso, interval) : [];
    return picked.map((d, i) => ({ drop: d, at: times[i] ?? null }));
  }, [drops, selected, order, startIso, interval]);
  const preview = new Map(plan.map((p) => [p.drop.id, p.at]));
  const canSave =
    !disabled && !spread.isPending && plan.length > 0 && startCheck?.ok === true;

  async function save() {
    const assignments = plan
      .filter((p): p is { drop: DayDrop; at: string } => p.at != null)
      .map((p) => ({ id: p.drop.id, at: p.at }));
    if (assignments.length === 0) return;
    const first = assignments[0]!.at;
    const last = assignments[assignments.length - 1]!.at;
    const ok = await confirm({
      title: `Spread ${assignments.length} drops?`,
      description: `From ${formatInZone(first, timeZone)} to ${formatTimeInZone(last, timeZone)}, ${interval} minutes apart.`,
      confirmLabel: `Spread ${assignments.length}`,
    });
    if (!ok) return;
    const previous = new Map(drops.map((d) => [d.id, d.scheduled_publish_at]));
    try {
      const r = await spread.mutateAsync({ assignments });
      setOpen(false);
      if (r.moved === 0) {
        toast.error("No drops moved. They already went live, or you cannot edit them.");
        return;
      }
      // Undo puts back only rows that moved, and only to times still ahead of
      // the cron; an old time that has passed would publish at once.
      const restore = r.movedIds
        .map((id) => ({ id, at: previous.get(id)! }))
        .filter((a) => assertFutureDrop(a.at).ok);
      toast.success(`Spread ${r.moved} of ${assignments.length}.`, {
        description:
          r.moved < assignments.length
            ? `${assignments.length - r.moved} already went live or could not be edited.`
            : undefined,
        action:
          restore.length > 0
            ? {
                label: "Undo",
                onClick: () => {
                  spread
                    .mutateAsync({ assignments: restore })
                    .catch((err: unknown) => toastError(err, "Could not undo the spread."));
                },
              }
            : undefined,
      });
    } catch (err) {
      toastError(err, "Could not spread the drops.");
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" disabled={disabled} onClick={openPanel}>
        Spread over time slots
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-2" data-testid="drop-spread-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Spread over time slots</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      <label className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">Start</span>
        <Input
          type="datetime-local"
          value={startAt}
          min={isoToZonedInput(new Date(now + MIN_DROP_LEAD_MS).toISOString(), timeZone)}
          onChange={(e) => setStartAt(e.target.value)}
          className="h-8 w-auto text-xs"
          aria-label="Spread start time"
        />
        {suggestedStart && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => setStartAt(isoToZonedInput(suggestedStart.iso, timeZone))}
          >
            Use {suggestedStart.label}
          </Button>
        )}
      </label>
      {startCheck && !startCheck.ok && (
        <p role="alert" className="text-xs text-destructive">
          {startCheck.reason}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="Interval">
        <span className="mr-1 font-medium">Every</span>
        {SPREAD_INTERVALS.map((m) => (
          <Button
            key={m}
            type="button"
            size="sm"
            variant={interval === m ? "secondary" : "ghost"}
            className="h-7 px-2 text-xs"
            aria-pressed={interval === m}
            onClick={() => setIntervalMinutes(m)}
          >
            {m} min
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="Order">
        <span className="mr-1 font-medium">Order</span>
        {(Object.keys(SPREAD_ORDER_LABEL) as SpreadOrder[]).map((o) => (
          <Button
            key={o}
            type="button"
            size="sm"
            variant={order === o ? "secondary" : "ghost"}
            className="h-7 px-2 text-xs"
            aria-pressed={order === o}
            onClick={() => setOrder(o)}
          >
            {SPREAD_ORDER_LABEL[o]}
          </Button>
        ))}
      </div>

      <ul className="space-y-1">
        {drops.map((d) => {
          const at = preview.get(d.id);
          return (
            <li key={d.id} className="flex items-center justify-between gap-2 text-xs">
              <label className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(d.id)}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(d.id);
                      else next.delete(d.id);
                      return next;
                    })
                  }
                  aria-label={`Include ${d.title}`}
                />
                <span className="truncate">{d.title}</span>
              </label>
              <span className="shrink-0 tabular-nums text-muted-foreground" data-testid={`spread-at-${d.id}`}>
                {formatTimeInZone(d.scheduled_publish_at, timeZone)}
                {at ? ` to ${formatTimeInZone(at, timeZone)}` : ""}
              </span>
            </li>
          );
        })}
      </ul>

      <Button size="sm" disabled={!canSave} onClick={() => void save()}>
        {spread.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
        Spread {plan.length} drop{plan.length === 1 ? "" : "s"}
      </Button>
    </div>
  );
}
