// Worth My Time, R1 10/12 (US-3175): turn the minutes a seller has into a
// short, readable plan.
//
// ── IT NEVER HEADLINES MONEY (AC3) ──────────────────────────────────────────
// The single most tempting thing to put at the top of this screen is "$48 in
// 30 minutes", and it would be a lie twice over: the value is a conservative
// estimate against a sale that has not happened, and the minutes are what the
// work takes rather than what the seller will be paid for. So the headline is
// the TIME, every value is labelled as an estimate with a range, and the word
// "earn" appears nowhere.
//
// ── IT DOES NOT COMPETE WITH THE INVENTORY SCREEN (AC1) ─────────────────────
// Every row links out to the item and its real action. Nothing here edits an
// item, and there is no filtering, sorting or bulk selection: the moment this
// grows those it becomes a second inventory screen with worse tools.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Clock, Loader2, MapPin, AlertTriangle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SEO } from "@/components/seo";
import {
  PLAN_STALE_MS,
  clearPlannerPlan,
  planToSessionTasks,
  useBuildPlan,
  useCurrentSession,
  useSaveWorkPreferences,
  useResetSuppression,
  useStartSession,
  usePlannerPlan,
  useWorkOverrides,
  useWorkPreferences,
} from "@/hooks/use-planner";
import { SessionRunner } from "@/components/flipdesk/session-runner";
import { TaskCorrections } from "@/components/flipdesk/task-corrections";
import { ResultsPanel } from "@/components/flipdesk/results-panel";
import { WorkSetupEditor } from "@/components/flipdesk/work-setup-editor";
import { gatedToolLine } from "@/lib/work-setup-copy";
import type { WorkTool } from "@/lib/work-candidates";
import { SUPPRESSION_STATE_COPY } from "@/lib/work-overrides-copy";
import { parkingRows, SUPPRESSION_KINDS, type SuppressionKind } from "@/lib/work-overrides";
import { actionLabel } from "@/lib/work-action-labels";
import { isOwedParcel } from "@/lib/work-ranker";
import { itemHref } from "@/lib/session-links";
import type { RankedTask } from "@/lib/work-ranker";
import type { WorkCandidate } from "@/lib/work-candidates";
import { UNKNOWN_BIN_LABEL } from "@/lib/work-batching";
import { explainOmission, explainTask, whatWouldChangeIt } from "@/lib/work-explain";
import {
  EXPLAIN_FACT_COPY,
  OMISSION_COPY,
  WOULD_CHANGE_COPY,
} from "@/lib/work-explain-copy";

/** Plain sentences, never a score. A seller reads why, not a number. */
const TIER_REASONS: Record<string, string> = {
  urgent_shipping: "Has to go out soon",
  valued_work: "Closest to being ready to sell",
  research: "Needs a price before it can be ranked",
  below_cost: "Likely to cost more than it makes",
  unvalued: "We can't estimate this one yet",
};

