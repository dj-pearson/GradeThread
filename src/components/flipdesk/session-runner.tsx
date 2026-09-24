// Worth My Time, R1 11/12 (US-3176): follow the plan, and come back to it.
//
// A plan a seller reads once is a list. A plan they work through, put down
// because someone rang the doorbell, and pick up an hour later is a session.
// This is the difference, and almost all of it is about what happens when the
// work is INTERRUPTED rather than when it goes smoothly.
//
// ── THE SERVER HOLDS THE SESSION, THE SCREEN HOLDS NOTHING ──────────────────
// Every control here is a POST and every render is the server's answer. There
// is no local mirror of which task is running, because a local mirror is what
// makes two tabs disagree and a refresh lose an evening. The cost is a round
// trip per press. The benefit is that closing the laptop is free: the session
// is exactly as durable as the database, and reopening the page restores it
// without the seller doing anything.
//
// ── STOPPING A TIMER IS NOT DOING THE WORK (AC2) ────────────────────────────
// Pressing Done records that the SELLER SAYS they did it. It publishes
// nothing, ships nothing and changes no grade -- those have their own routes.
// Before offering the button the screen re-reads the item and says plainly
// when it cannot see the work: "We still don't see measurements saved on this
// item." It does not block. A seller who measured on paper is telling the
// truth and a screen that called them a liar would be wrong more often than it
// was right.
//
// ── DOUBLE PRESSES, TWO TABS, DROPPED CONNECTIONS (AC4) ─────────────────────
// Three separate mechanisms, because they are three separate problems:
//   - a second press while one is in flight is refused locally (the buttons
//     disable), which handles the impatient click;
//   - a stale revision is refused by the SERVER, which handles two tabs, and
//     the refusal carries the true session so the screen corrects itself
//     without re-sending anything;
//   - a retried timing event carries the same attempt number, so the unique
//     index collapses it rather than recording the work twice.
// None of the three is sufficient alone and none is a substitute for another.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Loader2,
  MapPin,
  Pause,
  Play,
  SkipForward,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastError } from "@/lib/toast-error";
import { useItemFull } from "@/hooks/use-items-full";
import {
  adviseOnCurrentItem,
  useCurrentSession,
  useSessionAction,
  useTaskAction,
  useWorkPreferences,
  type PlannerSession,
} from "@/hooks/use-planner";
import { TaskCorrections } from "@/components/flipdesk/task-corrections";
import { ADVICE_COPY, ADVICE_REASON_COPY } from "@/lib/work-advice-copy";
import {
  confirmableMinutes,
  reconcile,
  sessionProgress,
  timingCertainty,
  type HiddenSpan,
  type SessionTaskView,
} from "@/lib/session-timing";
import { itemHref } from "@/lib/session-links";
import { actionLabel } from "@/lib/work-action-labels";
import type { AdviceResult } from "@/lib/work-advice";
import type { ItemListRow } from "@/lib/item-list-columns";


/**
 * Track how long this tab spent in the background.
 *
 * Deliberately NOT a pause. Hiding the tab is the commonest thing that happens
 * when the work is physical, so auto-pausing would stop the clock exactly when
 * the seller picked up the camera. See lib/session-timing.ts for why the
 * answer is to measure and ask rather than to guess.
 */
function useHiddenSpans(): { spans: HiddenSpan[]; reset: () => void } {
  const [spans, setSpans] = useState<HiddenSpan[]>([]);
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "hidden") {
        setSpans((prev) => [...prev, { from: Date.now(), to: null }]);
      } else {
        setSpans((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.to !== null) return prev;
          return [...prev.slice(0, -1), { ...last, to: Date.now() }];
        });
      }
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return { spans, reset: useCallback(() => setSpans([]), []) };
}

interface RunnerProps {
  /** Rendered when there is no session to run. */
  fallback?: React.ReactNode;
}

