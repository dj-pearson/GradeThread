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
  useCurrentSession,
  useSessionAction,
  useTaskAction,
  type PlannerSession,
} from "@/hooks/use-planner";
import {
  reconcile,
  sessionProgress,
  timingCertainty,
  type HiddenSpan,
  type SessionTaskView,
} from "@/lib/session-timing";
import { itemHref } from "@/lib/session-links";
import type { ItemListRow } from "@/lib/item-list-columns";

const ACTION_LABELS: Record<string, string> = {
  measure: "Measure",
  photograph: "Photograph",
  review_grade: "Review the grade",
  price_research: "Price it",
  draft_review: "Check the draft",
  publish: "Publish",
  pack_ship: "Pack and ship",
};

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

  const current = progress.current;
  const item = useItemFull(current?.inventory_item_id ?? undefined);
  const check = useMemo(
    () => reconcile(current?.action_key ?? "", item.data as ItemListRow | null),
    [current, item.data],
  );

  const busy = sessionAction.isPending || taskAction.isPending;

  const runTask = useCallback(
    async (task: SessionTaskView, action: string, confirmedMinutes?: number) => {
      if (!session) return;
      if (action === "start") {
        attempts.current[task.id] = (attempts.current[task.id] ?? 0) + 1;
      }
      try {
        setConflict(null);
        await taskAction.mutateAsync({
          taskId: task.id,
          action,
          revision: session.revision,
          confirmedMinutes,
          attempt: attempts.current[task.id] ?? 1,
        });
        if (action === "start") {
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
    if (session && progress.done.length > 0) {
      return (
        <section aria-labelledby="wmt-done" className="space-y-3 rounded-xl border p-4">
          <h2 id="wmt-done" className="text-sm font-medium">
            {session.state === "completed" ? "Session finished" : "Session stopped"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {progress.done.length}{" "}
            {progress.done.length === 1 ? "job" : "jobs"} done
            {progress.confirmedMinutes > 0
              ? `, ${progress.confirmedMinutes} minutes you confirmed`
              : ""}
            .
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
            <p className="font-medium">
              {ACTION_LABELS[current.action_key] ?? current.action_key}
              {" — "}
              {current.item_title ?? "Untitled item"}
            </p>
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
                    const from = startedAtRef.current;
                    const c = from
                      ? timingCertainty({
                        startedAt: from,
                        endedAt: Date.now(),
                        hidden: spans,
                      })
                      : null;
                    setMinutes(
                      String(c?.observedMinutes ?? current.estimate_minutes ?? 0),
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
            const from = startedAtRef.current;
            if (!from) return "";
            return timingCertainty({
              startedAt: from,
              endedAt: Date.now(),
              hidden: spans,
            }).sentence;
          })()}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const n = Number(minutes);
            const task = confirming;
            setConfirming(null);
            void runTask(
              task,
              "complete",
              Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined,
            );
          }}
        />
      )}

      {progress.upcoming.length > 0 && (
        <div className="space-y-1 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">Next up</p>
          <ol className="space-y-1 text-sm text-muted-foreground">
            {progress.upcoming.slice(0, 5).map((t) => (
              <li key={t.id}>
                {ACTION_LABELS[t.action_key] ?? t.action_key} —{" "}
                {t.item_title ?? "Untitled item"}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t pt-3">
        {paused
          ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void runSession("resume")}
            >
              <Play className="mr-1 h-3 w-3" /> Pick up where I left off
            </Button>
          )
          : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void runSession("pause")}
            >
              <Pause className="mr-1 h-3 w-3" /> Pause
            </Button>
          )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void runSession("complete")}
        >
          <Square className="mr-1 h-3 w-3" /> Finish for now
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Everything is saved as you go. Closing this page won't lose it.
      </p>
    </section>
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
  return (
    <div
      role="group"
      aria-labelledby="wmt-confirm"
      className="space-y-2 rounded-lg bg-muted/50 p-3"
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
            inputMode="numeric"
            value={props.minutes}
            onChange={(e) => props.setMinutes(e.target.value)}
          />
        </div>
        <Button size="sm" disabled={props.busy} onClick={props.onConfirm}>
          Save and move on
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Not yet
        </Button>
      </div>
    </div>
  );
}
