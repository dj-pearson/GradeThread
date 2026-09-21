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

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Clock, Loader2, MapPin, AlertTriangle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SEO } from "@/components/seo";
import {
  planToSessionTasks,
  useBuildPlan,
  useCurrentSession,
  useSaveWorkPreferences,
  useStartSession,
  useWorkPreferences,
  type PreparedPlan,
} from "@/hooks/use-planner";
import { SessionRunner } from "@/components/flipdesk/session-runner";
import { itemHref } from "@/lib/session-links";
import { estimateDuration, isUnestimated } from "@/lib/work-duration";
import type { RankedTask } from "@/lib/work-ranker";
import type { WorkCandidate } from "@/lib/work-candidates";
import { UNKNOWN_BIN_LABEL } from "@/lib/work-batching";
import { explainOmission, explainTask, whatWouldChangeIt } from "@/lib/work-explain";
import {
  EXPLAIN_FACT_COPY,
  OMISSION_COPY,
  WOULD_CHANGE_COPY,
} from "@/lib/work-explain-copy";
import { estimateWorkValue } from "@/lib/work-value";

const ACTION_LABELS: Record<string, string> = {
  measure: "Measure",
  photograph: "Photograph",
  review_grade: "Review the grade",
  price_research: "Price it",
  draft_review: "Check the draft",
  publish: "Publish",
  pack_ship: "Pack and ship",
};

/** Plain sentences, never a score. A seller reads why, not a number. */
const TIER_REASONS: Record<string, string> = {
  urgent_shipping: "Has to go out soon",
  valued_work: "Closest to being ready to sell",
  research: "Needs a price before it can be ranked",
  unvalued: "We can't estimate this one yet",
};

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
function WhyThisTask({
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
    duration: estimateDuration({ action: task.action }),
    // The same estimator call the plan made, from the snapshot's own numbers.
    // It is rebuilt rather than stored because ValueResult is not carried on
    // the ranked task; the INPUTS are the snapshot's, which is what AC5 asks.
    value: estimateWorkValue({
      marketplace: null,
      evidence: task.conservativeCents != null
        ? {
          amountCents: task.conservativeCents,
          source: "seller_estimate",
          observedAt: takenAt,
        }
        : null,
    }),
    shipBy: candidate?.shipBy
      ? { at: candidate.shipBy.at, confidence: candidate.shipBy.confidence }
      : undefined,
    takenAt,
    now: new Date().toISOString(),
    hourlyTargetSet,
  });
  const change = whatWouldChangeIt(explanation);

  return (
    <details className="text-xs">
      <summary className="cursor-pointer underline">Why this one?</summary>
      <div className="mt-2 w-64 space-y-2 rounded-lg bg-muted/50 p-3 text-left">
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
        {explanation.conflict && (
          <p role="alert">{explanation.conflict.message}</p>
        )}
        {change && WOULD_CHANGE_COPY[change] && (
          <p className="font-medium">{WOULD_CHANGE_COPY[change]}</p>
        )}
      </div>
    </details>
  );
}

