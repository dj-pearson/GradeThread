import { Link } from "react-router-dom";
import { Gift, Trophy } from "lucide-react";
import { SEO } from "@/components/seo";
import { TopReferrers } from "@/components/referral/top-referrers";

// US-864: public, opt-in top-referrers leaderboard. A little public competition
// to drive referral participation. Renders only PII-free aliases + counts (from
// /api/content/public/referral-leaderboard.json). Dynamic — NOT registered in
// PUBLIC_ROUTES (no prerender), like /status.
export function ReferralLeaderboardPage() {
  return (
    <div className="min-h-screen bg-background">
      <SEO
        title="Top Referrers — GradeThread"
        description="The GradeThread top-referrers leaderboard. Sellers who share GradeThread and earn grade credits when friends join and qualify."
        canonicalUrl="https://gradethread.com/leaderboard"
      />

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
        <TopReferrers />

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
    </div>
  );
}
