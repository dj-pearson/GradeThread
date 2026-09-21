// Worth My Time, R2 06/06 (US-3183): the results view.
//
// ── WHAT THIS SCREEN IS NOT ALLOWED TO SAY ──────────────────────────────────
// "You earned", "you saved", "the planner made you". It reports three figures
// that are never combined, names the unsold work beside them, and prints a
// reason wherever a number cannot be stated. The word "earned" appears
// nowhere, which the suite checks, and the hourly figure is labelled profit
// per TRACKED hour with the caveat attached rather than tucked behind a
// tooltip.
//
// ── A DISCLOSURE, NOT A DASHBOARD (AC1) ─────────────────────────────────────
// "A small results view within the planner", and small is the instruction. A
// seller opening Worth My Time wants to plan an evening; the scorecard is
// what they check once a month. So it is a <details> under the planner: a
// native disclosure, keyboard-operable with no handler of ours, closed by
// default, and it does not compete with the plan for the top of the page.

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWorkOutcomes } from "@/hooks/use-planner";
import {
  buildScorecard,
  isThinSample,
  type Scorecard,
  type Stat,
} from "@/lib/work-scorecard";
import {
  COMPARISON_CAVEAT,
  HORIZON_COPY,
  INCOMPLETE_COSTS_COPY,
  PENDING_CAVEAT,
  PER_HOUR_CAVEAT,
  PROJECTED_CAVEAT,
  REALIZED_CAVEAT,
  SCORECARD_STAT_LABELS,
  THIN_SAMPLE_COPY,
  UNAVAILABLE_COPY,
} from "@/lib/work-scorecard-copy";

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function hours(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** A figure, or the reason there isn't one. Never a zero standing in. */
function StatValue({ stat }: { stat: Stat }) {
  if (!stat.available) {
    return <p className="text-sm text-muted-foreground">{UNAVAILABLE_COPY[stat.reason]}</p>;
  }
  return <p className="text-2xl font-semibold tabular-nums">{money(stat.cents)}</p>;
}

/** The default window: the last 90 days, as YYYY-MM-DD for a date input. */
function defaultRange(now: string): { from: string; to: string } {
  const end = Date.parse(now);
  const start = end - 90 * 86_400_000;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: day(start), to: day(end) };
}

function Figures({ card }: { card: Scorecard }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {/* THREE BOXES, NEVER A TOTAL (AC2). A screen that adds a projection to
          a recorded net produces a figure that is neither. */}
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{SCORECARD_STAT_LABELS.projected}</h4>
        <p className="text-2xl font-semibold tabular-nums">
          {money(card.projectedNetCents)}
        </p>
        <p className="text-xs text-muted-foreground">{PROJECTED_CAVEAT}</p>
      </div>
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{SCORECARD_STAT_LABELS.realized}</h4>
        <StatValue stat={card.realized} />
        <p className="text-xs text-muted-foreground">{REALIZED_CAVEAT}</p>
      </div>
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{SCORECARD_STAT_LABELS.perHour}</h4>
        <StatValue stat={card.profitPerTrackedHour} />
        {/* AC2: attached, not behind a tooltip. */}
        <p className="text-xs text-muted-foreground">{PER_HOUR_CAVEAT}</p>
      </div>
    </div>
  );
}

