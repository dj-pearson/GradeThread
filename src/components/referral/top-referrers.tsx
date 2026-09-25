import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { BadgeCheck, Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { edgeApiUrl } from "@/lib/edge-api";
import {
  resolvePrerenderSeed,
  seedDomId,
  escapeJsonForScript,
} from "@/lib/seo/prerender-seed";
import { cn } from "@/lib/utils";
import { rankLabel, REFERRAL_LEADERBOARD_QUERY_KEY } from "@/lib/referral-page";

// One row from /api/content/public/referral-leaderboard.json (US-864). PII-free:
// a user-chosen alias + their count of rewarded referrals + credits earned.
// US-1784: `verified_handle` is present ONLY for referrers who are publicly
// verified sellers (opted into the directory) — the row then links to their
// /verified profile.
export interface LeaderboardReferrer {
  /** The server's rank; tied sellers share one. Absent on an older feed. */
  rank?: number;
  tied?: boolean;
  display_name: string;
  referrals: number;
  credits_earned: number;
  verified_handle?: string | null;
}

async function fetchBoard(): Promise<LeaderboardReferrer[]> {
  const res = await fetch(`${edgeApiUrl()}/api/content/public/referral-leaderboard.json`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  const json = (await res.json()) as { referrers?: LeaderboardReferrer[] };
  return json.referrers ?? [];
}

interface TopReferrersProps {
  // Cap how many rows to render (the feed itself returns up to 100).
  limit?: number;
  className?: string;
  // US-2187: when set (only the public /leaderboard passes it), seed the rows
  // from the build-time prerender so the ranked list lands in the crawlable
  // HTML, and bake an inline JSON <script> the live SPA reads at mount. The
  // authed referrals page omits it (that page isn't prerendered).
  seedKey?: string;
}

// Self-contained public leaderboard list. Reads the anonymous feed through the
// query cache so it works on both the authed referrals page and the public
// /leaderboard page, and so the opt-in form can refresh it after a save.
export function TopReferrers({ limit, className, seedKey }: TopReferrersProps) {
  // Only seed a NON-EMPTY list. An empty seed would render the EmptyState
  // (an <h3>) directly under the page <h1> in the prerendered HTML, skipping
  // a heading level (heading-outline guard). An empty leaderboard has nothing
  // to seed for GEO anyway, so it falls back to the skeleton until the fetch.
  const seeded = seedKey
    ? resolvePrerenderSeed<{ referrers: LeaderboardReferrer[] }>(seedKey)?.referrers
    : undefined;
  const initial = seeded && seeded.length > 0 ? seeded : undefined;

  const { data: rows, isError, refetch, isFetching } = useQuery({
    queryKey: REFERRAL_LEADERBOARD_QUERY_KEY,
    queryFn: fetchBoard,
    initialData: initial,
    staleTime: 5 * 60 * 1000,
  });

  if (isError && !rows) {
    return (
      <ErrorState
        className={className}
        title="Couldn't load the leaderboard"
        onRetry={() => refetch()}
        retrying={isFetching}
      />
    );
  }

  if (!rows) {
    return (
      <div className={cn("space-y-2", className)} aria-busy="true">
        {Array.from({ length: limit ?? 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        className={className}
        icon={Trophy}
        title="No ranked referrers yet"
        description="Be the first to make the board. Share your referral link and earn grade credits when friends join."
      />
    );
  }

  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div className={className}>
      {/* US-2187: bake the ranked rows so crawlers/AI engines read them and the
          live SPA can seed from the same payload. */}
      {seedKey && rows.length > 0 && (
        <script
          type="application/json"
          id={seedDomId(seedKey)}
          dangerouslySetInnerHTML={{
            __html: escapeJsonForScript({ referrers: rows }),
          }}
        />
      )}
      <ol className="divide-y">
        {shown.map((r, i) => {
          const rank = r.rank ?? i + 1;
          const tied = r.tied ?? false;
          return (
            <li
              key={`${r.display_name}-${i}`}
              className="flex items-center gap-3 py-3"
              aria-label={`${rankLabel(rank, tied)}: ${r.display_name}`}
            >
              <div className="flex w-12 flex-shrink-0 items-center gap-1 tabular-nums">
                <span className="text-lg font-bold text-brand-navy dark:text-foreground">
                  {tied ? "=" : ""}
                  {rank}
                </span>
                {rank <= 3 && (
                  <Trophy className="h-4 w-4 text-brand-red-text" aria-hidden />
                )}
              </div>
              <div className="min-w-0 flex-1">
                {r.verified_handle ? (
                  <Link
                    to={`/verified/${encodeURIComponent(r.verified_handle)}`}
                    className="flex items-center gap-1 truncate font-semibold text-brand-navy hover:underline dark:text-foreground"
                  >
                    {r.display_name}
                    <BadgeCheck className="h-3.5 w-3.5 flex-shrink-0 text-brand-navy dark:text-foreground" />
                  </Link>
                ) : (
                  <p className="truncate font-semibold">{r.display_name}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {r.referrals.toLocaleString()} referral
                  {r.referrals === 1 ? "" : "s"} rewarded
                </p>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="text-lg font-bold tabular-nums text-brand-navy dark:text-foreground">
                  {r.credits_earned.toLocaleString()}
                </div>
                <p className="text-xs text-muted-foreground">Credits</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
