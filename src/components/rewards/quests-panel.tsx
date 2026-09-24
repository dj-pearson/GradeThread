import {
  Camera,
  Check,
  Globe,
  ListChecks,
  Share2,
  Sparkles,
  Target,
  Trophy,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LabeledProgress } from "@/components/rewards/labeled-progress";
import { Skeleton } from "@/components/ui/skeleton";
import { lastPeriodLine, useQuests, type Challenge, type Quest } from "@/hooks/use-quests";
import { cn } from "@/lib/utils";
import { actionForMetric } from "@/lib/reward-actions";
import { RewardActionLink } from "@/components/rewards/reward-action-link";

// US-1852: quests are the SHORT loop on the rewards page — the week, sitting
// under the level (identity, permanent) and the season (the quarter).
//
// A finished quest stays on the list with a tick rather than disappearing. The
// point of the card is "here is what this week looked like", and a list that
// empties itself as you succeed reads as though nothing happened.
//
// Community challenges name only sellers who joined the leaderboards (the same
// opt-in as the Perks tab boards). Being counted in a challenge is not consent
// to be named on one, so a seller who has not joined still scores and still
// sees their own progress — they are just not on the board, and the card says
// so plainly instead of silently omitting them.

const ICONS: Record<string, LucideIcon> = {
  Camera,
  Globe,
  ListChecks,
  Share2,
  Sparkles,
  Target,
  Trophy,
  Users,
  Zap,
};

const CADENCE_LABEL: Record<string, string> = {
  weekly: "This week",
  monthly: "This month",
  fixed: "Limited time",
};

/** Plain-words time remaining. Exported for the unit test. */
export function questTimeLeft(endsAt: string, nowMs: number = Date.now()): string {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return "";
  const ms = end - nowMs;
  if (ms <= 0) return "ended";
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 24) return `${hours} hour${hours === 1 ? "" : "s"} left`;
  const days = Math.ceil(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} left`;
}

function QuestRow({ quest }: { quest: Quest }) {
  const Icon = ICONS[quest.icon] ?? Target;
  const done = !!quest.completed_at;
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          "mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
          done ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground",
        )}
      >
        {done
          ? <Check className="h-4 w-4" aria-hidden="true" />
          : <Icon className="h-4 w-4" aria-hidden="true" />}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">{quest.name}</p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {Math.min(quest.progress.current, quest.progress.target)}/{quest.progress.target}
          </p>
        </div>
        <LabeledProgress
          value={quest.progress.percent}
          label={quest.name}
          valueText={`${Math.min(quest.progress.current, quest.progress.target)} of ${quest.progress.target}`}
          className="h-1.5"
        />
        <p className="text-xs text-muted-foreground">
          {quest.description}{" "}
          {quest.xp_reward > 0 && (
            <span className="font-medium text-foreground">+{quest.xp_reward} XP</span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {CADENCE_LABEL[quest.cadence] ?? "Now"} · {questTimeLeft(quest.window_ends_at)}
        </p>
        {!done && actionForMetric(quest.metric) && (
          <RewardActionLink action={actionForMetric(quest.metric)!} />
        )}
      </div>
    </li>
  );
}

function ChallengeCard({ challenge }: { challenge: Challenge }) {
  const Icon = ICONS[challenge.icon] ?? Trophy;
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-white">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold">{challenge.name}</p>
            <p className="text-xs text-muted-foreground">
              {questTimeLeft(challenge.window_ends_at)}
            </p>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{challenge.description}</p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <LabeledProgress
          value={challenge.progress.percent}
          label={challenge.name}
          valueText={`${challenge.progress.current} of ${challenge.progress.target}`}
          className="h-1.5"
        />
        <p className="text-xs text-muted-foreground">
          You: {challenge.progress.current} of {challenge.progress.target}
          {challenge.your_rank !== null && ` · ranked #${challenge.your_rank}`}
        </p>
      </div>

      {challenge.standings.length > 0 && (
        <ol className="mt-3 space-y-1">
          {challenge.standings.map((s) => (
            <li
              key={s.handle}
              className={cn(
                "flex items-baseline justify-between gap-3 text-sm",
                s.is_you && "font-semibold",
              )}
            >
              <span className="min-w-0 truncate">
                <span className="tabular-nums text-muted-foreground">{s.rank}.</span>{" "}
                {s.display_name}
              </span>
              <span className="tabular-nums text-muted-foreground">{s.score}</span>
            </li>
          ))}
        </ol>
      )}

      {!challenge.you_are_listed && (
        <p className="mt-3 text-xs text-muted-foreground">
          Your score counts.{" "}
          <Link
            to="/dashboard/rewards?tab=perks#leaderboard"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Join the boards to be named here.
          </Link>
        </p>
      )}
    </div>
  );
}

export function QuestsPanel() {
  const { quests, isLoading, isError, refetch } = useQuests();

  // Returning nothing while loading, or on a failed read, left the season tab
  // looking like there were no quests at all.
  if (isLoading) {
    return (
      <Card className="shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Target className="h-5 w-5 text-primary" />
            Quests
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div role="status" aria-label="Loading your quests" className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Target className="h-5 w-5 text-primary" />
            Quests
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Couldn't load this week's quests.</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!quests.enabled || (quests.quests.length === 0 && quests.challenges.length === 0)) {
    return null;
  }

  const done = quests.quests.filter((q) => q.completed_at).length;

  return (
    <>
      {quests.quests.length > 0 && (
        <Card className="shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Target className="h-5 w-5 text-primary" />
              Quests
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Small goals that refresh on their own. {done} of {quests.quests.length} done.
            </p>
            {quests.last_period && (
              <p className="text-xs text-muted-foreground">
                {lastPeriodLine(quests.last_period)}
              </p>
            )}
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {quests.quests.map((q) => <QuestRow key={`${q.key}:${q.period_key}`} quest={q} />)}
            </ul>
          </CardContent>
        </Card>
      )}

      {quests.challenges.length > 0 && (
        <Card className="shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users className="h-5 w-5 text-primary" />
              Community challenges
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Time-boxed, everyone against the same clock. Scores reset when it ends.
            </p>
          </CardHeader>
          <CardContent className="divide-y">
            {quests.challenges.map((ch) => (
              <ChallengeCard key={`${ch.key}:${ch.period_key}`} challenge={ch} />
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
