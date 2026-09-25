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
  GAP_COPY,
  HORIZON_COPY,
  INCOMPLETE_COSTS_COPY,
  PENDING_CAVEAT,
  PER_HOUR_CAVEAT,
  PROJECTED_CAVEAT,
  REALIZED_CAVEAT,
  SCORECARD_STAT_LABELS,
  SOURCE_WORDS,
  THIN_SAMPLE_COPY,
  UNAVAILABLE_COPY,
  UNMATCHABLE_COPY,
  plural,
} from "@/lib/work-scorecard-copy";
import type { EstimateSource } from "@/lib/work-outcomes";

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

/** A LOCAL calendar day as YYYY-MM-DD, the way a date input shows it. */
function localDay(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The default window: the last 90 days, as YYYY-MM-DD for a date input. */
function defaultRange(now: string): { from: string; to: string } {
  const end = Date.parse(now);
  const start = end - 90 * 86_400_000;
  return { from: localDay(start), to: localDay(end) };
}

/**
 * The seller's own midnight, not UTC's (WMT-10). A seller in Los Angeles who
 * picks "March 10" means their March 10, and a UTC bound cuts their evening
 * off at 4pm.
 */
function localBounds(r: { from: string; to: string }): { from: number; to: number } {
  return {
    from: new Date(`${r.from}T00:00:00`).getTime(),
    to: new Date(`${r.to}T23:59:59.999`).getTime(),
  };
}

function Figures({ card }: { card: Scorecard }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {/* THREE BOXES, NEVER A TOTAL (AC2). A screen that adds a projection to
          a recorded net produces a figure that is neither. */}
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{SCORECARD_STAT_LABELS.projected}</h4>
        {/* WMT-10: unsold stock only, and a reason rather than $0.00. */}
        <StatValue stat={card.projected} />
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
  // WMT-10: five tables are read for this, and most visits never open it. The
  // read waits for the disclosure.
  const [open, setOpen] = useState(false);
  const outcomes = useWorkOutcomes(open);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [comparing, setComparing] = useState(false);

  const book = outcomes.data;
  const effective = range ?? (book ? defaultRange(book.now) : null);

  const card = useMemo(() => {
    if (!book || !effective) return null;
    const { from, to } = localBounds(effective);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return buildScorecard({
      outcomes: book.outcomes,
      tasks: book.tasks,
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    });
  }, [book, effective]);

  /** The same length of window immediately before this one. */
  const previous = useMemo(() => {
    if (!book || !effective || !comparing) return null;
    const { from, to } = localBounds(effective);
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
    <details
      className="rounded-xl border p-4"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        How the planner has done for you
      </summary>

      <div className="mt-4 space-y-5">
        {outcomes.isLoading && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading your history
          </p>
        )}

        {outcomes.isError && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">
              We couldn't read your history just now. Nothing is lost; try
              again in a moment.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={outcomes.isFetching}
              onClick={() => void outcomes.refetch()}
            >
              Try again
            </Button>
          </div>
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
                  {plural(card.work.carriedForwardItems, "item", "items")} carried
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

            {card.unmatchableJobs > 0 && (
              <p className="text-sm text-muted-foreground">
                {UNMATCHABLE_COPY(card.unmatchableJobs)}
              </p>
            )}

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
                    recorded {money(card.forecast.recordedTotalCents)}.{" "}
                    {GAP_COPY(
                      card.forecast.lowestDifferenceCents ?? 0,
                      card.forecast.highestDifferenceCents ?? 0,
                      card.forecast.medianDifferenceCents ?? 0,
                      money,
                    )}
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
                  .map(([k, n]) => `${n} from ${SOURCE_WORDS[k as EstimateSource] ?? k}`)
                  .join(", ") || "no recorded evidence"}.
              </p>
            </div>

            {comparing && previous && (
              <div className="space-y-1">
                <h3 className="text-sm font-medium">The period before</h3>
                <p className="text-sm">
                  {plural(previous.work.completedTasks, "job", "jobs")},{" "}
                  {hours(previous.work.confirmedMinutes)} confirmed.{" "}
                  {previous.realized.available
                    ? `${money(previous.realized.cents)} recorded.`
                    : UNAVAILABLE_COPY[previous.realized.reason]}
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