export function SessionRunner({ fallback = null }: RunnerProps) {
  const query = useCurrentSession();
  const sessionAction = useSessionAction();
  const taskAction = useTaskAction();
  const { spans, reset: resetSpans } = useHiddenSpans();

  const data: PlannerSession | undefined = query.data;
  const session = data?.session ?? null;
  const progress = useMemo(() => sessionProgress(data?.tasks ?? []), [data]);

  // When the current task started, by the browser's clock. Only ever used to
  // OFFER a number the seller can change; the server's own observed figure is
  // built from its own timestamps and does not trust this.
  const startedAtRef = useRef<number | null>(null);
  // How many times each task has entered `active`. The server dedups on it,
  // so a retry must reuse the number rather than increment it (AC4).
  const attempts = useRef<Record<string, number>>({});
  const [confirming, setConfirming] = useState<SessionTaskView | null>(null);
  const [minutes, setMinutes] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  // WMT-03: ending a session is one tap from losing the sitting, so it asks
  // first. Holds which end is being confirmed.
  const [confirmEnd, setConfirmEnd] = useState<"complete" | "abandon" | null>(null);

  const current = progress.current;
  // WMT-09: after a reload the in-memory start is gone, so the server's
  // task_started time stands in for it. Read at the moment it is needed.
  const startedAt = (): number | null => {
    if (startedAtRef.current !== null) return startedAtRef.current;
    const fromServer = progress.currentIsActive && current?.started_at
      ? Date.parse(current.started_at)
      : Number.NaN;
    return Number.isFinite(fromServer) ? fromServer : null;
  };
  const item = useItemFull(current?.inventory_item_id ?? undefined);
  const check = useMemo(
    () => reconcile(current?.action_key ?? "", item.data as ItemListRow | null),
    [current, item.data],
  );

  // US-3180: should the seller keep going on this one? Computed from the item
  // row the runner already holds, so it costs no extra read.
  const prefs = useWorkPreferences();
  const advice = useMemo(
    () =>
      adviseOnCurrentItem({
        item: item.data as ItemListRow | null,
        action: current?.action_key ?? "",
        hourlyTargetCents: prefs.data?.hourlyTargetAmount != null
          ? Math.round(prefs.data.hourlyTargetAmount * 100)
          : null,
      }),
    [item.data, current, prefs.data],
  );

  const busy = sessionAction.isPending || taskAction.isPending;

  const runTask = useCallback(
    async (task: SessionTaskView, action: string, confirmedMinutes?: number) => {
      if (!session) return;
      // WMT-09: the attempt number moves only once a start has LANDED. A
      // start that failed may still have reached the server, so its retry
      // must carry the same number for the server to dedup it.
      const attempt = action === "start"
        ? (attempts.current[task.id] ?? 0) + 1
        : attempts.current[task.id] ?? 1;
      try {
        setConflict(null);
        await taskAction.mutateAsync({
          taskId: task.id,
          action,
          revision: session.revision,
          confirmedMinutes,
          attempt,
        });
        if (action === "start") {
          attempts.current[task.id] = attempt;
          startedAtRef.current = Date.now();
          resetSpans();
        } else {
          startedAtRef.current = null;
        }
      } catch (err) {
        const e = err as Error & { payload?: unknown };
        // The refusal already carried the true session into the cache, so the
        // list below has corrected itself. All that is left is to say so.
        if (e.payload) setConflict(e.message);
        else toastError(err, "That didn't go through. Try again.");
      }
    },
    [session, taskAction, resetSpans],
  );

  const runSession = useCallback(
    async (action: string) => {
      if (!session) return;
      try {
        setConflict(null);
        await sessionAction.mutateAsync({
          sessionId: session.id,
          action,
          revision: session.revision,
        });
        if (action !== "resume") startedAtRef.current = null;
      } catch (err) {
        const e = err as Error & { payload?: unknown };
        if (e.payload) setConflict(e.message);
        else toastError(err, "That didn't go through. Try again.");
      }
    },
    [session, sessionAction],
  );

  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Looking for a session you
        left running.
      </p>
    );
  }

  if (query.isError) {
    return (
      <div className="space-y-2 rounded-xl border p-4">
        <p role="alert" className="text-sm">
          We couldn't reach your session just now. Nothing is lost; it's saved
          on our side.
        </p>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!session || session.state === "completed" || session.state === "abandoned") {
    // AC5: a finished session shows what was FINISHED and the minutes the
    // seller confirmed. Not a projected profit, and not a clock reading they
    // never agreed to.
    // US-3177: shown whenever the session HAD work, not only when something
    // was finished. Pressing "Finish for now" having completed nothing used to
    // make the whole panel vanish with no acknowledgement -- the seller gets
    // no confirmation that the jobs they did not get to were kept, which is
    // exactly the reassurance AC5 is about. Found in the browser against a
    // real session; no unit test asked what an empty finish looks like.
    if (session && (progress.done.length > 0 || progress.leftOverCount > 0)) {
      return (
        <section aria-labelledby="wmt-done" className="space-y-3 rounded-xl border p-4">
          <h2 id="wmt-done" className="text-sm font-medium">
            {session.state === "completed" ? "Session finished" : "Session stopped"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {progress.done.length === 0
              ? "No jobs finished this time."
              : `${progress.done.length} ${
                progress.done.length === 1 ? "job" : "jobs"
              } done${
                progress.confirmedMinutes > 0
                  ? `, ${progress.confirmedMinutes} minutes you confirmed`
                  : ""
              }.`}
          </p>
          {progress.leftOverCount > 0 && (
            <p className="text-sm text-muted-foreground">
              {progress.leftOverCount} left for next time. Nothing was lost.
            </p>
          )}
          {fallback}
        </section>
      );
    }
    return <>{fallback}</>;
  }

  const paused = session.state === "paused";
  // WMT-03: a plan nobody has started yet. The server only lets `planned` go
  // to active or abandoned, so Pause and "Finish for now" would both be
  // refused, and the open session would then block every new plan.
  const planned = session.state === "planned";
  const openCount = progress.upcoming.length + (current ? 1 : 0);

  return (
    <section aria-labelledby="wmt-session" className="space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="wmt-session" className="text-sm font-medium">
          {paused ? "Paused" : "Working through your plan"}
        </h2>
        <p className="text-xs text-muted-foreground">
          {progress.done.length} done · about {progress.remainingMinutes} minutes
          left
        </p>
      </div>

      {conflict && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{conflict} Your list above is up to date now.</span>
        </p>
      )}

      {progress.invalidated.length > 0 && (
        <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
          {progress.invalidated.length}{" "}
          {progress.invalidated.length === 1 ? "job was" : "jobs were"} closed
          because the item sold or moved. The rest of your plan is untouched.
        </p>
      )}

      {current ? (
        <div className="space-y-3">
          <div className="space-y-1">
            {/* WMT-12: the job, then the garment, on two lines rather than
                joined by a dash. */}
            <p className="font-medium">{actionLabel(current.action_key)}</p>
            <p className="break-words text-sm">{current.item_title ?? "Untitled item"}</p>
            <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              {current.bin && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {current.bin}
                </span>
              )}
              {current.estimate_minutes != null && (
                <span>about {current.estimate_minutes} min</span>
              )}
            </p>
          </div>

          {!check.landed && (
            <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              {check.note} You can still mark it done if you know you did it.
            </p>
          )}

          {advice && <AdvicePanel advice={advice} />}

          {current.inventory_item_id && (
            <TaskCorrections
              itemId={current.inventory_item_id}
              actionKey={current.action_key}
              estimateMinutes={current.estimate_minutes ?? null}
              // What is left of the session, so "this no longer fits" means
              // the sitting in hand rather than a plan that is already half
              // spent.
              remainingBudgetMinutes={progress.remainingMinutes}
              sessionId={session?.id ?? null}
            />
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to={itemHref(current.inventory_item_id)}>
                Open item <ArrowRight className="ml-1 h-3 w-3" />
              </Link>
            </Button>

            {progress.currentIsActive
              ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    const from = startedAt();
                    const c = from
                      ? timingCertainty({
                        startedAt: from,
                        endedAt: Date.now(),
                        hidden: spans,
                      })
                      : null;
                    // WMT-09: what the clock saw, or NOTHING. Pre-filling the
                    // estimate meant one tap stored the planner's guess as
                    // confirmed minutes, which the learner then trained on.
                    setMinutes(
                      c && c.observedMinutes > 0 ? String(c.observedMinutes) : "",
                    );
                    setConfirming(current);
                  }}
                >
                  <Check className="mr-1 h-3 w-3" /> Done
                </Button>
              )
              : (
                <Button
                  size="sm"
                  disabled={busy || paused}
                  onClick={() => void runTask(current, "start")}
                >
                  <Play className="mr-1 h-3 w-3" /> Start this one
                </Button>
              )}

            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void runTask(current, "skip")}
            >
              <SkipForward className="mr-1 h-3 w-3" /> Skip
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing left to do in this session.
        </p>
      )}

      {confirming && (
        <ConfirmMinutes
          busy={busy}
          minutes={minutes}
          setMinutes={setMinutes}
          sentence={(() => {
            const from = startedAt();
            if (!from) return "";
            return timingCertainty({
              startedAt: from,
              endedAt: Date.now(),
              hidden: spans,
            }).sentence;
          })()}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const n = confirmableMinutes(minutes);
            if (n === null) return;
            const task = confirming;
            setConfirming(null);
            void runTask(task, "complete", n);
          }}
        />
      )}

      {progress.upcoming.length > 0 && (
        <div className="space-y-1 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">Next up</p>
          <ol className="space-y-1 text-sm text-muted-foreground">
            {progress.upcoming.slice(0, 5).map((t) => (
              <li key={t.id}>
                <span className="block font-medium">{actionLabel(t.action_key)}</span>
                <span className="block break-words">{t.item_title ?? "Untitled item"}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {confirmEnd
        ? (
          <div
            role="group"
            aria-labelledby="wmt-end"
            className="space-y-2 border-t pt-3"
          >
            <p id="wmt-end" className="text-sm">
              End this session? {openCount}{" "}
              {openCount === 1 ? "job" : "jobs"} you haven't done will be kept
              for next time.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  const action = confirmEnd;
                  setConfirmEnd(null);
                  void runSession(action);
                }}
              >
                End session
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setConfirmEnd(null)}
              >
                Keep going
              </Button>
            </div>
          </div>
        )
        : (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {paused && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runSession("resume")}
              >
                <Play className="mr-1 h-3 w-3" aria-hidden="true" /> Pick up where I left off
              </Button>
            )}
            {!paused && !planned && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void runSession("pause")}
              >
                <Pause className="mr-1 h-3 w-3" aria-hidden="true" /> Pause
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmEnd(planned ? "abandon" : "complete")}
            >
              <Square className="mr-1 h-3 w-3" aria-hidden="true" />{" "}
              {planned ? "Throw this plan away" : "Finish for now"}
            </Button>
          </div>
        )}
      <p className="text-xs text-muted-foreground">
        Everything is saved as you go. Closing this page won't lose it.
      </p>
    </section>
  );
}