/** "6:42pm", the seller's own clock, for "Plan from ..." (WMT-11). */
function planTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m}${h < 12 ? "am" : "pm"}`;
}

const visitedKey = (ownerId: string | null, takenAt: string) =>
  `wmt-visited:${ownerId ?? "-"}:${takenAt}`;

function readVisited(ownerId: string | null, takenAt: string | undefined): Set<string> {
  if (!takenAt) return new Set();
  try {
    const raw = sessionStorage.getItem(visitedKey(ownerId, takenAt));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** "due by 6:42pm", "due tomorrow 9:00am" or "late", for the strip (WMT-13). */
function shipByLabel(at: string, nowMs: number, confidence: string): string {
  const due = Date.parse(at);
  if (!Number.isFinite(due)) return "";
  if (due < nowMs) return "late";
  const sameDay = new Date(due).toDateString() === new Date(nowMs).toDateString();
  const when = `${sameDay ? "" : "tomorrow "}${planTimeLabel(at)}`;
  return confidence === "confirmed" ? `due by ${when}` : `due about ${when}, our estimate`;
}

/** How many left-out jobs are listed by name before "...and N more". */
const OMITTED_SHOWN = 12;

function money(cents: number | null): string | null {
  if (cents == null) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * "Why this task", on demand (US-3181).
 *
 * A <details> rather than a modal or a tooltip, and that is the accessibility
 * answer as much as the design one: it is a native disclosure, reachable and
 * operable from the keyboard with no handler of ours, it degrades to open
 * markup when styles fail, and a screen reader announces its state without
 * being told to.
 *
 * EVERYTHING IT SHOWS COMES FROM THE SNAPSHOT (AC5). It is handed the ranked
 * task and the candidate the plan was built from, never the item. Re-reading
 * the item here would explain a plan that was never made.
 */
function WhyThisTask(props: {
  task: RankedTask;
  candidate: WorkCandidate | null;
  takenAt: string;
  hourlyTargetSet: boolean;
}) {
  // WMT-12: the explanation is only worked out once it is opened. A plan of
  // forty rows used to build forty explanations nobody read.
  const [open, setOpen] = useState(false);
  return (
    <details
      className="text-xs open:basis-full"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="inline-flex min-h-11 cursor-pointer items-center underline">
        Why this one?
      </summary>
      {open && <WhyThisTaskBody {...props} />}
    </details>
  );
}

function WhyThisTaskBody({
  task,
  candidate,
  takenAt,
  hourlyTargetSet,
}: {
  task: RankedTask;
  candidate: WorkCandidate | null;
  takenAt: string;
  hourlyTargetSet: boolean;
}) {
  const explanation = explainTask({
    task,
    // WMT-04/05: the duration and the value the ranker actually ranked on,
    // straight from the snapshot. The value used to be rebuilt here with no
    // marketplace, so it always reported the fee schedule missing and never
    // showed a range.
    duration: task.duration ??
      { unestimated: true, reason: "No duration model for this step." },
    value: task.value,
    shipBy: candidate?.shipBy
      ? { at: candidate.shipBy.at, confidence: candidate.shipBy.confidence }
      : undefined,
    takenAt,
    now: new Date().toISOString(),
    hourlyTargetSet,
  });
  const change = whatWouldChangeIt(explanation);

  return (
    <>
      <div className="mt-2 w-full space-y-2 rounded-lg bg-muted/50 p-3 text-left sm:max-w-sm">
        <ul className="space-y-1">
          {explanation.facts.map((f) => (
            <li key={f}>{EXPLAIN_FACT_COPY[f]}</li>
          ))}
        </ul>
        <dl className="space-y-0.5 text-muted-foreground">
          {explanation.timing.activeMinutes != null && (
            <div>
              <dt className="inline">Hands-on: </dt>
              <dd className="inline">
                about {explanation.timing.activeMinutes} min
                {explanation.timing.setupMinutes
                  ? `, plus ${explanation.timing.setupMinutes} to set up`
                  : ""}
              </dd>
            </div>
          )}
          <div>
            <dt className="inline">Left on this item: </dt>
            <dd className="inline">about {explanation.timing.chainMinutes} min</dd>
          </div>
          {explanation.value.lowCents != null && explanation.value.highCents != null && (
            <div>
              <dt className="inline">Worth: </dt>
              <dd className="inline">
                {money(explanation.value.lowCents)} to{" "}
                {money(explanation.value.highCents)}, if it sells
              </dd>
            </div>
          )}
          {explanation.timing.sampleCount != null && (
            <div>
              <dt className="inline">Based on: </dt>
              <dd className="inline">
                {explanation.timing.sampleCount} of your finished jobs
              </dd>
            </div>
          )}
        </dl>
        {explanation.conflict && <p>{explanation.conflict.message}</p>}
        {change && WOULD_CHANGE_COPY[change] && (
          <p className="font-medium">{WOULD_CHANGE_COPY[change]}</p>
        )}
      </div>
    </>
  );
}

export function WorthMyTimePage() {
  const prefs = useWorkPreferences();
  const savePrefs = useSaveWorkPreferences();
  const build = useBuildPlan();
  const currentSession = useCurrentSession();
  const startSession = useStartSession();
  const [custom, setCustom] = useState("");
  // WMT-11: the plan survives "Open item" and back. It lives in the query
  // cache keyed by workspace owner, mirrored to sessionStorage, rather than
  // in state that a remount throws away.
  const qc = useQueryClient();
  const { plan, setPlan, ownerId } = usePlannerPlan();
  const [visited, setVisited] = useState<Set<string>>(() =>
    readVisited(ownerId, plan?.takenAt)
  );
  useEffect(() => {
    setVisited(readVisited(ownerId, plan?.takenAt));
  }, [ownerId, plan?.takenAt]);
  function markVisited(key: string) {
    if (!plan) return;
    const next = new Set(visited).add(key);
    setVisited(next);
    try {
      sessionStorage.setItem(visitedKey(ownerId, plan.takenAt), JSON.stringify([...next]));
    } catch {
      // A tick that cannot be remembered is a convenience lost, nothing more.
    }
  }
  // A workspace switch drops the previous owner's plan outright, so it can
  // never be shown against another tenant's stock.
  const lastOwner = useRef(ownerId);
  useEffect(() => {
    if (lastOwner.current !== ownerId) {
      clearPlannerPlan(qc, lastOwner.current);
      lastOwner.current = ownerId;
    }
  }, [ownerId, qc]);
  // A plan that has sat for a quarter of an hour is flagged, not replaced.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const planIsOld = plan != null && nowMs - Date.parse(plan.takenAt) > PLAN_STALE_MS;
  // Set only when a correction lands AFTER a plan was built. The plan on
  // screen is the one the seller agreed to, so it is never replaced under
  // them -- they are told it is out of date and press the button (AC2).
  const [stalePlan, setStalePlan] = useState(false);
  // WMT-12: which control asked for the build, so only that one spins.
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  // WMT-12: after a build, focus moves to the headline so a keyboard or
  // screen-reader user lands on the answer rather than on the button.
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const focusHeadline = useRef(false);
  useEffect(() => {
    if (plan && focusHeadline.current) {
      focusHeadline.current = false;
      headlineRef.current?.focus();
    }
  }, [plan]);
  const liveOverrides = useWorkOverrides();
  const unsuppress = useResetSuppression();
  const [broughtBack, setBroughtBack] = useState<Set<string>>(() => new Set());

  const presets = prefs.data?.sessionMinutePresets ?? [15, 30, 60];
  // WMT-07: a plan built before the setup loads would be built on the
  // camera-only defaults. Wait for an answer, success or failure.
  const prefsSettled = prefs.isSuccess || prefs.isError;
  const context = prefs.data?.workContext ?? "home";
  const tools = useMemo(() => prefs.data?.availableTools ?? ["camera"], [prefs.data]);

  async function generate(minutes: number, from = String(minutes)) {
    if (
      !Number.isInteger(minutes) ||
      minutes < (prefs.data?.minSessionMinutes ?? 5) ||
      minutes > (prefs.data?.maxSessionMinutes ?? 240)
    ) {
      toast.error(
        `Choose between ${prefs.data?.minSessionMinutes ?? 5} and ${prefs.data?.maxSessionMinutes ?? 240} minutes.`,
      );
      return;
    }
    setPendingFrom(from);
    try {
      const built = await build.mutateAsync({
        budgetMinutes: minutes,
        workContext: context,
        availableTools: tools,
        hourlyTargetCents: prefs.data?.hourlyTargetAmount != null
          ? Math.round(prefs.data.hourlyTargetAmount * 100)
          : null,
        // WMT-07: buildPlan reads the corrections (fresh, and a failure
        // refuses the build) and the learned pace itself, in parallel with
        // the items.
        sessionId: currentSession.data?.session?.id ?? null,
      });
      setStalePlan(false);
      // AC5: a failed build leaves the previous plan on screen. setPlan runs
      // only on success, so a dropped connection never blanks the page.
      focusHeadline.current = true;
      setPlan(built);
      setNowMs(Date.now());
      setBroughtBack(new Set());
      // WMT-12: nothing to remember when it is already the saved default.
      if (minutes !== prefs.data?.defaultSessionMinutes) {
        void savePrefs.mutateAsync({ default_session_minutes: minutes }).catch(() => {
          // Remembering the choice is a convenience. Failing to remember it
          // must not look like failing to plan.
        });
      }
    } catch (err) {
      // US-2869 AC4: the seller gets our sentence, not PostgREST's.
      toastError(err, "Couldn't build a plan just now.");
    } finally {
      setPendingFrom(null);
    }
  }

  /**
   * Undo one set-aside from the plan's list (WMT-12), scoped the way the
   * corrections panel scopes it (WMT-02): the rows parking THIS job under
   * THIS reason, and no other.
   */
  async function bringBack(note: { itemId: string; actionKey: string; reason: SuppressionKind }) {
    const book = liveOverrides.data;
    const sessionId = currentSession.data?.session?.id ?? null;
    const rows = book
      ? parkingRows(book, {
        itemId: note.itemId,
        actionKey: note.actionKey,
        sessionId,
        kind: note.reason,
      })
      : [];
    const targets = rows.length > 0 ? rows : [{
      actionKey: note.reason === "dismiss" ? null : note.actionKey,
      sessionId: note.reason === "skip_session" ? sessionId : null,
    }];
    try {
      for (const r of targets) {
        await unsuppress.mutateAsync({
          inventoryItemId: note.itemId,
          kind: note.reason,
          actionKey: r.actionKey,
          sessionId: r.sessionId,
        });
      }
      setBroughtBack((prev) => new Set(prev).add(`${note.itemId}:${note.actionKey}`));
      setStalePlan(true);
      toast.success("Back on the list. Build the plan again to see it.");
    } catch (err) {
      toastError(err, "Couldn't bring that back.");
    }
  }

  async function beginSession() {
    if (!plan || plan.plan.tasks.length === 0) return;
    try {
      await startSession.mutateAsync({
        budget_minutes: plan.budgetMinutes,
        work_context: context,
        available_tools: tools,
        tasks: planToSessionTasks(plan),
      });
    } catch (err) {
      toastError(err, "Couldn't start that session just now.");
    }
  }

  // One session at a time, which is the server's rule too (00818 has a partial
  // unique index for it). Offering Start while one is open would produce a
  // refusal the seller could do nothing useful with.
  const sessionOpen = ["planned", "active", "paused"].includes(
    currentSession.data?.session?.state ?? "",
  );

  const scheduled = plan?.plan.tasks ?? [];
  // WMT-06: how many jobs each missing tool is holding back. An item held by
  // two tools counts under both, because either one alone would not free it.
  const gatedByTool = useMemo(() => {
    const counts = new Map<WorkTool, number>();
    for (const g of plan?.gated ?? []) {
      if (g.reason !== "tools") continue;
      for (const t of g.missing) {
        if (tools.includes(t)) continue;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()];
  }, [plan, tools]);

  async function addTool(tool: WorkTool) {
    if (tools.includes(tool)) return;
    try {
      // One field, the whole new list: the route writes only this column.
      await savePrefs.mutateAsync({ available_tools: [...tools, tool] });
      setStalePlan(true);
    } catch (err) {
      toastError(err, "Couldn't save your setup.");
    }
  }
  const rankedByKey = useMemo(
    () => new Map((plan?.ranked ?? []).map((r) => [r.key, r])),
    [plan],
  );
  // WMT-12: one lookup table instead of a candidates.find per row, per render.
  // Plans saved before WMT-13 have no strip; treat that as none.
  const shipToday = useMemo(() => plan?.shipToday ?? [], [plan]);
  /** Minutes for just the parcels due today: their high estimates plus one setup. */
  const parcelMinutes = useMemo(() => {
    let total = 0;
    let setup = 0;
    for (const p of shipToday) {
      const d = rankedByKey.get(p.key)?.duration;
      total += d?.high ?? 0;
      setup = Math.max(setup, d?.setupMinutes ?? 0);
    }
    const min = prefs.data?.minSessionMinutes ?? 5;
    const max = prefs.data?.maxSessionMinutes ?? 240;
    const rounded = Math.ceil((total + setup) / 5) * 5;
    return Math.min(max, Math.max(min, rounded));
  }, [shipToday, rankedByKey, prefs.data]);
  const candidateByKey = useMemo(
    () => new Map((plan?.candidates ?? []).map((c) => [c.key, c])),
    [plan],
  );
  const suppressedByReason = useMemo(() => {
    const groups = new Map<SuppressionKind, NonNullable<typeof plan>["suppressed"]>();
    for (const n of plan?.suppressed ?? []) {
      groups.set(n.reason, [...(groups.get(n.reason) ?? []), n]);
    }
    return SUPPRESSION_KINDS.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)!] as const);
  }, [plan]);

  return (
    <div className="space-y-6">
      <SEO title="Worth My Time" noindex />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Worth My Time</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Tell us how long you have. We'll pick work from what you already own
          and put the most useful first.
        </p>
      </header>

      <section
        aria-labelledby="wmt-how-long"
        className="space-y-3 rounded-xl border p-4"
      >
        <h2 id="wmt-how-long" className="text-sm font-medium">
          How long have you got?
        </h2>
        <div className="flex flex-wrap items-end gap-2">
          {presets.map((m) => (
            <Button
              key={m}
              variant="outline"
              disabled={build.isPending || !prefsSettled}
              onClick={() => void generate(m)}
            >
              {pendingFrom === String(m)
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                : null}
              {m} minutes
            </Button>
          ))}
          <div className="space-y-1">
            <Label htmlFor="wmt-custom" className="text-xs text-muted-foreground">
              Or type it
            </Label>
            {/* WMT-12: a real form, so Enter in the box builds the plan. */}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (build.isPending || !prefsSettled || custom.trim() === "") return;
                void generate(Number(custom), "custom");
              }}
            >
              <Input
                id="wmt-custom"
                className="w-24"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="45"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
              <Button
                type="submit"
                disabled={build.isPending || !prefsSettled || custom.trim() === ""}
              >
                {pendingFrom === "custom"
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  : null}
                Plan it
              </Button>
            </form>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Working {context === "phone_only" ? "away from your table" : "at home"}
          {tools.length > 0 ? ` with ${tools.join(", ").replace(/_/g, " ")}` : ""}.
          {" "}
          {/* WMT-06: the setup is edited right here. This used to link to the
              inventory screen, which has no setup controls. */}
          <button
            type="button"
            className="underline"
            onClick={() => {
              const el = document.getElementById("wmt-setup");
              el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
              el?.querySelector("button")?.focus();
            }}
          >
            Change your setup
          </button>
        </p>
        <WorkSetupEditor
          prefs={prefs.data}
          onChanged={() => {
            if (plan) setStalePlan(true);
          }}
        />
      </section>

      <SessionRunner />

      {/* R2 06/06 (US-3183). Below the picker and the runner on purpose: a
          seller opening this page wants to plan an evening, and the scorecard
          is what they check once a month. */}
      <ResultsPanel />

      {prefs.isError && (
        <p role="alert" className="text-sm text-destructive">
          We couldn't load your setup. The planner will use sensible defaults
          until it comes back.
        </p>
      )}

      {plan && (
        <section aria-labelledby="wmt-plan" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="wmt-plan"
              ref={headlineRef}
              tabIndex={-1}
              className="text-xl font-semibold tabular-nums outline-none"
            >
              {scheduled.length === 0
                ? "Nothing fits that window"
                : `${scheduled.length} ${scheduled.length === 1 ? "job" : "jobs"}, about ${plan.plan.plannedMinutes} minutes`}
            </h2>
            {/* AC3: estimates are never presented as earnings. This line is
                the whole guard against the screen reading as a payday. */}
            <p className="text-xs text-muted-foreground">
              Plan from {planTimeLabel(plan.takenAt)}. Times and values are
              estimates, not earnings.
            </p>
          </div>

          {/* WMT-13: what has to go out within a day, above everything
              else. The ranker already puts these first; the strip says by
              when, and sizes a plan to just them in one tap. */}
          {shipToday.length > 0 && (
            <div
              aria-labelledby="wmt-ship-today"
              className="space-y-2 rounded-lg border p-3 text-sm"
              role="group"
            >
              <h3 id="wmt-ship-today" className="font-medium">Ship today</h3>
              <ul className="space-y-1">
                {shipToday.map((p) => (
                  <li key={p.key} className="flex flex-wrap justify-between gap-x-3">
                    <span className="min-w-0 break-words">{p.itemTitle ?? "Untitled item"}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {shipByLabel(p.at, nowMs, p.confidence)}
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="outline"
                disabled={build.isPending}
                onClick={() => void generate(parcelMinutes, "parcels")}
              >
                Plan the parcels first
              </Button>
            </div>
          )}

          {(stalePlan || planIsOld) && (
            <p
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm"
            >
              <span>
                {stalePlan
                  ? "You changed something since this plan was built. It still shows the old numbers."
                  : `This plan is from ${planTimeLabel(plan.takenAt)}. Your stock may have moved since.`}
              </span>
              <Button
                size="sm"
                disabled={build.isPending}
                onClick={() => void generate(plan.budgetMinutes)}
              >
                Build it again
              </Button>
            </p>
          )}

          {/* AC3: what was left out because the seller set it aside, said
              rather than silently missing. A plan that quietly shrinks is a
              plan a seller thinks is broken. */}
          {plan.suppressed.length > 0 && (
            <details className="rounded-lg border p-3 text-sm">
              <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium">
                {plan.suppressed.length}{" "}
                {plan.suppressed.length === 1 ? "job is" : "jobs are"} set aside
              </summary>
              {/* WMT-12: grouped by reason, so each job carries its own
                  reason rather than the first one's, and each can come back. */}
              <div className="mt-2 space-y-3">
                {suppressedByReason.map(([reason, notes]) => (
                  <div key={reason} className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {SUPPRESSION_STATE_COPY[reason]}
                    </p>
                    <ul className="space-y-1">
                      {notes.map((n) => {
                        const k = `${n.itemId}:${n.actionKey}`;
                        return (
                          <li key={k} className="flex flex-wrap items-center justify-between gap-2">
                            <span className="min-w-0 break-words">
                              <span className="block font-medium">{actionLabel(n.actionKey)}</span>
                              <span className="block">{n.itemTitle ?? "Untitled item"}</span>
                            </span>
                            {broughtBack.has(k)
                              ? <span className="text-xs text-muted-foreground">Back on the list</span>
                              : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={unsuppress.isPending}
                                  onClick={() => void bringBack(n)}
                                >
                                  Bring back
                                </Button>
                              )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* WMT-06: work the seller's setup is holding back, counted per
              tool, with the one tap that fixes it. */}
          {gatedByTool.map(([tool, count]) => (
            <p
              key={tool}
              className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
            >
              <span>{gatedToolLine(tool, count)}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void addTool(tool)}
              >
                I have one
              </Button>
            </p>
          ))}

          {scheduled.length > 0 && !sessionOpen && (
            <Button
              disabled={startSession.isPending}
              onClick={() => void beginSession()}
            >
              {startSession.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                : null}
              Start working through this
            </Button>
          )}
          {scheduled.length > 0 && sessionOpen && (
            <p className="text-sm text-muted-foreground">
              You have a session going. Finish or end it above to start this plan.
            </p>
          )}

          {/* WMT-12: ONE announcement for every conflict, not an alert each. */}
          {plan.plan.conflicts.length > 0 && (
            <div role="status" data-testid="wmt-conflicts" className="space-y-2">
              {plan.plan.conflicts.map((c) => (
                <div
                  key={c.key}
                  className="flex flex-wrap items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    {c.message} Try {c.proposedBudgetMinutes} minutes instead.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={build.isPending}
                    onClick={() => void generate(c.proposedBudgetMinutes, `conflict:${c.key}`)}
                  >
                    Plan {c.proposedBudgetMinutes} minutes
                  </Button>
                </div>
              ))}
            </div>
          )}

          {scheduled.length === 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              <span>
                {plan.plan.smallestEligibleMinutes != null
                  ? `The shortest job waiting needs about ${plan.plan.smallestEligibleMinutes} minutes.`
                  : "There's no unfinished work in your stock right now."}
              </span>
              {plan.plan.smallestEligibleMinutes != null && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={build.isPending}
                  onClick={() =>
                    void generate(plan.plan.smallestEligibleMinutes!, "smallest")}
                >
                  Plan {plan.plan.smallestEligibleMinutes} minutes
                </Button>
              )}
            </div>
          )}

          {plan.pullList.length > 0 && (
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              <p className="font-medium">Bring these over</p>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {plan.pullList.map((p) => (
                  <li key={p.label} className="flex items-start gap-2">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {p.label}: {p.itemIds.length}{" "}
                      {p.itemIds.length === 1 ? "item" : "items"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ol className="space-y-2">
            {scheduled.map((task, i) => {
              const r = rankedByKey.get(task.key);
              const candidate = candidateByKey.get(task.key) ?? null;
              // WMT-04: what the plan CHARGED for this row, so the rows plus
              // their setup add up to the headline.
              const minutes = task.activeMinutes;
              const low = money(r?.conservativeCents ?? null);
              const bin = candidate?.bin;
              return (
                <li key={task.key} className="space-y-2 rounded-xl border p-3">
                  {/* WMT-12: content first, then a wrapping action bar. An
                      open panel takes the full width of the row, so two open
                      panels never push the page sideways on a phone. */}
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">
                      <span className="text-muted-foreground">{i + 1}. </span>
                      {actionLabel(r?.action)}
                      {visited.has(task.key) && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          (opened)
                        </span>
                      )}
                    </p>
                    <p className="break-words text-sm">
                      {candidate?.itemTitle ?? "Untitled item"}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        about {minutes} min
                        {task.overheadMinutes > 0
                          ? ` +${task.overheadMinutes} to set up`
                          : ""}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3" aria-hidden="true" />
                        {bin?.value ?? UNKNOWN_BIN_LABEL}
                      </span>
                      <span>{TIER_REASONS[r?.tier ?? ""] ?? ""}</span>
                      {low && (
                        <span>
                          worth about {low} after costs, if it sells
                        </span>
                      )}
                    </p>
                    {r?.conflict && (
                      <p className="text-xs text-destructive">{r.conflict.message}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <Link
                        to={itemHref(task.itemId)}
                        onClick={() => markVisited(task.key)}
                      >
                        Open item <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
                      </Link>
                    </Button>
                    {r && (
                      <WhyThisTask
                        task={r}
                        candidate={candidate}
                        takenAt={plan.takenAt}
                        hourlyTargetSet={prefs.data?.hourlyTargetSet === true}
                      />
                    )}
                    {r && (
                      <TaskCorrections
                        itemId={r.itemId}
                        actionKey={r.action}
                        estimateMinutes={minutes}
                        chargedMinutes={minutes}
                        remainingBudgetMinutes={Math.max(
                          0,
                          plan.budgetMinutes - plan.plan.plannedMinutes,
                        )}
                        sessionId={currentSession.data?.session?.id ?? null}
                        // WMT-13: the same rule buildPlan uses, so the panel
                        // never offers to hide a parcel the plan would not.
                        urgentShipping={isOwedParcel({ action: r.action })}
                        onChanged={() => setStalePlan(true)}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {plan.truncated && (
            <p className="text-xs text-muted-foreground">
              We looked at your {plan.itemsRead} most recently updated items.
            </p>
          )}

          {plan.plan.omitted.length > 0 && (
            <details className="rounded-lg border p-3 text-sm">
              <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium">
                {plan.plan.omitted.length} job
                {plan.plan.omitted.length === 1 ? "" : "s"} didn't make the list
              </summary>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {plan.plan.omitted.slice(0, OMITTED_SHOWN).map((o) => {
                  const e = explainOmission(o);
                  const title = candidateByKey.get(o.key)?.itemTitle;
                  return (
                    <li key={o.key}>
                      {/* User-supplied text, rendered as TEXT (AC5). React
                          escapes it and this file has no dangerouslySetInnerHTML. */}
                      <span className="block break-words text-foreground">
                        {title ?? "Untitled item"}
                      </span>
                      <span className="block">
                        {OMISSION_COPY[e.reason]}
                        {e.minutes != null ? ` (about ${e.minutes} min)` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {plan.plan.omitted.length > OMITTED_SHOWN && (
                <p className="mt-2 text-muted-foreground">
                  ...and {plan.plan.omitted.length - OMITTED_SHOWN} more.
                </p>
              )}
            </details>
          )}
        </section>
      )}
    </div>
  );
}
