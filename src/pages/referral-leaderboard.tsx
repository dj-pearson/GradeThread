import { Link } from "react-router-dom";
import { Gift, Trophy } from "lucide-react";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { TopReferrers } from "@/components/referral/top-referrers";

// US-864: public, opt-in top-referrers leaderboard. A little public competition
// to drive referral participation. Renders only PII-free aliases + counts (from
// /api/content/public/referral-leaderboard.json). The rows load client-side,
// but the page IS registered in PUBLIC_ROUTES and IS prerendered (as is
// /status) — an earlier comment here claimed the opposite, which is the kind
// of stale note that argues someone out of giving an indexable page the
// marketing chrome it needs.
export function ReferralLeaderboardPage() {
  return (
    // MarketingLayout so this indexable page carries the site nav + footer.
    // Without it the page shipped ONE outbound link, giving a visitor from
    // search no path to sign up.
    <MarketingLayout
      title="Top Referrers — GradeThread"
      description="The GradeThread top-referrers leaderboard. Sellers who share GradeThread and earn grade credits when friends join and qualify."
      canonicalPath="/leaderboard"
    >

      <div className="bg-brand-navy py-10 text-white">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 px-6 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">
            <Trophy className="h-4 w-4" />
            Top Referrers
          </span>
          <h1 className="text-3xl font-bold sm:text-4xl">Referral Leaderboard</h1>
          <p className="max-w-xl text-sm text-white/80">
            Members who share GradeThread and earn grade credits when friends join
            and qualify. Opt in from your referrals page to appear here.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
        <TopReferrers seedKey="referral-leaderboard" />

        <div className="pt-2 text-center">
          <p className="text-sm text-muted-foreground">
            Want to climb the board?{" "}
            <Link
              to="/dashboard/referrals"
              className="inline-flex items-center gap-1 font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              <Gift className="h-3.5 w-3.5" /> Share your referral link
            </Link>
          </p>
        </div>
      </div>
    </MarketingLayout>
  );
}
