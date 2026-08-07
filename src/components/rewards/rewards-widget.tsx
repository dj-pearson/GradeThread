import { Link } from "react-router";
import { ArrowRight, CalendarRange, Target, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useRewards } from "@/hooks/use-rewards";
import { useQuests } from "@/hooks/use-quests";
import { BadgeMedalStrip } from "@/components/rewards/badge-shelf";
import { RewardCelebrations } from "@/components/rewards/reward-celebrations";

// US-1857: the rewards widget on the seller dashboard — level and XP, the
// season, the badge shelf, live quests, and how far the next real reward is.
//
// One card, not five. The dashboard already carries usage meters, an activation
// checklist and a submissions table; a rewards SECTION made of tiles would push
// everything that pays the bills below the fold for the sake of a progress bar.
// The full picture is one click away and this is the doorway to it.
//
// There is deliberately no STREAK here. Reselling is bursty — a picker sources
// for three weeks and lists forty items in a weekend — so a daily chain turns a
// normal rhythm into a status loss. Streaks live only on the buyer confirmation
// surface (/buyer/rewards), which genuinely has a weekly rhythm, and come with
// grace + freeze rules there.

function nf(n: number): string {
  return n.toLocaleString();
}

export function RewardsWidget() {
  const { rewards, isLoading, isError } = useRewards();
  const { quests } = useQuests();

  // The celebration runner is mounted even when the card below renders nothing.
  // A brand-new seller has no widget to show, but they DO need their baseline
  // snapshot recorded — otherwise their very first badge diffs against nothing
  // and the one moment most worth marking is the one that gets skipped.
  const celebrations = <RewardCelebrations />;

  // A failed rewards read is not worth a red block on the dashboard: it is an
  // extra here, and the rewards page states the error properly.
  if (isLoading || isError || !rewards) return celebrations;

  const { level, season, badges, milestones } = rewards;

  // Nothing earned yet — the activation checklist is already telling this user
  // what to do, and an all-zero rewards card underneath it is noise.
  if (level.xp_total === 0 && badges.earned_count === 0) return celebrations;

  const activeQuests = quests.quests.filter((q) => !q.completed_at);

  return (
    <>
      {celebrations}
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-brand-navy text-white">
                <Trophy className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold">
                  Level {level.level} · {level.tier.name}
                </p>
                <p className="text-xs text-muted-foreground">{nf(level.xp_total)} XP earned</p>
              </div>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/dashboard/rewards">
                Rewards
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>

          <div className="space-y-1.5">
            <Progress value={level.percent_to_next_level} />
            <p className="text-xs text-muted-foreground">
              {level.xp_to_next_level > 0
                ? `${nf(level.xp_to_next_level)} XP to level ${level.level + 1}`
                : "Level up ready"}
            </p>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-start gap-2">
              <CalendarRange className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0">
                <dt className="text-xs font-medium">Season {season.label}</dt>
                <dd className="text-xs text-muted-foreground">
                  {season.goals_completed} of {season.goals_total} goals ·{" "}
                  {nf(season.xp_earned)} XP this season
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Target className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0">
                <dt className="text-xs font-medium">Quests</dt>
                <dd className="text-xs text-muted-foreground">
                  {activeQuests.length > 0
                    ? `${activeQuests.length} open · ${activeQuests[0]!.name}`
                    : quests.quests.length > 0
                      ? "All done for now"
                      : "None running"}
                </dd>
              </div>
            </div>
          </dl>

          {badges.earned_count > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium">
                Badges · {badges.earned_count} of {badges.total}
              </p>
              <BadgeMedalStrip badges={badges.earned} limit={6} />
            </div>
          )}

          {milestones.next && (
            <div className="space-y-1.5 border-t pt-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-medium">Next reward: {milestones.next.label}</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {nf(milestones.next.xp_remaining)} XP to go
                </p>
              </div>
              <Progress value={milestones.next.percent} className="h-1.5" />
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
