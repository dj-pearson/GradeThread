import { CalendarHeart, Share2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { LoyaltyStanding } from "@/hooks/use-rewards";
import {
  memberSinceLabel,
  STANDING_PRESERVED_COPY,
  TENURE_EXPLAINER_COPY,
  tenureLengthLabel,
} from "@/lib/loyalty-copy";
import { shareOrCopy } from "@/lib/share";

// US-1914 AC1: "member since" flair and the tenure ladder.
//
// This is the only card on the rewards page that measures nothing the seller did.
// Level is activity, the season is a clock, badges are achievements, integrity is
// what buyers said. Tenure is just: you have been here this long, and that is a
// fact about the past that a slow quarter cannot revise.
//
// Three things it deliberately never renders, because each would reintroduce the
// decay this feature exists to remove:
//   • a countdown, a deadline or an "expires" of any kind;
//   • a loss frame — nothing here says lost, broken, behind or slipping. The
//     refused vocabulary is pinned in src/lib/loyalty-copy.ts and enforced by a
//     guard test that scans every client, so this is checked rather than intended;
//   • an ACTIVITY requirement dressed up as tenure. The ladder's second input is
//     paid months, which is also monotonic, so both bars only ever fill.
//
// It renders nothing at all when the read failed (`loyalty` null), rather than
// falling back to rank 0 — showing a three-year customer "Member, 0 months"
// because a query timed out is the exact failure the card is meant to prevent.

interface LoyaltyStandingCardProps {
  loyalty: LoyaltyStanding | null;
}

/** How far along the CURRENT rung the seller is, on whichever of the two
 *  requirements is further behind. Pure — a bar that showed the easier of the
 *  two would say "almost there" to someone who is not. */
function nextRungPercent(loyalty: LoyaltyStanding): number {
  const next = loyalty.next_tier;
  if (!next) return 100;
  const monthsNeeded = (loyalty.months_to_next ?? 0) + loyalty.months;
  const paidNeeded = (loyalty.paid_months_to_next ?? 0) + loyalty.paid_months;
  const monthPct = monthsNeeded > 0 ? (loyalty.months / monthsNeeded) * 100 : 100;
  const paidPct = paidNeeded > 0 ? (loyalty.paid_months / paidNeeded) * 100 : 100;
  return Math.max(0, Math.min(100, Math.round(Math.min(monthPct, paidPct))));
}

export function LoyaltyStandingCard({ loyalty }: LoyaltyStandingCardProps) {
  if (!loyalty) return null;

  const since = memberSinceLabel(loyalty.member_since);
  const tier = loyalty.tier;
  const next = loyalty.next_tier;
  const multiplier = loyalty.credit_multiplier;
  const percentBigger = Math.round((multiplier - 1) * 100);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <CalendarHeart className="h-5 w-5 text-primary" />
          Your standing
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {tier && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-3 py-1 text-sm font-bold text-white">
              {tier.label}
            </span>
          )}
          {since && (
            <span className="text-sm font-medium">
              Member since {since}
              <span className="text-muted-foreground">
                {" "}· {tenureLengthLabel(loyalty.months)}
              </span>
            </span>
          )}
        </div>

        <p className="text-sm text-muted-foreground">{TENURE_EXPLAINER_COPY}</p>

        {percentBigger > 0 && (
          <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-3">
            <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
            <p className="text-sm">
              Milestone credits come through{" "}
              <span className="font-semibold">{percentBigger}% larger</span> at this tier.
              Rewards you have already been paid keep whatever they were worth.
            </p>
          </div>
        )}

        {next ? (
          <div className="space-y-1.5">
            <Progress value={nextRungPercent(loyalty)} />
            <p className="text-xs text-muted-foreground">
              {next.label} at{" "}
              {tenureLengthLabel((loyalty.months_to_next ?? 0) + loyalty.months)} as a member
              {(loyalty.paid_months_to_next ?? 0) > 0
                ? ` and ${(loyalty.paid_months_to_next ?? 0) + loyalty.paid_months} paid months`
                : ""}
              . Nothing here counts down.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Top of the tenure ladder. It stays yours.
          </p>
        )}

        <p className="text-xs text-muted-foreground">{STANDING_PRESERVED_COPY}</p>

        {loyalty.last_anniversary_year > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <p className="text-sm text-muted-foreground">
              {loyalty.last_anniversary_year === 1
                ? "You celebrated your first GradeThread anniversary."
                : `You've celebrated ${loyalty.last_anniversary_year} GradeThread anniversaries.`}
            </p>
            {/* The card describes the ANNIVERSARY, never the account: no handle,
                no numbers, nothing that identifies who is sharing it. Same rule
                as the level and badge cards. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void shareOrCopy({
                  title: `${loyalty.last_anniversary_year} years on GradeThread`,
                  text: `${loyalty.last_anniversary_year} ${
                    loyalty.last_anniversary_year === 1 ? "year" : "years"
                  } grading condition on GradeThread.`,
                  url: `${
                    typeof window !== "undefined" ? window.location.origin : ""
                  }/how-it-works`,
                  copiedMessage: "Link copied — paste it anywhere.",
                });
              }}
            >
              <Share2 className="mr-1.5 h-3.5 w-3.5" />
              Share
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