export function ResultsPanel() {
  const outcomes = useWorkOutcomes();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [comparing, setComparing] = useState(false);

  const book = outcomes.data;
  const effective = range ?? (book ? defaultRange(book.now) : null);

  const card = useMemo(() => {
    if (!book || !effective) return null;
    return buildScorecard({
      outcomes: book.outcomes,
      tasks: book.tasks,
      range: {
        from: `${effective.from}T00:00:00.000Z`,
        to: `${effective.to}T23:59:59.999Z`,
      },
    });
  }, [book, effective]);

  /** The same length of window immediately before this one. */
  const previous = useMemo(() => {
    if (!book || !effective || !comparing) return null;
    const from = Date.parse(`${effective.from}T00:00:00.000Z`);
    const to = Date.parse(`${effective.to}T23:59:59.999Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const span = to - from;
    return buildScorecard({
      outcomes: book.outcomes,
      tasks: book.tasks,
      range: {
        from: new Date(from - span - 1).toISOString(),
        to: new Date(from - 1).toISOString(),
      },
    });
  }, [book, effective, comparing]);

  return (
    <details className="rounded-xl border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        How the planner has done for you
      </summary>

      <div className="mt-4 space-y-5">
        {outcomes.isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading your history
          </p>
        )}

        {outcomes.isError && (
          <p role="alert" className="text-sm text-destructive">
            We couldn't read your history just now. Nothing is lost; try again
            in a moment.
          </p>
        )}

        {book && effective && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="wmt-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input
                id="wmt-from"
                type="date"
                className="w-40"
                value={effective.from}
                onChange={(e) => setRange({ ...effective, from: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wmt-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input
                id="wmt-to"
                type="date"
                className="w-40"
                value={effective.to}
                onChange={(e) => setRange({ ...effective, to: e.target.value })}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={comparing}
              onClick={() => setComparing((v) => !v)}
            >
              {comparing ? "Hide the period before" : "Compare with the period before"}
            </Button>
          </div>
        )}

        {card && (
          <>
            <div className="space-y-1">
              <h3 className="text-sm font-medium">What you got through</h3>
              <p className="text-sm">
                {card.work.completedTasks}{" "}
                {card.work.completedTasks === 1 ? "job" : "jobs"} finished across{" "}
                {card.work.sessions}{" "}
                {card.work.sessions === 1 ? "session" : "sessions"}, and{" "}
                {hours(card.work.confirmedMinutes)} you confirmed.
              </p>
              {card.work.carriedForwardItems > 0 && (
                <p className="text-sm text-muted-foreground">
                  {card.work.carriedForwardItems}{" "}
                  {card.work.carriedForwardItems === 1 ? "item" : "items"} carried
                  into another evening.
                </p>
              )}
            </div>

            <Figures card={card} />

            {/* AC3: the unsold half, beside the wins rather than under them. */}
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Still waiting to sell</h3>
              <p className="text-sm">
                {card.pending.items}{" "}
                {card.pending.items === 1 ? "item" : "items"}, with{" "}
                {hours(card.pending.trackedMinutes)} already in them.
              </p>
              <p className="text-xs text-muted-foreground">{PENDING_CAVEAT}</p>
            </div>

            {card.excludedForIncompleteCosts > 0 && (
              <p role="status" className="text-sm">
                {INCOMPLETE_COSTS_COPY(card.excludedForIncompleteCosts)}
              </p>
            )}

            <div className="space-y-1">
              <h3 className="text-sm font-medium">Guess against result</h3>
              {card.forecast.sampleSize === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing from this window has both an estimate and a recorded
                  result yet.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    On {card.forecast.sampleSize}{" "}
                    {card.forecast.sampleSize === 1 ? "item" : "items"}: we
                    guessed {money(card.forecast.estimatedTotalCents)}, the books
                    recorded {money(card.forecast.recordedTotalCents)}. Per item
                    the gap ran from{" "}
                    {money(card.forecast.lowestDifferenceCents ?? 0)} to{" "}
                    {money(card.forecast.highestDifferenceCents ?? 0)}, middle{" "}
                    {money(card.forecast.medianDifferenceCents ?? 0)}.
                  </p>
                  {isThinSample(card.forecast.sampleSize) && (
                    <p className="text-xs text-muted-foreground">{THIN_SAMPLE_COPY}</p>
                  )}
                </>
              )}
              <p className="text-xs text-muted-foreground">
                {HORIZON_COPY(card.forecast.horizonDays)} Prices came from{" "}
                {Object.entries(card.forecast.bySource)
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
                  .join(", ") || "no recorded evidence"}.
              </p>
            </div>

            {comparing && previous && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium">The period before</h3>
                <p className="text-sm">
                  {previous.work.completedTasks} jobs,{" "}
                  {hours(previous.work.confirmedMinutes)} confirmed,{" "}
                  {previous.realized.available
                    ? `${money(previous.realized.cents)} recorded`
                    : UNAVAILABLE_COPY[previous.realized.reason]}
                  .
                </p>
                {/* AC4: descriptive, and it says so. */}
                <p className="text-xs text-muted-foreground">{COMPARISON_CAVEAT}</p>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
