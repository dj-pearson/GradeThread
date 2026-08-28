import {
  Award,
  Camera,
  CalendarRange,
  Check,
  Crown,
  Frame,
  Gem,
  Globe,
  Library,
  ListChecks,
  Loader2,
  Lock,
  Search,
  Share2,
  Shirt,
  Sparkles,
  Trophy,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrivalMoment } from "@/components/rewards/arrival-moment";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { useRewards, type SeasonRecap } from "@/hooks/use-rewards";
import { useNudgeAttribution } from "@/hooks/use-nudge-attribution";
import { QuestsPanel } from "@/components/rewards/quests-panel";
import { LeaderboardPanel } from "@/components/rewards/leaderboard-panel";
import { BadgeShelf } from "@/components/rewards/badge-shelf";
import { IntegrityStandingCard } from "@/components/rewards/integrity-standing";
import { LoyaltyStandingCard } from "@/components/rewards/loyalty-standing";
import { MilestoneRewards } from "@/components/rewards/milestone-rewards";
import { RewardCelebrations } from "@/components/rewards/reward-celebrations";
import { shareRewardCard } from "@/lib/reward-share";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageHelp } from "@/components/help/page-help";

// US-1851: the seller's rewards home — level, season track, cosmetic perks and
// past season recaps.
//
// There is deliberately NO STREAK on this page. Reselling is bursty: a picker
// sources for three weeks and lists forty items in a weekend, and a daily-or-
// weekly chain turns that normal rhythm into a status loss. Identity lives on
// the LEVEL, which never decreases, and the clock lives on the SEASON, which
// resets cleanly every quarter and takes nothing with it. Streaks survive only
// on the buyer confirmation surface, where the rhythm is genuinely weekly.

// Catalog icon names → components. Explicit map (same convention as the
// achievement medals) so the bundle carries only what we ship and an unknown
// name degrades instead of crashing the page.
const ICONS: Record<string, LucideIcon> = {
  Camera,
  Crown,
  Gem,
  Globe,
  Library,
  ListChecks,
  Search,
  Share2,
  Shirt,
  Zap,
};

function nf(n: number): string {
  return n.toLocaleString();
}

function daysLeft(endsAt: string): number {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
}

// The honour keys buildSeasonRecap can award. All cosmetic, by design.
const HONOUR_LABELS: Record<string, string> = {
  season_complete: "Season swept",
  season_strong: "Strong season",
  season_started: "On the board",
  season_high_xp: "High XP season",
};

