import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BadgeCheck, Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { edgeApiUrl } from "@/lib/edge-api";
import { cn } from "@/lib/utils";

// One row from /api/content/public/referral-leaderboard.json (US-864). PII-free:
// a user-chosen alias + their count of rewarded referrals + credits earned.
// US-1784: `verified_handle` is present ONLY for referrers who are publicly
// verified sellers (opted into the directory) — the row then links to their
// /verified profile.
export interface LeaderboardReferrer {
  display_name: string;
  referrals: number;
  credits_earned: number;
  verified_handle?: string | null;
}

function rankBadge(rank: number) {
  return (
    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-sm font-bold text-white">
      {rank <= 3 ? <Trophy className="h-4 w-4" /> : `#${rank}`}
    </div>
  );
}

interface TopReferrersProps {
  // Cap how many rows to render (the feed itself returns up to 100).
  limit?: number;
  className?: string;
}

// Self-contained public leaderboard list. Fetches the anonymous feed directly so
// it works on both the authed referrals page and the public /leaderboard page.
export function TopReferrers({ limit, className }: TopReferrersProps) {
  const [rows, setRows] = useState<LeaderboardReferrer[] | null>(null);
  const [error, setError] = useState(false);
  // US-1131: bump to re-run the fetch from the standardized ErrorState retry.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setRows(null);
    (async () => {
      try {
        const res = await fetch(
          `${edgeApiUrl()}/api/content/public/referral-leaderboard.json`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const json = (await res.json()) as { referrers: LeaderboardReferrer[] };
        if (!cancelled) setRows(json.referrers ?? []);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (error) {
    return (
      <ErrorState
        className={className}
        title="Couldn't load the leaderboard"
        onRetry={() => setAttempt((a) => a + 1)}
      />
    );
  }

  if (!rows) {
    return (
      <div className={cn("space-y-2", className)}>
        {Array.from({ length: limit ?? 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
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
        description="Be the first to make the board — share your referral link and earn grade credits when friends join."
      />
    );
  }

  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div className={cn("space-y-2", className)}>
      {shown.map((r, i) => (
        <div
          key={`${r.display_name}-${i}`}
          className="flex items-center gap-3 rounded-lg border p-3"
        >
          {rankBadge(i + 1)}
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
            <div className="text-lg font-bold text-brand-navy dark:text-foreground">
              {r.credits_earned.toLocaleString()}
            </div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              credits
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
