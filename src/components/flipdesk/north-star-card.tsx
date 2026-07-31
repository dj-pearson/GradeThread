import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Flame, Target, Trophy, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { computeNorthStar } from "@/lib/north-star";
import { NORTH_STAR_WEEKLY_GOAL } from "@/lib/constants";


// US-597: surface + gamify the "Items Listed Per Week" North Star. Reads each
// item's list_date (= listings.listed_at) to show weekly goal progress and a
// "don't break the chain" listing streak. Pure-computed from the shared
// items_full read — no extra fetch.
export function NorthStarCard({
  items,
  goal = NORTH_STAR_WEEKLY_GOAL,
}: {
  items: readonly { list_date: string | null }[];
  goal?: number;
}) {
  const stats = useMemo(
    () => computeNorthStar(items.map((it) => it.list_date), { goal }),
    [items, goal],
  );

  const remaining = Math.max(0, stats.goal - stats.listedThisWeek);

  return (
    <Card className="overflow-hidden border-brand-navy/20 bg-gradient-to-br from-brand-navy/[0.03] to-transparent">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="h-4 w-4 text-brand-navy" />
              Items listed this week
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Listing throughput is what moves inventory — keep it up.
            </p>
          </div>
          <StreakBadge weeks={stats.streakWeeks} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex items-baseline justify-between">
            <div className="text-3xl font-bold tabular-nums">
              {stats.listedThisWeek}
              <span className="ml-1 text-base font-medium text-muted-foreground">
                / {stats.goal}
              </span>
            </div>
            {stats.goalMet ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-semibold text-green-600 dark:text-green-400">
                <Trophy className="h-3 w-3" />
                Goal hit!
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {remaining} to go
              </span>
            )}
          </div>
          <Progress
            value={stats.progress * 100}
            className={cn("mt-2 h-2", stats.goalMet && "[&>div]:bg-green-500")}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Flame className="h-3.5 w-3.5" />
              Weekly streak
            </div>
            <div className="mt-1 text-xl font-bold tabular-nums">
              {stats.streakWeeks}
              <span className="ml-1 text-xs font-medium text-muted-foreground">
                {stats.streakWeeks === 1 ? "week" : "weeks"}
              </span>
            </div>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Trophy className="h-3.5 w-3.5" />
              Next milestone
            </div>
            <div className="mt-1 text-xl font-bold tabular-nums">
              {stats.nextMilestone == null ? (
                <span className="text-base font-semibold text-amber-500">
                  Maxed 🏆
                </span>
              ) : (
                <>
                  {stats.lifetimeListed}
                  <span className="ml-1 text-xs font-medium text-muted-foreground">
                    / {stats.nextMilestone}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <Button variant="ghost" size="sm" className="w-full" asChild>
          <Link to="/dashboard/flipdesk/intake">
            List another item
            <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function StreakBadge({ weeks }: { weeks: number }) {
  if (weeks <= 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
        <Flame className="h-3 w-3" />
        Start a streak
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-red/10 px-2.5 py-1 text-xs font-semibold text-brand-red">
      <Flame className="h-3 w-3 fill-current" />
      {weeks}-week streak
    </span>
  );
}