function RecapCard({ recap }: { recap: SeasonRecap }) {
  return (
    <div className="rounded-xl bg-muted/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-semibold">{recap.season_label}</p>
        <p className="text-sm text-muted-foreground">
          {recap.goals_completed}/{recap.goals_total} goals
        </p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {nf(recap.xp_earned)} XP earned · finished at level {recap.level_at_end}
      </p>
      {recap.highlights?.honours?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {recap.highlights.honours.map((h) => (
            <Badge key={h} variant="secondary" className="text-xs">
              {HONOUR_LABELS[h] ?? h}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function RewardsPage() {
  const { rewards, isLoading, isError, refetch } = useRewards();
  // US-1859: a re-engagement nudge deep-links here with ?nudge=<sendId>.
  useNudgeAttribution();

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (isError || !rewards) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState
          title="Couldn't load your rewards"
          description="Your XP, level and season progress are safe — we just couldn't fetch them right now."
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const { level, season, perks, recaps, badges, milestones, integrity, loyalty, arrival } =
    rewards;
  const TierIcon = ICONS[level.tier.icon] ?? Trophy;
  const remaining = daysLeft(season.ends_at);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* US-1857: the tiered celebration runner. Mounted here as well as in the
          dashboard widget because both surfaces already hold this exact read —
          neither mount costs a request, and whichever the seller opens first is
          where the moment lands. */}
      {/* US-2973: the backfill's one moment, above the celebration runner. When
          an arrival is pending the runner is suppressed — the seller should get
          one clear "your work counted", not that plus a stack of badge toasts
          for badges the same backfill just awarded. */}
      {arrival
        ? <ArrivalMoment arrival={arrival} tierName={level.tier.name} />
        : <RewardCelebrations />}

      <PageHeader
        title="Rewards"
        subtitle="Your level is yours to keep. Seasons give you something to chase each quarter."
        icon={Trophy}
              actions={<PageHelp slug="rewards-and-credit" />}
      />

      {/* Level — the identity. Never decreases. */}
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="flex items-center gap-4">
            <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-brand-navy text-white">
              <TierIcon className="h-7 w-7" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xl font-bold">{level.tier.name}</p>
              <p className="text-sm text-muted-foreground">{level.tier.blurb}</p>
            </div>
            <div className="ml-auto text-right">
              <p className="text-2xl font-bold tabular-nums">{level.level}</p>
              <p className="text-xs text-muted-foreground">level</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Progress value={level.percent_to_next_level} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{nf(level.xp_total)} XP earned</span>
              <span>
                {level.xp_to_next_level > 0
                  ? `${nf(level.xp_to_next_level)} XP to level ${level.level + 1}`
                  : "Level up ready"}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {level.next_tier ? (
              <p className="text-sm text-muted-foreground">
                {nf(level.xp_to_next_tier ?? 0)} XP to{" "}
                <span className="font-medium text-foreground">{level.next_tier.name}</span>{" "}
                (level {level.next_tier.minLevel}).
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Top of the ladder.</p>
            )}
            {/* US-1857: the same one-tap share the level-up celebration offers,
                available whenever — the card is public and describes the RUNG,
                so sharing it publishes the achievement, never the account. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void shareRewardCard({
                  kind: "level",
                  key: String(level.level),
                  title: `GradeThread level ${level.level}`,
                  text: `Level ${level.level} — ${level.tier.name} — grading condition on GradeThread.`,
                }, "rewards_page");
              }}
            >
              <Share2 className="mr-1.5 h-3.5 w-3.5" />
              Share level card
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* US-2543 AC2: nine panels on one scroll, so the season goals a
          seller opens this page to check sat below four cards they had
          already read. The level card stays above the tabs: it is the answer
          to "where am I" and belongs on every one of them. */}
      <Tabs defaultValue="standing" className="space-y-6">
        <TabsList>
          <TabsTrigger value="standing">Standing</TabsTrigger>
          <TabsTrigger value="season">This season</TabsTrigger>
          <TabsTrigger value="perks">Perks &amp; boards</TabsTrigger>
        </TabsList>

        <TabsContent value="standing" className="space-y-6">
        {/* US-1912: Grade Integrity. Placed directly under the level card and
            above everything else on purpose — it is the only standing on this page
            a seller cannot earn by activity, so it should not sit below the things
            they can. */}
        <IntegrityStandingCard integrity={integrity} />

        {/* US-1914: tenure. Directly under integrity because the two together are
            the whole answer to "where do I stand", and both are things a quiet
            month cannot take away — unlike everything below them, which is a
            measure of activity and is allowed to be. */}
        <LoyaltyStandingCard loyalty={loyalty} />
        {/* US-1857: the badge gallery — earned medals plus what's still to earn. */}
        <BadgeShelf shelf={badges} />
        </TabsContent>

        <TabsContent value="season" className="space-y-6">
        {/* Season — the clock. Resets clean; takes nothing with it. */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <CalendarRange className="h-5 w-5 text-primary" />
              Season {season.label}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {season.goals_completed} of {season.goals_total} goals done ·{" "}
              {nf(season.xp_earned)} XP this season ·{" "}
              {remaining === 0 ? "ends today" : `${remaining} day${remaining === 1 ? "" : "s"} left`}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-3">
              {season.goals.map((goal) => {
                const GoalIcon = ICONS[goal.icon] ?? Sparkles;
                return (
                  <li key={goal.key} className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
                        goal.complete
                          ? "bg-emerald-600 text-white"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {goal.complete ? (
                        <Check className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <GoalIcon className="h-4 w-4" aria-hidden="true" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm font-medium">{goal.name}</p>
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {nf(Math.min(goal.current, goal.target))}/{nf(goal.target)}
                        </p>
                      </div>
                      <Progress value={goal.percent} className="h-1.5" />
                      <p className="text-xs text-muted-foreground">{goal.description}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              A slow month costs you nothing here. When the season ends you keep every level,
              medal and XP point — only the season track resets.
            </p>
          </CardContent>
        </Card>
        {/* Quests — the week. Renders nothing when the program is off or empty. */}
        <QuestsPanel />
        {/* US-1857 over the US-1853 grant model: tangible rewards. No claim
            button — crossing the milestone grants it, and XP is never spent. */}
        <MilestoneRewards milestones={milestones} />
        {/* Past seasons. */}
        {recaps.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Past seasons</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {recaps.map((r) => (
                <RecapCard key={r.season_key} recap={r} />
              ))}
            </CardContent>
          </Card>
        )}
        </TabsContent>

        <TabsContent value="perks" className="space-y-6">
        {/* Cosmetic perks — free, always. */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Frame className="h-5 w-5 text-primary" />
              Perks
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Profile flair and share-card frames. All free — levels unlock them, money never does.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {perks.unlocked.map((perk) => (
              <div key={perk.key} className="flex items-start gap-3 rounded-lg bg-muted/60 p-3">
                <Award className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{perk.name}</p>
                  <p className="text-xs text-muted-foreground">{perk.description}</p>
                </div>
              </div>
            ))}
            {perks.locked.map((perk) => (
              <div key={perk.key} className="flex items-start gap-3 rounded-lg p-3">
                <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-muted-foreground">{perk.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {perk.description} Unlocks at level {perk.minLevel}.
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        {/* US-1856: the public boards. Opt-in, with its own consent copy. */}
        <LeaderboardPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