/**
 * What else the seller could do with this garment (US-3180).
 *
 * EVERY LINE IS A SUGGESTION TO REVIEW. Nothing here lists, delists, donates
 * or deletes; the links go to the seller's own existing screens. It renders
 * only what the model could actually support: an option with no number says
 * so rather than showing a blank, and when the model refused to choose the
 * panel says that too.
 */
/** Cents to dollars. Negative reads as a loss rather than a minus sign. */
function money(cents: number): string {
  const abs = Math.abs(cents) / 100;
  return cents < 0 ? `$${abs.toFixed(2)} down` : `$${abs.toFixed(2)}`;
}

function AdvicePanel({ advice }: { advice: AdviceResult }) {
  // Nothing worth saying: a clear recommendation to carry on is what the
  // seller is already doing, so the panel stays out of the way.
  if (advice.recommended === "continue_prep" && !advice.uncertain) return null;
  const worth = advice.alternatives.filter((a) => a.option !== "continue_prep");
  if (worth.length === 0) return null;

  const why = advice.alternatives.find((a) => a.option === "continue_prep")?.reasons ?? [];
  const headline = advice.uncertain
    ? "We can't tell whether finishing this one pays."
    : why.length > 0
    ? ADVICE_REASON_COPY[why[0]!]
    : "Worth a look before you carry on.";

  return (
    <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm">
      <p className="font-medium">{headline}</p>
      {advice.wholeItemProfitCents != null && (
        <p className="text-xs text-muted-foreground">
          Across its whole life this item is at{" "}
          {money(advice.wholeItemProfitCents)}. That's already spent either
          way, so it isn't part of the choice.
        </p>
      )}
      <ul className="space-y-1">
        {worth.map((a) => (
          <li key={a.option} className="flex flex-wrap items-center gap-x-2">
            <span>{ADVICE_COPY[a.option]}</span>
            {a.reasons.map((r) => (
              <span key={r} className="text-xs text-muted-foreground">
                {ADVICE_REASON_COPY[r]}
              </span>
            ))}
            {a.actionHref && (
              <Link className="text-xs underline" to={a.actionHref}>
                Open
              </Link>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Suggestions only. Nothing here changes a listing.
      </p>
    </div>
  );
}

/**
 * Ask before recording the minutes.
 *
 * THE NUMBER IS OFFERED, NOT ASSERTED (AC3). It arrives filled in with what
 * the clock saw so the common case is one press, and it is editable so the
 * clock never becomes the record by default. When the tab spent time hidden,
 * the sentence above says so without claiming to know which way it went.
 */
function ConfirmMinutes(props: {
  busy: boolean;
  minutes: string;
  setMinutes: (v: string) => void;
  sentence: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const valid = confirmableMinutes(props.minutes) !== null;
  return (
    <form
      aria-labelledby="wmt-confirm"
      className="space-y-2 rounded-lg bg-muted/50 p-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!props.busy && valid) props.onConfirm();
      }}
    >
      <p id="wmt-confirm" className="text-sm font-medium">
        How long did that actually take?
      </p>
      {props.sentence && (
        <p className="text-xs text-muted-foreground">{props.sentence}</p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="wmt-minutes" className="text-xs">
            Minutes
          </Label>
          <Input
            id="wmt-minutes"
            className="w-24"
            type="number"
            min={1}
            max={240}
            inputMode="numeric"
            // The box opens on a question; the cursor belongs in it.
            autoFocus
            value={props.minutes}
            onChange={(e) => props.setMinutes(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={props.busy || !valid}>
          Save and move on
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Not yet
        </Button>
      </div>
    </form>
  );
}