export function WorthMyTimePage() {
  const prefs = useWorkPreferences();
  const savePrefs = useSaveWorkPreferences();
  const build = useBuildPlan();
  const currentSession = useCurrentSession();
  const startSession = useStartSession();
  const [custom, setCustom] = useState("");
  const [plan, setPlan] = useState<PreparedPlan | null>(null);

  const presets = prefs.data?.sessionMinutePresets ?? [15, 30, 60];
  const context = prefs.data?.workContext ?? "home";
  const tools = useMemo(() => prefs.data?.availableTools ?? ["camera"], [prefs.data]);

  async function generate(minutes: number) {
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
    try {
      const built = await build.mutateAsync({
        budgetMinutes: minutes,
        workContext: context,
        availableTools: tools,
        hourlyTargetCents: prefs.data?.hourlyTargetAmount != null
          ? Math.round(prefs.data.hourlyTargetAmount * 100)
          : null,
      });
      // AC5: a failed build leaves the previous plan on screen. setPlan runs
      // only on success, so a dropped connection never blanks the page.
      setPlan(built);
      void savePrefs.mutateAsync({ default_session_minutes: minutes }).catch(() => {
        // Remembering the choice is a convenience. Failing to remember it must
        // not look like failing to plan.
      });
    } catch (err) {
      // US-2869 AC4: the seller gets our sentence, not PostgREST's.
      toastError(err, "Couldn't build a plan just now.");
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
  const rankedByKey = useMemo(
    () => new Map((plan?.ranked ?? []).map((r) => [r.key, r])),
    [plan],
  );

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
              disabled={build.isPending}
              onClick={() => void generate(m)}
            >
              {m} minutes
            </Button>
          ))}
          <div className="space-y-1">
            <Label htmlFor="wmt-custom" className="text-xs text-muted-foreground">
              Or type it
            </Label>
            <div className="flex gap-2">
              <Input
                id="wmt-custom"
                className="w-24"
                inputMode="numeric"
                placeholder="45"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
              <Button
                disabled={build.isPending || custom.trim() === ""}
                onClick={() => void generate(Number(custom))}
              >
                {build.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : null}
                Plan it
              </Button>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Working {context === "phone_only" ? "away from your table" : "at home"}
          {tools.length > 0 ? ` with ${tools.join(", ").replace(/_/g, " ")}` : ""}.
          {" "}
          <Link className="underline" to="/dashboard/flipdesk/inventory">
            Change your setup
          </Link>
        </p>
      </section>

      <SessionRunner />

      {prefs.isError && (
        <p role="alert" className="text-sm text-destructive">
          We couldn't load your setup. The planner will use sensible defaults
          until it comes back.
        </p>
      )}

      {plan && (
        <section aria-labelledby="wmt-plan" className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="wmt-plan" className="text-sm font-medium">
              {scheduled.length === 0
                ? "Nothing fits that window"
                : `${scheduled.length} ${scheduled.length === 1 ? "job" : "jobs"}, about ${plan.plan.plannedMinutes} minutes`}
            </h2>
            {/* AC3: estimates are never presented as earnings. This line is
                the whole guard against the screen reading as a payday. */}
            <p className="text-xs text-muted-foreground">
              Times and values are estimates, not earnings.
            </p>
          </div>

          {scheduled.length > 0 && !sessionOpen && (
            <Button
              disabled={startSession.isPending}
              onClick={() => void beginSession()}
            >
              {startSession.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : null}
              Start working through this
            </Button>
          )}

          {plan.plan.conflicts.map((c) => (
            <p
              key={c.key}
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {c.message} Try {c.proposedBudgetMinutes} minutes instead.
              </span>
            </p>
          ))}

          {scheduled.length === 0 && (
            <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              {plan.plan.smallestEligibleMinutes != null
                ? `The shortest job waiting needs about ${plan.plan.smallestEligibleMinutes} minutes.`
                : "There's no unfinished work in your stock right now."}
            </p>
          )}

          {plan.pullList.length > 0 && (
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              <p className="font-medium">Bring these over</p>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {plan.pullList.map((p) => (
                  <li key={p.label} className="flex items-start gap-2">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
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
              const d = estimateDuration({ action: r?.action ?? "measure" });
              const minutes = isUnestimated(d) ? null : d.typical;
              const low = money(r?.conservativeCents ?? null);
              const bin = plan.candidates.find((c) => c.itemId === task.itemId)?.bin;
              return (
                <li
                  key={task.key}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-xl border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">
                      <span className="text-muted-foreground">{i + 1}. </span>
                      {ACTION_LABELS[r?.action ?? ""] ?? r?.action}
                      {" — "}
                      {plan.candidates.find((c) => c.itemId === task.itemId)
                        ?.itemTitle ?? "Untitled item"}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        about {minutes ?? "?"} min
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
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
                      <p role="alert" className="text-xs text-destructive">
                        {r.conflict.message}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {r && (
                      <WhyThisTask
                        task={r}
                        candidate={plan.candidates.find((c) => c.key === r.key) ?? null}
                        takenAt={plan.takenAt}
                        hourlyTargetSet={prefs.data?.hourlyTargetSet === true}
                      />
                    )}
                    <Button variant="outline" size="sm" asChild>
                      <Link to={itemHref(task.itemId)}>
                        Open item <ArrowRight className="ml-1 h-3 w-3" />
                      </Link>
                    </Button>
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
              <summary className="cursor-pointer font-medium">
                {plan.plan.omitted.length} job
                {plan.plan.omitted.length === 1 ? "" : "s"} didn't make the list
              </summary>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {plan.plan.omitted.slice(0, 12).map((o) => {
                  const e = explainOmission(o);
                  const title = plan.candidates.find((c) => c.key === o.key)?.itemTitle;
                  return (
                    <li key={o.key}>
                      {/* User-supplied text, rendered as TEXT (AC5). React
                          escapes it and this file has no dangerouslySetInnerHTML. */}
                      <span className="break-words">{title ?? "Untitled item"}</span>
                      {" — "}
                      {OMISSION_COPY[e.reason]}
                      {e.minutes != null ? ` (about ${e.minutes} min)` : ""}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
