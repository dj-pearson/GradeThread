import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1915 AC3: the rewards north-star surface.
//
// Reward Economics answers "what is the tangible rail costing?". This one
// answers the question the gamification epic is actually judged on: is any of
// it moving retention, and at what price.
//
// ⚠ EVERY NUMBER HERE CAN BE ABSENT, AND ABSENT IS RENDERED AS "—" WITH ITS
// REASON, NEVER AS 0. The server returns null for a ratio whose denominator is
// empty, because "no retained users yet" and "cost per retained user is $0" are
// opposite claims. A dashboard that prints 0 for both is the specific way this
// page could do more harm than having no page — someone would quote the zero.
//
// The ONE control here is the per-mechanic switchboard at the bottom, and it is
// here rather than on Reward Economics because the reason to flip it is
// something you just read in the numbers above. The money switch stays on
// Reward Economics and the per-quest switch on Quests: those answer "stop the
// spend" and "retire this quest", which are not this page's question.

interface Retention {
  eligible: number;
  retained: number;
  rate: number | null;
  undecided: number;
}

interface NorthStarResponse {
  window_days: number;
  since: string;
  cohort_since: string;
  truncated: boolean;
  cohort_size: number;
  report: {
    retention: Retention;
    retentionComparison: {
      gamified: Retention;
      notGamified: Retention;
      gapPp: number | null;
      caveat: string;
      causal: false;
    };
    gradesPerUser: { grades: number; activeUsers: number; perUser: number | null };
    kFactor:
      | { available: false; reason: string }
      | {
        available: true;
        sharers: number;
        shares: number;
        conversions: number;
        sharesPerSharer: number | null;
        conversionRate: number | null;
        k: number | null;
      };
    costPerRetained: {
      costUsd: number;
      retained: number;
      perRetainedUsd: number | null;
      uncommittedGrants: number;
    };
  };
}

interface Mechanic {
  key: string;
  enabled: boolean;
  xp: number;
}

interface MechanicsResponse {
  mechanics: Mechanic[];
  re_enable_backfills: boolean;
}

const WINDOWS = [30, 60, 90, 180] as const;

