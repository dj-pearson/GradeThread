import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Share2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfettiBurst } from "@/components/rewards/confetti-burst";
import { edgeFetch } from "@/lib/edge-fetch";
import type { RewardArrival, RewardsState } from "@/hooks/use-rewards";
import { article } from "@/lib/reward-celebrations";
import { shareRewardCard } from "@/lib/reward-share";

/**
 * US-2973: the one-time "your work counted" moment.
 *
 * WHY THIS IS NOT A CELEBRATION EVENT.
 *
 * `detectCelebrations` diffs two snapshots and returns nothing when the previous
 * one is null, and that snapshot lives in localStorage. So a seller opening this
 * page for the first time after the pipeline-XP backfill would see NOTHING —
 * and a seller who has never opened this page is close to a definition of the
 * people the backfill exists for. The moment therefore comes from the server,
 * off `user_reward_state.arrival_seen_level`, which survives a fresh browser and
 * a different device.
 *
 * It says what happened and what it means, in that order, and then gets out of
 * the way. It is not a modal: the seller came here to look at their rewards, and
 * blocking that to tell them their rewards are good would be a worse experience
 * than the silence it replaces.
 */
export function ArrivalMoment({
  arrival,
  tierName,
}: {
  arrival: RewardArrival;
  tierName: string;
}) {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  async function acknowledge() {
    // Optimistic: the card goes away on click. The ack is idempotent and
    // monotonic server-side, so a failed request costs at most one repeat
    // showing on the next load, which is the right way for this to fail.
    setDismissed(true);
    try {
      await edgeFetch("/api/rewards/arrival/ack", {
        method: "POST",
        // Personal, like every rewards route: the ack is the caller's own row.
        skipWorkspaceHeader: true,
      });
      // Clear the arrival in the cache rather than refetching. A refetch here
      // re-ran the whole /state read just to learn what we already know, and it
      // was the refetch that re-mounted the celebration runner into a replay.
      qc.setQueriesData<RewardsState>(
        { queryKey: ["rewards-state"] },
        (s) => (s ? { ...s, arrival: null } : s),
      );
    } catch {
      // Deliberately silent. There is nothing the seller can do about it and
      // nothing they lose.
    }
  }

  return (
    <>
      {/* The one place confetti is unambiguously earned. No frequency cap is
          needed or bypassed: the server shows this at most once per account,
          ever, which is a harder limit than any client-side cap. ConfettiBurst
          already declines to run under prefers-reduced-motion. */}
      <ConfettiBurst runId={1} />
      <Card className="border-primary/40 bg-primary/5">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-full bg-primary/10 p-2 text-primary">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-primary">
                Your work counted. You&rsquo;re {article(tierName)}.
              </h2>
              <p className="text-sm text-primary/80">
                We went back through everything you have sourced, photographed,
                listed and sold, and gave you the XP for it. That put you at level
                {" "}
                {arrival.level}
                {arrival.badgeCount > 0
                  ? `, with ${arrival.badgeCount} ${
                    arrival.badgeCount === 1 ? "badge" : "badges"
                  } on your shelf.`
                  : "."}
              </p>
              <p className="text-sm text-primary/80">
                Levels never go down. Everything you list from here keeps adding to
                it.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void acknowledge()}>
              Got it
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void shareRewardCard({
                  kind: "level",
                  key: String(arrival.level),
                  title: `GradeThread level ${arrival.level}`,
                  text: `Level ${arrival.level}, ${tierName}, grading condition on GradeThread.`,
                }, "arrival");
              }}
            >
              <Share2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Share my level
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