/** `quest_completed` → `Quest completed`. The wire name stays visible below it. */
function mechanicLabel(key: string): string {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A rate as a percentage, or an em dash. Never "0%" for "we don't know". */
function pct(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function num(n: number | null, prefix = ""): string {
  return n === null ? "—" : `${prefix}${n}`;
}

/**
 * One headline number plus the denominator it was divided by.
 *
 * The denominator is shown ALWAYS, not on hover: every metric on this page is a
 * ratio whose meaning lives in what it divided by, and a retention rate over
 * four eligible users is a different fact from the same rate over four hundred.
 */
function Metric(
  { label, value, denominator, note }: {
    label: string;
    value: string;
    denominator: string;
    note?: string;
  },
) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
        <p className="mt-1 text-sm text-muted-foreground">{denominator}</p>
        {note ? <p className="mt-2 text-xs text-muted-foreground">{note}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The per-mechanic switchboard (US-1915 AC3).
 *
 * It sits on THIS page rather than on Reward Economics on purpose: the reason to
 * turn a mechanic off is something you just read in the numbers above, and a
 * switch on a different screen is one an operator flips without the evidence in
 * front of them.
 */
function MechanicSwitchboard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<MechanicsResponse>({
    queryKey: ["admin-reward-mechanics"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/rewards/mechanics");
      if (!res.ok) throw new Error("Failed to load reward mechanics");
      return res.json();
    },
  });

  const toggle = useMutation({
    mutationFn: async (m: Mechanic) => {
      const res = await edgeFetch("/api/admin/rewards/mechanics", {
        method: "POST",
        body: JSON.stringify({ key: m.key, enabled: !m.enabled }),
      });
      if (!res.ok) throw new Error("Failed to change the switch");
      return res.json();
    },
    onSuccess: (_d, m) => {
      toast.success(`${mechanicLabel(m.key)} ${m.enabled ? "switched off" : "switched on"}`);
      void qc.invalidateQueries({ queryKey: ["admin-reward-mechanics"] });
    },
    onError: () => toast.error("Couldn't change that switch."),
  });

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data) return null;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Mechanics</h2>
          <p className="text-sm text-muted-foreground">
            Switch one mechanic off and watch the numbers above. Takes effect
            within the settings cache TTL, no deploy.
          </p>
        </div>

        {/* Stated before the switches, not after. Someone reaching for these is
            about to run an experiment, and "it will pay out the backlog when I
            turn it back on" is the assumption that would ruin the reading. */}
        <div className="flex gap-3 rounded-xl bg-amber-500/10 p-4 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-amber-900 dark:text-amber-200">
            Switching a mechanic off stops its events being written, so the XP is
            not deferred — it never happens. Turning it back on resumes new grants
            and does not backfill the gap. This is an experiment control, not a
            pause button.
          </p>
        </div>

        <ul className="divide-y">
          {data.mechanics.map((m) => (
            <li key={m.key} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{mechanicLabel(m.key)}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {m.key} · {m.xp} XP
                </p>
              </div>
              <Switch
                checked={m.enabled}
                disabled={toggle.isPending}
                onCheckedChange={() => toggle.mutate(m)}
                aria-label={`${m.enabled ? "Switch off" : "Switch on"} ${mechanicLabel(m.key)}`}
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function GrowthRewardNorthStarPage() {
  const [days, setDays] = useState<number>(90);

  const { data, isLoading, error } = useQuery<NorthStarResponse>({
    queryKey: ["admin-reward-north-star", days],
    queryFn: async () => {
      const res = await edgeFetch(`/api/admin/rewards/north-star?days=${days}`);
      if (!res.ok) throw new Error("Failed to load the north-star report");
      return res.json();
    },
  });

  const r = data?.report;
  const cmp = r?.retentionComparison;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reward North Star"
        subtitle="Week-4 retention, grading intensity, the share loop and what a retained user costs."
      />

      <div className="flex flex-wrap gap-2">
        {WINDOWS.map((w) => (
          <Button
            key={w}
            variant={w === days ? "default" : "outline"}
            size="sm"
            onClick={() => setDays(w)}
          >
            {w} days
          </Button>
        ))}
      </div>

      {isLoading
        ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
          </div>
        )
        : error || !r
        ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Couldn't load the report. It reads a lot of rows; try a shorter window.
            </CardContent>
          </Card>
        )
        : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                label="Week-4 retention"
                value={pct(r.retention.rate)}
                denominator={`${r.retention.retained} of ${r.retention.eligible} eligible`}
                note={r.retention.undecided > 0
                  ? `${r.retention.undecided} too new to decide — excluded, not counted as churned`
                  : undefined}
              />
              <Metric
                label="Grades per active user"
                value={num(r.gradesPerUser.perUser)}
                denominator={`${r.gradesPerUser.grades} grades ÷ ${r.gradesPerUser.activeUsers} who graded`}
                note="Divided by users who graded, not users who exist."
              />
              <Metric
                label="Share K-factor"
                value={r.kFactor.available ? num(r.kFactor.k) : "—"}
                denominator={r.kFactor.available
                  ? `${r.kFactor.conversions} conversions ÷ ${r.kFactor.sharers} sharers`
                  : "not measured here"}
                note={r.kFactor.available ? undefined : r.kFactor.reason}
              />
              <Metric
                label="Cost per retained user"
                value={num(r.costPerRetained.perRetainedUsd, "$")}
                denominator={`$${r.costPerRetained.costUsd} committed ÷ ${r.costPerRetained.retained} retained`}
                note="A ratio, not an attribution — it does not claim the spend caused the retention."
              />
            </div>

            {cmp
              ? (
                <Card>
                  <CardContent className="space-y-4 p-5">
                    <div>
                      <h2 className="text-base font-semibold">
                        Retention: engaged with rewards vs not
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        Same window, same arithmetic, split by whether the user has
                        any reward event.
                      </p>
                    </div>

                    {/* The caveat sits ABOVE the numbers, not under them. Read
                        after the chart it is a disclaimer nobody reaches; read
                        first it is the frame the numbers are seen through. */}
                    <div className="flex gap-3 rounded-xl bg-amber-500/10 p-4 text-sm">
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      <p className="text-amber-900 dark:text-amber-200">{cmp.caveat}</p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <p className="text-sm text-muted-foreground">Engaged</p>
                        <p className="text-2xl font-semibold tabular-nums">
                          {pct(cmp.gamified.rate)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {cmp.gamified.retained} of {cmp.gamified.eligible}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Not engaged</p>
                        <p className="text-2xl font-semibold tabular-nums">
                          {pct(cmp.notGamified.rate)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {cmp.notGamified.retained} of {cmp.notGamified.eligible}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Gap</p>
                        <p className="text-2xl font-semibold tabular-nums">
                          {cmp.gapPp === null ? "—" : `${cmp.gapPp} pp`}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {cmp.gapPp === null
                            ? "one arm has nobody eligible yet"
                            : "percentage points, not a lift"}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
              : null}

            <div className="flex gap-3 rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Signups are read from {new Date(data.cohort_since).toLocaleDateString()}
                {" "}— 28 days further back than the {data.window_days}-day window, because
                week-4 retention can only be decided for someone who signed up at least
                that long ago. {data.cohort_size} users in the cohort.
                {data.truncated
                  ? " ⚠ The read hit its row cap, so these rates describe the newest rows rather than the whole window."
                  : ""}
              </p>
            </div>
          </>
        )}

      <MechanicSwitchboard />
    </div>
  );
}
